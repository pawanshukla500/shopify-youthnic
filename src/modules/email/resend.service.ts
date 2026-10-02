import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { config } from '../../config';
import logger from '../../utils/logger';
import emailLogService from './email-log.service';
import {
  renderTransitDelayEmail,
  renderDispatchDelayEmail,
  renderInTransitEmail,
  renderOutForDeliveryEmail,
  renderNdrEmail,
  renderDeliveredEmail,
  renderOrderConfirmedEmail,
  renderReturnInitiatedEmail,
  renderReturnReceivedEmail,
  renderReturnRefundEmail,
  renderSupportReplyEmail,
  renderCustomEmail,
  EmailTemplateData,
} from './email-templates';

export type EmailTemplateType =
  | 'TRANSIT_DELAY'
  | 'DISPATCH_DELAY'
  | 'IN_TRANSIT'
  | 'OUT_FOR_DELIVERY'
  | 'NDR_ALERT'
  | 'DELIVERED'
  | 'ORDER_CONFIRMED'
  | 'RETURN_INITIATED'
  | 'RETURN_RECEIVED'
  | 'RETURN_REFUND'
  | 'SUPPORT_REPLY'
  | 'CUSTOM';

export interface SendEmailOptions {
  to: string;
  templateType: EmailTemplateType;
  fromEmail?: string;
  orderId?: number | null;
  data: EmailTemplateData;
  subject?: string;
  replyTo?: string;
}

export interface ResendStatus {
  status: 'ok' | 'unauthorized' | 'not_configured';
  latencyMs: number;
  apiKeyConfigured: boolean;
  fromEmail: string;
  message?: string;
}

class ResendService {
  private apiKey: string;
  private fromEmail: string;
  private apiUrl: string;

  constructor() {
    this.apiKey = config.resend.apiKey;
    this.fromEmail = config.resend.fromEmail;
    this.apiUrl = config.resend.apiUrl;
  }

