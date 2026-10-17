import prisma from '../../database/prisma';
import { config } from '../../config';
import delhiveryService from '../delhivery/delhivery.service';
import shopifyService, { matchShopifyLineItem } from '../shopify/shopify.service';
import notificationEngine from '../notifications/notification.service';
import { recordAccountTrailEvent, type AccountTrailActor } from '../accounts/account-trail.service';
import logger from '../../utils/logger';
import { applyReturnCarrierScan } from './return-tracking';
import { mapReturnReason, reverseProductDescription } from './return-reasons';

/** Failed refund attempts before the hourly retry leaves a return for a person. */
export const REFUND_MAX_ATTEMPTS = 5;

/** A refund claim (PENDING) older than this was abandoned by a dead process. */
const STALE_REFUND_CLAIM_MS = 30 * 60 * 1000;

/**
 * Orders with a refund or reverse-pickup booking in flight in this process.
 * A double click must not refund twice or book two Delhivery reverse pickups
 * (each booking takes a fresh waybill, so Delhivery does not dedupe them).
 */
const refundsInFlight = new Set<number>();
const returnBookingsInFlight = new Set<number>();

/** Note for an order with no captured online payment, so nothing was refunded. */
const NO_ONLINE_PAYMENT_NOTE =
  'Shopify recorded the refund, but the order has no captured online payment (COD), so no money moved. Pay the customer by UPI or bank transfer.';

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
    if (returnBookingsInFlight.has(orderId)) {
      throw new Error('A return for this order is already being booked. Wait for it to finish.');
    }
    returnBookingsInFlight.add(orderId);
    try {
      return await this.bookReturn(orderId, returnReason, items, options);
    } finally {
      returnBookingsInFlight.delete(orderId);
    }
  }

  private async bookReturn(
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
    reason?: string,
    actor?: AccountTrailActor | null
  ): Promise<{ success: boolean; refundId: string; refundAmount: number; moneyMoved: boolean }> {
    if (refundsInFlight.has(orderId)) {
      throw new Error('A refund for this order is already in progress.');
    }
    refundsInFlight.add(orderId);
    try {
      return await this.refundOrderUnlocked(orderId, refundAmount, reason, actor);
    } finally {
      refundsInFlight.delete(orderId);
    }
  }

  private async refundOrderUnlocked(
    orderId: number,
    refundAmount?: number,
    reason?: string,
    actor?: AccountTrailActor | null
  ): Promise<{ success: boolean; refundId: string; refundAmount: number; moneyMoved: boolean }> {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true, returns: true },
    });

    if (!order) {
      throw new Error(`Order not found: ${orderId}`);
    }

    const amount = refundAmount && refundAmount > 0 ? refundAmount : order.totalAmount;
    const isPartial = amount < order.totalAmount;
    // An open customer return is closed by a full refund only. A partial
    // (goodwill) refund leaves it to run its normal scan → QC → refund course.
    const openReturn = isPartial ? undefined : order.returns.find((r) => r.refundStatus !== 'PROCESSED');

    // A partial refund is money only. A full refund also closes the line items
    // on Shopify, matched by variant so sizes are not mixed up. Items are
    // restocked only when a return is bringing them back (that return's scan
    // then records receipt without refunding again); otherwise the goods may
    // still be with the customer and are not restocked.
    let shopifyRefundItems: Array<{ lineItemId: number; quantity: number; restockType: 'return' | 'no_restock' }> = [];
    if (!isPartial) {
      const restockType = openReturn ? ('return' as const) : ('no_restock' as const);
      const shopifyOrder = await shopifyService.fetchOrder(order.shopifyOrderId);
      const taken = new Set<number>();
      shopifyRefundItems = (order.items || []).flatMap((item) => {
        const matched = matchShopifyLineItem(shopifyOrder.line_items, item, taken);
        if (!matched) return [];
        taken.add(matched.id);
        return [{ lineItemId: matched.id, quantity: item.quantity, restockType }];
      });
    }

    const refundResult = await shopifyService.createRefund(
      order.shopifyOrderId,
      amount,
      shopifyRefundItems,
      !isPartial
    );
    const refundedAmount = refundResult.amount;

    // Shopify has the refund now. Bookkeeping failures below are logged, never
    // reported as a failed refund (which would invite a second one).
    let activeReturn = openReturn;
    try {
      // A partial refund does not close the order: an in-transit parcel must
      // still be delivered and tracked normally.
      await prisma.order.update({
        where: { id: order.id },
        data: isPartial
          ? { financialStatus: 'partially_refunded' }
          : { status: 'REFUNDED', financialStatus: 'refunded' },
      });

      // Close the open return. Its later warehouse scan sees PROCESSED,
      // records receipt and QC, and does not refund again.
      if (activeReturn) {
        await prisma.return.update({
          where: { id: activeReturn.id },
          data: {
            returnStatus: 'REFUNDED',
            refundStatus: 'PROCESSED',
            refundAmount: refundedAmount,
            shopifyRefundId: refundResult.refundId,
            refundProcessedAt: new Date(),
            ...(refundResult.moneyMoved ? {} : { errorMessage: NO_ONLINE_PAYMENT_NOTE }),
          },
        });
      }

      await prisma.syncLog.create({
        data: {
          orderId: order.id,
          syncType: 'REFUND_PROCESS',
          status: 'SUCCESS',
          message: refundResult.moneyMoved
            ? `Refund of ₹${refundedAmount} processed on Shopify. Refund ID: ${refundResult.refundId}. Reason: ${reason || 'Customer refund'}`
            : `Refund recorded on Shopify (Refund ID: ${refundResult.refundId}) with no money moved. ${NO_ONLINE_PAYMENT_NOTE}`,
        },
      });
    } catch (dbErr: any) {
      logger.error('Refund succeeded on Shopify but OMS bookkeeping failed', {
        orderId: order.id,
        refundId: refundResult.refundId,
        error: dbErr.message,
      });
      activeReturn = undefined;
    }

    try {
      await recordAccountTrailEvent({
        orderId: order.id,
        returnId: activeReturn?.id,
        eventType: 'REFUND_AUTOMATIC',
        actorType: actor?.uid ? 'USER' : 'SYSTEM',
        actor: actor || { name: 'OMS automation', role: 'SYSTEM' },
        source: 'ORDER_PAGE',
        status: refundResult.moneyMoved ? 'COMPLETED' : 'NO_MONEY_MOVED',
        amount: refundResult.moneyMoved ? refundedAmount : 0,
        currency: order.currency || 'INR',
        refundMode: refundResult.moneyMoved ? 'ORIGINAL_PAYMENT_METHOD' : null,
        accountUsed: refundResult.moneyMoved
          ? order.paymentProvider || order.paymentGateway || 'Shopify original payment method'
          : null,
        externalReference: refundResult.refundId,
        note: reason || 'Refund initiated from order details.',
        metadata: { moneyMoved: refundResult.moneyMoved, isPartial, alreadyRefunded: refundResult.alreadyRefunded },
      });
    } catch (auditError: any) {
      logger.error('Refund succeeded but account-trail event could not be written', {
        orderId: order.id,
        refundId: refundResult.refundId,
        error: auditError.message,
      });
    }

    // Tell the customer only when money actually went back to them.
    if (refundResult.moneyMoved) {
      await notificationEngine.notifyRefundProcessed(order, refundedAmount, activeReturn);
    }

    return {
      success: true,
      refundId: refundResult.refundId,
      refundAmount: refundedAmount,
      moneyMoved: refundResult.moneyMoved,
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
    qcRemark?: string,
    actor?: AccountTrailActor | null
  ): Promise<{
    returnId: number;
    refundProcessed: boolean;
    refundAmount?: number;
    moneyMoved?: boolean;
    refundError?: string;
    alreadyRefunded?: boolean;
  }> {
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

    // A second scan (barcode gun double read, re-scan on another desk) must
    // never reopen a return whose refund is done or under way. A QC_REJECTED
    // return may be scanned again to change the decision.
    if (returnRecord.refundStatus === 'PENDING') {
      throw new Error(`Return ${waybillNumber} was already sent for refund. Scanning it again does not refund again.`);
    }
    if (returnRecord.returnStatus === 'CANCELLED') {
      throw new Error(`Return ${waybillNumber} is cancelled.`);
    }
    const refundedAlready = returnRecord.returnStatus === 'REFUNDED' || returnRecord.refundStatus === 'PROCESSED';
    if (refundedAlready) {
      if (returnRecord.qcCheckedAt) {
        throw new Error(`Return ${waybillNumber} was already scanned in and refunded. Scanning it again does not refund again.`);
      }
      // Refunded before the parcel arrived (direct refund from the order page).
      // The goods still have to be received and inspected; nothing is refunded.
      const now = new Date();
      await prisma.return.update({
        where: { id: returnRecord.id },
        data: { qcStatus, qcRemark: qcRemark || null, qcCheckedAt: now, receivedAt: returnRecord.receivedAt || now },
      });
      await prisma.returnItem.updateMany({
        where: { returnId: returnRecord.id },
        data: { qcStatus, qcRemark: qcRemark || null },
      });
      await prisma.syncLog.create({
        data: {
          orderId: returnRecord.orderId,
          syncType: 'RETURN_TRACKING',
          status: 'SUCCESS',
          message: `Return ${waybillNumber} received at warehouse after it was refunded. QC: ${qcStatus}. No second refund.`,
        },
      });
      return { returnId: returnRecord.id, refundProcessed: false, alreadyRefunded: true };
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

    // Mark return received and close return on Shopify
    if (returnRecord.order?.shopifyOrderId) {
      shopifyService.markReturnReceivedOnShopify(returnRecord.order.shopifyOrderId, {
        scanId: returnRecord.id,
        tracking: waybillNumber,
        issueLabel: qcRemark,
        shopifyReturnId: returnRecord.shopifyReturnId,
      }).catch((err) => {
        logger.warn('Failed to mark return received on Shopify from scanReturnAtWarehouse', {
          orderId: returnRecord.orderId,
          error: err.message,
        });
      });
    }

    // If QC approved, auto-process refund
    if (qcStatus === 'APPROVED' || qcStatus === 'PARTIAL') {
      const refundResult = await this.processRefund(returnRecord.id, qcStatus === 'PARTIAL', actor);
      return {
        returnId: returnRecord.id,
        refundProcessed: refundResult.success,
        refundAmount: refundResult.refundAmount,
        moneyMoved: refundResult.moneyMoved,
        refundError: refundResult.error,
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
  /**
   * Refund a received, QC-passed return on Shopify.
   *
   * Only the returned items are refunded, at the price the customer actually
   * paid (Shopify's refunds/calculate applies order discounts and taxes).
   * Shipping is refunded only when QC fully approved a return of every unit in
   * the order. PARTIAL QC refunds the items but does not restock them as
   * sellable, since part of the return failed inspection.
   *
   * Safe to call twice: the return is claimed atomically (NONE/FAILED →
   * PENDING) before Shopify is called, and the refund carries an idempotency
   * key, so a retry after a lost response adopts the refund Shopify already
   * made instead of refunding again.
   *
   * @param partial - true for PARTIAL QC. Defaults to the QC result stored on the return.
   */
  async processRefund(
    returnId: number,
    partial?: boolean,
    actor?: AccountTrailActor | null
  ): Promise<{ success: boolean; refundAmount: number; shopifyRefundId?: string; moneyMoved?: boolean; error?: string }> {
    const returnRecord = await prisma.return.findUnique({
      where: { id: returnId },
      include: {
        order: { include: { items: true } },
        items: { include: { orderItem: true } },
      },
    });

    if (!returnRecord) {
      throw new Error(`Return not found: ${returnId}`);
    }

    if (returnRecord.qcStatus !== 'APPROVED' && returnRecord.qcStatus !== 'PARTIAL') {
      return {
        success: false,
        refundAmount: 0,
        error: `Return ${returnRecord.returnWaybillNumber || returnId} has not passed QC (${returnRecord.qcStatus || 'not scanned'}). Scan it in with QC first.`,
      };
    }
    const partialQc = partial ?? returnRecord.qcStatus === 'PARTIAL';

    // Claim the refund. Only one caller (scan, retry cron, Returns page button)
    // can move it out of NONE/FAILED; everyone else stops here.
    const claim = await prisma.return.updateMany({
      where: { id: returnId, refundStatus: { in: ['NONE', 'FAILED'] } },
      data: { returnStatus: 'REFUND_PENDING', refundStatus: 'PENDING' },
    });
    if (claim.count === 0) {
      return {
        success: false,
        refundAmount: returnRecord.refundAmount || 0,
        error: `Refund for return ${returnRecord.returnWaybillNumber || returnId} is already ${returnRecord.refundStatus === 'PROCESSED' ? 'done' : 'in progress'}.`,
      };
    }

    let refundResult: Awaited<ReturnType<typeof shopifyService.createRefund>>;
    try {
      const shopifyOrderId = returnRecord.order.shopifyOrderId;

      // Fetch the order from Shopify to get accurate line item IDs
      const shopifyOrder = await shopifyService.fetchOrder(shopifyOrderId);

      const restockType = partialQc ? ('no_restock' as const) : ('return' as const);
      const taken = new Set<number>();
      const shopifyRefundItems = returnRecord.items.map((retItem) => {
        const lineItem = matchShopifyLineItem(shopifyOrder.line_items, retItem.orderItem, taken);
        if (!lineItem) {
          throw new Error(
            `Could not match returned item "${retItem.orderItem.title}${retItem.orderItem.variantTitle ? ` / ${retItem.orderItem.variantTitle}` : ''}" to a Shopify line item`
          );
        }
        taken.add(lineItem.id);
        return { lineItemId: lineItem.id, quantity: retItem.quantity, restockType };
      });

      const orderUnits = (returnRecord.order.items || []).reduce((sum, item) => sum + item.quantity, 0);
      const returnedUnits = returnRecord.items.reduce((sum, item) => sum + item.quantity, 0);
      const refundShipping = !partialQc && orderUnits > 0 && returnedUnits >= orderUnits;

      refundResult = await shopifyService.createRefund(
        shopifyOrderId,
        null,
        shopifyRefundItems,
        refundShipping,
        { idempotencyKey: `oms-return-${returnId}` }
      );
    } catch (error: any) {
      await prisma.return.update({
        where: { id: returnId },
        data: {
          refundStatus: 'FAILED',
          refundAttempts: { increment: 1 },
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

      return { success: false, refundAmount: 0, error: error.message };
    }

    // Shopify has the refund now. Bookkeeping failures below are logged and
    // must never mark the refund FAILED, which would make the cron retry it.
    const refundAmount = refundResult.amount;
    try {
      await prisma.return.update({
        where: { id: returnId },
        data: {
          returnStatus: 'REFUNDED',
          refundStatus: 'PROCESSED',
          refundAmount,
          shopifyRefundId: refundResult.refundId,
          refundProcessedAt: new Date(),
          errorMessage: refundResult.moneyMoved ? null : NO_ONLINE_PAYMENT_NOTE,
          order: {
            update: { status: 'REFUNDED' },
          },
        },
      });

      await prisma.syncLog.create({
        data: {
          orderId: returnRecord.orderId,
          syncType: 'REFUND_PROCESS',
          status: 'SUCCESS',
          message: refundResult.moneyMoved
            ? `Refund of Rs. ${refundAmount} processed on Shopify. Refund ID: ${refundResult.refundId}`
            : `Return refund recorded on Shopify (Refund ID: ${refundResult.refundId}) with no money moved. ${NO_ONLINE_PAYMENT_NOTE}`,
        },
      });
    } catch (dbErr: any) {
      logger.error('Refund succeeded on Shopify but the return row was not updated', {
        returnId,
        refundId: refundResult.refundId,
        error: dbErr.message,
      });
    }

    try {
      await recordAccountTrailEvent({
        orderId: returnRecord.orderId,
        returnId,
        eventType: 'REFUND_AUTOMATIC',
        actorType: actor?.uid ? 'USER' : 'SYSTEM',
        actor: actor || { name: 'OMS automation', role: 'SYSTEM' },
        source: 'RETURN_QC',
        status: refundResult.moneyMoved ? 'COMPLETED' : 'NO_MONEY_MOVED',
        amount: refundResult.moneyMoved ? refundAmount : 0,
        currency: returnRecord.order.currency || 'INR',
        refundMode: refundResult.moneyMoved ? 'ORIGINAL_PAYMENT_METHOD' : null,
        accountUsed: refundResult.moneyMoved
          ? returnRecord.order.paymentProvider || returnRecord.order.paymentGateway || 'Shopify original payment method'
          : null,
        externalReference: refundResult.refundId,
        note: refundResult.moneyMoved ? 'Automatically refunded after warehouse QC.' : NO_ONLINE_PAYMENT_NOTE,
        metadata: {
          moneyMoved: refundResult.moneyMoved,
          alreadyRefunded: refundResult.alreadyRefunded,
          qcStatus: returnRecord.qcStatus,
        },
      });
    } catch (auditError: any) {
      logger.error('Refund succeeded but account-trail event could not be written', {
        returnId,
        refundId: refundResult.refundId,
        error: auditError.message,
      });
    }

    // Tell the customer only when money actually went back to them.
    if (refundResult.moneyMoved) {
      await notificationEngine.notifyRefundProcessed(returnRecord.order, refundAmount, returnRecord);
    }

    logger.info('Refund processed successfully', {
      returnId,
      refundAmount,
      moneyMoved: refundResult.moneyMoved,
      shopifyRefundId: refundResult.refundId,
    });

    return {
      success: true,
      refundAmount,
      shopifyRefundId: refundResult.refundId,
      moneyMoved: refundResult.moneyMoved,
    };
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
    // A claim (PENDING) left behind by a process that died mid-refund (a
    // deploy restart) is retried too. The idempotency key makes that retry
    // adopt the refund if Shopify already made it.
    await prisma.return.updateMany({
      where: {
        refundStatus: 'PENDING',
        updatedAt: { lt: new Date(Date.now() - STALE_REFUND_CLAIM_MS) },
      },
      data: { refundStatus: 'FAILED', errorMessage: 'Refund attempt was interrupted; retrying.' },
    });

    // Only returns that passed QC, and only up to the attempt cap. The QC
    // result stored on the return decides full vs partial, so a PARTIAL
    // return is never retried as a full refund.
    const failedReturns = await prisma.return.findMany({
      where: {
        refundStatus: 'FAILED',
        qcStatus: { in: ['APPROVED', 'PARTIAL'] },
        refundAttempts: { lt: REFUND_MAX_ATTEMPTS },
      },
      select: { id: true },
      take: 50,
    });

    let retriedCount = 0;
    for (const ret of failedReturns) {
      try {
        const result = await this.processRefund(ret.id);
        if (result.success) retriedCount++;
      } catch (error: any) {
        logger.error('Retry refund failed', { returnId: ret.id, error: error.message });
      }
    }

    return retriedCount;
  }
}

export default new ReturnService();
