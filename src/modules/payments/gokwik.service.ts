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

export interface GoKwikRtoPredictInput {
  requestId?: string;
  merchantOrderId?: string;
  orderDate?: string | Date;
  platformType?: string;
  totalPrice?: number;
  paymentMethod?: string;
  customer?: {
    firstName?: string;
    lastName?: string;
    phone?: string;
    email?: string;
  };
  shippingAddress?: {
    firstName?: string;
    lastName?: string;
    address1?: string;
    address2?: string;
    city?: string;
    state?: string;
    postcode?: string;
    phone?: string;
    email?: string;
  };
  billingAddress?: {
    firstName?: string;
    lastName?: string;
    address1?: string;
    address2?: string;
    city?: string;
    state?: string;
    postcode?: string;
    phone?: string;
    email?: string;
  };
  lineItems?: Array<{
    name?: string;
    title?: string;
    sku?: string;
    quantity?: number;
    price?: number;
  }>;
}

export interface GoKwikRtoPredictResult {
  success: boolean;
  riskFlag: 'LOW' | 'MEDIUM' | 'HIGH' | 'CONTROL' | 'UNKNOWN';
  riskScore?: number;
  riskReason?: string;
  allowCod?: boolean;
  incentivizePrepaid?: boolean;
  requestId?: string;
  raw?: any;
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
  private orderClient: AxiosInstance | null = null;

  constructor() {
    this.initClient();
  }

