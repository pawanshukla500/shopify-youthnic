/**
 * Provider bill reconciliation (payment gateways and couriers).
 *
 * Easebuzz / PhonePe deduct their charges from every settlement and Velocity / Delhivery
 * from the wallet per AWB. That per-transaction deduction is the "consumption". Once a
 * month the provider raises one tax invoice for it (e.g. Easebuzz Oct-2026: ₹4,426.11 +
 * IGST ₹796.70 = ₹5,222.81). The invoice must equal our consumption for the month.
 *
 * Tally treatment:
 *   Purchase (the bill):  Dr expense ledger + Dr input GST   / Cr provider ledger (invoice total)
 *   Journal (nullify):    Dr provider ledger (consumption)    / Cr where the deduction sat
 *                         (Sundry Debtors for gateway fees kept out of settlements,
 *                          the prepaid wallet for courier freight)
 * The provider ledger then closes to zero; anything left is a real variance to raise with them.
 */
import prisma from '../../database/prisma';
import { isVelocityCourier } from '../../utils/courier';
import { monthRange, money, sum, resolvePaymentRailName } from './accounts-report.service';

export type ProviderCode = 'EASEBUZZ' | 'PHONEPE' | 'VELOCITY' | 'DELHIVERY';

export const PROVIDERS: Record<ProviderCode, {
  label: string;
  kind: 'GATEWAY' | 'FREIGHT';
  partyLedger: string;
  expenseLedger: string;
  consumedFromLedger: string;
}> = {
  EASEBUZZ: {
    label: 'Easebuzz',
    kind: 'GATEWAY',
    partyLedger: 'Easebuzz Pvt Ltd',
    expenseLedger: 'Payment Gateway Processing Fees (Easebuzz)',
    consumedFromLedger: 'Sundry Debtors - Online Store Customers',
  },
  PHONEPE: {
    label: 'PhonePe',
    kind: 'GATEWAY',
    partyLedger: 'PhonePe Pvt Ltd',
    expenseLedger: 'Payment Gateway Processing Fees (PhonePe)',
    consumedFromLedger: 'Sundry Debtors - Online Store Customers',
  },
  VELOCITY: {
    label: 'Velocity',
    kind: 'FREIGHT',
    partyLedger: 'Velocity Technologies (Vendor Payable)',
    expenseLedger: 'Freight Charges - Forward Shipments',
    consumedFromLedger: 'Velocity Prepaid Logistics Wallet',
  },
  DELHIVERY: {
    label: 'Delhivery',
    kind: 'FREIGHT',
    partyLedger: 'Delhivery Limited (Vendor Payable)',
    expenseLedger: 'Freight Charges - Forward Shipments',
    consumedFromLedger: 'Delhivery Prepaid Logistics Wallet',
  },
};

export const PROVIDER_CODES = Object.keys(PROVIDERS) as ProviderCode[];
/** Rupee tolerance for calling a bill matched (paise rounding across hundreds of lines). */
export const MATCH_TOLERANCE = 1;

export interface ProviderInvoiceLike {
  id?: number;
  invoiceNumber: string;
  invoiceDate: Date | string;
  taxableAmount: number;
  igst: number;
  cgst: number;
  sgst: number;
  totalAmount: number;
  note?: string | null;
}

export interface Consumption {
  taxable: number;
  gst: number;
  total: number;
  lines: number;     // transactions / shipment legs counted
  estimated: number; // legs still on an estimate or with no charge yet (freight only)
  basis: string;
}

export interface ProviderReconRow {
  provider: ProviderCode;
  label: string;
  kind: 'GATEWAY' | 'FREIGHT';
  period: string;
  invoices: ProviderInvoiceLike[];
  invoiceTaxable: number;
  invoiceGst: number;
  invoiceTotal: number;
  consumption: Consumption;
  variance: number | null; // invoice total − consumption total
  status: 'MATCHED' | 'VARIANCE' | 'INVOICE_PENDING';
  ledgers: (typeof PROVIDERS)[ProviderCode];
}

const n = (v: unknown): number => Number(v) || 0;

/** GST-inclusive amount → taxable + 18% GST (gateway and courier services). */
function split18(total: number): { taxable: number; gst: number } {
  const gst = money((total * 18) / 118) || 0;
  return { taxable: money(total - gst) || 0, gst };
}

/** Compare one provider's invoices for the month with what it already deducted. Pure. */
export function reconcileProvider(
  provider: ProviderCode,
  period: string,
  invoices: ProviderInvoiceLike[],
  consumption: Consumption
): ProviderReconRow {
  const invoiceTaxable = sum(invoices.map((i) => n(i.taxableAmount)));
  const invoiceGst = sum(invoices.map((i) => n(i.igst) + n(i.cgst) + n(i.sgst)));
  const invoiceTotal = sum(invoices.map((i) => n(i.totalAmount)));
  const variance = invoices.length ? money(invoiceTotal - consumption.total) : null;
  return {
    provider,
    label: PROVIDERS[provider].label,
    kind: PROVIDERS[provider].kind,
    period,
    invoices,
    invoiceTaxable,
    invoiceGst,
    invoiceTotal,
    consumption,
    variance,
    status: variance === null ? 'INVOICE_PENDING' : Math.abs(variance) <= MATCH_TOLERANCE ? 'MATCHED' : 'VARIANCE',
    ledgers: PROVIDERS[provider],
  };
}

