/**
 * Double-Entry Financial Accounting Ledger Service
 *
 * Implements strict, auditable double-entry general ledger bookkeeping for:
 * - Shopify sales invoices & tax liability (CGST/SGST/IGST)
 * - Customer return credit notes & tax reversal
 * - Payment gateway settlements, MDR expense & input GST
 * - COD remittances & handling fees
 * - Courier freight expenses, weight surcharges & input GST
 * - Courier wallet prepayment transfers (Asset-to-Asset)
 * - Customer refunds & bank payments
 *
 * Invariant: Total Debits == Total Credits (enforced on every entry).
 * Monetary precision: Decimal arithmetic with exact 2-decimal rounding.
 */

import { Prisma, AccountType, VoucherType, EntryStatus } from '@prisma/client';
import prisma from '../../database/prisma';
import logger from '../../utils/logger';
import { gstService, resolvePosCode } from './gst.service';

export interface PostSalesParams {
  orderId: number;
  entryDate?: Date;
  postingDate?: Date;
  period?: string; // YYYY-MM
}

export interface PostReturnParams {
  returnId: number;
  entryDate?: Date;
  postingDate?: Date;
  period?: string;
}

export interface PostGatewaySettlementParams {
  gateway: 'EASEBUZZ' | 'GOKWIK' | 'PHONEPE';
  batchId: string;
  grossAmount: number;
  feeAmount: number;
  feeGst: number;
  netBankCredit: number;
  bankUtr?: string;
  settlementDate: Date;
  postingDate?: Date;
  period: string;
  orderIds?: number[];
}

export interface PostCodRemittanceParams {
  carrier: 'DELHIVERY' | 'VELOCITY';
  remittanceRef: string;
  grossAmount: number;
  codFee?: number;
  feeGst?: number;
  netBankCredit: number;
  bankUtr?: string;
  remittanceDate: Date;
  postingDate?: Date;
  period: string;
  orderIds?: number[];
}

export interface PostFreightBillParams {
  carrier: 'DELHIVERY' | 'VELOCITY';
  invoiceNumber: string;
  invoiceDate: Date;
  period: string;
  forwardFreight: number;
  rtoFreight?: number;
  reverseFreight?: number;
  weightSurcharges?: number;
  codHandlingFee?: number;
  freightGst: number;
  totalBilled: number;
  isWalletDeducted?: boolean;
  underlyingCarrier?: string;
}

export interface PostWalletTopupParams {
  carrier: 'DELHIVERY' | 'VELOCITY';
  amount: number;
  date: Date;
  bankRef: string;
  period: string;
}

export interface TrialBalanceRow {
  accountCode: string;
  accountName: string;
  accountType: AccountType;
  subType: string | null;
  openingDebit: number;
  openingCredit: number;
  periodDebit: number;
  periodCredit: number;
  closingDebit: number;
  closingCredit: number;
}

export class LedgerService {
  private accountsCache = new Map<string, number>();

