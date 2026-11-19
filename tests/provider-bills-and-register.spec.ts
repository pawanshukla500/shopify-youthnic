/**
 * Provider bill reconciliation (Easebuzz / Velocity bill vs charges already deducted),
 * the state-wise Sales & Returns register in the Tally "Shopify format", and
 * exchange freight (reverse pickup + replacement leg) in the monthly report.
 */
import { describe, it, expect, vi } from 'vitest';
import ExcelJS from 'exceljs';

vi.mock('../src/utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { prismaStub } = vi.hoisted(() => ({
  prismaStub: {
    order: { findMany: vi.fn(async () => []) },
    return: { findMany: vi.fn(async () => []) },
    shipment: { findMany: vi.fn(async () => []) },
    gatewaySettlementOrder: { findMany: vi.fn(async () => []) },
    providerInvoice: { findMany: vi.fn(async () => []) },
  },
}));
vi.mock('../src/database/prisma', () => ({ default: prismaStub }));
vi.mock('../src/modules/email/resend.service', () => ({ default: { sendInternalEmail: vi.fn() } }));

import {
  getProviderReconciliation,
  providerTallyRows,
  reconcileProvider,
  validateProviderInvoice,
} from '../src/modules/accounts/provider-invoice.service';
import { buildGstRegister, registerChannel, renderGstRegisterWorkbook } from '../src/modules/accounts/gst-register.service';
import { attachExchangeForwardFreight, buildReportData, buildStateAccountingSummary } from '../src/modules/accounts/accounts-report.service';
import { PROVIDERS } from '../src/modules/accounts/provider-invoice.service';
import { TALLY_STANDARD_LEDGER_MASTERS } from '../src/modules/accounts/tally-integration.service';
import { gstService } from '../src/modules/accounts/gst.service';

const easebuzzOct = {
  id: 1,
  invoiceNumber: 'N2627/000099618',
  invoiceDate: '2026-10-31',
  taxableAmount: 4426.11,
  igst: 796.7,
  cgst: 0,
  sgst: 0,
  totalAmount: 5222.81,
};
const books = (taxable: number, gst: number) => ({ taxable, gst, total: Math.round((taxable + gst) * 100) / 100, lines: 10, estimated: 0, basis: 'test' });

