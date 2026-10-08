import prisma from '../../database/prisma';
import { config } from '../../config';
import shopifyService from '../shopify/shopify.service';
import delhiveryService from '../delhivery/delhivery.service';
import notificationEngine from '../notifications/notification.service';
import paymentService from '../payments/payment.service';
import logger from '../../utils/logger';
import { Order } from '@prisma/client';
import { ShopifyOrderWebhook } from '../../types';
import {
  classifyOrderTab,
  isApprovedForDispatch,
  isCodConfirmed as orderIsCodConfirmed,
  isCodRiskHold,
  isHighRtoCancel,
  isOperationalTab,
  type OrderTab,
} from './order-tabs';

export {
  classifyOrderTab,
  isApprovedForDispatch,
  isCodConfirmed,
  isCodRiskHold,
  isHighRtoCancel,
  isOperationalTab,
  isPrepaidOrder,
  orderStatusFromLiveTracking,
  resolveCourierStage,
} from './order-tabs';

/**
 * Order Service
 * Orchestrates the full order lifecycle:
 *   NEW → DISPATCH_PENDING → DISPATCHED → SHIPPED → IN_TRANSIT → OUT_FOR_DELIVERY → DELIVERED
 * Each transition triggers appropriate WhatsApp notifications.
 *
 * Orders-page tabs are NOT a raw status filter. classifyOrderTab() places each
 * order using Shopify tags and the latest Delhivery tracking scan:
 *   new: received, not approved, not shipped
 *   dispatch: prepaid or COD_CONFIRMED (Low RTO), no label, nothing in Delhivery
 *   ready: label generated, still under pickup (Manifested / Not Picked)
 *   transit: picked up and moving until the customer receives it (includes NDR)
 *   delivered: delivered to the customer
 *   return: RTO and customer returns
 *   cancel: cancelled before pickup, including COD_CANCELLED / High RTO
 */
