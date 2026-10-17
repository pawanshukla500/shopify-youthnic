/**
 * shopifyService.syncOrderToDb must not corrupt what is already stored:
 *   - two sizes of one product stay two rows (matched by variant, not title)
 *   - an older copy of the order never overwrites a newer one
 *   - a refund's own orders/updated does not reopen a REFUNDED order
 *   - the full delivery address (address2) and the consignee's name are kept
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('axios', () => {
  const client = {
    interceptors: { request: { use: vi.fn() } },
    get: vi.fn(async () => ({ data: {} })),
    post: vi.fn(async () => ({ data: {} })),
    put: vi.fn(async () => ({ data: {} })),
  };
  return { default: { create: vi.fn(() => client) } };
});

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

const cutoff = config.shopify.syncStartDate;
const AFTER = new Date(cutoff.getTime() + 2 * 24 * 3600 * 1000);

function order(overrides: Record<string, any> = {}): any {
  return {
    id: 7001,
    name: '#YOUTH-7001',
    number: 7001,
    email: 'buyer@example.com',
    created_at: AFTER.toISOString(),
    updated_at: AFTER.toISOString(),
    currency: 'INR',
    total_price: '1598.00',
    financial_status: 'paid',
    fulfillment_status: null,
    tags: 'Prepaid',
    source_name: 'web',
    customer: { first_name: 'Account', last_name: 'Holder', email: 'buyer@example.com' },
    shipping_address: {
      address1: '1 Test St',
      city: 'Surat',
      province: 'Gujarat',
      zip: '395006',
      country: 'India',
      phone: '9999999999',
    },
    line_items: [{ title: 'Cotton Kurta', quantity: 1, price: '799.00' }],
    fulfillments: [],
    ...overrides,
  };
}

describe('syncOrderToDb integrity', () => {
  beforeEach(() => {
    for (const group of Object.values(prismaStub)) {
      for (const fn of Object.values(group)) (fn as any).mockReset();
    }
    prismaStub.order.findUnique.mockResolvedValue(null);
    prismaStub.order.upsert.mockResolvedValue({ id: 1, shipment: null });
    prismaStub.orderItem.findMany.mockResolvedValue([]);
    prismaStub.orderItem.create.mockResolvedValue({});
    prismaStub.orderItem.update.mockResolvedValue({});
  });

  it('keeps Kurta-S and Kurta-M as two rows instead of overwriting S with M', async () => {
    prismaStub.orderItem.findMany.mockResolvedValue([
      { id: 1, shopifyVariantId: '9001', sku: 'KURTA-S', title: 'Cotton Kurta', variantTitle: 'S', price: 799, imageUrl: null },
    ]);

    await shopifyService.syncOrderToDb(
      order({
        line_items: [
          { variant_id: 9001, sku: 'KURTA-S', title: 'Cotton Kurta', variant_title: 'S', quantity: 1, price: '799.00' },
          { variant_id: 9002, sku: 'KURTA-M', title: 'Cotton Kurta', variant_title: 'M', quantity: 1, price: '799.00' },
        ],
      })
    );

    expect(prismaStub.orderItem.update).toHaveBeenCalledTimes(1);
    expect(prismaStub.orderItem.update.mock.calls[0][0]).toMatchObject({
      where: { id: 1 },
      data: { sku: 'KURTA-S', variantTitle: 'S' },
    });
    expect(prismaStub.orderItem.create).toHaveBeenCalledTimes(1);
    expect(prismaStub.orderItem.create.mock.calls[0][0].data).toMatchObject({
      shopifyVariantId: '9002',
      sku: 'KURTA-M',
      variantTitle: 'M',
    });
  });

  it('ignores a payload older than the copy already stored', async () => {
    prismaStub.order.findUnique.mockResolvedValue({
      dispatchedAt: null,
      status: 'CANCELLED',
      shopifyUpdatedAt: new Date(AFTER.getTime() + 60 * 1000),
      shipment: null,
    });

    await shopifyService.syncOrderToDb(order({ updated_at: AFTER.toISOString() }));

    expect(prismaStub.order.upsert).not.toHaveBeenCalled();
  });

  it('applies a payload newer than the stored copy', async () => {
    prismaStub.order.findUnique.mockResolvedValue({
      dispatchedAt: null,
      status: 'NEW',
      shopifyUpdatedAt: new Date(AFTER.getTime() - 60 * 1000),
      shipment: null,
    });

    await shopifyService.syncOrderToDb(order());

    expect(prismaStub.order.upsert).toHaveBeenCalledTimes(1);
  });

  it('does not let Shopify move a REFUNDED order back to DELIVERED', async () => {
    prismaStub.order.findUnique.mockResolvedValue({
      dispatchedAt: AFTER,
      status: 'REFUNDED',
      shopifyUpdatedAt: null,
      shipment: null,
    });

    await shopifyService.syncOrderToDb(
      order({
        fulfillment_status: 'fulfilled',
        fulfillments: [{ status: 'success', shipment_status: 'delivered', tracking_number: '30100810012345', created_at: AFTER.toISOString() }],
      })
    );

    expect(prismaStub.order.upsert.mock.calls[0][0].update.status).toBe('REFUNDED');
  });

  it('stores address2 and the consignee name from the shipping address', async () => {
    await shopifyService.syncOrderToDb(
      order({
        shipping_address: {
          name: 'Gift Recipient',
          address1: 'B-12 Lotus Apartments',
          address2: 'Near City Mall',
          city: 'Surat',
          province: 'Gujarat',
          zip: '395006',
          country: 'India',
        },
      })
    );

    const { create, update } = prismaStub.order.upsert.mock.calls[0][0];
    expect(create.customerAddress).toBe('B-12 Lotus Apartments, Near City Mall');
    expect(update.customerAddress).toBe('B-12 Lotus Apartments, Near City Mall');
    expect(create.customerName).toBe('Gift Recipient');
  });

  it('falls back to the account name when the shipping address has none', async () => {
    await shopifyService.syncOrderToDb(order());

    expect(prismaStub.order.upsert.mock.calls[0][0].create.customerName).toBe('Account Holder');
  });

  it('persists the Shopify breakdown in both create and update writes', async () => {
    await shopifyService.syncOrderToDb(order({
      total_price: '573.32',
      total_shipping_price_set: { shop_money: { amount: '45.00' } },
      total_discounts: '70.68', total_tax: '27.30', taxes_included: true,
      discount_codes: [{ code: 'newyou10', amount: '70.68', type: 'percentage' }],
      tax_lines: [{ title: 'CGST', rate: 0.05, price: '27.30' }],
      shipping_lines: [{ title: 'Shipping Fee', price: '45.00' }],
    }));
    const { create, update } = prismaStub.order.upsert.mock.calls[0][0];
    for (const write of [create, update]) {
      expect(write).toMatchObject({ totalAmount: 573.32, totalShipping: 45, totalDiscounts: 70.68, totalTax: 27.3, taxesIncluded: true, shippingTitle: 'Shipping Fee' });
      expect(write.discountCodes[0].code).toBe('newyou10');
    }
  });
});
