/**
 * Unit tests for shopifyService.syncOrderToDb external-fulfillment ingestion.
 *
 * Covers the fulfillment-sync validation contract assertions owned by the
 * "shopify-fulfillment-webhooks-and-sync" feature:
 *   VAL-SYNC-004  parse pre-existing fulfillments and record order + shipment
 *   VAL-SYNC-005  filter cancelled fulfillments; pick latest active
 *   VAL-SYNC-006  extract waybill (tracking_number / tracking_numbers[0]),
 *                 courier (tracking_company, fallback 'Other'), tracking URL
 *   VAL-SYNC-009  promote order status out of NEW/DISPATCH_PENDING
 *   VAL-SYNC-010  upsert Shipment (create when none, update when present)
 *   VAL-SYNC-011  initialize dispatchedAt when null, preserve when already set
 *   VAL-SYNC-012  skip orders created before the 2026-09-25 sync cutoff
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Prevent any real HTTP: the Shopify client is an axios instance created in the
// service constructor. Return a stub that also satisfies the request interceptor.
vi.mock('axios', () => {
  const client = {
    interceptors: { request: { use: vi.fn() } },
    get: vi.fn(async () => ({ data: {} })),
    post: vi.fn(async () => ({ data: {} })),
    put: vi.fn(async () => ({ data: {} })),
  };
  return { default: { create: vi.fn(() => client) } };
});

// Hoisted so the stub exists when the (hoisted) vi.mock factory runs.
const { prismaStub } = vi.hoisted(() => ({
  prismaStub: {
    order: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
    orderItem: { findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    shipment: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  },
}));
vi.mock('../src/database/prisma', () => ({ default: prismaStub }));

import { config } from '../src/config';
import shopifyService from '../src/modules/shopify/shopify.service';
import logger from '../src/utils/logger';

// Build created_at values relative to the runtime cutoff so the assertions hold
// regardless of how ORDER_SYNC_START_DATE is (or isn't) configured for tests.
const cutoff = config.shopify.syncStartDate;
const AFTER = new Date(cutoff.getTime() + 2 * 24 * 3600 * 1000).toISOString();
const BEFORE = new Date(cutoff.getTime() - 2 * 24 * 3600 * 1000).toISOString();

function baseOrder(overrides: Record<string, any> = {}): any {
  return {
    id: 5001,
    name: '#YOUTH-5001',
    number: 5001,
    email: 'cust@example.com',
    created_at: AFTER,
    updated_at: AFTER,
    currency: 'INR',
    total_price: '999.00',
    financial_status: 'pending',
    fulfillment_status: null,
    tags: 'COD',
    source_name: 'web', // known channel -> no GraphQL lookup
    customer: { first_name: 'Test', last_name: 'Buyer', email: 'cust@example.com' },
    shipping_address: {
      address1: '1 Test St',
      city: 'Surat',
      province: 'Gujarat',
      zip: '395006',
      country: 'India',
      phone: '9999999999',
    },
    // No variant_id -> fetchVariantImages short-circuits (no HTTP).
    line_items: [{ title: 'Cotton Kurta', quantity: 1, price: '999.00' }],
    fulfillments: [],
    ...overrides,
  };
}

describe('shopifyService.syncOrderToDb — external fulfillment ingestion', () => {
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
    (logger.info as any).mockReset();
    (logger.warn as any).mockReset();
    (logger.error as any).mockReset();
    (logger.debug as any).mockReset();
  });

  it('creates a Shipment, promotes status to IN_TRANSIT, and initializes dispatchedAt for a new externally-fulfilled order', async () => {
    const order = baseOrder({
      fulfillment_status: 'fulfilled',
      fulfillments: [
        {
          status: 'success',
          shipment_status: 'in_transit',
          tracking_number: '30100810012345',
          tracking_company: 'Delhivery Express',
          tracking_url: 'https://www.delhivery.com/track/package/30100810012345',
          created_at: AFTER,
        },
      ],
    });

    await shopifyService.syncOrderToDb(order);

    expect(prismaStub.order.upsert).toHaveBeenCalledTimes(1);
    const upsertArg = prismaStub.order.upsert.mock.calls[0][0];
    // VAL-SYNC-009: promoted out of NEW to IN_TRANSIT
    expect(upsertArg.create.status).toBe('IN_TRANSIT');
    // VAL-SYNC-011: dispatchedAt initialized to a valid Date
    expect(upsertArg.create.dispatchedAt).toBeInstanceOf(Date);
    expect(upsertArg.update.dispatchedAt).toBeInstanceOf(Date);

    // VAL-SYNC-006 / VAL-SYNC-010: shipment created with tracking attributes
    expect(prismaStub.shipment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          waybillNumber: '30100810012345',
          courier: 'Delhivery Express',
          status: 'IN_TRANSIT',
          paymentMode: 'COD',
          labelUrl: 'https://www.delhivery.com/track/package/30100810012345',
        }),
      })
    );
    expect(prismaStub.shipment.update).not.toHaveBeenCalled();
  });

  it('promotes a fulfilled order (success without shipment_status) to SHIPPED', async () => {
    const order = baseOrder({
      fulfillment_status: 'fulfilled',
      fulfillments: [
        { status: 'success', tracking_number: 'AWB777', tracking_company: 'Delhivery', created_at: AFTER },
      ],
    });

    await shopifyService.syncOrderToDb(order);

    const upsertArg = prismaStub.order.upsert.mock.calls[0][0];
    expect(upsertArg.create.status).toBe('SHIPPED');
  });

  it('maps a delivered fulfillment to DELIVERED on both order and shipment', async () => {
    const order = baseOrder({
      fulfillment_status: 'fulfilled',
      fulfillments: [
        {
          status: 'success',
          shipment_status: 'delivered',
          tracking_number: 'AWBDONE1',
          tracking_company: 'Delhivery',
          created_at: AFTER,
        },
      ],
    });

    await shopifyService.syncOrderToDb(order);

    const upsertArg = prismaStub.order.upsert.mock.calls[0][0];
    expect(upsertArg.create.status).toBe('DELIVERED');
    expect(prismaStub.shipment.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'DELIVERED' }) })
    );
  });

  it('does not create a shipment or mark fulfilled when every fulfillment is cancelled', async () => {
    const order = baseOrder({
      fulfillment_status: null,
      fulfillments: [
        { status: 'cancelled', tracking_number: 'OLDX', tracking_company: 'Delhivery', created_at: AFTER },
      ],
    });

    await shopifyService.syncOrderToDb(order);

    expect(prismaStub.shipment.create).not.toHaveBeenCalled();
    expect(prismaStub.shipment.update).not.toHaveBeenCalled();
    const upsertArg = prismaStub.order.upsert.mock.calls[0][0];
    expect(['NEW', 'DISPATCH_PENDING']).toContain(upsertArg.create.status);
    // No active fulfillment or waybill -> dispatchedAt stays null
    expect(upsertArg.create.dispatchedAt).toBeNull();
  });

  it('selects the latest active (non-cancelled) fulfillment when multiple exist', async () => {
    const order = baseOrder({
      fulfillment_status: 'fulfilled',
      fulfillments: [
        { status: 'cancelled', tracking_number: 'CANCELLED111', tracking_company: 'Delhivery', created_at: AFTER },
        {
          status: 'success',
          shipment_status: 'in_transit',
          tracking_number: 'ACTIVE222',
          tracking_company: 'Delhivery Surface',
          tracking_url: 'https://www.delhivery.com/track/package/ACTIVE222',
          created_at: AFTER,
        },
      ],
    });

    await shopifyService.syncOrderToDb(order);

    expect(prismaStub.shipment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ waybillNumber: 'ACTIVE222', courier: 'Delhivery Surface' }),
      })
    );
  });

  it("falls back to courier 'Other' and reads tracking_numbers[0] / tracking_urls[0]", async () => {
    const order = baseOrder({
      fulfillment_status: 'fulfilled',
      fulfillments: [
        {
          status: 'success',
          shipment_status: 'in_transit',
          tracking_numbers: ['ARR333'],
          tracking_urls: ['https://track.example.com/ARR333'],
          created_at: AFTER,
        },
      ],
    });

    await shopifyService.syncOrderToDb(order);

    expect(prismaStub.shipment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          waybillNumber: 'ARR333',
          courier: 'Other',
          labelUrl: 'https://track.example.com/ARR333',
        }),
      })
    );
  });

  it('updates an existing Shipment (no duplicate) and preserves an already-set dispatchedAt', async () => {
    const preExistingDispatch = new Date('2026-10-01T09:30:00.000Z');
    prismaStub.order.findUnique.mockResolvedValue({ dispatchedAt: preExistingDispatch });
    prismaStub.shipment.findFirst.mockResolvedValue({ id: 5, labelUrl: null });

    const order = baseOrder({
      fulfillment_status: 'fulfilled',
      fulfillments: [
        {
          status: 'success',
          shipment_status: 'in_transit',
          tracking_number: 'AWBUPDATED',
          tracking_company: 'Delhivery',
          created_at: AFTER,
        },
      ],
    });

    await shopifyService.syncOrderToDb(order);

    // VAL-SYNC-011.2: existing dispatchedAt preserved, not overwritten
    const upsertArg = prismaStub.order.upsert.mock.calls[0][0];
    expect(upsertArg.update.dispatchedAt).toEqual(preExistingDispatch);
    expect(upsertArg.create.dispatchedAt).toEqual(preExistingDispatch);

    // VAL-SYNC-010.2: update the existing shipment, do not create a duplicate
    expect(prismaStub.shipment.create).not.toHaveBeenCalled();
    expect(prismaStub.shipment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 5 },
        data: expect.objectContaining({
          waybillNumber: 'AWBUPDATED',
          courier: 'Delhivery',
          status: 'IN_TRANSIT',
        }),
      })
    );
  });

  it('skips an order created before the sync cutoff without writing to the DB (VAL-SYNC-012)', async () => {
    const order = baseOrder({
      created_at: BEFORE,
      fulfillment_status: 'fulfilled',
      fulfillments: [
        {
          status: 'success',
          shipment_status: 'in_transit',
          tracking_number: 'HIST1',
          tracking_company: 'Delhivery',
          created_at: BEFORE,
        },
      ],
    });

    await shopifyService.syncOrderToDb(order);

    expect(prismaStub.order.findUnique).not.toHaveBeenCalled();
    expect(prismaStub.order.upsert).not.toHaveBeenCalled();
    expect(prismaStub.shipment.create).not.toHaveBeenCalled();
    expect(prismaStub.shipment.update).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('historical order'),
      expect.anything()
    );
  });
});