describe('provider bill reconciliation', () => {
  it('matches the Easebuzz October bill to the fees deducted in settlements', () => {
    const row = reconcileProvider('EASEBUZZ', '2026-10', [easebuzzOct], books(4426.11, 796.7));
    expect(row.status).toBe('MATCHED');
    expect(row.variance).toBe(0);
    expect(row.invoiceGst).toBe(796.7);
  });

  it('flags a variance and a missing bill', () => {
    expect(reconcileProvider('EASEBUZZ', '2026-10', [easebuzzOct], books(4400, 792)).variance).toBe(30.81);
    expect(reconcileProvider('EASEBUZZ', '2026-10', [easebuzzOct], books(4400, 792)).status).toBe('VARIANCE');
    const pending = reconcileProvider('VELOCITY', '2026-10', [], books(1000, 180));
    expect(pending.status).toBe('INVOICE_PENDING');
    expect(pending.variance).toBeNull();
  });

  it('books the bill and nullifies it against the consumption in Tally', () => {
    const row = reconcileProvider('EASEBUZZ', '2026-10', [easebuzzOct], books(4426.11, 796.7));
    const [purchase, journal] = providerTallyRows(row, new Date('2026-10-31'));
    expect(purchase).toMatchObject({ voucherType: 'Purchase', partyLedger: 'Easebuzz Pvt Ltd', drCr: 'Cr', totalAmount: 5222.81, igst: 796.7 });
    expect(journal).toMatchObject({ voucherType: 'Journal', partyLedger: 'Easebuzz Pvt Ltd', drCr: 'Dr', totalAmount: 5222.81 });
    expect(journal.particulars).toBe('Sundry Debtors - Online Store Customers');
    // Cr bill − Dr consumption = 0 on the provider ledger
    expect(purchase.totalAmount - journal.totalAmount).toBe(0);
    expect(providerTallyRows(reconcileProvider('PHONEPE', '2026-10', [], books(0, 0)), new Date())).toEqual([]);
  });

  it('exports every provider ledger the bill vouchers use as a Tally master', () => {
    const masters = new Set(TALLY_STANDARD_LEDGER_MASTERS.map((m) => m.name));
    for (const p of Object.values(PROVIDERS)) {
      expect(masters.has(p.partyLedger), p.partyLedger).toBe(true);
      expect(masters.has(p.expenseLedger), p.expenseLedger).toBe(true);
      expect(masters.has(p.consumedFromLedger), p.consumedFromLedger).toBe(true);
    }
  });

  it('validates a typed-in bill', () => {
    const ok = { provider: 'easebuzz', period: '2026-10', invoiceNumber: ' N2627/000099618 ', invoiceDate: '2026-10-31', taxableAmount: 4426.11, igst: 796.7, totalAmount: 5222.81 };
    expect(validateProviderInvoice(ok)).toMatchObject({ provider: 'EASEBUZZ', invoiceNumber: 'N2627/000099618', cgst: 0 });
    expect(() => validateProviderInvoice({ ...ok, totalAmount: 5300 })).toThrow(/does not equal/);
    expect(() => validateProviderInvoice({ ...ok, cgst: 10 })).toThrow(/IGST or CGST/);
    expect(() => validateProviderInvoice({ ...ok, provider: 'RAZORPAY' })).toThrow(/Provider/);
    expect(() => validateProviderInvoice({ ...ok, igst: -1 })).toThrow(/non-negative/);
  });

  it('counts each Easebuzz transaction once and Velocity freight per leg, including exchange legs', async () => {
    prismaStub.providerInvoice.findMany.mockResolvedValueOnce([
      { ...easebuzzOct, provider: 'EASEBUZZ', period: '2026-10', invoiceDate: new Date('2026-10-31'), note: null } as any,
    ]);
    prismaStub.gatewaySettlementOrder.findMany.mockResolvedValueOnce([
      { id: 1, easebuzzTrxnId: 'E1', merchantTrxnId: 'M1', serviceCharge: 4000, gst: 720 },
      { id: 2, easebuzzTrxnId: 'E1', merchantTrxnId: 'M1', serviceCharge: 4000, gst: 720 }, // same txn in a re-uploaded batch
      { id: 3, easebuzzTrxnId: 'E2', merchantTrxnId: 'M2', serviceCharge: 426.11, gst: 76.7 },
    ] as any);
    prismaStub.shipment.findMany.mockResolvedValue([
      { courier: 'Velocity', labelUrl: null, waybillNumber: 'V1', status: 'DELIVERED', forwardCharge: 118, rtoCharge: null, shippingCostSource: 'ACTUAL', rtoChargeSource: null },
      { courier: 'Velocity', labelUrl: null, waybillNumber: 'V2', status: 'RTO_DELIVERED', forwardCharge: 59, rtoCharge: 59, shippingCostSource: 'ACTUAL', rtoChargeSource: 'ACTUAL' },
      { courier: 'Delhivery', labelUrl: null, waybillNumber: 'D1', status: 'DELIVERED', forwardCharge: 70, rtoCharge: null, shippingCostSource: 'ESTIMATE', rtoChargeSource: null },
    ] as any);
    prismaStub.return.findMany.mockResolvedValue([
      { carrier: 'Velocity', shippingCharge: 80, shippingCostSource: 'ESTIMATE' }, // exchange reverse pickup
    ] as any);

    const rows = await getProviderReconciliation('2026-10');
    const easebuzz = rows.find((r) => r.provider === 'EASEBUZZ')!;
    expect(easebuzz.consumption).toMatchObject({ taxable: 4426.11, gst: 796.7, total: 5222.81, lines: 2 });
    expect(easebuzz.status).toBe('MATCHED');

    const velocity = rows.find((r) => r.provider === 'VELOCITY')!;
    expect(velocity.consumption.total).toBe(316);
    expect(velocity.consumption.lines).toBe(4);
    expect(velocity.consumption.estimated).toBe(1);
    expect(rows.find((r) => r.provider === 'DELHIVERY')!.consumption.total).toBe(70);
    prismaStub.shipment.findMany.mockReset().mockResolvedValue([]);
    prismaStub.return.findMany.mockReset().mockResolvedValue([]);
  });
});