  private initClient(): void {
    if (config.gokwik.appId && config.gokwik.appSecret) {
      const defaultHeaders = {
        appid: config.gokwik.appId,
        appsecret: config.gokwik.appSecret,
        'gk-app-id': config.gokwik.appId,
        'gk-app-secret': config.gokwik.appSecret,
        'Content-Type': 'application/json',
        accept: 'application/json',
      };

      // V2 API Client (RTO predict & Refund V2: https://api.gokwik.co)
      this.client = axios.create({
        baseURL: config.gokwik.apiUrl || 'https://api.gokwik.co',
        headers: defaultHeaders,
        timeout: 15000,
      });

      // V3 Order Client (Fetch & Update Orders: https://gkx.gokwik.co)
      this.orderClient = axios.create({
        baseURL: (config.gokwik as any).orderApiUrl || 'https://gkx.gokwik.co',
        headers: defaultHeaders,
        timeout: 15000,
      });
    } else {
      this.client = null;
      this.orderClient = null;
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
    const activeClient = this.orderClient || this.client;
    if (!activeClient) {
      return { success: false, error: 'GoKwik API credentials (gk-app-id / gk-app-secret) not configured' };
    }

    try {
      const response = await activeClient.post('/v3/orders/fetch', {
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
    const activeClient = this.orderClient || this.client;
    if (!activeClient) {
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

      const response = await activeClient.post('/v3/orders/update', payload);

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
   * Supports both:
   * 1. Official GoKwik Refund API V2: POST /v2/order/refund/initiate (base: https://api.gokwik.co)
   *    Accepts amount, moid (e.g. #26YOU5759 with # included) and optional gokwik_oid.
   * 2. Integrated Refund via Order Update: POST /v3/orders/update (base: https://gkx.gokwik.co)
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
      gokwikOrderId?: string;
    }
  ): Promise<GoKwikRefundResult> {
    if (!this.client) {
      return { success: false, error: 'GoKwik API not configured' };
    }

    try {
      const endpoint = config.gokwik.refundPath || '/v2/order/refund/initiate';

      // 1. Official GoKwik Refund V2: POST /v2/order/refund/initiate
      if (endpoint.includes('/v2/order/refund/initiate')) {
        const moid = merchantOrderId.startsWith('#') ? merchantOrderId : `#${merchantOrderId}`;
        const payload: Record<string, any> = {
          amount,
          moid,
        };
        if (extra?.gokwikOrderId) {
          payload.gokwik_oid = extra.gokwikOrderId;
        }

        const response = await this.client.post('/v2/order/refund/initiate', payload);
        const resData = response.data;
        if (resData?.statusCode === 200 || resData?.success) {
          const refundData = resData?.data || resData;
          const refundId = refundData?.refund_id || refundData?.refundId || `gk_ref_${Date.now()}`;
          logger.info('GoKwik refund processed successfully via /v2/order/refund/initiate', {
            merchantOrderId: moid,
            refundId,
            amount,
          });
          return {
            success: true,
            refundId,
            statusCode: resData?.statusCode || response.status,
            message: resData?.statusMessage || 'Refund initiated successfully',
          };
        } else {
          return {
            success: false,
            statusCode: resData?.statusCode || response.status,
            error: resData?.statusMessage || resData?.message || 'GoKwik refund rejected',
          };
        }
      }

      // 2. Fallback to /v3/orders/update integrated refund
      const activeClient = this.orderClient || this.client;
      const payload: Record<string, any> = {
        merchant_order_id: merchantOrderId,
        refund_amount: amount,
        order_note: reason || 'Customer Return / Warehouse QC Approved Refund',
        order_status: extra?.orderStatus || 'Cancelled',
      };

      if (extra?.awbNumber) payload.awb_number = extra.awbNumber;
      if (extra?.awbStatus) payload.awb_status = extra.awbStatus;
      if (extra?.shippingProvider) payload.shipping_provider = extra.shippingProvider;

      const response = await activeClient.post(endpoint, payload);

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
      const errMsg =
        error.response?.data?.statusMessage ||
        error.response?.data?.error ||
        error.response?.data?.message ||
        error.message;
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
   * Verify refund status using official GoKwik Refund V2 API:
   * POST /v2/order/refund/verify
   */
  async verifyRefund(refundId: string): Promise<{
    success: boolean;
    refundId: string;
    amount?: number;
    status?: string;
    referenceId?: string;
    createdAt?: string;
    refundedAt?: string;
    error?: string;
  }> {
    if (!this.client) {
      return { success: false, refundId, error: 'GoKwik API not configured' };
    }

    try {
      const response = await this.client.post('/v2/order/refund/verify', { refund_id: refundId });
      const resData = response.data;
      if (resData?.statusCode === 200 && resData?.data) {
        return {
          success: true,
          refundId: resData.data.refund_id || refundId,
          amount: resData.data.amount !== undefined ? Number(resData.data.amount) : undefined,
          status: resData.data.status,
          referenceId: resData.data.reference_id,
          createdAt: resData.data.created_at,
          refundedAt: resData.data.refunded_at,
        };
      }
      return {
        success: false,
        refundId,
        error: resData?.statusMessage || 'Refund verification returned non-200',
      };
    } catch (error: any) {
      const errMsg = error.response?.data?.statusMessage || error.response?.data?.message || error.message;
      return { success: false, refundId, error: errMsg };
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
    rrn?: string;
    arn?: string;
    paymentMethod?: string;
    paymentSubMethod?: string;
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
    const isPayment =
      entity === 'payment' || entity === 'order' || event.startsWith('payment.') || event.startsWith('order.');

    const merchantOrderId =
      data.merchantReferenceId ||
      data.merchant_order_id ||
      data.merchantOrderId ||
      payload.merchant_order_id;

    const paymentId = data.paymentId || data.transactionPaymentId || data.transaction_id;
    const refundId = data.refundId || data.refund_id;
    const rrn =
      data.rrn ||
      data.refund_rrn ||
      data.refundRrn ||
      data.bank_reference_number ||
      data.bankReferenceNumber ||
      data.reference_id ||
      data.referenceId ||
      undefined;
    const arn =
      data.arn ||
      data.refund_arn ||
      data.refundArn ||
      data.acquirer_reference_number ||
      refundId ||
      undefined;
    const paymentMethod = data.payment_method || data.paymentMethod || data.payment_mode || data.paymentMode || undefined;
    const paymentSubMethod = data.payment_sub_method || data.paymentSubMethod || data.vpa || data.card_network || undefined;
    const amount = data.amount !== undefined ? Number(data.amount) : undefined;
    const provider = data.provider || 'gokwik';

    return {
      event,
      entity,
      merchantOrderId,
      paymentId,
      refundId,
      rrn: rrn ? String(rrn).trim() : undefined,
      arn: arn ? String(arn).trim() : undefined,
      paymentMethod: paymentMethod ? String(paymentMethod).trim() : undefined,
      paymentSubMethod: paymentSubMethod ? String(paymentSubMethod).trim() : undefined,
      amount,
      provider,
      status: data.status || event,
      isPayment,
      isRefund,
    };
  }

  /**
   * Predict RTO risk for an order via official GoKwik RTO Predict API:
   * POST /v2/rto/predict (https://api.gokwik.co)
   */
  async predictRtoRisk(
    input: GoKwikRtoPredictInput
  ): Promise<GoKwikRtoPredictResult> {
    if (!this.client) {
      return {
        success: false,
        riskFlag: 'UNKNOWN',
        error: 'GoKwik API credentials (gk-app-id / gk-app-secret) not configured',
      };
    }

    try {
      const reqId = input.requestId || `rto_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      const orderDateStr = input.orderDate
        ? input.orderDate instanceof Date
          ? input.orderDate.toISOString()
          : String(input.orderDate)
        : new Date().toISOString();

      const totalVal = String(input.totalPrice !== undefined ? input.totalPrice : 0);
      const rawPhone = input.shippingAddress?.phone || input.customer?.phone || '';
      const phone = rawPhone.replace(/\D/g, '').slice(-10) || '9876543210';
      const email = input.shippingAddress?.email || input.customer?.email || 'customer@example.com';

      const items = (input.lineItems && input.lineItems.length > 0
        ? input.lineItems
        : [{ name: 'Item', quantity: 1, price: Number(totalVal) }]
      ).map((item, idx) => {
        const itemPrice = item.price !== undefined ? String(item.price) : '0';
        const qty = item.quantity || 1;
        const itemTotal = String(Number(itemPrice) * qty);
        const pId = (item as any).productId || item.sku || `prod_${idx + 1}`;
        const lId = (item as any).lineItemId || `li_${idx + 1}`;
        return {
          line_item_id: String(lId),
          product_id: String(pId),
          variant_id: String((item as any).variantId || pId),
          sku: item.sku || `SKU_${idx + 1}`,
          name: item.title || item.name || 'Product',
          price: itemPrice,
          total: itemTotal,
          subtotal: itemTotal,
          quantity: qty,
          tax: '0',
          item_size: (item as any).size || 'Free Size',
          item_brand: (item as any).brand || 'Youthnic',
          item_color: (item as any).color || 'Default',
          item_height: '0',
          item_length: '0',
          item_breadth: '0',
          item_weight: '350',
          item_rating: '4.5',
          product_url: '',
          product_thumbnail_url: '',
          seller_code: 'YOUTHNIC',
          is_exclusive: false,
          sub_category: 'Clothing',
          major_category: 'Fashion',
          target_group: 'All',
          article_price: itemPrice,
          item_cashback: '0',
          item_discount: '0',
          item_shipping: '0',
          seller_rating: '4.8',
          seller_origin_city: input.shippingAddress?.city || 'Surat',
          seller_origin_pincode: input.shippingAddress?.postcode || '395007',
        };
      });

      const addressPayload = {
        first_name: input.shippingAddress?.firstName || 'Customer',
        last_name: input.shippingAddress?.lastName || '',
        address_1: input.shippingAddress?.address1 || 'Address Line 1',
        address_2: input.shippingAddress?.address2 || '',
        city: input.shippingAddress?.city || 'City',
        state: input.shippingAddress?.state || 'State',
        postcode: input.shippingAddress?.postcode || '395007',
        phone,
        email,
        company: '',
        type: 'home',
      };

      const payload = {
        request_id: reqId,
        order: {
          total: totalVal,
          subtotal: totalVal,
          cashback: '0',
          total_tax: '0',
          total_discount: '0',
          total_shipping: '0',
          user_type: 'new',
          promo_code: '',
          order_date: orderDateStr,
          past_del: null,
          past_shipped: null,
          platform_type: input.platformType || 'shopify',
          total_line_items: items.length,
          total_line_items_quantity: items.reduce((sum, it) => sum + it.quantity, 0),
          session: {
            source: '',
            utm: { source: '', medium: '', campaign: '' },
            customer_ip: '127.0.0.1',
            customer_user_agent: 'Mozilla/5.0',
          },
          line_items: items,
          billing_address: addressPayload,
          shipping_address: addressPayload,
        },
        customer: {
          phone,
          email,
          age: null,
          gender: null,
          past_del: '0',
          past_shipped: '0',
          platform_type: input.platformType || 'shopify',
          customer_since: null,
          wallet_balance: null,
        },
      };

      const response = await this.client.post('/v2/rto/predict', payload, {
        headers: {
          appid: config.gokwik.appId,
          appsecret: config.gokwik.appSecret,
          'gk-app-id': config.gokwik.appId,
          'gk-app-secret': config.gokwik.appSecret,
          'Content-Type': 'application/json',
          accept: 'application/json',
        },
      });

      const resData = response.data;
      if (resData?.status_code !== undefined && resData?.status_code !== 200) {
        return {
          success: false,
          riskFlag: 'UNKNOWN',
          error: resData?.message || resData?.msg || 'GoKwik RTO predict failed',
          raw: resData,
        };
      }
      if (resData?.success === false) {
        return {
          success: false,
          riskFlag: 'UNKNOWN',
          error: resData?.error?.message || resData?.error || resData?.message || 'GoKwik RTO predict failed',
          raw: resData,
        };
      }

      const data = resData?.data || resData;
      const rawFlag = String(data?.risk_flag || data?.riskFlag || data?.flag || '').toLowerCase();

      let riskFlag: 'LOW' | 'MEDIUM' | 'HIGH' | 'CONTROL' | 'UNKNOWN' = 'UNKNOWN';
      if (rawFlag.includes('high')) {
        riskFlag = 'HIGH';
      } else if (rawFlag.includes('medium') || rawFlag.includes('moderate')) {
        riskFlag = 'MEDIUM';
      } else if (rawFlag.includes('low')) {
        riskFlag = 'LOW';
      } else if (rawFlag.includes('control')) {
        riskFlag = 'CONTROL';
      }

      const riskScore =
        data?.risk_score !== undefined
          ? Number(data.risk_score)
          : data?.score !== undefined
          ? Number(data.score)
          : undefined;

      const riskReason =
        data?.reason ||
        data?.risk_reason ||
        (riskFlag === 'HIGH'
          ? 'High RTO risk: predicted high return propensity on GoKwik network'
          : riskFlag === 'MEDIUM'
          ? 'Medium RTO risk: moderate return risk or unverified COD intent'
          : riskFlag === 'LOW'
          ? 'Low RTO risk: high delivery propensity verified on GoKwik network'
          : 'GoKwik RTO risk prediction completed');

      const allowCod =
        data?.recommendations?.allow_cod !== undefined
          ? Boolean(data.recommendations.allow_cod)
          : riskFlag !== 'HIGH';

      const incentivizePrepaid =
        data?.recommendations?.incentivize_prepaid !== undefined
          ? Boolean(data.recommendations.incentivize_prepaid)
          : (riskFlag === 'HIGH' || riskFlag === 'MEDIUM');

      logger.info('GoKwik RTO prediction completed', {
        merchantOrderId: input.merchantOrderId,
        riskFlag,
        riskScore,
        allowCod,
      });

      return {
        success: true,
        riskFlag,
        riskScore,
        riskReason,
        allowCod,
        incentivizePrepaid,
        requestId: data?.request_id || reqId,
        raw: data,
      };
    } catch (error: any) {
      const errMsg = error.response?.data?.error?.message || error.response?.data?.message || error.message;
      logger.error('GoKwik RTO prediction request failed', {
        merchantOrderId: input.merchantOrderId,
        error: errMsg,
      });
      return {
        success: false,
        riskFlag: 'UNKNOWN',
        error: typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg),
        raw: error.response?.data,
      };
    }
  }
}

export const gokwikService = new GoKwikService();
export default gokwikService;
