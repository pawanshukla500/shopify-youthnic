/**
 * Monthly Accounts Pack: five Excel reports zipped and emailed on the 15th.
 *
 *   01 Sales (state-wise)    orders placed in the month and delivered, plus late deliveries
 *   02 Returns (state-wise)  customer returns initiated in the month; cancellations, RTOs, exchanges listed, not deducted
 *   03 Other charges         gateway fees and freight (forward, RTO, reverse, exchange), actual figures only
 *   04 Order level           A delivered, B returns/RTO/cancellation/exchange, C AWB, charges and payment
 *   05 Reconciliation        Opening + Sales − Returns − Payout deductions − Net receipts = Closing, plus checks
 *
 * Sale recognition: an order is a sale of the month it was placed in when it was delivered before that
 * month's pack went out (or before now when not yet sent). Delivered later, it is a "late delivery"
 * in the first later pack whose window covers the delivery date — never lost, never counted twice.
 * GST follows the government apparel slabs (gstService.orderGstLines), not Shopify/GoKwik tax lines.
 */
import { ZipArchive } from 'archiver';
import { PassThrough } from 'stream';
import prisma from '../../database/prisma';
import logger from '../../utils/logger';
import { config } from '../../config';
import resendService from '../email/resend.service';
import { isVelocityCourier } from '../../utils/courier';
import { gstService } from './gst.service';
import {
  IST_OFFSET_MS,
  getReportCcRecipients,
  getReportRecipients,
  isExchangeReplacement,
  previousMonth,
  money,
  monthRange,
  resolvePaymentRailName,
  sum,
} from './accounts-report.service';
import { registerChannel, REGISTER_CHANNELS, type RegisterChannel } from './gst-register.service';
import { reconcileProvider, PROVIDER_CODES, type Consumption, type ProviderCode, type ProviderReconRow } from './provider-invoice.service';

export const PACK_SENT_PREFIX = 'accounts_pack_sent:';
export const PACK_HELD_PREFIX = 'accounts_pack_held:';
const RTO_STATUSES = new Set(['RTO_INITIATED', 'RTO_DELIVERED']);
const GST_FREIGHT_RATE = 18;

// ─── Small helpers ─────────────────────────────────────────

