import { describe, it, expect } from 'vitest';
import {
  ORDER_TABS,
  resolveOrderTabStatuses,
  resolveOrderTabWaybill,
  resolveOrderTabFilter,
  type OrderTab,
} from '../src/modules/orders/order.service';

describe('order operational tabs', () => {
  it('covers every OrderStatus (dispatch+ready share pending/dispatched, split by AWB)', () => {
    const all = Object.values(ORDER_TABS).flat();
    // dispatch & ready intentionally share DISPATCH_PENDING/DISPATCHED (AWB split);
    // every other status appears exactly once.
    const counts = all.reduce<Record<string, number>>((m, s) => {
      m[s] = (m[s] || 0) + 1;
      return m;
    }, {});
    expect(counts['DISPATCH_PENDING']).toBe(2);
    expect(counts['DISPATCHED']).toBe(2);
    for (const [s, n] of Object.entries(counts)) {
      if (s !== 'DISPATCH_PENDING' && s !== 'DISPATCHED') expect(n).toBe(1);
    }
    expect(all).toContain('NEW');
    expect(all).toContain('CANCELLED');
    expect(all).toContain('DELIVERED');
    expect(all).toContain('REFUNDED');
  });

  it('splits Ready by AWB: dispatch = no AWB, ready = label generated', () => {
    expect(resolveOrderTabStatuses('dispatch')).toEqual(['DISPATCH_PENDING', 'DISPATCHED']);
    expect(resolveOrderTabWaybill('dispatch')).toBe(false);
    expect(resolveOrderTabStatuses('ready')).toEqual(['DISPATCH_PENDING', 'DISPATCHED']);
    expect(resolveOrderTabWaybill('ready')).toBe(true);
    expect(resolveOrderTabFilter('dispatch')).toEqual({
      statuses: ['DISPATCH_PENDING', 'DISPATCHED'],
      hasWaybill: false,
    });
    expect(resolveOrderTabFilter('ready')).toEqual({
      statuses: ['DISPATCH_PENDING', 'DISPATCHED'],
      hasWaybill: true,
    });
    expect(resolveOrderTabStatuses('new')).toEqual(['NEW']);
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

  it('returns undefined filter for all/unknown', () => {
    expect(resolveOrderTabStatuses('all')).toBeUndefined();
    expect(resolveOrderTabStatuses(undefined)).toBeUndefined();
    expect(resolveOrderTabStatuses('nonsense')).toBeUndefined();
    expect(resolveOrderTabWaybill('all')).toBeUndefined();
    expect(resolveOrderTabFilter('all')).toEqual({});
  });

  it('tab keys match frontend contract', () => {
    const keys = Object.keys(ORDER_TABS);
    expect(keys).toEqual(['new', 'dispatch', 'ready', 'transit', 'delivered', 'return', 'cancel']);
    const _typeCheck: OrderTab = 'dispatch';
    expect(_typeCheck).toBe('dispatch');
  });
});
