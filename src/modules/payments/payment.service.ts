import axios from 'axios';
import { config } from '../../config';
import prisma from '../../database/prisma';
import gokwikService from './gokwik.service';
import phonepeService from './phonepe.service';
import logger from '../../utils/logger';
import { Order } from '@prisma/client';
import { shopifyTokenProvider } from '../shopify/token.provider';

/**
 * Payment Service
 * Central service for:
 *   1. Detecting which payment gateway was used (GoKwik, PhonePe, etc.)
 *   2. Verifying payment status before dispatch
 *   3. Routing refunds through the correct gateway
 *
 * Gateway detection: reads Shopify order transactions to find the gateway field.
 * Shopify stores the payment gateway name (e.g. "gokwik", "phonepe_pg") in each transaction.
 */

interface ShopifyTransaction {
  id: number;
  gateway: string;
  kind: string; // authorization, capture, sale, refund
  status: string; // success, pending, failure
  amount: string;
  payment_id?: string;
}

/**
 * Shopify financial statuses that mean the money is gone or was never taken.
 * An order in one of these states must never be handed to the courier, no
 * matter what its transactions say, and regardless of COD vs prepaid.
 * `partially_refunded` is deliberately absent: the rest of the order can ship.
 */
const NON_DISPATCHABLE_FINANCIAL_STATUSES = ['voided', 'refunded'];

/**
 * Pure dispatch-gate check, kept separate so it can be exercised by
 * verification scripts without touching the database. Returns a
 * human-readable reason the order must not ship, or null when the order's
 * state does not block dispatch.
 */
export function blockedDispatchReason(
  financialStatus: string | null | undefined,
  orderStatus: string | null
): string | null {
  const normalized = financialStatus?.toLowerCase();
  if (normalized && NON_DISPATCHABLE_FINANCIAL_STATUSES.includes(normalized)) {
    return `Shopify financial status is "${financialStatus}"`;
  }
  if (orderStatus === 'CANCELLED') {
    return 'Order is cancelled';
  }
  return null;
}

class PaymentService {
  /**
   * Return a reason string when Shopify's own order state forbids dispatch,
   * otherwise null. Checked before any transaction logic, and before trusting a
   * previously stored paymentVerified flag, because an order can be voided or
   * refunded long after its payment was verified.
   */
  private blockedByOrderState(order: Order): string | null {
    return blockedDispatchReason(order.financialStatus, order.status);
  }

  /**
   * Fetch transactions for a Shopify order.
   * These tell us which gateway was used and whether payment was captured.
   */
  async fetchShopifyTransactions(shopifyOrderId: string): Promise<ShopifyTransaction[]> {
    try {
      const accessToken = await shopifyTokenProvider.getAccessToken();
      const baseUrl = `https://${config.shopify.shopDomain}/admin/api/${config.shopify.apiVersion}`;
      const response = await axios.get(`${baseUrl}/orders/${shopifyOrderId}/transactions.json`, {
        headers: {
          'X-Shopify-Access-Token': accessToken,
        },
        timeout: 15000,
      });
      return response.data.transactions || [];
    } catch (error: any) {
      logger.error('Failed to fetch Shopify transactions', {
        shopifyOrderId,
        error: error.message,
      });
      return [];
    }
  }

