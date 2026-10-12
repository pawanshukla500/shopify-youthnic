import prisma from '../../database/prisma';
import kwikengageService from '../whatsapp/kwikengage.service';
import resendService, { EmailTemplateType } from '../email/resend.service';
import logger from '../../utils/logger';
import { Order, Return } from '@prisma/client';
import { NotificationPayload } from '../../types';
import { EmailTemplateData } from '../email/email-templates';

/**
 * Notification Engine
 * Central service that triggers critical WhatsApp messages at each order lifecycle stage
 * powered by GoKwik's official KwikEngage WhatsApp API (https://api.kwikengage.ai/send-message/v2).
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
        data: {
          orderName: order.shopifyOrderName,
          customerName: order.customerName,
          recipientEmail: to,
          customerAddress: [order.customerAddress, order.customerCity, order.customerPincode]
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
   */
  async notifyOrderConfirmed(order: Order): Promise<void> {
    try {
      await kwikengageService.sendCriticalTrigger('ORDER_CONFIRMED', order);
    } catch (err) {
      logger.warn('KwikEngage send failed for ORDER_CONFIRMED', { err });
    }
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
   */
  async notifyOrderShipped(order: Order, waybillNumber: string): Promise<void> {
    try {
      await kwikengageService.sendCriticalTrigger('ORDER_SHIPPED', order, {
        waybillNumber,
        courierName: 'Delhivery',
      });
    } catch (err) {
      logger.warn('KwikEngage send failed for ORDER_SHIPPED', { err });
    }
  }

  /**
   * Out for delivery — sent when tracking shows OFD status.
   */
  async notifyOutForDelivery(order: Order, waybillNumber?: string, location?: string): Promise<void> {
    try {
      await kwikengageService.sendCriticalTrigger('OUT_FOR_DELIVERY', order, { waybillNumber });
    } catch (err) {
      logger.warn('KwikEngage send failed for OUT_FOR_DELIVERY', { err });
    }
    await this.sendLifecycleEmail(order, 'OUT_FOR_DELIVERY', {
      waybillNumber,
      currentLocation: location,
    });
  }

  /**
   * In transit — email the customer once the parcel leaves the origin hub.
   */
  async notifyInTransit(order: Order, waybillNumber?: string, location?: string): Promise<void> {
    await this.sendLifecycleEmail(order, 'IN_TRANSIT', {
      waybillNumber,
      currentLocation: location,
    });
  }

  /**
   * Delivered — sent when tracking shows delivery confirmation.
   */
  async notifyDelivered(order: Order, waybillNumber?: string): Promise<void> {
    try {
      await kwikengageService.sendCriticalTrigger('DELIVERED', order, { waybillNumber });
    } catch (err) {
      logger.warn('KwikEngage send failed for DELIVERED', { err });
    }
    await this.sendLifecycleEmail(order, 'DELIVERED', { waybillNumber });
  }

  /**
   * NDR alert — delivery attempt failed (customer unreachable, address issue).
   */
  async notifyNDR(order: Order, remark: string, waybillNumber?: string): Promise<void> {
    try {
      await kwikengageService.sendCriticalTrigger('NDR_ALERT', order, {
        ndrReason: remark,
        waybillNumber,
      });
    } catch (err) {
      logger.warn('KwikEngage send failed for NDR_ALERT', { err });
    }
    await this.sendLifecycleEmail(order, 'NDR_ALERT', {
      waybillNumber,
      delayReason: remark,
    });
  }

  /**
   * Return initiated — sent when a return request is created.
   */
  async notifyReturnInitiated(order: Order, returnRecord: Return): Promise<void> {
    try {
      await kwikengageService.sendCriticalTrigger('RETURN_INITIATED', order, {
        waybillNumber: returnRecord.returnWaybillNumber || undefined,
        ndrReason: returnRecord.returnReason,
      });
    } catch (err) {
      logger.warn('KwikEngage send failed for RETURN_INITIATED', { err });
    }
  }

  /**
   * Return received at warehouse — sent when returned goods are scanned.
   */
  async notifyReturnReceived(order: Order): Promise<void> {
    try {
      await kwikengageService.sendCriticalTrigger('CUSTOM', order, {
        customText: `Hi ${order.customerName}, your returned parcel for order ${order.shopifyOrderName} has been received at our warehouse. QC check is underway.`,
      });
    } catch (err) {
      logger.warn('KwikEngage send failed for RETURN_RECEIVED', { err });
    }
  }

  /**
   * Refund processed — sent when Shopify or GoKwik refund is completed.
   */
  async notifyRefundProcessed(order: Order, refundAmount: number, _returnRecord?: Return): Promise<void> {
    try {
      await kwikengageService.sendCriticalTrigger('REFUND_PROCESSED', order, {
        customText: `A refund of ₹${Math.round(refundAmount)} for order ${order.shopifyOrderName} has been processed to your original payment method.`,
      });
    } catch (err) {
      logger.warn('KwikEngage send failed for REFUND_PROCESSED', { err });
    }
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