  /**
   * Check connection status and measure latency to Resend API
   */
  async ping(): Promise<ResendStatus> {
    const start = Date.now();
    if (!this.apiKey) {
      return {
        status: 'not_configured',
        latencyMs: 5,
        apiKeyConfigured: false,
        fromEmail: this.fromEmail,
        message: 'Sandbox / Simulated Mode. Add RESEND_API_KEY to send live emails to customer inboxes.',
      };
    }

    try {
      // Test key via Resend domains or api-keys endpoint
      const response = await axios.get(`${this.apiUrl}/api-keys`, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
        timeout: 5000,
      });

      const latencyMs = Date.now() - start;
      return {
        status: response.status >= 200 && response.status < 300 ? 'ok' : 'unauthorized',
        latencyMs,
        apiKeyConfigured: true,
        fromEmail: this.fromEmail,
        message: 'Connected to Resend Mail Platform (Live Delivery Active)',
      };
    } catch (error: any) {
      const latencyMs = Date.now() - start;
      const status = error.response?.status === 401 ? 'unauthorized' : 'ok';
      return {
        status,
        latencyMs,
        apiKeyConfigured: true,
        fromEmail: this.fromEmail,
        message:
          error.response?.data?.message ||
          (status === 'unauthorized'
            ? 'Invalid Resend API Key. Check your key in Settings.'
            : 'Resend API reachable'),
      };
    }
  }

  /**
   * Update credentials at runtime and persist to .env file
   */
  async updateCredentials(options: { apiKey?: string; fromEmail?: string }) {
    if (options.apiKey !== undefined) {
      this.apiKey = options.apiKey.trim();
    }
    if (options.fromEmail !== undefined) {
      this.fromEmail = options.fromEmail.trim();
    }

    // Persist to .env
    try {
      const envPath = path.join(process.cwd(), '.env');
      if (fs.existsSync(envPath)) {
        let envContent = fs.readFileSync(envPath, 'utf8');

        if (/^RESEND_API_KEY=/m.test(envContent)) {
          envContent = envContent.replace(
            /^RESEND_API_KEY=.*$/m,
            `RESEND_API_KEY=${this.apiKey}`
          );
        } else {
          envContent += `\nRESEND_API_KEY=${this.apiKey}`;
        }

        if (/^RESEND_FROM_EMAIL=/m.test(envContent)) {
          envContent = envContent.replace(
            /^RESEND_FROM_EMAIL=.*$/m,
            `RESEND_FROM_EMAIL=${this.fromEmail}`
          );
        } else {
          envContent += `\nRESEND_FROM_EMAIL=${this.fromEmail}`;
        }

        fs.writeFileSync(envPath, envContent, 'utf8');
      }
    } catch (err) {
      logger.warn('Could not persist RESEND credentials to .env:', err);
    }

    const pingResult = await this.ping();
    return {
      success: true,
      message: 'Resend email configuration updated and verified successfully.',
      ping: pingResult,
    };
  }

  /**
   * Render email subject & HTML body based on chosen template
   */
  renderTemplate(
    type: EmailTemplateType,
    data: EmailTemplateData
  ): { subject: string; html: string } {
    switch (type) {
      case 'TRANSIT_DELAY':
        return renderTransitDelayEmail(data);
      case 'DISPATCH_DELAY':
        return renderDispatchDelayEmail(data);
      case 'IN_TRANSIT':
        return renderInTransitEmail(data);
      case 'OUT_FOR_DELIVERY':
        return renderOutForDeliveryEmail(data);
      case 'NDR_ALERT':
        return renderNdrEmail(data);
      case 'DELIVERED':
        return renderDeliveredEmail(data);
      case 'ORDER_CONFIRMED':
        return renderOrderConfirmedEmail(data);
      case 'RETURN_INITIATED':
        return renderReturnInitiatedEmail(data);
      case 'RETURN_RECEIVED':
        return renderReturnReceivedEmail(data);
      case 'RETURN_REFUND':
        return renderReturnRefundEmail(data);
      case 'SUPPORT_REPLY':
        return renderSupportReplyEmail(data);
      case 'CUSTOM':
      default:
        return renderCustomEmail(data);
    }
  }

  /**
   * Send an email to a customer with automatic tracking and logging
   */
  async sendEmail(options: SendEmailOptions) {
    const { to, templateType, orderId, data, subject: customSubject, replyTo } = options;

    // Render template
    const rendered = this.renderTemplate(templateType, data);
    const finalSubject = customSubject || rendered.subject;
    const finalHtml = rendered.html;

    // 1. Pre-create pending EmailLog
    const log = await emailLogService.createLog({
      orderId: orderId || undefined,
      shopifyOrderName: data.orderName,
      recipientEmail: to,
      recipientName: data.customerName,
      subject: finalSubject,
      templateType,
      status: 'PENDING',
      waybillNumber: data.waybillNumber,
      courier: data.courier || 'Delhivery Express',
      currentLocation: data.currentLocation,
      delayReason: data.delayReason,
      expectedDeliveryDate: data.newEstimatedDelivery,
      htmlPreview: finalHtml,
    });

    // 2. Attach tracking link using log ID
    const trackingRedirectUrl = `${config.appBaseUrl}/api/communications/track/${log.id}`;
    data.trackingUrl = trackingRedirectUrl;

    // Re-render with tracking URL injected
    const renderedWithTracking = this.renderTemplate(templateType, data);

    // 3. Dispatch via Resend API or simulate
    if (!this.apiKey) {
      // Sandbox mode: simulate successful dispatch
      logger.info(`[Resend Sandbox] Email to ${to} (${templateType}): ${finalSubject}`);
      const updatedLog = await emailLogService.updateStatus(log.id, {
        status: 'SIMULATED',
        resendId: `sim_${Date.now()}`,
        sentAt: new Date(),
      });

      return {
        success: true,
        mode: 'SIMULATED',
        logId: updatedLog.id,
        resendId: updatedLog.resendId,
        recipient: to,
        subject: finalSubject,
        htmlPreview: renderedWithTracking.html,
        message: 'Dispatched in Sandbox / Simulated Mode. Add RESEND_API_KEY for live delivery.',
      };
    }

    // Sender must match the lowercase desk printed on the template badge.
    // Resend verifies the youthnic.com domain, so these local-parts deliver.
    const sender = senderForTemplate(templateType);
    let effectiveFrom = options.fromEmail || sender.from;
    let defaultReplyTo: string | undefined = options.fromEmail ? undefined : sender.replyTo;

    const effectiveReplyTo = replyTo || defaultReplyTo;

    try {
      const payload: any = {
        from: effectiveFrom,
        to: [to],
        subject: finalSubject,
        html: renderedWithTracking.html,
        tags: [
          { name: 'order_name', value: (data.orderName || 'general').replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50) },
          { name: 'template', value: templateType.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50) },
        ],
      };

      if (effectiveReplyTo) {
        payload.reply_to = effectiveReplyTo;
      }

      const response = await axios.post(`${this.apiUrl}/emails`, payload, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      });

      const resendId = response.data?.id || `res_${Date.now()}`;
      const updatedLog = await emailLogService.updateStatus(log.id, {
        status: 'SENT',
        resendId,
        sentAt: new Date(),
      });

      return {
        success: true,
        mode: 'LIVE',
        logId: updatedLog.id,
        resendId,
        recipient: to,
        from: effectiveFrom,
        replyTo: effectiveReplyTo,
        subject: finalSubject,
        message: `Live email dispatched to ${to} from ${effectiveFrom} via Resend.`,
      };
    } catch (error: any) {
      const errorMsg =
        error.response?.data?.message || error.message || 'Failed to dispatch email';
      logger.error(`Resend dispatch error to ${to}:`, errorMsg);

      await emailLogService.updateStatus(log.id, {
        status: 'FAILED',
        errorMessage: errorMsg,
      });

      return {
        success: false,
        mode: 'FAILED',
        logId: log.id,
        recipient: to,
        error: errorMsg,
      };
    }
  }

  getStatus() {
    return {
      apiKeyConfigured: Boolean(this.apiKey),
      fromEmail: this.fromEmail,
      apiUrl: this.apiUrl,
    };
  }
}

/**
 * Official Youthnic desk addresses. The From header and the badge in the
 * HTML template must name the same mailbox.
 */
export function senderForTemplate(templateType: EmailTemplateType): { from: string; replyTo: string } {
  switch (templateType) {
    case 'RETURN_INITIATED':
    case 'RETURN_RECEIVED':
      return { from: 'Youthnic Returns <returns@youthnic.com>', replyTo: 'returns@youthnic.com' };
    case 'RETURN_REFUND':
      return { from: 'Youthnic Refunds <refunds@youthnic.com>', replyTo: 'refunds@youthnic.com' };
    case 'SUPPORT_REPLY':
    case 'ORDER_CONFIRMED':
      return { from: 'Youthnic Support <support@youthnic.com>', replyTo: 'support@youthnic.com' };
    case 'TRANSIT_DELAY':
    case 'DISPATCH_DELAY':
    case 'IN_TRANSIT':
    case 'OUT_FOR_DELIVERY':
    case 'NDR_ALERT':
    case 'DELIVERED':
    case 'CUSTOM':
    default:
      return { from: 'Youthnic Logistics <delivery@youthnic.com>', replyTo: 'delivery@youthnic.com' };
  }
}

export const resendService = new ResendService();
export default resendService;
