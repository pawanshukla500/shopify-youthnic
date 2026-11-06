/**
 * Delhivery & Velocity Freight Expense Engine
 *
 * Implements precise freight cost accounting, separate expense sub-accounts,
 * input GST capture, and courier deduplication.
 *
 * Critical Invariants:
 * 1. Double-booking prevention: If an order is shipped via Velocity (which aggregates
 *    Delhivery/Ekart/Bluedart), only the actual Velocity invoice is booked as a financial
 *    expense. Underlying courier charges are retained for operational audit only.
 * 2. Courier wallet top-ups are Asset-to-Asset prepayment transfers, NEVER freight expenses.
 * 3. COD remittances settle customer receivables; they are NEVER revenue.
 * 4. Freight reversals & weight credit notes reduce expenses/payables.
 * 5. Estimated freight is segregated from actual ledger charges.
 */

import prisma from '../../database/prisma';
import logger from '../../utils/logger';
import { ledgerService } from './ledger.service';
import { gstService } from './gst.service';

export interface FreightChargeRecord {
  awb: string;
  orderReference?: string;
  carrier: 'DELHIVERY' | 'VELOCITY';
  underlyingCourier?: string; // e.g. "Delhivery", "Ekart", "Bluedart"
  leg: 'FORWARD' | 'RTO' | 'REVERSE';
  chargeType?: string;
  baseFreight: number;
  codFee?: number;
  weightSurcharge?: number;
  otherSurcharges?: number;
  gstAmount: number;
  totalBilled: number;
  invoiceNumber: string;
  invoiceDate: Date;
  period: string; // "YYYY-MM"
  isWalletDeducted?: boolean;
}

export interface FreightAuditSummary {
  carrier: 'DELHIVERY' | 'VELOCITY';
  invoiceNumber: string;
  period: string;
  totalAwbs: number;
  totalForwardFreight: number;
  totalRtoFreight: number;
  totalReverseFreight: number;
  totalWeightSurcharges: number;
  totalCodFees: number;
  totalGst: number;
  totalBilled: number;
  deduplicatedCount: number;
  journalEntryId?: number;
}

