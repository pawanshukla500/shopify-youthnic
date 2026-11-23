import prisma from '../../database/prisma';
import logger from '../../utils/logger';

export type RefundGatewayStage = 'INITIATED' | 'CREDITED' | 'SETTLED' | 'MANUAL_RECORDED' | 'FAILED';

export interface ExtractedRefundDetails {
  paymentInstrument: string | null;
  paymentProvider: string | null;
  shopifyRefundId: string | null;
  refundTransactionId: string | null;
  refundRrn: string | null;
  refundArn: string | null;
  refundSource: string | null;
  customerRefundSource: string | null;
  refundGatewayStatus: RefundGatewayStage | null;
  refundAmount: number | null;
  refundProcessedAt: Date | null;
}

export interface OrderRefundSummary {
  isRefunded: boolean;
  isPartial: boolean;
  isManualCod: boolean;
  refundAmount: number | null;
  shopifyRefundId: string | null;
  refundTransactionId: string | null;
  refundRrn: string | null;
  refundArn: string | null;
  settlementBatchUtr: string | null;
  refundSource: string | null;
  customerRefundSource: string | null;
  paymentInstrument: string | null;
  paymentProvider: string | null;
  refundGatewayStatus: RefundGatewayStage | null;
  refundProcessedAt: string | null;
  refundCreditedAt: string | null;
  checkoutReference: string | null;
  manualAccountUsed: string | null;
  manualRefundMode: string | null;
  emailSentAt: string | null;
  emailTemplateType: string | null;
  rrnEmailSentAt: string | null;
  evidenceUrl: string | null;
}

interface NoteAttribute {
  name?: string | null;
  value?: string | number | null;
}

const STAGE_RANK: Record<RefundGatewayStage, number> = {
  FAILED: 0,
  INITIATED: 1,
  CREDITED: 2,
  MANUAL_RECORDED: 3,
  SETTLED: 4,
};

function cleanStr(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s.length > 0 ? s : null;
}

function normKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findNoteAttr(attrs: NoteAttribute[] | null | undefined, candidates: string[]): string | null {
  if (!Array.isArray(attrs) || attrs.length === 0) return null;
  const normalizedCandidates = candidates.map(normKey);
  for (const target of normalizedCandidates) {
    for (const item of attrs) {
      if (!item?.name) continue;
      if (normKey(String(item.name)) === target) {
        const val = cleanStr(item.value);
        if (val) return val;
      }
    }
  }
  return null;
}