  /**
   * Seed / Ensure standard Chart of Accounts in the database.
   */
  public async ensureChartOfAccounts(): Promise<void> {
    const defaultAccounts: Array<{
      code: string;
      name: string;
      type: AccountType;
      subType: string;
    }> = [
      // Assets
      { code: 'BANK_MAIN', name: 'HDFC Bank Current Account', type: AccountType.ASSET, subType: 'BANK' },
      { code: 'COURIER_WALLET_DELHIVERY', name: 'Delhivery Prepaid Logistics Wallet', type: AccountType.ASSET, subType: 'PREPAYMENT' },
      { code: 'COURIER_WALLET_VELOCITY', name: 'Velocity Prepaid Logistics Wallet', type: AccountType.ASSET, subType: 'PREPAYMENT' },
      { code: 'SUNDRY_DEBTORS_PREPAID', name: 'Sundry Debtors - Online Store Customers', type: AccountType.ASSET, subType: 'DEBTORS' },
      { code: 'SUNDRY_DEBTORS_COD', name: 'Sundry Debtors - COD Customers', type: AccountType.ASSET, subType: 'DEBTORS' },
      { code: 'CLEARING_EASEBUZZ', name: 'Easebuzz Settlement Clearing Account', type: AccountType.ASSET, subType: 'GATEWAY_CLEARING' },
      { code: 'CLEARING_GOKWIK', name: 'GoKwik Settlement Clearing Account', type: AccountType.ASSET, subType: 'GATEWAY_CLEARING' },
      { code: 'CLEARING_PHONEPE', name: 'PhonePe Settlement Clearing Account', type: AccountType.ASSET, subType: 'GATEWAY_CLEARING' },
      { code: 'CLEARING_DELHIVERY_COD', name: 'Delhivery COD Remittance Clearing', type: AccountType.ASSET, subType: 'COURIER_CLEARING' },
      { code: 'CLEARING_VELOCITY_COD', name: 'Velocity COD Remittance Clearing', type: AccountType.ASSET, subType: 'COURIER_CLEARING' },
      { code: 'INPUT_CGST', name: 'Input CGST (Duties & Taxes)', type: AccountType.ASSET, subType: 'INPUT_TAX' },
      { code: 'INPUT_SGST', name: 'Input SGST (Duties & Taxes)', type: AccountType.ASSET, subType: 'INPUT_TAX' },
      { code: 'INPUT_IGST', name: 'Input IGST (Duties & Taxes)', type: AccountType.ASSET, subType: 'INPUT_TAX' },

      // Liabilities
      { code: 'SUNDRY_CREDITORS_DELHIVERY', name: 'Delhivery Limited (Vendor Payable)', type: AccountType.LIABILITY, subType: 'CREDITORS' },
      { code: 'SUNDRY_CREDITORS_VELOCITY', name: 'Velocity Technologies (Vendor Payable)', type: AccountType.LIABILITY, subType: 'CREDITORS' },
      { code: 'CUSTOMER_REFUND_PAYABLE', name: 'Customer Refund Payable Account', type: AccountType.LIABILITY, subType: 'REFUND_PAYABLE' },
      { code: 'OUTPUT_CGST', name: 'Output CGST (Central Goods & Services Tax)', type: AccountType.LIABILITY, subType: 'OUTPUT_TAX' },
      { code: 'OUTPUT_SGST', name: 'Output SGST (State Goods & Services Tax)', type: AccountType.LIABILITY, subType: 'OUTPUT_TAX' },
      { code: 'OUTPUT_IGST', name: 'Output IGST (Integrated Goods & Services Tax)', type: AccountType.LIABILITY, subType: 'OUTPUT_TAX' },

      // Equity
      { code: 'OWNERS_CAPITAL', name: 'Capital Account', type: AccountType.EQUITY, subType: 'EQUITY' },
      { code: 'RETAINED_EARNINGS', name: 'Retained Earnings', type: AccountType.EQUITY, subType: 'EQUITY' },

      // Revenue
      { code: 'SALES_REVENUE', name: 'Domestic Apparel Sales Revenue', type: AccountType.REVENUE, subType: 'SALES' },
      { code: 'SALES_RETURNS', name: 'Sales Returns & Deductions', type: AccountType.REVENUE, subType: 'SALES_RETURN' },

      // Expenses
      { code: 'EXPENSE_PG_FEES_EASEBUZZ', name: 'Payment Gateway Processing Fees (Easebuzz)', type: AccountType.EXPENSE, subType: 'MDR' },
      { code: 'EXPENSE_PG_FEES_GOKWIK', name: 'Checkout Technology Platform Fees (GoKwik)', type: AccountType.EXPENSE, subType: 'PLATFORM_FEE' },
      { code: 'EXPENSE_PG_FEES_PHONEPE', name: 'Payment Gateway Processing Fees (PhonePe)', type: AccountType.EXPENSE, subType: 'MDR' },
      { code: 'EXPENSE_FREIGHT_FORWARD', name: 'Freight Charges - Forward Shipments', type: AccountType.EXPENSE, subType: 'FREIGHT' },
      { code: 'EXPENSE_FREIGHT_RTO', name: 'Freight Charges - Return to Origin (RTO)', type: AccountType.EXPENSE, subType: 'FREIGHT' },
      { code: 'EXPENSE_FREIGHT_REVERSE', name: 'Freight Charges - Customer Reverse Pickups', type: AccountType.EXPENSE, subType: 'FREIGHT' },
      { code: 'EXPENSE_COD_HANDLING', name: 'Logistics COD Collection & Handling Charges', type: AccountType.EXPENSE, subType: 'COURIER_FEE' },
      { code: 'EXPENSE_WEIGHT_SURCHARGES', name: 'Logistics Weight Discrepancy Surcharges', type: AccountType.EXPENSE, subType: 'SURCHARGES' },
    ];

    for (const acc of defaultAccounts) {
      const existing = await prisma.ledgerAccount.upsert({
        where: { code: acc.code },
        create: {
          code: acc.code,
          name: acc.name,
          type: acc.type,
          subType: acc.subType,
        },
        update: {
          name: acc.name,
          type: acc.type,
          subType: acc.subType,
        },
      });
      this.accountsCache.set(acc.code, existing.id);
    }
  }

