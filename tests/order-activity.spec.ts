import { beforeEach, describe, expect, it, vi } from 'vitest';
const { db, record } = vi.hoisted(() => ({
  db: { order: { findUnique: vi.fn() }, accountTrailEvent: { findMany: vi.fn() }, emailLog: { findMany: vi.fn() }, notification: { findMany: vi.fn() } },
  record: vi.fn(async () => ({ id: 7 })),
}));
vi.mock('../src/database/prisma', () => ({ default: db }));
vi.mock('../src/modules/accounts/account-trail.service', () => ({ recordAccountTrailEvent: record }));
import { addStaffNote, getOrderActivity, recordOrderAction } from '../src/modules/orders/order-activity.service';
beforeEach(() => {
  vi.clearAllMocks();
  db.order.findUnique.mockResolvedValue({ id: 1, shopifyCreatedAt: new Date('2026-10-10'), salesChannel: 'Shopify', paymentReceivedAt: new Date('2026-10-15'), paymentReceivedUtr: 'BANK-UTR', paymentReceivedAmount: 480, paymentReceivedSource: 'MANUAL' });
  db.accountTrailEvent.findMany.mockResolvedValue([]);
  db.emailLog.findMany.mockResolvedValue([]);
  db.notification.findMany.mockResolvedValue([]);
});
describe('staff order activity', () => {
  it('validates notes and snapshots the authenticated actor and replay key', async () => {
    const actor = { uid: 'uid1', name: 'Riya', role: 'FINANCE', email: 'riya@example.com' };
    await addStaffNote(1, ' <script>only text</script> ', 'note-request-123456', actor);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'STAFF_NOTE', actor, actorType: 'USER', externalReference: 'uid1:note-request-123456', note: '<script>only text</script>' }));
    await expect(addStaffNote(1, 'text', 'note-request-123456', {})).rejects.toThrow(/Authentication/);
    await expect(addStaffNote(1, '', 'note-request-123456', actor)).rejects.toThrow(/1–2000/);
    await expect(addStaffNote(1, 'text', '', actor)).rejects.toThrow(/request ID/);
  });
  it('orders available evidence and labels unknown historical operators without inventing them', async () => {
    db.accountTrailEvent.findMany.mockResolvedValue([{ id: 9, eventType: 'COD_APPROVED', actorType: 'USER', actorName: 'Riya', actorEmail: 'riya@example.com', actorRole: 'OPS', source: 'OMS_UI', status: 'COMPLETED', note: 'Approved', amount: null, externalReference: 'COD_CONFIRMED', createdAt: new Date('2026-10-11'), evidenceStoragePath: 'private/path', metadata: { secret: 'not public' } }]);
    const events = (await getOrderActivity(1))!;
    expect(events[0].id).toBe('bank-record');
    expect(events[0].actor).toMatch(/not recorded/);
    expect(events[0].reference).toBe('BANK-UTR');
    expect(events[1]).toMatchObject({ actor: 'Riya', actorRole: 'OPS', source: 'OMS_UI' });
    expect(JSON.stringify(events)).not.toMatch(/private\/path|not public|evidenceStoragePath/);
    expect(events.at(-1)?.type).toBe('ORDER_CREATED');
  });
  it('distinguishes user, automation and imported actors', async () => {
    await recordOrderAction(1, 'UPDATE', { uid: 'u1', name: 'Operator' }, { note: 'Updated' });
    await recordOrderAction(1, 'UPDATE', undefined, { note: 'Job' });
    expect(record.mock.calls[0][0]).toMatchObject({ actorType: 'USER' });
    expect(record.mock.calls[1][0]).toMatchObject({ actorType: 'SYSTEM' });
  });
});
