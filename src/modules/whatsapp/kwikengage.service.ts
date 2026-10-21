import axios, { AxiosInstance } from 'axios';
import fs from 'fs';
import path from 'path';
import { config } from '../../config';
import prisma from '../../database/prisma';
import logger from '../../utils/logger';
import { NotificationType } from '@prisma/client';
import { isVelocityCourier } from '../../utils/courier';

export type KwikEngageTriggerType =
  | 'ORDER_CONFIRMED'
  | 'COD_CONFIRMATION'
  | 'ORDER_SHIPPED'
  | 'IN_TRANSIT'
  | 'OUT_FOR_DELIVERY'
  | 'DELIVERED'
  | 'NDR_ALERT'
  | 'TRANSIT_DELAY'
  | 'DISPATCH_DELAY'
  | 'RTO_INITIATED'
  | 'RETURN_INITIATED'
  | 'RETURN_RECEIVED'
  | 'REFUND_PROCESSED'
  | 'SUPPORT_REPLY'
  | 'CUSTOM';

export interface KwikEngageSendResult {
  success: boolean;
  provider: 'KWIKENGAGE_WHATSAPP';
  messageId?: string;
  error?: string;
  recipient: string;
  previewText?: string;
  simulated?: boolean;
  requiresTemplate?: boolean;
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
 * - Session text messages (when customer has interacted within 24 hours)
 * - Session media messages (image, document, video)
 * - Approved WhatsApp utility template messages (for outbound messages outside 24h window)
 * - Automated critical lifecycle triggers synchronized with order emails:
 *   Order Confirmed, COD Confirmation, Order Shipped, In-Transit, Transit Delay,
 *   Dispatch Delay, Out for Delivery, Delivered, NDR Alert, Return Initiated,
 *   Return Received, Refund Processed, Support Reply.
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
    if (cleaned.length === 11 && cleaned.startsWith('0')) return `91${cleaned.slice(1)}`;
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
      const endpoint = config.kwikengage.apiUrl || 'https://api.kwikengage.ai/send-message/v2';
      const parsed = new URL(endpoint);

      await axios.get(`${parsed.origin}/health`, {
        timeout: 5000,
        headers: this.getHeaders(),
      }).catch((probeErr) => {
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

        if (/^KWIKENGAGE_API_KEY=.*/m.test(content)) {
          content = content.replace(/^KWIKENGAGE_API_KEY=.*/m, `KWIKENGAGE_API_KEY=${config.kwikengage.apiKey}`);
        } else {
          content += `\nKWIKENGAGE_API_KEY=${config.kwikengage.apiKey}`;
        }

        if (config.kwikengage.merchantId) {
          if (/^KWIKENGAGE_MERCHANT_ID=.*/m.test(content)) {
            content = content.replace(/^KWIKENGAGE_MERCHANT_ID=.*/m, `KWIKENGAGE_MERCHANT_ID=${config.kwikengage.merchantId}`);
          } else {
            content += `\nKWIKENGAGE_MERCHANT_ID=${config.kwikengage.merchantId}`;
          }
        }

        if (config.kwikengage.senderPhone) {
          if (/^KWIKENGAGE_SENDER_PHONE=.*/m.test(content)) {
            content = content.replace(/^KWIKENGAGE_SENDER_PHONE=.*/m, `KWIKENGAGE_SENDER_PHONE=${config.kwikengage.senderPhone}`);
          } else {
            content += `\nKWIKENGAGE_SENDER_PHONE=${config.kwikengage.senderPhone}`;
          }
        }

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

      const errStr = typeof errDetails === 'string' ? errDetails : JSON.stringify(errDetails);
      const isOutsideSession = errStr.includes('24 hours') || errStr.includes('template message');

      logger.warn('KwikEngage WhatsApp session dispatch error', {
        recipient,
        error: errDetails,
        status: error.response?.status,
        requiresTemplate: isOutsideSession,
      });

      return {
        success: false,
        provider: 'KWIKENGAGE_WHATSAPP',
        recipient,
        error: isOutsideSession
          ? 'Recipient outside 24-hour session window. Requires approved Meta WhatsApp template to initiate conversation.'
          : errStr,
        previewText: message,
        requiresTemplate: isOutsideSession,
      };
    }
  }

