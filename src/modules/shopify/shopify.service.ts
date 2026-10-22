import axios, { AxiosInstance } from 'axios';
import { config } from '../../config';
import prisma from '../../database/prisma';
import logger from '../../utils/logger';
import { withRetry } from '../../utils/retry';
import { isDelhiveryCourier, isVelocityCourier, getTrackingUrl, normalizeCourierName } from '../../utils/courier';
import { ShopifyOrderWebhook } from '../../types';
import { extractOrderFinancials } from '../orders/order-financials';
import { OrderStatus } from '@prisma/client';
import { shopifyTokenProvider } from './token.provider';
import { mapReturnReason, selectReturnFulfillmentLines } from '../returns/return-reasons';
import {
  isApprovedForDispatch,
  isCodConfirmed,
  isHighRtoCancel,
  mapShopifyShipmentStatus,
  orderStatusFromLiveTracking,
  trackingLabelFromShopify,
} from '../orders/order-tabs';
import { OMS_OWNED_ORDER_STATUSES } from '../orders/order-lifecycle';

/**
 * Shopify Service
 * Handles: fetching orders, registering webhooks, processing refunds
 */
/**
 * Values Shopify puts in `source_name` instead of a numeric app id.
 * Anything not listed here is an app id that has to be resolved to a name.
 */
const KNOWN_ORDER_SOURCES: Record<string, string> = {
  web: 'Online Store',
  pos: 'Point of Sale',
  shopify_draft_order: 'Draft Order',
  iphone: 'Shopify Mobile (iPhone)',
  android: 'Shopify Mobile (Android)',
};

/** Round a rupee amount to paise. */
export function roundMoney(value: number): number {
  return Math.round((Number(value) || 0) * 100) / 100;
}

/**
 * Find the Shopify line item for one of our order items.
 *
 * Every size of a product shares the same title, so title is only a last
 * resort: variant id first, then SKU, then title + variant title, then a title
 * whose line is the only one with that title. Lines in `taken` are skipped so
 * two of our items never map onto the same Shopify line.
 */
export function matchShopifyLineItem<T extends { id: number; variant_id?: number | string | null; sku?: string | null; title?: string | null; variant_title?: string | null }>(
  lineItems: T[],
  item: { shopifyVariantId?: string | null; sku?: string | null; title?: string | null; variantTitle?: string | null },
  taken: Set<number> = new Set()
): T | undefined {
  const open = lineItems.filter((li) => !taken.has(li.id));
  const variantId = (item.shopifyVariantId || '').toString().trim();
  if (variantId) {
    const byVariant = open.find((li) => li.variant_id != null && li.variant_id.toString() === variantId);
    if (byVariant) return byVariant;
  }
  if (item.sku) {
    const bySku = open.find((li) => li.sku && li.sku === item.sku);
    if (bySku) return bySku;
  }
  if (item.title && item.variantTitle) {
    const byTitleAndVariant = open.find(
      (li) => li.title === item.title && (li.variant_title || '') === item.variantTitle
    );
    if (byTitleAndVariant) return byTitleAndVariant;
  }
  if (item.title) {
    const sameTitle = open.filter((li) => li.title === item.title);
    if (sameTitle.length === 1) return sameTitle[0];
  }
  return undefined;
}

class ShopifyService {
  private client: AxiosInstance;

  /**
   * source_name -> human readable channel name. Resolving an app id needs a
   * GraphQL call, so each distinct channel is looked up once per process.
   */
  private salesChannelCache = new Map<string, string>();

  constructor() {
    const baseUrl = `https://${config.shopify.shopDomain}/admin/api/${config.shopify.apiVersion}`;
    this.client = axios.create({
      baseURL: baseUrl,
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });

    // Attach a valid access token to every request. The provider returns the
    // legacy static token when configured, otherwise it caches and refreshes
    // a Dev Dashboard client-credentials token (24h expiry) before expiry.
    this.client.interceptors.request.use(async (requestConfig) => {
      requestConfig.headers['X-Shopify-Access-Token'] =
        await shopifyTokenProvider.getAccessToken();
      return requestConfig;
    });
  }

  /**
   * Execute an Admin GraphQL query or mutation with error checking,
   * THROTTLED detection, and automatic retry.
   */
  async graphql<T = any>(
    query: string,
    variables?: Record<string, any>
  ): Promise<T> {
    return withRetry(
      async () => {
        const response = await this.client.post('/graphql.json', {
          query,
          variables,
        });

        const data = response.data;
        if (data?.errors && data.errors.length > 0) {
          const firstError = data.errors[0];
          const isThrottled =
            firstError?.extensions?.code === 'THROTTLED' ||
            firstError?.message?.toLowerCase().includes('throttled');

          const error: any = new Error(
            `Shopify GraphQL Error: ${firstError?.message || 'Unknown error'}`
          );
          error.graphQLErrors = data.errors;
          error.extensions = firstError?.extensions;
          if (isThrottled) {
            error.code = 'THROTTLED';
          }
          throw error;
        }

        return data?.data as T;
      },
      { attempts: 3, baseDelayMs: 600 }
    );
  }

  /**
   * Fetch orders created/updated since a given timestamp.
   * Returns raw Shopify order objects.
   */
  async fetchOrdersSince(sinceDate: Date): Promise<ShopifyOrderWebhook[]> {
    const minDate = sinceDate < config.shopify.syncStartDate
      ? config.shopify.syncStartDate.toISOString()
      : sinceDate.toISOString();
    const cutoffDate = config.shopify.syncStartDate.toISOString();
    try {
      const orders: ShopifyOrderWebhook[] = [];
      let nextUrl: string | null = '/orders.json';
      let isFirstRequest = true;

      while (nextUrl) {
        const url = nextUrl;
        const params = isFirstRequest
          ? {
              updated_at_min: minDate,
              created_at_min: cutoffDate,
              status: 'any',
              limit: 250,
              order: 'updated_at asc',
            }
          : undefined;
        // Retry transient Shopify 429/5xx so order sync doesn't fall back to empty.
        const response = await withRetry(() => this.client.get(url, { params }), {
          attempts: 3,
          baseDelayMs: 600,
        });

        orders.push(...((response.data.orders || []) as ShopifyOrderWebhook[]));
        nextUrl = this.getNextPageUrl(response.headers.link);
        isFirstRequest = false;
      }

      return orders;
    } catch (error: any) {
      logger.error('Failed to fetch orders from Shopify', {
        error: error.message,
        sinceDate: minDate,
      });
      throw error;
    }
  }

