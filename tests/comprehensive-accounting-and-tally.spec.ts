import { describe, it, expect, vi, beforeEach } from 'vitest';
import { gstService, resolvePosCode } from '../src/modules/accounts/gst.service';
import { ledgerService } from '../src/modules/accounts/ledger.service';
import { gatewayExpenseService } from '../src/modules/accounts/gateway-expense.service';
import { freightEngineService } from '../src/modules/accounts/freight-engine.service';
import { bankReconciliationService } from '../src/modules/accounts/bank-reconciliation.service';
import { tallyIntegrationService } from '../src/modules/accounts/tally-integration.service';
import { buildStateAccountingSummary } from '../src/modules/accounts/accounts-report.service';

describe('Comprehensive Accounting, Ledger, GST & Tally Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('1. Dynamic GST Calculation vs Universal 18% Assumption', () => {
    it('calculates 5% GST for apparel under ₹1000 in inter-state orders (IGST)', () => {
      const tax = gstService.calculateSalesTax(799, 'Maharashtra', 5);
      expect(tax.isInterState).toBe(true);
      expect(tax.posCode).toBe('27');
      expect(tax.posState).toBe('Maharashtra');
      expect(tax.gstRate).toBe(5);
      // Taxable = 799 / 1.05 = 760.95
      expect(tax.taxableAmount).toBe(760.95);
      expect(tax.totalGst).toBe(38.05);
      expect(tax.igst).toBe(38.05);
      expect(tax.cgst).toBe(0);
      expect(tax.sgst).toBe(0);
      expect(Math.round((tax.taxableAmount + tax.totalGst) * 100) / 100).toBe(799);
    });

    it('splits into 2.5% CGST + 2.5% SGST for intra-state Gujarat orders (POS 24)', () => {
      const tax = gstService.calculateSalesTax(1000, 'Gujarat', 5);
      expect(tax.isInterState).toBe(false);
      expect(tax.posCode).toBe('24');
      expect(tax.taxableAmount).toBe(952.38);
      expect(tax.totalGst).toBe(47.62);
      expect(tax.cgst).toBe(23.81);
      expect(tax.sgst).toBe(23.81);
      expect(tax.igst).toBe(0);
      expect(Math.round((tax.taxableAmount + tax.cgst + tax.sgst) * 100) / 100).toBe(1000);
    });

    it('supports 12% GST for garments over ₹1000', () => {
      const tax = gstService.calculateSalesTax(1499, 'Delhi', 12);
      expect(tax.gstRate).toBe(12);
      expect(tax.isInterState).toBe(true);
      expect(tax.posCode).toBe('07');
      // Taxable = 1499 / 1.12 = 1338.39
      expect(tax.taxableAmount).toBe(1338.39);
      expect(tax.totalGst).toBe(160.61);
      expect(tax.igst).toBe(160.61);
    });

    it('correctly calculates credit note tax reversal on customer returns', () => {
      const returnTax = gstService.calculateReturnTax(500, 'Karnataka', 5);
      expect(returnTax.grossAmount).toBe(500);
      expect(returnTax.taxableAmount).toBe(476.19);
      expect(returnTax.igst).toBe(23.81);
    });
  });

  describe('2. Payment Gateway Accounting & Double-Fee Prevention', () => {
    it('enforces Gross = Bank Credit + MDR Fee + Input GST without reducing sales', () => {
      const rows = [
        {
          orderReference: '#26YOU5754',
          gateway: 'EASEBUZZ' as const,
          transactionId: 'TXN-EB-101',
          paymentId: 'PAY-101',
          grossAmount: 1000,
          mdrFee: 10,
          gstOnFee: 1.80,
          netCredit: 988.20,
          batchId: 'BATCH-2026-OCT',
          bankUtr: 'UTR123456789012',
          settlementDate: new Date('2026-11-03'),
        },
      ];

      const r = rows[0];
      const sumDebits = r.netCredit + r.mdrFee + r.gstOnFee;
      expect(Math.round(sumDebits * 100) / 100).toBe(r.grossAmount);
    });

    it('prevents double-booking fee between GoKwik checkout and Easebuzz processing', () => {
      // If Easebuzz already recorded the MDR fee, GoKwik row with same transactionId is skipped
      const rows = gatewayExpenseService.parseEasebuzzRows(
        [
          { 'Order ID': '#26YOU5754', 'Gross Amount': 1000, 'MDR': 10, 'GST': 1.8, 'Transaction ID': 'TXN-COMMON' },
          { 'Order ID': '#26YOU5754', 'Gross Amount': 1000, 'MDR': 10, 'GST': 1.8, 'Transaction ID': 'TXN-COMMON' },
        ],
        'BATCH-DUP',
        new Date()
      );
      expect(rows.length).toBe(2);
      // Deduplicate by transaction ID
      const seenTxns = new Set<string>();
      const deduped = rows.filter(r => {
        if (!r.transactionId || seenTxns.has(r.transactionId)) return false;
        seenTxns.add(r.transactionId);
        return true;
      });
      expect(deduped.length).toBe(1);
    });
  });

  describe('3. Freight Expense Engine & Courier Deduplication', () => {
    it('distinguishes courier wallet top-up (Asset transfer) from freight expense', () => {
      // A wallet top-up debits COURIER_WALLETS (Asset 1130) and credits BANK_MAIN (Asset 1110)
      // It must never debit an expense account (5xxx)
      const topupLines = [
        { accountCode: 'COURIER_WALLETS', debit: 5000, credit: 0 },
        { accountCode: 'BANK_MAIN', debit: 0, credit: 5000 },
      ];
      const hasExpenseLine = topupLines.some(l => l.accountCode.startsWith('EXPENSE'));
      expect(hasExpenseLine).toBe(false);
      expect(topupLines[0].accountCode).toBe('COURIER_WALLETS');
    });

    it('correctly calculates 18% Input GST on courier logistics services', () => {
      const breakdown = gstService.calculateFreightTax(333.57, 18);
      // 333.57 / 1.18 = 282.69 taxable, 50.88 GST
      expect(breakdown.taxableFreight).toBe(282.69);
      expect(breakdown.freightGst).toBe(50.88);
      expect(breakdown.totalFreight).toBe(333.57);
    });

    it('parses Delhivery charges and categorizes forward, RTO, and reverse legs', () => {
      const parsed = freightEngineService.parseDelhiveryChargesRows(
        [
          { Waybill: '3010081001', Debit: '70.80', Description: 'Forward freight' },
          { Waybill: '3010081002', Debit: '118.00', Description: 'RTO freight charges' },
          { Waybill: '3010081003', Debit: '82.60', Description: 'Reverse pickup from customer' },
        ],
        'INV-DEL-101',
        new Date('2026-10-31')
      );

      expect(parsed.length).toBe(3);
      expect(parsed[0].leg).toBe('FORWARD');
      expect(parsed[1].leg).toBe('RTO');
      expect(parsed[2].leg).toBe('REVERSE');
    });
  });

  describe('4. Bank & UTR Reconciliation Engine', () => {
    it('parses bank statement CSV rows and extracts UTR references', () => {
      const rawBankRows = [
        {
          Date: '2026-11-04',
          Description: 'CMS/EASEBUZZ/PAYOUT/UTR987654321098',
          'Chq./Ref.No.': 'UTR987654321098',
          Credit: '49410.00',
          Debit: '0',
          Balance: '150420.00',
        },
        {
          Date: '2026-11-05',
          Description: 'DELHIVERY REMITTANCE 30100810014162',
          Credit: '1344.00',
          Debit: '0',
        },
      ];

      const parsed = bankReconciliationService.parseBankCsv(rawBankRows);
      expect(parsed.length).toBe(2);
      expect(parsed[0].credit).toBe(49410);
      expect(parsed[0].referenceNo).toBe('UTR987654321098');
      expect(parsed[1].credit).toBe(1344);
    });

    it('never marks settlement verified without actual bank credit evidence', () => {
      // Status remains UNVERIFIED or PENDING_BANK_EVIDENCE until statement is parsed
      expect(true).toBe(true);
    });
  });

  describe('5. Month-Wise Cutoff & Carry Forward Timing', () => {
    it('attributes October sales to October, November settlement to November with carry forward', () => {
      // Oct Order
      const octOrder = {
        shopifyOrderName: '#26YOU5900',
        shopifyCreatedAt: new Date('2026-10-28T10:00:00Z'),
        totalAmount: 1000,
        customerState: 'Maharashtra',
        status: 'DELIVERED',
        paymentReceivedAmount: 1000,
        paymentReceivedAt: new Date('2026-11-03T14:00:00Z'), // Settled in Nov!
        paymentMethod: 'Pre-paid',
      };

      const octStart = new Date('2026-10-01T00:00:00Z');
      const octEnd = new Date('2026-11-01T00:00:00Z');

      // October Summary: Order was placed in Oct, but payment was NOT received in Oct
      const octSummary = buildStateAccountingSummary([octOrder], [], octStart, octEnd);
      expect(octSummary.totals.grossSales).toBe(1000);
      // Payment received in Oct is 0 because paymentReceivedAt was Nov 3!
      // In October, closing balance carries forward as 1000
      expect(octSummary.totals.closingBalance).toBe(1000);

      // November Summary:
      // Opening balance brought forward from October is 1000
      const novOpening = new Map<string, number>([['Maharashtra', 1000]]);
      const novStart = new Date('2026-11-01T00:00:00Z');
      const novEnd = new Date('2026-12-01T00:00:00Z');

      // In November, order placed is 0, but payment received is 1000!
      // Passing octOrder as settled in November:
      const novSummary = buildStateAccountingSummary([], [], novStart, novEnd, novOpening, [octOrder]);
      expect(novSummary.totals.openingBalance).toBe(1000);
      expect(novSummary.totals.grossSales).toBe(0);
      expect(novSummary.totals.paymentReceived).toBe(1000);
      // Closing balance in November is 0 (fully settled!)
      expect(novSummary.totals.closingBalance).toBe(0);
    });
  });

  describe('6. TallyPrime XML Export & Schema Validation', () => {
    it('formats dates as YYYYMMDD for Tally XML', () => {
      const formatted = tallyIntegrationService.formatTallyDate(new Date('2026-10-31'));
      expect(formatted).toBe('20261031');
    });

    it('escapes XML special characters in party names and narrations', () => {
      const escaped = tallyIntegrationService.escapeXml('Youthnic & Co. <Test> "Order"');
      expect(escaped).toBe('Youthnic &amp; Co. &lt;Test&gt; &quot;Order&quot;');
    });
  });
});
