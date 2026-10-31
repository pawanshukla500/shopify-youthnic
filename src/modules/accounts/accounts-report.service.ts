/**
 * Monthly accounts closing report (Excel) & State-Wise Tally Ledger Matrix.
 *
 * Automated monthly email dispatch on the 10th of every month to:
 *   To: accounts2@vbexports.co.in
 *   CC: returnorders@vbexports.co.in, vaibhav@vbexports.co.in, accounts@vbexports.co.in
 *
 * Accounting formula:
 *   State-wise Monthly Sales - Returns Deducted - Payment Received = Net Outstanding
 *
 * Return Timing & Cutoff Rule (Tally ERP Alignment):
 *   If an order is placed in Month M (e.g. 1-31 Oct) but its return occurs after Month M
 *   (e.g. in November), that return deduction is accounted under November's books.
 *   Returns occurring in Month M (even for orders placed in prior months) are deducted
 *   in Month M's Tally ledger.
 *
 * Payment Rails:
 *   - Delhivery COD -> "Delhivery"
 *   - GoKwik (Easebuzz) -> "EaseBuzz"
 *   - PhonePe -> "PhonePe"
 *   - Velocity -> "Velocity"
 *   along with exact bank UTR details.
 */
import ExcelJS from 'exceljs';
import prisma from '../../database/prisma';
import { config } from '../../config';
import logger from '../../utils/logger';
import resendService from '../email/resend.service';
import { accountsStatus } from '../orders/order-tabs';
import { istDateRange } from './settlement-summary';
import { isDelhiveryCourier, isVelocityCourier } from '../../utils/courier';

const IST_OFFSET_MS = 5.5 * 3600 * 1000;

export type PaymentRailName = 'Delhivery' | 'EaseBuzz' | 'PhonePe' | 'Velocity';

/** 'YYYY-MM' → the month's start and end instants in IST, plus a label. */
export function monthRange(month: string): { start: Date; end: Date; label: string } {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) throw new Error(`Month must be YYYY-MM, got "${month}"`);
  const year = +m[1];
  const monthIndex = +m[2] - 1;
  if (monthIndex < 0 || monthIndex > 11) throw new Error(`Month must be YYYY-MM, got "${month}"`);
  const start = new Date(Date.UTC(year, monthIndex, 1) - IST_OFFSET_MS);
  const end = new Date(Date.UTC(year, monthIndex + 1, 1) - IST_OFFSET_MS);
  const label = new Date(Date.UTC(year, monthIndex, 15)).toLocaleString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return { start, end, label };
}

/** The month before `now` (in IST) as 'YYYY-MM'. */
export function previousMonth(now: Date = new Date()): string {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const year = ist.getUTCMonth() === 0 ? ist.getUTCFullYear() - 1 : ist.getUTCFullYear();
  const month = ist.getUTCMonth() === 0 ? 12 : ist.getUTCMonth();
  return `${year}-${String(month).padStart(2, '0')}`;
}

/** An instant as an Excel date cell showing the IST calendar date. */
export function istDay(value?: Date | string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const ist = new Date(date.getTime() + IST_OFFSET_MS);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));
}

export const money = (value?: number | null): number | null =>
  value === null || value === undefined || Number.isNaN(value) ? null : Math.round(value * 100) / 100;

export function sum(values: Array<number | null | undefined>): number {
  return Math.round(values.reduce<number>((total, v) => total + (v || 0), 0) * 100) / 100;
}

export const SOURCE_LABELS: Record<string, string> = {
  DELHIVERY_REMITTANCE: 'Delhivery COD remittance',
  VELOCITY_REMITTANCE: 'Velocity COD remittance',
  AMAZON_SHIPPING_REMITTANCE: 'Velocity (Amazon) remittance',
  EKART_SHIPPING_REMITTANCE: 'Velocity (Ekart) remittance',
  PG_SETTLEMENT_REPORT: 'Gateway settlement report',
  GOKWIK_SETTLEMENT: 'GoKwik (Easebuzz) settlement',
  PHONEPE_SETTLEMENT: 'PhonePe settlement',
  PHONEPE_SETTLEMENT_API: 'PhonePe settlement API',
  EASEBUZZ_PAYOUT_API: 'Easebuzz payout API',
  MANUAL: 'Entered manually',
};

export const STATUS_LABELS: Record<string, string> = {
  NEW: 'New',
  DISPATCH_PENDING: 'Ready to dispatch',
  DISPATCHED: 'Label created',
  SHIPPED: 'Picked up',
  IN_TRANSIT: 'In transit',
  OUT_FOR_DELIVERY: 'Out for delivery',
  DELIVERED: 'Delivered',
  FAILED_DELIVERY: 'Delivery failed (NDR)',
  RTO_INITIATED: 'RTO in transit',
  RTO_DELIVERED: 'RTO received',
  RETURN_REQUESTED: 'Return requested',
  EXCHANGE_REQUESTED: 'Exchange requested',
  RETURN_DISPATCHED: 'Return in transit',
  RETURN_RECEIVED: 'Return received',
  REFUNDED: 'Refunded',
  CANCELLED: 'Cancelled',
};

/**
 * Attribute an order's payment rail strictly into:
 *   - "Delhivery"
 *   - "EaseBuzz"
 *   - "PhonePe"
 *   - "Velocity"
 */
export function resolvePaymentRailName(order: {
  paymentReceivedSource?: string | null;
  paymentGateway?: string | null;
  paymentProvider?: string | null;
  paymentAggregator?: string | null;
  paymentMethod?: string | null;
  tags?: string | null;
  shipment?: { courier?: string | null; labelUrl?: string | null; waybillNumber?: string | null } | null;
}): PaymentRailName {
  const isCod = order.paymentMethod === 'COD' || (order.paymentGateway || '').toLowerCase().includes('cash');
  const courier = order.shipment?.courier || '';
  const labelUrl = order.shipment?.labelUrl || '';
  const waybill = order.shipment?.waybillNumber || '';
  const src = (order.paymentReceivedSource || '').toLowerCase();
  const gwAll = `${order.paymentProvider || ''} ${order.paymentAggregator || ''} ${order.paymentGateway || ''} ${order.tags || ''}`.toLowerCase();

  // 1. Velocity (courier or remittance source)
  if (src.includes('velocity') || isVelocityCourier(courier, labelUrl, waybill)) {
    return 'Velocity';
  }

  // 2. Delhivery COD
  if (isCod) {
    return 'Delhivery';
  }

  // 3. PhonePe
  if (src.includes('phonepe') || gwAll.includes('phonepe') || gwAll.includes('phone_pe')) {
    return 'PhonePe';
  }

  // 4. EaseBuzz (GoKwik / Easebuzz prepaid)
  if (
    src.includes('gokwik') ||
    src.includes('easebuzz') ||
    gwAll.includes('gokwik') ||
    gwAll.includes('easebuzz')
  ) {
    return 'EaseBuzz';
  }

  return 'EaseBuzz';
}

export interface StateAccountingRow {
  state: string;
  orderCount: number;
  grossSales: number;           // Orders placed in month M
  returnsDeducted: number;       // Returns occurring in month M (timing cutoff rule)
  netSales: number;              // grossSales - returnsDeducted
  paymentReceived: number;       // Settlements / Remittances in bank
  outstanding: number;           // grossSales - returnsDeducted - paymentReceived
  delhivery: number;             // Delhivery COD
  easebuzz: number;              // EaseBuzz (GoKwik)
  phonepe: number;               // PhonePe
  velocity: number;              // Velocity
  notes?: string;
}

export interface StateAccountingTotals {
  totalOrders: number;
  grossSales: number;
  returnsDeducted: number;
  netSales: number;
  paymentReceived: number;
  outstanding: number;
  delhivery: number;
  easebuzz: number;
  phonepe: number;
  velocity: number;
}