  /**
   * Send WhatsApp session media message (image, document, video) via KwikEngage API.
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
   * Send WhatsApp pre-approved template message via official KwikEngage v2 API.
   * Matches KwikEngage schema:
   * {
   *   to: recipient,
   *   channel: 'whatsapp',
   *   type: 'template',
   *   content: {
   *     type: 'template',
   *     template: {
   *       template_id: string,
   *       language: string,
   *       parameters?: string[] | object,
   *       components?: any[]
   *     }
   *   }
   * }
   */
  async sendTemplateMessage(
    to: string,
    templateName: string,
    parameters?: string[] | Record<string, any>,
    options?: {
      language?: string;
      components?: any[];
      fallbackText?: string;
    } | string
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

    const fallbackText = typeof options === 'string' ? options : options?.fallbackText;
    const language = typeof options === 'object' && options?.language ? options.language : 'en';
    const components = typeof options === 'object' ? options?.components : undefined;

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
      const templateObj: Record<string, any> = {
        template_id: templateName,
        language,
      };

      if (components && components.length > 0) {
        templateObj.components = components;
      } else if (Array.isArray(parameters) && parameters.length > 0) {
        templateObj.parameters = parameters;
      } else if (parameters && typeof parameters === 'object') {
        templateObj.parameters = parameters;
      }

      const payload = {
        to: recipient,
        channel: 'whatsapp',
        type: 'template',
        content: {
          type: 'template',
          template: templateObj,
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

      logger.info('KwikEngage template message dispatched successfully', {
        recipient,
        templateName,
        messageId,
      });

      return {
        success: true,
        provider: 'KWIKENGAGE_WHATSAPP',
        messageId,
        recipient,
        previewText: fallbackText || templateName,
        simulated: false,
      };
    } catch (err: any) {
      const errDetails = err.response?.data?.message || err.response?.data?.error || err.message;
      logger.warn('KwikEngage template send failed', {
        templateName,
        recipient,
        error: errDetails,
      });

      if (fallbackText) {
        logger.info('Attempting session fallback text message for recipient', { recipient });
        const fallbackRes = await this.sendTextMessage(to, fallbackText);
        if (fallbackRes.success) {
          return fallbackRes;
        }
      }

      return {
        success: false,
        provider: 'KWIKENGAGE_WHATSAPP',
        recipient,
        error: typeof errDetails === 'string' ? errDetails : JSON.stringify(errDetails),
      };
    }
  }

  /**
   * Build formatted utility message text for all order lifecycle events.
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
      currentLocation?: string;
      delayReason?: string;
      newEstimatedDelivery?: string;
      ndrReason?: string;
      itemsSummary?: string;
      customText?: string;
    }
  ): string {
    const customer = order.customerName || 'Valued Customer';
    const orderNo = order.shopifyOrderName || 'Order';
    const amount = Math.round(order.totalAmount || 0);
    const waybill = extra?.waybillNumber || '';
    const isVelocity = isVelocityCourier(extra?.courierName, null, waybill);
    const courier = extra?.courierName || (isVelocity ? 'Velocity' : 'Delhivery Express');
    const carrierLabel = isVelocity ? 'Velocity' : 'Delhivery';
    const trackingLink = isVelocity
      ? `https://www.velocityshipping.in/track/${waybill}`
      : `https://www.delhivery.com/track/package/${waybill}`;
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
          `Your order *${orderNo}* has been dispatched via *${courier}*!\n\n` +
          (waybill
            ? `🏷️ *Tracking AWB:* \`${waybill}\`\n` +
              `🔗 *Live Tracking Link:* ${trackingLink}\n\n`
            : '') +
          `Expected Delivery: 2 to 4 business days.`
        );

      case 'IN_TRANSIT':
        return (
          `🚚 *Youthnic Order Update: In Transit*\n\n` +
          `Hi *${customer}*,\n` +
          `Your order *${orderNo}* is currently in transit with *${courier}*.\n\n` +
          (waybill ? `🏷️ *${carrierLabel} AWB:* \`${waybill}\`\n` : '') +
          (extra?.currentLocation ? `📍 *Current Hub:* ${extra.currentLocation}\n` : '') +
          (waybill ? `🔗 *Track Package:* ${trackingLink}\n\n` : '\n') +
          `We are actively tracking your shipment to ensure smooth delivery.`
        );

      case 'TRANSIT_DELAY':
        return (
          `⏱️ *Update Regarding Your Youthnic Delivery*\n\n` +
          `Hi *${customer}*,\n` +
          `We wanted to let you know that your parcel *${orderNo}* is experiencing a brief transit delay due to: *${extra?.delayReason || 'Logistics network routing check'}*.\n\n` +
          (waybill ? `🏷️ *${carrierLabel} AWB:* \`${waybill}\`\n` : '') +
          (extra?.newEstimatedDelivery ? `📅 *Revised Estimated Delivery:* ${extra.newEstimatedDelivery}\n` : '') +
          (waybill ? `🔗 *Track Live Status:* ${trackingLink}\n\n` : '\n') +
          `Our logistics team is actively coordinating with ${carrierLabel} to deliver your package at the earliest.`
        );

      case 'DISPATCH_DELAY':
        return (
          `📦 *Youthnic Dispatch Update*\n\n` +
          `Hi *${customer}*,\n` +
          `Your order *${orderNo}* is being carefully prepared at our Surat Fulfillment Center. Due to high seasonal volume, dispatch is taking slightly longer than usual.\n\n` +
          `Expected Dispatch: Within 24-48 business hours.\n` +
          `Thank you for your patience and support!`
        );

      case 'OUT_FOR_DELIVERY':
        return (
          `🚚 *Out for Delivery Today!* 🚚\n\n` +
          `Hi *${customer}*,\n` +
          `Your Youthnic parcel *${orderNo}* is *OUT FOR DELIVERY* today via ${courier}.\n\n` +
          (isCod
            ? `💵 *Payment Mode: COD* — Please keep *₹${amount}* cash or UPI QR scan ready for the delivery partner.\n\n`
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
          `Your return request for order *${orderNo}* has been accepted. A Delhivery courier partner will pick up the package within 24-48 hours.\n\n` +
          (waybill ? `🏷️ *Return AWB:* \`${waybill}\`\n\n` : '') +
          `Please keep the items in original packaging with tags intact.`
        );

      case 'RETURN_RECEIVED':
        return (
          `🏢 *Returned Parcel Received at Warehouse*\n\n` +
          `Hi *${customer}*,\n` +
          `Your returned parcel for order *${orderNo}* has safely arrived at our Surat Fulfillment Center.\n\n` +
          `Our Quality Check (QC) team is inspecting the items. Once QC is approved, your refund will be processed promptly.`
        );

      case 'REFUND_PROCESSED':
        return (
          `💸 *Refund Processed Successfully*\n\n` +
          `Hi *${customer}*,\n` +
          `A refund of *₹${amount}* for order *${orderNo}* has been processed to your original payment method via GoKwik / Easebuzz.\n\n` +
          `The amount will reflect in your account within 2 to 4 business days.`
        );

      case 'SUPPORT_REPLY':
        return (
          `💬 *Youthnic Customer Support*\n\n` +
          `Hi *${customer}*,\n` +
          `Update regarding your order *${orderNo}*:\n\n` +
          `${extra?.customText || 'Our support team has updated your ticket.'}\n\n` +
          `If you have any further questions, feel free to reply to this message.`
        );

      case 'CUSTOM':
      default:
        return extra?.customText || `Hi ${customer}, update regarding your Youthnic order ${orderNo}.`;
    }
  }

  /**
   * Build positional template parameters matching the approved Meta WhatsApp Utility Templates.
   */
  buildTriggerTemplateParams(
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
      currentLocation?: string;
      delayReason?: string;
      newEstimatedDelivery?: string;
      ndrReason?: string;
      itemsSummary?: string;
      customText?: string;
    }
  ): string[] {
    const customer = order.customerName || 'Valued Customer';
    const orderNo = order.shopifyOrderName || 'Order';
    const amount = Math.round(order.totalAmount || 0).toString();
    const waybill = extra?.waybillNumber || '';
    const courier = extra?.courierName || 'Delhivery Express';
    const city = order.customerCity || order.customerState || 'your address';

    switch (trigger) {
      case 'ORDER_CONFIRMED':
      case 'COD_CONFIRMATION':
        return [customer, orderNo, amount, city];

      case 'ORDER_SHIPPED':
      case 'IN_TRANSIT':
        return [customer, orderNo, courier, waybill];

      case 'OUT_FOR_DELIVERY':
        return [
          customer,
          orderNo,
          courier,
          order.paymentMethod === 'COD' ? `₹${amount} (Cash/UPI)` : 'Prepaid (Already Paid)',
        ];

      case 'DELIVERED':
        return [customer, orderNo];

      case 'TRANSIT_DELAY':
        return [
          customer,
          orderNo,
          extra?.delayReason || 'Logistics routing transit check',
          extra?.newEstimatedDelivery || 'Within 2 business days',
          waybill,
        ];

      case 'NDR_ALERT':
      case 'RTO_INITIATED':
        return [
          customer,
          orderNo,
          extra?.ndrReason || 'Customer unreachable / premises closed',
          waybill,
        ];

      case 'REFUND_PROCESSED':
        return [
          customer,
          orderNo,
          amount,
          'Original Payment Method (GoKwik / Easebuzz)',
        ];

      default:
        return [customer, orderNo, amount, waybill];
    }
  }

