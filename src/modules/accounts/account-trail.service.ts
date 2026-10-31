import { randomUUID } from 'node:crypto';
import { Prisma, SyncType } from '@prisma/client';
import prisma from '../../database/prisma';
import firebaseService from '../firebase/firebase.service';
import logger from '../../utils/logger';

export const REFUND_MODES = ['ORIGINAL_PAYMENT_METHOD', 'UPI', 'BANK_TRANSFER', 'CASH', 'OTHER'] as const;
export type RefundMode = (typeof REFUND_MODES)[number];

export interface AccountTrailActor {
  uid?: string | null;
  email?: string | null;
  name?: string | null;
  role?: string | null;
}

export interface AccountTrailEventInput {
  orderId: number;
  returnId?: number | null;
  eventType: string;
  actorType: 'USER' | 'SYSTEM' | 'EXTERNAL';
  actor?: AccountTrailActor | null;
  source?: string | null;
  status?: string | null;
  amount?: number | null;
  currency?: string | null;
  refundMode?: RefundMode | null;
  accountUsed?: string | null;
  externalReference?: string | null;
  note?: string | null;
  metadata?: Prisma.InputJsonValue | null;
  evidenceStoragePath?: string | null;
  evidenceFileName?: string | null;
  evidenceContentType?: string | null;
}

export interface ManualRefundInput {
  orderId: number;
  returnId?: number;
  amount: number;
  refundMode: RefundMode;
  accountUsed: string;
  externalReference?: string;
  note?: string;
  actor: AccountTrailActor;
  evidence?: {
    fileName: string;
    contentType: string;
    contentBase64: string;
  };
}

const MAX_EVIDENCE_BYTES = 5 * 1024 * 1024;
export const ALLOWED_EVIDENCE_TYPES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
} as const;

function actorSnapshot(actor: AccountTrailActor | null | undefined) {
  return {
    actorUid: actor?.uid || null,
    actorEmail: actor?.email || null,
    actorName: actor?.name || null,
    actorRole: actor?.role || null,
  };
}

export async function recordAccountTrailEvent(input: AccountTrailEventInput, client: Pick<Prisma.TransactionClient, 'accountTrailEvent'> = prisma) {
  const data = {
    orderId: input.orderId,
    returnId: input.returnId ?? null,
    eventType: input.eventType,
    actorType: input.actorType,
    ...actorSnapshot(input.actor),
    source: input.source ?? null,
    status: input.status ?? null,
    amount: input.amount ?? null,
    currency: input.currency ?? 'INR',
    refundMode: input.refundMode ?? null,
    accountUsed: input.accountUsed ?? null,
    externalReference: input.externalReference ?? null,
    note: input.note ?? null,
    evidenceStoragePath: input.evidenceStoragePath ?? null,
    evidenceFileName: input.evidenceFileName ?? null,
    evidenceContentType: input.evidenceContentType ?? null,
    metadata: input.metadata ?? undefined,
  };
  try {
    return await client.accountTrailEvent.create({ data });
  } catch (error: any) {
    if (client !== prisma) throw error; // The caller's transaction rolls back both bookkeeping and audit.
    if (error?.code === 'P2002' && input.externalReference) {
      const existing = await client.accountTrailEvent.findFirst({
        where: {
          orderId: input.orderId,
          eventType: input.eventType,
          externalReference: input.externalReference,
        },
      });
      if (existing) return existing;
    }
    await queueTrailBackfill(input, error);
    throw error;
  }
}

/**
 * A failed trail write must never be silent: the money move already happened,
 * so queue a reconstructible backfill record. The hourly refund cron replays
 * these via backfillMissingRefundTrailEvents; the rest are visible in the
 * support queue instead of vanishing into a log line.
 */
async function queueTrailBackfill(input: AccountTrailEventInput, error: any) {
  // Typed (no cast): tsc rejects any syncType the database enum will not
  // accept, so a bad value can never again fail silently at runtime.
  try {
    await prisma.syncLog.create({
      data: {
        orderId: input.orderId,
        syncType: SyncType.ACCOUNT_TRAIL_BACKFILL,
        status: 'FAILED',
        message:
          `Account-trail ${input.eventType} for order ${input.orderId}` +
          `${input.returnId ? ` return ${input.returnId}` : ''} was not written and needs backfill` +
          `${input.externalReference ? ` (ref ${input.externalReference})` : ''}.`,
        errorMessage: String(error?.message || error).slice(0, 1000),
      },
    });
  } catch {
    // Backfill logging must never break the money path.
  }
}