  /**
   * Fetch all open, unfulfilled orders from Shopify channel.
   * Matches Delhivery One's channel logic ("fetch all unfulfilled orders from channel").
   */
  async fetchOpenUnfulfilledOrders(): Promise<ShopifyOrderWebhook[]> {
    const cutoffDate = config.shopify.syncStartDate.toISOString();
    try {
      const orders: ShopifyOrderWebhook[] = [];
      let nextUrl: string | null = '/orders.json';
      let isFirstRequest = true;

      while (nextUrl) {
        const response = await this.client.get(nextUrl, {
          params: isFirstRequest
            ? {
                status: 'open',
                fulfillment_status: 'unfulfilled',
                created_at_min: cutoffDate,
                limit: 250,
                order: 'created_at desc',
              }
            : undefined,
        });

        orders.push(...((response.data.orders || []) as ShopifyOrderWebhook[]));
        nextUrl = this.getNextPageUrl(response.headers.link);
        isFirstRequest = false;
      }

      logger.info('Fetched open unfulfilled orders from Shopify channel', { count: orders.length });
      return orders;
    } catch (error: any) {
      logger.error('Failed to fetch unfulfilled orders from Shopify channel', {
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Fetch a single order by its Shopify order ID.
   */
  async fetchOrder(shopifyOrderId: string): Promise<ShopifyOrderWebhook> {
    try {
      const response = await this.client.get(`/orders/${shopifyOrderId}.json`);
      return response.data.order as ShopifyOrderWebhook;
    } catch (error: any) {
      logger.error('Failed to fetch single order from Shopify', {
        shopifyOrderId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Get store information from Shopify (used for live health check and connection test).
   */
  async getShop(): Promise<any> {
    try {
      const response = await this.client.get('/shop.json');
      return response.data.shop;
    } catch (error: any) {
      logger.error('Failed to ping shopify shop info', { error: error.message });
      throw error;
    }
  }

  /**
   * Register webhooks for order creation, updates, and refunds.
   * Call this once during setup.
   */
  async registerWebhooks(): Promise<Array<{ topic: string; address: string; status: 'created' | 'exists' | 'failed'; message?: string }>> {
    const webhookTopics = [
      'orders/create',
      'orders/paid',
      'orders/updated',
      'orders/cancelled',
      'orders/fulfilled',
      'fulfillments/create',
      'fulfillments/update',
      'refunds/create',
    ];

    const baseUrl = (config.appBaseUrl || '').replace(/\/$/, '');
    const results: Array<{ topic: string; address: string; status: 'created' | 'exists' | 'failed'; message?: string }> = [];

    // Shopify rejects non-HTTPS callback URLs — surface it before attempting registration.
    if (!/^https:\/\//i.test(baseUrl)) {
      logger.warn('APP_BASE_URL is not public HTTPS — Shopify webhook registration will fail', { baseUrl });
    }

    for (const topic of webhookTopics) {
      const address = `${baseUrl}/webhooks/shopify`;
      try {
        // Check if webhook already exists
        const existing = await withRetry(
          () => this.client.get('/webhooks.json', { params: { topic, address } }),
          { attempts: 2, baseDelayMs: 400 }
        );

        if (existing.data.webhooks && existing.data.webhooks.length > 0) {
          logger.info(`Webhook already registered: ${topic}`);
          results.push({ topic, address, status: 'exists' });
          continue;
        }

        await withRetry(
          () =>
            this.client.post('/webhooks.json', {
              webhook: { topic, address, format: 'json' },
            }),
          { attempts: 2, baseDelayMs: 400 }
        );
        logger.info(`Registered webhook: ${topic}`);
        results.push({ topic, address, status: 'created' });
      } catch (error: any) {
        logger.error(`Failed to register webhook: ${topic}`, { error: error.message });
        results.push({ topic, address, status: 'failed', message: error.message });
      }
    }
    return results;
  }

  /**
   * List currently registered Shopify webhooks (for setup-status endpoint).
   */
  async listWebhooks(): Promise<any[]> {
    try {
      const response = await withRetry(() => this.client.get('/webhooks.json'), {
        attempts: 2,
        baseDelayMs: 400,
      });
      return response.data?.webhooks || [];
    } catch (error: any) {
      logger.warn('Failed to list Shopify webhooks', { error: error.message });
      return [];
    }
  }

  /**
   * Verify Shopify webhook signature using HMAC.
   */
  verifyWebhook(rawBody: string, hmacHeader: string): boolean {
    if (!config.shopify.webhookSecret) {
      // A forged orders/create marked "paid" would otherwise be imported and
      // dispatched. Only local development may run without a secret.
      if (config.nodeEnv === 'production') {
        logger.error('Shopify webhook rejected: no SHOPIFY_CLIENT_SECRET / SHOPIFY_WEBHOOK_SECRET configured');
        return false;
      }
      logger.warn('SHOPIFY_WEBHOOK_SECRET not set — skipping verification');
      return true;
    }
    const crypto = require('crypto');
    const expected: Buffer = crypto
      .createHmac('sha256', config.shopify.webhookSecret)
      .update(rawBody, 'utf8')
      .digest();
    const provided = Buffer.from(hmacHeader || '', 'base64');
    return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
  }

  /**
   * Create a refund on Shopify for an order.
   * This processes the refund through Shopify so the customer gets their money back
   * via the original payment gateway.
   *
   * Shopify's refunds/calculate decides the refund line items, shipping and the
   * amount per parent transaction, so order discounts and taxes are respected.
   *
   * @param shopifyOrderId - Shopify order ID (REST id as string)
   * @param refundAmount - amount to refund; null refunds exactly what Shopify
   *   calculates for the given line items (and shipping). A number is capped at
   *   what the order still has refundable.
   * @param refundLineItems - items being refunded with quantities
   * @param refundShipping - also refund the order's shipping charge
   * @param options.idempotencyKey - written into the refund note. If a refund
   *   with this key already exists (an earlier attempt reached Shopify but its
   *   response was lost), it is returned instead of refunding again.
   * @returns amount actually refunded, and moneyMoved=false when the order had
   *   no captured payment (COD), so nothing went back to the customer.
   */
  async createRefund(
    shopifyOrderId: string,
    refundAmount: number | null,
    refundLineItems: Array<{ lineItemId: number; quantity: number; restockType?: string }>,
    refundShipping: boolean = false,
    options: { idempotencyKey?: string } = {}
  ): Promise<{ refundId: string; success: boolean; amount: number; moneyMoved: boolean; alreadyRefunded: boolean }> {
    try {
      if (options.idempotencyKey) {
        const existing = await this.findRefundByKey(shopifyOrderId, options.idempotencyKey);
        if (existing) {
          logger.warn('Shopify already has a refund for this key, not refunding again', {
            shopifyOrderId,
            idempotencyKey: options.idempotencyKey,
            refundId: existing.refundId,
          });
          return { ...existing, success: true, alreadyRefunded: true };
        }
      }

      // Calculate first so Shopify determines valid refundable line items,
      // duties, taxes, and shipping values for the current order state.
      const calculationResponse = await this.client.post(
        `/orders/${shopifyOrderId}/refunds/calculate.json`,
        {
          refund: {
            refund_line_items: refundLineItems.map((item) => ({
              line_item_id: item.lineItemId,
              quantity: item.quantity,
              restock_type: item.restockType || 'return',
            })),
            ...(refundShipping ? { shipping: { full_refund: true } } : {}),
          },
        }
      );

      const calculatedRefund = calculationResponse.data.refund;
      if (!calculatedRefund) {
        throw new Error('Shopify did not return a calculated refund');
      }

      let transactionsPayload: Array<{ parent_id: number; amount: string; kind: 'refund'; gateway: string }> = [];
      let amount = 0;

      // Shopify suggests one refund per parent payment, with the most that can
      // still be refunded from it.
      const suggested = (calculatedRefund.transactions || []).filter(
        (t: any) => t.kind === 'suggested_refund' && t.parent_id
      );
      if (suggested.length > 0) {
        const maxRefundable = roundMoney(
          suggested.reduce((sum: number, t: any) => sum + (parseFloat(t.maximum_refundable) || 0), 0)
        );
        const suggestedAmount = roundMoney(
          suggested.reduce((sum: number, t: any) => sum + (parseFloat(t.amount) || 0), 0)
        );
        amount = refundAmount === null ? suggestedAmount : Math.min(roundMoney(refundAmount), maxRefundable);
        if (refundAmount !== null && refundAmount > maxRefundable) {
          logger.warn('Refund amount capped at what Shopify still has refundable', {
            shopifyOrderId,
            requested: refundAmount,
            maxRefundable,
          });
        }
        let remaining = amount;
        for (const t of suggested) {
          if (remaining <= 0) break;
          const part = roundMoney(Math.min(remaining, parseFloat(t.maximum_refundable) || 0));
          if (part > 0) {
            transactionsPayload.push({ parent_id: t.parent_id, amount: part.toFixed(2), kind: 'refund', gateway: t.gateway });
            remaining = roundMoney(remaining - part);
          }
        }
      } else if (refundAmount !== null && refundAmount > 0) {
        // Older behaviour for gateways Shopify gives no suggestion for: refund
        // against the first successful sale/capture.
        const transactionResponse = await this.client.get(
          `/orders/${shopifyOrderId}/transactions.json`
        );
        const transactions = transactionResponse.data.transactions || [];
        const parentTx = transactions.find(
          (t: any) =>
            (t.kind === 'sale' || t.kind === 'capture') &&
            (t.status === 'success' || t.status === 'captured')
        );
        if (parentTx) {
          amount = roundMoney(refundAmount);
          transactionsPayload = [
            { parent_id: parentTx.id, amount: amount.toFixed(2), kind: 'refund', gateway: parentTx.gateway },
          ];
        }
      }

      const moneyMoved = transactionsPayload.length > 0 && amount > 0;
      const refundPayload = {
        refund: {
          ...(options.idempotencyKey ? { note: `[${options.idempotencyKey}] Refund issued by Youthnic OMS` } : {}),
          refund_line_items: calculatedRefund.refund_line_items,
          ...(refundShipping && calculatedRefund.shipping
            ? { shipping: calculatedRefund.shipping }
            : {}),
          ...(moneyMoved ? { transactions: transactionsPayload } : {}),
        },
      };

      const response = await this.client.post(
        `/orders/${shopifyOrderId}/refunds.json`,
        refundPayload
      );

      const refundId = response.data.refund?.id?.toString() || 'REFUND-' + Date.now();
      const refundAmountLabel = moneyMoved ? amount : 0;
      logger.info('Refund created on Shopify', { shopifyOrderId, refundId, amount: refundAmountLabel, moneyMoved });

      // Update order tags and notes on Shopify
      try {
        const orderData = await this.fetchOrder(shopifyOrderId);
        const existingTags = orderData.tags ? orderData.tags.split(',').map((t: string) => t.trim()) : [];
        const newTags = Array.from(new Set([...existingTags, 'Refunded', `Refund-Processed:Rs${Math.round(refundAmountLabel)}`]));
        const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
        const noteAddition = `\n[Refund Processed - ${timestamp}] Amount: ₹${refundAmountLabel.toFixed(2)} | Refund ID: ${refundId}`;
        const updatedNote = (orderData as any).note ? `${(orderData as any).note}\n${noteAddition}` : noteAddition.trim();

        await this.client.put(`/orders/${shopifyOrderId}.json`, {
          order: {
            id: shopifyOrderId,
            tags: newTags.join(', '),
            note: updatedNote,
          },
        });
      } catch (tagErr: any) {
        logger.warn('Could not append refund tag/note to Shopify order', { error: tagErr.message });
      }

      return { refundId, success: true, amount: refundAmountLabel, moneyMoved, alreadyRefunded: false };
    } catch (error: any) {
      logger.error('Failed to create refund on Shopify', {
        shopifyOrderId,
        refundAmount,
        error: error.response?.data || error.message,
      });
      throw error;
    }
  }

  /**
   * The refund an earlier attempt created with this idempotency key, if any.
   * Throws when Shopify cannot be read, so a caller never refunds blind.
   */
  private async findRefundByKey(
    shopifyOrderId: string,
    idempotencyKey: string
  ): Promise<{ refundId: string; amount: number; moneyMoved: boolean } | null> {
    const response = await this.client.get(`/orders/${shopifyOrderId}/refunds.json`);
    const refunds: any[] = response.data?.refunds || [];
    const match = refunds.find(
      (refund) => typeof refund?.note === 'string' && refund.note.includes(`[${idempotencyKey}]`)
    );
    if (!match) return null;
    // Payment-app gateways (Easebuzz, GoKwik) keep a refund "pending" while
    // they settle it; that money is already on its way back.
    const amount = roundMoney(
      (match.transactions || [])
        .filter((t: any) => t.kind === 'refund' && (t.status === 'success' || t.status === 'pending'))
        .reduce((sum: number, t: any) => sum + (parseFloat(t.amount) || 0), 0)
    );
    return { refundId: String(match.id), amount, moneyMoved: amount > 0 };
  }

  /**
   * Open a real Shopify return (Admin → order shows Return), attach the
   * Delhivery reverse AWB, and keep the timeline note.
   * Requires the app token to include write_returns. A missing scope still
   * writes the note so the reverse pickup is not lost.
   */
  async registerReturnOnShopify(
    shopifyOrderId: string,
    returnData: {
      returnReason: string;
      returnTrackingNumber?: string;
      carrier?: string;
      items?: Array<{ sku?: string | null; title?: string | null; quantity: number }>;
      noteOnly?: boolean;
    }
  ): Promise<{
    success: boolean;
    tagsAdded?: string[];
    note?: string;
    shopifyReturnId?: string | null;
    returnError?: string;
  }> {
    const mapped = mapReturnReason(returnData.returnReason);
    let shopifyReturnId: string | null = null;
    let returnError: string | undefined;

    try {
      if (!returnData.noteOnly) shopifyReturnId = await this.createShopifyReturn(shopifyOrderId, {
        reason: mapped.shopifyReason,
        reasonNote: mapped.note,
        items: returnData.items || [],
        trackingNumber: returnData.returnTrackingNumber,
        carrier: returnData.carrier || 'Delhivery',
      });
    } catch (error: any) {
      returnError = error.message || 'Shopify returnCreate failed';
      logger.error('Shopify returnCreate failed; the order note will still be updated', {
        shopifyOrderId,
        error: returnError,
      });
    }

    try {
      const order = await this.fetchOrder(shopifyOrderId);
      const existingTags = order.tags ? order.tags.split(',').map((t: string) => t.trim()) : [];
      const newTags = Array.from(new Set([
        ...existingTags,
        'Return-Initiated',
        ...(returnData.returnTrackingNumber ? [`Return-AWB:${returnData.returnTrackingNumber}`] : []),
        ...(returnData.carrier ? [`Return-Courier:${returnData.carrier}`] : []),
      ]));

      const existingNote = (order as any).note || '';
      const returnTimestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
      const returnLogEntry = `[Return Initiated - ${returnTimestamp}] Courier: ${returnData.carrier || 'Delhivery'}${
        returnData.returnTrackingNumber ? ` | Reverse AWB: ${returnData.returnTrackingNumber}` : ''
      } | Reason: ${mapped.delhiveryReason} (${mapped.note})${
        shopifyReturnId ? ` | Shopify return: ${shopifyReturnId}` : ''
      }`;
      const updatedNote = existingNote ? `${existingNote}\n${returnLogEntry}` : returnLogEntry;

      await this.client.put(`/orders/${shopifyOrderId}.json`, {
        order: {
          id: shopifyOrderId,
          tags: newTags.join(', '),
          note: updatedNote,
        },
      });

      logger.info('Return registered on Shopify order', {
        shopifyOrderId,
        returnWaybill: returnData.returnTrackingNumber,
        shopifyReturnId,
      });

      return { success: true, tagsAdded: newTags, note: updatedNote, shopifyReturnId, returnError };
    } catch (error: any) {
      logger.error('Failed to register return on Shopify order', {
        shopifyOrderId,
        error: error.response?.data || error.message,
      });
      return { success: Boolean(shopifyReturnId), shopifyReturnId, returnError: returnError || error.message };
    }
  }

  /**
   * Closes an open Return in Shopify using GraphQL mutation returnClose.
   * This officially marks the return as completed/received in Shopify Admin.
   */
  async closeShopifyReturn(shopifyReturnId: string): Promise<{ success: boolean; status?: string; error?: string }> {
    const returnGid = shopifyReturnId.startsWith('gid://')
      ? shopifyReturnId
      : `gid://shopify/Return/${shopifyReturnId}`;

    const mutation = `mutation ReturnClose($id: ID!) {
      returnClose(id: $id) {
        return {
          id
          status
        }
        userErrors {
          field
          message
        }
      }
    }`;

    try {
      const res = await this.graphql<{
        returnClose: {
          return: { id: string; status: string } | null;
          userErrors: Array<{ field: string[]; message: string }>;
        };
      }>(mutation, { id: returnGid });

      const errors = res.returnClose?.userErrors || [];
      if (errors.length) {
        const errorMsg = errors.map((e) => e.message).join('; ');
        logger.warn('Shopify returnClose returned user errors', { returnGid, errorMsg });
        return { success: false, error: errorMsg };
      }

      logger.info('Shopify return closed successfully', {
        returnGid,
        status: res.returnClose?.return?.status,
      });

      return { success: true, status: res.returnClose?.return?.status };
    } catch (err: any) {
      logger.error('Failed to close Shopify return', { returnGid, error: err.message });
      return { success: false, error: err.message };
    }
  }

  /**
   * Marks a return as received on Shopify:
   * 1. Closes any open Return on Shopify (via returnClose GraphQL mutation).
   * 2. Appends 'Return Received', 'Return Delivered', 'RTO_DELIVERED', 'Scanned Received' tags.
   * 3. Appends an audit note to the Shopify order timeline.
   */
  async markReturnReceivedOnShopify(
    shopifyOrderId: string,
    details: {
      scanId?: number | string;
      tracking?: string;
      issueLabel?: string | null;
      shopifyReturnId?: string | null;
      ironRequired?: boolean;
    } = {}
  ): Promise<{
    success: boolean;
    closedReturnIds: string[];
    tagsAdded: string[];
    noteUpdated: boolean;
    errors: string[];
  }> {
    const result = {
      success: true,
      closedReturnIds: [] as string[],
      tagsAdded: [] as string[],
      noteUpdated: false,
      errors: [] as string[],
    };

    const orderGid = shopifyOrderId.startsWith('gid://')
      ? shopifyOrderId
      : `gid://shopify/Order/${shopifyOrderId}`;
    const numericOrderId = shopifyOrderId.replace(/\D/g, '');

    // 1. Close open returns on Shopify
    try {
      const orderQuery = `query OrderReturnsForReceipt($id: ID!) {
        order(id: $id) {
          id
          name
          returnStatus
          returns(first: 10) {
            nodes {
              id
              status
            }
          }
        }
      }`;

      const orderData = await this.graphql<{
        order: {
          id: string;
          name: string;
          returnStatus: string;
          returns: { nodes: Array<{ id: string; status: string }> };
        } | null;
      }>(orderQuery, { id: orderGid });

      const returnNodes = orderData.order?.returns?.nodes || [];
      const returnsToClose = returnNodes.filter((r) => r.status === 'OPEN' || r.status === 'REQUESTED');

      // If a specific return ID was provided and not found in nodes, try closing it too
      if (details.shopifyReturnId) {
        const specificGid = details.shopifyReturnId.startsWith('gid://')
          ? details.shopifyReturnId
          : `gid://shopify/Return/${details.shopifyReturnId}`;
        if (!returnsToClose.some((r) => r.id === specificGid)) {
          returnsToClose.push({ id: specificGid, status: 'OPEN' });
        }
      }

      for (const ret of returnsToClose) {
        const closeRes = await this.closeShopifyReturn(ret.id);
        if (closeRes.success) {
          result.closedReturnIds.push(ret.id);
        } else if (closeRes.error) {
          result.errors.push(`Return ${ret.id}: ${closeRes.error}`);
        }
      }
    } catch (err: any) {
      logger.warn('Failed to query/close open returns on Shopify', { shopifyOrderId, error: err.message });
      result.errors.push(`GraphQL returns check: ${err.message}`);
    }

    // 2. Add Return Received tags and timeline note
    try {
      const order = await this.fetchOrder(numericOrderId || shopifyOrderId);
      const existingTags = order.tags ? order.tags.split(',').map((t: string) => t.trim()).filter(Boolean) : [];
      const tagSet = new Set(existingTags);
      tagSet.add('Return Received');
      tagSet.add('Return Delivered');
      tagSet.add('RTO_DELIVERED');
      tagSet.add('Scanned Received');
      if (details.ironRequired) {
        tagSet.add('Iron Required');
      }
      result.tagsAdded = Array.from(tagSet);

      const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
      const qcNote = details.issueLabel ? ` | QC: ${details.issueLabel}` : '';
      const trackingNote = details.tracking ? ` | Tracking: ${details.tracking}` : '';
      const scanNote = details.scanId ? ` | Scan #${details.scanId}` : '';
      const receiptLogEntry = `[Return Received - ${timestamp}] Verified received at warehouse${scanNote}${trackingNote}${qcNote}`;
      
      const existingNote = (order as any).note || '';
      const updatedNote = existingNote ? `${existingNote}\n${receiptLogEntry}` : receiptLogEntry;

      await this.client.put(`/orders/${numericOrderId || shopifyOrderId}.json`, {
        order: {
          id: numericOrderId || shopifyOrderId,
          tags: Array.from(tagSet).join(', '),
          note: updatedNote,
        },
      });

      result.noteUpdated = true;
      logger.info('Marked return received on Shopify order', {
        shopifyOrderId,
        closedReturns: result.closedReturnIds,
        tagsCount: tagSet.size,
      });
    } catch (err: any) {
      logger.error('Failed to update Shopify tags/note for return receipt', {
        shopifyOrderId,
        error: err.response?.data || err.message,
      });
      result.errors.push(`Tags/Note update: ${err.message}`);
      result.success = false;
    }

    return result;
  }

  /**
   * returnCreate + reverse delivery tracking. Throws when Shopify rejects it.
   */
  private async createShopifyReturn(
    shopifyOrderId: string,
    input: {
      reason: string;
      reasonNote: string;
      items: Array<{ sku?: string | null; title?: string | null; quantity: number }>;
      trackingNumber?: string;
      carrier: string;
    }
  ): Promise<string> {
    const orderGid = shopifyOrderId.startsWith('gid://')
      ? shopifyOrderId
      : `gid://shopify/Order/${shopifyOrderId}`;

    const linesQuery = `query OrderReturnLines($id: ID!) {
      order(id: $id) {
        fulfillments {
          fulfillmentLineItems(first: 40) {
            nodes { id quantity lineItem { sku title } }
          }
        }
      }
    }`;
    const orderData = await this.graphql<{
      order: {
        fulfillments: Array<{
          fulfillmentLineItems: { nodes: Array<{ id: string; quantity: number; lineItem: { sku?: string | null; title?: string | null } }> };
        }>;
      } | null;
    }>(linesQuery, { id: orderGid });

    const lines = (orderData.order?.fulfillments || []).flatMap((fulfillment) =>
      (fulfillment.fulfillmentLineItems?.nodes || []).map((node) => ({
        id: node.id,
        quantity: node.quantity,
        sku: node.lineItem?.sku,
        title: node.lineItem?.title,
      }))
    );
    const requested = input.items.length
      ? input.items
      : lines.map((line) => ({ sku: line.sku, title: line.title, quantity: line.quantity }));
    const returnLineItems = selectReturnFulfillmentLines(lines, requested).map((line) => ({
      fulfillmentLineItemId: line.fulfillmentLineItemId,
      quantity: line.quantity,
      returnReason: input.reason,
      returnReasonNote: input.reasonNote.slice(0, 255),
    }));
    if (!returnLineItems.length) {
      throw new Error('Shopify has no fulfilled line items to open a return against.');
    }

    const createMutation = `mutation ReturnCreate($returnInput: ReturnInput!) {
      returnCreate(returnInput: $returnInput) {
        userErrors { field message }
        return { id status }
      }
    }`;
    const created = await this.graphql<{
      returnCreate: { userErrors: Array<{ message: string }>; return: { id: string; status: string } | null };
    }>(createMutation, { returnInput: { orderId: orderGid, returnLineItems } });
    const createErrors = created.returnCreate?.userErrors || [];
    if (createErrors.length || !created.returnCreate?.return?.id) {
      throw new Error(createErrors.map((err) => err.message).join('; ') || 'Shopify did not create the return.');
    }
    const returnId = created.returnCreate.return.id;

    if (input.trackingNumber) {
      await this.attachReverseTracking(returnId, input.trackingNumber, input.carrier);
    }
    return returnId;
  }

  private async attachReverseTracking(returnId: string, trackingNumber: string, carrier: string): Promise<void> {
    const reverseQuery = `query ReturnReverse($id: ID!) {
      return(id: $id) {
        reverseFulfillmentOrders(first: 5) {
          nodes {
            id
            lineItems(first: 20) { nodes { id totalQuantity } }
          }
        }
      }
    }`;
    const reverse = await this.graphql<{
      return: {
        reverseFulfillmentOrders: {
          nodes: Array<{ id: string; lineItems: { nodes: Array<{ id: string; totalQuantity: number }> } }>;
        };
      } | null;
    }>(reverseQuery, { id: returnId });
    const reverseOrder = reverse.return?.reverseFulfillmentOrders?.nodes?.[0];
    const reverseLines = reverseOrder?.lineItems?.nodes || [];
    if (!reverseOrder || !reverseLines.length) {
      logger.warn('Shopify return has no reverse fulfillment order yet', { returnId });
      return;
    }

    const deliveryMutation = `mutation ReverseDelivery($reverseFulfillmentOrderId: ID!, $reverseDeliveryLineItems: [ReverseDeliveryLineItemInput!]!, $trackingInput: ReverseDeliveryTrackingInput, $notifyCustomer: Boolean) {
      reverseDeliveryCreateWithShipping(
        reverseFulfillmentOrderId: $reverseFulfillmentOrderId
        reverseDeliveryLineItems: $reverseDeliveryLineItems
        trackingInput: $trackingInput
        notifyCustomer: $notifyCustomer
      ) {
        reverseDelivery { id }
        userErrors { field message }
      }
    }`;
    const delivered = await this.graphql<{
      reverseDeliveryCreateWithShipping: { userErrors: Array<{ message: string }>; reverseDelivery: { id: string } | null };
    }>(deliveryMutation, {
      reverseFulfillmentOrderId: reverseOrder.id,
      reverseDeliveryLineItems: reverseLines.map((line) => ({
        reverseFulfillmentOrderLineItemId: line.id,
        quantity: line.totalQuantity || 1,
      })),
      trackingInput: {
        number: trackingNumber,
        url: getTrackingUrl(carrier, trackingNumber) || `https://www.delhivery.com/track/package/${encodeURIComponent(trackingNumber)}`,
      },
      notifyCustomer: false,
    });
    const errors = delivered.reverseDeliveryCreateWithShipping?.userErrors || [];
    if (errors.length) {
      logger.warn('Shopify reverse tracking was not attached', {
        returnId,
        carrier,
        errors,
      });
    }
  }

  /**
   * Register fulfillment on Shopify with Delhivery tracking:
   * 1. Creates fulfillment on Shopify with Delhivery tracking info
   * 2. Appends Dispatched tag and Delhivery-AWB tag to the Shopify order
   */
  /**
   * Update tracking information on an existing Shopify fulfillment.
   * Uses GraphQL fulfillmentTrackingInfoUpdate with fallback to REST update_tracking.json.
   */
  async updateFulfillmentTracking(
    fulfillmentId: string,
    trackingInfo: {
      number: string;
      company: string;
      url?: string;
    },
    notifyCustomer: boolean = true
  ): Promise<{ success: boolean; fulfillment?: any }> {
    const gid = fulfillmentId.startsWith('gid://')
      ? fulfillmentId
      : `gid://shopify/Fulfillment/${fulfillmentId}`;

    try {
      const mutation = `mutation FulfillmentTrackingInfoUpdate(
        $fulfillmentId: ID!
        $trackingInfoInput: FulfillmentTrackingInput!
        $notifyCustomer: Boolean
      ) {
        fulfillmentTrackingInfoUpdate(
          fulfillmentId: $fulfillmentId
          trackingInfoInput: $trackingInfoInput
          notifyCustomer: $notifyCustomer
        ) {
          fulfillment {
            id
            status
            trackingInfo { company number url }
          }
          userErrors { field message }
        }
      }`;

      const variables = {
        fulfillmentId: gid,
        trackingInfoInput: {
          company: trackingInfo.company,
          number: trackingInfo.number,
          ...(trackingInfo.url ? { url: trackingInfo.url } : {}),
        },
        notifyCustomer,
      };

      const res = await this.graphql<{
        fulfillmentTrackingInfoUpdate: {
          fulfillment: any;
          userErrors: any[];
        };
      }>(mutation, variables);

      if (res?.fulfillmentTrackingInfoUpdate?.userErrors?.length > 0) {
        logger.warn('Shopify fulfillmentTrackingInfoUpdate userErrors', {
          fulfillmentId,
          errors: res.fulfillmentTrackingInfoUpdate.userErrors,
        });
      } else if (res?.fulfillmentTrackingInfoUpdate?.fulfillment) {
        logger.info('Updated fulfillment tracking via GraphQL', {
          fulfillmentId,
          trackingInfo,
        });
        return { success: true, fulfillment: res.fulfillmentTrackingInfoUpdate.fulfillment };
      }
    } catch (gqlErr: any) {
      logger.warn('GraphQL fulfillmentTrackingInfoUpdate failed, falling back to REST', {
        fulfillmentId,
        error: gqlErr.message,
      });
    }

    // REST fallback: POST /admin/api/{version}/fulfillments/{id}/update_tracking.json
    try {
      const numericId = fulfillmentId.replace(/\D/g, '');
      const payload = {
        fulfillment: {
          notify_customer: notifyCustomer,
          tracking_info: {
            number: trackingInfo.number,
            company: trackingInfo.company,
            ...(trackingInfo.url ? { url: trackingInfo.url } : {}),
          },
        },
      };
      const response = await this.client.post(
        `/fulfillments/${numericId}/update_tracking.json`,
        payload
      );
      return { success: true, fulfillment: response.data?.fulfillment };
    } catch (restErr: any) {
      logger.error('Failed to update fulfillment tracking via REST fallback', {
        fulfillmentId,
        error: restErr.response?.data || restErr.message,
      });
      return { success: false };
    }
  }

  /**
   * Set metafields on a Shopify resource (e.g. Order) using GraphQL metafieldsSet.
   */
  async setOrderMetafields(
    shopifyOrderId: string,
    metafields: Array<{
      key: string;
      value: string;
      type?: string;
      namespace?: string;
    }>
  ): Promise<{ success: boolean; metafields?: any[] }> {
    const ownerId = shopifyOrderId.startsWith('gid://')
      ? shopifyOrderId
      : `gid://shopify/Order/${shopifyOrderId}`;

    const mutation = `mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields {
          id
          namespace
          key
          value
        }
        userErrors {
          field
          message
        }
      }
    }`;

    try {
      const formatted = metafields.map((m) => ({
        ownerId,
        namespace: m.namespace || 'youthnic',
        key: m.key,
        value: m.value,
        type: m.type || 'single_line_text_field',
      }));

      const res = await this.graphql<{
        metafieldsSet: {
          metafields: any[];
          userErrors: any[];
        };
      }>(mutation, { metafields: formatted });

      if (res?.metafieldsSet?.userErrors?.length > 0) {
        logger.warn('Shopify metafieldsSet userErrors', {
          shopifyOrderId,
          errors: res.metafieldsSet.userErrors,
        });
        return { success: false };
      }

      logger.info('Saved metafields to Shopify Order', {
        shopifyOrderId,
        keys: metafields.map((m) => m.key),
      });
      return { success: true, metafields: res?.metafieldsSet?.metafields };
    } catch (err: any) {
      logger.warn('Failed to set metafields on Shopify order', {
        shopifyOrderId,
        error: err.message,
      });
      return { success: false };
    }
  }

  /**
   * Register fulfillment on Shopify with Delhivery tracking:
   * 1. Creates fulfillment on Shopify with Delhivery tracking info if open fulfillment order exists
   * 2. Or updates tracking on existing fulfillment if order is already fulfilled
   * 3. Appends Dispatched tag and Delhivery-AWB tag to the Shopify order
   * 4. Syncs Order Metafields for native visibility
   */
  async fulfillOrderOnShopify(
    shopifyOrderId: string,
    waybillNumber: string,
    courier: string = 'Delhivery',
    trackingUrl?: string
  ): Promise<{ success: boolean; fulfillmentId?: string }> {
    try {
      // 1. Fetch fulfillment orders for this order
      const foResponse = await this.client.get(
        `/orders/${shopifyOrderId}/fulfillment_orders.json`
      );
      const fulfillmentOrders = foResponse.data?.fulfillment_orders || [];
      const openFo = fulfillmentOrders.find(
        (fo: any) => fo.status === 'open' || fo.status === 'in_progress'
      );

      let fulfillmentId: string | undefined;

      const effectiveCourier = normalizeCourierName(courier, trackingUrl, waybillNumber);
      const isVel = isVelocityCourier(effectiveCourier, trackingUrl, waybillNumber);
      const effectiveUrl =
        trackingUrl ||
        (isVel
          ? `https://www.velocityshipping.in/track/${waybillNumber}`
          : effectiveCourier.toLowerCase().includes('delhivery')
          ? `https://www.delhivery.com/track/package/${waybillNumber}`
          : effectiveCourier.toLowerCase().includes('ekart')
          ? `https://t.proship.in/${waybillNumber}`
          : undefined);

      if (openFo) {
        const payload: any = {
          fulfillment: {
            message: `Dispatched via ${effectiveCourier}`,
            notify_customer: true,
            tracking_info: {
              number: waybillNumber,
              company: effectiveCourier,
              ...(effectiveUrl ? { url: effectiveUrl } : {}),
            },
            line_items_by_fulfillment_order: [
              {
                fulfillment_order_id: openFo.id,
              },
            ],
          },
        };

        const fResponse = await this.client.post('/fulfillments.json', payload);
        fulfillmentId = fResponse.data?.fulfillment?.id?.toString();
        logger.info('Created fulfillment on Shopify', {
          shopifyOrderId,
          waybillNumber,
          courier: effectiveCourier,
          fulfillmentId,
        });
      } else {
        // No open fulfillment order. Check if fulfillments already exist on this order
        // (e.g. fulfilled via external OMS or Shopify Admin) and update their tracking.
        try {
          const fListResponse = await this.client.get(`/orders/${shopifyOrderId}/fulfillments.json`);
          const existingFulfillments = fListResponse.data?.fulfillments || [];
          const activeFulfillment = existingFulfillments.find((f: any) => f.status !== 'cancelled');
          if (activeFulfillment) {
            fulfillmentId = activeFulfillment.id?.toString();
            await this.updateFulfillmentTracking(
              fulfillmentId!,
              {
                number: waybillNumber,
                company: effectiveCourier,
                url: effectiveUrl,
              },
              true
            );
            logger.info('Updated tracking on existing Shopify fulfillment', {
              shopifyOrderId,
              fulfillmentId,
              waybillNumber,
              courier: effectiveCourier,
            });
          }
        } catch (findErr: any) {
          logger.warn('Could not inspect existing fulfillments for tracking update', {
            shopifyOrderId,
            error: findErr.message,
          });
        }
      }

      // 2. Append AWB tags to the Shopify order via atomic addOrderTags
      await this.addOrderTags(shopifyOrderId, [
        'Dispatched',
        `${effectiveCourier}-AWB:${waybillNumber}`,
      ]);

      // 3. Write Order Metafields for native visibility in Shopify Admin & Liquid templates
      this.setOrderMetafields(shopifyOrderId, [
        { key: 'waybill_number', value: waybillNumber },
        { key: 'courier_name', value: effectiveCourier },
        ...(effectiveUrl ? [{ key: 'tracking_url', value: effectiveUrl }] : []),
      ]).catch((mfErr) => {
        logger.debug('Metafield update completed non-fatally', {
          shopifyOrderId,
          error: mfErr.message,
        });
      });

      return { success: true, fulfillmentId };
    } catch (error: any) {
      logger.error('Failed to create or update fulfillment on Shopify', {
        shopifyOrderId,
        waybillNumber,
        courier,
        error: error.response?.data || error.message,
      });
      return { success: false };
    }
  }

  /**
   * Atomically add tags to a Shopify Order using GraphQL tagsAdd.
   * Falls back to REST PUT if GraphQL encounters an issue.
   */
  async addOrderTags(
    shopifyOrderId: string,
    tagsToAdd: string[]
  ): Promise<{ success: boolean; tags: string[] }> {
    const cleanTags = Array.from(new Set(tagsToAdd.map((t) => t.trim()).filter(Boolean)));
    if (!cleanTags.length) return { success: true, tags: [] };

    const gid = shopifyOrderId.startsWith('gid://')
      ? shopifyOrderId
      : `gid://shopify/Order/${shopifyOrderId}`;

    try {
      const mutation = `mutation tagsAdd($id: ID!, $tags: [String!]!) {
        tagsAdd(id: $id, tags: $tags) {
          node { id }
          userErrors { field message }
        }
      }`;

      const res = await this.graphql<{
        tagsAdd: {
          node: any;
          userErrors: any[];
        };
      }>(mutation, { id: gid, tags: cleanTags });

      if (res?.tagsAdd?.userErrors && res.tagsAdd.userErrors.length > 0) {
        logger.warn('Shopify tagsAdd userErrors', {
          shopifyOrderId,
          errors: res.tagsAdd.userErrors,
        });
      } else {
        logger.info('Added tags to Shopify order via GraphQL', {
          shopifyOrderId,
          tags: cleanTags,
        });
        return { success: true, tags: cleanTags };
      }
    } catch (gqlErr: any) {
      logger.warn('GraphQL tagsAdd failed, falling back to REST', {
        shopifyOrderId,
        error: gqlErr.message,
      });
    }

    // Fallback to REST update
    try {
      const orderData = await this.fetchOrder(shopifyOrderId);
      const existingTags = orderData.tags
        ? orderData.tags.split(',').map((t: string) => t.trim()).filter(Boolean)
        : [];
      const merged = Array.from(new Set([...existingTags, ...cleanTags]));
      await this.client.put(`/orders/${shopifyOrderId}.json`, {
        order: { id: shopifyOrderId, tags: merged.join(', ') },
      });
      return { success: true, tags: merged };
    } catch (restErr: any) {
      logger.error('Failed to add tags to Shopify order via REST fallback', {
        shopifyOrderId,
        error: restErr.response?.data || restErr.message,
      });
      return { success: false, tags: [] };
    }
  }

  /**
   * Update tags on a Shopify order.
   */
  async updateOrderTags(
    shopifyOrderId: string,
    tags: string[]
  ): Promise<{ success: boolean; tags: string[] }> {
    return this.addOrderTags(shopifyOrderId, tags);
  }

  /**
   * Cancel an active fulfillment on Shopify.
   * Restores the order to unfulfilled state.
   */
  async cancelFulfillment(
    fulfillmentId: string
  ): Promise<{ success: boolean; status?: string }> {
    try {
      const response = await this.client.post(`/fulfillments/${fulfillmentId}/cancel.json`);
      const status = response.data?.fulfillment?.status || 'cancelled';
      logger.info('Fulfillment cancelled on Shopify', { fulfillmentId, status });
      return { success: true, status };
    } catch (error: any) {
      logger.error('Failed to cancel fulfillment on Shopify', {
        fulfillmentId,
        error: error.response?.data || error.message,
      });
      return { success: false };
    }
  }

  /**
   * Atomically remove tags from a Shopify order using GraphQL tagsRemove.
   * Falls back to REST PUT if GraphQL encounters an issue.
   */
  async removeOrderTags(
    shopifyOrderId: string,
    tagsToRemove: string[]
  ): Promise<{ success: boolean; tags: string[] }> {
    const cleanRemove = Array.from(new Set(tagsToRemove.map((t) => t.trim()).filter(Boolean)));
    if (!cleanRemove.length) return { success: true, tags: [] };

    const gid = shopifyOrderId.startsWith('gid://')
      ? shopifyOrderId
      : `gid://shopify/Order/${shopifyOrderId}`;

    try {
      const mutation = `mutation tagsRemove($id: ID!, $tags: [String!]!) {
        tagsRemove(id: $id, tags: $tags) {
          node { id }
          userErrors { field message }
        }
      }`;

      const res = await this.graphql<{
        tagsRemove: {
          node: any;
          userErrors: any[];
        };
      }>(mutation, { id: gid, tags: cleanRemove });

      if (res?.tagsRemove?.userErrors && res.tagsRemove.userErrors.length > 0) {
        logger.warn('Shopify tagsRemove userErrors', {
          shopifyOrderId,
          errors: res.tagsRemove.userErrors,
        });
      } else {
        logger.info('Removed tags from Shopify order via GraphQL', {
          shopifyOrderId,
          tags: cleanRemove,
        });
        return { success: true, tags: cleanRemove };
      }
    } catch (gqlErr: any) {
      logger.warn('GraphQL tagsRemove failed, falling back to REST', {
        shopifyOrderId,
        error: gqlErr.message,
      });
    }

    // Fallback to REST
    try {
      const orderData = await this.fetchOrder(shopifyOrderId);
      const existingTags = orderData.tags
        ? orderData.tags.split(',').map((t: string) => t.trim()).filter(Boolean)
        : [];
      const lowerRemove = new Set(cleanRemove.map((t) => t.toLowerCase()));
      const updatedTags = existingTags.filter((t) => !lowerRemove.has(t.toLowerCase()));

      await this.client.put(`/orders/${shopifyOrderId}.json`, {
        order: {
          id: shopifyOrderId,
          tags: updatedTags.join(', '),
        },
      });
      return { success: true, tags: updatedTags };
    } catch (error: any) {
      logger.error('Failed to remove tags from Shopify order', {
        shopifyOrderId,
        tagsToRemove,
        error: error.response?.data || error.message,
      });
      return { success: false, tags: [] };
    }
  }

  /**
   * Cancel an order on Shopify.
   */
  async cancelOrder(
    shopifyOrderId: string,
    reason: string = 'customer'
  ): Promise<{ success: boolean; cancelledAt?: string }> {
    try {
      const response = await this.client.post(`/orders/${shopifyOrderId}/cancel.json`, {
        reason,
        email: false,
        restock: true,
      });
      logger.info('Cancelled order on Shopify', {
        shopifyOrderId,
        cancelledAt: response.data?.order?.cancelled_at,
      });
      return { success: true, cancelledAt: response.data?.order?.cancelled_at };
    } catch (error: any) {
      logger.error('Failed to cancel order on Shopify', {
        shopifyOrderId,
        error: error.response?.data || error.message,
      });
      throw error;
    }
  }

  /**
   * Fetch variant images in batch via GraphQL nodes query.
   * Returns a map of variant numeric ID -> image URL.
   */
  async fetchVariantImages(variantIds: string[]): Promise<Map<string, string>> {
    const imageMap = new Map<string, string>();
    if (!variantIds.length) return imageMap;

    const uniqueIds = Array.from(new Set(variantIds.filter(Boolean)));
    const gids = uniqueIds.map((id) =>
      id.startsWith('gid://') ? id : `gid://shopify/ProductVariant/${id}`
    );

    const chunkSize = 50;
    for (let i = 0; i < gids.length; i += chunkSize) {
      const chunk = gids.slice(i, i + chunkSize);
      try {
        const query = `{
          nodes(ids: ${JSON.stringify(chunk)}) {
            ... on ProductVariant {
              id
              image { url }
              product { featuredImage { url } }
            }
          }
        }`;

        const response = await this.client.post('/graphql.json', { query });
        const nodes = response.data?.data?.nodes || [];
        for (const node of nodes) {
          if (!node) continue;
          const rawId = node.id.replace('gid://shopify/ProductVariant/', '');
          const imgUrl = node.image?.url || node.product?.featuredImage?.url || null;
          if (imgUrl) {
            imageMap.set(rawId, imgUrl);
          }
        }
      } catch (err: any) {
        logger.warn('Failed to fetch batch variant images from Shopify', {
          error: err.message,
        });
      }
    }

    return imageMap;
  }

  /**
   * Backfill missing images for existing OrderItems in the database.
   */
  async backfillItemImages(): Promise<number> {
    const items = await prisma.orderItem.findMany({
      where: {
        imageUrl: null,
        shopifyVariantId: { not: null },
      },
    });

    if (!items.length) return 0;

    const variantIds = items.map((i) => i.shopifyVariantId!).filter(Boolean);
    const imageMap = await this.fetchVariantImages(variantIds);

    let updated = 0;
    for (const item of items) {
      const imgUrl = item.shopifyVariantId ? imageMap.get(item.shopifyVariantId) : null;
      if (imgUrl) {
        await prisma.orderItem.update({
          where: { id: item.id },
          data: { imageUrl: imgUrl },
        });
        updated++;
      }
    }

    logger.info(`Backfilled ${updated} order item images from Shopify`);
    return updated;
  }

  private getNextPageUrl(linkHeader?: string): string | null {
    if (!linkHeader) {
      return null;
    }

    const nextLink = linkHeader
      .split(',')
      .map((link) => link.trim())
      .find((link) => link.includes('rel="next"'));
    const urlMatch = nextLink?.match(/<([^>]+)>/);
    return urlMatch?.[1] || null;
  }

  /**
   * Work out which sales channel an order came through, e.g. the online store,
   * a headless checkout app such as GoKwik, or POS.
   *
   * Shopify reports `source_name` as either a known literal ("web", "pos") or
   * the numeric id of the app that created the order. App ids only carry a name
   * in GraphQL, so unknown ids are resolved once and cached. A failed lookup is
   * not fatal: the raw source is still stored.
   */
  async resolveSalesChannel(
    order: ShopifyOrderWebhook
  ): Promise<{ sourceName: string | null; salesChannel: string | null }> {
    const sourceName = (order as any).source_name || null;
    if (!sourceName) {
      return { sourceName: null, salesChannel: null };
    }

    const known = KNOWN_ORDER_SOURCES[sourceName];
    if (known) {
      return { sourceName, salesChannel: known };
    }

    const cached = this.salesChannelCache.get(sourceName);
    if (cached) {
      return { sourceName, salesChannel: cached };
    }

    try {
      const response = await this.client.post('/graphql.json', {
        query: `{ order(id: "gid://shopify/Order/${order.id}") { app { name } } }`,
      });
      const appName: string | undefined = response.data?.data?.order?.app?.name;
      if (appName) {
        this.salesChannelCache.set(sourceName, appName);
        logger.info('Resolved Shopify sales channel', { sourceName, salesChannel: appName });
        return { sourceName, salesChannel: appName };
      }
    } catch (error: any) {
      logger.warn('Could not resolve Shopify sales channel name', {
        sourceName,
        error: error.message,
      });
    }

    return { sourceName, salesChannel: null };
  }

  /**
   * Determine exact internal OrderStatus from Shopify webhook payload.
   */
  calculateOrderStatus(order: ShopifyOrderWebhook): OrderStatus {
    const fulfillments = ((order as any).fulfillments || []).filter((f: any) => f.status !== 'cancelled');
    const withShipmentStatus = (wanted: string[]) =>
      fulfillments.find((f: any) => wanted.includes((f.shipment_status || '').toLowerCase()));

    // A real carrier scan wins over a later Shopify cancel/refund flag.
    if (withShipmentStatus(['delivered'])) return 'DELIVERED';
    if (withShipmentStatus(['rto_delivered'])) return 'RTO_DELIVERED';
    if (withShipmentStatus(['rto', 'return_to_origin'])) return 'RTO_INITIATED';
    if (withShipmentStatus(['failure', 'attempted_delivery'])) return 'FAILED_DELIVERY';
    if (withShipmentStatus(['out_for_delivery'])) return 'OUT_FOR_DELIVERY';
    if (withShipmentStatus(['in_transit'])) return 'IN_TRANSIT';

    const paymentMethod = this.detectPaymentMethod(order);
    const tagInput = {
      tags: order.tags,
      paymentMethod,
      financialStatus: order.financial_status,
    };
    const labelOnly =
      order.fulfillment_status === 'fulfilled' ||
      order.fulfillment_status === 'partial' ||
      fulfillments.some(
        (f: any) => f.status === 'success' || f.tracking_number || (f.tracking_numbers && f.tracking_numbers.length)
      );
    const cancelledBeforePickup =
      Boolean((order as any).cancelled_at) ||
      isHighRtoCancel(tagInput) ||
      ['voided', 'refunded'].includes((order.financial_status || '').toLowerCase());

    // Cancelled before the courier picked the parcel, including a label that
    // was generated and then voided (COD_CANCELLED / High RTO).
    if (cancelledBeforePickup) return 'CANCELLED';

    // Label / fulfillment exists but Delhivery has not reported a pickup scan.
    if (labelOnly) return 'DISPATCHED';

    if (paymentMethod === 'Pre-paid' || isCodConfirmed(tagInput)) {
      return 'DISPATCH_PENDING';
    }

    return 'NEW';
  }

  /**
   * Sync (or upsert) a Shopify order into our database.
   */
  async syncOrderToDb(order: ShopifyOrderWebhook): Promise<void> {
    // Strict historical cutoff (mission invariant): never create or modify
    // orders, items, or shipments for orders placed before the sync start date.
    // Guards every caller — REST polling and orders/* + fulfillments/* webhooks.
    if (new Date(order.created_at) < config.shopify.syncStartDate) {
      logger.info('Skipping historical order — created before the sync cutoff', {
        orderName: order.name,
        createdAt: order.created_at,
        syncStartDate: config.shopify.syncStartDate.toISOString(),
      });
      return;
    }

    const customer = order.customer;
    const address = order.shipping_address || customer?.default_address;

    const phone = this.normalizePhone(
      order.phone || address?.phone || customer?.phone || ''
    );
    // The consignee is whoever the parcel is addressed to, which is not always
    // the account holder (gift orders). Delhivery prints this on the label.
    const customerName =
      (address?.name || `${address?.first_name || ''} ${address?.last_name || ''}`).trim() ||
      `${customer?.first_name || ''} ${customer?.last_name || ''}`.trim() ||
      'Customer';
    // address2 carries the flat / house number and landmark. Dropping it is a
    // common cause of "address incomplete" NDRs.
    const customerAddress =
      [address?.address1, address?.address2]
        .map((part) => (part || '').trim())
        .filter(Boolean)
        .join(', ') || 'N/A';

    const { sourceName, salesChannel } = await this.resolveSalesChannel(order);
    const paymentMethod = this.detectPaymentMethod(order);
    const paymentGateway =
      (order as any).payment_gateway_names?.[0] ||
      ((order as any).payment_gateway_names || []).join(', ') ||
      null;
    let status = this.calculateOrderStatus(order);

    // ─── Extract Payment Partner (Easebuzz), Aggregator (GoKwik), and IDs ───
    const noteAttributes = (order as any).note_attributes || [];
    const findAttr = (patterns: string[]): string | null => {
      for (const p of patterns) {
        const found = noteAttributes.find((a: any) =>
          a.name && a.name.toLowerCase().replace(/[-_\s]/g, '') === p.toLowerCase().replace(/[-_\s]/g, '')
        );
        if (found && found.value) return String(found.value).trim();
      }
      return null;
    };

    let paymentProvider = findAttr(['Payment_Provider_Name', 'payment_provider', 'payment_provider_name', 'provider_name', 'provider']);
    let paymentProviderPaymentId = findAttr(['Payment_Provider_Payment_ID', 'payment_provider_payment_id', 'provider_payment_id', 'easebuzz_payment_id']);
    let gokwikPaymentId = findAttr(['GoKwik_Payment_ID', 'gokwik_payment_id', 'gk_payment_id']);
    let paymentReference = findAttr(['Payment_Reference_ID', 'payment_reference_id', 'payment_reference', 'utr', 'bank_reference']);
    let paymentAuthorizationKey: string | null = null;
    let gatewayTransactionId: string | null = (order as any).gatewayTransactionId || null;

    const rawGateway = (paymentGateway || '').toLowerCase();
    const isGoKwik =
      rawGateway.includes('kwik') ||
      (salesChannel || '').toLowerCase().includes('gokwik') ||
      (order.tags || '').toLowerCase().includes('gokwik') ||
      !!gokwikPaymentId ||
      !!findAttr(['gk_order_confirmation_url', 'gokwik_cid']);

    const paymentAggregator = isGoKwik ? 'GoKwik' : rawGateway.includes('phonepe') ? 'PhonePe' : (paymentGateway || null);

    // Fetch transactions from Shopify to capture exact gateway receipt fields (Easebuzz ID, UTR, auth key)
    if (paymentMethod === 'Pre-paid' || order.financial_status === 'paid' || isGoKwik) {
      try {
        const txRes = await this.client.get(`/orders/${order.id}/transactions.json`);
        const transactions = txRes.data.transactions || [];
        const captureTx =
          transactions.find((t: any) => t.status === 'success' && ['capture', 'sale'].includes(t.kind)) ||
          transactions.find((t: any) => t.status === 'success') ||
          transactions[0];

        if (captureTx) {
          if (captureTx.authorization && !paymentAuthorizationKey) {
            paymentAuthorizationKey = captureTx.authorization;
          }
          if (captureTx.payment_id && !gatewayTransactionId) {
            gatewayTransactionId = captureTx.payment_id;
          }
          const receipt = captureTx.receipt || {};
          if (typeof receipt === 'object') {
            if (!paymentProvider && receipt.payment_provider) paymentProvider = receipt.payment_provider;
            if (!paymentProviderPaymentId && receipt.payment_id) paymentProviderPaymentId = receipt.payment_id;
            if (!gokwikPaymentId && receipt.gokwik_payment_id) gokwikPaymentId = receipt.gokwik_payment_id;
            if (!paymentReference && receipt.payment_reference_id) paymentReference = receipt.payment_reference_id;
          }
        }
      } catch (err: any) {
        logger.debug('Failed to fetch transactions for order in syncOrderToDb', { orderId: order.id, error: err.message });
      }
    }

    if (paymentProvider) {
      if (paymentProvider.toLowerCase() === 'easebuzz') paymentProvider = 'Easebuzz';
      else if (paymentProvider.toLowerCase() === 'phonepe') paymentProvider = 'PhonePe';
      else if (paymentProvider.toLowerCase() === 'razorpay') paymentProvider = 'Razorpay';
      else paymentProvider = paymentProvider.charAt(0).toUpperCase() + paymentProvider.slice(1);
    } else if (isGoKwik && paymentMethod === 'Pre-paid') {
      paymentProvider = 'Easebuzz';
    }

    let paymentVerified = false;
    let paymentVerifiedAt: Date | null = null;
    let paymentVerificationSource: string | null = null;

    if (paymentMethod === 'Pre-paid') {
      if (order.financial_status === 'paid' || paymentProviderPaymentId || gokwikPaymentId || paymentAuthorizationKey) {
        paymentVerified = true;
        paymentVerifiedAt = new Date(order.created_at);
        paymentVerificationSource = paymentProvider
          ? `shopify_${paymentAggregator?.toLowerCase() || 'gateway'}_${paymentProvider.toLowerCase()}`
          : 'shopify_capture';
      }
    }

    // ─── Extract Deliver Count, RTO Risk & Dispatch SLA ───
    const deliverOrderCountStr = findAttr(['deliver_order_count', 'delivery_order_count', 'gk_deliver_order_count']);
    const deliverOrderCount = deliverOrderCountStr ? parseInt(deliverOrderCountStr, 10) : null;

    const tagInput = { tags: order.tags, paymentMethod, financialStatus: order.financial_status };
    const isCodBlocked = isHighRtoCancel(tagInput);
    const codConfirmed = isCodConfirmed(tagInput);

    let rtoRiskLevel = 'LOW';
    let rtoRiskReason = 'Prepaid order (Zero RTO risk)';

    if (paymentMethod === 'COD') {
      if (isCodBlocked) {
        rtoRiskLevel = 'HIGH';
        rtoRiskReason = 'GoKwik flagged COD blocked / customer cancelled';
      } else if (codConfirmed) {
        rtoRiskLevel = 'LOW';
        rtoRiskReason = 'Customer verified intent via WhatsApp / GoKwik confirmation';
      } else if (deliverOrderCount && deliverOrderCount >= 2) {
        rtoRiskLevel = 'LOW';
        rtoRiskReason = `Repeat trustworthy buyer (${deliverOrderCount} prior deliveries on GoKwik network)`;
      } else {
        rtoRiskLevel = 'MEDIUM';
        rtoRiskReason = 'Unconfirmed COD (verification pending)';
      }
    }

    const orderCreatedAt = new Date(order.created_at);
    const expectedDispatchAt = new Date(orderCreatedAt.getTime() + 24 * 3600 * 1000);
    const activeFulfillments = ((order as any).fulfillments || []).filter((f: any) => f.status !== 'cancelled');
    const hasActiveWaybill = activeFulfillments.some(
      (f: any) => f.tracking_number || (f.tracking_numbers && f.tracking_numbers.length > 0)
    );
    const approvedForDispatch = isApprovedForDispatch(tagInput);
    const dispatchDelayed =
      approvedForDispatch && !hasActiveWaybill && Date.now() > expectedDispatchAt.getTime();

    // dispatchedAt audit timestamp: initialize when the order carries an active
    // fulfillment or an assigned waybill, and never overwrite a timestamp that a
    // prior dispatch already recorded (read the stored value and preserve it).
    // Live Delhivery tracking, once polled, owns the lifecycle so a Shopify
    // fulfillment webhook cannot push a not-picked parcel back to In Transit.
    const existingDispatch = await prisma.order.findUnique({
      where: { shopifyOrderId: order.id.toString() },
      select: {
        dispatchedAt: true,
        status: true,
        shopifyUpdatedAt: true,
        shipment: {
          select: {
            status: true,
            trackingStatus: true,
            trackingUpdatedAt: true,
            waybillNumber: true,
            courier: true,
          },
        },
      },
    });
    // Webhooks and the hourly poll can deliver an older copy of an order after
    // a newer one was stored (a 10:04 poll result landing after a 10:05
    // cancel). The older copy must never overwrite the newer state.
    const storedUpdatedAt = (existingDispatch as any)?.shopifyUpdatedAt as Date | null | undefined;
    if (storedUpdatedAt && order.updated_at && new Date(order.updated_at) < new Date(storedUpdatedAt)) {
      logger.info('Skipping stale Shopify payload, a newer copy of this order is stored', {
        orderName: order.name,
        payloadUpdatedAt: order.updated_at,
        storedUpdatedAt,
      });
      return;
    }

    if (existingDispatch?.shipment?.trackingUpdatedAt) {
      const liveStatus = orderStatusFromLiveTracking(existingDispatch.shipment);
      const preShipCancel =
        status === 'CANCELLED' && (liveStatus === 'DISPATCHED' || liveStatus === 'DISPATCH_PENDING');
      if (liveStatus && !preShipCancel) {
        status = liveStatus as OrderStatus;
      }
    }

    // Returns and refunds are run by the OMS, not Shopify. A refund's own
    // orders/updated webhook would otherwise flip REFUNDED back to DELIVERED.
    const storedStatus = (existingDispatch as any)?.status as string | undefined;
    if (storedStatus && OMS_OWNED_ORDER_STATUSES.has(storedStatus)) {
      status = storedStatus as OrderStatus;
    }
    const primaryActiveFulfillment = activeFulfillments[activeFulfillments.length - 1] || null;
    const fulfillmentDispatchedAt = primaryActiveFulfillment?.created_at
      ? new Date(primaryActiveFulfillment.created_at)
      : null;
    let dispatchedAt: Date | null = existingDispatch?.dispatchedAt ?? null;
    if (!dispatchedAt && (activeFulfillments.length > 0 || hasActiveWaybill)) {
      dispatchedAt = fulfillmentDispatchedAt || new Date();
    }

    try {
      const dbOrder = await prisma.order.upsert({
        where: { shopifyOrderId: order.id.toString() },
        create: {
          shopifyOrderId: order.id.toString(),
          shopifyOrderName: order.name,
          shopifyOrderNumber: order.number,
          customerName,
          customerPhone: phone || '0000000000',
          customerEmail: order.email || customer?.email || null,
          customerAddress,
          customerCity: address?.city || 'N/A',
          customerState: address?.province || 'N/A',
          customerPincode: address?.zip || 'N/A',
          customerCountry: address?.country || 'India',
          totalAmount: parseFloat(order.total_price) || 0,
          ...extractOrderFinancials(order),
          currency: order.currency || 'INR',
          paymentMethod,
          paymentGateway,
          paymentAggregator,
          paymentProvider,
          paymentProviderPaymentId,
          gokwikPaymentId,
          gatewayTransactionId,
          paymentAuthorizationKey,
          paymentReference,
          paymentVerified,
          paymentVerifiedAt,
          paymentVerificationSource,
          deliverOrderCount,
          rtoRiskLevel,
          rtoRiskReason,
          expectedDispatchAt,
          dispatchDelayed,
          financialStatus: order.financial_status || null,
          fulfillmentStatus: order.fulfillment_status || null,
          tags: order.tags || null,
          sourceName,
          salesChannel,
          status,
          shopifyCreatedAt: new Date(order.created_at),
          shopifyUpdatedAt: order.updated_at ? new Date(order.updated_at) : null,
          dispatchedAt,
          items: {
            create: await (async () => {
              const variantIds = order.line_items
                .map((i) => i.variant_id?.toString() || '')
                .filter(Boolean);
              const imageMap = await this.fetchVariantImages(variantIds);
              return order.line_items.map((item) => {
                const vId = item.variant_id?.toString() || null;
                return {
                  shopifyVariantId: vId,
                  sku: item.sku || null,
                  title: item.title,
                  variantTitle: item.variant_title || null,
                  imageUrl: vId ? imageMap.get(vId) || null : null,
                  quantity: item.quantity,
                  price: parseFloat(item.price) || 0,
                };
              });
            })(),
          },
        },
        update: {
          shopifyOrderName: order.name,
          customerName,
          customerPhone: phone || '0000000000',
          customerEmail: order.email || customer?.email || null,
          customerAddress,
          customerCity: address?.city || 'N/A',
          customerState: address?.province || 'N/A',
          customerPincode: address?.zip || 'N/A',
          totalAmount: parseFloat(order.total_price) || 0,
          ...extractOrderFinancials(order),
          paymentMethod,
          paymentGateway,
          paymentAggregator,
          paymentProvider,
          paymentProviderPaymentId,
          gokwikPaymentId,
          gatewayTransactionId,
          paymentAuthorizationKey,
          paymentReference,
          paymentVerified,
          paymentVerifiedAt,
          paymentVerificationSource,
          deliverOrderCount,
          rtoRiskLevel,
          rtoRiskReason,
          expectedDispatchAt,
          dispatchDelayed,
          financialStatus: order.financial_status || null,
          fulfillmentStatus: order.fulfillment_status || null,
          tags: order.tags || null,
          sourceName,
          salesChannel,
          status,
          shopifyUpdatedAt: order.updated_at ? new Date(order.updated_at) : null,
          dispatchedAt,
        },
        include: { shipment: true },
      });

      // ─── Sync / Update Line Items ───
      if (order.line_items && order.line_items.length > 0) {
        const variantIds = order.line_items
          .map((i) => i.variant_id?.toString() || '')
          .filter(Boolean);
        const imageMap = await this.fetchVariantImages(variantIds);

        const existingItems = await prisma.orderItem.findMany({
          where: { orderId: dbOrder.id },
        });

        // Every size of a product shares one title, so a row is matched on the
        // variant id. Title is only used for rows stored without a variant id,
        // and no row is matched twice (Kurta-S and Kurta-M stay two rows).
        const matchedRowIds = new Set<number>();
        for (const item of order.line_items) {
          const vId = item.variant_id?.toString() || null;
          const imgUrl = vId ? imageMap.get(vId) || null : null;
          const unmatched = existingItems.filter((i) => !matchedRowIds.has(i.id));
          const existingItem =
            (vId ? unmatched.find((i) => i.shopifyVariantId === vId) : undefined) ||
            unmatched.find(
              (i) =>
                i.title === item.title &&
                (!vId || !i.shopifyVariantId) &&
                (!item.variant_title || !i.variantTitle || i.variantTitle === item.variant_title)
            );
          if (existingItem) matchedRowIds.add(existingItem.id);

          if (existingItem) {
            await prisma.orderItem.update({
              where: { id: existingItem.id },
              data: {
                shopifyVariantId: vId || existingItem.shopifyVariantId || null,
                sku: item.sku || existingItem.sku || null,
                title: item.title,
                variantTitle: item.variant_title || existingItem.variantTitle || null,
                quantity: item.quantity,
                price: parseFloat(item.price) || existingItem.price,
                imageUrl: imgUrl || existingItem.imageUrl || null,
              },
            });
          } else {
            await prisma.orderItem.create({
              data: {
                orderId: dbOrder.id,
                shopifyVariantId: vId,
                sku: item.sku || null,
                title: item.title,
                variantTitle: item.variant_title || null,
                imageUrl: imgUrl,
                quantity: item.quantity,
                price: parseFloat(item.price) || 0,
              },
            });
          }
        }
      }

      // ─── Sync Shopify Fulfillments & Carrier Tracking ───
      const fulfillments = (order as any).fulfillments || [];
      const activeFulfillments = fulfillments.filter((f: any) => f.status !== 'cancelled');

      if (activeFulfillments.length > 0) {
        const primaryFulfillment = activeFulfillments[activeFulfillments.length - 1];
        const waybillNumber =
          primaryFulfillment.tracking_number ||
          (primaryFulfillment.tracking_numbers && primaryFulfillment.tracking_numbers[0]) ||
          null;
        const courier = primaryFulfillment.tracking_company || 'Other';
        const trackingUrl =
          primaryFulfillment.tracking_url ||
          (primaryFulfillment.tracking_urls && primaryFulfillment.tracking_urls[0]) ||
          null;

        const shipmentStatus = mapShopifyShipmentStatus(primaryFulfillment.shipment_status);
        const shipmentTrackingLabel = trackingLabelFromShopify(primaryFulfillment.shipment_status);

        if (waybillNumber) {
          // Delhivery is fulfilled under several carrier labels ("Delhivery",
          // "Delhivery Express", "Delhivery Surface", "Delhivery B2C"). Detect any
          // variant case-insensitively (/delhivery/i) so it stays on the Delhivery
          // tracking/label/audit path; anything else is a third-party courier.
          const isNonDelhivery = !isDelhiveryCourier(courier, trackingUrl, waybillNumber);
          const effectiveCourier = normalizeCourierName(courier, trackingUrl, waybillNumber);

          // On a third-party AWB the Delhivery weight/billing audit values are
          // meaningless, so hold them at safe defaults — otherwise Delhivery
          // reconciliation raises false discrepancies against a courier it doesn't own.
          const delhiveryAuditReset = {
            weightMismatch: false,
            mismatchDetails: null,
            declaredWeightGrams: null,
            billedWeightGrams: null,
            chargedZone: null,
            initialCost: 0,
            reversalAmount: 0,
            revisedCost: 0,
            hasReversal: false,
            reversalReason: null,
            totalDebited: 0,
            totalCredited: 0,
            netBilledCost: 0,
            billingStatus: null,
            lastBilledAt: null,
          };

          const existingShipment = await prisma.shipment.findFirst({
            where: { orderId: dbOrder.id },
          });
          // A Delhivery poll already recorded the real scan. Do not let a
          // Shopify fulfillment payload replace Manifested / Not Picked with
          // a synthetic in-transit status.
          const preserveLiveTracking = Boolean(existingShipment?.trackingUpdatedAt);

          if (existingShipment) {
            await prisma.shipment.update({
              where: { id: existingShipment.id },
              data: {
                waybillNumber,
                courier: effectiveCourier,
                ...(preserveLiveTracking
                  ? {}
                  : {
                      status: shipmentStatus as any,
                      trackingStatus: shipmentTrackingLabel,
                    }),
                labelUrl: isNonDelhivery ? trackingUrl : (existingShipment.labelUrl || trackingUrl),
                // If courier is not Delhivery, clear any false Delhivery audit discrepancy fields
                ...(isNonDelhivery
                  ? {
                      ...delhiveryAuditReset,
                      codRemitted: false,
                      codRemittedAt: null,
                      codCollected: false,
                      codCollectedAt: null,
                      codRemittanceRef: null,
                    }
                  : {}),
              },
            });

            if (isNonDelhivery) {
              await prisma.order.update({
                where: { id: dbOrder.id },
                data: {
                  weightDiscrepancy: false,
                  weightDiscrepancyNote: null,
                  actualShippingCost: 0,
                  shippingAudited: false,
                  ...(dbOrder.paymentVerificationSource === 'delhivery_cod_remittance'
                    ? {
                        paymentVerified: false,
                        paymentVerifiedAt: null,
                        paymentVerificationSource: null,
                        paymentReference: null,
                      }
                    : {}),
                },
              });
            }
          } else {
            await prisma.shipment.create({
              data: {
                orderId: dbOrder.id,
                waybillNumber,
                courier: effectiveCourier,
                paymentMode: paymentMethod === 'COD' ? 'COD' : 'Pre-paid',
                codAmount: paymentMethod === 'COD' ? parseFloat(order.total_price) || 0 : 0,
                status: shipmentStatus as any,
                trackingStatus: shipmentTrackingLabel,
                labelUrl: trackingUrl,
                ...(isNonDelhivery ? delhiveryAuditReset : {}),
              },
            });
          }

          // If this fulfillment is carried by Delhivery, immediately trigger live tracking
          // from the Delhivery API in the background so tracking scans, ETA, and hub locations
          // are immediately populated rather than waiting for the 30-min polling cron.
          if (!isNonDelhivery && waybillNumber) {
            import('../tracking/tracking.service')
              .then(({ default: trackingService }) => trackingService.syncShipmentTracking(waybillNumber))
              .catch((trackErr) => {
                logger.warn('Immediate Delhivery tracking sync failed after external fulfillment ingest', {
                  waybill: waybillNumber,
                  error: trackErr?.message,
                });
              });
          }
        }
      }

      logger.info('Order synced to DB', {
        shopifyOrderId: order.id,
        orderName: order.name,
        status,
        phone,
      });
    } catch (error: any) {
      logger.error('Failed to sync order to DB', {
        shopifyOrderId: order.id,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Normalize phone to E.164 format (strip leading 0, ensure country code).
   */
  private normalizePhone(phone: string): string {
    let cleaned = phone.replace(/[^0-9]/g, '');
    if (cleaned.startsWith('91') && cleaned.length === 12) {
      return cleaned;
    }
    if (cleaned.startsWith('0') && cleaned.length === 11) {
      return '91' + cleaned.substring(1);
    }
    if (cleaned.length === 10) {
      return '91' + cleaned;
    }
    return cleaned;
  }

  /**
   * Detect payment method from order data.
   */
  private detectPaymentMethod(order: ShopifyOrderWebhook): string {
    const tags = (order.tags || '').toLowerCase();
    const isPrepaidTag = tags.includes('prepaid') || tags.includes('upi') || tags.includes('phonepe') || tags.includes('gokwik');
    const isCodTag = tags.includes('cod') && !tags.includes('prepaid');

    const gateways = ((order as any).payment_gateway_names || []).map((g: string) => g.toLowerCase());
    const isCodGateway = gateways.some((g: string) => g.includes('cod') || g.includes('cash'));

    if (isCodGateway || isCodTag) {
      return 'COD';
    }
    if (isPrepaidTag || order.financial_status === 'paid') {
      return 'Pre-paid';
    }
    if (order.financial_status === 'pending') {
      return 'COD';
    }
    return 'COD'; // default for Indian market
  }
}

export default new ShopifyService();
