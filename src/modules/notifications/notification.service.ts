import prisma from '../../database/prisma';
import { config } from '../../config';
import kwikengageService from '../whatsapp/kwikengage.service';
import resendService, { EmailTemplateType } from '../email/resend.service';
import emailLogService from '../email/email-log.service';
import firebaseService from '../firebase/firebase.service';
import logger from '../../utils/logger';
import { Order, Return } from '@prisma/client';
import { EmailTemplateData } from '../email/email-templates';
import { isVelocityCourier } from '../../utils/courier';
import {
  extractRefundDetailsFromShopify,
  formatCustomerRefundSource,
  OrderRefundSummary,
} from '../returns/refund-details';

/**
 * Notification Engine
 * Central service that synchronizes multi-channel customer communications across:
 * 1. Meta WhatsApp via GoKwik's official KwikEngage API (https://api.kwikengage.ai/send-message/v2)
 * 2. Customer transactional emails via Resend (https://api.resend.com)
 *
 * Every critical order lifecycle event dispatches BOTH email and WhatsApp utility updates.
 */
class NotificationEngine {
  /**
   * Best-effort Resend email for a lifecycle event. Never throws — a mail
   * failure must not roll back a tracking or webhook status change.
   */
  private async sendLifecycleEmail(
    order: Order,
    templateType: EmailTemplateType,
    extra: Partial<EmailTemplateData> = {},
    options: { fromEmail?: string; replyTo?: string; force?: boolean } = {}
  ): Promise<any> {
    const to = order.customerEmail?.trim();
    if (!to) return null;
    try {
      const result = await resendService.sendEmail({
        to,
        templateType,
        fromEmail: options.fromEmail,
        replyTo: options.replyTo,
        force: options.force,
        orderId: order.id,
        syncWhatsApp: false, // Prevent duplicate WhatsApp dispatch since notificationEngine handles it directly
        data: {
          orderName: order.shopifyOrderName,
          customerName: order.customerName,
          recipientEmail: to,
          customerAddress: [order.customerAddress, order.customerCity, order.customerState, order.customerPincode]
            .filter(Boolean)
            .join(', '),
          totalAmount: order.totalAmount,
          paymentMethod: order.paymentMethod || undefined,
          courier: 'Delhivery Express',
          ...extra,
        },
      });
      if (!result.success) {
        logger.warn('Lifecycle email was not accepted', {
          templateType,
          orderId: order.id,
          error: 'error' in result ? result.error : undefined,
        });
      }
      return result;
    } catch (err: any) {
      logger.warn('Lifecycle email failed', {
        templateType,
        orderId: order.id,
        error: err?.message,
      });
      return null;
    }
  }

  /**
   * Order confirmed — sent when a new order is synced from Shopify.
   * Dispatches WhatsApp order confirmation + Email order confirmation.
   */
  async notifyOrderConfirmed(order: Order): Promise<void> {
    try {
      await kwikengageService.sendCriticalTrigger('ORDER_CONFIRMED', order);
    } catch (err) {
      logger.warn('KwikEngage send failed for ORDER_CONFIRMED', { err });
    }
    await this.sendLifecycleEmail(order, 'ORDER_CONFIRMED');
  }

  /**
   * COD Confirmation — critical trigger requesting customer confirmation to reduce RTO risk.
   */
  async notifyCodConfirmation(order: Order): Promise<void> {
    try {
      await kwikengageService.sendCriticalTrigger('COD_CONFIRMATION', order);
    } catch (err) {
      logger.error('Failed to dispatch COD confirmation via KwikEngage', { err });
    }
  }

  /**
   * Order shipped — sent when AWB is generated and shipment is dispatched via Delhivery.
   * Dispatches WhatsApp dispatch update + Email in-transit notice.
   */
  async notifyOrderShipped(order: Order, waybillNumber: string, courierName?: string): Promise<void> {
    const isVel = isVelocityCourier(courierName, null, waybillNumber);
    const resolvedCourier = courierName || (isVel ? 'Velocity' : 'Delhivery Express');
    try {
      await kwikengageService.sendCriticalTrigger('ORDER_SHIPPED', order, {
        waybillNumber,
        courierName: resolvedCourier,
      });
    } catch (err) {
      logger.warn('KwikEngage send failed for ORDER_SHIPPED', { err });
    }
    await this.sendLifecycleEmail(order, 'IN_TRANSIT', {
      waybillNumber,
      courier: resolvedCourier,
    });
  }

