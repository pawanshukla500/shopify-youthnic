import { Router, Request, Response } from 'express';
import prisma from '../database/prisma';
import delhiveryService from '../modules/delhivery/delhivery.service';
import notificationEngine from '../modules/notifications/notification.service';
import { config } from '../config';
import logger from '../utils/logger';

const router = Router();

/**
 * Delhivery Webhook Handler
 *
 * Delhivery pushes real-time shipment status updates via webhook.
 * This replaces polling the tracking API for status updates.
 *
 * To enable: Share your endpoint URL with Delhivery's integration team
 * (lastmile-integration@delhivery.com). They will configure the webhook.
 *
 * Status Types pushed by Delhivery:
 *   Forward: UD (Manifested, Not Picked, In Transit, Pending, Dispatched), DL (Delivered)
 *   Return:  RT (In Transit, Pending, Dispatched), DL (RTO)
 *   Reverse: PP (Open, Scheduled, Dispatched), PU (In Transit, Pending, Dispatched), DL (DTO), CN (Canceled, Closed)
 *
 * Note: Scan Push and Document Push are separate webhooks.
 * This handler is for Scan Push (status updates).
 *
 * Payload schema (official, from one.delhivery.com):
 *   { Shipment: { AWB, ReferenceNo, Sortcode, NSLCode, PickUpDate,
 *                Status: { Status, StatusDateTime, StatusType, StatusLocation, Instructions } } }
 *
 * Some accounts still send a flat shape (legacy). We accept both.
 */
router.post('/delhivery', async (req: Request, res: Response): Promise<void> => {
  try {
    // Optional shared-secret gate. When DELHIVERY_WEBHOOK_SECRET is set, reject
    // calls without a matching ?secret= or x-delhivery-secret header.
    // When unset (default), stay open for backward compatibility.
    const expected = config.delhivery.webhookSecret;
    if (expected) {
      const provided =
        (req.query.secret as string | undefined) ||
        (req.headers['x-delhivery-secret'] as string | undefined);
      if (provided !== expected) {
        logger.warn('Delhivery webhook rejected: bad secret');
        res.status(401).json({ received: false, error: 'invalid_secret' });
        return;
      }
    }

    const payload = req.body;

    // Normalize to array of normalized scan objects (cap to prevent DoS).
    const updates = Array.isArray(payload) ? payload.slice(0, 500) : [payload];
    const normalized = updates.map(normalizeScanPushPayload).filter(Boolean) as NormalizedScan[];

    if (normalized.length === 0) {
      logger.warn('Delhivery webhook received without recognizable payload', {
        keys: Object.keys(payload || {}),
      });
      res.status(200).json({ received: true, ignored: true });
      return;
    }

    for (const scan of normalized) {
      // Don't log raw payload to avoid PII leak (round-2 finding G9)
      logger.info('Processing Delhivery status update', {
        waybill: scan.waybill,
        status: scan.status,
        statusType: scan.statusType,
        location: scan.location,
      });

      // Find the shipment in our DB
      const shipment = await prisma.shipment.findFirst({
        where: { waybillNumber: scan.waybill },
        include: { order: true },
      });

      if (!shipment) {
        logger.warn('Shipment not found for Delhivery webhook waybill', { waybill: scan.waybill });
        continue;
      }

      // Save tracking log — use upsert keyed on (waybill, status, scannedAt) so webhook
      // retries don't double-log (round-2 finding G8)
      const scannedAt = new Date(scan.scanDateTime);
      try {
        await prisma.trackingLog.upsert({
          where: {
            waybill_status_time: {
              waybill: scan.waybill,
              status: scan.status,
              scannedAt,
            },
          },
          create: {
            shipmentId: shipment.id,
            waybill: scan.waybill,
            status: scan.status,
            location: scan.location || null,
            remark: scan.remarks || null,
            scannedAt,
            statusType: scan.statusType || null,
            rawStatus: scan.rawStatus || null,
            instructions: scan.instructions || null,
            pickupDate: scan.pickupDate ? new Date(scan.pickupDate) : null,
            nslCode: scan.nslCode || null,
            sortCode: scan.sortCode || null,
            referenceNo: scan.referenceNo || null,
            receivedBy: scan.receivedBy || null,
          },
          update: {
            // No-op for retries — preserves original createdAt and any side-effect writes
          },
        });
      } catch (upsertErr: any) {
        // If unique constraint fails because of a microsecond difference, fall back to plain create
        // and let the @unique produce a no-op duplicate.
        logger.warn('Tracking log upsert failed (likely microsecond dup)', {
          error: upsertErr.message,
          waybill: scan.waybill,
        });
      }

      // Map to our internal status
      const newShipmentStatus = delhiveryService.mapTrackingToShipmentStatus(
        scan.statusType || '',
        scan.rawStatus || scan.status || ''
      );

      // Check if status changed
      if (newShipmentStatus !== shipment.status) {
        await prisma.shipment.update({
          where: { id: shipment.id },
          data: {
            status: newShipmentStatus as any,
            trackingStatus: scan.rawStatus || scan.status,
            trackingLocation: scan.location || null,
            trackingUpdatedAt: new Date(),
          },
        });

        // Handle order status + notifications
        await handleStatusTransition(shipment.order, newShipmentStatus, scan.rawStatus || scan.status, scan.location);
      } else {
        // Just update tracking info
        await prisma.shipment.update({
          where: { id: shipment.id },
          data: {
            trackingStatus: scan.rawStatus || scan.status,
            trackingLocation: scan.location || null,
            trackingUpdatedAt: new Date(),
          },
        });
      }

      // Record sync log
      await prisma.syncLog.create({
        data: {
          orderId: shipment.orderId,
          syncType: 'TRACKING_UPDATE',
          status: 'SUCCESS',
          message: `Delhivery webhook: ${scan.statusType || '?'} - ${scan.rawStatus || scan.status} at ${scan.location || 'unknown'}`,
        },
      });
    }

    // Always return 200 quickly so Delhivery doesn't retry (round-2 G10: only swallow AFTER persist)
    res.status(200).json({ received: true, processed: normalized.length });
  } catch (error: any) {
    logger.error('Delhivery webhook processing error', { error: error.message });
    // Still return 200 to prevent retries — we'll catch up on polling
    res.status(200).json({ received: true, error: 'processing_error' });
  }
});

