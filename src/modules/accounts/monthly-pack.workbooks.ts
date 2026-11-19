/**
 * Renders the monthly pack as five separate Excel files, each opening on an Analytics tab.
 * The channel sheets keep the accounts team's exact "Shopify format" columns for Tally upload.
 */
import { istDay, money, monthRange, sum } from './accounts-report.service';
import { REGISTER_CHANNELS, type RegisterChannel } from './gst-register.service';
import { addAnalyticsSheet, addDataSheet, colourStatus, newWorkbook, type Column } from './report-theme';
import { paymentStatus, type ChargeLine, type GstLine, type LedgerRow, type MonthFigures, type MonthlyPack, type ReturnRow, type SaleRow } from './monthly-pack.service';

const VOUCHER_CODE: Record<RegisterChannel, string> = { 'Delivery-COD': 'DLCOD', 'Velocity-COD': 'VLCOD', 'EaseBuzz-Prepaid': 'EBPP', 'PhonePe-Prepaid': 'PPPP' };
const MAX_SKU_TEXT = 250;

/** The accounts team's columns, in their order. */
const FORMAT_COLUMNS: Column[] = [
  { header: 'Sr No', key: 'srNo', width: 7, type: 'int' },
  { header: 'State', key: 'state', width: 22 },
  { header: 'Taxable Amt', key: 'taxable', width: 14, type: 'money' },
  { header: 'Sum of IGST', key: 'igst', width: 12, type: 'money' },
  { header: 'Sum of CGST', key: 'cgst', width: 12, type: 'money' },
  { header: 'Sum of SGST', key: 'sgst', width: 12, type: 'money' },
  { header: 'Gross Sales (₹)', key: 'gross', width: 15, type: 'money' },
  { header: 'Sum of QTY', key: 'qty', width: 11, type: 'int' },
  { header: 'Voucher No', key: 'voucherNo', width: 20 },
  { header: 'Date', key: 'date', width: 12, type: 'date' },
  { header: 'Skus', key: 'skus', width: 60 },
];

type Taxed = { channel: RegisterChannel; state: string; lines: GstLine[] | null; qty: number };

function skuText(titles: string[]): string {
  const unique = [...new Set(titles.map((t) => t.trim()).filter(Boolean))];
  const shown: string[] = [];
  for (const t of unique) if ([...shown, t].join(', ').length <= MAX_SKU_TEXT) shown.push(t);
  return shown.length < unique.length ? `${shown.join(', ')} (+${unique.length - shown.length} more)` : shown.join(', ');
}

/** State-wise rows for one channel in the exact format. */
function formatRows(items: Taxed[], channel: RegisterChannel | null, prefix: string, month: string): Array<Record<string, any>> {
  const date = istDay(new Date(monthRange(month).end.getTime() - 1));
  const yymm = month.slice(2, 4) + month.slice(5, 7);
  const byState = new Map<string, { taxable: number; igst: number; cgst: number; sgst: number; gross: number; qty: number; titles: string[] }>();
  for (const it of items) {
    if (!it.lines || (channel && it.channel !== channel)) continue;
    const key = it.state.toUpperCase();
    const g = byState.get(key) || { taxable: 0, igst: 0, cgst: 0, sgst: 0, gross: 0, qty: 0, titles: [] };
    for (const l of it.lines) {
      g.taxable += l.taxable; g.igst += l.igst; g.cgst += l.cgst; g.sgst += l.sgst; g.gross += l.amount;
      g.titles.push(...l.titles);
    }
    g.qty += it.qty;
    byState.set(key, g);
  }
  return [...byState.keys()].sort().map((state, i) => {
    const g = byState.get(state)!;
    return {
      srNo: i + 1, state, taxable: money(g.taxable), igst: money(g.igst), cgst: money(g.cgst), sgst: money(g.sgst), gross: money(g.gross),
      qty: g.qty, voucherNo: channel ? `${prefix}${VOUCHER_CODE[channel]}/${yymm}/${String(i + 1).padStart(2, '0')}` : '', date, skus: skuText(g.titles),
    };
  });
}

const total = <T>(rows: T[], f: (r: T) => number) => sum(rows.map(f));
const lineSum = (rows: Array<{ lines: GstLine[] | null }>, k: 'taxable' | 'igst' | 'cgst' | 'sgst') => sum(rows.flatMap((r) => (r.lines || []).map((l) => l[k])));
const share = (part: number, whole: number) => (whole ? part / whole : 0);
const subtitle = (pack: MonthlyPack) => `${pack.label} · generated ${pack.generatedAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`;
const status = (pack: MonthlyPack) => ({
  ok: pack.passed,
  text: pack.passed ? 'All reconciliation checks passed' : `HOLD: ${pack.checks.filter((c) => !c.passed).length} check(s) failed (see 05-Reconciliation)`,
});
const deductible = (f: MonthFigures) => f.returns.filter((r) => r.deducted);

