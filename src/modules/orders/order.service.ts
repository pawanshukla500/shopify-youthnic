import prisma from '../../database/prisma';
import { config } from '../../config';
import shopifyService from '../shopify/shopify.service';
import delhiveryService from '../delhivery/delhivery.service';
import notificationEngine from '../notifications/notification.service';
import paymentService from '../payments/payment.service';
import logger from '../../utils/logger';
import { Order } from '@prisma/client';
import { ShopifyOrderWebhook } from '../../types';

/**
 * Order Service
 * Orchestrates the full order lifecycle:
 *   NEW → DISPATCH_PENDING → DISPATCHED → SHIPPED → IN_TRANSIT → OUT_FOR_DELIVERY → DELIVERED
 * Each transition triggers appropriate WhatsApp notifications.
 */
class OrderService {
  /**
   * Sync new/updated orders from Shopify into our DB.
   * Called by the cron job and also by webhooks.
   */
  async syncOrdersFromShopify(): Promise<number> {
    const syncStartDate = config.shopify.syncStartDate;

    // Check if an initial full fetch from syncStartDate has completed.
    // If not, we must fetch from syncStartDate to backfill the full historical window.
    const backfillTag = `BACKFILL_SINCE_${syncStartDate.toISOString().slice(0, 10)}`;
    const backfillCompleted = await prisma.syncLog.findFirst({
      where: {
        syncType: 'ORDER_FETCH',
        status: 'SUCCESS',
        message: { contains: backfillTag },
      },
    });

    let sinceDate: Date;
    if (backfillCompleted) {
      // Incremental sync: find the most recent order update to use as the "since" timestamp
      const lastOrder = await prisma.order.findFirst({
        orderBy: { shopifyUpdatedAt: 'desc' },
      });
      const incrementalSince = lastOrder?.shopifyUpdatedAt
        ? new Date(lastOrder.shopifyUpdatedAt.getTime() + 1000) // +1s to avoid re-sync
        : null;
      sinceDate = incrementalSince && incrementalSince > syncStartDate ? incrementalSince : syncStartDate;
    } else {
      // Initial backfill from syncStartDate
      sinceDate = syncStartDate;
    }

    logger.info('Syncing orders from Shopify', {
      sinceDate: sinceDate.toISOString(),
      syncStartDate: syncStartDate.toISOString(),
      isBackfill: !backfillCompleted,
    });

    const orders = await shopifyService.fetchOrdersSince(sinceDate);

    let syncedCount = 0;
    let skippedAsHistory = 0;
    for (const order of orders) {
      try {
        // Check if order already exists in our DB
        const existing = await prisma.order.findUnique({
          where: { shopifyOrderId: order.id.toString() },
          include: { shipment: true },
        });

        // Orders created before the start date are history and must never enter
        // the system. Orders already stored keep syncing whatever their age, so
        // a later payment or cancellation on them is still picked up.
        if (!existing && new Date(order.created_at) < syncStartDate) {
          skippedAsHistory++;
          continue;
        }

        // Cancelled, voided, and refunded orders must not be dispatched. An
        // order already in our DB has to be marked CANCELLED rather than
        // skipped, otherwise it stays in NEW and auto-dispatch still ships it.
        const isCancelledOnShopify =
          Boolean((order as any).cancelled_at) ||
          order.financial_status === 'voided' ||
          order.financial_status === 'refunded';

        if (isCancelledOnShopify) {
          if (existing) {
            if (existing.status !== 'CANCELLED') {
              await this.handleOrderCancelled(order.id.toString());
            }
          } else {
            logger.info('Skipping cancelled order', {
              orderName: order.name,
              financialStatus: order.financial_status,
            });
          }
          continue;
        }

        if (existing) {
          // Update order data but don't change our internal status
          await shopifyService.syncOrderToDb(order);
        } else {
          // New order — sync to DB and send confirmation notification
          await shopifyService.syncOrderToDb(order);

          const newOrder = await prisma.order.findUnique({
            where: { shopifyOrderId: order.id.toString() },
          });

          if (newOrder) {
            // Send order confirmation WhatsApp message only for recent orders (under 24h old)
            // to avoid spamming customers for historical backfilled orders
            const orderAgeHours = (Date.now() - new Date(order.created_at).getTime()) / (1000 * 60 * 60);
            if (orderAgeHours < 24) {
              await notificationEngine.notifyOrderConfirmed(newOrder);
            }

            // Verify payment (detects gateway, checks if prepaid payment is captured)
            // COD orders pass automatically; prepaid orders must have captured payment
            await paymentService.verifyPayment(newOrder);

            // Record sync log
            await prisma.syncLog.create({
              data: {
                orderId: newOrder.id,
                syncType: 'ORDER_FETCH',
                status: 'SUCCESS',
                message: `Order ${order.name} synced from Shopify`,
              },
            });
          }
        }

        syncedCount++;
      } catch (error: any) {
        logger.error('Failed to sync individual order', {
          shopifyOrderId: order.id,
          error: error.message,
        });

        await prisma.syncLog.create({
          data: {
            syncType: 'ORDER_FETCH',
            status: 'FAILED',
            message: `Failed to sync order ${order.name}`,
            errorMessage: error.message,
          },
        });
      }
    }

    if (!backfillCompleted) {
      await prisma.syncLog.create({
        data: {
          syncType: 'ORDER_FETCH',
          status: 'SUCCESS',
          message: `${backfillTag}_COMPLETE: Synced ${syncedCount} orders from ${syncStartDate.toISOString()}`,
        },
      });
    }

    logger.info('Order sync complete', {
      syncedCount,
      totalFetched: orders.length,
      skippedAsHistory,
      isBackfill: !backfillCompleted,
    });
    return syncedCount;
  }

