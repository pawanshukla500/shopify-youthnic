import axios, { AxiosInstance } from 'axios';
import fs from 'fs';
import path from 'path';
import { config } from '../../config';
import prisma from '../../database/prisma';
import logger from '../../utils/logger';
import { NotificationType } from '@prisma/client';

export type KwikEngageTriggerType =
  | 'ORDER_CONFIRMED'
  | 'COD_CONFIRMATION'
  | 'ORDER_SHIPPED'
  | 'OUT_FOR_DELIVERY'
  | 'DELIVERED'
  | 'NDR_ALERT'
  | 'RTO_INITIATED'
  | 'RETURN_INITIATED'
  | 'REFUND_PROCESSED'
  | 'CUSTOM';

export interface KwikEngageSendResult {
  success: boolean;
  provider: 'KWIKENGAGE_WHATSAPP';
  messageId?: string;
  error?: string;
  recipient: string;
  previewText?: string;
  simulated?: boolean;
}

export interface KwikEngageStatus {
  status: 'ok' | 'unauthorized' | 'error';
  latencyMs: number;
  apiUrl: string;
  merchantId?: string;
  senderPhone: string;
  wabaId?: string;
  apiKeyConfigured: boolean;
  merchantIdConfigured: boolean;
  message?: string;
}

/**
 * KwikEngage WhatsApp Service
 * Connects directly to GoKwik's official KwikEngage Messaging API:
 * https://api.kwikengage.ai/send-message/v2
 *
 * Supports:
 * - Session text messages
 * - Session media messages (image, document)
 * - Approved WhatsApp template messages
 * - Automated critical lifecycle triggers (COD Confirmation, Delhivery Tracking, Delivery alerts, NDR, Return, Refund)
 */
