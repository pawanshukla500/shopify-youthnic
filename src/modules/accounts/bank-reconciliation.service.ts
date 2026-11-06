/**
 * Bank & UTR Reconciliation Engine
 *
 * Reconciles bank statements against:
 * 1. Gateway settlement batches (Easebuzz, PhonePe, GoKwik)
 * 2. Courier COD remittances (Delhivery, Velocity)
 *
 * Strict Accounting Rule:
 * An order or settlement is NEVER marked "Bank Verified" simply because a UTR
 * string was typed or generated in a gateway report. It requires verified matching
 * against an actual bank credit transaction line on an authorized bank statement.
 */

import { BankReconciliationStatus, Prisma } from '@prisma/client';
import prisma from '../../database/prisma';
import logger from '../../utils/logger';
import { parseDateLoose } from './spreadsheet';

export interface ParsedBankStatementRow {
  transactionDate: Date;
  valueDate?: Date;
  description: string;
  referenceNo?: string; // UTR or Cheque/Txn reference
  debit: number;
  credit: number;
  balance?: number;
}

export interface BankReconciliationMatchResult {
  statementLineId: number;
  status: BankReconciliationStatus;
  matchedType?: 'GATEWAY_SETTLEMENT' | 'COD_REMITTANCE' | 'DIRECT_CREDIT';
  matchedRef?: string;
  matchedAmount?: number;
  notes?: string;
  affectedOrdersCount: number;
}

export interface BankUploadSummary {
  statementId: number;
  fileName: string;
  totalRows: number;
  totalCredits: number;
  totalDebits: number;
  matchedCount: number;
  unmatchedCount: number;
  mismatchCount: number;
  results: BankReconciliationMatchResult[];
}

export class BankReconciliationService {
  /**
   * Upload and parse an authorized bank statement, then auto-match against settlement batches.
   */
  public async ingestAndReconcileStatement(params: {
    fileName: string;
    bankName: string;
    accountNumber?: string;
    statementPeriod?: string;
    rows: ParsedBankStatementRow[];
    uploadedBy?: string;
  }): Promise<BankUploadSummary> {
    if (!params.rows.length) {
      throw new Error(`Empty bank statement: ${params.fileName}`);
    }

    let totalCredits = 0;
    let totalDebits = 0;
    for (const r of params.rows) {
      totalCredits += r.credit;
      totalDebits += r.debit;
    }

    // 1. Create BankStatement Header
    const statement = await prisma.bankStatement.create({
      data: {
        fileName: params.fileName,
        bankName: params.bankName,
        accountNumber: params.accountNumber || null,
        statementPeriod: params.statementPeriod || null,
        totalCredits: new Prisma.Decimal(Math.round(totalCredits * 100) / 100),
        totalDebits: new Prisma.Decimal(Math.round(totalDebits * 100) / 100),
        uploadedBy: params.uploadedBy || 'SYSTEM',
      },
    });

    const matchResults: BankReconciliationMatchResult[] = [];
    let matchedCount = 0;
    let unmatchedCount = 0;
    let mismatchCount = 0;

    // 2. Process each statement transaction line
    for (const row of params.rows) {
      // Check for duplicate statement line already recorded in database
      const existingLine = row.referenceNo
        ? await prisma.bankStatementLine.findFirst({
            where: {
              referenceNo: row.referenceNo,
              credit: new Prisma.Decimal(Math.round(row.credit * 100) / 100),
              transactionDate: row.transactionDate,
            },
          })
        : null;

      const isDuplicate = Boolean(existingLine);
      const initialStatus = isDuplicate ? BankReconciliationStatus.DUPLICATE : BankReconciliationStatus.UNMATCHED;

      const line = await prisma.bankStatementLine.create({
        data: {
          statementId: statement.id,
          transactionDate: row.transactionDate,
          valueDate: row.valueDate || null,
          description: row.description,
          referenceNo: row.referenceNo || null,
          debit: new Prisma.Decimal(Math.round(row.debit * 100) / 100),
          credit: new Prisma.Decimal(Math.round(row.credit * 100) / 100),
          balance: row.balance !== undefined ? new Prisma.Decimal(Math.round(row.balance * 100) / 100) : null,
          status: initialStatus,
        },
      });

      if (isDuplicate) {
        matchResults.push({
          statementLineId: line.id,
          status: BankReconciliationStatus.DUPLICATE,
          notes: 'Duplicate transaction line already reconciled',
          affectedOrdersCount: 0,
        });
        continue;
      }

      // Only attempt to match credit lines (incoming cash settlements)
      if (row.credit <= 0) {
        matchResults.push({
          statementLineId: line.id,
          status: BankReconciliationStatus.UNMATCHED,
          notes: 'Debit transaction (expense/withdrawal)',
          affectedOrdersCount: 0,
        });
        unmatchedCount++;
        continue;
      }

      // Match Strategy:
      // A. Match by exact UTR in GatewaySettlementBatch
      // B. Match by exact UTR in Order / Shipment remittances
      // C. Match by reference in description
      const match = await this.matchCreditLine(line.id, row);
      matchResults.push(match);

      if (match.status === BankReconciliationStatus.VERIFIED) {
        matchedCount++;
      } else if (match.status === BankReconciliationStatus.AMOUNT_MISMATCH) {
        mismatchCount++;
      } else {
        unmatchedCount++;
      }
    }

    logger.info('Bank statement reconciliation completed', {
      statementId: statement.id,
      totalRows: params.rows.length,
      matchedCount,
      unmatchedCount,
      mismatchCount,
    });

    return {
      statementId: statement.id,
      fileName: params.fileName,
      totalRows: params.rows.length,
      totalCredits: Math.round(totalCredits * 100) / 100,
      totalDebits: Math.round(totalDebits * 100) / 100,
      matchedCount,
      unmatchedCount,
      mismatchCount,
      results: matchResults,
    };
  }

