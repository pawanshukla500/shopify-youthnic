import prisma from '../../database/prisma';
import { recordAccountTrailEvent, type AccountTrailActor } from '../accounts/account-trail.service';
import logger from '../../utils/logger';

export async function recordOrderAction(orderId: number, eventType: string, actor: AccountTrailActor | undefined, detail: {
  note: string; status?: string; reference?: string; amount?: number; metadata?: Record<string, string | number | boolean | null>;
}) {
  return recordAccountTrailEvent({
    orderId, eventType, actorType: actor?.uid ? 'USER' : actor?.email ? 'EXTERNAL' : 'SYSTEM', actor,
    source: actor ? 'OMS_UI' : 'OMS_AUTOMATION', status: detail.status || 'COMPLETED',
    externalReference: detail.reference, amount: detail.amount, note: detail.note, metadata: detail.metadata,
  }).catch((error) => logger.error('Order action audit could not be stored', { orderId, eventType, error: error.message }));
}

export async function addStaffNote(orderId: number, text: string, requestId: string, actor: AccountTrailActor) {
  if (!actor.uid) throw new Error('Authentication required.');
  const note = text.trim();
  if (!note || note.length > 2000) throw new Error('A note must contain 1–2000 characters.');
  if (!/^[a-zA-Z0-9_-]{16,80}$/.test(requestId)) throw new Error('A valid note request ID is required.');
  if (!await prisma.order.findUnique({ where: { id: orderId }, select: { id: true } })) throw new Error('Order not found.');
  return recordAccountTrailEvent({
    orderId, eventType: 'STAFF_NOTE', actorType: 'USER', actor, source: 'OMS_UI', status: 'COMPLETED',
    externalReference: `${actor.uid}:${requestId}`, note,
  });
}

export async function getOrderActivity(orderId: number) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, shopifyCreatedAt: true, salesChannel: true, paymentReceivedAt: true, paymentReceivedUtr: true, paymentReceivedAmount: true, paymentReceivedSource: true },
  });
  if (!order) return null;
  const [audit, emails, notices] = await Promise.all([
    prisma.accountTrailEvent.findMany({ where: { orderId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 200 }),
    prisma.emailLog.findMany({ where: { orderId }, select: { id: true, subject: true, status: true, sentAt: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 50 }),
    prisma.notification.findMany({ where: { orderId }, select: { id: true, type: true, status: true, sentAt: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 50 }),
  ]);
  // No raw receipts, authorization keys, payloads or evidence storage paths.
  const events = audit.map((event) => ({
    id: `audit-${event.id}`, type: event.eventType, title: event.eventType.replace(/_/g, ' ').toLowerCase(),
    at: event.createdAt, actor: event.actorName || event.actorEmail || (event.actorType === 'SYSTEM' ? 'OMS automation' : 'External integration'),
    actorEmail: event.actorEmail, actorRole: event.actorRole, source: event.source, status: event.status,
    note: event.note, amount: event.amount,
    reference: event.eventType === 'STAFF_NOTE' ? null
      : event.eventType === 'BANK_UTR_UPDATED' && typeof (event.metadata as any)?.utr === 'string' ? (event.metadata as any).utr
      : event.eventType === 'PICKUP_REQUESTED' ? ((event.metadata as any)?.pickupId || null) : event.externalReference,
  }));
  const merged = [
    ...events,
    { id: 'order-created', type: 'ORDER_CREATED', title: 'Order placed', at: order.shopifyCreatedAt, actor: order.salesChannel || 'Shopify', actorEmail: null, actorRole: null, source: 'SHOPIFY', status: 'RECORDED', note: null, amount: null, reference: null },
    ...emails.map((email) => ({ id: `email-${email.id}`, type: 'CUSTOMER_EMAIL', title: email.subject, at: email.sentAt || email.createdAt, actor: 'Email integration', actorEmail: null, actorRole: null, source: 'EMAIL', status: email.status, note: null, amount: null, reference: null })),
    ...notices.map((notice) => ({ id: `message-${notice.id}`, type: 'CUSTOMER_MESSAGE', title: notice.type.replace(/_/g, ' ').toLowerCase(), at: notice.sentAt || notice.createdAt, actor: 'Messaging integration', actorEmail: null, actorRole: null, source: 'WHATSAPP', status: notice.status, note: null, amount: null, reference: null })),
  ];
  if (order.paymentReceivedAt && !audit.some((event) => event.eventType === 'PAYMENT_RECEIVED')) merged.push({
    id: 'bank-record', type: 'PAYMENT_RECEIVED', title: 'Bank receipt recorded', at: order.paymentReceivedAt,
    actor: 'Historical record (actor not recorded)', actorEmail: null, actorRole: null, source: order.paymentReceivedSource,
    status: order.paymentReceivedUtr ? 'RECORDED' : 'UTR_MISSING', note: 'Existing settlement record; the original operator was not recorded.',
    amount: order.paymentReceivedAmount, reference: order.paymentReceivedUtr,
  });
  return merged.sort((a, b) => b.at.getTime() - a.at.getTime() || a.id.localeCompare(b.id));
}
