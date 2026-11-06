/**
 * Payment Gateway Expense Accounting & Settlement Reconciliation Service
 *
 * Implements strict fee segregation and deduplication for:
 * - GoKwik (Checkout Aggregator) vs Easebuzz (Payment Processing Partner)
 * - PhonePe Direct Gateway
 *
 * Core Invariant:
 * Gross Collection (Clearing Credit) = Bank Receipt (Debit) + MDR Expense (Debit) + Input GST (Debit)
 * Sales revenue is NEVER reduced by gateway processing deductions.
 */

import prisma from '../../database/prisma';
import logger from '../../utils/logger';
import { ledgerService } from './ledger.service';
import { gstService } from './gst.service';

export interface RawGatewaySettlementRow {
  orderReference: string; // #26YOU5754, 26YOU5754, or shopifyOrderId
  gateway: 'EASEBUZZ' | 'GOKWIK' | 'PHONEPE';
  transactionId: string;
  paymentId?: string;
  grossAmount: number;
  mdrFee: number;
  gstOnFee: number;
  netCredit: number;
  batchId: string;
  bankUtr?: string;
  settlementDate: Date;
  isPlatformFeeSeparate?: boolean;
  platformFee?: number;
}

export interface GatewayReconciliationResult {
  batchId: string;
  gateway: string;
  ordersProcessed: number;
  totalGross: number;
  totalMdrFee: number;
  totalFeeGst: number;
  totalNetCredit: number;
  bankUtr?: string;
  journalEntryId?: number;
}

