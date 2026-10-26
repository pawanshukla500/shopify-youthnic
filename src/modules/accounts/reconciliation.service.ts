/**
 * Accounts reconciliation from uploaded reports.
 *
 * Delhivery has no API for COD remittances or actual billed charges, and a
 * gateway settlement API needs credentials the brand may not hold, so the
 * accounts team uploads the files those systems export:
 *
 *   DELHIVERY_REMITTANCE  Delhivery One > Finances > Remittance (AWB-wise export
 *                         and/or the remittance list with Bank Transaction ID)
 *   DELHIVERY_CHARGES     Delhivery One > Finances > Wallet > Download Ledger,
 *                         or an invoice's AWB-wise backup
 *   PG_SETTLEMENT         PhonePe / Easebuzz / GoKwik settlement report
 *
 * Each import matches rows to orders (by AWB, order number or gateway payment
 * ids), writes the money fields, and records a ReconciliationImport row with
 * whatever did not match.
 */
import prisma from '../../database/prisma';
import logger from '../../utils/logger';
import { ParsedSheet, parseAmount, parseDateLoose, pickColumn } from './spreadsheet';
import { settlementEvidence } from './settlement-summary';
import { recordOrderAction } from '../orders/order-activity.service';
import { recordAccountTrailEvent, type AccountTrailActor } from './account-trail.service';
import velocityService from '../velocity/velocity.service';

export type ImportKind =
  | 'DELHIVERY_REMITTANCE'
  | 'DELHIVERY_CHARGES'
  | 'PG_SETTLEMENT'
  | 'GOKWIK_SETTLEMENT'
  | 'PHONEPE_SETTLEMENT'
  | 'AMAZON_SHIPPING'
  | 'EKART_SHIPPING'
  | 'GENERIC_CARRIER'
  | 'VELOCITY_REMITTANCE';

export interface MatchedOrderSummary {
  orderId?: number;
  shopifyOrderName?: string;
  waybillNumber?: string;
  amount?: number;
  utr?: string | null;
  status?: string;
  city?: string;
  remittanceRef?: string | null;
}

export interface ImportResult {
  importId?: number;
  kind: ImportKind;
  fileName: string;
  rowCount: number;
  matchedCount: number;
  unmatched: string[];
  skippedDuplicates?: string[];
  remittanceNumber?: string | null;
  remittanceDate?: string | null;
  bankTransactionId?: string | null;
  state?: 'Completed' | 'Pending';
  totalRemittance?: number;
  matchedOrders?: MatchedOrderSummary[];
  /** Which header was used for each field, so a wrong guess is visible. */
  columns: Record<string, string | undefined>;
  notes: string[];
  extractedFiles?: Array<{ fileName: string; sheetName: string; rowCount: number }>;
  storageMode?: string;
  zipStoredOnDisk?: boolean;
}

export interface RemittanceDefaults {
  /** UTR / Bank Transaction ID for files whose rows do not carry one. */
  utr?: string;
  remittanceRef?: string;
  remittedAt?: string;
}

const AWB_COLUMN = [/^(waybill|awb|lrn)( number| no| num)?$/, /waybill|^awb|awb no|tracking (number|id)|\blrn\b/];
const ORDER_COLUMN = [
  /^(client )?order (number|no|id|name|ref|reference)$/,
  /merchant order id|order id|order no|order number|order name|client order|reference (number|no|id)|^reference$/,
];

function rowsOf(sheets: ParsedSheet[], skipSheet?: RegExp): Array<{ sheet: ParsedSheet; row: Record<string, string> }> {
  return sheets
    .filter((sheet) => !(skipSheet && skipSheet.test(sheet.name)))
    .flatMap((sheet) => sheet.rows.map((row) => ({ sheet, row })));
}

/**
 * Order lookup by anything a report may print: order name, Shopify id, or a
 * gateway payment id. A reference that matches more than one order is
 * treated as no match, so a payment is never attached to a guessed order.
 */