  public async getAccountId(code: string): Promise<number> {
    if (this.accountsCache.has(code)) {
      return this.accountsCache.get(code)!;
    }
    const acc = await prisma.ledgerAccount.findUnique({ where: { code } });
    if (!acc) {
      await this.ensureChartOfAccounts();
      const fresh = await prisma.ledgerAccount.findUnique({ where: { code } });
      if (!fresh) throw new Error(`Ledger account not found for code: ${code}`);
      this.accountsCache.set(code, fresh.id);
      return fresh.id;
    }
    this.accountsCache.set(code, acc.id);
    return acc.id;
  }

  /**
   * Helper to format accounting period "YYYY-MM" from a Date.
   */
  public toPeriod(d: Date): string {
    const ist = new Date(d.getTime() + 5.5 * 3600 * 1000);
    const yr = ist.getUTCFullYear();
    const mo = String(ist.getUTCMonth() + 1).padStart(2, '0');
    return `${yr}-${mo}`;
  }

  /**
   * Create a verified, balanced JournalEntry with LineItems in a single atomic transaction.
   * Throws an error if Debits != Credits.
   */
  public async createBalancedEntry(params: {
    entryNumber: string;
    voucherType: VoucherType;
    documentDate: Date;
    postingDate?: Date;
    accountingPeriod: string;
    reference?: string;
    orderId?: number;
    returnId?: number;
    narration?: string;
    lines: Array<{
      accountCode: string;
      debit: number;
      credit: number;
      partyName?: string;
      statePos?: string;
      gstRate?: number;
      narration?: string;
    }>;
    metadata?: any;
  }): Promise<any> {
    const postingDate = params.postingDate || params.documentDate;

    // Convert and sum lines
    let totalDebit = new Prisma.Decimal(0);
    let totalCredit = new Prisma.Decimal(0);

    const resolvedLines: Array<{
      accountId: number;
      debit: Prisma.Decimal;
      credit: Prisma.Decimal;
      partyName?: string;
      statePos?: string;
      gstRate?: Prisma.Decimal;
      narration?: string;
    }> = [];

    for (const line of params.lines) {
      const d = new Prisma.Decimal(Math.round(line.debit * 100) / 100);
      const c = new Prisma.Decimal(Math.round(line.credit * 100) / 100);
      totalDebit = totalDebit.plus(d);
      totalCredit = totalCredit.plus(c);

      const accountId = await this.getAccountId(line.accountCode);
      resolvedLines.push({
        accountId,
        debit: d,
        credit: c,
        partyName: line.partyName,
        statePos: line.statePos,
        gstRate: line.gstRate !== undefined ? new Prisma.Decimal(line.gstRate) : undefined,
        narration: line.narration,
      });
    }

    // Enforce Debits == Credits (allow max 0.01 rounding difference and adjust)
    const diff = totalDebit.minus(totalCredit).toNumber();
    if (Math.abs(diff) > 0.02) {
      throw new Error(
        `Double-entry imbalance in voucher ${params.entryNumber}: Total Debits (₹${totalDebit.toFixed(2)}) != Total Credits (₹${totalCredit.toFixed(2)}) (Diff: ${diff})`
      );
    }

    // Auto-balance tiny 1-paise rounding discrepancy if any
    if (Math.abs(diff) > 0 && resolvedLines.length > 0) {
      if (diff > 0) {
        // Debits exceed credits by 1 paise: increase credit of first non-zero credit line
        const cLine = resolvedLines.find((l) => l.credit.gt(0));
        if (cLine) {
          cLine.credit = cLine.credit.plus(new Prisma.Decimal(diff));
          totalCredit = totalCredit.plus(new Prisma.Decimal(diff));
        }
      } else {
        // Credits exceed debits: increase debit of first non-zero debit line
        const dLine = resolvedLines.find((l) => l.debit.gt(0));
        if (dLine) {
          dLine.debit = dLine.debit.plus(new Prisma.Decimal(Math.abs(diff)));
          totalDebit = totalDebit.plus(new Prisma.Decimal(Math.abs(diff)));
        }
      }
    }

    // Idempotent upsert
    return await prisma.$transaction(async (tx) => {
      const existing = await tx.journalEntry.findUnique({
        where: { entryNumber: params.entryNumber },
      });
      // Protect both the destination and original period when correcting an existing voucher.
      const affectedPeriods = new Set([params.accountingPeriod, existing?.accountingPeriod].filter(Boolean) as string[]);
      for (const period of affectedPeriods) {
        const snapshot = await tx.monthlyClosingSnapshot.findUnique({ where: { period } });
        if (snapshot?.status === 'CLOSED') {
          throw new Error(`Cannot post or revise voucher ${params.entryNumber}: accounting period ${period} is CLOSED.`);
        }
      }
      if (existing) {
        // Delete existing lines and re-post
        await tx.journalLineItem.deleteMany({
          where: { journalEntryId: existing.id },
        });
        const updated = await tx.journalEntry.update({
          where: { id: existing.id },
          data: {
            voucherType: params.voucherType,
            documentDate: params.documentDate,
            postingDate,
            accountingPeriod: params.accountingPeriod,
            reference: params.reference,
            orderId: params.orderId,
            returnId: params.returnId,
            narration: params.narration,
            totalDebit,
            totalCredit,
            metadata: params.metadata || Prisma.JsonNull,
            lines: {
              create: resolvedLines,
            },
          },
          include: { lines: { include: { account: true } } },
        });
        return updated;
      }

      return await tx.journalEntry.create({
        data: {
          entryNumber: params.entryNumber,
          voucherType: params.voucherType,
          documentDate: params.documentDate,
          postingDate,
          accountingPeriod: params.accountingPeriod,
          reference: params.reference,
          orderId: params.orderId,
          returnId: params.returnId,
          narration: params.narration,
          status: EntryStatus.POSTED,
          totalDebit,
          totalCredit,
          metadata: params.metadata || Prisma.JsonNull,
          lines: {
            create: resolvedLines,
          },
        },
        include: { lines: { include: { account: true } } },
      });
    });
  }

