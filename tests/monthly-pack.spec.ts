/**
 * Monthly accounts pack: sale recognition (placed + delivered, late deliveries), return values,
 * exchanges not double-counted, the roll-forward tying to order level, the five themed workbooks,
 * and the hold path that keeps an unchecked pack away from the accounts team.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ExcelJS from 'exceljs';

vi.mock('../src/utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { prismaStub, resendStub } = vi.hoisted(() => ({
  prismaStub: {
    order: { findMany: vi.fn(async () => []) },
    trackingLog: { groupBy: vi.fn(async () => []) },
    shipment: { findMany: vi.fn(async () => []) },
    gatewaySettlementOrder: { findMany: vi.fn(async () => []) },
    gatewaySettlementRefund: { findMany: vi.fn(async () => []) },
    providerInvoice: { findMany: vi.fn(async () => []) },
    setting: { findMany: vi.fn(async () => []), findUnique: vi.fn(async () => null), upsert: vi.fn(async () => ({})), create: vi.fn(async () => ({})), delete: vi.fn(async () => ({})), updateMany: vi.fn(async () => ({ count: 0 })) },
  },
  resendStub: { sendInternalEmail: vi.fn(async () => ({ id: 'em_1' })) },
}));
vi.mock('../src/database/prisma', () => ({ default: prismaStub }));
vi.mock('../src/modules/email/resend.service', () => ({ default: resendStub }));

import {
  buildMonthlyPack,
  returnValue,
  saleMonth,
  sendDueMonthlyPack,
  sendMonthlyPack,
  zipFiles,
  type PackData,
} from '../src/modules/accounts/monthly-pack.service';
import { renderPackWorkbooks } from '../src/modules/accounts/monthly-pack.workbooks';

const NOW = new Date('2026-11-15T05:00:00Z'); // 15 Nov 10:30 IST
const IST = (d: string) => new Date(`${d}T12:00:00+05:30`);
let nextId = 1;

function order(o: Record<string, any> = {}) {
  const id = nextId++;
  return {
    id,
    shopifyOrderId: String(id),
    shopifyOrderName: `#26YOU${id}`,
    shopifyCreatedAt: IST('2026-10-05'),
    customerState: 'Gujarat',
    paymentMethod: 'COD',
    status: 'DELIVERED',
    totalAmount: 1050,
    totalDiscounts: 0,
    deliveredAt: IST('2026-10-09'),
    items: [{ title: 'Kurta set', price: 1050, quantity: 1 }],
    shipment: { id: id * 10, courier: 'Delhivery', waybillNumber: `D${id}`, status: 'DELIVERED', forwardCharge: 70.8, shippingCostSource: 'ACTUAL', rtoCharge: null, rtoChargeSource: null, createdAt: IST('2026-10-05'), omsManifestedAt: IST('2026-10-05') },
    returns: [],
    ...o,
  };
}

function data(orders: any[], extra: Partial<PackData> = {}): PackData {
  return {
    orders,
    rtoStart: new Map(),
    replacementShipments: new Map(),
    settlementRows: [],
    gatewayRefunds: [],
    invoices: [],
    sentAt: new Map(),
    ...extra,
  };
}

describe('sale recognition', () => {
  it('is the month placed when delivered before that pack went out, else a late delivery next month', () => {
    const sent = new Map([['2026-10', IST('2026-11-15')]]);
    expect(saleMonth(order(), sent, NOW)).toBe('2026-10');
    expect(saleMonth(order({ deliveredAt: IST('2026-11-14') }), sent, NOW)).toBe('2026-10');
    expect(saleMonth(order({ deliveredAt: IST('2026-11-20') }), sent, new Date('2026-12-01'))).toBe('2026-11');
    expect(saleMonth(order({ deliveredAt: null, status: 'IN_TRANSIT' }), sent, NOW)).toBeNull();
    expect(saleMonth(order({ status: 'CANCELLED' }), sent, NOW)).toBeNull();
    expect(saleMonth(order({ status: 'RTO_DELIVERED' }), sent, NOW)).toBeNull();
    expect(saleMonth(order({ paymentMethod: 'EXCHANGE', shopifyOrderId: 'EX-FWD-1', totalAmount: 0 }), sent, NOW)).toBeNull();
  });
});

describe('return value', () => {
  const o = order({ totalAmount: 2100, items: [{ id: 1, title: 'Kurta', price: 1000, quantity: 1 }, { id: 2, title: 'Saree', price: 1000, quantity: 1 }] });
  it('uses the refund paid, else the returned items share, else the order value', () => {
    expect(returnValue({ refundStatus: 'PROCESSED', refundAmount: 999, items: [] }, o)).toMatchObject({ value: 999, basis: 'Refund processed' });
    expect(returnValue({ refundStatus: 'NONE', items: [{ quantity: 1, orderItem: { price: 1000, title: 'Kurta' } }] }, o)).toMatchObject({ value: 1050, qty: 1 });
    expect(returnValue({ refundStatus: 'NONE', items: [] }, o)).toMatchObject({ value: 2100, basis: 'Order value (no item detail)' });
  });
});

describe('monthly pack', () => {
  beforeEach(() => {
    nextId = 1;
  });

  function october() {
    const cod = order({ paymentReceivedAt: IST('2026-10-20'), paymentReceivedAmount: 1050, paymentReceivedUtr: 'UTR1' });
    const prepaid = order({
      customerState: 'Karnataka', paymentMethod: 'Pre-paid', paymentProvider: 'Easebuzz', paymentAggregator: 'GoKwik', totalAmount: 2100,
      items: [{ title: 'Saree', price: 2100, quantity: 1 }], paymentReceivedAt: IST('2026-10-05'), paymentReceivedAmount: 2050, gatewayFee: 50, paymentReceivedUtr: 'UTR2',
    });
    const exchanged = order({
      status: 'EXCHANGE_REQUESTED', paymentReceivedAt: IST('2026-10-21'), paymentReceivedAmount: 1050, paymentReceivedUtr: 'UTR3',
      returns: [{ id: 91, isExchange: true, returnStatus: 'RECEIVED', returnWaybillNumber: 'R1', shippingCharge: 80, shippingCostSource: 'ACTUAL', exchangeForwardAwb: 'V9', carrier: 'Delhivery', createdAt: IST('2026-10-15'), items: [] }],
    });
    const replacement = order({ shopifyOrderId: 'EX-FWD-3', paymentMethod: 'EXCHANGE', totalAmount: 0, deliveredAt: IST('2026-10-20'), items: [{ title: 'Kurta set', price: 0, quantity: 1 }] });
    const returned = order({
      customerState: 'Maharashtra', paymentReceivedAt: IST('2026-10-22'), paymentReceivedAmount: 1050, paymentReceivedUtr: 'UTR4',
      returns: [{ id: 92, isExchange: false, returnStatus: 'RECEIVED', refundStatus: 'PROCESSED', refundAmount: 1050, refundProcessedAt: IST('2026-10-28'), returnWaybillNumber: 'R2', shippingCharge: 60, shippingCostSource: 'ACTUAL', carrier: 'Delhivery', createdAt: IST('2026-10-25'), items: [] }],
    });
    const cancelled = order({ status: 'CANCELLED', deliveredAt: null, cancelledAt: IST('2026-10-06'), shipment: null });
    const rto = order({ status: 'RTO_DELIVERED', deliveredAt: null, shipment: { id: 700, courier: 'Delhivery', waybillNumber: 'D7', status: 'RTO_DELIVERED', forwardCharge: 70.8, shippingCostSource: 'ACTUAL', rtoCharge: 59, rtoChargeSource: 'ACTUAL', createdAt: IST('2026-10-05'), omsManifestedAt: IST('2026-10-05'), updatedAt: IST('2026-10-30') } });
    const sept = order({ shopifyCreatedAt: IST('2026-09-28'), deliveredAt: IST('2026-09-30'), shipment: null });
    return {
      orders: { cod, prepaid, exchanged, replacement, returned, cancelled, rto, sept },
      data: data([sept, cod, prepaid, exchanged, replacement, returned, cancelled, rto], {
        rtoStart: new Map([[700, IST('2026-10-12')]]),
        replacementShipments: new Map([['V9', { waybillNumber: 'V9', courier: 'Velocity', forwardCharge: 90, rtoCharge: null, shippingCostSource: 'ACTUAL', rtoChargeSource: null }]]),
        settlementRows: [{ id: 1, orderId: 2, easebuzzTrxnId: 'E1', serviceCharge: 42.37, gst: 7.63, transactionDate: IST('2026-10-05'), status: 'MATCHED' }],
      }),
    };
  }

  it('counts delivered sales once, keeps exchanges out of sales and returns, and lists cancellations/RTOs without deducting', () => {
    const { data: d } = october();
    const pack = buildMonthlyPack(d, '2026-10', NOW);
    const sales = pack.current.sales;
    expect(sales.map((s) => s.orderNo)).toEqual(['#26YOU1', '#26YOU2', '#26YOU3', '#26YOU5']); // not the replacement, cancelled, RTO or September order
    expect(sales.every((s) => s.lines?.every((l) => l.rate === 5))).toBe(true);
    const gujarat = sales.find((s) => s.orderNo === '#26YOU1')!.lines![0];
    expect(gujarat).toMatchObject({ igst: 0, cgst: 25, sgst: 25, taxable: 1000 });
    expect(sales.find((s) => s.orderNo === '#26YOU2')!.lines![0]).toMatchObject({ igst: 100, cgst: 0 });

    const kinds = pack.current.returns.map((r) => [r.kind, r.deducted, r.value]);
    expect(kinds).toEqual(expect.arrayContaining([['Exchange', false, 0], ['Customer return', true, 1050], ['Cancellation', false, 1050], ['RTO', false, 1050]]));
    expect(pack.current.returns.filter((r) => r.deducted)).toHaveLength(1);

    const cat = (c: string) => pack.current.charges.filter((x) => x.category === c).reduce((t, x) => t + x.total, 0);
    expect(cat('Exchange')).toBeCloseTo(170, 2); // reverse 80 + replacement 90
    expect(cat('RTO')).toBe(59);
    expect(cat('Reverse')).toBe(60);
    const gw = pack.current.charges.filter((x) => x.category === 'Gateway');
    expect(gw).toHaveLength(1);
    expect(gw[0]).toMatchObject({ provider: 'EASEBUZZ', taxable: 42.37, gst: 7.63, total: 50, actual: true }); // split from the settlement row
  });

  it('rolls forward Opening + Sales − Returns − Deductions − Receipts = Closing, tied to order level', () => {
    const { data: d } = october();
    const pack = buildMonthlyPack(d, '2026-10', NOW);
    expect(pack.roll).toMatchObject({ opening: 1050, sales: 5250, returns: 1050, deductions: 50 });
    // receipts: 1050 + 2050 + 1050 + 1050 − refund 1050 = 4150
    expect(pack.roll.receipts).toBe(4150);
    expect(pack.roll.closing).toBe(1050); // only the September order is still unpaid
    expect(pack.checks.find((c) => c.id === 1)!.passed).toBe(true);
    expect(pack.checks.find((c) => c.id === 2)!.passed).toBe(true);
    const cod = pack.ledger.find((l) => l.order.shopifyOrderName === '#26YOU1')!;
    expect(cod.today.outstanding).toBe(0);
  });

  it('fails the charge check when a leg is only an estimate, and holds the pack', () => {
    const { data: d, orders } = october();
    orders.rto.shipment.rtoChargeSource = 'ESTIMATE';
    const pack = buildMonthlyPack(d, '2026-10', NOW);
    expect(pack.checks.find((c) => c.id === 4)!.passed).toBe(false);
    expect(pack.passed).toBe(false);
    expect(pack.gaps.some((g) => g.area === 'RTO charge')).toBe(true);
  });

  it('renders five separate workbooks, each opening on Analytics, with the exact Shopify-format channel sheets', async () => {
    const { data: d } = october();
    const files = await renderPackWorkbooks(buildMonthlyPack(d, '2026-10', NOW));
    expect(files.map((f) => f.name)).toEqual([
      '01-Sales-Statewise-2026-10.xlsx', '02-Returns-Statewise-2026-10.xlsx', '03-Other-Charges-2026-10.xlsx', '04-Order-Level-2026-10.xlsx', '05-Reconciliation-2026-10.xlsx',
    ]);
    const books = await Promise.all(files.map(async (f) => {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(f.buffer);
      return wb;
    }));
    for (const wb of books) expect(wb.worksheets[0].name).toBe('Analytics');
    expect(books[0].worksheets.map((w) => w.name)).toEqual(['Analytics', 'Delivery-COD', 'Velocity-COD', 'EaseBuzz-Prepaid', 'PhonePe-Prepaid', 'All Channels']);
    expect((books[0].getWorksheet('Delivery-COD')!.getRow(1).values as any[]).slice(1)).toEqual([
      'Sr No', 'State', 'Taxable Amt', 'Sum of IGST', 'Sum of CGST', 'Sum of SGST', 'Gross Sales (₹)', 'Sum of QTY', 'Voucher No', 'Date', 'Skus',
    ]);
    expect(books[0].getWorksheet('Delivery-COD')!.getRow(2).getCell(9).value).toBe('DLCOD/2610/01');
    expect(books[3].worksheets.map((w) => w.name)).toEqual(['Analytics', 'A Delivered (Sales)', 'B Returns', 'C AWB-Charges-Payment']);
    expect(books[4].worksheets.map((w) => w.name)).toEqual(['Analytics', 'Roll-forward', 'Checks', 'Warnings', 'Data Gaps', 'Order Outstanding']);
    const zip = await zipFiles(files);
    expect(zip.subarray(0, 2).toString()).toBe('PK');
  });
});

describe('sending the pack', () => {
  beforeEach(() => {
    nextId = 1;
    for (const group of [...Object.values(prismaStub), resendStub]) for (const fn of Object.values(group)) (fn as any).mockClear();
    prismaStub.setting.findMany.mockResolvedValue([]);
    prismaStub.setting.findUnique.mockImplementation(async ({ where }: any) =>
      where.key === 'accounts_report_recipients' ? { key: where.key, value: 'accounts2@vbexports.co.in' } : null);
  });

  it('holds a pack with failed checks: only the hold address gets it, stamped as held, not sent', async () => {
    const o = order({ shipment: { id: 10, courier: 'Delhivery', waybillNumber: 'D1', status: 'DELIVERED', forwardCharge: 70, shippingCostSource: 'ESTIMATE', createdAt: IST('2026-10-05') } });
    prismaStub.order.findMany.mockResolvedValue([o] as any);
    const result = await sendMonthlyPack('2026-10', { now: NOW });
    expect(result.held).toBe(true);
    expect(result.sentTo).toEqual(['returnorders@vbexports.co.in']);
    const mail = (resendStub.sendInternalEmail.mock.calls as any[])[0][0];
    expect(mail.to).toEqual(['returnorders@vbexports.co.in']);
    expect(mail.cc).toEqual([]);
    expect(mail.subject).toMatch(/^HOLD/);
    expect(mail.attachments[0].filename).toBe('Youthnic-Accounts-Pack-2026-10.zip');
    expect((prismaStub.setting.upsert.mock.calls as any[])[0][0].where.key).toBe('accounts_pack_held:2026-10');
  });

  it('sends a passing pack to the accounts team and stamps it sent', async () => {
    prismaStub.order.findMany.mockResolvedValue([order({ paymentReceivedAt: IST('2026-10-20'), paymentReceivedAmount: 1050, paymentReceivedUtr: 'U1' })] as any);
    const result = await sendMonthlyPack('2026-10', { now: NOW });
    expect(result.held).toBe(false);
    expect(result.sentTo).toEqual(['accounts2@vbexports.co.in']);
    expect((prismaStub.setting.upsert.mock.calls as any[])[0][0].where.key).toBe('accounts_pack_sent:2026-10');
  });

  it('only sends on or after the 15th at 09:00 IST', async () => {
    prismaStub.order.findMany.mockResolvedValue([] as any);
    expect(await sendDueMonthlyPack(new Date('2026-11-14T10:00:00Z'))).toBeNull();
    expect(await sendDueMonthlyPack(new Date('2026-11-15T03:00:00Z'))).toBeNull(); // 08:30 IST
    expect(resendStub.sendInternalEmail).not.toHaveBeenCalled();
    expect(await sendDueMonthlyPack(new Date('2026-11-15T03:30:00Z'))).toMatchObject({ month: '2026-10' });
  });
});
