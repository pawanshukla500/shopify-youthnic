import prisma from '../../database/prisma';
import { config } from '../../config';
import shopifyService from '../shopify/shopify.service';
import delhiveryService from '../delhivery/delhivery.service';
import notificationEngine from '../notifications/notification.service';
import paymentService from '../payments/payment.service';
import logger from '../../utils/logger';
import { Order } from '@prisma/client';
import { ShopifyOrderWebhook } from '../../types';

/**
 * Order Service
 * Orchestrates the full order lifecycle:
 *   NEW → DISPATCH_PENDING → DISPATCHED → SHIPPED → IN_TRANSIT → OUT_FOR_DELIVERY → DELIVERED
 * Each transition triggers appropriate WhatsApp notifications.
 *
 * Operational tabs (Orders page). Ready is split by AWB so the warehouse sees
 * two distinct queues (verified 2026-09-28: 9 no-AWB + 9 label-ready = 18):
 *   new: NEW (fresh, needs confirmation/payment verify)
 *   dispatch: DISPATCH_PENDING/DISPATCHED WITHOUT waybill (needs Dispatch click → AWB+label)
 *   ready: DISPATCH_PENDING/DISPATCHED WITH waybill (label generated, awaiting courier pickup)
 *   transit: SHIPPED, IN_TRANSIT, OUT_FOR_DELIVERY, FAILED_DELIVERY (NDR still in transit loop)
 *   delivered: DELIVERED
 *   return: RTO_INITIATED, RTO_DELIVERED, RETURN_REQUESTED, RETURN_DISPATCHED, RETURN_RECEIVED, REFUNDED
 *   cancel: CANCELLED
 */