  /**
   * Detect the payment gateway from Shopify transactions.
   * Returns the gateway name normalized to our standard names.
   */
  detectGateway(transactions: ShopifyTransaction[]): {
    gateway: string;
    transactionId: string | null;
    isPrepaid: boolean;
    paymentCaptured: boolean;
  } {
    // A failed first attempt (UPI retry) or a COD fallback still ends in a
    // successful sale/capture. The first transaction is not necessarily the
    // one that settled, so prefer the successful one when it exists.
    const successTx = transactions.find(
      (t) =>
        (t.kind === 'sale' || t.kind === 'capture') &&
        (t.status === 'success' || t.status === 'captured')
    );

    // Fall back to the first sale/capture/authorization when nothing settled.
    const primaryTx =
      successTx ||
      transactions.find(
        (t) => t.kind === 'sale' || t.kind === 'capture' || t.kind === 'authorization'
      );

    if (!primaryTx) {
      // No transaction — likely COD
      return {
        gateway: 'COD',
        transactionId: null,
        isPrepaid: false,
        paymentCaptured: true, // COD doesn't need pre-payment capture
      };
    }

    const rawGateway = primaryTx.gateway.toLowerCase();
    const transactionId = primaryTx.payment_id || primaryTx.id.toString();

    // Normalize gateway names
    let gateway: string;
    if (rawGateway.includes('gokwik') || rawGateway.includes('go_kwik') || rawGateway.includes('kwik')) {
      gateway = 'gokwik';
    } else if (rawGateway.includes('phonepe') || rawGateway.includes('phone_pe') || rawGateway.includes('phonepe_pg')) {
      gateway = 'phonepe';
    } else if (rawGateway.includes('shopify_payments') || rawGateway.includes('shopify')) {
      gateway = 'shopify_payments';
    } else if (rawGateway.includes('razorpay')) {
      gateway = 'razorpay';
    } else if (rawGateway.includes('cashfree')) {
      gateway = 'cashfree';
    } else if (rawGateway.includes('payu')) {
      gateway = 'payu';
    } else {
      gateway = rawGateway;
    }

    const isPrepaid = gateway !== 'COD' && !rawGateway.includes('cash_on_delivery') && !rawGateway.includes('cod');
    const paymentCaptured =
      primaryTx.status === 'success' ||
      primaryTx.status === 'captured' ||
      (primaryTx.kind === 'sale' && primaryTx.status === 'success');

    return { gateway, transactionId, isPrepaid, paymentCaptured };
  }

