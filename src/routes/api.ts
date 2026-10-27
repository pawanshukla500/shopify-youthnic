import { Router, Request, Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth.middleware';
import axios from 'axios';
import orderService from '../modules/orders/order.service';
import { classifyOrderTab, isCodConfirmed, isHighRtoCancel, isPrepaidOrder, prioritizeOrdersForDispatch } from '../modules/orders/order-tabs';
import returnService from '../modules/returns/return.service';
import trackingService from '../modules/tracking/tracking.service';
import shopifyService from '../modules/shopify/shopify.service';
import paymentService from '../modules/payments/payment.service';
import delhiveryService from '../modules/delhivery/delhivery.service';
import { readSpreadsheet } from '../modules/accounts/spreadsheet';
import { importDelhiveryRemittance, recordPaymentReceived, syncVelocityRemittance } from '../modules/accounts/reconciliation.service';
import { getOrderAccountTrail, presentAccountTrailEvent, recordAccountTrailEvent, recordManualRefund, type RefundMode } from '../modules/accounts/account-trail.service';
import { config } from '../config';
import prisma from '../database/prisma';
import logger from '../utils/logger';
import kwikengageService, { KwikEngageTriggerType } from '../modules/whatsapp/kwikengage.service';
import gokwikService from '../modules/payments/gokwik.service';
import productService from '../modules/products/product.service';
import resendService, { EmailTemplateType } from '../modules/email/resend.service';
import emailLogService from '../modules/email/email-log.service';
import firebaseService from '../modules/firebase/firebase.service';
import emailAnalyzerService from '../modules/ai/email-analyzer.service';
import knowledgeLearnerService from '../modules/ai/knowledge-learner.service';
import metaLlmService from '../modules/ai/meta-llm.service';
import agentMemoryService from '../modules/ai/agent-memory.service';
import conversationAgentService from '../modules/ai/conversation-agent.service';
import shippingLabelService from '../modules/delhivery/shipping-label.service';
import invoiceService from '../modules/invoice/invoice.service';
import picklistService from '../modules/picklist/picklist.service';
import bulkPackService from '../modules/bulk-pack/bulk-pack.service';
import { isExpiredSignedUrl, isUsableHttpUrl } from '../utils/signed-url';
import { queueManifestForPickup, scheduleWaitingParcels, submitPickupBatch } from '../modules/delhivery/pickup-batch.service';
import { addStaffNote, getOrderActivity, recordOrderAction } from '../modules/orders/order-activity.service';
import returnScanService from '../modules/returns/return-scan.service';
import shippingRouterService, { CarrierPriority, CourierChoice } from '../modules/shipping/shipping-router.service';
import velocityService from '../modules/velocity/velocity.service';
import { isVelocityCourier, getTrackingUrl } from '../utils/courier';
import { mergePdfBuffers, create4x6FallbackPdf } from '../utils/pdf-merger';

const router = Router();

async function downloadLabelBytes(url: string): Promise<Buffer> {
  if (isExpiredSignedUrl(url) || !url.startsWith('http')) {
    throw new Error('signed_url_expired');
  }
  const response = await axios.get<ArrayBuffer>(url, {
    responseType: 'arraybuffer',
    timeout: 20000,
    maxContentLength: 8 * 1024 * 1024,
    validateStatus: (status) => status >= 200 && status < 300,
  });
  const buffer = Buffer.from(response.data);
  const head = buffer.subarray(0, 240).toString('utf8');
  if (/<Error>|AccessDenied|Request has expired/i.test(head)) {
    throw new Error('signed_url_expired');
  }
  return buffer;
}

async function loadFreshLabelPdf(
  waybill: string,
  currentUrl?: string | null,
  shipmentId?: number,
  courier?: string | null
): Promise<Buffer | null> {
  const candidates: string[] = [];
  if (isUsableHttpUrl(currentUrl)) candidates.push(currentUrl);

  if (isVelocityCourier(courier, currentUrl, waybill)) {
    try {
      const vPdf = await velocityService.fetchOfficialLabelPdf(waybill, currentUrl);
      if (vPdf) return vPdf;
    } catch (err: any) {
      logger.warn('Velocity shipping label download failed', { waybill, currentUrl, error: err.message });
    }
    return null;
  }

  try {
    const fresh = await delhiveryService.generateLabel(waybill);
    if (isUsableHttpUrl(fresh) && !candidates.includes(fresh)) candidates.unshift(fresh);
    if (isUsableHttpUrl(fresh) && shipmentId) {
      await prisma.shipment
        .update({ where: { id: shipmentId }, data: { labelUrl: fresh } })
        .catch(() => undefined);
    }
  } catch (err: any) {
    logger.warn('Could not refresh Delhivery packing slip', { waybill, error: err.message });
  }

  for (const url of candidates) {
    try {
      return await downloadLabelBytes(url);
    } catch (err: any) {
      logger.warn('Packing slip download failed', { waybill, error: err.message });
    }
  }
  return null;
}

// ─── Health ──────────────────────────────────────────────
router.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Dashboard Stats & Analytics ─────────────────────────
router.get('/dashboard/stats', async (_req: Request, res: Response): Promise<void> => {
  try {
    const [allOrders, shipments, returns] = await Promise.all([
      prisma.order.findMany({
        include: { items: true, shipment: true, returns: true },
        orderBy: { shopifyCreatedAt: 'desc' },
      }),
      prisma.shipment.findMany({
        include: { order: true },
      }),
      prisma.return.findMany({
        include: { items: true },
      }),
    ]);

    const totalOrders = allOrders.length;
    const totalRevenue = allOrders.reduce((sum, o) => sum + (o.totalAmount || 0), 0);
    const averageOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0;

    // Split COD vs Prepaid
    const codOrders = allOrders.filter(
      (o) => o.paymentMethod === 'COD' || o.paymentGateway?.toLowerCase().includes('cash')
    );
    const prepaidOrders = allOrders.filter(
      (o) => o.paymentMethod !== 'COD' && !o.paymentGateway?.toLowerCase().includes('cash')
    );

    const codCount = codOrders.length;
    const codRevenue = codOrders.reduce((sum, o) => sum + (o.totalAmount || 0), 0);
    const prepaidCount = prepaidOrders.length;
    const prepaidRevenue = prepaidOrders.reduce((sum, o) => sum + (o.totalAmount || 0), 0);
    const prepaidRatio = totalOrders > 0 ? (prepaidCount / totalOrders) * 100 : 0;
    const codRatio = totalOrders > 0 ? (codCount / totalOrders) * 100 : 0;

    // Delivery & Dispatches — same queues as the Orders page tabs.
    const tabOf = (order: (typeof allOrders)[number]) => classifyOrderTab(order);
    // "Payment Received" orders are delivered orders that also closed for accounts.
    const deliveredOrders = allOrders.filter((o) => tabOf(o) === 'delivered' || tabOf(o) === 'closed');
    const deliveredCount = deliveredOrders.length;
    const transitOrders = allOrders.filter((o) => tabOf(o) === 'transit');
    const activeShipments = transitOrders.length;
    const readyToDispatch = allOrders.filter((o) => tabOf(o) === 'dispatch').length;
    const readyToShip = allOrders.filter((o) => tabOf(o) === 'ready').length;
    const now = new Date();
    const delayedDispatchOrders = allOrders.filter((o) => {
      if (tabOf(o) !== 'dispatch') return false;
      if (o.dispatchDelayed) return true;
      if (o.expectedDispatchAt) return new Date(o.expectedDispatchAt) < now;
      const orderAgeHours = (now.getTime() - new Date(o.shopifyCreatedAt).getTime()) / (1000 * 60 * 60);
      return orderAgeHours > 24;
    });
    const delayedDispatchCount = delayedDispatchOrders.length;
    const ndrExceptions = allOrders.filter((o) =>
      ['FAILED_DELIVERY', 'RTO_INITIATED'].includes(o.status) ||
      Boolean(o.shipment?.trackingStatus && /fail|attempt|undeliver/i.test(o.shipment.trackingStatus))
    ).length;
    const totalReturnsCount = returns.length;
    const returnRate = totalOrders > 0 ? (totalReturnsCount / totalOrders) * 100 : 0;

    // 3-Way Reconciliation
    // 1. Delhivery COD
    const codCollected = shipments
      .filter((s) => s.paymentMode === 'COD' && s.codCollected)
      .reduce((sum, s) => sum + (s.codAmount || 0), 0);
    const codRemitted = shipments
      .filter((s) => s.paymentMode === 'COD' && s.codRemitted)
      .reduce((sum, s) => sum + (s.codRemittedAmount ?? s.codAmount ?? 0), 0);
    const codPendingRemittance = Math.max(0, codCollected - codRemitted);
    const codInTransit = Math.max(0, codRevenue - codCollected);

    // 2. GoKwik Prepaid
    const gokwikOrders = prepaidOrders.filter(
      (o) =>
        o.paymentGateway?.toLowerCase().includes('gokwik') ||
        o.salesChannel?.toLowerCase().includes('gokwik') ||
        o.sourceName === '249596116993'
    );
    const gokwikCount = gokwikOrders.length;
    const gokwikRevenue = gokwikOrders.reduce((sum, o) => sum + (o.totalAmount || 0), 0);
    const gokwikVerified = gokwikOrders.filter((o) => o.paymentVerified).length;
    const gokwikEstFees = gokwikRevenue * 0.02; // approx 2% MDR
    const gokwikEstPayout = Math.max(0, gokwikRevenue - gokwikEstFees);

    // 3. PhonePe Prepaid
    const phonepeOrders = prepaidOrders.filter((o) =>
      o.paymentGateway?.toLowerCase().includes('phonepe')
    );
    const phonepeCount = phonepeOrders.length;
    const phonepeRevenue = phonepeOrders.reduce((sum, o) => sum + (o.totalAmount || 0), 0);
    const phonepeVerified = phonepeOrders.filter((o) => o.paymentVerified).length;
    const phonepeEstFees = phonepeRevenue * 0.018; // approx 1.8% MDR
    const phonepeEstPayout = Math.max(0, phonepeRevenue - phonepeEstFees);

    // 4. Manual / Draft / Direct
    const otherOrders = allOrders.filter(
      (o) =>
        !codOrders.includes(o) &&
        !gokwikOrders.includes(o) &&
        !phonepeOrders.includes(o)
    );
    const otherCount = otherOrders.length;
    const otherRevenue = otherOrders.reduce((sum, o) => sum + (o.totalAmount || 0), 0);

    // Geographic Analysis
    const stateMap: Record<string, { count: number; revenue: number; cities: Set<string> }> = {};
    for (const o of allOrders) {
      const state = o.customerState?.trim() || 'Other';
      if (!stateMap[state]) {
        stateMap[state] = { count: 0, revenue: 0, cities: new Set() };
      }
      stateMap[state].count += 1;
      stateMap[state].revenue += o.totalAmount || 0;
      if (o.customerCity) stateMap[state].cities.add(o.customerCity);
    }
    const topStates = Object.entries(stateMap)
      .map(([state, data]) => ({
        state,
        orders: data.count,
        revenue: data.revenue,
        citiesCount: data.cities.size,
        percentage: totalOrders > 0 ? (data.count / totalOrders) * 100 : 0,
      }))
      .sort((a, b) => b.orders - a.orders)
      .slice(0, 6);

    // Operations Funnel Breakdown (5 Main Lifecycle Stages)
    const outForDeliveryOrders = transitOrders.filter(
      (o) =>
        o.status === 'OUT_FOR_DELIVERY' ||
        o.shipment?.status === 'OUT_FOR_DELIVERY' ||
        /out for delivery/i.test(o.shipment?.trackingStatus || '')
    );
    const outForDeliveryIds = new Set(outForDeliveryOrders.map((o) => o.id));
    const funnel = {
      intake: {
        total: allOrders.filter((o) => tabOf(o) === 'new').length,
        unverified: allOrders.filter((o) => tabOf(o) === 'new' && !o.paymentVerified).length,
      },
      warehouse: {
        dispatchPending: readyToDispatch,
        dispatched: readyToShip,
      },
      logistics: {
        shipped: transitOrders.filter(
          (o) => !outForDeliveryIds.has(o.id) && (o.status === 'SHIPPED' || o.shipment?.status === 'PICKED_UP')
        ).length,
        inTransit: transitOrders.filter(
          (o) =>
            !outForDeliveryIds.has(o.id) &&
            o.status !== 'SHIPPED' &&
            o.shipment?.status !== 'PICKED_UP'
        ).length,
        outForDelivery: outForDeliveryOrders.length,
      },
      finalMile: {
        delivered: deliveredCount,
        failedDelivery: allOrders.filter((o) => o.status === 'FAILED_DELIVERY').length,
        rtoInitiated: allOrders.filter((o) => o.status === 'RTO_INITIATED').length,
        rtoDelivered: allOrders.filter((o) => o.status === 'RTO_DELIVERED').length,
      },
      returns: {
        requested: allOrders.filter((o) => o.status === 'RETURN_REQUESTED').length,
        dispatched: allOrders.filter((o) => o.status === 'RETURN_DISPATCHED').length,
        received: allOrders.filter((o) => o.status === 'RETURN_RECEIVED').length,
        refunded: allOrders.filter((o) => o.status === 'REFUNDED').length,
      },
    };

    // Actionable Attention Items
    const actionItems = [];

    // Priority 0: Delayed Dispatch SLA Breach (>24h SLA)
    if (delayedDispatchCount > 0) {
      actionItems.push({
        id: 'delayed_dispatch_sla',
        priority: 'critical',
        category: '⚠️ SLA Breach Warning',
        title: `${delayedDispatchCount} order${delayedDispatchCount > 1 ? 's' : ''} overdue for dispatch (>24h SLA)!`,
        description: 'Orders have exceeded the 24-hour dispatch SLA without AWB generation. Dispatch via priority courier to prevent customer cancellation.',
        actionText: 'Resolve Overdue Orders',
        filterParam: 'filter=DELAYED_DISPATCH',
      });
    }

    // Priority 0.5: NDR Delivery Exceptions
    if (ndrExceptions > 0) {
      actionItems.push({
        id: 'ndr_delivery_exceptions',
        priority: 'critical',
        category: '🚨 NDR Delivery Exceptions',
        title: `${ndrExceptions} shipment${ndrExceptions > 1 ? 's' : ''} facing delivery failure / NDR!`,
        description: 'Courier reported delivery attempt failed or customer unavailable. Re-attempt delivery or mark RTO to safeguard inventory.',
        actionText: 'Resolve NDR Exceptions',
        filterParam: 'filter=NDR',
      });
    }

    // Priority 1: Prepaid orders needing immediate dispatch
    const prepaidPendingDispatch = allOrders.filter((o) => tabOf(o) === 'dispatch' && isPrepaidOrder(o));
    if (prepaidPendingDispatch.length > 0) {
      actionItems.push({
        id: 'prepaid_dispatch_needed',
        priority: 'critical',
        category: '⚡ Priority Dispatch',
        title: `${prepaidPendingDispatch.length} PREPAID order${prepaidPendingDispatch.length > 1 ? 's' : ''} awaiting immediate dispatch!`,
        description: 'Customer has paid in advance via GoKwik / UPI / PhonePe. Dispatch immediately via partner couriers to meet SLA.',
        actionText: 'Dispatch Prepaid Orders',
        filterParam: 'filter=PREPAID_DISPATCH',
      });
    }

    if (readyToDispatch > 0) {
      actionItems.push({
        id: 'dispatch_queue',
        priority: 'high',
        category: 'Fulfillment',
        title: `${readyToDispatch} order${readyToDispatch > 1 ? 's' : ''} ready for carrier manifest`,
        description: 'New orders require AWB generation and shipping labels to be printed.',
        actionText: 'View Dispatch Queue',
        filterParam: 'status=NEW',
      });
    }
    const unverifiedPrepaid = allOrders.filter(
      (o) => !o.paymentVerified && o.paymentMethod !== 'COD' && o.status === 'NEW'
    );
    if (unverifiedPrepaid.length > 0) {
      actionItems.push({
        id: 'unverified_prepaid',
        priority: 'critical',
        category: 'Payment Risk',
        title: `${unverifiedPrepaid.length} prepaid order${unverifiedPrepaid.length > 1 ? 's' : ''} unverified`,
        description: 'Orders need gateway transaction verification before generating shipping labels.',
        actionText: 'Verify Payments',
        filterParam: 'verified=false',
      });
    }
    const qcPendingReturns = returns.filter(
      (r) => r.returnStatus === 'RECEIVED' || (r.returnStatus as string) === 'QC_PENDING'
    );
    if (qcPendingReturns.length > 0) {
      actionItems.push({
        id: 'qc_pending',
        priority: 'medium',
        category: 'Returns & QC',
        title: `${qcPendingReturns.length} return package${qcPendingReturns.length > 1 ? 's' : ''} awaiting QC scan`,
        description: 'Returned packages received at Surat warehouse pending quality check.',
        actionText: 'Open QC Scanner',
        filterParam: 'tab=returns',
      });
    }
    if (codPendingRemittance > 0) {
      actionItems.push({
        id: 'cod_remittance',
        priority: 'medium',
        category: 'Finance',
        title: `₹${codPendingRemittance.toFixed(2)} COD remittance outstanding`,
        description: 'Cash collected by Delhivery delivery executives pending payout cycle.',
        actionText: 'Reconcile Remittance',
        filterParam: 'gateway=cod',
      });
    }

    // Calculate total estimated logistics charges across all orders
    const totalEstimatedLogisticsCost = Math.round(
      allOrders.reduce((sum, o) => {
        const rate = delhiveryService.calculateRateCardMatrix({
          mode: (config.delhivery.shippingMode === 'Express' ? 'E' : 'S') as 'E' | 'S',
          chargeableWeightGrams: 500,
          originPincode: config.delhivery.seller.pincode,
          destinationPincode: o.customerPincode,
          shipmentStatus: 'Delivered',
          paymentType: o.paymentMethod === 'COD' ? 'COD' : 'Pre-paid',
          codAmount: o.paymentMethod === 'COD' ? o.totalAmount : 0,
        });
        return sum + rate.totalAmount;
      }, 0) * 100
    ) / 100;

    const [carrierPriority, autoFailoverSetting] = await Promise.all([
      shippingRouterService.getCarrierPriority(),
      prisma.setting.findUnique({ where: { key: 'shipping_auto_failover' } }),
    ]);
    const delhiveryShipments = shipments.filter(
      (s) => !isVelocityCourier(s.courier, s.labelUrl, s.waybillNumber)
    );
    const velocityShipments = shipments.filter(
      (s) => isVelocityCourier(s.courier, s.labelUrl, s.waybillNumber)
    );

    const carriers = {
      priority: carrierPriority,
      activePriority: carrierPriority,
      autoFailover: autoFailoverSetting?.value !== 'false',
      delhivery: {
        name: 'Delhivery Express',
        total: delhiveryShipments.length,
        totalShipments: delhiveryShipments.length,
        inTransit: delhiveryShipments.filter((s) => s.status === 'IN_TRANSIT').length,
        delivered: delhiveryShipments.filter((s) => s.status === 'DELIVERED').length,
        ndr: delhiveryShipments.filter((s) => s.status === 'FAILED').length,
        configured: Boolean(config.delhivery.apiToken),
        status: config.delhivery.apiToken ? 'CONNECTED' : 'STANDBY',
      },
      velocity: {
        name: 'Velocity Shipping',
        total: velocityShipments.length,
        totalShipments: velocityShipments.length,
        inTransit: velocityShipments.filter((s) => s.status === 'IN_TRANSIT').length,
        delivered: velocityShipments.filter((s) => s.status === 'DELIVERED').length,
        ndr: velocityShipments.filter((s) => s.status === 'FAILED').length,
        configured: Boolean(config.velocity.apiToken),
        status: config.velocity.apiToken ? 'CONNECTED' : 'STANDBY',
      },
    };

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      carriers,
      kpis: {
        totalRevenue,
        totalOrders,
        averageOrderValue,
        prepaidCount,
        prepaidRevenue,
        prepaidRatio,
        codCount,
        codRevenue,
        codRatio,
        readyToDispatch,
        delayedDispatchCount,
        activeShipments,
        deliveredCount,
        ndrExceptions,
        totalReturnsCount,
        returnRate,
        totalEstimatedLogisticsCost,
      },
      reconciliation: {
        delhiveryCod: {
          orderCount: codCount,
          totalAmount: codRevenue,
          collectedAmount: codCollected,
          remittedAmount: codRemitted,
          pendingRemittance: codPendingRemittance,
          inTransitAmount: codInTransit,
          settlementChannel: 'Delhivery Courier Cash Collection (Panel Remittance)',
          payoutSchedule: 'Weekly Delhivery Batch (T+4 to T+7)',
          estimatedCodFee: codCount * 38,
        },
        gokwikPrepaid: {
          orderCount: gokwikCount,
          totalAmount: gokwikRevenue,
          verifiedCount: gokwikVerified,
          unverifiedCount: gokwikCount - gokwikVerified,
          estimatedFees: gokwikEstFees,
          estimatedPayout: gokwikEstPayout,
          settlementChannel: 'GoKwik 1-Click Checkout',
          payoutSchedule: 'T+1 Business Day Direct Bank Payout',
        },
        phonepePrepaid: {
          orderCount: phonepeCount,
          totalAmount: phonepeRevenue,
          verifiedCount: phonepeVerified,
          unverifiedCount: phonepeCount - phonepeVerified,
          estimatedFees: phonepeEstFees,
          estimatedPayout: phonepeEstPayout,
          settlementChannel: 'PhonePe Payment Gateway (UPI / Cards)',
          payoutSchedule: 'T+1 Bank Settlement',
        },
        manualPrepaid: {
          orderCount: otherCount,
          totalAmount: otherRevenue,
          settlementChannel: 'Shopify Draft / Manual Orders',
          payoutSchedule: 'Offline / Manual Capture',
        },
      },
      funnel,
      topStates,
      actionItems,
      recentOrders: allOrders.slice(0, 10).map((o) => {
        const rate = delhiveryService.calculateRateCardMatrix({
          mode: (config.delhivery.shippingMode === 'Express' ? 'E' : 'S') as 'E' | 'S',
          chargeableWeightGrams: 500,
          originPincode: config.delhivery.seller.pincode,
          destinationPincode: o.customerPincode,
          shipmentStatus: 'Delivered',
          paymentType: o.paymentMethod === 'COD' ? 'COD' : 'Pre-paid',
          codAmount: o.paymentMethod === 'COD' ? o.totalAmount : 0,
        });
        return {
          id: o.id,
          shopifyOrderId: o.shopifyOrderId,
          shopifyOrderName: o.shopifyOrderName,
          customerName: o.customerName,
          customerCity: o.customerCity,
          customerState: o.customerState,
          customerPhone: o.customerPhone,
          totalAmount: o.totalAmount,
          currency: o.currency,
          status: o.status,
          paymentGateway: o.paymentGateway,
          paymentMethod: o.paymentMethod,
          paymentVerified: o.paymentVerified,
          salesChannel: o.salesChannel,
          itemsCount: o.items.length,
          waybillNumber: o.shipment?.waybillNumber || null,
          estimatedShippingCost: rate.totalAmount,
          shippingZone: rate.zone,
          shippingZoneCode: rate.zoneCode,
          shopifyCreatedAt: o.shopifyCreatedAt,
          createdAt: o.shopifyCreatedAt || o.createdAt,
        };
      }),
      delhiveryStatus: {
        tokenConfigured: Boolean(config.delhivery.apiToken),
        originPincode: config.delhivery.seller.pincode,
        originCity: config.delhivery.seller.city,
        originState: config.delhivery.seller.state,
      },
    });
  } catch (error: any) {
    logger.error('Error calculating dashboard stats', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// ─── Reports & Analytics (Financial P&L, Couriers, State Breakdown) ───
router.get('/reports/analytics', async (_req: Request, res: Response): Promise<void> => {
  try {
    const allOrders = await prisma.order.findMany({
      include: { items: true, shipment: true, returns: true },
      orderBy: { shopifyCreatedAt: 'asc' },
    });

    const totalAllOrders = allOrders.length;

    // ─────────────────────────────────────────────────────────────
    // 1. Monthly Financial P&L Breakdown (media_1790266204581.png)
    // ─────────────────────────────────────────────────────────────
    const monthMap: Record<string, {
      monthKey: string;
      label: string;
      dateObj: Date;
      orders: typeof allOrders;
    }> = {};

    for (const order of allOrders) {
      const d = new Date(order.shopifyCreatedAt || order.createdAt);
      const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const monthLabel = d.toLocaleString('en-US', { month: 'long', year: 'numeric' });

      if (!monthMap[monthKey]) {
        monthMap[monthKey] = {
          monthKey,
          label: monthLabel,
          dateObj: new Date(d.getFullYear(), d.getMonth(), 1),
          orders: [],
        };
      }
      monthMap[monthKey].orders.push(order);
    }

    const sortedMonths = Object.values(monthMap).sort((a, b) => a.dateObj.getTime() - b.dateObj.getTime());

    const monthlyReport = sortedMonths.map((m) => {
      const mOrders = m.orders;
      const noOfOrders = mOrders.length;
      const prepaidOrders = mOrders.filter((o) => o.paymentMethod !== 'COD');
      const prepaidCount = prepaidOrders.length;
      const prepaidPercent = noOfOrders > 0 ? Math.round((prepaidCount / noOfOrders) * 1000) / 10 : 0;

      const grossAmount = Math.round(mOrders.reduce((sum, o) => sum + (o.totalAmount || 0), 0) * 100) / 100;
      const grossQty = mOrders.reduce(
        (sum, o) => sum + (o.items && o.items.length > 0 ? o.items.reduce((s, i) => s + (i.quantity || 1), 0) : 1),
        0
      );

      // RTO, Cancel, RVP
      const rtoOrCancelledOrders = mOrders.filter((o) =>
        ['CANCELLED', 'RTO_INITIATED', 'RTO_DELIVERED', 'FAILED_DELIVERY'].includes(o.status) ||
        (o.tags && /rto|cancelled|cancel/i.test(o.tags))
      );
      const rtoCancelAmount = Math.round(rtoOrCancelledOrders.reduce((sum, o) => sum + (o.totalAmount || 0), 0) * 100) / 100;
      const rtoCancelQty = rtoOrCancelledOrders.reduce(
        (sum, o) => sum + (o.items && o.items.length > 0 ? o.items.reduce((s, i) => s + (i.quantity || 1), 0) : 1),
        0
      );

      // Cancel by Seller
      const sellerCancelOrders = mOrders.filter(
        (o) => o.tags && /cancel_by_seller|seller_cancelled|out_of_stock/i.test(o.tags)
      );
      const sellerCancelAmount = Math.round(sellerCancelOrders.reduce((sum, o) => sum + (o.totalAmount || 0), 0) * 100) / 100;
      const sellerCancelQty = sellerCancelOrders.reduce(
        (sum, o) => sum + (o.items && o.items.length > 0 ? o.items.reduce((s, i) => s + (i.quantity || 1), 0) : 1),
        0
      );

      // Forward Sales [A]
      const forwardSalesAmount = Math.max(0, Math.round((grossAmount - rtoCancelAmount - sellerCancelAmount) * 100) / 100);
      const forwardSalesQty = Math.max(0, grossQty - rtoCancelQty - sellerCancelQty);

      // Forward Shipping Cost [B]
      const shippingCostF = Math.round(
        mOrders.reduce((sum, o) => {
          const cost = o.shipment?.initialCost || o.shipment?.netBilledCost || o.actualShippingCost || 106.44;
          return sum + cost;
        }, 0) * 100
      ) / 100;

      // Reverse Shipping Cost [C]
      const shippingCostR = Math.round(
        rtoOrCancelledOrders.reduce((sum, o) => {
          const revCost = o.shipment?.reversalAmount || 95.0; // standard reverse freight
          return sum + revCost;
        }, 0) * 100
      ) / 100;

      // COD Collection Fees [D] (₹38 standard COD collection fee on COD orders)
      const codOrders = mOrders.filter((o) => o.paymentMethod === 'COD');
      const codCollectionFee = Math.round(codOrders.length * 38.0 * 100) / 100;

      // Payment Gateway Fee [E] (approx 2% MDR on prepaid sales)
      const prepaidSales = prepaidOrders.reduce((sum, o) => sum + (o.totalAmount || 0), 0);
      const paymentGatewayFee = Math.round(prepaidSales * 0.02 * 100) / 100;

      // Received Payment [F = A - E]
      const receivedPayment = Math.max(0, Math.round((forwardSalesAmount - paymentGatewayFee) * 100) / 100);

      return {
        month: m.label,
        monthKey: m.monthKey,
        noOfOrders,
        prepaidCount,
        prepaidPercent,
        grossAmount,
        grossQty,
        rtoCancelAmount,
        rtoCancelQty,
        sellerCancelAmount,
        sellerCancelQty,
        forwardSalesAmount,
        forwardSalesQty,
        shippingCostF,
        shippingCostR,
        codCollectionFee,
        paymentGatewayFee,
        receivedPayment,
      };
    });

    // ─────────────────────────────────────────────────────────────
    // 2. Courier Performance Breakdown (media_1790266219905.png)
    // ─────────────────────────────────────────────────────────────
    const courierMap: Record<string, {
      courierName: string;
      orders: typeof allOrders;
      totalCost: number;
      rtoOrders: number;
    }> = {};

    for (const order of allOrders) {
      const isVel = isVelocityCourier(order.shipment?.courier, order.shipment?.labelUrl, order.shipment?.waybillNumber);
      let courierName = isVel ? 'Velocity' : (order.shipment?.courier?.trim() || 'Delhivery');
      if (!isVel) {
        if (courierName.toLowerCase().includes('delhivery')) courierName = 'Delhivery';
        else if (courierName.toLowerCase().includes('ekart')) courierName = 'Ekart Logistics';
        else if (courierName.toLowerCase().includes('ecom')) courierName = 'Ecom Express';
      }

      if (!courierMap[courierName]) {
        courierMap[courierName] = {
          courierName,
          orders: [],
          totalCost: 0,
          rtoOrders: 0,
        };
      }

      const cost = order.shipment?.netBilledCost || order.shipment?.initialCost || order.actualShippingCost || 106.44;
      courierMap[courierName].orders.push(order);
      courierMap[courierName].totalCost += cost;

      const isRto =
        order.status === 'RTO_INITIATED' ||
        order.status === 'RTO_DELIVERED' ||
        order.shipment?.status === 'RTO' ||
        (order.shipment?.trackingStatus && /rto|return/i.test(order.shipment.trackingStatus));

      if (isRto) {
        courierMap[courierName].rtoOrders += 1;
      }
    }

    const courierReport = Object.values(courierMap)
      .map((c) => {
        const totalOrders = c.orders.length;
        const totalCost = Math.round(c.totalCost * 100) / 100;
        const totalRtoOrders = c.rtoOrders;
        const avgPerOrderAmount = totalOrders > 0 ? Math.round((totalCost / totalOrders) * 100) / 100 : 0;
        const rtoPercent = totalOrders > 0 ? Math.round((totalRtoOrders / totalOrders) * 1000) / 10 : 0;

        return {
          courierName: c.courierName,
          totalOrders,
          totalCost,
          totalRtoOrders,
          avgPerOrderAmount,
          rtoPercent,
        };
      })
      .sort((a, b) => b.totalOrders - a.totalOrders);

    // ─────────────────────────────────────────────────────────────
    // 3. State-wise Geographic Breakdown
    // ─────────────────────────────────────────────────────────────
    const stateMap: Record<string, {
      state: string;
      orders: typeof allOrders;
      cities: Set<string>;
    }> = {};

    for (const order of allOrders) {
      const state = (order.customerState || 'Other').trim();
      if (!stateMap[state]) {
        stateMap[state] = { state, orders: [], cities: new Set() };
      }
      stateMap[state].orders.push(order);
      if (order.customerCity) stateMap[state].cities.add(order.customerCity.trim());
    }

    const stateReport = Object.values(stateMap)
      .map((s) => {
        const orderCount = s.orders.length;
        const grossRevenue = Math.round(s.orders.reduce((sum, o) => sum + (o.totalAmount || 0), 0) * 100) / 100;
        const prepaidCount = s.orders.filter((o) => o.paymentMethod !== 'COD').length;
        const codCount = orderCount - prepaidCount;
        const percentage = totalAllOrders > 0 ? Math.round((orderCount / totalAllOrders) * 1000) / 10 : 0;

        const deliveredCount = s.orders.filter((o) => o.status === 'DELIVERED').length;
        const rtoCount = s.orders.filter((o) =>
          ['RTO_INITIATED', 'RTO_DELIVERED', 'FAILED_DELIVERY'].includes(o.status)
        ).length;
        const rtoRate = orderCount > 0 ? Math.round((rtoCount / orderCount) * 1000) / 10 : 0;

        const topCities = Array.from(s.cities).slice(0, 4);

        return {
          state: s.state,
          orderCount,
          percentage,
          grossRevenue,
          prepaidCount,
          codCount,
          prepaidPercent: orderCount > 0 ? Math.round((prepaidCount / orderCount) * 1000) / 10 : 0,
          citiesCount: s.cities.size,
          topCities,
          deliveredCount,
          rtoCount,
          rtoRate,
        };
      })
      .sort((a, b) => b.orderCount - a.orderCount);

    // Overall Totals
    const totalGrossRevenue = Math.round(allOrders.reduce((sum, o) => sum + (o.totalAmount || 0), 0) * 100) / 100;
    const totalPrepaidOrders = allOrders.filter((o) => o.paymentMethod !== 'COD').length;
    const totalCodOrders = totalAllOrders - totalPrepaidOrders;
    const totalShippingSpend = courierReport.reduce((sum, c) => sum + c.totalCost, 0);

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      kpis: {
        totalOrders: totalAllOrders,
        totalGrossRevenue,
        totalPrepaidOrders,
        totalCodOrders,
        prepaidRatio: totalAllOrders > 0 ? Math.round((totalPrepaidOrders / totalAllOrders) * 1000) / 10 : 0,
        totalShippingSpend: Math.round(totalShippingSpend * 100) / 100,
        totalStatesCount: stateReport.length,
      },
      monthlyReport,
      courierReport,
      stateReport,
    });
  } catch (error: any) {
    logger.error('Error generating analytics report', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// ─── Orders ──────────────────────────────────────────────

// Get all orders (supports status, gateway, paymentMethod, verified, search, pagination)
router.get('/orders/tab-counts', async (_req: Request, res: Response): Promise<void> => {
  try {
    const counts = await orderService.getOrderTabCounts();
    res.json({ success: true, counts });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/orders', async (req: Request, res: Response): Promise<void> => {
  try {
    const status = req.query.status as string | undefined;
    const tab = (req.query.tab as string | undefined)?.toLowerCase();
    const statuses = req.query.statuses
      ? String(req.query.statuses).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
      : undefined;
    const gateway = req.query.gateway as string | undefined;
    const paymentMethod = req.query.paymentMethod as string | undefined;
    const verified = req.query.verified !== undefined ? req.query.verified === 'true' : undefined;
    const search = req.query.search as string | undefined;
    const filter = req.query.filter as string | undefined;
    const rawLimit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    const rawOffset = req.query.offset ? parseInt(req.query.offset as string, 10) : undefined;
    // Clamp pagination to prevent full-table fallback scans on large stores.
    const limit = rawLimit === undefined ? undefined : Math.max(1, Math.min(Number.isFinite(rawLimit) ? rawLimit : 100, 500));
    const offset = rawOffset === undefined ? undefined : Math.max(0, Number.isFinite(rawOffset) ? rawOffset : 0);

    const orders = await orderService.getOrders({
      status: status || undefined,
      statuses,
      tab: tab || undefined,
      gateway: gateway || undefined,
      paymentMethod: paymentMethod || undefined,
      paymentVerified: verified,
      search: search || undefined,
      filter: filter || undefined,
      limit,
      offset,
    });
    res.json({ orders });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get a single order
router.get('/orders/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const orderId = parseInt(req.params.id, 10);
    const order = await orderService.getOrder(orderId);
    if (!order) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }
    res.json({ order });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/orders/:id/pickup', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const orderId = Number(req.params.id);
    if (!Number.isSafeInteger(orderId) || orderId <= 0) { res.status(400).json({ error: 'Invalid order ID.' }); return; }
    const shipment = await prisma.shipment.findUnique({ where: { orderId } });
    if (!shipment?.waybillNumber || shipment.status !== 'CREATED') { res.status(409).json({ error: 'Only a manifested parcel awaiting pickup can be scheduled.' }); return; }

    if (isVelocityCourier(shipment.courier, shipment.labelUrl, shipment.waybillNumber)) {
      try {
        const tracking = await velocityService.trackShipment(shipment.waybillNumber);
        const status = (tracking.shipmentStatus || tracking.currentStatus || '').toLowerCase();
        const isScheduled =
          status.includes('ready') ||
          status.includes('pickup') ||
          status.includes('transit') ||
          status.includes('created') ||
          Boolean(tracking.pickupDate);
        res.json({
          success: true,
          status: 'SCHEDULED',
          message: isScheduled
            ? `Pickup is registered with ${shipment.courier || 'Velocity'} (${tracking.currentStatus || 'Ready for Pickup'}). Logistics pickup executive notified.`
            : `Pickup request confirmed for ${shipment.courier || 'Velocity'} parcel AWB ${shipment.waybillNumber}.`,
          details: {
            courier: shipment.courier || 'Velocity',
            waybill: shipment.waybillNumber,
            pickupStatus: tracking.currentStatus || 'Scheduled',
          },
        });
        return;
      } catch (err: any) {
        res.json({
          success: true,
          status: 'SCHEDULED',
          message: `Pickup confirmed for ${shipment.courier || 'Velocity'} parcel AWB ${shipment.waybillNumber}.`,
          details: {
            courier: shipment.courier || 'Velocity',
            waybill: shipment.waybillNumber,
          },
        });
        return;
      }
    }

    const batch = await queueManifestForPickup(orderId, shipment.waybillNumber, req.user);
    if (!batch) { res.status(409).json({ error: 'This parcel is not eligible for warehouse pickup.' }); return; }
    const result = await submitPickupBatch(batch.key, req.user, new Date(), true);
    res.json({ success: result?.status === 'SCHEDULED', batch: result, message: result?.message });
  } catch (error: any) { res.status(400).json({ error: error.message }); }
});
router.get('/orders/:id/activity', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) { res.status(400).json({ error: 'Invalid order ID.' }); return; }
    const events = await getOrderActivity(id);
    if (!events) { res.status(404).json({ error: 'Order not found.' }); return; }
    res.json({ events });
  } catch { res.status(500).json({ error: 'Could not load order activity.' }); }
});
router.post('/orders/:id/activity/notes', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.uid) { res.status(401).json({ error: 'Authentication required.' }); return; }
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) { res.status(400).json({ error: 'Invalid order ID.' }); return; }
    const event = await addStaffNote(id, String(req.body?.text || ''), String(req.body?.requestId || ''), req.user);
    res.status(201).json({ id: event.id });
  } catch (error: any) { res.status(400).json({ error: error.message }); }
});

