import { beforeEach, describe, expect, it, vi } from 'vitest';

const { orders, shopify } = vi.hoisted(() => ({
  orders: { getOrder: vi.fn(), dispatchOrder: vi.fn(), syncOrdersFromShopify: vi.fn() },
  shopify: { fetchOrder: vi.fn(), syncOrderToDb: vi.fn() },
}));
vi.mock('../src/modules/orders/order.service', () => ({ default: orders }));
vi.mock('../src/modules/shopify/shopify.service', () => ({ default: shopify }));
vi.mock('../src/utils/logger', () => ({ default: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import router from '../src/routes/api';

const handler = (router as any).stack.find((layer: any) =>
  layer.route?.path === '/orders/:id/refresh-shopify'
).route.stack[0].handle;

const response = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn() });
beforeEach(() => {
  vi.clearAllMocks();
  orders.getOrder.mockResolvedValue({ id: 1883, shopifyOrderId: '18951876083911' });
  shopify.fetchOrder.mockResolvedValue({ id: 18951876083911 });
  shopify.syncOrderToDb.mockResolvedValue(undefined);
});

describe('single-order Shopify refresh', () => {
  it('fetches and syncs only the stored Shopify order without bulk sync or dispatch', async () => {
    const res = response();
    await handler({ params: { id: '1883' } }, res);
    expect(shopify.fetchOrder).toHaveBeenCalledWith('18951876083911');
    expect(shopify.syncOrderToDb).toHaveBeenCalledWith({ id: 18951876083911 });
    expect(orders.dispatchOrder).not.toHaveBeenCalled();
    expect(orders.syncOrdersFromShopify).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ order: { id: 1883, shopifyOrderId: '18951876083911' } });
  });

  it.each(['0', '-1', '1junk', '1.5', 'NaN'])('rejects invalid order ids: %s', async (id) => {
    const res = response();
    await handler({ params: { id } }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(shopify.fetchOrder).not.toHaveBeenCalled();
  });

  it('returns 404 without contacting Shopify for an unknown order', async () => {
    orders.getOrder.mockResolvedValueOnce(null);
    const res = response();
    await handler({ params: { id: '1883' } }, res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(shopify.fetchOrder).not.toHaveBeenCalled();
  });

  it('rejects mismatched upstream order identity', async () => {
    shopify.fetchOrder.mockResolvedValueOnce({ id: 999 });
    const res = response();
    await handler({ params: { id: '1883' } }, res);
    expect(res.status).toHaveBeenCalledWith(502);
    expect(shopify.syncOrderToDb).not.toHaveBeenCalled();
  });

  it('handles an upstream outage without claiming a successful refresh', async () => {
    shopify.fetchOrder.mockRejectedValueOnce(new Error('Shopify unavailable'));
    const res = response();
    await handler({ params: { id: '1883' } }, res);
    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json).toHaveBeenCalledWith({ error: expect.stringContaining('Could not refresh') });
    expect(shopify.syncOrderToDb).not.toHaveBeenCalled();
  });

  it('requires authentication on the real API mount', async () => {
    const { requireAuth } = await import('../src/middleware/auth.middleware');
    const res = response();
    const next = vi.fn();
    await requireAuth({ path: '/orders/1883/refresh-shopify', headers: {}, query: {} } as any, res as any, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});
