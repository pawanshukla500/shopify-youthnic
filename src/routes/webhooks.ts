import { Router, Request, Response } from 'express';
import shopifyService from '../modules/shopify/shopify.service';
import orderService from '../modules/orders/order.service';
import notificationEngine from '../modules/notifications/notification.service';
import prisma from '../database/prisma';
import logger from '../utils/logger';

const router = Router();

/**
 * Shopify Webhook Handler
 * Receives webhooks for: orders/create, orders/paid, orders/updated,
 * orders/cancelled, refunds/create
 *
 * The raw body must be captured for HMAC verification.
 * In app.ts, we set up express.json with verify for the /webhooks/shopify path.
 */
router.post('/shopify', async (req: Request, res: Response): Promise<void> => {
  try {
    // Verify webhook signature
    const hmacHeader = (req.headers['x-shopify-hmac-sha256'] as string) || '';
    const rawBody = (req as any).rawBody || JSON.stringify(req.body);

    const isValid = shopifyService.verifyWebhook(rawBody, hmacHeader);
    if (!isValid) {
      logger.warn('Invalid Shopify webhook signature — rejecting');
      res.status(401).json({ error: 'Invalid webhook signature' });
      return;
    }

    const topic = (req.headers['x-shopify-topic'] as string) || '';
    const payload = req.body;

    logger.info('Received Shopify webhook', { topic, orderId: payload?.id });

    // Record webhook receipt
    await prisma.syncLog.create({
      data: {
        syncType: 'WEBHOOK_RECEIVE',
        status: 'SUCCESS',
        message: `Webhook received: ${topic}`,
      },
    });

    switch (topic) {
      case 'orders/create': {
        const stored = await orderService.syncOrderFromWebhook(payload);
        if (stored) {
          const newOrder = await prisma.order.findUnique({
            where: { shopifyOrderId: payload.id.toString() },
          });
          if (newOrder) {
            await notificationEngine.notifyOrderConfirmed(newOrder);
          }
        }
        break;
      }

      case 'orders/paid':
      case 'orders/updated':
      case 'orders/fulfilled':
        await orderService.syncOrderFromWebhook(payload);
        break;

      case 'orders/cancelled':
        await orderService.handleOrderCancelled(payload.id.toString());
        break;

      case 'fulfillments/create':
      case 'fulfillments/update': {
        // External fulfillments (Delhivery One portal / Shopify Admin) arrive as
        // fulfillment webhooks that only carry the parent order_id. Fetch the
        // full parent order so its fulfillments, tracking, and status sync in.
        const parentOrderId = payload?.order_id;
        if (!parentOrderId) {
          logger.warn('Fulfillment webhook missing order_id — skipping', { topic });
          break;
        }
        const parentOrder = await shopifyService.fetchOrder(parentOrderId.toString());
        await shopifyService.syncOrderToDb(parentOrder);
        break;
      }

      case 'refunds/create':
        logger.info('Refund webhook received (refund processed on Shopify)', {
          orderId: payload.order_id,
        });
        break;

      default:
        logger.info('Unhandled webhook topic', { topic });
    }

    res.status(200).json({ received: true });
  } catch (error: any) {
    logger.error('Webhook processing error', { error: error.message });
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

export default router;