/** Recent-duplicate window for reference-less manual payouts (double clicks, retries). */
const MANUAL_REFUND_DEDUPE_WINDOW_MS = 10 * 60 * 1000;

/**
 * Recreate REFUND_AUTOMATIC trail events for refunds Shopify accepted but
 * whose original trail write was lost. Runs inside the hourly retry cron, so
 * a PROCESSED return can never permanently lack its audit entry. The refund
 * dedupe key keeps this idempotent: an event created between the check and
 * the write is adopted instead of duplicated.
 */
export async function backfillMissingRefundTrailEvents(limit = 50): Promise<number> {
  const processed = await prisma.return.findMany({
    where: { refundStatus: 'PROCESSED', shopifyRefundId: { not: null } },
    select: { id: true, orderId: true, refundAmount: true, shopifyRefundId: true },
    orderBy: { id: 'asc' },
    take: Math.max(1, Math.min(limit, 200)),
  });

  let created = 0;
  for (const ret of processed) {
    const refundId = ret.shopifyRefundId as string | null;
    if (!refundId) continue;
    try {
      const existing = await prisma.accountTrailEvent.findFirst({
        where: { orderId: ret.orderId, eventType: 'REFUND_AUTOMATIC', externalReference: refundId },
      });
      if (existing) continue;
      await recordAccountTrailEvent({
        orderId: ret.orderId,
        returnId: ret.id,
        eventType: 'REFUND_AUTOMATIC',
        actorType: 'SYSTEM',
        actor: { name: 'OMS automation', role: 'SYSTEM' },
        source: 'RETURN_QC_BACKFILL',
        status: 'COMPLETED',
        amount: ret.refundAmount ?? 0,
        currency: 'INR',
        refundMode: 'ORIGINAL_PAYMENT_METHOD',
        accountUsed: 'Shopify original payment method',
        externalReference: refundId,
        note: 'Backfilled: the refund succeeded on Shopify but the original trail write was lost.',
        metadata: { backfilled: true },
      });
      created++;
    } catch (itemError: any) {
      // One bad row queues its own backfill record inside
      // recordAccountTrailEvent; the rest of the batch still runs.
      logger.error('Refund trail backfill failed for return', {
        returnId: ret.id,
        orderId: ret.orderId,
        error: itemError.message,
      });
    }
  }
  return created;
}

function decodeEvidence(evidence: NonNullable<ManualRefundInput['evidence']>): {
  buffer: Buffer;
  extension: string;
  fileName: string;
} {
  const extension = ALLOWED_EVIDENCE_TYPES[evidence.contentType as keyof typeof ALLOWED_EVIDENCE_TYPES];
  if (!extension) throw new Error('Refund proof must be a PNG, JPEG, WebP image, or PDF document.');
  // Bound check base64 length first to prevent ReDoS stack overflow
  const maxBase64Chars = Math.ceil((MAX_EVIDENCE_BYTES * 4) / 3) + 8;
  if (!evidence.contentBase64 || evidence.contentBase64.length > maxBase64Chars) {
    throw new Error('Refund proof must be smaller than 5 MB.');
  }
  if (evidence.contentBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(evidence.contentBase64)) {
    throw new Error('Refund proof is not valid base64 data.');
  }

  const buffer = Buffer.from(evidence.contentBase64, 'base64');
  if (!buffer.length || buffer.length > MAX_EVIDENCE_BYTES) {
    throw new Error('Refund proof must be smaller than 5 MB.');
  }

  const isPng = buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const isJpeg = buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const isWebp = buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
  const isPdf = buffer.length >= 5 && buffer.subarray(0, 5).equals(Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d])); // %PDF-
  if (
    (evidence.contentType === 'image/png' && !isPng) ||
    (evidence.contentType === 'image/jpeg' && !isJpeg) ||
    (evidence.contentType === 'image/webp' && !isWebp) ||
    (evidence.contentType === 'application/pdf' && !isPdf)
  ) {
    throw new Error('Refund proof content does not match its file type.');
  }

  const fileName = evidence.fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120) || `refund-proof.${extension}`;
  return { buffer, extension, fileName };
}