export interface ReportOrderRow {
  orderNo: string;
  orderDate: Date | null;
  customer: string;
  city: string;
  state: string;
  pincode: string;
  paymentMode: 'COD' | 'Prepaid';
  gateway: string;
  paymentRail: PaymentRailName;
  orderValue: number;
  orderStatus: string;
  deliveredOn: Date | null;
  returnWindowClosesOn: Date | null;
  paymentReceived: 'Yes' | 'No';
  receivedAmount: number | null;
  receivedOn: Date | null;
  utr: string;
  settlementRef: string;
  receivedVia: string;
  gatewayFee: number | null;
  customerPaymentRef: string;
  forwardAwb: string;
  forwardShipping: number | null;
  rtoShipping: number | null;
  returnAwb: string;
  returnShipping: number | null;
  totalShipping: number | null;
  shippingBasis: string;
  returnDeductedInPeriod: number;
  returnTimingNote: string;
  refundAmount: number | null;
  netAfterShipping: number | null;
  outstanding: number;
  accountsStatus: 'Closed' | 'Open' | 'Not a sale';
  pending: string;
}

export interface ReportReturnRow {
  returnId: number;
  orderNo: string;
  orderDate: Date | null;
  orderMonth: string;
  timingCategory: string;
  customer: string;
  state: string;
  returnDate: Date | null;
  refundDate: Date | null;
  returnStatus: string;
  refundStatus: string;
  refundAmount: number;
  paymentRail: PaymentRailName;
  tallyVoucherType: string;
  reason?: string;
}

export interface ReportData {
  month: string;
  label: string;
  generatedAt: Date;
  stateSummary: StateAccountingRow[];
  stateTotals: StateAccountingTotals;
  orders: ReportOrderRow[];
  returnsInPeriod: ReportReturnRow[];
  cod: Array<Record<string, any>>;
  prepaid: Array<Record<string, any>>;
  shipping: Array<Record<string, any>>;
  returns: Array<Record<string, any>>;
  summary: Array<{ label: string; value: number | string; note?: string }>;
}

/**
 * Builds the State-Wise Monthly Accounts Matrix following the timing cutoff rule:
 * - Orders placed in [start, end) count as Gross Sales in this period.
 * - Returns occurring in [start, end) count as Return Deductions in this period
 *   (regardless of when the original order was created).
 * - Orders placed in [start, end) that are returned after `end` are NOT deducted here;
 *   they are deducted under the subsequent month's books.
 */
export function buildStateAccountingSummary(
  orders: any[],
  periodReturns: any[],
  start?: Date,
  end?: Date
): { states: StateAccountingRow[]; totals: StateAccountingTotals } {
  const safeReturns = Array.isArray(periodReturns) ? periodReturns : [];
  const stateMap = new Map<string, StateAccountingRow>();

  function getRow(stateName?: string | null): StateAccountingRow {
    const raw = (stateName || '').trim();
    const clean = raw.length > 0 ? raw : 'Unspecified';
    if (!stateMap.has(clean)) {
      stateMap.set(clean, {
        state: clean,
        orderCount: 0,
        grossSales: 0,
        returnsDeducted: 0,
        netSales: 0,
        paymentReceived: 0,
        outstanding: 0,
        delhivery: 0,
        easebuzz: 0,
        phonepe: 0,
        velocity: 0,
      });
    }
    return stateMap.get(clean)!;
  }

  // 1. Tally gross sales and payments received for orders placed in this month
  for (const order of orders) {
    const row = getRow(order.customerState);
    row.orderCount += 1;
    row.grossSales += order.totalAmount || 0;

    const rail = resolvePaymentRailName(order);
    const rec = order.paymentReceivedAmount || 0;
    row.paymentReceived += rec;
    if (rail === 'Delhivery') row.delhivery += rec;
    else if (rail === 'EaseBuzz') row.easebuzz += rec;
    else if (rail === 'PhonePe') row.phonepe += rec;
    else if (rail === 'Velocity') row.velocity += rec;
  }

  // 2. Tally return deductions for all returns effective in this month
  for (const ret of safeReturns) {
    const state = ret.order?.customerState || 'Unspecified';
    const row = getRow(state);
    const retAmt = (ret.refundAmount && ret.refundAmount > 0)
      ? ret.refundAmount
      : (ret.order?.totalAmount || 0);
    row.returnsDeducted += retAmt;
  }

  // 3. Compute netSales and outstanding per state
  const states: StateAccountingRow[] = [];
  for (const row of stateMap.values()) {
    row.grossSales = money(row.grossSales) || 0;
    row.returnsDeducted = money(row.returnsDeducted) || 0;
    row.netSales = money(row.grossSales - row.returnsDeducted) || 0;
    row.paymentReceived = money(row.paymentReceived) || 0;
    row.outstanding = money(row.grossSales - row.returnsDeducted - row.paymentReceived) || 0;
    row.delhivery = money(row.delhivery) || 0;
    row.easebuzz = money(row.easebuzz) || 0;
    row.phonepe = money(row.phonepe) || 0;
    row.velocity = money(row.velocity) || 0;
    states.push(row);
  }

  // Sort states by gross sales descending
  states.sort((a, b) => b.grossSales - a.grossSales);

  const totals: StateAccountingTotals = {
    totalOrders: sum(states.map((s) => s.orderCount)),
    grossSales: sum(states.map((s) => s.grossSales)),
    returnsDeducted: sum(states.map((s) => s.returnsDeducted)),
    netSales: sum(states.map((s) => s.netSales)),
    paymentReceived: sum(states.map((s) => s.paymentReceived)),
    outstanding: sum(states.map((s) => s.outstanding)),
    delhivery: sum(states.map((s) => s.delhivery)),
    easebuzz: sum(states.map((s) => s.easebuzz)),
    phonepe: sum(states.map((s) => s.phonepe)),
    velocity: sum(states.map((s) => s.velocity)),
  };

  return { states, totals };
}