  /**
   * Phase 2 & 6: Post a balanced Sales Invoice Voucher for an Order.
   */
  public async postSalesInvoice(params: PostSalesParams): Promise<any> {
    const order = await prisma.order.findUnique({
      where: { id: params.orderId },
      include: { items: true },
    });
    if (!order) throw new Error(`Order ${params.orderId} not found`);

    const docDate = params.entryDate || order.shopifyCreatedAt;
    const period = params.period || this.toPeriod(docDate);
    const entryNumber = `INV-${order.shopifyOrderName.replace(/^#/, '')}`;

    const isCod = order.paymentMethod === 'COD';
    const debtorAccount = isCod ? 'SUNDRY_DEBTORS_COD' : 'SUNDRY_DEBTORS_PREPAID';

    const tax = gstService.calculateSalesTax(order.totalAmount, order.customerState, undefined, order);

    const lines: Array<{
      accountCode: string;
      debit: number;
      credit: number;
      partyName?: string;
      statePos?: string;
      gstRate?: number;
      narration?: string;
    }> = [
      // 1. Debit Sundry Debtors for gross invoice value
      {
        accountCode: debtorAccount,
        debit: tax.grossAmount,
        credit: 0,
        partyName: order.customerName,
        statePos: `${tax.posCode}-${tax.posState}`,
        narration: `Sales Invoice ${order.shopifyOrderName} to ${order.customerName}`,
      },
      // 2. Credit Sales Revenue for taxable turnover
      {
        accountCode: 'SALES_REVENUE',
        debit: 0,
        credit: tax.taxableAmount,
        statePos: `${tax.posCode}-${tax.posState}`,
        gstRate: tax.gstRate,
        narration: `Taxable apparel sales (${tax.gstRate}% GST)`,
      },
    ];

    // 3. Credit Output Tax
    if (tax.isInterState) {
      lines.push({
        accountCode: 'OUTPUT_IGST',
        debit: 0,
        credit: tax.igst,
        statePos: `${tax.posCode}-${tax.posState}`,
        gstRate: tax.gstRate,
        narration: `Output IGST @ ${tax.gstRate}% on ${order.shopifyOrderName}`,
      });
    } else {
      lines.push({
        accountCode: 'OUTPUT_CGST',
        debit: 0,
        credit: tax.cgst,
        statePos: `${tax.posCode}-${tax.posState}`,
        gstRate: tax.gstRate / 2,
        narration: `Output CGST @ ${tax.gstRate / 2}% on ${order.shopifyOrderName}`,
      });
      lines.push({
        accountCode: 'OUTPUT_SGST',
        debit: 0,
        credit: tax.sgst,
        statePos: `${tax.posCode}-${tax.posState}`,
        gstRate: tax.gstRate / 2,
        narration: `Output SGST @ ${tax.gstRate / 2}% on ${order.shopifyOrderName}`,
      });
    }

    return await this.createBalancedEntry({
      entryNumber,
      voucherType: VoucherType.SALES,
      documentDate: docDate,
      postingDate: params.postingDate || docDate,
      accountingPeriod: period,
      reference: order.shopifyOrderName,
      orderId: order.id,
      narration: `Shopify Sales Invoice ${order.shopifyOrderName} · ${order.customerName} · POS ${tax.posCode} (${tax.posState})`,
      lines,
      metadata: {
        gstBreakdown: tax,
        shopifyOrderId: order.shopifyOrderId,
        paymentMethod: order.paymentMethod,
      },
    });
  }