  /**
   * In transit — sent when parcel departs the origin hub and travels between fulfillment centers.
   * Dispatches WhatsApp in-transit alert + Email in-transit notice.
   */
  async notifyInTransit(order: Order, waybillNumber?: string, location?: string, courierName?: string): Promise<void> {
    const isVel = isVelocityCourier(courierName, null, waybillNumber);
    const resolvedCourier = courierName || (isVel ? 'Velocity' : 'Delhivery Express');
    try {
      await kwikengageService.sendCriticalTrigger('IN_TRANSIT', order, {
        waybillNumber,
        courierName: resolvedCourier,
        currentLocation: location,
      });
    } catch (err) {
      logger.warn('KwikEngage send failed for IN_TRANSIT', { err });
    }
    await this.sendLifecycleEmail(order, 'IN_TRANSIT', {
      waybillNumber,
      currentLocation: location,
      courier: resolvedCourier,
    });
  }

  /**
   * Transit Delay — sent when shipment encounters routing or weather delay in transit.
   * Dispatches WhatsApp transit delay notice + Email transit delay notice.
   */
  async notifyTransitDelay(
    order: Order,
    extra: {
      waybillNumber?: string;
      delayReason?: string;
      newEstimatedDelivery?: string;
      currentLocation?: string;
      courierName?: string;
    } = {}
  ): Promise<void> {
    const isVel = isVelocityCourier(extra.courierName, null, extra.waybillNumber);
    const resolvedCourier = extra.courierName || (isVel ? 'Velocity' : 'Delhivery Express');
    try {
      await kwikengageService.sendCriticalTrigger('TRANSIT_DELAY', order, {
        waybillNumber: extra.waybillNumber,
        delayReason: extra.delayReason,
        newEstimatedDelivery: extra.newEstimatedDelivery,
        currentLocation: extra.currentLocation,
        courierName: resolvedCourier,
      });
    } catch (err) {
      logger.warn('KwikEngage send failed for TRANSIT_DELAY', { err });
    }
    await this.sendLifecycleEmail(order, 'TRANSIT_DELAY', {
      waybillNumber: extra.waybillNumber,
      delayReason: extra.delayReason,
      newEstimatedDelivery: extra.newEstimatedDelivery,
      currentLocation: extra.currentLocation,
      courier: resolvedCourier,
    });
  }

  /**
   * Dispatch Delay — sent when order fulfillment at Surat warehouse takes longer than normal.
   * Dispatches WhatsApp dispatch delay notice + Email dispatch delay notice.
   */
  async notifyDispatchDelay(
    order: Order,
    extra: {
      delayReason?: string;
      newEstimatedDelivery?: string;
    } = {}
  ): Promise<void> {
    try {
      await kwikengageService.sendCriticalTrigger('DISPATCH_DELAY', order, {
        delayReason: extra.delayReason,
        newEstimatedDelivery: extra.newEstimatedDelivery,
      });
    } catch (err) {
      logger.warn('KwikEngage send failed for DISPATCH_DELAY', { err });
    }
    await this.sendLifecycleEmail(order, 'DISPATCH_DELAY', {
      delayReason: extra.delayReason,
      newEstimatedDelivery: extra.newEstimatedDelivery,
    });
  }

  /**
   * Out for delivery — sent when tracking shows OFD status.
   * Dispatches WhatsApp OFD alert + Email OFD notice.
   */
  async notifyOutForDelivery(order: Order, waybillNumber?: string, location?: string, courierName?: string): Promise<void> {
    const isVel = isVelocityCourier(courierName, null, waybillNumber);
    const resolvedCourier = courierName || (isVel ? 'Velocity' : 'Delhivery Express');
    try {
      await kwikengageService.sendCriticalTrigger('OUT_FOR_DELIVERY', order, {
        waybillNumber,
        courierName: resolvedCourier,
        currentLocation: location,
      });
    } catch (err) {
      logger.warn('KwikEngage send failed for OUT_FOR_DELIVERY', { err });
    }
    await this.sendLifecycleEmail(order, 'OUT_FOR_DELIVERY', {
      waybillNumber,
      currentLocation: location,
      courier: resolvedCourier,
    });
  }

