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

export type ImportKind = 'DELHIVERY_REMITTANCE' | 'DELHIVERY_CHARGES' | 'PG_SETTLEMENT';

export interface ImportResult {
  importId?: number;
  kind: ImportKind;
  fileName: string;
  rowCount: number;
  matchedCount: number;
  unmatched: string[];
  /** Which header was used for each field, so a wrong guess is visible. */
  columns: Record<string, string | undefined>;
  notes: string[];
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
  const matches = await prisma.order.findMany({
    where: {
      OR: [
        { shopifyOrderName: `#${bare}` },
        { shopifyOrderName: bare },
        { shopifyOrderId: bare },
        { gokwikPaymentId: bare },
        { paymentProviderPaymentId: bare },
        { gatewayTransactionId: bare },
        { paymentAuthorizationKey: bare },
        { paymentReference: bare },
      ],
    },
    include: { shipment: true },
    take: 2,
  });
  if (matches.length > 1) {
    logger.warn('Reference matches more than one order, not attaching it', { reference: raw });
    return null;
  }
  return matches[0] || null;
}

async function saveImport(result: ImportResult, uploadedBy?: string): Promise<ImportResult> {
  try {
    const row = await prisma.reconciliationImport.create({
      data: {
        kind: result.kind,
        fileName: result.fileName,
        rowCount: result.rowCount,
        matchedCount: result.matchedCount,
        unmatched: result.unmatched.slice(0, 500),
        summary: { columns: result.columns, notes: result.notes } as any,
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
  }
): Promise<void> {
  await prisma.order.update({
    where: { id: orderId },
    data: {
      paymentReceivedAt: payment.receivedAt,
      paymentReceivedAmount: payment.amount ?? null,
      paymentReceivedUtr: payment.utr || null,
      paymentReceivedRef: payment.ref || null,
      paymentReceivedSource: payment.source,
      ...(payment.gatewayFee !== undefined && payment.gatewayFee !== null ? { gatewayFee: payment.gatewayFee } : {}),
      paymentVerified: true,
      paymentVerifiedAt: payment.receivedAt,
    },
  });
}

// ─── Delhivery COD remittance ──────────────────────────────

export async function importDelhiveryRemittance(
  fileName: string,
  sheets: ParsedSheet[],
  defaults: RemittanceDefaults = {},
  uploadedBy?: string
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
        columns,
        notes: [`No Waybill / AWB or Order Number column found. Columns in the file: ${headers.join(', ')}`],
      },
      uploadedBy
    );
  }

  const fallbackDate = parseDateLoose(defaults.remittedAt || '') || new Date();
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
  for (const { row } of rowsOf(sheets)) {
    const awb = columns.awb ? row[columns.awb] : '';
    const orderRef = columns.order ? row[columns.order] : '';
    if (!awb && !orderRef) continue;
    rowCount++;

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

    const utr = (columns.utr && row[columns.utr]) || defaultUtr || null;
    const ref = (columns.remittance && row[columns.remittance]) || defaults.remittanceRef || null;
    const remittedAt = (columns.date && parseDateLoose(row[columns.date])) || fallbackDate;
    const fileAmount = columns.amount ? parseAmount(row[columns.amount]) : null;
    const amount: number = fileAmount || shipment.codAmount || shipment.order?.totalAmount || 0;
    if (!utr) missingUtr++;

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
    if (shipment.order) {
      await recordPaymentReceived(shipment.order.id, {
        receivedAt: remittedAt,
        amount,
        utr,
        ref,
        source: 'DELHIVERY_REMITTANCE',
      });
    }
    matchedCount++;
  }

  if (missingUtr > 0) {
    notes.push(
      `${missingUtr} matched row(s) had no UTR. Enter the remittance's Bank Transaction ID in the UTR box and upload the file again to fill it.`
    );
  }
  return saveImport(
    { kind: 'DELHIVERY_REMITTANCE', fileName, rowCount, matchedCount, unmatched, columns, notes },
    uploadedBy
  );
}

// ─── Delhivery shipping charges (wallet ledger / invoice backup) ───

type Leg = 'forward' | 'rto';