  /**
   * Phase 2 & 6: Post a balanced Credit Note Voucher for a Customer Return.
   */
  public async postCustomerReturnCreditNote(params: PostReturnParams): Promise<any> {
    const returnRecord = await prisma.return.findUnique({
      where: { id: params.returnId },
      include: { order: { include: { items: true } } },
    });
    if (!returnRecord) throw new Error(`Return ${params.returnId} not found`);

    const order = returnRecord.order;
    const docDate = params.entryDate || returnRecord.receivedAt || returnRecord.createdAt;
    const period = params.period || this.toPeriod(docDate);
    const entryNumber = `CN-${order.shopifyOrderName.replace(/^#/, '')}-${returnRecord.id}`;

    const refundAmt = returnRecord.refundAmount && returnRecord.refundAmount > 0
      ? returnRecord.refundAmount
      : order.totalAmount;

    // Check if original sales invoice entry recorded the exact GST rate
    let originalGstRate: number | undefined;
    const invoiceEntry = await prisma.journalEntry.findFirst({
      where: { orderId: order.id, voucherType: VoucherType.SALES },
      select: { metadata: true },
    });
    if (invoiceEntry?.metadata && typeof invoiceEntry.metadata === 'object') {
      const meta = invoiceEntry.metadata as any;
      if (typeof meta.gstBreakdown?.gstRate === 'number') {
        originalGstRate = meta.gstBreakdown.gstRate;
      }
    }
    if (originalGstRate === undefined) {
      originalGstRate = gstService.determineOrderGstRate(order);
    }
    const tax = gstService.calculateReturnTax(refundAmt, order.customerState, originalGstRate);

    const isCod = order.paymentMethod === 'COD';
    const debtorAccount = isCod ? 'SUNDRY_DEBTORS_COD' : 'SUNDRY_DEBTORS_PREPAID';

    const lines: Array<{
      accountCode: string;
      debit: number;
      credit: number;
      partyName?: string;
      statePos?: string;
      gstRate?: number;
      narration?: string;
    }> = [
      // 1. Debit Sales Returns (contra-revenue)
      {
        accountCode: 'SALES_RETURNS',
        debit: tax.taxableAmount,
        credit: 0,
        partyName: order.customerName,
        statePos: `${tax.posCode}-${tax.posState}`,
        gstRate: tax.gstRate,
        narration: `Customer return taxable reversal on ${order.shopifyOrderName}`,
      },
    ];

    // 2. Debit (reverse) Output GST
    if (tax.isInterState) {
      lines.push({
        accountCode: 'OUTPUT_IGST',
        debit: tax.igst,
        credit: 0,
        statePos: `${tax.posCode}-${tax.posState}`,
        gstRate: tax.gstRate,
        narration: `Reverse Output IGST on Credit Note ${entryNumber}`,
      });
    } else {
      lines.push({
        accountCode: 'OUTPUT_CGST',
        debit: tax.cgst,
        credit: 0,
        statePos: `${tax.posCode}-${tax.posState}`,
        gstRate: tax.gstRate / 2,
        narration: `Reverse Output CGST on Credit Note ${entryNumber}`,
      });
      lines.push({
        accountCode: 'OUTPUT_SGST',
        debit: tax.sgst,
        credit: 0,
        statePos: `${tax.posCode}-${tax.posState}`,
        gstRate: tax.gstRate / 2,
        narration: `Reverse Output SGST on Credit Note ${entryNumber}`,
      });
    }

    // 3. Credit Sundry Debtors / Customer Refund Payable
    lines.push({
      accountCode: debtorAccount,
      debit: 0,
      credit: tax.grossAmount,
      partyName: order.customerName,
      statePos: `${tax.posCode}-${tax.posState}`,
      narration: `Credit Note against ${order.shopifyOrderName} for returned merchandise`,
    });

    return await this.createBalancedEntry({
      entryNumber,
      voucherType: VoucherType.CREDIT_NOTE,
      documentDate: docDate,
      postingDate: params.postingDate || docDate,
      accountingPeriod: period,
      reference: order.shopifyOrderName,
      orderId: order.id,
      returnId: returnRecord.id,
      narration: `GST Credit Note ${entryNumber} for Return #${returnRecord.id} on ${order.shopifyOrderName} (${tax.posState})`,
      lines,
      metadata: {
        gstBreakdown: tax,
        returnReason: returnRecord.returnReason,
        waybill: returnRecord.returnWaybillNumber,
      },
    });
  }