/** 'YYYY-MM' of an instant, in IST. */
export function monthOf(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const ist = new Date(d.getTime() + IST_OFFSET_MS);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

const n = (v: unknown): number => Number(v) || 0;
const split18 = (total: number) => {
  const gst = money((total * GST_FREIGHT_RATE) / (100 + GST_FREIGHT_RATE)) || 0;
  return { taxable: money(total - gst) || 0, gst };
};
const freightProvider = (courier?: string | null, labelUrl?: string | null, awb?: string | null): ProviderCode =>
  isVelocityCourier(courier || '', labelUrl || '', awb || '') ? 'VELOCITY' : 'DELHIVERY';
const returnProvider = (carrier?: string | null): ProviderCode => (/velocity/i.test(carrier || '') ? 'VELOCITY' : 'DELHIVERY');
const isCodOrder = (o: any) => o.paymentMethod === 'COD' || (o.paymentGateway || '').toLowerCase().includes('cash');

// ─── Data ──────────────────────────────────────────────────

export interface PackData {
  orders: any[]; // every order placed before the month end, with items, shipment, returns (items → orderItem)
  rtoStart: Map<number, Date>; // shipmentId → first RTO tracking scan
  replacementShipments: Map<string, any>; // exchange replacement AWB → shipment (+ order name)
  settlementRows: any[]; // Easebuzz settlement transactions in the month and the month before
  gatewayRefunds: Array<{ orderId: number; amount: number; date: Date }>;
  invoices: any[]; // ProviderInvoice rows for the month and the month before
  sentAt: Map<string, Date>; // month → when its pack went to the accounts team
}

export async function loadPackData(month: string): Promise<PackData> {
  const { end } = monthRange(month);
  const prevStart = monthRange(shiftMonth(month, -1)).start;
  // shortcut: loads every order since the first one (845 in Nov 2026); move to a rolling window if this passes ~50k.
  const orders = await prisma.order.findMany({
    where: { shopifyCreatedAt: { lt: end } },
    include: { items: true, shipment: true, returns: { include: { items: { include: { orderItem: true } } } } },
    orderBy: { shopifyCreatedAt: 'asc' },
  });
  const shipmentIds = orders.map((o) => o.shipment?.id).filter((id): id is number => Boolean(id));
  const exchangeAwbs = orders.flatMap((o) => o.returns.filter((r) => r.isExchange && r.exchangeForwardAwb).map((r) => r.exchangeForwardAwb as string));

  const [rtoScans, replacements, settlementRows, refunds, invoices, stamps] = await Promise.all([
    shipmentIds.length
      ? prisma.trackingLog.groupBy({
          by: ['shipmentId'],
          where: {
            shipmentId: { in: shipmentIds },
            OR: [{ statusType: 'RT' }, { status: { contains: 'RTO', mode: 'insensitive' } }, { rawStatus: { contains: 'RTO', mode: 'insensitive' } }],
          },
          _min: { scannedAt: true },
        })
      : Promise.resolve([] as any[]),
    exchangeAwbs.length
      ? prisma.shipment.findMany({ where: { waybillNumber: { in: exchangeAwbs } }, include: { order: { select: { shopifyOrderName: true } } } })
      : Promise.resolve([] as any[]),
    prisma.gatewaySettlementOrder.findMany({
      where: { transactionDate: { gte: prevStart, lt: end }, batch: { gateway: 'EASEBUZZ' } },
      select: { id: true, orderId: true, shopifyOrderName: true, easebuzzTrxnId: true, merchantTrxnId: true, serviceCharge: true, gst: true, transactionDate: true, transactionAmount: true, status: true },
    }),
    prisma.gatewaySettlementRefund.findMany({
      where: { orderId: { not: null } },
      select: { orderId: true, settlementAmount: true, batch: { select: { settlementDate: true } } },
    }),
    prisma.providerInvoice.findMany({ where: { period: { in: [shiftMonth(month, -1), month] } } }),
    prisma.setting.findMany({ where: { key: { startsWith: PACK_SENT_PREFIX } } }),
  ]);

  const sentAt = new Map<string, Date>();
  for (const s of stamps) {
    try {
      const at = new Date(JSON.parse(s.value).sentAt);
      if (!Number.isNaN(at.getTime())) sentAt.set(s.key.slice(PACK_SENT_PREFIX.length), at);
    } catch {
      // a SENDING: claim, not a stamp
    }
  }
  return {
    orders,
    rtoStart: new Map(rtoScans.filter((r: any) => r._min?.scannedAt).map((r: any) => [r.shipmentId, new Date(r._min.scannedAt)])),
    replacementShipments: new Map(replacements.map((s: any) => [s.waybillNumber, s])),
    settlementRows,
    gatewayRefunds: refunds.map((r) => ({ orderId: r.orderId as number, amount: n(r.settlementAmount), date: r.batch.settlementDate })),
    invoices,
    sentAt,
  };
}

// ─── Month figures ─────────────────────────────────────────

export interface GstLine { rate: number; amount: number; qty: number; titles: string[]; taxable: number; igst: number; cgst: number; sgst: number }
export interface SaleRow {
  order: any; orderNo: string; orderDate: Date; deliveredAt: Date; state: string; channel: RegisterChannel;
  paymentMethod: 'COD' | 'Prepaid'; value: number; qty: number; lines: GstLine[] | null; gstError?: string;
  late: boolean; shopifyRate: number | null;
}
export interface ReturnRow {
  kind: 'Customer return' | 'Exchange' | 'RTO' | 'Cancellation';
  order: any; orderNo: string; orderDate: Date; initiatedAt: Date; dateNote: string; state: string; channel: RegisterChannel;
  reason: string; status: string; value: number; deducted: boolean; valueBasis: string; qty: number;
  lines: GstLine[] | null; gstError?: string; refundStatus: string; refundDate: Date | null; awb: string; charges: number | null;
}
export interface ChargeLine {
  category: 'Gateway' | 'Forward' | 'RTO' | 'Reverse' | 'Exchange'; provider: ProviderCode; orderNo: string; reference: string;
  date: Date | null; taxable: number; gst: number; total: number; actual: boolean; basis: string;
}
export interface LedgerRow {
  order: any; saleMonth: string | null; opening: number; sales: number; returns: number; deductions: number; receipts: number;
  closing: number; // at month end
  today: { sales: number; returns: number; deductions: number; receipts: number; outstanding: number };
}
export interface Check { id: number; name: string; passed: boolean; detail: string }
export interface Gap { area: string; orderNo: string; reference: string; issue: string; amount: number | null }

export interface MonthFigures {
  month: string;
  sales: SaleRow[];
  returns: ReturnRow[]; // all kinds initiated in the month
  charges: ChargeLine[];
  bills: ProviderReconRow[];
  inTransit: any[];
}

function gstLinesFor(order: any, value: number, items?: Array<{ price: number; quantity: number; title?: string | null }>, discounts?: number): GstLine[] {
  return gstService
    .orderGstLines({ ...order, totalAmount: value, items: items ?? order.items, totalDiscounts: discounts ?? order.totalDiscounts })
    .map((l) => {
      const tax = gstService.calculateSalesTax(l.amount, order.customerState, l.rate);
      return { ...l, taxable: tax.taxableAmount, igst: tax.igst, cgst: tax.cgst, sgst: tax.sgst };
    });
}

function shopifyRate(order: any): number | null {
  try {
    return gstService.shopifyTaxLineRate(order.taxLines);
  } catch {
    return -1; // mixed rates on Shopify's side
  }
}

/** The pack month that recognises this order's sale, or null when it isn't a sale. */
export function saleMonth(order: any, sentAt: Map<string, Date>, now: Date): string | null {
  if (!order.deliveredAt || isExchangeReplacement(order) || order.status === 'CANCELLED' || RTO_STATUSES.has(order.status)) return null;
  const delivered = new Date(order.deliveredAt);
  let m = monthOf(order.shopifyCreatedAt)!;
  const last = monthOf(now)!;
  // A month's window closes when its pack is sent; unsent months stay open until now.
  while (m < last && delivered > (sentAt.get(m) || now)) m = shiftMonth(m, 1);
  return m;
}

/** Value of a customer return: refund paid, else the returned items' share of the order, else the order total. */
export function returnValue(ret: any, order: any): { value: number; basis: string; items?: any[]; discounts?: number; qty: number } {
  const orderItems: any[] = order.items || [];
  const subtotal = orderItems.reduce((t, i) => t + n(i.price) * n(i.quantity), 0);
  const returned = (ret.items || []).filter((ri: any) => ri.orderItem && n(ri.quantity) > 0)
    .map((ri: any) => ({ price: n(ri.orderItem.price), quantity: n(ri.quantity), title: ri.orderItem.title }));
  const returnedValue = returned.reduce((t: number, i: any) => t + i.price * i.quantity, 0);
  const share = subtotal > 0 && returnedValue > 0 ? Math.min(1, returnedValue / subtotal) : 1;
  const items = returned.length ? returned : undefined;
  const discounts = n(order.totalDiscounts) * share;
  const qty = returned.length ? returned.reduce((t: number, i: any) => t + i.quantity, 0) : orderItems.reduce((t, i) => t + n(i.quantity), 0);
  if (ret.refundStatus === 'PROCESSED' && n(ret.refundAmount) > 0) return { value: money(n(ret.refundAmount))!, basis: 'Refund processed', items, discounts, qty };
  if (returned.length && subtotal > 0) return { value: money(n(order.totalAmount) * share)!, basis: 'Returned items share of order value', items, discounts, qty };
  return { value: money(n(order.totalAmount))!, basis: 'Order value (no item detail)', qty };
}

export function computeMonth(data: PackData, month: string, now: Date): MonthFigures {
  const inMonth = (d: Date | string | null | undefined) => monthOf(d) === month;
  const sales: SaleRow[] = [];
  const returns: ReturnRow[] = [];
  const charges: ChargeLine[] = [];
  const inTransit: any[] = [];
  const realOrders = data.orders.filter((o) => !isExchangeReplacement(o));
  const byId = new Map<number, any>(data.orders.map((o) => [o.id, o]));

  for (const o of realOrders) {
    const channel = registerChannel(o);
    const state = (o.customerState || '').trim() || 'Unspecified';
    const sm = saleMonth(o, data.sentAt, now);
    if (sm === month) {
      let lines: GstLine[] | null = null;
      let gstError: string | undefined;
      try {
        lines = gstLinesFor(o, n(o.totalAmount));
      } catch (err: any) {
        gstError = err?.message || 'GST rate could not be determined';
      }
      sales.push({
        order: o, orderNo: o.shopifyOrderName, orderDate: o.shopifyCreatedAt, deliveredAt: o.deliveredAt, state, channel,
        paymentMethod: isCodOrder(o) ? 'COD' : 'Prepaid', value: money(n(o.totalAmount))!,
        qty: (o.items || []).reduce((t: number, i: any) => t + n(i.quantity), 0), lines, gstError,
        late: monthOf(o.shopifyCreatedAt) !== month, shopifyRate: shopifyRate(o),
      });
    }
    if (inMonth(o.shopifyCreatedAt) && !o.deliveredAt && o.status !== 'CANCELLED' && !RTO_STATUSES.has(o.status)) inTransit.push(o);

    // Customer returns and exchanges initiated this month
    for (const r of o.returns || []) {
      if (!inMonth(r.createdAt) || r.returnStatus === 'CANCELLED') continue;
      const base = {
        order: o, orderNo: o.shopifyOrderName, orderDate: o.shopifyCreatedAt, initiatedAt: r.createdAt, dateNote: 'Return created',
        state, channel, reason: r.returnReason || '', status: r.returnStatus, refundStatus: r.refundStatus,
        refundDate: r.refundProcessedAt || null, awb: r.returnWaybillNumber || '',
      };
      if (r.isExchange) {
        const rep = r.exchangeForwardAwb ? data.replacementShipments.get(r.exchangeForwardAwb) : null;
        const repCharge = rep && (rep.forwardCharge !== null || rep.rtoCharge !== null) ? n(rep.forwardCharge) + n(rep.rtoCharge) : null;
        returns.push({
          ...base, kind: 'Exchange', value: 0, deducted: false, valueBasis: 'Exchange: item swapped, no sale reversal', qty: 0, lines: null,
          charges: r.shippingCharge === null && repCharge === null ? null : money(n(r.shippingCharge) + n(repCharge)),
        });
        charges.push({
          category: 'Exchange', provider: returnProvider(r.carrier), orderNo: o.shopifyOrderName, reference: `Reverse ${r.returnWaybillNumber || '—'}`,
          date: r.createdAt, ...split18(n(r.shippingCharge)), total: money(n(r.shippingCharge))!, actual: r.shippingCostSource === 'ACTUAL',
          basis: r.shippingCharge === null ? 'No charge recorded' : r.shippingCostSource || 'No source',
        });
        if (r.exchangeForwardAwb) {
          const repActual = Boolean(rep) && rep.shippingCostSource === 'ACTUAL' && (rep.rtoCharge === null || rep.rtoChargeSource === 'ACTUAL');
          charges.push({
            category: 'Exchange', provider: rep ? freightProvider(rep.courier, rep.labelUrl, rep.waybillNumber) : returnProvider(r.carrier),
            orderNo: o.shopifyOrderName, reference: `Replacement ${r.exchangeForwardAwb}`, date: r.createdAt,
            ...split18(n(repCharge)), total: money(n(repCharge))!, actual: repActual,
            basis: repCharge === null ? 'No charge recorded' : repActual ? 'ACTUAL' : 'ESTIMATE',
          });
        }
        continue;
      }
      const rv = returnValue(r, o);
      let lines: GstLine[] | null = null;
      let gstError: string | undefined;
      try {
        lines = gstLinesFor(o, rv.value, rv.items, rv.discounts);
      } catch (err: any) {
        gstError = err?.message || 'GST rate could not be determined';
      }
      returns.push({
        ...base, kind: 'Customer return', value: rv.value, deducted: true, valueBasis: rv.basis, qty: rv.qty, lines, gstError,
        charges: r.shippingCharge === null ? null : money(n(r.shippingCharge)),
      });
      if (r.returnWaybillNumber) {
        charges.push({
          category: 'Reverse', provider: returnProvider(r.carrier), orderNo: o.shopifyOrderName, reference: r.returnWaybillNumber,
          date: r.createdAt, ...split18(n(r.shippingCharge)), total: money(n(r.shippingCharge))!, actual: r.shippingCostSource === 'ACTUAL',
          basis: r.shippingCharge === null ? 'No charge recorded' : r.shippingCostSource || 'No source',
        });
      }
    }

    // Cancellations in the month (listed, not deducted: never a sale)
    if (o.status === 'CANCELLED') {
      const at = o.cancelledAt || o.shopifyUpdatedAt || o.updatedAt;
      if (inMonth(at)) {
        returns.push({
          kind: 'Cancellation', order: o, orderNo: o.shopifyOrderName, orderDate: o.shopifyCreatedAt, initiatedAt: at,
          dateNote: o.cancelledAt ? 'Cancelled at' : 'Last Shopify update (cancel date not recorded)', state, channel,
          reason: o.cancelReason || '', status: 'CANCELLED', value: money(n(o.totalAmount))!, deducted: false,
          valueBasis: 'Not a sale: listed only', qty: 0, lines: null, refundStatus: o.financialStatus || '', refundDate: null,
          awb: o.shipment?.waybillNumber || '', charges: null,
        });
      }
    }

    const s = o.shipment;
    if (s?.waybillNumber) {
      // Forward freight by manifest date
      if (s.status !== 'CANCELLED' && inMonth(s.omsManifestedAt || s.createdAt)) {
        charges.push({
          category: 'Forward', provider: freightProvider(s.courier, s.labelUrl, s.waybillNumber), orderNo: o.shopifyOrderName,
          reference: s.waybillNumber, date: s.omsManifestedAt || s.createdAt, ...split18(n(s.forwardCharge)), total: money(n(s.forwardCharge))!,
          actual: s.shippingCostSource === 'ACTUAL', basis: s.forwardCharge === null ? 'No charge recorded' : s.shippingCostSource || 'No source',
        });
      }
      // RTO: started on the first RTO scan
      if (/^RTO/.test(s.status) || RTO_STATUSES.has(o.status)) {
        const scan = data.rtoStart.get(s.id);
        const at = scan || s.updatedAt;
        if (inMonth(at)) {
          returns.push({
            kind: 'RTO', order: o, orderNo: o.shopifyOrderName, orderDate: o.shopifyCreatedAt, initiatedAt: at,
            dateNote: scan ? 'First RTO scan' : 'Shipment last update (no RTO scan recorded)', state, channel,
            reason: s.trackingStatus || 'Returned to origin', status: s.status, value: money(n(o.totalAmount))!, deducted: false,
            valueBasis: 'Not a sale: listed only', qty: 0, lines: null, refundStatus: o.financialStatus || '', refundDate: null,
            awb: s.waybillNumber, charges: s.rtoCharge === null ? null : money(n(s.rtoCharge)),
          });
          charges.push({
            category: 'RTO', provider: freightProvider(s.courier, s.labelUrl, s.waybillNumber), orderNo: o.shopifyOrderName,
            reference: s.waybillNumber, date: at, ...split18(n(s.rtoCharge)), total: money(n(s.rtoCharge))!,
            actual: s.rtoChargeSource === 'ACTUAL', basis: s.rtoCharge === null ? 'No charge recorded' : s.rtoChargeSource || 'No source',
          });
        }
      }
    }
  }

  // Gateway fees. Each settled prepaid order carries fee + GST from the settlement file, dated on the
  // transaction (paymentReceivedAt is the transaction date): the same basis as the provider's monthly invoice.
  const rowsByOrder = new Map<number, any[]>();
  for (const row of data.settlementRows) if (row.orderId) rowsByOrder.set(row.orderId, [...(rowsByOrder.get(row.orderId) || []), row]);
  for (const o of realOrders) {
    if (!inMonth(o.paymentReceivedAt) || isCodOrder(o)) continue;
    const rail = resolvePaymentRailName({ ...o, shipment: null });
    if (rail !== 'EaseBuzz' && rail !== 'PhonePe') continue;
    const fee = n(o.gatewayFee);
    const rows = (rowsByOrder.get(o.id) || []).filter((r) => r.status === 'MATCHED');
    const rowTotal = sum(rows.map((r) => n(r.serviceCharge) + n(r.gst)));
    // Use the settlement file's own fee/GST split when its rows add up to the order's fee.
    const split = rows.length && Math.abs(rowTotal - fee) <= 0.05
      ? { taxable: sum(rows.map((r) => n(r.serviceCharge))), gst: sum(rows.map((r) => n(r.gst))) }
      : split18(fee);
    charges.push({
      category: 'Gateway', provider: rail === 'PhonePe' ? 'PHONEPE' : 'EASEBUZZ', orderNo: o.shopifyOrderName,
      reference: o.paymentReceivedRef || o.paymentReference || '', date: o.paymentReceivedAt, ...split, total: money(fee)!,
      actual: o.gatewayFee !== null, basis: o.gatewayFee === null ? 'Settled, but no fee recorded' : `${o.paymentReceivedSource || 'Settlement'} fee`,
    });
  }
  // shortcut: settlement rows not linked to an order are not added; in Oct 2026 they were copies of transactions already
  // on orders (order fees alone = Easebuzz invoice ₹5,222.81 to the paisa). Revisit if a bill shows a shortfall.

  // Provider bills against this month's actual lines
  const bills = PROVIDER_CODES.map((provider) => {
    const lines = charges.filter((c) => c.provider === provider && c.actual);
    const taxable = sum(lines.map((l) => l.taxable));
    const gst = sum(lines.map((l) => l.gst));
    const consumption: Consumption = {
      taxable, gst, total: money(taxable + gst)!, lines: lines.length,
      estimated: charges.filter((c) => c.provider === provider && !c.actual).length,
      basis: 'Actual lines in the Other Charges report',
    };
    const invoices = data.invoices.filter((i) => i.provider === provider && i.period === month).map((i) => ({
      id: i.id, invoiceNumber: i.invoiceNumber, invoiceDate: i.invoiceDate, taxableAmount: n(i.taxableAmount),
      igst: n(i.igst), cgst: n(i.cgst), sgst: n(i.sgst), totalAmount: n(i.totalAmount), note: i.note,
    }));
    return reconcileProvider(provider, month, invoices, consumption);
  });

  return { month, sales, returns, charges, bills, inTransit };
}

// ─── Ledger (roll-forward) ─────────────────────────────────

interface Movement { month: string; sales: number; returns: number; deductions: number; receipts: number }

/** Every dated money movement of one order: sale, deductible returns, payout deductions, receipts net of refunds. */
export function orderMovements(order: any, data: PackData, now: Date): Movement[] {
  const out: Movement[] = [];
  const add = (month: string | null, part: Partial<Movement>) => {
    if (!month) return;
    out.push({ month, sales: 0, returns: 0, deductions: 0, receipts: 0, ...part });
  };
  const sm = saleMonth(order, data.sentAt, now);
  if (sm) add(sm, { sales: n(order.totalAmount) });
  for (const r of order.returns || []) {
    if (r.isExchange || r.returnStatus === 'CANCELLED') continue;
    add(monthOf(r.createdAt), { returns: returnValue(r, order).value });
  }
  const paidAt = order.paymentReceivedAt;
  if (paidAt && n(order.paymentReceivedAmount)) add(monthOf(paidAt), { receipts: n(order.paymentReceivedAmount) });
  if (isCodOrder(order)) {
    const s = order.shipment;
    if (s?.codRemitted && s.codRemittedAmount !== null && n(s.codAmount) > n(s.codRemittedAmount)) {
      add(monthOf(s.codRemittedAt || paidAt), { deductions: n(s.codAmount) - n(s.codRemittedAmount) });
    }
  } else if (paidAt && n(order.gatewayFee)) {
    add(monthOf(paidAt), { deductions: n(order.gatewayFee) });
  }
  // Refunds paid back reduce receipts: gateway refund debits when the gateway reported them, else processed return refunds.
  const gatewayRefunds = data.gatewayRefunds.filter((g) => g.orderId === order.id);
  if (gatewayRefunds.length) for (const g of gatewayRefunds) add(monthOf(g.date), { receipts: -g.amount });
  else for (const r of order.returns || []) {
    if (r.refundStatus === 'PROCESSED' && n(r.refundAmount) > 0 && r.refundProcessedAt) add(monthOf(r.refundProcessedAt), { receipts: -n(r.refundAmount) });
  }
  return out;
}

export function buildLedger(data: PackData, month: string, now: Date): LedgerRow[] {
  return data.orders.filter((o) => !isExchangeReplacement(o)).map((o) => {
    const moves = orderMovements(o, data, now);
    const total = (filter: (m: Movement) => boolean, key: keyof Omit<Movement, 'month'>) => sum(moves.filter(filter).map((m) => m[key]));
    const before = (m: Movement) => m.month < month;
    const during = (m: Movement) => m.month === month;
    const upTo = (m: Movement) => m.month <= month;
    const net = (f: (m: Movement) => boolean) => money(total(f, 'sales') - total(f, 'returns') - total(f, 'deductions') - total(f, 'receipts'))!;
    const all = () => true;
    return {
      order: o,
      saleMonth: saleMonth(o, data.sentAt, now),
      opening: net(before),
      sales: total(during, 'sales'),
      returns: total(during, 'returns'),
      deductions: total(during, 'deductions'),
      receipts: total(during, 'receipts'),
      closing: net(upTo),
      today: { sales: total(all, 'sales'), returns: total(all, 'returns'), deductions: total(all, 'deductions'), receipts: total(all, 'receipts'), outstanding: net(all) },
    };
  });
}

export function paymentStatus(row: LedgerRow): string {
  const o = row.order;
  const t = row.today;
  if (Math.abs(t.outstanding) <= 1) return t.sales || t.receipts ? 'Reconciled' : 'No sale, no money';
  if (t.outstanding > 0) return t.receipts > 0 ? 'Short paid' : 'Awaiting payment';
  return o.deliveredAt ? 'Excess / refund not recorded' : 'Advance before delivery';
}

// ─── Pack ──────────────────────────────────────────────────

export interface MonthlyPack {
  month: string;
  label: string;
  generatedAt: Date;
  current: MonthFigures;
  previous: MonthFigures;
  ledger: LedgerRow[];
  roll: { opening: number; sales: number; returns: number; deductions: number; receipts: number; closing: number; walletFreight: number };
  checks: Check[];
  warnings: string[];
  gaps: Gap[];
  passed: boolean;
}

const sumBy = <T>(rows: T[], f: (r: T) => number) => sum(rows.map(f));
const lineTotal = (lines: GstLine[] | null, k: keyof GstLine) => sum((lines || []).map((l) => Number(l[k]) || 0));

export function buildMonthlyPack(data: PackData, month: string, now: Date = new Date()): MonthlyPack {
  const { label } = monthRange(month);
  const current = computeMonth(data, month, now);
  const previous = computeMonth(data, shiftMonth(month, -1), now);
  const ledger = buildLedger(data, month, now);
  const roll = {
    opening: sumBy(ledger, (l) => l.opening),
    sales: sumBy(ledger, (l) => l.sales),
    returns: sumBy(ledger, (l) => l.returns),
    deductions: sumBy(ledger, (l) => l.deductions),
    receipts: sumBy(ledger, (l) => l.receipts),
    closing: 0,
    walletFreight: sumBy(current.charges.filter((c) => c.category !== 'Gateway' && c.actual), (c) => c.total),
  };
  roll.closing = money(roll.opening + roll.sales - roll.returns - roll.deductions - roll.receipts)!;

  const deducted = current.returns.filter((r) => r.deducted);
  const salesInRegister = current.sales.filter((s) => s.lines);
  const returnsInRegister = deducted.filter((r) => r.lines);
  const tie = (a: number, b: number) => Math.abs(a - b) <= 0.05;

  const gaps: Gap[] = [
    ...current.charges.filter((c) => !c.actual).map((c) => ({
      area: `${c.category} charge`, orderNo: c.orderNo, reference: c.reference, issue: `Not an actual billed charge (${c.basis})`, amount: c.total || null,
    })),
    ...[...current.sales, ...deducted].filter((r) => !r.lines).map((r) => ({
      area: 'GST', orderNo: r.orderNo, reference: '', issue: r.gstError || 'GST rate could not be determined', amount: r.value,
    })),
  ];
  const settledIds = new Set(data.settlementRows.map((r) => r.orderId).filter(Boolean));
  const unsettledPrepaid = current.sales.filter((s) => s.paymentMethod === 'Prepaid' && !s.order.paymentReceivedAt && !settledIds.has(s.order.id));
  for (const s of unsettledPrepaid) gaps.push({ area: 'Gateway settlement', orderNo: s.orderNo, reference: s.channel, issue: 'Delivered prepaid order with no settlement recorded', amount: s.value });
  const orderLevelClosing = sumBy(ledger, (l) => l.closing);
  const variances = current.bills.filter((b) => b.status === 'VARIANCE');

  const checks: Check[] = [
    { id: 1, name: 'Closing outstanding = sum of order-level outstanding', passed: tie(roll.closing, orderLevelClosing), detail: `Roll-forward ₹${roll.closing.toFixed(2)} vs orders ₹${orderLevelClosing.toFixed(2)}` },
    {
      id: 2, name: 'Report totals = order-level section totals',
      passed: tie(sumBy(salesInRegister, (s) => s.value), sumBy(current.sales, (s) => s.value)) && tie(sumBy(returnsInRegister, (r) => r.value), sumBy(deducted, (r) => r.value)) && tie(roll.sales, sumBy(current.sales, (s) => s.value)) && tie(roll.returns, sumBy(deducted, (r) => r.value)),
      detail: `Sales register ₹${sumBy(salesInRegister, (s) => s.value).toFixed(2)} / section A ₹${sumBy(current.sales, (s) => s.value).toFixed(2)} / ledger ₹${roll.sales.toFixed(2)}; returns register ₹${sumBy(returnsInRegister, (r) => r.value).toFixed(2)} / section B ₹${sumBy(deducted, (r) => r.value).toFixed(2)} / ledger ₹${roll.returns.toFixed(2)}`,
    },
    {
      id: 3, name: 'Sales by channel = section A by channel',
      passed: REGISTER_CHANNELS.every((c) => tie(sumBy(salesInRegister.filter((s) => s.channel === c), (s) => s.value), sumBy(current.sales.filter((s) => s.channel === c), (s) => s.value))),
      detail: REGISTER_CHANNELS.map((c) => `${c} ₹${sumBy(current.sales.filter((s) => s.channel === c), (s) => s.value).toFixed(2)}`).join(' · '),
    },
    { id: 4, name: 'Every charge in the month is an actual billed figure', passed: !current.charges.some((c) => !c.actual), detail: `${current.charges.filter((c) => !c.actual).length} of ${current.charges.length} lines not actual` },
    { id: 5, name: 'Every delivered prepaid order has a gateway settlement', passed: unsettledPrepaid.length === 0, detail: `${unsettledPrepaid.length} delivered prepaid order(s) without settlement` },
    { id: 6, name: 'Every sale and return has a determinable GST rate', passed: [...current.sales, ...deducted].every((r) => r.lines), detail: `${[...current.sales, ...deducted].filter((r) => !r.lines).length} need GST review` },
    { id: 7, name: 'Provider bills entered match our books (±₹1)', passed: variances.length === 0, detail: variances.length ? variances.map((b) => `${b.label} ₹${b.variance?.toFixed(2)}`).join(', ') : 'No variance on entered bills' },
  ];

  const warnings: string[] = [];
  if (current.inTransit.length) warnings.push(`${current.inTransit.length} order(s) placed in ${label} not delivered yet (counted when delivered)`);
  const pending = current.bills.filter((b) => b.status === 'INVOICE_PENDING' && b.consumption.total > 0);
  if (pending.length) warnings.push(`Provider bill not entered: ${pending.map((b) => b.label).join(', ')}`);
  const gstDiff = current.sales.filter((s) => s.lines && s.shopifyRate !== null && !s.lines.some((l) => l.rate === s.shopifyRate));
  if (gstDiff.length) warnings.push(`${gstDiff.length} order(s) where Shopify/GoKwik tax lines differ from the government slab (fix GoKwik tax settings)`);
  const noUtr = current.sales.filter((s) => s.order.paymentReceivedAt && !s.order.paymentReceivedUtr);
  if (noUtr.length) warnings.push(`${noUtr.length} payment(s) received without a bank UTR`);
  const datedByFallback = current.returns.filter((r) => /not recorded/.test(r.dateNote));
  if (datedByFallback.length) warnings.push(`${datedByFallback.length} cancellation/RTO date(s) taken from the last update because the event date was not recorded`);

  return { month, label, generatedAt: now, current, previous, ledger, roll, checks, warnings, gaps, passed: checks.every((c) => c.passed) };
}

// ─── ZIP, send, hold ───────────────────────────────────────

export async function zipFiles(files: Array<{ name: string; buffer: Buffer }>): Promise<Buffer> {
  const archive = new ZipArchive({ zlib: { level: 9 } });
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on('data', (c) => chunks.push(c as Buffer));
  const done = new Promise<void>((resolve, reject) => {
    out.on('end', () => resolve());
    archive.on('error', reject);
  });
  archive.pipe(out);
  for (const f of files) archive.append(f.buffer, { name: f.name });
  await archive.finalize();
  await done;
  return Buffer.concat(chunks);
}

export interface GeneratedPack { pack: MonthlyPack; files: Array<{ name: string; buffer: Buffer }>; zip: Buffer; zipName: string }

export async function generateMonthlyPack(month: string, now: Date = new Date()): Promise<GeneratedPack> {
  monthRange(month);
  const data = await loadPackData(month);
  const pack = buildMonthlyPack(data, month, now);
  const { renderPackWorkbooks } = await import('./monthly-pack.workbooks');
  const files = await renderPackWorkbooks(pack);
  const zip = await zipFiles(files);
  logger.info('Monthly accounts pack generated', { month, passed: pack.passed, files: files.length });
  return { pack, files, zip, zipName: `Youthnic-Accounts-Pack-${month}.zip` };
}

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const inr = (v: number) => `₹${v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function packEmailHtml(pack: MonthlyPack, held: boolean): string {
  const r = pack.roll;
  const rows = ([
    ['Opening outstanding', r.opening], ['+ Sales (delivered)', r.sales], ['− Returns', r.returns],
    ['− Deductions from payouts', r.deductions], ['− Payments received (net of refunds)', r.receipts], ['= Closing outstanding', r.closing],
  ] as Array<[string, number]>).map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0">${k}</td><td style="padding:4px 0;text-align:right">${inr(v)}</td></tr>`).join('');
  const checks = pack.checks.map((c) => `<li style="color:${c.passed ? '#15803d' : '#b91c1c'}">${c.passed ? 'PASS' : 'FAIL'} · ${esc(c.name)}: ${esc(c.detail)}</li>`).join('');
  const warnings = pack.warnings.map((w) => `<li>${esc(w)}</li>`).join('');
  return `<div style="font-family:Calibri,Arial,sans-serif;font-size:14px;color:#334155">
  <p>${held ? '<b style="color:#b91c1c">HELD: not sent to the accounts team because some checks failed.</b><br>' : ''}
  Monthly accounts pack for <b>${esc(pack.label)}</b>, generated ${pack.generatedAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST.</p>
  <p>The ZIP holds five Excel files: 01 Sales (state-wise), 02 Returns (state-wise), 03 Other charges, 04 Order level, 05 Reconciliation. Each opens on an Analytics tab.</p>
  <table style="border-collapse:collapse">${rows}</table>
  <p style="margin-top:16px"><b>Checks</b></p><ul>${checks}</ul>
  ${warnings ? `<p><b>Warnings</b></p><ul>${warnings}</ul>` : ''}
  ${held ? '<p>Fix the failed checks (upload the missing source files on the Payments &amp; Accounts page), then use <b>Monthly Reports → Send to accounts team</b>.</p>' : ''}
</div>`;
}