export const ORDER_TABS = {
  new: ['NEW'],
  dispatch: ['DISPATCH_PENDING', 'DISPATCHED'],
  ready: ['DISPATCH_PENDING', 'DISPATCHED'],
  transit: ['SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'FAILED_DELIVERY'],
  delivered: ['DELIVERED'],
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

export type OrderTab = keyof typeof ORDER_TABS | 'all';

/** dispatch tab = no AWB yet; ready tab = label generated (AWB assigned). */
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
      include: { items: true },
    });

    if (!order) {
      throw new Error(`Order not found: ${orderId}`);
    }

    if (order.status !== 'NEW' && order.status !== 'DISPATCH_PENDING') {
      throw new Error(`Order ${order.shopifyOrderName} is not in dispatchable state (current: ${order.status})`);
    }

    // Shopify already marks this order fulfilled, so a Delhivery shipment here
    // would ship goods that are already out (or were never meant to be). This
    // catches both historic imports and orders fulfilled through another path.
    if (order.fulfillmentStatus === 'fulfilled') {
      throw new Error(
        `Order ${order.shopifyOrderName} is already fulfilled on Shopify and cannot be dispatched again`
      );
    }

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

    // Create shipment on Delhivery
    const result = await delhiveryService.createShipment(verifiedOrder, {
      itemCount: verifiedOrder.items?.length ?? 1,
    });

    // Promote the order + shipment out of their pre-dispatch states so the
    // UI stops showing "Dispatch Pending". Without these updates the row
    // would stay on the yellow badge forever even though Delhivery has the
    // shipment. Pre-PR #10 round-2 finding (round-2 audit G3 was about EPOD
    // webhook gaps; this is the same class of bug for the dispatch flow).
    await prisma.$transaction([
      prisma.shipment.update({
        where: { orderId: order.id },
        data: { status: 'CREATED', trackingStatus: 'Label generated', courier: 'Delhivery' },
      }),
      prisma.order.update({
        where: { id: order.id },
        data: { status: 'DISPATCHED', dispatchedAt: new Date() },
      }),
    ]);

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
      where: { status: 'NEW' },
      include: { shipment: true },
    });

    let dispatchedCount = 0;
    let skippedFulfilled = 0;
    for (const order of pendingOrders) {
      // Skip if shipment already exists
      if (order.shipment) {
        logger.info('Order already has a shipment, skipping', { orderId: order.id });
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

    // If shipment was created, try to cancel on Delhivery
    if (order.shipment?.waybillNumber && order.shipment.status === 'CREATED') {
      await delhiveryService.cancelShipment(order.shipment.waybillNumber);
      await prisma.shipment.update({
        where: { id: order.shipment.id },
        data: { status: 'CANCELLED' },
      });
    }

    await prisma.order.update({
      where: { id: order.id },
      data: { status: 'CANCELLED' },
    });

    logger.info('Order cancelled', { shopifyOrderId, orderName: order.shopifyOrderName });
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
      // Explicit hasWaybill wins; otherwise derive from tab (dispatch=false, ready=true).
      hasWaybill = optionsOrStatus.hasWaybill ?? resolveOrderTabWaybill(tab);
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
      andConditions.push({ status: { in: ['NEW', 'DISPATCH_PENDING'] } });
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

    const tabStatuses = resolveOrderTabStatuses(tab);
    const explicitStatuses = statuses?.length ? statuses : tabStatuses;
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
      take: limit,
      skip: offset,
    });

    return orders.map((o) => this.enrichOrderMetadata(o));
  }

  /**
   * Counts per operational tab. Status-only tabs use one groupBy; the AWB-split
   * dispatch/ready tabs use two targeted counts (no full-table fetch).
   * Used for Orders page tab badges.
   */
  async getOrderTabCounts(): Promise<Record<OrderTab | 'all', number> & { byStatus: Record<string, number> }> {
    const grouped = await prisma.order.groupBy({ by: ['status'], _count: { status: true } });
    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const row of grouped) {
      byStatus[row.status] = row._count.status;
      total += row._count.status;
    }
    const countFor = (statuses: readonly string[]): number =>
      statuses.reduce((sum, s) => sum + (byStatus[s] || 0), 0);
    // AWB split for the two Ready queues (verified live split 9/9 on 2026-09-28).
    const [dispatchNoAwb, readyWithAwb] = await Promise.all([
      prisma.order.count({
        where: {
          status: { in: [...ORDER_TABS.dispatch] },
          OR: [{ shipment: null }, { shipment: { waybillNumber: null } }],
        },
      }),
      prisma.order.count({
        where: {
          status: { in: [...ORDER_TABS.ready] },
          shipment: { waybillNumber: { not: null } },
        },
      }),
    ]);
    return {
      all: total,
      new: countFor(ORDER_TABS.new),
      dispatch: dispatchNoAwb,
      ready: readyWithAwb,
      transit: countFor(ORDER_TABS.transit),
      delivered: countFor(ORDER_TABS.delivered),
      return: countFor(ORDER_TABS.return),
      cancel: countFor(ORDER_TABS.cancel),
      byStatus,
    };
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
    const isDispatchOverdue = ['NEW', 'DISPATCH_PENDING'].includes(order.status) && !hasWaybill && hoursSincePlaced > 24;
    const dispatchOverdueHours = isDispatchOverdue ? Math.round(hoursSincePlaced - 24) : 0;
    const expectedDispatchAt = order.expectedDispatchAt || new Date(new Date(order.shopifyCreatedAt).getTime() + 24 * 3600 * 1000);

    const hasNdrException =
      order.status === 'FAILED_DELIVERY' ||
      (order.shipment?.trackingStatus && /fail|attempt|undeliver/i.test(order.shipment.trackingStatus));

    const rawTags = (order.tags || '').toLowerCase();
    const isCodBlocked =
      rawTags.includes('gokwik_cod_blocking') ||
      rawTags.includes('cod_blocking') ||
      rawTags.includes('cod_cancelled') ||
      rawTags.includes('c2p-order-cancelled');
    const isCodConfirmed =
      rawTags.includes('cod_confirmed') ||
      rawTags.includes('cod confirmed') ||
      rawTags.includes('confirmed') ||
      rawTags.includes('c2p-converted') ||
      rawTags.includes('c2p-prepaid-order');

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

    // Prepaid Order: Call Shopify Refund API (routing to Easebuzz / GoKwik)
    const refundResult = await shopifyService.createRefund(
      order.shopifyOrderId,
      order.totalAmount,
      [],
      true // full refund
    );

    // Update in DB
    await prisma.order.update({
      where: { id: order.id },
      data: {
        status: 'REFUNDED',
        financialStatus: 'refunded',
      },
    });

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

    // Send customer WhatsApp notification
    try {
      await notificationEngine.sendCustomMessage(
        order,
        `Hi ${order.customerName}, your returned package for order ${order.shopifyOrderName} has been safely received at our Surat warehouse. A full refund of ₹${order.totalAmount} has been automatically processed to your original payment mode (${order.paymentProvider || order.paymentGateway || 'Prepaid'}). Refund ID: ${refundResult.refundId}.`
      );
    } catch (notifErr: any) {
      logger.warn('Failed to send refund WhatsApp notification', { error: notifErr.message });
    }

    // Record sync log
    await prisma.syncLog.create({
      data: {
        orderId: order.id,
        syncType: 'REFUND_PROCESS',
        status: 'SUCCESS',
        message: `Auto-refund of ₹${order.totalAmount} processed for RTO delivered order ${order.shopifyOrderName} (Refund ID: ${refundResult.refundId})`,
      },
    });

    return {
      success: true,
      refundId: refundResult.refundId,
      message: `Auto-refund of ₹${order.totalAmount} processed successfully for ${order.shopifyOrderName}!`,
    };
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