/** Rows in the monthly workbook's "Tally Vouchers" layout: one Purchase per bill + one nullifying Journal. Pure. */
export function providerTallyRows(row: ProviderReconRow, monthEnd: Date): Array<Record<string, any>> {
  if (!row.invoices.length) return [];
  const { partyLedger, expenseLedger, consumedFromLedger } = row.ledgers;
  const out: Array<Record<string, any>> = row.invoices.map((inv) => ({
    voucherDate: new Date(inv.invoiceDate),
    voucherType: 'Purchase',
    voucherNo: inv.invoiceNumber,
    partyLedger,
    particulars: `${expenseLedger} + Input GST`,
    gstPos: '',
    taxableAmount: n(inv.taxableAmount),
    igst: n(inv.igst),
    cgst: n(inv.cgst),
    sgst: n(inv.sgst),
    totalAmount: n(inv.totalAmount),
    drCr: 'Cr',
    paymentRail: row.label,
    utr: '',
    narration: `${row.label} bill ${inv.invoiceNumber} for ${row.period}: Dr ${expenseLedger} ₹${n(inv.taxableAmount).toFixed(2)} + input GST, Cr ${partyLedger}`,
  }));
  out.push({
    voucherDate: monthEnd,
    voucherType: 'Journal',
    voucherNo: `NULLIFY-${row.provider}-${row.period}`,
    partyLedger,
    particulars: consumedFromLedger,
    gstPos: '',
    taxableAmount: row.consumption.total,
    igst: 0,
    cgst: 0,
    sgst: 0,
    totalAmount: row.consumption.total,
    drCr: 'Dr',
    paymentRail: row.label,
    utr: '',
    narration:
      `Nullify ${row.label} bill against charges already deducted in ${row.period}: Dr ${partyLedger}, Cr ${consumedFromLedger}` +
      (row.status === 'VARIANCE' ? `. Variance ₹${row.variance?.toFixed(2)} stays on ${partyLedger}: raise it with ${row.label}.` : ''),
  });
  return out;
}

async function gatewayConsumption(provider: ProviderCode, start: Date, end: Date): Promise<Consumption> {
  // Easebuzz settlement files carry the real per-transaction fee/GST split and transaction date.
  if (provider === 'EASEBUZZ' && typeof prisma.gatewaySettlementOrder?.findMany === 'function') {
    const rows = await prisma.gatewaySettlementOrder.findMany({
      where: { transactionDate: { gte: start, lt: end }, batch: { gateway: 'EASEBUZZ' } },
      select: { id: true, easebuzzTrxnId: true, merchantTrxnId: true, serviceCharge: true, gst: true },
    });
    // The same transaction can appear in more than one uploaded batch.
    const unique = new Map(rows.map((r) => [r.easebuzzTrxnId || r.merchantTrxnId || `row-${r.id}`, r]));
    if (unique.size) {
      const taxable = sum([...unique.values()].map((r) => n(r.serviceCharge)));
      const gst = sum([...unique.values()].map((r) => n(r.gst)));
      return { taxable, gst, total: money(taxable + gst) || 0, lines: unique.size, estimated: 0, basis: 'Easebuzz settlement rows by transaction date' };
    }
  }
  // Fallback: fee + GST recorded on each prepaid order, by order (transaction) date.
  const rail = provider === 'PHONEPE' ? 'PhonePe' : 'EaseBuzz';
  const orders = await prisma.order.findMany({
    where: { shopifyCreatedAt: { gte: start, lt: end }, gatewayFee: { gt: 0 } },
    select: {
      gatewayFee: true, paymentMethod: true, paymentGateway: true, paymentProvider: true,
      paymentAggregator: true, paymentReceivedSource: true, tags: true,
    },
  });
  const fees = orders
    .filter((o) => o.paymentMethod !== 'COD' && resolvePaymentRailName({ ...o, shipment: null }) === rail)
    .map((o) => n(o.gatewayFee));
  const total = sum(fees);
  return { ...split18(total), total, lines: fees.length, estimated: 0, basis: 'Order gateway fees by order date (GST split at 18%)' };
}

