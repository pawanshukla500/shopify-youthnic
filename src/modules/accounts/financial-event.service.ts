/**
 * Financial Event Architecture & Reconciliation Engine
 *
 * Implements immutable, auditable financial events for:
 * - Gross Bookings & Cancellations
 * - RTO Adjustments (separated from delivery)
 * - Customer Returns (Initiated vs Confirmed vs Refunded)
 * - Size Exchange Logistics (Attributed to original customer state)
 * - Gateway Fee Deductions (Easebuzz/GoKwik/PhonePe)
 * - Freight Invoicing (Wallet Prepayments vs Settlement Deductions)
 * - Verified Bank Credits & Settlement Reconciliation
 *
 * Enforces:
 * 1. Asia/Kolkata monthly event boundaries.
 * 2. Mutually exclusive classifications: an order is never deducted as both cancellation and RTO and return.
 * 3. Never reconstructs previous months using today's mutable Order.status.
 * 4. Payout Bridge:
 *    Outstanding = (Opening + Gross - Cancel - RTO - Returns - Gateway Deductions) - Verified Receipts.
 */

import { Prisma, ShipmentStatus, OrderStatus } from '@prisma/client';
import prisma from '../../database/prisma';
import logger from '../../utils/logger';
import { gstService, resolvePosCode } from './gst.service';
import { getGstStateCode, monthRange, money, sum } from './accounts-report.service';

export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Converts a UTC Date or ISO date string into an Asia/Kolkata (IST) YYYY-MM accounting period.
 *
 * @param date - Date object or ISO string representing the transaction timestamp
 * @returns Formatted "YYYY-MM" accounting period string in IST timezone
 */