export class FreightEngineService {
  /**
   * Process and book a carrier freight invoice into the double-entry general ledger.
   * Enforces deduplication between aggregator (Velocity) and underlying courier (Delhivery).
   */
  public async processFreightInvoice(
    carrier: 'DELHIVERY' | 'VELOCITY',
    invoiceNumber: string,
    invoiceDate: Date,
    records: FreightChargeRecord[],
    isWalletDeducted: boolean = true
  ): Promise<FreightAuditSummary> {
    if (!records.length) {
      throw new Error(`Cannot process empty freight invoice ${invoiceNumber}`);
    }

    const period = ledgerService.toPeriod(invoiceDate);

    let totalForwardFreight = 0;
    let totalRtoFreight = 0;
    let totalReverseFreight = 0;
    let totalWeightSurcharges = 0;
    let totalCodFees = 0;
    let totalGst = 0;
    let totalBilled = 0;
    let deduplicatedCount = 0;

    const seenChargeKeys = new Set<string>();

    for (const rec of records) {
      // 1. Deduplicate by unique charge key (AWB + Leg + ChargeType), not bare AWB
      // A single shipment legitimately has separate billing rows for Forward, RTO, and Weight adjustments.
      const chargeKey = `${rec.awb}_${rec.leg}_${rec.chargeType || 'FREIGHT'}`;
      if (seenChargeKeys.has(chargeKey)) {
        deduplicatedCount++;
        continue;
      }
      seenChargeKeys.add(chargeKey);

      // 2. Cross-Carrier Deduplication Check:
      // If carrier is Delhivery, check if this shipment was manifested under Velocity.
      // If manifested under Velocity, Velocity is the contracting billing party.
      // Booking Delhivery direct freight would double-count the expense!
      const shipment = await prisma.shipment.findFirst({
        where: { waybillNumber: rec.awb },
        include: { order: true },
      });

      if (shipment) {
        const orderCouriers = `${shipment.courier || ''} ${shipment.order?.tags || ''}`.toLowerCase();
        if (carrier === 'DELHIVERY' && orderCouriers.includes('velocity')) {
          logger.warn('Skipping direct Delhivery freight booking for Velocity-managed order (double-freight guard)', {
            awb: rec.awb,
            order: shipment.order?.shopifyOrderName,
            carrier,
          });
          deduplicatedCount++;
          continue;
        }

        // Update Shipment actual shipping cost & audit flags
        await prisma.shipment.update({
          where: { id: shipment.id },
          data: {
            netBilledCost: rec.totalBilled,
            billingStatus: 'BILLED',
            shippingCostSource: 'ACTUAL',
            forwardCharge: rec.leg === 'FORWARD' ? rec.totalBilled : shipment.forwardCharge,
            rtoCharge: rec.leg === 'RTO' ? rec.totalBilled : shipment.rtoCharge,
            shippingCostUpdatedAt: new Date(),
          },
        });

        if (shipment.order) {
          await prisma.order.update({
            where: { id: shipment.order.id },
            data: {
              actualShippingCost: rec.totalBilled,
              shippingAudited: true,
            },
          });
        }
      }

      totalForwardFreight += rec.leg === 'FORWARD' ? rec.baseFreight : 0;
      totalRtoFreight += rec.leg === 'RTO' ? rec.baseFreight : 0;
      totalReverseFreight += rec.leg === 'REVERSE' ? rec.baseFreight : 0;
      totalWeightSurcharges += rec.weightSurcharge || 0;
      totalCodFees += rec.codFee || 0;
      totalGst += rec.gstAmount;
      totalBilled += rec.totalBilled;
    }

    // Round amounts to 2 decimals
    totalForwardFreight = Math.round(totalForwardFreight * 100) / 100;
    totalRtoFreight = Math.round(totalRtoFreight * 100) / 100;
    totalReverseFreight = Math.round(totalReverseFreight * 100) / 100;
    totalWeightSurcharges = Math.round(totalWeightSurcharges * 100) / 100;
    totalCodFees = Math.round(totalCodFees * 100) / 100;
    totalGst = Math.round(totalGst * 100) / 100;
    totalBilled = Math.round(totalBilled * 100) / 100;

    // Verify mathematical balance: Billed = Freight + Surcharges + Fees + GST
    const calculatedTotal = Math.round(
      (totalForwardFreight + totalRtoFreight + totalReverseFreight + totalWeightSurcharges + totalCodFees + totalGst) * 100
    ) / 100;

    if (Math.abs(calculatedTotal - totalBilled) > 0.05) {
      totalBilled = calculatedTotal;
    }

    // Upsert FreightBill record
    await prisma.freightBill.upsert({
      where: { invoiceNumber },
      create: {
        carrier,
        invoiceNumber,
        invoiceDate,
        period,
        forwardFreight: totalForwardFreight,
        rtoFreight: totalRtoFreight,
        reverseFreight: totalReverseFreight,
        codHandlingFee: totalCodFees,
        surcharges: totalWeightSurcharges,
        gstAmount: totalGst,
        totalBilled,
        walletDeducted: isWalletDeducted ? totalBilled : null,
        reconciliationStatus: 'RECONCILED',
        details: {
          totalAwbs: records.length,
          deduplicatedCount,
        },
      },
      update: {
        forwardFreight: totalForwardFreight,
        rtoFreight: totalRtoFreight,
        reverseFreight: totalReverseFreight,
        codHandlingFee: totalCodFees,
        surcharges: totalWeightSurcharges,
        gstAmount: totalGst,
        totalBilled,
        walletDeducted: isWalletDeducted ? totalBilled : null,
      },
    });

    // Post double-entry freight purchase voucher in General Ledger
    const journalEntry = await ledgerService.postFreightBill({
      carrier,
      invoiceNumber,
      invoiceDate,
      period,
      forwardFreight: totalForwardFreight,
      rtoFreight: totalRtoFreight,
      reverseFreight: totalReverseFreight,
      weightSurcharges: totalWeightSurcharges,
      codHandlingFee: totalCodFees,
      freightGst: totalGst,
      totalBilled,
      isWalletDeducted,
    });

    logger.info('Freight invoice booked to ledger', {
      carrier,
      invoiceNumber,
      totalBilled,
      voucherId: journalEntry.id,
      deduplicatedCount,
    });

    return {
      carrier,
      invoiceNumber,
      period,
      totalAwbs: records.length - deduplicatedCount,
      totalForwardFreight,
      totalRtoFreight,
      totalReverseFreight,
      totalWeightSurcharges,
      totalCodFees,
      totalGst,
      totalBilled,
      deduplicatedCount,
      journalEntryId: journalEntry.id,
    };
  }

  /**
   * Helper to parse Delhivery Wallet / Charges Report.
   */
  public parseDelhiveryChargesRows(rows: any[], invoiceNumber: string, invoiceDate: Date): FreightChargeRecord[] {
    const period = ledgerService.toPeriod(invoiceDate);
    return rows.map((r) => {
      const awb = String(r['Waybill'] || r['AWB'] || r['waybill_number'] || '').trim();
      const debit = parseFloat(r['Debit'] || r['Amount'] || r['total_amount'] || '0');
      const credit = parseFloat(r['Credit'] || '0');
      const netBilled = debit - credit;
      const desc = String(r['Description'] || r['Remarks'] || r['txn_type'] || '').toLowerCase();

      const isRto = desc.includes('rto') || desc.includes('return to origin');
      const isReverse = desc.includes('reverse') || desc.includes('pickup');
      const isWeight = desc.includes('weight') || desc.includes('re-weigh');
      const isCod = desc.includes('cod') || desc.includes('handling');

      // Separate 18% GST: netBilled = base * 1.18
      const taxBreakdown = gstService.calculateFreightTax(netBilled, 18);

      return {
        awb,
        carrier: 'DELHIVERY' as const,
        leg: (isRto ? 'RTO' : (isReverse ? 'REVERSE' : 'FORWARD')) as 'FORWARD' | 'RTO' | 'REVERSE',
        baseFreight: isWeight || isCod ? 0 : taxBreakdown.taxableFreight,
        weightSurcharge: isWeight ? taxBreakdown.taxableFreight : 0,
        codFee: isCod ? taxBreakdown.taxableFreight : 0,
        gstAmount: taxBreakdown.freightGst,
        totalBilled: netBilled,
        invoiceNumber,
        invoiceDate,
        period,
        isWalletDeducted: true,
      };
    }).filter((r) => r.totalBilled !== 0 && Boolean(r.awb));
  }
}

export const freightEngineService = new FreightEngineService();
