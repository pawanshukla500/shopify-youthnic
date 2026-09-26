import axios, { AxiosInstance } from 'axios';
import { config } from '../../config';
import logger from '../../utils/logger';

/**
 * PhonePe Payment Service
 * Handles: payment status verification and refunds via PhonePe Payment Gateway API.
 *
 * PhonePe is the secondary payment gateway.
 *
 * PhonePe PG API reference:
 * - Status check: GET /pg/v1/status/{merchantId}/{merchantTransactionId}
 * - Refund:       POST /pg/v1/refund
 * - Authentication: X-VERIFY header = sha256(endpoint + salt) + ### + salt_index
 */
class PhonePeService {
  private client: AxiosInstance | null = null;

  constructor() {
    if (config.phonepe.saltKey && config.phonepe.merchantId) {
      const baseUrl =
        config.phonepe.env === 'UAT'
          ? 'https://api-preprod.phonepe.com/apis/pg-sandbox'
          : config.phonepe.apiUrl;

      this.client = axios.create({
        baseURL: baseUrl,
        headers: {
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      });
    }
  }

  /**
   * Generate X-VERIFY checksum for PhonePe API authentication.
   * Format: sha256(requestPath + payload + saltKey) + "###" + saltIndex
   */
  private generateChecksum(requestPath: string, payload: string = ''): string {
    const crypto = require('crypto');
    const data = requestPath + payload + config.phonepe.saltKey;
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    return `${hash}###${config.phonepe.saltIndex}`;
  }

  /**
   * Verify payment status for an order via PhonePe API.
   *
   * @param merchantTransactionId - The transaction ID used when creating the payment
   * @returns payment status and details
   */
  async verifyPayment(
    merchantTransactionId: string
  ): Promise<{
    verified: boolean;
    status: string;
    amount?: number;
    transactionId?: string;
    paymentMode?: string;
  }> {
    if (!this.client) {
      logger.warn('PhonePe API not configured — cannot verify payment directly');
      return { verified: false, status: 'NOT_CONFIGURED' };
    }

    try {
      const endpoint = `/pg/v1/status/${config.phonepe.merchantId}/${merchantTransactionId}`;
      const checksum = this.generateChecksum(`/pg/v1/status/${config.phonepe.merchantId}/${merchantTransactionId}`);

      const response = await this.client.get(endpoint, {
        headers: {
          'X-VERIFY': checksum,
          'X-MERCHANT-ID': config.phonepe.merchantId,
        },
      });

      const data = response.data;
      const code = data?.code;
      const verified = code === 'PAYMENT_SUCCESS';

      logger.info('PhonePe payment verification', {
        merchantTransactionId,
        code,
        verified,
      });

      return {
        verified,
        status: code || 'UNKNOWN',
        amount: data?.data?.amount ? data.data.amount / 100 : undefined, // PhonePe uses paise
        transactionId: data?.data?.transactionId || data?.data?.providerReferenceId,
        paymentMode: data?.data?.paymentInstrument?.type,
      };
    } catch (error: any) {
      logger.error('PhonePe payment verification failed', {
        merchantTransactionId,
        error: error.response?.data || error.message,
      });
      return { verified: false, status: 'ERROR' };
    }
  }

  /**
   * Process a refund via PhonePe API.
   *
   * @param merchantTransactionId - original payment transaction ID
   * @param refundAmount - amount to refund (in rupees)
   * @param refundId - unique refund reference ID
   */
  async processRefund(
    merchantTransactionId: string,
    refundAmount: number,
    refundId: string
  ): Promise<{ success: boolean; refundId?: string; error?: string }> {
    if (!this.client) {
      return { success: false, error: 'PhonePe API not configured' };
    }

    try {
      const payload = {
        merchantId: config.phonepe.merchantId,
        merchantTransactionId: refundId,
        originalTransactionId: merchantTransactionId,
        amount: Math.round(refundAmount * 100), // PhonePe expects paise
      };

      const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString('base64');
      const endpoint = '/pg/v1/refund';
      const checksum = this.generateChecksum(endpoint + payloadBase64);

      const response = await this.client.post(endpoint, {
        request: payloadBase64,
      }, {
        headers: {
          'X-VERIFY': checksum,
        },
      });

      const code = response.data?.code;
      const success = code === 'PAYMENT_SUCCESS' || code === 'REFUND_SUCCESS';

      logger.info('PhonePe refund processed', {
        merchantTransactionId,
        refundId,
        code,
        success,
      });

      return {
        success,
        refundId: response.data?.data?.merchantTransactionId || refundId,
        error: success ? undefined : response.data?.message,
      };
    } catch (error: any) {
      logger.error('PhonePe refund failed', {
        merchantTransactionId,
        error: error.response?.data || error.message,
      });
      return {
        success: false,
        error: error.response?.data?.message || error.message,
      };
    }
  }
}

export default new PhonePeService();