  /**
   * Import or update a single order arriving from a Shopify webhook.
   *
   * Applies the same start-date policy as the scheduled sync, so editing an old
   * order in Shopify (which fires orders/updated) cannot pull history into the
   * system. Orders already stored are always updated, whatever their age.
   *
   * Returns true when the order was written to the database.
   */
  async syncOrderFromWebhook(order: ShopifyOrderWebhook): Promise<boolean> {
    const existing = await prisma.order.findUnique({
      where: { shopifyOrderId: order.id.toString() },
      select: { id: true },
    });

    if (!existing && new Date(order.created_at) < config.shopify.syncStartDate) {
      logger.info('Ignoring webhook for order created before the sync start date', {
        orderName: order.name,
        createdAt: order.created_at,
        syncStartDate: config.shopify.syncStartDate.toISOString(),
      });
      return false;
    }

    await shopifyService.syncOrderToDb(order);
    return true;
  }

  /**
   * Dispatch an order: push it to Delhivery to generate AWB.
   * Can be called manually or automatically for all DISPATCH_PENDING orders.
   */
  async dispatchOrder(orderId: number): Promise<{ waybillNumber: string }> {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });

    if (!order) {
      throw new Error(`Order not found: ${orderId}`);
    }

    if (order.status !== 'NEW' && order.status !== 'DISPATCH_PENDING') {
      throw new Error(`Order ${order.shopifyOrderName} is not in dispatchable state (current: ${order.status})`);
    }

    // Shopify already marks this order fulfilled, so a Delhivery shipment here
    // would ship goods that are already out (or were never meant to be). This
    // catches both historic imports and orders fulfilled through another path.
    if (order.fulfillmentStatus === 'fulfilled') {
      throw new Error(
        `Order ${order.shopifyOrderName} is already fulfilled on Shopify and cannot be dispatched again`
      );
    }

    // Verify payment before dispatch (prepaid orders must be paid, COD is always OK)
    const paymentCheck = await paymentService.isReadyForDispatch(order);
    if (!paymentCheck.ready) {
      throw new Error(
        `Cannot dispatch order ${order.shopifyOrderName}: ${paymentCheck.reason || 'Payment not verified'}`
      );
    }

    // Refresh order after payment verification may have updated it
    const verifiedOrder = await prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });
    if (!verifiedOrder) {
      throw new Error(`Order not found after verification: ${orderId}`);
    }

    // Create shipment on Delhivery
    const result = await delhiveryService.createShipment(verifiedOrder);

    // Sync fulfillment and tracking number directly to Shopify order
    try {
      await shopifyService.fulfillOrderOnShopify(verifiedOrder.shopifyOrderId, result.waybillNumber);
    } catch (shopifyErr: any) {
      logger.warn('Could not sync fulfillment to Shopify (non-critical)', { error: shopifyErr.message });
    }

    // Send "order shipped" WhatsApp notification
    await notificationEngine.notifyOrderShipped(verifiedOrder, result.waybillNumber);

    // Record sync log
    await prisma.syncLog.create({
      data: {
        orderId: order.id,
        syncType: 'SHIPMENT_CREATE',
        status: 'SUCCESS',
        message: `Shipment created with waybill ${result.waybillNumber}`,
      },
    });

    return { waybillNumber: result.waybillNumber };
  }

  /**
   * Auto-dispatch all orders that are in NEW status.
   * Called by the scheduler.
   */
  async autoDispatchPendingOrders(): Promise<number> {
    const pendingOrders = await prisma.order.findMany({
      where: { status: 'NEW' },
      include: { shipment: true },
    });

    let dispatchedCount = 0;
    let skippedFulfilled = 0;
    for (const order of pendingOrders) {
      // Skip if shipment already exists
      if (order.shipment) {
        logger.info('Order already has a shipment, skipping', { orderId: order.id });
        continue;
      }

      // Shopify already shows this order as fulfilled (shipped elsewhere or
      // manually). It must not get a second Delhivery shipment. The historical
      // import pulls such orders in as NEW; they stay NEW but are never
      // dispatched.
      if (order.fulfillmentStatus === 'fulfilled') {
        skippedFulfilled++;
        continue;
      }

      // Only auto-dispatch recent orders (created within the last 48 hours).
      // Older backfilled orders imported from June/July/August are kept for records,
      // reports, and manual fulfillment.
      const orderAgeHours = (Date.now() - new Date(order.shopifyCreatedAt).getTime()) / (1000 * 60 * 60);
      if (orderAgeHours > 48) {
        continue;
      }

      try {
        await this.dispatchOrder(order.id);
        dispatchedCount++;
      } catch (error: any) {
        logger.error('Auto-dispatch failed for order', {
          orderId: order.id,
          orderName: order.shopifyOrderName,
          error: error.message,
        });

        await prisma.syncLog.create({
          data: {
            orderId: order.id,
            syncType: 'SHIPMENT_CREATE',
            status: 'FAILED',
            message: `Auto-dispatch failed for ${order.shopifyOrderName}`,
            errorMessage: error.message,
          },
        });
      }
    }

    if (skippedFulfilled > 0) {
      logger.info('Auto-dispatch skipped already-fulfilled orders', {
        skippedFulfilled,
        totalPending: pendingOrders.length,
      });
    }

    logger.info('Auto-dispatch complete', { dispatchedCount, totalPending: pendingOrders.length });
    return dispatchedCount;
  }

  /**
   * Handle order cancelled webhook from Shopify.
   */
  async handleOrderCancelled(shopifyOrderId: string): Promise<void> {
    const order = await prisma.order.findUnique({
      where: { shopifyOrderId: shopifyOrderId },
      include: { shipment: true },
    });

    if (!order) {
      logger.warn('Cancelled order not found in DB', { shopifyOrderId });
      return;
    }

    // If shipment was created, try to cancel on Delhivery
    if (order.shipment?.waybillNumber && order.shipment.status === 'CREATED') {
      await delhiveryService.cancelShipment(order.shipment.waybillNumber);
      await prisma.shipment.update({
        where: { id: order.shipment.id },
        data: { status: 'CANCELLED' },
      });
    }

    await prisma.order.update({
      where: { id: order.id },
      data: { status: 'CANCELLED' },
    });

    logger.info('Order cancelled', { shopifyOrderId, orderName: order.shopifyOrderName });
  }

  /**
   * Get all orders with optional filters and search.
   * Supports filtering by status, paymentGateway, paymentMethod, paymentVerified, search query, and pagination.
   */
  async getOrders(
    optionsOrStatus?: string | {
      status?: string;
      gateway?: string;
      paymentMethod?: string;
      paymentVerified?: boolean;
      search?: string;
      filter?: string;
      limit?: number;
      offset?: number;
    }
  ): Promise<Order[]> {
    let status: string | undefined;
    let gateway: string | undefined;
    let paymentMethod: string | undefined;
    let paymentVerified: boolean | undefined;
    let search: string | undefined;
    let filter: string | undefined;
    let limit: number | undefined;
    let offset: number | undefined;

    if (typeof optionsOrStatus === 'string') {
      status = optionsOrStatus;
    } else if (optionsOrStatus && typeof optionsOrStatus === 'object') {
      status = optionsOrStatus.status;
      gateway = optionsOrStatus.gateway;
      paymentMethod = optionsOrStatus.paymentMethod;
      paymentVerified = optionsOrStatus.paymentVerified;
      search = optionsOrStatus.search?.trim();
      filter = optionsOrStatus.filter;
      limit = optionsOrStatus.limit;
      offset = optionsOrStatus.offset;
    }

    const where: any = {};
    const andConditions: any[] = [];

    if (filter === 'DELAYED_DISPATCH') {
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 3600 * 1000);
      andConditions.push({ status: { in: ['NEW', 'DISPATCH_PENDING'] } });
      andConditions.push({
        OR: [
          { dispatchDelayed: true },
          { expectedDispatchAt: { lte: new Date() } },
          { shopifyCreatedAt: { lte: twentyFourHoursAgo } },
        ],
      });
      andConditions.push({
        OR: [
          { shipment: null },
          { shipment: { waybillNumber: null } },
        ],
      });
    } else if (filter === 'NDR') {
      andConditions.push({
        OR: [
          { status: { in: ['FAILED_DELIVERY', 'RTO_INITIATED'] } },
          {
            shipment: {
              OR: [
                { status: { in: ['FAILED', 'RTO'] } },
                { trackingStatus: { contains: 'failure', mode: 'insensitive' } },
                { trackingStatus: { contains: 'attempt', mode: 'insensitive' } },
                { trackingStatus: { contains: 'undeliver', mode: 'insensitive' } },
              ],
            },
          },
        ],
      });
    } else if (filter === 'PREPAID_DISPATCH') {
      andConditions.push({ status: { in: ['NEW', 'DISPATCH_PENDING'] } });
      andConditions.push({ paymentMethod: { not: 'COD' } });
    }

    if (status) {
      where.status = status;
    }

    if (gateway) {
      if (gateway.toLowerCase() === 'cod') {
        where.paymentMethod = 'COD';
      } else {
        where.paymentGateway = { contains: gateway, mode: 'insensitive' };
      }
    }

    if (paymentMethod) {
      where.paymentMethod = paymentMethod;
    }

    if (paymentVerified !== undefined) {
      where.paymentVerified = paymentVerified;
    }

    if (search) {
      andConditions.push({
        OR: [
          { shopifyOrderName: { contains: search, mode: 'insensitive' } },
          { customerName: { contains: search, mode: 'insensitive' } },
          { customerPhone: { contains: search } },
          { customerEmail: { contains: search, mode: 'insensitive' } },
          { customerCity: { contains: search, mode: 'insensitive' } },
          { customerState: { contains: search, mode: 'insensitive' } },
          { customerPincode: { contains: search } },
          { salesChannel: { contains: search, mode: 'insensitive' } },
          { tags: { contains: search, mode: 'insensitive' } },
          { shipment: { waybillNumber: { contains: search } } },
          {
            items: {
              some: {
                OR: [
                  { sku: { contains: search, mode: 'insensitive' } },
                  { title: { contains: search, mode: 'insensitive' } },
                  { variantTitle: { contains: search, mode: 'insensitive' } },
                ],
              },
            },
          },
        ],
      });
    }

    if (andConditions.length > 0) {
      where.AND = andConditions;
    }

    const orders = await prisma.order.findMany({
      where,
      include: { items: true, shipment: true, returns: true },
      orderBy: { shopifyCreatedAt: 'desc' },
      take: limit,
      skip: offset,
    });

    return orders.map((o) => this.enrichOrderMetadata(o));
  }

  /**
   * Get a single order by ID with all related data and enriched operational metadata.
   */
  async getOrder(orderId: number): Promise<any> {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: true,
        shipment: { include: { trackingLogs: true } },
        returns: { include: { items: { include: { orderItem: true } } } },
        notifications: true,
      },
    });

    if (!order) return null;
    return this.enrichOrderMetadata(order);
  }

  /**
   * Helper to attach RTO risk, dispatch SLA, and NDR flags to an order.
   */
  enrichOrderMetadata(order: any): any {
    const rate = delhiveryService.calculateRateCardMatrix({
      mode: (config.delhivery.shippingMode === 'Express' ? 'E' : 'S') as 'E' | 'S',
      chargeableWeightGrams: 500,
      originPincode: config.delhivery.seller.pincode,
      destinationPincode: order.customerPincode,
      shipmentStatus: 'Delivered',
      paymentType: order.paymentMethod === 'COD' ? 'COD' : 'Pre-paid',
      codAmount: order.paymentMethod === 'COD' ? order.totalAmount : 0,
    });

    const hoursSincePlaced = (Date.now() - new Date(order.shopifyCreatedAt).getTime()) / (1000 * 60 * 60);
    const hasWaybill = Boolean(order.shipment?.waybillNumber);
    const isDispatchOverdue = ['NEW', 'DISPATCH_PENDING'].includes(order.status) && !hasWaybill && hoursSincePlaced > 24;
    const dispatchOverdueHours = isDispatchOverdue ? Math.round(hoursSincePlaced - 24) : 0;
    const expectedDispatchAt = order.expectedDispatchAt || new Date(new Date(order.shopifyCreatedAt).getTime() + 24 * 3600 * 1000);

    const hasNdrException =
      order.status === 'FAILED_DELIVERY' ||
      (order.shipment?.trackingStatus && /fail|attempt|undeliver/i.test(order.shipment.trackingStatus));

    const rawTags = (order.tags || '').toLowerCase();
    const isCodBlocked =
      rawTags.includes('gokwik_cod_blocking') ||
      rawTags.includes('cod_blocking') ||
      rawTags.includes('cod_cancelled') ||
      rawTags.includes('c2p-order-cancelled');
    const isCodConfirmed =
      rawTags.includes('cod_confirmed') ||
      rawTags.includes('cod confirmed') ||
      rawTags.includes('confirmed') ||
      rawTags.includes('c2p-converted') ||
      rawTags.includes('c2p-prepaid-order');

    let rtoRiskLevel: 'LOW' | 'MEDIUM' | 'HIGH' = (order.rtoRiskLevel as any) || 'LOW';
    let rtoRiskLabel = 'Prepaid (Zero RTO Risk)';
    let rtoRiskReason = order.rtoRiskReason || 'Payment captured upfront via Easebuzz / PhonePe';

    if (order.paymentMethod === 'COD') {
      if (isCodBlocked) {
        rtoRiskLevel = 'HIGH';
        rtoRiskLabel = 'High RTO Risk (GoKwik COD Blocked)';
        rtoRiskReason = 'GoKwik flagged COD blocked / customer cancelled';
      } else if (isCodConfirmed) {
        rtoRiskLevel = 'LOW';
        rtoRiskLabel = 'Low RTO Risk (COD Confirmed)';
        rtoRiskReason = 'Customer verified intent via WhatsApp / GoKwik confirmation';
      } else if (order.deliverOrderCount && order.deliverOrderCount >= 2) {
        rtoRiskLevel = 'LOW';
        rtoRiskLabel = `Low RTO Risk (${order.deliverOrderCount} prior deliveries)`;
        rtoRiskReason = `Repeat trustworthy buyer (${order.deliverOrderCount} prior deliveries on GoKwik network)`;
      } else {
        rtoRiskLevel = 'MEDIUM';
        rtoRiskLabel = 'Medium Risk (Unconfirmed COD)';
        rtoRiskReason = 'Awaiting customer WhatsApp confirmation before dispatch';
      }
    }

    return {
      ...order,
      estimatedShippingCost: rate.totalAmount,
      shippingZone: rate.zone,
      shippingZoneCode: rate.zoneCode,
      isDispatchOverdue,
      dispatchOverdueHours,
      expectedDispatchAt,
      hasNdrException: Boolean(hasNdrException),
      rtoRiskLevel,
      rtoRiskReason,
      rtoRiskLabel,
      rtoRisk: {
        level: rtoRiskLevel,
        label: rtoRiskLabel,
        reason: rtoRiskReason,
        deliverCount: order.deliverOrderCount,
        isConfirmed: isCodConfirmed,
        isBlocked: isCodBlocked,
      },
    };
  }

  /**
   * Process Auto-Refund for RTO Delivered Orders (Scenario 2).
   * When package arrives back at warehouse:
   * - If prepaid: issues refund via Shopify to Easebuzz/PhonePe, adds tags, notifies customer.
   * - If COD: marks RTO delivered and restocks without customer refund.
   */
  async processRtoRefund(orderId: number): Promise<{ success: boolean; refundId?: string; message: string }> {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true, shipment: true },
    });

    if (!order) {
      throw new Error(`Order ${orderId} not found`);
    }

    if (order.financialStatus === 'refunded' || order.status === 'REFUNDED') {
      return { success: true, message: 'Order is already marked as refunded.' };
    }

    const isPrepaid = order.paymentMethod !== 'COD';
    if (!isPrepaid) {
      await prisma.order.update({
        where: { id: order.id },
        data: { status: 'RTO_DELIVERED' },
      });
      try {
        await shopifyService.updateOrderTags(order.shopifyOrderId, [
          'RTO_DELIVERED',
          'COD_RTO_RESTOCKED',
        ]);
      } catch (e: any) {
        logger.warn('Could not update tags on Shopify for COD RTO', { error: e.message });
      }
      return { success: true, message: 'COD Order marked RTO Delivered and restocked (no customer refund required).' };
    }

    // Prepaid Order: Call Shopify Refund API (routing to Easebuzz / GoKwik)
    const refundResult = await shopifyService.createRefund(
      order.shopifyOrderId,
      order.totalAmount,
      [],
      true // full refund
    );

    // Update in DB
    await prisma.order.update({
      where: { id: order.id },
      data: {
        status: 'REFUNDED',
        financialStatus: 'refunded',
      },
    });

    // Tag on Shopify
    try {
      await shopifyService.updateOrderTags(order.shopifyOrderId, [
        'RTO_DELIVERED',
        'RTO_AUTO_REFUNDED',
        'Refund_initiated',
        'Refund_credited',
      ]);
    } catch (tagErr: any) {
      logger.warn('Failed to add refund tags to Shopify', { error: tagErr.message });
    }

    // Send customer WhatsApp notification
    try {
      await notificationEngine.sendCustomMessage(
        order,
        `Hi ${order.customerName}, your returned package for order ${order.shopifyOrderName} has been safely received at our Surat warehouse. A full refund of ₹${order.totalAmount} has been automatically processed to your original payment mode (${order.paymentProvider || order.paymentGateway || 'Prepaid'}). Refund ID: ${refundResult.refundId}.`
      );
    } catch (notifErr: any) {
      logger.warn('Failed to send refund WhatsApp notification', { error: notifErr.message });
    }

    // Record sync log
    await prisma.syncLog.create({
      data: {
        orderId: order.id,
        syncType: 'REFUND_PROCESS',
        status: 'SUCCESS',
        message: `Auto-refund of ₹${order.totalAmount} processed for RTO delivered order ${order.shopifyOrderName} (Refund ID: ${refundResult.refundId})`,
      },
    });

    return {
      success: true,
      refundId: refundResult.refundId,
      message: `Auto-refund of ₹${order.totalAmount} processed successfully for ${order.shopifyOrderName}!`,
    };
  }

  /**
   * Handle NDR action (re-attempt or mark RTO) with Delhivery and customer notification.
   */
  async handleNdrAction(
    orderId: number,
    action: 'RE-ATTEMPT' | 'RTO',
    notes?: string
  ): Promise<{ success: boolean; message: string }> {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { shipment: true },
    });

    if (!order) {
      throw new Error(`Order ${orderId} not found`);
    }

    if (action === 'RE-ATTEMPT') {
      if (order.shipment?.waybillNumber && order.shipment.courier?.toLowerCase() === 'delhivery') {
        try {
          await delhiveryService.ndrAction(order.shipment.waybillNumber, 'RE-ATTEMPT');
        } catch (delhErr: any) {
          logger.warn('Delhivery NDR action failed (courier may be offline)', { error: delhErr.message });
        }
      }

      await notificationEngine.sendCustomMessage(
        order,
        `Hi ${order.customerName}, our courier will re-attempt delivery of your order ${order.shopifyOrderName} tomorrow. Please ensure someone is available at the address. If you need assistance, reply to this message.`
      );

      await prisma.syncLog.create({
        data: {
          orderId: order.id,
          syncType: 'TRACKING_UPDATE',
          status: 'SUCCESS',
          message: `NDR Re-attempt requested for ${order.shopifyOrderName}. Notes: ${notes || 'None'}`,
        },
      });

      return { success: true, message: `Re-attempt scheduled for ${order.shopifyOrderName}. Customer notified on WhatsApp.` };
    } else {
      // Mark RTO Initiated
      await prisma.order.update({
        where: { id: order.id },
        data: { status: 'RTO_INITIATED' },
      });
      if (order.shipment) {
        await prisma.shipment.update({
          where: { id: order.shipment.id },
          data: { status: 'RTO' },
        });
      }

      try {
        await shopifyService.updateOrderTags(order.shopifyOrderId, ['RTO_INITIATED']);
      } catch (e: any) {
        // ignore
      }

      await notificationEngine.sendCustomMessage(
        order,
        `Hi ${order.customerName}, delivery of your order ${order.shopifyOrderName} could not be completed and is being returned to our warehouse (RTO). If you have questions, please reach out to us.`
      );

      return { success: true, message: `Order ${order.shopifyOrderName} marked as RTO Initiated.` };
    }
  }

}

export default new OrderService();
