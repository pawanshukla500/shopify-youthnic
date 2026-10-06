/**
 * Unit tests for Delhivery createShipment dimension & weight behavior.
 *
 * Verifies:
 *   - Single-item shipments use 22 × 20 × 3 cm
 *   - Multi-item shipments use 22 × 20 × 5 cm
 *   - Declared weight is 500g in both cases
 *   - All four dimension keys (shipment_length, shipment_breadth, shipment_height,
 *     weight) plus the gm alias are present in the payload
 *
 * Mocking strategy: vi.mock the Prisma client and config so we never need a real DB.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Replace these stubs BEFORE importing the service under test.

vi.mock('../src/utils/logger', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../src/modules/firebase/firebase.service', () => ({
  default: { uploadOrderArtifact: vi.fn() },
}));

// Capture the URL-encoded payload sent to Delhivery's create API.
let capturedFormBody: string | null = null;
let capturedApiPath: string | null = null;

vi.mock('axios', () => {
  const mockPost = vi.fn((url: string, body: string) => {
    capturedApiPath = url;
    capturedFormBody = body;
    return Promise.resolve({
      data: {
        packages: [
          {
            waybill: '30100810009251',
            status: 'Success',
            remarks: ['Shipment created'],
          },
        ],
        shipment_id: 12345,
      },
    });
  });
  // Default GET → success for pincode serviceability + waybill fetch. Tests can
  // override per case with mockGet.mockResolvedValueOnce(...).
  const mockGet = vi.fn((url: string) => {
    if (url.includes('/c/api/pin-codes/json/')) {
      return Promise.resolve({
        data: {
          delivery_codes: [
            { postal_code: { remark: '', cod: 'Y', pre_paid: 'Y' } },
          ],
        },
      });
    }
    if (url.includes('/api/waybill/api/fetch_waybill')) {
      return Promise.resolve({ data: { waybills: ['30100810009251'] } });
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

// Prisma stub — only the calls used by createShipment need to exist.
vi.mock('../src/database/prisma', () => ({
  default: {
    order: { findUnique: vi.fn(), update: vi.fn(async () => ({})) },
    shipment: {
      create: vi.fn(async () => ({})),
      upsert: vi.fn(async () => ({})),
    },
    orderTracking: { create: vi.fn(async () => ({})) },
    syncLog: { create: vi.fn(async () => ({})) },
  },
}));

// Stub config with the dimensions the production deploy uses.
vi.mock('../src/config', () => ({
  config: {
    delhivery: {
      apiToken: 'test-token',
      baseUrl: 'https://track.delhivery.com',
      apiBaseUrl: 'https://track.delhivery.com',
      pickupLocation: 'Test Warehouse',
      seller: {
        name: 'Youthnic',
        address: '7004, Hi-tech Textile Centre, Anjana Farm, Surat, Gujarat 395002',
        city: 'Surat',
        state: 'Gujarat',
        pincode: '395002',
        phone: '9999999999',
      },
      shippingMode: 'Surface',
      labelSize: '4R',
      // Test-injected dimensions
      singleItemLengthCm: 22,
      singleItemBreadthCm: 20,
      singleItemHeightCm: 3,
      multiItemLengthCm: 22,
      multiItemBreadthCm: 20,
      multiItemHeightCm: 5,
      declaredWeightGrams: 500,
      autoPickup: false,
    },
  },
}));

describe('Delhivery createShipment — package dimensions', () => {
  let service: any;
  let prismaStub: any;

  beforeEach(async () => {
    capturedFormBody = null;
    capturedApiPath = null;
    vi.resetModules();
    service = (await import('../src/modules/delhivery/delhivery.service')).default;
    prismaStub = (await import('../src/database/prisma')).default as any;
    prismaStub.shipment.create = vi.fn(async () => ({}));
    prismaStub.shipment.upsert = vi.fn(async () => ({}));
    prismaStub.order.update = vi.fn(async () => ({}));
    prismaStub.orderTracking.create = vi.fn(async () => ({}));
    prismaStub.syncLog.create = vi.fn(async () => ({}));
  });

  function decodeFormBody(): any {
    // formData = 'format=json&data=<urlencoded-json>'
    const match = (capturedFormBody ?? '').match(/^format=json&data=(.+)$/);
    if (!match) throw new Error('Form body did not match expected shape');
    return JSON.parse(decodeURIComponent(match[1]));
  }

  function fakeOrder(overrides: any = {}) {
    return {
      id: 1,
      shopifyOrderId: 'gid://shopify/Order/1',
      shopifyOrderName: '#1001',
      shopifyCreatedAt: new Date('2026-01-01'),
      customerName: 'Test Customer',
      customerPhone: '9999999999',
      customerAddress: '123 Test Lane',
      customerCity: 'Mumbai',
      customerState: 'Maharashtra',
      customerCountry: 'India',
      customerPincode: '400001',
      customerEmail: 'test@example.com',
      paymentMethod: 'Prepaid',
      paymentGateway: null,
      totalAmount: 999,
      ...overrides,
    };
  }

  it('uses 22×20×3 cm + 500 g for a single-item shipment', async () => {
    await service.createShipment(fakeOrder(), { itemCount: 1 });
    expect(capturedApiPath).toContain('/api/cmu/create');
    const shipment = decodeFormBody().shipments[0];
    expect(shipment.shipment_length).toBe(22);
    expect(shipment.shipment_breadth).toBe(20);
    expect(shipment.shipment_height).toBe(3);
    expect(shipment.weight).toBe(500);
    expect(shipment.gm).toBe(500);
  });

  it('uses 22×20×5 cm + 500 g for a multi-item shipment', async () => {
    await service.createShipment(fakeOrder(), { itemCount: 3 });
    const shipment = decodeFormBody().shipments[0];
    expect(shipment.shipment_length).toBe(22);
    expect(shipment.shipment_breadth).toBe(20);
    expect(shipment.shipment_height).toBe(5);
    expect(shipment.weight).toBe(500);
    expect(shipment.gm).toBe(500);
  });

  it('falls back to single-item dimensions when itemCount is undefined', async () => {
    await service.createShipment(fakeOrder());
    const shipment = decodeFormBody().shipments[0];
    expect(shipment.shipment_length).toBe(22);
    expect(shipment.shipment_height).toBe(3);
  });

  it('does not keep the reserved waybill when Delhivery rejects the manifest for a low wallet', async () => {
    const axios = (await import('axios')).default;
    const http = axios.create() as any;
    http.get.mockResolvedValueOnce({
      data: { delivery_codes: [{ postal_code: { remark: '', cod: 'Y', pre_paid: 'Y' } }] },
    });
    http.get.mockResolvedValueOnce({ data: '30100810010275' });
    http.post.mockResolvedValueOnce({
      data: {
        success: false,
        packages: [
          {
            status: 'Fail',
            waybill: '30100810010275',
            remarks: ['insufficient balance in prepaid wallet'],
          },
        ],
      },
    });

    await expect(
      service.createShipment(fakeOrder({ status: 'DISPATCH_PENDING', paymentMethod: 'COD' }), { itemCount: 1 })
    ).rejects.toThrow(/Insufficient balance/);

    const writes = prismaStub.shipment.upsert.mock.calls.map((call: any[]) => call[0].create || call[0].update);
    expect(writes.length).toBeGreaterThan(0);
    for (const data of writes) {
      expect(data.waybillNumber ?? null).toBeNull();
      expect(data.status).toBe('ERROR');
    }
    expect(prismaStub.order.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'DISPATCH_PENDING' } })
    );
  });

  it('attaches the dimension keys Delhivery expects (shipment_length/breadth/height + weight + gm)', async () => {
    await service.createShipment(fakeOrder(), { itemCount: 2 });
    const shipment = decodeFormBody().shipments[0];
    expect(shipment).toHaveProperty('shipment_length');
    expect(shipment).toHaveProperty('shipment_breadth');
    expect(shipment).toHaveProperty('shipment_height');
    expect(shipment).toHaveProperty('weight');
    expect(shipment).toHaveProperty('gm');
  });
});