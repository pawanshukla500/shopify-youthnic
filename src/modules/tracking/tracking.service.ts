import prisma from '../../database/prisma';
import delhiveryService from '../delhivery/delhivery.service';
import notificationEngine from '../notifications/notification.service';
import resendService from '../email/resend.service';
import logger from '../../utils/logger';
import { config } from '../../config';
import { isDelhiveryCourier } from '../../utils/courier';
import { ShipmentStatus } from '@prisma/client';

/**
 * Tracking Service
 * Periodically pulls tracking updates from Delhivery for all active shipments.
 * When status changes, it updates the DB, triggers WhatsApp notifications,
 * and transitions the order lifecycle.
 */
class TrackingService {
  /**
   * Sync tracking for all shipments that are not yet delivered/cancelled.
   * Called by the cron scheduler.
   */
  async syncAllTracking(force = false): Promise<number> {
    // Get all active shipments (not yet delivered/cancelled/RTO).
    // CRITICAL: include CREATED and PENDING — the dispatchOrder bug fix moves
    // shipments from PENDING → CREATED on dispatch, but the cron previously
    // skipped PENDING entirely, so a shipment that just got a waybill but never
    // moved to PICKED_UP would never be polled. Including them here means a
    // shipment that has been "Label generated" for >1 cron cycle will get the
    // first tracking poll automatically.
    //
    // Resilience guards (prevent Delhivery 429 fallback on large backlogs):
    // - stale-first ordering (oldest trackingUpdatedAt first)
    // - batch cap via TRACKING_SYNC_BATCH_LIMIT (default 200)
    // - skip-fresh: ignore rows polled within TRACKING_SYNC_MIN_INTERVAL_MINUTES
    //   unless force=true (manual "Sync now" button passes force).
    const batchLimit = Math.max(1, Math.min(config.tracking.batchLimit || 200, 500));
    const minIntervalMs = (config.tracking.minIntervalMinutes || 10) * 60 * 1000;
    const staleBefore = new Date(Date.now() - minIntervalMs);

    const activeShipments = await prisma.shipment.findMany({
      where: {
        status: {
          notIn: ['DELIVERED', 'CANCELLED', 'RTO_DELIVERED', 'ERROR'],
        },
        waybillNumber: { not: null },
        // Only Delhivery shipments are tracked via the Delhivery API. Filtering
        // here (ILIKE '%delhivery%') keeps third-party couriers (Blue Dart, DTDC,
        // India Post, ...) out of the batch so their waybills never trigger the
        // Delhivery 404/not-found poll loops the cron would otherwise generate.
        courier: { contains: 'delhivery', mode: 'insensitive' },
        ...(force
          ? {}
          : {
              OR: [{ trackingUpdatedAt: null }, { trackingUpdatedAt: { lt: staleBefore } }],
            }),
      },
      include: { order: { include: { items: true } } },
      orderBy: { trackingUpdatedAt: 'asc' },
      take: batchLimit,
    });

    logger.info('Syncing tracking for active shipments', {
      count: activeShipments.length,
    });

    let updatedCount = 0;
    for (const shipment of activeShipments) {
      if (!shipment.waybillNumber) continue;
      // Defense-in-depth alongside the query filter: never hand a third-party
      // waybill to the Delhivery API, even if a legacy row slips through.
      if (!isDelhiveryCourier(shipment.courier)) continue;

      try {
        const tracking = await delhiveryService.trackShipment(shipment.waybillNumber);

        // Determine new shipment status — pass pickupDone so "Picked Up" scans and
        // PickedupDate/DispatchCount promote CREATED → PICKED_UP (pickup confirmed).
        const newShipmentStatus = delhiveryService.mapTrackingToShipmentStatus(
          tracking.statusType,
          tracking.status,
          (tracking as any).pickupDone
        ) as ShipmentStatus;

        // Check if status actually changed
        if (newShipmentStatus !== shipment.status) {
          await this.handleStatusChange(
            shipment,
            shipment.status,
            newShipmentStatus,
            tracking.status,
            tracking.location
          );
          updatedCount++;
        }

        // Save tracking history
        if (tracking.history.length > 0) {
          // Save new tracking logs
          const existingLogs = await prisma.trackingLog.findMany({
            where: { shipmentId: shipment.id },
            select: { scannedAt: true, status: true },
          });

          for (const scan of tracking.history) {
            const scanDate = new Date(scan.dateTime);
            const exists = existingLogs.some(
              (log) =>
                log.status === scan.status &&
                log.scannedAt.getTime() === scanDate.getTime()
            );

            if (!exists) {
              await prisma.trackingLog.create({
                data: {
                  shipmentId: shipment.id,
                  status: scan.status,
                  location: scan.location || null,
                  remark: scan.remark || null,
                  scannedAt: scanDate,
                },
              });
            }
          }
        }

        // Update shipment tracking fields
        await prisma.shipment.update({
          where: { id: shipment.id },
          data: {
            trackingStatus: tracking.status,
            trackingLocation: tracking.location || null,
            trackingUpdatedAt: new Date(),
            expectedDeliveryDate: this.parseExpectedDeliveryDate(tracking.expectedDeliveryDate),
            trackingHistory: tracking.history as any,
          },
        });
        await this.evaluateConsumerDelay(shipment, tracking);
      } catch (error: any) {
        logger.error('Failed to sync tracking for shipment', {
          shipmentId: shipment.id,
          waybill: shipment.waybillNumber,
          error: error.message,
        });

        await prisma.syncLog.create({
          data: {
            orderId: shipment.orderId,
            syncType: 'TRACKING_UPDATE',
            status: 'FAILED',
            message: `Tracking sync failed for ${shipment.waybillNumber}`,
            errorMessage: error.message,
          },
        });
      }
    }

    logger.info('Tracking sync complete', { updatedCount, totalShipped: activeShipments.length });
    return updatedCount;
  }