export interface PackSendResult { month: string; held: boolean; sentTo: string[]; ccTo: string[]; failed: string[]; zipName: string }

/** Hold address for a pack whose checks failed. */
export const packHoldRecipients = (): string[] =>
  (config.accounts.packHoldEmails || '').split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);

/**
 * Email the month's pack. Checks pass (or `force`): to the accounts team, stamped as sent.
 * Checks fail: only to the hold address, stamped as held, so the accounts team never gets an unchecked pack.
 */
export async function sendMonthlyPack(month: string, opts: { force?: boolean; to?: string[]; cc?: string[]; now?: Date } = {}): Promise<PackSendResult> {
  const now = opts.now || new Date();
  const { pack, zip, zipName } = await generateMonthlyPack(month, now);
  const failed = pack.checks.filter((c) => !c.passed).map((c) => `${c.name}: ${c.detail}`);
  const held = !pack.passed && !opts.force;
  const to = held ? packHoldRecipients() : opts.to?.length ? opts.to : await getReportRecipients();
  const cc = held ? [] : opts.cc ?? (await getReportCcRecipients());
  if (!to.length) throw new Error(held ? 'No hold address set (ACCOUNTS_PACK_HOLD_EMAILS).' : 'No report recipients set.');

  await resendService.sendInternalEmail({
    to,
    cc,
    subject: `${held ? 'HOLD · ' : ''}Youthnic accounts pack · ${pack.label}${held ? ` · ${failed.length} check(s) failed` : opts.force && !pack.passed ? ' · sent with failed checks' : ''}`,
    html: packEmailHtml(pack, held),
    attachments: [{ filename: zipName, content: zip }],
  });
  const stamp = JSON.stringify({ [held ? 'heldAt' : 'sentAt']: now.toISOString(), to, cc, failed, forced: Boolean(opts.force && !pack.passed) });
  const key = `${held ? PACK_HELD_PREFIX : PACK_SENT_PREFIX}${month}`;
  await prisma.setting.upsert({ where: { key }, create: { key, value: stamp }, update: { value: stamp } });
  logger.info('Monthly accounts pack emailed', { month, held, to, cc, failed: failed.length });
  return { month, held, sentTo: to, ccTo: cc, failed, zipName };
}

