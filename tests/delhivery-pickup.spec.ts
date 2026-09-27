import { describe, it, expect } from 'vitest';
import delhiveryService from '../src/modules/delhivery/delhivery.service';

describe('Delhivery pickup mapping (Ready-to-ship)', () => {
  it('Manifested / manifest uploaded stays CREATED (awaiting pickup)', () => {
    expect(delhiveryService.mapTrackingToShipmentStatus('UD', 'Manifested')).toBe('CREATED');
    expect(delhiveryService.mapTrackingToShipmentStatus('UD', 'Manifest uploaded')).toBe('CREATED');
  });

  it('Not Picked stays CREATED (courier en route, not a failed delivery)', () => {
    expect(delhiveryService.mapTrackingToShipmentStatus('UD', 'Not Picked')).toBe('CREATED');
    expect(delhiveryService.mapTrackingToShipmentStatus('UD', 'NOT PICKED')).toBe('CREATED');
  });

  it('Picked-up scans promote to PICKED_UP', () => {
    expect(delhiveryService.mapTrackingToShipmentStatus('UD', 'Picked Up')).toBe('PICKED_UP');
    expect(delhiveryService.mapTrackingToShipmentStatus('UD', 'Received at Surat hub')).toBe('PICKED_UP');
    expect(delhiveryService.mapTrackingToShipmentStatus('UD', 'In Transit', true)).toBe('PICKED_UP');
  });

  it('delivery / RTO / cancel mapping unchanged', () => {
    expect(delhiveryService.mapTrackingToShipmentStatus('DL', 'Delivered')).toBe('DELIVERED');
    expect(delhiveryService.mapTrackingToShipmentStatus('DL', 'RTO')).toBe('RTO_DELIVERED');
    expect(delhiveryService.mapTrackingToShipmentStatus('RT', 'In Transit')).toBe('RTO');
    expect(delhiveryService.mapTrackingToShipmentStatus('CN', 'Canceled')).toBe('CANCELLED');
    expect(delhiveryService.mapTrackingToShipmentStatus('UD', 'Dispatched')).toBe('OUT_FOR_DELIVERY');
  });
});