  /**
   * Handle a status change: update DB, transition order status, send notifications.
   */
  private async handleStatusChange(
    shipment: any,
    oldStatus: ShipmentStatus,
    newStatus: ShipmentStatus,
    delhiveryStatusText: string,
    location?: string
  ): Promise<void> {
    logger.info('Shipment status changed', {
      waybill: shipment.waybillNumber,
      oldStatus,
      newStatus,
      delhiveryStatusText,
    });

    // Update shipment status
    await prisma.shipment.update({
      where: { id: shipment.id },
      data: { status: newStatus },
    });

    const order = shipment.order;

    // Map shipment status → order status + notifications
    switch (newStatus) {
      case 'CREATED':
        // First poll after dispatch — Delhivery has confirmed the manifest
        // entry but the parcel hasn't been picked up yet. Just ensure the
        // order.status matches what dispatchOrder already wrote.
        if (order.status === 'DISPATCH_PENDING') {
          await prisma.order.update({
            where: { id: order.id },
            data: { status: 'DISPATCHED' },
          });
        } else if (['SHIPPED', 'IN_TRANSIT'].includes(order.status)) {
          // Correction: DB overstated pickup (e.g. legacy NOT-PICKED→FAILED or
          // default→IN_TRANSIT) while courier still reports Manifested.
          // Move back to DISPATCHED so Ready-to-ship shows "awaiting pickup".
          await prisma.order.update({
            where: { id: order.id },
            data: { status: 'DISPATCHED' },
          });
          logger.info('Corrected overstated pickup — courier still Manifested', {
            waybill: shipment.waybillNumber,
            fromOrderStatus: order.status,
          });
        }
        break;

      case 'PICKED_UP':
        await prisma.order.update({
          where: { id: order.id },
          data: { status: 'SHIPPED' },
        });
        break;

      case 'IN_TRANSIT':
        await prisma.order.update({
          where: { id: order.id },
          data: { status: 'IN_TRANSIT' },
        });
        break;

      case 'OUT_FOR_DELIVERY':
        await prisma.order.update({
          where: { id: order.id },
          data: { status: 'OUT_FOR_DELIVERY' },
        });
        await notificationEngine.notifyOutForDelivery(order);
        break;

      case 'DELIVERED':
        await prisma.order.update({
          where: { id: order.id },
          data: { status: 'DELIVERED' },
        });
        // The courier collects the cash at delivery, so a delivered COD
        // shipment's COD amount is now "collected" and awaiting remittance
        // from Delhivery (Finances > Remittance in the Delhivery panel).
        if (
          shipment.paymentMode === 'COD' &&
          (shipment.codAmount || 0) > 0 &&
          !shipment.codCollected
        ) {
          await prisma.shipment.update({
            where: { id: shipment.id },
            data: { codCollected: true, codCollectedAt: new Date() },
          });
          logger.info('COD marked collected on delivery', {
            waybill: shipment.waybillNumber,
            codAmount: shipment.codAmount,
          });
        }
        await notificationEngine.notifyDelivered(order);
        break;

      case 'FAILED':
        await prisma.order.update({
          where: { id: order.id },
          data: { status: 'FAILED_DELIVERY' },
        });
        await notificationEngine.notifyNDR(
          order,
          `Delivery attempt failed at ${location || 'location unknown'}. Status: ${delhiveryStatusText}`
        );
        break;

      case 'RTO':
        await prisma.order.update({
          where: { id: order.id },
          data: { status: 'RTO_INITIATED' },
        });
        await notificationEngine.sendCustomMessage(
          order,
          `Hi ${order.customerName}, your order ${order.shopifyOrderName} is being returned to us (RTO initiated). If you'd like to re-attempt delivery, please contact us.`
        );
        break;

      case 'RTO_DELIVERED':
        try {
          const orderService = (await import('../orders/order.service')).default;
          await orderService.processRtoRefund(order.id);
        } catch (rtoErr: any) {
          logger.error('Failed to auto-process RTO refund during tracking update', { error: rtoErr.message });
          await prisma.order.update({
            where: { id: order.id },
            data: { status: 'RTO_DELIVERED' },
          });
        }
        break;
    }

    // Record sync log
    await prisma.syncLog.create({
      data: {
        orderId: order.id,
        syncType: 'TRACKING_UPDATE',
        status: 'SUCCESS',
        message: `Shipment ${shipment.waybillNumber} status changed from ${oldStatus} to ${newStatus} (${delhiveryStatusText})`,
      },
    });
  }