export function normalizeProviderName(raw: string | null | undefined): string | null {
  const s = cleanStr(raw);
  if (!s) return null;
  const low = s.toLowerCase();
  if (low.includes('easebuzz')) return 'Easebuzz';
  if (low.includes('phonepe') || low.includes('phone_pe')) return 'PhonePe';
  if (low.includes('razorpay')) return 'Razorpay';
  if (low.includes('cashfree')) return 'Cashfree';
  if (low.includes('payu')) return 'PayU';
  if (low.includes('gokwik') || low.includes('kwik')) return 'GoKwik';
  if (low.includes('shopify_payments')) return 'Shopify Payments';
  if (low === 'manual' || low === 'cash_on_delivery' || low === 'cod') return null;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function extractPaymentInstrument(input: {
  noteAttributes?: NoteAttribute[] | null;
  receipt?: Record<string, any> | null;
  paymentGateway?: string | null;
  paymentMethod?: string | null;
}): string | null {
  const method =
    findNoteAttr(input.noteAttributes, ['Payment_Method', 'payment_method']) ||
    cleanStr(input.receipt?.payment_method) ||
    cleanStr(input.receipt?.method);
  const subMethod =
    findNoteAttr(input.noteAttributes, ['Payment_Sub_Method', 'payment_sub_method', 'vpa', 'upi_handle']) ||
    cleanStr(input.receipt?.payment_sub_method) ||
    cleanStr(input.receipt?.card_company) ||
    cleanStr(input.receipt?.vpa);
  const last4 = cleanStr(input.receipt?.card_last4 || input.receipt?.last4);

  if (method) {
    const mLow = method.toLowerCase();
    if (mLow === 'cash on delivery' || mLow === 'cod') return 'Cash on Delivery';
    if (mLow === 'upi') {
      return subMethod && subMethod.toLowerCase() !== 'upi' ? `UPI (${subMethod})` : 'UPI';
    }
    if (mLow === 'cards' || mLow === 'card' || mLow.includes('credit') || mLow.includes('debit')) {
      const cardBrand = subMethod ? subMethod.toUpperCase() : '';
      const suffix = last4 ? ` •••• ${last4}` : '';
      if (cardBrand) return `${cardBrand} Card${suffix}`;
      return `Card${suffix}`;
    }
    if (mLow.includes('netbanking') || mLow.includes('net_banking') || mLow === 'nb') {
      return subMethod ? `NetBanking (${subMethod})` : 'NetBanking';
    }
    if (mLow.includes('wallet')) {
      return subMethod ? `Wallet (${subMethod})` : 'Wallet';
    }
    return subMethod && subMethod.toLowerCase() !== mLow ? `${method} (${subMethod})` : method;
  }

  const gw = (input.paymentGateway || '').toLowerCase();
  if (gw.includes('upi')) return subMethod ? `UPI (${subMethod})` : 'UPI';
  if (gw.includes('card')) return subMethod ? `${subMethod.toUpperCase()} Card` : 'Card';
  if (gw.includes('netbank') || gw.includes('nb')) return 'NetBanking';
  if (gw.includes('wallet')) return 'Wallet';
  if (gw.includes('cash') || gw === 'cod' || (input.paymentMethod || '').toUpperCase() === 'COD') {
    return 'Cash on Delivery';
  }
  return subMethod || null;
}

export function formatManualRefundSource(refundMode: string | null | undefined, accountUsed?: string | null): string {
  const modeLabel = formatManualModeLabel(refundMode);
  const acct = cleanStr(accountUsed);
  return acct ? `Manual ${modeLabel} · ${acct}` : `Manual ${modeLabel}`;
}

export function formatManualModeLabel(refundMode: string | null | undefined): string {
  switch ((refundMode || '').toUpperCase()) {
    case 'UPI':
      return 'UPI';
    case 'BANK_TRANSFER':
      return 'Bank Transfer';
    case 'CASH':
      return 'Cash';
    case 'ORIGINAL_PAYMENT_METHOD':
      return 'Original Payment Method';
    default:
      return 'Payout';
  }
}

export function formatRefundSource(input: {
  paymentInstrument?: string | null;
  paymentProvider?: string | null;
  paymentGateway?: string | null;
  manualMode?: string | null;
  accountUsed?: string | null;
}): string | null {
  if (input.manualMode && input.manualMode !== 'ORIGINAL_PAYMENT_METHOD') {
    return formatManualRefundSource(input.manualMode, input.accountUsed);
  }
  const instrument = cleanStr(input.paymentInstrument);
  const provider =
    normalizeProviderName(input.paymentProvider) ||
    normalizeProviderName(input.paymentGateway);

  if (instrument && instrument.toLowerCase() !== 'cash on delivery') {
    if (provider && !instrument.toLowerCase().includes(provider.toLowerCase())) {
      return `${instrument} · ${provider}`;
    }
    return instrument;
  }
  if (provider) {
    return `Original Payment Method · ${provider}`;
  }
  const gw = cleanStr(input.paymentGateway);
  if (gw && !/cash|cod|manual/i.test(gw)) {
    return gw;
  }
  return null;
}

/**
 * Customer-facing refund source label for emails/WhatsApp.
 * Never exposes Youthnic's internal merchant bank account name or digits.
 */
export function formatCustomerRefundSource(input: {
  paymentInstrument?: string | null;
  paymentProvider?: string | null;
  paymentGateway?: string | null;
  refundSource?: string | null;
  manualMode?: string | null;
}): string {
  if (input.manualMode && input.manualMode !== 'ORIGINAL_PAYMENT_METHOD') {
    switch (input.manualMode.toUpperCase()) {
      case 'UPI':
        return 'Direct UPI Transfer';
      case 'BANK_TRANSFER':
        return 'Direct Bank Transfer (IMPS / NEFT)';
      case 'CASH':
        return 'Cash Refund';
      default:
        return 'Direct Bank / UPI Transfer';
    }
  }
  // Never pass an internal "Manual UPI · HDFC ..." string directly to a customer email
  if (input.refundSource && /^manual\s+/i.test(input.refundSource)) {
    const modePart = input.refundSource.split('·')[0].replace(/^manual\s+/i, '').trim();
    if (/upi/i.test(modePart)) return 'Direct UPI Transfer';
    if (/bank/i.test(modePart)) return 'Direct Bank Transfer (IMPS / NEFT)';
    if (/cash/i.test(modePart)) return 'Cash Refund';
    return 'Direct Bank / UPI Transfer';
  }

  const rawSource = cleanStr(input.refundSource);
  const sourceHead =
    rawSource && !/^manual\s+/i.test(rawSource) && !/^original\s+/i.test(rawSource)
      ? cleanStr(rawSource.split('·')[0])
      : null;
  const rawInstrument = cleanStr(input.paymentInstrument);
  const instrument =
    sourceHead &&
    sourceHead.toLowerCase() !== 'cash on delivery' &&
    (!rawInstrument || sourceHead.length > rawInstrument.length)
      ? sourceHead
      : rawInstrument;
  const provider =
    normalizeProviderName(input.paymentProvider) ||
    normalizeProviderName(input.paymentGateway);

  if (instrument && instrument.toLowerCase() !== 'cash on delivery') {
    if (provider && !instrument.toLowerCase().includes(provider.toLowerCase())) {
      return `Original ${instrument} via ${provider}`;
    }
    return `Original ${instrument}`;
  }
  if (rawSource && !/^manual\s+/i.test(rawSource)) {
    const formatted = rawSource.replace(/\s*·\s*/g, ' via ');
    return /^original\s+/i.test(formatted) ? formatted : `Original ${formatted}`;
  }
  if (provider) {
    return `Original Payment Method via ${provider}`;
  }
  return 'Original Payment Method';
}

export function pickHigherRefundStage(
  a: RefundGatewayStage | string | null | undefined,
  b: RefundGatewayStage | string | null | undefined
): RefundGatewayStage | null {
  const valid = (v: unknown): RefundGatewayStage | null => {
    const s = cleanStr(v)?.toUpperCase() as RefundGatewayStage | undefined;
    return s && s in STAGE_RANK ? s : null;
  };
  const va = valid(a);
  const vb = valid(b);
  if (!va) return vb;
  if (!vb) return va;
  return STAGE_RANK[vb] >= STAGE_RANK[va] ? vb : va;
}

export function extractRefundDetailsFromShopify(input: {
  noteAttributes?: NoteAttribute[] | null;
  tags?: string | null;
  paymentGateway?: string | null;
  paymentProvider?: string | null;
  paymentMethod?: string | null;
  transactions?: any[] | null;
  refunds?: any[] | null;
}): ExtractedRefundDetails {
  const attrs = Array.isArray(input.noteAttributes) ? input.noteAttributes : [];
  const tagsList = (input.tags || '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  const txns = Array.isArray(input.transactions) ? input.transactions : [];
  const refunds = Array.isArray(input.refunds) ? input.refunds : [];

  const captureTx =
    txns.find((t) => t?.status === 'success' && ['capture', 'sale'].includes(String(t?.kind || '').toLowerCase())) ||
    txns.find((t) => ['capture', 'sale'].includes(String(t?.kind || '').toLowerCase())) ||
    null;

  // Prefer refund transactions directly from refunds[], falling back to transactions[]
  const refundTxnsFromRefunds = refunds.flatMap((r) =>
    Array.isArray(r?.transactions) ? r.transactions.filter((t: any) => t?.kind === 'refund') : []
  );
  const refundTxns =
    refundTxnsFromRefunds.length > 0
      ? refundTxnsFromRefunds
      : txns.filter((t) => String(t?.kind || '').toLowerCase() === 'refund');

  const latestRefund = refunds.length > 0 ? refunds[refunds.length - 1] : null;
  const latestRefundTx =
    [...refundTxns].reverse().find((t) => t?.status === 'success' || t?.status === 'pending') ||
    refundTxns[refundTxns.length - 1] ||
    null;

  const receipt =
    (latestRefundTx?.receipt && typeof latestRefundTx.receipt === 'object' ? latestRefundTx.receipt : null) ||
    (captureTx?.receipt && typeof captureTx.receipt === 'object' ? captureTx.receipt : null) ||
    null;

  const originalPaymentRef =
    findNoteAttr(attrs, ['Payment_Reference_ID', 'payment_reference_id']) ||
    cleanStr(captureTx?.receipt?.payment_reference_id);
  const captureAuth = cleanStr(captureTx?.authorization);

  const paymentProvider =
    normalizeProviderName(input.paymentProvider) ||
    normalizeProviderName(findNoteAttr(attrs, ['Payment_Provider_Name', 'payment_provider', 'payment_provider_name', 'provider_name'])) ||
    normalizeProviderName(cleanStr(receipt?.payment_provider)) ||
    normalizeProviderName(input.paymentGateway);

  const paymentInstrument = extractPaymentInstrument({
    noteAttributes: attrs,
    receipt,
    paymentGateway: cleanStr(latestRefundTx?.gateway) || input.paymentGateway,
    paymentMethod: input.paymentMethod,
  });

  // Refund RRN: strictly from refund-specific attributes or refund transaction receipt (never original checkout payment_reference_id)
  const receiptAcquirer = receipt?.acquirer_data && typeof receipt.acquirer_data === 'object' ? receipt.acquirer_data : null;
  const candidateReceiptRrn =
    cleanStr(receipt?.refund_rrn) ||
    cleanStr(receipt?.return_rrn) ||
    cleanStr(receipt?.rrn) ||
    cleanStr(receipt?.bank_ref_num) ||
    cleanStr(receipt?.bank_reference_number) ||
    cleanStr(receiptAcquirer?.rrn);

  const refundRrn =
    findNoteAttr(attrs, [
      'Refund RRN',
      'refund_rrn',
      'return_rrn',
      'refund_reference_number',
      'refund_bank_rrn',
      'refund_upi_rrn',
      'rrn',
    ]) ||
    (candidateReceiptRrn && candidateReceiptRrn !== originalPaymentRef ? candidateReceiptRrn : null);

  // Refund ARN / Gateway Refund ID
  const candidateReceiptArn =
    cleanStr(receipt?.refund_arn) ||
    cleanStr(receipt?.arn) ||
    cleanStr(receiptAcquirer?.arn) ||
    cleanStr(receipt?.easebuzz_refund_id) ||
    cleanStr(receipt?.gateway_refund_id) ||
    cleanStr(receipt?.refund_id);
  const refundTxAuth = cleanStr(latestRefundTx?.authorization);

  const refundArn =
    findNoteAttr(attrs, [
      'Refund ARN',
      'refund_arn',
      'gateway_refund_id',
      'easebuzz_refund_id',
      'refund_id',
      'acquirer_reference_number',
      'arn',
    ]) ||
    candidateReceiptArn ||
    (refundTxAuth && refundTxAuth !== captureAuth ? refundTxAuth : null);

  const shopifyRefundId = cleanStr(latestRefund?.id);
  const refundTransactionId = cleanStr(latestRefundTx?.payment_id) || cleanStr(latestRefundTx?.id);

  const activeRefundTxns = refundTxns.filter((t) => t?.status === 'success' || t?.status === 'pending');
  const sumAmount = activeRefundTxns.reduce((sum, t) => sum + (parseFloat(String(t?.amount || 0)) || 0), 0);
  const refundAmount = activeRefundTxns.length > 0 ? Math.round(sumAmount * 100) / 100 : null;

  const processedAtRaw = cleanStr(latestRefundTx?.processed_at) || cleanStr(latestRefund?.created_at);
  const refundProcessedAt = processedAtRaw && !Number.isNaN(Date.parse(processedAtRaw)) ? new Date(processedAtRaw) : null;

  const hasCreditedTag = tagsList.includes('refund_credited');
  const hasInitiatedTag = tagsList.includes('refund_initiated');
  const hasAnyRefund = Boolean(shopifyRefundId || latestRefundTx || hasCreditedTag || hasInitiatedTag || refundRrn || refundArn);

  let refundGatewayStatus: RefundGatewayStage | null = null;
  if (hasCreditedTag || Boolean(refundRrn) || Boolean(refundArn)) {
    refundGatewayStatus = 'CREDITED';
  } else if (hasInitiatedTag || Boolean(latestRefundTx) || Boolean(shopifyRefundId)) {
    refundGatewayStatus = 'INITIATED';
  }

  const refundSource = hasAnyRefund || paymentInstrument || paymentProvider
    ? formatRefundSource({
        paymentInstrument,
        paymentProvider,
        paymentGateway: cleanStr(latestRefundTx?.gateway) || input.paymentGateway,
      })
    : null;

  const customerRefundSource = formatCustomerRefundSource({
    paymentInstrument,
    paymentProvider,
    paymentGateway: cleanStr(latestRefundTx?.gateway) || input.paymentGateway,
    refundSource,
  });

  return {
    paymentInstrument,
    paymentProvider,
    shopifyRefundId,
    refundTransactionId,
    refundRrn,
    refundArn,
    refundSource,
    customerRefundSource,
    refundGatewayStatus,
    refundAmount,
    refundProcessedAt,
  };
}

/**
 * Merges every persisted source for an order (Order row, Return rows, additionalDetails,
 * AccountTrailEvent refund records, GatewaySettlementRefund rows, and refund EmailLogs)
 * into a single canonical refund summary for Order Detail UI and customer emails.
 */
export function resolveOrderRefundSummary(input: {
  order: any;
  returns?: any[];
  accountTrailEvents?: any[];
  gatewaySettlementRefunds?: any[];
  refundEmailLogs?: any[];
}): OrderRefundSummary {
  const { order } = input;
  const returns = input.returns || order?.returns || [];
  const trails = input.accountTrailEvents || [];
  const gwRefunds = input.gatewaySettlementRefunds || [];
  const emailLogs = input.refundEmailLogs || [];

  const attrs = Array.isArray(order?.additionalDetails) ? (order.additionalDetails as NoteAttribute[]) : [];
  const extracted = extractRefundDetailsFromShopify({
    noteAttributes: attrs,
    tags: order?.tags,
    paymentGateway: order?.paymentGateway,
    paymentProvider: order?.paymentProvider,
    paymentMethod: order?.paymentMethod,
  });

  const refundedReturn =
    returns.find((r: any) => r.refundStatus === 'PROCESSED' || r.returnStatus === 'REFUNDED') ||
    returns.find((r: any) => Boolean(r.shopifyRefundId || r.refundRrn || r.refundArn)) ||
    null;

  const manualTrail = trails.find((e: any) => e.eventType === 'REFUND_MANUAL' && e.status === 'COMPLETED') || null;
  const autoTrail = trails.find((e: any) => e.eventType === 'REFUND_AUTOMATIC' && e.status === 'COMPLETED') || null;
  const settledTrail = trails.find((e: any) => e.eventType === 'REFUND_SETTLED') || null;
  const latestGwRefund = gwRefunds[0] || null;

  const isManualCod = Boolean(
    manualTrail ||
    order?.refundGatewayStatus === 'MANUAL_RECORDED' ||
    refundedReturn?.refundGatewayStatus === 'MANUAL_RECORDED'
  );

  const isRefunded = Boolean(
    order?.financialStatus === 'refunded' ||
    order?.financialStatus === 'partially_refunded' ||
    order?.status === 'REFUNDED' ||
    refundedReturn ||
    manualTrail ||
    autoTrail ||
    order?.refundRrn ||
    order?.refundArn ||
    extracted.refundRrn ||
    extracted.refundArn
  );

  const isPartial = order?.financialStatus === 'partially_refunded';

  const paymentInstrument = cleanStr(order?.paymentInstrument) || extracted.paymentInstrument;
  const paymentProvider = normalizeProviderName(order?.paymentProvider) || extracted.paymentProvider;

  const refundRrn =
    cleanStr(refundedReturn?.refundRrn) ||
    cleanStr(order?.refundRrn) ||
    extracted.refundRrn ||
    cleanStr(manualTrail?.externalReference) ||
    null;

  const refundArn =
    cleanStr(refundedReturn?.refundArn) ||
    cleanStr(order?.refundArn) ||
    extracted.refundArn ||
    cleanStr(latestGwRefund?.refundId) ||
    null;

  const settlementBatchUtr =
    cleanStr(latestGwRefund?.bankUtr) ||
    cleanStr(settledTrail?.externalReference) ||
    null;

  const shopifyRefundId =
    cleanStr(refundedReturn?.shopifyRefundId) ||
    cleanStr(autoTrail?.externalReference) ||
    null;

  const refundTransactionId =
    cleanStr(refundedReturn?.refundTransactionId) ||
    cleanStr((autoTrail?.metadata as any)?.refundTransactionId) ||
    null;

  const manualMode = cleanStr(manualTrail?.refundMode);
  const manualAccountUsed = cleanStr(manualTrail?.accountUsed);

  const refundSource =
    (isManualCod && manualMode ? formatManualRefundSource(manualMode, manualAccountUsed) : null) ||
    cleanStr(refundedReturn?.refundSource) ||
    cleanStr(order?.refundSource) ||
    extracted.refundSource ||
    formatRefundSource({
      paymentInstrument,
      paymentProvider,
      paymentGateway: order?.paymentGateway,
      manualMode,
      accountUsed: manualAccountUsed,
    });

  const customerRefundSource = formatCustomerRefundSource({
    paymentInstrument,
    paymentProvider,
    paymentGateway: order?.paymentGateway,
    refundSource,
    manualMode: isManualCod ? manualMode || 'BANK_TRANSFER' : null,
  });

  let refundGatewayStatus: RefundGatewayStage | null = null;
  if (isRefunded) {
    refundGatewayStatus = pickHigherRefundStage(refundGatewayStatus, order?.refundGatewayStatus);
    refundGatewayStatus = pickHigherRefundStage(refundGatewayStatus, refundedReturn?.refundGatewayStatus);
    refundGatewayStatus = pickHigherRefundStage(refundGatewayStatus, extracted.refundGatewayStatus);
    if (isManualCod) refundGatewayStatus = pickHigherRefundStage(refundGatewayStatus, 'MANUAL_RECORDED');
    if (latestGwRefund || settledTrail) refundGatewayStatus = pickHigherRefundStage(refundGatewayStatus, 'SETTLED');
    if (!refundGatewayStatus) refundGatewayStatus = refundRrn || refundArn ? 'CREDITED' : 'INITIATED';
  }

  const refundAmount =
    (typeof refundedReturn?.refundAmount === 'number' && refundedReturn.refundAmount > 0 ? refundedReturn.refundAmount : null) ??
    (typeof manualTrail?.amount === 'number' && manualTrail.amount > 0 ? manualTrail.amount : null) ??
    (typeof autoTrail?.amount === 'number' && autoTrail.amount > 0 ? autoTrail.amount : null) ??
    (latestGwRefund?.refundAmount ? Number(latestGwRefund.refundAmount) : null) ??
    (isRefunded && !isPartial && typeof order?.totalAmount === 'number' ? order.totalAmount : null);

  const toIso = (val: unknown): string | null => {
    if (!val) return null;
    const d = val instanceof Date ? val : new Date(String(val));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  };

  const refundProcessedAt =
    toIso(refundedReturn?.refundProcessedAt) ||
    toIso(manualTrail?.createdAt) ||
    toIso(autoTrail?.createdAt) ||
    (isRefunded ? toIso(order?.refundReferenceUpdatedAt) : null);

  const refundCreditedAt =
    toIso(refundedReturn?.refundCreditedAt) ||
    (refundGatewayStatus && ['CREDITED', 'SETTLED', 'MANUAL_RECORDED'].includes(refundGatewayStatus)
      ? toIso(order?.refundReferenceUpdatedAt) || toIso(manualTrail?.createdAt) || toIso(latestGwRefund?.createdAt)
      : null);

  const sentRefundEmails = emailLogs.filter((l: any) =>
    ['RETURN_REFUND', 'REFUND_RRN_UPDATE'].includes(l?.templateType) &&
    ['SENT', 'DELIVERED', 'SIMULATED'].includes(l?.status)
  );
  const latestEmail = sentRefundEmails[0] || null;
  const rrnEmail = sentRefundEmails.find((l: any) => l?.templateType === 'REFUND_RRN_UPDATE') || null;

  return {
    isRefunded,
    isPartial,
    isManualCod,
    refundAmount,
    shopifyRefundId,
    refundTransactionId,
    refundRrn,
    refundArn,
    settlementBatchUtr,
    refundSource,
    customerRefundSource,
    paymentInstrument,
    paymentProvider,
    refundGatewayStatus,
    refundProcessedAt,
    refundCreditedAt,
    checkoutReference: cleanStr(order?.paymentReference),
    manualAccountUsed,
    manualRefundMode: manualMode,
    emailSentAt: toIso(latestEmail?.sentAt || latestEmail?.createdAt || refundedReturn?.refundEmailSentAt),
    emailTemplateType: cleanStr(latestEmail?.templateType),
    rrnEmailSentAt: toIso(rrnEmail?.sentAt || rrnEmail?.createdAt),
    evidenceUrl: cleanStr(manualTrail?.evidenceUrl),
  };
}

/**
 * Live fetch refund details (RRN, ARN, Shopify refund ID, transaction receipt, refund source)
 * from Shopify + GatewaySettlementRefund + AccountTrailEvent, persist them on Order & Return,
 * and optionally send the customer RRN confirmation email when a new RRN/ARN arrives.
 */
export async function syncOrderRefundDetails(
  orderId: number,
  options: { sendEmailOnNewRrn?: boolean } = {}
): Promise<{
  updated: boolean;
  newReferenceFound: boolean;
  emailSent: boolean;
  summary: OrderRefundSummary;
}> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      items: true,
      returns: { include: { items: { include: { orderItem: true } } }, orderBy: { createdAt: 'desc' } },
      accountTrailEvents: {
        where: { eventType: { in: ['REFUND_AUTOMATIC', 'REFUND_MANUAL', 'REFUND_SETTLED'] } },
        orderBy: { createdAt: 'desc' },
      },
    },
  });
  if (!order) {
    throw new Error(`Order not found: ${orderId}`);
  }

  const priorFromAttrs = extractRefundDetailsFromShopify({
    noteAttributes: order.additionalDetails as any,
    tags: order.tags,
  });
  const priorRrn = cleanStr(order.refundRrn) || priorFromAttrs.refundRrn;
  const priorArn = cleanStr(order.refundArn) || priorFromAttrs.refundArn;

  // Lazy-import shopifyService to avoid circular module dependency
  const shopifyService = (await import('../shopify/shopify.service')).default;
  const shopifyData = await shopifyService.fetchOrderRefundData(order.shopifyOrderId);

  const gwRefunds = await prisma.gatewaySettlementRefund.findMany({
    where: { orderId },
    orderBy: { createdAt: 'desc' },
  });

  const extracted = extractRefundDetailsFromShopify({
    noteAttributes: shopifyData.order?.note_attributes || (order.additionalDetails as any),
    tags: shopifyData.order?.tags ?? order.tags,
    paymentGateway: shopifyData.order?.payment_gateway_names?.[0] || order.paymentGateway,
    paymentProvider: order.paymentProvider,
    paymentMethod: order.paymentMethod,
    transactions: shopifyData.transactions,
    refunds: shopifyData.refunds,
  });

  const gwRefund = gwRefunds[0] || null;
  const manualTrail = order.accountTrailEvents.find((e) => e.eventType === 'REFUND_MANUAL' && e.status === 'COMPLETED') || null;
  const isManualCod = Boolean(manualTrail || order.refundGatewayStatus === 'MANUAL_RECORDED');

  const nextRrn = extracted.refundRrn || cleanStr(order.refundRrn) || cleanStr(manualTrail?.externalReference) || null;
  const nextArn = extracted.refundArn || cleanStr(gwRefund?.refundId) || cleanStr(order.refundArn) || null;
  const nextInstrument = extracted.paymentInstrument || cleanStr(order.paymentInstrument) || null;
  const nextSource = isManualCod
    ? formatManualRefundSource(manualTrail?.refundMode, manualTrail?.accountUsed)
    : extracted.refundSource || cleanStr(order.refundSource) || null;

  let nextStage = pickHigherRefundStage(order.refundGatewayStatus, extracted.refundGatewayStatus);
  if (isManualCod) nextStage = pickHigherRefundStage(nextStage, 'MANUAL_RECORDED');
  if (gwRefund) nextStage = pickHigherRefundStage(nextStage, 'SETTLED');

  const hasNewRrn = Boolean(nextRrn && nextRrn !== priorRrn);
  const hasNewArn = Boolean(nextArn && nextArn !== priorArn);
  const newReferenceFound = hasNewRrn || hasNewArn;

  const now = new Date();
  const orderPatch: Record<string, any> = {};
  if (nextInstrument && nextInstrument !== order.paymentInstrument) orderPatch.paymentInstrument = nextInstrument;
  if (nextRrn && nextRrn !== order.refundRrn) orderPatch.refundRrn = nextRrn;
  if (nextArn && nextArn !== order.refundArn) orderPatch.refundArn = nextArn;
  if (nextSource && nextSource !== order.refundSource) orderPatch.refundSource = nextSource;
  if (nextStage && nextStage !== order.refundGatewayStatus) orderPatch.refundGatewayStatus = nextStage;
  if (shopifyData.order?.tags && shopifyData.order.tags !== order.tags) orderPatch.tags = shopifyData.order.tags;
  if (Array.isArray(shopifyData.order?.note_attributes)) {
    orderPatch.additionalDetails = shopifyData.order.note_attributes.filter(
      (a: any) => !/token|secret|password|authorization|key|confirmation.*url|user_agent|full_url/i.test(String(a?.name || ''))
    );
  }
  if (Object.keys(orderPatch).length > 0 && (nextRrn || nextArn || nextStage === 'CREDITED' || nextStage === 'SETTLED')) {
    orderPatch.refundReferenceUpdatedAt = now;
  }

  let updated = false;
  if (Object.keys(orderPatch).length > 0) {
    await prisma.order.update({ where: { id: orderId }, data: orderPatch });
    updated = true;
  }

  // Propagate to linked Return row(s)
  const targetReturns = order.returns.filter(
    (r) => !r.isExchange && r.returnStatus !== 'CANCELLED' && (r.refundStatus === 'PROCESSED' || r.returnStatus === 'REFUNDED' || Boolean(r.shopifyRefundId))
  );
  const returnsToUpdate = targetReturns.length > 0
    ? targetReturns
    : order.returns.length === 1 && !order.returns[0].isExchange && order.returns[0].returnStatus !== 'CANCELLED' && Boolean(extracted.shopifyRefundId)
      ? [order.returns[0]]
      : [];

  for (const ret of returnsToUpdate) {
    const retPatch: Record<string, any> = {};
    if (nextRrn && nextRrn !== ret.refundRrn) retPatch.refundRrn = nextRrn;
    if (nextArn && nextArn !== ret.refundArn) retPatch.refundArn = nextArn;
    if (extracted.refundTransactionId && extracted.refundTransactionId !== ret.refundTransactionId) {
      retPatch.refundTransactionId = extracted.refundTransactionId;
    }
    if (extracted.shopifyRefundId && !ret.shopifyRefundId) {
      retPatch.shopifyRefundId = extracted.shopifyRefundId;
    }
    if (nextSource && nextSource !== ret.refundSource) retPatch.refundSource = nextSource;
    const retStage = pickHigherRefundStage(ret.refundGatewayStatus, nextStage);
    if (retStage && retStage !== ret.refundGatewayStatus) retPatch.refundGatewayStatus = retStage;
    if (!ret.refundCreditedAt && (retStage === 'CREDITED' || retStage === 'SETTLED' || retStage === 'MANUAL_RECORDED')) {
      retPatch.refundCreditedAt = now;
    }
    if (Object.keys(retPatch).length > 0) {
      await prisma.return.update({ where: { id: ret.id }, data: retPatch });
      updated = true;
    }
  }

  // Re-read fresh state for summary & optional RRN customer email
  const refreshedOrder = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      items: true,
      returns: { include: { items: { include: { orderItem: true } } }, orderBy: { createdAt: 'desc' } },
      accountTrailEvents: {
        where: { eventType: { in: ['REFUND_AUTOMATIC', 'REFUND_MANUAL', 'REFUND_SETTLED'] } },
        orderBy: { createdAt: 'desc' },
      },
    },
  });
  const refundEmailLogs = await prisma.emailLog.findMany({
    where: { orderId, templateType: { in: ['RETURN_REFUND', 'REFUND_RRN_UPDATE'] } },
    orderBy: { createdAt: 'desc' },
    take: 5,
  });

  const summary = resolveOrderRefundSummary({
    order: refreshedOrder || order,
    returns: refreshedOrder?.returns || order.returns,
    accountTrailEvents: refreshedOrder?.accountTrailEvents || order.accountTrailEvents,
    gatewaySettlementRefunds: gwRefunds,
    refundEmailLogs,
  });

  let emailSent = false;
  if (options.sendEmailOnNewRrn && newReferenceFound && summary.isRefunded && (refreshedOrder || order).customerEmail) {
    const activeOrder = refreshedOrder || order;
    const processedAt = summary.refundProcessedAt
      ? new Date(summary.refundProcessedAt)
      : activeOrder.shopifyUpdatedAt || activeOrder.shopifyCreatedAt || null;
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const isRecentRefund = Boolean(processedAt && Date.now() - processedAt.getTime() <= sevenDaysMs);
    if (isRecentRefund) {
      try {
        const notificationEngine = (await import('../notifications/notification.service')).default;
        const primaryReturn = (refreshedOrder?.returns || []).find(
          (r) => r.refundStatus === 'PROCESSED' || r.returnStatus === 'REFUNDED'
        );
        emailSent = await notificationEngine.notifyRefundRrnUpdated(
          refreshedOrder || order,
          summary,
          primaryReturn
        );
      } catch (err: any) {
        logger.warn('Failed to send RRN confirmation email after refund details sync', {
          orderId,
          error: err?.message,
        });
      }
    }
  }

  return { updated, newReferenceFound, emailSent, summary };
}

