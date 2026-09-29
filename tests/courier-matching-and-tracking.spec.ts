/**
 * Unit + integration tests for the "resilient-courier-matching-and-tracking-filter"
 * feature (milestone: fulfillment-sync).
 *
 * Fulfilled validation-contract assertions:
 *   VAL-SYNC-007  case-insensitive /delhivery/i detection — "Delhivery Express",
 *                 "delhivery surface", "DELHIVERY" are NOT flagged isNonDelhivery.
 *   VAL-SYNC-008  third-party couriers (Blue Dart, DTDC, ...) retain their native
 *                 name + tracking URL and reset the Delhivery audit/discrepancy
 *                 fields to safe defaults (both create and update paths).
 *   VAL-SYNC-013  syncAllTracking() polls Delhivery shipments only — the Delhivery
 *                 API is never queried with a third-party waybill.
 *   VAL-CROSS-001 end-to-end external fulfillment → linked Shipment, order promoted,
 *                 dispatchedAt populated.
 *   VAL-CROSS-005 strict 2026-09-25 date cutoff enforced across the sync path.
 *   VAL-CROSS-007 Delhivery variants map to the Delhivery tracking path; third-party
 *                 couriers are bypassed by the background tracking cron.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// shopify.service builds an axios client in its constructor — stub it so no HTTP
// happens and the request interceptor registration succeeds.
vi.mock('axios', () => {
  const client = {
    interceptors: { request: { use: vi.fn() } },
    get: vi.fn(async () => ({ data: {} })),
    post: vi.fn(async () => ({ data: {} })),
    put: vi.fn(async () => ({ data: {} })),
  };
  return { default: { create: vi.fn(() => client) } };
});

// tracking.service depends on delhiveryService + the notification engine.
const { delhiveryStub } = vi.hoisted(() => ({
  delhiveryStub: {
    trackShipment: vi.fn(),
    mapTrackingToShipmentStatus: vi.fn(),
  },
}));
vi.mock('../src/modules/delhivery/delhivery.service', () => ({ default: delhiveryStub }));

vi.mock('../src/modules/notifications/notification.service', () => ({
  default: {
    notifyOutForDelivery: vi.fn(async () => undefined),
    notifyDelivered: vi.fn(async () => undefined),
    notifyNDR: vi.fn(async () => undefined),
    sendCustomMessage: vi.fn(async () => undefined),
  },
}));

const { prismaStub } = vi.hoisted(() => ({
  prismaStub: {
    order: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
    orderItem: { findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    shipment: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    trackingLog: { findMany: vi.fn(), create: vi.fn() },
    syncLog: { create: vi.fn() },
  },
}));
vi.mock('../src/database/prisma', () => ({ default: prismaStub }));

import { config } from '../src/config';
import shopifyService from '../src/modules/shopify/shopify.service';
import trackingService from '../src/modules/tracking/tracking.service';

const cutoff = config.shopify.syncStartDate;
const AFTER = new Date(cutoff.getTime() + 2 * 24 * 3600 * 1000).toISOString();
const BEFORE = new Date(cutoff.getTime() - 2 * 24 * 3600 * 1000).toISOString();

function baseOrder(overrides: Record<string, any> = {}): any {
  return {
    id: 6001,
    name: '#YOUTH-6001',
    number: 6001,
    email: 'cust@example.com',
    created_at: AFTER,
    updated_at: AFTER,
    currency: 'INR',
    total_price: '1499.00',
    financial_status: 'pending',
    fulfillment_status: null,
    tags: 'COD',
    source_name: 'web',
    customer: { first_name: 'Test', last_name: 'Buyer', email: 'cust@example.com' },
    shipping_address: {
      address1: '1 Test St',
      city: 'Surat',
      province: 'Gujarat',
      zip: '395006',
      country: 'India',
      phone: '9999999999',
    },
    line_items: [{ title: 'Cotton Kurta', quantity: 1, price: '1499.00' }],
    fulfillments: [],
    ...overrides,
  };
}

function fulfillment(overrides: Record<string, any> = {}): any {
  return {
    status: 'success',
    shipment_status: 'in_transit',
    tracking_number: '30100810012345',
    tracking_company: 'Delhivery',
    tracking_url: 'https://www.delhivery.com/track/package/30100810012345',
    created_at: AFTER,
    ...overrides,
  };
}

describe('shopifyService.syncOrderToDb — resilient courier detection', () => {
  beforeEach(() => {
    prismaStub.order.findUnique.mockReset().mockResolvedValue(null);
    prismaStub.order.upsert
      .mockReset()
      .mockResolvedValue({ id: 1, paymentVerificationSource: null, dispatchedAt: null, shipment: null });
    prismaStub.order.update.mockReset().mockResolvedValue({});
    prismaStub.orderItem.findMany.mockReset().mockResolvedValue([]);
    prismaStub.orderItem.create.mockReset().mockResolvedValue({});
    prismaStub.orderItem.update.mockReset().mockResolvedValue({});
    prismaStub.shipment.findFirst.mockReset().mockResolvedValue(null);
    prismaStub.shipment.create.mockReset().mockResolvedValue({});
    prismaStub.shipment.update.mockReset().mockResolvedValue({});
  });

  it('VAL-SYNC-007: "Delhivery Express" on an existing shipment is NOT third-party — preserves label, keeps audit fields untouched', async () => {
    prismaStub.order.findUnique.mockResolvedValue({ dispatchedAt: new Date('2026-10-01T00:00:00.000Z') });
    prismaStub.shipment.findFirst.mockResolvedValue({ id: 7, labelUrl: 'https://delhivery/label-existing.pdf' });

    const order = baseOrder({
      fulfillment_status: 'fulfilled',
      fulfillments: [
        fulfillment({ tracking_number: '30100810055555', tracking_company: 'Delhivery Express' }),
      ],
    });

    await shopifyService.syncOrderToDb(order);

    expect(prismaStub.shipment.update).toHaveBeenCalledTimes(1);
    const data = prismaStub.shipment.update.mock.calls[0][0].data;
    expect(data.courier).toBe('Delhivery Express');
    // existing Delhivery label preserved, not clobbered with the tracking URL
    expect(data.labelUrl).toBe('https://delhivery/label-existing.pdf');
    // Delhivery is not third-party → discrepancy fields left alone
    expect(data.weightMismatch).toBeUndefined();
    expect(data.declaredWeightGrams).toBeUndefined();
    expect(data.netBilledCost).toBeUndefined();
    // no order-level discrepancy reset for a Delhivery courier
    expect(prismaStub.order.update).not.toHaveBeenCalled();
  });

  it.each(['delhivery surface', 'DELHIVERY', 'Delhivery B2C', 'Delhivery Surface'])(
    'VAL-SYNC-007: courier "%s" is recognized as Delhivery (label preserved, no audit reset)',
    async (courierName) => {
      prismaStub.order.findUnique.mockResolvedValue({ dispatchedAt: new Date('2026-10-01T00:00:00.000Z') });
      prismaStub.shipment.findFirst.mockResolvedValue({ id: 9, labelUrl: 'https://delhivery/keep.pdf' });

      const order = baseOrder({
        fulfillment_status: 'fulfilled',
        fulfillments: [fulfillment({ tracking_number: 'AWBVAR', tracking_company: courierName })],
      });

      await shopifyService.syncOrderToDb(order);

      const data = prismaStub.shipment.update.mock.calls[0][0].data;
      expect(data.labelUrl).toBe('https://delhivery/keep.pdf');
      expect(data.weightMismatch).toBeUndefined();
    }
  );

  it('VAL-SYNC-008 / VAL-CROSS-007: third-party courier (Blue Dart) on an existing shipment keeps its name+URL and resets Delhivery audit fields', async () => {
    prismaStub.order.findUnique.mockResolvedValue({
      dispatchedAt: new Date('2026-10-01T00:00:00.000Z'),
    });
    prismaStub.shipment.findFirst.mockResolvedValue({ id: 11, labelUrl: 'https://delhivery/old-label.pdf' });

    const order = baseOrder({
      fulfillment_status: 'fulfilled',
      fulfillments: [
        fulfillment({
          tracking_number: 'BD123456',
          tracking_company: 'Blue Dart',
          tracking_url: 'https://bluedart.com/track/BD123456',
        }),
      ],
    });

    await shopifyService.syncOrderToDb(order);

    const data = prismaStub.shipment.update.mock.calls[0][0].data;
    expect(data.courier).toBe('Blue Dart');
    // third-party tracking URL becomes the label link
    expect(data.labelUrl).toBe('https://bluedart.com/track/BD123456');
    // Delhivery audit/discrepancy fields reset to safe defaults
    expect(data.weightMismatch).toBe(false);
    expect(data.mismatchDetails).toBeNull();
    expect(data.declaredWeightGrams).toBeNull();
    expect(data.billedWeightGrams).toBeNull();
    expect(data.chargedZone).toBeNull();
    expect(data.initialCost).toBe(0);
    expect(data.reversalAmount).toBe(0);
    expect(data.netBilledCost).toBe(0);
  });

  it('VAL-SYNC-008: third-party courier (DTDC) on a NEW shipment stores native courier + URL and safe-default audit fields', async () => {
    prismaStub.order.findUnique.mockResolvedValue(null);
    prismaStub.shipment.findFirst.mockResolvedValue(null); // no existing shipment → create path

    const order = baseOrder({
      fulfillment_status: 'fulfilled',
      fulfillments: [
        fulfillment({
          tracking_number: 'DTDC999',
          tracking_company: 'DTDC',
          tracking_url: 'https://dtdc.in/track/DTDC999',
        }),
      ],
    });

    await shopifyService.syncOrderToDb(order);

    expect(prismaStub.shipment.create).toHaveBeenCalledTimes(1);
    const data = prismaStub.shipment.create.mock.calls[0][0].data;
    expect(data.courier).toBe('DTDC');
    expect(data.labelUrl).toBe('https://dtdc.in/track/DTDC999');
    expect(data.weightMismatch).toBe(false);
    expect(data.declaredWeightGrams).toBeNull();
    expect(data.billedWeightGrams).toBeNull();
    expect(data.chargedZone).toBeNull();
    expect(data.initialCost).toBe(0);
    expect(data.netBilledCost).toBe(0);
  });

  it('VAL-SYNC-008: a Delhivery variant on a NEW shipment does NOT force audit fields (leaves schema defaults)', async () => {
    prismaStub.order.findUnique.mockResolvedValue(null);
    prismaStub.shipment.findFirst.mockResolvedValue(null);

    const order = baseOrder({
      fulfillment_status: 'fulfilled',
      fulfillments: [fulfillment({ tracking_company: 'Delhivery Express' })],
    });

    await shopifyService.syncOrderToDb(order);

    const data = prismaStub.shipment.create.mock.calls[0][0].data;
    expect(data.courier).toBe('Delhivery Express');
    // Delhivery keeps schema defaults — no explicit reset injected
    expect(data.declaredWeightGrams).toBeUndefined();
    expect(data.netBilledCost).toBeUndefined();
  });

  it('VAL-CROSS-001: end-to-end "Delhivery Express" fulfillment links a Shipment, promotes the order, and sets dispatchedAt', async () => {
    prismaStub.order.findUnique.mockResolvedValue(null); // dispatchedAt null → initialize
    prismaStub.shipment.findFirst.mockResolvedValue(null);

    const order = baseOrder({
      fulfillment_status: 'fulfilled',
      fulfillments: [
        fulfillment({ tracking_number: '30100810012345', tracking_company: 'Delhivery Express' }),
      ],
    });

    await shopifyService.syncOrderToDb(order);

    const upsertArg = prismaStub.order.upsert.mock.calls[0][0];
    expect(upsertArg.create.status).toBe('IN_TRANSIT'); // promoted out of NEW/DISPATCH_PENDING
    expect(upsertArg.create.dispatchedAt).toBeInstanceOf(Date);
    expect(upsertArg.update.dispatchedAt).toBeInstanceOf(Date);
    expect(prismaStub.shipment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          waybillNumber: '30100810012345',
          courier: 'Delhivery Express',
          status: 'IN_TRANSIT',
        }),
      })
    );
  });

  it('VAL-CROSS-005: an order created before the 2026-09-25 cutoff writes nothing to the DB', async () => {
    const order = baseOrder({
      created_at: BEFORE,
      fulfillment_status: 'fulfilled',
      fulfillments: [fulfillment({ tracking_company: 'Delhivery Express', created_at: BEFORE })],
    });

    await shopifyService.syncOrderToDb(order);

    expect(prismaStub.order.findUnique).not.toHaveBeenCalled();
    expect(prismaStub.order.upsert).not.toHaveBeenCalled();
    expect(prismaStub.shipment.create).not.toHaveBeenCalled();
    expect(prismaStub.shipment.update).not.toHaveBeenCalled();
  });
});

describe('trackingService.syncAllTracking — Delhivery-only polling', () => {
  function shipmentRow(overrides: Record<string, any> = {}): any {
    return {
      id: 1,
      orderId: 1,
      waybillNumber: 'AWB',
      courier: 'Delhivery',
      status: 'IN_TRANSIT',
      order: { id: 1, status: 'IN_TRANSIT', customerName: 'Test', shopifyOrderName: '#YOUTH-6001' },
      ...overrides,
    };
  }

  beforeEach(() => {
    prismaStub.shipment.findMany.mockReset().mockResolvedValue([]);
    prismaStub.shipment.update.mockReset().mockResolvedValue({});
    prismaStub.trackingLog.findMany.mockReset().mockResolvedValue([]);
    prismaStub.trackingLog.create.mockReset().mockResolvedValue({});
    prismaStub.order.update.mockReset().mockResolvedValue({});
    prismaStub.syncLog.create.mockReset().mockResolvedValue({});
    delhiveryStub.trackShipment
      .mockReset()
      .mockResolvedValue({ status: 'In Transit', statusType: 'UD', location: 'Hub', history: [] });
    // Keep the mapped status equal to the row status so no status-change branch runs.
    delhiveryStub.mapTrackingToShipmentStatus.mockReset().mockReturnValue('IN_TRANSIT');
  });

  it('VAL-SYNC-013: the active-shipment query filters courier to Delhivery (case-insensitive)', async () => {
    await trackingService.syncAllTracking();

    expect(prismaStub.shipment.findMany).toHaveBeenCalledTimes(1);
    const where = prismaStub.shipment.findMany.mock.calls[0][0].where;
    expect(where.courier).toEqual({ contains: 'delhivery', mode: 'insensitive' });
  });

  it('VAL-SYNC-013 / VAL-CROSS-007: Delhivery variants are polled and a third-party waybill is never sent to the Delhivery API', async () => {
    prismaStub.shipment.findMany.mockResolvedValue([
      shipmentRow({ id: 1, waybillNumber: 'AWB-DEL-1', courier: 'Delhivery Express' }),
      shipmentRow({ id: 2, waybillNumber: 'AWB-BD-1', courier: 'Blue Dart' }),
      shipmentRow({ id: 3, waybillNumber: 'AWB-DEL-2', courier: 'delhivery surface' }),
      shipmentRow({ id: 4, waybillNumber: 'AWB-NULL', courier: null }),
    ]);

    await trackingService.syncAllTracking(true);

    const polled = delhiveryStub.trackShipment.mock.calls.map((c: any[]) => c[0]);
    expect(polled).toContain('AWB-DEL-1');
    expect(polled).toContain('AWB-DEL-2');
    expect(polled).not.toContain('AWB-BD-1');
    expect(polled).not.toContain('AWB-NULL');
    expect(delhiveryStub.trackShipment).toHaveBeenCalledTimes(2);
  });
});
