/**
 * State-wise Sales & Returns register for Tally, in the accounts team's
 * "Shopify format" layout: one sheet per channel (Delivery-COD, Velocity-COD,
 * EaseBuzz-Prepaid, PhonePe-Prepaid) with
 *   Sr No | State | Taxable Amt | Sum of IGST | Sum of CGST | Sum of SGST | Gross Sales (₹) | Sum of QTY | Voucher No | Date | Skus
 * and the same four sheets again for returns (credit notes).
 *
 * The figures follow the monthly State Summary exactly:
 *   Sales   = orders placed in the month, less unpaid cancellations and ₹0 exchange replacements.
 *   Returns = non-exchange returns effective in the month (refund date, else return date).
 * Gujarat (seller state) gets CGST + SGST, every other state IGST. An order whose GST rate
 * cannot be proven from Shopify tax lines is kept out of the state rows and listed on "GST Review".
 */
import ExcelJS from 'exceljs';
import prisma from '../../database/prisma';
import { gstService } from './gst.service';
import { isExchangeReplacement, istDay, money, monthRange, resolvePaymentRailName } from './accounts-report.service';

export type RegisterChannel = 'Delivery-COD' | 'Velocity-COD' | 'EaseBuzz-Prepaid' | 'PhonePe-Prepaid';
export const REGISTER_CHANNELS: RegisterChannel[] = ['Delivery-COD', 'Velocity-COD', 'EaseBuzz-Prepaid', 'PhonePe-Prepaid'];
const VOUCHER_CODE: Record<RegisterChannel, string> = {
  'Delivery-COD': 'DLCOD',
  'Velocity-COD': 'VLCOD',
  'EaseBuzz-Prepaid': 'EBPP',
  'PhonePe-Prepaid': 'PPPP',
};
const MAX_SKU_TEXT = 250;

export interface RegisterRow {
  srNo: number;
  state: string;
  taxable: number;
  igst: number;
  cgst: number;
  sgst: number;
  gross: number;
  qty: number;
  voucherNo: string;
  date: Date;
  skus: string;
}

export interface RegisterReviewRow {
  type: 'Sale' | 'Return';
  orderNo: string;
  state: string;
  channel: RegisterChannel;
  amount: number;
  reason: string;
}

export interface GstRegister {
  month: string;
  label: string;
  sales: Record<RegisterChannel, RegisterRow[]>;
  returns: Record<RegisterChannel, RegisterRow[]>;
  review: RegisterReviewRow[];
}

/** COD → the courier that collected the cash; prepaid → the gateway that took the payment. */
export function registerChannel(order: any): RegisterChannel {
  const isCod = order.paymentMethod === 'COD' || (order.paymentGateway || '').toLowerCase().includes('cash');
  if (isCod) return resolvePaymentRailName(order) === 'Velocity' ? 'Velocity-COD' : 'Delivery-COD';
  // Without the shipment, a prepaid order shipped by Velocity still resolves to its gateway.
  return resolvePaymentRailName({ ...order, shipment: null }) === 'PhonePe' ? 'PhonePe-Prepaid' : 'EaseBuzz-Prepaid';
}

interface Line { channel: RegisterChannel; state: string; amount: number; rate: number; qty: number; titles: string[] }

function groupRows(lines: Line[], prefix: string, yymm: string, date: Date): Record<RegisterChannel, RegisterRow[]> {
  const out = Object.fromEntries(REGISTER_CHANNELS.map((c) => [c, [] as RegisterRow[]])) as Record<RegisterChannel, RegisterRow[]>;
  for (const channel of REGISTER_CHANNELS) {
    const byState = new Map<string, { taxable: number; igst: number; cgst: number; sgst: number; gross: number; qty: number; titles: Set<string> }>();
    for (const line of lines.filter((l) => l.channel === channel)) {
      const tax = gstService.calculateSalesTax(line.amount, line.state, line.rate);
      const g = byState.get(line.state) || { taxable: 0, igst: 0, cgst: 0, sgst: 0, gross: 0, qty: 0, titles: new Set<string>() };
      g.taxable += tax.taxableAmount;
      g.igst += tax.igst;
      g.cgst += tax.cgst;
      g.sgst += tax.sgst;
      g.gross += line.amount;
      g.qty += line.qty;
      line.titles.forEach((t) => g.titles.add(t));
      byState.set(line.state, g);
    }
    [...byState.keys()].sort().forEach((state, i) => {
      const g = byState.get(state)!;
      const titles = [...g.titles];
      let skus = titles.join(', ');
      if (skus.length > MAX_SKU_TEXT) {
        const shown: string[] = [];
        for (const t of titles) if ([...shown, t].join(', ').length <= MAX_SKU_TEXT) shown.push(t);
        skus = `${shown.join(', ')} (+${titles.length - shown.length} more)`;
      }
      out[channel].push({
        srNo: i + 1,
        state,
        taxable: money(g.taxable) || 0,
        igst: money(g.igst) || 0,
        cgst: money(g.cgst) || 0,
        sgst: money(g.sgst) || 0,
        gross: money(g.gross) || 0,
        qty: g.qty,
        voucherNo: `${prefix}${VOUCHER_CODE[channel]}/${yymm}/${String(i + 1).padStart(2, '0')}`,
        date,
        skus,
      });
    });
  }
  return out;
}

const stateOf = (order: any): string => (order?.customerState || '').trim().toUpperCase() || 'UNSPECIFIED';
const itemTitles = (items: any[] = []): string[] => items.map((i) => (i?.title || i?.orderItem?.title || '').trim()).filter(Boolean);
const itemQty = (items: any[] = []): number => items.reduce((t, i) => t + (Number(i?.quantity) || 0), 0);

