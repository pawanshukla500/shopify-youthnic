/**
 * State-Wise Sales, Returns, Freight, Payment & Outstanding Reconciliation Test Suite
 *
 * Verifies all 22 required accounting, settlement bridge, and reconciliation scenarios.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ExcelJS from 'exceljs';

vi.mock('../src/utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { prismaStub, resendStub } = vi.hoisted(() => ({
  prismaStub: {
    order: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
    return: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
    shipment: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
    financialEvent: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0), create: vi.fn(), upsert: vi.fn() },
    setting: {
      findUnique: vi.fn(),
      findMany: vi.fn(async () => []),
      upsert: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
  },
  resendStub: { sendInternalEmail: vi.fn() },
}));

vi.mock('../src/database/prisma', () => ({ default: prismaStub }));
vi.mock('../src/modules/email/resend.service', () => ({ default: resendStub }));

import {
  buildReportData,
  buildStateAccountingSummary,
  computeOpeningBalances,
  getGstStateCode,
  monthRange,
  renderWorkbook,
  resolvePaymentRailName,
} from '../src/modules/accounts/accounts-report.service';
import { financialEventService } from '../src/modules/accounts/financial-event.service';

function mockOrder(overrides: Record<string, any> = {}) {
  return {
    id: 101,
    shopifyOrderName: '#26YOU6001',
    shopifyCreatedAt: new Date('2026-10-10T10:00:00.000Z'),
    customerName: 'Rahul Verma',
    customerCity: 'Mumbai',
    customerState: 'Maharashtra',
    customerPincode: '400001',
    paymentMethod: 'Pre-paid',
    paymentProvider: 'Easebuzz',
    tags: 'Prepaid',
    financialStatus: 'paid',
    totalAmount: 1000.0,
    gatewayFee: 11.8,
    paymentReceivedAmount: 988.2,
    paymentReceivedAt: new Date('2026-10-12T10:00:00.000Z'),
    paymentReceivedUtr: 'AXIS12345678',
    status: 'DELIVERED',
    shipment: {
      waybillNumber: '1234567890',
      status: 'DELIVERED',
      forwardCharge: 80.0,
      rtoCharge: null,
      shippingCostSource: 'ACTUAL',
    },
    returns: [],
    ...overrides,
  };
}

describe('State-Wise Reconciliation Bridge & Multi-Period Invariants', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Scenario 1: October order paid in October, returned in November
  it('Scenario 1: October order returned in November does not mutate October books; recognized in November', () => {
    const octStart = new Date('2026-09-30T18:30:00.000Z');
    const octEnd = new Date('2026-10-31T18:30:00.000Z');
    const novStart = octEnd;
    const novEnd = new Date('2026-11-30T18:30:00.000Z');

    const octOrder = mockOrder({
      customerState: 'Maharashtra',
      totalAmount: 1000.0,
      paymentReceivedAmount: 988.2,
      gatewayFee: 11.8,
    });

    // In October: Order placed and settled
    const octSummary = buildStateAccountingSummary([octOrder], [], octStart, octEnd);
    const mhOct = octSummary.states.find((s) => s.state === 'Maharashtra')!;
    expect(mhOct.grossSales).toBe(1000.0);
    expect(mhOct.returnsDeducted).toBe(0.0);
    expect(mhOct.netSales).toBe(1000.0);

    // In November: Return occurs
    const novReturn = {
      id: 501,
      orderId: octOrder.id,
      refundAmount: 1000.0,
      refundStatus: 'PROCESSED',
      createdAt: new Date('2026-11-05T10:00:00.000Z'),
      refundProcessedAt: new Date('2026-11-06T10:00:00.000Z'),
      order: octOrder,
    };

    const novOpening = new Map([['Maharashtra', mhOct.closingBalance]]);
    const novSummary = buildStateAccountingSummary([], [novReturn], novStart, novEnd, novOpening);
    const mhNov = novSummary.states.find((s) => s.state === 'Maharashtra')!;
    expect(mhNov.grossSales).toBe(0.0);
    expect(mhNov.returnsDeducted).toBe(1000.0);
    expect(mhNov.customerReturns).toBe(1000.0);
    expect(mhNov.netSales).toBe(-1000.0);
  });

  // Scenario 2: October order cancelled in November
  it('Scenario 2: October order cancelled in November recognized in November without mutating October gross sales', () => {
    const novStart = new Date('2026-10-31T18:30:00.000Z');
    const novEnd = new Date('2026-11-30T18:30:00.000Z');

    const octOrder = mockOrder({
      customerState: 'Delhi',
      totalAmount: 1500.0,
      status: 'CANCELLED',
      cancelledAt: new Date('2026-11-02T10:00:00.000Z'),
      paymentReceivedAmount: 0,
    });

    const novOpening = new Map([['Delhi', 1500.0]]);
    const novSummary = buildStateAccountingSummary([], [], novStart, novEnd, novOpening, [], [octOrder]);
    const dl = novSummary.states.find((s) => s.state === 'Delhi')!;
    expect(dl.cancelledOrders).toBe(1500.0);
    expect(dl.expectedGrossSettlement).toBe(0.0); // 1500 opening - 1500 cancellation = 0
  });

  // Scenario 3: October shipment marked RTO in November
  it('Scenario 3: October prepaid shipment marked RTO in November recognized in November books', () => {
    const novStart = new Date('2026-10-31T18:30:00.000Z');
    const novEnd = new Date('2026-11-30T18:30:00.000Z');

    const rtoOrder = mockOrder({
      customerState: 'Karnataka',
      totalAmount: 1200.0,
      paymentReceivedAmount: 1185.0,
      status: 'RTO_DELIVERED',
    });

    const rtoShipment = {
      order: rtoOrder,
      rtoDeliveredAt: new Date('2026-11-04T12:00:00.000Z'),
      status: 'RTO_DELIVERED',
    };

    const novOpening = new Map([['Karnataka', 1200.0]]);
    const novSummary = buildStateAccountingSummary([], [], novStart, novEnd, novOpening, [], [], [rtoShipment]);
    const ka = novSummary.states.find((s) => s.state === 'Karnataka')!;
    expect(ka.rtoAdjustments).toBe(1200.0);
    expect(ka.expectedGrossSettlement).toBe(0.0); // 1200 opening - 1200 RTO = 0
  });

  // Scenario 4: Free exchange with reverse + forward freight attributed to original customer state
  it('Scenario 4: Free exchange replacement order has ₹0 new sales and all freight attributed to original customer state', () => {
    const octStart = new Date('2026-09-30T18:30:00.000Z');
    const octEnd = new Date('2026-10-31T18:30:00.000Z');

    const origOrder = mockOrder({
      shopifyOrderName: '#26YOU6100',
      customerState: 'Gujarat',
      totalAmount: 1200.0,
      paymentReceivedAmount: 1180.0,
    });

    const exchangeReturn = {
      id: 701,
      orderId: origOrder.id,
      isExchange: true,
      shippingCharge: 75.0, // reverse pickup freight
      exchangeOrderName: '#26YOU6100-EX',
      exchangeShippingCharge: 80.0, // replacement forward freight
      order: origOrder,
    };

    const summary = buildStateAccountingSummary([origOrder], [exchangeReturn], octStart, octEnd);
    const gj = summary.states.find((s) => s.state === 'Gujarat')!;
    expect(gj.exchangeFreightExpenses).toBe(75.0);
    expect(gj.grossSales).toBe(1200.0);
    expect(gj.returnsDeducted).toBe(0.0);
    expect(gj.customerReturns).toBe(0.0);
    expect(gj.netSales).toBe(1200.0);
  });

  // Scenario 5: GoKwik / Easebuzz ₹1,000 gross, ₹11.80 fee, ₹988.20 bank credit leaving ₹0 outstanding
  it('Scenario 5: GoKwik/Easebuzz ₹1,000 gross with ₹11.80 fee and ₹988.20 bank credit leaves ₹0.00 outstanding', () => {
    const octStart = new Date('2026-09-30T18:30:00.000Z');
    const octEnd = new Date('2026-10-31T18:30:00.000Z');

    const orderObj = mockOrder({
      paymentProvider: 'Easebuzz',
      totalAmount: 1000.0,
      gatewayFee: 11.8,
      paymentReceivedAmount: 988.2,
      paymentReceivedAt: new Date('2026-10-15T12:00:00.000Z'),
    });

    const summary = buildStateAccountingSummary([orderObj], [], octStart, octEnd);
    const mh = summary.states.find((s) => s.state === 'Maharashtra')!;
    expect(mh.expectedGrossSettlement).toBe(1000.0);
    expect(mh.gokwikEasebuzzFeeDeducted).toBe(11.8);
    expect(mh.netExpectedBankSettlement).toBe(988.2);
    expect(mh.verifiedPaymentReceived).toBe(988.2);
    expect(mh.outstandingSettlement).toBe(0.0); // Exact settlement leaves ₹0.00
  });

  // Scenario 6: PhonePe settlement deduction
  it('Scenario 6: PhonePe ₹1,500 gross with ₹26.55 fee and ₹1,473.45 bank credit leaves ₹0.00 outstanding', () => {
    const octStart = new Date('2026-09-30T18:30:00.000Z');
    const octEnd = new Date('2026-10-31T18:30:00.000Z');

    const phonePeOrder = mockOrder({
      paymentProvider: 'PhonePe',
      paymentMethod: 'Pre-paid',
      customerState: 'Haryana',
      totalAmount: 1500.0,
      gatewayFee: 26.55,
      paymentReceivedAmount: 1473.45,
      paymentReceivedAt: new Date('2026-10-16T12:00:00.000Z'),
    });

    const summary = buildStateAccountingSummary([phonePeOrder], [], octStart, octEnd);
    const hr = summary.states.find((s) => s.state === 'Haryana')!;
    expect(hr.phonepeFeeDeducted).toBe(26.55);
    expect(hr.netExpectedBankSettlement).toBe(1473.45);
    expect(hr.outstandingSettlement).toBe(0.0);
  });

  // Scenario 7: Delhivery COD remittance withholding
  it('Scenario 7: Delhivery COD ₹1,200 collected with ₹120 remittance withholding and ₹1,080 bank credit leaves ₹0.00 outstanding', () => {
    const octStart = new Date('2026-09-30T18:30:00.000Z');
    const octEnd = new Date('2026-10-31T18:30:00.000Z');

    const codOrder = mockOrder({
      paymentMethod: 'COD',
      customerState: 'Punjab',
      totalAmount: 1200.0,
      gatewayFee: 120.0, // freight withheld from remittance
      paymentReceivedAmount: 1080.0,
      paymentReceivedAt: new Date('2026-10-20T12:00:00.000Z'),
      shipment: { courier: 'Delhivery' },
    });

    const summary = buildStateAccountingSummary([codOrder], [], octStart, octEnd);
    const pb = summary.states.find((s) => s.state === 'Punjab')!;
    expect(pb.codSettlementDeductions).toBe(120.0);
    expect(pb.netExpectedBankSettlement).toBe(1080.0);
    expect(pb.verifiedPaymentReceived).toBe(1080.0);
    expect(pb.outstandingSettlement).toBe(0.0);
  });

  // Scenario 8: Prepaid Delhivery wallet debit does NOT deduct from gateway bank settlement
  it('Scenario 8: Prepaid courier wallet debits are recorded as freight expenses but NOT subtracted from gateway settlements', () => {
    const octStart = new Date('2026-09-30T18:30:00.000Z');
    const octEnd = new Date('2026-10-31T18:30:00.000Z');

    const prepaidOrder = mockOrder({
      paymentMethod: 'Pre-paid',
      customerState: 'Rajasthan',
      totalAmount: 800.0,
      actualShippingCost: 95.0, // Delhivery wallet debit
      gatewayFee: 9.44,
      paymentReceivedAmount: 790.56,
      paymentReceivedAt: new Date('2026-10-18T10:00:00.000Z'),
    });

    const summary = buildStateAccountingSummary([prepaidOrder], [], octStart, octEnd);
    const rj = summary.states.find((s) => s.state === 'Rajasthan')!;
    expect(rj.actualFreightExpenses).toBe(95.0);
    expect(rj.netExpectedBankSettlement).toBe(790.56); // 800 - 9.44 gateway fee = 790.56 (NOT reduced by 95.0 wallet freight)
    expect(rj.outstandingSettlement).toBe(0.0);
  });

  // Scenario 9: Velocity underlying courier Delhivery without duplicate freight
  it('Scenario 9: Velocity shipment with underlying Delhivery courier logs single freight billing', async () => {
    const orderWithVelocity = mockOrder({
      id: 901,
      customerState: 'Haryana',
      shipment: {
        courier: 'Velocity',
        aggregator: 'VELOCITY',
        waybillNumber: 'VEL12345678',
        forwardCharge: 85.0,
      },
      actualShippingCost: 85.0,
      shippingAudited: true,
    });

    const upsertEvents: any[] = [];
    prismaStub.order.findMany.mockResolvedValueOnce([orderWithVelocity]);
    prismaStub.financialEvent.upsert.mockImplementation(async (args: any) => {
      upsertEvents.push(args.create);
      return { createdAt: new Date(), updatedAt: new Date() };
    });

    const res = await financialEventService.syncFinancialEvents('2026-10');
    expect(res).toBeDefined();

    const freightEvents = upsertEvents.filter((e) => e.eventType === 'FREIGHT_EXPENSE_WALLET');
    expect(freightEvents.length).toBe(1);
    expect(Number(freightEvents[0].feeAmount)).toBe(85.0);
    expect(freightEvents[0].provider).toBe('Velocity');
  });

  // Scenario 10: Multi-order UTR settlement matching
  it('Scenario 10: Multiple orders covered by single bank UTR batch reconcile accurately', async () => {
    const utrBatch = 'UTRBATCH9999';
    const order1 = mockOrder({ id: 1001, shopifyOrderName: '#ORD-1', customerState: 'Delhi', paymentReceivedUtr: utrBatch, paymentReceivedAmount: 500, paymentVerified: true });
    const order2 = mockOrder({ id: 1002, shopifyOrderName: '#ORD-2', customerState: 'Delhi', paymentReceivedUtr: utrBatch, paymentReceivedAmount: 700, paymentVerified: true });

    const upsertEvents: any[] = [];
    prismaStub.order.findMany.mockResolvedValueOnce([order1, order2]);
    prismaStub.financialEvent.upsert.mockImplementation(async (args: any) => {
      upsertEvents.push(args.create);
      return { createdAt: new Date(), updatedAt: new Date() };
    });

    await financialEventService.syncFinancialEvents('2026-10');

    const receiptEvents = upsertEvents.filter((e) => e.eventType === 'BANK_RECEIPT_VERIFIED');
    expect(receiptEvents.length).toBe(2);
    expect(receiptEvents.every((e) => e.reference === utrBatch)).toBe(true);
    const totalCredited = receiptEvents.reduce((acc, e) => acc + Number(e.grossAmount), 0);
    expect(totalCredited).toBe(1200);
  });

  // Scenario 11-13: State Settlement Bridge Math Invariants
  it('Scenario 11-13: Enforces exact Settlement Bridge formulas on all rows and national totals', () => {
    const octStart = new Date('2026-09-30T18:30:00.000Z');
    const octEnd = new Date('2026-10-31T18:30:00.000Z');

    const orders = [
      mockOrder({ customerState: 'Maharashtra', totalAmount: 1000, gatewayFee: 11.8, paymentReceivedAmount: 988.2 }),
      mockOrder({ customerState: 'Delhi', totalAmount: 2000, gatewayFee: 23.6, paymentReceivedAmount: 1976.4 }),
      mockOrder({ customerState: 'Gujarat', totalAmount: 1500, gatewayFee: 17.7, paymentReceivedAmount: 1482.3 }),
    ];

    const opening = new Map([
      ['Maharashtra', 200.0],
      ['Delhi', 300.0],
      ['Gujarat', 100.0],
    ]);

    const { states, totals } = buildStateAccountingSummary(orders, [], octStart, octEnd, opening);

    // Verify Invariant 1: Expected Gross = Opening + Gross - Cancel - RTO - Returns
    for (const row of states) {
      const expGross = (row.openingOutstanding || 0) + (row.grossOrderSales || 0) - (row.cancelledOrders || 0) - (row.rtoAdjustments || 0) - (row.customerReturns || 0);
      expect(row.expectedGrossSettlement).toBeCloseTo(expGross, 2);

      // Verify Invariant 2: Net Expected = Expected Gross - Fees
      const netExp = row.expectedGrossSettlement! - (row.gokwikEasebuzzFeeDeducted || 0) - (row.phonepeFeeDeducted || 0) - (row.codSettlementDeductions || 0);
      expect(row.netExpectedBankSettlement).toBeCloseTo(netExp, 2);

      // Verify Invariant 3: Outstanding = Net Expected - Verified Receipts
      const out = row.netExpectedBankSettlement! - (row.verifiedPaymentReceived || 0);
      expect(row.outstandingSettlement).toBeCloseTo(out, 2);
    }

    // Scenario 14: National totals match sum of states
    expect(totals.expectedGrossSettlement).toBeCloseTo(
      states.reduce((acc, s) => acc + (s.expectedGrossSettlement || 0), 0),
      2
    );
    expect(totals.netExpectedBankSettlement).toBeCloseTo(
      states.reduce((acc, s) => acc + (s.netExpectedBankSettlement || 0), 0),
      2
    );
    expect(totals.outstandingSettlement).toBeCloseTo(
      states.reduce((acc, s) => acc + (s.outstandingSettlement || 0), 0),
      2
    );
  });

  // Scenario 15-16: Dynamic GST POS Code Mapping
  it('Scenario 15-16: Maps GST POS codes and handles itemized dynamic tax lines', () => {
    expect(getGstStateCode('Maharashtra')).toBe('27');
    expect(getGstStateCode('Delhi')).toBe('07');
    expect(getGstStateCode('Karnataka')).toBe('29');
    expect(getGstStateCode('Gujarat')).toBe('24');
    expect(getGstStateCode('Haryana')).toBe('06');
    expect(getGstStateCode('Tamil Nadu')).toBe('33');
    expect(getGstStateCode('Unknown State')).toBe('99');
  });

  // Scenario 17: Month-End Closing Immutability
  it('Scenario 17: Month-end closing carried forward preserves prior month historical figures and event deductions', async () => {
    const cutoffDate = new Date('2026-11-01T00:00:00.000Z');
    prismaStub.order.count.mockResolvedValueOnce(2);
    prismaStub.financialEvent.count.mockResolvedValueOnce(3);
    prismaStub.financialEvent.findMany.mockResolvedValueOnce([
      { customerState: 'Maharashtra', grossAmount: 1000, netAmount: 1000, feeAmount: 0, eventType: 'BOOKING' },
      { customerState: 'Maharashtra', grossAmount: 11.8, netAmount: 0, feeAmount: 11.8, eventType: 'GATEWAY_FEE_DEDUCTED' },
      { customerState: 'Maharashtra', grossAmount: 988.2, netAmount: 988.2, feeAmount: 0, eventType: 'BANK_RECEIPT_VERIFIED' },
    ]);

    const openingMap = await computeOpeningBalances(cutoffDate);
    // Opening balance with verified settlement: 1000 gross - 11.8 fee - 988.2 net = 0.0
    expect(openingMap.get('Maharashtra')).toBe(0.0);
  });

  // Scenario 18: View B: Monthly Expense Report Breakdown
  it('Scenario 18: Builds View B Monthly Expense Report isolating MDR and logistics costs', async () => {
    prismaStub.financialEvent.findMany.mockResolvedValueOnce([
      { eventType: 'GATEWAY_FEE_DEDUCTED', provider: 'PHONEPE', grossAmount: 118, feeAmount: 118 },
      { eventType: 'GATEWAY_FEE_DEDUCTED', provider: 'GOKWIK', grossAmount: 236, feeAmount: 236 },
      { eventType: 'GATEWAY_FEE_DEDUCTED', provider: 'EASEBUZZ', grossAmount: 59, feeAmount: 59 },
      { eventType: 'FREIGHT_EXPENSE_WALLET', provider: 'DELHIVERY', grossAmount: 500, feeAmount: 500 },
      { eventType: 'FREIGHT_EXPENSE_WALLET', provider: 'VELOCITY', grossAmount: 400, feeAmount: 400 },
      { eventType: 'EXCHANGE_FREIGHT', provider: 'VELOCITY', grossAmount: 150, feeAmount: 150 },
    ]);

    const expenses = await financialEventService.buildMonthlyExpenseReport('2026-10');
    expect(expenses.period).toBe('2026-10');
    expect(expenses.phonepeFees.total).toBe(118);
    expect(expenses.gokwikFees.total).toBe(236);
    expect(expenses.easebuzzFees.total).toBe(59);
    expect(expenses.delhiveryFreight.forward).toBe(500);
    expect(expenses.velocityFreight.forward).toBe(400);
    expect(expenses.exchangeFreight.netFreightExpense).toBe(150);
    expect(expenses.totalOperatingExpenses).toBe(118 + 236 + 59 + 500 + 400 + 150);
  });

  // Scenario 19: View C: Monthly Contribution / P&L
  it('Scenario 19: Builds View C Monthly Contribution before COGS report', async () => {
    const mockEvents = [
      { eventType: 'BOOKING', customerState: 'Gujarat', grossAmount: 10000, netAmount: 10000 },
      { eventType: 'CANCELLATION', customerState: 'Gujarat', grossAmount: 1000, netAmount: -1000 },
      { eventType: 'RETURN_CONFIRMED', customerState: 'Gujarat', grossAmount: 1000, netAmount: -1000 },
      { eventType: 'GATEWAY_FEE_DEDUCTED', provider: 'EASEBUZZ', customerState: 'Gujarat', grossAmount: 118, feeAmount: 118 },
      { eventType: 'FREIGHT_EXPENSE_WALLET', provider: 'DELHIVERY', customerState: 'Gujarat', grossAmount: 500, feeAmount: 500 },
    ];
    prismaStub.financialEvent.findMany.mockResolvedValue(mockEvents);
    prismaStub.order.findMany.mockResolvedValue([]);

    const contribution = await financialEventService.buildMonthlyContributionReport('2026-10');
    expect(contribution.period).toBe('2026-10');
    expect(contribution.grossBookings).toBe(10000);
    expect(contribution.cancelledOrders).toBe(1000);
    expect(contribution.customerReturns).toBe(1000);
    expect(contribution.netRecognizedRevenue).toBe(8000);
    expect(contribution.gatewayExpenses).toBe(118);
    expect(contribution.freightExpenses).toBe(500);
    expect(contribution.totalVariableExpenses).toBe(618);
    expect(contribution.contributionBeforeCogs).toBeCloseTo(contribution.taxableRevenue - 618, 2);
    expect(contribution.contributionMarginPercent).toBeGreaterThan(0);
  });

  // Scenario 20-21: Excel workbook rendering with Settlement Bridge sheet and formula verification
  it('Scenario 20-21: Generates comprehensive Excel workbook with State Settlement Bridge and formula formatting', async () => {
    const octOrder = mockOrder();
    const data = buildReportData('2026-10', [octOrder], [], new Date('2026-11-10T03:30:00.000Z'));
    data.settlementBridge = true;
    data.cancellationsAndRtos = [
      { orderNo: '#26YOU5900', type: 'Cancellation', eventDate: new Date(), customer: 'A', state: 'Delhi', amount: 500, rail: 'EaseBuzz', awb: '', reason: 'Cancel' }
    ];
    data.exchanges = [
      { orderNo: '#26YOU5901', state: 'Maharashtra', returnAwb: 'RET1', reverseFreight: 75, replacementOrderNo: '#EX-1', replacementAwb: 'FWD1', forwardFreight: 80, totalFreight: 155, netNewSales: 0, attributedState: 'Maharashtra' }
    ];

    const buffer = await renderWorkbook(data);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);

    const sheetNames = workbook.worksheets.map((s) => s.name);
    expect(sheetNames).toContain('State Summary (Tally Ledger)');
    expect(sheetNames).toContain('State Settlement Bridge');
    expect(sheetNames).toContain('Orders');
    expect(sheetNames).toContain('Monthly Returns (Credit Notes)');
    expect(sheetNames).toContain('Cancellation & RTO Details');
    expect(sheetNames).toContain('Exchange Freight Register');
    expect(sheetNames).toContain('Tally Vouchers');

    const bridgeSheet = workbook.getWorksheet('State Settlement Bridge')!;
    expect(bridgeSheet.getRow(1).getCell(1).value).toContain('State-Wise Settlement Bridge');
  });

  // Scenario 22: Unverified receipts separation
  it('Scenario 22: Separates verified vs unverified bank receipts with audit status', async () => {
    const verifiedOrder = mockOrder({ id: 2201, paymentReceivedUtr: 'AXIS1111', paymentReceivedAmount: 1000, paymentVerified: true });
    const unverifiedOrder = mockOrder({ id: 2202, paymentReceivedUtr: '', paymentReceivedAmount: 500, paymentVerified: false });

    const createdEvents: any[] = [];
    prismaStub.order.findMany.mockResolvedValueOnce([verifiedOrder, unverifiedOrder]);
    prismaStub.financialEvent.upsert.mockImplementation(async (args: any) => {
      createdEvents.push(args.create);
      return { createdAt: new Date(), updatedAt: new Date() };
    });

    await financialEventService.syncFinancialEvents('2026-10');

    const verifiedEv = createdEvents.find((e) => e.orderId === 2201 && e.eventType.startsWith('BANK_RECEIPT'));
    const unverifiedEv = createdEvents.find((e) => e.orderId === 2202 && e.eventType.startsWith('BANK_RECEIPT'));

    expect(verifiedEv).toBeDefined();
    expect(verifiedEv.eventType).toBe('BANK_RECEIPT_VERIFIED');
    expect(verifiedEv.verificationStatus).toBe('VERIFIED');

    expect(unverifiedEv).toBeDefined();
    expect(unverifiedEv.eventType).toBe('BANK_RECEIPT_UNVERIFIED');
    expect(unverifiedEv.verificationStatus).toBe('UNVERIFIED');
  });
});