  /**
   * Delivered — sent when tracking shows delivery confirmation.
   * If KwikEngage automated Journey Flow is active (KWIKENGAGE_FLOW_ORDER_DELIVERED_ACTIVE=true),
   * WhatsApp dispatch is handled by KwikEngage's native flow to prevent duplicate messages.
   * Dispatches Email delivery confirmation via Resend.
   */
  async notifyDelivered(order: Order, waybillNumber?: string, courierName?: string): Promise<void> {
    const isVel = isVelocityCourier(courierName, null, waybillNumber);
    const resolvedCourier = courierName || (isVel ? 'Velocity' : 'Delhivery Express');
    const shouldSendWhatsAppDelivered =
      config.kwikengage.dispatchDelivered && !config.kwikengage.flowOrderDeliveredActive;

    if (shouldSendWhatsAppDelivered) {
      try {
        await kwikengageService.sendCriticalTrigger('DELIVERED', order, {
          waybillNumber,
          courierName: resolvedCourier,
        });
      } catch (err) {
        logger.warn('KwikEngage send failed for DELIVERED', { err });
      }
    } else {
      logger.info('Skipping OMS KwikEngage WhatsApp delivery dispatch (managed by KwikEngage native Journey Flow)', {
        orderId: order.id,
        orderName: order.shopifyOrderName,
      });
    }

    await this.sendLifecycleEmail(order, 'DELIVERED', {
      waybillNumber,
      courier: resolvedCourier,
    });
  }

  /**
   * NDR alert — delivery attempt failed (customer unreachable, address issue).
   * Dispatches WhatsApp NDR alert + Email NDR notice.
   */
  async notifyNDR(order: Order, remark: string, waybillNumber?: string, courierName?: string): Promise<void> {
    const isVel = isVelocityCourier(courierName, null, waybillNumber);
    const resolvedCourier = courierName || (isVel ? 'Velocity' : 'Delhivery Express');
    try {
      await kwikengageService.sendCriticalTrigger('NDR_ALERT', order, {
        ndrReason: remark,
        waybillNumber,
        courierName: resolvedCourier,
      });
    } catch (err) {
      logger.warn('KwikEngage send failed for NDR_ALERT', { err });
    }
    await this.sendLifecycleEmail(order, 'NDR_ALERT', {
      waybillNumber,
      delayReason: remark,
      courier: resolvedCourier,
    });
  }

  /**
   * Return initiated — sent when a return request is created.
   * Dispatches WhatsApp return notice + Email return notice.
   */
  async notifyReturnInitiated(order: Order, returnRecord: Return): Promise<void> {
    const isVel = isVelocityCourier(returnRecord.carrier, returnRecord.returnWaybillNumber);
    const courierLabel = isVel ? 'Velocity Reverse' : (returnRecord.carrier || 'Delhivery Surface Reverse');
    try {
      await kwikengageService.sendCriticalTrigger('RETURN_INITIATED', order, {
        waybillNumber: returnRecord.returnWaybillNumber || undefined,
        ndrReason: returnRecord.returnReason,
        courierName: courierLabel,
      });
    } catch (err) {
      logger.warn('KwikEngage send failed for RETURN_INITIATED', { err });
    }
    await this.sendLifecycleEmail(order, 'RETURN_INITIATED', {
      waybillNumber: returnRecord.returnWaybillNumber || undefined,
      returnReason: returnRecord.returnReason,
      courier: courierLabel,
    });
  }

  /**
   * Return received at warehouse — sent when returned goods are scanned.
   * Dispatches WhatsApp return received notice + Email return received notice.
   */
  async notifyReturnReceived(order: Order): Promise<void> {
    try {
      await kwikengageService.sendCriticalTrigger('RETURN_RECEIVED', order);
    } catch (err) {
      logger.warn('KwikEngage send failed for RETURN_RECEIVED', { err });
    }
    await this.sendLifecycleEmail(order, 'RETURN_RECEIVED');
  }

