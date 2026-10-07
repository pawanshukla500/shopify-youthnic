import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let capturedPosts: Array<{ url: string; body: any }> = [];

vi.mock('axios', () => {
  const mockPost = vi.fn((url: string, body: any) => {
    capturedPosts.push({ url, body });
    return Promise.resolve({
      data: { packages: [{ waybill: '30100810019991', status: 'Success', remarks: [] }] },
    });
  });
  const mockGet = vi.fn((url: string) => {
    if (String(url).includes('pin-codes')) {
      return Promise.resolve({ data: { delivery_codes: [{ postal_code: { remark: '', cod: 'Y', pre_paid: 'Y' } }] } });
    }
    if (String(url).includes('waybill')) {
      return Promise.resolve({ data: '30100810019991' });
    }
    return Promise.resolve({ data: {} });
  });
  return {
    default: {
      post: mockPost,
      get: mockGet,
      create: () => ({
        post: mockPost,
        get: mockGet,
        interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
      }),
    },
  };
});

vi.mock('../src/database/prisma', () => ({
  default: {
    shipment: { count: vi.fn(async () => 0), upsert: vi.fn(), update: vi.fn() },
    pickupRequest: { findFirst: vi.fn(), create: vi.fn() },
    order: { update: vi.fn() },
  },
}));

vi.mock('../src/config', () => ({
  config: {
    delhivery: {
      apiToken: 'test-token',
      baseUrl: 'https://track.delhivery.com',
      pickupLocation: 'Surat Warehouse',
      pickupTime: '11:00:00',
      shippingMode: 'Surface',
      autoPickup: true,
      singleItemLengthCm: 22,
      singleItemBreadthCm: 20,
      singleItemHeightCm: 3,
      multiItemLengthCm: 22,
      multiItemBreadthCm: 20,
      multiItemHeightCm: 5,
      declaredWeightGrams: 500,
      seller: {
        name: 'Youthnic',
        address: 'Surat FC',
        city: 'Surat',
        state: 'Gujarat',
        pincode: '395002',
        phone: '9999999999',
      },
    },
    tracking: { minIntervalMinutes: 10, batchLimit: 200 },
  },
}));

describe('Delhivery reverse manifest', () => {
  beforeEach(() => {
    capturedPosts = [];
    vi.resetModules();
  });

  function order() {
    return {
      id: 7,
      shopifyOrderId: 'gid://shopify/Order/7',
      shopifyOrderName: '#26YOU5782',
      customerName: 'Vani Srinath',
      customerPhone: '917259030744',
      customerAddress: 'BT248 Albela',
      customerCity: 'BANGALORE',
      customerState: 'Karnataka',
      customerCountry: 'India',
      customerPincode: '560078',
      totalAmount: 1119,
    } as any;
  }

  it('manifests payment_mode Pickup against the forward AWB and does not call warehouse pickup', async () => {
    const service = (await import('../src/modules/delhivery/delhivery.service')).default;
    const result = await service.createReturnShipment(order(), 'Size mismatch', '30100810010220', [
      { title: 'Navy Blue Kurta', sku: 'BT248-Albela-navy_L', quantity: 1 },
    ]);

    expect(result).toEqual({ waybillNumber: '30100810019991', pickupAutomatic: true });
    expect(capturedPosts.map((call) => call.url)).toEqual(['/api/cmu/create.json']);
    const body = String(capturedPosts[0].body);
    const payload = JSON.parse(decodeURIComponent(body.replace(/^format=json&data=/, '')));
    const shipment = payload.shipments[0];
    expect(shipment.payment_mode).toBe('Pickup');
    expect(shipment.order).toBe('26YOU5782');
    expect(shipment.products_desc).toContain('Size mismatch');
    expect(shipment.ref_waybill).toBe('30100810010220');
    expect(shipment.shipment_length).toBe(22);
    expect(shipment.shipment_height).toBe(3);
    expect(shipment.weight).toBe(500);
    expect(shipment.cod_amount).toBe('0');
    expect(payload.pickup_location.name).toBe('Surat Warehouse');
  });

  it('refuses a rejected manifest instead of inventing a waybill', async () => {
    const axios = (await import('axios')).default as any;
    axios.create().post.mockResolvedValueOnce({
      data: { success: false, packages: [{ status: 'Fail', remarks: ['ClientWarehouse matching query does not exist'], waybill: '' }] },
    });
    const service = (await import('../src/modules/delhivery/delhivery.service')).default;
    await expect(service.createReturnShipment(order(), 'Defective item', '30100810010220')).rejects.toThrow(/ClientWarehouse|rejected|reverse/i);
  });
});
