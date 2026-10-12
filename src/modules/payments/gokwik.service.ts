import axios, { AxiosInstance } from 'axios';
import { config } from '../../config';
import logger from '../../utils/logger';

export interface GoKwikOrderData {
  _id?: string;
  merchant_order_id?: string;
  status?: string;
  total?: number;
  payment_status?: string;
  payment_mode?: string;
  payment_method?: string;
  transaction_id?: string;
  refunds?: Array<{
    refund_id?: string;
    amount?: number;
    status?: string;
    created_at?: string;
  }>;
  gokwik_order_id?: string;
  awb?: string;
  awb_number?: string;
  awb_status?: string;
  shipping_provider?: string;
  [key: string]: any;
}

export interface GoKwikVerifyResult {
  verified: boolean;
  status: string;
  amount?: number;
  transactionId?: string;
  paymentMode?: string;
  paymentMethod?: string;
  refunds?: any[];
  raw?: any;
}

export interface GoKwikRefundResult {
  success: boolean;
  refundId?: string;
  statusCode?: number;
  message?: string;
  error?: string;
}

/**
 * GoKwik Payment & Order Service
 * Implements official GoKwik APIs based on the GoKwik KwikCheckout Integration:
 * - Fetch Order: POST /v3/orders/fetch (order details & payment status verification)
 * - Update Order & Integrated Refund: POST /v3/orders/update (status updates & automatic refund initiation)
 * - Webhook processing for payment and refund notifications
 */
class GoKwikService {
  private client: AxiosInstance | null = null;

  constructor() {
    this.initClient();
  }

