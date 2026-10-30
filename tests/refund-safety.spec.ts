/**
 * Refund safety: the money path must refund the right amount exactly once.
 *
 *   - matchShopifyLineItem never maps one size onto another
 *   - createRefund uses Shopify's calculated amount, caps a requested amount,
 *     adopts an earlier refund with the same idempotency key, and reports
 *     when no money moved (COD)
 *   - processRefund refunds only the returned items, is claimed atomically,
 *     and never reports a refund Shopify made as FAILED
 *   - scanReturn cannot refund twice; the retry cron keeps the QC result
 *   - processRtoRefund refunds only an RTO Delhivery confirms
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { prismaStub } = vi.hoisted(() => ({
  prismaStub: {
    order: { findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
    return: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    returnItem: { updateMany: vi.fn() },
    accountTrailEvent: { create: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn(), upsert: vi.fn() },
    syncLog: { create: vi.fn(), count: vi.fn() },
    shipment: { update: vi.fn() },
  },
}));
vi.mock('../src/database/prisma', () => ({ default: prismaStub }));

const { delhiveryStub, notifyStub } = vi.hoisted(() => ({
  delhiveryStub: { trackShipment: vi.fn(), mapTrackingToShipmentStatus: vi.fn() },
  notifyStub: {
    notifyRefundProcessed: vi.fn(),
    notifyReturnReceived: vi.fn(),
    sendCustomMessage: vi.fn(),
  },
}));
vi.mock('../src/modules/delhivery/delhivery.service', () => ({ default: delhiveryStub }));
vi.mock('../src/modules/notifications/notification.service', () => ({ default: notifyStub }));

import shopifyService, { matchShopifyLineItem, roundMoney } from '../src/modules/shopify/shopify.service';
import returnService, { REFUND_MAX_ATTEMPTS } from '../src/modules/returns/return.service';
import orderService from '../src/modules/orders/order.service';

const kurtaS = { id: 501, variant_id: 9001, sku: 'KURTA-S', title: 'Cotton Kurta', variant_title: 'S' };
const kurtaM = { id: 502, variant_id: 9002, sku: 'KURTA-M', title: 'Cotton Kurta', variant_title: 'M' };

function resetStubs() {
  for (const group of [...Object.values(prismaStub), delhiveryStub, notifyStub]) {
    for (const fn of Object.values(group)) (fn as any).mockReset();
  }
  prismaStub.return.update.mockResolvedValue({});
  prismaStub.order.update.mockResolvedValue({});
  prismaStub.syncLog.create.mockResolvedValue({});
  prismaStub.accountTrailEvent.create.mockResolvedValue({ id: 1 });
  prismaStub.accountTrailEvent.findFirst.mockResolvedValue(null);
  prismaStub.returnItem.updateMany.mockResolvedValue({});
}

describe('matchShopifyLineItem', () => {
  it('matches each size by variant, never by the shared product title', () => {
    const lines = [kurtaS, kurtaM];
    expect(matchShopifyLineItem(lines, { shopifyVariantId: '9002', sku: 'KURTA-M', title: 'Cotton Kurta' })).toBe(kurtaM);
    expect(matchShopifyLineItem(lines, { shopifyVariantId: '9001', title: 'Cotton Kurta' })).toBe(kurtaS);
  });

  it('falls back to SKU, then title + variant title', () => {
    const lines = [kurtaS, kurtaM];
    expect(matchShopifyLineItem(lines, { sku: 'KURTA-M', title: 'Cotton Kurta' })).toBe(kurtaM);
    expect(matchShopifyLineItem(lines, { title: 'Cotton Kurta', variantTitle: 'M' })).toBe(kurtaM);
  });

  it('refuses an ambiguous title-only match and skips lines already taken', () => {
    expect(matchShopifyLineItem([kurtaS, kurtaM], { title: 'Cotton Kurta' })).toBeUndefined();
    expect(matchShopifyLineItem([kurtaS], { title: 'Cotton Kurta' })).toBe(kurtaS);
    expect(matchShopifyLineItem([kurtaS, kurtaM], { sku: 'KURTA-S' }, new Set([501]))).toBeUndefined();
  });
});

describe('shopifyService.createRefund', () => {
  let client: { get: any; post: any; put: any };

  beforeEach(() => {
    client = { get: vi.fn(), post: vi.fn(), put: vi.fn().mockResolvedValue({}) };
    (shopifyService as any).client = client;
  });

  function calculated(transactions: any[]) {
    return { data: { refund: { refund_line_items: [{ line_item_id: 501, quantity: 1 }], shipping: { amount: '0.00' }, transactions } } };
  }

  it('refunds what Shopify calculates (discounted price) when no amount is given', async () => {
    client.post
      .mockResolvedValueOnce(calculated([{ kind: 'suggested_refund', parent_id: 77, gateway: 'gokwik', amount: '719.10', maximum_refundable: '1598.00' }]))
      .mockResolvedValueOnce({ data: { refund: { id: 3001 } } });
    client.get.mockResolvedValue({ data: { order: { tags: '' } } });

    const result = await shopifyService.createRefund('123', null, [{ lineItemId: 501, quantity: 1 }]);

    expect(result).toMatchObject({ refundId: '3001', amount: 719.1, moneyMoved: true, alreadyRefunded: false });
    const posted = client.post.mock.calls[1][1].refund;
    expect(posted.transactions).toEqual([{ parent_id: 77, amount: '719.10', kind: 'refund', gateway: 'gokwik' }]);
  });

  it('caps a requested amount at what the order still has refundable', async () => {
    client.post
      .mockResolvedValueOnce(calculated([{ kind: 'suggested_refund', parent_id: 77, gateway: 'gokwik', amount: '0.00', maximum_refundable: '500.00' }]))
      .mockResolvedValueOnce({ data: { refund: { id: 3002 } } });
    client.get.mockResolvedValue({ data: { order: { tags: '' } } });

    const result = await shopifyService.createRefund('123', 1598, []);

    expect(result.amount).toBe(500);
    expect(client.post.mock.calls[1][1].refund.transactions[0].amount).toBe('500.00');
  });

  it('adopts an earlier refund with the same idempotency key instead of refunding again', async () => {
    client.get.mockResolvedValueOnce({
      data: {
        refunds: [
          { id: 2999, note: '[oms-return-7] Refund issued by Youthnic OMS', transactions: [{ kind: 'refund', status: 'success', amount: '719.10' }] },
        ],
      },
    });

    const result = await shopifyService.createRefund('123', null, [{ lineItemId: 501, quantity: 1 }], false, {
      idempotencyKey: 'oms-return-7',
    });

    expect(result).toEqual({ refundId: '2999', amount: 719.1, moneyMoved: true, success: true, alreadyRefunded: true });
    expect(client.post).not.toHaveBeenCalled();
  });

  it('counts a gateway refund still pending as money moved when adopting it', async () => {
    client.get.mockResolvedValueOnce({
      data: {
        refunds: [
          { id: 2998, note: '[oms-return-8] Refund issued by Youthnic OMS', transactions: [{ kind: 'refund', status: 'pending', amount: '499.00' }] },
        ],
      },
    });

    const result = await shopifyService.createRefund('123', null, [], false, { idempotencyKey: 'oms-return-8' });

    expect(result).toMatchObject({ alreadyRefunded: true, amount: 499, moneyMoved: true });
  });

  it('does not confuse oms-return-1 with oms-return-12', async () => {
    client.get.mockResolvedValueOnce({ data: { refunds: [{ id: 1, note: '[oms-return-12] Refund issued by Youthnic OMS', transactions: [] }] } });
    client.post
      .mockResolvedValueOnce(calculated([{ kind: 'suggested_refund', parent_id: 77, gateway: 'gokwik', amount: '100.00', maximum_refundable: '100.00' }]))
      .mockResolvedValueOnce({ data: { refund: { id: 3003 } } });
    client.get.mockResolvedValue({ data: { order: { tags: '' } } });

    const result = await shopifyService.createRefund('123', null, [], false, { idempotencyKey: 'oms-return-1' });

    expect(result.refundId).toBe('3003');
    expect(client.post.mock.calls[1][1].refund.note).toBe('[oms-return-1] Refund issued by Youthnic OMS');
  });

  it('reports that no money moved for an order without a captured payment (COD)', async () => {
    client.post
      .mockResolvedValueOnce(calculated([]))
      .mockResolvedValueOnce({ data: { refund: { id: 3004 } } });
    client.get
      .mockResolvedValueOnce({ data: { transactions: [{ kind: 'sale', status: 'pending', gateway: 'Cash on Delivery (COD)' }] } })
      .mockResolvedValue({ data: { order: { tags: '' } } });

    const result = await shopifyService.createRefund('123', 799, [{ lineItemId: 501, quantity: 1 }]);

    expect(result).toMatchObject({ moneyMoved: false, amount: 0 });
    expect(client.post.mock.calls[1][1].refund.transactions).toBeUndefined();
  });

  it('rounds to paise', () => {
    expect(roundMoney(719.105)).toBe(719.11);
    expect(roundMoney(0.1 + 0.2)).toBe(0.3);
  });
});

describe('returnService.processRefund', () => {
  const twoKurtaOrder = {
    id: 1,
    shopifyOrderId: '123',
    totalAmount: 1648,
    items: [
      { id: 11, quantity: 1, shopifyVariantId: '9001', sku: 'KURTA-S', title: 'Cotton Kurta', variantTitle: 'S' },
      { id: 12, quantity: 1, shopifyVariantId: '9002', sku: 'KURTA-M', title: 'Cotton Kurta', variantTitle: 'M' },
    ],
  };

  function returnOf(items: any[], overrides: Record<string, unknown> = {}) {
    return {
      id: 7,
      orderId: 1,
      returnWaybillNumber: '30100810099999',
      returnStatus: 'RECEIVED',
      refundStatus: 'NONE',
      qcStatus: 'APPROVED',
      order: twoKurtaOrder,
      items,
      ...overrides,
    };
  }

  const returnedM = { quantity: 1, orderItem: twoKurtaOrder.items[1] };
  const returnedS = { quantity: 1, orderItem: twoKurtaOrder.items[0] };

  beforeEach(() => {
    resetStubs();
    prismaStub.return.updateMany.mockResolvedValue({ count: 1 });
    vi.spyOn(shopifyService, 'fetchOrder').mockResolvedValue({ line_items: [kurtaS, kurtaM] } as any);
    vi.spyOn(shopifyService, 'createRefund').mockResolvedValue({
      refundId: '3001',
      success: true,
      amount: 719.1,
      moneyMoved: true,
      alreadyRefunded: false,
    });
  });

  it('refunds only the returned size, at the calculated price, without shipping', async () => {
    prismaStub.return.findUnique.mockResolvedValue(returnOf([returnedM]));

    const result = await returnService.processRefund(7);

    expect(result).toMatchObject({ success: true, refundAmount: 719.1, moneyMoved: true });
    expect(shopifyService.createRefund).toHaveBeenCalledWith(
      '123',
      null,
      [{ lineItemId: 502, quantity: 1, restockType: 'return' }],
      false,
      { idempotencyKey: 'oms-return-7' }
    );
    expect(prismaStub.accountTrailEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId: 1,
        returnId: 7,
        eventType: 'REFUND_AUTOMATIC',
        actorType: 'SYSTEM',
        source: 'RETURN_QC',
        status: 'COMPLETED',
        amount: 719.1,
        refundMode: 'ORIGINAL_PAYMENT_METHOD',
        accountUsed: 'Shopify original payment method',
        externalReference: '3001',
      }),
    });
  });

  it('refunds shipping when QC approved a return of every unit', async () => {
    prismaStub.return.findUnique.mockResolvedValue(returnOf([returnedS, returnedM]));

    await returnService.processRefund(7);

    const [, , lines, refundShipping] = (shopifyService.createRefund as any).mock.calls[0];
    expect(lines.map((l: any) => l.lineItemId)).toEqual([501, 502]);
    expect(refundShipping).toBe(true);
  });

  it('PARTIAL QC refunds the items without shipping and without restocking them', async () => {
    prismaStub.return.findUnique.mockResolvedValue(returnOf([returnedS, returnedM], { qcStatus: 'PARTIAL' }));

    await returnService.processRefund(7);

    const [, , lines, refundShipping] = (shopifyService.createRefund as any).mock.calls[0];
    expect(lines.every((l: any) => l.restockType === 'no_restock')).toBe(true);
    expect(refundShipping).toBe(false);
  });

  it('does nothing when another caller already claimed the refund', async () => {
    prismaStub.return.findUnique.mockResolvedValue(returnOf([returnedM], { refundStatus: 'PENDING' }));
    prismaStub.return.updateMany.mockResolvedValue({ count: 0 });

    const result = await returnService.processRefund(7);

    expect(result.success).toBe(false);
    expect(shopifyService.createRefund).not.toHaveBeenCalled();
    expect(prismaStub.return.updateMany).toHaveBeenCalledWith({
      where: { id: 7, refundStatus: { in: ['NONE', 'FAILED'] } },
      data: { returnStatus: 'REFUND_PENDING', refundStatus: 'PENDING' },
    });
  });

  it('refuses a return that has not passed QC', async () => {
    prismaStub.return.findUnique.mockResolvedValue(returnOf([returnedM], { qcStatus: 'REJECTED' }));

    const result = await returnService.processRefund(7);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not passed QC/);
    expect(prismaStub.return.updateMany).not.toHaveBeenCalled();
  });

  it('marks a Shopify failure FAILED and counts the attempt', async () => {
    prismaStub.return.findUnique.mockResolvedValue(returnOf([returnedM]));
    (shopifyService.createRefund as any).mockRejectedValueOnce(new Error('Gateway timeout'));

    const result = await returnService.processRefund(7);

    expect(result).toMatchObject({ success: false, error: 'Gateway timeout' });
    expect(prismaStub.return.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { refundStatus: 'FAILED', refundAttempts: { increment: 1 }, errorMessage: 'Gateway timeout' },
    });
  });

  it('never reports a refund Shopify made as FAILED when bookkeeping breaks', async () => {
    prismaStub.return.findUnique.mockResolvedValue(returnOf([returnedM]));
    prismaStub.return.update.mockRejectedValueOnce(new Error('connection reset'));

    const result = await returnService.processRefund(7);

    expect(result.success).toBe(true);
    const failedWrites = prismaStub.return.update.mock.calls.filter((c: any[]) => c[0].data.refundStatus === 'FAILED');
    expect(failedWrites).toHaveLength(0);
  });

  it('attributes the refund to the operator who triggered it from the Returns page', async () => {
    prismaStub.return.findUnique.mockResolvedValue(returnOf([returnedM]));
    const actor = { uid: 'u-7', email: 'ops@youthnic.com', name: 'Ops User', role: 'OPERATOR' };

    await returnService.processRefund(7, undefined, actor);

    expect(prismaStub.accountTrailEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId: 1,
        returnId: 7,
        eventType: 'REFUND_AUTOMATIC',
        actorType: 'USER',
        actorUid: 'u-7',
        actorEmail: 'ops@youthnic.com',
        source: 'RETURN_QC',
      }),
    });
  });

  it('does not message the customer when no money moved (COD)', async () => {
    prismaStub.return.findUnique.mockResolvedValue(returnOf([returnedM]));
    (shopifyService.createRefund as any).mockResolvedValueOnce({
      refundId: '3005',
      success: true,
      amount: 0,
      moneyMoved: false,
      alreadyRefunded: false,
    });

    const result = await returnService.processRefund(7);

    expect(result).toMatchObject({ success: true, moneyMoved: false });
    expect(notifyStub.notifyRefundProcessed).not.toHaveBeenCalled();
    const bookkeeping = prismaStub.return.update.mock.calls[0][0].data;
    expect(bookkeeping.errorMessage).toMatch(/no money moved/);
    expect(prismaStub.accountTrailEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: 'REFUND_AUTOMATIC',
        actorType: 'SYSTEM',
        status: 'NO_MONEY_MOVED',
        amount: 0,
        refundMode: null,
        accountUsed: null,
        externalReference: '3005',
      }),
    });
  });
});

describe('returnService.scanReturn and retryFailedRefunds', () => {
  beforeEach(resetStubs);

  it('a second scan of a scanned-in, refunded return does not refund again', async () => {
    prismaStub.return.findFirst.mockResolvedValue({
      id: 7,
      returnStatus: 'REFUNDED',
      refundStatus: 'PROCESSED',
      qcCheckedAt: new Date(),
      order: { items: [] },
      items: [],
    });
    const processRefund = vi.spyOn(returnService, 'processRefund');

    await expect(returnService.scanReturn('30100810099999', 'PARTIAL')).rejects.toThrow(/already scanned in and refunded/);
    expect(processRefund).not.toHaveBeenCalled();
    expect(prismaStub.return.update).not.toHaveBeenCalled();
  });

  it('records receipt and QC for a return refunded before it arrived, without refunding again', async () => {
    prismaStub.return.findFirst.mockResolvedValue({
      id: 8,
      orderId: 1,
      returnStatus: 'REFUNDED',
      refundStatus: 'PROCESSED',
      qcCheckedAt: null,
      receivedAt: null,
      order: { items: [] },
      items: [],
    });
    const processRefund = vi.spyOn(returnService, 'processRefund');

    const result = await returnService.scanReturn('30100810088888', 'APPROVED');

    expect(result).toEqual({ returnId: 8, refundProcessed: false, alreadyRefunded: true });
    expect(processRefund).not.toHaveBeenCalled();
    expect(prismaStub.return.update.mock.calls[0][0].data).toMatchObject({
      qcStatus: 'APPROVED',
      qcCheckedAt: expect.any(Date),
      receivedAt: expect.any(Date),
    });
    expect(prismaStub.return.update.mock.calls[0][0].data.returnStatus).toBeUndefined();
  });

  it('a scan while the refund is in flight is rejected', async () => {
    prismaStub.return.findFirst.mockResolvedValue({ id: 9, returnStatus: 'REFUND_PENDING', refundStatus: 'PENDING', order: { items: [] }, items: [] });

    await expect(returnService.scanReturn('30100810077777')).rejects.toThrow(/already sent for refund/);
  });

  it('keeps the scanning operator on the refund trail event', async () => {
    const orderItem = { id: 12, quantity: 1, shopifyVariantId: '9002', sku: 'KURTA-M', title: 'Cotton Kurta', variantTitle: 'M' };
    prismaStub.return.findFirst.mockResolvedValue({
      id: 7,
      returnStatus: 'IN_TRANSIT',
      refundStatus: 'NONE',
      qcCheckedAt: null,
      order: { items: [] },
      items: [],
    });
    prismaStub.return.findUnique.mockResolvedValue({
      id: 7,
      orderId: 1,
      returnWaybillNumber: '30100810099999',
      returnStatus: 'RECEIVED',
      refundStatus: 'NONE',
      qcStatus: 'APPROVED',
      order: { id: 1, shopifyOrderId: '123', totalAmount: 1648, currency: 'INR', paymentProvider: null, paymentGateway: null, items: [orderItem] },
      items: [{ quantity: 1, orderItem }],
    });
    prismaStub.return.updateMany.mockResolvedValue({ count: 1 });
    vi.spyOn(shopifyService, 'fetchOrder').mockResolvedValue({ line_items: [kurtaS, kurtaM] } as any);
    vi.spyOn(shopifyService, 'createRefund').mockResolvedValue({
      refundId: '3001',
      success: true,
      amount: 719.1,
      moneyMoved: true,
      alreadyRefunded: false,
    });
    const actor = { uid: 'u-9', email: 'warehouse@youthnic.com', name: 'Warehouse User', role: 'OPERATOR' };

    const result = await returnService.scanReturn('30100810099999', 'APPROVED', undefined, actor);

    expect(result.refundProcessed).toBe(true);
    expect(prismaStub.accountTrailEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId: 1,
        returnId: 7,
        eventType: 'REFUND_AUTOMATIC',
        actorType: 'USER',
        actorUid: 'u-9',
      }),
    });
  });

  it('reclaims a refund left PENDING by a dead process before retrying', async () => {
    prismaStub.return.updateMany.mockResolvedValue({ count: 1 });
    prismaStub.return.findMany.mockResolvedValue([]);

    await returnService.retryFailedRefunds();

    const reclaim = prismaStub.return.updateMany.mock.calls[0][0];
    expect(reclaim.where.refundStatus).toBe('PENDING');
    expect(reclaim.where.updatedAt.lt).toBeInstanceOf(Date);
    expect(Date.now() - reclaim.where.updatedAt.lt.getTime()).toBeGreaterThanOrEqual(29 * 60 * 1000);
    expect(reclaim.data.refundStatus).toBe('FAILED');
  });

  it('retries only QC-passed refunds under the attempt cap, keeping their QC result', async () => {
    prismaStub.return.findMany.mockResolvedValue([{ id: 7 }]);
    const processRefund = vi.spyOn(returnService, 'processRefund').mockResolvedValue({ success: true, refundAmount: 1 });

    await returnService.retryFailedRefunds();

    expect(prismaStub.return.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          refundStatus: 'FAILED',
          qcStatus: { in: ['APPROVED', 'PARTIAL'] },
          refundAttempts: { lt: REFUND_MAX_ATTEMPTS },
          isExchange: false,
        },
      })
    );
    // No partial flag passed: the stored QC result decides.
    expect(processRefund).toHaveBeenCalledWith(7);
  });
});

describe('returnService.refundOrder (direct refund from the order page)', () => {
  const order = {
    id: 3,
    shopifyOrderId: '333',
    totalAmount: 1598,
    items: [{ id: 31, quantity: 1, shopifyVariantId: '9001', sku: 'KURTA-S', title: 'Cotton Kurta', variantTitle: 'S' }],
    returns: [{ id: 70, refundStatus: 'NONE' }],
  };

  beforeEach(() => {
    resetStubs();
    prismaStub.order.findUnique.mockResolvedValue(order);
    vi.spyOn(shopifyService, 'fetchOrder').mockResolvedValue({ line_items: [kurtaS] } as any);
    vi.spyOn(shopifyService, 'createRefund').mockResolvedValue({
      refundId: '5001',
      success: true,
      amount: 200,
      moneyMoved: true,
      alreadyRefunded: false,
    });
  });

  it('a partial goodwill refund is money only and leaves the order and its return open', async () => {
    await returnService.refundOrder(3, 200);

    expect(shopifyService.createRefund).toHaveBeenCalledWith('333', 200, [], false);
    expect(prismaStub.order.update).toHaveBeenCalledWith({
      where: { id: 3 },
      data: { financialStatus: 'partially_refunded' },
    });
    expect(prismaStub.return.update).not.toHaveBeenCalled();
  });

  it('records the authenticated user who initiated a direct Shopify refund', async () => {
    const actor = { uid: 'u-12', email: 'finance@youthnic.com', name: 'Finance User', role: 'ADMIN' };
    await returnService.refundOrder(3, 200, 'goodwill', actor);

    expect(prismaStub.accountTrailEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId: 3,
        returnId: null,
        eventType: 'REFUND_AUTOMATIC',
        actorType: 'USER',
        actorUid: 'u-12',
        actorEmail: 'finance@youthnic.com',
        actorName: 'Finance User',
        source: 'ORDER_PAGE',
        status: 'COMPLETED',
        amount: 200,
        refundMode: 'ORIGINAL_PAYMENT_METHOD',
        externalReference: '5001',
      }),
    });
  });

  it('a full refund closes the open return and restocks the items it brings back', async () => {
    await returnService.refundOrder(3);

    const [, , lines, refundShipping] = (shopifyService.createRefund as any).mock.calls[0];
    expect(lines).toEqual([{ lineItemId: 501, quantity: 1, restockType: 'return' }]);
    expect(refundShipping).toBe(true);
    expect(prismaStub.return.update.mock.calls[0][0]).toMatchObject({
      where: { id: 70 },
      data: { returnStatus: 'REFUNDED', refundStatus: 'PROCESSED' },
    });
  });

  it('a full refund with no return coming back does not restock', async () => {
    prismaStub.order.findUnique.mockResolvedValue({ ...order, returns: [] });

    await returnService.refundOrder(3);

    const [, , lines] = (shopifyService.createRefund as any).mock.calls[0];
    expect(lines[0].restockType).toBe('no_restock');
  });
});

describe('orderService.processRtoRefund', () => {
  const rtoOrder = {
    id: 5,
    shopifyOrderId: '555',
    shopifyOrderName: '#26YOU5000',
    paymentMethod: 'Pre-paid',
    financialStatus: 'paid',
    status: 'RTO_INITIATED',
    totalAmount: 999,
    deliveredAt: null,
    supportFlag: null,
    customerName: 'Asha',
    items: [],
    shipment: { waybillNumber: '30100810055555' },
  };

  beforeEach(() => {
    resetStubs();
    vi.spyOn(shopifyService, 'createRefund').mockResolvedValue({
      refundId: '4001',
      success: true,
      amount: 999,
      moneyMoved: true,
      alreadyRefunded: false,
    });
    vi.spyOn(shopifyService, 'updateOrderTags').mockResolvedValue(undefined as any);
    delhiveryStub.trackShipment.mockResolvedValue({ statusType: 'DL', status: 'RTO' });
    delhiveryStub.mapTrackingToShipmentStatus.mockReturnValue('RTO_DELIVERED');
  });

  it('refunds a prepaid RTO that Delhivery confirms, with an idempotency key', async () => {
    prismaStub.order.findUnique.mockResolvedValue(rtoOrder);

    const result = await orderService.processRtoRefund(5);

    expect(result.success).toBe(true);
    expect(delhiveryStub.trackShipment).toHaveBeenCalledWith('30100810055555');
    expect(shopifyService.createRefund).toHaveBeenCalledWith('555', 999, [], true, { idempotencyKey: 'oms-rto-5' });
    expect(prismaStub.accountTrailEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId: 5,
        eventType: 'REFUND_AUTOMATIC',
        actorType: 'SYSTEM',
        source: 'RTO_AUTO_REFUND',
        status: 'COMPLETED',
        amount: 999,
        refundMode: 'ORIGINAL_PAYMENT_METHOD',
        externalReference: '4001',
      }),
    });
  });

  it('never refunds an order the customer received, whatever the carrier data says', async () => {
    prismaStub.order.findUnique.mockResolvedValue({ ...rtoOrder, status: 'DELIVERED', deliveredAt: new Date() });

    const result = await orderService.processRtoRefund(5);

    expect(result.success).toBe(false);
    expect(shopifyService.createRefund).not.toHaveBeenCalled();
    expect(prismaStub.order.update).toHaveBeenCalledWith({
      where: { id: 5 },
      data: { hasUrgentSupport: true, supportFlag: 'RTO_REFUND_REVIEW' },
    });
  });

  it('refunds a prepaid order that was cancelled after pickup once its RTO is confirmed', async () => {
    prismaStub.order.findUnique.mockResolvedValue({ ...rtoOrder, status: 'CANCELLED' });

    const result = await orderService.processRtoRefund(5);

    expect(result.success).toBe(true);
    expect(shopifyService.createRefund).toHaveBeenCalledWith('555', 999, [], true, { idempotencyKey: 'oms-rto-5' });
  });

  it('does not refund an order whose payment was voided', async () => {
    prismaStub.order.findUnique.mockResolvedValue({ ...rtoOrder, financialStatus: 'voided' });

    const result = await orderService.processRtoRefund(5);

    expect(result.success).toBe(true);
    expect(shopifyService.createRefund).not.toHaveBeenCalled();
  });

  it('does not refund when Delhivery tracking does not show RTO delivered (forged scan)', async () => {
    prismaStub.order.findUnique.mockResolvedValue(rtoOrder);
    delhiveryStub.mapTrackingToShipmentStatus.mockReturnValue('IN_TRANSIT');

    const result = await orderService.processRtoRefund(5);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/not RTO delivered/);
    expect(shopifyService.createRefund).not.toHaveBeenCalled();
  });

  it('flags a failed Shopify refund for the retry cron instead of dropping it', async () => {
    prismaStub.order.findUnique.mockResolvedValue(rtoOrder);
    (shopifyService.createRefund as any).mockRejectedValueOnce(new Error('Shopify 502'));

    await expect(orderService.processRtoRefund(5)).rejects.toThrow('Shopify 502');
    expect(prismaStub.order.update).toHaveBeenCalledWith({
      where: { id: 5 },
      data: { hasUrgentSupport: true, supportFlag: 'RTO_REFUND_FAILED' },
    });
  });

  it('hands an order to a person after repeated RTO refund failures', async () => {
    prismaStub.order.findMany.mockResolvedValue([{ id: 5, shopifyOrderName: '#26YOU5000' }]);
    prismaStub.syncLog.count.mockResolvedValue(5);

    const refunded = await orderService.retryFailedRtoRefunds();

    expect(refunded).toBe(0);
    expect(shopifyService.createRefund).not.toHaveBeenCalled();
    expect(prismaStub.order.update).toHaveBeenCalledWith({ where: { id: 5 }, data: { supportFlag: 'RTO_REFUND_REVIEW' } });
  });
});
