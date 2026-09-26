/**
 * Unit tests for dispatchOrder status-update behavior.
 *
 * Verifies that after createShipment succeeds on Delhivery:
 *   - order.status moves DISPATCH_PENDING -> DISPATCHED
 *   - shipment.status moves PENDING -> CREATED
 *   - order.dispatchedAt is set to a Date
 *
 * This is the round-2 finding G3 follow-up: before this fix, the dispatch
 * flow created the AWB in Delhivery but never transitioned the order
 * status out of DISPATCH_PENDING, so the UI kept showing "Dispatch Pending"
 * for orders that were actually shipped.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock the heavy deps BEFORE importing the service ───

vi.mock('../src/utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const prismaStub = {
  order: {
    findUnique: vi.fn(),
    update: vi.fn(async () => ({})),
  },
  shipment: {
    update: vi.fn(async () => ({})),
    upsert: vi.fn(async () => ({})),
    findFirst: vi.fn(async () => null),
    findUnique: vi.fn(async () => null),
  },
  syncLog: { create: vi.fn(async () => ({})) },
  trackingLog: { upsert: vi.fn() },
  $transaction: vi.fn(async (...args: any[]) => {
    // Capture the args — each arg is a Promise-returning Prisma call.
    // We just call them in sequence and return their results.
    const results = [];
    for (const arg of args) {
      results.push(await arg);
    }
    return results;
  }),
};
vi.mock('../src/database/prisma', () => ({ default: prismaStub }));

vi.mock('../src/modules/delhivery/delhivery.service', () => ({
  default: {
    createShipment: vi.fn(async () => ({
      waybillNumber: '30100810009999',
      labelUrl: 'https://example.com/label.pdf',
    })),
  },
}));

vi.mock('../src/modules/shopify/shopify.service', () => ({
  default: {
    fulfillOrderOnShopify: vi.fn(async () => undefined),
  },
}));

vi.mock('../src/modules/notifications/notification.service', () => ({
  default: {
    notifyOrderShipped: vi.fn(async () => undefined),
  },
}));

vi.mock('../src/modules/payments/payment.service', () => ({
  default: {
    isReadyForDispatch: vi.fn(async () => ({ ready: true })),
  },
}));

describe('dispatchOrder status transitions', () => {
  let orderService: any;

  beforeEach(async () => {
    Object.values(prismaStub).forEach((m: any) => {
      if (typeof m === 'object' && m !== null) {
        Object.values(m).forEach((fn: any) => {
          if (typeof fn?.mockReset === 'function') fn.mockReset();
          if (typeof fn?.mockResolvedValue === 'function')
            fn.mockResolvedValue({});
        });
      }
    });

    prismaStub.shipment.findFirst = vi.fn(async () => null);
    prismaStub.shipment.upsert = vi.fn(async () => ({
      id: 99,
      orderId: 1,
      status: 'PENDING',
    }));

    let findCallCount = 0;
    prismaStub.order.findUnique = vi.fn(async () => {
      findCallCount += 1;
      if (findCallCount === 1) {
        // Initial fetch
        return {
          id: 1,
          shopifyOrderId: 'gid://shopify/Order/1',
          shopifyOrderName: '#1001',
          shopifyCreatedAt: new Date('2026-09-26'),
          customerName: 'Test',
          customerPhone: '919999999999',
          customerAddress: '1 Test',
          customerCity: 'Surat',
          customerState: 'Gujarat',
          customerPincode: '395002',
          customerCountry: 'India',
          paymentMethod: 'Prepaid',
          totalAmount: 999,
          items: [{ id: 1 }],
          status: 'DISPATCH_PENDING',
          fulfillmentStatus: null,
        };
      }
      // Verified re-fetch (after payment check)
      return {
        id: 1,
        shopifyOrderId: 'gid://shopify/Order/1',
        shopifyOrderName: '#1001',
        shopifyCreatedAt: new Date('2026-09-26'),
        customerName: 'Test',
        customerPhone: '919999999999',
        customerAddress: '1 Test',
        customerCity: 'Surat',
        customerState: 'Gujarat',
        customerPincode: '395002',
        customerCountry: 'India',
        paymentMethod: 'Prepaid',
        totalAmount: 999,
        items: [{ id: 1 }],
        status: 'DISPATCH_PENDING',
        fulfillmentStatus: null,
      };
    });

    const mod = await import('../src/modules/orders/order.service');
    orderService = mod.default;
  });

  it('promotes order DISPATCH_PENDING -> DISPATCHED + shipment PENDING -> CREATED + sets dispatchedAt', async () => {
    await orderService.dispatchOrder(1);

    // The transaction must have been called once with [shipmentUpdate, orderUpdate]
    expect(prismaStub.$transaction).toHaveBeenCalledTimes(1);
    const txArgs = prismaStub.$transaction.mock.calls[0][0];
    expect(txArgs).toHaveLength(2);

    // shipment update -> CREATED + trackingStatus = 'Label generated'
    expect(prismaStub.shipment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orderId: 1 },
        data: expect.objectContaining({
          status: 'CREATED',
          trackingStatus: 'Label generated',
        }),
      })
    );

    // order update -> DISPATCHED + dispatchedAt: <Date>
    expect(prismaStub.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1 },
        data: expect.objectContaining({
          status: 'DISPATCHED',
          dispatchedAt: expect.any(Date),
        }),
      })
    );
  });

  it('rejects dispatch if order is not in NEW or DISPATCH_PENDING state', async () => {
    prismaStub.order.findUnique = vi.fn(async () => ({
      id: 1,
      shopifyOrderId: 'gid://shopify/Order/1',
      shopifyOrderName: '#1001',
      shopifyCreatedAt: new Date(),
      customerName: 'T',
      customerPhone: '9',
      customerAddress: '1',
      customerCity: 'c',
      customerState: 's',
      customerPincode: '1',
      customerCountry: 'India',
      paymentMethod: 'Prepaid',
      totalAmount: 1,
      items: [],
      status: 'SHIPPED', // not in [NEW, DISPATCH_PENDING]
      fulfillmentStatus: null,
    }));
    await expect(orderService.dispatchOrder(1)).rejects.toThrow(/not in dispatchable state/);
  });
});