import { describe, expect, it } from 'vitest';
import { contactPhone, displayTrackingEvents, hasCustomerDelivery } from '../frontend/src/order-workspace';
import type { Order, TrackingLog } from '../frontend/src/types';

const scan = (id: number, overrides: Partial<TrackingLog> = {}): TrackingLog => ({
  id, status: 'In Transit', location: 'Bhiwandi', remark: 'Trip Arrived', scannedAt: '2026-10-17T05:03:00Z', ...overrides,
} as TrackingLog);

describe('order workspace presentation', () => {
  it('deduplicates webhook/poll events without mutating stored history', () => {
    const original = [scan(1), scan(2, { status: 'UD:In Transit', scannedAt: '2026-10-17T10:33:00+05:30' })];
    expect(displayTrackingEvents(original)).toHaveLength(1);
    expect(original).toHaveLength(2);
  });
  it('retains distinct carrier remarks, locations and timestamps', () => {
    expect(displayTrackingEvents([scan(1), scan(2, { remark: 'Vehicle Departed' }), scan(3, { location: 'Surat' }), scan(4, { scannedAt: '2026-10-16T05:03:00Z' })])).toHaveLength(4);
  });
  it('sorts newest first and handles empty and invalid date histories', () => {
    expect(displayTrackingEvents()).toEqual([]);
    expect(displayTrackingEvents([scan(1, { scannedAt: 'bad' }), scan(2)])[0].id).toBe(2);
  });
  it.each([
    ['9999999999', '919999999999'], ['+91 99999 99999', '919999999999'],
    ['919999999999', '919999999999'], ['+44 7700 900123', '447700900123'], ['', ''],
  ])('formats contact %s without duplicating a country prefix', (input, expected) => {
    expect(contactPhone(input)).toBe(expected);
  });
  it.each(['RTO_DELIVERED', 'RTO_INITIATED', 'CANCELLED', 'REFUNDED'])('does not allow customer returns for %s', (status) => {
    expect(hasCustomerDelivery({ status, deliveredAt: null, shipment: { status: 'RTO_DELIVERED', trackingStatus: 'RTO Delivered' } } as Order)).toBe(false);
  });
  it('requires actual customer delivery, not matching a tracking description', () => {
    expect(hasCustomerDelivery({ status: 'IN_TRANSIT', shipment: { trackingStatus: 'Not delivered' } } as Order)).toBe(false);
    expect(hasCustomerDelivery({ status: 'DELIVERED' } as Order)).toBe(true);
    expect(hasCustomerDelivery({ status: 'RETURN_REQUESTED', deliveredAt: '2026-10-17T00:00:00Z' } as Order)).toBe(true);
  });
});
