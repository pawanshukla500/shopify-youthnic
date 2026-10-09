/**
 * Tracking cron guards (trackingService.syncAllTracking):
 *   - an empty Delhivery answer never moves a live shipment
 *   - a transition a scan webhook already applied is not repeated (no
 *     duplicate customer message)
 *   - a cancelled order's moving parcel is flagged, the order left alone
 *   - delivery stamps deliveredAt and marks COD collected in the same write
 *   - never-polled shipments are polled first
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { prismaStub, delhiveryStub, notifyStub } = vi.hoisted(() => ({
  prismaStub: {
    shipment: { findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    order: { update: vi.fn() },
    trackingLog: { findMany: vi.fn(), create: vi.fn() },
    syncLog: { create: vi.fn() },
    emailLog: { findFirst: vi.fn() },
  },
  delhiveryStub: { trackShipment: vi.fn(), mapTrackingToShipmentStatus: vi.fn() },
  notifyStub: {
    notifyInTransit: vi.fn(),
    notifyOutForDelivery: vi.fn(),
    notifyDelivered: vi.fn(),
    notifyNDR: vi.fn(),
    sendCustomMessage: vi.fn(),
  },
}));
vi.mock('../src/database/prisma', () => ({ default: prismaStub }));
vi.mock('../src/modules/delhivery/delhivery.service', () => ({ default: delhiveryStub }));
vi.mock('../src/modules/notifications/notification.service', () => ({ default: notifyStub }));
vi.mock('../src/modules/returns/return.service', () => ({ default: { syncActiveReturns: vi.fn(async () => 0) } }));
vi.mock('../src/modules/email/resend.service', () => ({ default: { sendEmail: vi.fn() } }));
const { orderServiceStub } = vi.hoisted(() => ({ orderServiceStub: { processRtoRefund: vi.fn() } }));
vi.mock('../src/modules/orders/order.service', () => ({ default: orderServiceStub }));

import trackingService from '../src/modules/tracking/tracking.service';

function shipment(overrides: Record<string, any> = {}) {
  return {
    id: 1,
    orderId: 10,
    waybillNumber: '30100810077777',
    courier: 'Delhivery',
    status: 'IN_TRANSIT',
    paymentMode: 'Prepaid',
    codAmount: 0,
    codCollected: false,
    labelUrl: null,
    order: { id: 10, status: 'IN_TRANSIT', customerEmail: null, items: [], deliveredAt: null, supportFlag: null },
    ...overrides,
  };
}

describe('tracking cron guards', () => {
  beforeEach(() => {
    for (const group of [...Object.values(prismaStub), delhiveryStub, notifyStub]) {
      for (const fn of Object.values(group)) (fn as any).mockReset();
    }
    prismaStub.shipment.update.mockResolvedValue({});
    prismaStub.shipment.updateMany.mockResolvedValue({ count: 1 });
    prismaStub.order.update.mockResolvedValue({});
    prismaStub.trackingLog.findMany.mockResolvedValue([]);
    prismaStub.syncLog.create.mockResolvedValue({});
  });

  it('polls never-polled shipments first', async () => {
    prismaStub.shipment.findMany.mockResolvedValue([]);

    await trackingService.syncAllTracking();

    expect(prismaStub.shipment.findMany.mock.calls[0][0].orderBy).toEqual({
      trackingUpdatedAt: { sort: 'asc', nulls: 'first' },
    });
  });

  it('leaves an out-for-delivery shipment alone when Delhivery returns no package data', async () => {
    prismaStub.shipment.findMany.mockResolvedValue([shipment({ status: 'OUT_FOR_DELIVERY' })]);
    delhiveryStub.trackShipment.mockResolvedValue({ status: 'UNKNOWN', statusType: '', history: [] });
    delhiveryStub.mapTrackingToShipmentStatus.mockReturnValue('IN_TRANSIT');

    await trackingService.syncAllTracking();

    expect(prismaStub.shipment.updateMany).not.toHaveBeenCalled();
    expect(prismaStub.shipment.update).toHaveBeenCalledTimes(1);
    expect(Object.keys(prismaStub.shipment.update.mock.calls[0][0].data)).toEqual(['trackingUpdatedAt']);
    expect(notifyStub.notifyInTransit).not.toHaveBeenCalled();
  });

  it('does not repeat a transition a scan webhook already applied', async () => {
    prismaStub.shipment.findMany.mockResolvedValue([shipment({ status: 'IN_TRANSIT' })]);
    delhiveryStub.trackShipment.mockResolvedValue({ status: 'Dispatched', statusType: 'UD', history: [] });
    delhiveryStub.mapTrackingToShipmentStatus.mockReturnValue('OUT_FOR_DELIVERY');
    prismaStub.shipment.updateMany.mockResolvedValue({ count: 0 });

    await trackingService.syncAllTracking();

    expect(prismaStub.shipment.updateMany.mock.calls[0][0].where).toEqual({ id: 1, status: 'IN_TRANSIT' });
    expect(prismaStub.order.update).not.toHaveBeenCalled();
    expect(notifyStub.notifyOutForDelivery).not.toHaveBeenCalled();
  });

  it('flags a cancelled order whose parcel is moving and does not message the customer', async () => {
    prismaStub.shipment.findMany.mockResolvedValue([
      shipment({ status: 'CREATED', order: { id: 10, status: 'CANCELLED', items: [], supportFlag: null } }),
    ]);
    delhiveryStub.trackShipment.mockResolvedValue({ status: 'In Transit', statusType: 'UD', history: [] });
    delhiveryStub.mapTrackingToShipmentStatus.mockReturnValue('IN_TRANSIT');

    await trackingService.syncAllTracking();

    expect(prismaStub.order.update).toHaveBeenCalledTimes(1);
    expect(prismaStub.order.update).toHaveBeenCalledWith({
      where: { id: 10 },
      data: { hasUrgentSupport: true, supportFlag: 'PARCEL_MOVING_ON_CLOSED_ORDER' },
    });
    expect(notifyStub.notifyInTransit).not.toHaveBeenCalled();
  });

  it('still refunds a prepaid order cancelled after pickup when its RTO arrives back', async () => {
    orderServiceStub.processRtoRefund.mockReset().mockResolvedValue({ success: true, message: 'ok' });
    prismaStub.shipment.findMany.mockResolvedValue([
      shipment({
        status: 'RTO',
        order: { id: 10, status: 'CANCELLED', paymentMethod: 'Pre-paid', items: [], supportFlag: null },
      }),
    ]);
    delhiveryStub.trackShipment.mockResolvedValue({ status: 'RTO', statusType: 'DL', history: [] });
    delhiveryStub.mapTrackingToShipmentStatus.mockReturnValue('RTO_DELIVERED');

    await trackingService.syncAllTracking();

    expect(orderServiceStub.processRtoRefund).toHaveBeenCalledWith(10);
  });

  it('does not refund a cancelled COD order whose RTO arrives back', async () => {
    orderServiceStub.processRtoRefund.mockReset();
    prismaStub.shipment.findMany.mockResolvedValue([
      shipment({ status: 'RTO', order: { id: 10, status: 'CANCELLED', paymentMethod: 'COD', items: [], supportFlag: null } }),
    ]);
    delhiveryStub.trackShipment.mockResolvedValue({ status: 'RTO', statusType: 'DL', history: [] });
    delhiveryStub.mapTrackingToShipmentStatus.mockReturnValue('RTO_DELIVERED');

    await trackingService.syncAllTracking();

    expect(orderServiceStub.processRtoRefund).not.toHaveBeenCalled();
  });

  it('stamps deliveredAt and marks COD collected when a COD parcel is delivered', async () => {
    prismaStub.shipment.findMany.mockResolvedValue([
      shipment({ status: 'OUT_FOR_DELIVERY', paymentMode: 'COD', codAmount: 1299 }),
    ]);
    delhiveryStub.trackShipment.mockResolvedValue({ status: 'Delivered', statusType: 'DL', history: [] });
    delhiveryStub.mapTrackingToShipmentStatus.mockReturnValue('DELIVERED');

    await trackingService.syncAllTracking();

    expect(prismaStub.shipment.updateMany.mock.calls[0][0].data).toMatchObject({
      status: 'DELIVERED',
      codCollected: true,
      codCollectedAt: expect.any(Date),
    });
    expect(prismaStub.order.update).toHaveBeenCalledWith({
      where: { id: 10 },
      data: { status: 'DELIVERED', deliveredAt: expect.any(Date) },
    });
    expect(notifyStub.notifyDelivered).toHaveBeenCalledTimes(1);
  });
});