  private initClient(): void {
    if (config.gokwik.appId && config.gokwik.appSecret) {
      this.client = axios.create({
        baseURL: config.gokwik.apiUrl || 'https://gkx.gokwik.co',
        headers: {
          'gk-app-id': config.gokwik.appId,
          'gk-app-secret': config.gokwik.appSecret,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      });
    } else {
      this.client = null;
    }
  }

  /**
   * Replace the supported order ID placeholders in a configured custom path.
   */
  private buildPath(pathTemplate: string, merchantOrderId: string): string {
    const encodedOrderId = encodeURIComponent(merchantOrderId);
    return pathTemplate
      .replace(/\{orderId\}/g, encodedOrderId)
      .replace(/\{merchantOrderId\}/g, encodedOrderId)
      .replace(/\{transactionId\}/g, encodedOrderId);
  }

  private getResponsePayload(data: any): any {
    return data?.data ?? data?.order ?? data;
  }

  /**
   * Fetch order details directly from GoKwik via official Order API:
   * POST /v3/orders/fetch
   */
  async fetchOrder(
    merchantOrderId: string
  ): Promise<{ success: boolean; data?: GoKwikOrderData; error?: string }> {
    if (!this.client) {
      return { success: false, error: 'GoKwik API credentials (gk-app-id / gk-app-secret) not configured' };
    }

    try {
      const response = await this.client.post('/v3/orders/fetch', {
        merchant_order_id: merchantOrderId,
      });

      if (response.data?.success === false) {
        return {
          success: false,
          error: response.data?.error || response.data?.message || 'GoKwik order fetch returned unsuccessful',
        };
      }

      const orderData: GoKwikOrderData = this.getResponsePayload(response.data);
      return { success: true, data: orderData };
    } catch (error: any) {
      logger.error('Failed to fetch order from GoKwik API', {
        merchantOrderId,
        error: error.response?.data || error.message,
      });
      return {
        success: false,
        error: error.response?.data?.message || error.response?.data?.error || error.message,
      };
    }
  }

  /**
   * Verify payment status for an order via GoKwik API.
   * If a custom GOKWIK_STATUS_PATH is configured, uses that path;
   * otherwise uses the official GoKwik POST /v3/orders/fetch endpoint.
   *
   * @param merchantOrderId - The order ID / reference used at GoKwik (e.g. #26YOU5913 or order ID)
   */
  async verifyPayment(
    merchantOrderId: string
  ): Promise<GoKwikVerifyResult> {
    if (!this.client) {
      logger.warn('GoKwik API not configured — cannot verify payment directly');
      return { verified: false, status: 'NOT_CONFIGURED' };
    }

    try {
      // 1. If legacy or custom status path is provided, use it
      if (config.gokwik.statusPath) {
        const endpoint = this.buildPath(config.gokwik.statusPath, merchantOrderId);
        const response = await this.client.get(endpoint);
        const data = this.getResponsePayload(response.data);

        const rawStatus =
          data?.payment_status ??
          data?.paymentStatus ??
          data?.payment_state ??
          data?.order_status ??
          data?.status ??
          'UNKNOWN';
        const status = String(rawStatus);
        const normalizedStatus = status.toLowerCase().replace(/[\s-]+/g, '_');
        const verified = ['paid', 'captured', 'success', 'completed', 'confirmed', 'payment_successful'].includes(
          normalizedStatus
        );

        logger.info('GoKwik payment verification via custom path', {
          merchantOrderId,
          status,
          verified,
        });

        return {
          verified,
          status,
          amount: data?.amount !== undefined ? Number(data.amount) : undefined,
          transactionId: data?.transaction_id || data?.transactionId || data?.payment_id,
          paymentMode: data?.payment_mode || data?.paymentMode || data?.method,
          raw: data,
        };
      }

      // 2. Official GoKwik POST /v3/orders/fetch API
      const fetchResult = await this.fetchOrder(merchantOrderId);
      if (!fetchResult.success || !fetchResult.data) {
        return { verified: false, status: fetchResult.error || 'ERROR' };
      }

      const orderData = fetchResult.data;
      const rawPaymentStatus = orderData.payment_status || orderData.status || 'UNKNOWN';
      const status = String(rawPaymentStatus);
      const normalized = status.toLowerCase().replace(/[\s-]+/g, '_');

      const verified = ['paid', 'captured', 'success', 'completed', 'confirmed', 'payment_successful'].includes(
        normalized
      );

      logger.info('GoKwik payment verification via official /v3/orders/fetch', {
        merchantOrderId,
        status,
        verified,
        transactionId: orderData.transaction_id,
      });

      return {
        verified,
        status,
        amount: orderData.total !== undefined ? Number(orderData.total) : undefined,
        transactionId: orderData.transaction_id,
        paymentMode: orderData.payment_mode,
        paymentMethod: orderData.payment_method,
        refunds: orderData.refunds,
        raw: orderData,
      };
    } catch (error: any) {
      logger.error('GoKwik payment verification failed', {
        merchantOrderId,
        error: error.response?.data || error.message,
      });
      return { verified: false, status: 'ERROR' };
    }
  }

  /**
   * Update order details in GoKwik (order status, AWB, courier).
   * POST /v3/orders/update
   */
  async updateOrder(params: {
    merchantOrderId: string;
    orderStatus?: 'Confirmed' | 'Pending' | 'Failed' | 'Cancelled';
    awbNumber?: string;
    awbStatus?: string;
    shippingProvider?: string;
    orderNote?: string;
  }): Promise<{ success: boolean; error?: string }> {
    if (!this.client) {
      return { success: false, error: 'GoKwik API not configured' };
    }

    try {
      const payload: Record<string, any> = {
        merchant_order_id: params.merchantOrderId,
      };

      if (params.orderStatus) payload.order_status = params.orderStatus;
      if (params.awbNumber) payload.awb_number = params.awbNumber;
      if (params.awbStatus) payload.awb_status = params.awbStatus;
      if (params.shippingProvider) payload.shipping_provider = params.shippingProvider;
      if (params.orderNote) payload.order_note = params.orderNote;

      const response = await this.client.post('/v3/orders/update', payload);

      if (response.data?.success === false) {
        return { success: false, error: response.data?.error || 'GoKwik order update rejected' };
      }

      return { success: true };
    } catch (error: any) {
      logger.error('GoKwik order update failed', {
        params,
        error: error.response?.data || error.message,
      });
      return { success: false, error: error.response?.data?.message || error.message };
    }
  }

  /**
   * Process a refund via GoKwik API.
   *
   * As specified in GoKwik Official Documentation:
   * GoKwik integrates the Refund API within the Update Order API:
   * POST /v3/orders/update
   * When `refund_amount` is included, the refund process is triggered automatically
   * (full refund if full amount, partial refund if partial amount).
   *
   * @param merchantOrderId - The merchant order ID to refund
   * @param amount - Refund amount in INR
   * @param reason - Reason for refund (mapped to order_note and refundRequestDescription)
   * @param extra - Optional AWB, courier, or order status details
   */
  async processRefund(
    merchantOrderId: string,
    amount: number,
    reason?: string,
    extra?: {
      orderStatus?: 'Cancelled' | 'Confirmed' | 'Pending' | 'Failed';
      awbNumber?: string;
      awbStatus?: string;
      shippingProvider?: string;
    }
  ): Promise<GoKwikRefundResult> {
    if (!this.client) {
      return { success: false, error: 'GoKwik API not configured' };
    }

    try {
      const endpoint = config.gokwik.refundPath || '/v3/orders/update';
      const payload: Record<string, any> = {
        merchant_order_id: merchantOrderId,
        refund_amount: amount,
        order_note: reason || 'Customer Return / Warehouse QC Approved Refund',
        order_status: extra?.orderStatus || 'Cancelled',
      };

      if (extra?.awbNumber) payload.awb_number = extra.awbNumber;
      if (extra?.awbStatus) payload.awb_status = extra.awbStatus;
      if (extra?.shippingProvider) payload.shipping_provider = extra.shippingProvider;

      const response = await this.client.post(endpoint, payload);

      if (response.data?.success === false || response.data?.status === 'failed') {
        return {
          success: false,
          error: response.data?.message || response.data?.error || 'GoKwik refund was rejected',
        };
      }

      const refundId =
        response.data?.refund_id ||
        response.data?.refundId ||
        response.data?.id ||
        response.data?.data?.refund_id ||
        `gk_ref_${Date.now()}`;

      logger.info('GoKwik refund processed successfully via /v3/orders/update', {
        merchantOrderId,
        refundId,
        amount,
        reason,
      });

      return {
        success: true,
        refundId,
        statusCode: response.status,
        message: 'Refund request initiated successfully with GoKwik',
      };
    } catch (error: any) {
      const errMsg = error.response?.data?.error || error.response?.data?.message || error.message;
      logger.error('GoKwik refund failed', {
        merchantOrderId,
        amount,
        error: errMsg,
      });
      return {
        success: false,
        error: typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg),
      };
    }
  }

