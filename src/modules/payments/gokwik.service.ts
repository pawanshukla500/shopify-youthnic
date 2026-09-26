import axios, { AxiosInstance } from 'axios';
import { config } from '../../config';
import logger from '../../utils/logger';

/**
 * GoKwik Payment Service
 * Handles: payment status verification via GoKwik API.
 *
 * GoKwik is the primary payment gateway. This service can verify
 * whether a payment was actually captured by calling GoKwik's API directly.
 * This provides an extra layer of verification beyond Shopify's transaction data.
 *
 * GoKwik's public WooCommerce integration confirms App ID/App Secret
 * authentication using the `gk-app-id` and `gk-app-secret` headers. The
 * payment-status endpoint is product/account-specific, so it is configured
 * through GOKWIK_STATUS_PATH instead of being guessed in code.
 */
class GoKwikService {
  private client: AxiosInstance | null = null;

  constructor() {
    if (config.gokwik.appId && config.gokwik.appSecret) {
      this.client = axios.create({
        baseURL: config.gokwik.apiUrl,
        headers: {
          'gk-app-id': config.gokwik.appId,
          'gk-app-secret': config.gokwik.appSecret,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      });
    }
  }

  /**
   * Replace the supported order ID placeholders in a configured path.
   * The path can also contain query parameters, for example:
   * `/v3/orders/status?merchant_order_id={orderId}`.
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
   * Verify payment status for an order via GoKwik API.
   *
   * @param merchantOrderId - The order ID/reference used at GoKwik
   * @returns payment status and amount
   */
  async verifyPayment(
    merchantOrderId: string
  ): Promise<{
    verified: boolean;
    status: string;
    amount?: number;
    transactionId?: string;
    paymentMode?: string;
  }> {
    if (!this.client) {
      logger.warn('GoKwik API not configured — cannot verify payment directly');
      return { verified: false, status: 'NOT_CONFIGURED' };
    }

    if (!config.gokwik.statusPath) {
      logger.warn(
        'GoKwik payment verification is enabled but GOKWIK_STATUS_PATH is empty — using Shopify transaction status'
      );
      return { verified: false, status: 'NOT_CONFIGURED' };
    }

    try {
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
      const verified = ['paid', 'captured', 'success', 'completed', 'confirmed'].includes(
        normalizedStatus
      );

      logger.info('GoKwik payment verification', {
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
   * Process a refund via GoKwik API.
   * Only used if direct gateway refund is needed (bypassing Shopify).
   *
   * @param transactionId - GoKwik transaction ID to refund
   * @param amount - refund amount
   * @param reason - refund reason
   */
  async processRefund(
    merchantOrderId: string,
    amount: number,
    reason?: string
  ): Promise<{ success: boolean; refundId?: string; error?: string }> {
    if (!this.client) {
      return { success: false, error: 'GoKwik API not configured' };
    }

    try {
      const response = await this.client.post(config.gokwik.refundPath, {
        merchant_order_id: merchantOrderId,
        refund_amount: amount,
      });

      if (response.data?.success === false || response.data?.status === 'failed') {
        return {
          success: false,
          error: response.data?.message || 'GoKwik refund was rejected',
        };
      }

      const refundId =
        response.data?.refund_id ||
        response.data?.refundId ||
        response.data?.id ||
        response.data?.data?.refund_id;
      logger.info('GoKwik refund processed', {
        merchantOrderId,
        refundId,
        amount,
        reason,
      });

      return { success: true, refundId };
    } catch (error: any) {
      logger.error('GoKwik refund failed', {
        merchantOrderId,
        error: error.response?.data || error.message,
      });
      return {
        success: false,
        error: error.response?.data?.message || error.message,
      };
    }
  }
}

export default new GoKwikService();