/** Build every row of the report from orders and period returns. */
export function buildReportData(
  monthOrLabel: string,
  orders: any[],
  periodReturnsOrNow?: any[] | Date,
  maybeNow?: Date
): ReportData {
  let periodReturns: any[] = [];
  let now: Date = new Date();

  if (Array.isArray(periodReturnsOrNow)) {
    periodReturns = periodReturnsOrNow;
    if (maybeNow instanceof Date) now = maybeNow;
  } else if (periodReturnsOrNow instanceof Date) {
    now = periodReturnsOrNow;
  }

  let label = monthOrLabel;
  let periodStart = new Date(0);
  let periodEnd = new Date(8640000000000000);

  try {
    const range = monthRange(monthOrLabel);
    label = range.label;
    periodStart = range.start;
    periodEnd = range.end;
  } catch {
    label = monthOrLabel;
  }

  const { states: stateSummary, totals: stateTotals } = buildStateAccountingSummary(
    orders,
    periodReturns,
    periodStart,
    periodEnd
  );

  const rows: ReportOrderRow[] = [];
  const cod: ReportData['cod'] = [];
  const prepaid: ReportData['prepaid'] = [];
  const shipping: ReportData['shipping'] = [];
  const returnRows: ReportData['returns'] = [];

  for (const order of orders) {
    const shipment = order.shipment;
    const returns: any[] = order.returns || [];
    const status = accountsStatus(order, now);
    const isCod = order.paymentMethod === 'COD';
    const paymentRail = resolvePaymentRailName(order);

    const reverse = returns.find((r) => r.returnWaybillNumber && r.returnStatus !== 'CANCELLED');
    const forwardShipping = money(shipment?.forwardCharge);
    const rtoShipping = money(shipment?.rtoCharge);
    const returnShipping = money(returns.reduce((t, r) => t + (r.shippingCharge || 0), 0) || null);
    const legsKnown = [forwardShipping, rtoShipping, returnShipping].filter((v) => v !== null);
    const totalShipping = legsKnown.length ? sum(legsKnown) : null;

    const sources = new Set<string>([
      ...(forwardShipping !== null && shipment?.shippingCostSource ? [shipment.shippingCostSource] : []),
      ...(rtoShipping !== null && shipment?.rtoChargeSource ? [shipment.rtoChargeSource] : []),
      ...returns.filter((r) => r.shippingCharge !== null && r.shippingCharge !== undefined).map((r) => r.shippingCostSource).filter(Boolean),
    ]);
    const shippingBasis = !shipment?.waybillNumber
      ? 'Not shipped'
      : sources.size === 0
        ? 'Not available yet'
        : sources.size > 1
          ? 'Actual + estimate'
          : sources.has('ACTUAL')
            ? 'Actual (Delhivery ledger)'
            : 'Estimate (Delhivery rate API)';

    // Compute return deduction for this order in this period:
    let returnDeductedInPeriod = 0;
    let returnTimingNote = 'No Return';

    for (const ret of returns) {
      if (ret.returnStatus === 'CANCELLED') continue;
      const effectiveDate = ret.refundProcessedAt ? new Date(ret.refundProcessedAt) : new Date(ret.createdAt);
      if (effectiveDate >= periodStart && effectiveDate < periodEnd) {
        const retAmt = (ret.refundAmount && ret.refundAmount > 0) ? ret.refundAmount : (order.totalAmount || 0);
        returnDeductedInPeriod += retAmt;
        returnTimingNote = 'Returned in period';
      } else if (effectiveDate >= periodEnd) {
        returnTimingNote = 'Return processed post-period (deducted in subsequent month per Tally rule)';
      }
    }

    const refundFromReturns = returns
      .filter((r) => r.refundStatus === 'PROCESSED')
      .reduce((t, r) => t + (r.refundAmount || 0), 0);
    const refundAmount =
      refundFromReturns > 0
        ? money(refundFromReturns)
        : (order.financialStatus || '').toLowerCase() === 'refunded'
          ? money(order.totalAmount)
          : null;

    const receivedAmount = money(order.paymentReceivedAmount);
    const orderGross = money(order.totalAmount) || 0;
    const orderOutstanding = money(orderGross - returnDeductedInPeriod - (receivedAmount || 0)) || 0;

    const row: ReportOrderRow = {
      orderNo: order.shopifyOrderName,
      orderDate: istDay(order.shopifyCreatedAt),
      customer: order.customerName,
      city: order.customerCity,
      state: order.customerState,
      pincode: order.customerPincode,
      paymentMode: isCod ? 'COD' : 'Prepaid',
      gateway: isCod
        ? `${paymentRail} COD`
        : (`${order.paymentProvider || ''} ${order.paymentAggregator || ''} ${order.paymentGateway || ''}`.toLowerCase().includes('phonepe')
          ? 'PhonePe'
          : (`${order.paymentProvider || ''} ${order.paymentAggregator || ''} ${order.paymentGateway || ''}`.toLowerCase().includes('gokwik') ||
             `${order.paymentProvider || ''} ${order.paymentAggregator || ''} ${order.paymentGateway || ''}`.toLowerCase().includes('easebuzz'))
            ? 'GoKwik (Easebuzz)'
            : (order.paymentGateway || order.paymentProvider || paymentRail)),
      paymentRail,
      orderValue: orderGross,
      orderStatus: STATUS_LABELS[order.status] || order.status,
      deliveredOn: istDay(order.deliveredAt),
      returnWindowClosesOn: istDay(status.returnWindowClosesAt),
      paymentReceived: order.paymentReceivedAt ? 'Yes' : 'No',
      receivedAmount,
      receivedOn: istDay(order.paymentReceivedAt),
      utr: order.paymentReceivedUtr || '',
      settlementRef: order.paymentReceivedRef || '',
      receivedVia: SOURCE_LABELS[order.paymentReceivedSource] || order.paymentReceivedSource || '',
      gatewayFee: money(order.gatewayFee),
      customerPaymentRef: isCod ? '' : order.paymentReference || order.gatewayTransactionId || '',
      forwardAwb: shipment?.waybillNumber || '',
      forwardShipping,
      rtoShipping,
      returnAwb: reverse?.returnWaybillNumber || '',
      returnShipping,
      totalShipping,
      shippingBasis,
      returnDeductedInPeriod: money(returnDeductedInPeriod) || 0,
      returnTimingNote,
      refundAmount,
      netAfterShipping: receivedAmount !== null ? money(receivedAmount - (totalShipping || 0)) : null,
      outstanding: orderOutstanding,
      accountsStatus: status.state === 'CLOSED' ? 'Closed' : status.state === 'OPEN' ? 'Open' : 'Not a sale',
      pending: status.state === 'OPEN' ? status.pending.join('; ') : status.state === 'NOT_A_SALE' ? notASaleReason(order) : '',
    };
    rows.push(row);

    if (isCod && shipment?.waybillNumber) {
      const remitted = Boolean(shipment.codRemitted);
      cod.push({
        orderNo: row.orderNo,
        rail: paymentRail,
        awb: shipment.waybillNumber,
        deliveredOn: row.deliveredOn,
        orderValue: row.orderValue,
        codAmount: money(shipment.codAmount || order.totalAmount),
        shippingCharge: totalShipping,
        remittedAmount: money(shipment.codRemittedAmount),
        difference: remitted ? money((shipment.codRemittedAmount || 0) - (shipment.codAmount || order.totalAmount || 0)) : null,
        remittanceRef: shipment.codRemittanceRef || '',
        utr: order.paymentReceivedUtr || '',
        remittedOn: istDay(shipment.codRemittedAt || order.paymentReceivedAt),
        status: remitted
          ? 'Remitted (In Bank)'
          : row.accountsStatus === 'Not a sale'
            ? 'Not a sale'
            : shipment.codCollected || order.deliveredAt
              ? 'Collected, awaiting remittance'
              : 'Not delivered yet',
      });
    }
    if (!isCod) {
      prepaid.push({
        orderNo: row.orderNo,
        gateway: paymentRail,
        orderValue: row.orderValue,
        settledAmount: receivedAmount,
        gatewayFee: row.gatewayFee,
        utr: row.utr,
        settledOn: row.receivedOn,
        settlementRef: row.settlementRef,
        customerPaymentRef: row.customerPaymentRef,
        status: order.paymentReceivedAt ? 'Settled' : row.accountsStatus === 'Not a sale' ? 'Not a sale' : 'Awaiting settlement',
      });
    }
    const weight = shipment?.billedWeightGrams || null;
    const zone = shipment?.chargedZone || '';
    if (shipment?.waybillNumber) {
      shipping.push({ orderNo: row.orderNo, leg: 'Forward', awb: shipment.waybillNumber, weight, zone, charge: forwardShipping, basis: shipment.shippingCostSource || '' });
      if (rtoShipping !== null || /^RTO/.test(order.status)) {
        shipping.push({ orderNo: row.orderNo, leg: 'RTO', awb: shipment.waybillNumber, weight, zone, charge: rtoShipping, basis: shipment.rtoChargeSource || '' });
      }
    }
    for (const r of returns) {
      if (r.returnWaybillNumber) {
        shipping.push({ orderNo: row.orderNo, leg: 'Reverse pickup', awb: r.returnWaybillNumber, weight: null, zone: '', charge: money(r.shippingCharge), basis: r.shippingCostSource || '' });
      }
      returnRows.push({
        orderNo: row.orderNo,
        returnAwb: r.returnWaybillNumber || '',
        reason: r.returnReason,
        returnStatus: r.returnStatus,
        qc: r.qcStatus || '',
        refundStatus: r.refundStatus,
        refundAmount: money(r.refundAmount),
        refundedOn: istDay(r.refundProcessedAt),
        returnShipping: money(r.shippingCharge),
      });
    }
  }

  // Returns in period for Tally Credit Note entry
  const returnsInPeriod: ReportReturnRow[] = periodReturns.map((r) => {
    const origOrder = r.order;
    const origDate = origOrder?.shopifyCreatedAt ? new Date(origOrder.shopifyCreatedAt) : null;
    const isPriorMonth = origDate && origDate < periodStart;
    const rail = origOrder ? resolvePaymentRailName(origOrder) : 'Delhivery';

    return {
      returnId: r.id,
      orderNo: origOrder?.shopifyOrderName || `#Order-${r.orderId}`,
      orderDate: istDay(origDate),
      orderMonth: isPriorMonth
        ? `Prior Month (${origDate?.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })})`
        : `Current Month (${label})`,
      timingCategory: isPriorMonth
        ? 'Cross-Month Return (Deducted from current month sales per Tally rule)'
        : 'Current Period Return',
      customer: origOrder?.customerName || 'Customer',
      state: origOrder?.customerState || 'Unspecified',
      returnDate: istDay(r.createdAt),
      refundDate: istDay(r.refundProcessedAt),
      returnStatus: r.returnStatus,
      refundStatus: r.refundStatus,
      refundAmount: money(r.refundAmount || origOrder?.totalAmount) || 0,
      paymentRail: rail,
      tallyVoucherType: 'Credit Note / Sales Return',
      reason: r.returnReason,
    };
  });

  const sales = rows.filter((r) => r.accountsStatus !== 'Not a sale');
  const summary: ReportData['summary'] = [
    { label: 'Orders placed', value: rows.length },
    { label: 'Not a sale (cancelled / RTO / refunded)', value: rows.length - sales.length },
    { label: 'Closed (delivered, paid, return window over)', value: rows.filter((r) => r.accountsStatus === 'Closed').length },
    { label: 'Open', value: rows.filter((r) => r.accountsStatus === 'Open').length },
    { label: '   …waiting for delivery', value: rows.filter((r) => r.accountsStatus === 'Open' && /Not delivered/.test(r.pending)).length },
    { label: '   …waiting for payment in bank', value: rows.filter((r) => r.accountsStatus === 'Open' && /Payment not received|UTR is missing/.test(r.pending)).length },
    { label: '   …return window still open', value: rows.filter((r) => r.accountsStatus === 'Open' && /Return window open/.test(r.pending)).length },
    { label: '   …return in progress', value: rows.filter((r) => r.accountsStatus === 'Open' && /Return in progress/.test(r.pending)).length },
    { label: '   …exchange in progress', value: rows.filter((r) => r.accountsStatus === 'Open' && /Exchange in progress/.test(r.pending)).length },
    { label: 'Order value, all orders (₹)', value: sum(rows.map((r) => r.orderValue)) },
    { label: 'Order value, sales (₹)', value: sum(sales.map((r) => r.orderValue)) },
    { label: '   …prepaid (₹)', value: sum(sales.filter((r) => r.paymentMode === 'Prepaid').map((r) => r.orderValue)) },
    { label: '   …COD (₹)', value: sum(sales.filter((r) => r.paymentMode === 'COD').map((r) => r.orderValue)) },
    { label: 'Received in bank (₹)', value: sum(rows.map((r) => r.receivedAmount)), note: 'Prepaid settlements net of gateway fees + Velocity & Delhivery COD remittances' },
    { label: '   …prepaid settlements (₹)', value: sum(rows.filter((r) => r.paymentMode === 'Prepaid').map((r) => r.receivedAmount)) },
    { label: '   …COD remittances (₹)', value: sum(rows.filter((r) => r.paymentMode === 'COD').map((r) => r.receivedAmount)) },
    { label: 'Gateway fees (₹)', value: sum(rows.map((r) => r.gatewayFee)) },
    { label: 'Not yet received in bank, sales (₹)', value: sum(sales.filter((r) => r.paymentReceived === 'No').map((r) => r.orderValue)) },
    { label: 'Shipping cost total (₹)', value: sum(rows.map((r) => r.totalShipping)) },
    { label: '   …forward (₹)', value: sum(rows.map((r) => r.forwardShipping)) },
    { label: '   …RTO (₹)', value: sum(rows.map((r) => r.rtoShipping)) },
    { label: '   …reverse pickups (₹)', value: sum(rows.map((r) => r.returnShipping)) },
    { label: 'Orders with actual (billed) shipping cost', value: rows.filter((r) => r.shippingBasis.startsWith('Actual')).length },
    { label: 'Orders with estimated shipping cost only', value: rows.filter((r) => r.shippingBasis.startsWith('Estimate')).length },
    { label: 'Refunds (₹)', value: sum(rows.map((r) => r.refundAmount)) },
  ];

  return {
    month: monthOrLabel,
    label,
    generatedAt: now,
    stateSummary,
    stateTotals,
    orders: rows,
    returnsInPeriod,
    cod,
    prepaid,
    shipping,
    returns: returnRows,
    summary,
  };
}