  /**
   * Process incoming GoKwik webhook events.
   * Handles:
   * - Payments: `payment.successful`, `order.successful`
   * - Refunds: `refund.successful`, `refund.failure`, `refund.pending`, `refund.initiated`
   */
  processWebhook(payload: any): {
    event: string;
    entity: string;
    merchantOrderId?: string;
    paymentId?: string;
    refundId?: string;
    amount?: number;
    provider?: string;
    status?: string;
    isPayment: boolean;
    isRefund: boolean;
  } {
    const event = String(payload?.event || '');
    const entity = String(payload?.entity || '');
    const data = payload?.data || {};

    const isRefund = entity === 'refund' || event.startsWith('refund.');
    const isPayment = entity === 'payment' || entity === 'order' || event.startsWith('payment.') || event.startsWith('order.');

    const merchantOrderId =
      data.merchantReferenceId ||
      data.merchant_order_id ||
      data.merchantOrderId ||
      payload.merchant_order_id;

    const paymentId = data.paymentId || data.transactionPaymentId || data.transaction_id;
    const refundId = data.refundId || data.refund_id;
    const amount = data.amount !== undefined ? Number(data.amount) : undefined;
    const provider = data.provider || 'gokwik';

    return {
      event,
      entity,
      merchantOrderId,
      paymentId,
      refundId,
      amount,
      provider,
      status: data.status || event,
      isPayment,
      isRefund,
    };
  }
}

export const gokwikService = new GoKwikService();
export default gokwikService;