const manualRefundsInFlight = new Set<number>();

export async function recordManualRefund(input: ManualRefundInput) {
  if (!Number.isInteger(input.orderId) || input.orderId <= 0) throw new Error('A valid order is required.');
  if (input.returnId !== undefined && (!Number.isInteger(input.returnId) || input.returnId <= 0)) {
    throw new Error('A valid return is required.');
  }
  if (!Number.isFinite(input.amount) || input.amount <= 0) throw new Error('Refund amount must be greater than zero.');
  if (!REFUND_MODES.includes(input.refundMode)) throw new Error('Choose a valid refund mode.');
  const accountUsed = input.accountUsed.trim();
  if (!accountUsed) throw new Error('Enter the account used to send the refund.');
  // Count every digit, whatever separates it: dots, slashes and spaces hide
  // full account/card numbers from a whitespace-only check.
  const digitCount = (accountUsed.match(/\d/g) || []).length;
  if (digitCount >= 10) {
    throw new Error('Use a masked account label; full bank or card numbers are not allowed.');
  }
  if (accountUsed.length > 160) throw new Error('Refund account name must be 160 characters or fewer.');
  if (!input.actor?.uid) throw new Error('An authenticated user is required to record a manual refund.');

  if (manualRefundsInFlight.has(input.orderId)) {
    throw new Error('A manual refund for this order is already in progress.');
  }
  manualRefundsInFlight.add(input.orderId);
  try {
    return await recordManualRefundUnlocked(input, accountUsed);
  } finally {
    manualRefundsInFlight.delete(input.orderId);
  }
}

