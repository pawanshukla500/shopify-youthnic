/**
 * Accounts closing: moves orders into "Payment Received".
 *
 * An order closes when it is delivered, its money is in Youthnic's bank
 * (prepaid settlement or Delhivery COD remittance, with UTR), the 7-day return
 * window has passed and no return is open (order-tabs.accountsStatus). The
 * Orders tab is computed live from those facts; this job stamps
 * accountsClosedAt for the monthly report and tags the Shopify order.
 */
import prisma from '../../database/prisma';
import logger from '../../utils/logger';
import shopifyService from '../shopify/shopify.service';
import { RETURN_WINDOW_DAYS, accountsStatus } from '../orders/order-tabs';

/** Shopify tags written on an order when it closes for accounts. */
export const ACCOUNTS_CLOSED_TAGS = ['Payment_Received', 'Return_Window_Closed'];

/** Delivery time from the scan history: the newest "Delivered" scan that is not an RTO or failed attempt. */
export function deliveredScanTime(history: unknown): Date | null {
  if (!Array.isArray(history)) return null;
  let latest: number | null = null;
  for (const scan of history) {
    const text = `${(scan as any)?.status || ''} ${(scan as any)?.statusType || ''}`;
    if (!/delivered/i.test(text) || /undeliver|not delivered|\brto\b|\bdto\b/i.test(text)) continue;
    const time = new Date((scan as any)?.dateTime || (scan as any)?.date || '').getTime();
    if (!Number.isNaN(time) && (latest === null || time > latest)) latest = time;
  }
  return latest === null ? null : new Date(latest);
}

/**
 * Orders delivered before deliveredAt was recorded get it from the proof of
 * delivery, the scan history, or (last resort) the last tracking update.
 * Without it the return window cannot be counted.
 */
export async function backfillDeliveredAt(limit = 200): Promise<number> {
  const orders = await prisma.order.findMany({
    where: {
      deliveredAt: null,
      OR: [
        { status: { in: ['DELIVERED', 'RETURN_REQUESTED', 'RETURN_DISPATCHED', 'RETURN_RECEIVED'] } },
        { shipment: { status: 'DELIVERED' } },
      ],
    },
    select: {
      id: true,
      updatedAt: true,
      shipment: { select: { epodReceivedAt: true, trackingHistory: true, trackingUpdatedAt: true, status: true } },
    },
    take: limit,
  });

  let filled = 0;
  for (const order of orders) {
    const shipment = order.shipment;
    const deliveredAt =
      shipment?.epodReceivedAt ||
      deliveredScanTime(shipment?.trackingHistory) ||
      (shipment?.status === 'DELIVERED' ? shipment.trackingUpdatedAt : null) ||
      null;
    if (!deliveredAt) continue;
    await prisma.order.update({ where: { id: order.id }, data: { deliveredAt } });
    filled++;
  }
  return filled;
}

/**
 * Stamp accountsClosedAt on orders that reached "Payment Received" and tag
 * them on Shopify. Safe to run repeatedly.
 */
export async function closeSettledOrders(now: Date = new Date()): Promise<number> {
  const windowStart = new Date(now.getTime() - RETURN_WINDOW_DAYS * 24 * 3600 * 1000);
  const candidates = await prisma.order.findMany({
    where: {
      accountsClosedAt: null,
      status: 'DELIVERED',
      deliveredAt: { not: null, lte: windowStart },
      paymentReceivedAt: { not: null },
      paymentReceivedUtr: { not: null },
    },
    include: { shipment: true, returns: true },
    take: 500,
  });

  let closed = 0;
  for (const order of candidates) {
    if (accountsStatus(order as any, now).state !== 'CLOSED') continue;
    await prisma.order.update({ where: { id: order.id }, data: { accountsClosedAt: now } });
    closed++;
    try {
      await shopifyService.updateOrderTags(order.shopifyOrderId, ACCOUNTS_CLOSED_TAGS);
    } catch (error: any) {
      logger.warn('Could not tag closed order on Shopify', { orderId: order.id, error: error.message });
    }
  }
  if (closed) logger.info('Orders closed for accounts', { closed });
  return closed;
}

export async function runAccountsMaintenance(): Promise<{ deliveredBackfilled: number; closed: number }> {
  const deliveredBackfilled = await backfillDeliveredAt();
  const closed = await closeSettledOrders();
  return { deliveredBackfilled, closed };
}