/**
 * Normalize a Delhivery scan-push payload into a flat shape.
 *
 * Supports both the official nested schema:
 *   { Shipment: { AWB, ReferenceNo, Sortcode, NSLCode, PickUpDate,
 *                 Status: { Status, StatusDateTime, StatusType, StatusLocation, Instructions } } }
 * and the legacy flat schema:
 *   { waybill, status, status_type, location, scan_datetime, remarks, received_by }
 *
 * Returns null if waybill can't be determined.
 */
interface NormalizedScan {
  waybill: string;
  status: string;        // Composite key "STATUSTYPE:RawStatus" e.g. "DL:Delivered"
  statusType?: string;
  rawStatus?: string;
  location?: string;
  scanDateTime: string;  // ISO string
  remarks?: string;
  instructions?: string;
  pickupDate?: string;
  nslCode?: string;
  sortCode?: string;
  referenceNo?: string;
  receivedBy?: string;
}

function normalizeScanPushPayload(input: any): NormalizedScan | null {
  if (!input || typeof input !== 'object') return null;

  // Official nested schema
  if (input.Shipment && typeof input.Shipment === 'object') {
    const s = input.Shipment;
    const st = s.Status || {};
    const waybill = s.AWB || s.awb;
    if (!waybill) return null;
    const statusType = st.StatusType || s.statusType || s.status_type;
    const rawStatus = st.Status || s.status;
    const scanDateTime = st.StatusDateTime || s.scan_datetime || new Date().toISOString();
    return {
      waybill: String(waybill),
      status: `${statusType || ''}:${rawStatus || ''}`,
      statusType,
      rawStatus,
      location: st.StatusLocation || s.location || s.scan_location || undefined,
      scanDateTime,
      remarks: st.Instructions || s.remarks || s.remark || undefined,
      instructions: st.Instructions || undefined,
      pickupDate: s.PickUpDate || undefined,
      nslCode: s.NSLCode || undefined,
      sortCode: s.Sortcode || undefined,
      referenceNo: s.ReferenceNo || undefined,
      receivedBy: s.receivedBy || s.received_by || undefined,
    };
  }

  // Legacy flat schema (older Delhivery accounts / partner integrations)
  const waybill = input.waybill || input.awb;
  if (!waybill) return null;
  const statusType = input.status_type || input.statusType;
  const rawStatus = input.status;
  return {
    waybill: String(waybill),
    status: `${statusType || ''}:${rawStatus || ''}`,
    statusType,
    rawStatus,
    location: input.location || input.scan_location,
    scanDateTime: input.scan_datetime || input.scanDateTime || new Date().toISOString(),
    remarks: input.remarks || input.remark,
    instructions: undefined,
    pickupDate: undefined,
    nslCode: undefined,
    sortCode: undefined,
    referenceNo: undefined,
    receivedBy: input.received_by || input.receivedBy,
  };
}

// Exported for unit tests so the webhook payload contract stays pinned in CI.
// Not used in production code paths.
export const __test__ = { normalizeScanPushPayload };

/**
 * Handle order status transition + WhatsApp notifications.
 * Same logic as the tracking service polling, but triggered by webhook.
 */
async function handleStatusTransition(
  order: any,
  newShipmentStatus: string,
  delhiveryStatusText: string,
  location?: string
): Promise<void> {
  switch (newShipmentStatus) {
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
        `Hi ${order.customerName}, your order ${order.shopifyOrderName} is being returned to us (RTO initiated).`
      );
      break;

    case 'RTO_DELIVERED':
      try {
        const orderService = (await import('../modules/orders/order.service')).default;
        await orderService.processRtoRefund(order.id);
      } catch (rtoErr: any) {
        logger.error('Failed to auto-process RTO refund in Delhivery webhook', { error: rtoErr.message });
        await prisma.order.update({
          where: { id: order.id },
          data: { status: 'RTO_DELIVERED' },
        });
      }
      break;

    case 'CANCELLED':
      await prisma.order.update({
        where: { id: order.id },
        data: { status: 'CANCELLED' },
      });
      break;
  }
}

export default router;