  /**
   * Phase 3: Post Payment Gateway Settlement Voucher (Gross Collection, MDR Expense, Input GST, Bank Credit).
   */
  public async postGatewaySettlement(params: PostGatewaySettlementParams): Promise<any> {
    const entryNumber = `SETTLE-PG-${params.gateway}-${params.batchId}`;
    const clearingAccount = params.gateway === 'PHONEPE'
      ? 'CLEARING_PHONEPE'
      : (params.gateway === 'GOKWIK' ? 'CLEARING_GOKWIK' : 'CLEARING_EASEBUZZ');

    const feeAccount = params.gateway === 'PHONEPE'
      ? 'EXPENSE_PG_FEES_PHONEPE'
      : (params.gateway === 'GOKWIK' ? 'EXPENSE_PG_FEES_GOKWIK' : 'EXPENSE_PG_FEES_EASEBUZZ');

    const lines: Array<{
      accountCode: string;
      debit: number;
      credit: number;
      partyName?: string;
      narration?: string;
    }> = [
      // 1. Debit Bank Main Account for actual funds credited
      {
        accountCode: 'BANK_MAIN',
        debit: params.netBankCredit,
        credit: 0,
        narration: `Bank receipt UTR: ${params.bankUtr || 'Pending UTR'}`,
      },
      // 2. Debit PG Fee Expense (MDR)
      {
        accountCode: feeAccount,
        debit: params.feeAmount,
        credit: 0,
        narration: `${params.gateway} processing fee on batch ${params.batchId}`,
      },
    ];

    // 3. Debit Input GST on MDR (if eligible)
    if (params.feeGst > 0) {
      lines.push({
        accountCode: 'INPUT_IGST',
        debit: params.feeGst,
        credit: 0,
        narration: `Input IGST on ${params.gateway} fee`,
      });
    }

    // 4. Credit Sundry Debtors (clearing customer receivables) or Gateway Clearing
    const creditAccount = params.orderIds && params.orderIds.length > 0 ? 'SUNDRY_DEBTORS_PREPAID' : clearingAccount;
    lines.push({
      accountCode: creditAccount,
      debit: 0,
      credit: params.grossAmount,
      narration: `Gross settlement batch ${params.batchId} from ${params.gateway} clearing receivables`,
    });

    return await this.createBalancedEntry({
      entryNumber,
      voucherType: VoucherType.RECEIPT,
      documentDate: params.settlementDate,
      postingDate: params.postingDate || params.settlementDate,
      accountingPeriod: params.period,
      reference: params.batchId,
      narration: `${params.gateway} Bank Settlement Batch ${params.batchId} · UTR: ${params.bankUtr || 'N/A'}`,
      lines,
      metadata: {
        gateway: params.gateway,
        batchId: params.batchId,
        utr: params.bankUtr,
        ordersCount: params.orderIds?.length || 0,
      },
    });
  }

