import { describe, it, expect } from 'vitest';
import { dashboardPeriodRange } from '../src/modules/accounts/settlement-summary';
import { classifyOrderTab, isPrepaidOrder } from '../src/modules/orders/order-tabs';

describe('Dashboard Digest IST Period Ranges & Queue Accuracy', () => {
  it('computes today and yesterday in IST (+05:30) even when the server clock is in UTC', () => {
    // 2026-11-17T20:00:00Z is 2026-11-18 01:30 AM IST (next calendar day in India).
    const utcEveningIstNextMorning = new Date('2026-11-17T20:00:00.000Z');

    const today = dashboardPeriodRange('today', utcEveningIstNextMorning);
    expect(today.gte?.toISOString()).toBe('2026-11-17T18:30:00.000Z'); // 2026-11-18 00:00 IST
    expect(today.lt?.toISOString()).toBe('2026-11-18T18:30:00.000Z');

    const yesterday = dashboardPeriodRange('yesterday', utcEveningIstNextMorning);
    expect(yesterday.gte?.toISOString()).toBe('2026-11-16T18:30:00.000Z');
    expect(yesterday.lt?.toISOString()).toBe('2026-11-17T18:30:00.000Z');

    const month = dashboardPeriodRange('month', utcEveningIstNextMorning);
    expect(month.gte?.toISOString()).toBe('2026-10-31T18:30:00.000Z'); // 2026-11-01 00:00 IST
    expect(month.lt).toBeUndefined();

    expect(dashboardPeriodRange('all', utcEveningIstNextMorning)).toEqual({});
  });

  it('counts only unshipped approved prepaid orders in the dispatch queue rather than all historical prepaid orders', () => {
    const orders = [
      {
        status: 'DELIVERED',
        paymentMethod: 'GoKwik',
        paymentGateway: 'gokwik',
        financialStatus: 'paid',
        tags: 'prepaid',
        shipment: { status: 'DELIVERED', waybillNumber: 'AWB100' },
        returns: [],
      },
      {
        status: 'DISPATCH_PENDING',
        paymentMethod: 'PREPAID',
        paymentGateway: 'gokwik',
        financialStatus: 'paid',
        tags: '',
        shipment: null,
        returns: [],
      },
      {
        status: 'DISPATCH_PENDING',
        paymentMethod: 'COD',
        paymentGateway: 'Cash on Delivery (COD)',
        financialStatus: 'pending',
        tags: 'COD_CONFIRMED',
        shipment: null,
        returns: [],
      },
    ];

    const readyToDispatch = orders.filter((o) => classifyOrderTab(o) === 'dispatch').length;
    const prepaidPendingDispatchCount = orders.filter(
      (o) => classifyOrderTab(o) === 'dispatch' && isPrepaidOrder(o)
    ).length;

    expect(readyToDispatch).toBe(2);
    expect(prepaidPendingDispatchCount).toBe(1);
  });
});