/**
 * Billed shipping cost per AWB and leg. Delhivery debits an estimate at
 * manifest, refunds and re-debits on weight correction, and debits the final
 * charge after delivery / RTO / DTO, so the charge for a leg is its LATEST
 * debit, not the sum of debits. Credits (refunds) are not costs.
 */
export async function importDelhiveryCharges(
  fileName: string,
  sheets: ParsedSheet[],
  uploadedBy?: string
): Promise<ImportResult> {
  const usable = sheets.filter((sheet) => !/summary/i.test(sheet.name));
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
    // Only free-text description columns decide the leg. A "Status" column
    // (e.g. RTO) describes the parcel, not which leg a row's amount is for.
    description: pickColumn(headers, [/description|narration|remarks/]),
    date: pickColumn(headers, [/date time|^date$|transaction date|date/]),
    weight: pickColumn(headers, [/charged weight|chargeable weight|billed weight/, /weight/]),
    zone: pickColumn(headers, [/zone/]),
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
      },
      uploadedBy
    );
  }

  // Latest debit per AWB and leg.
  const latest = new Map<string, { awb: string; leg: Leg; amount: number; at: number; order: number; weight?: number; zone?: string }>();
  let rowCount = 0;
  let order = 0;
  for (const { sheet, row } of rowsOf(usable)) {
    const awb = (row[columns.awb] || '').trim();
    if (!awb) continue;
    rowCount++;
    const typeText = `${columns.type ? row[columns.type] : ''} ${sheet.name}`;
    if (/refund|credit|reversal|\bcr\b/i.test(typeText) && !/debit|deduction/i.test(typeText)) continue;

    const text = `${columns.description ? row[columns.description] : ''} ${typeText}`;
    const at = (columns.date && parseDateLoose(row[columns.date])?.getTime()) || 0;
    const weight = columns.weight ? parseAmount(row[columns.weight]) ?? undefined : undefined;
    const zone = columns.zone ? row[columns.zone] || undefined : undefined;

    const legs: Array<{ leg: Leg; amount: number }> = [];
    const total = parseAmount(row[columns.amount]);
    const rto = columns.rtoAmount ? parseAmount(row[columns.rtoAmount]) : null;
    if (rto && rto > 0) {
      legs.push({ leg: 'rto', amount: Math.abs(rto) });
      if (total && Math.abs(total) > Math.abs(rto)) legs.push({ leg: 'forward', amount: Math.abs(total) - Math.abs(rto) });
    } else if (total) {
      // Reverse pickups have their own AWB and are recognised by matching a
      // Return below, never from row text.
      const leg: Leg = /\brto\b|return to origin/i.test(text) ? 'rto' : 'forward';
      legs.push({ leg, amount: Math.abs(total) });
    }

    for (const { leg, amount } of legs) {
      const key = `${awb}|${leg}`;
      order++;
      const prev = latest.get(key);
      if (!prev || at > prev.at || (at === prev.at && order > prev.order)) {
        latest.set(key, { awb, leg, amount, at, order, weight, zone });
      }
    }
  }

  const matchedAwbs = new Set<string>();
  const unmatchedAwbs = new Set<string>();
  for (const charge of latest.values()) {
    const amount = Math.round(charge.amount * 100) / 100;
    // A reverse-pickup AWB belongs to a Return, whatever the row text says.
    const reverse = await prisma.return.findFirst({ where: { returnWaybillNumber: charge.awb } });
    if (reverse) {
      await prisma.return.update({
        where: { id: reverse.id },
        data: { shippingCharge: amount, shippingCostSource: 'ACTUAL' },
      });
      matchedAwbs.add(charge.awb);
      continue;
    }
    const shipment = await prisma.shipment.findFirst({ where: { waybillNumber: charge.awb } });
    if (!shipment) {
      unmatchedAwbs.add(charge.awb);
      continue;
    }
    await prisma.shipment.update({
      where: { id: shipment.id },
      data: {
        // Each leg records its own source: an upload that only bills the RTO
        // leg leaves the forward estimate marked as an estimate.
        ...(charge.leg === 'rto'
          ? { rtoCharge: amount, rtoChargeSource: 'ACTUAL' }
          : { forwardCharge: amount, shippingCostSource: 'ACTUAL' }),
        shippingCostUpdatedAt: new Date(),
        ...(charge.weight ? { billedWeightGrams: charge.weight < 50 ? charge.weight * 1000 : charge.weight } : {}),
        ...(charge.zone ? { chargedZone: charge.zone } : {}),
      },
    });
    matchedAwbs.add(charge.awb);
  }
  for (const awb of unmatchedAwbs) if (!matchedAwbs.has(awb)) unmatched.push(awb);

  return saveImport(
    { kind: 'DELHIVERY_CHARGES', fileName, rowCount, matchedCount: matchedAwbs.size, unmatched, columns, notes },
    uploadedBy
  );
}

