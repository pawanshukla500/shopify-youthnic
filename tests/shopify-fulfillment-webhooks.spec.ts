/**
 * Unit tests for the Shopify fulfillment webhook handling in src/routes/webhooks.ts.
 *
 * Covers:
 *   VAL-SYNC-001  fulfillments/create -> 200 { received: true }, records a
 *                 WEBHOOK_RECEIVE SyncLog, fetches the parent order, and calls
 *                 syncOrderToDb(parentOrder).
 *   VAL-SYNC-002  fulfillments/update -> fetches parent order + syncOrderToDb.
 *   VAL-SYNC-003  invalid/missing HMAC -> 401 without any order fetch or DB write.
 *
 * The route handler is invoked directly (Express router layer) with mock
 * req/res objects, so no HTTP server or supertest dependency is needed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/modules/shopify/shopify.service', () => ({
  default: {
    verifyWebhook: vi.fn(() => true),
    fetchOrder: vi.fn(async () => ({ id: 456, name: '#YOUTH-456', created_at: '2026-09-26T00:00:00.000Z' })),
    syncOrderToDb: vi.fn(async () => undefined),
  },
}));

vi.mock('../src/modules/orders/order.service', () => ({
  default: {
    syncOrderFromWebhook: vi.fn(async () => true),
    handleOrderCancelled: vi.fn(async () => undefined),
  },
}));

vi.mock('../src/modules/notifications/notification.service', () => ({
  default: { notifyOrderConfirmed: vi.fn(async () => undefined) },
}));

// Hoisted so the stub exists when the (hoisted) vi.mock factory runs.
const { prismaStub } = vi.hoisted(() => ({
  prismaStub: {
    syncLog: { create: vi.fn(async () => ({})) },
    order: { findUnique: vi.fn(async () => null) },
  },
}));
vi.mock('../src/database/prisma', () => ({ default: prismaStub }));

import webhookRouter from '../src/routes/webhooks';
import shopifyService from '../src/modules/shopify/shopify.service';

function getShopifyHandler(): (req: any, res: any) => Promise<void> {
  const routeLayer = (webhookRouter as any).stack.find(
    (l: any) => l.route && l.route.path === '/shopify'
  );
  return routeLayer.route.stack[0].handle;
}

function mockRes() {
  const res: any = { statusCode: null, body: null };
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = vi.fn((payload: any) => {
    res.body = payload;
    return res;
  });
  return res;
}

function fulfillmentReq(topic: string, body: any, hmac = 'valid-signature') {
  return {
    headers: {
      'x-shopify-hmac-sha256': hmac,
      'x-shopify-topic': topic,
    },
    body,
    rawBody: JSON.stringify(body),
  } as any;
}

describe('Shopify fulfillment webhook handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (shopifyService.verifyWebhook as any).mockReturnValue(true);
    (shopifyService.fetchOrder as any).mockResolvedValue({
      id: 456,
      name: '#YOUTH-456',
      created_at: '2026-09-26T00:00:00.000Z',
    });
    (shopifyService.syncOrderToDb as any).mockResolvedValue(undefined);
  });

  it('acknowledges fulfillments/create with 200 and syncs the parent order (VAL-SYNC-001)', async () => {
    const req = fulfillmentReq('fulfillments/create', { id: 999, order_id: 456 });
    const res = mockRes();

    await getShopifyHandler()(req, res);

    expect(shopifyService.verifyWebhook).toHaveBeenCalledWith(req.rawBody, 'valid-signature');
    expect(prismaStub.syncLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ syncType: 'WEBHOOK_RECEIVE' }) })
    );
    expect(shopifyService.fetchOrder).toHaveBeenCalledWith('456');
    expect(shopifyService.syncOrderToDb).toHaveBeenCalledWith(
      expect.objectContaining({ id: 456 })
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.body).toEqual({ received: true });
  });

  it('processes fulfillments/update by fetching the parent order and syncing it (VAL-SYNC-002)', async () => {
    const req = fulfillmentReq('fulfillments/update', { id: 1001, order_id: 456 });
    const res = mockRes();

    await getShopifyHandler()(req, res);

    expect(shopifyService.fetchOrder).toHaveBeenCalledWith('456');
    expect(shopifyService.syncOrderToDb).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.body).toEqual({ received: true });
  });

  it('rejects a fulfillment webhook with an invalid HMAC as 401 and performs no fetch or sync (VAL-SYNC-003)', async () => {
    (shopifyService.verifyWebhook as any).mockReturnValue(false);
    const req = fulfillmentReq('fulfillments/create', { id: 999, order_id: 456 }, 'bad-signature');
    const res = mockRes();

    await getShopifyHandler()(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(shopifyService.fetchOrder).not.toHaveBeenCalled();
    expect(shopifyService.syncOrderToDb).not.toHaveBeenCalled();
    expect(prismaStub.syncLog.create).not.toHaveBeenCalled();
  });

  it('acknowledges but skips syncing when a fulfillment webhook has no order_id', async () => {
    const req = fulfillmentReq('fulfillments/create', { id: 999 });
    const res = mockRes();

    await getShopifyHandler()(req, res);

    expect(shopifyService.fetchOrder).not.toHaveBeenCalled();
    expect(shopifyService.syncOrderToDb).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.body).toEqual({ received: true });
  });
});
