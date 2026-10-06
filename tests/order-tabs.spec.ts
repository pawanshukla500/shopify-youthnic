import { describe, it, expect } from 'vitest';
import {
  ORDER_TABS,
  resolveOrderTabStatuses,
  resolveOrderTabWaybill,
  resolveOrderTabFilter,
  type OrderTab,
} from '../src/modules/orders/order.service';
import { classifyOrderTab, type OrderTabSnapshot } from '../src/modules/orders/order-tabs';

function order(partial: OrderTabSnapshot): OrderTabSnapshot {
  return { status: 'NEW', paymentMethod: 'COD', tags: 'COD', ...partial };
}

describe('order operational tabs', () => {
  it('lists every OrderStatus once as the coarse fallback', () => {
    const all = Object.values(ORDER_TABS).flat();
    const counts = all.reduce<Record<string, number>>((map, status) => {
      map[status] = (map[status] || 0) + 1;
      return map;
    }, {});
    for (const count of Object.values(counts)) expect(count).toBe(1);
    expect(all).toEqual(
      expect.arrayContaining([
        'NEW',
        'DISPATCH_PENDING',
        'DISPATCHED',
        'SHIPPED',
        'IN_TRANSIT',
        'OUT_FOR_DELIVERY',
        'DELIVERED',
        'FAILED_DELIVERY',
        'RTO_INITIATED',
        'RTO_DELIVERED',
        'RETURN_REQUESTED',
        'RETURN_DISPATCHED',
        'RETURN_RECEIVED',
        'REFUNDED',
        'CANCELLED',
      ])
    );
  });

  it('keeps the coarse AWB hint for older callers', () => {
    expect(resolveOrderTabStatuses('dispatch')).toEqual(['DISPATCH_PENDING']);
    expect(resolveOrderTabWaybill('dispatch')).toBe(false);
    expect(resolveOrderTabStatuses('ready')).toEqual(['DISPATCHED']);
    expect(resolveOrderTabWaybill('ready')).toBe(true);
    expect(resolveOrderTabFilter('dispatch')).toEqual({
      statuses: ['DISPATCH_PENDING'],
      hasWaybill: false,
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
    expect(resolveOrderTabStatuses('all')).toBeUndefined();
    expect(resolveOrderTabStatuses(undefined)).toBeUndefined();
    expect(resolveOrderTabStatuses('nonsense')).toBeUndefined();
    expect(resolveOrderTabFilter('all')).toEqual({});
  });

  it('tab keys match frontend contract', () => {
    const keys = Object.keys(ORDER_TABS);
    expect(keys).toEqual(['new', 'dispatch', 'ready', 'transit', 'delivered', 'return', 'cancel']);
    const _typeCheck: OrderTab = 'dispatch';
    expect(_typeCheck).toBe('dispatch');
  });
});

describe('classifyOrderTab — Delhivery live tracking and Shopify tags', () => {
  it('keeps a fresh unconfirmed COD order in New Order', () => {
    expect(classifyOrderTab(order({ tags: 'COD' }))).toBe('new');
    expect(classifyOrderTab(order({ tags: 'COD, unconfirmed', status: 'NEW' }))).toBe('new');
    expect(classifyOrderTab(order({ tags: 'GoKwik, COD', status: 'DISPATCH_PENDING' }))).toBe('new');
  });

  it('puts prepaid and COD_CONFIRMED orders with no label in Ready to Dispatch', () => {
    expect(
      classifyOrderTab(order({ paymentMethod: 'Pre-paid', tags: 'Prepaid, UPI', financialStatus: 'paid' }))
    ).toBe('dispatch');
    expect(
      classifyOrderTab(order({ tags: 'COD, COD_CONFIRMED', status: 'NEW' }))
    ).toBe('dispatch');
    expect(
      classifyOrderTab(order({ tags: 'COD, Low RTO', status: 'DISPATCH_PENDING' }))
    ).toBe('dispatch');
    expect(
      classifyOrderTab(
        order({
          tags: 'COD, COD_CONFIRMED',
          shipment: { status: 'PENDING', waybillNumber: null, courier: 'Delhivery' },
        })
      )
    ).toBe('dispatch');
  });

  it('puts a generated label that Delhivery has not picked into Ready to Ship', () => {
    const label = {
      waybillNumber: '30100810010054',
      courier: 'Delhivery',
      status: 'CREATED',
      trackingStatus: 'Manifested',
      trackingUpdatedAt: '2026-10-06T10:00:00.000Z',
    };
    expect(classifyOrderTab(order({ status: 'DISPATCHED', shipment: label }))).toBe('ready');
    expect(
      classifyOrderTab(
        order({
          status: 'IN_TRANSIT',
          shipment: { ...label, status: 'IN_TRANSIT', trackingStatus: 'Not Picked' },
        })
      )
    ).toBe('ready');
    expect(
      classifyOrderTab(
        order({
          status: 'SHIPPED',
          paymentMethod: 'Pre-paid',
          shipment: {
            waybillNumber: 'AWB1',
            courier: 'Delhivery',
            status: 'IN_TRANSIT',
            trackingStatus: 'In Transit',
            trackingUpdatedAt: null,
          },
        })
      )
    ).toBe('ready');
    expect(
      classifyOrderTab(
        order({
          status: 'DISPATCHED',
          shipment: {
            waybillNumber: 'AWB2',
            courier: 'Delhivery',
            status: 'CREATED',
            trackingStatus: 'Label generated',
          },
        })
      )
    ).toBe('ready');
  });

  it('moves a parcel to In Transit only after Delhivery reports pickup', () => {
    expect(
      classifyOrderTab(
        order({
          status: 'SHIPPED',
          shipment: {
            waybillNumber: 'AWB3',
            courier: 'Delhivery',
            status: 'PICKED_UP',
            trackingStatus: 'Picked Up',
            trackingUpdatedAt: '2026-10-06T12:00:00.000Z',
          },
        })
      )
    ).toBe('transit');
    expect(
      classifyOrderTab(
        order({
          status: 'IN_TRANSIT',
          shipment: {
            waybillNumber: 'AWB4',
            courier: 'Delhivery',
            status: 'IN_TRANSIT',
            trackingStatus: 'In Transit',
            trackingUpdatedAt: '2026-10-06T12:00:00.000Z',
          },
        })
      )
    ).toBe('transit');
    expect(
      classifyOrderTab(
        order({
          status: 'OUT_FOR_DELIVERY',
          shipment: {
            waybillNumber: 'AWB5',
            courier: 'Delhivery',
            status: 'OUT_FOR_DELIVERY',
            trackingStatus: 'Dispatched',
            trackingUpdatedAt: '2026-10-06T15:00:00.000Z',
          },
        })
      )
    ).toBe('transit');
    expect(
      classifyOrderTab(
        order({
          status: 'FAILED_DELIVERY',
          shipment: {
            waybillNumber: 'AWB6',
            courier: 'Delhivery',
            status: 'FAILED',
            trackingStatus: 'Pending',
            trackingUpdatedAt: '2026-10-06T16:00:00.000Z',
          },
        })
      )
    ).toBe('transit');
  });

  it('puts customer deliveries in Delivered and RTO / returns in Return', () => {
    expect(
      classifyOrderTab(
        order({
          status: 'DELIVERED',
          shipment: {
            waybillNumber: 'AWB7',
            courier: 'Delhivery',
            status: 'DELIVERED',
            trackingStatus: 'Delivered',
            trackingUpdatedAt: '2026-10-06T18:00:00.000Z',
          },
        })
      )
    ).toBe('delivered');
    expect(classifyOrderTab(order({ status: 'RTO_INITIATED' }))).toBe('return');
    expect(
      classifyOrderTab(
        order({
          status: 'IN_TRANSIT',
          shipment: {
            waybillNumber: 'AWB8',
            courier: 'Delhivery',
            status: 'RTO',
            trackingStatus: 'In Transit',
            trackingUpdatedAt: '2026-10-06T18:00:00.000Z',
          },
        })
      )
    ).toBe('return');
    expect(
      classifyOrderTab(
        order({
          status: 'DELIVERED',
          returns: [{ returnStatus: 'INITIATED' }],
          shipment: {
            waybillNumber: 'AWB9',
            status: 'DELIVERED',
            trackingStatus: 'Delivered',
            trackingUpdatedAt: '2026-10-06T18:00:00.000Z',
          },
        })
      )
    ).toBe('return');
  });

  it('puts pre-ship cancels and High RTO / COD_CANCELLED in Cancel', () => {
    expect(classifyOrderTab(order({ status: 'CANCELLED' }))).toBe('cancel');
    expect(classifyOrderTab(order({ tags: 'COD, COD_CANCELLED', status: 'NEW' }))).toBe('cancel');
    expect(classifyOrderTab(order({ tags: 'COD, gokwik_cod_blocking', status: 'DISPATCH_PENDING' }))).toBe('cancel');
    expect(classifyOrderTab(order({ tags: 'COD, High RTO', status: 'NEW' }))).toBe('cancel');
    expect(
      classifyOrderTab(
        order({
          status: 'DISPATCHED',
          tags: 'COD, COD_CANCELLED',
          shipment: {
            waybillNumber: 'AWB10',
            courier: 'Delhivery',
            status: 'CANCELLED',
            trackingStatus: 'Not Picked (Seller cancelled)',
            trackingUpdatedAt: '2026-10-06T11:00:00.000Z',
          },
        })
      )
    ).toBe('cancel');
    expect(classifyOrderTab(order({ status: 'REFUNDED', financialStatus: 'refunded' }))).toBe('cancel');
  });

  it('sends a low-wallet manifest failure back to Ready to Dispatch and leaves cancel and RTO alone', () => {
    const reserved = {
      waybillNumber: '30100810010275',
      courier: 'Delhivery',
      status: 'ERROR',
      errorMessage:
        'Delhivery Manifest Failed: Insufficient balance in Delhivery prepaid wallet. Please recharge your Delhivery One account.',
      trackingStatus: null,
      trackingUpdatedAt: null,
    };
    expect(
      classifyOrderTab(order({ status: 'DISPATCH_PENDING', tags: 'COD, Low RTO', shipment: reserved }))
    ).toBe('dispatch');
    expect(
      classifyOrderTab(order({ status: 'DISPATCHED', paymentMethod: 'Pre-paid', tags: 'Prepaid', shipment: reserved }))
    ).toBe('dispatch');
    expect(classifyOrderTab(order({ status: 'CANCELLED', shipment: reserved }))).toBe('cancel');
    expect(classifyOrderTab(order({ status: 'RTO_INITIATED', shipment: reserved }))).toBe('return');
    expect(
      classifyOrderTab(
        order({
          status: 'IN_TRANSIT',
          shipment: {
            ...reserved,
            status: 'IN_TRANSIT',
            errorMessage: null,
            trackingStatus: 'In Transit',
            trackingUpdatedAt: '2026-10-06T12:00:00.000Z',
          },
        })
      )
    ).toBe('transit');
  });

  it('does not treat a third-party in-transit scan as an unpicked Delhivery label', () => {
    expect(
      classifyOrderTab(
        order({
          status: 'IN_TRANSIT',
          shipment: {
            waybillNumber: 'EK123',
            courier: 'Ekart',
            status: 'IN_TRANSIT',
            trackingStatus: 'in transit',
          },
        })
      )
    ).toBe('transit');
  });

  it('places every sample in exactly one tab', () => {
    const samples: OrderTabSnapshot[] = [
      order({}),
      order({ paymentMethod: 'Pre-paid', tags: 'Prepaid' }),
      order({ tags: 'COD_CONFIRMED' }),
      order({ tags: 'COD_CANCELLED' }),
      order({
        status: 'DISPATCHED',
        shipment: { waybillNumber: '1', status: 'CREATED', trackingStatus: 'Manifested', trackingUpdatedAt: '2026-10-06T00:00:00.000Z' },
      }),
      order({
        status: 'IN_TRANSIT',
        shipment: { waybillNumber: '2', status: 'IN_TRANSIT', trackingStatus: 'In Transit', trackingUpdatedAt: '2026-10-06T00:00:00.000Z' },
      }),
      order({ status: 'DELIVERED', shipment: { waybillNumber: '3', status: 'DELIVERED', trackingStatus: 'Delivered', trackingUpdatedAt: '2026-10-06T00:00:00.000Z' } }),
      order({ status: 'RTO_DELIVERED' }),
    ];
    const tabs = ['new', 'dispatch', 'ready', 'transit', 'delivered', 'return', 'cancel'];
    for (const sample of samples) {
      expect(tabs).toContain(classifyOrderTab(sample));
    }
  });
});