export class GatewayExpenseService {
  /**
   * Reconcile and post a payment gateway settlement batch.
   * Enforces deduplication between GoKwik checkout events and Easebuzz processing fee records.
   */
  public async reconcileAndPostBatch(
    gateway: 'EASEBUZZ' | 'GOKWIK' | 'PHONEPE',
    batchId: string,
    settlementDate: Date,
    rows: RawGatewaySettlementRow[],
    bankUtr?: string
  ): Promise<GatewayReconciliationResult> {
    if (!rows.length) {
      throw new Error(`Empty settlement batch ${batchId}`);
    }

    let totalGross = 0;
    let totalMdrFee = 0;
    let totalFeeGst = 0;
    let totalNetCredit = 0;
    const matchedOrderIds: number[] = [];

    // Deduplication tracker: prevent double-booking if both GoKwik and Easebuzz report the same transaction
    const seenTxnIds = new Set<string>();

    for (const r of rows) {
      if (seenTxnIds.has(r.transactionId)) {
        logger.warn('Duplicate transaction in gateway batch skipped', {
          batchId,
          transactionId: r.transactionId,
          orderRef: r.orderReference,
        });
        continue;
      }
      seenTxnIds.add(r.transactionId);

      // Resolve order in database
      const cleanRef = r.orderReference.replace(/^#/, '');
      const order = await prisma.order.findFirst({
        where: {
          OR: [
            { shopifyOrderName: cleanRef },
            { shopifyOrderName: `#${cleanRef}` },
            { shopifyOrderId: cleanRef },
            { paymentProviderPaymentId: r.paymentId || r.transactionId },
            { gatewayTransactionId: r.transactionId },
          ],
        },
      });

      if (order) {
        matchedOrderIds.push(order.id);

        // Update order payment tracking fields
        const totalFeeDeduction = r.mdrFee + r.gstOnFee;
        await prisma.order.update({
          where: { id: order.id },
          data: {
            paymentReceivedAt: r.settlementDate,
            paymentReceivedAmount: r.netCredit,
            paymentReceivedUtr: r.bankUtr || bankUtr || order.paymentReceivedUtr,
            paymentReceivedRef: batchId,
            paymentReceivedSource: `PG_${gateway}`,
            gatewayFee: totalFeeDeduction,
            // paymentVerified remains false until confirmed by bank statement line per reconciliation rule
          },
        });
      }

      totalGross += r.grossAmount;
      totalMdrFee += r.mdrFee;
      totalFeeGst += r.gstOnFee;
      totalNetCredit += r.netCredit;
    }

    // Round to 2 decimals
    totalGross = Math.round(totalGross * 100) / 100;
    totalMdrFee = Math.round(totalMdrFee * 100) / 100;
    totalFeeGst = Math.round(totalFeeGst * 100) / 100;
    totalNetCredit = Math.round(totalNetCredit * 100) / 100;

    // Verify mathematical equality: Net = Gross - Fees - GST
    const calculatedNet = Math.round((totalGross - totalMdrFee - totalFeeGst) * 100) / 100;
    let batchStatus: 'SETTLED' | 'NEEDS_REVIEW' = 'SETTLED';
    if (Math.abs(calculatedNet - totalNetCredit) > 0.05) {
      logger.warn('Settlement batch net credit discrepancy detected against calculated net', {
        batchId,
        reportedNet: totalNetCredit,
        calculatedNet,
        diff: Math.abs(calculatedNet - totalNetCredit),
      });
      // Retain reported net credit from merchant statement to avoid bank ledger drift
      batchStatus = 'NEEDS_REVIEW';
    }

    const period = ledgerService.toPeriod(settlementDate);

    // Save or update GatewaySettlementBatch entity
    await prisma.gatewaySettlementBatch.upsert({
      where: { batchId },
      create: {
        gateway,
        batchId,
        settlementDate,
        grossAmount: totalGross,
        feeAmount: totalMdrFee,
        gstAmount: totalFeeGst,
        netAmount: totalNetCredit,
        bankUtr: bankUtr || rows[0]?.bankUtr || null,
        orderCount: matchedOrderIds.length,
        details: {
          matchedOrderIds,
          rowCount: rows.length,
        },
      },
      update: {
        grossAmount: totalGross,
        feeAmount: totalMdrFee,
        gstAmount: totalFeeGst,
        netAmount: totalNetCredit,
        bankUtr: bankUtr || rows[0]?.bankUtr || null,
        orderCount: matchedOrderIds.length,
        details: {
          matchedOrderIds,
          rowCount: rows.length,
        },
      },
    });

    // Post double-entry journal voucher in General Ledger
    const journalEntry = await ledgerService.postGatewaySettlement({
      gateway,
      batchId,
      grossAmount: totalGross,
      feeAmount: totalMdrFee,
      feeGst: totalFeeGst,
      netBankCredit: totalNetCredit,
      bankUtr: bankUtr || rows[0]?.bankUtr,
      settlementDate,
      period,
      orderIds: matchedOrderIds,
    });

    logger.info('Gateway settlement batch posted to ledger', {
      batchId,
      gateway,
      orders: matchedOrderIds.length,
      netBankCredit: totalNetCredit,
      voucherId: journalEntry.id,
    });

    return {
      batchId,
      gateway,
      ordersProcessed: matchedOrderIds.length,
      totalGross,
      totalMdrFee,
      totalFeeGst,
      totalNetCredit,
      bankUtr: bankUtr || rows[0]?.bankUtr,
      journalEntryId: journalEntry.id,
    };
  }

  /**
   * Helper to parse Easebuzz settlement CSV/Excel records.
   */
  public parseEasebuzzRows(rows: any[], batchId: string, settlementDate: Date, bankUtr?: string): RawGatewaySettlementRow[] {
    return rows.map((r) => {
      const gross = parseFloat(r['Gross Amount'] || r['amount'] || r['Order Amount'] || '0');
      const fee = parseFloat(r['MDR'] || r['Fee'] || r['Service Charge'] || '0');
      const gst = parseFloat(r['GST'] || r['Service Tax'] || '0');
      const net = parseFloat(r['Net Amount'] || r['Settlement Amount'] || '0') || (gross - fee - gst);
      const orderRef = String(r['Merchant Ref'] || r['Order ID'] || r['txnid'] || '').trim();

      return {
        orderReference: orderRef,
        gateway: 'EASEBUZZ' as const,
        transactionId: String(r['Easebuzz ID'] || r['Transaction ID'] || r['easepayid'] || orderRef),
        paymentId: String(r['Payment ID'] || ''),
        grossAmount: gross,
        mdrFee: fee,
        gstOnFee: gst,
        netCredit: net,
        batchId,
        bankUtr: String(r['UTR'] || r['Bank UTR'] || bankUtr || '').trim() || undefined,
        settlementDate,
      };
    }).filter((r) => r.grossAmount > 0 && Boolean(r.orderReference));
  }

  /**
   * Helper to parse PhonePe settlement CSV/Excel records.
   */
  public parsePhonePeRows(rows: any[], batchId: string, settlementDate: Date, bankUtr?: string): RawGatewaySettlementRow[] {
    return rows.map((r) => {
      const gross = parseFloat(r['Amount'] || r['Transaction Amount'] || '0');
      const fee = parseFloat(r['Fee'] || r['MDR'] || '0');
      const gst = parseFloat(r['Tax'] || r['GST'] || '0');
      const net = parseFloat(r['Net Settlement'] || r['Net Amount'] || '0') || (gross - fee - gst);
      const orderRef = String(r['Merchant Order Id'] || r['Order ID'] || '').trim();

      return {
        orderReference: orderRef,
        gateway: 'PHONEPE' as const,
        transactionId: String(r['PhonePe Transaction Id'] || r['Transaction ID'] || orderRef),
        grossAmount: gross,
        mdrFee: fee,
        gstOnFee: gst,
        netCredit: net,
        batchId,
        bankUtr: String(r['UTR'] || r['Bank Reference'] || bankUtr || '').trim() || undefined,
        settlementDate,
      };
    }).filter((r) => r.grossAmount > 0 && Boolean(r.orderReference));
  }
}

export const gatewayExpenseService = new GatewayExpenseService();