function byChannelTable(rows: Array<{ channel: RegisterChannel; value: number; qty: number }>, valueLabel: string) {
  const all = total(rows, (r) => r.value);
  return {
    heading: 'By channel',
    columns: [
      { header: 'Channel', key: 'channel' }, { header: 'Orders', key: 'count', type: 'int' as const }, { header: 'Qty', key: 'qty', type: 'int' as const },
      { header: valueLabel, key: 'value', type: 'money' as const }, { header: 'Share', key: 'share', type: 'pct' as const },
    ],
    rows: REGISTER_CHANNELS.map((c) => {
      const part = rows.filter((r) => r.channel === c);
      return { channel: c, count: part.length, qty: total(part, (r) => r.qty), value: total(part, (r) => r.value), share: share(total(part, (r) => r.value), all) };
    }),
    barKey: 'value',
  };
}

function byStateTable(rows: Array<{ state: string; value: number; qty: number; lines: GstLine[] | null }>, valueLabel: string) {
  const all = total(rows, (r) => r.value);
  const states = new Map<string, typeof rows>();
  for (const r of rows) states.set(r.state.toUpperCase(), [...(states.get(r.state.toUpperCase()) || []), r]);
  return {
    heading: 'By state',
    columns: [
      { header: 'State', key: 'state' }, { header: 'Orders', key: 'count', type: 'int' as const }, { header: 'Qty', key: 'qty', type: 'int' as const },
      { header: 'Taxable', key: 'taxable', type: 'money' as const }, { header: 'GST', key: 'gst', type: 'money' as const },
      { header: valueLabel, key: 'value', type: 'money' as const }, { header: 'Share', key: 'share', type: 'pct' as const },
    ],
    rows: [...states.entries()].map(([state, part]) => ({
      state, count: part.length, qty: total(part, (r) => r.qty), taxable: lineSum(part, 'taxable'),
      gst: sum([lineSum(part, 'igst'), lineSum(part, 'cgst'), lineSum(part, 'sgst')]), value: total(part, (r) => r.value), share: share(total(part, (r) => r.value), all),
    })).sort((a, b) => b.value - a.value),
    barKey: 'value',
  };
}

const reviewColumns: Column[] = [
  { header: 'Order No', key: 'orderNo', width: 16 }, { header: 'State', key: 'state', width: 18 }, { header: 'Channel', key: 'channel', width: 18 },
  { header: 'Amount (₹)', key: 'value', type: 'money' }, { header: 'Why it is not in the channel sheets', key: 'gstError', width: 70 },
];

