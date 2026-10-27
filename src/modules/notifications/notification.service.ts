import prisma from '../../database/prisma';
import { config } from '../../config';
import kwikengageService from '../whatsapp/kwikengage.service';
import resendService, { EmailTemplateType } from '../email/resend.service';
import logger from '../../utils/logger';
import { Order, Return } from '@prisma/client';
import { EmailTemplateData } from '../email/email-templates';
import { isVelocityCourier } from '../../utils/courier';

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
    extra: Partial<EmailTemplateData> = {}
  ): Promise<void> {
    const to = order.customerEmail?.trim();
    if (!to) return;
    try {
      const result = await resendService.sendEmail({
        to,
        templateType,
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
    } catch (err: any) {
      logger.warn('Lifecycle email failed', {
        templateType,
        orderId: order.id,
        error: err?.message,
      });
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
   * Refund processed — sent when Shopify or GoKwik refund is completed.
   * Dispatches WhatsApp refund notice + Email refund confirmation.
   */
  async notifyRefundProcessed(order: Order, refundAmount: number, returnRecord?: Return): Promise<void> {
    try {
      await kwikengageService.sendCriticalTrigger('REFUND_PROCESSED', order, {
        customText: `A refund of ₹${Math.round(refundAmount)} for order ${order.shopifyOrderName} has been processed to your original payment method.`,
      });
    } catch (err) {
      logger.warn('KwikEngage send failed for REFUND_PROCESSED', { err });
    }
    await this.sendLifecycleEmail(order, 'RETURN_REFUND', {
      refundAmount,
      refundId: returnRecord?.shopifyRefundId || `RF-${order.shopifyOrderNumber}`,
    });
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