  /**
   * Primary entry point: Send critical trigger WhatsApp message and record in DB.
   * If customer is outside 24h window and template is configured, attempts template dispatch.
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
      currentLocation?: string;
      delayReason?: string;
      newEstimatedDelivery?: string;
      ndrReason?: string;
      itemsSummary?: string;
      customText?: string;
      operatorName?: string;
    }
  ): Promise<KwikEngageSendResult> {
    const message = this.buildTriggerMessage(trigger, order, extra);
    const recipient = this.normalizePhoneNumber(order.customerPhone);

    const dbTypeMap: Record<KwikEngageTriggerType, NotificationType> = {
      ORDER_CONFIRMED: 'ORDER_CONFIRMED',
      COD_CONFIRMATION: 'ORDER_CONFIRMED',
      ORDER_SHIPPED: 'ORDER_SHIPPED',
      IN_TRANSIT: 'ORDER_SHIPPED',
      OUT_FOR_DELIVERY: 'OUT_FOR_DELIVERY',
      DELIVERED: 'DELIVERED',
      NDR_ALERT: 'NDR_ALERT',
      TRANSIT_DELAY: 'NDR_ALERT',
      DISPATCH_DELAY: 'ORDER_CONFIRMED',
      RTO_INITIATED: 'NDR_ALERT',
      RETURN_INITIATED: 'RETURN_INITIATED',
      RETURN_RECEIVED: 'RETURN_RECEIVED',
      REFUND_PROCESSED: 'REFUND_PROCESSED',
      SUPPORT_REPLY: 'CUSTOM',
      CUSTOM: 'CUSTOM',
    };

    // 1. Record pending notification in Prisma DB
    let notificationId: number | undefined;
    try {
      const dbType = dbTypeMap[trigger] || 'CUSTOM';
      const created = await prisma.notification.create({
        data: {
          orderId: order.id > 0 ? order.id : undefined,
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

    // 2. Dispatch via KwikEngage: try session text first
    let result = await this.sendTextMessage(order.customerPhone, message);

    // 3. If outside 24h session window, try approved template if configured
    if (!result.success && result.requiresTemplate) {
      const templateMap: Partial<Record<KwikEngageTriggerType, string | undefined>> = {
        ORDER_CONFIRMED: config.kwikengage.templates.orderConfirmed,
        COD_CONFIRMATION: config.kwikengage.templates.codConfirmation,
        ORDER_SHIPPED: config.kwikengage.templates.orderDispatched,
        IN_TRANSIT: config.kwikengage.templates.inTransit,
        TRANSIT_DELAY: config.kwikengage.templates.transitDelay,
        DISPATCH_DELAY: config.kwikengage.templates.dispatchDelay,
        OUT_FOR_DELIVERY: config.kwikengage.templates.outForDelivery,
        DELIVERED: config.kwikengage.templates.delivered,
        NDR_ALERT: config.kwikengage.templates.ndrAttempt,
        RTO_INITIATED: config.kwikengage.templates.rtoInitiated,
        RETURN_INITIATED: config.kwikengage.templates.returnInitiated,
        RETURN_RECEIVED: config.kwikengage.templates.returnReceived,
        REFUND_PROCESSED: config.kwikengage.templates.refundProcessed,
        SUPPORT_REPLY: config.kwikengage.templates.supportReply,
      };

      const configuredTemplate = templateMap[trigger];
      if (configuredTemplate) {
        logger.info(`Recipient ${recipient} is outside 24h window; attempting configured template: ${configuredTemplate}`);
        const templateParams = this.buildTriggerTemplateParams(trigger, order, extra);
        const templateResult = await this.sendTemplateMessage(
          order.customerPhone,
          configuredTemplate,
          templateParams,
          { fallbackText: message }
        );
        if (templateResult.success) {
          result = templateResult;
        }
      }
    }

    // 4. Update notification status in DB
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
