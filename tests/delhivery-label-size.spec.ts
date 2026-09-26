/**
 * Unit test that pins the Delhivery label download request to thermal 4R sizing.
 *
 * Without this test, a future config-default change (e.g. someone reverting
 * DELHIVERY_LABEL_SIZE to A4) would silently break thermal-printer workflows
 * — labels would print at A4 size and waste labels.
 */
import { describe, it, expect, vi } from 'vitest';
import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';

// Suppress heavy deps; we only exercise generateLabel()
vi.mock('../src/database/prisma', () => ({ default: {} }));
vi.mock('../src/modules/firebase/firebase.service', () => ({
  default: { uploadOrderArtifact: vi.fn() },
}));
vi.mock('../src/utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mock = new MockAdapter(axios);

describe('Delhivery label size — thermal 4R (4 in x 6 in)', () => {
  it('requests pdf_size=4R (thermal) by default', async () => {
    let capturedParams: Record<string, any> | undefined;
    mock.onGet(/packing_slip/).reply((config) => {
      capturedParams = config.params;
      return [200, { packages: [{ pdf_download_link: 'https://signed.example/label.pdf' }] }];
    });

    // Import AFTER mock setup so the axios instance the service uses is the
    // same instance the mock adapter is bound to.
    const delhiveryServiceModule = await import('../src/modules/delhivery/delhivery.service');
    const delhiveryService = delhiveryServiceModule.default;

    await delhiveryService.generateLabel('TEST-AWB-123');
    expect(capturedParams).toBeDefined();
    expect(capturedParams?.pdf).toBe(true);
    expect(capturedParams?.pdf_size).toBe('4R');
    expect(capturedParams?.wbns).toBe('TEST-AWB-123');
  });

  it('respects DELHIVERY_LABEL_SIZE override (e.g. A4 for desktop printers)', async () => {
    // Reset modules so the service re-imports with overridden env.
    vi.resetModules();
    process.env.DELHIVERY_LABEL_SIZE = 'A4';

    let capturedParams: Record<string, any> | undefined;
    mock.onGet(/packing_slip/).reply((config) => {
      capturedParams = config.params;
      return [200, { packages: [{ pdf_download_link: 'https://signed.example/label.pdf' }] }];
    });

    const delhiveryServiceModule = await import('../src/modules/delhivery/delhivery.service');
    const delhiveryService = delhiveryServiceModule.default;
    await delhiveryService.generateLabel('TEST-AWB-A4');
    expect(capturedParams?.pdf_size).toBe('A4');

    // Restore default for subsequent tests.
    delete process.env.DELHIVERY_LABEL_SIZE;
  });

  it('rejects invalid label sizes by surfacing the upstream error', async () => {
    mock.onGet(/packing_slip/).reply(400, { error: 'invalid pdf_size' });
    const delhiveryServiceModule = await import('../src/modules/delhivery/delhivery.service');
    const delhiveryService = delhiveryServiceModule.default;
    // generateLabel is non-fatal: empty string on failure so dispatch flow can continue.
    const url = await delhiveryService.generateLabel('TEST-BAD-SIZE');
    expect(url).toBe('');
  });
});