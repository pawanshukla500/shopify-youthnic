import prisma from '../../database/prisma';
import delhiveryService from '../delhivery/delhivery.service';
import shopifyService from '../shopify/shopify.service';
import notificationEngine from '../notifications/notification.service';
import logger from '../../utils/logger';

/**
 * Returns Service
 * Full return lifecycle:
 *   INITIATED → PICKUP_SCHEDULED → PICKED_UP → IN_TRANSIT → RECEIVED
 *   → QC_PENDING → QC_APPROVED/REJECTED → REFUND_PENDING → REFUNDED
 *
 * The "scan" flow: when returned goods arrive at the warehouse, they are scanned.
 * This triggers QC. If QC passes, the refund is automatically processed on Shopify.
 */
class ReturnService {
  /**
   * Create a return request for an order.
   * This creates the return in our DB and initiates a reverse pickup with Delhivery.
   */
  /**
   * Create a return request for an order.
   * This creates the return in our DB and initiates a reverse pickup with Delhivery,
   * while also triggering reverse tracking and notes on Shopify.
   */
  async createReturn(
    orderId: number,
    returnReason: string,
    items: Array<{ orderItemId: number; quantity: number }>,
    options?: {
      returnWaybillNumber?: string;
      carrier?: string;
      triggerShopify?: boolean;
    }
  ): Promise<{ returnId: number; returnWaybill: string; shopifyTriggered: boolean }> {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true, returns: true, shipment: true },
    });

    if (!order) {
      throw new Error(`Order not found: ${orderId}`);
    }

    // Check if there's already an active return
    const activeReturn = order.returns.find(
      (r) => !['REFUNDED', 'CANCELLED'].includes(r.returnStatus)
    );
    if (activeReturn) {
      throw new Error(`Order ${order.shopifyOrderName} already has an active return`);
    }

    // Forward shipment's waybill number to link reverse pickup against forward order
    const forwardWaybill = order.shipment?.waybillNumber || undefined;
    let finalReturnWaybill = options?.returnWaybillNumber?.trim() || '';

    // If no manual return waybill provided, try creating reverse pickup via Delhivery
    if (!finalReturnWaybill) {
      try {
        const delhiveryResult = await delhiveryService.createReturnShipment(
          order,
          returnReason,
          forwardWaybill
        );
        finalReturnWaybill = delhiveryResult.waybillNumber;
      } catch (err: any) {
        logger.warn('Delhivery reverse pickup creation failed or offline, generating reverse tracking code', {
          error: err.message,
        });
        finalReturnWaybill = `REV-DEL-${order.shopifyOrderNumber}-${Date.now().toString().slice(-4)}`;
      }
    }

    // Create return record in DB
    const returnRecord = await prisma.return.create({
      data: {
        orderId: order.id,
        returnReason,
        returnStatus: 'PICKUP_SCHEDULED',
        returnWaybillNumber: finalReturnWaybill,
        refundStatus: 'NONE',
        items: {
          create: items.map((item) => ({
            orderItemId: item.orderItemId,
            quantity: item.quantity,
          })),
        },
      },
    });

    // Update order status
    await prisma.order.update({
      where: { id: order.id },
      data: { status: 'RETURN_REQUESTED' },
    });

    // Trigger on Shopify (Tags, Order Notes, and timeline)
    let shopifyTriggered = false;
    if (options?.triggerShopify !== false) {
      const shopifyRes = await shopifyService.registerReturnOnShopify(order.shopifyOrderId, {
        returnReason,
        returnTrackingNumber: finalReturnWaybill,
        carrier: options?.carrier || 'Delhivery',
      });
      shopifyTriggered = shopifyRes.success;
    }

    // Notify customer via WhatsApp
    await notificationEngine.notifyReturnInitiated(order, returnRecord);

    // Record sync log
    await prisma.syncLog.create({
      data: {
        orderId: order.id,
        syncType: 'RETURN_CREATE',
        status: 'SUCCESS',
        message: `Return created with waybill ${finalReturnWaybill}${shopifyTriggered ? ' · Synced to Shopify' : ''}`,
      },
    });

    logger.info('Return created', {
      orderId: order.id,
      returnId: returnRecord.id,
      returnWaybill: finalReturnWaybill,
      shopifyTriggered,
    });

    return {
      returnId: returnRecord.id,
      returnWaybill: finalReturnWaybill,
      shopifyTriggered,
    };
  }

  /**
   * Process a direct refund for an order through Shopify.
   * Can be invoked directly from Order Detail without requiring return package scan.
   */
  async refundOrder(
    orderId: number,
    refundAmount?: number,
    reason?: string
  ): Promise<{ success: boolean; refundId: string; refundAmount: number }> {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true, returns: true },
    });

    if (!order) {
      throw new Error(`Order not found: ${orderId}`);
    }

    const amount = refundAmount && refundAmount > 0 ? refundAmount : order.totalAmount;

    // Fetch order from Shopify to match line items
    const shopifyOrder = await shopifyService.fetchOrder(order.shopifyOrderId);
    const shopifyRefundItems = (order.items || []).map((item) => {
      const matched = shopifyOrder.line_items.find(
        (li) => (item.sku && li.sku === item.sku) || li.title === item.title
      );
      return {
        lineItemId: matched?.id || 0,
        quantity: item.quantity,
        restockType: 'return' as const,
      };
    }).filter((i) => i.lineItemId > 0);

    const isPartial = amount < order.totalAmount;
    const refundResult = await shopifyService.createRefund(
      order.shopifyOrderId,
      amount,
      shopifyRefundItems,
      !isPartial
    );

    // Update DB Order
    await prisma.order.update({
      where: { id: order.id },
      data: {
        status: 'REFUNDED',
        financialStatus: isPartial ? 'partially_refunded' : 'refunded',
      },
    });

    // Update any linked return record
    const activeReturn = order.returns.find((r) => r.refundStatus !== 'PROCESSED');
    if (activeReturn) {
      await prisma.return.update({
        where: { id: activeReturn.id },
        data: {
          returnStatus: 'REFUNDED',
          refundStatus: 'PROCESSED',
          refundAmount: amount,
          shopifyRefundId: refundResult.refundId,
          refundProcessedAt: new Date(),
        },
      });
    }

    // Record sync log
    await prisma.syncLog.create({
      data: {
        orderId: order.id,
        syncType: 'REFUND_PROCESS',
        status: 'SUCCESS',
        message: `Refund of ₹${amount} processed on Shopify. Refund ID: ${refundResult.refundId}. Reason: ${reason || 'Customer refund'}`,
      },
    });

    // Send WhatsApp notification
    await notificationEngine.notifyRefundProcessed(order, amount, activeReturn);

    return {
      success: true,
      refundId: refundResult.refundId,
      refundAmount: amount,
    };
  }

  /**
   * Scan a returned package when it arrives at the warehouse.
   * This is the key entry point for the return → refund automation.
   *
   * When a returned item is scanned (by waybill number or barcode):
   *   1. Find the return record
   *   2. Mark it as RECEIVED
   *   3. Trigger QC (quality check)
   *   4. If QC passes → auto-process refund on Shopify
   *   5. Notify customer via WhatsApp
   */
  async scanReturn(
    waybillNumber: string,
    qcStatus: 'APPROVED' | 'REJECTED' | 'PARTIAL' = 'APPROVED',
    qcRemark?: string
  ): Promise<{ returnId: number; refundProcessed: boolean; refundAmount?: number }> {
    // Find return by waybill number
    const returnRecord = await prisma.return.findFirst({
      where: { returnWaybillNumber: waybillNumber },
      include: {
        order: { include: { items: true } },
        items: { include: { orderItem: true } },
      },
    });

    if (!returnRecord) {
      throw new Error(`No return found for waybill: ${waybillNumber}`);
    }

    logger.info('Return scanned at warehouse', {
      waybillNumber,
      returnId: returnRecord.id,
      orderId: returnRecord.orderId,
    });

    // Update return status to RECEIVED + QC
    await prisma.return.update({
      where: { id: returnRecord.id },
      data: {
        returnStatus: 'RECEIVED',
        qcStatus,
        qcRemark: qcRemark || null,
        qcCheckedAt: new Date(),
        order: {
          update: { status: 'RETURN_RECEIVED' },
        },
      },
    });

    // Update individual return items QC status
    await prisma.returnItem.updateMany({
      where: { returnId: returnRecord.id },
      data: { qcStatus, qcRemark: qcRemark || null },
    });

    // Record sync log
    await prisma.syncLog.create({
      data: {
        orderId: returnRecord.orderId,
        syncType: 'RETURN_TRACKING',
        status: 'SUCCESS',
        message: `Return ${waybillNumber} scanned and received at warehouse. QC: ${qcStatus}`,
      },
    });

    // Notify customer that return is received
    await notificationEngine.notifyReturnReceived(returnRecord.order);

    // If QC approved, auto-process refund
    if (qcStatus === 'APPROVED' || qcStatus === 'PARTIAL') {
      const refundResult = await this.processRefund(returnRecord.id, qcStatus === 'PARTIAL');
      return {
        returnId: returnRecord.id,
        refundProcessed: refundResult.success,
        refundAmount: refundResult.refundAmount,
      };
    }

    // QC rejected — no refund, notify customer
    if (qcStatus === 'REJECTED') {
      await prisma.return.update({
        where: { id: returnRecord.id },
        data: { returnStatus: 'QC_REJECTED', refundStatus: 'NONE' },
      });

      logger.info('Return QC rejected, no refund processed', {
        returnId: returnRecord.id,
        qcRemark,
      });
    }

    return { returnId: returnRecord.id, refundProcessed: false };
  }

  /**
   * Process a refund through Shopify API.
   * This automatically refunds the customer via the original payment method.
   */
  async processRefund(
    returnId: number,
    partial: boolean = false
  ): Promise<{ success: boolean; refundAmount: number; shopifyRefundId?: string }> {
    const returnRecord = await prisma.return.findUnique({
      where: { id: returnId },
      include: {
        order: true,
        items: { include: { orderItem: true } },
      },
    });

    if (!returnRecord) {
      throw new Error(`Return not found: ${returnId}`);
    }

    // Calculate refund amount
    let refundAmount = 0;
    const refundLineItems: Array<{ lineItemId: number; quantity: number }> = [];

    for (const item of returnRecord.items) {
      const itemTotal = item.orderItem.price * item.quantity;
      refundAmount += itemTotal;
      // Find Shopify line item ID (we store orderItem.id, but we need Shopify's line item ID)
      // We need to map our OrderItem.id to Shopify's line_item.id
      // For now, we query Shopify to get the line items and match by SKU/title
      refundLineItems.push({
        lineItemId: parseInt(item.orderItem.shopifyVariantId || '0'),
        quantity: item.quantity,
      });
    }

    // For partial refunds, only refund the returned items' value
    // For full refunds, refund the entire order
    if (!partial) {
      // Add shipping refund — refund full order total
      refundAmount = returnRecord.order.totalAmount;
    }

    // Update return status
    await prisma.return.update({
      where: { id: returnId },
      data: { returnStatus: 'REFUND_PENDING', refundStatus: 'PENDING', refundAmount },
    });

    try {
      // Call Shopify to create the refund
      // We need the Shopify REST order ID and line item IDs
      const shopifyOrderId = returnRecord.order.shopifyOrderId;

      // Fetch the order from Shopify to get accurate line item IDs
      const shopifyOrder = await shopifyService.fetchOrder(shopifyOrderId);

      // Map our return items to Shopify line items
      const shopifyRefundItems = returnRecord.items.map((retItem) => {
        const shopifyLineItem = shopifyOrder.line_items.find(
          (li) =>
            (retItem.orderItem.sku && li.sku === retItem.orderItem.sku) ||
            li.title === retItem.orderItem.title
        );
        return {
          lineItemId: shopifyLineItem?.id || 0,
          quantity: retItem.quantity,
          restockType: 'return' as const,
        };
      }).filter((item) => item.lineItemId > 0);

      const refundResult = await shopifyService.createRefund(
        shopifyOrderId,
        refundAmount,
        shopifyRefundItems,
        !partial
      );

      // Update return record
      await prisma.return.update({
        where: { id: returnId },
        data: {
          returnStatus: 'REFUNDED',
          refundStatus: 'PROCESSED',
          shopifyRefundId: refundResult.refundId,
          refundProcessedAt: new Date(),
          order: {
            update: { status: 'REFUNDED' },
          },
        },
      });

      // Notify customer that refund is processed
      await notificationEngine.notifyRefundProcessed(
        returnRecord.order,
        refundAmount,
        returnRecord
      );

      // Record sync log
      await prisma.syncLog.create({
        data: {
          orderId: returnRecord.orderId,
          syncType: 'REFUND_PROCESS',
          status: 'SUCCESS',
          message: `Refund of Rs. ${refundAmount} processed on Shopify. Refund ID: ${refundResult.refundId}`,
        },
      });

      logger.info('Refund processed successfully', {
        returnId,
        refundAmount,
        shopifyRefundId: refundResult.refundId,
      });

      return { success: true, refundAmount, shopifyRefundId: refundResult.refundId };
    } catch (error: any) {
      // Mark refund as failed
      await prisma.return.update({
        where: { id: returnId },
        data: {
          refundStatus: 'FAILED',
          errorMessage: error.message,
        },
      });

      await prisma.syncLog.create({
        data: {
          orderId: returnRecord.orderId,
          syncType: 'REFUND_PROCESS',
          status: 'FAILED',
          message: `Refund processing failed`,
          errorMessage: error.message,
        },
      });

      logger.error('Refund processing failed', {
        returnId,
        error: error.message,
      });

      return { success: false, refundAmount };
    }
  }

  /**
   * Get all returns with optional status filter.
   */
  async getReturns(status?: string): Promise<any[]> {
    return prisma.return.findMany({
      where: status ? { returnStatus: status as any } : undefined,
      include: {
        order: { select: { shopifyOrderName: true, customerName: true, customerPhone: true } },
        items: { include: { orderItem: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Retry failed refunds.
   */
  async retryFailedRefunds(): Promise<number> {
    const failedReturns = await prisma.return.findMany({
      where: { refundStatus: 'FAILED' },
    });

    let retriedCount = 0;
    for (const ret of failedReturns) {
      try {
        await this.processRefund(ret.id);
        retriedCount++;
      } catch (error: any) {
        logger.error('Retry refund failed', { returnId: ret.id, error: error.message });
      }
    }

    return retriedCount;
  }
}

export default new ReturnService();