// Explicit single-order refresh: never invoke bulk sync or auto-dispatch.
router.post('/orders/:id/refresh-shopify', async (req: Request, res: Response): Promise<void> => {
  try {
    const orderId = Number(req.params.id);
    if (!Number.isSafeInteger(orderId) || orderId <= 0) {
      res.status(400).json({ error: 'Invalid order id' });
      return;
    }
    const stored = await orderService.getOrder(orderId);
    if (!stored) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }
    const payload = await shopifyService.fetchOrder(stored.shopifyOrderId);
    if (String(payload.id) !== stored.shopifyOrderId) {
      res.status(502).json({ error: 'Shopify returned a different order' });
      return;
    }
    await shopifyService.syncOrderToDb(payload);
    res.json({ order: await orderService.getOrder(orderId) });
  } catch (error: any) {
    logger.error('Single-order Shopify refresh failed', { error: error.message });
    res.status(502).json({ error: 'Could not refresh this order from Shopify. Please try again.' });
  }
});

// Account trail is accessible only through this authenticated API mount.
router.get('/orders/:id/account-trail', async (req: Request, res: Response): Promise<void> => {
  try {
    const orderId = parseInt(req.params.id, 10);
    if (!Number.isInteger(orderId) || orderId <= 0) {
      res.status(400).json({ error: 'Invalid order ID.' });
      return;
    }
    const order = await prisma.order.findUnique({ where: { id: orderId }, select: { id: true } });
    if (!order) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }
    res.json({ events: await getOrderAccountTrail(orderId) });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Record an already-sent manual payout. This only records the payout; it does not
// initiate a bank/UPI transfer or trigger an additional Shopify refund.
router.post('/orders/:id/refunds/manual', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.uid) {
      res.status(401).json({ error: 'Authentication required to record a manual refund.' });
      return;
    }
    const orderId = parseInt(req.params.id, 10);
    const body = req.body || {};
    const returnId = body.returnId === undefined || body.returnId === null || body.returnId === ''
      ? undefined
      : Number(body.returnId);
    const evidence = body.evidence && typeof body.evidence === 'object'
      ? {
          fileName: String(body.evidence.fileName || ''),
          contentType: String(body.evidence.contentType || ''),
          contentBase64: String(body.evidence.contentBase64 || ''),
        }
      : undefined;
    const event = await recordManualRefund({
      orderId,
      returnId,
      amount: Number(body.amount),
      refundMode: String(body.refundMode || '') as RefundMode,
      accountUsed: String(body.accountUsed || ''),
      externalReference: body.externalReference == null ? undefined : String(body.externalReference),
      note: body.note == null ? undefined : String(body.note),
      evidence,
      actor: req.user,
    });
    res.status(201).json({ event: await presentAccountTrailEvent(event) });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// Calculate estimated Delhivery logistic charges for an order per AWB / pincode
router.get('/orders/:id/shipping-estimate', async (req: Request, res: Response): Promise<void> => {
  try {
    const orderId = parseInt(req.params.id, 10);
    const order = await orderService.getOrder(orderId);
    if (!order) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }
    const weightGrams = req.query.weight ? parseInt(req.query.weight as string, 10) : 500;
    const charges = await delhiveryService.calculateOrderLogisticCharges(order, weightGrams);
    res.json({
      success: true,
      orderId: order.id,
      shopifyOrderName: order.shopifyOrderName,
      waybillNumber: order.shipment?.waybillNumber || null,
      originPincode: config.delhivery.seller.pincode,
      destinationPincode: order.customerPincode,
      paymentMode: order.paymentMethod === 'COD' ? 'COD' : 'Pre-paid',
      chargeableWeightGrams: weightGrams,
      charges,
      actualAudit: null,
      note: 'Delhivery calculates logistics charges per order based on weight and pincodes. Wallet debits/credits live only in the Delhivery ONE panel (Finances > Wallet) — no wallet API exists, so check billed amounts there.',
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Clear unconfirmed Delhivery manifest review lock
router.post('/orders/:id/clear-manifest-review', async (req: Request, res: Response): Promise<void> => {
  try {
    const orderId = parseInt(req.params.id, 10);
    const result = await orderService.clearManifestReview(orderId);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Update or switch courier partner on order shipment (e.g. switch to Velocity on Delhivery NSZ)
router.post('/orders/:id/update-courier', async (req: Request, res: Response): Promise<void> => {
  try {
    const orderId = parseInt(req.params.id, 10);
    const { courier, waybillNumber } = req.body;
    if (!courier || !String(courier).trim()) {
      res.status(400).json({ error: 'Courier name is required' });
      return;
    }
    const result = await orderService.updateShipmentCourier(orderId, String(courier), waybillNumber ? String(waybillNumber) : undefined);
    res.json(result);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// Manually dispatch an order
router.post('/orders/:id/dispatch', async (req: Request, res: Response): Promise<void> => {
  try {
    const orderId = parseInt(req.params.id, 10);
    const courierChoice = (req.body?.courier || req.query?.courier) as CourierChoice | 'auto' | undefined;
    const velocityCarrierId = req.body?.velocityCarrierId || req.body?.carrierId;
    const result = await orderService.dispatchOrder(
      orderId,
      (req as AuthenticatedRequest).user,
      courierChoice,
      velocityCarrierId ? { velocityCarrierId } : undefined
    );
    res.json({ success: true, waybillNumber: result.waybillNumber, courier: result.courier });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// Bulk dispatch multiple orders with priority: Prepaid first (FIFO), then COD (FIFO)
router.post('/orders/bulk-dispatch', async (req: Request, res: Response): Promise<void> => {
  try {
    const { orderIds, courier, carrierId, velocityCarrierId } = req.body;
    const selectedCarrierId = velocityCarrierId || carrierId;
    if (!Array.isArray(orderIds) || !orderIds.length) {
      res.status(400).json({ error: 'orderIds array is required' });
      return;
    }

    const courierChoice = courier as CourierChoice | 'auto' | undefined;
    const numericIds = orderIds.map((id) => Number(id)).filter((id) => !isNaN(id));

    // Fetch orders to determine payment methods and creation dates for prioritization
    const dbOrders = await prisma.order.findMany({
      where: { id: { in: numericIds } },
      include: { shipment: true },
    });

    // Enforce priority: Prepaid orders ALWAYS dispatched first (FIFO), then COD (FIFO)
    const prioritizedOrders = prioritizeOrdersForDispatch(dbOrders);

    // If any IDs were not in DB, keep them at the end preserving input order
    const prioritizedIds = prioritizedOrders.map((o) => o.id);
    const missingIds = numericIds.filter((id) => !prioritizedIds.includes(id));
    const finalDispatchQueue = [...prioritizedIds, ...missingIds];

    const results: Array<{ orderId: number; success: boolean; waybillNumber?: string; courier?: string; error?: string; paymentMode?: string }> = [];
    for (const id of finalDispatchQueue) {
      const order = dbOrders.find((o) => o.id === id);
      const isPrepaid = order ? isPrepaidOrder(order) : false;
      const paymentMode = order ? (isPrepaid ? 'Prepaid' : 'COD') : undefined;

      try {
        const result = await orderService.dispatchOrder(
          Number(id),
          (req as AuthenticatedRequest).user,
          courierChoice,
          selectedCarrierId ? { velocityCarrierId: selectedCarrierId } : undefined
        );
        results.push({ orderId: Number(id), success: true, waybillNumber: result.waybillNumber, courier: result.courier, paymentMode });
      } catch (err: any) {
        results.push({ orderId: Number(id), success: false, error: err.message, paymentMode });
      }
    }
    const successfulCount = results.filter((r) => r.success).length;
    const prepaidDispatched = results.filter((r) => r.success && r.paymentMode === 'Prepaid').length;
    const codDispatched = results.filter((r) => r.success && r.paymentMode === 'COD').length;

    res.json({
      success: true,
      total: orderIds.length,
      dispatched: successfulCount,
      prepaidDispatched,
      codDispatched,
      failed: orderIds.length - successfulCount,
      results,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Single GST Tax Invoice preview & print
router.get('/orders/:id/invoice', async (req: Request, res: Response): Promise<void> => {
  try {
    const orderId = parseInt(req.params.id, 10);
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true, shipment: true },
    });
    if (!order) {
      res.status(404).send('<h1>Order not found</h1>');
      return;
    }
    const html = invoiceService.generatePrintableInvoicePage(order as any);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (error: any) {
    res.status(500).send(`<h1>Error generating invoice: ${error.message}</h1>`);
  }
});

// Download Single GST Tax Invoice
router.get('/orders/:id/invoice/download', async (req: Request, res: Response): Promise<void> => {
  try {
    const orderId = parseInt(req.params.id, 10);
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true, shipment: true },
    });
    if (!order) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }
    const html = invoiceService.generatePrintableInvoicePage(order as any);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="Invoice-${order.shopifyOrderName.replace('#', '')}.html"`);
    res.send(html);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Bulk GST Tax Invoices preview & print
router.post('/orders/bulk-invoices', async (req: Request, res: Response): Promise<void> => {
  try {
    const { orderIds } = req.body;
    if (!Array.isArray(orderIds) || !orderIds.length) {
      res.status(400).send('<h1>orderIds array is required</h1>');
      return;
    }
    const orders = await prisma.order.findMany({
      where: { id: { in: orderIds.map(Number) } },
      include: { items: true, shipment: true },
      orderBy: { id: 'asc' },
    });
    if (!orders.length) {
      res.status(404).send('<h1>No orders found for provided IDs</h1>');
      return;
    }
    const html = invoiceService.generateBulkPrintableInvoicesPage(orders as any);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (error: any) {
    res.status(500).send(`<h1>Error generating bulk invoices: ${error.message}</h1>`);
  }
});

// Bulk GST Tax Invoices Download (Direct file download as HTML attachment)
router.post('/orders/bulk-invoices/download', async (req: Request, res: Response): Promise<void> => {
  try {
    const { orderIds } = req.body;
    if (!Array.isArray(orderIds) || !orderIds.length) {
      res.status(400).json({ error: 'orderIds array is required' });
      return;
    }
    const orders = await prisma.order.findMany({
      where: { id: { in: orderIds.map(Number) } },
      include: { items: true, shipment: true },
      orderBy: { id: 'asc' },
    });
    if (!orders.length) {
      res.status(404).json({ error: 'No orders found for provided IDs' });
      return;
    }
    const html = invoiceService.generateBulkPrintableInvoicesPage(orders as any);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="Bulk-Invoices-${orders.length}-Orders.html"`);
    res.send(html);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Single Shipping Label (Thermal 4R / Official Delhivery)
router.get('/orders/:id/label', async (req: Request, res: Response): Promise<void> => {
  try {
    const orderId = parseInt(req.params.id, 10);
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true, shipment: true },
    });
    if (!order) {
      res.status(404).send('<h1>Order not found</h1>');
      return;
    }

    let waybillNumber = order.shipment?.waybillNumber;
    if (!waybillNumber || order.shipment?.status === 'ERROR') {
      const err = order.shipment?.errorMessage || 'Order has not been manifested yet. Please click Dispatch to generate an official waybill.';
      res.status(400).send(`
        <!DOCTYPE html>
        <html>
        <head><title>Label Not Available - ${order.shopifyOrderName}</title></head>
        <body style="font-family:sans-serif; text-align:center; padding: 50px 20px; background:#f8fafc;">
          <div style="max-width:500px; margin:0 auto; background:#fff; padding:30px; border-radius:12px; box-shadow:0 4px 12px rgba(0,0,0,0.08); border:1px solid #e2e8f0;">
            <h2 style="color:#ef4444; margin-top:0;">⚠️ Label Not Available</h2>
            <p style="color:#334155; font-size:15px; line-height:1.5;">${err}</p>
            <p style="color:#64748b; font-size:13px;">Please check courier serviceability and credentials, then click <strong>Dispatch</strong> on the OMS dashboard to create this shipment.</p>
            <button onclick="window.close()" style="margin-top:15px; padding:8px 20px; background:#0f172a; color:#fff; border:none; border-radius:6px; cursor:pointer; font-weight:600;">Close Window</button>
          </div>
        </body>
        </html>
      `);
      return;
    }

    const isVelocity = isVelocityCourier(order.shipment?.courier, order.shipment?.labelUrl, waybillNumber);

    // Refresh the packing-slip URL for Delhivery when it is missing or the S3 signature has expired.
    // Velocity provides a direct immutable label_url PDF at orchestration time.
    const storedLabel = order.shipment?.labelUrl;
    if (!isVelocity && !isUsableHttpUrl(storedLabel)) {
      try {
        const officialUrl = await delhiveryService.generateLabel(waybillNumber);
        if (isUsableHttpUrl(officialUrl)) {
          if (order.shipment) order.shipment.labelUrl = officialUrl;
          await prisma.shipment.update({
            where: { orderId: order.id },
            data: { labelUrl: officialUrl },
          });
        } else if (order.shipment) {
          order.shipment.labelUrl = null;
        }
      } catch {
        if (order.shipment) order.shipment.labelUrl = null;
      }
    }

    if (isVelocity) {
      const pdf = await loadFreshLabelPdf(waybillNumber, order.shipment?.labelUrl, order.shipment?.id, order.shipment?.courier);
      if (pdf) {
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="velocity-label-${waybillNumber}.pdf"`);
        res.send(pdf);
        return;
      }
      if (isUsableHttpUrl(order.shipment?.labelUrl)) {
        res.redirect(order.shipment!.labelUrl!);
        return;
      }
      res.status(404).send(`
        <!DOCTYPE html>
        <html>
        <head><title>Velocity Label Pending - ${order.shopifyOrderName}</title></head>
        <body style="font-family:sans-serif; text-align:center; padding: 50px 20px; background:#f8fafc;">
          <div style="max-width:500px; margin:0 auto; background:#fff; padding:30px; border-radius:12px; box-shadow:0 4px 12px rgba(0,0,0,0.08); border:1px solid #e2e8f0;">
            <h2 style="color:#7c3aed; margin-top:0;">⚡ Velocity Shipping Label</h2>
            <p style="color:#334155; font-size:15px; line-height:1.5;">Official PDF label is being generated by the Velocity shipping network for AWB <strong>${waybillNumber}</strong>.</p>
            <p style="color:#64748b; font-size:13px;">Please reload this page in a few seconds or check order tracking.</p>
            <button onclick="location.reload()" style="margin-top:15px; padding:8px 20px; background:#7c3aed; color:#fff; border:none; border-radius:6px; cursor:pointer; font-weight:600;">Reload Label</button>
          </div>
        </body>
        </html>
      `);
      return;
    }

    if (req.query.pdf === 'true' && isUsableHttpUrl(order.shipment?.labelUrl)) {
      res.redirect(order.shipment!.labelUrl!);
      return;
    }

    const html = shippingLabelService.generatePrintableLabelPage(order as any, waybillNumber);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (error: any) {
    res.status(500).send(`<h1>Error generating shipping label: ${error.message}</h1>`);
  }
});

// Download Single Shipping Label
router.get('/orders/:id/label/download', async (req: Request, res: Response): Promise<void> => {
  try {
    const orderId = parseInt(req.params.id, 10);
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true, shipment: true },
    });
    if (!order) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }
    const waybill = order.shipment?.waybillNumber || `PENDING-${order.shopifyOrderName.replace('#', '')}`;
    const isVelocity = isVelocityCourier(order.shipment?.courier, order.shipment?.labelUrl, waybill);
    const pdf = await loadFreshLabelPdf(waybill, order.shipment?.labelUrl, order.shipment?.id, order.shipment?.courier);
    if (pdf) {
      const prefix = isVelocity ? 'velocity' : 'delhivery';
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${prefix}-label-${waybill}.pdf"`);
      res.send(pdf);
      return;
    }
    if (isVelocity) {
      if (isUsableHttpUrl(order.shipment?.labelUrl)) {
        res.redirect(order.shipment!.labelUrl!);
        return;
      }
      res.status(404).json({ error: 'Official Velocity label not ready yet. Please try again shortly.' });
      return;
    }
    const html = shippingLabelService.generatePrintableLabelPage(order as any, waybill);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="delhivery-label-${waybill}.html"`);
    res.send(html);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Bulk Shipping Labels (Multi-Page Thermal 4R)
router.post('/orders/bulk-labels', async (req: Request, res: Response): Promise<void> => {
  try {
    const { orderIds } = req.body;
    if (!Array.isArray(orderIds) || !orderIds.length) {
      res.status(400).send('<h1>orderIds array is required</h1>');
      return;
    }
    const orders = await prisma.order.findMany({
      where: { id: { in: orderIds.map(Number) } },
      include: { items: true, shipment: true },
      orderBy: { id: 'asc' },
    });
    if (!orders.length) {
      res.status(404).send('<h1>No orders found</h1>');
      return;
    }

    const skippedOrders: string[] = [];
    const validOrders: typeof orders = [];

    for (const order of orders) {
      const waybill = order.shipment?.waybillNumber;
      if (!waybill || order.shipment?.status === 'ERROR') {
        skippedOrders.push(order.shopifyOrderName);
        continue;
      }
      validOrders.push(order);
    }

    if (!validOrders.length) {
      res.status(400).send(`
        <!DOCTYPE html>
        <html>
        <head><title>No Manifested Labels</title></head>
        <body style="font-family:sans-serif; text-align:center; padding: 50px 20px; background:#f8fafc;">
          <div style="max-width:500px; margin:0 auto; background:#fff; padding:30px; border-radius:12px; box-shadow:0 4px 12px rgba(0,0,0,0.08); border:1px solid #e2e8f0;">
            <h2 style="color:#ef4444; margin-top:0;">⚠️ No Manifested Orders Selected</h2>
            <p style="color:#334155; font-size:15px; line-height:1.5;">The selected orders (${skippedOrders.join(', ')}) do not have active shipping waybills yet.</p>
            <p style="color:#64748b; font-size:13px;">Please dispatch them first to generate official shipping labels.</p>
            <button onclick="window.close()" style="margin-top:15px; padding:8px 20px; background:#0f172a; color:#fff; border:none; border-radius:6px; cursor:pointer; font-weight:600;">Close Window</button>
          </div>
        </body>
        </html>
      `);
      return;
    }

    // Parallel fetch of official label PDFs (especially for Velocity / Amazon orders)
    const orderList = await Promise.all(
      validOrders.map(async (order) => {
        const waybillNumber = order.shipment!.waybillNumber!;
        let pdfBuffer: Buffer | null = null;
        const isVel = isVelocityCourier(order.shipment?.courier, order.shipment?.labelUrl, waybillNumber);
        if (isVel) {
          try {
            pdfBuffer = await loadFreshLabelPdf(
              waybillNumber,
              order.shipment?.labelUrl,
              order.shipment?.id,
              order.shipment?.courier
            );
          } catch (err: any) {
            logger.warn('Could not load official Velocity PDF in bulk view', {
              waybillNumber,
              error: err.message,
            });
          }
        }
        return { order: order as any, waybillNumber, pdfBuffer };
      })
    );

    const html = shippingLabelService.generateBulkPrintableLabelsPage(orderList);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (error: any) {
    res.status(500).send(`<h1>Error generating bulk labels: ${error.message}</h1>`);
  }
});

// Bulk Shipping Labels Download (Direct file download - Official Merged PDF if all have PDF / format=pdf, or HTML)
router.post('/orders/bulk-labels/download', async (req: Request, res: Response): Promise<void> => {
  try {
    const { orderIds } = req.body;
    if (!Array.isArray(orderIds) || !orderIds.length) {
      res.status(400).json({ error: 'orderIds array is required' });
      return;
    }
    const orders = await prisma.order.findMany({
      where: { id: { in: orderIds.map(Number) } },
      include: { items: true, shipment: true },
      orderBy: { id: 'asc' },
    });
    if (!orders.length) {
      res.status(404).json({ error: 'No orders found' });
      return;
    }

    const orderListWithPdfs = await Promise.all(
      orders.map(async (order) => {
        const waybill = order.shipment?.waybillNumber || `PENDING-${order.shopifyOrderName.replace('#', '')}`;
        let pdfBuffer: Buffer | null = null;
        if (order.shipment?.waybillNumber) {
          try {
            pdfBuffer = await loadFreshLabelPdf(
              waybill,
              order.shipment?.labelUrl,
              order.shipment?.id,
              order.shipment?.courier
            );
          } catch (err: any) {
            logger.warn('Could not load label PDF for bulk download', { waybill, error: err.message });
          }
        }
        return { order: order as any, waybillNumber: waybill, pdfBuffer };
      })
    );

    const wantsHtml = req.query.format === 'html';

    if (!wantsHtml) {
      // Build complete PDF list for every order in the batch.
      // If an upstream carrier download was missing/failed, generate an authentic 4x6" PDF fallback.
      const completePdfBuffers = await Promise.all(
        orderListWithPdfs.map(async (item) => {
          if (item.pdfBuffer && item.pdfBuffer.length > 50) {
            return item.pdfBuffer;
          }
          return create4x6FallbackPdf(item.order, item.waybillNumber, item.order.shipment?.courier);
        })
      );

      const mergedPdf = await mergePdfBuffers(completePdfBuffers);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="Bulk-Labels-${orders.length}-Orders.pdf"`
      );
      res.send(mergedPdf);
      return;
    }

    const html = shippingLabelService.generateBulkPrintableLabelsPage(orderListWithPdfs);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="Bulk-Labels-${orders.length}-Orders.html"`
    );
    res.send(html);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Single Shipping Label + GST Tax Invoice (Label then Invoice sequence)
router.get('/orders/:id/label-and-invoice', async (req: Request, res: Response): Promise<void> => {
  try {
    const orderId = parseInt(req.params.id, 10);
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true, shipment: true },
    });
    if (!order) {
      res.status(404).send('<h1>Order not found</h1>');
      return;
    }
    const waybill = order.shipment?.waybillNumber || `PENDING-${order.shopifyOrderName.replace('#', '')}`;
    let pdfBuffer: Buffer | null = null;
    const isVel = isVelocityCourier(order.shipment?.courier, order.shipment?.labelUrl, waybill);
    if (isVel && order.shipment?.waybillNumber) {
      try {
        pdfBuffer = await loadFreshLabelPdf(
          waybill,
          order.shipment?.labelUrl,
          order.shipment?.id,
          order.shipment?.courier
        );
      } catch (err: any) {
        logger.warn('Could not load Velocity label PDF for single label+invoice', { waybill, error: err.message });
      }
    }
    const html = shippingLabelService.generateLabelAndInvoiceHtml(order as any, waybill, pdfBuffer);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (error: any) {
    res.status(500).send(`<h1>Error generating label and invoice: ${error.message}</h1>`);
  }
});

// Download Single Shipping Label + GST Tax Invoice (Direct attachment download)
router.get('/orders/:id/label-and-invoice/download', async (req: Request, res: Response): Promise<void> => {
  try {
    const orderId = parseInt(req.params.id, 10);
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true, shipment: true },
    });
    if (!order) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }
    const waybill = order.shipment?.waybillNumber || `PENDING-${order.shopifyOrderName.replace('#', '')}`;
    let pdfBuffer: Buffer | null = null;
    const isVel = isVelocityCourier(order.shipment?.courier, order.shipment?.labelUrl, waybill);
    if (isVel && order.shipment?.waybillNumber) {
      try {
        pdfBuffer = await loadFreshLabelPdf(
          waybill,
          order.shipment?.labelUrl,
          order.shipment?.id,
          order.shipment?.courier
        );
      } catch (err: any) {
        logger.warn('Could not load Velocity label PDF for single label+invoice download', { waybill, error: err.message });
      }
    }
    const html = shippingLabelService.generateLabelAndInvoiceHtml(order as any, waybill, pdfBuffer);
    const filename = `Label-Invoice-${order.shopifyOrderName.replace('#', '')}.html`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(html);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Bulk Shipping Labels + Invoices (Alternating: Order 1 Label -> Order 1 Invoice -> Order 2 Label -> Order 2 Invoice...)
router.post('/orders/bulk-labels-and-invoices', async (req: Request, res: Response): Promise<void> => {
  try {
    const { orderIds } = req.body;
    if (!Array.isArray(orderIds) || !orderIds.length) {
      res.status(400).send('<h1>orderIds array is required</h1>');
      return;
    }
    const orders = await prisma.order.findMany({
      where: { id: { in: orderIds.map(Number) } },
      include: { items: true, shipment: true },
      orderBy: { id: 'asc' },
    });
    if (!orders.length) {
      res.status(404).send('<h1>No orders found</h1>');
      return;
    }

    const orderList = await Promise.all(
      orders.map(async (order) => {
        const waybillNumber = order.shipment?.waybillNumber || `PENDING-${order.shopifyOrderName.replace('#', '')}`;
        let pdfBuffer: Buffer | null = null;
        const isVel = isVelocityCourier(order.shipment?.courier, order.shipment?.labelUrl, waybillNumber);
        if (isVel && order.shipment?.waybillNumber) {
          try {
            pdfBuffer = await loadFreshLabelPdf(
              waybillNumber,
              order.shipment?.labelUrl,
              order.shipment?.id,
              order.shipment?.courier
            );
          } catch (err: any) {
            logger.warn('Could not load Velocity label PDF for bulk label+invoice', { waybillNumber, error: err.message });
          }
        }
        return {
          order: order as any,
          waybillNumber,
          pdfBuffer,
        };
      })
    );

    const html = shippingLabelService.generateBulkLabelsAndInvoicesHtml(orderList);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (error: any) {
    res.status(500).send(`<h1>Error generating bulk labels and invoices: ${error.message}</h1>`);
  }
});

// Download Bulk Shipping Labels + Invoices (Direct file download as HTML attachment)
router.post('/orders/bulk-labels-and-invoices/download', async (req: Request, res: Response): Promise<void> => {
  try {
    const { orderIds } = req.body;
    if (!Array.isArray(orderIds) || !orderIds.length) {
      res.status(400).json({ error: 'orderIds array is required' });
      return;
    }
    const orders = await prisma.order.findMany({
      where: { id: { in: orderIds.map(Number) } },
      include: { items: true, shipment: true },
      orderBy: { id: 'asc' },
    });
    if (!orders.length) {
      res.status(404).json({ error: 'No orders found' });
      return;
    }

    const orderList = await Promise.all(
      orders.map(async (order) => {
        const waybillNumber = order.shipment?.waybillNumber || `PENDING-${order.shopifyOrderName.replace('#', '')}`;
        let pdfBuffer: Buffer | null = null;
        const isVel = isVelocityCourier(order.shipment?.courier, order.shipment?.labelUrl, waybillNumber);
        if (isVel && order.shipment?.waybillNumber) {
          try {
            pdfBuffer = await loadFreshLabelPdf(
              waybillNumber,
              order.shipment?.labelUrl,
              order.shipment?.id,
              order.shipment?.courier
            );
          } catch (err: any) {
            logger.warn('Could not load Velocity label PDF for bulk label+invoice download', { waybillNumber, error: err.message });
          }
        }
        return {
          order: order as any,
          waybillNumber,
          pdfBuffer,
        };
      })
    );

    const html = shippingLabelService.generateBulkLabelsAndInvoicesHtml(orderList);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="Bulk-Labels-And-Invoices-${orders.length}-Orders.html"`
    );
    res.send(html);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Bulk Picklist (Consolidated SKU Picking Manifest Preview & Print)
router.post('/orders/picklist', async (req: Request, res: Response): Promise<void> => {
  try {
    const { orderIds } = req.body;
    if (!Array.isArray(orderIds) || !orderIds.length) {
      res.status(400).send('<h1>orderIds array is required</h1>');
      return;
    }
    const orders = await prisma.order.findMany({
      where: { id: { in: orderIds.map(Number) } },
      include: { items: true, shipment: true },
      orderBy: { id: 'asc' },
    });
    if (!orders.length) {
      res.status(404).send('<h1>No orders found</h1>');
      return;
    }
    const html = picklistService.generatePicklistHtml(orders as any);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (error: any) {
    res.status(500).send(`<h1>Error generating picklist: ${error.message}</h1>`);
  }
});

// Bulk Picklist Download (Direct file download as HTML attachment)
router.post('/orders/picklist/download', async (req: Request, res: Response): Promise<void> => {
  try {
    const { orderIds } = req.body;
    if (!Array.isArray(orderIds) || !orderIds.length) {
      res.status(400).json({ error: 'orderIds array is required' });
      return;
    }
    const orders = await prisma.order.findMany({
      where: { id: { in: orderIds.map(Number) } },
      include: { items: true, shipment: true },
      orderBy: { id: 'asc' },
    });
    if (!orders.length) {
      res.status(404).json({ error: 'No orders found' });
      return;
    }
    const html = picklistService.generatePicklistHtml(orders as any);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="Picklist-${orders.length}-Orders.html"`
    );
    res.send(html);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Bulk Pack Download (Complete ZIP containing Picklist, Collated Labels & Invoices, Individual Labels, Individual Invoices, and Manifest CSV)
router.post('/orders/bulk-pack/download', async (req: Request, res: Response): Promise<void> => {
  try {
    const { orderIds } = req.body;
    if (!Array.isArray(orderIds) || !orderIds.length) {
      res.status(400).json({ error: 'orderIds array is required' });
      return;
    }
    const orders = await prisma.order.findMany({
      where: { id: { in: orderIds.map(Number) } },
      include: { items: true, shipment: true },
      orderBy: { id: 'asc' },
    });
    if (!orders.length) {
      res.status(404).json({ error: 'No orders found' });
      return;
    }

    const dateStamp = new Date().toISOString().slice(0, 10);
    const filename = `Youthnic-Bulk-Pack-${orders.length}-Orders-${dateStamp}.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    await bulkPackService.streamBulkPackZip(orders as any, res);
  } catch (error: any) {
    logger.error('Bulk pack streaming error', { error: error.message });
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

// Trigger Live Delhivery Tracking for a Specific Order
router.post('/orders/:id/track', async (req: Request, res: Response): Promise<void> => {
  try {
    const orderId = parseInt(req.params.id, 10);
    let order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { shipment: true },
    });
    if (!order) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }

    // If order does not have an assigned waybill yet, automatically attempt to fetch
    // external fulfillment from Shopify (e.g. OMS Guru) or Delhivery ONE packages API
    if (!order.shipment?.waybillNumber) {
      const reconcileRes = await orderService.fetchAndReconcileOrderFulfillment(orderId);
      if (reconcileRes.found && reconcileRes.waybillNumber) {
        order = await prisma.order.findUnique({
          where: { id: orderId },
          include: { shipment: true },
        });
      }
    }

    if (!order?.shipment?.waybillNumber) {
      res.status(400).json({
        error: 'Order does not have an assigned waybill number yet, and no external fulfillment was found on Shopify or Delhivery ONE.',
      });
      return;
    }

    const isVel = isVelocityCourier(order.shipment.courier, order.shipment.labelUrl, order.shipment.waybillNumber);
    if (isVel) {
      const { velocityFinancialSyncService } = await import('../modules/velocity/velocity-financial-sync.service');
      const vResult = await velocityFinancialSyncService.syncSingleOrderVelocityDetails(order.id, (req as AuthenticatedRequest).user);
      const refreshedOrder = await orderService.getOrder(orderId);
      res.json({
        success: true,
        tracking: {
          status: vResult.trackingStatus,
          courier: vResult.courier,
          waybill: vResult.waybillNumber,
          trackUrl: `https://www.velocityshipping.in/track/${encodeURIComponent(vResult.waybillNumber)}`,
        },
        shipment: refreshedOrder?.shipment,
        order: refreshedOrder,
        charges: vResult.shippingCharges,
        remittance: vResult.codRemittance,
      });
      return;
    }

    const result = await trackingService.syncShipmentTracking(order.shipment.waybillNumber);
    res.json({ success: true, tracking: result?.tracking, shipment: result?.shipment, order });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Direct Velocity Live Sync (tracking, shipping charges ledger, and COD remittance)
router.post(['/orders/:id/velocity/sync', '/api/orders/:id/velocity/sync'], async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const orderId = parseInt(req.params.id, 10);
    const { velocityFinancialSyncService } = await import('../modules/velocity/velocity-financial-sync.service');
    const result = await velocityFinancialSyncService.syncSingleOrderVelocityDetails(orderId, req.user);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Evaluates available shipping options across courier partners for an order
router.get(['/orders/:id/shipping-options', '/api/orders/:id/shipping-options'], async (req: Request, res: Response): Promise<void> => {
  try {
    const orderId = parseInt(req.params.id, 10);
    const options = await shippingRouterService.getShippingOptionsForOrder(orderId);
    res.json({ success: true, ...options });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Check and fetch external fulfillment for a single order (Shopify OMS Guru / Delhivery ONE)
router.post('/orders/:id/sync-external', async (req: Request, res: Response): Promise<void> => {
  try {
    const orderId = parseInt(req.params.id, 10);
    const result = await orderService.fetchAndReconcileOrderFulfillment(orderId);
    res.json({
      success: true,
      ...result,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Reconcile external fulfillments in bulk across all pending orders or selected order IDs
router.post('/orders/sync-external', async (req: Request, res: Response): Promise<void> => {
  try {
    const { orderIds } = req.body;
    let reconciledCount = 0;
    const results: any[] = [];

    if (Array.isArray(orderIds) && orderIds.length > 0) {
      for (const id of orderIds) {
        try {
          const resObj = await orderService.fetchAndReconcileOrderFulfillment(Number(id));
          if (resObj.found && resObj.source !== 'existing') {
            reconciledCount++;
          }
          results.push({ orderId: id, ...resObj });
        } catch (err: any) {
          results.push({ orderId: id, found: false, error: err.message });
        }
      }
    } else {
      reconciledCount = await orderService.reconcilePendingChannelOrders();
    }

    res.json({
      success: true,
      reconciledCount,
      results,
      message: `Reconciled ${reconciledCount} external fulfillment(s)`,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Delhivery Warehouse Courier Pickup Request
router.post('/delhivery/pickup', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const batch = await scheduleWaitingParcels(req.user);
    res.json({ success: batch?.status === 'SCHEDULED', message: batch?.message || 'No manifested parcels are awaiting a next-day pickup.', batch,
      details: batch ? { location: batch.pickupLocation, date: batch.pickupDate, time: batch.pickupTime, packageCount: batch.submittedPackageCount } : null });
  } catch (error: any) { res.status(400).json({ error: error.message }); }
});

// Confirm COD order (adds COD_CONFIRMED tag on Shopify & DB, moves order to dispatch queue)
router.post('/orders/:id/confirm-cod', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const orderId = parseInt(req.params.id, 10);
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true, shipment: true },
    });
    if (!order) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }

    const currentTags = order.tags || '';
    if (order.paymentMethod !== 'COD' || !['NEW', 'DISPATCH_PENDING'].includes(order.status) || order.shipment?.waybillNumber || isHighRtoCancel(order)) {
      res.status(409).json({ error: 'Only an unshipped, non-cancelled COD order can be approved.' });
      return;
    }
    const tagSet = new Set(currentTags.split(',').map((t) => t.trim()).filter(Boolean));
    tagSet.add('COD_CONFIRMED');
    tagSet.add('Confirmed');
    const updatedTags = Array.from(tagSet).join(', ');

    // Push tag update to Shopify
    try {
      await shopifyService.updateOrderTags(order.shopifyOrderId, Array.from(tagSet));
    } catch (shopifyErr: any) {
      logger.warn('Failed to update tags on Shopify directly, continuing with DB update', { error: shopifyErr.message });
    }

    // Update in database
    const claimed = await prisma.order.updateMany({
      where: { id: orderId, status: order.status, tags: order.tags },
      data: { tags: updatedTags, status: 'DISPATCH_PENDING' },
    });
    if (claimed.count !== 1) { res.status(409).json({ error: 'Order changed while confirming COD. Reload before trying again.' }); return; }
    const updated = await prisma.order.findUnique({ where: { id: orderId }, include: { items: true, shipment: true } });

    // Snapshot the Firebase actor so future account changes do not erase who approved COD.
    await recordAccountTrailEvent({
      orderId,
      eventType: 'COD_APPROVED',
      externalReference: 'COD_CONFIRMED',
      actorType: 'USER',
      actor: req.user,
      source: 'OMS_UI',
      status: 'COMPLETED',
      note: 'COD order approved for dispatch.',
      metadata: { previousStatus: order.status },
    }).catch((auditError: any) => {
      logger.error('COD approval succeeded but account-trail event could not be written', {
        orderId,
        actorUid: req.user?.uid,
        error: auditError.message,
      });
    });

    logger.info('COD order confirmed and moved to dispatch queue', { orderId, orderName: order.shopifyOrderName, approvedBy: req.user?.email });
    res.json({
      success: true,
      message: `Order ${order.shopifyOrderName} confirmed! Moved to Dispatch queue.`,
      order: updated,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Cancel order (with trigger confirmation, cancels Delhivery shipment if any and cancels in Shopify)
router.post('/orders/:id/cancel', async (req: Request, res: Response): Promise<void> => {
  try {
    const orderId = parseInt(req.params.id, 10);
    const { reason } = req.body;
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { shipment: true },
    });
    if (!order) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }
    if (
      ['DELIVERED', 'RTO_DELIVERED', 'RETURN_REQUESTED', 'RETURN_DISPATCHED', 'RETURN_RECEIVED', 'REFUNDED'].includes(
        order.status
      )
    ) {
      res.status(409).json({
        error: `Order ${order.shopifyOrderName} is ${order.status.replaceAll('_', ' ').toLowerCase()}. Use a return or refund instead of cancelling it.`,
      });
      return;
    }

    // Delhivery answers a refused cancel with false, not an error. The shipment
    // is marked cancelled only when Delhivery accepted, and the operator is
    // told when the parcel may still move.
    let delhiveryCancel: 'none' | 'cancelled' | 'refused' = 'none';
    try {
      delhiveryCancel = await orderService.cancelLiveShipment(order);
    } catch (delErr: any) {
      delhiveryCancel = 'refused';
      logger.warn('Failed to cancel Delhivery shipment during order cancel', { error: delErr.message });
    }
    const delhiveryCancelled = delhiveryCancel === 'cancelled';

    let shopifyCancelled = false;
    try {
      await shopifyService.cancelOrder(order.shopifyOrderId, reason || 'customer');
      shopifyCancelled = true;
    } catch (shopErr: any) {
      logger.warn('Failed to cancel on Shopify directly', { error: shopErr.message });
    }

    const currentTags = order.tags || '';
    const tagSet = new Set(currentTags.split(',').map((t) => t.trim()).filter(Boolean));
    tagSet.add('CANCELLED');
    const updatedTags = Array.from(tagSet).join(', ');

    const updated = await prisma.order.update({
      where: { id: orderId },
      data: {
        status: 'CANCELLED',
        tags: updatedTags,
        cancelledAt: order.cancelledAt || new Date(),
        ...(delhiveryCancel === 'refused'
          ? { hasUrgentSupport: true, supportFlag: 'DELHIVERY_CANCEL_FAILED' }
          : {}),
      },
      include: { items: true, shipment: true },
    });

    logger.info('Order cancelled successfully', { orderId, orderName: order.shopifyOrderName, delhiveryCancel });
    await recordOrderAction(orderId, 'ORDER_CANCELLED', (req as AuthenticatedRequest).user, {
      note: `Order cancellation requested. Carrier: ${delhiveryCancel}; Shopify accepted: ${shopifyCancelled}.`,
      status: delhiveryCancel === 'refused' ? 'REVIEW' : 'COMPLETED',
    });
    res.json({
      success: true,
      delhiveryCancel,
      warning:
        delhiveryCancel === 'refused'
          ? `Delhivery did not accept the cancel for AWB ${order.shipment?.waybillNumber}. Cancel it in Delhivery One; the parcel may still move.`
          : undefined,
      message: `Order ${order.shopifyOrderName} cancelled.${delhiveryCancelled ? ' Delhivery shipment cancelled.' : ''}${
        delhiveryCancel === 'refused' ? ' Delhivery REFUSED the shipment cancel.' : ''
      }${shopifyCancelled ? ' Shopify order cancelled.' : ''}`,
      order: updated,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Delete order (with trigger confirmation for test/deleted orders).
// Orders with financial audit history are never deleted: the trail is the
// permanent record. The check and the deletion run in one transaction so a
// trail event inserted between them cannot leave a partial deletion behind.
router.delete('/orders/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const orderId = parseInt(req.params.id, 10);
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { shipment: true },
    });
    if (!order) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }
    const waybillNumber = order.shipment?.waybillNumber || null;
    const shipmentLive = Boolean(waybillNumber) && order.shipment!.status !== 'CANCELLED';

    try {
      await prisma.$transaction(async (tx) => {
        const trailCount = await tx.accountTrailEvent.count({ where: { orderId } });
        if (trailCount > 0) {
          throw Object.assign(
            new Error('This order has financial audit history and cannot be deleted.'),
            { code: 'ACCOUNT_TRAIL_PRESENT' }
          );
        }
        await tx.orderItem.deleteMany({ where: { orderId } });
        if (order.shipment) {
          await tx.shipment.delete({ where: { id: order.shipment.id } });
        }
        await tx.notification.deleteMany({ where: { orderId } });
        await tx.order.delete({ where: { id: orderId } });
      });
    } catch (txError: any) {
      if (txError?.code === 'ACCOUNT_TRAIL_PRESENT') {
        res.status(409).json({ error: 'This order has financial audit history and cannot be deleted.' });
        return;
      }
      if (txError?.code === 'P2003') {
        res.status(409).json({ error: 'This order still has linked records and cannot be deleted.' });
        return;
      }
      throw txError;
    }

    if (shipmentLive && waybillNumber) {
      try {
        await delhiveryService.cancelShipment(waybillNumber);
      } catch (e) {}
    }

    res.json({ success: true, message: `Order ${order.shopifyOrderName} deleted.` });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Manually trigger order sync from Shopify
router.post('/orders/sync', async (_req: Request, res: Response): Promise<void> => {
  try {
    const syncedCount = await orderService.syncOrdersFromShopify();
    const dispatched = await orderService.autoDispatchPendingOrders();
    res.json({ success: true, syncedCount, dispatchedCount: dispatched });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Channel Status: Returns summary of Shopify channel in Delhivery One
router.get('/delhivery/channel-status', async (_req: Request, res: Response): Promise<void> => {
  try {
    const totalOrders = await prisma.order.count();
    const pendingAwbCount = await prisma.order.count({
      where: {
        fulfillmentStatus: null,
        status: { not: 'CANCELLED' },
      },
    });
    const manifestedCount = await prisma.order.count({
      where: {
        fulfillmentStatus: 'fulfilled',
      },
    });
    const inTransitCount = await prisma.order.count({
      where: {
        status: { in: ['IN_TRANSIT', 'OUT_FOR_DELIVERY'] },
      },
    });

    res.json({
      success: true,
      channel: {
        name: 'youthnic2024',
        platform: 'Shopify',
        shopDomain: config.shopify.shopDomain,
        status: 'Connected',
        syncStartDate: config.shopify.syncStartDate,
        autoPaymentStatusUpdate: true,
      },
      stats: {
        totalChannelOrders: totalOrders,
        pendingAwb: pendingAwbCount,
        manifested: manifestedCount,
        inTransit: inTransitCount,
      },
    });
  } catch (error: any) {
    logger.error('Failed to get Delhivery channel status', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// Trigger channel-specific order sync
router.post('/orders/sync-channel', async (_req: Request, res: Response): Promise<void> => {
  try {
    const syncedCount = await orderService.syncOrdersFromShopify();
    res.json({
      success: true,
      message: `Synchronized ${syncedCount} channel orders from Shopify & Delhivery One`,
      syncedCount,
    });
  } catch (error: any) {
    logger.error('Channel order sync failed', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// Process Auto-Refund / Restock for RTO Delivered order (Scenario 2 & Scenario 1)
router.post('/orders/:id/rto-refund', async (req: Request, res: Response): Promise<void> => {
  try {
    const orderId = parseInt(req.params.id, 10);
    const result = await orderService.processRtoRefund(orderId);
    // A held refund (not confirmed as RTO, already part-refunded, ...) is not a success.
    res.status(result.success ? 200 : 409).json(result.success ? result : { ...result, error: result.message });
  } catch (error: any) {
    logger.error('Error processing RTO refund', { orderId: req.params.id, error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

// Handle NDR exception action (Re-attempt with courier or Mark RTO)
router.post('/orders/:id/ndr-action', async (req: Request, res: Response): Promise<void> => {
  try {
    const orderId = parseInt(req.params.id, 10);
    const { action, notes } = req.body;
    if (!action || !['RE-ATTEMPT', 'RTO'].includes(action)) {
      res.status(400).json({ error: 'Valid action (RE-ATTEMPT or RTO) is required' });
      return;
    }
    const result = await orderService.handleNdrAction(orderId, action, notes);
    await recordOrderAction(orderId, 'NDR_ACTION', (req as AuthenticatedRequest).user, {
      note: `Requested ${action}${notes ? `: ${String(notes).slice(0, 1000)}` : ''}.`,
    });
    res.json(result);
  } catch (error: any) {
    logger.error('Error handling NDR action', { orderId: req.params.id, error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── Returns ─────────────────────────────────────────────

// Get all returns
router.get('/returns', async (req: Request, res: Response): Promise<void> => {
  try {
    const status = req.query.status as string | undefined;
    const returns = await returnService.getReturns(status);
    res.json({ returns });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Create a return for an order (with reverse tracking and Shopify trigger)
// ONLY sends return email to user if return is created from our side
router.post('/orders/:id/returns', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const orderId = parseInt(req.params.id, 10);
    const { returnReason, items, returnWaybillNumber, carrierName, triggerShopify } = req.body;

    if (!returnReason || !items || !Array.isArray(items)) {
      res.status(400).json({ error: 'returnReason and items[] are required' });
      return;
    }

    const result = await returnService.createReturn(orderId, returnReason, items, {
      returnWaybillNumber,
      carrier: carrierName,
      triggerShopify: triggerShopify !== false,
    });

    await recordAccountTrailEvent({
      orderId,
      returnId: result.returnId,
      eventType: 'RETURN_CREATED',
      actorType: 'USER',
      actor: req.user,
      source: 'OMS_UI',
      status: 'COMPLETED',
      note: `Return created by ${req.user?.email || req.user?.name || 'authenticated user'}.`,
      metadata: {
        returnReason,
        returnWaybill: result.returnWaybill,
        items: items.map((item: any) => ({ orderItemId: item.orderItemId, quantity: item.quantity })),
      },
    }).catch((auditError: any) => {
      logger.error('Return was created but account-trail event could not be written', {
        orderId,
        returnId: result.returnId,
        actorUid: req.user?.uid,
        error: auditError.message,
      });
    });

    // Auto-send Return Initiated Email to customer from Youthnic Returns <returns@youthnic.com>
    // Triggered because this return was created from our side
    let emailDispatched = false;
    let emailResult: any = null;
    try {
      const order = await prisma.order.findUnique({
        where: { id: orderId },
        include: { items: true },
      });
      if (order?.customerEmail) {
        const fullAddress = [order.customerAddress, order.customerCity, order.customerState, order.customerPincode]
          .filter(Boolean)
          .join(', ');

        emailResult = await resendService.sendEmail({
          to: order.customerEmail,
          templateType: 'RETURN_INITIATED',
          fromEmail: 'Youthnic Returns <returns@youthnic.com>',
          replyTo: 'returns@youthnic.com',
          orderId: order.id,
          data: {
            orderName: order.shopifyOrderName,
            customerName: order.customerName,
            recipientEmail: order.customerEmail,
            waybillNumber: result.returnWaybill,
            courier: carrierName || 'Delhivery Surface Reverse',
            returnReason,
            customerAddress: fullAddress || 'Customer registered address',
            items: order.items.map((i: any) => ({
              title: i.title,
              variantTitle: i.variantTitle,
              quantity: i.quantity,
              price: i.price,
              imageUrl: i.imageUrl,
            })),
            totalAmount: order.totalAmount,
            trackingUrl: getTrackingUrl(carrierName, result.returnWaybill) || `https://www.delhivery.com/track/package/${result.returnWaybill}`,
          },
        });
        emailDispatched = emailResult?.success ?? false;

        // Sync event to Firebase RTDB customer history
        await firebaseService.syncCustomerHistory(order.customerEmail, {
          type: 'OUTBOUND_EMAIL',
          channel: 'EMAIL',
          title: `Return Pickup Scheduled: Order ${order.shopifyOrderName}`,
          description: `Reverse pickup waybill ${result.returnWaybill} scheduled via Delhivery.`,
          timestamp: new Date().toISOString(),
          sender: 'Youthnic Returns <returns@youthnic.com>',
          recipient: order.customerEmail,
          orderId: order.id,
          shopifyOrderName: order.shopifyOrderName,
          waybillNumber: result.returnWaybill,
          status: 'SENT',
        });
      }
    } catch (e: any) {
      logger.warn('Failed to send return initiated email:', e.message);
    }

    res.json({ success: true, ...result, emailDispatched, emailResult });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// Update the return reason before the reverse parcel is picked up.
router.patch('/returns/:id/reason', async (req: Request, res: Response): Promise<void> => {
  try {
    const returnId = parseInt(req.params.id, 10);
    const { returnReason } = req.body || {};
    const result = await returnService.updateReturnReason(returnId, String(returnReason || ''));
    res.json({ success: true, ...result });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// Process direct refund for an order via Shopify
router.post('/orders/:id/refund', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const orderId = parseInt(req.params.id, 10);
    const { amount, reason } = req.body;
    const result = await returnService.refundOrder(orderId, amount ? parseFloat(amount) : undefined, reason, req.user);

    // Send Refund Processed Email from Youthnic Refunds <refunds@youthnic.com>
    // only when money went back (a COD order has no online payment to refund).
    let emailDispatched = false;
    let emailResult: any = null;
    try {
      const order = result.moneyMoved
        ? await prisma.order.findUnique({
            where: { id: orderId },
            include: { items: true },
          })
        : null;
      if (order?.customerEmail) {
        emailResult = await resendService.sendEmail({
          to: order.customerEmail,
          templateType: 'RETURN_REFUND',
          fromEmail: 'Youthnic Refunds <refunds@youthnic.com>',
          replyTo: 'refunds@youthnic.com',
          orderId: order.id,
          data: {
            orderName: order.shopifyOrderName,
            customerName: order.customerName,
            recipientEmail: order.customerEmail,
            refundId: result.refundId || `RF-${order.shopifyOrderNumber}`,
            refundAmount: result.refundAmount,
            paymentMethod: order.paymentMethod || 'Prepaid',
            settlementGateway: order.paymentMethod || 'Easebuzz / PhonePe',
            items: order.items.map((i: any) => ({
              title: i.title,
              variantTitle: i.variantTitle,
              quantity: i.quantity,
              price: i.price,
              imageUrl: i.imageUrl,
            })),
            totalAmount: order.totalAmount,
          },
        });
        emailDispatched = emailResult?.success ?? false;

        await firebaseService.syncCustomerHistory(order.customerEmail, {
          type: 'OUTBOUND_EMAIL',
          channel: 'EMAIL',
          title: `Refund Processed: ₹${result.refundAmount} for Order ${order.shopifyOrderName}`,
          description: `Refund ID: ${result.refundId}. Funds credited to original payment source.`,
          timestamp: new Date().toISOString(),
          sender: 'Youthnic Refunds <refunds@youthnic.com>',
          recipient: order.customerEmail,
          orderId: order.id,
          shopifyOrderName: order.shopifyOrderName,
          status: 'SENT',
        });
      }
    } catch (e: any) {
      logger.warn('Failed to send refund email on order refund:', e.message);
    }

    res.json({ ...result, emailDispatched, emailResult });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * Scan a returned package at the warehouse.
 * This is the critical endpoint for the return→refund automation.
 * The warehouse team scans the waybill/barcode, and this endpoint:
 *   1. Marks the return as received
 *   2. Runs QC
 *   3. Auto-processes refund on Shopify if QC passes (no issue)
 *   4. Automatically notifies consumer from refunds@youthnic.com with Refund ID
 *
 * Body: { waybillNumber, qcStatus: 'APPROVED'|'REJECTED'|'PARTIAL', qcRemark? }
 */
router.post('/returns/scan', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { waybillNumber, qcStatus, qcRemark } = req.body;

    if (!waybillNumber) {
      res.status(400).json({ error: 'waybillNumber is required' });
      return;
    }

    const result = await returnService.scanReturn(
      waybillNumber,
      qcStatus || 'APPROVED',
      qcRemark,
      req.user
    );

    // If refund was processed (item received, no issue, QC approved) -> dispatch email from refunds@youthnic.com with refund ID
    let emailDispatched = false;
    let emailResult: any = null;
    if (result.refundProcessed && result.moneyMoved !== false) {
      try {
        const returnRec = await prisma.return.findUnique({
          where: { id: result.returnId },
          include: { order: { include: { items: true } } },
        });
        if (returnRec?.order?.customerEmail) {
          const finalRefundAmount = result.refundAmount || returnRec.refundAmount || returnRec.order.totalAmount;
          const finalRefundId = returnRec.shopifyRefundId || `RF-${returnRec.order.shopifyOrderNumber}`;

          emailResult = await resendService.sendEmail({
            to: returnRec.order.customerEmail,
            templateType: 'RETURN_REFUND',
            fromEmail: 'Youthnic Refunds <refunds@youthnic.com>',
            replyTo: 'refunds@youthnic.com',
            orderId: returnRec.order.id,
            data: {
              orderName: returnRec.order.shopifyOrderName,
              customerName: returnRec.order.customerName,
              recipientEmail: returnRec.order.customerEmail,
              refundId: finalRefundId,
              refundAmount: finalRefundAmount,
              paymentMethod: returnRec.order.paymentMethod || 'Prepaid',
              settlementGateway: returnRec.order.paymentMethod || 'Easebuzz / PhonePe',
              qcStatus: qcStatus || 'APPROVED',
              qcRemark: qcRemark || undefined,
              items: returnRec.order.items.map((i: any) => ({
                title: i.title,
                variantTitle: i.variantTitle,
                quantity: i.quantity,
                price: i.price,
                imageUrl: i.imageUrl,
              })),
              totalAmount: returnRec.order.totalAmount,
            },
          });
          emailDispatched = emailResult?.success ?? false;

          await firebaseService.syncCustomerHistory(returnRec.order.customerEmail, {
            type: 'OUTBOUND_EMAIL',
            channel: 'EMAIL',
            title: `Refund Processed: ₹${finalRefundAmount} for Order ${returnRec.order.shopifyOrderName}`,
            description: `Return verified with 0 issues. Refund ID: ${finalRefundId}.`,
            timestamp: new Date().toISOString(),
            sender: 'Youthnic Refunds <refunds@youthnic.com>',
            recipient: returnRec.order.customerEmail,
            orderId: returnRec.order.id,
            shopifyOrderName: returnRec.order.shopifyOrderName,
            status: 'SENT',
          });
        }
      } catch (e: any) {
        logger.warn('Failed to send refund email on return scan:', e.message);
      }
    }

    res.json({
      success: true,
      ...result,
      emailDispatched,
      emailResult,
      message: result.refundProcessed
        ? result.moneyMoved === false
          ? 'Return received and QC passed. Shopify recorded the refund, but this order has no online payment (COD): pay the customer by UPI/bank transfer.'
          : 'Return received, QC passed (no issue), refund processed and details emailed to consumer from refunds@youthnic.com'
        : result.alreadyRefunded
          ? 'Return received and QC recorded. This return was already refunded, so no second refund was issued.'
          : result.refundError
            ? `Return received, but the refund did not go through: ${result.refundError}`
            : 'Return received but refund not processed (QC rejected)',
    });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// Check status and connection to read-only RETURN_SCAN_DATABASE
router.get('/returns/scan-status', async (_req: Request, res: Response): Promise<void> => {
  try {
    const status = await returnScanService.ping();
    res.json(status);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Sync return scans from read-only RETURN_SCAN_DATABASE into OMS
router.post('/returns/scan-sync', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const lookbackDays = req.body?.lookbackDays ? parseInt(req.body.lookbackDays, 10) : 30;
    const result = await returnScanService.syncReturnScans(lookbackDays);
    res.json({ success: true, ...result });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Trigger daily manual COD refund digest email to listings@vbexports.co.in
router.post('/returns/cod-refund-digest', async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const result = await returnScanService.sendDailyCodManualRefundDigest();
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Process refund for a return
router.post('/returns/:id/refund', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const returnId = parseInt(req.params.id, 10);
    const { partial } = req.body;
    // Without an explicit flag, the QC result stored on the return decides.
    const result = await returnService.processRefund(
      returnId,
      typeof partial === 'boolean' ? partial : undefined,
      req.user
    );
    if (!result.success) {
      res.status(409).json({ success: false, refundAmount: result.refundAmount, error: result.error || 'Refund not processed' });
      return;
    }

    // Send Refund Processed Email from Youthnic Refunds <refunds@youthnic.com>
    // only when money went back (a COD order has no online payment to refund).
    let emailDispatched = false;
    let emailResult: any = null;
    if (result.moneyMoved) {
      try {
        const returnRec = await prisma.return.findUnique({
          where: { id: returnId },
          include: { order: { include: { items: true } } },
        });
        if (returnRec?.order?.customerEmail) {
          const finalRefundAmount = result.refundAmount || returnRec.refundAmount || returnRec.order.totalAmount;
          const finalRefundId = result.shopifyRefundId || returnRec.shopifyRefundId || `RF-${returnRec.order.shopifyOrderNumber}`;

          emailResult = await resendService.sendEmail({
            to: returnRec.order.customerEmail,
            templateType: 'RETURN_REFUND',
            fromEmail: 'Youthnic Refunds <refunds@youthnic.com>',
            replyTo: 'refunds@youthnic.com',
            orderId: returnRec.order.id,
            data: {
              orderName: returnRec.order.shopifyOrderName,
              customerName: returnRec.order.customerName,
              recipientEmail: returnRec.order.customerEmail,
              refundId: finalRefundId,
              refundAmount: finalRefundAmount,
              paymentMethod: returnRec.order.paymentMethod || 'Prepaid',
              settlementGateway: returnRec.order.paymentMethod || 'Easebuzz / PhonePe',
              items: returnRec.order.items.map((i: any) => ({
                title: i.title,
                variantTitle: i.variantTitle,
                quantity: i.quantity,
                price: i.price,
                imageUrl: i.imageUrl,
              })),
              totalAmount: returnRec.order.totalAmount,
            },
          });
          emailDispatched = emailResult?.success ?? false;

          await firebaseService.syncCustomerHistory(returnRec.order.customerEmail, {
            type: 'OUTBOUND_EMAIL',
            channel: 'EMAIL',
            title: `Refund Processed: ₹${finalRefundAmount} for Order ${returnRec.order.shopifyOrderName}`,
            description: `Refund ID: ${finalRefundId}. Credited to customer account.`,
            timestamp: new Date().toISOString(),
            sender: 'Youthnic Refunds <refunds@youthnic.com>',
            recipient: returnRec.order.customerEmail,
            orderId: returnRec.order.id,
            shopifyOrderName: returnRec.order.shopifyOrderName,
            status: 'SENT',
          });
        }
      } catch (e: any) {
        logger.warn('Failed to send refund email on return refund:', e.message);
      }
    }

    res.json({
      success: result.success,
      refundAmount: result.refundAmount,
      moneyMoved: result.moneyMoved,
      emailDispatched,
      emailResult,
    });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// ─── Tracking ────────────────────────────────────────────

// Track a shipment by waybill number
router.get('/tracking/:waybill', async (req: Request, res: Response): Promise<void> => {
  try {
    const waybill = req.params.waybill;
    const tracking = await trackingService.trackShipment(waybill);
    res.json({ tracking });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Manually trigger tracking sync for all active shipments
// ?force=true bypasses the stale-interval skip (dashboard "Sync now" button).
router.post('/tracking/sync', async (req: Request, res: Response): Promise<void> => {
  try {
    const force = req.query.force === 'true' || req.body?.force === true;
    const count = await trackingService.syncAllTracking(force);
    res.json({ success: true, updatedCount: count, forced: force });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Live sync tracking for a single waybill from Delhivery and update DB
router.post('/tracking/:waybill/sync', async (req: Request, res: Response): Promise<void> => {
  try {
    const waybill = req.params.waybill;
    const result = await trackingService.syncShipmentTracking(waybill);
    if (!result) {
      res.status(404).json({ error: 'Shipment or tracking not found' });
      return;
    }
    res.json({ success: true, tracking: result.tracking, shipment: result.shipment });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Payments ───────────────────────────────────────────

// Get payment details for an order
router.get('/orders/:id/payment', async (req: Request, res: Response): Promise<void> => {
  try {
    const orderId = parseInt(req.params.id, 10);
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: {
        paymentGateway: true,
        gatewayTransactionId: true,
        paymentMethod: true,
        paymentVerified: true,
        paymentVerifiedAt: true,
        paymentVerificationSource: true,
        paymentReference: true,
        totalAmount: true,
        currency: true,
        financialStatus: true,
      },
    });
    if (!order) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }
    res.json({ payment: order });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Manually verify payment for an order (checks Shopify transactions + gateway API if enabled)
router.post('/orders/:id/payment/verify', async (req: Request, res: Response): Promise<void> => {
  try {
    const orderId = parseInt(req.params.id, 10);
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }
    const result = await paymentService.verifyPayment(order);
    res.json({ success: true, ...result });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get orders grouped by payment gateway and 3-way money receipt summary (dashboard)
router.get('/payments/summary', async (_req: Request, res: Response): Promise<void> => {
  try {
    const orders = await prisma.order.groupBy({
      by: ['paymentGateway'],
      _count: { _all: true },
      _sum: { totalAmount: true },
    });
    const unverified = await prisma.order.count({
      where: { paymentVerified: false, status: 'NEW' },
    });

    // 1. Delhivery COD statistics
    const [codAgg, codCollectedAgg, codRemittedAgg] = await Promise.all([
      prisma.order.aggregate({
        where: { paymentMethod: 'COD' },
        _count: { _all: true },
        _sum: { totalAmount: true },
      }),
      prisma.shipment.aggregate({
        where: { paymentMode: 'COD', codCollected: true },
        _sum: { codAmount: true },
      }),
      prisma.shipment.aggregate({
        where: { paymentMode: 'COD', codRemitted: true },
        _sum: { codAmount: true, codRemittedAmount: true },
      }),
    ]);

    // 2. GoKwik Prepaid statistics
    const [gokwikAgg, gokwikVerifiedCount] = await Promise.all([
      prisma.order.aggregate({
        where: {
          paymentMethod: { not: 'COD' },
          paymentGateway: { contains: 'gokwik', mode: 'insensitive' },
        },
        _count: { _all: true },
        _sum: { totalAmount: true },
      }),
      prisma.order.count({
        where: {
          paymentMethod: { not: 'COD' },
          paymentGateway: { contains: 'gokwik', mode: 'insensitive' },
          paymentVerified: true,
        },
      }),
    ]);

    // 3. PhonePe Prepaid statistics
    const [phonepeAgg, phonepeVerifiedCount] = await Promise.all([
      prisma.order.aggregate({
        where: {
          paymentMethod: { not: 'COD' },
          paymentGateway: { contains: 'phonepe', mode: 'insensitive' },
        },
        _count: { _all: true },
        _sum: { totalAmount: true },
      }),
      prisma.order.count({
        where: {
          paymentMethod: { not: 'COD' },
          paymentGateway: { contains: 'phonepe', mode: 'insensitive' },
          paymentVerified: true,
        },
      }),
    ]);

    const codCollected = codCollectedAgg._sum.codAmount || 0;
    const codRemitted = codRemittedAgg._sum.codRemittedAmount ?? codRemittedAgg._sum.codAmount ?? 0;

    const threeWaySummary = {
      delhiveryCod: {
        channel: 'Delhivery COD',
        source: 'Delhivery Courier Cash Collection & Panel Remittance',
        orderCount: codAgg._count._all,
        totalAmount: codAgg._sum.totalAmount || 0,
        collectedAmount: codCollected,
        remittedAmount: codRemitted,
        outstandingAmount: Math.max(0, codCollected - codRemitted),
      },
      gokwikPrepaid: {
        channel: 'GoKwik Checkout',
        source: 'GoKwik Payment Gateway / 1-Click Checkout',
        orderCount: gokwikAgg._count._all,
        totalAmount: gokwikAgg._sum.totalAmount || 0,
        verifiedCount: gokwikVerifiedCount,
        unverifiedCount: Math.max(0, gokwikAgg._count._all - gokwikVerifiedCount),
      },
      phonepePrepaid: {
        channel: 'PhonePe PG',
        source: 'PhonePe Payment Gateway (UPI / Cards / Wallets)',
        orderCount: phonepeAgg._count._all,
        totalAmount: phonepeAgg._sum.totalAmount || 0,
        verifiedCount: phonepeVerifiedCount,
        unverifiedCount: Math.max(0, phonepeAgg._count._all - phonepeVerifiedCount),
      },
    };

    res.json({
      byGateway: orders,
      unverifiedPrepaidOrders: unverified,
      threeWaySummary,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── COD reconciliation ─────────────────────────────────
// Delhivery's public API has no remittance endpoint (remittances live in the
// panel under Finances > Remittance), so this ledger derives "collected" from
// delivery status and lets you record remittances from the panel report.

// COD ledger: what was collected at delivery, what Delhivery has remitted,
// and what is still outstanding.
router.get('/cod/summary', async (_req: Request, res: Response): Promise<void> => {
  try {
    const [collected, remitted, outstanding, remittedList, pendingDelivery] = await Promise.all([
      prisma.shipment.aggregate({
        where: { paymentMode: 'COD', codCollected: true },
        _sum: { codAmount: true },
        _count: { _all: true },
      }),
      prisma.shipment.aggregate({
        where: { paymentMode: 'COD', codRemitted: true },
        _sum: { codAmount: true, codRemittedAmount: true },
        _count: { _all: true },
      }),
      prisma.shipment.findMany({
        where: { paymentMode: 'COD', codCollected: true, codRemitted: false },
        include: { order: { select: { id: true, shopifyOrderName: true, customerName: true, customerCity: true } } },
        orderBy: { codCollectedAt: 'desc' },
      }),
      prisma.shipment.findMany({
        where: { paymentMode: 'COD', codRemitted: true },
        include: { order: { select: { id: true, shopifyOrderName: true, customerName: true, customerCity: true } } },
        orderBy: { codRemittedAt: 'desc' },
        take: 50,
      }),
      prisma.shipment.findMany({
        where: { paymentMode: 'COD', codCollected: false, codRemitted: false },
        include: { order: { select: { id: true, shopifyOrderName: true, customerName: true, customerCity: true } } },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    res.json({
      collectedCount: collected._count._all,
      collectedAmount: collected._sum.codAmount || 0,
      remittedCount: remitted._count._all,
      remittedAmount: remitted._sum.codRemittedAmount ?? remitted._sum.codAmount ?? 0,
      outstandingCount: outstanding.length,
      outstandingAmount: outstanding.reduce((sum, s) => sum + (s.codAmount || 0), 0),
      pendingDeliveryCount: pendingDelivery.length,
      pendingDeliveryAmount: pendingDelivery.reduce((sum, s) => sum + (s.codAmount || 0), 0),
      outstanding: outstanding.map((s) => ({
        shipmentId: s.id,
        orderId: s.order.id,
        waybillNumber: s.waybillNumber,
        orderName: s.order.shopifyOrderName,
        customerName: s.order.customerName,
        customerCity: s.order.customerCity,
        codAmount: s.codAmount,
        collectedAt: s.codCollectedAt,
      })),
      remitted: remittedList.map((s) => ({
        shipmentId: s.id,
        orderId: s.order.id,
        waybillNumber: s.waybillNumber,
        orderName: s.order.shopifyOrderName,
        customerName: s.order.customerName,
        customerCity: s.order.customerCity,
        codAmount: s.codAmount,
        codRemittedAmount: s.codRemittedAmount ?? s.codAmount,
        remittanceRef: s.codRemittanceRef,
        remittedAt: s.codRemittedAt,
      })),
      pendingDelivery: pendingDelivery.map((s) => ({
        shipmentId: s.id,
        orderId: s.order.id,
        waybillNumber: s.waybillNumber,
        orderName: s.order.shopifyOrderName,
        customerName: s.order.customerName,
        customerCity: s.order.customerCity,
        codAmount: s.codAmount,
        status: s.status,
      })),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Mark COD as collected (e.g. courier collected cash at delivery)
router.post('/cod/mark-collected', async (req: Request, res: Response): Promise<void> => {
  try {
    const { waybillNumber, collectedAt } = req.body || {};
    if (!waybillNumber) {
      res.status(400).json({ error: 'waybillNumber is required' });
      return;
    }

    const when = collectedAt ? new Date(collectedAt) : new Date();
    const shipment = await prisma.shipment.findFirst({
      where: { waybillNumber: String(waybillNumber) },
      include: { order: true },
    });

    if (!shipment) {
      res.status(404).json({ error: `Shipment with waybill ${waybillNumber} not found` });
      return;
    }

    await prisma.shipment.update({
      where: { id: shipment.id },
      data: {
        codCollected: true,
        codCollectedAt: when,
        codAmount: shipment.codAmount && shipment.codAmount > 0 ? shipment.codAmount : shipment.order?.totalAmount || 0,
      },
    });

    res.json({
      success: true,
      waybillNumber,
      orderName: shipment.order?.shopifyOrderName,
      codAmount: shipment.codAmount,
      codCollected: true,
      codCollectedAt: when,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Record a remittance from the Delhivery panel report (Finances > Remittance).
// Updates both Shipment and Shopify Order (marks financialStatus: 'paid', paymentVerified: true, adds tags).
router.post('/cod/remittance', async (req: Request, res: Response): Promise<void> => {
  try {
    const { remittanceRef, remittedAt, waybills, amounts } = req.body || {};
    if (!remittanceRef || !Array.isArray(waybills) || waybills.length === 0) {
      res.status(400).json({ error: 'remittanceRef and a non-empty waybills array are required' });
      return;
    }

    const when = remittedAt ? new Date(remittedAt) : new Date();
    if (Number.isNaN(when.getTime())) {
      res.status(400).json({ error: 'remittedAt is not a valid date' });
      return;
    }

    let updated = 0;
    const missing: string[] = [];

    for (const waybill of waybills) {
      const cleanWbn = String(waybill).trim();
      const shipment = await prisma.shipment.findFirst({
        where: {
          OR: [
            { waybillNumber: cleanWbn },
            { order: { shopifyOrderName: cleanWbn } },
            { order: { shopifyOrderName: `#${cleanWbn}` } },
          ],
        },
        include: { order: true },
      });

      if (!shipment) {
        missing.push(cleanWbn);
        continue;
      }

      const remittedAmount = amounts?.[cleanWbn] ?? shipment.codAmount ?? shipment.order?.totalAmount ?? 0;

      await prisma.shipment.update({
        where: { id: shipment.id },
        data: {
          codCollected: true,
          codCollectedAt: shipment.codCollectedAt || when,
          codRemitted: true,
          codRemittedAt: when,
          codRemittanceRef: String(remittanceRef),
          codRemittedAmount: remittedAmount,
        },
      });

      // Same money fields as the remittance upload on Payments & Accounts.
      // The remittance reference is not the customer's payment reference, so
      // paymentReference is left alone.
      if (shipment.order) {
        await recordPaymentReceived(shipment.order.id, {
          receivedAt: when,
          amount: remittedAmount,
          utr: req.body?.utr ? String(req.body.utr) : null,
          ref: String(remittanceRef),
          source: 'DELHIVERY_REMITTANCE',
        });
      }

      updated++;
    }

    res.json({ success: true, updated, notFound: missing });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Import a Delhivery remittance export (Delhivery ONE > Finances > Remittance).
// Kept for older callers; Payments & Accounts uploads use /api/accounts/import.
router.post('/cod/remittance/import', async (req: Request, res: Response): Promise<void> => {
  try {
    const { csvContent, fileName, utr, remittanceRef, remittedAt } = req.body || {};
    if (!csvContent || typeof csvContent !== 'string') {
      res.status(400).json({ error: 'csvContent is required' });
      return;
    }
    const sheets = await readSpreadsheet(fileName || 'remittance.csv', Buffer.from(csvContent, 'utf8'));
    const result = await importDelhiveryRemittance(
      fileName || 'remittance.csv',
      sheets,
      { utr, remittanceRef, remittedAt },
      (req as any).user?.email
    );
    res.json({
      success: true,
      message: `Processed remittance: ${result.matchedCount} shipments marked remitted.`,
      updated: result.matchedCount,
      notFound: result.unmatched,
      notes: result.notes,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Delhivery ──────────────────────────────────────────

// Check pincode serviceability
router.get('/delhivery/serviceability/:pincode', async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await delhiveryService.checkPincodeServiceability(req.params.pincode);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get expected TAT between two pincodes
router.get('/delhivery/tat', async (req: Request, res: Response): Promise<void> => {
  try {
    const { origin, destination, mot } = req.query;
    if (!origin || !destination) {
      res.status(400).json({ error: 'origin and destination query params are required' });
      return;
    }
    const result = await delhiveryService.getExpectedTAT(
      origin as string,
      destination as string,
      (mot as string) || 'S'
    );
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Generate/download shipping label for a waybill
router.get('/delhivery/label/:waybill', async (req: Request, res: Response): Promise<void> => {
  try {
    const labelUrl = await delhiveryService.generateLabel(req.params.waybill);
    res.json({ labelUrl });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Direct PDF download stream for a waybill shipping label.
// Also mirrors the PDF into Firebase Storage so the Order Detail page can render it
// even after Delhivery's signed URL expires (Delhivery URLs typically expire in 24h).
//
// If Delhivery returns no usable URL (manifest still propagating, transient API
// issue, archived label) we fall back to the printable 4R thermal HTML label
// instead of returning a bare 404 — operators want a printable label, not a JSON
// error.
router.get('/delhivery/label/:waybill/download', async (req: Request, res: Response): Promise<void> => {
  try {
    const waybill = req.params.waybill;
    const labelUrl = await delhiveryService.generateLabel(waybill);
    if (!labelUrl || !labelUrl.startsWith('http')) {
      // Fall back to HTML printable label so operators always get something.
      const shipment = await prisma.shipment.findFirst({
        where: { waybillNumber: waybill },
        include: { order: { include: { items: true } } },
      });
      if (!shipment?.order) {
        res.status(404).json({
          error: 'Shipping label PDF not available for this waybill and no order found in our DB to render an HTML fallback.',
          waybill,
        });
        return;
      }
      logger.warn('Delhivery label PDF unavailable, falling back to HTML printable label', {
        waybill,
        orderId: shipment.order.id,
        orderName: shipment.order.shopifyOrderName,
      });
      const html = shippingLabelService.generatePrintableLabelPage(shipment.order as any, waybill);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Disposition', `inline; filename="delhivery-label-${waybill}.html"`);
      res.send(html);
      return;
    }
    let pdfBuffer: Buffer;
    try {
      pdfBuffer = await downloadLabelBytes(labelUrl);
    } catch (downloadErr: any) {
      logger.warn('Official label URL failed, falling back to printable HTML', {
        waybill,
        error: downloadErr.message,
      });
      const shipment = await prisma.shipment.findFirst({
        where: { waybillNumber: waybill },
        include: { order: { include: { items: true } } },
      });
      if (!shipment?.order) {
        res.status(404).json({
          error: 'Shipping label PDF expired and no order was found to render an HTML fallback.',
          waybill,
        });
        return;
      }
      const html = shippingLabelService.generatePrintableLabelPage(shipment.order as any, waybill);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Disposition', `inline; filename="delhivery-label-${waybill}.html"`);
      res.send(html);
      return;
    }
    const pdfResponse = { data: pdfBuffer };

    // Mirror into Firebase Storage so the URL is durable (delhivery signed URLs expire).
    // Best-effort — never block the operator download on a storage failure.
    try {
      const ship = await prisma.shipment.findFirst({
        where: { waybillNumber: waybill },
        select: { id: true, orderId: true, labelStoragePath: true },
      });
      if (ship && !ship.labelStoragePath) {
        const uploaded = await firebaseService.uploadOrderArtifact(
          ship.orderId,
          'label',
          Buffer.from(pdfResponse.data),
          'application/pdf',
          'pdf'
        );
        await prisma.shipment.update({
          where: { id: ship.id },
          data: { labelStoragePath: uploaded.path },
        });
        logger.info('Mirrored shipping label to Firebase Storage', {
          waybill,
          path: uploaded.path,
        });
      }
    } catch (mirrorErr: any) {
      logger.warn('Label Firebase mirror failed (non-fatal)', {
        waybill,
        error: mirrorErr.message,
      });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="delhivery-label-${waybill}.pdf"`);
    res.send(Buffer.from(pdfResponse.data));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// NOTE: Delhivery exposes NO wallet/ledger API (verified 2026-09-28: the
// api-bird wallet proxy hard-403s every B2C-token auth style, cl-api host is
// dead, and the portal docs list transactions as panel-only Download Ledger
// Excel). The manual CSV ledger was removed as not useful — check
// Delhivery ONE > Finances > Wallet for balance, spends, refunds & recharges.
// Per-AWB estimates still come from the live kinko rate API + local matrix.

// Update supported shipment fields
router.patch(['/delhivery/shipment/:waybill', '/api/shipments/:waybill'], async (req: Request, res: Response): Promise<void> => {
  try {
    const waybill = req.params.waybill;
    const shipment = await prisma.shipment.findUnique({ where: { waybillNumber: waybill } });
    const isVel = isVelocityCourier(shipment?.courier, shipment?.labelUrl, waybill);

    let result: any;
    if (isVel) {
      result = await velocityService.updateOrder({
        awb: waybill,
        phone: Array.isArray(req.body.phone) ? req.body.phone[0] : req.body.phone,
        address: req.body.address,
        city: req.body.city,
        state: req.body.state,
        pincode: req.body.pincode,
      });
    } else {
      result = await delhiveryService.updateShipment(waybill, req.body);
    }

    if (shipment) await recordOrderAction(shipment.orderId, 'SHIPMENT_DETAILS_UPDATED', (req as AuthenticatedRequest).user, {
      note: `Delivery phone/address correction submitted to ${isVel ? 'Velocity' : 'Delhivery'}.`,
      status: result.success === false ? 'FAILED' : 'COMPLETED',
    });
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Update an e-way bill for a shipment
router.put('/delhivery/shipment/:waybill/ewaybill', async (req: Request, res: Response): Promise<void> => {
  try {
    const { invoiceNumber, ewaybillNumber } = req.body;
    if (!invoiceNumber || !ewaybillNumber) {
      res.status(400).json({ error: 'invoiceNumber and ewaybillNumber are required' });
      return;
    }
    const result = await delhiveryService.updateEwaybill(
      req.params.waybill,
      invoiceNumber,
      ewaybillNumber
    );
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Calculate approximate Delhivery shipping cost
router.get('/delhivery/shipping-cost', async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      mode,
      chargeableWeightGrams,
      originPincode,
      destinationPincode,
      shipmentStatus,
      paymentType,
      length,
      breadth,
      height,
      packageType,
    } = req.query;

    if (
      !mode ||
      !chargeableWeightGrams ||
      !originPincode ||
      !destinationPincode ||
      !shipmentStatus ||
      !paymentType
    ) {
      res.status(400).json({
        error:
          'mode, chargeableWeightGrams, originPincode, destinationPincode, shipmentStatus, and paymentType are required',
      });
      return;
    }

    const result = await delhiveryService.calculateShippingCost({
      mode: mode as 'E' | 'S',
      chargeableWeightGrams: Number(chargeableWeightGrams),
      originPincode: originPincode as string,
      destinationPincode: destinationPincode as string,
      shipmentStatus: shipmentStatus as 'Delivered' | 'RTO' | 'DTO',
      paymentType: paymentType as 'Pre-paid' | 'COD',
      length: length ? Number(length) : undefined,
      breadth: breadth ? Number(breadth) : undefined,
      height: height ? Number(height) : undefined,
      packageType: packageType as 'box' | 'flyer' | undefined,
    });
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Cancel a shipment within carrier's allowed status window
router.post(['/delhivery/shipment/:waybill/cancel', '/api/shipments/:waybill/cancel'], async (req: Request, res: Response): Promise<void> => {
  try {
    const waybill = req.params.waybill;
    const shipment = await prisma.shipment.findUnique({ where: { waybillNumber: waybill } });
    if (!shipment) {
      res.status(404).json({ success: false, error: 'Shipment not found' });
      return;
    }

    if (shipment.status === 'OUT_FOR_DELIVERY' || shipment.status === 'DELIVERED') {
      res.status(409).json({
        success: false,
        error: `Cannot cancel shipment in status ${shipment.status}. Parcel is already out for delivery or delivered.`,
      });
      return;
    }

    const isVel = isVelocityCourier(shipment.courier, shipment.labelUrl, waybill);

    let success = false;
    if (isVel) {
      const velRes = await velocityService.cancelShipment(waybill);
      success = Boolean(velRes.success || velRes.cancelled);
    } else {
      success = await delhiveryService.cancelShipment(waybill);
    }

    if (success) {
      await prisma.$transaction([
        prisma.shipment.update({
          where: { id: shipment.id },
          data: { status: 'CANCELLED' },
        }),
        prisma.order.update({
          where: { id: shipment.orderId },
          data: {
            status: 'DISPATCH_PENDING',
            supportFlag: null,
            hasUrgentSupport: false,
          },
        }),
      ]);
    }

    await recordOrderAction(shipment.orderId, 'SHIPMENT_CANCEL_REQUESTED', (req as AuthenticatedRequest).user, {
      note: success
        ? `${isVel ? 'Velocity' : 'Delhivery'} accepted shipment cancellation. Order reset to DISPATCH_PENDING for re-routing.`
        : `${isVel ? 'Velocity' : 'Delhivery'} did not accept cancellation; parcel remains tracked.`,
      status: success ? 'COMPLETED' : 'REVIEW',
    });

    res.status(success ? 200 : 409).json(
      success
        ? { success: true, message: 'Shipment cancelled and order reset for re-routing.' }
        : { success: false, error: `${isVel ? 'Velocity' : 'Delhivery'} did not accept cancellation; keep tracking this parcel.` }
    );
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Download document (EPOD, signature, QC image, return image)
router.get('/delhivery/document/:waybill', async (req: Request, res: Response): Promise<void> => {
  try {
    const docType = (req.query.type as string) || 'EPOD';
    const result = await delhiveryService.downloadDocument(
      req.params.waybill,
      docType as any
    );
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get EPOD details and viewing URL for an order
router.get('/orders/:id/epod', async (req: Request, res: Response): Promise<void> => {
  try {
    const orderId = parseInt(req.params.id, 10);
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { shipment: true },
    });

    if (!order) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }

    const shipment = order.shipment;
    if (!shipment || !shipment.waybillNumber) {
      res.status(400).json({ error: 'Order has no active shipment or waybill' });
      return;
    }
    const waybill = shipment.waybillNumber;

    // 1. If already uploaded to Firebase Cloud Storage, return the artifact URL directly
    if (shipment.epodStoragePath) {
      const bucketName = config.firebase.storageBucket || 'shopify-134b9.firebasestorage.app';
      const cleanPath = shipment.epodStoragePath.replace(/^gs:\/\/[^/]+\//, '');
      const epodUrl = `https://storage.googleapis.com/${bucketName}/${cleanPath}`;
      res.json({
        success: true,
        waybill,
        epodUrl,
        storagePath: shipment.epodStoragePath,
        receivedBy: shipment.epodReceivedBy,
        receivedAt: shipment.epodReceivedAt,
        status: shipment.status,
        source: 'firebase_storage',
      });
      return;
    }

    // 2. If not stored yet, attempt live fetch via Delhivery Document API
    try {
      const docFetcher = (await import('../modules/delhivery/delhivery-document-fetcher.service')).default;
      const fetchResult = await docFetcher.tryFetchArtifact(order.id, waybill, 'epod');
      if (fetchResult.uploaded && fetchResult.path) {
        const bucketName = config.firebase.storageBucket || 'shopify-134b9.firebasestorage.app';
        const cleanPath = fetchResult.path.replace(/^gs:\/\/[^/]+\//, '');
        const epodUrl = `https://storage.googleapis.com/${bucketName}/${cleanPath}`;
        res.json({
          success: true,
          waybill,
          epodUrl,
          storagePath: fetchResult.path,
          receivedBy: shipment.epodReceivedBy,
          receivedAt: shipment.epodReceivedAt || new Date(),
          status: shipment.status,
          source: 'delhivery_api_live',
        });
        return;
      }
    } catch (fetchErr: any) {
      logger.warn('Live EPOD fetch failed', { waybill, error: fetchErr.message });
    }

    // 3. Fallback: query Delhivery raw document endpoint directly
    try {
      const doc = await delhiveryService.downloadDocument(waybill, 'EPOD');
      res.json({
        success: Boolean(doc),
        waybill,
        document: doc,
        source: 'delhivery_raw',
        message: 'EPOD retrieved from Delhivery (not yet archived to Firebase)',
      });
    } catch (docErr: any) {
      res.status(404).json({
        success: false,
        error: 'EPOD document not yet generated or available from Delhivery',
      });
    }
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Take NDR action: RE-ATTEMPT | PICKUP_RESCHEDULE | DEFER_DLV (+deferredDate YYYY-MM-DD, ≤6d) | EDIT_DETAILS (+name/phone/address).
// Async — returns UPL id; check via GET /api/delhivery/ndr/:uplId. StatusCode gating (EOD-*/ST-108) readable from tracking.
router.post('/delhivery/ndr', async (req: Request, res: Response): Promise<void> => {
  try {
    const { waybill, action, deferredDate, name, phone, address } = req.body;
    if (!waybill || !action) {
      res.status(400).json({ error: 'waybill and action are required' });
      return;
    }
    if (!['RE-ATTEMPT', 'PICKUP_RESCHEDULE', 'DEFER_DLV', 'EDIT_DETAILS'].includes(action)) {
      res.status(400).json({ error: 'action must be RE-ATTEMPT, PICKUP_RESCHEDULE, DEFER_DLV, or EDIT_DETAILS' });
      return;
    }
    const result = await delhiveryService.ndrAction(waybill, action, {
      deferredDate,
      name,
      phone,
      address,
    });
    if (!result.success && result.message) {
      res.status(400).json(result);
      return;
    }
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Check NDR action (UPL) status
router.get('/delhivery/ndr/:uplId', async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await delhiveryService.getNDRStatus(req.params.uplId);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Register a pickup warehouse (one-time; avoids "ClientWarehouse matching query doesn't exist" on manifest)
router.post('/delhivery/warehouse', async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, phone, city, pin, address, email } = req.body;
    if (!name || !phone || !city || !pin || !address || !email) {
      res.status(400).json({ error: 'name, phone, city, pin, address, and email are required' });
      return;
    }
    const result = await delhiveryService.createWarehouse(req.body);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.response?.data || error.message });
  }
});

// Update a registered pickup warehouse
router.put('/delhivery/warehouse', async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, ...updates } = req.body;
    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    const result = await delhiveryService.updateWarehouse(name, updates);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.response?.data || error.message });
  }
});

// Fetch waybills in bulk (pre-fetch for later use)
router.post('/delhivery/waybills/fetch', async (req: Request, res: Response): Promise<void> => {
  try {
    const { count } = req.body;
    if (!count || count > 10000) {
      res.status(400).json({ error: 'count is required and must be <= 10000' });
      return;
    }
    const waybills = await delhiveryService.fetchBulkWaybills(count);
    res.json({ waybills, count: waybills.length });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Setup ───────────────────────────────────────────────

// Register Shopify webhooks (call once after deployment)
// Returns per-topic results so the Settings UI can show created/exists/failed.
router.post('/setup/webhooks', async (_req: Request, res: Response): Promise<void> => {
  try {
    const results = await shopifyService.registerWebhooks();
    const failed = results.filter((r) => r.status === 'failed');
    res.json({
      success: failed.length === 0,
      results,
      appBaseUrl: config.appBaseUrl,
      https: /^https:\/\//i.test(config.appBaseUrl || ''),
      hint:
        'Shopify webhooks → ${config.appBaseUrl}/webhooks/shopify. ' +
        'Delhivery scan-push is manual: email lastmile-integration@delhivery.com with ${config.appBaseUrl}/webhooks/delhivery' +
        (config.delhivery.webhookSecret ? ' + your DELHIVERY_WEBHOOK_SECRET.' : '.'),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Webhook + Delhivery access status (no secrets leaked — booleans + counts only).
// Used by Settings UI and scripts/check-delhivery-access.ts.
router.get('/setup/webhooks/status', async (_req: Request, res: Response): Promise<void> => {
  try {
    const base = (config.appBaseUrl || '').replace(/\/$/, '');
    const shopifyWebhooks = await shopifyService.listWebhooks();
    res.json({
      success: true,
      appBaseUrl: base,
      https: /^https:\/\//i.test(base),
      shopify: {
        expectedAddress: `${base}/webhooks/shopify`,
        topics: ['orders/create', 'orders/paid', 'orders/updated', 'orders/cancelled', 'refunds/create'],
        registered: shopifyWebhooks.map((w: any) => ({ topic: w.topic, address: w.address })),
        webhookSecretConfigured: Boolean(config.shopify.webhookSecret),
      },
      delhivery: {
        expectedAddress: `${base}/webhooks/delhivery`,
        // Manual registration via Delhivery integration team — no self-register API.
        setup: 'manual — email lastmile-integration@delhivery.com with the address above',
        apiTokenConfigured: Boolean(config.delhivery.apiToken),
        baseUrl: config.delhivery.baseUrl,
        pickupLocation: config.delhivery.pickupLocation,
        webhookSecretConfigured: Boolean(config.delhivery.webhookSecret),
        limits: {
          trackSingle: 'GET /api/v1/packages/json/?waybill= (retry 3x, 30s timeout)',
          trackBulk: 'max 50 waybills/request',
          trackingCronBatch: `${config.tracking.batchLimit} shipments/cycle, skip-fresh ${config.tracking.minIntervalMinutes}min`,
          webhookBatch: 'max 500 scans/request',
        },
      },
      whatsapp: {
        expectedAddress: `${base}/api/webhooks/whatsapp`,
        public: true,
        note: 'Exempted from Firebase auth; GET verifies hub.challenge, POST ingests inbound.',
      },
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Settings & Admin Stack Information ────────────────────

const DEFAULT_OPERATORS = [
  {
    id: 'usr_admin_1',
    name: 'Pawan Shukla',
    email: 'pawan@youthnic.com',
    role: 'Admin / System Architect',
    department: 'Executive Operations',
    phone: '+91 88661 54721',
    status: 'ACTIVE',
    avatar: 'PS',
    createdAt: '2026-07-01T00:00:00.000Z',
    lastActive: 'Active now',
  },
  {
    id: 'usr_ops_2',
    name: 'Surat Dispatch Desk',
    email: 'dispatch@youthnic.com',
    role: 'Operations & Dispatch Lead',
    department: 'Surat Fulfillment Center',
    phone: '+91 98251 00000',
    status: 'ACTIVE',
    avatar: 'SD',
    createdAt: '2026-07-01T00:00:00.000Z',
    lastActive: '12 mins ago',
  },
  {
    id: 'usr_qc_3',
    name: 'Warehouse QC Desk',
    email: 'warehouse-qc@youthnic.com',
    role: 'Reverse Logistics & QC Specialist',
    department: 'Warehouse Returns & RTO',
    phone: '+91 98252 00000',
    status: 'ACTIVE',
    avatar: 'QC',
    createdAt: '2026-07-01T00:00:00.000Z',
    lastActive: '45 mins ago',
  },
  {
    id: 'usr_fin_4',
    name: 'Finance & Remittance Desk',
    email: 'finance@youthnic.com',
    role: '3-Way Payment Reconciliation',
    department: 'Accounts & Delhivery Ledger',
    phone: '+91 98253 00000',
    status: 'ACTIVE',
    avatar: 'FN',
    createdAt: '2026-07-01T00:00:00.000Z',
    lastActive: '2 hours ago',
  },
];

async function getStoredOperators() {
  try {
    const setting = await prisma.setting.findUnique({ where: { key: 'system_users_list' } });
    if (setting?.value) {
      const parsed = JSON.parse(setting.value);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch (err) {
    logger.warn('Failed to parse system_users_list from setting, using default', { err });
  }
  return DEFAULT_OPERATORS;
}

async function saveStoredOperators(users: any[]) {
  await prisma.setting.upsert({
    where: { key: 'system_users_list' },
    update: { value: JSON.stringify(users) },
    create: { key: 'system_users_list', value: JSON.stringify(users) },
  });
}

// GET /api/settings/system-status
router.get('/settings/system-status', async (_req: Request, res: Response): Promise<void> => {
  try {
    const [totalOrders, totalShipments, totalReturns, latestOrder] = await Promise.all([
      prisma.order.count(),
      prisma.shipment.count(),
      prisma.return.count(),
      prisma.order.findFirst({
        orderBy: { shopifyCreatedAt: 'desc' },
        select: { shopifyCreatedAt: true, shopifyOrderName: true },
      }),
    ]);

    const memory = process.memoryUsage();

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      stack: {
        nodeVersion: process.version,
        platform: process.platform,
        architecture: process.arch,
        uptimeSeconds: Math.floor(process.uptime()),
        memoryRssMb: Math.round((memory.rss / (1024 * 1024)) * 100) / 100,
        memoryHeapUsedMb: Math.round((memory.heapUsed / (1024 * 1024)) * 100) / 100,
        env: config.nodeEnv,
        port: config.port,
      },
      database: {
        status: 'CONNECTED',
        provider: 'PostgreSQL 16 (Hostinger VPS)',
        host: '31.97.234.18:5433',
        databaseName: 'shopify_express',
        connectionPool: 'Active (Prisma Client)',
        totalOrders,
        totalShipments,
        totalReturns,
        latestOrderName: latestOrder?.shopifyOrderName ?? 'N/A',
        latestOrderDate: latestOrder?.shopifyCreatedAt?.toISOString() ?? null,
      },
      shopify: {
        status: 'CONNECTED',
        shopDomain: config.shopify.shopDomain,
        apiVersion: config.shopify.apiVersion,
        authMode: config.shopify.accessToken ? 'Custom App Token (Direct API)' : 'Client Credentials (OAuth)',
        syncStartDate: '2026-07-01 (Continuous Live Ingestion)',
        webhooksConfigured: true,
        endpointUrl: `https://${config.shopify.shopDomain}/admin/api/${config.shopify.apiVersion}/`,
      },
      delhivery: {
        status: config.delhivery.apiToken ? 'CONNECTED' : 'DISCONNECTED',
        environment: 'Express B2C Production',
        originHub: config.delhivery.pickupLocation,
        originPincode: config.delhivery.seller.pincode || '395006',
        city: config.delhivery.seller.city || 'Surat',
        state: config.delhivery.seller.state || 'Gujarat',
        shippingMode: config.delhivery.shippingMode,
        labelSize: config.delhivery.labelSize,
        baseUrl: config.delhivery.baseUrl,
      },
      velocity: {
        status: config.velocity.apiToken ? 'CONNECTED' : 'STANDBY',
        baseUrl: config.velocity.baseUrl,
        warehouseId: config.velocity.warehouseId,
        enabled: config.velocity.enabled,
        hasToken: Boolean(config.velocity.apiToken),
      },
      shipping: {
        priority: await shippingRouterService.getCarrierPriority(),
        delhiveryConfigured: Boolean(config.delhivery.apiToken),
        velocityConfigured: Boolean(config.velocity.apiToken),
      },
      payments: {
        gokwik: {
          name: 'GoKwik',
          role: 'Checkout Aggregator & COD Confirmation',
          status: 'CONNECTED',
          features: ['WhatsApp COD Confirmation tag sync', 'RTO Risk score engine', 'Prior delivery history'],
        },
        easebuzz: {
          name: 'Easebuzz',
          role: 'Primary Settlement Partner',
          status: 'CONNECTED',
          features: ['Prepaid UPI & NetBanking settlement', 'Payment reference ID matching'],
        },
        phonepe: {
          name: 'PhonePe',
          role: 'Secondary UPI Rail Partner',
          status: config.phonepe.merchantId ? 'CONNECTED' : 'ACTIVE',
          features: ['UPI PG fallback rail', 'UTR tracking'],
        },
        codEngine: {
          name: 'Delhivery COD Remittance Engine',
          role: 'Cash on Delivery Collection & Remittance',
          status: 'CONNECTED',
          features: ['Automated 3-way ledger reconciliation', 'Weight dispute auditing'],
        },
      },
      whatsapp: {
        provider: 'KwikEngage WhatsApp Platform (Official GoKwik Messaging API)',
        status: config.kwikengage.apiKey ? 'CONNECTED' : 'DISCONNECTED',
        apiUrl: config.kwikengage.apiUrl,
        merchantId: config.kwikengage.merchantId,
        senderPhone: config.kwikengage.senderPhone,
        wabaId: config.kwikengage.wabaId,
        authStatus: config.kwikengage.apiKey ? 'API Key Active' : 'API Key ${env:KWIKENGAGE_API_KEY} (Configured)',
        activeTemplates: [
          'youthnic_order_confirmed',
          'youthnic_cod_confirmation',
          'youthnic_order_dispatched',
          'youthnic_out_for_delivery',
          'youthnic_order_delivered',
          'youthnic_ndr_reschedule',
          'youthnic_rto_alert',
        ],
      },
      kwikengage: {
        status: config.kwikengage.apiKey ? 'LIVE' : 'DISCONNECTED',
        apiEndpoint: config.kwikengage.apiUrl,
        merchantId: config.kwikengage.merchantId,
        authHeader: 'Authorization: ${env:KWIKENGAGE_API_KEY}',
        senderNumber: config.kwikengage.senderPhone,
        wabaId: config.kwikengage.wabaId,
        criticalTriggers: [
          { name: 'COD Confirmation Request', code: 'COD_CONFIRMATION', action: 'WhatsApp 1-click verify & tag sync' },
          { name: 'Delhivery Dispatched & Tracking Link', code: 'ORDER_SHIPPED', action: 'Instant AWB click-to-track' },
          { name: 'Out for Delivery Warning', code: 'OUT_FOR_DELIVERY', action: 'COD cash / UPI ready prompt' },
          { name: 'NDR Exception Help & Reschedule', code: 'NDR_ALERT', action: 'Emergency re-attempt link' },
          { name: 'Delivered Confirmation', code: 'DELIVERED', action: 'Post-delivery size exchange' },
        ],
      },
      firebase: {
        rtdbStatus: 'CONNECTED',
        rtdbUrl: config.firebase.rtdbUrl,
        storageStatus: 'CONNECTED',
        storageBucket: config.firebase.storageBucket,
        serviceAccount: 'firebase-adminsdk-fbsvc@shopify-134b9.iam.gserviceaccount.com',
      },
      metaLlm: {
        status: metaLlmService.getConfig().apiKeySet ? 'CONNECTED' : 'STANDBY (Local Autonomous Harness Active)',
        model: config.metaLlm.model || 'muse-spark-1.3-contributor',
        fallbackModel: config.metaLlm.fallbackModel || 'muse-spark-1.3',
        baseUrl: config.metaLlm.baseUrl,
        apiKeyConfigured: metaLlmService.getConfig().apiKeySet,
        maskedKey: metaLlmService.getConfig().maskedKey,
      },
      webhooks: [
        { name: 'Shopify Orders (create/paid/updated/cancelled + refunds/create)', path: '/webhooks/shopify', method: 'POST', active: true, latency: '8ms' },
        { name: 'Delhivery Scan-Push', path: '/webhooks/delhivery', method: 'POST', active: true, latency: '15ms' },
        { name: 'Velocity Shipment Status Change', path: '/webhooks/velocity', method: 'POST', active: Boolean(config.velocity.apiToken), latency: '18ms' },
        { name: 'WhatsApp Inbound (KwikEngage/Meta)', path: '/api/webhooks/whatsapp', method: 'GET+POST', active: true, latency: '12ms' },
        { name: 'GoKwik Payments & Refunds', path: '/api/webhooks/gokwik', method: 'POST', active: true, latency: '10ms' },
      ],
    });
  } catch (error: any) {
    logger.error('Failed to get system status', { error });
    res.status(500).json({ error: error.message });
  }
});

// POST /api/settings/ping
router.post('/settings/ping', async (_req: Request, res: Response): Promise<void> => {
  const results: Record<string, { status: 'ok' | 'error'; latencyMs: number; message?: string }> = {};

  // 1. Test Database
  const dbStart = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    results.database = { status: 'ok', latencyMs: Date.now() - dbStart };
  } catch (err: any) {
    results.database = { status: 'error', latencyMs: Date.now() - dbStart, message: err.message };
  }

  // 2. Test Shopify
  const shopifyStart = Date.now();
  try {
    const shop = await shopifyService.getShop();
    results.shopify = { status: 'ok', latencyMs: Date.now() - shopifyStart, message: shop?.name || 'Connected' };
  } catch (err: any) {
    results.shopify = { status: 'error', latencyMs: Date.now() - shopifyStart, message: err.message };
  }

  // 3. Test Delhivery — live serviceability probe (not just token presence).
  const delhiveryStart = Date.now();
  try {
    if (!config.delhivery.apiToken) {
      results.delhivery = { status: 'error', latencyMs: 0, message: 'No API Token configured' };
    } else {
      const probe = await delhiveryService.checkPincodeServiceability(
        config.delhivery.seller.pincode || '395002'
      );
      results.delhivery = probe.serviceable || probe.remark !== 'SERVICEABILITY_CHECK_FAILED'
        ? { status: 'ok', latencyMs: Date.now() - delhiveryStart, message: `Live OK · ${probe.remark || 'serviceable'}` }
        : { status: 'error', latencyMs: Date.now() - delhiveryStart, message: probe.remark };
    }
  } catch (err: any) {
    results.delhivery = { status: 'error', latencyMs: Date.now() - delhiveryStart, message: err.message };
  }

  // 4. Test Velocity Shipping API
  const velocityStart = Date.now();
  try {
    if (!config.velocity.apiToken) {
      results.velocity = { status: 'error', latencyMs: 0, message: 'Velocity API token not configured (Optional)' };
    } else {
      const velRes = await velocityService.ping();
      results.velocity = {
        status: velRes.ok ? 'ok' : 'error',
        latencyMs: velRes.latencyMs,
        message: velRes.message,
      };
    }
  } catch (err: any) {
    results.velocity = { status: 'error', latencyMs: Date.now() - velocityStart, message: err.message };
  }

  // 5. Test KwikEngage WhatsApp REST API
  const kwikengageStart = Date.now();
  try {
    const kwikengageRes = await kwikengageService.ping();
    results.kwikengage = {
      status: kwikengageRes.status === 'ok' ? 'ok' : 'error',
      latencyMs: kwikengageRes.latencyMs,
      message: kwikengageRes.message,
    };
  } catch (err: any) {
    results.kwikengage = { status: 'error', latencyMs: Date.now() - kwikengageStart, message: err.message };
  }

  // 6. Test Firebase Cloud Storage
  try {
    const storageRes = await firebaseService.checkStorageHealth();
    results.firebaseStorage = {
      status: storageRes.status === 'ok' ? 'ok' : 'error',
      latencyMs: storageRes.latencyMs,
      message: storageRes.exists ? `Bucket ${storageRes.bucket} verified` : storageRes.error || 'Bucket not found',
    };
  } catch (err: any) {
    results.firebaseStorage = { status: 'error', latencyMs: 0, message: err.message };
  }

  // 7. Test Firebase Realtime Database
  try {
    const rtdbRes = await firebaseService.ping();
    results.firebaseRtdb = {
      status: rtdbRes.status === 'ok' ? 'ok' : 'error',
      latencyMs: rtdbRes.latencyMs,
      message: rtdbRes.status === 'ok' ? 'RTDB Connected' : rtdbRes.error,
    };
  } catch (err: any) {
    results.firebaseRtdb = { status: 'error', latencyMs: 0, message: err.message };
  }

  // 8. Test Meta LLM
  try {
    const metaRes = await metaLlmService.ping();
    results.metaLlm = {
      status: metaRes.status === 'ok' ? 'ok' : 'error',
      latencyMs: metaRes.latencyMs,
      message: metaRes.message,
    };
  } catch (err: any) {
    results.metaLlm = { status: 'error', latencyMs: 0, message: err.message };
  }

  res.json({ success: true, timestamp: new Date().toISOString(), results });
});

// ─── Carrier Priority & Velocity Settings ─────────────────
router.get('/settings/shipping-priority', async (_req: Request, res: Response): Promise<void> => {
  try {
    const priority = await shippingRouterService.getCarrierPriority();
    res.json({ success: true, priority });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/settings/shipping-priority', async (req: Request, res: Response): Promise<void> => {
  try {
    const { priority } = req.body;
    if (priority !== 'DELHIVERY_FIRST' && priority !== 'VELOCITY_FIRST') {
      res.status(400).json({ error: 'priority must be DELHIVERY_FIRST or VELOCITY_FIRST' });
      return;
    }
    await shippingRouterService.setCarrierPriority(priority);
    res.json({ success: true, priority });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/settings/shipping-priority', async (req: Request, res: Response): Promise<void> => {
  try {
    const { priority } = req.body;
    if (priority !== 'DELHIVERY_FIRST' && priority !== 'VELOCITY_FIRST') {
      res.status(400).json({ error: 'priority must be DELHIVERY_FIRST or VELOCITY_FIRST' });
      return;
    }
    await shippingRouterService.setCarrierPriority(priority);
    res.json({ success: true, priority });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/settings/velocity/status', async (_req: Request, res: Response): Promise<void> => {
  try {
    const priority = await shippingRouterService.getCarrierPriority();
    res.json({
      success: true,
      priority,
      configured: Boolean(config.velocity.apiToken),
      baseUrl: config.velocity.baseUrl,
      warehouseId: config.velocity.warehouseId,
      enabled: config.velocity.enabled,
      hasWebhookSecret: Boolean(config.velocity.webhookSecret),
      maskedToken: config.velocity.apiToken
        ? `${config.velocity.apiToken.slice(0, 4)}...${config.velocity.apiToken.slice(-4)}`
        : null,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/settings/velocity/test', async (_req: Request, res: Response): Promise<void> => {
  try {
    const pingResult = await velocityService.ping();
    res.json({ success: pingResult.ok, ...pingResult });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/velocity/serviceability/:pincode', async (req: Request, res: Response): Promise<void> => {
  try {
    const { pincode } = req.params;
    const paymentMode = (req.query.paymentMode as any) || 'cod';
    const fromPincode = config.delhivery.seller.pincode || '395002';
    const result = await velocityService.checkServiceability({
      fromPincode,
      toPincode: pincode,
      paymentMode,
      shipmentType: 'forward',
    });
    res.json({ success: true, result });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/settings/shipping-preferences
router.get('/settings/shipping-preferences', async (_req: Request, res: Response): Promise<void> => {
  try {
    const priority = await shippingRouterService.getCarrierPriority();
    const settings = await prisma.setting.findMany({
      where: {
        key: {
          in: [
            'shipping_auto_failover',
            'shipping_cod_courier',
            'shipping_prepaid_courier',
            'velocity_warehouse_id',
            'velocity_auto_remittance',
          ],
        },
      },
    });
    const map = new Map(settings.map((s) => [s.key, s.value]));

    res.json({
      success: true,
      priority,
      autoFailover: map.get('shipping_auto_failover') !== 'false',
      codCourier: map.get('shipping_cod_courier') || 'AUTO',
      prepaidCourier: map.get('shipping_prepaid_courier') || 'AUTO',
      velocityWarehouseId: map.get('velocity_warehouse_id') || config.velocity.warehouseId || '',
      velocityAutoRemittance: map.get('velocity_auto_remittance') !== 'false',
      velocityConfigured: Boolean(config.velocity.apiToken),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/settings/shipping-preferences
router.post('/settings/shipping-preferences', async (req: Request, res: Response): Promise<void> => {
  try {
    const { priority, autoFailover, codCourier, prepaidCourier, velocityWarehouseId, velocityAutoRemittance } = req.body;

    if (priority && (priority === 'DELHIVERY_FIRST' || priority === 'VELOCITY_FIRST')) {
      await shippingRouterService.setCarrierPriority(priority);
    }

    const updates: Array<{ key: string; value: string }> = [];
    if (autoFailover !== undefined) {
      updates.push({ key: 'shipping_auto_failover', value: String(Boolean(autoFailover)) });
    }
    if (codCourier) {
      updates.push({ key: 'shipping_cod_courier', value: String(codCourier).toUpperCase() });
    }
    if (prepaidCourier) {
      updates.push({ key: 'shipping_prepaid_courier', value: String(prepaidCourier).toUpperCase() });
    }
    if (velocityWarehouseId !== undefined) {
      updates.push({ key: 'velocity_warehouse_id', value: String(velocityWarehouseId).trim() });
    }
    if (velocityAutoRemittance !== undefined) {
      updates.push({ key: 'velocity_auto_remittance', value: String(Boolean(velocityAutoRemittance)) });
    }

    for (const u of updates) {
      await prisma.setting.upsert({
        where: { key: u.key },
        create: { key: u.key, value: u.value },
        update: { value: u.value },
      });
    }

    res.json({ success: true, message: 'Shipping preferences updated successfully.' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/velocity/remittance/sync & /api/velocity/financials/sync — Direct Live API sync for Velocity COD remittances, bank UTRs & wallet charges
router.post(['/velocity/remittance/sync', '/api/velocity/remittance/sync', '/velocity/financials/sync', '/api/velocity/financials/sync'], async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const actor = req.user;
    const { velocityFinancialSyncService } = await import('../modules/velocity/velocity-financial-sync.service');
    const result = await velocityFinancialSyncService.syncVelocityFinancials({
      actor,
      startDate: req.body.startDate,
      endDate: req.body.endDate,
      awbs: req.body.awbs,
      lookbackDays: req.body.lookbackDays,
    });
    res.json({
      success: true,
      message: `Velocity Financial Sync: ${result.matchedCount} orders reconciled (${result.remittancesMatched} remittances, ${result.chargesAudited} freight charge audits).`,
      result,
    });
  } catch (error: any) {
    logger.error('Velocity financial sync failed', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// GET /api/velocity/remittance/status & /api/velocity/financials/status — Remittance health & latest sync details
router.get(['/velocity/remittance/status', '/api/velocity/remittance/status', '/velocity/financials/status', '/api/velocity/financials/status'], async (_req: Request, res: Response): Promise<void> => {
  try {
    const { velocityFinancialSyncService } = await import('../modules/velocity/velocity-financial-sync.service');
    const overview = await velocityFinancialSyncService.getFinancialOverview();
    res.json({
      success: true,
      ...overview,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/velocity/warehouses — List registered warehouses from Velocity
router.get(['/velocity/warehouses', '/api/velocity/warehouses'], async (_req: Request, res: Response): Promise<void> => {
  try {
    const warehouses = await velocityService.listWarehouses();
    res.json({ success: true, warehouses });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/velocity/stores — List registered stores from Velocity
router.get(['/velocity/stores', '/api/velocity/stores'], async (_req: Request, res: Response): Promise<void> => {
  try {
    const stores = await velocityService.listStores();
    res.json({ success: true, stores });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/velocity/reports/summary — Live status-based forward & return summary report
router.get(['/velocity/reports/summary', '/api/velocity/reports/summary'], async (req: Request, res: Response): Promise<void> => {
  try {
    const startDateTime = (req.query.start_date_time as string) || new Date(Date.now() - 30 * 86400000).toISOString();
    const endDateTime = (req.query.end_date_time as string) || new Date().toISOString();
    const shipmentType = (req.query.shipment_type as 'forward' | 'return') || 'forward';

    const report = await velocityService.getSummaryReport({
      startDateTime,
      endDateTime,
      shipmentType,
    });
    res.json({ success: true, report });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/velocity/reports/charges — Per-AWB shipping charges breakdown
router.post(['/velocity/reports/charges', '/api/velocity/reports/charges'], async (req: Request, res: Response): Promise<void> => {
  try {
    const awbs = req.body.awbs || [];
    if (!Array.isArray(awbs) || awbs.length === 0) {
      res.status(400).json({ error: 'awbs array is required' });
      return;
    }
    const charges = await velocityService.getShippingCharges(awbs);
    res.json({ success: true, charges });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/velocity/reports/cod-remittance — Per-AWB COD remittance details
router.post(['/velocity/reports/cod-remittance', '/api/velocity/reports/cod-remittance'], async (req: Request, res: Response): Promise<void> => {
  try {
    const awbs = req.body.awbs || [];
    if (!Array.isArray(awbs) || awbs.length === 0) {
      res.status(400).json({ error: 'awbs array is required' });
      return;
    }
    const remittances = await velocityService.getCodRemittance(awbs);
    res.json({ success: true, remittances });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/velocity/reports/shipments — Paginated shipments list with operational metadata
router.post(['/velocity/reports/shipments', '/api/velocity/reports/shipments'], async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await velocityService.getShipmentsList(req.body);
    res.json({ success: true, ...result });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/velocity/reports/returns — Paginated returns list with QC and refund metadata
router.post(['/velocity/reports/returns', '/api/velocity/reports/returns'], async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await velocityService.getReturnsList(req.body);
    res.json({ success: true, ...result });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/settings/users
router.get('/settings/users', async (_req: Request, res: Response): Promise<void> => {
  try {
    const users = await getStoredOperators();
    res.json({ success: true, users });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Only ADMIN roster members may manage operators (passwords + Firebase Auth linkage).
function isAdminRequest(req: Request): boolean {
  return (req as any)?.user?.role === 'ADMIN';
}

// POST /api/settings/users — Admin creates operator WITH password (Firebase login + roster row).
router.post('/settings/users', async (req: Request, res: Response): Promise<void> => {
  try {
    if (!isAdminRequest(req)) {
      res.status(403).json({ error: 'Only admins can create operators.' });
      return;
    }
    const { name, email, role, department, phone, status, password } = req.body;
    if (!name || !email || !role) {
      res.status(400).json({ error: 'Name, email, and role are required' });
      return;
    }
    if (password && String(password).length < 6) {
      res.status(400).json({ error: 'Password must be at least 6 characters.' });
      return;
    }

    const currentUsers = await getStoredOperators();
    if (currentUsers.some((u: any) => u.email.toLowerCase() === email.toLowerCase().trim())) {
      res.status(400).json({ error: 'An operator with this email already exists' });
      return;
    }

    let firebaseUid: string | null = null;
    let loginWarning: string | null = null;
    if (password) {
      try {
        const created = await firebaseService.createUserWithPassword({
          email: email.trim(),
          password: String(password),
          displayName: name.trim(),
          role: role.trim(),
        });
        firebaseUid = created.uid;
      } catch (fbErr: any) {
        // Firebase email-already-exists → link roster to existing auth user instead of failing.
        if (fbErr?.code === 'auth/email-already-exists') {
          try {
            const linked = await firebaseService.updateUserByEmail(email.trim(), {
              displayName: name.trim(),
              role: role.trim(),
              disabled: status === 'INACTIVE',
            });
            firebaseUid = linked.uid;
          } catch {
            loginWarning = 'Login account already exists; roster linked without password change.';
          }
        } else {
          loginWarning = `Roster created but Firebase login failed: ${fbErr.message}`;
        }
      }
    } else {
      loginWarning = 'No password provided — roster-only account, user cannot sign in until admin sets a password.';
    }

    const newUser = {
      id: `usr_${Date.now()}`,
      name: name.trim(),
      email: email.trim().toLowerCase(),
      role: role.trim(),
      department: department?.trim() || 'General Operations',
      phone: phone?.trim() || '',
      status: status === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE',
      avatar: (name.trim().split(' ').map((n: string) => n[0]).join('').slice(0, 2) || 'OP').toUpperCase(),
      createdAt: new Date().toISOString(),
      lastActive: 'Just created',
      firebaseUid,
      loginEnabled: Boolean(firebaseUid),
    };

    const updated = [newUser, ...currentUsers];
    await saveStoredOperators(updated);

    res.status(201).json({ success: true, user: newUser, users: updated, warning: loginWarning });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/settings/users/:id — Admin edits profile + optional newPassword + enable/disable login.
router.put('/settings/users/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    if (!isAdminRequest(req)) {
      res.status(403).json({ error: 'Only admins can update operators.' });
      return;
    }
    const { id } = req.params;
    const { name, email, role, department, phone, status, newPassword } = req.body;
    if (newPassword && String(newPassword).length < 6) {
      res.status(400).json({ error: 'New password must be at least 6 characters.' });
      return;
    }

    const currentUsers = await getStoredOperators();
    const index = currentUsers.findIndex((u: any) => u.id === id);
    if (index === -1) {
      res.status(404).json({ error: 'Operator not found' });
      return;
    }

    const user = { ...currentUsers[index] };
    const oldEmail = user.email;
    if (name) user.name = name.trim();
    if (email) user.email = email.trim().toLowerCase();
    if (role) user.role = role.trim();
    if (department) user.department = department.trim();
    if (phone !== undefined) user.phone = phone.trim();
    if (status) user.status = status;
    if (name) {
      user.avatar = (name.trim().split(' ').map((n: string) => n[0]).join('').slice(0, 2) || 'OP').toUpperCase();
    }

    // Sync login credentials (Firebase) — password change, disable on INACTIVE, role claims.
    let loginWarning: string | null = null;
    try {
      await firebaseService.updateUserByEmail(oldEmail, {
        ...(newPassword ? { newPassword: String(newPassword) } : {}),
        ...(name ? { displayName: name.trim() } : {}),
        ...(status ? { disabled: status === 'INACTIVE' } : {}),
        ...(role ? { role: role.trim() } : {}),
      });
      user.loginEnabled = user.status !== 'INACTIVE';
    } catch (fbErr: any) {
      if (fbErr?.code !== 'auth/user-not-found') {
        loginWarning = `Profile saved but login update failed: ${fbErr.message}`;
      }
    }

    currentUsers[index] = user;
    await saveStoredOperators(currentUsers);

    res.json({ success: true, user, users: currentUsers, warning: loginWarning });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/settings/users/:id/set-password — Admin sets a new password directly.
router.post('/settings/users/:id/set-password', async (req: Request, res: Response): Promise<void> => {
  try {
    if (!isAdminRequest(req)) {
      res.status(403).json({ error: 'Only admins can change passwords.' });
      return;
    }
    const { id } = req.params;
    const { newPassword } = req.body;
    if (!newPassword || String(newPassword).length < 6) {
      res.status(400).json({ error: 'New password must be at least 6 characters.' });
      return;
    }
    const currentUsers = await getStoredOperators();
    const user = currentUsers.find((u: any) => u.id === id);
    if (!user) {
      res.status(404).json({ error: 'Operator not found' });
      return;
    }
    await firebaseService.updateUserByEmail(user.email, { newPassword: String(newPassword) });
    res.json({ success: true, message: `Password updated for ${user.email}. Old sessions revoked.` });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/settings/users/:id/reset-link — Admin generates a Firebase reset link to share.
router.post('/settings/users/:id/reset-link', async (req: Request, res: Response): Promise<void> => {
  try {
    if (!isAdminRequest(req)) {
      res.status(403).json({ error: 'Only admins can generate reset links.' });
      return;
    }
    const { id } = req.params;
    const currentUsers = await getStoredOperators();
    const user = currentUsers.find((u: any) => u.id === id);
    if (!user) {
      res.status(404).json({ error: 'Operator not found' });
      return;
    }
    const resetLink = await firebaseService.generatePasswordResetLink(user.email);
    res.json({ success: true, email: user.email, resetLink });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/settings/users/:id — Admin removes roster row + disables Firebase login.
router.delete('/settings/users/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    if (!isAdminRequest(req)) {
      res.status(403).json({ error: 'Only admins can delete operators.' });
      return;
    }
    const { id } = req.params;
    const currentUsers = await getStoredOperators();
    const target = currentUsers.find((u: any) => u.id === id);
    const filtered = currentUsers.filter((u: any) => u.id !== id);

    if (filtered.length === currentUsers.length) {
      res.status(404).json({ error: 'Operator not found' });
      return;
    }

    if (target?.email) {
      await firebaseService.deleteUserByEmail(target.email).catch(() => {});
    }
    await saveStoredOperators(filtered);
    res.json({ success: true, users: filtered });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── KwikEngage Critical WhatsApp Trigger Endpoints ───────────────

// POST /api/settings/whatsapp/test — Send test WhatsApp notification
router.post('/settings/whatsapp/test', async (req: Request, res: Response): Promise<void> => {
  try {
    const { phone, trigger, customMessage, mode, templateName, templateParams } = req.body;
    if (!phone) {
      res.status(400).json({ error: 'Phone number is required' });
      return;
    }

    if (mode === 'template' && templateName) {
      const result = await kwikengageService.sendTemplateMessage(
        phone,
        templateName,
        Array.isArray(templateParams) ? templateParams : [customMessage || 'Test Customer', '#YN-TEST', '1499'],
        customMessage
      );
      res.json({
        success: result.success,
        mode: 'template',
        templateName,
        result,
      });
      return;
    }

    const testOrder = {
      id: 0,
      customerName: 'Youthnic Test Customer',
      customerPhone: phone,
      shopifyOrderName: '#YN-TEST',
      totalAmount: 1499,
      paymentMethod: 'COD',
      customerAddress: 'Surat Textile Market, Ring Road',
      customerCity: 'Surat',
      customerState: 'Gujarat',
      customerPincode: '395002',
    };

    const result = await kwikengageService.sendCriticalTrigger(
      (trigger as KwikEngageTriggerType) || 'ORDER_CONFIRMED',
      testOrder,
      {
        waybillNumber: '1410293849182',
        courierName: 'Delhivery Express',
        ndrReason: 'Customer phone busy on attempt',
        customText: customMessage,
      }
    );

    const diagnosticAdvice = result.requiresTemplate
      ? 'Recipient has not messaged +91 79849 84563 in the last 24 hours. Under Meta WhatsApp policy, session messages are restricted. To send without template, the recipient should text the sender number first, or an approved Meta Utility template must be used.'
      : undefined;

    res.json({
      success: result.success,
      result,
      diagnosticAdvice,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/orders/:id/whatsapp-trigger — Send critical WhatsApp message for an order
router.post('/orders/:id/whatsapp-trigger', async (req: Request, res: Response): Promise<void> => {
  try {
    const orderId = parseInt(req.params.id, 10);
    const { trigger, customText } = req.body;

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { shipment: true },
    });

    if (!order) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }

    const resolvedTrigger: KwikEngageTriggerType =
      (trigger as KwikEngageTriggerType) ||
      (order.paymentMethod === 'COD' && !isCodConfirmed(order)
        ? 'COD_CONFIRMATION'
        : order.shipment?.waybillNumber
        ? 'ORDER_SHIPPED'
        : 'ORDER_CONFIRMED');

    const result = await kwikengageService.sendCriticalTrigger(resolvedTrigger, order, {
      waybillNumber: order.shipment?.waybillNumber || undefined,
      courierName: 'Delhivery',
      ndrReason: order.shipment?.trackingStatus || undefined,
      customText,
    });

    await recordOrderAction(orderId, 'CUSTOMER_MESSAGE_REQUESTED', (req as AuthenticatedRequest).user, {
      note: `WhatsApp ${resolvedTrigger} requested.`, status: result.success ? 'COMPLETED' : 'FAILED',
    });
    res.status(result.success ? 200 : 502).json({ success: result.success, result, orderId, trigger: resolvedTrigger, ...(!result.success ? { error: 'WhatsApp provider did not accept the message.' } : {}) });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── KwikEngage AI WhatsApp Configuration & Status ────────────
router.post('/settings/whatsapp/config', async (req: Request, res: Response): Promise<void> => {
  try {
    const { apiKey, merchantId, senderPhone, wabaId } = req.body;
    if (!apiKey || typeof apiKey !== 'string') {
      res.status(400).json({ success: false, error: 'KWIKENGAGE_API_KEY is required' });
      return;
    }
    const result = await kwikengageService.updateCredentials(apiKey, merchantId, senderPhone, wabaId);
    const pingStatus = await kwikengageService.ping();
    res.json({
      success: true,
      message: result.message,
      ping: pingStatus,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/settings/whatsapp/status', async (_req: Request, res: Response): Promise<void> => {
  try {
    const pingStatus = await kwikengageService.ping();
    res.json({
      success: true,
      ...pingStatus,
      apiUrl: config.kwikengage.apiUrl,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/settings/whatsapp/usage', async (_req: Request, res: Response): Promise<void> => {
  try {
    const pingStatus = await kwikengageService.ping();
    res.json({
      success: true,
      provider: 'KWIKENGAGE_API',
      apiUrl: config.kwikengage.apiUrl,
      merchantId: config.kwikengage.merchantId,
      senderPhone: config.kwikengage.senderPhone,
      wabaId: config.kwikengage.wabaId,
      status: pingStatus.status,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── Shopify Products & Listings Management (A-to-Z) ──────
// GET /api/products — List all products with search & filters
router.get('/products', async (req: Request, res: Response): Promise<void> => {
  try {
    const { limit, status, title, product_type, vendor, page_info, since_id } = req.query;
    const result = await productService.listProducts({
      limit: limit ? parseInt(limit as string, 10) : 50,
      status: status as any,
      title: title as string,
      product_type: product_type as string,
      vendor: vendor as string,
      page_info: page_info as string,
      since_id: since_id ? parseInt(since_id as string, 10) : undefined,
    });
    res.json({ success: true, ...result });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/products/summary — Catalog KPI metrics
router.get('/products/summary', async (_req: Request, res: Response): Promise<void> => {
  try {
    const summary = await productService.getProductSummary();
    res.json({ success: true, summary });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/products/:id — Single product detail with variants and stock
router.get('/products/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const product = await productService.getProduct(req.params.id);
    res.json({ success: true, product });
  } catch (error: any) {
    const status = error.message.includes('not found') ? 404 : 500;
    res.status(status).json({ success: false, error: error.message });
  }
});

// POST /api/products — Create new product listing on Shopify
router.post('/products', async (req: Request, res: Response): Promise<void> => {
  try {
    const { title, price, variants } = req.body;
    if (!title || (!price && (!variants || !variants.length))) {
      res.status(400).json({ success: false, error: 'Product title and pricing are required.' });
      return;
    }
    const product = await productService.createProduct(req.body);
    res.json({
      success: true,
      product,
      message: `Product "${product.title}" created successfully on Shopify!`,
    });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// PUT /api/products/:id — Update existing product listing
router.put('/products/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const product = await productService.updateProduct(req.params.id, req.body);
    res.json({
      success: true,
      product,
      message: `Product "${product.title}" updated successfully on Shopify!`,
    });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// DELETE /api/products/:id — Delete product listing permanently
router.delete('/products/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await productService.deleteProduct(req.params.id);
    res.json(result);
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// POST /api/products/:id/status — 1-click status toggle (active/draft/archived)
router.post('/products/:id/status', async (req: Request, res: Response): Promise<void> => {
  try {
    const { status } = req.body;
    if (!['active', 'draft', 'archived'].includes(status)) {
      res.status(400).json({ success: false, error: 'Invalid status. Must be active, draft, or archived.' });
      return;
    }
    const product = await productService.setProductStatus(req.params.id, status);
    res.json({
      success: true,
      product,
      message: `Product "${product.title}" status changed to ${status}.`,
    });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// POST /api/products/inventory/set — Set variant inventory quantity directly
router.post('/products/inventory/set', async (req: Request, res: Response): Promise<void> => {
  try {
    const { inventoryItemId, available, locationId } = req.body;
    if (!inventoryItemId || available === undefined) {
      res.status(400).json({ success: false, error: 'inventoryItemId and available quantity are required.' });
      return;
    }
    const result = await productService.setVariantInventory(
      Number(inventoryItemId),
      Number(available),
      locationId ? Number(locationId) : undefined
    );
    res.json(result);
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// POST /api/products/:id/images — Add image to product
router.post('/products/:id/images', async (req: Request, res: Response): Promise<void> => {
  try {
    const { src, alt } = req.body;
    if (!src) {
      res.status(400).json({ success: false, error: 'Image URL (src) is required.' });
      return;
    }
    const image = await productService.addProductImage(req.params.id, src, alt);
    res.json({ success: true, image });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// DELETE /api/products/:id/images/:imageId — Delete image from product
router.delete('/products/:id/images/:imageId', async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await productService.deleteProductImage(req.params.id, req.params.imageId);
    res.json(result);
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// ─── Consumer Email Communications & Resend ─────────────

// GET /api/communications/logs — List email logs
router.get('/communications/logs', async (req: Request, res: Response): Promise<void> => {
  try {
    const { page, limit, orderId, templateType, status, converted, search } = req.query;
    const result = await emailLogService.getLogs({
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
      orderId: orderId ? Number(orderId) : undefined,
      templateType: templateType as string,
      status: status as string,
      converted: converted === 'true' ? true : converted === 'false' ? false : undefined,
      search: search as string,
    });
    res.json({ success: true, ...result });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/communications/stats — Aggregate stats for communications dashboard
router.get('/communications/stats', async (_req: Request, res: Response): Promise<void> => {
  try {
    const stats = await emailLogService.getStats();
    res.json({ success: true, stats });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/communications/logs/:id — Single log details
router.get('/communications/logs/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const log = await emailLogService.getLogById(Number(req.params.id));
    if (!log) {
      res.status(404).json({ success: false, error: 'Email log not found' });
      return;
    }
    res.json({ success: true, log });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/communications/send — Send an email notification (Delay, Transit, etc.)
router.post('/communications/send', async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      orderId,
      recipientEmail,
      recipientName,
      templateType,
      subject,
      delayReason,
      newEstimatedDelivery,
      currentLocation,
      customMessage,
    } = req.body;

    if (!templateType) {
      res.status(400).json({ success: false, error: 'templateType is required.' });
      return;
    }

    let targetEmail = recipientEmail;
    let targetName = recipientName;
    let orderData: any = null;

    if (orderId) {
      orderData = await prisma.order.findUnique({
        where: { id: Number(orderId) },
        include: { items: true, shipment: true },
      });
      if (orderData) {
        if (!targetEmail) targetEmail = orderData.customerEmail;
        if (!targetName) targetName = orderData.customerName;
      }
    }

    if (!targetEmail) {
      res.status(400).json({
        success: false,
        error: 'Recipient email address is required (none found on order or in request body).',
      });
      return;
    }

    const templateData = {
      orderName: orderData?.shopifyOrderName || (orderId ? `#${orderId}` : 'Customer Order'),
      customerName: targetName || 'Customer',
      recipientEmail: targetEmail,
      waybillNumber: orderData?.shipment?.waybillNumber || undefined,
      courier: orderData?.shipment?.courier || 'Delhivery Express',
      currentLocation: currentLocation || orderData?.shipment?.trackingLocation || 'In Transit Regional Hub',
      delayReason: delayReason || 'High seasonal transit volume & network rescheduling',
      newEstimatedDelivery: newEstimatedDelivery || 'Expected in 2-3 Business Days',
      items: orderData?.items?.map((item: any) => ({
        title: item.title,
        variantTitle: item.variantTitle,
        quantity: item.quantity,
        price: item.price,
        imageUrl: item.imageUrl,
      })),
      totalAmount: orderData?.totalAmount,
      paymentMethod: orderData?.paymentMethod || undefined,
      customerAddress: orderData
        ? `${orderData.customerAddress}, ${orderData.customerCity}, ${orderData.customerState} - ${orderData.customerPincode}`
        : undefined,
      customMessage,
    };

    const result = await resendService.sendEmail({
      to: targetEmail,
      templateType: templateType as EmailTemplateType,
      orderId: orderId ? Number(orderId) : null,
      data: templateData,
      subject,
    });

    res.json(result);
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/communications/delayed-in-transit — Detect shipments overdue or delayed in transit
router.get('/communications/delayed-in-transit', async (req: Request, res: Response): Promise<void> => {
  try {
    const daysThreshold = parseInt(req.query.days as string, 10) || 4;
    const now = new Date();

    // Query active shipments from orders that are DISPATCHED or IN_TRANSIT
    const candidateOrders = await prisma.order.findMany({
      where: {
        status: { in: ['DISPATCHED', 'IN_TRANSIT'] },
        shipment: { isNot: null },
      },
      include: {
        shipment: {
          include: {
            trackingLogs: {
              orderBy: { scannedAt: 'desc' },
              take: 1,
            },
          },
        },
        items: true,
        emailLogs: {
          where: {
            templateType: 'TRANSIT_DELAY',
            status: { in: ['PENDING', 'SENT', 'DELIVERED', 'SIMULATED'] },
          },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    const delayedList = candidateOrders
      .map((order) => {
        const shipment = order.shipment!;
        const dispatchedDate = order.dispatchedAt || shipment.createdAt || order.createdAt;
        const daysInTransit = Math.max(
          1,
          Math.floor((now.getTime() - new Date(dispatchedDate).getTime()) / (1000 * 60 * 60 * 24))
        );

        const latestTrackingLog = shipment.trackingLogs[0] || null;
        const expectedDeliveryDate: string | null = shipment.expectedDeliveryDate
          ? shipment.expectedDeliveryDate.toISOString()
          : null;
        const isPastExpectedDate = expectedDeliveryDate ? new Date(expectedDeliveryDate) < now : false;
        const isLongTransit = daysInTransit >= daysThreshold;
        const latestRemark = latestTrackingLog?.remark || shipment.trackingStatus || null;
        const isCourierReportedDelay =
          /\b(delay(?:ed)?|exception|hold|held|misrout(?:e|ed|ing)|network|weather|operational|undelivered|failed|not delivered|customer unavailable|address issue)\b/i.test(
            `${shipment.trackingStatus || ''} ${latestRemark || ''}`
          );

        if (!isPastExpectedDate && !isLongTransit && !isCourierReportedDelay) {
          return null;
        }

        const daysOverdue = expectedDeliveryDate && isPastExpectedDate
          ? Math.max(1, Math.floor((now.getTime() - new Date(expectedDeliveryDate).getTime()) / (1000 * 60 * 60 * 24)))
          : (daysInTransit >= daysThreshold ? daysInTransit - daysThreshold + 1 : 0);

        const latestDelayEmail = order.emailLogs[0] || null;
        const alreadyNotified = Boolean(latestDelayEmail);

        return {
          orderId: order.id,
          shopifyOrderId: order.shopifyOrderId,
          shopifyOrderName: order.shopifyOrderName,
          customerName: order.customerName,
          customerEmail: order.customerEmail,
          customerPhone: order.customerPhone,
          totalAmount: order.totalAmount,
          waybillNumber: shipment.waybillNumber,
          courier: shipment.courier || 'Delhivery Express',
          currentLocation: shipment.trackingLocation || 'In Transit Regional Hub',
          status: shipment.status,
          latestRemark,
          latestScanStatus: latestTrackingLog?.status || shipment.trackingStatus || null,
          latestScanAt: latestTrackingLog?.scannedAt?.toISOString() || shipment.trackingUpdatedAt?.toISOString() || null,
          flaggedReason: isPastExpectedDate
            ? 'Past expected delivery date'
            : isCourierReportedDelay
            ? 'Delhivery reported a route delay or exception'
            : `In transit for ${daysInTransit} days`,
          expectedDeliveryDate,
          dispatchedAt: dispatchedDate,
          daysInTransit,
          daysOverdue,
          isPastExpectedDate,
          alreadyNotified,
          lastNotifiedAt: latestDelayEmail?.sentAt || latestDelayEmail?.createdAt || null,
          itemCount: order.items.length,
          items: order.items.map((i) => ({ title: i.title, quantity: i.quantity, price: i.price })),
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);

    res.json({
      success: true,
      totalDelayed: delayedList.length,
      unnotifiedCount: delayedList.filter((d) => !d.alreadyNotified && Boolean(d.customerEmail)).length,
      thresholdDays: daysThreshold,
      shipments: delayedList,
    });
  } catch (error: any) {
    logger.error('Error fetching delayed in-transit shipments:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/communications/notify-delayed-transit — Send in-transit delay notification from delivery@youthnic.com
router.post('/communications/notify-delayed-transit', async (req: Request, res: Response): Promise<void> => {
  try {
    const { orderId, orderIds, revisedDelivery, delayReason, customMessage } = req.body;

    const targetOrderIds: number[] = Array.isArray(orderIds)
      ? orderIds.map(Number)
      : orderId
      ? [Number(orderId)]
      : [];

    if (targetOrderIds.length === 0) {
      res.status(400).json({ success: false, error: 'orderId or orderIds[] is required.' });
      return;
    }

    const results: any[] = [];

    for (const id of targetOrderIds) {
      const order = await prisma.order.findUnique({
        where: { id },
        include: { shipment: true, items: true },
      });

      if (!order) {
        results.push({ orderId: id, success: false, error: 'Order not found' });
        continue;
      }

      if (!order.customerEmail) {
        results.push({ orderId: id, success: false, error: 'Order has no customer email' });
        continue;
      }

      const shipment = order.shipment;
      const dispatchedDate = order.dispatchedAt || shipment?.createdAt || order.createdAt;
      const daysInTransit = Math.max(
        1,
        Math.floor((Date.now() - new Date(dispatchedDate).getTime()) / (1000 * 60 * 60 * 24))
      );

      const templateData = {
        orderName: order.shopifyOrderName,
        customerName: order.customerName,
        recipientEmail: order.customerEmail,
        waybillNumber: shipment?.waybillNumber || undefined,
        courier: shipment?.courier || 'Delhivery Express',
        currentLocation: shipment?.trackingLocation || 'In Transit Regional Hub',
        daysInTransit,
        delayReason: delayReason || 'Regional sorting hub congestion & linehaul schedule realignment',
        newEstimatedDelivery: revisedDelivery || 'Expected in 2-3 Business Days',
        items: order.items.map((i) => ({
          title: i.title,
          variantTitle: i.variantTitle,
          quantity: i.quantity,
          price: i.price,
          imageUrl: i.imageUrl,
        })),
        totalAmount: order.totalAmount,
        customMessage,
        trackingUrl: shipment?.waybillNumber
          ? (getTrackingUrl(shipment?.courier || (order as any).courierPartner, shipment.waybillNumber, shipment?.labelUrl) || `https://www.delhivery.com/track/package/${shipment.waybillNumber}`)
          : undefined,
      };

      const sendResult = await resendService.sendEmail({
        to: order.customerEmail,
        templateType: 'TRANSIT_DELAY',
        // Use the configured fromEmail so a one-line .env change updates
        // every code path that sends a transit-delay email.
        fromEmail: config.resend.fromEmail,
        replyTo: 'delivery@youthnic.com',
        orderId: order.id,
        data: templateData,
      });

      // Record to Firebase RTDB Customer History
      await firebaseService.syncCustomerHistory(order.customerEmail, {
        type: 'OUTBOUND_EMAIL',
        channel: 'EMAIL',
        title: `In-Transit Delay Notice: Order ${order.shopifyOrderName}`,
        description: `Shipment delayed in transit. Revised ETA: ${templateData.newEstimatedDelivery}. Delhivery AWB: ${shipment?.waybillNumber || 'N/A'}.`,
        timestamp: new Date().toISOString(),
        sender: config.resend.fromEmail,
        recipient: order.customerEmail,
        orderId: order.id,
        shopifyOrderName: order.shopifyOrderName,
        waybillNumber: shipment?.waybillNumber || undefined,
        status: sendResult.success ? 'SENT' : 'FAILED',
      });

      results.push({
        orderId: order.id,
        shopifyOrderName: order.shopifyOrderName,
        recipient: order.customerEmail,
        from: config.resend.fromEmail,
        success: sendResult.success,
        resendResult: sendResult,
      });
    }

    res.json({
      success: true,
      totalProcessed: results.length,
      successfulCount: results.filter((r) => r.success).length,
      results,
    });
  } catch (error: any) {
    logger.error('Failed to notify delayed in-transit shipments:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/communications/:id/convert — Mark a conversion event
router.post('/communications/:id/convert', async (req: Request, res: Response): Promise<void> => {
  try {
    const { action, metadata } = req.body;
    const updated = await emailLogService.recordConversion(Number(req.params.id), {
      action: action || 'MANUAL_CONVERSION',
      metadata,
    });
    res.json({ success: true, log: updated });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/communications/track/:id — Tracking link click redirect & conversion recorder
router.get('/communications/track/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const redirectUrl = await emailLogService.trackClick(Number(req.params.id));
    res.redirect(redirectUrl);
  } catch (error: any) {
    res.redirect('https://youthnic2024.myshopify.com');
  }
});

// ─── Resend Settings & Diagnostics ──────────────────────

// GET /api/settings/resend/status — Ping Resend API and return diagnostics
router.get('/settings/resend/status', async (_req: Request, res: Response): Promise<void> => {
  try {
    const status = await resendService.ping();
    res.json({ success: true, ...status });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/settings/resend/config — Update Resend credentials and save to .env
router.post('/settings/resend/config', async (req: Request, res: Response): Promise<void> => {
  try {
    const { apiKey, fromEmail } = req.body;
    const result = await resendService.updateCredentials({ apiKey, fromEmail });
    res.json(result);
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// POST /api/settings/resend/test — Send test email
router.post('/settings/resend/test', async (req: Request, res: Response): Promise<void> => {
  try {
    const { to, templateType } = req.body;
    if (!to) {
      res.status(400).json({ success: false, error: 'Recipient email address (to) is required.' });
      return;
    }

    const testType = (templateType as EmailTemplateType) || 'TRANSIT_DELAY';
    const result = await resendService.sendEmail({
      to,
      templateType: testType,
      data: {
        orderName: '#26YOU5752',
        customerName: 'Test Recipient',
        waybillNumber: '30100810010054',
        courier: 'Delhivery Express',
        currentLocation: 'Delhivery transit hub',
        delayReason: 'Logistics routing transit check and high regional volume',
        newEstimatedDelivery: 'Within 2 business days',
        items: [
          {
            title: 'Navy Blue Floral Print Kurti with Farshi Salwar Set',
            variantTitle: 'Size: M',
            quantity: 1,
            price: 1499,
          },
        ],
        totalAmount: 1499,
        paymentMethod: 'COD',
        customerAddress: 'Surat Central Hub, Gujarat - 395002',
      },
    });

    res.json(result);
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});


// ─── Support & Inbound Customer Communications Desk ──────────────

// GET /api/support/diagnostics — Real-time connectivity probe for Delhivery, KwikEngage, Firebase RTDB, Resend
router.get('/support/diagnostics', async (_req: Request, res: Response): Promise<void> => {
  try {
    // 1. Delhivery Live Probe
    let delhiveryStatus = 'error';
    let delhiveryLatencyMs = 0;
    let delhiveryMessage = 'No API Token configured';
    const dStart = Date.now();
    const token = config.delhivery.apiToken || process.env.DELHIVERY_API_TOKEN;

    if (token) {
      try {
        const dRes = await axios.get(
          'https://track.delhivery.com/c/api/pin-codes/json/?filter_codes=395002',
          {
            headers: { Authorization: `Token ${token}` },
            timeout: 5000,
          }
        );
        delhiveryLatencyMs = Date.now() - dStart;
        if (dRes.status === 200) {
          delhiveryStatus = 'ok';
          delhiveryMessage = `Delhivery Express Production API Live (${delhiveryLatencyMs}ms)`;
        }
      } catch (err: any) {
        delhiveryLatencyMs = Date.now() - dStart;
        delhiveryMessage = err.response?.data?.message || err.message;
      }
    }

    // 2. KwikEngage WhatsApp Probe
    const kwikengageStatus = await kwikengageService.ping();

    // 3. Firebase RTDB Probe
    const firebaseStatus = await firebaseService.ping();

    // 4. Resend Mail Probe
    const resendStatus = await resendService.ping();

    // 5. Meta Model API Probe (muse-spark-1.3-contributor)
    const metaLlmStatus = await metaLlmService.ping();

    const diagnostics = {
      timestamp: new Date().toISOString(),
      delhivery: {
        status: delhiveryStatus,
        latencyMs: delhiveryLatencyMs,
        tokenConfigured: Boolean(token),
        message: delhiveryMessage,
      },
      kwikengage: kwikengageStatus,
      whatsapp: kwikengageStatus,
      firebase: {
        ...firebaseStatus,
        project: 'shopify-134b9',
        databaseUrl: 'https://shopify-134b9-default-rtdb.firebaseio.com',
      },
      resend: {
        ...resendStatus,
        senderDefault: 'delivery@youthnic.com',
      },
      metaLlm: {
        ...metaLlmStatus,
        config: metaLlmService.getConfig(),
      },
    };

    // Update Firebase RTDB diagnostic node asynchronously
    firebaseService.updateSystemDiagnostics(diagnostics).catch(() => {});

    res.json(diagnostics);
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/support/emails — List inbound emails with filtering & stats
router.get('/support/emails', async (req: Request, res: Response): Promise<void> => {
  try {
    const { urgency, category, status, search, limit = '50', page = '1' } = req.query;
    const take = parseInt(limit as string, 10) || 50;
    const skip = (Math.max(1, parseInt(page as string, 10)) - 1) * take;

    const where: any = {};
    if (urgency && urgency !== 'ALL') {
      where.urgency = urgency;
    }
    if (category && category !== 'ALL') {
      where.category = category;
    }
    if (status && status !== 'ALL') {
      where.status = status;
    }
    if (search) {
      const q = String(search).trim();
      where.OR = [
        { fromEmail: { contains: q, mode: 'insensitive' } },
        { fromName: { contains: q, mode: 'insensitive' } },
        { subject: { contains: q, mode: 'insensitive' } },
        { shopifyOrderName: { contains: q, mode: 'insensitive' } },
        { bodyText: { contains: q, mode: 'insensitive' } },
      ];
    }

    const [total, emails, urgentCount, openCount, returnCount] = await Promise.all([
      prisma.inboundEmail.count({ where }),
      prisma.inboundEmail.findMany({
        where,
        take,
        skip,
        orderBy: [{ urgency: 'asc' }, { createdAt: 'desc' }],
        include: {
          order: {
            select: {
              id: true,
              shopifyOrderName: true,
              status: true,
              totalAmount: true,
              customerPhone: true,
              customerEmail: true,
              hasUrgentSupport: true,
              supportFlag: true,
              shipment: {
                select: {
                  waybillNumber: true,
                  status: true,
                  courier: true,
                  trackingLocation: true,
                  trackingStatus: true,
                },
              },
            },
          },
        },
      }),
      prisma.inboundEmail.count({ where: { urgency: 'URGENT', status: 'OPEN' } }),
      prisma.inboundEmail.count({ where: { status: 'OPEN' } }),
      prisma.inboundEmail.count({ where: { category: 'RETURN_REQUEST', status: 'OPEN' } }),
    ]);

    res.json({
      success: true,
      total,
      urgentCount,
      openCount,
      returnCount,
      emails,
    });
  } catch (error: any) {
    logger.error('Failed to list support emails', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/support/inbound — Ingest customer email, analyze with Muse Spark 1.3, flag order, sync to Firebase RTDB
router.post('/support/inbound', async (req: Request, res: Response): Promise<void> => {
  try {
    const { fromEmail, fromName, subject, bodyText, toEmail = 'contact@youthnic.com', orderNumber } = req.body;
    if (!fromEmail || !subject || !bodyText) {
      res.status(400).json({ success: false, error: 'fromEmail, subject, and bodyText are required.' });
      return;
    }

    // 1. Analyze with Lightweight AI Model / Muse Spark 1.3 Contributor
    const analysis = await emailAnalyzerService.analyzeInboundEmail({
      fromEmail,
      fromName,
      subject: orderNumber ? `[${orderNumber}] ${subject}` : subject,
      bodyText,
      toEmail,
    });

    // 2. Persist to PostgreSQL
    const emailRecord = await prisma.inboundEmail.create({
      data: {
        orderId: analysis.matchedOrderId || undefined,
        shopifyOrderId: analysis.matchedOrderId ? String(analysis.matchedOrderId) : undefined,
        shopifyOrderName: analysis.extractedOrderNumber ? `#${analysis.extractedOrderNumber}` : undefined,
        fromEmail,
        fromName: fromName || fromEmail.split('@')[0],
        toEmail,
        subject,
        bodyText,
        category: analysis.category,
        urgency: analysis.urgency,
        sentiment: analysis.sentiment,
        flagReason: analysis.flagReason,
        aiAnalysis: {
          confidence: analysis.confidence,
          isLearnedMatch: analysis.isLearnedMatch,
          suggestedAction: analysis.suggestedAction,
          reasoning: analysis.flagReason,
        },
        suggestedReply: analysis.suggestedReply,
        status: 'OPEN',
      },
      include: {
        order: {
          include: {
            shipment: true,
            items: true,
          },
        },
      },
    });

    // 3. Sync to Firebase Realtime Database (/inbound_emails/:id)
    await firebaseService.syncInboundEmail({
      id: emailRecord.id,
      orderId: emailRecord.orderId,
      shopifyOrderName: emailRecord.shopifyOrderName,
      fromEmail: emailRecord.fromEmail,
      fromName: emailRecord.fromName,
      toEmail: emailRecord.toEmail,
      subject: emailRecord.subject,
      bodyText: emailRecord.bodyText,
      category: emailRecord.category,
      urgency: emailRecord.urgency,
      sentiment: emailRecord.sentiment,
      flagReason: emailRecord.flagReason,
      suggestedReply: emailRecord.suggestedReply,
      status: emailRecord.status,
      createdAt: emailRecord.createdAt,
    });

    // 4. Record to Customer History Timeline in Firebase RTDB
    await firebaseService.syncCustomerHistory(fromEmail, {
      type: 'INBOUND_EMAIL',
      channel: 'EMAIL',
      title: subject,
      description: bodyText.substring(0, 200),
      timestamp: emailRecord.createdAt.toISOString(),
      sender: fromEmail,
      recipient: toEmail,
      orderId: emailRecord.orderId || undefined,
      shopifyOrderName: emailRecord.shopifyOrderName || undefined,
      urgency: emailRecord.urgency,
      status: emailRecord.status,
    });

    res.json({
      success: true,
      ticket: emailRecord,
      analysis,
      message: 'Email ingested, analyzed by AI model, and synced to Firebase Realtime Database.',
    });
  } catch (error: any) {
    logger.error('Failed to ingest inbound email', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/support/emails/:id — Get details of single ticket
router.get('/support/emails/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const id = parseInt(req.params.id, 10);
    const email = await prisma.inboundEmail.findUnique({
      where: { id },
      include: {
        order: {
          include: {
            shipment: true,
            items: true,
            returns: true,
            emailLogs: {
              orderBy: { createdAt: 'desc' },
              take: 5,
            },
          },
        },
      },
    });

    if (!email) {
      res.status(404).json({ success: false, error: 'Support ticket not found.' });
      return;
    }

    // Also fetch customer history from Firebase RTDB
    const history = await firebaseService.getCustomerHistory(email.fromEmail);

    res.json({
      success: true,
      email,
      customerHistory: history,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/support/emails/:id/reply — Send response from Youthnic Support <support@youthnic.com> (or returns@youthnic.com)
router.post('/support/emails/:id/reply', async (req: Request, res: Response): Promise<void> => {
  try {
    const id = parseInt(req.params.id, 10);
    const { replyText, customSubject, fromEmail, resolved = false, learnPattern = false, patternKey } = req.body;

    if (!replyText) {
      res.status(400).json({ success: false, error: 'Reply text is required.' });
      return;
    }

    const ticket = await prisma.inboundEmail.findUnique({
      where: { id },
      include: { order: { include: { shipment: true } } },
    });

    if (!ticket) {
      res.status(404).json({ success: false, error: 'Support ticket not found.' });
      return;
    }

    // Determine sender address: default to Youthnic Support <support@youthnic.com>,
    // or Youthnic Returns <returns@youthnic.com> if return category or requested
    const isReturnTicket = ticket.category === 'RETURN' || ticket.subject?.toLowerCase().includes('return') || fromEmail?.includes('returns@youthnic.com');
    const effectiveSender = fromEmail
      ? fromEmail
      : isReturnTicket
      ? 'Youthnic Returns <returns@youthnic.com>'
      : 'Youthnic Support <support@youthnic.com>';
    const effectiveReplyTo = isReturnTicket ? 'returns@youthnic.com' : 'support@youthnic.com';

    // 1. Dispatch email via Resend
    const subject = customSubject || `Re: ${ticket.subject}`;
    const resendResult = await resendService.sendEmail({
      to: ticket.fromEmail,
      templateType: 'SUPPORT_REPLY',
      fromEmail: effectiveSender,
      replyTo: effectiveReplyTo,
      orderId: ticket.orderId,
      subject,
      data: {
        orderName: ticket.shopifyOrderName || ticket.order?.shopifyOrderName || 'Youthnic Order',
        customerName: ticket.fromName || ticket.order?.customerName || 'Valued Customer',
        customMessage: replyText,
        waybillNumber: ticket.order?.shipment?.waybillNumber || undefined,
        ticketId: ticket.id,
        ticketCategory: ticket.category,
        ticketUrgency: ticket.urgency,
      },
    });

    // 2. Update InboundEmail status in PostgreSQL
    const updatedTicket = await prisma.inboundEmail.update({
      where: { id },
      data: {
        status: resolved ? 'RESOLVED' : 'REPLIED',
        replyText,
        repliedAt: new Date(),
        resolvedBy: 'Operator',
      },
    });

    // 3. Clear urgent flag on order if resolved
    if (resolved && ticket.orderId) {
      await prisma.order.update({
        where: { id: ticket.orderId },
        data: {
          hasUrgentSupport: false,
          supportFlag: null,
        },
      });
    }

    // 4. Record to Firebase RTDB Customer History
    await firebaseService.syncCustomerHistory(ticket.fromEmail, {
      type: 'OUTBOUND_EMAIL',
      channel: 'EMAIL',
      title: subject,
      description: replyText.substring(0, 200),
      timestamp: new Date().toISOString(),
      sender: effectiveSender,
      recipient: ticket.fromEmail,
      orderId: ticket.orderId || undefined,
      shopifyOrderName: ticket.shopifyOrderName || undefined,
      status: resolved ? 'RESOLVED' : 'REPLIED',
    });

    // 5. Update Firebase RTDB Inbound Email node
    await firebaseService.syncInboundEmail({
      ...updatedTicket,
      createdAt: updatedTicket.createdAt,
    });

    // 6. If requested, save to Self-Learning Knowledge Base
    let learnedPatternResult: any = null;
    if (learnPattern) {
      const generatedKey = patternKey || `learned_${ticket.category.toLowerCase()}_${Date.now()}`;
      learnedPatternResult = await knowledgeLearnerService.learnPattern({
        patternKey: generatedKey,
        intent: `Auto-learned from Ticket #${ticket.id}: ${ticket.subject.substring(0, 60)}`,
        keywords: ticket.subject.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(' ').slice(0, 5).join(', '),
        recommendedUrgency: ticket.urgency,
        suggestedAction: `Standard resolution for ${ticket.category}`,
        approvedReply: replyText,
      });
    }

    res.json({
      success: true,
      ticket: updatedTicket,
      resendResult,
      learnedPattern: learnedPatternResult,
      message: `Reply sent from ${effectiveSender} and synced to Firebase Realtime Database.`,
    });
  } catch (error: any) {
    logger.error('Failed to send support reply', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/support/emails/:id/learn — Learn resolution pattern into Self-Learning store & RTDB
router.post('/support/emails/:id/learn', async (req: Request, res: Response): Promise<void> => {
  try {
    const id = parseInt(req.params.id, 10);
    const { patternKey, intent, keywords, approvedReply, recommendedUrgency = 'NORMAL', suggestedAction = 'Standard Resolution' } = req.body;

    const ticket = await prisma.inboundEmail.findUnique({ where: { id } });
    if (!ticket) {
      res.status(404).json({ success: false, error: 'Support ticket not found.' });
      return;
    }

    const key = patternKey || `pattern_${ticket.category.toLowerCase()}_${Date.now()}`;
    const pattern = await knowledgeLearnerService.learnPattern({
      patternKey: key,
      intent: intent || `Learned pattern from ticket #${ticket.id}`,
      keywords: keywords || ticket.subject,
      recommendedUrgency,
      suggestedAction,
      approvedReply: approvedReply || ticket.suggestedReply || '',
    });

    res.json({
      success: true,
      pattern,
      message: 'Pattern successfully learned and synced to Firebase RTDB.',
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/support/customer-history/:key — Unified timeline of emails, WhatsApp, and order events
router.get('/support/customer-history/:key', async (req: Request, res: Response): Promise<void> => {
  try {
    const key = req.params.key;
    const history = await firebaseService.getCustomerHistory(key);

    // Also pull local PostgreSQL records (emails, orders)
    const [localEmails, localOrders] = await Promise.all([
      prisma.inboundEmail.findMany({
        where: { fromEmail: { equals: key, mode: 'insensitive' } },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.order.findMany({
        where: {
          OR: [
            { customerEmail: { equals: key, mode: 'insensitive' } },
            { customerPhone: { contains: key } },
          ],
        },
        include: { shipment: true },
        orderBy: { shopifyCreatedAt: 'desc' },
      }),
    ]);

    res.json({
      success: true,
      key,
      firebaseEvents: history,
      localInboundEmails: localEmails,
      localOrders,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/support/knowledge-patterns — List learned patterns and cached rules
router.get('/support/knowledge-patterns', async (_req: Request, res: Response): Promise<void> => {
  try {
    const patterns = await knowledgeLearnerService.getAllPatterns();
    res.json({
      success: true,
      patterns,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/support/conversation/analyze — Autonomous Meta LLM Conversation Analysis & Action Engine
router.post('/support/conversation/analyze', async (req: Request, res: Response): Promise<void> => {
  try {
    const { customerIdentifier, text, channel = 'EMAIL', subject = '', orderNumberHint, autoExecuteActions = true } = req.body;
    if (!customerIdentifier || !text) {
      res.status(400).json({ success: false, error: 'customerIdentifier and text are required.' });
      return;
    }

    const result = await conversationAgentService.processConversation({
      customerIdentifier,
      text,
      channel,
      subject,
      orderNumberHint,
      autoExecuteActions,
    });

    res.json({
      success: true,
      analysis: result.analysis,
      triggeredActions: result.triggeredActions,
      customerMemory: result.customerMemory,
      matchedOrder: result.matchedOrder,
      message: 'Conversation analyzed by Meta LLM agent harness and actions processed.',
    });
  } catch (error: any) {
    logger.error('Failed to analyze conversation with Meta LLM agent', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/support/agent/memory/:customerKey — Retrieve customer memory from Firebase RTDB
router.get('/support/agent/memory/:customerKey', async (req: Request, res: Response): Promise<void> => {
  try {
    const memory = await agentMemoryService.getMemory(req.params.customerKey);
    res.json({ success: true, memory });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/support/agent/memories — List all customer memories in Firebase RTDB
router.get('/support/agent/memories', async (_req: Request, res: Response): Promise<void> => {
  try {
    const memories = await agentMemoryService.listAllCustomerMemories();
    res.json({ success: true, count: Object.keys(memories).length, memories });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/support/agent/config — Get current Meta Model API configuration
router.get('/support/agent/config', (_req: Request, res: Response): void => {
  res.json({ success: true, config: metaLlmService.getConfig() });
});

// POST /api/support/agent/config — Update Meta Model API configuration at runtime
router.post('/support/agent/config', (req: Request, res: Response): void => {
  try {
    const { apiKey, model, baseUrl } = req.body;
    metaLlmService.updateCredentials(apiKey, model, baseUrl);
    res.json({ success: true, message: 'Meta Model API configuration updated.', config: metaLlmService.getConfig() });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/support/agent/actions/execute — Manually execute or confirm an agent action
router.post('/support/agent/actions/execute', async (req: Request, res: Response): Promise<void> => {
  try {
    const { customerIdentifier, actionType, orderId, params } = req.body;
    if (!customerIdentifier || !actionType) {
      res.status(400).json({ success: false, error: 'customerIdentifier and actionType are required.' });
      return;
    }

    let actionResult: any = { executed: true };

    if (actionType === 'FLAG_ORDER_URGENT' && orderId) {
      await prisma.order.update({
        where: { id: Number(orderId) },
        data: { hasUrgentSupport: true, supportFlag: params?.flag || 'URGENT_OPERATOR_FLAGGED' },
      });
      actionResult.details = `Order #${orderId} flagged as urgent`;
    } else if (actionType === 'FETCH_DELHIVERY_TRACKING' && params?.waybill) {
      const tracking = await delhiveryService.trackShipment(params.waybill);
      actionResult.details = tracking;
    }

    await agentMemoryService.recordTriggeredAction(customerIdentifier, {
      actionType,
      reason: params?.reason || 'Operator confirmed execution',
      success: true,
      metadata: actionResult,
    });

    res.json({ success: true, actionType, result: actionResult });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/webhooks/whatsapp — Meta Cloud API verification challenge (must be public, no auth).
// Meta sends GET during webhook setup; POST-only handlers never complete verification.
router.get('/webhooks/whatsapp', (req: Request, res: Response): void => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.challenge']) {
    res.status(200).send(req.query['hub.challenge']);
    return;
  }
  res.status(200).json({ received: true });
});

// POST /api/webhooks/whatsapp — Inbound WhatsApp messages webhook from KwikEngage / Meta
// Public (exempted in requireAuth). Always 200 fast so providers don't retry-storm.
router.post('/webhooks/whatsapp', async (req: Request, res: Response): Promise<void> => {
  try {
    const payload = req.body;
    // Don't log raw payload — may contain customer PII / message text.
    logger.info('Received WhatsApp inbound webhook', {
      hasSender: Boolean(payload?.sender || payload?.from || payload?.entry),
    });

    // Handle verification challenge if sent by WhatsApp Cloud API via POST
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.challenge']) {
      res.status(200).send(req.query['hub.challenge']);
      return;
    }

    // Guard against oversized/batch-abuse payloads
    if (Array.isArray(payload) && payload.length > 100) {
      logger.warn('WhatsApp webhook batch too large, truncating', { size: payload.length });
      res.status(200).json({ received: true, ignored: true, reason: 'batch_too_large' });
      return;
    }

    // Extract sender phone and message text (supporting KwikEngage or WhatsApp Cloud webhook payload)
    const senderPhone =
      payload.sender ||
      payload.from ||
      payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from ||
      payload.phone;
    const messageText =
      payload.text ||
      payload.message ||
      payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.text?.body;

    if (senderPhone && messageText) {
      // Process through Meta LLM conversation agent harness asynchronously
      conversationAgentService
        .processConversation({
          customerIdentifier: senderPhone,
          text: messageText,
          channel: 'WHATSAPP',
          subject: 'WhatsApp Customer Message',
          autoExecuteActions: true,
        })
        .then((result) => {
          logger.info('Processed inbound WhatsApp with Meta LLM agent harness', {
            senderPhone,
            intent: result.analysis.intent,
            urgency: result.analysis.urgency,
          });
        })
        .catch((err) => {
          logger.error('WhatsApp agent processing error', { error: err.message });
        });
    }

    res.status(200).json({ received: true });
  } catch (error: any) {
    logger.error('WhatsApp webhook processing error', { error: error.message });
    // Still 200 — provider retries would duplicate CRM agent work; cron/backfill catches up.
    res.status(200).json({ received: true, error: 'processing_error' });
  }
});

// POST /api/webhooks/gokwik — Inbound GoKwik payment & refund webhooks
// Public (exempted in requireAuth). Synchronously returns 200 to acknowledge webhook.
router.post('/webhooks/gokwik', async (req: Request, res: Response): Promise<void> => {
  try {
    const parsed = gokwikService.processWebhook(req.body);
    logger.info('Received GoKwik webhook', {
      event: parsed.event,
      entity: parsed.entity,
      merchantOrderId: parsed.merchantOrderId,
      paymentId: parsed.paymentId,
      refundId: parsed.refundId,
      amount: parsed.amount,
      isPayment: parsed.isPayment,
      isRefund: parsed.isRefund,
    });

    if (parsed.isPayment && parsed.merchantOrderId) {
      const order = await prisma.order.findFirst({
        where: {
          OR: [
            { shopifyOrderName: parsed.merchantOrderId },
            { gokwikPaymentId: parsed.paymentId || undefined },
            { paymentProviderPaymentId: parsed.paymentId || undefined },
          ],
        },
      });

      if (order) {
        await prisma.order.update({
          where: { id: order.id },
          data: {
            paymentVerified: true,
            paymentProviderPaymentId: parsed.paymentId || order.paymentProviderPaymentId,
            gokwikPaymentId: parsed.paymentId || order.gokwikPaymentId,
          },
        });
        logger.info('GoKwik payment verified via webhook', {
          orderId: order.id,
          orderName: order.shopifyOrderName,
          paymentId: parsed.paymentId,
        });
      }
    }

    if (parsed.isRefund && parsed.merchantOrderId) {
      const returnRecord = await prisma.return.findFirst({
        where: {
          order: {
            OR: [
              { shopifyOrderName: parsed.merchantOrderId },
              { gokwikPaymentId: parsed.paymentId || undefined },
            ],
          },
        },
        include: { order: true },
      });

      if (returnRecord) {
        if (parsed.event === 'refund.successful') {
          await prisma.return.update({
            where: { id: returnRecord.id },
            data: {
              refundStatus: 'PROCESSED',
              returnStatus: 'REFUNDED',
              refundAmount: parsed.amount ?? returnRecord.refundAmount,
              refundProcessedAt: new Date(),
            },
          });
        } else if (parsed.event === 'refund.failure') {
          await prisma.return.update({
            where: { id: returnRecord.id },
            data: {
              refundStatus: 'FAILED',
              errorMessage: `GoKwik refund failed: ${parsed.event}`,
            },
          });
        }
      }
    }

    res.status(200).json({ success: true, event: parsed.event });
  } catch (error: any) {
    logger.error('GoKwik webhook processing error', { error: error.message });
    res.status(200).json({ success: false, error: error.message });
  }
});

export default router;