/**
 * Scheduled job: pulls live Shopify refund RRN / ARN / credited status for recent
 * refunded prepaid orders that don't yet have their bank RRN/ARN recorded.
 */
export async function syncPendingRefundDetails(limit = 30): Promise<{
  checked: number;
  updated: number;
  emailed: number;
}> {
  const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const candidates = await prisma.order.findMany({
    where: {
      paymentMethod: { not: 'COD' },
      OR: [
        { financialStatus: { in: ['refunded', 'partially_refunded'] } },
        { status: 'REFUNDED' },
      ],
      updatedAt: { gte: cutoff },
      AND: [
        {
          OR: [
            { refundGatewayStatus: null },
            { refundGatewayStatus: 'INITIATED' },
            { AND: [{ refundRrn: null }, { refundArn: null }] },
            { refundSource: null },
          ],
        },
      ],
    },
    select: { id: true, shopifyOrderName: true },
    orderBy: { updatedAt: 'desc' },
    take: Math.max(1, Math.min(limit, 100)),
  });

  let updated = 0;
  let emailed = 0;
  for (const row of candidates) {
    try {
      const res = await syncOrderRefundDetails(row.id, { sendEmailOnNewRrn: true });
      if (res.updated) updated++;
      if (res.emailSent) emailed++;
    } catch (err: any) {
      logger.warn('Pending refund details sync failed for order', {
        orderId: row.id,
        orderName: row.shopifyOrderName,
        error: err?.message,
      });
    }
  }
  return { checked: candidates.length, updated, emailed };
}