export const ORDER_TABS = {
  new: ['NEW'],
  dispatch: ['DISPATCH_PENDING'],
  ready: ['DISPATCHED'],
  transit: ['SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'FAILED_DELIVERY'],
  delivered: ['DELIVERED'],
  // "Payment Received" has no status of its own: classifyOrderTab moves a
  // DELIVERED order here once it is paid into the bank and past the return
  // window, so the coarse status fallback lists nothing for it.
  closed: [],
  return: [
    'RTO_INITIATED',
    'RTO_DELIVERED',
    'RETURN_REQUESTED',
    'RETURN_DISPATCHED',
    'RETURN_RECEIVED',
    'REFUNDED',
  ],
  cancel: ['CANCELLED'],
} as const;

export type { OrderTab };

/**
 * How long a dispatch claim (Order.dispatchLockedAt) holds. Longer than one
 * manifest round trip (pincode check + waybill fetch + manifest, ~1 min worst
 * case); a claim left by a crashed process is ignored after this.
 */
export const DISPATCH_LOCK_TTL_MS = 5 * 60 * 1000;

/**
 * Order states in which an RTO auto-refund is never issued without a person.
 * CANCELLED is not one: a prepaid order cancelled after pickup comes back as
 * RTO and still needs its refund (Shopify's cancel does not refund it).
 */
const RTO_REFUND_BLOCKING_STATUSES = new Set([
  'DELIVERED',
  'RETURN_REQUESTED',
  'RETURN_DISPATCHED',
  'RETURN_RECEIVED',
]);

/** Failed RTO refund attempts before the retry cron hands the order to a person. */
export const RTO_REFUND_MAX_ATTEMPTS = 5;

/**
 * Coarse AWB hint kept for older callers. Tab membership itself is
 * classifyOrderTab(), because a waybill can still be awaiting pickup.
 */
export function resolveOrderTabWaybill(tab?: string): boolean | undefined {
  if (!tab) return undefined;
  const key = tab.toLowerCase();
  if (key === 'dispatch') return false;
  if (key === 'ready') return true;
  return undefined;
}

export function resolveOrderTabStatuses(tab?: string): string[] | undefined {
  if (!tab || tab === 'all') return undefined;
  const key = tab.toLowerCase() as keyof typeof ORDER_TABS;
  // Back-compat: old ?tab=ready links meant both queues; now they mean label-ready.
  return ORDER_TABS[key] ? [...ORDER_TABS[key]] : undefined;
}

export function resolveOrderTabFilter(tab?: string): {
  statuses?: string[];
  hasWaybill?: boolean;
} {
  if (!tab || tab === 'all') return {};
  return { statuses: resolveOrderTabStatuses(tab), hasWaybill: resolveOrderTabWaybill(tab) };
}
class OrderService {
  /**
   * Sync new/updated orders from Shopify into our DB.
   * Called by the cron job and also by webhooks.
   */
  async syncOrdersFromShopify(): Promise<number> {
    const syncStartDate = config.shopify.syncStartDate;

    // Check if an initial full fetch from syncStartDate has completed.
    // If not, we must fetch from syncStartDate to backfill the full historical window.
    const backfillTag = `BACKFILL_SINCE_${syncStartDate.toISOString().slice(0, 10)}`;
    const backfillCompleted = await prisma.syncLog.findFirst({
      where: {
        syncType: 'ORDER_FETCH',
        status: 'SUCCESS',
        message: { contains: backfillTag },
      },
    });

    let sinceDate: Date;
    if (backfillCompleted) {
      // Incremental sync: find the most recent order update to use as the "since" timestamp
      const lastOrder = await prisma.order.findFirst({
        orderBy: { shopifyUpdatedAt: 'desc' },
      });
      const incrementalSince = lastOrder?.shopifyUpdatedAt
        ? new Date(lastOrder.shopifyUpdatedAt.getTime() + 1000) // +1s to avoid re-sync
        : null;
      sinceDate = incrementalSince && incrementalSince > syncStartDate ? incrementalSince : syncStartDate;
    } else {
      // Initial backfill from syncStartDate
      sinceDate = syncStartDate;
    }

    logger.info('Syncing orders from Shopify', {
      sinceDate: sinceDate.toISOString(),
      syncStartDate: syncStartDate.toISOString(),
      isBackfill: !backfillCompleted,
    });

    // Strictly fetch orders since sinceDate (always >= syncStartDate)
    const allOrders = await shopifyService.fetchOrdersSince(sinceDate);

    let syncedCount = 0;
    let skippedAsHistory = 0;
    for (const order of allOrders) {
      try {
        // Strict cutoff: Ignore all orders created prior to syncStartDate (25-09-2026 IST)
        if (new Date(order.created_at) < syncStartDate) {
          skippedAsHistory++;
          continue;
        }

        // Check if order already exists in our DB
        const existing = await prisma.order.findUnique({
          where: { shopifyOrderId: order.id.toString() },
          include: { shipment: true },
        });

        // Cancelled, voided, and refunded orders must not be dispatched. An
        // order already in our DB has to be marked CANCELLED rather than
        // skipped, otherwise it stays in NEW and auto-dispatch still ships it.
        const isCancelledOnShopify =
          Boolean((order as any).cancelled_at) ||
          order.financial_status === 'voided' ||
          order.financial_status === 'refunded';

        if (isCancelledOnShopify) {
          if (existing) {
            if (existing.status !== 'CANCELLED') {
              await this.handleOrderCancelled(order.id.toString());
            }
          } else {
            logger.info('Skipping cancelled order', {
              orderName: order.name,
              financialStatus: order.financial_status,
            });
          }
          continue;
        }

        if (existing) {
          // Update order data but don't change our internal status
          await shopifyService.syncOrderToDb(order);
        } else {
          // New order — sync to DB and send confirmation notification
          await shopifyService.syncOrderToDb(order);

          const newOrder = await prisma.order.findUnique({
            where: { shopifyOrderId: order.id.toString() },
          });

          if (newOrder) {
            // Send order confirmation WhatsApp message only for recent orders (under 24h old)
            // to avoid spamming customers for historical backfilled orders
            const orderAgeHours = (Date.now() - new Date(order.created_at).getTime()) / (1000 * 60 * 60);
            if (orderAgeHours < 24) {
              await notificationEngine.notifyOrderConfirmed(newOrder);
            }

            // Verify payment (detects gateway, checks if prepaid payment is captured)
            // COD orders pass automatically; prepaid orders must have captured payment
            await paymentService.verifyPayment(newOrder);

            // Record sync log
            await prisma.syncLog.create({
              data: {
                orderId: newOrder.id,
                syncType: 'ORDER_FETCH',
                status: 'SUCCESS',
                message: `Order ${order.name} synced from Shopify`,
              },
            });
          }
        }

        syncedCount++;
      } catch (error: any) {
        logger.error('Failed to sync individual order', {
          shopifyOrderId: order.id,
          error: error.message,
        });

        await prisma.syncLog.create({
          data: {
            syncType: 'ORDER_FETCH',
            status: 'FAILED',
            message: `Failed to sync order ${order.name}`,
            errorMessage: error.message,
          },
        });
      }
    }

    if (!backfillCompleted) {
      await prisma.syncLog.create({
        data: {
          syncType: 'ORDER_FETCH',
          status: 'SUCCESS',
          message: `${backfillTag}_COMPLETE: Synced ${syncedCount} orders from ${syncStartDate.toISOString()}`,
        },
      });
    }

    logger.info('Order sync complete', {
      syncedCount,
      totalFetched: allOrders.length,
      skippedAsHistory,
      isBackfill: !backfillCompleted,
    });

    // Reconcile any channel orders awaiting AWB with Delhivery One
    try {
      const reconciled = await this.reconcilePendingChannelOrders();
      if (reconciled > 0) {
        logger.info('Reconciled Delhivery One channel orders with AWBs', { count: reconciled });
      }
    } catch (reconcileErr: any) {
      logger.warn('Delhivery channel reconciliation encountered non-fatal error', {
        error: reconcileErr.message,
      });
    }

    return syncedCount;
  }

  /**
   * Import or update a single order arriving from a Shopify webhook.
   *
   * Applies the same start-date policy as the scheduled sync, so editing an old
   * order in Shopify (which fires orders/updated) cannot pull history into the
   * system. Orders already stored are always updated, whatever their age.
   *
   * Returns true when the order was written to the database.
   */
  async syncOrderFromWebhook(order: ShopifyOrderWebhook): Promise<boolean> {
    if (new Date(order.created_at) < config.shopify.syncStartDate) {
      logger.info('Ignoring webhook for order created before the sync start date', {
        orderName: order.name,
        createdAt: order.created_at,
        syncStartDate: config.shopify.syncStartDate.toISOString(),
      });
      return false;
    }

    await shopifyService.syncOrderToDb(order);
    return true;
  }

  /**
   * Reconcile orders in DB that are pending AWB against Delhivery One channel shipments.
   * If an order was manifested or created in Delhivery One under the Shopify channel,
   * its ReferenceNo will match our order name (e.g. 26YOU5761), allowing us to
   * link the AWB and update tracking immediately!
   */
  async reconcilePendingChannelOrders(): Promise<number> {
    const ordersPendingAwb = await prisma.order.findMany({
      where: {
        shopifyCreatedAt: { gte: config.shopify.syncStartDate },
        status: { in: ['NEW', 'DISPATCH_PENDING', 'SHIPPED', 'IN_TRANSIT'] },
        OR: [
          { shipment: null },
          { shipment: { waybillNumber: null } },
        ],
      },
      select: {
        id: true,
        shopifyOrderId: true,
        shopifyOrderName: true,
        shopifyOrderNumber: true,
        totalAmount: true,
        paymentMethod: true,
        fulfillmentStatus: true,
        dispatchedAt: true,
      },
      take: 100,
    });

    if (!ordersPendingAwb.length) return 0;

    const refIds = Array.from(
      new Set(
        ordersPendingAwb.flatMap((o) => [
          o.shopifyOrderName,
          o.shopifyOrderName.replace('#', ''),
          o.shopifyOrderId,
          String(o.shopifyOrderNumber),
        ]).filter(Boolean)
      )
    );

    const packages = await delhiveryService.fetchPackagesByRefIds(refIds);

    let reconciledCount = 0;
    for (const pkg of packages) {
      const shipment = pkg.Shipment;
      if (!shipment?.AWB || !shipment?.ReferenceNo) continue;

      const ref = (shipment.ReferenceNo || '').trim();
      const refClean = ref.replace('#', '').toLowerCase();
      const order = ordersPendingAwb.find((o) => {
        const nameClean = o.shopifyOrderName.replace('#', '').trim().toLowerCase();
        const rawName = o.shopifyOrderName.trim().toLowerCase();
        const orderId = (o.shopifyOrderId || '').trim().toLowerCase();
        const orderNum = String(o.shopifyOrderNumber || '').trim().toLowerCase();
        return (
          refClean === nameClean ||
          refClean === rawName ||
          refClean === orderId ||
          refClean === orderNum
        );
      });
      if (!order) continue;

      const awb = shipment.AWB;
      const statusDesc = shipment.Status?.Status || 'Manifested';
      const statusType = shipment.Status?.StatusType || 'UD';
      const instructions = shipment.Status?.Instructions || '';
      const isSellerCancelled = instructions.toLowerCase().includes('seller cancelled');
      const isPickedUp = !!shipment.PickedUpDate || /in transit|dispatched|out for delivery/i.test(statusDesc);

      const mappedStatus = isSellerCancelled
        ? 'CANCELLED'
        : isPickedUp
        ? delhiveryService.mapTrackingToShipmentStatus(statusType, statusDesc)
        : 'CREATED';

      await prisma.shipment.upsert({
        where: { orderId: order.id },
        create: {
          orderId: order.id,
          waybillNumber: awb,
          courier: 'Delhivery',
          paymentMode: order.paymentMethod === 'COD' ? 'COD' : 'Prepaid',
          codAmount: order.paymentMethod === 'COD' ? order.totalAmount : 0,
          declaredValue: order.totalAmount,
          status: mappedStatus === 'DELIVERED' ? 'DELIVERED' : mappedStatus === 'CANCELLED' ? 'CANCELLED' : 'CREATED',
          trackingStatus: isSellerCancelled ? 'Not Picked (Seller cancelled)' : statusDesc,
          trackingLocation: shipment.Status?.StatusLocation || null,
          trackingUpdatedAt: new Date(),
        },
        update: {
          waybillNumber: awb,
          courier: 'Delhivery',
          status: mappedStatus === 'DELIVERED' ? 'DELIVERED' : mappedStatus === 'CANCELLED' ? 'CANCELLED' : 'CREATED',
          trackingStatus: isSellerCancelled ? 'Not Picked (Seller cancelled)' : statusDesc,
          trackingLocation: shipment.Status?.StatusLocation || null,
          trackingUpdatedAt: new Date(),
        },
      });

      // Orders that are Manifested or Not Picked remain DISPATCH_PENDING (with AWB recorded)
      // They are only marked IN_TRANSIT or DELIVERED once physically picked up by Delhivery
      let newOrderStatus: any = 'DISPATCH_PENDING';
      if (mappedStatus === 'DELIVERED') {
        newOrderStatus = 'DELIVERED';
      } else if (isPickedUp) {
        newOrderStatus = 'IN_TRANSIT';
      }

      await prisma.order.update({
        where: { id: order.id },
        data: {
          status: newOrderStatus,
          dispatchedAt: order.dispatchedAt || new Date(),
        },
      });

      // Push fulfillment to Shopify if Shopify does not have it yet
      if (!order.fulfillmentStatus || order.fulfillmentStatus !== 'fulfilled') {
        try {
          await shopifyService.fulfillOrderOnShopify(order.shopifyOrderId, awb, 'Delhivery');
          logger.info('Synced Delhivery ONE fulfillment back to Shopify', {
            orderId: order.id,
            shopifyOrderId: order.shopifyOrderId,
            awb,
          });
        } catch (shopErr: any) {
          logger.warn('Failed to push Delhivery ONE fulfillment to Shopify during channel reconcile', {
            error: shopErr.message,
          });
        }
      }

      // Trigger live tracking sync in background
      import('../tracking/tracking.service')
        .then(({ default: ts }) => ts.syncShipmentTracking(awb))
        .catch((e) => logger.warn('Background tracking sync failed after channel reconcile', { error: e.message }));

      reconciledCount++;
    }
    return reconciledCount;
  }

  /**
   * Fetch and reconcile fulfillment details for an order from external channels:
   * 1. Checks Shopify live API (in case OMS Guru or another external app created a fulfillment in Shopify)
   * 2. Checks Delhivery ONE Packages API by reference number (in case a user manifested directly in one.delhivery.com)
   * 3. If found in Delhivery ONE but not yet in Shopify, synchronizes fulfillment to Shopify!
   * 4. Updates OMS DB order and shipment records and triggers live tracking.
   */
  async fetchAndReconcileOrderFulfillment(orderId: number): Promise<{
    found: boolean;
    source?: 'shopify' | 'delhivery_one' | 'existing';
    waybillNumber?: string;
    courier?: string;
    order?: any;
    shipment?: any;
    message?: string;
  }> {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { shipment: true },
    });

    if (!order) {
      throw new Error(`Order with ID ${orderId} not found`);
    }

    // Step 1: Check Shopify live API for fulfillments
    try {
      const shopifyOrder = await shopifyService.fetchOrder(order.shopifyOrderId);
      const fulfillments = (shopifyOrder as any).fulfillments || [];
      const activeFulfillments = fulfillments.filter((f: any) => f.status !== 'cancelled');

      if (activeFulfillments.length > 0) {
        const primary = activeFulfillments[activeFulfillments.length - 1];
        const waybill =
          primary.tracking_number ||
          (primary.tracking_numbers && primary.tracking_numbers[0]) ||
          null;

        if (waybill) {
          await shopifyService.syncOrderToDb(shopifyOrder);
          const updated = await prisma.order.findUnique({
            where: { id: orderId },
            include: { shipment: true },
          });
          return {
            found: true,
            source: 'shopify',
            waybillNumber: waybill,
            courier: updated?.shipment?.courier || primary.tracking_company || 'Delhivery',
            order: updated,
            shipment: updated?.shipment,
            message: `Fulfillment details retrieved from Shopify (${updated?.shipment?.courier || 'Courier'}: ${waybill})`,
          };
        }
      }
    } catch (err: any) {
      logger.warn('Failed to check Shopify live fulfillments in fetchAndReconcileOrderFulfillment', {
        orderId,
        error: err.message,
      });
    }

    // Step 2: Check Delhivery ONE packages API by reference numbers
    try {
      const refVariants = Array.from(
        new Set([
          order.shopifyOrderName,
          order.shopifyOrderName.replace('#', ''),
          order.shopifyOrderId,
          String(order.shopifyOrderNumber),
        ].filter(Boolean))
      );

      const packages = await delhiveryService.fetchPackagesByRefIds(refVariants);
      for (const pkg of packages) {
        const shipment = pkg.Shipment;
        if (!shipment?.AWB) continue;

        const ref = (shipment.ReferenceNo || '').trim();
        const refClean = ref.replace('#', '').toLowerCase();
        const matches = refVariants.some(
          (v) => v.replace('#', '').toLowerCase() === refClean
        );

        if (matches) {
          const awb = shipment.AWB;
          const statusDesc = shipment.Status?.Status || 'Manifested';
          const statusType = shipment.Status?.StatusType || 'UD';
          const instructions = shipment.Status?.Instructions || '';
          const isSellerCancelled = instructions.toLowerCase().includes('seller cancelled');
          const isPickedUp = !!shipment.PickedUpDate || /in transit|dispatched|out for delivery/i.test(statusDesc);

          const mappedStatus = isSellerCancelled
            ? 'CANCELLED'
            : isPickedUp
            ? delhiveryService.mapTrackingToShipmentStatus(statusType, statusDesc)
            : 'CREATED';

          const dbShipment = await prisma.shipment.upsert({
            where: { orderId: order.id },
            create: {
              orderId: order.id,
              waybillNumber: awb,
              courier: 'Delhivery',
              paymentMode: order.paymentMethod === 'COD' ? 'COD' : 'Prepaid',
              codAmount: order.paymentMethod === 'COD' ? order.totalAmount : 0,
              declaredValue: order.totalAmount,
              status: mappedStatus === 'DELIVERED' ? 'DELIVERED' : mappedStatus === 'CANCELLED' ? 'CANCELLED' : 'CREATED',
              trackingStatus: isSellerCancelled ? 'Not Picked (Seller cancelled)' : statusDesc,
              trackingLocation: shipment.Status?.StatusLocation || null,
              trackingUpdatedAt: new Date(),
            },
            update: {
              waybillNumber: awb,
              courier: 'Delhivery',
              status: mappedStatus === 'DELIVERED' ? 'DELIVERED' : mappedStatus === 'CANCELLED' ? 'CANCELLED' : 'CREATED',
              trackingStatus: isSellerCancelled ? 'Not Picked (Seller cancelled)' : statusDesc,
              trackingLocation: shipment.Status?.StatusLocation || null,
              trackingUpdatedAt: new Date(),
            },
          });

          let newOrderStatus: any = 'DISPATCH_PENDING';
          if (mappedStatus === 'DELIVERED') {
            newOrderStatus = 'DELIVERED';
          } else if (isPickedUp) {
            newOrderStatus = 'IN_TRANSIT';
          }

          const updatedOrder = await prisma.order.update({
            where: { id: order.id },
            data: {
              status: newOrderStatus,
              dispatchedAt: order.dispatchedAt || new Date(),
            },
            include: { shipment: true },
          });

          // Sync fulfillment back to Shopify if Shopify is unfulfilled
          if (!order.fulfillmentStatus || order.fulfillmentStatus !== 'fulfilled') {
            try {
              await shopifyService.fulfillOrderOnShopify(order.shopifyOrderId, awb, 'Delhivery');
              logger.info('Synced Delhivery ONE direct fulfillment to Shopify', {
                orderId: order.id,
                shopifyOrderId: order.shopifyOrderId,
                awb,
              });
            } catch (shopErr: any) {
              logger.warn('Failed to push Delhivery ONE fulfillment to Shopify', {
                error: shopErr.message,
              });
            }
          }

          // Trigger live tracking poll
          import('../tracking/tracking.service')
            .then(({ default: ts }) => ts.syncShipmentTracking(awb))
            .catch((e) =>
              logger.warn('Background tracking sync failed after Delhivery ONE reconcile', { error: e.message })
            );

          return {
            found: true,
            source: 'delhivery_one',
            waybillNumber: awb,
            courier: 'Delhivery',
            order: updatedOrder,
            shipment: dbShipment,
            message: `Found manifested shipment in Delhivery ONE (AWB: ${awb}). Linked and synced to Shopify!`,
          };
        }
      }
    } catch (err: any) {
      logger.warn('Failed to check Delhivery ONE packages in fetchAndReconcileOrderFulfillment', {
        orderId,
        error: err.message,
      });
    }

    // Step 3: If already has waybill in DB
    if (order.shipment?.waybillNumber) {
      return {
        found: true,
        source: 'existing',
        waybillNumber: order.shipment.waybillNumber,
        courier: order.shipment.courier || 'Delhivery',
        order,
        shipment: order.shipment,
        message: `Order already has tracking ID: ${order.shipment.waybillNumber} (${order.shipment.courier || 'Delhivery'})`,
      };
    }

    return {
      found: false,
      message: 'No external fulfillment found on Shopify or Delhivery ONE for this order.',
      order,
    };
  }

  /**
   * Dispatch an order: push it to Delhivery to generate AWB.
   * Can be called manually or automatically for all DISPATCH_PENDING orders.
   */
  async dispatchOrder(orderId: number): Promise<{ waybillNumber: string }> {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true, shipment: true },
    });

    if (!order) {
      throw new Error(`Order not found: ${orderId}`);
    }

    if (order.status !== 'NEW' && order.status !== 'DISPATCH_PENDING') {
      throw new Error(`Order ${order.shopifyOrderName} is not in dispatchable state (current: ${order.status})`);
    }

    if (isHighRtoCancel(order)) {
      throw new Error(
        `Order ${order.shopifyOrderName} is COD_CANCELLED / High RTO and was cancelled before dispatch`
      );
    }

    // Every dispatch path (single, bulk, sync auto-dispatch) goes through here,
    // so the approval rule is enforced once on the server: prepaid, or COD the
    // customer confirmed (COD_CONFIRMED / Low RTO). Unconfirmed COD stays in New.
    if (!isApprovedForDispatch(order)) {
      throw new Error(
        `Order ${order.shopifyOrderName} is unconfirmed COD. Confirm COD before dispatching it.`
      );
    }

    if (order.shopifyCreatedAt && new Date(order.shopifyCreatedAt) < config.shopify.syncStartDate) {
      throw new Error(
        `Order ${order.shopifyOrderName} was created before the ${config.shopify.syncStartDate.toISOString().slice(0, 10)} cutoff and is never dispatched by the OMS`
      );
    }

    // Shopify already marks this order fulfilled, so a Delhivery shipment here
    // would ship goods that are already out (or were never meant to be). This
    // catches both historic imports and orders fulfilled through another path.
    if (order.fulfillmentStatus === 'fulfilled') {
      throw new Error(
        `Order ${order.shopifyOrderName} is already fulfilled on Shopify and cannot be dispatched again`
      );
    }

    // A live AWB means Delhivery already has this parcel. Manifesting again
    // would create a second shipment and overwrite the first AWB. Rejected
    // manifests (ERROR) and cancelled shipments may be dispatched again.
    const existing = (order as any).shipment;
    if (existing?.waybillNumber && !['ERROR', 'CANCELLED'].includes(existing.status)) {
      throw new Error(
        `Order ${order.shopifyOrderName} already has Delhivery AWB ${existing.waybillNumber}`
      );
    }

    // Claim the order for this dispatch. Only one caller can win the
    // conditional update; the others fail fast instead of booking a second AWB.
    const claimedAt = new Date();
    const claim = await prisma.order.updateMany({
      where: {
        id: order.id,
        status: { in: ['NEW', 'DISPATCH_PENDING'] },
        OR: [
          { dispatchLockedAt: null },
          { dispatchLockedAt: { lt: new Date(claimedAt.getTime() - DISPATCH_LOCK_TTL_MS) } },
        ],
      },
      data: { dispatchLockedAt: claimedAt },
    });
    if (claim.count === 0) {
      throw new Error(`Order ${order.shopifyOrderName} is already being dispatched`);
    }

    try {
      return await this.dispatchClaimedOrder(order);
    } finally {
      await prisma.order
        .updateMany({ where: { id: order.id, dispatchLockedAt: claimedAt }, data: { dispatchLockedAt: null } })
        .catch((releaseErr: any) =>
          logger.warn('Could not release dispatch claim', { orderId: order.id, error: releaseErr.message })
        );
    }
  }

  /** The manifest itself. Only called by dispatchOrder while it holds the claim. */
  private async dispatchClaimedOrder(order: Order): Promise<{ waybillNumber: string }> {
    const orderId = order.id;

    // Verify payment before dispatch (prepaid orders must be paid, COD is always OK)
    const paymentCheck = await paymentService.isReadyForDispatch(order);
    if (!paymentCheck.ready) {
      throw new Error(
        `Cannot dispatch order ${order.shopifyOrderName}: ${paymentCheck.reason || 'Payment not verified'}`
      );
    }

    // Refresh order after payment verification may have updated it
    const verifiedOrder = await prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });
    if (!verifiedOrder) {
      throw new Error(`Order not found after verification: ${orderId}`);
    }
    // A Shopify cancel can land while payment is being verified.
    if (verifiedOrder.status !== 'NEW' && verifiedOrder.status !== 'DISPATCH_PENDING') {
      throw new Error(
        `Order ${verifiedOrder.shopifyOrderName} changed to ${verifiedOrder.status} before dispatch; not manifested`
      );
    }

    // Create shipment on Delhivery
    const result = await delhiveryService.createShipment(verifiedOrder, {
      itemCount: verifiedOrder.items?.length ?? 1,
    });

    // Promote the order + shipment out of their pre-dispatch states so the
    // UI stops showing "Dispatch Pending". Without these updates the row
    // would stay on the yellow badge forever even though Delhivery has the
    // shipment. Pre-PR #10 round-2 finding (round-2 audit G3 was about EPOD
    // webhook gaps; this is the same class of bug for the dispatch flow).
    const [, promoted] = await prisma.$transaction([
      prisma.shipment.update({
        where: { orderId: order.id },
        data: { status: 'CREATED', trackingStatus: 'Label generated', courier: 'Delhivery' },
      }),
      // Conditional: a Shopify cancel that landed during the manifest call
      // must not be overwritten back to DISPATCHED.
      prisma.order.updateMany({
        where: { id: order.id, status: { in: ['NEW', 'DISPATCH_PENDING', 'DISPATCHED'] } },
        data: { status: 'DISPATCHED', dispatchedAt: new Date() },
      }),
    ]);
    if (promoted?.count === 0) {
      const shipment = await prisma.shipment.findUnique({ where: { orderId: order.id } });
      const outcome = await this.cancelLiveShipment({
        id: order.id,
        shopifyOrderName: order.shopifyOrderName,
        shipment: shipment
          ? { id: shipment.id, waybillNumber: shipment.waybillNumber, status: shipment.status }
          : null,
      });
      throw new Error(
        `Order ${order.shopifyOrderName} was cancelled while it was being dispatched. AWB ${result.waybillNumber} ${outcome === 'cancelled' ? 'was cancelled at Delhivery' : 'could NOT be cancelled at Delhivery; cancel it in Delhivery One'}.`
      );
    }

    // Sync fulfillment and tracking number directly to Shopify order
    try {
      await shopifyService.fulfillOrderOnShopify(verifiedOrder.shopifyOrderId, result.waybillNumber);
    } catch (shopifyErr: any) {
      logger.warn('Could not sync fulfillment to Shopify (non-critical)', { error: shopifyErr.message });
    }

    // Send "order shipped" WhatsApp notification
    await notificationEngine.notifyOrderShipped(verifiedOrder, result.waybillNumber);

    // Record sync log
    await prisma.syncLog.create({
      data: {
        orderId: order.id,
        syncType: 'SHIPMENT_CREATE',
        status: 'SUCCESS',
        message: `Shipment created with waybill ${result.waybillNumber}`,
      },
    });

    return { waybillNumber: result.waybillNumber };
  }

  /**
   * Auto-dispatch all orders that are in NEW status.
   * Called by the scheduler.
   */
  async autoDispatchPendingOrders(): Promise<number> {
    const pendingOrders = await prisma.order.findMany({
      where: {
        status: { in: ['NEW', 'DISPATCH_PENDING'] },
        OR: [{ shipment: null }, { shipment: { waybillNumber: null } }],
      },
      include: { shipment: true },
    });

    let dispatchedCount = 0;
    let skippedFulfilled = 0;
    for (const order of pendingOrders) {
      // Skip if shipment already exists
      if (order.shipment?.waybillNumber) {
        logger.info('Order already has a shipment, skipping', { orderId: order.id });
        continue;
      }

      // New Order stays untouched until someone approves COD (COD_CONFIRMED /
      // Low RTO) or the order is prepaid. High RTO / COD_CANCELLED never ships.
      if (!isApprovedForDispatch(order)) {
        continue;
      }

      // Shopify already shows this order as fulfilled (shipped elsewhere or
      // manually). It must not get a second Delhivery shipment. The historical
      // import pulls such orders in as NEW; they stay NEW but are never
      // dispatched.
      if (order.fulfillmentStatus === 'fulfilled') {
        skippedFulfilled++;
        continue;
      }

      // Only auto-dispatch recent orders (created within the last 48 hours).
      // Older backfilled orders imported from June/July/August are kept for records,
      // reports, and manual fulfillment.
      const orderAgeHours = (Date.now() - new Date(order.shopifyCreatedAt).getTime()) / (1000 * 60 * 60);
      if (orderAgeHours > 48) {
        continue;
      }

      try {
        await this.dispatchOrder(order.id);
        dispatchedCount++;
      } catch (error: any) {
        logger.error('Auto-dispatch failed for order', {
          orderId: order.id,
          orderName: order.shopifyOrderName,
          error: error.message,
        });

        await prisma.syncLog.create({
          data: {
            orderId: order.id,
            syncType: 'SHIPMENT_CREATE',
            status: 'FAILED',
            message: `Auto-dispatch failed for ${order.shopifyOrderName}`,
            errorMessage: error.message,
          },
        });
      }
    }

    if (skippedFulfilled > 0) {
      logger.info('Auto-dispatch skipped already-fulfilled orders', {
        skippedFulfilled,
        totalPending: pendingOrders.length,
      });
    }

    logger.info('Auto-dispatch complete', { dispatchedCount, totalPending: pendingOrders.length });
    return dispatchedCount;
  }

  /**
   * Handle order cancelled webhook from Shopify.
   */
  async handleOrderCancelled(shopifyOrderId: string): Promise<void> {
    const order = await prisma.order.findUnique({
      where: { shopifyOrderId: shopifyOrderId },
      include: { shipment: true },
    });

    if (!order) {
      logger.warn('Cancelled order not found in DB', { shopifyOrderId });
      return;
    }

    const delhiveryCancel = await this.cancelLiveShipment(order);

    await prisma.order.update({
      where: { id: order.id },
      data: {
        status: 'CANCELLED',
        cancelledAt: order.cancelledAt || new Date(),
        ...(delhiveryCancel === 'refused'
          ? { hasUrgentSupport: true, supportFlag: 'DELHIVERY_CANCEL_FAILED' }
          : {}),
      },
    });

    logger.info('Order cancelled', {
      shopifyOrderId,
      orderName: order.shopifyOrderName,
      delhiveryCancel,
    });
  }

  /**
   * Cancel the order's Delhivery shipment if it is still live.
   *
   * Delhivery accepts a forward cancel while the parcel is Manifested, In
   * Transit or Pending (after pickup it comes back as RTO). The shipment is
   * marked CANCELLED only when Delhivery accepts; a refusal keeps it active so
   * tracking keeps polling it, and records why.
   */
  async cancelLiveShipment(order: {
    id: number;
    shopifyOrderName: string;
    shipment?: { id: number; waybillNumber: string | null; status: string } | null;
  }): Promise<'none' | 'cancelled' | 'refused'> {
    const shipment = order.shipment;
    const live =
      shipment?.waybillNumber &&
      !['CANCELLED', 'ERROR', 'DELIVERED', 'RTO', 'RTO_DELIVERED'].includes(shipment.status);
    if (!shipment || !live) return 'none';

    const accepted = await delhiveryService.cancelShipment(shipment.waybillNumber!);
    if (accepted) {
      await prisma.shipment.update({
        where: { id: shipment.id },
        data: { status: 'CANCELLED', trackingStatus: 'Cancelled by seller' },
      });
      return 'cancelled';
    }

    const message = `Delhivery did not accept the cancel for AWB ${shipment.waybillNumber}. The parcel may still move; cancel it in Delhivery One.`;
    await prisma.shipment.update({
      where: { id: shipment.id },
      data: { errorMessage: message },
    });
    await prisma.syncLog.create({
      data: {
        orderId: order.id,
        syncType: 'SHIPMENT_CREATE',
        status: 'FAILED',
        message: `Cancel ${order.shopifyOrderName}: Delhivery refused`,
        errorMessage: message,
      },
    });
    logger.warn('Delhivery refused shipment cancel', {
      orderId: order.id,
      waybill: shipment.waybillNumber,
    });
    return 'refused';
  }

  /**
   * Get all orders with optional filters and search.
   * Supports filtering by status, paymentGateway, paymentMethod, paymentVerified, search query, and pagination.
   */
  async getOrders(
    optionsOrStatus?: string | {
      status?: string;
      statuses?: string[];
      tab?: string;
      hasWaybill?: boolean;
      gateway?: string;
      paymentMethod?: string;
      paymentVerified?: boolean;
      search?: string;
      filter?: string;
      limit?: number;
      offset?: number;
    }
  ): Promise<Order[]> {
    let status: string | undefined;
    let statuses: string[] | undefined;
    let tab: string | undefined;
    let hasWaybill: boolean | undefined;
    let gateway: string | undefined;
    let paymentMethod: string | undefined;
    let paymentVerified: boolean | undefined;
    let search: string | undefined;
    let filter: string | undefined;
    let limit: number | undefined;
    let offset: number | undefined;

    if (typeof optionsOrStatus === 'string') {
      status = optionsOrStatus;
    } else if (optionsOrStatus && typeof optionsOrStatus === 'object') {
      status = optionsOrStatus.status;
      statuses = optionsOrStatus.statuses;
      tab = optionsOrStatus.tab;
      // Tab queues are applied after load via classifyOrderTab (tags + live
      // Delhivery scan). An explicit hasWaybill filter is still honored.
      hasWaybill = optionsOrStatus.hasWaybill;
      gateway = optionsOrStatus.gateway;
      paymentMethod = optionsOrStatus.paymentMethod;
      paymentVerified = optionsOrStatus.paymentVerified;
      search = optionsOrStatus.search?.trim();
      filter = optionsOrStatus.filter;
      limit = optionsOrStatus.limit;
      offset = optionsOrStatus.offset;
    }

    const where: any = {};
    const andConditions: any[] = [];

    if (filter === 'DELAYED_DISPATCH') {
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 3600 * 1000);
      andConditions.push({
        OR: [
          { dispatchDelayed: true },
          { expectedDispatchAt: { lte: new Date() } },
          { shopifyCreatedAt: { lte: twentyFourHoursAgo } },
        ],
      });
      andConditions.push({
        OR: [
          { shipment: null },
          { shipment: { waybillNumber: null } },
        ],
      });
    } else if (filter === 'NDR') {
      andConditions.push({
        OR: [
          { status: { in: ['FAILED_DELIVERY', 'RTO_INITIATED'] } },
          {
            shipment: {
              OR: [
                { status: { in: ['FAILED', 'RTO'] } },
                { trackingStatus: { contains: 'failure', mode: 'insensitive' } },
                { trackingStatus: { contains: 'attempt', mode: 'insensitive' } },
                { trackingStatus: { contains: 'undeliver', mode: 'insensitive' } },
              ],
            },
          },
        ],
      });
    } else if (filter === 'PREPAID_DISPATCH') {
      andConditions.push({ status: { in: ['NEW', 'DISPATCH_PENDING'] } });
      andConditions.push({ paymentMethod: { not: 'COD' } });
    }

    // A named tab is classified in memory so Delhivery tracking and Shopify
    // tags can move an order between queues without a status rewrite.
    const tabKey = tab?.toLowerCase();
    const classifyTab = isOperationalTab(tabKey) ? tabKey : undefined;
    const explicitStatuses = statuses?.length ? statuses : undefined;
    if (explicitStatuses?.length) {
      where.status = { in: explicitStatuses };
    } else if (status) {
      where.status = status;
    }

    // AWB segregation: dispatch tab = shipment missing/waybill null (needs Dispatch
    // click); ready tab = waybill assigned (label generated, awaiting pickup).
    if (hasWaybill === true) {
      andConditions.push({ shipment: { waybillNumber: { not: null } } });
    } else if (hasWaybill === false) {
      andConditions.push({
        OR: [{ shipment: null }, { shipment: { waybillNumber: null } }],
      });
    }

    if (gateway) {
      if (gateway.toLowerCase() === 'cod') {
        where.paymentMethod = 'COD';
      } else {
        where.paymentGateway = { contains: gateway, mode: 'insensitive' };
      }
    }

    if (paymentMethod) {
      where.paymentMethod = paymentMethod;
    }

    if (paymentVerified !== undefined) {
      where.paymentVerified = paymentVerified;
    }

    if (search) {
      andConditions.push({
        OR: [
          { shopifyOrderName: { contains: search, mode: 'insensitive' } },
          { customerName: { contains: search, mode: 'insensitive' } },
          { customerPhone: { contains: search } },
          { customerEmail: { contains: search, mode: 'insensitive' } },
          { customerCity: { contains: search, mode: 'insensitive' } },
          { customerState: { contains: search, mode: 'insensitive' } },
          { customerPincode: { contains: search } },
          { salesChannel: { contains: search, mode: 'insensitive' } },
          { tags: { contains: search, mode: 'insensitive' } },
          { shipment: { waybillNumber: { contains: search } } },
          {
            items: {
              some: {
                OR: [
                  { sku: { contains: search, mode: 'insensitive' } },
                  { title: { contains: search, mode: 'insensitive' } },
                  { variantTitle: { contains: search, mode: 'insensitive' } },
                ],
              },
            },
          },
        ],
      });
    }

    if (andConditions.length > 0) {
      where.AND = andConditions;
    }

    const orders = await prisma.order.findMany({
      where,
      include: { items: true, shipment: true, returns: true },
      orderBy: { shopifyCreatedAt: 'desc' },
      // Pagination is applied after tab classification so a limit cannot
      // drop an order that belongs in this queue but sits later in the table.
      take: classifyTab ? undefined : limit,
      skip: classifyTab ? undefined : offset,
    });

    let mapped = orders.map((o) => this.enrichOrderMetadata(o));
    if (classifyTab) {
      mapped = mapped.filter((order) => classifyOrderTab(order) === classifyTab);
      const start = offset ?? 0;
      if (limit !== undefined || offset !== undefined) {
        mapped = mapped.slice(start, limit !== undefined ? start + limit : undefined);
      }
    }
    if (filter === 'DELAYED_DISPATCH') {
      mapped = mapped.filter((order) => classifyOrderTab(order) === 'dispatch' && order.isDispatchOverdue);
    }
    return mapped;
  }

  /**
   * Counts per operational tab. Each order is placed with classifyOrderTab so
   * the badge matches the list (Shopify tags + Delhivery live tracking).
   */
  async getOrderTabCounts(): Promise<Record<OrderTab, number> & { byStatus: Record<string, number> }> {
    const rows = await prisma.order.findMany({
      select: {
        status: true,
        paymentMethod: true,
        paymentGateway: true,
        financialStatus: true,
        tags: true,
        shipment: {
          select: {
            status: true,
            waybillNumber: true,
            trackingStatus: true,
            trackingUpdatedAt: true,
            courier: true,
          },
        },
        returns: { select: { returnStatus: true } },
        deliveredAt: true,
        paymentReceivedAt: true,
        paymentReceivedUtr: true,
        accountsClosedAt: true,
      },
    });
    const byStatus: Record<string, number> = {};
    const counts: Record<OrderTab, number> = {
      all: rows.length,
      new: 0,
      dispatch: 0,
      ready: 0,
      transit: 0,
      delivered: 0,
      closed: 0,
      return: 0,
      cancel: 0,
    };
    for (const row of rows) {
      byStatus[row.status] = (byStatus[row.status] || 0) + 1;
      counts[classifyOrderTab(row)] += 1;
    }
    return { ...counts, byStatus };
  }

  /**
   * Get a single order by ID with all related data and enriched operational metadata.
   */
  async getOrder(orderId: number): Promise<any> {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: true,
        shipment: { include: { trackingLogs: true } },
        returns: { include: { items: { include: { orderItem: true } } } },
        notifications: true,
      },
    });

    if (!order) return null;
    return this.enrichOrderMetadata(order);
  }

  /**
   * Helper to attach RTO risk, dispatch SLA, and NDR flags to an order.
   */
  enrichOrderMetadata(order: any): any {
    const rate = delhiveryService.calculateRateCardMatrix({
      mode: (config.delhivery.shippingMode === 'Express' ? 'E' : 'S') as 'E' | 'S',
      chargeableWeightGrams: 500,
      originPincode: config.delhivery.seller.pincode,
      destinationPincode: order.customerPincode,
      shipmentStatus: 'Delivered',
      paymentType: order.paymentMethod === 'COD' ? 'COD' : 'Pre-paid',
      codAmount: order.paymentMethod === 'COD' ? order.totalAmount : 0,
    });

    const hoursSincePlaced = (Date.now() - new Date(order.shopifyCreatedAt).getTime()) / (1000 * 60 * 60);
    const hasWaybill = Boolean(order.shipment?.waybillNumber);
    const operationalTab = classifyOrderTab(order);
    // SLA applies only to orders that are actually waiting for a label.
    const isDispatchOverdue = operationalTab === 'dispatch' && !hasWaybill && hoursSincePlaced > 24;
    const dispatchOverdueHours = isDispatchOverdue ? Math.round(hoursSincePlaced - 24) : 0;
    const expectedDispatchAt = order.expectedDispatchAt || new Date(new Date(order.shopifyCreatedAt).getTime() + 24 * 3600 * 1000);

    const hasNdrException =
      order.status === 'FAILED_DELIVERY' ||
      (order.shipment?.trackingStatus && /fail|attempt|undeliver/i.test(order.shipment.trackingStatus));

    const isCodBlocked = isCodRiskHold(order);
    const isCodConfirmed = orderIsCodConfirmed(order);

    let rtoRiskLevel: 'LOW' | 'MEDIUM' | 'HIGH' = (order.rtoRiskLevel as any) || 'LOW';
    let rtoRiskLabel = 'Prepaid (Zero RTO Risk)';
    let rtoRiskReason = order.rtoRiskReason || 'Payment captured upfront via Easebuzz / PhonePe';

    if (order.paymentMethod === 'COD') {
      if (isCodBlocked) {
        rtoRiskLevel = 'HIGH';
        rtoRiskLabel = 'High RTO Risk (GoKwik COD Blocked)';
        rtoRiskReason = 'GoKwik flagged COD blocked / customer cancelled';
      } else if (isCodConfirmed) {
        rtoRiskLevel = 'LOW';
        rtoRiskLabel = 'Low RTO Risk (COD Confirmed)';
        rtoRiskReason = 'Customer verified intent via WhatsApp / GoKwik confirmation';
      } else if (order.deliverOrderCount && order.deliverOrderCount >= 2) {
        rtoRiskLevel = 'LOW';
        rtoRiskLabel = `Low RTO Risk (${order.deliverOrderCount} prior deliveries)`;
        rtoRiskReason = `Repeat trustworthy buyer (${order.deliverOrderCount} prior deliveries on GoKwik network)`;
      } else {
        rtoRiskLevel = 'MEDIUM';
        rtoRiskLabel = 'Medium Risk (Unconfirmed COD)';
        rtoRiskReason = 'Awaiting customer WhatsApp confirmation before dispatch';
      }
    }

    return {
      ...order,
      estimatedShippingCost: rate.totalAmount,
      shippingZone: rate.zone,
      shippingZoneCode: rate.zoneCode,
      isDispatchOverdue,
      dispatchOverdueHours,
      expectedDispatchAt,
      hasNdrException: Boolean(hasNdrException),
      operationalTab,
      rtoRiskLevel,
      rtoRiskReason,
      rtoRiskLabel,
      rtoRisk: {
        level: rtoRiskLevel,
        label: rtoRiskLabel,
        reason: rtoRiskReason,
        deliverCount: order.deliverOrderCount,
        isConfirmed: isCodConfirmed,
        isBlocked: isCodBlocked,
      },
    };
  }

  /**
   * Process Auto-Refund for RTO Delivered Orders (Scenario 2).
   * When package arrives back at warehouse:
   * - If prepaid: issues refund via Shopify to Easebuzz/PhonePe, adds tags, notifies customer.
   * - If COD: marks RTO delivered and restocks without customer refund.
   */
  async processRtoRefund(orderId: number): Promise<{ success: boolean; refundId?: string; message: string }> {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true, shipment: true },
    });

    if (!order) {
      throw new Error(`Order ${orderId} not found`);
    }

    if (order.financialStatus === 'refunded' || order.status === 'REFUNDED') {
      return { success: true, message: 'Order is already marked as refunded.' };
    }
    // A voided authorization was never captured: there is nothing to refund.
    if ((order.financialStatus || '').toLowerCase() === 'voided') {
      return { success: true, message: 'Payment was voided, nothing to refund.' };
    }

    const isPrepaid = order.paymentMethod !== 'COD';
    if (!isPrepaid) {
      await prisma.order.update({
        where: { id: order.id },
        data: { status: 'RTO_DELIVERED' },
      });
      try {
        await shopifyService.updateOrderTags(order.shopifyOrderId, [
          'RTO_DELIVERED',
          'COD_RTO_RESTOCKED',
        ]);
      } catch (e: any) {
        logger.warn('Could not update tags on Shopify for COD RTO', { error: e.message });
      }
      return { success: true, message: 'COD Order marked RTO Delivered and restocked (no customer refund required).' };
    }

    // A parcel the customer received is never an RTO. Late or forged carrier
    // data must not turn a delivered order into an automatic refund.
    if (order.deliveredAt || RTO_REFUND_BLOCKING_STATUSES.has(order.status)) {
      return this.holdRtoRefund(
        order,
        'RTO_REFUND_REVIEW',
        `RTO auto-refund skipped: ${order.shopifyOrderName} is ${order.status}${order.deliveredAt ? ' and was delivered' : ''}. Review it before refunding.`
      );
    }
    if ((order.financialStatus || '').toLowerCase() === 'partially_refunded') {
      return this.holdRtoRefund(
        order,
        'RTO_REFUND_REVIEW',
        `RTO auto-refund skipped: ${order.shopifyOrderName} is already partially refunded. Refund the balance by hand.`
      );
    }

    // Only Delhivery's authenticated tracking API can confirm the RTO. The
    // scan webhook is open, so its claim alone never moves money.
    const waybill = order.shipment?.waybillNumber;
    if (!waybill) {
      return this.holdRtoRefund(order, 'RTO_REFUND_REVIEW', `RTO auto-refund skipped: ${order.shopifyOrderName} has no forward AWB to verify.`);
    }
    let carrierStatus: string;
    try {
      const live = await delhiveryService.trackShipment(waybill);
      carrierStatus = delhiveryService.mapTrackingToShipmentStatus(
        live.statusType,
        live.status,
        live.pickupDone,
        live.remarks
      );
    } catch (verifyErr: any) {
      await this.holdRtoRefund(
        order,
        'RTO_REFUND_FAILED',
        `Could not confirm the RTO of ${waybill} with Delhivery: ${verifyErr.message}`
      );
      throw verifyErr;
    }
    if (carrierStatus !== 'RTO_DELIVERED') {
      return this.holdRtoRefund(
        order,
        'RTO_REFUND_REVIEW',
        `Delhivery reports ${carrierStatus} for ${waybill}, not RTO delivered. No refund issued.`
      );
    }

    await prisma.order.update({ where: { id: order.id }, data: { status: 'RTO_DELIVERED' } });

    // Prepaid Order: Call Shopify Refund API (routing to Easebuzz / GoKwik).
    // The idempotency key makes a retry after a timeout adopt the refund that
    // already went through instead of refunding twice.
    let refundResult: Awaited<ReturnType<typeof shopifyService.createRefund>>;
    try {
      refundResult = await shopifyService.createRefund(
        order.shopifyOrderId,
        order.totalAmount,
        [],
        true, // full refund
        { idempotencyKey: `oms-rto-${order.id}` }
      );
    } catch (refundErr: any) {
      await this.holdRtoRefund(
        order,
        'RTO_REFUND_FAILED',
        `Shopify refund for RTO ${order.shopifyOrderName} failed: ${refundErr.message}`
      );
      throw refundErr;
    }

    // Shopify has the refund now. Bookkeeping failures below are logged and
    // must never send this order back through the refund path.
    const refundedAmount = refundResult.amount;
    try {
      await prisma.order.update({
        where: { id: order.id },
        data: {
          status: 'REFUNDED',
          financialStatus: 'refunded',
          ...(order.supportFlag?.startsWith('RTO_REFUND') ? { supportFlag: null, hasUrgentSupport: false } : {}),
        },
      });
    } catch (dbErr: any) {
      logger.error('RTO refund succeeded on Shopify but the order row was not updated', {
        orderId: order.id,
        refundId: refundResult.refundId,
        error: dbErr.message,
      });
    }

    // Tag on Shopify
    try {
      await shopifyService.updateOrderTags(order.shopifyOrderId, [
        'RTO_DELIVERED',
        'RTO_AUTO_REFUNDED',
        'Refund_initiated',
        'Refund_credited',
      ]);
    } catch (tagErr: any) {
      logger.warn('Failed to add refund tags to Shopify', { error: tagErr.message });
    }

    // Tell the customer only when money actually moved back to them.
    if (refundResult.moneyMoved) {
      try {
        await notificationEngine.sendCustomMessage(
          order,
          `Hi ${order.customerName}, your returned package for order ${order.shopifyOrderName} has been safely received at our Surat warehouse. A refund of ₹${refundedAmount} has been processed to your original payment mode (${order.paymentProvider || order.paymentGateway || 'Prepaid'}). Refund ID: ${refundResult.refundId}.`
        );
      } catch (notifErr: any) {
        logger.warn('Failed to send refund WhatsApp notification', { error: notifErr.message });
      }
    }

    // Record sync log
    await prisma.syncLog
      .create({
        data: {
          orderId: order.id,
          syncType: 'REFUND_PROCESS',
          status: 'SUCCESS',
          message: refundResult.moneyMoved
            ? `Auto-refund of ₹${refundedAmount} processed for RTO delivered order ${order.shopifyOrderName} (Refund ID: ${refundResult.refundId})`
            : `RTO ${order.shopifyOrderName} recorded on Shopify (Refund ID: ${refundResult.refundId}) but no captured payment was found, so no money moved. Pay the customer by hand if they paid outside Shopify.`,
        },
      })
      .catch((logErr: any) => logger.warn('Could not write RTO refund sync log', { error: logErr.message }));

    return {
      success: true,
      refundId: refundResult.refundId,
      message: `Auto-refund of ₹${refundedAmount} processed successfully for ${order.shopifyOrderName}!`,
    };
  }

  /**
   * Leave an RTO refund for retry (RTO_REFUND_FAILED) or for a person
   * (RTO_REFUND_REVIEW): flag the order so it surfaces in the support queue.
   */
  private async holdRtoRefund(
    order: { id: number; shopifyOrderName: string },
    flag: 'RTO_REFUND_FAILED' | 'RTO_REFUND_REVIEW',
    message: string
  ): Promise<{ success: false; message: string }> {
    logger.warn('RTO refund held', { orderId: order.id, flag, message });
    await prisma.order.update({
      where: { id: order.id },
      data: { hasUrgentSupport: true, supportFlag: flag },
    });
    await prisma.syncLog.create({
      data: {
        orderId: order.id,
        syncType: 'REFUND_PROCESS',
        status: 'FAILED',
        message: `RTO refund held (${flag}) for ${order.shopifyOrderName}`,
        errorMessage: message,
      },
    });
    return { success: false, message };
  }

  /**
   * Retry RTO refunds that failed for a transient reason (Delhivery or Shopify
   * unreachable). Called by the hourly retry cron. After RTO_REFUND_MAX_ATTEMPTS
   * failures the order is left for a person.
   */
  async retryFailedRtoRefunds(): Promise<number> {
    const flagged = await prisma.order.findMany({
      where: { supportFlag: 'RTO_REFUND_FAILED', status: 'RTO_DELIVERED' },
      select: { id: true, shopifyOrderName: true },
      take: 50,
    });

    let refunded = 0;
    for (const order of flagged) {
      const failures = await prisma.syncLog.count({
        where: { orderId: order.id, syncType: 'REFUND_PROCESS', status: 'FAILED' },
      });
      if (failures >= RTO_REFUND_MAX_ATTEMPTS) {
        await prisma.order.update({
          where: { id: order.id },
          data: { supportFlag: 'RTO_REFUND_REVIEW' },
        });
        logger.warn('RTO refund gave up after repeated failures', { orderId: order.id, failures });
        continue;
      }
      try {
        const result = await this.processRtoRefund(order.id);
        if (result.success) refunded++;
      } catch (error: any) {
        logger.error('RTO refund retry failed', { orderId: order.id, error: error.message });
      }
    }
    return refunded;
  }

  /**
   * Handle NDR action (re-attempt or mark RTO) with Delhivery and customer notification.
   */
  async handleNdrAction(
    orderId: number,
    action: 'RE-ATTEMPT' | 'RTO',
    notes?: string
  ): Promise<{ success: boolean; message: string }> {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { shipment: true },
    });

    if (!order) {
      throw new Error(`Order ${orderId} not found`);
    }

    if (action === 'RE-ATTEMPT') {
      if (order.shipment?.waybillNumber && order.shipment.courier?.toLowerCase() === 'delhivery') {
        try {
          await delhiveryService.ndrAction(order.shipment.waybillNumber, 'RE-ATTEMPT');
        } catch (delhErr: any) {
          logger.warn('Delhivery NDR action failed (courier may be offline)', { error: delhErr.message });
        }
      }

      await notificationEngine.sendCustomMessage(
        order,
        `Hi ${order.customerName}, our courier will re-attempt delivery of your order ${order.shopifyOrderName} tomorrow. Please ensure someone is available at the address. If you need assistance, reply to this message.`
      );

      await prisma.syncLog.create({
        data: {
          orderId: order.id,
          syncType: 'TRACKING_UPDATE',
          status: 'SUCCESS',
          message: `NDR Re-attempt requested for ${order.shopifyOrderName}. Notes: ${notes || 'None'}`,
        },
      });

      return { success: true, message: `Re-attempt scheduled for ${order.shopifyOrderName}. Customer notified on WhatsApp.` };
    } else {
      // Mark RTO Initiated
      await prisma.order.update({
        where: { id: order.id },
        data: { status: 'RTO_INITIATED' },
      });
      if (order.shipment) {
        await prisma.shipment.update({
          where: { id: order.shipment.id },
          data: { status: 'RTO' },
        });
      }

      try {
        await shopifyService.updateOrderTags(order.shopifyOrderId, ['RTO_INITIATED']);
      } catch (e: any) {
        // ignore
      }

      await notificationEngine.sendCustomMessage(
        order,
        `Hi ${order.customerName}, delivery of your order ${order.shopifyOrderName} could not be completed and is being returned to our warehouse (RTO). If you have questions, please reach out to us.`
      );

      return { success: true, message: `Order ${order.shopifyOrderName} marked as RTO Initiated.` };
    }
  }

}

export default new OrderService();