// ─── 01 Sales ──────────────────────────────────────────────
async function salesWorkbook(pack: MonthlyPack): Promise<Buffer> {
  const wb = newWorkbook();
  const cur = pack.current.sales;
  const prev = pack.previous.sales;
  const gst = (rows: SaleRow[]) => sum([lineSum(rows, 'igst'), lineSum(rows, 'cgst'), lineSum(rows, 'sgst')]);
  addAnalyticsSheet(wb, {
    title: 'Monthly Sales Report (state-wise)', subtitle: subtitle(pack), status: status(pack),
    kpis: [
      { label: 'Delivered orders (sales)', value: cur.length, previous: prev.length, type: 'int' },
      { label: 'Quantity', value: total(cur, (s) => s.qty), previous: total(prev, (s) => s.qty), type: 'int' },
      { label: 'Taxable value (₹)', value: lineSum(cur, 'taxable'), previous: lineSum(prev, 'taxable'), type: 'money' },
      { label: 'GST (₹)', value: gst(cur), previous: gst(prev), type: 'money' },
      { label: 'Gross sales (₹)', value: total(cur, (s) => s.value), previous: total(prev, (s) => s.value), type: 'money' },
      { label: 'Average order value (₹)', value: cur.length ? money(total(cur, (s) => s.value) / cur.length) : 0, previous: prev.length ? money(total(prev, (s) => s.value) / prev.length) : null, type: 'money' },
      { label: 'Late deliveries from earlier months', value: cur.filter((s) => s.late).length, type: 'int' },
      { label: 'Placed this month, not delivered yet', value: pack.current.inTransit.length, type: 'int' },
    ],
    tables: [byChannelTable(cur, 'Gross sales (₹)'), byStateTable(cur, 'Gross sales (₹)')],
    notes: [
      'Sales = orders placed in the month and delivered (including ones returned later). Cancelled, RTO and exchange-replacement orders are never sales.',
      'An order delivered after its month\'s pack went out is a late delivery in the next pack, keeping its original order date.',
      'GST: apparel slab per piece after discount (5% up to ₹2,500, else 18%); CGST + SGST for Gujarat, IGST for other states. Shipping is taxed with the goods.',
    ],
  });
  for (const c of REGISTER_CHANNELS) addDataSheet(wb, c, FORMAT_COLUMNS, formatRows(cur, c, '', pack.month), { exact: true });
  addDataSheet(wb, 'All Channels', FORMAT_COLUMNS.slice(0, 8), formatRows(cur, null, '', pack.month), { totals: ['taxable', 'igst', 'cgst', 'sgst', 'gross', 'qty'] });
  const review = cur.filter((s) => !s.lines);
  if (review.length) addDataSheet(wb, 'GST Review', reviewColumns, review);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ─── 02 Returns ────────────────────────────────────────────
const eventColumns: Column[] = [
  { header: 'Order No', key: 'orderNo', width: 16 }, { header: 'Order Date', key: 'orderDate', type: 'date', width: 12 },
  { header: 'Date', key: 'initiatedAt', type: 'date', width: 12 }, { header: 'Date Source', key: 'dateNote', width: 26 },
  { header: 'State', key: 'state', width: 18 }, { header: 'Channel', key: 'channel', width: 18 }, { header: 'AWB', key: 'awb', width: 18 },
  { header: 'Order Value (₹)', key: 'value', type: 'money' }, { header: 'Freight (₹)', key: 'charges', type: 'money' },
  { header: 'Reason / Status', key: 'reason', width: 30 },
];
const asDated = (r: ReturnRow) => ({ ...r, orderDate: istDay(r.orderDate), initiatedAt: istDay(r.initiatedAt) });

async function returnsWorkbook(pack: MonthlyPack): Promise<Buffer> {
  const wb = newWorkbook();
  const cur = deductible(pack.current);
  const prev = deductible(pack.previous);
  const salesValue = total(pack.current.sales, (s) => s.value);
  const kinds = (f: MonthFigures, k: ReturnRow['kind']) => f.returns.filter((r) => r.kind === k);
  const reasons = new Map<string, ReturnRow[]>();
  for (const r of cur) reasons.set(r.reason || 'Not given', [...(reasons.get(r.reason || 'Not given') || []), r]);
  addAnalyticsSheet(wb, {
    title: 'Monthly Return Report (state-wise)', subtitle: subtitle(pack), status: status(pack),
    kpis: [
      { label: 'Customer returns initiated', value: cur.length, previous: prev.length, type: 'int' },
      { label: 'Return value deducted (₹)', value: total(cur, (r) => r.value), previous: total(prev, (r) => r.value), type: 'money' },
      { label: 'Returns as % of this month\'s sales', value: share(total(cur, (r) => r.value), salesValue), type: 'pct' },
      { label: 'Returned quantity', value: total(cur, (r) => r.qty), previous: total(prev, (r) => r.qty), type: 'int' },
      { label: 'Exchanges (no sale reversal)', value: kinds(pack.current, 'Exchange').length, previous: kinds(pack.previous, 'Exchange').length, type: 'int' },
      { label: 'RTOs started (listed, not deducted)', value: kinds(pack.current, 'RTO').length, previous: kinds(pack.previous, 'RTO').length, type: 'int' },
      { label: 'RTO order value (₹, not a sale)', value: total(kinds(pack.current, 'RTO'), (r) => r.value), type: 'money' },
      { label: 'Cancellations (listed, not deducted)', value: kinds(pack.current, 'Cancellation').length, previous: kinds(pack.previous, 'Cancellation').length, type: 'int' },
    ],
    tables: [
      byChannelTable(cur, 'Return value (₹)'),
      byStateTable(cur, 'Return value (₹)'),
      {
        heading: 'Top return reasons',
        columns: [{ header: 'Reason', key: 'reason' }, { header: 'Returns', key: 'count', type: 'int' }, { header: 'Value (₹)', key: 'value', type: 'money' }],
        rows: [...reasons.entries()].map(([reason, rs]) => ({ reason, count: rs.length, value: total(rs, (r) => r.value) })).sort((a, b) => b.count - a.count).slice(0, 10),
        barKey: 'count',
      },
    ],
    notes: [
      'Customer returns count in the month they were initiated, whatever the order date. Value: refund paid, else the returned items\' share of the order, else the order value.',
      'Cancellations and RTOs were never delivered, so they were never sales; they are listed here with their value and freight but not deducted.',
      'Exchanges swap an item: the original sale stays, nothing is deducted, the replacement is not a sale. Only their freight counts (03-Other-Charges).',
    ],
  });
  for (const c of REGISTER_CHANNELS) addDataSheet(wb, c, FORMAT_COLUMNS, formatRows(cur, c, 'CN-', pack.month), { exact: true });
  addDataSheet(wb, 'All Channels', FORMAT_COLUMNS.slice(0, 8), formatRows(cur, null, 'CN-', pack.month), { totals: ['taxable', 'igst', 'cgst', 'sgst', 'gross', 'qty'] });
  addDataSheet(wb, 'Customer Returns', [...eventColumns.slice(0, 7), { header: 'Return Value (₹)', key: 'value', type: 'money' }, { header: 'Value Basis', key: 'valueBasis', width: 30 }, { header: 'Refund Status', key: 'refundStatus', width: 12 }, { header: 'Refund Date', key: 'refundDate', type: 'date' }, { header: 'Reverse Freight (₹)', key: 'charges', type: 'money' }, { header: 'Reason', key: 'reason', width: 30 }],
    cur.map((r) => ({ ...asDated(r), refundDate: istDay(r.refundDate) })), { totals: ['value', 'charges'] });
  addDataSheet(wb, 'Cancellations', eventColumns, kinds(pack.current, 'Cancellation').map(asDated), { totals: ['value'] });
  addDataSheet(wb, 'RTO', eventColumns, kinds(pack.current, 'RTO').map(asDated), { totals: ['value', 'charges'] });
  addDataSheet(wb, 'Exchanges', [...eventColumns.slice(0, 7), { header: 'Exchange Freight (₹)', key: 'charges', type: 'money' }, { header: 'Reason', key: 'reason', width: 30 }],
    kinds(pack.current, 'Exchange').map(asDated), { totals: ['charges'] });
  const review = cur.filter((r) => !r.lines);
  if (review.length) addDataSheet(wb, 'GST Review', reviewColumns, review);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ─── 03 Other charges ──────────────────────────────────────
const CATEGORIES: ChargeLine['category'][] = ['Gateway', 'Forward', 'RTO', 'Reverse', 'Exchange'];

async function chargesWorkbook(pack: MonthlyPack): Promise<Buffer> {
  const wb = newWorkbook();
  const actual = (f: MonthFigures) => f.charges.filter((c) => c.actual);
  const cur = actual(pack.current);
  const prev = actual(pack.previous);
  const salesValue = total(pack.current.sales, (s) => s.value);
  const summary = CATEGORIES.flatMap((category) =>
    [...new Set(pack.current.charges.filter((c) => c.category === category).map((c) => c.provider))].map((provider) => {
      const all = pack.current.charges.filter((c) => c.category === category && c.provider === provider);
      const ok = all.filter((c) => c.actual);
      return {
        category, provider, lines: ok.length, taxable: total(ok, (c) => c.taxable), gst: total(ok, (c) => c.gst), total: total(ok, (c) => c.total),
        pctSales: share(total(ok, (c) => c.total), salesValue), pending: all.length - ok.length, pendingAmount: total(all.filter((c) => !c.actual), (c) => c.total),
      };
    })
  );
  const cat = (rows: ChargeLine[], k: ChargeLine['category']) => total(rows.filter((c) => c.category === k), (c) => c.total);
  addAnalyticsSheet(wb, {
    title: 'Monthly Other Charges Report', subtitle: subtitle(pack), status: status(pack),
    kpis: [
      { label: 'Total charges, actual (₹)', value: total(cur, (c) => c.total), previous: total(prev, (c) => c.total), type: 'money' },
      { label: 'Charges as % of sales', value: share(total(cur, (c) => c.total), salesValue), type: 'pct' },
      ...CATEGORIES.map((k) => ({ label: `${k === 'Gateway' ? 'Payment gateway' : `${k} shipping`} (₹)`, value: cat(cur, k), previous: cat(prev, k), type: 'money' as const })),
      { label: 'Input GST on charges (₹)', value: total(cur, (c) => c.gst), previous: total(prev, (c) => c.gst), type: 'money' },
      { label: 'Lines not yet billed (excluded)', value: pack.current.charges.length - cur.length, type: 'int' },
    ],
    tables: [
      {
        heading: 'By category and provider',
        columns: [
          { header: 'Category', key: 'category' }, { header: 'Provider', key: 'provider' }, { header: 'Lines', key: 'lines', type: 'int' },
          { header: 'Taxable', key: 'taxable', type: 'money' }, { header: 'GST', key: 'gst', type: 'money' }, { header: 'Total', key: 'total', type: 'money' },
          { header: '% of sales', key: 'pctSales', type: 'pct' },
        ],
        rows: summary,
        barKey: 'total',
      },
      {
        heading: 'Provider bills vs our books',
        columns: [
          { header: 'Provider', key: 'label' }, { header: 'Bill total', key: 'invoiceTotal', type: 'money' }, { header: 'Our books', key: 'books', type: 'money' },
          { header: 'Variance', key: 'variance', type: 'money' }, { header: 'Status', key: 'status' },
        ],
        rows: pack.current.bills.map((b) => ({ label: b.label, invoiceTotal: b.invoices.length ? b.invoiceTotal : '', books: b.consumption.total, variance: b.variance ?? '', status: b.status === 'MATCHED' ? 'Matched' : b.status === 'VARIANCE' ? 'Variance' : 'Bill not entered' })),
      },
    ],
    notes: [
      'Only actual billed figures are totalled; estimates and missing charges are listed on the Detail tab (Actual = No) and in 05-Reconciliation → Data Gaps.',
      'Gateway: Easebuzz (GoKwik) per-transaction fee + GST from the settlement files, by transaction date; PhonePe fee recorded on each settled order. Freight: per AWB, forward by manifest date, RTO by first RTO scan, reverse and exchange by return date. GST on freight split at 18%.',
      'COD charges: Delhivery and Velocity include them in the per-AWB freight and do not itemise them, so they sit inside forward shipping.',
      'Courier freight is paid from the prepaid wallet, so it is an expense and not a deduction from COD remittances.',
    ],
  });
  addDataSheet(wb, 'Summary', [
    { header: 'Category', key: 'category', width: 12 }, { header: 'Provider', key: 'provider', width: 12 }, { header: 'Actual Lines', key: 'lines', type: 'int' },
    { header: 'Taxable (₹)', key: 'taxable', type: 'money' }, { header: 'GST (₹)', key: 'gst', type: 'money' }, { header: 'Total (₹)', key: 'total', type: 'money' },
    { header: '% of Sales', key: 'pctSales', type: 'pct' }, { header: 'Not Billed Yet (lines)', key: 'pending', type: 'int' }, { header: 'Not Billed Yet (₹, excluded)', key: 'pendingAmount', type: 'money' },
  ], summary, { totals: ['taxable', 'gst', 'total', 'pendingAmount'] });
  addDataSheet(wb, 'Detail', [
    { header: 'Category', key: 'category', width: 11 }, { header: 'Provider', key: 'provider', width: 11 }, { header: 'Order No', key: 'orderNo', width: 16 },
    { header: 'AWB / Transaction', key: 'reference', width: 26 }, { header: 'Date', key: 'date', type: 'date' }, { header: 'Taxable (₹)', key: 'taxable', type: 'money' },
    { header: 'GST (₹)', key: 'gst', type: 'money' }, { header: 'Total (₹)', key: 'total', type: 'money' }, { header: 'Actual', key: 'actualText', width: 8 }, { header: 'Basis', key: 'basis', width: 34 },
  ], pack.current.charges.map((c) => ({ ...c, date: istDay(c.date), actualText: c.actual ? 'Yes' : 'No' })), { totals: ['taxable', 'gst', 'total'] });
  addDataSheet(wb, 'Provider Bills', [
    { header: 'Provider', key: 'label', width: 12 }, { header: 'Invoice No(s)', key: 'invoiceNos', width: 26 }, { header: 'Bill Taxable (₹)', key: 'invoiceTaxable', type: 'money' },
    { header: 'Bill GST (₹)', key: 'invoiceGst', type: 'money' }, { header: 'Bill Total (₹)', key: 'invoiceTotal', type: 'money' }, { header: 'Books Taxable (₹)', key: 'bookTaxable', type: 'money' },
    { header: 'Books GST (₹)', key: 'bookGst', type: 'money' }, { header: 'Books Total (₹)', key: 'bookTotal', type: 'money' }, { header: 'Variance (₹)', key: 'variance', type: 'money' },
    { header: 'Status', key: 'status', width: 16 }, { header: 'Tally: Bill Credited To', key: 'party', width: 30 }, { header: 'Tally: Nullify Against', key: 'against', width: 32 },
  ], pack.current.bills.map((b) => ({
    label: b.label, invoiceNos: b.invoices.map((i) => i.invoiceNumber).join(', '), invoiceTaxable: b.invoiceTaxable, invoiceGst: b.invoiceGst, invoiceTotal: b.invoiceTotal,
    bookTaxable: b.consumption.taxable, bookGst: b.consumption.gst, bookTotal: b.consumption.total, variance: b.variance,
    status: b.status === 'MATCHED' ? 'Matched' : b.status === 'VARIANCE' ? 'Variance' : 'Bill not entered', party: b.ledgers.partyLedger, against: b.ledgers.consumedFromLedger,
  })));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ─── 04 Order level ────────────────────────────────────────
async function orderLevelWorkbook(pack: MonthlyPack): Promise<Buffer> {
  const wb = newWorkbook();
  const { start, end } = monthRange(pack.month);
  // Orders placed this month plus late deliveries recognised this month.
  const cohort = pack.ledger.filter((l) => l.saleMonth === pack.month || (new Date(l.order.shopifyCreatedAt) >= start && new Date(l.order.shopifyCreatedAt) < end));
  const statuses = new Map<string, LedgerRow[]>();
  for (const l of cohort) statuses.set(paymentStatus(l), [...(statuses.get(paymentStatus(l)) || []), l]);
  const kinds = (k: ReturnRow['kind']) => pack.current.returns.filter((r) => r.kind === k).length;
  addAnalyticsSheet(wb, {
    title: 'Order-Level Detailed Report', subtitle: subtitle(pack), status: status(pack),
    kpis: [
      { label: 'A · Delivered orders (sales)', value: pack.current.sales.length, previous: pack.previous.sales.length, type: 'int' },
      { label: 'B · Customer returns', value: kinds('Customer return'), type: 'int' },
      { label: 'B · RTOs', value: kinds('RTO'), type: 'int' },
      { label: 'B · Cancellations', value: kinds('Cancellation'), type: 'int' },
      { label: 'B · Exchanges', value: kinds('Exchange'), type: 'int' },
      { label: 'C · Orders reconciled', value: cohort.length, type: 'int' },
      { label: 'C · Outstanding today (₹)', value: total(cohort, (l) => l.today.outstanding), type: 'money' },
    ],
    tables: [{
      heading: 'C · Payment status of this month\'s orders',
      columns: [{ header: 'Status', key: 'status' }, { header: 'Orders', key: 'count', type: 'int' }, { header: 'Outstanding today (₹)', key: 'amount', type: 'money' }],
      rows: [...statuses.entries()].map(([s, ls]) => ({ status: s, count: ls.length, amount: total(ls, (l) => l.today.outstanding) })).sort((a, b) => b.count - a.count),
      barKey: 'count',
    }],
    notes: ['Section C covers orders placed this month plus late deliveries recognised this month. Expected payment = sale − returns − payout deductions; outstanding = expected − received (net of refunds).'],
  });

  addDataSheet(wb, 'A Delivered (Sales)', [
    { header: 'Order No', key: 'orderNo', width: 16 }, { header: 'Order Date', key: 'orderDate', type: 'date' }, { header: 'Delivery Date', key: 'deliveredAt', type: 'date' },
    { header: 'State', key: 'state', width: 18 }, { header: 'Channel', key: 'channel', width: 17 }, { header: 'Payment Method', key: 'paymentMethod', width: 10 },
    { header: 'Qty', key: 'qty', type: 'int' }, { header: 'Order Value (₹)', key: 'value', type: 'money' }, { header: 'Taxable (₹)', key: 'taxable', type: 'money' },
    { header: 'IGST (₹)', key: 'igst', type: 'money' }, { header: 'CGST (₹)', key: 'cgst', type: 'money' }, { header: 'SGST (₹)', key: 'sgst', type: 'money' },
    { header: 'GST Rate', key: 'rate', width: 9 }, { header: 'Shopify/GoKwik Tax Line Rate', key: 'shopifyRate', width: 14 }, { header: 'Note', key: 'note', width: 40 },
  ], pack.current.sales.map((s) => ({
    ...s, orderDate: istDay(s.orderDate), deliveredAt: istDay(s.deliveredAt),
    taxable: lineSum([s], 'taxable'), igst: lineSum([s], 'igst'), cgst: lineSum([s], 'cgst'), sgst: lineSum([s], 'sgst'),
    rate: s.lines ? s.lines.map((l) => `${l.rate}%`).join(' + ') : 'Review', shopifyRate: s.shopifyRate === null ? 'none' : s.shopifyRate === -1 ? 'mixed' : `${s.shopifyRate}%`,
    note: [s.late ? 'Late delivery from an earlier month' : '', s.gstError || ''].filter(Boolean).join('; '),
  })), { totals: ['qty', 'value', 'taxable', 'igst', 'cgst', 'sgst'] });

  addDataSheet(wb, 'B Returns', [
    { header: 'Order No', key: 'orderNo', width: 16 }, { header: 'Original Order Date', key: 'orderDate', type: 'date' }, { header: 'Initiated Date', key: 'initiatedAt', type: 'date' },
    { header: 'Type', key: 'kind', width: 15 }, { header: 'State', key: 'state', width: 18 }, { header: 'Channel', key: 'channel', width: 17 },
    { header: 'Return / Refund Amount (₹)', key: 'value', type: 'money' }, { header: 'Deducted From Sales', key: 'deductedText', width: 10 }, { header: 'Value Basis', key: 'valueBasis', width: 30 },
    { header: 'Refund Status', key: 'refundStatus', width: 12 }, { header: 'Refund Date', key: 'refundDate', type: 'date' }, { header: 'AWB', key: 'awb', width: 18 },
    { header: 'Charges (₹)', key: 'charges', type: 'money' }, { header: 'Reason / Status', key: 'reason', width: 30 }, { header: 'Date Source', key: 'dateNote', width: 26 },
  ], pack.current.returns.map((r) => ({ ...asDated(r), refundDate: istDay(r.refundDate), deductedText: r.deducted ? 'Yes' : 'No' })), { totals: ['charges'] });

  const cRows = cohort.map((l) => {
    const o = l.order;
    const s = o.shipment || {};
    const customer = (o.returns || []).filter((r: any) => !r.isExchange && r.returnStatus !== 'CANCELLED');
    const exchanges = (o.returns || []).filter((r: any) => r.isExchange);
    const deductions = l.today.deductions;
    return {
      orderNo: o.shopifyOrderName, orderDate: istDay(o.shopifyCreatedAt), status: o.status, paymentMethod: o.paymentMethod === 'COD' ? 'COD' : 'Prepaid',
      partner: s.courier || '', forwardAwb: s.waybillNumber || '', forwardCharge: s.forwardCharge ?? null, rtoCharge: s.rtoCharge ?? null,
      reverseAwb: customer.map((r: any) => r.returnWaybillNumber).filter(Boolean).join(', '), reverseCharge: customer.length ? sum(customer.map((r: any) => r.shippingCharge)) : null,
      exchangeAwb: exchanges.flatMap((r: any) => [r.returnWaybillNumber, r.exchangeForwardAwb]).filter(Boolean).join(', '),
      exchangeCharge: exchanges.length ? sum(exchanges.map((r: any) => r.shippingCharge)) : null,
      gatewayFee: o.gatewayFee ?? null, deductions, sale: l.today.sales, returns: l.today.returns,
      expected: money(l.today.sales - l.today.returns - deductions), received: l.today.receipts, receivedOn: istDay(o.paymentReceivedAt),
      utr: o.paymentReceivedUtr || '', ref: o.paymentReceivedRef || '', outstanding: l.today.outstanding, monthEnd: l.closing, recon: paymentStatus(l),
    };
  });
  const cSheet = addDataSheet(wb, 'C AWB-Charges-Payment', [
    { header: 'Order No', key: 'orderNo', width: 16 }, { header: 'Order Date', key: 'orderDate', type: 'date' }, { header: 'Order Status', key: 'status', width: 16 },
    { header: 'Payment Method', key: 'paymentMethod', width: 10 }, { header: 'Logistics Partner', key: 'partner', width: 12 }, { header: 'Forward AWB', key: 'forwardAwb', width: 17 },
    { header: 'Forward (₹)', key: 'forwardCharge', type: 'money' }, { header: 'RTO (₹)', key: 'rtoCharge', type: 'money' }, { header: 'Reverse AWB', key: 'reverseAwb', width: 17 },
    { header: 'Reverse (₹)', key: 'reverseCharge', type: 'money' }, { header: 'Exchange AWBs', key: 'exchangeAwb', width: 26 }, { header: 'Exchange Reverse (₹)', key: 'exchangeCharge', type: 'money' },
    { header: 'Gateway Fee (₹)', key: 'gatewayFee', type: 'money' }, { header: 'Payout Deductions (₹)', key: 'deductions', type: 'money' }, { header: 'Sale (₹)', key: 'sale', type: 'money' },
    { header: 'Returns (₹)', key: 'returns', type: 'money' }, { header: 'Expected Payment (₹)', key: 'expected', type: 'money' }, { header: 'Actual Received, net of refunds (₹)', key: 'received', type: 'money' },
    { header: 'Received On', key: 'receivedOn', type: 'date' }, { header: 'UTR', key: 'utr', width: 22 }, { header: 'Settlement / Remittance Ref', key: 'ref', width: 22 },
    { header: 'Outstanding Today (₹)', key: 'outstanding', type: 'money' }, { header: 'Outstanding at Month End (₹)', key: 'monthEnd', type: 'money' }, { header: 'Reconciliation Status', key: 'recon', width: 24 },
  ], cRows, { totals: ['forwardCharge', 'rtoCharge', 'reverseCharge', 'exchangeCharge', 'gatewayFee', 'deductions', 'sale', 'returns', 'expected', 'received', 'outstanding', 'monthEnd'] });
  colourStatus(cSheet, 'recon');
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ─── 05 Reconciliation ─────────────────────────────────────
async function reconciliationWorkbook(pack: MonthlyPack): Promise<Buffer> {
  const wb = newWorkbook();
  const r = pack.roll;
  const open = pack.ledger.filter((l) => Math.abs(l.closing) > 1);
  const byMonth = new Map<string, LedgerRow[]>();
  for (const l of open) {
    const m = l.saleMonth || 'No sale (advance/refund)';
    byMonth.set(m, [...(byMonth.get(m) || []), l]);
  }
  addAnalyticsSheet(wb, {
    title: 'Reconciliation & Validation', subtitle: subtitle(pack), status: status(pack),
    kpis: [
      { label: 'Opening outstanding (₹)', value: r.opening, type: 'money' },
      { label: '+ Sales (₹)', value: r.sales, type: 'money' },
      { label: '− Returns (₹)', value: r.returns, type: 'money' },
      { label: '− Deductions from payouts (₹)', value: r.deductions, type: 'money' },
      { label: '− Payments received, net of refunds (₹)', value: r.receipts, type: 'money' },
      { label: '= Closing outstanding (₹)', value: r.closing, type: 'money' },
      { label: 'Collected in the month vs sales', value: share(r.receipts, r.sales), type: 'pct' },
      { label: 'Checks passed', value: `${pack.checks.filter((c) => c.passed).length} of ${pack.checks.length}` },
    ],
    tables: [{
      heading: 'Closing outstanding by sale month',
      columns: [{ header: 'Sale month', key: 'month' }, { header: 'Orders', key: 'count', type: 'int' }, { header: 'Outstanding (₹)', key: 'amount', type: 'money' }],
      rows: [...byMonth.entries()].map(([month, ls]) => ({ month, count: ls.length, amount: total(ls, (l) => l.closing) })).sort((a, b) => a.month.localeCompare(b.month)),
      barKey: 'amount',
    }],
    notes: [
      'Formula: Opening + Sales − Returns − Deductions taken from payouts − Payments received (net of refunds paid) = Closing outstanding.',
      'Deductions = gateway fees kept by Easebuzz/PhonePe and any shortfall on a COD remittance. Courier freight is paid from the wallet, so it is a memo line, not a deduction.',
      'Negative outstanding = money received before delivery, or a refund not yet recorded.',
    ],
  });
  addDataSheet(wb, 'Roll-forward', [
    { header: 'Line', key: 'line', width: 44 }, { header: 'Amount (₹)', key: 'amount', type: 'money', width: 16 }, { header: 'Source', key: 'note', width: 60 },
  ], [
    { line: 'Opening outstanding', amount: r.opening, note: 'Order-level outstanding at the end of the previous month' },
    { line: '+ Sales (delivered)', amount: r.sales, note: '01-Sales total' },
    { line: '− Returns (customer returns)', amount: r.returns, note: '02-Returns total (cancellations and RTOs are not sales)' },
    { line: '− Deductions from payouts', amount: r.deductions, note: 'Gateway fees on settlements dated this month; COD remittance shortfalls' },
    { line: '− Payments received (net of refunds paid)', amount: r.receipts, note: 'Settlements and COD remittances dated this month, less refund debits' },
    { line: '= Closing outstanding', amount: r.closing, note: 'Must equal the sum of order-level outstanding (check 1)' },
    { line: 'Memo: courier freight paid from wallet', amount: r.walletFreight, note: '03-Other-Charges, freight categories (actual)' },
  ]);
  const checks = addDataSheet(wb, 'Checks', [
    { header: 'No', key: 'id', type: 'int', width: 5 }, { header: 'Check', key: 'name', width: 52 }, { header: 'Result', key: 'result', width: 9 }, { header: 'Detail', key: 'detail', width: 90 },
  ], pack.checks.map((c) => ({ ...c, result: c.passed ? 'PASS' : 'FAIL' })));
  colourStatus(checks, 'result');
  addDataSheet(wb, 'Warnings', [{ header: 'Warning (does not hold the send)', key: 'text', width: 110 }], pack.warnings.map((text) => ({ text })));
  addDataSheet(wb, 'Data Gaps', [
    { header: 'Area', key: 'area', width: 18 }, { header: 'Order No', key: 'orderNo', width: 16 }, { header: 'Reference', key: 'reference', width: 24 },
    { header: 'Issue', key: 'issue', width: 60 }, { header: 'Amount (₹)', key: 'amount', type: 'money' },
  ], pack.gaps);
  addDataSheet(wb, 'Order Outstanding', [
    { header: 'Order No', key: 'orderNo', width: 16 }, { header: 'Sale Month', key: 'saleMonth', width: 11 }, { header: 'Opening (₹)', key: 'opening', type: 'money' },
    { header: 'Sales (₹)', key: 'sales', type: 'money' }, { header: 'Returns (₹)', key: 'returns', type: 'money' }, { header: 'Deductions (₹)', key: 'deductions', type: 'money' },
    { header: 'Receipts (₹)', key: 'receipts', type: 'money' }, { header: 'Closing (₹)', key: 'closing', type: 'money' },
  ], pack.ledger.filter((l) => Math.abs(l.opening) > 0.005 || Math.abs(l.closing) > 0.005 || l.sales || l.returns || l.deductions || l.receipts)
    .map((l) => ({ ...l, orderNo: l.order.shopifyOrderName, saleMonth: l.saleMonth || '—' })), { totals: ['opening', 'sales', 'returns', 'deductions', 'receipts', 'closing'] });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export const PACK_FILES = ['01-Sales-Statewise', '02-Returns-Statewise', '03-Other-Charges', '04-Order-Level', '05-Reconciliation'] as const;

export async function renderPackWorkbooks(pack: MonthlyPack): Promise<Array<{ name: string; buffer: Buffer }>> {
  const builders = [salesWorkbook, returnsWorkbook, chargesWorkbook, orderLevelWorkbook, reconciliationWorkbook];
  const buffers = await Promise.all(builders.map((b) => b(pack)));
  return PACK_FILES.map((name, i) => ({ name: `${name}-${pack.month}.xlsx`, buffer: buffers[i] }));
}