  /**
   * Refund processed — sent when Shopify, GoKwik, RTO, or manual COD refund is completed.
   * Dispatches WhatsApp refund notice + official Refund Receipt Email from refunds@youthnic.com
   * with exact Refund RRN, Gateway ARN, Shopify Refund ID, Refund Source, and refunded items.
   */
  async notifyRefundProcessed(
    order: Order & { items?: any[] },
    refundAmount: number,
    returnRecord?: (Return & { items?: any[] }) | null,
    options: {
      shopifyRefundId?: string | null;
      refundRrn?: string | null;
      refundArn?: string | null;
      refundSource?: string | null;
      manualMode?: string | null;
      refundGatewayStatus?: string | null;
      refundProcessedAt?: Date | string | null;
      refundContext?: 'RETURN' | 'RTO' | 'ORDER' | 'MANUAL_COD';
      qcStatus?: string | null;
      qcRemark?: string | null;
      forceEmail?: boolean;
      skipWhatsApp?: boolean;
    } = {}
  ): Promise<{ emailDispatched: boolean; emailResult: any }> {
    const extracted = extractRefundDetailsFromShopify({
      noteAttributes: Array.isArray(order.additionalDetails) ? (order.additionalDetails as any) : undefined,
      tags: order.tags,
      paymentGateway: order.paymentGateway,
      paymentProvider: order.paymentProvider,
      paymentMethod: order.paymentMethod,
    });

    const shopifyRefundId =
      options.shopifyRefundId ||
      returnRecord?.shopifyRefundId ||
      undefined;
    const refundRrn =
      options.refundRrn ||
      returnRecord?.refundRrn ||
      order.refundRrn ||
      extracted.refundRrn ||
      undefined;
    const refundArn =
      options.refundArn ||
      returnRecord?.refundArn ||
      order.refundArn ||
      extracted.refundArn ||
      undefined;

    const customerSource = formatCustomerRefundSource({
      paymentInstrument: order.paymentInstrument || extracted.paymentInstrument,
      paymentProvider: order.paymentProvider || extracted.paymentProvider,
      paymentGateway: order.paymentGateway,
      refundSource: options.refundSource || returnRecord?.refundSource || order.refundSource || extracted.refundSource,
      manualMode: options.manualMode,
    });

    const gatewayStatus =
      options.refundGatewayStatus ||
      returnRecord?.refundGatewayStatus ||
      order.refundGatewayStatus ||
      extracted.refundGatewayStatus ||
      undefined;

    const refParts: string[] = [];
    if (refundRrn) refParts.push(`RRN: ${refundRrn}`);
    if (refundArn) refParts.push(`ARN: ${refundArn}`);
    if (shopifyRefundId) refParts.push(`Refund ID: ${shopifyRefundId}`);
    const refSuffix = refParts.length ? ` (${refParts.join(' · ')})` : '';

    if (!options.skipWhatsApp) {
      try {
        await kwikengageService.sendCriticalTrigger('REFUND_PROCESSED', order, {
          customText: `A refund of ₹${refundAmount.toFixed(2)} for order ${order.shopifyOrderName} has been processed to ${customerSource}${refSuffix}.`,
        });
      } catch (err) {
        logger.warn('KwikEngage send failed for REFUND_PROCESSED', { err });
      }
    }

    // Resolve refunded items (prefer returned items if partial return, else order items)
    let emailItems: EmailTemplateData['items'] = undefined;
    if (Array.isArray(returnRecord?.items) && returnRecord.items.length > 0) {
      emailItems = returnRecord.items.map((ri: any) => ({
        title: ri.orderItem?.title || 'Returned Item',
        variantTitle: ri.orderItem?.variantTitle || null,
        quantity: ri.quantity || 1,
        price: ri.orderItem?.price || 0,
        imageUrl: ri.orderItem?.imageUrl || null,
      }));
    } else if (Array.isArray(order.items) && order.items.length > 0) {
      emailItems = order.items.map((i: any) => ({
        title: i.title,
        variantTitle: i.variantTitle || null,
        quantity: i.quantity || 1,
        price: i.price || 0,
        imageUrl: i.imageUrl || null,
      }));
    } else if (order.id && typeof (prisma as any)?.orderItem?.findMany === 'function') {
      try {
        const dbItems = await prisma.orderItem.findMany({ where: { orderId: order.id } });
        if (dbItems.length > 0) {
          emailItems = dbItems.map((i) => ({
            title: i.title,
            variantTitle: i.variantTitle || null,
            quantity: i.quantity,
            price: i.price,
            imageUrl: i.imageUrl || null,
          }));
        }
      } catch {
        // Non-fatal: email still sends without item breakdown if DB query unavailable
      }
    }

    const processedAtIso =
      options.refundProcessedAt instanceof Date
        ? options.refundProcessedAt.toISOString()
        : typeof options.refundProcessedAt === 'string'
          ? options.refundProcessedAt
          : returnRecord?.refundProcessedAt
            ? new Date(returnRecord.refundProcessedAt).toISOString()
            : new Date().toISOString();

    const emailResult = await this.sendLifecycleEmail(
      order,
      'RETURN_REFUND',
      {
        refundAmount,
        refundId: shopifyRefundId || (!refundRrn && !refundArn ? `RF-${order.shopifyOrderNumber}` : undefined),
        refundRrn,
        refundArn,
        refundSource: customerSource,
        settlementGateway: customerSource,
        refundGatewayStatus: gatewayStatus,
        refundProcessedAt: processedAtIso,
        refundContext: options.refundContext || (returnRecord ? 'RETURN' : 'ORDER'),
        returnWaybill: returnRecord?.returnWaybillNumber || undefined,
        qcStatus: options.qcStatus || returnRecord?.qcStatus || undefined,
        qcRemark: options.qcRemark || returnRecord?.qcRemark || undefined,
        items: emailItems,
      },
      {
        fromEmail: 'Youthnic Refunds <refunds@youthnic.com>',
        replyTo: 'refunds@youthnic.com',
        force: options.forceEmail,
      }
    );

    const emailDispatched = Boolean(emailResult?.success && emailResult?.mode !== 'SKIPPED');

    if (emailDispatched && returnRecord?.id && typeof (prisma as any)?.return?.update === 'function') {
      prisma.return
        .update({ where: { id: returnRecord.id }, data: { refundEmailSentAt: new Date() } })
        .catch(() => undefined);
    }

    if (emailDispatched && order.customerEmail) {
      firebaseService
        .syncCustomerHistory(order.customerEmail, {
          type: 'OUTBOUND_EMAIL',
          channel: 'EMAIL',
          title: `Refund Processed: ₹${refundAmount.toFixed(2)} for Order ${order.shopifyOrderName}`,
          description: `Source: ${customerSource}${refSuffix}.`,
          timestamp: new Date().toISOString(),
          sender: 'Youthnic Refunds <refunds@youthnic.com>',
          recipient: order.customerEmail,
          orderId: order.id,
          shopifyOrderName: order.shopifyOrderName,
          status: 'SENT',
        })
        .catch(() => undefined);
    }

    return { emailDispatched, emailResult };
  }

