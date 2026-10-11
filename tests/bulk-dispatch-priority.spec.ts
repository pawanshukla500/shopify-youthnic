import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  prioritizeOrdersForDispatch,
  isPrepaidOrder,
  type OrderTabSnapshot,
} from '../src/modules/orders/order-tabs';

describe('Bulk Dispatch Priority System (Prepaid First + FIFO COD)', () => {
  it('correctly identifies Prepaid vs COD orders', () => {
    expect(isPrepaidOrder({ paymentMethod: 'Prepaid' })).toBe(true);
    expect(isPrepaidOrder({ paymentMethod: 'Pre-paid' })).toBe(true);
    expect(isPrepaidOrder({ paymentMethod: 'UPI' })).toBe(true);
    expect(isPrepaidOrder({ paymentGateway: 'PhonePe' })).toBe(true);
    expect(isPrepaidOrder({ paymentGateway: 'Easebuzz' })).toBe(true);
    expect(isPrepaidOrder({ paymentGateway: 'Razorpay' })).toBe(true);
    expect(isPrepaidOrder({ financialStatus: 'paid' })).toBe(true);
    expect(isPrepaidOrder({ tags: 'Prepaid, GoKwik' })).toBe(true);

    expect(isPrepaidOrder({ paymentMethod: 'COD' })).toBe(false);
    expect(isPrepaidOrder({ paymentMethod: 'Cash on Delivery' })).toBe(false);
    expect(isPrepaidOrder({ paymentMethod: 'COD', tags: 'COD, Low RTO' })).toBe(false);
  });

  it('always gives priority to Prepaid orders over COD orders regardless of creation date', () => {
    const orders = [
      {
        id: 1,
        shopifyOrderName: '#COD-OLD',
        paymentMethod: 'COD',
        shopifyCreatedAt: new Date('2026-10-01T08:00:00Z'),
      },
      {
        id: 2,
        shopifyOrderName: '#PREPAID-NEW',
        paymentMethod: 'Prepaid',
        shopifyCreatedAt: new Date('2026-10-10T12:00:00Z'),
      },
      {
        id: 3,
        shopifyOrderName: '#COD-NEW',
        paymentMethod: 'COD',
        shopifyCreatedAt: new Date('2026-10-11T10:00:00Z'),
      },
      {
        id: 4,
        shopifyOrderName: '#PREPAID-OLD',
        paymentMethod: 'Prepaid',
        shopifyCreatedAt: new Date('2026-10-05T09:00:00Z'),
      },
    ];

    const sorted = prioritizeOrdersForDispatch(orders);
    const sortedNames = sorted.map((o) => o.shopifyOrderName);

    // Expected:
    // 1. #PREPAID-OLD (Prepaid FIFO 1)
    // 2. #PREPAID-NEW (Prepaid FIFO 2)
    // 3. #COD-OLD (COD FIFO 1)
    // 4. #COD-NEW (COD FIFO 2)
    expect(sortedNames).toEqual([
      '#PREPAID-OLD',
      '#PREPAID-NEW',
      '#COD-OLD',
      '#COD-NEW',
    ]);
  });

  it('orders multiple prepaid orders strictly on FIFO basis (oldest first)', () => {
    const prepaidOrders = [
      {
        id: 10,
        shopifyOrderName: '#P3',
        paymentMethod: 'UPI',
        shopifyCreatedAt: new Date('2026-10-11T15:00:00Z'),
      },
      {
        id: 11,
        shopifyOrderName: '#P1',
        paymentMethod: 'Prepaid',
        shopifyCreatedAt: new Date('2026-10-11T09:00:00Z'),
      },
      {
        id: 12,
        shopifyOrderName: '#P2',
        paymentMethod: 'PhonePe',
        shopifyCreatedAt: new Date('2026-10-11T12:00:00Z'),
      },
    ];

    const sorted = prioritizeOrdersForDispatch(prepaidOrders);
    expect(sorted.map((o) => o.shopifyOrderName)).toEqual(['#P1', '#P2', '#P3']);
  });

  it('orders multiple COD orders strictly on FIFO basis (oldest first)', () => {
    const codOrders = [
      {
        id: 20,
        shopifyOrderName: '#COD3',
        paymentMethod: 'COD',
        shopifyCreatedAt: new Date('2026-10-11T16:00:00Z'),
      },
      {
        id: 21,
        shopifyOrderName: '#COD1',
        paymentMethod: 'COD',
        shopifyCreatedAt: new Date('2026-10-10T10:00:00Z'),
      },
      {
        id: 22,
        shopifyOrderName: '#COD2',
        paymentMethod: 'COD',
        shopifyCreatedAt: new Date('2026-10-11T08:00:00Z'),
      },
    ];

    const sorted = prioritizeOrdersForDispatch(codOrders);
    expect(sorted.map((o) => o.shopifyOrderName)).toEqual(['#COD1', '#COD2', '#COD3']);
  });

  it('handles empty list or single item without mutation', () => {
    expect(prioritizeOrdersForDispatch([])).toEqual([]);

    const single = [{ id: 1, paymentMethod: 'COD', shopifyCreatedAt: new Date() }];
    expect(prioritizeOrdersForDispatch(single)).toEqual(single);
  });

  it('breaks ties deterministically using order id', () => {
    const sameTime = new Date('2026-10-11T10:00:00Z');
    const orders = [
      { id: 105, shopifyOrderName: '#P-105', paymentMethod: 'Prepaid', shopifyCreatedAt: sameTime },
      { id: 101, shopifyOrderName: '#P-101', paymentMethod: 'Prepaid', shopifyCreatedAt: sameTime },
      { id: 205, shopifyOrderName: '#COD-205', paymentMethod: 'COD', shopifyCreatedAt: sameTime },
      { id: 201, shopifyOrderName: '#COD-201', paymentMethod: 'COD', shopifyCreatedAt: sameTime },
    ];

    const sorted = prioritizeOrdersForDispatch(orders);
    expect(sorted.map((o) => o.shopifyOrderName)).toEqual([
      '#P-101',
      '#P-105',
      '#COD-201',
      '#COD-205',
    ]);
  });
});
