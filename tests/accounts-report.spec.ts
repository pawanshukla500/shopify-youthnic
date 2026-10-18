/**
 * Monthly accounts closing report: month boundaries, per-order rows, the
 * Excel layout, and "send once, on or after the 8th".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ExcelJS from 'exceljs';

vi.mock('../src/utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { prismaStub, resendStub } = vi.hoisted(() => ({
  prismaStub: {
    order: { findMany: vi.fn() },
    setting: { findUnique: vi.fn(), findMany: vi.fn(async () => []), upsert: vi.fn(), create: vi.fn(), updateMany: vi.fn(), delete: vi.fn() },
  },
  resendStub: { sendInternalEmail: vi.fn() },
}));
vi.mock('../src/database/prisma', () => ({ default: prismaStub }));
vi.mock('../src/modules/email/resend.service', () => ({ default: resendStub }));

import {
  buildReportData,
  monthRange,
  parseRecipients,
  previousMonth,
  renderWorkbook,
  sendDueMonthlyReport,
} from '../src/modules/accounts/accounts-report.service';

const DAY = 24 * 3600 * 1000;
const now = new Date('2026-11-08T03:30:00.000Z'); // 8 Nov 09:00 IST

function order(overrides: Record<string, any> = {}) {
  return {
    shopifyOrderName: '#26YOU5913',
    shopifyCreatedAt: new Date('2026-10-08T12:54:00.000Z'), // 8 Oct 18:24 IST
    customerName: 'Reena Sharma',
    customerCity: 'BANGALORE',
    customerState: 'Karnataka',
    customerPincode: '560102',
    paymentMethod: 'Pre-paid',
    paymentProvider: 'PhonePe',
    tags: 'Prepaid',
    financialStatus: 'paid',
    totalAmount: 754.52,
    status: 'DELIVERED',
    deliveredAt: new Date('2026-10-12T06:00:00.000Z'),
    paymentReceivedAt: new Date('2026-10-09T05:00:00.000Z'),
    paymentReceivedAmount: 740.6,
    paymentReceivedUtr: 'SBIN226281234567',
    paymentReceivedRef: 'STL-1',
    paymentReceivedSource: 'PG_SETTLEMENT_REPORT',
    gatewayFee: 13.92,
    paymentReference: '614686239240',
    shipment: {
      waybillNumber: '30100810011111',
      status: 'DELIVERED',
      trackingStatus: 'Delivered',
      trackingUpdatedAt: new Date(),
      forwardCharge: 82.6,
      rtoCharge: null,
      shippingCostSource: 'ACTUAL',
      billedWeightGrams: 500,
      chargedZone: 'D',
    },
    returns: [],
    ...overrides,
  };
}

describe('month handling', () => {
  it('uses IST month boundaries', () => {
    const { start, end, label } = monthRange('2026-10');
    expect(start.toISOString()).toBe('2026-09-30T18:30:00.000Z');
    expect(end.toISOString()).toBe('2026-10-31T18:30:00.000Z');
    expect(label).toBe('October 2026');
    expect(() => monthRange('2026-13')).toThrow();
  });

  it('reports the previous month, crossing the year in January', () => {
    expect(previousMonth(now)).toBe('2026-10');
    expect(previousMonth(new Date('2027-01-08T03:30:00.000Z'))).toBe('2026-12');
    // 1 Nov 00:30 IST is still 31 Oct in UTC; IST decides.
    expect(previousMonth(new Date('2026-10-31T19:00:00.000Z'))).toBe('2026-10');
  });

  it('cleans up the recipients list', () => {
    expect(parseRecipients('Accounts@Youthnic.com; finance@vbexports.co.in, bad-address, accounts@youthnic.com')).toEqual([
      'accounts@youthnic.com',
      'finance@vbexports.co.in',
    ]);
  });
});

describe('buildReportData', () => {
  it('closes a delivered, settled order and carries its UTR and shipping cost', () => {
    const data = buildReportData('2026-10', [order()], now);
    const row = data.orders[0];
    expect(row).toMatchObject({
      orderNo: '#26YOU5913',
      paymentMode: 'Prepaid',
      gateway: 'PhonePe',
      paymentReceived: 'Yes',
      receivedAmount: 740.6,
      utr: 'SBIN226281234567',
      receivedVia: 'Gateway settlement report',
      forwardShipping: 82.6,
      totalShipping: 82.6,
      shippingBasis: 'Actual (Delhivery ledger)',
      netAfterShipping: 658,
      accountsStatus: 'Closed',
      pending: '',
    });
    expect(row.orderDate?.toISOString()).toBe('2026-10-08T00:00:00.000Z');
    expect(row.returnWindowClosesOn?.toISOString()).toBe('2026-10-19T00:00:00.000Z');
    expect(data.prepaid[0]).toMatchObject({ status: 'Settled', utr: 'SBIN226281234567' });
  });

  it('lists what keeps an order open and separates COD remittance rows', () => {
    const cod = order({
      shopifyOrderName: '#26YOU6000',
      paymentMethod: 'COD',
      paymentReceivedAt: null,
      paymentReceivedAmount: null,
      paymentReceivedUtr: null,
      deliveredAt: new Date(now.getTime() - 2 * DAY),
      shipment: { ...order().shipment, paymentMode: 'COD', codAmount: 999, codCollected: true, codRemitted: false, forwardCharge: 95.4, shippingCostSource: 'ESTIMATE' },
    });
    const data = buildReportData('2026-10', [cod], now);
    expect(data.orders[0].accountsStatus).toBe('Open');
    expect(data.orders[0].pending).toMatch(/Payment not received in bank/);
    expect(data.orders[0].pending).toMatch(/Return window open until/);
    expect(data.orders[0].shippingBasis).toBe('Estimate (Delhivery rate API)');
    expect(data.cod[0]).toMatchObject({ awb: '30100810011111', codAmount: 999, status: 'Collected, awaiting remittance' });
  });

  it('marks cancelled and RTO orders as not a sale and adds the RTO leg', () => {
    const rto = order({
      status: 'RTO_DELIVERED',
      shipment: { ...order().shipment, status: 'RTO_DELIVERED', rtoCharge: 64.9 },
    });
    const data = buildReportData('2026-10', [order({ status: 'CANCELLED', shipment: null }), rto], now);
    expect(data.orders.map((r) => [r.accountsStatus, r.pending])).toEqual([
      ['Not a sale', 'Cancelled'],
      ['Not a sale', 'Returned to origin (RTO)'],
    ]);
    expect(data.shipping.filter((s) => s.leg === 'RTO')[0]).toMatchObject({ charge: 64.9 });
    expect(data.orders[1].totalShipping).toBe(147.5);
  });

  it('adds up the summary', () => {
    const cancelledUnpaid = order({
      shopifyOrderName: '#2',
      status: 'CANCELLED',
      shipment: null,
      paymentReceivedAt: null,
      paymentReceivedAmount: null,
      gatewayFee: null,
    });
    const data = buildReportData('2026-10', [order(), cancelledUnpaid], now);
    const value = (label: string) => data.summary.find((s) => s.label === label)?.value;
    expect(value('Orders placed')).toBe(2);
    expect(value('Closed (delivered, paid, return window over)')).toBe(1);
    expect(value('Received in bank (₹)')).toBe(740.6);
    expect(value('Gateway fees (₹)')).toBe(13.92);
    expect(value('Order value, sales (₹)')).toBe(754.52);
    expect(value('Not a sale (cancelled / RTO / refunded)')).toBe(1);
  });

  it('counts money received for an order later cancelled, so receipts match the bank', () => {
    const settledThenCancelled = order({ status: 'CANCELLED', financialStatus: 'refunded', shipment: null });
    const data = buildReportData('2026-10', [settledThenCancelled], now);
    const value = (label: string) => data.summary.find((s) => s.label === label)?.value;
    expect(value('Received in bank (₹)')).toBe(740.6);
    expect(value('Refunds (₹)')).toBe(754.52);
  });
});

describe('renderWorkbook', () => {
  it('writes filterable sheets with real dates, money formats and filter-aware totals', async () => {
    const buffer = await renderWorkbook(buildReportData('2026-10', [order(), order({ shopifyOrderName: '#2' })], now));
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as any);

    expect(workbook.worksheets.map((s) => s.name)).toEqual([
      'Summary',
      'Orders',
      'COD Remittance',
      'Prepaid Settlements',
      'Shipping Costs',
      'Returns & Refunds',
    ]);
    const sheet = workbook.getWorksheet('Orders')!;
    expect(sheet.getRow(1).getCell(1).value).toBe('Order No');
    expect(sheet.getRow(1).getCell(16).value).toBe('Bank UTR');
    expect(sheet.getRow(2).getCell(16).value).toBe('SBIN226281234567');
    expect(sheet.getRow(2).getCell(2).value).toBeInstanceOf(Date);
    expect(sheet.getColumn(9).numFmt).toBe('#,##0.00');
    expect(sheet.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
    const total = sheet.getRow(4).getCell(9).value as any;
    expect(total.formula).toBe('SUBTOTAL(109,I2:I3)');
  });
});

describe('sendDueMonthlyReport', () => {
  beforeEach(() => {
    for (const group of [...Object.values(prismaStub), resendStub]) for (const fn of Object.values(group)) (fn as any).mockReset();
    prismaStub.order.findMany.mockResolvedValue([order()]);
    prismaStub.setting.upsert.mockResolvedValue({});
    prismaStub.setting.create.mockResolvedValue({});
    prismaStub.setting.delete.mockResolvedValue({});
    resendStub.sendInternalEmail.mockResolvedValue({ id: 'em_1' });
  });

  it('waits until 09:00 IST on the 8th', async () => {
    settings({ accounts_report_recipients: 'accounts@youthnic.com' });
    expect(await sendDueMonthlyReport(new Date('2026-11-08T03:00:00.000Z'))).toBeNull(); // 08:30 IST
    expect(resendStub.sendInternalEmail).not.toHaveBeenCalled();
    expect(await sendDueMonthlyReport(new Date('2026-11-08T03:30:00.000Z'))).toBe('2026-10'); // 09:00 IST
  });

  it('lets only one sender claim the month', async () => {
    prismaStub.setting.create.mockRejectedValue(new Error('Unique constraint failed'));
    settings({
      accounts_report_recipients: 'accounts@youthnic.com',
      'accounts_report_sent:2026-10': `SENDING:${new Date('2026-11-09T09:59:00.000Z').toISOString()}`,
    });
    expect(await sendDueMonthlyReport(new Date('2026-11-09T10:00:00.000Z'))).toBeNull();
    expect(resendStub.sendInternalEmail).not.toHaveBeenCalled();
  });

  it('releases the claim when the email fails, so the next hour retries', async () => {
    settings({ accounts_report_recipients: 'accounts@youthnic.com' });
    resendStub.sendInternalEmail.mockRejectedValue(new Error('Resend 500'));
    await expect(sendDueMonthlyReport(new Date('2026-11-09T10:00:00.000Z'))).rejects.toThrow('Resend 500');
    expect(prismaStub.setting.delete).toHaveBeenCalledWith({ where: { key: 'accounts_report_sent:2026-10' } });
  });

  function settings(values: Record<string, string>) {
    prismaStub.setting.findUnique.mockImplementation(async ({ where }: any) =>
      values[where.key] !== undefined ? { key: where.key, value: values[where.key] } : null
    );
  }

  it('does nothing before the 8th', async () => {
    settings({ accounts_report_recipients: 'accounts@youthnic.com' });
    expect(await sendDueMonthlyReport(new Date('2026-11-07T10:00:00.000Z'))).toBeNull();
    expect(resendStub.sendInternalEmail).not.toHaveBeenCalled();
  });

  it('emails last month on or after the 8th, with the workbook attached, once', async () => {
    settings({ accounts_report_recipients: 'accounts@youthnic.com' });
    expect(await sendDueMonthlyReport(new Date('2026-11-09T10:00:00.000Z'))).toBe('2026-10');

    const email = resendStub.sendInternalEmail.mock.calls[0][0];
    expect(email.to).toEqual(['accounts@youthnic.com']);
    expect(email.subject).toBe('Youthnic accounts closing report · October 2026');
    expect(email.attachments[0].filename).toBe('Youthnic-Accounts-2026-10.xlsx');
    expect(prismaStub.setting.upsert.mock.calls[0][0].where).toEqual({ key: 'accounts_report_sent:2026-10' });

    settings({ accounts_report_recipients: 'accounts@youthnic.com', 'accounts_report_sent:2026-10': '{"sentAt":"x"}' });
    expect(await sendDueMonthlyReport(new Date('2026-11-09T11:00:00.000Z'))).toBeNull();
    expect(resendStub.sendInternalEmail).toHaveBeenCalledTimes(1);
  });

  it('waits for recipients instead of marking the month sent', async () => {
    settings({ accounts_report_recipients: '' });
    expect(await sendDueMonthlyReport(new Date('2026-11-09T10:00:00.000Z'))).toBeNull();
    expect(prismaStub.setting.upsert).not.toHaveBeenCalled();
  });
});