function regOrder(overrides: Record<string, any> = {}) {
  return {
    shopifyOrderName: '#26YOU1',
    shopifyOrderId: '1',
    shopifyCreatedAt: new Date('2026-10-08T07:00:00.000Z'),
    customerState: 'Gujarat',
    paymentMethod: 'COD',
    status: 'DELIVERED',
    totalAmount: 1050,
    taxLines: [{ rate: 0.05 }],
    items: [{ title: 'Kurta set', quantity: 2, price: 525 }],
    shipment: { courier: 'Delhivery', waybillNumber: 'D1' },
    ...overrides,
  };
}

describe('sales & returns register (Tally Shopify format)', () => {
  it('adds CGST + SGST lines into one rate but sends mixed-rate orders to GST review', () => {
    expect(gstService.determineOrderGstRate({ totalAmount: 1050, taxLines: [{ rate: 0.025, title: 'CGST' }, { rate: 0.025, title: 'SGST' }] })).toBe(5);
    expect(() => gstService.determineOrderGstRate({ totalAmount: 3000, taxLines: [{ rate: 0.05, title: 'IGST' }, { rate: 0.18, title: 'IGST' }] })).toThrow(/Mixed GST/);
    const reg = buildGstRegister('2026-10', [regOrder({ taxLines: [{ rate: 0.05, title: 'IGST' }, { rate: 0.18, title: 'IGST' }] })], []);
    expect(reg.sales['Delivery-COD']).toHaveLength(0);
    expect(reg.review[0].reason).toMatch(/Mixed GST/);
  });

  it('picks the channel from courier for COD and gateway for prepaid', () => {
    expect(registerChannel(regOrder())).toBe('Delivery-COD');
    expect(registerChannel(regOrder({ shipment: { courier: 'Velocity', waybillNumber: 'V1' } }))).toBe('Velocity-COD');
    expect(registerChannel(regOrder({ paymentMethod: 'Pre-paid', paymentProvider: 'PhonePe', shipment: { courier: 'Velocity' } }))).toBe('PhonePe-Prepaid');
    expect(registerChannel(regOrder({ paymentMethod: 'Pre-paid', paymentGateway: 'gokwik' }))).toBe('EaseBuzz-Prepaid');
  });

  it('groups sales and refunds state-wise with CGST/SGST for Gujarat and IGST elsewhere', async () => {
    const orders = [
      regOrder(),
      regOrder({ shopifyOrderName: '#26YOU2', items: [{ title: 'Saree', quantity: 1, price: 1050 }] }),
      regOrder({ shopifyOrderName: '#26YOU3', customerState: 'Karnataka', paymentMethod: 'Pre-paid', paymentProvider: 'PhonePe', totalAmount: 2100 }),
      regOrder({ shopifyOrderName: '#26YOU4', status: 'CANCELLED' }),
      regOrder({ shopifyOrderName: '26YOU1-EX-FWD', shopifyOrderId: 'EX-FWD-1', paymentMethod: 'EXCHANGE', totalAmount: 0 }),
      regOrder({ shopifyOrderName: '#26YOU5', taxLines: null, totalTax: null, totalDiscounts: 100 }),
    ];
    const returns = [
      { isExchange: false, returnStatus: 'RECEIVED', refundAmount: 1050, order: orders[2], items: [{ quantity: 1, orderItem: { title: 'Kurta set' } }] },
      { isExchange: true, returnStatus: 'RECEIVED', refundAmount: 0, order: orders[0] },
    ];
    const reg = buildGstRegister('2026-10', orders, returns);

    expect(reg.sales['Delivery-COD']).toHaveLength(1);
    expect(reg.sales['Delivery-COD'][0]).toMatchObject({
      srNo: 1, state: 'GUJARAT', taxable: 2000, igst: 0, cgst: 50, sgst: 50, gross: 2100, qty: 3, voucherNo: 'DLCOD/2610/01', skus: 'Kurta set, Saree',
    });
    expect(reg.sales['PhonePe-Prepaid'][0]).toMatchObject({ state: 'KARNATAKA', taxable: 2000, igst: 100, cgst: 0, gross: 2100 });
    expect(reg.returns['PhonePe-Prepaid'][0]).toMatchObject({ state: 'KARNATAKA', taxable: 1000, igst: 50, gross: 1050, qty: 1, voucherNo: 'CN-PPPP/2610/01' });
    expect(reg.returns['Delivery-COD']).toHaveLength(0);
    expect(reg.review.map((r) => r.orderNo)).toEqual(['#26YOU5']);
    expect(reg.sales['Delivery-COD'][0].date.toISOString().slice(0, 10)).toBe('2026-10-31');

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await renderGstRegisterWorkbook(reg));
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      'Delivery-COD', 'Velocity-COD', 'EaseBuzz-Prepaid', 'PhonePe-Prepaid',
      'Return-Delivery-COD', 'Return-Velocity-COD', 'Return-EaseBuzz-Prepaid', 'Return-PhonePe-Prepaid', 'GST Review',
    ]);
    expect((wb.getWorksheet('Delivery-COD')!.getRow(1).values as any[]).slice(1)).toEqual([
      'Sr No', 'State', 'Taxable Amt', 'Sum of IGST', 'Sum of CGST', 'Sum of SGST', 'Gross Sales (₹)', 'Sum of QTY', 'Voucher No', 'Date', 'Skus',
    ]);
  });
});