export async function findOrderByReference(reference: string) {
  const raw = (reference || '').trim();
  if (!raw) return null;
  const bare = raw.replace(/^#/, '');
  const baseOrderName = bare.replace(/[-.]\d+$/, '');
  const matches = (await prisma.order.findMany({
    where: {
      OR: [
        { shopifyOrderName: `#${bare}` },
        { shopifyOrderName: bare },
        ...(baseOrderName !== bare
          ? [
              { shopifyOrderName: `#${baseOrderName}` },
              { shopifyOrderName: baseOrderName },
            ]
          : []),
        { shopifyOrderId: bare },
        { gokwikPaymentId: bare },
        { paymentProviderPaymentId: bare },
        { gatewayTransactionId: bare },
        { paymentAuthorizationKey: bare },
        { paymentReference: bare },
        { shipment: { waybillNumber: bare } },
        { shipment: { waybillNumber: raw } },
      ],
    },
    include: { shipment: true },
    take: 2,
  })) || [];
  if (matches.length > 1) {
    logger.warn('Reference matches more than one order, not attaching it', { reference: raw });
    return null;
  }
  return matches[0] || null;
}

function getExtractedFiles(sheets: ParsedSheet[]): Array<{ fileName: string; sheetName: string; rowCount: number }> {
  return sheets
    .filter((s) => s.isZipExtracted && s.sourceFile)
    .map((s) => ({
      fileName: s.sourceFile!,
      sheetName: s.name,
      rowCount: s.rows.length,
    }));
}

async function saveImport(result: ImportResult, uploadedBy?: string): Promise<ImportResult> {
  const evidence = result.kind === 'DELHIVERY_CHARGES' ? {} : settlementEvidence(result.matchedOrders || []);
  result = { ...result, ...evidence };
  const isZip = result.fileName.toLowerCase().endsWith('.zip') || Boolean(result.extractedFiles?.length);
  try {
    const row = await prisma.reconciliationImport.create({
      data: {
        kind: result.kind,
        fileName: result.fileName,
        rowCount: result.rowCount,
        matchedCount: result.matchedCount,
        unmatched: result.unmatched.slice(0, 500),
        summary: {
          columns: result.columns,
          notes: result.notes,
          storageMode: result.storageMode || 'POSTGRESQL_RELATIONAL_DATA',
          zipStoredOnDisk: false,
          extractedFromZip: isZip,
          extractedFiles: result.extractedFiles || null,
          skippedDuplicates: (result.skippedDuplicates || []).slice(0, 500),
          alreadyRemittedCount: result.skippedDuplicates?.length || 0,
          remittanceNumber: result.remittanceNumber || null,
          remittanceDate: result.remittanceDate || null,
          bankTransactionId: result.bankTransactionId || null,
          state: result.state || (result.bankTransactionId ? 'Completed' : 'Pending'),
          totalRemittance: result.totalRemittance ?? null,
          matchedOrders: (result.matchedOrders || []).slice(0, 500),
          ...evidence,
        } as any,
        uploadedBy: uploadedBy || null,
      },
    });
    return { ...result, importId: row.id };
  } catch (error: any) {
    logger.warn('Could not record reconciliation import', { error: error.message });
    return result;
  }
}

/**
 * Write a received payment onto an order. Used by every source (remittance,
 * settlement report, gateway API, manual entry), so the fields mean the same
 * thing everywhere: money credited to Youthnic's bank for this order.
 */
export async function recordPaymentReceived(
  orderId: number,
  payment: {
    receivedAt: Date;
    amount?: number | null;
    utr?: string | null;
    ref?: string | null;
    source: string;
    gatewayFee?: number | null;
    deliveredAt?: Date | null;
    actor?: AccountTrailActor;
  }
): Promise<void> {
  payment = { ...payment, utr: payment.utr?.trim() || null, ref: payment.ref?.trim() || null };
  if (!Number.isFinite(payment.receivedAt.getTime()) || (payment.amount != null && (!Number.isFinite(payment.amount) || payment.amount < 0))) throw new Error('Payment date and amount must be valid.');
  const previous = await prisma.order.findUnique({ where: { id: orderId } });
  if (!previous) throw new Error('Order not found while recording payment.');
  const recorded = Boolean(previous.paymentReceivedAt);
  if (recorded && previous.paymentReceivedUtr && payment.utr && previous.paymentReceivedUtr !== payment.utr) {
    throw new Error('Order already has a different bank UTR. Use a settlement-scoped correction.');
  }
  if (recorded && previous.paymentReceivedRef && payment.ref && previous.paymentReceivedRef !== payment.ref) {
    throw new Error('Order already belongs to another settlement; review before replacing it.');
  }
  if (recorded && previous.paymentReceivedUtr) return;
  if (recorded && !payment.utr) return;
  await prisma.$transaction(async (tx) => {
    const written = await tx.order.updateMany({
      where: { id: orderId, paymentReceivedAt: previous.paymentReceivedAt, paymentReceivedUtr: previous.paymentReceivedUtr, paymentReceivedRef: previous.paymentReceivedRef },
      data: {
        paymentReceivedAt: previous.paymentReceivedAt || payment.receivedAt,
        paymentReceivedAmount: recorded ? previous.paymentReceivedAmount : payment.amount ?? null,
        paymentReceivedUtr: payment.utr || previous.paymentReceivedUtr || null,
        paymentReceivedRef: previous.paymentReceivedRef || payment.ref || null,
        paymentReceivedSource: previous.paymentReceivedSource || payment.source,
        ...(!recorded && payment.gatewayFee !== undefined && payment.gatewayFee !== null ? { gatewayFee: payment.gatewayFee } : {}),
        paymentVerified: true,
        paymentVerifiedAt: previous.paymentVerifiedAt || payment.receivedAt,
      },
    });
    if (written.count !== 1) throw new Error('Payment changed concurrently. Reload and retry.');
    await recordAccountTrailEvent({
      orderId, eventType: recorded ? 'BANK_UTR_UPDATED' : 'PAYMENT_RECEIVED',
      actor: payment.actor, actorType: payment.actor?.uid ? 'USER' : payment.actor?.email ? 'EXTERNAL' : 'SYSTEM',
      source: payment.source, status: payment.utr ? 'COMPLETED' : 'UTR_MISSING',
      note: recorded ? 'Missing bank UTR added; existing amount and settlement date preserved.' : payment.utr ? 'Bank receipt recorded. Customer checkout reference is unchanged.' : 'Settlement reported without a bank UTR; this does not close the order for accounts.',
      amount: (recorded ? previous.paymentReceivedAmount : payment.amount) ?? null,
      externalReference: payment.utr || null, metadata: { source: payment.source, settlementRef: previous.paymentReceivedRef || payment.ref || null },
    }, tx);
  });
}

// ─── Delhivery COD remittance ──────────────────────────────

export async function importDelhiveryRemittance(
  fileName: string,
  sheets: ParsedSheet[],
  defaults: RemittanceDefaults = {},
  uploadedBy?: string,
  actor?: AccountTrailActor
): Promise<ImportResult> {
  const extractedFiles = getExtractedFiles(sheets);
  const headers = sheets.flatMap((s) => s.headers);
  const columns = {
    awb: pickColumn(headers, AWB_COLUMN),
    order: pickColumn(headers, ORDER_COLUMN),
    utr: pickColumn(headers, [/^utr( no| number)?$/, /bank transaction id|bank txn|utr|bank ref|transaction ref/]),
    remittance: pickColumn(headers, [/remittance (number|no|id|ref)/, /\bcrn\b|batch (id|no)/]),
    amount: pickColumn(headers, [
      /remitted amount|remittance amount/,
      /amount payable/,
      /^cod amount$|cod amount/,
      /net amount/,
      /^amount$|amount/,
    ]),
    date: pickColumn(headers, [/remittance (processed )?date|processed date|remitted (on|at|date)/, /payment date|^date$|date/]),
  };

  const notes: string[] = [];
  const unmatched: string[] = [];
  const skippedDuplicates: string[] = [];
  const seenInBatch = new Set<string>();
  let rowCount = 0;
  let matchedCount = 0;
  let missingUtr = 0;

  if (!columns.awb && !columns.order) {
    return saveImport(
      {
        kind: 'DELHIVERY_REMITTANCE',
        fileName,
        rowCount: 0,
        matchedCount: 0,
        unmatched: [],
        skippedDuplicates: [],
        columns,
        notes: [`No Waybill / AWB or Order Number column found. Columns in the file: ${headers.join(', ')}`],
        extractedFiles: getExtractedFiles(sheets),
        storageMode: 'POSTGRESQL_RELATIONAL_DATA',
        zipStoredOnDisk: false,
      },
      uploadedBy
    );
  }

  const refFromFileName = fileName.match(/\b(R\d{6,})\b/i)?.[1];
  const dateFromFileName = refFromFileName?.match(/(20\d{2})(0[1-9]|1[0-2])([0-2]\d|3[01])/);
  const inferredDate = dateFromFileName
    ? parseDateLoose(`${dateFromFileName[1]}-${dateFromFileName[2]}-${dateFromFileName[3]}`)
    : null;

  const fallbackDate = parseDateLoose(defaults.remittedAt || '') || inferredDate || new Date();
  const defaultRef = defaults.remittanceRef || refFromFileName || null;

  // A UTR typed on the form belongs to one remittance. A file covering
  // several remittances (several remittance numbers) must not borrow it.
  const remittanceRefsInFile = new Set(
    columns.remittance ? rowsOf(sheets).map(({ row }) => row[columns.remittance!]).filter(Boolean) : []
  );
  const defaultUtr = remittanceRefsInFile.size <= 1 ? defaults.utr : undefined;
  if (defaults.utr && !defaultUtr) {
    notes.push(
      `The file covers ${remittanceRefsInFile.size} remittances, so the UTR typed on the form was not applied. Upload each remittance's AWB list with its own UTR.`
    );
  }

  let totalAmountRemitted = 0;
  const matchedOrders: MatchedOrderSummary[] = [];

  for (const { row } of rowsOf(sheets)) {
    const awb = (columns.awb ? row[columns.awb] : '').trim();
    const orderRef = (columns.order ? row[columns.order] : '').trim();
    if (!awb && !orderRef) continue;
    rowCount++;

    const trackingKey = awb || orderRef;
    if (seenInBatch.has(trackingKey)) {
      skippedDuplicates.push(`${trackingKey} (duplicate row in file)`);
      continue;
    }
    seenInBatch.add(trackingKey);

    let shipment: any = await prisma.shipment.findFirst({
      where: {
        OR: [
          ...(awb ? [{ waybillNumber: awb }] : []),
          ...(orderRef
            ? [
                { order: { shopifyOrderName: `#${orderRef.replace(/^#/, '')}` } },
                { order: { shopifyOrderName: orderRef.replace(/^#/, '') } },
                { order: { shopifyOrderName: `#${orderRef.replace(/^#/, '').replace(/[-.]\d+$/, '')}` } },
                { order: { shopifyOrderName: orderRef.replace(/^#/, '').replace(/[-.]\d+$/, '') } },
              ]
            : []),
        ],
      },
      include: { order: true },
    });

    let order: any = shipment?.order;

    if (!shipment) {
      // Fallback: search order directly via findOrderByReference
      order = await findOrderByReference(orderRef || awb);
      if (order) {
        if (order.shipment) {
          shipment = order.shipment as any;
        }
      }
    }

    if (!shipment && !order) {
      unmatched.push(awb || orderRef);
      continue;
    }

    // STRICT IDEMPOTENCY / DUPLICATE GUARD:
    // If this shipment's COD remittance was already recorded and remitted,
    // do NOT re-credit or double-count the same tracking ID.
    if (shipment?.codRemitted && shipment.codRemittedAmount && shipment.codRemittedAmount > 0) {
      skippedDuplicates.push(awb || orderRef);
      continue;
    }

    const utr = (columns.utr && row[columns.utr]) || defaultUtr || null;
    const ref = (columns.remittance && row[columns.remittance]) || defaultRef || null;
    const remittedAt = (columns.date && parseDateLoose(row[columns.date])) || fallbackDate;
    const fileAmount = columns.amount ? parseAmount(row[columns.amount]) : null;
    if (fileAmount === null || fileAmount < 0) { unmatched.push(trackingKey); notes.push(`${trackingKey}: no non-negative remittance amount in the report; not inferred from the order total.`); continue; }
    const amount: number = fileAmount;
    if (!utr) missingUtr++;
    totalAmountRemitted += amount;

    const currentOrder = order || shipment?.order;
    matchedOrders.push({
      orderId: currentOrder?.id,
      shopifyOrderName: currentOrder?.shopifyOrderName,
      waybillNumber: shipment?.waybillNumber || awb,
      amount,
      utr,
      remittanceRef: ref,
      status: currentOrder?.status || 'Unknown',
      city: row['City'] || row['city'],
    });

    if (currentOrder) {
      try {
      await recordPaymentReceived(currentOrder.id, {
        receivedAt: remittedAt,
        amount,
        utr,
        ref,
        source: 'DELHIVERY_REMITTANCE',
        actor: actor || (uploadedBy ? { email: uploadedBy } : undefined),
        deliveredAt: currentOrder.deliveredAt || remittedAt,
      });
      } catch (error: any) {
        totalAmountRemitted -= amount; matchedOrders.pop(); unmatched.push(trackingKey);
        notes.push(`${trackingKey}: bank evidence conflicts or could not be recorded; review this order.`);
        logger.warn('Remittance row not recorded', { orderId: currentOrder.id, error: error.message });
        continue;
      }
    }
    if (shipment) {
      await prisma.shipment.update({
        where: { id: shipment.id },
        data: {
          codCollected: true,
          codCollectedAt: shipment.codCollectedAt || remittedAt,
          codRemitted: true,
          codRemittedAt: remittedAt,
          codRemittanceRef: ref || utr || 'DELHIVERY-REMITTANCE',
          codRemittedAmount: amount,
        },
      });
    }
    matchedCount++;
  }

  if (skippedDuplicates.length > 0) {
    notes.push(
      `${skippedDuplicates.length} tracking ID(s) were skipped because they have already been remitted previously or appeared more than once in the file (duplicate upload prevented).`
    );
  }

  if (missingUtr > 0) {
    notes.push(
      `${missingUtr} matched row(s) had no UTR. Use the import history UTR correction to add the Bank Transaction ID without re-crediting these orders.`
    );
  }

  const inferredRemittanceNum =
    defaultRef || (columns.remittance ? Array.from(remittanceRefsInFile)[0] : null) || null;
  const state: 'Completed' | 'Pending' =
    defaultUtr || matchedOrders.some((o) => o.utr) ? 'Completed' : 'Pending';

  return saveImport(
    {
      kind: 'DELHIVERY_REMITTANCE',
      fileName,
      rowCount,
      matchedCount,
      unmatched,
      skippedDuplicates,
      remittanceNumber: inferredRemittanceNum,
      remittanceDate: fallbackDate ? fallbackDate.toISOString() : null,
      bankTransactionId: defaultUtr || null,
      state,
      totalRemittance: Math.round(totalAmountRemitted * 100) / 100,
      matchedOrders,
      columns,
      notes,
      extractedFiles,
    },
    uploadedBy
  );
}

// ─── Delhivery shipping charges (wallet ledger / invoice backup) ───

type Leg = 'forward' | 'rto';

export interface WalletTransactionEntry {
  txnId: string;
  date: string;
  type: 'debit' | 'credit';
  amount: number;
  description: string;
  status: string;
  zone?: string;
  weight?: number;
  closureDate?: string;
  orderRef?: string;
}

/**
 * Billed shipping cost per AWB and leg from Delhivery Wallet Ledger / Invoice Backup.
 * Parses both Deductions (wallet debits) and Refunds (wallet credits e.g. "Not Picked"),
 * preserves the exact line-by-line wallet ledger with Txn IDs and timestamps,
 * computes net freight cost = debits - credits, and saves walletTransactions on Shipment.
 */
export async function importDelhiveryCharges(
  fileName: string,
  sheets: ParsedSheet[],
  uploadedBy?: string,
  actor?: AccountTrailActor
): Promise<ImportResult> {
  const hasDeductions = sheets.some((s) => /^deductions$/i.test(s.name.trim()));
  const hasRefunds = sheets.some((s) => /^refunds$/i.test(s.name.trim()));

  const usable = sheets.filter((sheet) => {
    const name = sheet.name.trim();
    if (/summary|recharge/i.test(name)) return false;
    if (hasDeductions && /^awb\s+deductions$/i.test(name)) return false;
    if (hasRefunds && /^awb\s+refunds$/i.test(name)) return false;
    return true;
  });

  const headers = usable.flatMap((s) => s.headers);
  const columns = {
    awb: pickColumn(headers, AWB_COLUMN),
    amount: pickColumn(headers, [
      /^total( amount)?( incl(uding)? gst)?$/,
      /total amount|net amount|gross amount|invoice amount/,
      /^amount$|debit amount|^debit$/,
      /^miles$|miles/,
      /freight|charge|amount/,
    ]),
    rtoAmount: pickColumn(headers, [/rto (charge|charges|freight|amount)/]),
    type: pickColumn(headers, [/transaction type|^type$|dr cr|debit credit|^nature$/]),
    description: pickColumn(headers, [/description|narration|remarks/]),
    date: pickColumn(headers, [/date time|^date$|transaction date|date/]),
    weight: pickColumn(headers, [/charged weight|chargeable weight|billed weight/, /weight/]),
    zone: pickColumn(headers, [/zone/]),
    status: pickColumn(headers, [/shipment status|^status$|status/]),
    transaction: pickColumn(headers, [/txn id|transaction id|txn/]),
    closureDate: pickColumn(headers, [/closure date|closure/]),
    client: pickColumn(headers, [/client|client order/]),
  };

  const notes: string[] = [];
  const unmatched: string[] = [];
  if (!columns.awb || !columns.amount) {
    return saveImport(
      {
        kind: 'DELHIVERY_CHARGES',
        fileName,
        rowCount: 0,
        matchedCount: 0,
        unmatched: [],
        columns,
        notes: [`Need an AWB and an amount column. Columns in the file: ${headers.join(', ')}`],
        extractedFiles: getExtractedFiles(sheets),
        storageMode: 'POSTGRESQL_RELATIONAL_DATA',
        zipStoredOnDisk: false,
      },
      uploadedBy
    );
  }

  // Collect all transactions grouped by AWB
  const awbTransactions = new Map<string, (WalletTransactionEntry & { leg: 'forward' | 'rto' })[]>();
  let rowCount = 0;

  const safeStr = (v: any) => String(v ?? '').trim();

  for (const sheet of usable) {
    const isRefundSheet = /^refunds?$/i.test(sheet.name.trim());
    for (const row of sheet.rows) {
      let awb = safeStr(columns.awb ? row[columns.awb] : row['AWB'] || row['awb']);
      const rawTxnId = safeStr(columns.transaction ? row[columns.transaction] : row['Txn ID'] || row['txn id']);
      const rawDate = safeStr(columns.date ? row[columns.date] : row['Date & Time'] || row['date']);
      const rawAmount = columns.amount ? row[columns.amount] : row['Miles'] || row['amount'] || '';
      let amount = parseAmount(rawAmount) ?? 0;

      const rawType = safeStr(
        columns.type ? row[columns.type] : row['Type'] || (isRefundSheet ? 'credit' : 'debit')
      ).toLowerCase();
      const type: 'debit' | 'credit' = /credit|refund/i.test(rawType) || isRefundSheet ? 'credit' : 'debit';
      const status = safeStr(columns.status ? row[columns.status] : row['Status'] || 'success');
      const rawShipmentStatus = safeStr(row['Shipment status'] || row['shipment status']);
      const rawDesc = safeStr(columns.description ? row[columns.description] : row['Description']);
      const closureDate = safeStr(columns.closureDate ? row[columns.closureDate] : row['Closure date']);
      let zone = safeStr(columns.zone ? row[columns.zone] : row['Zone']);
      let weight = columns.weight ? parseAmount(row[columns.weight]) ?? undefined : undefined;
      let orderRef = safeStr(columns.client ? row[columns.client] : row['Client']);

      // Delhivery JSON payload embedded inside Description
      let parsedJson: any = null;
      if (rawDesc.startsWith('{') && rawDesc.endsWith('}')) {
        try {
          parsedJson = JSON.parse(rawDesc);
          if (!awb && parsedJson.wbn) awb = String(parsedJson.wbn).trim();
          if (!zone && parsedJson.zn) zone = String(parsedJson.zn).trim();
          if (!weight && parsedJson.wt) weight = Number(parsedJson.wt);
          if (parsedJson.client && !orderRef) orderRef = String(parsedJson.client).trim();
          if (parsedJson.rs && !amount) amount = Number(parsedJson.rs);
        } catch {
          // ignore json parse error
        }
      }

      if (!awb) continue;
      if (type === 'debit') rowCount++;

      let humanDesc = '';
      if (type === 'credit') {
        const creditReason = rawShipmentStatus || parsedJson?.st || 'Refund';
        humanDesc = /not picked/i.test(creditReason)
          ? 'Shipment Not Picked (Full Freight Refund)'
          : `Freight Credit / Refund (${creditReason})`;
      } else {
        const manifestStatus = rawShipmentStatus || parsedJson?.st || 'Manifested';
        humanDesc = `Shipment ${manifestStatus}${zone ? ` (Zone ${zone})` : ''}`;
      }

      // Check RTO column or text
      const rtoVal = columns.rtoAmount ? parseAmount(row[columns.rtoAmount]) : null;
      if (rtoVal && rtoVal > 0 && Math.abs(amount) > Math.abs(rtoVal)) {
        // Split row with both Forward and RTO columns
        const forwardPart = Math.abs(amount) - Math.abs(rtoVal);
        const rtoPart = Math.abs(rtoVal);

        if (!awbTransactions.has(awb)) awbTransactions.set(awb, []);
        awbTransactions.get(awb)!.push({
          txnId: rawTxnId || `TXN-FWD-${Date.now()}-${Math.random().toString(36).substring(7)}`,
          date: rawDate,
          type,
          amount: forwardPart,
          description: humanDesc,
          status: rawShipmentStatus || status,
          leg: 'forward',
          zone: zone || undefined,
          weight: weight || undefined,
          closureDate: closureDate || undefined,
          orderRef: orderRef || undefined,
        });
        awbTransactions.get(awb)!.push({
          txnId: rawTxnId ? `${rawTxnId}-RTO` : `TXN-RTO-${Date.now()}-${Math.random().toString(36).substring(7)}`,
          date: rawDate,
          type,
          amount: rtoPart,
          description: `RTO Charge${zone ? ` (Zone ${zone})` : ''}`,
          status: rawShipmentStatus || status,
          leg: 'rto',
          zone: zone || undefined,
          weight: weight || undefined,
          closureDate: closureDate || undefined,
          orderRef: orderRef || undefined,
        });
        continue;
      }

      const isRto = /\brto\b|return to origin/i.test(`${rawDesc} ${rawShipmentStatus}`);
      const entry: WalletTransactionEntry & { leg: 'forward' | 'rto' } = {
        txnId: rawTxnId || `TXN-${Date.now()}-${Math.random().toString(36).substring(7)}`,
        date: rawDate,
        type,
        amount: Math.abs(amount),
        description: humanDesc,
        status: rawShipmentStatus || status,
        leg: isRto ? 'rto' : 'forward',
        zone: zone || undefined,
        weight: weight || undefined,
        closureDate: closureDate || undefined,
        orderRef: orderRef || undefined,
      };

      if (!awbTransactions.has(awb)) awbTransactions.set(awb, []);
      awbTransactions.get(awb)!.push(entry);
    }
  }

  let totalFreightBilled = 0;
  const matchedOrders: MatchedOrderSummary[] = [];
  const matchedAwbs = new Set<string>();
  const unmatchedAwbs = new Set<string>();

  for (const [awb, txns] of awbTransactions.entries()) {
    // Deduplicate by txnId and type
    const seenTxnKeys = new Set<string>();
    const dedupedTxns: (WalletTransactionEntry & { leg: 'forward' | 'rto' })[] = [];
    for (const t of txns) {
      const key = `${t.txnId}_${t.type}`;
      if (!seenTxnKeys.has(key)) {
        seenTxnKeys.add(key);
        dedupedTxns.push(t);
      }
    }

    // Sort chronologically (earliest first)
    dedupedTxns.sort((a, b) => {
      const timeA = parseDateLoose(a.date)?.getTime() || 0;
      const timeB = parseDateLoose(b.date)?.getTime() || 0;
      return timeA - timeB;
    });

    const debits = dedupedTxns.filter((t) => t.type === 'debit');
    const credits = dedupedTxns.filter((t) => t.type === 'credit');
    const totalDebited = Math.round(debits.reduce((s, t) => s + t.amount, 0) * 100) / 100;
    const totalCredited = Math.round(credits.reduce((s, t) => s + t.amount, 0) * 100) / 100;
    const netBilledCost = Math.max(0, Math.round((totalDebited - totalCredited) * 100) / 100);

    const isNotPicked = credits.some(
      (c) => /not picked/i.test(c.description) || /not picked/i.test(c.status)
    );

    // Leg-wise breakdown
    const forwardDebits = dedupedTxns.filter((t) => t.type === 'debit' && t.leg === 'forward');
    const forwardCredits = dedupedTxns.filter((t) => t.type === 'credit' && t.leg === 'forward');
    const forwardNet = Math.max(
      0,
      Math.round(
        (forwardDebits.reduce((s, t) => s + t.amount, 0) -
          forwardCredits.reduce((s, t) => s + t.amount, 0)) *
          100
      ) / 100
    );

    const rtoDebits = dedupedTxns.filter((t) => t.type === 'debit' && t.leg === 'rto');
    const rtoCredits = dedupedTxns.filter((t) => t.type === 'credit' && t.leg === 'rto');
    const rtoNet = Math.max(
      0,
      Math.round(
        (rtoDebits.reduce((s, t) => s + t.amount, 0) -
          rtoCredits.reduce((s, t) => s + t.amount, 0)) *
          100
      ) / 100
    );

    const forwardCharge = isNotPicked || netBilledCost === 0 ? 0 : forwardNet;

    // Pick best zone and weight
    const lastWithZone = [...dedupedTxns].reverse().find((t) => t.zone);
    const zone = lastWithZone?.zone;
    const lastWithWeight = [...dedupedTxns].reverse().find((t) => t.weight);
    const weight = lastWithWeight?.weight;
    const orderRef = dedupedTxns.find((t) => t.orderRef)?.orderRef;

    const billingStatus =
      isNotPicked || netBilledCost === 0
        ? 'REFUNDED'
        : credits.length > 0
          ? 'PARTIALLY_REFUNDED'
          : 'BILLED';

    // 1. Check Reverse Pickups (Return model)
    const reverse = await prisma.return.findFirst({ where: { returnWaybillNumber: awb } });
    if (reverse) {
      await prisma.return.update({
        where: { id: reverse.id },
        data: { shippingCharge: netBilledCost, shippingCostSource: 'ACTUAL' },
      });
      matchedAwbs.add(awb);
      totalFreightBilled += netBilledCost;
      matchedOrders.push({
        orderId: reverse.orderId,
        waybillNumber: awb,
        amount: netBilledCost,
        status: isNotPicked ? 'Reverse Pickup Cancelled (₹0.00)' : 'Reverse Pickup Billed',
        city: zone ? `Zone ${zone}` : undefined,
      });
      continue;
    }

    // 2. Check Forward Shipment
    let shipment = await prisma.shipment.findFirst({
      where: { waybillNumber: awb },
      include: { order: true },
    });

    // Fallback: search order by client reference if shipment not found by AWB
    if (!shipment && orderRef) {
      const order = await findOrderByReference(orderRef);
      if (order?.shipment) {
        shipment = await prisma.shipment.findUnique({
          where: { id: order.shipment.id },
          include: { order: true },
        });
        if (shipment && !shipment.waybillNumber) {
          await prisma.shipment.update({
            where: { id: shipment.id },
            data: { waybillNumber: awb },
          });
        }
      }
    }

    if (!shipment) {
      unmatchedAwbs.add(awb);
      continue;
    }

    const hasRtoLeg = rtoDebits.length > 0;
    const hasForwardLeg = forwardDebits.length > 0;

    await prisma.shipment.update({
      where: { id: shipment.id },
      data: {
        walletTransactions: dedupedTxns as any,
        totalDebited,
        totalCredited,
        netBilledCost,
        ...(hasForwardLeg || isNotPicked ? { forwardCharge, shippingCostSource: 'ACTUAL' } : {}),
        ...(hasRtoLeg ? { rtoCharge: rtoNet, rtoChargeSource: 'ACTUAL' } : {}),
        shippingCostUpdatedAt: new Date(),
        ...(weight ? { billedWeightGrams: weight < 50 ? weight * 1000 : weight } : {}),
        ...(zone ? { chargedZone: zone } : {}),
        billingStatus,
        lastBilledAt: new Date(),
      },
    });

    if (shipment.orderId) {
      await prisma.order.update({
        where: { id: shipment.orderId },
        data: {
          actualShippingCost: netBilledCost,
          shippingAudited: true,
        },
      });
    }

    matchedAwbs.add(awb);
    if (shipment.orderId) await recordOrderAction(shipment.orderId, 'FREIGHT_RECONCILED', actor || (uploadedBy ? { email: uploadedBy } : undefined), {
      note: 'Freight costs reconciled from the uploaded Delhivery wallet report.', amount: netBilledCost,
      reference: `${fileName}:${awb}`,
    });
    totalFreightBilled += netBilledCost;
    matchedOrders.push({
      orderId: shipment.order?.id,
      shopifyOrderName: shipment.order?.shopifyOrderName,
      waybillNumber: awb,
      amount: netBilledCost,
      status:
        isNotPicked || netBilledCost === 0
          ? 'Refunded (₹0.00 Net)'
          : credits.length > 0
            ? `Billed (₹${netBilledCost} after credit)`
            : `Freight Debited (₹${netBilledCost})`,
      city: shipment.order?.customerCity || (zone ? `Zone ${zone}` : undefined),
    });
  }

  for (const awb of unmatchedAwbs) {
    if (!matchedAwbs.has(awb)) unmatched.push(awb);
  }

  const cleanFileName = fileName.replace(/\.[^/.]+$/, '');
  return saveImport(
    {
      kind: 'DELHIVERY_CHARGES',
      fileName,
      rowCount,
      matchedCount: matchedAwbs.size,
      unmatched,
      columns,
      notes,
      state: 'Completed',
      totalRemittance: Math.round(totalFreightBilled * 100) / 100,
      remittanceNumber: cleanFileName,
      remittanceDate: new Date().toISOString(),
      matchedOrders,
      extractedFiles: getExtractedFiles(sheets),
      storageMode: 'POSTGRESQL_RELATIONAL_DATA',
      zipStoredOnDisk: false,
    },
    uploadedBy
  );
}

// ─── Gateway settlement (PhonePe / Easebuzz / GoKwik) ──────

const SETTLED_STATES = /(success|settled|processed|completed|paid|credited|captured)/i;
const UNSETTLED_STATES = /(pending|failed|cancelled|canceled|rejected|declined|reversed|dropped)/i;

export async function importGatewaySettlement(
  fileName: string,
  sheets: ParsedSheet[],
  uploadedBy?: string,
  kind: ImportKind = 'PG_SETTLEMENT',
  actor?: AccountTrailActor,
  defaults: RemittanceDefaults = {}
): Promise<ImportResult> {
  const headers = sheets.flatMap((s) => s.headers);
  const columns = {
    order: pickColumn(headers, ORDER_COLUMN),
    transaction: pickColumn(headers, [
      /merchant transaction id|pg transaction id|transaction id|txn ?id|txnid/,
      /easepayid|payment id|^reference$/,
    ]),
    settlementRef: pickColumn(headers, [/settlement (id|ref|reference|number)|payout (id|ref)/]),
    utr: pickColumn(headers, [/settlement utr|payout utr/, /^utr( no| number)?$|bank transaction id|bank utr/, /utr|bank ref/]),
    date: pickColumn(headers, [/settlement date|settled (on|date)|payout (actual )?date|settlement time/, /^date$|date/]),
    amount: pickColumn(headers, [
      /settlement amount|settled amount|net settlement|payout amount|net amount|amount settled/,
      /^amount$|amount/,
    ]),
    fee: pickColumn(headers, [/total charges|fee|mdr|service charge|commission/]),
    tax: undefined as string | undefined,
    status: pickColumn(headers, [/settlement status|^status$|^state$/]),
  };
  // "Fee (incl. GST)" matches both patterns; never add the same column twice.
  columns.tax = pickColumn(
    headers.filter((h) => h !== columns.fee),
    [/total tax|gst|service tax|\btax\b/]
  );

  const notes: string[] = [];
  const unmatched: string[] = [];
  const settlementRefs = new Set(columns.settlementRef ? rowsOf(sheets).map(({ row }) => row[columns.settlementRef!]).filter(Boolean) : []);
  const fileUtrs = new Set(columns.utr ? rowsOf(sheets).map(({ row }) => row[columns.utr!]).filter(Boolean) : []);
  const typedUtr = settlementRefs.size <= 1 && fileUtrs.size <= 1 && (!fileUtrs.size || fileUtrs.has(defaults.utr || '')) ? defaults.utr : undefined;
  if (defaults.utr && !typedUtr) notes.push('The typed UTR was not applied to this mixed settlement file. Correct individual order evidence.');
  if (!columns.order && !columns.transaction) {
    return saveImport(
      {
        kind,
        fileName,
        rowCount: 0,
        matchedCount: 0,
        unmatched: [],
        columns,
        notes: [`No order or transaction id column found. Columns in the file: ${headers.join(', ')}`],
        extractedFiles: getExtractedFiles(sheets),
        storageMode: 'POSTGRESQL_RELATIONAL_DATA',
        zipStoredOnDisk: false,
      },
      uploadedBy
    );
  }

  // One settlement can list an order more than once (split payments,
  // refund adjustments), so amounts and fees are summed per order.
  const perOrder = new Map<
    number,
    {
      orderName?: string;
      city?: string;
      amount: number;
      fee: number;
      utr: string;
      at: Date;
      ref: string;
    }
  >();
  const ambiguousOrders = new Set<number>();
  let rowCount = 0;
  let skippedState = 0;
  let codRows = 0;
  for (const { row } of rowsOf(sheets)) {
    const orderRef = columns.order ? row[columns.order] : '';
    const txn = columns.transaction ? row[columns.transaction] : '';
    if (!orderRef && !txn) continue;
    rowCount++;
    if (columns.status && row[columns.status]) {
      const statusText = row[columns.status].trim();
      if (UNSETTLED_STATES.test(statusText) || !SETTLED_STATES.test(statusText)) {
        skippedState++;
        continue;
      }
    }

    const order = (orderRef && (await findOrderByReference(orderRef))) || (txn && (await findOrderByReference(txn))) || null;
    if (!order) {
      unmatched.push(orderRef || txn);
      continue;
    }
    if (ambiguousOrders.has(order.id)) continue;
    const isC2P =
      Boolean((order as any).gokwikPaymentId) ||
      /c2p|prepaid|converted/i.test((order as any).tags || '');
    if (order.paymentMethod === 'COD' && !isC2P) {
      codRows++;
      continue;
    }

    const entry = perOrder.get(order.id) || {
      orderName: order.shopifyOrderName,
      city: (order as any).city || row['City'] || row['city'] || undefined,
      amount: 0,
      fee: 0,
      at: new Date(0),
      utr: '',
      ref: '',
    };
    const rowAmount = columns.amount ? parseAmount(row[columns.amount]) : null;
    if (rowAmount === null || rowAmount < 0) { unmatched.push(orderRef || txn); notes.push(`${orderRef || txn}: settlement amount missing/negative; review instead of inferring a credit.`); continue; }
    entry.amount += rowAmount;
    entry.fee += Math.abs((columns.fee && parseAmount(row[columns.fee])) || 0) + Math.abs((columns.tax && parseAmount(row[columns.tax])) || 0);
    const utr = (columns.utr ? row[columns.utr] : '') || typedUtr || '';
    if (entry.utr && utr && entry.utr !== utr) {
      ambiguousOrders.add(order.id); perOrder.delete(order.id); unmatched.push(orderRef || txn);
      notes.push(`${orderRef || txn}: multiple bank UTRs for one order; requires reconciliation rather than overwriting one.`);
      continue;
    }
    if (utr) entry.utr = utr;
    entry.ref = (columns.settlementRef && row[columns.settlementRef]) || defaults.remittanceRef || utr || txn || entry.ref;
    const at = (columns.date && parseDateLoose(row[columns.date])) || null;
    if (at && at > entry.at) entry.at = at;
    perOrder.set(order.id, entry);
  }

  let missingUtr = 0;
  let totalSettled = 0;
  let recordedCount = 0;
  let primaryUtr: string | null = null;
  const matchedOrders: MatchedOrderSummary[] = [];

  for (const [orderId, entry] of perOrder) {
    if (!entry.utr) missingUtr++;
    if (!primaryUtr && entry.utr) primaryUtr = entry.utr;
    const amount = Math.round(entry.amount * 100) / 100;
    if (amount) totalSettled += amount;

    matchedOrders.push({
      orderId,
      shopifyOrderName: entry.orderName,
      amount: amount || 0,
      utr: entry.utr || null,
      status: 'Payment settlement',
      remittanceRef: entry.ref,
      city: entry.city,
    });

    const sourceLabel =
      kind === 'GOKWIK_SETTLEMENT'
        ? 'GOKWIK_SETTLEMENT'
        : kind === 'PHONEPE_SETTLEMENT'
          ? 'PHONEPE_SETTLEMENT'
          : 'PG_SETTLEMENT_REPORT';

    try {
    await recordPaymentReceived(orderId, {
      receivedAt: entry.at.getTime() > 0 ? entry.at : new Date(),
      amount,
      utr: entry.utr || null,
      ref: entry.ref || null,
      source: sourceLabel,
      actor: actor || (uploadedBy ? { email: uploadedBy } : undefined),
      gatewayFee: Math.round(entry.fee * 100) / 100,
    });
    recordedCount++;
    } catch (error: any) {
      totalSettled -= amount; matchedOrders.pop(); unmatched.push(entry.orderName || String(orderId));
      notes.push(`${entry.orderName || orderId}: bank evidence conflicts or could not be recorded; review this order.`);
      logger.warn('Gateway settlement row not recorded', { orderId, error: error.message });
    }
  }

  if (skippedState) notes.push(`${skippedState} row(s) were not settled yet (status column) and were skipped.`);
  if (codRows) notes.push(`${codRows} row(s) matched COD orders and were skipped; COD money comes from the Delhivery remittance.`);
  if (missingUtr) notes.push(`${missingUtr} order(s) were matched but the file has no UTR for them.`);

  return saveImport(
    {
      kind,
      fileName,
      rowCount,
      matchedCount: recordedCount,
      unmatched,
      columns,
      notes,
      totalRemittance: Math.round(totalSettled * 100) / 100,
      bankTransactionId: primaryUtr,
      state: primaryUtr ? 'Completed' : 'Pending',
      matchedOrders,
      extractedFiles: getExtractedFiles(sheets),
      storageMode: 'POSTGRESQL_RELATIONAL_DATA',
      zipStoredOnDisk: false,
    },
    uploadedBy
  );
}

// ─── Partner Carrier Remittance (Amazon Shipping / Ekart / Generic) ─────

export async function importCarrierRemittance(
  carrierKind: ImportKind,
  fileName: string,
  sheets: ParsedSheet[],
  defaults: RemittanceDefaults = {},
  uploadedBy?: string,
  actor?: AccountTrailActor
): Promise<ImportResult> {
  const headers = sheets.flatMap((s) => s.headers);
  const columns = {
    awb: pickColumn(headers, AWB_COLUMN),
    order: pickColumn(headers, ORDER_COLUMN),
    utr: pickColumn(headers, [/^utr( no| number)?$/, /bank transaction id|bank txn|utr|bank ref|transaction ref/]),
    remittance: pickColumn(headers, [/remittance (number|no|id|ref)/, /\bcrn\b|batch (id|no)/]),
    amount: pickColumn(headers, [
      /remitted amount|remittance amount/,
      /amount payable/,
      /^cod amount$|cod amount/,
      /net amount/,
      /^amount$|amount/,
    ]),
    date: pickColumn(headers, [/remittance (processed )?date|processed date|remitted (on|at|date)/, /payment date|^date$|date/]),
  };

  const notes: string[] = [];
  const unmatched: string[] = [];
  const skippedDuplicates: string[] = [];
  const seenInBatch = new Set<string>();
  let rowCount = 0;
  let matchedCount = 0;
  let missingUtr = 0;

  if (!columns.awb && !columns.order) {
    return saveImport(
      {
        kind: carrierKind,
        fileName,
        rowCount: 0,
        matchedCount: 0,
        unmatched: [],
        skippedDuplicates: [],
        columns,
        notes: [`No Waybill / AWB or Order Number column found. Columns in the file: ${headers.join(', ')}`],
        extractedFiles: getExtractedFiles(sheets),
        storageMode: 'POSTGRESQL_RELATIONAL_DATA',
        zipStoredOnDisk: false,
      },
      uploadedBy
    );
  }

  const fallbackDate = parseDateLoose(defaults.remittedAt || '') || new Date();
  const refCount = new Set(columns.remittance ? rowsOf(sheets).map(({ row }) => row[columns.remittance!]).filter(Boolean) : []).size;
  const defaultUtr = refCount <= 1 ? defaults.utr : undefined;
  const defaultRef = defaults.remittanceRef || fileName.replace(/\.zip|\.csv|\.xlsx/i, '');

  let totalAmountRemitted = 0;
  const matchedOrders: MatchedOrderSummary[] = [];

  for (const { row } of rowsOf(sheets)) {
    const awb = (columns.awb ? row[columns.awb] : '').trim();
    const orderRef = (columns.order ? row[columns.order] : '').trim();
    if (!awb && !orderRef) continue;
    rowCount++;

    const trackingKey = awb || orderRef;
    if (seenInBatch.has(trackingKey)) {
      skippedDuplicates.push(`${trackingKey} (duplicate row in file)`);
      continue;
    }
    seenInBatch.add(trackingKey);

    const shipment = await prisma.shipment.findFirst({
      where: {
        OR: [
          ...(awb ? [{ waybillNumber: awb }] : []),
          ...(orderRef
            ? [
                { order: { shopifyOrderName: `#${orderRef.replace(/^#/, '')}` } },
                { order: { shopifyOrderName: orderRef.replace(/^#/, '') } },
              ]
            : []),
        ],
      },
      include: { order: true },
    });
    if (!shipment) {
      unmatched.push(awb || orderRef);
      continue;
    }

    if (shipment.codRemitted && shipment.codRemittedAmount && shipment.codRemittedAmount > 0) {
      skippedDuplicates.push(awb || orderRef);
      continue;
    }

    const utr = (columns.utr && row[columns.utr]) || defaultUtr || null;
    const ref = (columns.remittance && row[columns.remittance]) || defaultRef || null;
    const remittedAt = (columns.date && parseDateLoose(row[columns.date])) || fallbackDate;
    const fileAmount = columns.amount ? parseAmount(row[columns.amount]) : null;
    if (fileAmount === null || fileAmount < 0) { unmatched.push(trackingKey); notes.push(`${trackingKey}: no non-negative remittance amount; not inferred from the order.`); continue; }
    const amount: number = fileAmount;
    if (!utr) missingUtr++;
    totalAmountRemitted += amount;

    matchedOrders.push({
      orderId: shipment.order?.id,
      shopifyOrderName: shipment.order?.shopifyOrderName,
      waybillNumber: shipment.waybillNumber || awb,
      amount,
      utr,
      status: shipment.order?.status || 'Unknown',
      remittanceRef: ref,
      city: row['City'] || row['city'],
    });

    if (shipment.order) {
      try {
      await recordPaymentReceived(shipment.order.id, {
        receivedAt: remittedAt,
        amount,
        utr,
        ref,
        source: `${carrierKind}_REMITTANCE`,
        actor: actor || (uploadedBy ? { email: uploadedBy } : undefined),
        deliveredAt: shipment.order.deliveredAt || remittedAt,
      });
      } catch (error: any) {
        totalAmountRemitted -= amount; matchedOrders.pop(); unmatched.push(trackingKey);
        notes.push(`${trackingKey}: bank evidence conflicts or could not be recorded; review this order.`);
        logger.warn('Carrier remittance row not recorded', { orderId: shipment.order.id, error: error.message });
        continue;
      }
    }
    await prisma.shipment.update({
      where: { id: shipment.id },
      data: {
        codCollected: true,
        codCollectedAt: shipment.codCollectedAt || remittedAt,
        codRemitted: true,
        codRemittedAt: remittedAt,
        codRemittanceRef: ref || utr || `${carrierKind}-REMITTANCE`,
        codRemittedAmount: amount,
      },
    });
    matchedCount++;
  }

  if (missingUtr) notes.push(`${missingUtr} order(s) had no UTR in the file.`);
  if (skippedDuplicates.length > 0) {
    notes.push(`${skippedDuplicates.length} tracking ID(s) were skipped because they were already remitted or duplicated.`);
  }

  return saveImport(
    {
      kind: carrierKind,
      fileName,
      rowCount,
      matchedCount,
      unmatched,
      skippedDuplicates,
      remittanceNumber: defaultRef,
      remittanceDate: fallbackDate.toISOString().slice(0, 10),
      bankTransactionId: defaultUtr || null,
      state: defaultUtr ? 'Completed' : 'Pending',
      totalRemittance: Math.round(totalAmountRemitted * 100) / 100,
      matchedOrders,
      columns,
      notes,
      extractedFiles: getExtractedFiles(sheets),
      storageMode: 'POSTGRESQL_RELATIONAL_DATA',
      zipStoredOnDisk: false,
    },
    uploadedBy
  );
}

/**
 * Direct Live API Sync for Velocity COD Remittances, Bank UTRs & Wallet Charges.
 * Pulls statement data from the Velocity API and automatically reconciles
 * orders in the database without requiring manual spreadsheet downloads/uploads.
 */
export async function syncVelocityRemittance(
  actor?: AccountTrailActor,
  params?: { startDate?: string; endDate?: string; awbs?: string[]; lookbackDays?: number }
): Promise<ImportResult> {
  const { velocityFinancialSyncService } = await import('../velocity/velocity-financial-sync.service');
  const syncRes = await velocityFinancialSyncService.syncVelocityFinancials({
    actor,
    startDate: params?.startDate,
    endDate: params?.endDate,
    awbs: params?.awbs,
    lookbackDays: params?.lookbackDays,
  });

  const defaultUtr = syncRes.matchedOrders.find((m) => m.utr)?.utr || null;
  const fileName = `Velocity-Auto-Sync-${new Date().toISOString().slice(0, 10)}`;

  return {
    importId: syncRes.importId,
    kind: 'VELOCITY_REMITTANCE',
    fileName,
    rowCount: syncRes.awbsChecked,
    matchedCount: syncRes.matchedCount,
    unmatched: syncRes.unmatchedAwbs,
    skippedDuplicates: [],
    remittanceNumber: `VEL-BATCH-${Date.now()}`,
    remittanceDate: new Date().toISOString().slice(0, 10),
    bankTransactionId: defaultUtr,
    state: defaultUtr ? 'Completed' : 'Pending',
    totalRemittance: syncRes.totalRemittanceAmount,
    matchedOrders: syncRes.matchedOrders.map((m) => ({
      orderId: m.orderId,
      shopifyOrderName: m.shopifyOrderName,
      waybillNumber: m.waybillNumber,
      amount: m.remittedAmount ?? m.codAmount,
      utr: m.utr || null,
      remittanceRef: m.remittanceRef || null,
      city: m.city,
      status: m.status,
    })),
    columns: {
      awb: 'awb',
      utr: 'utr_no',
      remittance: 'remittance_ref',
      amount: 'cod_amount',
      date: 'remittance_date',
      charges: 'shipping_charges',
    },
    notes: syncRes.notes,
  };
}

