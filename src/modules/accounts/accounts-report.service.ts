/**
 * Monthly accounts closing report (Excel), for the orders PLACED in a month.
 *
 * Sent to the accounts team on the 8th of the next month (October's report on
 * 8 November) and downloadable any time from Payments & Accounts. Every order
 * is listed with where it stands: Closed (delivered, paid into the bank, return
 * window over), Open (and why), or Not a sale (cancelled / RTO / refunded),
 * with the bank UTR and the shipping cost of each leg.
 *
 * Sheets: Summary · Orders · COD Remittance · Prepaid Settlements ·
 * Shipping Costs · Returns & Refunds. Data sheets start at row 1 with a frozen,
 * filterable header so they can be sorted, filtered and exported as they are.
 */
import ExcelJS from 'exceljs';
import prisma from '../../database/prisma';
import { config } from '../../config';
import logger from '../../utils/logger';
import resendService from '../email/resend.service';
import { accountsStatus } from '../orders/order-tabs';
import { istDateRange } from './settlement-summary';
import { isDelhiveryCourier, isVelocityCourier, normalizeCourierName } from '../../utils/courier';

const IST_OFFSET_MS = 5.5 * 3600 * 1000;

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
function istDay(value?: Date | string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const ist = new Date(date.getTime() + IST_OFFSET_MS);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));
}

const money = (value?: number | null): number | null =>
  value === null || value === undefined || Number.isNaN(value) ? null : Math.round(value * 100) / 100;

