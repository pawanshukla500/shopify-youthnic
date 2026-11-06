import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClosingStatus, VoucherType } from '@prisma/client';

const { prismaMock, txMock } = vi.hoisted(() => {
  const txMock = {
    journalEntry: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    journalLineItem: { deleteMany: vi.fn() },
    monthlyClosingSnapshot: { findUnique: vi.fn() },
  };
  const prismaMock = {
    order: { findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    gatewaySettlementBatch: { upsert: vi.fn() },
    monthlyClosingSnapshot: { findUnique: vi.fn() },
    $transaction: vi.fn(async (callback: (tx: typeof txMock) => Promise<unknown>) => callback(txMock)),
  };
  return { prismaMock, txMock };
});
vi.mock('../src/database/prisma', () => ({ default: prismaMock }));
vi.mock('../src/utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { monthlyClosingService } from '../src/modules/accounts/monthly-closing.service';
import { ledgerService } from '../src/modules/accounts/ledger.service';
import { gatewayExpenseService } from '../src/modules/accounts/gateway-expense.service';
import { bankReconciliationService } from '../src/modules/accounts/bank-reconciliation.service';
import { gstService } from '../src/modules/accounts/gst.service';
import { freightEngineService } from '../src/modules/accounts/freight-engine.service';
import { TALLY_STANDARD_LEDGER_MASTERS } from '../src/modules/accounts/tally-integration.service';
import { DEFAULT_LEDGER_ACCOUNTS } from '../src/modules/accounts/ledger.service';

describe('Financial accounting guardrails', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.monthlyClosingSnapshot.findUnique.mockResolvedValue(null);
  });
  afterEach(() => vi.restoreAllMocks());

  it('rejects a finalized month before posting invoice and return vouchers', async () => {
    prismaMock.monthlyClosingSnapshot.findUnique.mockResolvedValue({ status: ClosingStatus.CLOSED });

    await expect(monthlyClosingService.closeMonth('2026-10'))
      .rejects.toThrow(/CLOSED/);

    expect(prismaMock.order.findMany).not.toHaveBeenCalled();
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('rejects ledger entries in a closed month within its write transaction', async () => {
    txMock.journalEntry.findUnique.mockResolvedValue(null);
    txMock.monthlyClosingSnapshot.findUnique.mockResolvedValue({ status: ClosingStatus.CLOSED });
    vi.spyOn(ledgerService, 'getAccountId').mockResolvedValue(1);

    await expect(ledgerService.createBalancedEntry({
      entryNumber: 'TEST-CLOSED-2026-10',
      voucherType: VoucherType.JOURNAL,
      documentDate: new Date('2026-10-15T12:00:00.000Z'),
      accountingPeriod: '2026-10',
      lines: [
        { accountCode: 'BANK_MAIN', debit: 100, credit: 0 },
        { accountCode: 'CLEARING_EASEBUZZ', debit: 0, credit: 100 },
      ],
    })).rejects.toThrow(/CLOSED/);

    expect(txMock.journalEntry.create).not.toHaveBeenCalled();
    expect(txMock.journalLineItem.deleteMany).not.toHaveBeenCalled();
  });

  it('rejects a mismatched gateway settlement before any order or ledger writes', async () => {
    await expect(gatewayExpenseService.reconcileAndPostBatch(
      'EASEBUZZ',
      'TEST-MISMATCH',
      new Date('2026-11-05T12:00:00.000Z'),
      [{
        gateway: 'EASEBUZZ',
        orderReference: '#26YOU5900',
        transactionId: 'TXN-MISMATCH',
        grossAmount: 1000,
        mdrFee: 10,
        gstOnFee: 1.8,
        netCredit: 900,
        batchId: 'TEST-MISMATCH',
        settlementDate: new Date('2026-11-05T12:00:00.000Z'),
      }],
    )).rejects.toThrow(/source amount discrepancy/);

    expect(prismaMock.order.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.order.update).not.toHaveBeenCalled();
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('keeps unmatched gateway collections in clearing rather than crediting customer debtors', async () => {
    const entrySpy = vi.spyOn(ledgerService, 'createBalancedEntry').mockResolvedValue({ id: 42 });
    await ledgerService.postGatewaySettlement({
      gateway: 'EASEBUZZ', batchId: 'MIXED-101',
      grossAmount: 1000, matchedGrossAmount: 600,
      feeAmount: 10, feeGst: 1.8, netBankCredit: 988.2,
      settlementDate: new Date('2026-11-05T12:00:00Z'), period: '2026-11', orderIds: [1],
    });
    const lines = entrySpy.mock.calls[0][0].lines;
    expect(lines.find((r) => r.accountCode === 'SUNDRY_DEBTORS_PREPAID')?.credit).toBe(600);
    expect(lines.find((r) => r.accountCode === 'CLEARING_EASEBUZZ')?.credit).toBe(400);
  });

  it('books negative freight reversals as credits to expenses and debits to the wallet', async () => {
    const entrySpy = vi.spyOn(ledgerService, 'createBalancedEntry').mockResolvedValue({ id: 43 });
    await ledgerService.postFreightBill({
      carrier: 'DELHIVERY', invoiceNumber: 'CREDIT-101',
      invoiceDate: new Date('2026-11-05T12:00:00Z'), period: '2026-11',
      forwardFreight: -100, freightGst: -18, totalBilled: -118,
      isWalletDeducted: true,
    });
    const lines = entrySpy.mock.calls[0][0].lines;
    expect(lines.find((r) => r.accountCode === 'EXPENSE_FREIGHT_FORWARD')).toMatchObject({ debit: 0, credit: 100 });
    expect(lines.find((r) => r.accountCode === 'INPUT_IGST')).toMatchObject({ debit: 0, credit: 18 });
    expect(lines.find((r) => r.accountCode === 'COURIER_WALLET_DELHIVERY')).toMatchObject({ debit: 118, credit: 0 });
  });

  it('reconciles matched gateway sales without setting bank verification from gateway evidence', async () => {
    prismaMock.order.findFirst.mockResolvedValueOnce({ id: 9, paymentReceivedUtr: null });
    prismaMock.order.update.mockResolvedValue({ id: 9 });
    const postSpy = vi.spyOn(ledgerService, 'postGatewaySettlement').mockResolvedValue({ id: 44 });
    const date = new Date('2026-11-05T12:00:00Z');
    await gatewayExpenseService.reconcileAndPostBatch('EASEBUZZ', 'MATCHED-101', date, [
      { gateway: 'EASEBUZZ', orderReference: '#26YOU5900', transactionId: 'TXN-101',
        grossAmount: 1000, mdrFee: 10, gstOnFee: 1.8, netCredit: 988.2,
        batchId: 'MATCHED-101', settlementDate: date },
    ]);
    expect(postSpy).toHaveBeenCalledWith(expect.objectContaining({ matchedGrossAmount: 1000 }));
    const change = prismaMock.order.update.mock.calls[0][0].data;
    expect(change).not.toHaveProperty('paymentVerified');
    expect(change).not.toHaveProperty('paymentVerifiedAt');
  });

  it('parses day-first two-digit bank years and discards invalid or missing dates', () => {
    const parsed = bankReconciliationService.parseBankCsv([
      { Date: '05/11/26', Description: 'Valid bank credit', UTR: 'UTR001', Credit: '988.20' },
      { Date: '31/02/26', Description: 'Impossible date', UTR: 'UTR002', Credit: '500.00' },
      { Description: 'Missing date', UTR: 'UTR003', Credit: '700.00' },
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].transactionDate.toISOString()).toBe('2026-11-04T18:30:00.000Z');
    expect(parsed[0].referenceNo).toBe('UTR001');
  });
  it('splits one Velocity RTO row into separate forward, RTO, COD, weight and tax allocations', () => {
    const rows = freightEngineService.parseVelocityChargesRows([{
      AWB: 'VEL-MIX-101',
      'Forward Charges': '60.00',
      'RTO Charges': '90.00',
      'Weight Charges': '10.00',
      'COD Charges': '8.00',
      GST: '30.24',
      'Total Amount': '198.24',
    }], 'VEL-BILL-MIXED', new Date('2026-11-05T12:00:00Z'));
    expect(rows).toHaveLength(4);
    expect(rows.filter((r) => r.leg === 'RTO').map((r) => r.baseFreight)).toEqual([90]);
    expect(rows.reduce((sum, r) => sum + r.totalBilled, 0)).toBeCloseTo(198.24, 2);
    expect(rows.reduce((sum, r) => sum + r.gstAmount, 0)).toBeCloseTo(30.24, 2);
    expect(rows.reduce((sum, r) => sum + (r.codFee || 0), 0)).toBe(8);
    expect(rows.reduce((sum, r) => sum + (r.weightSurcharge || 0), 0)).toBe(10);
  });

  it('rejects Velocity invoice source totals that do not match component charges', () => {
    expect(() => freightEngineService.parseVelocityChargesRows([{
      AWB: 'VEL-MISMATCH',
      'Forward Charges': '100',
      GST: '18',
      'Total Amount': '150',
    }], 'VEL-BAD', new Date('2026-11-05T12:00:00Z'))).toThrow(/do not reconcile/);
  });

  it('uses the tax rate effective at supply time and refuses mixed-rate orders', () => {
    const base = { totalAmount: 1999, totalDiscounts: 0, items: [{ price: 1999, quantity: 1 }] };
    expect(gstService.determineOrderGstRate({ ...base, shopifyCreatedAt: new Date('2025-09-20T12:00:00Z') })).toBe(12);
    expect(gstService.determineOrderGstRate({ ...base, shopifyCreatedAt: new Date('2025-09-23T12:00:00Z') })).toBe(5);
    expect(() => gstService.determineOrderGstRate({ ...base, shopifyCreatedAt: new Date('2026-10-20T12:00:00Z'), items: [{price: 2400, quantity: 1}, {price: 3000, quantity: 1}] }))
      .toThrow(/Mixed GST rates/);
  });

  it('uses exactly the accounting chart names for Tally ledger masters', () => {
    expect(TALLY_STANDARD_LEDGER_MASTERS.map((entry) => entry.name))
      .toEqual(DEFAULT_LEDGER_ACCOUNTS.map((entry) => entry.name));
  });

});
