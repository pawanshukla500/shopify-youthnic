import { describe, it, expect } from 'vitest';
import { ORDER_TABS, resolveOrderTabStatuses, type OrderTab } from '../src/modules/orders/order.service';

describe('order operational tabs', () => {
  it('covers every OrderStatus exactly once (except ALL)', () => {
    const all = Object.values(ORDER_TABS).flat();
    // 15 statuses in prisma enum
    expect(all).toHaveLength(15);
    expect(new Set(all).size).toBe(15);
    expect(all).toContain('NEW');
    expect(all).toContain('CANCELLED');
    expect(all).toContain('DELIVERED');
    expect(all).toContain('REFUNDED');
  });

  it('maps requested 6 stages correctly', () => {
    expect(resolveOrderTabStatuses('new')).toEqual(['NEW']);
    expect(resolveOrderTabStatuses('ready')).toEqual(['DISPATCH_PENDING', 'DISPATCHED']);
    expect(resolveOrderTabStatuses('transit')).toEqual([
      'SHIPPED',
      'IN_TRANSIT',
      'OUT_FOR_DELIVERY',
      'FAILED_DELIVERY',
    ]);
    expect(resolveOrderTabStatuses('delivered')).toEqual(['DELIVERED']);
    expect(resolveOrderTabStatuses('cancel')).toEqual(['CANCELLED']);
    expect(resolveOrderTabStatuses('return')).toContain('RTO_INITIATED');
    expect(resolveOrderTabStatuses('return')).toContain('RETURN_REQUESTED');
    expect(resolveOrderTabStatuses('return')).toContain('REFUNDED');
  });

  it('returns undefined for all/unknown (no status filter)', () => {
    expect(resolveOrderTabStatuses('all')).toBeUndefined();
    expect(resolveOrderTabStatuses(undefined)).toBeUndefined();
    expect(resolveOrderTabStatuses('nonsense')).toBeUndefined();
  });

  it('tab keys match frontend contract', () => {
    const keys = Object.keys(ORDER_TABS);
    expect(keys).toEqual(['new', 'ready', 'transit', 'delivered', 'return', 'cancel']);
    const _typeCheck: OrderTab = 'new';
    expect(_typeCheck).toBe('new');
  });
});
