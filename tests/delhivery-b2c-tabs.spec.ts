/**
 * Delhivery B2C portal tabs newly implemented:
 *  - NDR DEFER_DLV validation (YYYY-MM-DD, max +6 days)
 *  - NDR EDIT_DETAILS requires at least one field
 *  - Edit-order guard blocks Delivered/Dispatched(RTO/DTO/Picked Up/Collected) equivalents
 *  - Warehouse create sends only documented keys
 *
 * NOTE: singleFork test pool shares one module registry across files, so this
 * spec must NOT call vi.resetModules() or reassign the axios module object —
 * that breaks axios-mock-adapter binding in delhivery-label-size.spec.ts.
 * The service is imported dynamically AFTER the hoisted mocks are assigned.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/database/prisma', () => ({
  default: {
    shipment: {
      findFirst: (...args: any[]) => (globalThis as any).__shipFind(...args),
      upsert: vi.fn(),
      update: vi.fn(),
    },
    order: { update: vi.fn() },
    syncLog: { create: vi.fn() },
    trackingLog: { findMany: vi.fn().mockResolvedValue([]), create: vi.fn() },
  },
}));

let mockPost: ReturnType<typeof vi.fn>;

vi.mock('axios', () => ({
  default: {
    create: () => ({
      get: vi.fn(),
      post: (...args: any[]) => (globalThis as any).__axiosPost(...args),
      put: vi.fn(),
      interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
    }),
  },
}));

vi.mock('../src/config', () => ({
  config: {
    delhivery: {
      baseUrl: 'https://track.delhivery.com',
      apiBaseUrl: 'https://track.delhivery.com',
      apiToken: 'test-token',
      pickupLocation: 'Surat Warehouse',
      shippingMode: 'Surface',
      labelSize: '4R',
      autoPickup: false,
      pickupTime: '11:00:00',
      webhookSecret: '',
      seller: { name: 'S', address: 'A', city: 'C', state: 'ST', pincode: '395002', phone: '9999999999' },
    },
    tracking: { batchLimit: 200, minIntervalMinutes: 10 },
  },
}));

let svc: any;

beforeEach(async () => {
  mockPost = vi.fn();
  (globalThis as any).__axiosPost = (...args: any[]) => mockPost(...args);
  (globalThis as any).__shipFind = vi.fn().mockResolvedValue({ status: 'CREATED' });
  const imported = await import('../src/modules/delhivery/delhivery.service');
  svc = imported.default;
});

describe('NDR extended actions (portal tab 11)', () => {
  it('DEFER_DLV rejects bad date format without calling API', async () => {
    const res = await svc.ndrAction('WB1', 'DEFER_DLV', { deferredDate: 'tomorrow' });
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/YYYY-MM-DD/);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('DEFER_DLV rejects dates more than 6 days out', async () => {
    const far = new Date();
    far.setDate(far.getDate() + 10);
    const iso = far.toISOString().slice(0, 10);
    const res = await svc.ndrAction('WB1', 'DEFER_DLV', { deferredDate: iso });
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/6 days/);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('DEFER_DLV accepts a valid near date and posts deferred_date', async () => {
    mockPost.mockResolvedValueOnce({ data: { upl_id: 'UPL123' } });
    const near = new Date();
    near.setDate(near.getDate() + 2);
    const iso = near.toISOString().slice(0, 10);
    const res = await svc.ndrAction('WB1', 'DEFER_DLV', { deferredDate: iso });
    expect(res.success).toBe(true);
    expect(res.uplId).toBe('UPL123');
    expect(mockPost).toHaveBeenCalledWith('/api/p/update', {
      data: [{ waybill: 'WB1', act: 'DEFER_DLV', deferred_date: iso }],
    });
  });

  it('EDIT_DETAILS requires at least one field', async () => {
    const res = await svc.ndrAction('WB1', 'EDIT_DETAILS', {});
    expect(res.success).toBe(false);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('EDIT_DETAILS posts phone/add keys', async () => {
    mockPost.mockResolvedValueOnce({ data: {} });
    const res = await svc.ndrAction('WB1', 'EDIT_DETAILS', {
      phone: '919999999999',
      address: 'New Addr',
    });
    expect(res.success).toBe(true);
    expect(mockPost).toHaveBeenCalledWith('/api/p/update', {
      data: [{ waybill: 'WB1', act: 'EDIT_DETAILS', phone: '919999999999', add: 'New Addr' }],
    });
  });
});

describe('Edit-order status guard (portal tab 6)', () => {
  it('blocks edits on Delivered / Dispatched(OFD) / RTO / Picked-up equivalents', async () => {
    for (const blocked of ['DELIVERED', 'OUT_FOR_DELIVERY', 'RTO', 'RTO_DELIVERED', 'PICKED_UP', 'CANCELLED']) {
      (globalThis as any).__shipFind = vi.fn().mockResolvedValue({ status: blocked });
      await expect(svc.updateShipment('WB1', { phone: ['9111'] })).rejects.toThrow(/Edit blocked/);
    }
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('allows edits on Manifested/In-Transit equivalents', async () => {
    mockPost.mockResolvedValueOnce({ data: { ok: true } });
    await svc.updateShipment('WB1', { phone: ['9111'] });
    expect(mockPost).toHaveBeenCalledWith('/api/p/edit', { waybill: 'WB1', phone: ['9111'] });
  });
});

describe('Warehouse create (portal tabs 3-4)', () => {
  it('posts only documented keys to create endpoint', async () => {
    mockPost.mockResolvedValueOnce({ data: { success: true } });
    await svc.createWarehouse({
      name: 'Surat Warehouse',
      phone: '9999999999',
      city: 'Surat',
      pin: '395002',
      address: 'Addr',
      email: 'a@b.c',
    });
    expect(mockPost).toHaveBeenCalledWith(
      '/api/backend/clientwarehouse/create/',
      expect.objectContaining({
        name: 'Surat Warehouse',
        registered_name: 'Surat Warehouse',
        return_pin: '395002',
        country: 'India',
      })
    );
    const sentKeys = Object.keys(mockPost.mock.calls[0][1]).sort();
    expect(sentKeys).toEqual(
      ['address', 'city', 'country', 'email', 'name', 'phone', 'pin', 'registered_name', 'return_address', 'return_city', 'return_country', 'return_pin', 'return_state'].sort()
    );
  });
});