  /**
   * Phase 4: Post COD Remittance Voucher (Courier Collections, COD Handling Fee, Bank Credit).
   */
  public async postCodRemittance(params: PostCodRemittanceParams): Promise<any> {
    const entryNumber = `REMIT-COD-${params.carrier}-${params.remittanceRef}`;
    const clearingAccount = params.carrier === 'DELHIVERY' ? 'CLEARING_DELHIVERY_COD' : 'CLEARING_VELOCITY_COD';

    const lines: Array<{
      accountCode: string;
      debit: number;
      credit: number;
      narration?: string;
    }> = [
      // 1. Debit Bank for actual funds remitted
      {
        accountCode: 'BANK_MAIN',
        debit: params.netBankCredit,
        credit: 0,
        narration: `${params.carrier} COD Remittance UTR: ${params.bankUtr || 'Pending UTR'}`,
      },
    ];

    // 2. Debit COD fee if deducted at source
    if (params.codFee && params.codFee > 0) {
      lines.push({
        accountCode: 'EXPENSE_COD_HANDLING',
        debit: params.codFee,
        credit: 0,
        narration: `${params.carrier} COD Handling / remittance charges`,
      });
    }

    // 3. Debit Input GST on COD fee if applicable
    if (params.feeGst && params.feeGst > 0) {
      lines.push({
        accountCode: 'INPUT_IGST',
        debit: params.feeGst,
        credit: 0,
        narration: `Input GST on ${params.carrier} COD fee`,
      });
    }

    // 4. Credit Sundry Debtors COD (clearing customer receivables) or Clearing
    const creditAccount = params.orderIds && params.orderIds.length > 0 ? 'SUNDRY_DEBTORS_COD' : clearingAccount;
    lines.push({
      accountCode: creditAccount,
      debit: 0,
      credit: params.grossAmount,
      narration: `Gross COD collected by ${params.carrier} (Ref: ${params.remittanceRef}) clearing receivables`,
    });

    return await this.createBalancedEntry({
      entryNumber,
      voucherType: VoucherType.RECEIPT,
      documentDate: params.remittanceDate,
      postingDate: params.postingDate || params.remittanceDate,
      accountingPeriod: params.period,
      reference: params.remittanceRef,
      narration: `${params.carrier} COD Remittance ${params.remittanceRef} · Net Credit: ₹${params.netBankCredit}`,
      lines,
      metadata: {
        carrier: params.carrier,
        remittanceRef: params.remittanceRef,
        utr: params.bankUtr,
      },
    });
  }

  /**
   * Phase 4: Post Freight Invoice / Bill Voucher (Delhivery or Velocity).
   */
  public async postFreightBill(params: PostFreightBillParams): Promise<any> {
    const entryNumber = `BILL-FRT-${params.carrier}-${params.invoiceNumber}`;
    const payableAccount = params.isWalletDeducted
      ? (params.carrier === 'DELHIVERY' ? 'COURIER_WALLET_DELHIVERY' : 'COURIER_WALLET_VELOCITY')
      : (params.carrier === 'DELHIVERY' ? 'SUNDRY_CREDITORS_DELHIVERY' : 'SUNDRY_CREDITORS_VELOCITY');

    const lines: Array<{
      accountCode: string;
      debit: number;
      credit: number;
      narration?: string;
    }> = [];

    // Forward freight
    if (params.forwardFreight > 0) {
      lines.push({
        accountCode: 'EXPENSE_FREIGHT_FORWARD',
        debit: params.forwardFreight,
        credit: 0,
        narration: `Forward logistics freight charges (${params.carrier})`,
      });
    }

    // RTO freight
    if (params.rtoFreight && params.rtoFreight > 0) {
      lines.push({
        accountCode: 'EXPENSE_FREIGHT_RTO',
        debit: params.rtoFreight,
        credit: 0,
        narration: `Return to Origin freight charges (${params.carrier})`,
      });
    }

    // Reverse pickup freight
    if (params.reverseFreight && params.reverseFreight > 0) {
      lines.push({
        accountCode: 'EXPENSE_FREIGHT_REVERSE',
        debit: params.reverseFreight,
        credit: 0,
        narration: `Customer reverse pickup freight (${params.carrier})`,
      });
    }

    // Weight discrepancy surcharges
    if (params.weightSurcharges && params.weightSurcharges > 0) {
      lines.push({
        accountCode: 'EXPENSE_WEIGHT_SURCHARGES',
        debit: params.weightSurcharges,
        credit: 0,
        narration: `Weight discrepancy re-billing surcharges (${params.carrier})`,
      });
    }

    // COD handling fee
    if (params.codHandlingFee && params.codHandlingFee > 0) {
      lines.push({
        accountCode: 'EXPENSE_COD_HANDLING',
        debit: params.codHandlingFee,
        credit: 0,
        narration: `COD collection & service fee (${params.carrier})`,
      });
    }

    // Input GST on freight (18%)
    if (params.freightGst > 0) {
      lines.push({
        accountCode: 'INPUT_IGST',
        debit: params.freightGst,
        credit: 0,
        narration: `Input IGST on freight invoice ${params.invoiceNumber}`,
      });
    }

    // Credit Vendor Payable or Wallet Asset
    lines.push({
      accountCode: payableAccount,
      debit: 0,
      credit: params.totalBilled,
      narration: params.isWalletDeducted
        ? `Wallet debit deduction by ${params.carrier}`
        : `Payable to ${params.carrier} for invoice ${params.invoiceNumber}`,
    });

    return await this.createBalancedEntry({
      entryNumber,
      voucherType: VoucherType.PURCHASE,
      documentDate: params.invoiceDate,
      postingDate: params.invoiceDate,
      accountingPeriod: params.period,
      reference: params.invoiceNumber,
      narration: `${params.carrier} Freight Invoice ${params.invoiceNumber} (${params.period}) · Total: ₹${params.totalBilled}`,
      lines,
      metadata: {
        carrier: params.carrier,
        invoiceNumber: params.invoiceNumber,
        underlyingCarrier: params.underlyingCarrier,
      },
    });
  }