  /**
   * Verify payment for an order.
   *
   * Flow:
   *   1. Fetch transactions from Shopify
   *   2. Detect gateway
   *   3. If COD → payment is verified (no pre-payment needed)
   *   4. If prepaid:
   *      a. Check Shopify transaction status (captured?)
   *      b. If direct gateway verification is enabled, double-check with gateway API
   *   5. Update the order in DB with payment info
   *   6. Return verification result
   */
  async verifyPayment(order: Order): Promise<{
    verified: boolean;
    gateway: string;
    reason?: string;
  }> {
    // Fetch Shopify transactions
    const transactions = await this.fetchShopifyTransactions(order.shopifyOrderId);
    const detected = this.detectGateway(transactions);

    // If transactions are sparse (common with headless checkouts like GoKwik), check order tags and financial status
    const tagsLower = (order.tags || '').toLowerCase();
    let finalGateway = detected.gateway;
    let isPrepaid = detected.isPrepaid;
    let paymentCaptured = detected.paymentCaptured;

    if (tagsLower.includes('gokwik')) {
      if (tagsLower.includes('upi') || tagsLower.includes('prepaid') || order.financialStatus === 'paid') {
        finalGateway = 'gokwik';
        isPrepaid = true;
        paymentCaptured = true;
      } else if (tagsLower.includes('cod')) {
        finalGateway = 'cash_on_delivery';
        isPrepaid = false;
        paymentCaptured = true;
      }
    } else if (tagsLower.includes('phonepe')) {
      finalGateway = 'phonepe';
      isPrepaid = true;
      paymentCaptured = true;
    } else if (order.financialStatus === 'paid') {
      isPrepaid = true;
      paymentCaptured = true;
      if (finalGateway === 'COD') finalGateway = 'manual';
    }

    // Update order with gateway info
    await prisma.order.update({
      where: { id: order.id },
      data: {
        paymentGateway: finalGateway,
        gatewayTransactionId: detected.transactionId,
        paymentMethod: isPrepaid ? 'Pre-paid' : 'COD',
      },
    });

    // A voided, refunded, or cancelled order is never dispatchable, so it must
    // not be marked verified even when it is COD.
    const blockedReason = this.blockedByOrderState(order);
    if (blockedReason) {
      await prisma.order.update({
        where: { id: order.id },
        data: {
          paymentVerified: false,
          paymentVerifiedAt: null,
          paymentVerificationSource: null,
        },
      });

      logger.warn('Payment not verified: order state forbids dispatch', {
        orderId: order.id,
        orderName: order.shopifyOrderName,
        financialStatus: order.financialStatus,
        status: order.status,
      });

      return { verified: false, gateway: detected.gateway, reason: blockedReason };
    }

    // COD orders don't need payment verification — can dispatch immediately
    if (!isPrepaid) {
      await prisma.order.update({
        where: { id: order.id },
        data: {
          paymentVerified: true,
          paymentVerifiedAt: new Date(),
          paymentVerificationSource: 'cod_no_verification_needed',
        },
      });

      logger.info('Payment verified (COD order)', {
        orderId: order.id,
        orderName: order.shopifyOrderName,
        gateway: finalGateway,
      });

      return { verified: true, gateway: finalGateway };
    }

    // Prepaid orders — check Shopify transaction status first
    let verified = paymentCaptured;
    let verificationSource = finalGateway === 'gokwik' ? 'gokwik_order_tags' : finalGateway === 'phonepe' ? 'phonepe_order_tags' : 'shopify_transaction';

    if (!verified) {
      logger.warn('Shopify transaction shows payment not captured', {
        orderId: order.id,
        gateway: detected.gateway,
        transactions: transactions.map((t) => ({ kind: t.kind, status: t.status, gateway: t.gateway })),
      });
    }

    // Optional: double-check with gateway API directly
    if (verified && config.gokwik.verifyEnabled && detected.gateway === 'gokwik') {
      const gokwikResult = await gokwikService.verifyPayment(
        detected.transactionId || order.shopifyOrderName.replace('#', '')
      );
      if (gokwikResult.verified) {
        verificationSource = 'gokwik_api';
        verified = true;
      } else if (gokwikResult.status !== 'NOT_CONFIGURED' && gokwikResult.status !== 'ERROR') {
        verified = false;
      }
    }

    if (verified && config.phonepe.verifyEnabled && detected.gateway === 'phonepe') {
      const phonepeResult = await phonepeService.verifyPayment(
        detected.transactionId || order.shopifyOrderName.replace('#', '')
      );
      if (phonepeResult.verified) {
        verificationSource = 'phonepe_api';
        verified = true;
      } else if (phonepeResult.status !== 'NOT_CONFIGURED' && phonepeResult.status !== 'ERROR') {
        verified = false;
      }
    }

    // Update DB with verification result
    await prisma.order.update({
      where: { id: order.id },
      data: {
        paymentVerified: verified,
        paymentVerifiedAt: verified ? new Date() : null,
        paymentVerificationSource: verified ? verificationSource : null,
      },
    });

    // Record sync log
    await prisma.syncLog.create({
      data: {
        orderId: order.id,
        syncType: 'PAYMENT_VERIFY',
        status: verified ? 'SUCCESS' : 'FAILED',
        message: `Payment verification via ${verificationSource}: ${verified ? 'verified' : 'not verified'}`,
      },
    });

    logger.info('Payment verification complete', {
      orderId: order.id,
      orderName: order.shopifyOrderName,
      gateway: detected.gateway,
      verified,
      source: verificationSource,
    });

    return {
      verified,
      gateway: detected.gateway,
      reason: verified ? undefined : 'Payment not captured or verification failed',
    };
  }

  /**
   * Check if an order is ready for dispatch.
   * - Voided, refunded, or cancelled orders: never ready
   * - COD orders: ready, since there is nothing to collect up front
   * - Prepaid orders: only if payment is verified
   */
  async isReadyForDispatch(order: Order): Promise<{ ready: boolean; reason?: string }> {
    // Checked before the stored paymentVerified flag, because an order can be
    // voided, refunded, or cancelled after its payment was verified.
    const blockedReason = this.blockedByOrderState(order);
    if (blockedReason) {
      return { ready: false, reason: blockedReason };
    }

    // If payment is already verified in our DB, we're good
    if (order.paymentVerified) {
      return { ready: true };
    }

    // If we haven't verified yet, do it now
    const result = await this.verifyPayment(order);

    if (result.verified) {
      return { ready: true };
    }

    return {
      ready: false,
      reason: `Payment not verified (gateway: ${result.gateway}). ${result.reason || ''}`,
    };
  }
}

export default new PaymentService();
