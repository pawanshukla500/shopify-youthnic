import axios from 'axios';
import { config } from '../../config';
import logger from '../../utils/logger';

export interface WhatsAppSendResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export class WhatsAppGatewayService {
  private getAuthHeader(): string {
    const raw = config.whatsappGateway.auth || 'returnorders@vbexports.co.in:Xchange4WA$';
    return `Basic ${Buffer.from(raw).toString('base64')}`;
  }

  private normalizeJid(recipient: string): string {
    const clean = recipient.trim();
    if (clean.includes('@')) {
      return clean;
    }
    const digits = clean.replace(/[^0-9]/g, '');
    return `${digits}@s.whatsapp.net`;
  }

  async sendTextMessage(recipient: string, message: string): Promise<WhatsAppSendResult> {
    if (!config.whatsappGateway.enabled) {
      logger.debug('WhatsApp gateway disabled, skipping send', { recipient });
      return { success: true, messageId: 'GATEWAY_DISABLED' };
    }

    const jid = this.normalizeJid(recipient);
    const url = `${config.whatsappGateway.apiUrl.replace(/\/+$/, '')}/send/message`;

    try {
      const response = await axios.post(
        url,
        {
          phone: jid,
          message: message.trim(),
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: this.getAuthHeader(),
          },
          timeout: 10000,
        }
      );

      const data = response.data;
      const messageId = data?.results?.message_id || data?.results?.id || 'SUCCESS';
      logger.info('Dispatched WhatsApp message via Operations Gateway', {
        jid,
        messageId,
      });

      return { success: true, messageId };
    } catch (err: any) {
      const errMsg = err?.response?.data?.message || err.message;
      logger.warn('Failed to dispatch WhatsApp message via Operations Gateway', {
        jid,
        error: errMsg,
        status: err?.response?.status,
      });
      return { success: false, error: errMsg };
    }
  }

  async ping(): Promise<{ connected: boolean; device?: string; jid?: string; error?: string }> {
    const url = `${config.whatsappGateway.apiUrl.replace(/\/+$/, '')}/app/devices`;
    try {
      const res = await axios.get(url, {
        headers: { Authorization: this.getAuthHeader() },
        timeout: 5000,
      });
      const firstDevice = res.data?.results?.[0];
      return {
        connected: Boolean(firstDevice?.device),
        device: firstDevice?.name,
        jid: firstDevice?.jid,
      };
    } catch (err: any) {
      return { connected: false, error: err.message };
    }
  }

  /**
   * Dispatches WhatsApp alert to Ekta Bhayani when a prepaid return is received & auto-refunded.
   */
  async notifyEktaPrepaidReturnRefund(params: {
    order: any;
    returnRecord?: any;
    refundAmount: number;
    shopifyRefundId?: string;
    isPartialReturn?: boolean;
    scan?: any;
  }): Promise<WhatsAppSendResult> {
    const { order, returnRecord, refundAmount, shopifyRefundId, isPartialReturn, scan } = params;
    const recipient = config.whatsappGateway.ektaJid;

    const orderName = order.shopifyOrderName || `#${order.shopifyOrderNumber}`;
    const customer = `${order.customerName || 'Customer'} (${order.customerPhone || 'No phone'})`;
    const waybill = returnRecord?.returnWaybillNumber || scan?.scanned_tracking || 'N/A';
    const refundId = shopifyRefundId || returnRecord?.shopifyRefundId || 'N/A';

    const returnedItemsList: string[] = [];
    if (returnRecord?.items?.length) {
      for (const item of returnRecord.items) {
        const title = item.orderItem?.title || item.title || 'Item';
        const sku = item.orderItem?.sku || item.sku ? ` (${item.orderItem?.sku || item.sku})` : '';
        returnedItemsList.push(`  • ${title}${sku} × ${item.quantity}`);
      }
    } else if (order.items?.length) {
      for (const item of order.items) {
        const sku = item.sku ? ` (${item.sku})` : '';
        returnedItemsList.push(`  • ${item.title}${sku} × ${item.quantity}`);
      }
    } else {
      returnedItemsList.push(`  • Return package (1 pc)`);
    }

    const header = isPartialReturn
      ? `📦 *PREPAID PARTIAL RETURN RECEIVED & REFUNDED*`
      : `📦 *PREPAID RETURN RECEIVED & REFUNDED*`;

    const note = isPartialReturn
      ? `✅ *Note:* Return received without any issue. Partial refund of ₹${refundAmount.toFixed(2)} processed for the returned item(s). Balance remains with customer.`
      : `✅ *Note:* Return received without any issue. This was prepaid, refund of ₹${refundAmount.toFixed(2)} processed automatically.`;

    const message = [
      header,
      `---------------------------------------`,
      `• *Order:* ${orderName}`,
      `• *Customer:* ${customer}`,
      `• *Return Waybill:* ${waybill}`,
      `• *Items Returned:*`,
      ...returnedItemsList,
      `• *Refund Processed:* ₹${refundAmount.toFixed(2)}`,
      `• *Shopify Refund ID:* ${refundId}`,
      `• *QC Status:* Verified Clear / No issue`,
      ``,
      note,
    ].join('\n');

    return this.sendTextMessage(recipient, message);
  }

  /**
   * Dispatches WhatsApp alert to Ekta Bhayani when a prepaid RTO is delivered & auto-refunded.
   */
  async notifyEktaPrepaidRtoRefund(params: {
    order: any;
    refundAmount: number;
    shopifyRefundId?: string;
    scan?: any;
  }): Promise<WhatsAppSendResult> {
    const { order, refundAmount, shopifyRefundId, scan } = params;
    const recipient = config.whatsappGateway.ektaJid;

    const orderName = order.shopifyOrderName || `#${order.shopifyOrderNumber}`;
    const customer = `${order.customerName || 'Customer'} (${order.customerPhone || 'No phone'})`;
    const waybill = order.shipment?.waybillNumber || scan?.scanned_tracking || 'N/A';
    const refundId = shopifyRefundId || 'N/A';

    const itemsList: string[] = (order.items || []).map((i: any) => `  • ${i.title}${i.sku ? ` (${i.sku})` : ''} × ${i.quantity}`);

    const message = [
      `📦 *PREPAID RTO DELIVERED & REFUNDED*`,
      `--------------------------------------`,
      `• *Order:* ${orderName}`,
      `• *Customer:* ${customer}`,
      `• *Tracking/AWB:* ${waybill}`,
      ...(itemsList.length ? [`• *Items:*`, ...itemsList] : []),
      `• *Refund Processed:* ₹${refundAmount.toFixed(2)}`,
      `• *Shopify Refund ID:* ${refundId}`,
      `• *Status:* Undelivered parcel returned to warehouse`,
      ``,
      `✅ *Note:* Prepaid RTO parcel received back. Full refund auto-processed to customer's original payment method.`,
    ].join('\n');

    return this.sendTextMessage(recipient, message);
  }

  /**
   * Dispatches WhatsApp alert to Ekta Bhayani when a COD return is received requiring manual refund.
   */
  async notifyEktaCodReturnReceived(params: {
    order: any;
    returnRecord?: any;
    qcStatus?: string;
    qcRemark?: string;
    scan?: any;
  }): Promise<WhatsAppSendResult> {
    const { order, returnRecord, qcStatus, qcRemark, scan } = params;
    const recipient = config.whatsappGateway.ektaJid;

    const orderName = order.shopifyOrderName || `#${order.shopifyOrderNumber}`;
    const customerName = order.customerName || 'Customer';
    const customerPhone = order.customerPhone || 'No phone';
    const waybill = returnRecord?.returnWaybillNumber || scan?.scanned_tracking || order.shipment?.waybillNumber || 'N/A';

    const amountToRefund = returnRecord?.refundAmount || order.totalAmount || 0;

    const returnedItemsList: string[] = [];
    if (returnRecord?.items?.length) {
      for (const item of returnRecord.items) {
        const title = item.orderItem?.title || item.title || 'Item';
        const sku = item.orderItem?.sku || item.sku ? ` (${item.orderItem?.sku || item.sku})` : '';
        returnedItemsList.push(`  • ${title}${sku} × ${item.quantity}`);
      }
    } else if (order.items?.length) {
      for (const item of order.items) {
        const sku = item.sku ? ` (${item.sku})` : '';
        returnedItemsList.push(`  • ${item.title}${sku} × ${item.quantity}`);
      }
    }

    const message = [
      `⚠️ *ACTION REQUIRED: COD RETURN RECEIVED*`,
      `------------------------------------------`,
      `• *Order:* ${orderName}`,
      `• *Customer:* ${customerName}`,
      `• *Customer Phone:* ${customerPhone}`,
      `• *Return AWB:* ${waybill}`,
      ...(returnedItemsList.length ? [`• *Items Returned:*`, ...returnedItemsList] : []),
      `• *Amount to Refund:* ₹${amountToRefund.toFixed(2)}`,
      `• *QC:* ${qcStatus || 'APPROVED'}${qcRemark ? ` (${qcRemark})` : ''}`,
      ``,
      `👉 *Action for Ekta:* This was a Cash on Delivery (COD) order. Please contact the customer at ${customerPhone} to collect their Bank/UPI details and manually process the refund of ₹${amountToRefund.toFixed(2)}.`,
    ].join('\n');

    return this.sendTextMessage(recipient, message);
  }

  /**
   * Dispatches WhatsApp alert to Ekta Bhayani when a COD RTO is delivered (no refund needed).
   */
  async notifyEktaCodRtoReceived(params: {
    order: any;
    scan?: any;
    waybill?: string;
    qcStatus?: string;
  }): Promise<WhatsAppSendResult> {
    const { order, scan, waybill: inputWaybill } = params;
    const recipient = config.whatsappGateway.ektaJid;

    const orderName = order.shopifyOrderName || `#${order.shopifyOrderNumber}`;
    const customer = `${order.customerName || 'Customer'} (${order.customerPhone || 'No phone'})`;
    const waybill = inputWaybill || order.shipment?.waybillNumber || scan?.scanned_tracking || 'N/A';

    const itemsList: string[] = (order.items || []).map((i: any) => `  • ${i.title}${i.sku ? ` (${i.sku})` : ''} × ${i.quantity}`);

    const message = [
      `📦 *COD RTO DELIVERED TO WAREHOUSE*`,
      `------------------------------------`,
      `• *Order:* ${orderName}`,
      `• *Customer:* ${customer}`,
      `• *Tracking/AWB:* ${waybill}`,
      ...(itemsList.length ? [`• *Items:*`, ...itemsList] : []),
      `• *Status:* Undelivered COD shipment received back at warehouse and restocked.`,
      ``,
      `ℹ️ *Note:* No refund required as customer did not pay for this order.`,
    ].join('\n');

    return this.sendTextMessage(recipient, message);
  }
}

export const whatsappGatewayService = new WhatsAppGatewayService();
export default whatsappGatewayService;