  /**
   * Internal matching algorithm for a single bank credit transaction.
   */
  private async matchCreditLine(
    lineId: number,
    row: ParsedBankStatementRow
  ): Promise<BankReconciliationMatchResult> {
    const rawUtr = (row.referenceNo || '').trim();
    const desc = row.description.toLowerCase();
    const creditAmt = Math.round(row.credit * 100) / 100;

    // 1. Try matching against GatewaySettlementBatch by UTR
    if (rawUtr) {
      const batch = await prisma.gatewaySettlementBatch.findFirst({
        where: {
          OR: [
            { bankUtr: rawUtr },
            { batchId: rawUtr },
          ],
        },
      });

      if (batch) {
        const batchNet = batch.netAmount.toNumber();
        const diff = Math.abs(batchNet - creditAmt);

        if (diff <= 1.0) {
          // Exact match!
          await prisma.gatewaySettlementBatch.update({
            where: { id: batch.id },
            data: {
              verificationStatus: BankReconciliationStatus.VERIFIED,
              bankCreditDate: row.transactionDate,
            },
          });

          await prisma.bankStatementLine.update({
            where: { id: lineId },
            data: {
              status: BankReconciliationStatus.VERIFIED,
              matchedType: 'GATEWAY_SETTLEMENT',
              matchedRef: batch.batchId,
              matchedAmount: new Prisma.Decimal(creditAmt),
              notes: `Verified against ${batch.gateway} settlement batch ${batch.batchId}`,
            },
          });

          // Mark all linked orders as paymentVerified
          const details = (batch.details as any) || {};
          const orderIds: number[] = details.matchedOrderIds || [];
          if (orderIds.length > 0) {
            await prisma.order.updateMany({
              where: { id: { in: orderIds } },
              data: {
                paymentVerified: true,
                paymentVerifiedAt: row.transactionDate,
              },
            });
          }

          return {
            statementLineId: lineId,
            status: BankReconciliationStatus.VERIFIED,
            matchedType: 'GATEWAY_SETTLEMENT',
            matchedRef: batch.batchId,
            matchedAmount: creditAmt,
            notes: `Matched ${batch.gateway} batch ${batch.batchId} (Orders: ${orderIds.length})`,
            affectedOrdersCount: orderIds.length,
          };
        } else {
          // Amount Mismatch
          await prisma.bankStatementLine.update({
            where: { id: lineId },
            data: {
              status: BankReconciliationStatus.AMOUNT_MISMATCH,
              matchedType: 'GATEWAY_SETTLEMENT',
              matchedRef: batch.batchId,
              matchedAmount: new Prisma.Decimal(batchNet),
              notes: `UTR matched batch ${batch.batchId} but amount differs (Bank: ₹${creditAmt} vs Batch: ₹${batchNet})`,
            },
          });

          return {
            statementLineId: lineId,
            status: BankReconciliationStatus.AMOUNT_MISMATCH,
            matchedType: 'GATEWAY_SETTLEMENT',
            matchedRef: batch.batchId,
            matchedAmount: batchNet,
            notes: `Amount mismatch: Bank ₹${creditAmt} vs Batch ₹${batchNet}`,
            affectedOrdersCount: 0,
          };
        }
      }
    }

    // 2. Try matching against Delhivery/Velocity COD remittance references in Shipments / Orders
    const matchingOrders = await prisma.order.findMany({
      where: {
        OR: [
          ...(rawUtr ? [{ paymentReceivedUtr: rawUtr }] : []),
          ...(rawUtr ? [{ paymentReceivedRef: rawUtr }] : []),
        ],
      },
    });

    if (matchingOrders.length > 0) {
      const ordersTotal = matchingOrders.reduce((acc, o) => acc + (o.paymentReceivedAmount || 0), 0);
      const diff = Math.abs(ordersTotal - creditAmt);

      if (diff <= 5.0) {
        await prisma.bankStatementLine.update({
          where: { id: lineId },
          data: {
            status: BankReconciliationStatus.VERIFIED,
            matchedType: 'COD_REMITTANCE',
            matchedRef: rawUtr,
            matchedAmount: new Prisma.Decimal(creditAmt),
            notes: `Verified against ${matchingOrders.length} COD order remittances`,
          },
        });

        await prisma.order.updateMany({
          where: { id: { in: matchingOrders.map((o) => o.id) } },
          data: {
            paymentVerified: true,
            paymentVerifiedAt: row.transactionDate,
          },
        });

        return {
          statementLineId: lineId,
          status: BankReconciliationStatus.VERIFIED,
          matchedType: 'COD_REMITTANCE',
          matchedRef: rawUtr,
          matchedAmount: creditAmt,
          notes: `Matched ${matchingOrders.length} COD remittances`,
          affectedOrdersCount: matchingOrders.length,
        };
      }
    }

    // 3. Fallback: Unmatched
    return {
      statementLineId: lineId,
      status: BankReconciliationStatus.UNMATCHED,
      notes: rawUtr ? `UTR ${rawUtr} not found in settlement batches` : 'No UTR in statement line',
      affectedOrdersCount: 0,
    };
  }

