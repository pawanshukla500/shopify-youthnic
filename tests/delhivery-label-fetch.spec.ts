/**
 * Unit tests for generateLabel — Delhivery packing-slip PDF retrieval.
 *
 * Verifies the response-shape fallbacks that the user-reported 404 fix added:
 *   1. Primary: /api/p/packing_slip with packages[0].pdf_download_link
 *   2. Alt: same endpoint with packages[0].pdf_url
 *   3. Alt: same endpoint with rawData.pdf_download_link / pdf_url / url
 *   4. Alt: same endpoint with packages[0].label_url
 *   5. Fallback: /api/v1/packages/json/ with ShipmentData[0].Shipment.PDF_URL
 *   6. Returns '' when nothing works (route then falls back to HTML printable label)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/database/prisma', () => ({ default: {} }));
vi.mock('../src/modules/firebase/firebase.service', () => ({
  default: { uploadOrderArtifact: vi.fn() },
}));

vi.mock('axios', () => {
  return {
    default: {
      create: () => ({
        get: mockGet,
        post: mockGet,
        interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
      }),
    },
  };
});

let mockGet: any;

import axios from 'axios';
import { config } from '../src/config';

vi.mock('../src/config', () => ({
  config: {
    delhivery: {
      baseUrl: 'https://track.delhivery.com',
      labelSize: '4R',
    },
  },
}));

describe('Delhivery generateLabel response-shape fallbacks', () => {
  let generateLabel: any;

  beforeEach(async () => {
    vi.resetModules();
    // Each test rebuilds the axios mock from scratch
    mockGet = vi.fn();
    const mod = await import('axios');
    mod.default.create = () => ({
      get: mockGet,
      post: mockGet,
      interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
    });
    const svc = await import('../src/modules/delhivery/delhivery.service');
    generateLabel = svc.default.generateLabel.bind(svc.default);
  });

  it('reads pdf_download_link from packages[0] (most common shape)', async () => {
    mockGet.mockResolvedValueOnce({
      data: {
        packages: [
          { pdf_download_link: 'https://s3.example/label.pdf' },
        ],
      },
    });
    const url = await generateLabel('AWB1');
    expect(url).toBe('https://s3.example/label.pdf');
  });

  it('falls back to packages[0].pdf_url', async () => {
    mockGet.mockResolvedValueOnce({
      data: { packages: [{ pdf_url: 'https://s3.example/label2.pdf' }] },
    });
    const url = await generateLabel('AWB2');
    expect(url).toBe('https://s3.example/label2.pdf');
  });

  it('falls back to root-level pdf_download_link when packages is empty', async () => {
    mockGet.mockResolvedValueOnce({
      data: { packages: [], pdf_download_link: 'https://s3.example/label3.pdf' },
    });
    const url = await generateLabel('AWB3');
    expect(url).toBe('https://s3.example/label3.pdf');
  });

  it('falls back to packages[0].label_url (newer API variant)', async () => {
    mockGet.mockResolvedValueOnce({
      data: { packages: [{ label_url: 'https://s3.example/label4.pdf' }] },
    });
    const url = await generateLabel('AWB4');
    expect(url).toBe('https://s3.example/label4.pdf');
  });

  it('falls back to the tracking API when packing_slip returns nothing useful', async () => {
    mockGet
      .mockResolvedValueOnce({ data: { packages: [] } }) // packing_slip empty
      .mockResolvedValueOnce({
        data: {
          ShipmentData: [
            { Shipment: { PDF_URL: 'https://s3.example/label5.pdf' } },
          ],
        },
      }); // tracking fallback
    const url = await generateLabel('AWB5');
    expect(url).toBe('https://s3.example/label5.pdf');
  });

  it('skips an expired SigV4 packing-slip URL and keeps the next live link', async () => {
    const expired =
      'https://express-hq-prod.s3.ap-south-1.amazonaws.com/packing_slip/30100810010205.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Date=20260928T044600Z&X-Amz-Expires=86400';
    mockGet.mockResolvedValueOnce({
      data: {
        packages: [{ pdf_download_link: expired, pdf_url: 'https://s3.example/fresh-label.pdf' }],
      },
    });
    const url = await generateLabel('30100810010205');
    expect(url).toBe('https://s3.example/fresh-label.pdf');
  });

  it('returns "" when both primary and fallback APIs return no usable URL', async () => {
    mockGet
      .mockResolvedValueOnce({ data: { packages: [] } })
      .mockResolvedValueOnce({ data: { ShipmentData: [] } });
    const url = await generateLabel('AWB6');
    expect(url).toBe('');
  });

  it('returns "" when the primary call throws AND the fallback throws', async () => {
    mockGet
      .mockRejectedValueOnce(new Error('Delhivery 503'))
      .mockRejectedValueOnce(new Error('Delhivery 503 too'));
    const url = await generateLabel('AWB7');
    expect(url).toBe('');
  });

  it('handles a raw string response', async () => {
    mockGet.mockResolvedValueOnce({ data: 'https://s3.example/label8.pdf' });
    const url = await generateLabel('AWB8');
    expect(url).toBe('https://s3.example/label8.pdf');
  });
});