const SOURCE_LABELS: Record<string, string> = {
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

const STATUS_LABELS: Record<string, string> = {
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
  RETURN_DISPATCHED: 'Return in transit',
  RETURN_RECEIVED: 'Return received',
  REFUNDED: 'Refunded',
  CANCELLED: 'Cancelled',
};

export interface ReportOrderRow {
  orderNo: string;
  orderDate: Date | null;
  customer: string;
  city: string;
  state: string;
  pincode: string;
  paymentMode: 'COD' | 'Prepaid';
  gateway: string;
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
  refundAmount: number | null;
  netAfterShipping: number | null;
  accountsStatus: 'Closed' | 'Open' | 'Not a sale';
  pending: string;
}

export interface ReportData {
  month: string;
  label: string;
  generatedAt: Date;
  orders: ReportOrderRow[];
  cod: Array<Record<string, any>>;
  prepaid: Array<Record<string, any>>;
  shipping: Array<Record<string, any>>;
  returns: Array<Record<string, any>>;
  summary: Array<{ label: string; value: number | string; note?: string }>;
}

function sum(values: Array<number | null | undefined>): number {
  return Math.round(values.reduce<number>((total, v) => total + (v || 0), 0) * 100) / 100;
}

/** Build every row of the report from orders loaded with shipment and returns. */
export function buildReportData(monthOrLabel: string, orders: any[], now: Date = new Date()): ReportData {
  let label = monthOrLabel;
  try {
    label = monthRange(monthOrLabel).label;
  } catch {
    label = monthOrLabel;
  }
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

    const reverse = returns.find((r) => r.returnWaybillNumber && r.returnStatus !== 'CANCELLED');
    const forwardShipping = money(shipment?.forwardCharge);
    const rtoShipping = money(shipment?.rtoCharge);
    const returnShipping = money(returns.reduce((t, r) => t + (r.shippingCharge || 0), 0) || null);
    const legsKnown = [forwardShipping, rtoShipping, returnShipping].filter((v) => v !== null);
    const totalShipping = legsKnown.length ? sum(legsKnown) : null;
    // Each leg's own source: forward, RTO, reverse pickups.
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
    const row: ReportOrderRow = {
      orderNo: order.shopifyOrderName,
      orderDate: istDay(order.shopifyCreatedAt),
      customer: order.customerName,
      city: order.customerCity,
      state: order.customerState,
      pincode: order.customerPincode,
      paymentMode: isCod ? 'COD' : 'Prepaid',
      gateway: isCod
        ? (isVelocityCourier(shipment?.courier, shipment?.labelUrl, shipment?.waybillNumber) ? 'Velocity COD' : (shipment?.courier && !isDelhiveryCourier(shipment?.courier, shipment?.labelUrl, shipment?.waybillNumber) ? `${normalizeCourierName(shipment.courier, shipment.labelUrl, shipment.waybillNumber)} COD` : 'Delhivery COD'))
        : (`${order.paymentProvider || ''} ${order.paymentAggregator || ''} ${order.paymentGateway || ''}`.toLowerCase().includes('phonepe') || `${order.paymentProvider || ''} ${order.paymentAggregator || ''} ${order.paymentGateway || ''}`.toLowerCase().includes('phone_pe')
            ? 'PhonePe'
            : (`${order.paymentProvider || ''} ${order.paymentAggregator || ''} ${order.paymentGateway || ''}`.toLowerCase().includes('gokwik') ||
               `${order.paymentProvider || ''} ${order.paymentAggregator || ''} ${order.paymentGateway || ''}`.toLowerCase().includes('easebuzz') ||
               (order.tags || '').toLowerCase().includes('gokwik'))
              ? 'GoKwik (Easebuzz)'
              : (order.paymentGateway || order.paymentProvider || 'Prepaid')),
      orderValue: money(order.totalAmount) || 0,
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
      refundAmount,
      netAfterShipping: receivedAmount !== null ? money(receivedAmount - (totalShipping || 0)) : null,
      accountsStatus: status.state === 'CLOSED' ? 'Closed' : status.state === 'OPEN' ? 'Open' : 'Not a sale',
      pending: status.state === 'OPEN' ? status.pending.join('; ') : status.state === 'NOT_A_SALE' ? notASaleReason(order) : '',
    };
    rows.push(row);

    if (isCod && shipment?.waybillNumber) {
      const remitted = Boolean(shipment.codRemitted);
      cod.push({
        orderNo: row.orderNo,
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
        gateway: row.gateway,
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

  return { month: monthOrLabel, label, generatedAt: now, orders: rows, cod, prepaid, shipping, returns: returnRows, summary };
}

function notASaleReason(order: { status?: string }): string {
  if (order.status === 'CANCELLED') return 'Cancelled';
  if (order.status === 'REFUNDED') return 'Refunded';
  return 'Returned to origin (RTO)';
}

// ─── Excel rendering ────────────────────────────────────────

type Column = { header: string; key: string; width: number; type?: 'money' | 'date' | 'int' };

const HEADER_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A2F' } };
const MONEY_FORMAT = '#,##0.00';
const DATE_FORMAT = 'dd-mmm-yyyy';

function addTable(workbook: ExcelJS.Workbook, name: string, columns: Column[], rows: Array<Record<string, any>>, totals: string[] = []) {
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
      // SUBTOTAL(109) ignores rows hidden by a filter, so the total follows the filter.
      totalRow.getCell(index).value = { formula: `SUBTOTAL(109,${letter}2:${letter}${last})` } as any;
      totalRow.getCell(index).numFmt = MONEY_FORMAT;
    }
    totalRow.font = { bold: true };
    totalRow.border = { top: { style: 'thin' } };
  }
  return sheet;
}

export async function renderWorkbook(data: ReportData): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Youthnic OMS';
  workbook.created = data.generatedAt;

  // Summary
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

  const orders = addTable(
    workbook,
    'Orders',
    [
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
    ],
    data.orders as any[],
    ['orderValue', 'receivedAmount', 'gatewayFee', 'forwardShipping', 'rtoShipping', 'returnShipping', 'totalShipping', 'refundAmount', 'netAfterShipping']
  );
  // Colour the status column so open orders stand out.
  const statusCol = orders.getColumn('accountsStatus').number;
  orders.eachRow((row, index) => {
    if (index === 1 || index > data.orders.length + 1) return;
    const cell = row.getCell(statusCol);
    const fill = cell.value === 'Closed' ? 'FFD1FAE5' : cell.value === 'Open' ? 'FFFEF3C7' : 'FFE5E7EB';
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
  });

  addTable(
    workbook,
    'COD Remittance',
    [
      { header: 'Order ID', key: 'orderNo', width: 14 },
      { header: 'Delhivery AWB / Tracking ID', key: 'awb', width: 18 },
      { header: 'Delivered Date', key: 'deliveredOn', width: 13, type: 'date' },
      { header: 'Order Value (₹)', key: 'orderValue', width: 14, type: 'money' },
      { header: 'COD Amount Collected (₹)', key: 'codAmount', width: 16, type: 'money' },
      { header: 'Delhivery Shipping Charged (₹)', key: 'shippingCharge', width: 22, type: 'money' },
      { header: 'Net Remitted Amount (₹)', key: 'remittedAmount', width: 16, type: 'money' },
      { header: 'Difference / Deductions (₹)', key: 'difference', width: 15, type: 'money' },
      { header: 'Remittance Number', key: 'remittanceRef', width: 22 },
      { header: 'Remittance Processed Date', key: 'remittedOn', width: 15, type: 'date' },
      { header: 'Bank\'s Transaction ID / UTR', key: 'utr', width: 24 },
      { header: 'Remittance Status', key: 'status', width: 26 },
    ],
    data.cod,
    ['orderValue', 'codAmount', 'shippingCharge', 'remittedAmount', 'difference']
  );

  addTable(
    workbook,
    'Prepaid Settlements',
    [
      { header: 'Order No', key: 'orderNo', width: 14 },
      { header: 'Gateway', key: 'gateway', width: 16 },
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

  addTable(
    workbook,
    'Returns & Refunds',
    [
      { header: 'Order No', key: 'orderNo', width: 14 },
      { header: 'Return AWB', key: 'returnAwb', width: 16 },
      { header: 'Reason', key: 'reason', width: 30 },
      { header: 'Return Status', key: 'returnStatus', width: 16 },
      { header: 'QC', key: 'qc', width: 10 },
      { header: 'Refund Status', key: 'refundStatus', width: 12 },
      { header: 'Refund (₹)', key: 'refundAmount', width: 12, type: 'money' },
      { header: 'Refunded On', key: 'refundedOn', width: 13, type: 'date' },
      { header: 'Return Shipping (₹)', key: 'returnShipping', width: 13, type: 'money' },
    ],
    data.returns,
    ['refundAmount', 'returnShipping']
  );

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** Load the month's orders and build the report. */
export async function generateMonthlyReport(month: string, now: Date = new Date()): Promise<{ data: ReportData; buffer: Buffer; fileName: string }> {
  const { start, end } = monthRange(month);
  const orders = await prisma.order.findMany({
    where: { shopifyCreatedAt: { gte: start, lt: end } },
    include: { shipment: true, returns: true },
    orderBy: { shopifyCreatedAt: 'asc' },
  });
  const data = buildReportData(month, orders, now);
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
  const orders = await prisma.order.findMany({
    where: { shopifyCreatedAt: { gte: start, lt: end } },
    include: { shipment: true, returns: true },
    orderBy: { shopifyCreatedAt: 'asc' },
  });
  const data = buildReportData(label, orders, now);
  data.label = label;
  const buffer = await renderWorkbook(data);
  return { data, buffer, fileName: `Youthnic-Accounts-${startDateStr}_to_${endDateStr}.xlsx` };
}

// ─── Emailing ───────────────────────────────────────────────

const RECIPIENTS_KEY = 'accounts_report_recipients';
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
  return parseRecipients(stored?.value ?? config.accounts.reportRecipients);
}

export async function setReportRecipients(value: string): Promise<string[]> {
  const recipients = parseRecipients(value);
  await prisma.setting.upsert({
    where: { key: RECIPIENTS_KEY },
    create: { key: RECIPIENTS_KEY, value: recipients.join(', ') },
    update: { value: recipients.join(', ') },
  });
  return recipients;
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
 * Claim the month's automatic send so only one sender emails it: the 09:00
 * cron and the hourly catch-up can fire at the same moment. The claim is the
 * creation of a unique Setting key; a claim left by a process that died while
 * sending is taken over after 30 minutes.
 */
async function claimMonthlySend(month: string, now: Date): Promise<boolean> {
  const key = sentKey(month);
  const claim = `${CLAIM_PREFIX}${now.toISOString()}`;
  try {
    await prisma.setting.create({ data: { key, value: claim } });
    return true;
  } catch {
    const row = await prisma.setting.findUnique({ where: { key } });
    if (!row?.value.startsWith(CLAIM_PREFIX)) return false; // already sent
    const claimedAt = Date.parse(row.value.slice(CLAIM_PREFIX.length));
    if (Number.isFinite(claimedAt) && now.getTime() - claimedAt < STALE_CLAIM_MS) return false;
    const taken = await prisma.setting.updateMany({ where: { key, value: row.value }, data: { value: claim } });
    return taken.count === 1;
  }
}

/** Email the month's report to the accounts team and remember that it was sent. */
export async function emailMonthlyReport(month: string, recipients?: string[]): Promise<{ sentTo: string[]; fileName: string }> {
  const to = recipients?.length ? recipients : await getReportRecipients();
  if (!to.length) {
    throw new Error('No report recipients set. Add the accounts team emails on the Payments & Accounts page.');
  }
  const { data, buffer, fileName } = await generateMonthlyReport(month);
  const line = (labelText: string) => data.summary.find((s) => s.label === labelText)?.value ?? 0;
  const inr = (value: number | string) =>
    typeof value === 'number' ? `₹${value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : value;

  await resendService.sendInternalEmail({
    to,
    subject: `Youthnic accounts closing report · ${data.label}`,
    html: `
      <div style="font-family:Arial,sans-serif;font-size:14px;color:#111">
        <p>Hello team,</p>
        <p>Attached is the accounts closing report for orders placed in <strong>${data.label}</strong>.</p>
        <table cellpadding="6" style="border-collapse:collapse;border:1px solid #ddd">
          <tr><td>Orders placed</td><td><strong>${line('Orders placed')}</strong></td></tr>
          <tr><td>Closed (paid, return window over)</td><td><strong>${line('Closed (delivered, paid, return window over)')}</strong></td></tr>
          <tr><td>Still open</td><td><strong>${line('Open')}</strong></td></tr>
          <tr><td>Received in bank</td><td><strong>${inr(line('Received in bank (₹)'))}</strong></td></tr>
          <tr><td>Shipping cost</td><td><strong>${inr(line('Shipping cost total (₹)'))}</strong></td></tr>
        </table>
        <p>The Orders sheet lists every order with its bank UTR, shipping cost per leg and, for open orders, what is still pending.</p>
        <p>Youthnic OMS</p>
      </div>`,
    attachments: [{ filename: fileName, content: buffer }],
  });

  const stamp = JSON.stringify({ sentAt: new Date().toISOString(), to });
  await prisma.setting.upsert({
    where: { key: sentKey(month) },
    create: { key: sentKey(month), value: stamp },
    update: { value: stamp },
  });
  logger.info('Monthly accounts report emailed', { month, to });
  return { sentTo: to, fileName };
}

/** The report hour on the report day (IST); the email never goes out earlier. */
const REPORT_HOUR_IST = 9;

/**
 * Called at 09:00 IST on the 8th by cron and hourly as a catch-up: emails last
 * month's report once, from 09:00 on the configured day onwards, if it has not
 * gone out yet (the server may have been down at 09:00 on the 8th).
 */
export async function sendDueMonthlyReport(now: Date = new Date()): Promise<string | null> {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const day = ist.getUTCDate();
  const reportDay = config.accounts.reportDayOfMonth;
  if (day < reportDay || (day === reportDay && ist.getUTCHours() < REPORT_HOUR_IST)) return null;

  const month = previousMonth(now);
  if (await reportSentAt(month)) return null;
  const recipients = await getReportRecipients();
  if (!recipients.length) {
    logger.warn('Monthly accounts report is due but no recipients are set', { month });
    return null;
  }
  if (!(await claimMonthlySend(month, now))) return null;
  try {
    await emailMonthlyReport(month, recipients);
  } catch (error) {
    // Release the claim so the next hourly run tries again.
    await prisma.setting.delete({ where: { key: sentKey(month) } }).catch(() => undefined);
    throw error;
  }
  return month;
}