function notASaleReason(order: { status?: string }): string {
  if (order.status === 'CANCELLED') return 'Cancelled';
  if (order.status === 'REFUNDED') return 'Refunded';
  return 'Returned to origin (RTO)';
}

// ─── Excel Rendering ────────────────────────────────────────

type Column = { header: string; key: string; width: number; type?: 'money' | 'date' | 'int' };

const HEADER_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
const TOTAL_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
const MONEY_FORMAT = '#,##0.00';
const DATE_FORMAT = 'dd-mmm-yyyy';

function addTable(
  workbook: ExcelJS.Workbook,
  name: string,
  columns: Column[],
  rows: Array<Record<string, any>>,
  totals: string[] = []
): ExcelJS.Worksheet {
  const sheet = workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  rows.forEach((row) => sheet.addRow(row));

  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = HEADER_FILL;
  header.alignment = { vertical: 'middle', wrapText: true };
  header.height = 30;

  columns.forEach((column, index) => {
    const col = sheet.getColumn(index + 1);
    if (column.type === 'money') col.numFmt = MONEY_FORMAT;
    if (column.type === 'date') col.numFmt = DATE_FORMAT;
  });
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };

  if (totals.length && rows.length) {
    const last = rows.length + 1;
    const totalRow = sheet.addRow({});
    totalRow.getCell(1).value = 'Total (filtered rows)';
    for (const key of totals) {
      const index = columns.findIndex((c) => c.key === key) + 1;
      if (index <= 0) continue;
      const letter = sheet.getColumn(index).letter;
      totalRow.getCell(index).value = { formula: `SUBTOTAL(109,${letter}2:${letter}${last})` } as any;
      totalRow.getCell(index).numFmt = MONEY_FORMAT;
    }
    totalRow.font = { bold: true };
    totalRow.fill = TOTAL_FILL;
    totalRow.border = { top: { style: 'thin' }, bottom: { style: 'double' } };
  }
  return sheet;
}

