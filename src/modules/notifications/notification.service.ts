import prisma from '../../database/prisma';
import kwikenageService from '../whatsapp/whatsapp.service';
import kapsoService from '../whatsapp/kapso.service';
import logger from '../../utils/logger';
import { Order, Return } from '@prisma/client';
import { NotificationPayload } from '../../types';

/**
 * Notification Engine
 * Central service that triggers critical WhatsApp messages at each order lifecycle stage
 * powered by Kapso AI WhatsApp Cloud REST API.
 */
class NotificationEngine {
  /**
   * Best-effort KwiKenage fallback when Kapso is down/misconfigured.
   * Never throws — CRM notifications must not break order state transitions.
   */
  private async fallbackToKwiKenage(
    order: Order,
    type: 'ORDER_CONFIRMED' | 'ORDER_SHIPPED' | 'OUT_FOR_DELIVERY' | 'DELIVERED' | 'NDR_ALERT' | 'RETURN_INITIATED' | 'REFUND_PROCESSED',
    extra: Partial<NotificationPayload> = {}
  ): Promise<void> {
    try {
      const payload: NotificationPayload = {
        customerName: order.customerName,
        orderNumber: order.shopifyOrderName,
        ...extra,
      };
      await kwikenageService.sendNotification(order.customerPhone, type as any, payload, order.id);
    } catch (fallbackErr: any) {
      logger.warn('KwiKenage fallback also failed', {
        type,
        orderId: order.id,
        error: fallbackErr?.message,
      });
    }
  }

  /**
   * Order confirmed — sent when a new order is synced from Shopify.
   */
  async notifyOrderConfirmed(order: Order): Promise<void> {
    try {
      await kapsoService.sendCriticalTrigger('ORDER_CONFIRMED', order);
    } catch (err) {
      logger.warn('Kapso send failed for ORDER_CONFIRMED, attempting fallback', { err });
      const payload: NotificationPayload = {
        customerName: order.customerName,
        orderNumber: order.shopifyOrderName,
      };
      await kwikenageService.sendNotification(
        order.customerPhone,
        'ORDER_CONFIRMED',
        payload,
        order.id
      ).catch(() => {});
    }
  }

  /**
   * COD Confirmation — critical trigger requesting customer confirmation to reduce RTO risk.
   */
  async notifyCodConfirmation(order: Order): Promise<void> {
    try {
      await kapsoService.sendCriticalTrigger('COD_CONFIRMATION', order);
    } catch (err) {
      logger.error('Failed to dispatch COD confirmation via Kapso', { err });
    }
  }

  /**
   * Order shipped — sent when AWB is generated and shipment is dispatched via Delhivery.
   */
  async notifyOrderShipped(order: Order, waybillNumber: string): Promise<void> {
    try {
      await kapsoService.sendCriticalTrigger('ORDER_SHIPPED', order, {
        waybillNumber,
        courierName: 'Delhivery',
      });
    } catch (err) {
      logger.warn('Kapso send failed for ORDER_SHIPPED, attempting fallback', { err });
      const payload: NotificationPayload = {
        customerName: order.customerName,
        orderNumber: order.shopifyOrderName,
        trackingNumber: waybillNumber,
        courierName: 'Delhivery',
      };
      await kwikenageService.sendNotification(
        order.customerPhone,
        'ORDER_SHIPPED',
        payload,
        order.id
      ).catch(() => {});
    }
  }

  /**
   * Out for delivery — sent when tracking shows OFD status.
   */
  async notifyOutForDelivery(order: Order, waybillNumber?: string): Promise<void> {
    try {
      await kapsoService.sendCriticalTrigger('OUT_FOR_DELIVERY', order, { waybillNumber });
    } catch (err) {
      logger.warn('Kapso send failed for OUT_FOR_DELIVERY, attempting fallback', { err });
      await this.fallbackToKwiKenage(order, 'OUT_FOR_DELIVERY', { trackingNumber: waybillNumber });
    }
  }

  /**
   * Delivered — sent when tracking shows delivery confirmation.
   */
  async notifyDelivered(order: Order, waybillNumber?: string): Promise<void> {
    try {
      await kapsoService.sendCriticalTrigger('DELIVERED', order, { waybillNumber });
    } catch (err) {
      logger.warn('Kapso send failed for DELIVERED, attempting fallback', { err });
      await this.fallbackToKwiKenage(order, 'DELIVERED', { trackingNumber: waybillNumber });
    }
  }

  /**
   * NDR alert — delivery attempt failed (customer unreachable, address issue).
   */
  async notifyNDR(order: Order, remark: string, waybillNumber?: string): Promise<void> {
    try {
      await kapsoService.sendCriticalTrigger('NDR_ALERT', order, {
        ndrReason: remark,
        waybillNumber,
      });
    } catch (err) {
      logger.warn('Kapso send failed for NDR_ALERT, attempting fallback', { err });
      await this.fallbackToKwiKenage(order, 'NDR_ALERT', { trackingNumber: waybillNumber } as any);
    }
  }

  /**
   * Return initiated — sent when a return request is created.
   */
  async notifyReturnInitiated(order: Order, returnRecord: Return): Promise<void> {
    try {
      await kapsoService.sendCriticalTrigger('RETURN_INITIATED', order, {
        waybillNumber: returnRecord.returnWaybillNumber || undefined,
        ndrReason: returnRecord.returnReason,
      });
    } catch (err) {
      logger.warn('Kapso send failed for RETURN_INITIATED, attempting fallback', { err });
      await this.fallbackToKwiKenage(order, 'RETURN_INITIATED', {
        trackingNumber: returnRecord.returnWaybillNumber || undefined,
      });
    }
  }

  /**
   * Return received at warehouse — sent when returned goods are scanned.
   */
  async notifyReturnReceived(order: Order): Promise<void> {
    try {
      await kapsoService.sendCriticalTrigger('CUSTOM', order, {
        customText: `Hi ${order.customerName}, your returned parcel for order ${order.shopifyOrderName} has been received at our warehouse. QC check is underway.`,
      });
    } catch (err) {
      logger.warn('Kapso send failed for RETURN_RECEIVED', { err });
    }
  }

  /**
   * Refund processed — sent when Shopify refund is completed.
   */
  async notifyRefundProcessed(order: Order, refundAmount: number, _returnRecord?: Return): Promise<void> {
    try {
      await kapsoService.sendCriticalTrigger('REFUND_PROCESSED', order);
    } catch (err) {
      logger.warn('Kapso send failed for REFUND_PROCESSED, attempting fallback', { err });
      await this.fallbackToKwiKenage(order, 'REFUND_PROCESSED');
    }
  }

  /**
   * Send a custom message to a customer.
   * Never throws — tracking/RTO flows must continue even if WhatsApp is down.
   */
  async sendCustomMessage(order: Order, message: string): Promise<void> {
    try {
      await kapsoService.sendCriticalTrigger('CUSTOM', order, {
        customText: message,
      });
    } catch (err: any) {
      logger.warn('Kapso send failed for CUSTOM message', { orderId: order.id, error: err?.message });
    }
  }
}

export default new NotificationEngine();