// ─── Gateway settlement (PhonePe / Easebuzz / GoKwik) ──────

const SETTLED_STATES = /^(success|successful|settled|processed|completed|paid|credited)$/i;

export async function importGatewaySettlement(
  fileName: string,
  sheets: ParsedSheet[],
  uploadedBy?: string
): Promise<ImportResult> {
  const headers = sheets.flatMap((s) => s.headers);
  const columns = {
    order: pickColumn(headers, ORDER_COLUMN),
    transaction: pickColumn(headers, [
      /merchant transaction id|pg transaction id|transaction id|txn ?id|txnid/,
      /easepayid|payment id|^reference$/,
    ]),
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
  if (!columns.order && !columns.transaction) {
    return saveImport(
      {
        kind: 'PG_SETTLEMENT',
        fileName,
        rowCount: 0,
        matchedCount: 0,
        unmatched: [],
        columns,
        notes: [`No order or transaction id column found. Columns in the file: ${headers.join(', ')}`],
      },
      uploadedBy
    );
  }

  // One settlement can list an order more than once (split payments,
  // refund adjustments), so amounts and fees are summed per order.
  const perOrder = new Map<number, { amount: number; fee: number; utr?: string; at: Date; ref?: string }>();
  let rowCount = 0;
  let skippedState = 0;
  let codRows = 0;
  for (const { row } of rowsOf(sheets)) {
    const orderRef = columns.order ? row[columns.order] : '';
    const txn = columns.transaction ? row[columns.transaction] : '';
    if (!orderRef && !txn) continue;
    rowCount++;
    if (columns.status && row[columns.status] && !SETTLED_STATES.test(row[columns.status].trim())) {
      skippedState++;
      continue;
    }

    const order = (orderRef && (await findOrderByReference(orderRef))) || (txn && (await findOrderByReference(txn))) || null;
    if (!order) {
      unmatched.push(orderRef || txn);
      continue;
    }
    if (order.paymentMethod === 'COD') {
      codRows++;
      continue;
    }

    const entry = perOrder.get(order.id) || { amount: 0, fee: 0, at: new Date(0) };
    entry.amount += (columns.amount && parseAmount(row[columns.amount])) || 0;
    entry.fee += Math.abs((columns.fee && parseAmount(row[columns.fee])) || 0) + Math.abs((columns.tax && parseAmount(row[columns.tax])) || 0);
    const utr = columns.utr ? row[columns.utr] : '';
    if (utr) entry.utr = utr;
    entry.ref = txn || entry.ref;
    const at = (columns.date && parseDateLoose(row[columns.date])) || null;
    if (at && at > entry.at) entry.at = at;
    perOrder.set(order.id, entry);
  }

  let missingUtr = 0;
  for (const [orderId, entry] of perOrder) {
    if (!entry.utr) missingUtr++;
    await recordPaymentReceived(orderId, {
      receivedAt: entry.at.getTime() > 0 ? entry.at : new Date(),
      amount: Math.round(entry.amount * 100) / 100 || null,
      utr: entry.utr || null,
      ref: entry.ref || null,
      source: 'PG_SETTLEMENT_REPORT',
      gatewayFee: Math.round(entry.fee * 100) / 100,
    });
  }

  if (skippedState) notes.push(`${skippedState} row(s) were not settled yet (status column) and were skipped.`);
  if (codRows) notes.push(`${codRows} row(s) matched COD orders and were skipped; COD money comes from the Delhivery remittance.`);
  if (missingUtr) notes.push(`${missingUtr} order(s) were matched but the file has no UTR for them.`);
  return saveImport(
    { kind: 'PG_SETTLEMENT', fileName, rowCount, matchedCount: perOrder.size, unmatched, columns, notes },
    uploadedBy
  );
}