async function freightConsumption(provider: ProviderCode, start: Date, end: Date): Promise<Consumption> {
  const velocity = provider === 'VELOCITY';
  const inMonth = { gte: start, lt: end };
  const [shipments, reverses] = await Promise.all([
    // shortcut: a leg is counted in the month the parcel was manifested, not when the courier billed an RTO; widen if bills lag.
    prisma.shipment.findMany({
      where: {
        waybillNumber: { not: null },
        status: { not: 'CANCELLED' },
        OR: [{ omsManifestedAt: inMonth }, { omsManifestedAt: null, createdAt: inMonth }],
      },
      select: {
        courier: true, labelUrl: true, waybillNumber: true, status: true,
        forwardCharge: true, rtoCharge: true, shippingCostSource: true, rtoChargeSource: true,
      },
    }),
    prisma.return.findMany({
      where: { createdAt: inMonth, returnWaybillNumber: { not: null }, returnStatus: { not: 'CANCELLED' } },
      select: { carrier: true, shippingCharge: true, shippingCostSource: true },
    }),
  ]);
  let lines = 0;
  let estimated = 0;
  const amounts: number[] = [];
  const leg = (value: number | null | undefined, source: string | null | undefined) => {
    lines++;
    if (value === null || value === undefined || source !== 'ACTUAL') estimated++;
    amounts.push(value || 0);
  };
  for (const s of shipments) {
    if (isVelocityCourier(s.courier, s.labelUrl, s.waybillNumber) !== velocity) continue;
    leg(s.forwardCharge, s.shippingCostSource);
    if (s.rtoCharge !== null || /^RTO/.test(s.status)) leg(s.rtoCharge, s.rtoChargeSource);
  }
  for (const r of reverses) {
    if (/velocity/i.test(r.carrier || '') !== velocity) continue;
    leg(r.shippingCharge, r.shippingCostSource);
  }
  const total = sum(amounts);
  return { ...split18(total), total, lines, estimated, basis: 'Per-AWB charges (forward, RTO, reverse and exchange legs) by manifest date' };
}

export async function computeConsumption(provider: ProviderCode, period: string): Promise<Consumption> {
  const { start, end } = monthRange(period);
  return PROVIDERS[provider].kind === 'GATEWAY'
    ? gatewayConsumption(provider, start, end)
    : freightConsumption(provider, start, end);
}

/** Every provider's bill-vs-consumption row for the month. */
export async function getProviderReconciliation(period: string): Promise<ProviderReconRow[]> {
  monthRange(period); // validates YYYY-MM
  const invoices = await prisma.providerInvoice.findMany({ where: { period }, orderBy: { invoiceDate: 'asc' } });
  return Promise.all(
    PROVIDER_CODES.map(async (provider) =>
      reconcileProvider(
        provider,
        period,
        invoices
          .filter((i) => i.provider === provider)
          .map((i) => ({
            id: i.id,
            invoiceNumber: i.invoiceNumber,
            invoiceDate: i.invoiceDate,
            taxableAmount: n(i.taxableAmount),
            igst: n(i.igst),
            cgst: n(i.cgst),
            sgst: n(i.sgst),
            totalAmount: n(i.totalAmount),
            note: i.note,
          })),
        await computeConsumption(provider, period)
      )
    )
  );
}

/** Validate a bill typed in from the provider's PDF. Throws a readable message. Pure. */
export function validateProviderInvoice(body: any): {
  provider: ProviderCode; period: string; invoiceNumber: string; invoiceDate: Date;
  taxableAmount: number; igst: number; cgst: number; sgst: number; totalAmount: number; note: string | null;
} {
  const provider = String(body?.provider || '').toUpperCase() as ProviderCode;
  if (!PROVIDERS[provider]) throw new Error(`Provider must be one of ${PROVIDER_CODES.join(', ')}`);
  const period = String(body?.period || '');
  monthRange(period);
  const invoiceNumber = String(body?.invoiceNumber || '').trim();
  if (!invoiceNumber) throw new Error('Invoice number is required');
  const invoiceDate = new Date(body?.invoiceDate);
  if (Number.isNaN(invoiceDate.getTime())) throw new Error('Invoice date is invalid');
  const amounts = ['taxableAmount', 'igst', 'cgst', 'sgst', 'totalAmount'].map((k) => {
    const v = body?.[k] === undefined || body?.[k] === '' ? 0 : Number(body[k]);
    if (!Number.isFinite(v) || v < 0) throw new Error(`${k} must be a non-negative number`);
    return money(v) || 0;
  });
  const [taxableAmount, igst, cgst, sgst, totalAmount] = amounts;
  if (totalAmount <= 0) throw new Error('Invoice total must be more than zero');
  if (igst > 0 && (cgst > 0 || sgst > 0)) throw new Error('An invoice has either IGST or CGST + SGST, not both');
  if (Math.abs(taxableAmount + igst + cgst + sgst - totalAmount) > 0.05) {
    throw new Error(`Taxable ₹${taxableAmount} + GST ₹${money(igst + cgst + sgst)} does not equal the invoice total ₹${totalAmount}`);
  }
  return { provider, period, invoiceNumber, invoiceDate, taxableAmount, igst, cgst, sgst, totalAmount, note: body?.note ? String(body.note) : null };
}
