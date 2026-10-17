import { Prisma } from '@prisma/client';
import prisma from '../../database/prisma';
import type { AccountTrailActor } from './account-trail.service';
import { settlementEvidence } from './settlement-summary';

export async function correctImportUtr(importId: number, utr: string, actor: AccountTrailActor, orderId?: number) {
  if (!actor.uid) throw new Error('Authentication required for UTR corrections.');
  if (!Number.isSafeInteger(importId) || importId <= 0 || !utr.trim() || utr.length > 160) throw new Error('A valid import and bank UTR are required.');
  return prisma.$transaction(async (tx) => {
    const record = await tx.reconciliationImport.findUnique({ where: { id: importId } });
    if (!record || record.kind === 'DELHIVERY_CHARGES') throw new Error('Payment import not found; wallet charges have no bank UTR.');
    const summary: any = record.summary || {};
    const snapshots: any[] = Array.isArray(summary.matchedOrders) ? summary.matchedOrders : [];
    const ids = [...new Set(snapshots.map((row) => Number(row.orderId)).filter((id) => Number.isSafeInteger(id) && id > 0))];
    if (!ids.length || (orderId === undefined && ids.length !== record.matchedCount)) throw new Error('This legacy/truncated import cannot be safely updated as a batch. Review each order.');
    if (orderId !== undefined && !ids.includes(orderId)) throw new Error('Order is not part of this import.');
    const orders = await tx.order.findMany({ where: { id: { in: ids } } });
    if (orderId === undefined && orders.length !== ids.length) throw new Error('Some payment records are missing. Correct verified orders individually.');
    const refs = new Set(orders.map((order) => order.paymentReceivedRef).filter(Boolean));
    const knownUtrs = new Set(orders.map((order) => order.paymentReceivedUtr).filter(Boolean));
    if (orderId === undefined && (refs.size !== 1 || knownUtrs.size > 1)) throw new Error('Mixed or ambiguous settlements: correct the UTR per order, not for the entire file.');
    const selected = orderId === undefined ? orders : orders.filter((order) => order.id === orderId);
    if (!selected.length) throw new Error('No matching payment records.');
    for (const order of selected) {
      const snapshot = snapshots.find((row) => row.orderId === order.id);
      const expectedRef = snapshot?.remittanceRef || summary.remittanceNumber;
      const expectedSource = record.kind === 'PG_SETTLEMENT' ? 'PG_SETTLEMENT_REPORT'
        : ['DELHIVERY_REMITTANCE', 'GOKWIK_SETTLEMENT', 'PHONEPE_SETTLEMENT'].includes(record.kind) ? record.kind : `${record.kind}_REMITTANCE`;
      if (!order.paymentReceivedAt || !order.paymentReceivedRef || order.paymentReceivedSource !== expectedSource
        || (expectedRef && order.paymentReceivedRef !== expectedRef)
        || (!expectedRef && snapshot?.utr !== order.paymentReceivedUtr)) {
        throw new Error('The order payment no longer matches this import. Review its current settlement before editing.');
      }
      if (order.paymentReceivedUtr === utr) continue;
      const changed = await tx.order.updateMany({
        where: { id: order.id, paymentReceivedAt: order.paymentReceivedAt, paymentReceivedRef: order.paymentReceivedRef, paymentReceivedSource: expectedSource, paymentReceivedUtr: order.paymentReceivedUtr },
        data: { paymentReceivedUtr: utr },
      });
      if (changed.count !== 1) throw new Error('Payment changed concurrently. Reload and retry.');
      await tx.accountTrailEvent.create({ data: {
        orderId: order.id, eventType: 'BANK_UTR_UPDATED', actorType: 'USER',
        actorUid: actor.uid, actorEmail: actor.email, actorName: actor.name, actorRole: actor.role,
        source: 'REMITTANCE_CORRECTION', status: 'COMPLETED', externalReference: null,
        note: 'Bank UTR corrected without changing the settlement amount, date or customer checkout reference.',
        metadata: { importId, previousUtr: order.paymentReceivedUtr, utr, settlementRef: order.paymentReceivedRef },
      } });
    }
    const matchedOrders = snapshots.map((row) => selected.some((order) => order.id === row.orderId) ? { ...row, utr } : row);
    return tx.reconciliationImport.update({ where: { id: importId }, data: { summary: { ...summary, matchedOrders, ...settlementEvidence(matchedOrders) } } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
