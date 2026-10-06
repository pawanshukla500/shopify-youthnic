import prisma from '../../database/prisma';
import delhiveryService from '../delhivery/delhivery.service';
import notificationEngine from '../notifications/notification.service';
import returnService from '../returns/return.service';
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
        waybillNumber: { not: null },
        // Live shipments, plus ERROR rows that still hold a reserved waybill
        // from a rejected manifest (low wallet). Those must be checked once:
        // if Delhivery has no package, the number is dropped and the order
        // returns to Ready to Dispatch.
        AND: [
          {
            OR: [
              {
                status: { notIn: ['DELIVERED', 'CANCELLED', 'RTO_DELIVERED', 'ERROR'] },
                courier: { contains: 'delhivery', mode: 'insensitive' },
              },
              {
                status: 'ERROR',
                OR: [
                  { courier: null },
                  { courier: { contains: 'delhivery', mode: 'insensitive' } },
                ],
              },
            ],
          },
          ...(force
            ? []
            : [{ OR: [{ trackingUpdatedAt: null }, { trackingUpdatedAt: { lt: staleBefore } }] }]),
        ],
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
      // ERROR rows from a rejected manifest often have a blank courier; a
      // numeric Delhivery-style waybill is still ours to verify.
      const ours = isDelhiveryCourier(shipment.courier, shipment.labelUrl, shipment.waybillNumber);
      if (!ours && shipment.status !== 'ERROR') continue;
      if (shipment.status === 'ERROR' && shipment.courier && !ours) continue;

      try {
        const tracking = await delhiveryService.trackShipment(shipment.waybillNumber);

        // Reserved AWB from a failed manifest: Delhivery tracking has no package.
        // Drop the number and put the order back in Ready to Dispatch.
        // Cancel and RTO orders are left on their own tabs.
        if (shipment.status === 'ERROR' && this.isMissingDelhiveryPackage(tracking)) {
          await this.releaseUnmanifestedWaybill(shipment);
          updatedCount++;
          continue;
        }

        // Determine new shipment status — pass pickupDone so "Picked Up" scans and
        // PickedupDate/DispatchCount promote CREATED → PICKED_UP (pickup confirmed).
        const newShipmentStatus = delhiveryService.mapTrackingToShipmentStatus(
          tracking.statusType,
          tracking.status,
          (tracking as any).pickupDone,
          tracking.remarks
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
            // A live package means the earlier wallet/manifest error is stale.
            ...(shipment.status === 'ERROR' ? { errorMessage: null, courier: shipment.courier || 'Delhivery' } : {}),
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

    try {
      const returnsUpdated = await returnService.syncActiveReturns(force);
      updatedCount += returnsUpdated;
    } catch (err: any) {
      logger.error('Reverse tracking sync failed', { error: err.message });
    }

    logger.info('Tracking sync complete', { updatedCount, totalShipped: activeShipments.length });
    return updatedCount;
  }

  /** Delhivery returned no package for this waybill (reserved, never manifested). */
  private isMissingDelhiveryPackage(tracking: { status?: string; history?: unknown[] } | null): boolean {
    if (!tracking) return true;
    const status = (tracking.status || '').trim().toUpperCase();
    const history = Array.isArray(tracking.history) ? tracking.history : [];
    if (status === 'UNKNOWN') return true;
    return !status && history.length === 0;
  }

  /**
   * The carrier id was only reserved. Delhivery tracking has no shipment, so
   * the order goes back to Ready to Dispatch. Cancel, RTO, and delivered stay put.
   */
  private async releaseUnmanifestedWaybill(shipment: any): Promise<void> {
    logger.info('Reserved waybill is not a Delhivery shipment — returning order to Ready to Dispatch', {
      waybill: shipment.waybillNumber,
      orderId: shipment.orderId,
    });
    await prisma.shipment.update({
      where: { id: shipment.id },
      data: {
        waybillNumber: null,
        labelUrl: null,
        trackingStatus: 'Not manifested',
        trackingUpdatedAt: new Date(),
        status: 'ERROR',
        errorMessage:
          shipment.errorMessage ||
          'Delhivery did not create this shipment (manifest rejected, often a low prepaid wallet). The reserved waybill is not trackable.',
      },
    });
    const orderStatus = shipment.order?.status as string | undefined;
    const leaveAsIs = [
      'CANCELLED',
      'RTO_INITIATED',
      'RTO_DELIVERED',
      'RETURN_REQUESTED',
      'RETURN_DISPATCHED',
      'RETURN_RECEIVED',
      'DELIVERED',
      'REFUNDED',
    ];
    if (orderStatus && !leaveAsIs.includes(orderStatus)) {
      await prisma.order.update({
        where: { id: shipment.orderId },
        data: { status: 'DISPATCH_PENDING' },
      });
    }
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
        await notificationEngine.notifyInTransit?.(
          order,
          shipment.waybillNumber || undefined,
          location
        );
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
    let live: any = null;
    let liveError: string | null = null;
    try {
      live = await delhiveryService.trackShipment(waybillNumber);
    } catch (error: any) {
      liveError = error.message || 'Delhivery tracking request failed';
      logger.warn('Live Delhivery tracking failed, trying stored scans', {
        waybillNumber,
        error: liveError,
      });
    }

    const stored = await this.loadStoredTracking(waybillNumber);
    const liveUsable =
      live &&
      ((Array.isArray(live.history) && live.history.length > 0) ||
        (live.status && live.status !== 'UNKNOWN'));

    if (liveUsable) {
      const liveHistory = Array.isArray(live.history) ? live.history : [];
      const storedHistory = stored?.history || [];
      const history = liveHistory.length > 0 ? liveHistory : storedHistory;
      return {
        ...live,
        history,
        source: 'delhivery',
        storedScanCount: storedHistory.length,
      };
    }

    if (stored) {
      return {
        ...stored,
        liveError,
        source: 'stored',
      };
    }

    if (live) return { ...live, source: 'delhivery', liveError };
    throw new Error(liveError || `No tracking found for ${waybillNumber}`);
  }

  /**
   * Scans already saved by the scan-push webhook or a previous poll.
   * Used when the live Delhivery API is down or returns an empty payload.
   */
  private async loadStoredTracking(waybillNumber: string): Promise<any | null> {
    const shipment = await prisma.shipment.findFirst({
      where: { waybillNumber },
      include: {
        trackingLogs: { orderBy: { scannedAt: 'desc' }, take: 80 },
        order: { select: { shopifyOrderName: true, status: true, customerName: true } },
      },
    });
    if (!shipment) return null;

    const fromLogs = (shipment.trackingLogs || []).map((log) => ({
      status: log.rawStatus || log.status,
      statusType: log.statusType || '',
      location: log.location || '',
      dateTime: log.scannedAt.toISOString(),
      date: log.scannedAt.toISOString(),
      remark: log.remark || log.instructions || undefined,
    }));

    const fromJson = Array.isArray(shipment.trackingHistory)
      ? (shipment.trackingHistory as any[]).map((scan) => ({
          status: scan.status || scan.Scan || 'SCAN',
          statusType: scan.statusType || scan.ScanType || '',
          location: scan.location || scan.ScanLocation || '',
          dateTime: scan.dateTime || scan.date || scan.ScanDateTime || null,
          date: scan.date || scan.dateTime || scan.ScanDateTime || null,
          remark: scan.remark || scan.Instructions || undefined,
        }))
      : [];

    const history = fromLogs.length > 0 ? fromLogs : fromJson;
    if (!shipment.trackingStatus && history.length === 0 && !shipment.status) return null;

    return {
      status: shipment.trackingStatus || shipment.status,
      statusType: history[0]?.statusType || '',
      location: shipment.trackingLocation || history[0]?.location || '',
      remarks: history[0]?.remark,
      history,
      waybill: waybillNumber,
      referenceNo: shipment.order?.shopifyOrderName,
      orderStatus: shipment.order?.status,
    };
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

    const ours = isDelhiveryCourier(shipment.courier, shipment.labelUrl, shipment.waybillNumber);
    if (!ours && !(shipment.status === 'ERROR' && !shipment.courier)) {
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
    if (shipment.status === 'ERROR' && this.isMissingDelhiveryPackage(tracking)) {
      await this.releaseUnmanifestedWaybill(shipment);
      const released = await prisma.shipment.findUnique({
        where: { id: shipment.id },
        include: { order: true },
      });
      return { shipment: released, tracking, manifestRejected: true };
    }
    const newShipmentStatus = delhiveryService.mapTrackingToShipmentStatus(
      tracking.statusType,
      tracking.status,
      (tracking as any).pickupDone,
      tracking.remarks
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
        ...(shipment.status === 'ERROR' ? { errorMessage: null, courier: shipment.courier || 'Delhivery' } : {}),
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