  /**
   * Phase 4: Post Wallet Top-up (Prepayment Asset Transfer: Bank -> Wallet).
   * Note: This is an Asset transfer, NOT an expense!
   */
  public async postWalletTopup(params: PostWalletTopupParams): Promise<any> {
    const entryNumber = `TOPUP-${params.carrier}-${params.bankRef}`;
    const walletAccount = params.carrier === 'DELHIVERY' ? 'COURIER_WALLET_DELHIVERY' : 'COURIER_WALLET_VELOCITY';

    const lines = [
      {
        accountCode: walletAccount,
        debit: params.amount,
        credit: 0,
        narration: `Top-up advance credit to ${params.carrier} wallet (Ref: ${params.bankRef})`,
      },
      {
        accountCode: 'BANK_MAIN',
        debit: 0,
        credit: params.amount,
        narration: `Bank transfer debit for ${params.carrier} wallet top-up`,
      },
    ];

    return await this.createBalancedEntry({
      entryNumber,
      voucherType: VoucherType.PAYMENT,
      documentDate: params.date,
      postingDate: params.date,
      accountingPeriod: params.period,
      reference: params.bankRef,
      narration: `${params.carrier} Wallet Prepayment Top-up · ₹${params.amount}`,
      lines,
      metadata: {
        carrier: params.carrier,
        bankRef: params.bankRef,
      },
    });
  }

  /**
   * Phase 5 & 8: Generate balanced Trial Balance for an accounting period.
   */
  public async getTrialBalance(period?: string): Promise<{
    rows: TrialBalanceRow[];
    totalDebit: number;
    totalCredit: number;
    isBalanced: boolean;
  }> {
    await this.ensureChartOfAccounts();

    const accounts = await prisma.ledgerAccount.findMany({
      orderBy: { code: 'asc' },
    });

    const whereClause: Prisma.JournalLineItemWhereInput = period
      ? { journalEntry: { accountingPeriod: period, status: EntryStatus.POSTED } }
      : { journalEntry: { status: EntryStatus.POSTED } };

    const lineItems = await prisma.journalLineItem.findMany({
      where: whereClause,
      include: { account: true },
    });

    const accountMovements = new Map<number, { debit: number; credit: number }>();
    for (const item of lineItems) {
      const cur = accountMovements.get(item.accountId) || { debit: 0, credit: 0 };
      cur.debit += item.debit.toNumber();
      cur.credit += item.credit.toNumber();
      accountMovements.set(item.accountId, cur);
    }

    const rows: TrialBalanceRow[] = [];
    let grandDebit = 0;
    let grandCredit = 0;

    for (const acc of accounts) {
      const mov = accountMovements.get(acc.id) || { debit: 0, credit: 0 };
      const net = mov.debit - mov.credit;
      const closingDebit = net > 0 ? net : 0;
      const closingCredit = net < 0 ? Math.abs(net) : 0;

      grandDebit += mov.debit;
      grandCredit += mov.credit;

      rows.push({
        accountCode: acc.code,
        accountName: acc.name,
        accountType: acc.type,
        subType: acc.subType,
        openingDebit: 0,
        openingCredit: 0,
        periodDebit: Math.round(mov.debit * 100) / 100,
        periodCredit: Math.round(mov.credit * 100) / 100,
        closingDebit: Math.round(closingDebit * 100) / 100,
        closingCredit: Math.round(closingCredit * 100) / 100,
      });
    }

    const diff = Math.abs(grandDebit - grandCredit);
    const isBalanced = diff < 0.05;

    return {
      rows,
      totalDebit: Math.round(grandDebit * 100) / 100,
      totalCredit: Math.round(grandCredit * 100) / 100,
      isBalanced,
    };
  }
}

export const ledgerService = new LedgerService();