/** When the month's pack went to the team, or was held; null when neither. */
export async function packStatus(month: string): Promise<{ sent: any | null; held: any | null }> {
  const rows = await prisma.setting.findMany({ where: { key: { in: [PACK_SENT_PREFIX + month, PACK_HELD_PREFIX + month] } } });
  const parse = (key: string) => {
    const v = rows.find((r) => r.key === key)?.value;
    if (!v || v.startsWith(CLAIM_PREFIX)) return null;
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  };
  return { sent: parse(PACK_SENT_PREFIX + month), held: parse(PACK_HELD_PREFIX + month) };
}

const REPORT_HOUR_IST = 9;
const CLAIM_PREFIX = 'SENDING:';
const STALE_CLAIM_MS = 30 * 60 * 1000;

/** One sender per month: a SENDING claim on the sent key, retaken only when stale. */
async function claimPackSend(month: string, now: Date): Promise<boolean> {
  const key = PACK_SENT_PREFIX + month;
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

/** Scheduler entry: on/after the report day (09:00 IST) send last month's pack once (to the team, or held). */
export async function sendDueMonthlyPack(now: Date = new Date()): Promise<PackSendResult | null> {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const day = ist.getUTCDate();
  const reportDay = config.accounts.reportDayOfMonth;
  if (day < reportDay || (day === reportDay && ist.getUTCHours() < REPORT_HOUR_IST)) return null;
  const month = previousMonth(now);
  const status = await packStatus(month);
  if (status.sent || status.held) return null;
  if (!(await claimPackSend(month, now))) return null;
  try {
    const result = await sendMonthlyPack(month, { now });
    if (result.held) await prisma.setting.delete({ where: { key: PACK_SENT_PREFIX + month } }).catch(() => undefined);
    return result;
  } catch (error) {
    // Release the claim so the next hourly run tries again.
    await prisma.setting.delete({ where: { key: PACK_SENT_PREFIX + month } }).catch(() => undefined);
    throw error;
  }
}
