import { config } from '../../config';
import prisma from '../../database/prisma';
import logger from '../../utils/logger';
import { NotificationType } from '@prisma/client';
import { NotificationPayload } from '../../types';
import kwikengageService, { KwikEngageService } from './kwikengage.service';

/**
 * KwikEngage WhatsApp Service (Unified Client)
 * Sends template and session messages to customers via official KwikEngage WhatsApp API:
 * https://api.kwikengage.ai/send-message/v2
 */
class KwiKenageService {
  /**
   * Send a template message to a customer.
   */
  async sendTemplateMessage(
    phoneNumber: string,
    templateName: string,
    parameters: string[],
    fallbackText?: string
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    return kwikengageService.sendTemplateMessage(phoneNumber, templateName, parameters, fallbackText);
  }

  /**
   * Send a plain text message to a customer.
   */
  async sendTextMessage(
    phoneNumber: string,
    message: string
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    return kwikengageService.sendTextMessage(phoneNumber, message);
  }

  /**
   * Send a notification based on the notification type.
   */
  async sendNotification(
    phoneNumber: string,
    type: NotificationType,
    payload: NotificationPayload,
    orderId?: number,
    returnId?: number
  ): Promise<void> {
    const { templateName, parameters, fallbackMessage } = this.buildTemplatePayload(type, payload);

    // Record pending notification in DB
    const notification = await prisma.notification.create({
      data: {
        orderId: orderId || null,
        returnId: returnId || null,
        type,
        recipient: kwikengageService.normalizePhoneNumber(phoneNumber) || phoneNumber,
        templateName,
        messageBody: fallbackMessage,
        status: 'PENDING',
      },
    });

    let result: { success: boolean; messageId?: string; error?: string };

    if (templateName) {
      result = await kwikengageService.sendTemplateMessage(phoneNumber, templateName, parameters, fallbackMessage);
    } else {
      result = await kwikengageService.sendTextMessage(phoneNumber, fallbackMessage);
    }

    // Update notification record
    await prisma.notification.update({
      where: { id: notification.id },
      data: {
        status: result.success ? 'SENT' : 'FAILED',
        providerMessageId: result.messageId || null,
        errorMessage: result.error || null,
        sentAt: result.success ? new Date() : null,
      },
    });
  }

  /**
   * Map notification type + payload to the right KwikEngage template and parameters.
   */
  private buildTemplatePayload(
    type: NotificationType,
    payload: NotificationPayload
  ): { templateName: string | null; parameters: string[]; fallbackMessage: string } {
    const t = config.kwikengage.templates;

    switch (type) {
      case 'ORDER_CONFIRMED':
        return {
          templateName: t.orderConfirmed,
          parameters: [payload.customerName, payload.orderNumber],
          fallbackMessage: `Hi ${payload.customerName}, your order ${payload.orderNumber} has been confirmed! We'll dispatch it soon. Thank you for shopping with us.`,
        };

      case 'ORDER_SHIPPED':
        return {
          templateName: t.orderDispatched,
          parameters: [payload.customerName, payload.orderNumber, payload.trackingNumber || 'N/A'],
          fallbackMessage: `Hi ${payload.customerName}, your order ${payload.orderNumber} has been shipped! Track your package with AWB: ${payload.trackingNumber || 'N/A'}`,
        };

      case 'OUT_FOR_DELIVERY':
        return {
          templateName: t.outForDelivery,
          parameters: [payload.customerName, payload.orderNumber],
          fallbackMessage: `Hi ${payload.customerName}, your order ${payload.orderNumber} is out for delivery today. Please keep your phone accessible.`,
        };

      case 'DELIVERED':
        return {
          templateName: t.delivered,
          parameters: [payload.customerName, payload.orderNumber],
          fallbackMessage: `Hi ${payload.customerName}, your order ${payload.orderNumber} has been delivered. We hope you love your purchase! Reply to this message if you have any questions.`,
        };

      case 'RETURN_INITIATED':
        return {
          templateName: t.returnInitiated,
          parameters: [payload.customerName, payload.orderNumber, payload.returnReason || 'N/A'],
          fallbackMessage: `Hi ${payload.customerName}, your return request for order ${payload.orderNumber} has been initiated. Reason: ${payload.returnReason || 'N/A'}. We'll arrange a pickup soon.`,
        };

      case 'REFUND_PROCESSED':
        return {
          templateName: t.refundProcessed,
          parameters: [payload.customerName, payload.orderNumber, payload.refundAmount || 'N/A'],
          fallbackMessage: `Hi ${payload.customerName}, a refund of Rs. ${payload.refundAmount || 'N/A'} for order ${payload.orderNumber} has been processed. It should reflect in your account within 5-7 business days.`,
        };

      case 'NDR_ALERT':
        return {
          templateName: t.ndrAttempt,
          parameters: [payload.customerName, payload.orderNumber, payload.customMessage || ''],
          fallbackMessage: `Hi ${payload.customerName}, delivery attempt failed for order ${payload.orderNumber}. ${payload.customMessage || 'Please provide an alternate delivery time or address.'}`,
        };

      case 'RETURN_PICKED_UP':
        return {
          templateName: null,
          parameters: [],
          fallbackMessage: `Hi ${payload.customerName}, your return for order ${payload.orderNumber} has been picked up. We'll process your refund once we receive the items.`,
        };

      case 'RETURN_RECEIVED':
        return {
          templateName: null,
          parameters: [],
          fallbackMessage: `Hi ${payload.customerName}, we've received your return for order ${payload.orderNumber}. Your refund is being processed.`,
        };

      case 'CUSTOM':
      default:
        return {
          templateName: null,
          parameters: [],
          fallbackMessage: payload.customMessage || `Hi ${payload.customerName}, update regarding your order ${payload.orderNumber}.`,
        };
    }
  }
}

export { KwikEngageService };
export const kwikenageService = new KwiKenageService();
export default kwikenageService;