export async function renderWorkbook(data: ReportData): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Youthnic OMS - Accounts & Tally Integration';
  workbook.created = data.generatedAt;

  // ═════════════════════════════════════════════════════════════════════════════
  // Sheet 1: State Summary (Tally Ledger Matrix)
  // ═════════════════════════════════════════════════════════════════════════════
  const stateSheet = workbook.addWorksheet('State Summary (Tally Ledger)', {
    views: [{ showGridLines: true, state: 'frozen', ySplit: 5 }],
  });

  stateSheet.columns = [
    { width: 22 }, // A: State
    { width: 14 }, // B: Orders
    { width: 18 }, // C: Gross Sales (₹)
    { width: 18 }, // D: Returns Deducted (₹)
    { width: 18 }, // E: Net Sales (₹)
    { width: 18 }, // F: Payment Received (₹)
    { width: 18 }, // G: Net Outstanding (₹)
    { width: 16 }, // H: Delhivery COD (₹)
    { width: 16 }, // I: EaseBuzz (₹)
    { width: 16 }, // J: PhonePe (₹)
    { width: 16 }, // K: Velocity (₹)
    { width: 36 }, // L: Tally Ledger Note
  ];

  // Header Banner
  const r1 = stateSheet.addRow(['Youthnic · State-Wise Monthly Sales, Returns & Settlement Matrix (Tally ERP)']);
  r1.font = { bold: true, size: 14, color: { argb: 'FF0F172A' } };

  const r2 = stateSheet.addRow([
    `Reporting Month: ${data.label} (IST) · Generated: ${data.generatedAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`
  ]);
  r2.font = { italic: true, size: 11, color: { argb: 'FF475569' } };

  const r3 = stateSheet.addRow([
    'Tally Accounting Formula: State Monthly Sales - Returns Deducted - Payment Received = Net Outstanding'
  ]);
  r3.font = { bold: true, size: 11, color: { argb: 'FF1E293B' } };

  stateSheet.addRow([]); // Blank row 4

  // Table Columns (Row 5)
  const headerRow = stateSheet.addRow([
    'State',
    'Orders Count',
    'Gross Sales (₹)',
    'Returns Deducted (₹)',
    'Net Sales (₹)',
    'Payment Received (₹)',
    'Net Outstanding (₹)',
    'Delhivery COD (₹)',
    'EaseBuzz (GoKwik) (₹)',
    'PhonePe (₹)',
    'Velocity (₹)',
    'Tally Posting Guidance',
  ]);
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.fill = HEADER_FILL;
  headerRow.height = 30;
  headerRow.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };

  const startRow = 6;
  data.stateSummary.forEach((row) => {
    const r = stateSheet.addRow([
      row.state,
      row.orderCount,
      row.grossSales,
      row.returnsDeducted,
      row.netSales,
      row.paymentReceived,
      row.outstanding,
      row.delhivery,
      row.easebuzz,
      row.phonepe,
      row.velocity,
      row.outstanding <= 0.05
        ? 'Reconciled / Settled in Full'
        : `Outstanding balance of ₹${row.outstanding.toFixed(2)} pending in bank`,
    ]);

    // Format currency columns
    [3, 4, 5, 6, 7, 8, 9, 10, 11].forEach((colIdx) => {
      r.getCell(colIdx).numFmt = MONEY_FORMAT;
    });
    r.getCell(2).numFmt = '#,##0';
    r.getCell(1).font = { bold: true };
  });

  const hasRows = data.stateSummary.length > 0;
  const endRow = startRow + data.stateSummary.length - 1;
  const totRow = stateSheet.addRow([
    'TOTAL (NATIONAL LEDGER)',
    hasRows ? { formula: `SUM(B${startRow}:B${endRow})` } : 0,
    hasRows ? { formula: `SUM(C${startRow}:C${endRow})` } : 0,
    hasRows ? { formula: `SUM(D${startRow}:D${endRow})` } : 0,
    hasRows ? { formula: `SUM(E${startRow}:E${endRow})` } : 0,
    hasRows ? { formula: `SUM(F${startRow}:F${endRow})` } : 0,
    hasRows ? { formula: `SUM(G${startRow}:G${endRow})` } : 0,
    hasRows ? { formula: `SUM(H${startRow}:H${endRow})` } : 0,
    hasRows ? { formula: `SUM(I${startRow}:I${endRow})` } : 0,
    hasRows ? { formula: `SUM(J${startRow}:J${endRow})` } : 0,
    hasRows ? { formula: `SUM(K${startRow}:K${endRow})` } : 0,
    'Net National Balance for Tally Verification',
  ]);
  totRow.font = { bold: true, size: 11 };
  totRow.fill = TOTAL_FILL;
  totRow.border = { top: { style: 'thin' }, bottom: { style: 'double' } };
  [3, 4, 5, 6, 7, 8, 9, 10, 11].forEach((colIdx) => {
    totRow.getCell(colIdx).numFmt = MONEY_FORMAT;
  });
  totRow.getCell(2).numFmt = '#,##0';

  // ═════════════════════════════════════════════════════════════════════════════
  // Sheet 2: Orders (Order Sales Ledger)
  // ═════════════════════════════════════════════════════════════════════════════
  const ordersColumns: Column[] = [
    { header: 'Order No', key: 'orderNo', width: 14 },
    { header: 'Order Date', key: 'orderDate', width: 13, type: 'date' },
    { header: 'Customer', key: 'customer', width: 22 },
    { header: 'City', key: 'city', width: 14 },
    { header: 'State', key: 'state', width: 14 },
    { header: 'Pincode', key: 'pincode', width: 9 },
    { header: 'Payment Mode', key: 'paymentMode', width: 10 },
    { header: 'Gateway', key: 'gateway', width: 16 },
    { header: 'Order Value (₹)', key: 'orderValue', width: 13, type: 'money' },
    { header: 'Order Status', key: 'orderStatus', width: 18 },
    { header: 'Delivered On', key: 'deliveredOn', width: 13, type: 'date' },
    { header: 'Return Window Closes', key: 'returnWindowClosesOn', width: 13, type: 'date' },
    { header: 'Payment Received', key: 'paymentReceived', width: 10 },
    { header: 'Received Amount (₹)', key: 'receivedAmount', width: 13, type: 'money' },
    { header: 'Received On', key: 'receivedOn', width: 13, type: 'date' },
    { header: 'Bank UTR', key: 'utr', width: 22 },
    { header: 'Settlement / Remittance Ref', key: 'settlementRef', width: 22 },
    { header: 'Payment Rail', key: 'paymentRail', width: 14 },
    { header: 'Return Deducted in Period (₹)', key: 'returnDeductedInPeriod', width: 18, type: 'money' },
    { header: 'Return Timing Note', key: 'returnTimingNote', width: 34 },
    { header: 'Net Outstanding (₹)', key: 'outstanding', width: 16, type: 'money' },
    { header: 'Received Via', key: 'receivedVia', width: 22 },
    { header: 'Gateway Fee (₹)', key: 'gatewayFee', width: 11, type: 'money' },
    { header: 'Customer Payment Ref', key: 'customerPaymentRef', width: 22 },
    { header: 'Forward AWB', key: 'forwardAwb', width: 16 },
    { header: 'Forward Shipping (₹)', key: 'forwardShipping', width: 12, type: 'money' },
    { header: 'RTO Shipping (₹)', key: 'rtoShipping', width: 11, type: 'money' },
    { header: 'Return AWB', key: 'returnAwb', width: 16 },
    { header: 'Return Shipping (₹)', key: 'returnShipping', width: 11, type: 'money' },
    { header: 'Total Shipping (₹)', key: 'totalShipping', width: 12, type: 'money' },
    { header: 'Shipping Cost Basis', key: 'shippingBasis', width: 24 },
    { header: 'Refund (₹)', key: 'refundAmount', width: 11, type: 'money' },
    { header: 'Received − Shipping (₹)', key: 'netAfterShipping', width: 14, type: 'money' },
    { header: 'Accounts Status', key: 'accountsStatus', width: 11 },
    { header: 'Open Because', key: 'pending', width: 48 },
  ];

  const ordersSheet = addTable(
    workbook,
    'Orders',
    ordersColumns,
    data.orders as any[],
    ['orderValue', 'receivedAmount', 'gatewayFee', 'forwardShipping', 'rtoShipping', 'returnShipping', 'totalShipping', 'refundAmount', 'netAfterShipping', 'outstanding']
  );

  const statusCol = ordersSheet.getColumn('accountsStatus').number;
  ordersSheet.eachRow((row, index) => {
    if (index === 1 || index > data.orders.length + 1) return;
    const cell = row.getCell(statusCol);
    const fill = cell.value === 'Closed' ? 'FFD1FAE5' : cell.value === 'Open' ? 'FFFEF3C7' : 'FFE5E7EB';
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // Sheet 3: Monthly Returns & Credit Notes
  // ═════════════════════════════════════════════════════════════════════════════
  const returnTableColumns: Column[] = [
    { header: 'Return ID', key: 'returnId', width: 12 },
    { header: 'Order No', key: 'orderNo', width: 14 },
    { header: 'Order Date (IST)', key: 'orderDate', width: 14, type: 'date' },
    { header: 'Sale Period', key: 'orderMonth', width: 18 },
    { header: 'Cutoff Timing Category', key: 'timingCategory', width: 36 },
    { header: 'Customer', key: 'customer', width: 22 },
    { header: 'State', key: 'state', width: 16 },
    { header: 'Return Date (IST)', key: 'returnDate', width: 14, type: 'date' },
    { header: 'Refund Date (IST)', key: 'refundDate', width: 14, type: 'date' },
    { header: 'Return Status', key: 'returnStatus', width: 16 },
    { header: 'Refund Status', key: 'refundStatus', width: 14 },
    { header: 'Credit Note Amount (₹)', key: 'refundAmount', width: 18, type: 'money' },
    { header: 'Payment Rail', key: 'paymentRail', width: 14 },
    { header: 'Tally Voucher Type', key: 'tallyVoucherType', width: 22 },
    { header: 'Return Reason', key: 'reason', width: 28 },
  ];

  addTable(
    workbook,
    'Monthly Returns (Credit Notes)',
    returnTableColumns,
    data.returnsInPeriod as any[],
    ['refundAmount']
  );

  // ═════════════════════════════════════════════════════════════════════════════
  // Sheet 4: COD Remittance
  // ═════════════════════════════════════════════════════════════════════════════
  addTable(
    workbook,
    'COD Remittance',
    [
      { header: 'Order ID', key: 'orderNo', width: 14 },
      { header: 'Courier Rail', key: 'rail', width: 14 },
      { header: 'AWB / Tracking ID', key: 'awb', width: 18 },
      { header: 'Delivered Date', key: 'deliveredOn', width: 13, type: 'date' },
      { header: 'Order Value (₹)', key: 'orderValue', width: 14, type: 'money' },
      { header: 'COD Amount Collected (₹)', key: 'codAmount', width: 16, type: 'money' },
      { header: 'Shipping Charged (₹)', key: 'shippingCharge', width: 18, type: 'money' },
      { header: 'Net Remitted Amount (₹)', key: 'remittedAmount', width: 16, type: 'money' },
      { header: 'Difference / Deductions (₹)', key: 'difference', width: 15, type: 'money' },
      { header: 'Remittance Number', key: 'remittanceRef', width: 22 },
      { header: 'Remittance Processed Date', key: 'remittedOn', width: 15, type: 'date' },
      { header: 'Bank Transaction ID / UTR', key: 'utr', width: 24 },
      { header: 'Remittance Status', key: 'status', width: 26 },
    ],
    data.cod,
    ['orderValue', 'codAmount', 'shippingCharge', 'remittedAmount', 'difference']
  );

  // ═════════════════════════════════════════════════════════════════════════════
  // Sheet 5: Prepaid Settlements
  // ═════════════════════════════════════════════════════════════════════════════
  addTable(
    workbook,
    'Prepaid Settlements',
    [
      { header: 'Order No', key: 'orderNo', width: 14 },
      { header: 'Gateway Rail', key: 'gateway', width: 16 },
      { header: 'Order Value (₹)', key: 'orderValue', width: 13, type: 'money' },
      { header: 'Settled Amount (₹)', key: 'settledAmount', width: 13, type: 'money' },
      { header: 'Gateway Fee (₹)', key: 'gatewayFee', width: 12, type: 'money' },
      { header: 'Settlement UTR', key: 'utr', width: 22 },
      { header: 'Settled On', key: 'settledOn', width: 13, type: 'date' },
      { header: 'Settlement Ref', key: 'settlementRef', width: 22 },
      { header: 'Customer Payment Ref', key: 'customerPaymentRef', width: 22 },
      { header: 'Status', key: 'status', width: 20 },
    ],
    data.prepaid,
    ['orderValue', 'settledAmount', 'gatewayFee']
  );

  // ═════════════════════════════════════════════════════════════════════════════
  // Sheet 6: Shipping Costs
  // ═════════════════════════════════════════════════════════════════════════════
  addTable(
    workbook,
    'Shipping Costs',
    [
      { header: 'Order No', key: 'orderNo', width: 14 },
      { header: 'Leg', key: 'leg', width: 15 },
      { header: 'AWB', key: 'awb', width: 16 },
      { header: 'Charged Weight (g)', key: 'weight', width: 13 },
      { header: 'Zone', key: 'zone', width: 8 },
      { header: 'Charge incl. GST (₹)', key: 'charge', width: 14, type: 'money' },
      { header: 'Basis', key: 'basis', width: 12 },
    ],
    data.shipping,
    ['charge']
  );

  // ═════════════════════════════════════════════════════════════════════════════
  // Sheet 7: Summary
  // ═════════════════════════════════════════════════════════════════════════════
  const summary = workbook.addWorksheet('Summary');
  summary.columns = [{ width: 52 }, { width: 20 }, { width: 70 }];
  summary.addRow([`Youthnic · Accounts closing report · ${data.label}`]).font = { bold: true, size: 14 };
  summary.addRow([`Orders placed ${data.label} (IST). Generated ${data.generatedAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}.`]);
  summary.addRow([
    'Closed = delivered + payment in Youthnic\'s bank (UTR) + 7-day return window over + no open return.',
  ]);
  summary.addRow([]);
  const head = summary.addRow(['Measure', 'Value', 'Note']);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = HEADER_FILL;
  for (const item of data.summary) {
    const row = summary.addRow([item.label, item.value, item.note || '']);
    if (/₹/.test(item.label)) row.getCell(2).numFmt = MONEY_FORMAT;
    if (!item.label.startsWith('   ')) row.getCell(1).font = { bold: true };
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** Load the month's orders and period returns and build the report. */
export async function generateMonthlyReport(
  month: string,
  now: Date = new Date()
): Promise<{ data: ReportData; buffer: Buffer; fileName: string }> {
  const { start, end } = monthRange(month);

  const [orders, periodReturns] = await Promise.all([
    prisma.order.findMany({
      where: { shopifyCreatedAt: { gte: start, lt: end } },
      include: { shipment: true, returns: true },
      orderBy: { shopifyCreatedAt: 'asc' },
    }),
    prisma.return.findMany({
      where: {
        OR: [
          { refundProcessedAt: { gte: start, lt: end } },
          { refundProcessedAt: null, createdAt: { gte: start, lt: end }, returnStatus: { not: 'CANCELLED' } },
        ],
      },
      include: {
        order: {
          include: { shipment: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    }),
  ]);

  const data = buildReportData(month, orders, periodReturns, now);
  const buffer = await renderWorkbook(data);
  return { data, buffer, fileName: `Youthnic-Accounts-${month}.xlsx` };
}

/** Load orders by custom date range and build the report. */
export async function generateDateRangeReport(
  startDateStr: string,
  endDateStr: string,
  now: Date = new Date()
): Promise<{ data: ReportData; buffer: Buffer; fileName: string }> {
  const { start, end } = istDateRange(startDateStr, endDateStr);
  const label = `${startDateStr} to ${endDateStr}`;

  const [orders, periodReturns] = await Promise.all([
    prisma.order.findMany({
      where: { shopifyCreatedAt: { gte: start, lt: end } },
      include: { shipment: true, returns: true },
      orderBy: { shopifyCreatedAt: 'asc' },
    }),
    prisma.return.findMany({
      where: {
        OR: [
          { refundProcessedAt: { gte: start, lt: end } },
          { refundProcessedAt: null, createdAt: { gte: start, lt: end }, returnStatus: { not: 'CANCELLED' } },
        ],
      },
      include: {
        order: {
          include: { shipment: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    }),
  ]);

  const data = buildReportData(label, orders, periodReturns, now);
  data.label = label;
  const buffer = await renderWorkbook(data);
  return { data, buffer, fileName: `Youthnic-Accounts-${startDateStr}_to_${endDateStr}.xlsx` };
}

/** Return State-Wise Monthly summary JSON for API and UI */
export async function getStateMonthlyAccounting(
  monthOrCurrent?: string,
  now: Date = new Date()
): Promise<{
  month: string;
  label: string;
  formula: string;
  timingRule: string;
  totals: StateAccountingTotals;
  states: StateAccountingRow[];
  crossMonthReturnsCount: number;
  recipients: { to: string[]; cc: string[] };
  reportDay: number;
  reportSentAt: { sentAt: string; to: string[] } | null;
}> {
  const month = typeof monthOrCurrent === 'string' && monthOrCurrent ? monthOrCurrent : previousMonth(now);
  const { start, end, label } = monthRange(month);

  const [orders, periodReturns, toRecipients, ccRecipients, sentStatus] = await Promise.all([
    prisma.order.findMany({
      where: { shopifyCreatedAt: { gte: start, lt: end } },
      include: { shipment: true, returns: true },
      orderBy: { shopifyCreatedAt: 'asc' },
    }),
    prisma.return.findMany({
      where: {
        OR: [
          { refundProcessedAt: { gte: start, lt: end } },
          { refundProcessedAt: null, createdAt: { gte: start, lt: end }, returnStatus: { not: 'CANCELLED' } },
        ],
      },
      include: {
        order: {
          include: { shipment: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    }),
    getReportRecipients(),
    getReportCcRecipients(),
    reportSentAt(month),
  ]);

  const { states, totals } = buildStateAccountingSummary(orders, periodReturns, start, end);
  const crossMonthReturnsCount = periodReturns.filter(
    (r) => r.order?.shopifyCreatedAt && new Date(r.order.shopifyCreatedAt) < start
  ).length;

  return {
    month,
    label,
    formula: 'State Monthly Sales - Returns Deducted - Payment Received = Net Outstanding',
    timingRule:
      'Returns occurring in this month are deducted from this month; returns occurring after the 31st are deducted in the subsequent month for Tally ERP alignment.',
    totals,
    states,
    crossMonthReturnsCount,
    recipients: { to: toRecipients, cc: ccRecipients },
    reportDay: config.accounts.reportDayOfMonth,
    reportSentAt: sentStatus,
  };
}

// ─── Emailing ───────────────────────────────────────────────

const RECIPIENTS_KEY = 'accounts_report_recipients';
const CC_RECIPIENTS_KEY = 'accounts_report_cc_recipients';
const sentKey = (month: string) => `accounts_report_sent:${month}`;

export function parseRecipients(value?: string | null): string[] {
  return Array.from(
    new Set(
      (value || '')
        .split(/[,;\s]+/)
        .map((email) => email.trim().toLowerCase())
        .filter((email) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    )
  );
}

export async function getReportRecipients(): Promise<string[]> {
  const stored = await prisma.setting.findUnique({ where: { key: RECIPIENTS_KEY } });
  const list = parseRecipients(stored?.value ?? config.accounts.reportRecipients);
  return list.length ? list : ['accounts2@vbexports.co.in'];
}

export async function getReportCcRecipients(): Promise<string[]> {
  const stored = await prisma.setting.findUnique({ where: { key: CC_RECIPIENTS_KEY } });
  const list = parseRecipients(stored?.value ?? config.accounts.reportCcRecipients);
  return list.length ? list : ['returnorders@vbexports.co.in', 'vaibhav@vbexports.co.in', 'accounts@vbexports.co.in'];
}

export async function setReportRecipients(value: string, ccValue?: string): Promise<{ to: string[]; cc: string[] }> {
  const recipients = parseRecipients(value);
  await prisma.setting.upsert({
    where: { key: RECIPIENTS_KEY },
    create: { key: RECIPIENTS_KEY, value: recipients.join(', ') },
    update: { value: recipients.join(', ') },
  });

  let ccRecipients: string[] = [];
  if (ccValue !== undefined) {
    ccRecipients = parseRecipients(ccValue);
    await prisma.setting.upsert({
      where: { key: CC_RECIPIENTS_KEY },
      create: { key: CC_RECIPIENTS_KEY, value: ccRecipients.join(', ') },
      update: { value: ccRecipients.join(', ') },
    });
  } else {
    ccRecipients = await getReportCcRecipients();
  }

  return { to: recipients, cc: ccRecipients };
}

const CLAIM_PREFIX = 'SENDING:';
const STALE_CLAIM_MS = 30 * 60 * 1000;

/** When and to whom the month's report was emailed, or null if it has not been. */
export async function reportSentAt(month: string): Promise<{ sentAt: string; to: string[] } | null> {
  const row = await prisma.setting.findUnique({ where: { key: sentKey(month) } });
  if (!row?.value || row.value.startsWith(CLAIM_PREFIX)) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

/**
 * Claim the month's automatic send so only one sender emails it.
 */
async function claimMonthlySend(month: string, now: Date): Promise<boolean> {
  const key = sentKey(month);
  const claim = `${CLAIM_PREFIX}${now.toISOString()}`;
  try {
    await prisma.setting.create({ data: { key, value: claim } });
    return true;
  } catch {
    const row = await prisma.setting.findUnique({ where: { key } });
    if (!row?.value.startsWith(CLAIM_PREFIX)) return false;
    const claimedAt = Date.parse(row.value.slice(CLAIM_PREFIX.length));
    if (Number.isFinite(claimedAt) && now.getTime() - claimedAt < STALE_CLAIM_MS) return false;
    const taken = await prisma.setting.updateMany({ where: { key, value: row.value }, data: { value: claim } });
    return taken.count === 1;
  }
}

function escapeHtml(str: string): string {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Email the month's report to the accounts team and remember that it was sent. */
export async function emailMonthlyReport(
  month: string,
  recipients?: string[],
  ccRecipients?: string[]
): Promise<{ sentTo: string[]; ccTo: string[]; fileName: string }> {
  const to = recipients?.length ? recipients : await getReportRecipients();
  const cc = ccRecipients !== undefined ? ccRecipients : await getReportCcRecipients();

  if (!to.length) {
    throw new Error('No report recipients set. Add the accounts team emails on the Payments & Accounts page.');
  }

  const { data, buffer, fileName } = await generateMonthlyReport(month);
  const inr = (value: number | string) =>
    typeof value === 'number'
      ? `₹${value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : value;

  // Render top 12 state rows in HTML email
  const topStatesHtml = data.stateSummary
    .slice(0, 12)
    .map(
      (s) => `
      <tr style="border-bottom: 1px solid #e2e8f0; font-size: 13px;">
        <td style="padding: 8px 10px; font-weight: bold; color: #1e293b;">${escapeHtml(s.state)}</td>
        <td style="padding: 8px 10px; text-align: center;">${s.orderCount}</td>
        <td style="padding: 8px 10px; text-align: right; font-weight: 500;">${inr(s.grossSales)}</td>
        <td style="padding: 8px 10px; text-align: right; color: #dc2626;">-${inr(s.returnsDeducted)}</td>
        <td style="padding: 8px 10px; text-align: right; font-weight: bold;">${inr(s.netSales)}</td>
        <td style="padding: 8px 10px; text-align: right; color: #16a34a;">${inr(s.paymentReceived)}</td>
        <td style="padding: 8px 10px; text-align: right; font-weight: bold; color: ${s.outstanding > 0 ? '#b91c1c' : '#15803d'};">
          ${inr(s.outstanding)}
        </td>
      </tr>`
    )
    .join('');

  await resendService.sendInternalEmail({
    to,
    cc,
    subject: `Youthnic Accounts Closing & Tally Report · State-wise Sales, Returns & Settlement · ${data.label}`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 14px; color: #0f172a; max-width: 720px; margin: 0 auto; line-height: 1.5;">
        <div style="background: #0f172a; padding: 20px 24px; border-radius: 8px 8px 0 0; color: #ffffff;">
          <h2 style="margin: 0; font-size: 20px; font-weight: 700;">Youthnic · Accounts Closing Report (Tally ERP)</h2>
          <p style="margin: 6px 0 0; font-size: 14px; color: #94a3b8;">
            Reporting Period: <strong>${data.label}</strong> (IST) · Automated Monthly Closing
          </p>
        </div>

        <div style="border: 1px solid #e2e8f0; border-top: none; padding: 24px; border-radius: 0 0 8px 8px; background: #ffffff;">
          <p style="margin: 0 0 16px;">Hello Accounts Team,</p>
          <p style="margin: 0 0 16px;">
            Attached is the official monthly accounting ledger workbook for <strong>${data.label}</strong>.
            The data is structured for direct Tally ERP entry, GST state-wise verification, and bank reconciliation.
          </p>

          <div style="background: #f8fafc; border-left: 4px solid #3b82f6; padding: 12px 16px; margin-bottom: 20px; border-radius: 0 6px 6px 0;">
            <p style="margin: 0; font-weight: 600; color: #1e3a8a;">Accounting Formula Applied:</p>
            <p style="margin: 4px 0 0; font-family: monospace; font-size: 13px; color: #1e293b;">
              State Monthly Sales - Returns Deducted - Payment Received = Net Outstanding
            </p>
            <p style="margin: 6px 0 0; font-size: 12px; color: #64748b;">
              <strong>Tally Cutoff Rule:</strong> Returns processed in ${data.label} are deducted in this period.
              Orders placed in ${data.label} returned after the month-end cutoff are deducted in the subsequent month.
            </p>
          </div>

          <table cellpadding="8" style="width: 100%; border-collapse: collapse; margin-bottom: 20px; border: 1px solid #cbd5e1;">
            <tr style="background: #f1f5f9;">
              <th colspan="2" style="text-align: left; font-size: 13px; text-transform: uppercase; color: #475569; letter-spacing: 0.5px;">National Closing KPI Summary</th>
            </tr>
            <tr style="border-bottom: 1px solid #e2e8f0;">
              <td>Total Orders Placed in Period</td>
              <td style="text-align: right; font-weight: bold;">${data.stateTotals.totalOrders}</td>
            </tr>
            <tr style="border-bottom: 1px solid #e2e8f0;">
              <td>Gross Sales in Period</td>
              <td style="text-align: right; font-weight: bold;">${inr(data.stateTotals.grossSales)}</td>
            </tr>
            <tr style="border-bottom: 1px solid #e2e8f0;">
              <td>Return Deductions in Period</td>
              <td style="text-align: right; font-weight: bold; color: #dc2626;">-${inr(data.stateTotals.returnsDeducted)}</td>
            </tr>
            <tr style="border-bottom: 1px solid #e2e8f0;">
              <td>Net Period Sales (Sales - Returns)</td>
              <td style="text-align: right; font-weight: bold; color: #0f172a;">${inr(data.stateTotals.netSales)}</td>
            </tr>
            <tr style="border-bottom: 1px solid #e2e8f0;">
              <td>Payments Received in Bank</td>
              <td style="text-align: right; font-weight: bold; color: #16a34a;">${inr(data.stateTotals.paymentReceived)}</td>
            </tr>
            <tr style="font-size: 12px; color: #64748b; background: #fafafa; border-bottom: 1px solid #e2e8f0;">
              <td style="padding-left: 24px;">• Delhivery COD Remittances</td>
              <td style="text-align: right;">${inr(data.stateTotals.delhivery)}</td>
            </tr>
            <tr style="font-size: 12px; color: #64748b; background: #fafafa; border-bottom: 1px solid #e2e8f0;">
              <td style="padding-left: 24px;">• EaseBuzz (GoKwik) Settlements</td>
              <td style="text-align: right;">${inr(data.stateTotals.easebuzz)}</td>
            </tr>
            <tr style="font-size: 12px; color: #64748b; background: #fafafa; border-bottom: 1px solid #e2e8f0;">
              <td style="padding-left: 24px;">• PhonePe Settlements</td>
              <td style="text-align: right;">${inr(data.stateTotals.phonepe)}</td>
            </tr>
            <tr style="font-size: 12px; color: #64748b; background: #fafafa; border-bottom: 1px solid #e2e8f0;">
              <td style="padding-left: 24px;">• Velocity Remittances</td>
              <td style="text-align: right;">${inr(data.stateTotals.velocity)}</td>
            </tr>
            <tr style="background: #fef2f2; font-weight: bold; font-size: 15px;">
              <td style="color: #991b1b;">Net Outstanding Balance</td>
              <td style="text-align: right; color: #991b1b;">${inr(data.stateTotals.outstanding)}</td>
            </tr>
          </table>

          <h3 style="font-size: 15px; margin: 24px 0 10px; color: #1e293b;">State-Wise Monthly Breakdown (Top States)</h3>
          <div style="overflow-x: auto; margin-bottom: 24px;">
            <table cellpadding="6" style="width: 100%; border-collapse: collapse; border: 1px solid #cbd5e1;">
              <thead>
                <tr style="background: #1e293b; color: #ffffff; font-size: 12px;">
                  <th style="padding: 8px 10px; text-align: left;">State</th>
                  <th style="padding: 8px 10px; text-align: center;">Orders</th>
                  <th style="padding: 8px 10px; text-align: right;">Gross Sales</th>
                  <th style="padding: 8px 10px; text-align: right;">Returns</th>
                  <th style="padding: 8px 10px; text-align: right;">Net Sales</th>
                  <th style="padding: 8px 10px; text-align: right;">Received</th>
                  <th style="padding: 8px 10px; text-align: right;">Outstanding</th>
                </tr>
              </thead>
              <tbody>
                ${topStatesHtml}
              </tbody>
            </table>
          </div>

          <p style="font-size: 13px; color: #475569; margin: 0 0 8px;">
            The attached workbook <strong>${fileName}</strong> includes 7 comprehensive sheets:
          </p>
          <ul style="font-size: 13px; color: #475569; margin: 0 0 20px; padding-left: 20px;">
            <li><strong>State Summary (Tally Ledger):</strong> State-wise monthly matrix with formulas.</li>
            <li><strong>Orders:</strong> Every order with payment rail, UTR, and net balance.</li>
            <li><strong>Monthly Returns (Credit Notes):</strong> All returns in period for Tally credit note vouchers.</li>
            <li><strong>COD Remittance:</strong> Delhivery & Velocity COD bank transfers and AWB breakdown.</li>
            <li><strong>Prepaid Settlements:</strong> EaseBuzz & PhonePe gateway settlements.</li>
            <li><strong>Shipping Costs:</strong> Forward, RTO, and reverse pickup freight audit.</li>
            <li><strong>Summary:</strong> Complete business P&L metrics.</li>
          </ul>

          <div style="border-top: 1px solid #e2e8f0; padding-top: 14px; font-size: 12px; color: #94a3b8;">
            Youthnic Order Management System · Automated Accounts Dispatch
          </div>
        </div>
      </div>`,
    attachments: [{ filename: fileName, content: buffer }],
  });

  const stamp = JSON.stringify({ sentAt: new Date().toISOString(), to, cc });
  await prisma.setting.upsert({
    where: { key: sentKey(month) },
    create: { key: sentKey(month), value: stamp },
    update: { value: stamp },
  });
  logger.info('Monthly accounts report emailed with CCs', { month, to, cc });
  return { sentTo: to, ccTo: cc, fileName };
}

/** The report hour on the report day (IST); the email never goes out earlier. */
const REPORT_HOUR_IST = 9;

/**
 * Called at 09:00 IST on the 10th by cron and hourly as a catch-up: emails last
 * month's report once, from 09:00 on the configured day (10th) onwards, if it has not
 * gone out yet.
 */
export async function sendDueMonthlyReport(now: Date = new Date()): Promise<string | null> {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const day = ist.getUTCDate();
  const reportDay = config.accounts.reportDayOfMonth;
  if (day < reportDay || (day === reportDay && ist.getUTCHours() < REPORT_HOUR_IST)) return null;

  const month = previousMonth(now);
  if (await reportSentAt(month)) return null;
  const recipients = await getReportRecipients();
  const ccRecipients = await getReportCcRecipients();
  if (!recipients.length) {
    logger.warn('Monthly accounts report is due but no recipients are set', { month });
    return null;
  }
  if (!(await claimMonthlySend(month, now))) return null;
  try {
    await emailMonthlyReport(month, recipients, ccRecipients);
  } catch (error) {
    // Release the claim so the next hourly run tries again.
    await prisma.setting.delete({ where: { key: sentKey(month) } }).catch(() => undefined);
    throw error;
  }
  return month;
}