/** Pure: orders placed in the month + returns effective in the month → the register. */
export function buildGstRegister(month: string, orders: any[], periodReturns: any[]): GstRegister {
  const { end, label } = monthRange(month);
  const date = istDay(new Date(end.getTime() - 1))!;
  const yymm = month.slice(2, 4) + month.slice(5, 7);
  const review: RegisterReviewRow[] = [];

  const rateOf = (order: any): number | string => {
    try {
      return gstService.determineOrderGstRate(order);
    } catch (err: any) {
      return err?.message || 'GST rate could not be determined';
    }
  };

  const saleLines: Line[] = [];
  for (const o of orders) {
    if (isExchangeReplacement(o) || (o.status === 'CANCELLED' && !o.paymentReceivedAmount) || !(o.totalAmount > 0)) continue;
    const channel = registerChannel(o);
    const rate = rateOf(o);
    if (typeof rate === 'string') {
      review.push({ type: 'Sale', orderNo: o.shopifyOrderName, state: stateOf(o), channel, amount: money(o.totalAmount) || 0, reason: rate });
      continue;
    }
    saleLines.push({ channel, state: stateOf(o), amount: o.totalAmount, rate, qty: itemQty(o.items), titles: itemTitles(o.items) });
  }

  const returnLines: Line[] = [];
  for (const r of periodReturns) {
    if (r.isExchange || r.returnStatus === 'CANCELLED' || !r.order) continue;
    const amount = r.refundAmount && r.refundAmount > 0 ? r.refundAmount : r.order.totalAmount || 0;
    if (!(amount > 0)) continue;
    const channel = registerChannel(r.order);
    const rate = rateOf(r.order);
    if (typeof rate === 'string') {
      review.push({ type: 'Return', orderNo: r.order.shopifyOrderName, state: stateOf(r.order), channel, amount: money(amount) || 0, reason: rate });
      continue;
    }
    const items = r.items?.length ? r.items : r.order.items;
    returnLines.push({ channel, state: stateOf(r.order), amount, rate, qty: itemQty(items), titles: itemTitles(items) });
  }

  return {
    month,
    label,
    sales: groupRows(saleLines, '', yymm, date),
    returns: groupRows(returnLines, 'CN-', yymm, date),
    review,
  };
}

const COLUMNS = [
  { header: 'Sr No', key: 'srNo', width: 7 },
  { header: 'State', key: 'state', width: 22 },
  { header: 'Taxable Amt', key: 'taxable', width: 14, money: true },
  { header: 'Sum of IGST', key: 'igst', width: 12, money: true },
  { header: 'Sum of CGST', key: 'cgst', width: 12, money: true },
  { header: 'Sum of SGST', key: 'sgst', width: 12, money: true },
  { header: 'Gross Sales (₹)', key: 'gross', width: 15, money: true },
  { header: 'Sum of QTY', key: 'qty', width: 11 },
  { header: 'Voucher No', key: 'voucherNo', width: 20 },
  { header: 'Date', key: 'date', width: 12 },
  { header: 'Skus', key: 'skus', width: 60 },
];

function addRegisterSheet(workbook: ExcelJS.Workbook, name: string, rows: Array<Record<string, any>>, columns = COLUMNS) {
  const sheet = workbook.addWorksheet(name);
  sheet.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  sheet.getRow(1).font = { bold: true };
  rows.forEach((r) => sheet.addRow(r));
  columns.forEach((c, i) => {
    if ((c as any).money) sheet.getColumn(i + 1).numFmt = '0.00';
  });
  const dateCol = columns.findIndex((c) => c.key === 'date');
  if (dateCol >= 0) sheet.getColumn(dateCol + 1).numFmt = 'dd-mm-yyyy';
}

export async function renderGstRegisterWorkbook(register: GstRegister): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Youthnic OMS - Tally Register';
  for (const channel of REGISTER_CHANNELS) addRegisterSheet(workbook, channel, register.sales[channel]);
  for (const channel of REGISTER_CHANNELS) addRegisterSheet(workbook, `Return-${channel}`, register.returns[channel]);
  if (register.review.length) {
    addRegisterSheet(workbook, 'GST Review', register.review, [
      { header: 'Type', key: 'type', width: 8 },
      { header: 'Order No', key: 'orderNo', width: 16 },
      { header: 'State', key: 'state', width: 20 },
      { header: 'Channel', key: 'channel', width: 18 },
      { header: 'Amount (₹)', key: 'amount', width: 12, money: true } as any,
      { header: 'Why it is not in the register', key: 'reason', width: 70 },
    ]);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** Load the month (same windows as the monthly report) and render the register. */
export async function generateGstRegister(month: string): Promise<{ register: GstRegister; buffer: Buffer; fileName: string }> {
  const { start, end } = monthRange(month);
  const [orders, periodReturns] = await Promise.all([
    prisma.order.findMany({
      where: { shopifyCreatedAt: { gte: start, lt: end } },
      include: { shipment: true, items: true },
    }),
    prisma.return.findMany({
      where: {
        isExchange: false,
        OR: [
          { refundProcessedAt: { gte: start, lt: end } },
          { refundProcessedAt: null, createdAt: { gte: start, lt: end }, returnStatus: { not: 'CANCELLED' } },
        ],
      },
      include: { items: { include: { orderItem: true } }, order: { include: { shipment: true, items: true } } },
    }),
  ]);
  const register = buildGstRegister(month, orders, periodReturns);
  return { register, buffer: await renderGstRegisterWorkbook(register), fileName: `Youthnic-Sales-Returns-Register-${month}.xlsx` };
}
