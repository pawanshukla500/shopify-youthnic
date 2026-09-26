/**
 * Unit tests for the Delhivery scan-push payload normalizer.
 *
 * The webhook route accepts both the official nested shape (per Delhivery docs)
 * and the legacy flat shape from older Delhivery integrations. These tests pin
 * the contract so silent regressions are caught in CI.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.mock('../src/utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/database/prisma', () => ({
  default: {
    shipment: { findFirst: vi.fn(async () => null) },
    trackingLog: { upsert: vi.fn() },
    syncLog: { create: vi.fn() },
    order: { update: vi.fn() },
  },
}));

vi.mock('../src/modules/delhivery/delhivery.service', () => ({
  default: {
    mapTrackingToShipmentStatus: vi.fn(() => 'IN_TRANSIT'),
  },
}));

vi.mock('../src/modules/notifications/notification.service', () => ({
  default: {
    notifyOutForDelivery: vi.fn(),
    notifyDelivered: vi.fn(),
    notifyNDR: vi.fn(),
    sendCustomMessage: vi.fn(),
  },
}));

vi.mock('../src/modules/orders/order.service', () => ({
  default: { processRtoRefund: vi.fn() },
}));

let normalize: (input: any) => any;

beforeAll(async () => {
  const mod = await import('../src/routes/delhivery-webhooks');
  normalize = mod.__test__.normalizeScanPushPayload;
});

describe('Delhivery scan-push payload normalizer — official schema', () => {
  it('parses the nested Shipment.{AWB,Status.*} shape', () => {
    const result = normalize({
      Shipment: {
        AWB: '30100810009251',
        ReferenceNo: '28',
        Sortcode: 'IXC/MDP',
        NSLCode: 'X-UCI',
        PickUpDate: '2019-01-09 17:10:42.543',
        Status: {
          Status: 'Delivered',
          StatusDateTime: '2019-01-09T17:10:42.767',
          StatusType: 'DL',
          StatusLocation: 'Chandigarh_Raiprkln_C',
          Instructions: 'Delivered to consignee',
        },
      },
    });
    expect(result).toEqual({
      waybill: '30100810009251',
      status: 'DL:Delivered',
      statusType: 'DL',
      rawStatus: 'Delivered',
      location: 'Chandigarh_Raiprkln_C',
      scanDateTime: '2019-01-09T17:10:42.767',
      remarks: 'Delivered to consignee',
      instructions: 'Delivered to consignee',
      pickupDate: '2019-01-09 17:10:42.543',
      nslCode: 'X-UCI',
      sortCode: 'IXC/MDP',
      referenceNo: '28',
      receivedBy: undefined,
    });
  });

  it('parses the Manifested status', () => {
    const result = normalize({
      Shipment: {
        AWB: '999',
        Status: {
          Status: 'Manifested',
          StatusType: 'UD',
          StatusLocation: 'Surat_Hub',
          Instructions: 'Manifest uploaded',
        },
      },
    });
    expect(result.statusType).toBe('UD');
    expect(result.rawStatus).toBe('Manifested');
    expect(result.location).toBe('Surat_Hub');
  });
});

describe('Delhivery scan-push payload normalizer — legacy flat schema', () => {
  it('parses the {waybill, status, status_type, ...} shape', () => {
    const result = normalize({
      waybill: '30100810009251',
      status: 'Delivered',
      status_type: 'DL',
      location: 'Chandigarh',
      scan_datetime: '2019-01-09T17:10:42.767',
      remarks: 'Delivered to customer',
      received_by: 'John Doe',
    });
    expect(result.waybill).toBe('30100810009251');
    expect(result.statusType).toBe('DL');
    expect(result.rawStatus).toBe('Delivered');
    expect(result.location).toBe('Chandigarh');
    expect(result.receivedBy).toBe('John Doe');
    // Enrichment fields aren't present in legacy
    expect(result.nslCode).toBeUndefined();
    expect(result.sortCode).toBeUndefined();
  });
});

describe('Delhivery scan-push payload normalizer — edge cases', () => {
  it('returns null when waybill missing', () => {
    expect(normalize({})).toBeNull();
    expect(normalize({ Shipment: {} })).toBeNull();
    expect(normalize({ waybill: null })).toBeNull();
  });

  it('returns null on non-objects', () => {
    expect(normalize(null)).toBeNull();
    expect(normalize(undefined)).toBeNull();
    expect(normalize('hello')).toBeNull();
    expect(normalize(42)).toBeNull();
  });

  it('falls back to current time when scanDateTime is missing', () => {
    const before = Date.now();
    const result = normalize({
      Shipment: { AWB: 'A', Status: { Status: 'X', StatusType: 'Y' } },
    });
    const after = Date.now();
    const ts = new Date(result.scanDateTime).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});