import prisma from '../../database/prisma';
import { config } from '../../config';
import delhiveryService from '../delhivery/delhivery.service';
import shopifyService from '../shopify/shopify.service';
import notificationEngine from '../notifications/notification.service';
import logger from '../../utils/logger';
import { applyReturnCarrierScan } from './return-tracking';
import { mapReturnReason, reverseProductDescription } from './return-reasons';

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
  ): Promise<{
    returnId: number;
    returnWaybill: string;
    shopifyTriggered: boolean;
    pickupAutomatic: boolean;
    forwardWaybill: string | null;
    shopifyReturnId: string | null;
  }> {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true, returns: true, shipment: true },
    });

    if (!order) {
      throw new Error(`Order not found: ${orderId}`);
    }

    const activeReturn = order.returns.find(
      (r) => !['REFUNDED', 'CANCELLED'].includes(r.returnStatus)
    );
    if (activeReturn) {
      throw new Error(`Order ${order.shopifyOrderName} already has an active return (${activeReturn.returnWaybillNumber || activeReturn.returnStatus}).`);
    }

    if (!items.length) {
      throw new Error('Select at least one item to return.');
    }

    if (['RTO_INITIATED', 'RTO_DELIVERED', 'CANCELLED', 'REFUNDED'].includes(order.status)) {
      throw new Error(`Order ${order.shopifyOrderName} is ${order.status.replaceAll('_', ' ').toLowerCase()}. A customer reverse pickup is not created for that state.`);
    }

    for (const item of items) {
      const line = order.items.find((row) => row.id === item.orderItemId);
      if (!line) throw new Error('One of the return items does not belong to this order.');
      if (!Number.isFinite(item.quantity) || item.quantity < 1 || item.quantity > line.quantity) {
        throw new Error(`Return quantity for ${line.title} must be between 1 and ${line.quantity}.`);
      }
    }

    const carrierName = (options?.carrier || 'Delhivery').trim() || 'Delhivery';
    const isDelhivery = /delhivery/i.test(carrierName);
    const typedWaybill = (options?.returnWaybillNumber || '').trim();
    if (/^REV-DEL-/i.test(typedWaybill)) {
      throw new Error('Placeholder return codes are not accepted. Leave the AWB blank so Delhivery can assign a real reverse waybill.');
    }

    const forwardWaybill = order.shipment?.waybillNumber || null;
    const forwardDelivered =
      order.status === 'DELIVERED' ||
      Boolean(order.deliveredAt) ||
      order.shipment?.status === 'DELIVERED' ||
      (/delivered/i.test(order.shipment?.trackingStatus || '') && !/undeliver/i.test(order.shipment?.trackingStatus || ''));

    let finalReturnWaybill = typedWaybill;
    let pickupAutomatic = false;

    if (isDelhivery && !finalReturnWaybill) {
      if (!forwardDelivered) {
        throw new Error(
          `Reverse pickup is created after the forward shipment is delivered, the same way Delhivery ONE "Initiate Return" works. ${order.shopifyOrderName} is still ${order.status}.`
        );
      }
      const selectedLines = items.map((item) => {
        const line = order.items.find((row) => row.id === item.orderItemId)!;
        return { title: line.title, sku: line.sku, quantity: item.quantity };
      });
      const created = await delhiveryService.createReturnShipment(
        order,
        returnReason,
        forwardWaybill || undefined,
        selectedLines
      );
      finalReturnWaybill = created.waybillNumber;
      pickupAutomatic = true;
    } else if (!finalReturnWaybill) {
      throw new Error(`Enter the ${carrierName} return waybill. Automatic reverse pickup is available for Delhivery.`);
    } else if (isDelhivery && !/^\d{8,}$/.test(finalReturnWaybill)) {
      throw new Error('A Delhivery return AWB is the numeric waybill from Delhivery. Leave the field blank to create one automatically.');
    }

    let labelUrl: string | null = null;
    if (isDelhivery && pickupAutomatic) {
      try {
        const generated = await delhiveryService.generateLabel(finalReturnWaybill);
        labelUrl = generated || null;
      } catch {
        labelUrl = null;
      }
    }

    const returnRecord = await prisma.return.create({
      data: {
        orderId: order.id,
        returnReason,
        returnStatus: 'PICKUP_SCHEDULED',
        returnWaybillNumber: finalReturnWaybill,
        returnShipmentStatus: pickupAutomatic ? 'Pickup scheduled' : 'Linked',
        forwardWaybill,
        carrier: carrierName,
        pickupAutomatic,
        trackingStatus: pickupAutomatic ? 'Pickup scheduled' : 'Linked AWB',
        labelUrl,
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
    let shopifyReturnId: string | null = null;
    if (options?.triggerShopify !== false) {
      const shopifyRes = await shopifyService.registerReturnOnShopify(order.shopifyOrderId, {
        returnReason,
        returnTrackingNumber: finalReturnWaybill,
        carrier: options?.carrier || 'Delhivery',
        items: items.map((item) => {
          const line = order.items.find((row) => row.id === item.orderItemId);
          return { sku: line?.sku, title: line?.title, quantity: item.quantity };
        }),
      });
      shopifyTriggered = shopifyRes.success;
      shopifyReturnId = shopifyRes.shopifyReturnId || null;
      if (shopifyReturnId) {
        await prisma.return.update({
          where: { id: returnRecord.id },
          data: { shopifyReturnId },
        });
      }
    }

    // Notify customer via WhatsApp
    await notificationEngine.notifyReturnInitiated(order, returnRecord);

    // Record sync log
    await prisma.syncLog.create({
      data: {
        orderId: order.id,
        syncType: 'RETURN_CREATE',
        status: 'SUCCESS',
        message: pickupAutomatic
          ? `Reverse AWB ${finalReturnWaybill} manifested against forward ${forwardWaybill || 'order'}. Delhivery schedules the customer pickup automatically.`
          : `Return linked with waybill ${finalReturnWaybill}${shopifyTriggered ? ' · Synced to Shopify' : ''}`,
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
      pickupAutomatic,
      forwardWaybill,
      shopifyReturnId,
    };
  }

  /**
   * Change the return reason before Delhivery picks the parcel up.
   * Delhivery's edit API accepts products_desc while the reverse shipment is
   * still manifested / scheduled. Shopify's return reason is fixed at
   * returnCreate; a later change is written to the order note.
   */
  async updateReturnReason(returnId: number, returnReason: string): Promise<{
    returnReason: string;
    delhiveryReason: string;
    delhiveryUpdated: boolean;
    delhiveryError?: string;
  }> {
    const reason = returnReason.trim();
    if (!reason) throw new Error('A return reason is required.');
    const record = await prisma.return.findUnique({
      where: { id: returnId },
      include: { order: true },
    });
    if (!record) throw new Error('Return not found.');
    const locked = ['PICKED_UP', 'IN_TRANSIT', 'RECEIVED', 'QC_PENDING', 'QC_APPROVED', 'QC_REJECTED', 'REFUND_PENDING', 'REFUNDED', 'CANCELLED'];
    if (locked.includes(record.returnStatus)) {
      throw new Error('The reason can only be changed before Delhivery picks up the return.');
    }

    const mapped = mapReturnReason(reason);
    let delhiveryUpdated = false;
    let delhiveryError: string | undefined;
    if (record.returnWaybillNumber && /delhivery/i.test(record.carrier || 'Delhivery')) {
      try {
        await delhiveryService.updateShipment(record.returnWaybillNumber, {
          productsDescription: reverseProductDescription(reason),
        });
        delhiveryUpdated = true;
      } catch (error: any) {
        delhiveryError = error.message || 'Delhivery did not accept the reason update.';
        logger.warn('Delhivery return reason update failed', { returnId, error: delhiveryError });
      }
    }

    await prisma.return.update({
      where: { id: returnId },
      data: { returnReason: reason },
    });

    try {
      await shopifyService.registerReturnOnShopify(record.order.shopifyOrderId, {
        returnReason: `Reason updated to ${mapped.delhiveryReason}: ${reason}`,
        returnTrackingNumber: record.returnWaybillNumber || undefined,
        carrier: record.carrier || 'Delhivery',
        noteOnly: true,
      });
    } catch (error: any) {
      logger.warn('Shopify note for return reason update failed', { returnId, error: error.message });
    }

    return { returnReason: reason, delhiveryReason: mapped.delhiveryReason, delhiveryUpdated, delhiveryError };
  }

  /**
   * Poll Delhivery for open reverse AWBs and advance return + order status.
   * Called from the tracking cron. No manual status marking.
   */
  async syncActiveReturns(force = false): Promise<number> {
    const minIntervalMs = (config.tracking.minIntervalMinutes || 10) * 60 * 1000;
    const staleBefore = new Date(Date.now() - minIntervalMs);
    const rows = await prisma.return.findMany({
      where: {
        returnWaybillNumber: { not: null },
        returnStatus: { in: ['INITIATED', 'PICKUP_SCHEDULED', 'PICKED_UP', 'IN_TRANSIT'] },
        ...(force
          ? {}
          : { OR: [{ trackingUpdatedAt: null }, { trackingUpdatedAt: { lt: staleBefore } }] }),
      },
      orderBy: { trackingUpdatedAt: 'asc' },
      take: 100,
    });

    let updated = 0;
    for (const row of rows) {
      if (!row.returnWaybillNumber) continue;
      try {
        const tracking = await delhiveryService.trackShipment(row.returnWaybillNumber);
        const handled = await applyReturnCarrierScan(row.returnWaybillNumber, {
          statusType: tracking.statusType,
          status: tracking.status,
          location: tracking.location,
          remarks: tracking.remarks,
          scannedAt: tracking.scanDateTime ? new Date(tracking.scanDateTime) : new Date(),
          history: tracking.history,
        });
        if (handled === 'updated') updated += 1;
      } catch (err: any) {
        logger.warn('Reverse tracking poll failed', {
          returnId: row.id,
          waybill: row.returnWaybillNumber,
          error: err.message,
        });
      }
    }
    return updated;
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
