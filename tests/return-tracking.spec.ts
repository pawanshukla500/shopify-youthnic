import { describe, it, expect } from 'vitest';
import {
  isExistingPickupError,
  planWarehousePickupSlot,
  readPickupId,
} from '../src/modules/delhivery/pickup-schedule';
import {
  mapCarrierScanToReturnStatus,
  orderStatusForReturn,
  shouldAdvanceReturnStatus,
} from '../src/modules/returns/return-tracking';

describe('warehouse pickup slot', () => {
  it('keeps the configured morning slot when the request is early', () => {
    const slot = planWarehousePickupSlot(new Date('2026-10-03T04:00:00Z'), '11:00:00');
    expect(slot).toEqual({ date: '2026-10-03', time: '11:00:00' });
  });

  it('pushes a same-day slot forward when 11:00 has already passed', () => {
    const slot = planWarehousePickupSlot(new Date('2026-10-03T10:00:00Z'), '11:00:00');
    expect(slot.date).toBe('2026-10-03');
    expect(slot.time).toBe('17:00:00');
  });

  it('moves to the next day after 16:30 IST', () => {
    const slot = planWarehousePickupSlot(new Date('2026-10-03T12:00:00Z'), '11:00:00');
    expect(slot).toEqual({ date: '2026-10-04', time: '11:00:00' });
  });

  it('treats an already-open pickup as success, not a failure', () => {
    expect(isExistingPickupError('A Pickup Request for this Pickup Location Already Exist for 2026-10-03')).toBe(true);
    expect(isExistingPickupError('Delhivery wallet balance alert: insufficient balance')).toBe(false);
  });

  it('reads pickup_id from the Delhivery response', () => {
    expect(readPickupId({ pickup_id: 25634 })).toBe('25634');
    expect(readPickupId({})).toBeNull();
  });
});

describe('reverse scans follow the forward shipment', () => {
  it('maps pickup planned, picked up, transit, and warehouse delivery', () => {
    expect(mapCarrierScanToReturnStatus('PP', 'Scheduled')).toBe('PICKUP_SCHEDULED');
    expect(mapCarrierScanToReturnStatus('UD', 'Manifested')).toBe('PICKUP_SCHEDULED');
    expect(mapCarrierScanToReturnStatus('PU', 'In Transit')).toBe('PICKED_UP');
    expect(mapCarrierScanToReturnStatus('UD', 'In Transit')).toBe('IN_TRANSIT');
    expect(mapCarrierScanToReturnStatus('DL', 'DTO')).toBe('QC_PENDING');
    expect(mapCarrierScanToReturnStatus('DL', 'Delivered')).toBe('QC_PENDING');
    expect(mapCarrierScanToReturnStatus('CN', 'Canceled')).toBe('CANCELLED');
  });

  it('does not walk a return backwards or past refund', () => {
    expect(shouldAdvanceReturnStatus('PICKED_UP', 'PICKUP_SCHEDULED')).toBe(false);
    expect(shouldAdvanceReturnStatus('PICKUP_SCHEDULED', 'PICKED_UP')).toBe(true);
    expect(shouldAdvanceReturnStatus('REFUNDED', 'QC_PENDING')).toBe(false);
    expect(shouldAdvanceReturnStatus('IN_TRANSIT', 'QC_PENDING')).toBe(true);
  });

  it('advances the order only along the return lane', () => {
    expect(orderStatusForReturn('PICKUP_SCHEDULED', 'DELIVERED')).toBe('RETURN_REQUESTED');
    expect(orderStatusForReturn('PICKED_UP', 'RETURN_REQUESTED')).toBe('RETURN_DISPATCHED');
    expect(orderStatusForReturn('QC_PENDING', 'RETURN_DISPATCHED')).toBe('RETURN_RECEIVED');
    expect(orderStatusForReturn('IN_TRANSIT', 'REFUNDED')).toBeNull();
    expect(orderStatusForReturn('PICKED_UP', 'IN_TRANSIT')).toBeNull();
  });
});
