import { beforeEach, describe, expect, it, vi } from 'vitest';
const { db } = vi.hoisted(() => ({
  db: { order: { findUnique: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() }, reconciliationImport: { findUnique: vi.fn(), update: vi.fn() }, accountTrailEvent: { create: vi.fn() }, $transaction: vi.fn() },
}));
vi.mock('../src/database/prisma', () => ({ default: db }));
vi.mock('../src/modules/orders/order-activity.service', () => ({ recordOrderAction: vi.fn(async () => undefined) }));
import { recordPaymentReceived } from '../src/modules/accounts/reconciliation.service';
import { correctImportUtr } from '../src/modules/accounts/settlement-utr.service';
import { istDateRange, settlementEvidence } from '../src/modules/accounts/settlement-summary';
const at = new Date('2026-10-16T05:00:00Z');
const actor = { uid: 'u1', name: 'Operator', email: 'operator@example.com', role: 'FINANCE' };
beforeEach(() => {
  vi.clearAllMocks();
  db.$transaction.mockImplementation(async (fn: any) => fn(db));
  db.order.updateMany.mockResolvedValue({ count: 1 });
  db.order.findUnique.mockResolvedValue({ id: 1, status: 'CANCELLED', paymentReceivedAt: at, paymentReceivedAmount: 480, paymentReceivedUtr: null, paymentReceivedRef: 'R1', paymentReceivedSource: 'DELHIVERY_REMITTANCE' });
  db.order.findMany.mockResolvedValue([awaitableOrder()]);
  db.reconciliationImport.findUnique.mockResolvedValue({ id: 1, kind: 'DELHIVERY_REMITTANCE', matchedCount: 1, summary: { remittanceNumber: 'R1', matchedOrders: [{ orderId: 1, utr: null, remittanceRef: 'R1' }] } });
  db.reconciliationImport.update.mockImplementation(async (args: any) => args.data);
});
function awaitableOrder() { return { id: 1, paymentReceivedAt: at, paymentReceivedAmount: 480, paymentReceivedUtr: null, paymentReceivedRef: 'R1', paymentReceivedSource: 'DELHIVERY_REMITTANCE' }; }
describe('settlement evidence and corrections', () => {
  it('does not mark partially evidenced or empty batches completed', () => {
    expect(settlementEvidence([{ utr: 'U1' }, { utr: null }])).toMatchObject({ state: 'Pending', missingUtrCount: 1, bankTransactionId: null });
    expect(settlementEvidence([]).state).toBe('Pending');
    expect(settlementEvidence([{ utr: 'U1', remittanceRef: 'R1' }, { utr: 'U2', remittanceRef: 'R2' }])).toMatchObject({ bankTransactionId: null, bankTransactionIds: ['U1', 'U2'], singleSettlement: false });
  });
  it('requires the bank write and its actor audit to complete in one transaction', async () => {
    db.accountTrailEvent.create.mockRejectedValueOnce(new Error('Audit unavailable'));
    await expect(recordPaymentReceived(1, { receivedAt: at, utr: 'NEW', source: 'MANUAL', actor })).rejects.toThrow('Audit unavailable');
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });
  it('permits a verified individual correction inside a mixed file without touching its other order', async () => {
    db.reconciliationImport.findUnique.mockResolvedValueOnce({ id: 1, kind: 'DELHIVERY_REMITTANCE', matchedCount: 2, summary: { matchedOrders: [{ orderId: 1, utr: 'OLD1', remittanceRef: 'R1' }, { orderId: 2, utr: null, remittanceRef: 'R2' }] } });
    db.order.findMany.mockResolvedValueOnce([{ ...awaitableOrder(), paymentReceivedUtr: 'OLD1' }, { ...awaitableOrder(), id: 2, paymentReceivedRef: 'R2' }]);
    await correctImportUtr(1, 'NEW2', actor, 2);
    expect(db.order.updateMany).toHaveBeenCalledTimes(1);
    expect(db.order.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: 2 }, data: { paymentReceivedUtr: 'NEW2' } });
    expect(db.reconciliationImport.update.mock.calls[0][0].data.summary.matchedOrders[0].utr).toBe('OLD1');
  });
  it('preserves bank amount/date/ref/source when filling a missing UTR and never moves delivery state', async () => {
    await recordPaymentReceived(1, { receivedAt: new Date(), amount: 999, utr: 'U1', source: 'MANUAL', actor, deliveredAt: new Date() });
    const { data } = db.order.updateMany.mock.calls[0][0];
    expect(data).toMatchObject({ paymentReceivedAt: at, paymentReceivedAmount: 480, paymentReceivedRef: 'R1', paymentReceivedSource: 'DELHIVERY_REMITTANCE', paymentReceivedUtr: 'U1' });
    expect(data).not.toHaveProperty('status'); expect(data).not.toHaveProperty('paymentReference');
  });
  it('rejects conflicting UTRs and concurrent payment writes', async () => {
    db.order.findUnique.mockResolvedValueOnce({ ...awaitableOrder(), paymentReceivedUtr: 'OTHER' });
    await expect(recordPaymentReceived(1, { receivedAt: at, utr: 'NEW', source: 'MANUAL' })).rejects.toThrow(/different bank UTR/);
    db.order.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(recordPaymentReceived(1, { receivedAt: at, utr: 'NEW', source: 'MANUAL' })).rejects.toThrow(/concurrently/);
  });
  it('corrects only UTR, snapshots the operator and retains customer/payment fields', async () => {
    await correctImportUtr(1, 'NEW-UTR', actor);
    expect(db.order.updateMany.mock.calls[0][0].data).toEqual({ paymentReceivedUtr: 'NEW-UTR' });
    expect(db.accountTrailEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ actorUid: 'u1', actorName: 'Operator', eventType: 'BANK_UTR_UPDATED' }) });
  });
  it('rejects mixed settlements, freight imports and stale membership', async () => {
    db.reconciliationImport.findUnique.mockResolvedValueOnce({ id: 1, kind: 'DELHIVERY_REMITTANCE', matchedCount: 2, summary: { matchedOrders: [{ orderId: 1, utr: null, remittanceRef: 'R1' }, { orderId: 2, utr: null, remittanceRef: 'R2' }] } });
    db.order.findMany.mockResolvedValueOnce([awaitableOrder(), { ...awaitableOrder(), id: 2, paymentReceivedRef: 'R2' }]);
    await expect(correctImportUtr(1, 'U', actor)).rejects.toThrow(/Mixed/);
    db.reconciliationImport.findUnique.mockResolvedValueOnce({ kind: 'DELHIVERY_CHARGES' });
    await expect(correctImportUtr(1, 'U', actor)).rejects.toThrow(/wallet charges/);
    db.order.findMany.mockResolvedValueOnce([{ ...awaitableOrder(), paymentReceivedRef: 'WRONG' }]);
    await expect(correctImportUtr(1, 'U', actor)).rejects.toThrow(/no longer matches/);
  });
  it('uses validated exclusive IST report boundaries', () => {
    expect(istDateRange('2026-10-01', '2026-10-31')).toEqual({ start: new Date('2026-09-30T18:30:00Z'), end: new Date('2026-10-31T18:30:00Z') });
    expect(() => istDateRange('2026-02-30', '2026-03-01')).toThrow();
    expect(() => istDateRange('2026-10-31', '2026-10-01')).toThrow();
  });
});