async function recordManualRefundUnlocked(
  input: ManualRefundInput,
  accountUsed: string
) {

  // Validate what is stored, not what was typed: a positive sub-cent amount
  // would otherwise round to a completed refund of zero.
  const amount = Math.round(input.amount * 100) / 100;
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Refund amount is too small to record.');
  const externalReference = input.externalReference?.trim() || null;

  // Proof requirement: user must provide either a payment reference (UTR) or payout screenshot
  const hasRef = Boolean(externalReference && externalReference.length > 0);
  const hasEvidence = Boolean(input.evidence && input.evidence.contentBase64);
  if (!hasRef && !hasEvidence) {
    throw new Error('Payment proof is required: please provide a payment reference number (UTR / Txn ID) or upload a payout screenshot.');
  }

  const order = await prisma.order.findUnique({
    where: { id: input.orderId },
    select: { id: true, currency: true, financialStatus: true, status: true, shopifyOrderName: true },
  });
  if (!order) throw new Error('Order not found.');

  if (input.returnId !== undefined) {
    const returnRecord = await prisma.return.findUnique({
      where: { id: input.returnId },
      select: { id: true, orderId: true, isExchange: true },
    });
    if (!returnRecord || returnRecord.orderId !== input.orderId) {
      throw new Error('Return does not belong to order.');
    }
    // Exchange guard: an exchange replacement order cannot be refunded with cash
    if (returnRecord.isExchange) {
      throw new Error('Cannot issue a monetary refund for an exchange return. Replacement size order is fulfilled instead.');
    }
  }

  // Idempotency: a retry or double click must adopt the existing record,
  // never create a second COMPLETED payout. Checked before any upload so a
  // duplicate submission leaves no orphaned evidence object either.
  if (externalReference) {
    const existing = await prisma.accountTrailEvent.findFirst({
      where: { orderId: input.orderId, eventType: 'REFUND_MANUAL', externalReference },
    });
    if (existing) return existing;
  } else {
    const existing = await prisma.accountTrailEvent.findFirst({
      where: {
        orderId: input.orderId,
        eventType: 'REFUND_MANUAL',
        returnId: input.returnId ?? null,
        amount,
        refundMode: input.refundMode,
        accountUsed,
        createdAt: { gte: new Date(Date.now() - MANUAL_REFUND_DEDUPE_WINDOW_MS) },
      },
    });
    if (existing) return existing;
  }

  // Single-refund invariant: each order can only be refunded once across all channels
  if (order.financialStatus === 'refunded' || order.status === 'REFUNDED') {
    throw new Error(`Order ${order.shopifyOrderName} has already been refunded. An order can only be refunded once.`);
  }
  const priorCompletedRefund = await prisma.accountTrailEvent.findFirst({
    where: {
      orderId: input.orderId,
      eventType: { in: ['REFUND_MANUAL', 'REFUND_AUTOMATIC'] },
      status: 'COMPLETED',
    },
  });
  if (priorCompletedRefund) {
    throw new Error(`Order ${order.shopifyOrderName} has already been refunded (Ref: ${priorCompletedRefund.externalReference || priorCompletedRefund.id}). Only one refund per order is permitted.`);
  }

  let evidenceStoragePath: string | null = null;
  let evidenceFileName: string | null = null;
  let evidenceContentType: string | null = null;
  if (input.evidence) {
    const decoded = decodeEvidence(input.evidence);
    evidenceStoragePath = `orders/${input.orderId}/refund-proof-${randomUUID()}.${decoded.extension}`;
    evidenceFileName = decoded.fileName;
    evidenceContentType = input.evidence.contentType;
    const uploaded = await firebaseService.uploadPrivateBuffer(evidenceStoragePath, decoded.buffer, evidenceContentType);
    evidenceStoragePath = uploaded.path;
  }

  const event = await recordAccountTrailEvent({
    orderId: input.orderId,
    returnId: input.returnId,
    eventType: 'REFUND_MANUAL',
    actorType: 'USER',
    actor: input.actor,
    source: 'MANUAL_PAYOUT',
    status: 'COMPLETED',
    amount,
    currency: order.currency || 'INR',
    refundMode: input.refundMode,
    accountUsed,
    externalReference,
    note: input.note?.trim().slice(0, 1000) || null,
    evidenceStoragePath,
    evidenceFileName,
    evidenceContentType,
  });

  let isPartialReturn = false;
  if (input.returnId) {
    const returnRec = await prisma.return.findUnique({
      where: { id: input.returnId },
      include: { items: true, order: { include: { items: true } } },
    });
    if (returnRec) {
      const orderUnits = (returnRec?.order?.items || []).reduce((s, i) => s + i.quantity, 0);
      const returnedUnits = (returnRec?.items || []).reduce((s, i) => s + i.quantity, 0);
      isPartialReturn = orderUnits > 0 && returnedUnits < orderUnits;
    }
  }

  try {
    await prisma.order.update({
      where: { id: input.orderId },
      data: {
        financialStatus: isPartialReturn ? 'partially_refunded' : 'refunded',
        status: isPartialReturn ? (order.status === 'DELIVERED' ? 'DELIVERED' : 'RETURN_RECEIVED') : 'REFUNDED',
      },
    });
  } catch (err: any) {
    logger.warn('Failed to update order financialStatus on manual refund', { orderId: input.orderId, error: err?.message });
  }

  if (input.returnId) {
    try {
      await prisma.return.update({
        where: { id: input.returnId },
        data: {
          refundStatus: 'PROCESSED',
          returnStatus: 'REFUNDED',
          refundAmount: amount,
          refundProcessedAt: new Date(),
          qcStatus: 'APPROVED',
          qcCheckedAt: new Date(),
        },
      });
    } catch (err: any) {
      logger.warn('Failed to update return refundStatus on manual refund', { returnId: input.returnId, error: err?.message });
    }
  }

  return event;
}

export async function presentAccountTrailEvent(event: any) {
  const { evidenceStoragePath, ...publicEvent } = event;
  let evidenceUrl: string | null = null;
  if (evidenceStoragePath) {
    try {
      evidenceUrl = await firebaseService.createPrivateDownloadUrl(evidenceStoragePath);
    } catch (error: any) {
      logger.warn('Could not create short-lived refund evidence link', {
        orderId: event.orderId,
        eventId: event.id,
        error: error.message,
      });
    }
  }
  return { ...publicEvent, evidenceUrl };
}

export async function getOrderAccountTrail(orderId: number) {
  const events = await prisma.accountTrailEvent.findMany({
    where: { orderId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  return Promise.all(events.map(presentAccountTrailEvent));
}
