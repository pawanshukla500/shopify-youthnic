import { beforeEach, describe, expect, it, vi } from 'vitest';
const { db, request, audit } = vi.hoisted(() => ({
  db: { shipment: { findUnique: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() }, warehousePickupBatch: { findUnique: vi.fn(), findMany: vi.fn(), upsert: vi.fn(), updateMany: vi.fn(), update: vi.fn() }, pickupRequest: { findFirst: vi.fn() } },
  request: vi.fn(), audit: vi.fn(),
}));
vi.mock('../src/database/prisma', () => ({ default: db }));
vi.mock('../src/modules/delhivery/delhivery.service', () => ({ default: { requestPickup: request } }));
vi.mock('../src/modules/accounts/account-trail.service', () => ({ recordAccountTrailEvent: audit }));
import { nextDayWarehousePickupSlot } from '../src/modules/delhivery/pickup-schedule';
import { queueManifestForPickup, submitPickupBatch } from '../src/modules/delhivery/pickup-batch.service';
import { config } from '../src/config';
const now = new Date('2026-12-31T10:00:00Z');
let row: any;
beforeEach(() => {
  vi.clearAllMocks();
  row = { key: 'warehouse:2027-01-01', pickupLocation: 'Warehouse', pickupDate: '2027-01-01', pickupTime: '14:00:00', status: 'QUEUED', attempts: 0, nextAttemptAt: now, claimedAt: null };
  db.warehousePickupBatch.findUnique.mockImplementation(async () => ({ ...row }));
  db.warehousePickupBatch.upsert.mockImplementation(async ({ create }: any) => ({ ...create, status: 'QUEUED', attempts: 0 }));
  db.warehousePickupBatch.updateMany.mockImplementation(async ({ where, data }: any) => {
    if (where.status !== row.status || (where.attempts !== undefined && where.attempts !== row.attempts)) return { count: 0 };
    row = { ...row, ...data, attempts: data.attempts?.increment ? row.attempts + 1 : row.attempts };
    return { count: 1 };
  });
  db.warehousePickupBatch.update.mockImplementation(async ({ data }: any) => (row = { ...row, ...data }));
  db.shipment.findMany.mockResolvedValue([{ id: 1, orderId: 11, waybillNumber: 'W1' }, { id: 2, orderId: 12, waybillNumber: 'W2' }]);
  db.shipment.findUnique.mockResolvedValue({ id: 1, orderId: 11, manifestedByOms: true, courier: 'Delhivery', status: 'CREATED', waybillNumber: 'W1', pickupBatchKey: null, order: { status: 'DISPATCHED', shopifyCreatedAt: now } });
  db.shipment.updateMany.mockResolvedValue({ count: 1 });
  db.pickupRequest.findFirst.mockResolvedValue(null);
  request.mockResolvedValue({ success: true, pickupId: 'PUR1', message: 'Scheduled' });
  audit.mockResolvedValue({});
});
describe('next-day warehouse pickup', () => {
  it.each([
    ['2026-12-31T18:29:00Z', '2027-01-01'], ['2026-12-31T18:31:00Z', '2027-01-02'],
    ['2026-10-31T09:00:00Z', '2026-11-01'], ['2028-02-28T10:00:00Z', '2028-02-29'],
  ])('uses IST next calendar day at %s', (instant, date) => {
    expect(nextDayWarehousePickupSlot(new Date(instant), '14:00:00')).toEqual({ date, time: '14:00:00' });
  });
  it('queues an accepted forward AWB without submitting a pickup for each order', async () => {
    await queueManifestForPickup(11, 'W1', { uid: 'operator' }, now);
    expect(db.shipment.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: 'CREATED', pickupBatchKey: null }), data: { pickupBatchKey: expect.stringContaining('2027-01-01') } }));
    expect(request).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'PICKUP_QUEUED', actor: { uid: 'operator' } }));
  });
  it.each(['CANCELLED', 'IN_TRANSIT', 'DELIVERED', 'ERROR'])('does not queue %s shipments', async (status) => {
    db.shipment.findUnique.mockResolvedValue({ status, waybillNumber: 'W1', order: { status: 'DISPATCHED' } });
    expect(await queueManifestForPickup(11, 'W1', undefined, now)).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });
  it('rejects historical, reverse and rejected/reserved waybills', async () => {
    db.shipment.findUnique.mockResolvedValue({ status: 'CREATED', waybillNumber: 'W1', courier: 'Delhivery', order: { status: 'DISPATCHED', shopifyCreatedAt: new Date(config.shopify.syncStartDate.getTime() - 1000) } });
    expect(await queueManifestForPickup(11, 'W1')).toBeNull();
    expect(await queueManifestForPickup(11, 'OTHER')).toBeNull();
  });
  it('submits one consolidated count despite concurrent callers', async () => {
    await Promise.all([submitPickupBatch(row.key, undefined, now), submitPickupBatch(row.key, undefined, now)]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('2027-01-01', '14:00:00', 2, 'Warehouse');
    expect(row).toMatchObject({ status: 'SCHEDULED', pickupId: 'PUR1', submittedPackageCount: 2 });
    await submitPickupBatch(row.key, undefined, now);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('keeps ambiguous outcomes in REVIEW and never blindly retries them', async () => {
    request.mockResolvedValueOnce({ success: false, uncertain: true, message: 'Timeout' });
    await submitPickupBatch(row.key, undefined, now);
    expect(row.status).toBe('REVIEW');
    await submitPickupBatch(row.key, undefined, now, true);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('does not call an unverified existing-open response scheduled', async () => {
    request.mockResolvedValueOnce({ success: false, alreadyOpen: true, message: 'Another pickup is open' });
    await submitPickupBatch(row.key, undefined, now);
    expect(row.status).toBe('BLOCKED');
    await submitPickupBatch(row.key, undefined, now);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('marks a stale sending claim REVIEW rather than repeating the POST', async () => {
    row.status = 'SENDING'; row.claimedAt = new Date(now.getTime() - 11 * 60 * 1000);
    await submitPickupBatch(row.key, undefined, now);
    expect(row.status).toBe('REVIEW'); expect(request).not.toHaveBeenCalled();
  });
  it('does not schedule empty/cancelled batches or expired dates', async () => {
    db.shipment.findMany.mockResolvedValueOnce([]);
    await submitPickupBatch(row.key, undefined, now);
    expect(row.status).toBe('EMPTY'); expect(request).not.toHaveBeenCalled();
    row.status = 'QUEUED'; row.pickupDate = '2026-12-01';
    await submitPickupBatch(row.key, undefined, now);
    expect(row.status).toBe('REVIEW');
  });
  it('adopts a confirmed legacy warehouse request without another API call', async () => {
    db.pickupRequest.findFirst.mockResolvedValue({ status: 'SCHEDULED', pickupId: 'OLD-PUR' });
    await submitPickupBatch(row.key, undefined, now);
    expect(row.pickupId).toBe('OLD-PUR'); expect(request).not.toHaveBeenCalled();
  });
});
