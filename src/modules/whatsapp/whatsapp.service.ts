import axios, { AxiosInstance } from 'axios';
import { config } from '../../config';
import prisma from '../../database/prisma';
import logger from '../../utils/logger';
import { NotificationType } from '@prisma/client';
import { NotificationPayload } from '../../types';

/**
 * KwiKenage WhatsApp Service
 * Sends template and text messages to customers via KwiKenage WhatsApp API.
 *
 * Typical KwiKenage API flow:
 * - POST /send-message with API key in header
 * - Supports template messages and plain text
 */
class KwiKenageService {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: config.kwikenage.apiUrl,
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });

    // Authenticate per request so a missing key surfaces as an actionable error
    // at the call site rather than as an opaque 401 from KwiKenage.
    this.client.interceptors.request.use((requestConfig) => {
      if (!config.kwikenage.apiKey) {
        throw new Error(
          'KWIKENAGE_API_KEY is not set. Add your KwiKenage API key to your environment to send WhatsApp messages.'
        );
      }
      requestConfig.headers['Authorization'] = `Bearer ${config.kwikenage.apiKey}`;
      return requestConfig;
    });
  }

  /**
   * Send a template message to a customer.
   * Template must be pre-approved in KwiKenage dashboard.
   */
  async sendTemplateMessage(
    phoneNumber: string,
    templateName: string,
    parameters: string[]
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    try {
      // KwiKenage API format for template messages
      const payload = {
        phone: phoneNumber,
        template_name: templateName,
        parameters: parameters,
        // Some KwiKenage versions use "body_parameters" instead
        body_parameters: parameters,
      };

      const response = await this.client.post('/send-template', payload);

      const messageId =
        response.data?.message_id ||
        response.data?.id ||
        response.data?.data?.id;

      logger.info('WhatsApp template message sent', {
        phoneNumber,
        templateName,
        messageId,
      });

      return { success: true, messageId };
    } catch (error: any) {
      logger.error('Failed to send WhatsApp template message', {
        phoneNumber,
        templateName,
        error: error.response?.data || error.message,
      });
      return {
        success: false,
        error: error.response?.data?.message || error.message,
      };
    }
  }

  /**
   * Send a plain text message to a customer.
   */
  async sendTextMessage(
    phoneNumber: string,
    message: string
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    try {
      const payload = {
        phone: phoneNumber,
        message: message,
      };

      const response = await this.client.post('/send-message', payload);

      const messageId =
        response.data?.message_id ||
        response.data?.id ||
        response.data?.data?.id;

      logger.info('WhatsApp text message sent', {
        phoneNumber,
        messageId,
      });

      return { success: true, messageId };
    } catch (error: any) {
      logger.error('Failed to send WhatsApp text message', {
        phoneNumber,
        error: error.response?.data || error.message,
      });
      return {
        success: false,
        error: error.response?.data?.message || error.message,
      };
    }
  }

  /**
   * Send a notification based on the notification type.
   * This is the main entry point called by the notification engine.
   *
   * It picks the appropriate template, fills in parameters, sends the message,
   * and records the result in the database.
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
        recipient: phoneNumber,
        templateName,
        messageBody: fallbackMessage,
        status: 'PENDING',
      },
    });

    let result: { success: boolean; messageId?: string; error?: string };

    if (templateName) {
      result = await this.sendTemplateMessage(phoneNumber, templateName, parameters);
    } else {
      result = await this.sendTextMessage(phoneNumber, fallbackMessage);
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
   * Map notification type + payload to the right KwiKenage template and parameters.
   */
  private buildTemplatePayload(
    type: NotificationType,
    payload: NotificationPayload
  ): { templateName: string | null; parameters: string[]; fallbackMessage: string } {
    const t = config.kwikenage.templates;

    switch (type) {
      case 'ORDER_CONFIRMED':
        return {
          templateName: t.orderConfirmed,
          parameters: [payload.customerName, payload.orderNumber],
          fallbackMessage: `Hi ${payload.customerName}, your order ${payload.orderNumber} has been confirmed! We'll dispatch it soon. Thank you for shopping with us.`,
        };

      case 'ORDER_SHIPPED':
        return {
          templateName: t.orderShipped,
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
          templateName: t.ndr,
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
        return {
          templateName: null,
          parameters: [],
          fallbackMessage: payload.customMessage || '',
        };

      default:
        return {
          templateName: null,
          parameters: [],
          fallbackMessage: '',
        };
    }
  }
}

export default new KwiKenageService();