  /**
   * Track a single shipment by waybill number (manual lookup).
   */
  async trackShipment(waybillNumber: string): Promise<any> {
    const tracking = await delhiveryService.trackShipment(waybillNumber);
    return tracking;
  }

  /**
   * Sync tracking live from Delhivery for a single shipment (by shipment ID or waybill number),
   * updating DB fields, recording tracking logs, and triggering status transitions/notifications.
   */
  async syncShipmentTracking(identifier: string | number): Promise<any> {
    const isNumericId =
      typeof identifier === 'number' || (/^\d+$/.test(String(identifier)) && String(identifier).length < 10);
    const shipment = await prisma.shipment.findFirst({
      where: isNumericId
        ? { id: Number(identifier) }
        : { waybillNumber: String(identifier) },
      include: { order: { include: { items: true } } },
    });

    if (!shipment || !shipment.waybillNumber) {
      logger.warn('Cannot sync tracking: shipment or waybill not found', { identifier });
      return null;
    }

    if (!isDelhiveryCourier(shipment.courier)) {
      logger.info('Skipping non-Delhivery shipment tracking', {
        courier: shipment.courier,
        waybill: shipment.waybillNumber,
      });
      return {
        shipment,
        tracking: {
          status: shipment.status,
          courier: shipment.courier,
          waybill: shipment.waybillNumber,
          isThirdParty: true,
          history: [],
        },
      };
    }

    const tracking = await delhiveryService.trackShipment(shipment.waybillNumber);
    const newShipmentStatus = delhiveryService.mapTrackingToShipmentStatus(
      tracking.statusType,
      tracking.status,
      (tracking as any).pickupDone
    ) as ShipmentStatus;

    if (newShipmentStatus !== shipment.status) {
      await this.handleStatusChange(
        shipment,
        shipment.status,
        newShipmentStatus,
        tracking.status,
        tracking.location
      );
    }

    if (tracking.history && tracking.history.length > 0) {
      const existingLogs = await prisma.trackingLog.findMany({
        where: { shipmentId: shipment.id },
        select: { scannedAt: true, status: true },
      });

      for (const scan of tracking.history) {
        const scanDate = new Date(scan.dateTime);
        const exists = existingLogs.some(
          (log) => log.status === scan.status && log.scannedAt.getTime() === scanDate.getTime()
        );

        if (!exists) {
          try {
            await prisma.trackingLog.create({
              data: {
                shipmentId: shipment.id,
                status: scan.status,
                location: scan.location || null,
                remark: scan.remark || null,
                scannedAt: scanDate,
              },
            });
          } catch (logErr) {
            // ignore unique/microsecond collision
          }
        }
      }
    }

    const updatedShipment = await prisma.shipment.update({
      where: { id: shipment.id },
      data: {
        trackingStatus: tracking.status,
        trackingLocation: tracking.location || null,
        trackingUpdatedAt: new Date(),
        expectedDeliveryDate: this.parseExpectedDeliveryDate(tracking.expectedDeliveryDate),
        trackingHistory: tracking.history as any,
      },
      include: {
        order: true,
        trackingLogs: {
          orderBy: { scannedAt: 'desc' },
        },
      },
    });
    await this.evaluateConsumerDelay(shipment, tracking);

    return {
      shipment: updatedShipment,
      tracking,
    };
  }