export function dateToIstPeriod(date: Date | string): string {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const ist = new Date(d.getTime() + IST_OFFSET_MS);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

export interface StateSettlementRow {
  state: string;
  gstStateCode: string;
  orderCount: number;
  openingOutstanding: number;
  grossOrderSales: number;
  cancelledOrders: number;
  rtoAdjustments: number;
  customerReturns: number;
  expectedGrossSettlement: number;
  gokwikEasebuzzFeeDeducted: number;
  phonepeFeeDeducted: number;
  codSettlementDeductions: number;
  netExpectedBankSettlement: number;
  verifiedPaymentReceived: number;
  outstandingSettlement: number;

  // Additional operational & expense columns
  estimatedFreightNotBilled: number;
  actualFreightExpenses: number;
  exchangeFreightExpenses: number;
  gatewayExpensesNotDeducted: number;
  pendingReturns: number;
  unverifiedReceipts: number;
  disputedDeductions: number;
  customerRefundPayable: number;
  varianceOverpayment: number;
  notes?: string;
}

export interface StateSettlementTotals {
  totalOrders: number;
  openingOutstanding: number;
  grossOrderSales: number;
  cancelledOrders: number;
  rtoAdjustments: number;
  customerReturns: number;
  expectedGrossSettlement: number;
  gokwikEasebuzzFeeDeducted: number;
  phonepeFeeDeducted: number;
  codSettlementDeductions: number;
  netExpectedBankSettlement: number;
  verifiedPaymentReceived: number;
  outstandingSettlement: number;

  estimatedFreightNotBilled: number;
  actualFreightExpenses: number;
  exchangeFreightExpenses: number;
  gatewayExpensesNotDeducted: number;
  pendingReturns: number;
  unverifiedReceipts: number;
  disputedDeductions: number;
  customerRefundPayable: number;
  varianceOverpayment: number;
}

export interface MonthlyExpenseReport {
  period: string;
  gokwikFees: { mdr: number; platform: number; gst: number; total: number };
  easebuzzFees: { mdr: number; gst: number; total: number };
  phonepeFees: { mdr: number; gst: number; total: number };
  delhiveryFreight: {
    forward: number;
    rto: number;
    reverse: number;
    cod: number;
    weight: number;
    gst: number;
    total: number;
    walletDeducted: number;
  };
  velocityFreight: {
    forward: number;
    rto: number;
    reverse: number;
    cod: number;
    weight: number;
    gst: number;
    total: number;
    billed: number;
  };
  exchangeFreight: {
    reverseFreight: number;
    forwardFreight: number;
    extraPaidByCustomer: number;
    netFreightExpense: number;
    exchangeCount: number;
  };
  totalOperatingExpenses: number;
  totalInputGstEligible: number;
}

export interface MonthlyContributionReport {
  period: string;
  grossBookings: number;
  cancelledOrders: number;
  rtoAdjustments: number;
  customerReturns: number;
  netRecognizedRevenue: number;
  taxableRevenue: number;
  totalOutputGst: number;
  gatewayExpenses: number;
  freightExpenses: number;
  exchangeExpenses: number;
  totalVariableExpenses: number;
  contributionBeforeCogs: number;
  contributionMarginPercent: number;
  cogsAvailable: boolean;
  notes: string;
}

export class FinancialEventService {
  /**
   * Idempotently synchronize financial events for orders, returns, and settlements.
   * If period is provided, restricts to orders and events occurring in or affecting that period.
   */
  async syncFinancialEvents(period?: string): Promise<{ created: number; updated: number }> {
    let created = 0;
    let updated = 0;

    let periodStart: Date | undefined;
    let periodEnd: Date | undefined;
    if (period) {
      const range = monthRange(period);
      periodStart = range.start;
      periodEnd = range.end;
    }

    // 1. Fetch orders placed in period or updated in period
    const orders = await prisma.order.findMany({
      where: periodStart && periodEnd
        ? {
            OR: [
              { shopifyCreatedAt: { gte: periodStart, lt: periodEnd } },
              { cancelledAt: { gte: periodStart, lt: periodEnd } },
              { paymentReceivedAt: { gte: periodStart, lt: periodEnd } },
              { updatedAt: { gte: periodStart, lt: periodEnd } },
            ],
          }
        : undefined,
      include: {
        shipment: true,
        returns: { include: { items: true } },
      },
      orderBy: { id: 'asc' },
    });

    for (const order of orders) {
      const bookingPeriod = dateToIstPeriod(order.shopifyCreatedAt);
      const bookingEventId = `ORD-${order.id}-BOOKING`;
      const cleanState = (order.customerState || 'Unspecified').trim();
      const posCode = getGstStateCode(cleanState);
      const isCod = order.paymentMethod === 'COD' || (order.paymentGateway || '').toLowerCase().includes('cash');

      // A. Booking Event (Gross Order Value)
      const bookingRes = await prisma.financialEvent.upsert({
        where: { eventId: bookingEventId },
        create: {
          eventId: bookingEventId,
          orderId: order.id,
          eventType: 'BOOKING',
          period: bookingPeriod,
          effectiveDate: order.shopifyCreatedAt,
          postingDate: order.shopifyCreatedAt,
          customerState: cleanState,
          gstStateCode: posCode,
          provider: order.paymentProvider || order.paymentAggregator || (isCod ? 'DELHIVERY_COD' : 'DIRECT'),
          grossAmount: new Prisma.Decimal(order.totalAmount || 0),
          netAmount: new Prisma.Decimal(order.totalAmount || 0),
          reference: order.shopifyOrderName,
          source: 'SHOPIFY_SYNC',
          verificationStatus: 'VERIFIED',
          note: `Gross order booking: ${order.shopifyOrderName}`,
        },
        update: {
          customerState: cleanState,
          gstStateCode: posCode,
          grossAmount: new Prisma.Decimal(order.totalAmount || 0),
          netAmount: new Prisma.Decimal(order.totalAmount || 0),
          reference: order.shopifyOrderName,
        },
      });
      if (bookingRes.createdAt.getTime() === bookingRes.updatedAt.getTime()) created++;
      else updated++;

      // B. Cancellation Event (if cancelled)
      if (order.status === 'CANCELLED' || order.cancelledAt) {
        const cancelDate = order.cancelledAt || order.updatedAt;
        const cancelPeriod = dateToIstPeriod(cancelDate);
        const cancelEventId = `ORD-${order.id}-CANCELLATION`;

        await prisma.financialEvent.upsert({
          where: { eventId: cancelEventId },
          create: {
            eventId: cancelEventId,
            orderId: order.id,
            eventType: 'CANCELLATION',
            period: cancelPeriod,
            effectiveDate: cancelDate,
            postingDate: cancelDate,
            customerState: cleanState,
            gstStateCode: posCode,
            provider: order.paymentProvider || (isCod ? 'DELHIVERY_COD' : 'DIRECT'),
            grossAmount: new Prisma.Decimal(order.totalAmount || 0),
            netAmount: new Prisma.Decimal(-(order.totalAmount || 0)),
            isSettlementDeduction: true,
            reference: order.shopifyOrderName,
            source: 'OMS_CANCEL',
            verificationStatus: 'VERIFIED',
            note: `Order cancelled on ${cancelDate.toISOString()}: ${order.shopifyOrderName}`,
          },
          update: {
            customerState: cleanState,
            gstStateCode: posCode,
            grossAmount: new Prisma.Decimal(order.totalAmount || 0),
            netAmount: new Prisma.Decimal(-(order.totalAmount || 0)),
            effectiveDate: cancelDate,
            period: cancelPeriod,
          },
        });
      }

      // C. RTO Adjustment Event (Shipment turned back before customer delivery)
      const isRto = Boolean(order.shipment) && (
        order.shipment?.status === ShipmentStatus.RTO ||
        order.shipment?.status === ShipmentStatus.RTO_DELIVERED ||
        order.status === OrderStatus.RTO_INITIATED ||
        order.status === OrderStatus.RTO_DELIVERED ||
        (order.shipment?.trackingStatus && /rto/i.test(order.shipment.trackingStatus))
      );

      // Mutually exclusive: If order already has a cancellation, do not duplicate with RTO
      if (isRto && order.status !== 'CANCELLED') {
        const rtoDate = order.shipment?.updatedAt || order.updatedAt;
        const rtoPeriod = dateToIstPeriod(rtoDate);
        const rtoEventId = `ORD-${order.id}-RTO_INITIATED`;

        await prisma.financialEvent.upsert({
          where: { eventId: rtoEventId },
          create: {
            eventId: rtoEventId,
            orderId: order.id,
            shipmentId: order.shipment?.id,
            eventType: 'RTO_INITIATED',
            period: rtoPeriod,
            effectiveDate: rtoDate,
            postingDate: rtoDate,
            customerState: cleanState,
            gstStateCode: posCode,
            provider: order.shipment?.courier || (isCod ? 'DELHIVERY_COD' : 'VELOCITY'),
            grossAmount: new Prisma.Decimal(order.totalAmount || 0),
            netAmount: new Prisma.Decimal(-(order.totalAmount || 0)),
            isSettlementDeduction: true,
            reference: order.shipment?.waybillNumber || order.shopifyOrderName,
            source: 'CARRIER_RTO_SCAN',
            verificationStatus: order.shipment?.status === 'RTO_DELIVERED' ? 'VERIFIED' : 'UNVERIFIED',
            note: `RTO recognized for order ${order.shopifyOrderName} (AWB: ${order.shipment?.waybillNumber || 'N/A'})`,
          },
          update: {
            customerState: cleanState,
            gstStateCode: posCode,
            grossAmount: new Prisma.Decimal(order.totalAmount || 0),
            netAmount: new Prisma.Decimal(-(order.totalAmount || 0)),
            verificationStatus: order.shipment?.status === 'RTO_DELIVERED' ? 'VERIFIED' : 'UNVERIFIED',
          },
        });
      }

      // D. Returns & Exchanges Events
      for (const ret of order.returns) {
        if (ret.returnStatus === 'CANCELLED') continue;

        const returnCreatedPeriod = dateToIstPeriod(ret.createdAt);
        const returnAmt = (ret.refundAmount && ret.refundAmount > 0)
          ? ret.refundAmount
          : (order.totalAmount || 0);

        if (ret.isExchange) {
          // Exchange Event: Allocate freight to ORIGINAL order customer state
          const exEventId = `RET-${ret.id}-EXCHANGE_CREATED`;
          await prisma.financialEvent.upsert({
            where: { eventId: exEventId },
            create: {
              eventId: exEventId,
              orderId: order.id,
              returnId: ret.id,
              eventType: 'EXCHANGE_CREATED',
              period: returnCreatedPeriod,
              effectiveDate: ret.createdAt,
              postingDate: ret.createdAt,
              customerState: cleanState,
              gstStateCode: posCode,
              provider: ret.carrier || 'VELOCITY',
              grossAmount: new Prisma.Decimal(0), // Free replacement contributes ₹0 new sales
              netAmount: new Prisma.Decimal(0),
              reference: ret.returnWaybillNumber || order.shopifyOrderName,
              source: 'OMS_EXCHANGE',
              verificationStatus: 'VERIFIED',
              note: `Exchange created: replacement forward AWB ${ret.exchangeForwardAwb || 'Pending'} · Reverse AWB ${ret.returnWaybillNumber || 'N/A'}`,
            },
            update: {
              customerState: cleanState,
              gstStateCode: posCode,
              reference: ret.returnWaybillNumber || order.shopifyOrderName,
            },
          });

          // Exchange freight reverse leg (if billed)
          if (ret.shippingCharge && ret.shippingCharge > 0) {
            const exFreightId = `RET-${ret.id}-EXCHANGE_FREIGHT`;
            await prisma.financialEvent.upsert({
              where: { eventId: exFreightId },
              create: {
                eventId: exFreightId,
                orderId: order.id,
                returnId: ret.id,
                eventType: 'EXCHANGE_FREIGHT',
                period: returnCreatedPeriod,
                effectiveDate: ret.createdAt,
                customerState: cleanState,
                gstStateCode: posCode,
                provider: ret.carrier || 'VELOCITY',
                feeAmount: new Prisma.Decimal(ret.shippingCharge),
                grossAmount: new Prisma.Decimal(ret.shippingCharge),
                isSettlementDeduction: false,
                reference: ret.returnWaybillNumber,
                source: ret.shippingCostSource || 'ACTUAL',
                verificationStatus: 'VERIFIED',
                note: `Exchange reverse freight for order ${order.shopifyOrderName}`,
              },
              update: {
                feeAmount: new Prisma.Decimal(ret.shippingCharge),
                grossAmount: new Prisma.Decimal(ret.shippingCharge),
              },
            });
          }
        } else {
          // Standard Customer Return
          const isConfirmed = ret.returnStatus === 'RECEIVED' ||
            ret.returnStatus === 'QC_APPROVED' ||
            ret.qcStatus === 'APPROVED' ||
            ret.refundStatus === 'PROCESSED';

          const returnEventId = `RET-${ret.id}-${isConfirmed ? 'CONFIRMED' : 'INITIATED'}`;
          const effectiveDate = ret.refundProcessedAt
            ? ret.refundProcessedAt
            : (ret.receivedAt || ret.createdAt);
          const retPeriod = dateToIstPeriod(effectiveDate);

          await prisma.financialEvent.upsert({
            where: { eventId: returnEventId },
            create: {
              eventId: returnEventId,
              orderId: order.id,
              returnId: ret.id,
              eventType: isConfirmed ? 'RETURN_CONFIRMED' : 'RETURN_INITIATED',
              period: retPeriod,
              effectiveDate: effectiveDate,
              postingDate: effectiveDate,
              customerState: cleanState,
              gstStateCode: posCode,
              provider: ret.carrier || 'DELHIVERY',
              grossAmount: new Prisma.Decimal(returnAmt),
              netAmount: new Prisma.Decimal(-returnAmt),
              isSettlementDeduction: true,
              reference: ret.returnWaybillNumber || order.shopifyOrderName,
              source: ret.refundStatus === 'PROCESSED' ? 'SHOPIFY_REFUND' : 'RETURN_SCAN',
              verificationStatus: isConfirmed ? 'VERIFIED' : 'UNVERIFIED',
              note: `${isConfirmed ? 'Confirmed' : 'Initiated'} return for order ${order.shopifyOrderName} (AWB: ${ret.returnWaybillNumber || 'N/A'})`,
            },
            update: {
              customerState: cleanState,
              gstStateCode: posCode,
              grossAmount: new Prisma.Decimal(returnAmt),
              netAmount: new Prisma.Decimal(-returnAmt),
              verificationStatus: isConfirmed ? 'VERIFIED' : 'UNVERIFIED',
            },
          });

          // A confirmed return supersedes any earlier initiated event in the same reporting period
          if (isConfirmed) {
            await prisma.financialEvent.deleteMany({
              where: {
                eventId: `RET-${ret.id}-INITIATED`,
                period: retPeriod,
              },
            }).catch(() => {});
          }
        }
      }

      // E. Gateway Fees & Net Settlement Deductions
      if (order.gatewayFee && order.gatewayFee > 0) {
        const feeDate = order.paymentReceivedAt || order.shopifyCreatedAt;
        const feePeriod = dateToIstPeriod(feeDate);
        const feeEventId = `ORD-${order.id}-GATEWAY_FEE`;
        const gwName = (order.paymentAggregator || order.paymentProvider || order.paymentGateway || '').toUpperCase();
        const eventType = isCod ? 'COD_FEE_DEDUCTED' : 'GATEWAY_FEE_DEDUCTED';

        await prisma.financialEvent.upsert({
          where: { eventId: feeEventId },
          create: {
            eventId: feeEventId,
            orderId: order.id,
            eventType: eventType,
            period: feePeriod,
            effectiveDate: feeDate,
            postingDate: feeDate,
            customerState: cleanState,
            gstStateCode: posCode,
            provider: gwName.includes('PHONEPE') ? 'PHONEPE' : gwName.includes('GOKWIK') ? 'GOKWIK' : 'EASEBUZZ',
            feeAmount: new Prisma.Decimal(order.gatewayFee),
            grossAmount: new Prisma.Decimal(order.gatewayFee),
            isSettlementDeduction: true,
            reference: order.paymentReceivedRef || order.paymentReference || order.shopifyOrderName,
            source: order.paymentReceivedSource || 'GATEWAY_SETTLEMENT',
            verificationStatus: 'VERIFIED',
            note: `Gateway processing deduction for order ${order.shopifyOrderName}`,
          },
          update: {
            feeAmount: new Prisma.Decimal(order.gatewayFee),
            grossAmount: new Prisma.Decimal(order.gatewayFee),
          },
        });
      }

      // F. Bank Receipts (Verified vs Unverified)
      if (order.paymentReceivedAmount && order.paymentReceivedAmount > 0) {
        const payDate = order.paymentReceivedAt || order.shopifyCreatedAt;
        const payPeriod = dateToIstPeriod(payDate);
        const receiptEventId = `ORD-${order.id}-BANK_RECEIPT`;
        const isVerified = Boolean(order.paymentReceivedUtr);

        await prisma.financialEvent.upsert({
          where: { eventId: receiptEventId },
          create: {
            eventId: receiptEventId,
            orderId: order.id,
            eventType: isVerified ? 'BANK_RECEIPT_VERIFIED' : 'BANK_RECEIPT_UNVERIFIED',
            period: payPeriod,
            effectiveDate: payDate,
            postingDate: payDate,
            bankValueDate: payDate,
            customerState: cleanState,
            gstStateCode: posCode,
            provider: order.paymentProvider || (isCod ? 'DELHIVERY_COD' : 'DIRECT'),
            grossAmount: new Prisma.Decimal(order.paymentReceivedAmount),
            netAmount: new Prisma.Decimal(order.paymentReceivedAmount),
            reference: order.paymentReceivedUtr || order.paymentReceivedRef || order.shopifyOrderName,
            source: order.paymentReceivedSource || 'BANK_CREDIT',
            verificationStatus: isVerified ? 'VERIFIED' : 'UNVERIFIED',
            note: `Bank payment receipt: ${order.paymentReceivedUtr ? `UTR ${order.paymentReceivedUtr}` : 'Pending UTR verification'}`,
          },
          update: {
            grossAmount: new Prisma.Decimal(order.paymentReceivedAmount),
            netAmount: new Prisma.Decimal(order.paymentReceivedAmount),
            verificationStatus: isVerified ? 'VERIFIED' : 'UNVERIFIED',
            reference: order.paymentReceivedUtr || order.paymentReceivedRef || order.shopifyOrderName,
          },
        });
      }

      // G. Freight Expenses (Wallet vs Settlement vs Estimated)
      if (order.actualShippingCost && order.actualShippingCost > 0) {
        const freightDate = order.dispatchedAt || order.shopifyCreatedAt;
        const freightPeriod = dateToIstPeriod(freightDate);
        const freightEventId = `ORD-${order.id}-FREIGHT_EXPENSE`;

        await prisma.financialEvent.upsert({
          where: { eventId: freightEventId },
          create: {
            eventId: freightEventId,
            orderId: order.id,
            shipmentId: order.shipment?.id,
            eventType: isCod ? 'FREIGHT_SETTLEMENT_DEDUCTED' : 'FREIGHT_EXPENSE_WALLET',
            period: freightPeriod,
            effectiveDate: freightDate,
            customerState: cleanState,
            gstStateCode: posCode,
            provider: order.shipment?.courier || 'DELHIVERY',
            feeAmount: new Prisma.Decimal(order.actualShippingCost),
            grossAmount: new Prisma.Decimal(order.actualShippingCost),
            isSettlementDeduction: isCod, // Deducted from COD remittance; for prepaid, paid from Delhivery wallet
            reference: order.shipment?.waybillNumber || order.shopifyOrderName,
            source: order.shippingAudited ? 'ACTUAL' : 'ESTIMATE',
            verificationStatus: order.shippingAudited ? 'VERIFIED' : 'UNVERIFIED',
            note: `Freight expense for order ${order.shopifyOrderName}`,
          },
          update: {
            feeAmount: new Prisma.Decimal(order.actualShippingCost),
            grossAmount: new Prisma.Decimal(order.actualShippingCost),
            verificationStatus: order.shippingAudited ? 'VERIFIED' : 'UNVERIFIED',
          },
        });
      }
    }

    logger.info('Financial events synchronized', { period, created, updated });
    return { created, updated };
  }

  /**
   * Build the comprehensive State-Wise Settlement Bridge for a given calendar month.
   */
  async getStateSettlementBridge(
    period: string,
    openingBalances?: Map<string, number> | Record<string, number>,
    doSync = true
  ): Promise<{ states: StateSettlementRow[]; totals: StateSettlementTotals; reconciliationBridge: any }> {
    // 1. Ensure events are synchronized for this period (unless pre-synchronized)
    if (doSync) {
      await this.syncFinancialEvents(period);
    }

    // 2. Fetch all financial events recognized in this period
    const events = await prisma.financialEvent.findMany({
      where: { period },
      orderBy: { effectiveDate: 'asc' },
    });

    // Identify confirmed returns to avoid double-counting pending returns in the same period
    const confirmedReturnIds = new Set(
      events.filter((e) => e.eventType === 'RETURN_CONFIRMED' && e.returnId).map((e) => e.returnId)
    );

    const stateMap = new Map<string, StateSettlementRow>();

    function getRow(stateName?: string | null): StateSettlementRow {
      const raw = (stateName || '').trim();
      const clean = raw.length > 0 ? raw : 'Unspecified';
      if (!stateMap.has(clean)) {
        const openBal = openingBalances
          ? (openingBalances instanceof Map ? openingBalances.get(clean) : (openingBalances as any)[clean]) || 0
          : 0;

        stateMap.set(clean, {
          state: clean,
          gstStateCode: getGstStateCode(clean),
          orderCount: 0,
          openingOutstanding: money(openBal) || 0,
          grossOrderSales: 0,
          cancelledOrders: 0,
          rtoAdjustments: 0,
          customerReturns: 0,
          expectedGrossSettlement: 0,
          gokwikEasebuzzFeeDeducted: 0,
          phonepeFeeDeducted: 0,
          codSettlementDeductions: 0,
          netExpectedBankSettlement: 0,
          verifiedPaymentReceived: 0,
          outstandingSettlement: 0,

          estimatedFreightNotBilled: 0,
          actualFreightExpenses: 0,
          exchangeFreightExpenses: 0,
          gatewayExpensesNotDeducted: 0,
          pendingReturns: 0,
          unverifiedReceipts: 0,
          disputedDeductions: 0,
          customerRefundPayable: 0,
          varianceOverpayment: 0,
        });
      }
      return stateMap.get(clean)!;
    }

    // Pre-seed opening balances
    if (openingBalances) {
      const keys = openingBalances instanceof Map ? Array.from(openingBalances.keys()) : Object.keys(openingBalances);
      for (const k of keys) getRow(k);
    }

    // Tally events into state rows
    for (const ev of events) {
      const row = getRow(ev.customerState);
      const gross = Number(ev.grossAmount) || 0;
      const fee = Number(ev.feeAmount) || 0;
      const net = Number(ev.netAmount) || 0;

      switch (ev.eventType) {
        case 'BOOKING':
          row.orderCount += 1;
          row.grossOrderSales += gross;
          break;

        case 'CANCELLATION':
          row.cancelledOrders += gross;
          break;

        case 'RTO_INITIATED':
        case 'RTO_DELIVERED':
          row.rtoAdjustments += gross;
          break;

        case 'RETURN_CONFIRMED':
          row.customerReturns += gross;
          break;

        case 'RETURN_INITIATED':
          if (!ev.returnId || !confirmedReturnIds.has(ev.returnId)) {
            row.pendingReturns += gross;
          }
          break;

        case 'GATEWAY_FEE_DEDUCTED': {
          const prov = (ev.provider || '').toUpperCase();
          if (prov.includes('PHONEPE')) {
            row.phonepeFeeDeducted += fee || gross;
          } else {
            row.gokwikEasebuzzFeeDeducted += fee || gross;
          }
          break;
        }

        case 'COD_FEE_DEDUCTED':
          row.codSettlementDeductions += fee || gross;
          break;

        case 'FREIGHT_SETTLEMENT_DEDUCTED':
          // Freight withheld from COD remittance payout
          row.codSettlementDeductions += fee || gross;
          row.actualFreightExpenses += fee || gross;
          break;

        case 'FREIGHT_EXPENSE_WALLET':
        case 'FREIGHT_EXPENSE_BILLED':
          // Paid separately from wallet / vendor invoice, NOT deducted from settlement
          row.actualFreightExpenses += fee || gross;
          break;

        case 'EXCHANGE_FREIGHT':
          row.exchangeFreightExpenses += fee || gross;
          row.actualFreightExpenses += fee || gross;
          break;

        case 'BANK_RECEIPT_VERIFIED':
          row.verifiedPaymentReceived += net || gross;
          break;

        case 'BANK_RECEIPT_UNVERIFIED':
          row.unverifiedReceipts += net || gross;
          break;
      }
    }

    // Finalize state rows with the strict settlement bridge formulas
    const states: StateSettlementRow[] = [];
    for (const row of stateMap.values()) {
      row.openingOutstanding = money(row.openingOutstanding) || 0;
      row.grossOrderSales = money(row.grossOrderSales) || 0;
      row.cancelledOrders = money(row.cancelledOrders) || 0;
      row.rtoAdjustments = money(row.rtoAdjustments) || 0;
      row.customerReturns = money(row.customerReturns) || 0;

      // Expected Gross Settlement = Opening + Gross Bookings - Cancellations - RTO - Returns
      row.expectedGrossSettlement = money(
        row.openingOutstanding +
        row.grossOrderSales -
        row.cancelledOrders -
        row.rtoAdjustments -
        row.customerReturns
      ) || 0;

      row.gokwikEasebuzzFeeDeducted = money(row.gokwikEasebuzzFeeDeducted) || 0;
      row.phonepeFeeDeducted = money(row.phonepeFeeDeducted) || 0;
      row.codSettlementDeductions = money(row.codSettlementDeductions) || 0;

      // Net Expected Bank Settlement = Expected Gross Settlement - Payout Deductions
      row.netExpectedBankSettlement = money(
        row.expectedGrossSettlement -
        row.gokwikEasebuzzFeeDeducted -
        row.phonepeFeeDeducted -
        row.codSettlementDeductions
      ) || 0;

      row.verifiedPaymentReceived = money(row.verifiedPaymentReceived) || 0;

      // Outstanding Settlement = Net Expected Settlement - Verified Bank Receipts
      row.outstandingSettlement = money(
        row.netExpectedBankSettlement - row.verifiedPaymentReceived
      ) || 0;

      row.actualFreightExpenses = money(row.actualFreightExpenses) || 0;
      row.exchangeFreightExpenses = money(row.exchangeFreightExpenses) || 0;
      row.pendingReturns = money(row.pendingReturns) || 0;
      row.unverifiedReceipts = money(row.unverifiedReceipts) || 0;

      states.push(row);
    }

    // Sort by gross order sales descending
    states.sort((a, b) => b.grossOrderSales - a.grossOrderSales || Math.abs(b.outstandingSettlement) - Math.abs(a.outstandingSettlement));

    const totals: StateSettlementTotals = {
      totalOrders: sum(states.map((s) => s.orderCount)),
      openingOutstanding: sum(states.map((s) => s.openingOutstanding)),
      grossOrderSales: sum(states.map((s) => s.grossOrderSales)),
      cancelledOrders: sum(states.map((s) => s.cancelledOrders)),
      rtoAdjustments: sum(states.map((s) => s.rtoAdjustments)),
      customerReturns: sum(states.map((s) => s.customerReturns)),
      expectedGrossSettlement: sum(states.map((s) => s.expectedGrossSettlement)),
      gokwikEasebuzzFeeDeducted: sum(states.map((s) => s.gokwikEasebuzzFeeDeducted)),
      phonepeFeeDeducted: sum(states.map((s) => s.phonepeFeeDeducted)),
      codSettlementDeductions: sum(states.map((s) => s.codSettlementDeductions)),
      netExpectedBankSettlement: sum(states.map((s) => s.netExpectedBankSettlement)),
      verifiedPaymentReceived: sum(states.map((s) => s.verifiedPaymentReceived)),
      outstandingSettlement: sum(states.map((s) => s.outstandingSettlement)),

      estimatedFreightNotBilled: sum(states.map((s) => s.estimatedFreightNotBilled)),
      actualFreightExpenses: sum(states.map((s) => s.actualFreightExpenses)),
      exchangeFreightExpenses: sum(states.map((s) => s.exchangeFreightExpenses)),
      gatewayExpensesNotDeducted: sum(states.map((s) => s.gatewayExpensesNotDeducted)),
      pendingReturns: sum(states.map((s) => s.pendingReturns)),
      unverifiedReceipts: sum(states.map((s) => s.unverifiedReceipts)),
      disputedDeductions: sum(states.map((s) => s.disputedDeductions)),
      customerRefundPayable: sum(states.map((s) => s.customerRefundPayable)),
      varianceOverpayment: sum(states.map((s) => s.varianceOverpayment)),
    };

    const reconciliationBridge = {
      period,
      openingBalance: totals.openingOutstanding,
      plusGrossBookings: totals.grossOrderSales,
      minusCancellations: totals.cancelledOrders,
      minusRtoAdjustments: totals.rtoAdjustments,
      minusCustomerReturns: totals.customerReturns,
      equalsExpectedGross: totals.expectedGrossSettlement,
      minusGatewayDeductions: money(totals.gokwikEasebuzzFeeDeducted + totals.phonepeFeeDeducted),
      minusCodDeductions: totals.codSettlementDeductions,
      equalsNetExpectedBankReceipts: totals.netExpectedBankSettlement,
      minusVerifiedBankCredits: totals.verifiedPaymentReceived,
      equalsClosingOutstanding: totals.outstandingSettlement,
      invariantsSatisfied: Math.abs(
        totals.netExpectedBankSettlement - (totals.verifiedPaymentReceived + totals.outstandingSettlement)
      ) < 0.05,
    };

    return { states, totals, reconciliationBridge };
  }

  /**
   * Build the Monthly Expense Report (View B).
   */
  async buildMonthlyExpenseReport(period: string): Promise<MonthlyExpenseReport> {
    const events = await prisma.financialEvent.findMany({
      where: { period },
    });

    const report: MonthlyExpenseReport = {
      period,
      gokwikFees: { mdr: 0, platform: 0, gst: 0, total: 0 },
      easebuzzFees: { mdr: 0, gst: 0, total: 0 },
      phonepeFees: { mdr: 0, gst: 0, total: 0 },
      delhiveryFreight: { forward: 0, rto: 0, reverse: 0, cod: 0, weight: 0, gst: 0, total: 0, walletDeducted: 0 },
      velocityFreight: { forward: 0, rto: 0, reverse: 0, cod: 0, weight: 0, gst: 0, total: 0, billed: 0 },
      exchangeFreight: { reverseFreight: 0, forwardFreight: 0, extraPaidByCustomer: 0, netFreightExpense: 0, exchangeCount: 0 },
      totalOperatingExpenses: 0,
      totalInputGstEligible: 0,
    };

    for (const ev of events) {
      const gross = Number(ev.grossAmount) || 0;
      const fee = Number(ev.feeAmount) || 0;
      const prov = (ev.provider || '').toUpperCase();

      if (ev.eventType === 'GATEWAY_FEE_DEDUCTED') {
        const amt = fee || gross;
        const gst = money(amt * 0.18 / 1.18) || 0;
        const base = money(amt - gst) || 0;

        if (prov.includes('PHONEPE')) {
          report.phonepeFees.mdr += base;
          report.phonepeFees.gst += gst;
          report.phonepeFees.total += amt;
        } else if (prov.includes('GOKWIK')) {
          report.gokwikFees.platform += base;
          report.gokwikFees.gst += gst;
          report.gokwikFees.total += amt;
        } else {
          report.easebuzzFees.mdr += base;
          report.easebuzzFees.gst += gst;
          report.easebuzzFees.total += amt;
        }
      } else if (ev.eventType === 'FREIGHT_EXPENSE_WALLET' || ev.eventType === 'FREIGHT_SETTLEMENT_DEDUCTED') {
        const amt = fee || gross;
        if (prov.includes('VELOCITY')) {
          report.velocityFreight.forward += amt;
          report.velocityFreight.total += amt;
        } else {
          report.delhiveryFreight.forward += amt;
          report.delhiveryFreight.total += amt;
          if (ev.eventType === 'FREIGHT_EXPENSE_WALLET') {
            report.delhiveryFreight.walletDeducted += amt;
          }
        }
      } else if (ev.eventType === 'EXCHANGE_FREIGHT') {
        const amt = fee || gross;
        report.exchangeFreight.reverseFreight += amt;
        report.exchangeFreight.netFreightExpense += amt;
        report.exchangeFreight.exchangeCount += 1;
      }
    }

    report.totalOperatingExpenses = money(
      report.gokwikFees.total +
      report.easebuzzFees.total +
      report.phonepeFees.total +
      report.delhiveryFreight.total +
      report.velocityFreight.total +
      report.exchangeFreight.netFreightExpense
    ) || 0;

    report.totalInputGstEligible = money(
      report.gokwikFees.gst +
      report.easebuzzFees.gst +
      report.phonepeFees.gst +
      report.delhiveryFreight.gst +
      report.velocityFreight.gst
    ) || 0;

    return report;
  }

  /**
   * Build the Monthly Contribution / P&L Report (View C).
   */
  async buildMonthlyContributionReport(
    period: string,
    existingTotals?: StateSettlementTotals,
    existingExpenses?: MonthlyExpenseReport
  ): Promise<MonthlyContributionReport> {
    const totals = existingTotals || (await this.getStateSettlementBridge(period)).totals;
    const expense = existingExpenses || (await this.buildMonthlyExpenseReport(period));

    const netRecognizedRevenue = money(
      totals.grossOrderSales - totals.cancelledOrders - totals.rtoAdjustments - totals.customerReturns
    ) || 0;

    // Calculate dynamic taxable revenue & GST using actual order evidence where possible
    let taxableRevenue = 0;
    let totalOutputGst = 0;
    let missingEvidence = false;

    try {
      const { start, end } = monthRange(period);
      const orders = await prisma.order.findMany({
        where: { shopifyCreatedAt: { gte: start, lt: end } },
        select: { totalAmount: true, customerState: true, totalTax: true, shopifyCreatedAt: true, totalDiscounts: true, status: true },
      });

      if (orders.length > 0) {
        let grossTaxable = 0;
        let grossGst = 0;
        for (const ord of orders) {
          if (ord.status === 'CANCELLED') continue;
          try {
            const tax = gstService.calculateSalesTax(ord.totalAmount, ord.customerState, undefined, ord);
            grossTaxable += tax.taxableAmount;
            grossGst += tax.totalGst;
          } catch {
            missingEvidence = true;
          }
        }

        // Net ratio applied to reversals (returns + RTOs)
        const grossBasis = totals.grossOrderSales || 1;
        const netRatio = Math.max(0, netRecognizedRevenue / grossBasis);
        taxableRevenue = money(grossTaxable * netRatio) || 0;
        totalOutputGst = money(grossGst * netRatio) || 0;
      } else {
        missingEvidence = true;
      }
    } catch {
      missingEvidence = true;
    }

    if (taxableRevenue === 0 && netRecognizedRevenue !== 0) {
      const fallbackTax = gstService.calculateSalesTax(netRecognizedRevenue, 'Gujarat');
      taxableRevenue = fallbackTax.taxableAmount;
      totalOutputGst = fallbackTax.totalGst;
    }

    const gatewayExpenses = money(expense.gokwikFees.total + expense.easebuzzFees.total + expense.phonepeFees.total) || 0;
    const freightExpenses = money(expense.delhiveryFreight.total + expense.velocityFreight.total) || 0;
    const exchangeExpenses = expense.exchangeFreight.netFreightExpense;

    const totalVariableExpenses = money(gatewayExpenses + freightExpenses + exchangeExpenses) || 0;
    const contributionBeforeCogs = money(taxableRevenue - totalVariableExpenses) || 0;
    const contributionMarginPercent = taxableRevenue > 0
      ? Math.round((contributionBeforeCogs / taxableRevenue) * 10000) / 100
      : 0;

    const notes = missingEvidence
      ? 'Contribution before COGS. Note: Some order GST evidence was missing or estimated.'
      : 'Contribution before COGS derived from order-level GST evidence. COGS accounted off-OMS.';

    return {
      period,
      grossBookings: totals.grossOrderSales,
      cancelledOrders: totals.cancelledOrders,
      rtoAdjustments: totals.rtoAdjustments,
      customerReturns: totals.customerReturns,
      netRecognizedRevenue,
      taxableRevenue,
      totalOutputGst,
      gatewayExpenses,
      freightExpenses,
      exchangeExpenses,
      totalVariableExpenses,
      contributionBeforeCogs,
      contributionMarginPercent,
      cogsAvailable: false,
      notes,
    };
  }
}

export const financialEventService = new FinancialEventService();