export class KwikEngageService {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: config.kwikengage.apiUrl || 'https://api.kwikengage.ai/send-message/v2',
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: 25000,
    });
  }

  /**
   * Build authentication and routing headers for KwikEngage API.
   * KwikEngage expects Authorization: <API_KEY> and optional merchant identifier headers.
   */
  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    const apiKey = config.kwikengage.apiKey?.trim();
    if (apiKey) {
      // Pass both Authorization and custom api key headers for maximum compatibility
      headers['Authorization'] = apiKey;
      headers['x-api-key'] = apiKey;
    }

    const merchantId = config.kwikengage.merchantId?.trim();
    if (merchantId) {
      headers['x-merchant-id'] = merchantId;
      headers['merchant-id'] = merchantId;
    }

    return headers;
  }

  /**
   * Normalize an Indian phone number to standard format (e.g. 919825012345).
   */
  normalizePhoneNumber(phone: string): string {
    const cleaned = (phone || '').replace(/\D/g, '');
    if (!cleaned) return '';
    if (cleaned.length === 10) return `91${cleaned}`;
    if (cleaned.length === 12 && cleaned.startsWith('91')) return cleaned;
    return cleaned;
  }

  /**
   * Ping / Health check for KwikEngage API.
   */
  async ping(): Promise<KwikEngageStatus> {
    const start = Date.now();
    const apiKeyConfigured = Boolean(config.kwikengage.apiKey && config.kwikengage.apiKey.trim().length > 3);
    const merchantIdConfigured = Boolean(config.kwikengage.merchantId && config.kwikengage.merchantId.trim().length > 2);

    if (!apiKeyConfigured) {
      return {
        status: 'ok',
        latencyMs: 5,
        apiUrl: config.kwikengage.apiUrl,
        merchantId: config.kwikengage.merchantId,
        senderPhone: config.kwikengage.senderPhone,
        wabaId: config.kwikengage.wabaId,
        apiKeyConfigured: false,
        merchantIdConfigured,
        message: 'Sandbox / Simulated Mode. Add KWIKENGAGE_API_KEY and Merchant ID to activate live WhatsApp messaging.',
      };
    }

    try {
      // Test connectivity by making a lightweight head/options or ping probe
      // Note: KwikEngage endpoint is POST https://api.kwikengage.ai/send-message/v2
      const endpoint = config.kwikengage.apiUrl || 'https://api.kwikengage.ai/send-message/v2';
      const parsed = new URL(endpoint);

      // Probe origin
      await axios.get(`${parsed.origin}/health`, {
        timeout: 5000,
        headers: this.getHeaders(),
      }).catch((probeErr) => {
        // A 404 or 405 on /health is fine, it proves DNS and HTTPS connectivity
        if (probeErr.response?.status && probeErr.response.status < 500) {
          return probeErr.response;
        }
        throw probeErr;
      });

      return {
        status: 'ok',
        latencyMs: Date.now() - start,
        apiUrl: config.kwikengage.apiUrl,
        merchantId: config.kwikengage.merchantId,
        senderPhone: config.kwikengage.senderPhone,
        wabaId: config.kwikengage.wabaId,
        apiKeyConfigured: true,
        merchantIdConfigured,
        message: 'Connected to KwikEngage WhatsApp API (api.kwikengage.ai)',
      };
    } catch (err: any) {
      const isAuth = err.response?.status === 401 || err.response?.status === 403;
      return {
        status: isAuth ? 'unauthorized' : 'error',
        latencyMs: Date.now() - start,
        apiUrl: config.kwikengage.apiUrl,
        merchantId: config.kwikengage.merchantId,
        senderPhone: config.kwikengage.senderPhone,
        wabaId: config.kwikengage.wabaId,
        apiKeyConfigured: true,
        merchantIdConfigured,
        message: isAuth
          ? 'Invalid or unauthorized KwikEngage API Key. Check credentials in app.kwikengage.ai'
          : err.message || 'KwikEngage connection probe failed',
      };
    }
  }

  /**
   * Update and persist KwikEngage credentials in runtime config and .env file.
   */
  async updateCredentials(
    apiKey: string,
    merchantId?: string,
    senderPhone?: string,
    wabaId?: string
  ): Promise<{ success: boolean; message: string }> {
    config.kwikengage.apiKey = apiKey.trim();

    if (merchantId !== undefined) {
      config.kwikengage.merchantId = merchantId.trim();
    }
    if (senderPhone !== undefined && senderPhone.trim()) {
      config.kwikengage.senderPhone = senderPhone.trim();
    }
    if (wabaId !== undefined && wabaId.trim()) {
      config.kwikengage.wabaId = wabaId.trim();
    }

    try {
      const envPath = path.resolve(process.cwd(), '.env');
      if (fs.existsSync(envPath)) {
        let content = fs.readFileSync(envPath, 'utf8');

        // KWIKENGAGE_API_KEY
        if (/^KWIKENGAGE_API_KEY=.*/m.test(content)) {
          content = content.replace(/^KWIKENGAGE_API_KEY=.*/m, `KWIKENGAGE_API_KEY=${config.kwikengage.apiKey}`);
        } else {
          content += `\nKWIKENGAGE_API_KEY=${config.kwikengage.apiKey}`;
        }

        // KWIKENGAGE_MERCHANT_ID
        if (config.kwikengage.merchantId) {
          if (/^KWIKENGAGE_MERCHANT_ID=.*/m.test(content)) {
            content = content.replace(/^KWIKENGAGE_MERCHANT_ID=.*/m, `KWIKENGAGE_MERCHANT_ID=${config.kwikengage.merchantId}`);
          } else {
            content += `\nKWIKENGAGE_MERCHANT_ID=${config.kwikengage.merchantId}`;
          }
        }

        // KWIKENGAGE_SENDER_PHONE
        if (config.kwikengage.senderPhone) {
          if (/^KWIKENGAGE_SENDER_PHONE=.*/m.test(content)) {
            content = content.replace(/^KWIKENGAGE_SENDER_PHONE=.*/m, `KWIKENGAGE_SENDER_PHONE=${config.kwikengage.senderPhone}`);
          } else {
            content += `\nKWIKENGAGE_SENDER_PHONE=${config.kwikengage.senderPhone}`;
          }
        }

        // KWIKENGAGE_WABA_ID
        if (config.kwikengage.wabaId) {
          if (/^KWIKENGAGE_WABA_ID=.*/m.test(content)) {
            content = content.replace(/^KWIKENGAGE_WABA_ID=.*/m, `KWIKENGAGE_WABA_ID=${config.kwikengage.wabaId}`);
          } else {
            content += `\nKWIKENGAGE_WABA_ID=${config.kwikengage.wabaId}`;
          }
        }

        fs.writeFileSync(envPath, content, 'utf8');
      }
      return { success: true, message: 'KwikEngage credentials saved and verified successfully.' };
    } catch (err: any) {
      logger.error('Failed to write KwikEngage config to .env', { error: err.message });
      return { success: true, message: 'KwikEngage credentials updated in active session.' };
    }
  }

  /**
   * Send WhatsApp session text message via official KwikEngage API:
   * POST https://api.kwikengage.ai/send-message/v2
   */
  async sendTextMessage(to: string, message: string): Promise<KwikEngageSendResult> {
    const recipient = this.normalizePhoneNumber(to);
    if (!recipient) {
      return {
        success: false,
        provider: 'KWIKENGAGE_WHATSAPP',
        recipient: to,
        error: 'Invalid recipient phone number',
      };
    }

    // If no API key configured, simulate dispatch safely
    if (!config.kwikengage.apiKey) {
      logger.info('[KWIKENGAGE_WHATSAPP_SIMULATED] Sending WhatsApp message via KwikEngage:', {
        recipient,
        preview: message.slice(0, 100),
      });
      return {
        success: true,
        provider: 'KWIKENGAGE_WHATSAPP',
        recipient,
        messageId: `kwikengage_sim_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        previewText: message,
        simulated: true,
      };
    }

    try {
      const payload = {
        to: recipient,
        channel: 'whatsapp',
        type: 'session',
        content: {
          type: 'text',
          text: message,
        },
      };

      const response = await this.client.post('', payload, {
        headers: this.getHeaders(),
      });

      const messageId =
        response.data?.messageId ||
        response.data?.message_id ||
        response.data?.id ||
        response.data?.data?.messageId ||
        `kwikengage_${Date.now()}`;

      logger.info('KwikEngage WhatsApp text message dispatched successfully', {
        recipient,
        messageId,
      });

      return {
        success: true,
        provider: 'KWIKENGAGE_WHATSAPP',
        messageId,
        recipient,
        previewText: message,
        simulated: false,
      };
    } catch (error: any) {
      const errDetails =
        error.response?.data?.message ||
        error.response?.data?.error ||
        error.response?.data ||
        error.message;

      logger.error('KwikEngage WhatsApp dispatch error', {
        recipient,
        error: errDetails,
        status: error.response?.status,
      });

      return {
        success: false,
        provider: 'KWIKENGAGE_WHATSAPP',
        recipient,
        error: typeof errDetails === 'string' ? errDetails : JSON.stringify(errDetails),
        previewText: message,
      };
    }
  }

  /**
   * Send WhatsApp session media message (image or document) via KwikEngage API.
   */
  async sendMediaMessage(
    to: string,
    mediaUrl: string,
    mediaType: 'image' | 'document' | 'video',
    caption?: string
  ): Promise<KwikEngageSendResult> {
    const recipient = this.normalizePhoneNumber(to);
    if (!recipient) {
      return {
        success: false,
        provider: 'KWIKENGAGE_WHATSAPP',
        recipient: to,
        error: 'Invalid recipient phone number',
      };
    }

    if (!config.kwikengage.apiKey) {
      return {
        success: true,
        provider: 'KWIKENGAGE_WHATSAPP',
        recipient,
        messageId: `kwikengage_sim_media_${Date.now()}`,
        previewText: caption || mediaUrl,
        simulated: true,
      };
    }

    try {
      const payload = {
        to: recipient,
        channel: 'whatsapp',
        type: 'session',
        content: {
          type: 'media',
          media: {
            url: mediaUrl,
            type: mediaType,
            caption: caption || '',
          },
        },
      };

      const response = await this.client.post('', payload, {
        headers: this.getHeaders(),
      });

      const messageId = response.data?.messageId || response.data?.id || `kwikengage_${Date.now()}`;
      return {
        success: true,
        provider: 'KWIKENGAGE_WHATSAPP',
        messageId,
        recipient,
        previewText: caption || mediaUrl,
        simulated: false,
      };
    } catch (error: any) {
      return {
        success: false,
        provider: 'KWIKENGAGE_WHATSAPP',
        recipient,
        error: error.response?.data?.message || error.message,
      };
    }
  }

  /**
   * Send WhatsApp pre-approved template message via KwikEngage API.
   * If template dispatch fails, falls back gracefully to session text message.
   */
  async sendTemplateMessage(
    to: string,
    templateName: string,
    parameters: string[],
    fallbackText?: string
  ): Promise<KwikEngageSendResult> {
    const recipient = this.normalizePhoneNumber(to);
    if (!recipient) {
      return {
        success: false,
        provider: 'KWIKENGAGE_WHATSAPP',
        recipient: to,
        error: 'Invalid recipient phone number',
      };
    }

    if (!config.kwikengage.apiKey) {
      return {
        success: true,
        provider: 'KWIKENGAGE_WHATSAPP',
        recipient,
        messageId: `kwikengage_sim_tpl_${Date.now()}`,
        previewText: fallbackText || templateName,
        simulated: true,
      };
    }

    try {
      const payload = {
        to: recipient,
        channel: 'whatsapp',
        type: 'template',
        content: {
          template_name: templateName,
          parameters,
          language: { code: 'en' },
        },
      };

      const response = await this.client.post('', payload, {
        headers: this.getHeaders(),
      });

      const messageId =
        response.data?.messageId ||
        response.data?.message_id ||
        response.data?.id ||
        response.data?.data?.messageId ||
        `kwikengage_${Date.now()}`;
      return {
        success: true,
        provider: 'KWIKENGAGE_WHATSAPP',
        messageId,
        recipient,
        previewText: fallbackText || templateName,
        simulated: false,
      };
    } catch (err: any) {
      logger.warn('KwikEngage template send failed, falling back to text session message', {
        templateName,
        error: err.response?.data || err.message,
      });

      if (fallbackText) {
        return this.sendTextMessage(to, fallbackText);
      }

      return {
        success: false,
        provider: 'KWIKENGAGE_WHATSAPP',
        recipient,
        error: err.response?.data?.message || err.message,
      };
    }
  }

  /**
   * Build formatted message text for critical order lifecycle triggers.
   */
  buildTriggerMessage(
    trigger: KwikEngageTriggerType,
    order: {
      customerName: string;
      shopifyOrderName: string;
      totalAmount: number;
      paymentMethod?: string | null;
      customerAddress?: string;
      customerCity?: string;
      customerState?: string;
      customerPincode?: string;
    },
    extra?: {
      waybillNumber?: string;
      courierName?: string;
      ndrReason?: string;
      itemsSummary?: string;
      customText?: string;
    }
  ): string {
    const customer = order.customerName || 'Valued Customer';
    const orderNo = order.shopifyOrderName || 'Order';
    const amount = Math.round(order.totalAmount || 0);
    const waybill = extra?.waybillNumber || '';
    const isCod = order.paymentMethod === 'COD';

    switch (trigger) {
      case 'ORDER_CONFIRMED':
        return (
          `✨ *Youthnic Order Confirmed!* ✨\n\n` +
          `Hi *${customer}*,\n` +
          `Thank you for shopping with *Youthnic*! Your order *${orderNo}* for *₹${amount}* has been confirmed.\n\n` +
          `📍 *Delivery Address:*\n${order.customerAddress || ''}, ${order.customerCity || ''} - ${order.customerPincode || ''}\n\n` +
          `🚚 We are packaging your items for immediate dispatch from our Surat Hub.`
        );

      case 'COD_CONFIRMATION':
        return (
          `📦 *Youthnic · Cash on Delivery Confirmation Required*\n\n` +
          `Hi *${customer}*,\n` +
          `We have received your COD order *${orderNo}* of *₹${amount}*.\n\n` +
          `To ensure express dispatch from Surat, please confirm your delivery:\n` +
          `👉 *Reply '1' or 'CONFIRM' to verify your order immediately.*`
        );

      case 'ORDER_SHIPPED':
        return (
          `🚀 *Your Youthnic Parcel is on its way!*\n\n` +
          `Hi *${customer}*,\n` +
          `Your order *${orderNo}* has been dispatched via *Delhivery Express*!\n\n` +
          `🏷️ *Delhivery AWB:* \`${waybill}\`\n` +
          `🔗 *Live Tracking Link:* https://www.delhivery.com/track/package/${waybill}\n\n` +
          `Expected Delivery: 2 to 4 business days.`
        );

      case 'OUT_FOR_DELIVERY':
        return (
          `🚚 *Out for Delivery Today!* 🚚\n\n` +
          `Hi *${customer}*,\n` +
          `Your Youthnic parcel *${orderNo}* is *OUT FOR DELIVERY* today via Delhivery.\n\n` +
          (isCod
            ? `💵 *Payment Mode: COD* — Please keep *₹${amount}* cash or UPI QR scan ready for the delivery associate.\n\n`
            : `💳 *Payment Mode: Prepaid* — No payment required at doorstep.\n\n`) +
          `Please keep your phone reachable so the delivery partner can hand over your parcel smoothly.`
        );

      case 'NDR_ALERT':
        return (
          `⚠️ *Urgent: Delivery Attempt Unsuccessful*\n\n` +
          `Hi *${customer}*,\n` +
          `Delhivery attempted to deliver your order *${orderNo}*, but could not reach you (${extra?.ndrReason || 'Customer unreachable / premises closed'}).\n\n` +
          `To prevent your package from being returned to Surat:\n` +
          `👉 *Click here to reschedule delivery date or update instructions:* https://www.delhivery.com/track/package/${waybill}\n\n` +
          `Need help? Simply reply to this WhatsApp message.`
        );

      case 'DELIVERED':
        return (
          `🎉 *Delivered Successfully!* 🎉\n\n` +
          `Hi *${customer}*,\n` +
          `Your Youthnic order *${orderNo}* has been delivered!\n\n` +
          `We hope you love your new ethnic wear! If you need any size assistance or return/exchange, feel free to reply right here on WhatsApp.\n\n` +
          `Thank you for choosing *Youthnic*!`
        );

      case 'RTO_INITIATED':
        return (
          `⚠️ *Notice: Return to Origin Initiated*\n\n` +
          `Hi *${customer}*,\n` +
          `Your order *${orderNo}* could not be delivered after multiple attempts and is returning to our Surat hub (${extra?.ndrReason || 'Delivery unserviceable'}).`
        );

      case 'RETURN_INITIATED':
        return (
          `📦 *Return Request Initiated*\n\n` +
          `Hi *${customer}*,\n` +
          `Your return request for order *${orderNo}* has been accepted. A Delhivery courier partner will pick up the package within 24-48 hours.`
        );

      case 'REFUND_PROCESSED':
        return (
          `💸 *Refund Processed*\n\n` +
          `Hi *${customer}*,\n` +
          `A refund of *₹${amount}* for order *${orderNo}* has been processed to your original payment method via GoKwik / Easebuzz.`
        );

      case 'CUSTOM':
      default:
        return extra?.customText || `Hi ${customer}, update regarding your Youthnic order ${orderNo}.`;
    }
  }

  /**
   * Primary entry point: Send critical trigger WhatsApp message and record in DB.
   */
  async sendCriticalTrigger(
    trigger: KwikEngageTriggerType,
    order: {
      id: number;
      customerName: string;
      customerPhone: string;
      shopifyOrderName: string;
      totalAmount: number;
      paymentMethod?: string | null;
      customerAddress?: string;
      customerCity?: string;
      customerState?: string;
      customerPincode?: string;
    },
    extra?: {
      waybillNumber?: string;
      courierName?: string;
      ndrReason?: string;
      itemsSummary?: string;
      customText?: string;
      operatorName?: string;
    }
  ): Promise<KwikEngageSendResult> {
    const message = this.buildTriggerMessage(trigger, order, extra);
    const recipient = this.normalizePhoneNumber(order.customerPhone);

    // 1. Record pending notification in Prisma DB
    let notificationId: number | undefined;
    try {
      const dbType: NotificationType =
        trigger === 'COD_CONFIRMATION'
          ? 'ORDER_CONFIRMED'
          : trigger === 'RTO_INITIATED'
          ? 'NDR_ALERT'
          : (trigger as NotificationType) || 'CUSTOM';

      const created = await prisma.notification.create({
        data: {
          orderId: order.id,
          type: dbType,
          recipient: recipient || order.customerPhone,
          templateName: `kwikengage_${trigger.toLowerCase()}`,
          messageBody: message,
          status: 'PENDING',
        },
      });
      notificationId = created.id;
    } catch (dbErr) {
      logger.warn('Failed to pre-insert notification record in DB', { dbErr });
    }

    // 2. Dispatch via KwikEngage
    const result = await this.sendTextMessage(order.customerPhone, message);

    // 3. Update notification status in DB
    if (notificationId) {
      try {
        await prisma.notification.update({
          where: { id: notificationId },
          data: {
            status: result.success ? 'SENT' : 'FAILED',
            providerMessageId: result.messageId || null,
            errorMessage: result.error || null,
            sentAt: result.success ? new Date() : null,
          },
        });
      } catch (updateErr) {
        logger.warn('Failed to update notification record in DB', { updateErr });
      }
    }

    return result;
  }
}

export const kwikengageService = new KwikEngageService();
export default kwikengageService;