describe('exchange freight', () => {
  const parent = regOrder({
    shopifyOrderName: '#26YOU9',
    status: 'EXCHANGE_REQUESTED',
    shipment: { courier: 'Velocity', waybillNumber: 'V9', forwardCharge: 100, shippingCostSource: 'ACTUAL' },
    returns: [{ isExchange: true, returnStatus: 'RECEIVED', returnWaybillNumber: 'R9', shippingCharge: 80, exchangeForwardAwb: 'V10', createdAt: new Date('2026-10-12T00:00:00Z') }],
  });
  const replacement = regOrder({ shopifyOrderName: '26YOU9-EX-FWD', shopifyOrderId: 'EX-FWD-9', paymentMethod: 'EXCHANGE', totalAmount: 0, shipment: { courier: 'Velocity', waybillNumber: 'V10', forwardCharge: 90 } });

  it('charges the reverse pickup and the replacement leg to the parent order', async () => {
    prismaStub.shipment.findMany.mockResolvedValueOnce([{ waybillNumber: 'V10', forwardCharge: 90, rtoCharge: null, shippingCostSource: 'ESTIMATE', rtoChargeSource: null, order: { shopifyOrderName: '26YOU9-EX-FWD' } }] as any);
    const ret = parent.returns[0] as any;
    await attachExchangeForwardFreight([ret]);
    expect(ret).toMatchObject({ exchangeForwardCharge: 90, exchangeOrderName: '26YOU9-EX-FWD', exchangeForwardCostSource: 'ESTIMATE' });

    const data = buildReportData('2026-10', [parent, replacement], [{ ...ret, order: parent }], new Date('2026-11-10'));
    expect(data.orders.map((o) => o.orderNo)).toEqual(['#26YOU9']); // replacement is not a separate sale
    expect(data.orders[0]).toMatchObject({ forwardShipping: 100, returnShipping: 80, exchangeShipping: 90, totalShipping: 270 });
    expect(data.exchanges![0]).toMatchObject({ reverseFreight: 80, replacementAwb: 'V10', forwardFreight: 90, totalFreight: 170 });
    expect(data.shipping.map((s) => s.leg)).toEqual(['Forward', 'Exchange reverse pickup', 'Exchange replacement']);

    const { totals } = buildStateAccountingSummary([parent, replacement], [{ ...ret, order: parent }]);
    expect(totals.exchangeFreightExpenses).toBe(170);
    expect(totals.actualFreightExpenses).toBe(0); // both legs are estimates, not billed cost
    expect(totals.estimatedFreightNotBilled).toBe(170);
    expect(totals.totalOrders).toBe(1);

    const billed = { ...ret, order: parent, shippingCostSource: 'ACTUAL', exchangeForwardCostSource: 'ESTIMATE' };
    const split = buildStateAccountingSummary([parent], [billed]).totals;
    expect(split).toMatchObject({ actualFreightExpenses: 80, estimatedFreightNotBilled: 90, exchangeFreightExpenses: 170 });
  });
});
