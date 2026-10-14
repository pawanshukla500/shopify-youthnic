/**
 * "Payment Received" closing rule (order-tabs.accountsStatus) and its tab.
 */
import { describe, it, expect } from 'vitest';
import { RETURN_WINDOW_DAYS, accountsStatus, classifyOrderTab, returnWindowClosesAt } from '../src/modules/orders/order-tabs';

const DAY = 24 * 3600 * 1000;
const now = new Date('2026-11-08T03:30:00.000Z'); // 8 Nov 2026, 09:00 IST

function delivered(overrides: Record<string, any> = {}) {
  return {
    status: 'DELIVERED',
    paymentMethod: 'COD',
    tags: 'COD, COD_CONFIRMED',
    deliveredAt: new Date(now.getTime() - 10 * DAY),
    paymentReceivedAt: new Date(now.getTime() - 5 * DAY),
    paymentReceivedUtr: 'UTIBR52026100800123',
    shipment: { status: 'DELIVERED', waybillNumber: '30100810011111', trackingStatus: 'Delivered', trackingUpdatedAt: new Date() },
    returns: [],
    ...overrides,
  };
}

describe('accountsStatus', () => {
  it('closes a delivered order once it is paid into the bank and the return window is over', () => {
    const status = accountsStatus(delivered(), now);
    expect(status.state).toBe('CLOSED');
    expect(status.pending).toEqual([]);
  });

  it('counts the return window as 7 days from delivery', () => {
    expect(RETURN_WINDOW_DAYS).toBe(7);
    const deliveredAt = new Date('2026-10-20T10:00:00.000Z');
    expect(returnWindowClosesAt({ deliveredAt })?.toISOString()).toBe('2026-10-27T10:00:00.000Z');
  });

  it('stays open, saying why, while the return window runs', () => {
    const status = accountsStatus(delivered({ deliveredAt: new Date(now.getTime() - 3 * DAY) }), now);
    expect(status.state).toBe('OPEN');
    expect(status.pending.join(' ')).toMatch(/Return window open until/);
  });

  it('stays open until the money is in the bank', () => {
    const status = accountsStatus(delivered({ paymentReceivedAt: null }), now);
    expect(status.state).toBe('OPEN');
    expect(status.pending).toContain('Payment not received in bank (no UTR yet)');
  });

  it('stays open when a payment was recorded without its bank UTR', () => {
    const status = accountsStatus(delivered({ paymentReceivedUtr: null }), now);
    expect(status.state).toBe('OPEN');
    expect(status.paymentReceived).toBe(false);
    expect(status.pending).toEqual(['Payment recorded but the bank UTR is missing']);
  });

  it('stays open while a return is in progress', () => {
    const status = accountsStatus(delivered({ returns: [{ returnStatus: 'PICKUP_SCHEDULED' }] }), now);
    expect(status.state).toBe('OPEN');
    expect(status.pending).toContain('Return in progress');
  });

  it('treats cancelled, refunded and RTO orders as not a sale', () => {
    expect(accountsStatus(delivered({ status: 'CANCELLED' }), now).state).toBe('NOT_A_SALE');
    expect(accountsStatus(delivered({ status: 'REFUNDED' }), now).state).toBe('NOT_A_SALE');
    expect(accountsStatus(delivered({ status: 'RTO_DELIVERED' }), now).state).toBe('NOT_A_SALE');
  });

  it('lists every open reason for an undelivered, unpaid order', () => {
    const status = accountsStatus(
      delivered({ status: 'IN_TRANSIT', deliveredAt: null, paymentReceivedAt: null, shipment: { status: 'IN_TRANSIT', waybillNumber: '1', trackingStatus: 'In Transit', trackingUpdatedAt: new Date() } }),
      now
    );
    expect(status.pending).toEqual(['Not delivered yet', 'Payment not received in bank (no UTR yet)']);
  });
});

describe('Payment Received tab', () => {
  it('moves a closed order out of Delivered into Payment Received', () => {
    // classifyOrderTab uses the real clock, so build dates relative to it.
    const realNow = Date.now();
    const closed = delivered({
      deliveredAt: new Date(realNow - 10 * DAY),
      paymentReceivedAt: new Date(realNow - 2 * DAY),
    });
    expect(classifyOrderTab(closed)).toBe('closed');
    expect(classifyOrderTab({ ...closed, paymentReceivedAt: null })).toBe('delivered');
    expect(classifyOrderTab({ ...closed, paymentReceivedUtr: null })).toBe('delivered');
    expect(classifyOrderTab({ ...closed, deliveredAt: new Date(realNow - DAY) })).toBe('closed');
  });

  it('keeps an order with an open return in the Return tab', () => {
    const realNow = Date.now();
    const order = delivered({
      deliveredAt: new Date(realNow - 10 * DAY),
      paymentReceivedAt: new Date(realNow - 2 * DAY),
      returns: [{ returnStatus: 'IN_TRANSIT' }],
    });
    expect(classifyOrderTab(order)).toBe('return');
  });
});
