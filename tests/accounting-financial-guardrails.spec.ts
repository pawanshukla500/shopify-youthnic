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

describe('Financial accounting guardrails', () => {
  beforeEach(() => vi.clearAllMocks());
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
});