  /**
   * Helper to parse generic bank statement CSV/Excel lines (HDFC, ICICI, SBI).
   */
  public parseBankCsv(rows: any[]): ParsedBankStatementRow[] {
    return rows.map((r) => {
      // Bank statements use Indian day-first dates, including two-digit years.
      // Never assign a fabricated current date to an unparseable transaction.
      const rawDate = r['Date'] || r['Txn Date'] || r['Transaction Date'] || r['Value Date'];
      const transactionDate = rawDate instanceof Date
        ? (Number.isNaN(rawDate.getTime()) ? null : rawDate)
        : parseDateLoose(rawDate == null ? null : String(rawDate));
      if (!transactionDate) return null;

      // Reject impossible dates such as 31/02/26 that JS would otherwise roll over.
      const dayFirst = String(rawDate).match(/^(\\d{1,2})[\\/-](\\d{1,2})[\\/-](\\d{2}|\\d{4})(?!\\d)/);
      if (dayFirst) {
        const day = Number(dayFirst[1]);
        const month = Number(dayFirst[2]);
        const inputYear = Number(dayFirst[3]);
        const year = inputYear < 100 ? 2000 + inputYear : inputYear;
        const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
        if (month < 1 || month > 12 || day < 1 || day > daysInMonth) return null;
      }

      const desc = String(r['Description'] || r['Narration'] || r['Particulars'] || '').trim();
      const rawRef = String(r['Chq./Ref.No.'] || r['Reference'] || r['UTR'] || r['Ref No'] || '').trim();

      // Extract 12-digit UTR from description if not in ref column
      let utr = rawRef;
      if (!utr || utr === '-') {
        const utrMatch = desc.match(/\b([A-Z0-9]{12,22})\b/i);
        if (utrMatch) utr = utrMatch[1];
      }

      const debit = parseFloat(String(r['Debit'] || r['Withdrawal'] || '0').replace(/,/g, '')) || 0;
      const credit = parseFloat(String(r['Credit'] || r['Deposit'] || '0').replace(/,/g, '')) || 0;
      const balance = parseFloat(String(r['Balance'] || r['Closing Balance'] || '0').replace(/,/g, ''));

      return {
        transactionDate,
        description: desc,
        referenceNo: utr || undefined,
        debit,
        credit,
        balance: isNaN(balance) ? undefined : balance,
      };
    }).filter((r): r is ParsedBankStatementRow => r !== null && (r.debit > 0 || r.credit > 0));
  }
}

export const bankReconciliationService = new BankReconciliationService();