/**
 * DB-only backfill (no Shopify API calls, no customer emails): populates the structured
 * refund RRN / ARN / source / status columns on historical orders and returns from
 * already-stored Shopify additionalDetails, GatewaySettlementRefund, and AccountTrailEvent rows.
 */
export async function backfillStoredRefundDetails(): Promise<{ ordersUpdated: number; returnsUpdated: number }> {
  const orders = await prisma.order.findMany({
    where: {
      OR: [
        { financialStatus: { in: ['refunded', 'partially_refunded'] } },
        { status: 'REFUNDED' },
        { returns: { some: { refundStatus: 'PROCESSED' } } },
      ],
    },
    include: {
      returns: true,
      accountTrailEvents: {
        where: { eventType: { in: ['REFUND_AUTOMATIC', 'REFUND_MANUAL', 'REFUND_SETTLED'] } },
        orderBy: { createdAt: 'desc' },
      },
    },
  });

  const allGwRefunds = await prisma.gatewaySettlementRefund.findMany({
    where: { orderId: { not: null } },
    orderBy: { createdAt: 'desc' },
  });
  const gwByOrder = new Map<number, any[]>();
  for (const g of allGwRefunds) {
    if (!g.orderId) continue;
    const list = gwByOrder.get(g.orderId) || [];
    list.push(g);
    gwByOrder.set(g.orderId, list);
  }

  let ordersUpdated = 0;
  let returnsUpdated = 0;

  for (const order of orders) {
    const summary = resolveOrderRefundSummary({
      order,
      returns: order.returns,
      accountTrailEvents: order.accountTrailEvents,
      gatewaySettlementRefunds: gwByOrder.get(order.id) || [],
    });

    const orderPatch: Record<string, any> = {};
    if (summary.paymentInstrument && !order.paymentInstrument) orderPatch.paymentInstrument = summary.paymentInstrument;
    if (summary.refundRrn && !order.refundRrn) orderPatch.refundRrn = summary.refundRrn;
    if (summary.refundArn && !order.refundArn) orderPatch.refundArn = summary.refundArn;
    if (summary.refundSource && !order.refundSource) orderPatch.refundSource = summary.refundSource;
    if (summary.refundGatewayStatus && !order.refundGatewayStatus) {
      orderPatch.refundGatewayStatus = summary.refundGatewayStatus;
    }
    if (Object.keys(orderPatch).length > 0) {
      orderPatch.refundReferenceUpdatedAt = new Date();
      await prisma.order.update({ where: { id: order.id }, data: orderPatch });
      ordersUpdated++;
    }

    for (const ret of order.returns) {
      if (ret.isExchange || ret.returnStatus === 'CANCELLED') continue;
      if (ret.refundStatus !== 'PROCESSED' && ret.returnStatus !== 'REFUNDED') continue;
      const retPatch: Record<string, any> = {};
      if (summary.refundRrn && !ret.refundRrn) retPatch.refundRrn = summary.refundRrn;
      if (summary.refundArn && !ret.refundArn) retPatch.refundArn = summary.refundArn;
      if (summary.refundSource && !ret.refundSource) retPatch.refundSource = summary.refundSource;
      if (summary.refundGatewayStatus && !ret.refundGatewayStatus) {
        retPatch.refundGatewayStatus = summary.refundGatewayStatus;
      }
      if (!ret.refundCreditedAt && summary.refundCreditedAt) {
        retPatch.refundCreditedAt = new Date(summary.refundCreditedAt);
      }
      if (Object.keys(retPatch).length > 0) {
        await prisma.return.update({ where: { id: ret.id }, data: retPatch });
        returnsUpdated++;
      }
    }
  }

  return { ordersUpdated, returnsUpdated };
}