  /**
   * Send a consumer email for a courier-reported delay or an overdue expected
   * delivery date. A 24-hour per-order cooldown avoids duplicate emails during
   * the frequent tracking polling cycle while still allowing a later update.
   */
  /**
   * Evaluate a Delhivery update and immediately notify the consumer when it
   * reports a route delay or missed ETA. Used by both polling and webhooks.
   */
  async evaluateConsumerDelay(shipment: any, tracking: any): Promise<void> {
    const order = shipment.order;
    if (!order?.customerEmail) return;

    const expectedDelivery = tracking.expectedDeliveryDate
      ? new Date(tracking.expectedDeliveryDate)
      : null;
    const overdueExpectedDelivery = Boolean(
      expectedDelivery && !Number.isNaN(expectedDelivery.getTime()) && expectedDelivery < new Date()
    );
    const courierUpdate = [
      tracking.status,
      tracking.remarks,
      ...((tracking.history || []).slice(-3).flatMap((scan: any) => [scan.status, scan.remark])),
    ]
      .filter(Boolean)
      .join(' ');
    const courierReportedDelay =
      /\b(delay(?:ed)?|exception|hold|held|misrout(?:e|ed|ing)|network|weather|operational|undelivered|failed|not delivered|customer unavailable|address issue)\b/i.test(
        courierUpdate
      );

    if (!courierReportedDelay && !overdueExpectedDelivery) return;

    try {
      const cooldownStart = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const recentNotice = await prisma.emailLog.findFirst({
        where: {
          orderId: order.id,
          templateType: 'TRANSIT_DELAY',
          status: { in: ['PENDING', 'SENT', 'SIMULATED'] },
          createdAt: { gte: cooldownStart },
        },
        select: { id: true },
      });
      if (recentNotice) return;

      const delayReason = courierReportedDelay
        ? tracking.remarks || tracking.status || 'A Delhivery transit exception was reported.'
        : 'The courier has not delivered by the expected delivery date.';
      await resendService.sendEmail({
        to: order.customerEmail,
        templateType: 'TRANSIT_DELAY',
        orderId: order.id,
        data: {
          orderName: order.shopifyOrderName,
          customerName: order.customerName,
          recipientEmail: order.customerEmail,
          waybillNumber: shipment.waybillNumber,
          courier: shipment.courier || 'Delhivery Express',
          currentLocation: tracking.location || shipment.trackingLocation || 'Delhivery transit network',
          delayReason,
          newEstimatedDelivery: expectedDelivery
            ? expectedDelivery.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
            : 'Expected in 2-3 business days',
          items: order.items?.map((item: any) => ({
            title: item.title,
            variantTitle: item.variantTitle,
            quantity: item.quantity,
            price: item.price,
            imageUrl: item.imageUrl,
          })),
          totalAmount: order.totalAmount,
          paymentMethod: order.paymentMethod,
        },
      });
      logger.info('Sent consumer transit-delay notice', {
        orderId: order.id,
        waybill: shipment.waybillNumber,
        overdueExpectedDelivery,
      });
    } catch (error: any) {
      // Customer communications must never prevent tracking persistence.
      logger.error('Failed to send consumer transit-delay notice', {
        orderId: order.id,
        waybill: shipment.waybillNumber,
        error: error.message,
      });
    }
  }

  private parseExpectedDeliveryDate(value: unknown): Date | null {
    if (!value) return null;
    const expectedDeliveryDate = new Date(String(value));
    return Number.isNaN(expectedDeliveryDate.getTime()) ? null : expectedDeliveryDate;
  }
}

export default new TrackingService();