  /**
   * Sends the Bank RRN / Gateway ARN credit confirmation email once the gateway confirms
   * the bank reference asynchronously (typically 1–2 hours after Shopify refund initiation).
   * Strictly deduplicated: sends at most once per order, and skips if the initial refund
   * email already carried the same RRN/ARN.
   */
  async notifyRefundRrnUpdated(
    order: Order & { items?: any[] },
    summary: OrderRefundSummary,
    returnRecord?: (Return & { items?: any[] }) | null
  ): Promise<boolean> {
    const to = order.customerEmail?.trim();
    if (!to) return false;
    if (!summary.refundRrn && !summary.refundArn) return false;

    const priorRefundEmail =
      typeof emailLogService.findDeliveredNotification === 'function'
        ? await emailLogService.findDeliveredNotification(order.id, 'RETURN_REFUND')
        : null;

    // If no refund email was ever sent yet, send the full RETURN_REFUND receipt directly with RRN/ARN!
    if (!priorRefundEmail) {
      const { emailDispatched } = await this.notifyRefundProcessed(
        order,
        summary.refundAmount ?? order.totalAmount,
        returnRecord,
        {
          shopifyRefundId: summary.shopifyRefundId,
          refundRrn: summary.refundRrn,
          refundArn: summary.refundArn,
          refundSource: summary.customerRefundSource,
          refundGatewayStatus: summary.refundGatewayStatus,
          refundProcessedAt: summary.refundProcessedAt,
          refundContext: summary.isManualCod ? 'MANUAL_COD' : returnRecord ? 'RETURN' : 'ORDER',
        }
      );
      return emailDispatched;
    }

    // If the earlier RETURN_REFUND email already contained this exact RRN (or ARN when no RRN), skip
    const priorMeta = (priorRefundEmail.metadata && typeof priorRefundEmail.metadata === 'object'
      ? priorRefundEmail.metadata
      : {}) as Record<string, any>;
    if (summary.refundRrn && priorMeta.refundRrn === summary.refundRrn) {
      return false;
    }
    if (!summary.refundRrn && summary.refundArn && priorMeta.refundArn === summary.refundArn) {
      return false;
    }

    const customerSource = summary.customerRefundSource || 'Original Payment Method';
    const amount = summary.refundAmount ?? order.totalAmount;

    let emailItems: EmailTemplateData['items'] = undefined;
    if (Array.isArray(returnRecord?.items) && returnRecord.items.length > 0) {
      emailItems = returnRecord.items.map((ri: any) => ({
        title: ri.orderItem?.title || 'Returned Item',
        variantTitle: ri.orderItem?.variantTitle || null,
        quantity: ri.quantity || 1,
        price: ri.orderItem?.price || 0,
        imageUrl: ri.orderItem?.imageUrl || null,
      }));
    } else if (Array.isArray(order.items) && order.items.length > 0) {
      emailItems = order.items.map((i: any) => ({
        title: i.title,
        variantTitle: i.variantTitle || null,
        quantity: i.quantity || 1,
        price: i.price || 0,
        imageUrl: i.imageUrl || null,
      }));
    }

    const emailResult = await this.sendLifecycleEmail(
      order,
      'REFUND_RRN_UPDATE',
      {
        refundAmount: amount,
        refundId: summary.shopifyRefundId || undefined,
        refundRrn: summary.refundRrn || undefined,
        refundArn: summary.refundArn || undefined,
        refundSource: customerSource,
        settlementGateway: customerSource,
        refundGatewayStatus: summary.refundGatewayStatus || 'CREDITED',
        refundProcessedAt: summary.refundProcessedAt || undefined,
        returnWaybill: returnRecord?.returnWaybillNumber || undefined,
        items: emailItems,
      },
      {
        fromEmail: 'Youthnic Refunds <refunds@youthnic.com>',
        replyTo: 'refunds@youthnic.com',
      }
    );

    const dispatched = Boolean(emailResult?.success && emailResult?.mode !== 'SKIPPED');
    if (dispatched) {
      if (returnRecord?.id && typeof (prisma as any)?.return?.update === 'function') {
        prisma.return
          .update({ where: { id: returnRecord.id }, data: { refundEmailSentAt: new Date() } })
          .catch(() => undefined);
      }

      const refLabel = summary.refundRrn
        ? `Bank RRN: ${summary.refundRrn}`
        : `Refund ARN: ${summary.refundArn}`;
      try {
        await kwikengageService.sendCriticalTrigger('REFUND_PROCESSED', order, {
          customText: `Your refund of ₹${amount.toFixed(2)} for order ${order.shopifyOrderName} has been credited to ${customerSource}. ${refLabel}.`,
        });
      } catch (err) {
        logger.warn('KwikEngage send failed for REFUND_RRN_UPDATE', { err });
      }

      firebaseService
        .syncCustomerHistory(to, {
          type: 'OUTBOUND_EMAIL',
          channel: 'EMAIL',
          title: `Refund Credited (${refLabel}) · Order ${order.shopifyOrderName}`,
          description: `₹${amount.toFixed(2)} credited to ${customerSource}. ${refLabel}.`,
          timestamp: new Date().toISOString(),
          sender: 'Youthnic Refunds <refunds@youthnic.com>',
          recipient: to,
          orderId: order.id,
          shopifyOrderName: order.shopifyOrderName,
          status: 'SENT',
        })
        .catch(() => undefined);
    }

    return dispatched;
  }

  /**
   * Send a custom message to a customer.
   * Never throws — tracking/RTO flows must continue even if WhatsApp is down.
   */
  async sendCustomMessage(order: Order, message: string): Promise<void> {
    try {
      await kwikengageService.sendCriticalTrigger('CUSTOM', order, {
        customText: message,
      });
    } catch (err: any) {
      logger.warn('KwikEngage send failed for CUSTOM message', { orderId: order.id, error: err?.message });
    }
  }
}

export default new NotificationEngine();
