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
    updateMany: vi.fn(async () => ({ count: 1 })),
  },
  shipment: {
    update: vi.fn(async () => ({})),
    upsert: vi.fn(async () => ({})),
    findFirst: vi.fn(async () => null),
    findUnique: vi.fn(async () => null),
  },
  syncLog: { create: vi.fn(async () => ({})) },
  trackingLog: { upsert: vi.fn() },
  $transaction: vi.fn(async (queries: any[]) => {
    // Like Prisma's batch transaction: takes an array of queries and resolves
    // to an array of their results, in order.
    const results = [];
    for (const query of queries) {
      results.push(await query);
    }
    return results;
  }),
};
vi.mock('../src/database/prisma', () => ({ default: prismaStub }));

const { createShipmentMock, cancelShipmentMock } = vi.hoisted(() => ({
  createShipmentMock: vi.fn(),
  cancelShipmentMock: vi.fn(async () => true),
}));
vi.mock('../src/modules/delhivery/delhivery.service', () => ({
  default: {
    createShipment: createShipmentMock,
    cancelShipment: cancelShipmentMock,
  },
}));

import { config } from '../src/config';

// Fixture orders are created just after the configured import cutoff, so they
// are dispatchable whatever ORDER_SYNC_START_DATE is (or isn't) set to.
const afterCutoff = () => new Date(config.shopify.syncStartDate.getTime() + 60 * 60 * 1000);

function dispatchableOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    shopifyOrderId: 'gid://shopify/Order/1',
    shopifyOrderName: '#1001',
    shopifyCreatedAt: afterCutoff(),
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
    shipment: null,
    ...overrides,
  };
}

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
    prismaStub.order.updateMany = vi.fn(async () => ({ count: 1 }));
    createShipmentMock.mockReset().mockResolvedValue({
      waybillNumber: '30100810009999',
      labelUrl: 'https://example.com/label.pdf',
    });

    // Initial fetch, then the verified re-fetch after the payment check.
    prismaStub.order.findUnique = vi.fn(async () => dispatchableOrder());

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

    // order update -> DISPATCHED + dispatchedAt: <Date>, conditional on the
    // order not having been cancelled during the manifest call
    expect(prismaStub.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1, status: { in: ['NEW', 'DISPATCH_PENDING', 'DISPATCHED'] } },
        data: expect.objectContaining({
          status: 'DISPATCHED',
          dispatchedAt: expect.any(Date),
        }),
      })
    );
  });

  it('cancels the new AWB when the order was cancelled during the manifest call', async () => {
    // claim succeeds, the promotion finds the order CANCELLED (count 0), release succeeds
    prismaStub.order.updateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValue({ count: 1 });
    prismaStub.shipment.findUnique = vi.fn(async () => ({ id: 99, waybillNumber: '30100810009999', status: 'CREATED' }));
    cancelShipmentMock.mockResolvedValueOnce(true);

    await expect(orderService.dispatchOrder(1)).rejects.toThrow(/cancelled while it was being dispatched.*was cancelled at Delhivery/);
    expect(cancelShipmentMock).toHaveBeenCalledWith('30100810009999');
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

  it('claims the order before manifesting and releases the claim afterwards', async () => {
    await orderService.dispatchOrder(1);

    const calls = prismaStub.order.updateMany.mock.calls.map((call: any[]) => call[0]);
    const claim = calls[0];
    const release = calls[calls.length - 1];
    expect(claim.where).toMatchObject({ id: 1, status: { in: ['NEW', 'DISPATCH_PENDING'] } });
    expect(claim.data.dispatchLockedAt).toBeInstanceOf(Date);
    expect(release.where).toMatchObject({ id: 1, dispatchLockedAt: claim.data.dispatchLockedAt });
    expect(release.data).toEqual({ dispatchLockedAt: null });
  });

  it('does not manifest when another dispatch holds the claim', async () => {
    prismaStub.order.updateMany = vi.fn(async () => ({ count: 0 }));

    await expect(orderService.dispatchOrder(1)).rejects.toThrow(/already being dispatched/);
    expect(createShipmentMock).not.toHaveBeenCalled();
  });

  it('releases the claim when Delhivery rejects the manifest', async () => {
    createShipmentMock.mockRejectedValueOnce(new Error('Insufficient balance'));

    await expect(orderService.dispatchOrder(1)).rejects.toThrow(/Insufficient balance/);
    const release = prismaStub.order.updateMany.mock.calls[1][0];
    expect(release.data).toEqual({ dispatchLockedAt: null });
  });

  it('rejects an unconfirmed COD order on the server, whatever the caller', async () => {
    prismaStub.order.findUnique = vi.fn(async () =>
      dispatchableOrder({ paymentMethod: 'COD', tags: 'GoKwik', status: 'NEW' })
    );

    await expect(orderService.dispatchOrder(1)).rejects.toThrow(/unconfirmed COD/);
    expect(createShipmentMock).not.toHaveBeenCalled();
  });

  it('dispatches a COD order the customer confirmed', async () => {
    prismaStub.order.findUnique = vi.fn(async () =>
      dispatchableOrder({ paymentMethod: 'COD', tags: 'GoKwik, COD_CONFIRMED' })
    );

    await expect(orderService.dispatchOrder(1)).resolves.toEqual({ waybillNumber: '30100810009999' });
  });

  it('refuses to manifest an order that already has a live AWB', async () => {
    prismaStub.order.findUnique = vi.fn(async () =>
      dispatchableOrder({ shipment: { waybillNumber: '30100810001111', status: 'CREATED' } })
    );

    await expect(orderService.dispatchOrder(1)).rejects.toThrow(/already has Delhivery AWB 30100810001111/);
    expect(createShipmentMock).not.toHaveBeenCalled();
  });

  it('re-dispatches an order whose earlier manifest was rejected', async () => {
    prismaStub.order.findUnique = vi.fn(async () =>
      dispatchableOrder({ shipment: { waybillNumber: null, status: 'ERROR' } })
    );

    await expect(orderService.dispatchOrder(1)).resolves.toEqual({ waybillNumber: '30100810009999' });
  });

  it('rejects an order created before the import cutoff', async () => {
    prismaStub.order.findUnique = vi.fn(async () =>
      dispatchableOrder({ shopifyCreatedAt: new Date(config.shopify.syncStartDate.getTime() - 1000) })
    );

    await expect(orderService.dispatchOrder(1)).rejects.toThrow(/cutoff/);
    expect(createShipmentMock).not.toHaveBeenCalled();
  });
});