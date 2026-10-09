import { Router, Request, Response } from 'express';
import { timingSafeEqual } from 'crypto';
import prisma from '../database/prisma';
import delhiveryService from '../modules/delhivery/delhivery.service';
import delhiveryDocumentFetcher from '../modules/delhivery/delhivery-document-fetcher.service';
import notificationEngine from '../modules/notifications/notification.service';
import trackingService from '../modules/tracking/tracking.service';
import { applyReturnCarrierScan } from '../modules/returns/return-tracking';
import {
  MOVING_SHIPMENT_STATUSES,
  PARCEL_MOVING_ON_CLOSED_ORDER,
  TERMINAL_SHIPMENT_STATUSES,
  deliveredShipmentData,
  isCarrierLockedOrderStatus,
  isStaleScan,
  needsRtoRefundAfterCancel,
} from '../modules/orders/order-lifecycle';
import { config } from '../config';
import logger from '../utils/logger';

const router = Router();

function secretMatches(candidate: string | undefined, expected: string): boolean {
  if (!candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Verify optional shared-secret gate.
 * When DELHIVERY_WEBHOOK_SECRET is configured, accepts ?secret=,
 * x-delhivery-secret, x-delhivery-token, or Authorization headers.
 * When unset, allows requests through for backwards compatibility. Even then
 * an open request cannot close a shipment or move money: terminal statuses are
 * confirmed with Delhivery's authenticated tracking API (confirmTerminalStatus).
 */
function verifyDelhiveryWebhookSecret(req: Request): boolean {
  const expected = config.delhivery.webhookSecret;
  if (!expected) return true;

  const querySecret = req.query.secret as string | undefined;
  const headerSecret = (req.headers['x-delhivery-secret'] || req.headers['x-delhivery-token']) as string | undefined;
  const authHeader = req.headers['authorization'] as string | undefined;
  const bearerToken = authHeader ? authHeader.replace(/^(Bearer|Token)\s+/i, '').trim() : undefined;

  return (
    secretMatches(querySecret, expected) ||
    secretMatches(headerSecret, expected) ||
    secretMatches(bearerToken, expected)
  );
}

/**
 * Pushed terminal statuses (delivered, RTO delivered, cancelled) are applied
 * only when Delhivery's authenticated tracking API reports the same. They
 * close the order, mark COD collected, stop tracking for good and can trigger
 * an automatic refund, while the push endpoint can be called by anyone who
 * knows an AWB. If the API disagrees or is down, the tracking poll decides.
 */
export async function confirmTerminalStatus(waybill: string, claimed: string): Promise<boolean> {
  try {
    const live = await delhiveryService.trackShipment(waybill);
    const actual = delhiveryService.mapTrackingToShipmentStatus(
      live.statusType,
      live.status,
      live.pickupDone,
      live.remarks
    );
    if (actual === claimed) return true;
    logger.warn('Delhivery webhook status not confirmed by the tracking API, ignored', {
      waybill,
      claimed,
      actual,
    });
    return false;
  } catch (error: any) {
    logger.warn('Could not confirm Delhivery webhook status, left for the tracking poll', {
      waybill,
      claimed,
      error: error.message,
    });
    return false;
  }
}

/**
 * Delhivery Webhook Handler - Scan Push (Status Updates)
 *
 * Delhivery pushes real-time shipment status updates via webhook.
 * Replaces continuous polling for tracking events.
 *
 * Enabled by Delhivery Last Mile Integration team (lastmile-integration@delhivery.com).
 *
 * Payload schema supports official nested shape:
 *   { Shipment: { AWB, ReferenceNo, Sortcode, NSLCode, PickUpDate,
 *                Status: { Status, StatusDateTime, StatusType, StatusLocation, Instructions } } }
 * and legacy flat shapes from various Delhivery systems.
 */
export async function handleScanPush(req: Request, res: Response): Promise<void> {
  try {
    if (!verifyDelhiveryWebhookSecret(req)) {
      logger.warn('Delhivery webhook rejected: bad secret');
      res.status(401).json({ received: false, error: 'invalid_secret' });
      return;
    }

    const updates = expandScanPushBodies(req.body).slice(0, 500);
    const normalized = updates.map(normalizeScanPushPayload).filter(Boolean) as NormalizedScan[];

    if (normalized.length === 0) {
      const payload = req.body;
      logger.warn('Delhivery scan webhook received without recognizable payload', {
        keys: payload && typeof payload === 'object' ? Object.keys(payload) : [],
      });
      res.status(200).json({ received: true, ignored: true });
      return;
    }

    for (const scan of normalized) {
      logger.info('Processing Delhivery status update', {
        waybill: scan.waybill,
        status: scan.status,
        statusType: scan.statusType,
        location: scan.location,
      });

      // Find shipment in database
      const shipment = await prisma.shipment.findFirst({
        where: { waybillNumber: scan.waybill },
        include: { order: true },
      });

      if (!shipment) {
        const scannedAt = parseScanDate(scan.scanDateTime);
        const handled = await applyReturnCarrierScan(scan.waybill, {
          statusType: scan.statusType,
          status: scan.rawStatus || scan.status,
          location: scan.location,
          remarks: scan.remarks || scan.instructions,
          scannedAt,
        });
        if (handled === 'missing') {
          logger.warn('Shipment not found for Delhivery webhook waybill', { waybill: scan.waybill });
        }
        continue;
      }

      const scannedAt = parseScanDate(scan.scanDateTime);

      // Map to internal status. Remarks/instructions carry NDR reasons that
      // the status token alone ("Pending") does not.
      const scanText = scan.rawStatus || scan.status || '';
      const newShipmentStatus = delhiveryService.mapTrackingToShipmentStatus(
        scan.statusType || '',
        scanText,
        /pick.*up|pickedup|received at origin/i.test(`${scanText} ${scan.remarks || ''}`),
        [scan.instructions, scan.remarks].filter(Boolean).join(' ')
      );

      // A scan older than one already applied is history only: it must not
      // move the shipment backwards (a late "In Transit" after "Delivered").
      const stale = isStaleScan(scannedAt, shipment.trackingHistory);
      // Delivered and RTO-delivered end the forward journey; no push reopens them.
      const finalAlready = shipment.status === 'DELIVERED' || shipment.status === 'RTO_DELIVERED';
      let applyStatus = !stale && !finalAlready && newShipmentStatus !== shipment.status;

      if (applyStatus && TERMINAL_SHIPMENT_STATUSES.has(newShipmentStatus)) {
        applyStatus = await confirmTerminalStatus(scan.waybill, newShipmentStatus);
        if (!applyStatus) {
          // Not even recorded: the order tabs read the tracking text, so an
          // unconfirmed "Delivered" would still move the order on screen.
          continue;
        }
      }

      // Save tracking log — idempotent upsert on (waybill, status, scannedAt)
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
          update: {},
        });
      } catch (upsertErr: any) {
        logger.warn('Tracking log upsert failed (likely microsecond dup)', {
          error: upsertErr.message,
          waybill: scan.waybill,
        });
      }

      const historyEntry = {
        status: scan.rawStatus || scan.status,
        statusType: scan.statusType || '',
        location: scan.location || '',
        dateTime: scannedAt.toISOString(),
        date: scannedAt.toISOString(),
        remark: scan.remarks || scan.instructions || undefined,
      };
      const previousHistory = Array.isArray(shipment.trackingHistory) ? (shipment.trackingHistory as any[]) : [];
      const trackingHistory = [
        ...previousHistory.filter(
          (row) => !(row?.status === historyEntry.status && row?.dateTime === historyEntry.dateTime)
        ),
        historyEntry,
      ].slice(-80);

      let statusApplied = false;
      if (applyStatus) {
        // Conditional on the status this request read: if the tracking cron or
        // a concurrent push moved the shipment meanwhile, this one does not
        // repeat the transition (and its customer message).
        const moved = await prisma.shipment.updateMany({
          where: { id: shipment.id, status: shipment.status },
          data: {
            status: newShipmentStatus as any,
            trackingStatus: scan.rawStatus || scan.status,
            trackingLocation: scan.location || null,
            trackingUpdatedAt: new Date(),
            trackingHistory: trackingHistory as any,
            ...(newShipmentStatus === 'DELIVERED' ? deliveredShipmentData(shipment) : {}),
          },
        });
        statusApplied = moved.count === 1;

        if (statusApplied) {
          // Trigger order status transition + notifications
          await handleStatusTransition(
            shipment.order,
            newShipmentStatus,
            scan.rawStatus || scan.status,
            scan.location,
            scan.waybill
          );
        }
      }
      if (!statusApplied) {
        await prisma.shipment.update({
          where: { id: shipment.id },
          data: {
            // A stale scan joins the history but does not replace the latest text.
            ...(stale || finalAlready
              ? {}
              : { trackingStatus: scan.rawStatus || scan.status, trackingLocation: scan.location || null }),
            trackingUpdatedAt: new Date(),
            trackingHistory: trackingHistory as any,
          },
        });
      }

      // Scan pushes arrive before the next tracking cron run. Evaluate the
      // remark now so a Delhivery delay/exception reaches the customer
      // immediately; the shared cooldown prevents a duplicate cron email.
      if (!stale && !finalAlready && !isCarrierLockedOrderStatus(shipment.order?.status)) {
        await trackingService.evaluateConsumerDelay(shipment, {
          status: scan.rawStatus || scan.status,
          statusType: scan.statusType,
          location: scan.location,
          remarks: scan.remarks || scan.instructions,
          history: [{ status: scan.status, remark: scan.remarks || scan.instructions }],
        });
      }

      // If package is delivered and EPOD is missing, trigger background document fetch
      if (statusApplied && newShipmentStatus === 'DELIVERED' && !shipment.epodStoragePath) {
        delhiveryDocumentFetcher.tryFetchArtifact(shipment.orderId, scan.waybill, 'epod').catch((docErr) => {
          logger.debug('Background EPOD fetch on DELIVERED scan failed (will retry on cron)', {
            waybill: scan.waybill,
            error: docErr.message,
          });
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

    res.status(200).json({ received: true, processed: normalized.length });
  } catch (error: any) {
    logger.error('Delhivery webhook processing error', { error: error.message });
    res.status(200).json({ received: true, error: 'processing_error' });
  }
}

/**
 * Delhivery EPOD Webhook Handler
 * Endpoint: POST /webhooks/delhivery/epod (and alias /webhooks/delhivery/pod)
 *
 * Processes Electronic Proof of Delivery (EPOD) pushed by Delhivery upon parcel delivery.
 * Stores EPOD image/PDF into Firebase Storage, updates Shipment with epodStoragePath,
 * transitions Order and Shipment to DELIVERED, and records tracking events.
 */
export async function handleEpodPush(req: Request, res: Response): Promise<void> {
  try {
    if (!verifyDelhiveryWebhookSecret(req)) {
      logger.warn('Delhivery EPOD webhook rejected: bad secret');
      res.status(401).json({ success: false, error: 'invalid_secret' });
      return;
    }

    const payload = req.body;
    const rawItems = Array.isArray(payload) ? payload.slice(0, 500) : [payload];
    const normalized = rawItems.map(normalizeEpodPayload).filter(Boolean) as NormalizedEpod[];

    if (normalized.length === 0) {
      logger.warn('Delhivery EPOD webhook received with empty or invalid payload', {
        keys: Object.keys(payload || {}),
      });
      res.status(200).json({ success: true, processed: 0, message: 'No valid EPOD records found' });
      return;
    }

    let processedCount = 0;

    for (const epod of normalized) {
      logger.info('Received Delhivery EPOD webhook record', {
        waybill: epod.waybill,
        orderId: epod.orderId,
        receivedBy: epod.receivedBy,
        hasEpodData: Boolean(epod.epodData),
      });

      // Find shipment by waybill
      let shipment = await prisma.shipment.findFirst({
        where: { waybillNumber: epod.waybill },
        include: { order: true },
      });

      // If not found by waybill, fall back to the Delhivery reference number,
      // which is our Shopify order name/id. Never our internal row id: those
      // are sequential, so a caller could walk every order.
      if (!shipment && epod.orderId) {
        const order = await prisma.order.findFirst({
          where: {
            OR: [
              { shopifyOrderId: String(epod.orderId) },
              { shopifyOrderName: String(epod.orderId).startsWith('#') ? String(epod.orderId) : `#${epod.orderId}` },
            ],
          },
          include: { shipment: true },
        });
        if (order?.shipment) {
          shipment = { ...order.shipment, order } as any;
        }
      }

      if (!shipment) {
        logger.warn('Shipment not found for EPOD webhook waybill', {
          waybill: epod.waybill,
          orderId: epod.orderId,
        });
        continue;
      }

      // An EPOD marks the order delivered and downloads the pushed image, so it
      // is acted on only when Delhivery's tracking API confirms the delivery of
      // our own AWB. The document fetcher cron backfills EPODs it skips.
      const ourWaybill = shipment.waybillNumber || epod.waybill;
      if (shipment.status !== 'DELIVERED' && !(await confirmTerminalStatus(ourWaybill, 'DELIVERED'))) {
        continue;
      }

      // If EPOD image or URL is provided, save artifact to Firebase Storage
      let artifactSaved = false;
      if (epod.epodData) {
        const saveRes = await delhiveryDocumentFetcher.saveEpodArtifact(
          shipment.orderId,
          epod.waybill,
          epod.epodData,
          epod.receivedBy,
          epod.receivedAt
        );
        artifactSaved = saveRes.uploaded;
      }

      // If payload had no image data or saving failed, fall back to REST download
      if (!artifactSaved && !shipment.epodStoragePath) {
        delhiveryDocumentFetcher.tryFetchArtifact(shipment.orderId, epod.waybill, 'epod').catch((err) => {
          logger.debug('Fallback REST EPOD download scheduled', {
            waybill: epod.waybill,
            error: err.message,
          });
        });
      }

      // EPOD receipt is conclusive proof of delivery — transition to DELIVERED
      if (shipment.status !== 'DELIVERED') {
        const moved = await prisma.shipment.updateMany({
          where: { id: shipment.id, status: shipment.status },
          data: {
            status: 'DELIVERED',
            trackingStatus: 'Delivered (EPOD Verified)',
            trackingUpdatedAt: new Date(),
            ...(epod.receivedBy ? { epodReceivedBy: epod.receivedBy } : {}),
            epodReceivedAt: epod.receivedAt || new Date(),
            ...deliveredShipmentData(shipment),
          },
        });

        // Only the writer that moved the shipment sends the "Delivered" message;
        // a scan push for the same delivery may have got there first.
        if (moved.count === 1 && shipment.order && shipment.order.status !== 'DELIVERED') {
          await handleStatusTransition(
            shipment.order,
            'DELIVERED',
            'Delivered (EPOD Verified)',
            shipment.trackingLocation || undefined
          );
        }
      } else if (epod.receivedBy && !shipment.epodReceivedBy) {
        // Update consignee name if not present
        await prisma.shipment.update({
          where: { id: shipment.id },
          data: {
            epodReceivedBy: epod.receivedBy,
            epodReceivedAt: epod.receivedAt || shipment.epodReceivedAt || new Date(),
          },
        });
      }

      // Log tracking history. Delhivery retries pushes; a repeat of the same
      // EPOD must not throw and abort the rest of the batch.
      const epodScannedAt = epod.receivedAt || new Date();
      await prisma.trackingLog.upsert({
        where: {
          waybill_status_time: { waybill: epod.waybill, status: 'EPOD_RECEIVED', scannedAt: epodScannedAt },
        },
        create: {
          shipmentId: shipment.id,
          waybill: epod.waybill,
          status: 'EPOD_RECEIVED',
          location: shipment.trackingLocation || 'Delivered Location',
          remark: `Electronic Proof of Delivery (EPOD) confirmed from Delhivery${
            epod.receivedBy ? `. Received by: ${epod.receivedBy}` : ''
          }`,
          scannedAt: epodScannedAt,
          receivedBy: epod.receivedBy || null,
        },
        update: {},
      });

      // Record SyncLog
      await prisma.syncLog.create({
        data: {
          orderId: shipment.orderId,
          syncType: 'TRACKING_UPDATE',
          status: 'SUCCESS',
          message: `Delhivery EPOD received for AWB ${epod.waybill}${
            epod.receivedBy ? ` (Received by: ${epod.receivedBy})` : ''
          }`,
        },
      });

      processedCount++;
    }

    res.status(200).json({
      success: true,
      message: 'EPOD processed successfully',
      processed: processedCount,
    });
  } catch (err: any) {
    logger.error('Error handling Delhivery EPOD webhook', { error: err.message });
    res.status(200).json({ success: true, warning: 'Processed with warnings', error: err.message });
  }
}

/**
 * Delhivery QC Image Webhook Handler
 * Endpoint: POST /webhooks/delhivery/qc-image
 */
export async function handleQcImagePush(req: Request, res: Response): Promise<void> {
  try {
    if (!verifyDelhiveryWebhookSecret(req)) {
      res.status(401).json({ success: false, error: 'invalid_secret' });
      return;
    }

    const { waybillId, returnId, Image, image, waybill } = req.body || {};
    const effectiveWaybill = waybillId || waybill || returnId;
    const effectiveImage = Image || image;

    logger.info('Received Delhivery QC Image webhook', {
      waybill: effectiveWaybill,
      hasImage: Boolean(effectiveImage),
    });

    if (effectiveWaybill) {
      const returnRecord = await prisma.return.findFirst({
        where: { returnWaybillNumber: String(effectiveWaybill) },
      });

      if (returnRecord && effectiveImage) {
        delhiveryDocumentFetcher.tryFetchArtifact(returnRecord.orderId, String(effectiveWaybill), 'qc').catch(() => {});
      }
    }

    res.status(200).json({ success: true, message: 'QC Image received successfully' });
  } catch (err: any) {
    logger.error('Error handling Delhivery QC Image webhook', { error: err.message });
    res.status(200).json({ success: true, warning: 'Processed with warnings' });
  }
}

/**
 * Delhivery Sorter Image Webhook Handler
 * Endpoint: POST /webhooks/delhivery/sorter-image
 */
export async function handleSorterImagePush(req: Request, res: Response): Promise<void> {
  try {
    if (!verifyDelhiveryWebhookSecret(req)) {
      res.status(401).json({ success: false, error: 'invalid_secret' });
      return;
    }

    const { waybill, image, status } = req.body || {};
    logger.info('Received Delhivery Sorter Image webhook', { waybill, status, hasImage: Boolean(image) });

    res.status(200).json({ success: true, message: 'Sorter Image received successfully' });
  } catch (err: any) {
    logger.error('Error handling Delhivery Sorter Image webhook', { error: err.message });
    res.status(200).json({ success: true, warning: 'Processed with warnings' });
  }
}

/**
 * Normalize a Delhivery scan-push payload into a flat shape.
 */
export interface NormalizedScan {
  waybill: string;
  status: string; // Composite key "STATUSTYPE:RawStatus" e.g. "DL:Delivered"
  statusType?: string;
  rawStatus?: string;
  location?: string;
  scanDateTime: string; // ISO string
  remarks?: string;
  instructions?: string;
  pickupDate?: string;
  nslCode?: string;
  sortCode?: string;
  referenceNo?: string;
  receivedBy?: string;
}

/**
 * Delhivery posts several envelopes: a raw scan, an array of scans, the
 * tracking-API ShipmentData wrapper, or a JSON string inside text/plain.
 * Flatten those into objects normalizeScanPushPayload can read.
 */
export function expandScanPushBodies(payload: any): any[] {
  if (payload == null) return [];
  if (typeof payload === 'string') {
    const trimmed = payload.trim();
    if (!trimmed) return [];
    try {
      return expandScanPushBodies(JSON.parse(trimmed));
    } catch {
      return [];
    }
  }
  if (Array.isArray(payload)) return payload.flatMap(expandScanPushBodies);
  if (typeof payload !== 'object') return [];

  if (typeof payload.payload === 'string' || typeof payload.data === 'string') {
    const inner = typeof payload.payload === 'string' ? payload.payload : payload.data;
    const parsed = expandScanPushBodies(inner);
    if (parsed.length) return parsed;
  }

  if (Array.isArray(payload.ShipmentData)) {
    return payload.ShipmentData.flatMap((row: any) =>
      expandScanPushBodies(row?.Shipment ? { Shipment: row.Shipment } : row)
    );
  }

  if (payload.Shipment || payload.waybill || payload.AWB || payload.Waybill || payload.awb || payload.waybill_number) {
    return [payload];
  }

  for (const key of ['payload', 'data', 'body', 'scan', 'event']) {
    if (payload[key] && typeof payload[key] === 'object') {
      const nested = expandScanPushBodies(payload[key]);
      if (nested.length) return nested;
    }
  }

  return [payload];
}

export function parseScanDate(raw: string | undefined | null): Date {
  if (!raw) return new Date();
  const direct = new Date(raw);
  if (!Number.isNaN(direct.getTime())) return direct;
  const normalized = new Date(String(raw).trim().replace(' ', 'T'));
  if (!Number.isNaN(normalized.getTime())) return normalized;
  return new Date();
}

export function normalizeScanPushPayload(input: any): NormalizedScan | null {
  if (!input || typeof input !== 'object') return null;

  // Official nested schema
  if (input.Shipment && typeof input.Shipment === 'object') {
    const s = input.Shipment;
    const st = s.Status || {};
    const waybill = s.AWB || s.awb || s.waybill || s.Waybill || s.waybill_number || s.waybillNumber || s.waybillId;
    if (!waybill) return null;
    const statusType = st.StatusType || s.statusType || s.status_type;
    const rawStatus = st.Status || s.status;
    const scanDateTime = st.StatusDateTime || s.scan_datetime || new Date().toISOString();
    return {
      waybill: String(waybill).trim(),
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

  // Legacy flat schema
  const waybill =
    input.waybill ||
    input.awb ||
    input.AWB ||
    input.Waybill ||
    input.waybill_number ||
    input.waybillNumber ||
    input.waybillId;
  if (!waybill) return null;

  const statusType = input.status_type || input.statusType || input.StatusType;
  const rawStatus = input.status || input.Status || input.rawStatus;
  return {
    waybill: String(waybill).trim(),
    status: `${statusType || ''}:${rawStatus || ''}`,
    statusType,
    rawStatus,
    location: input.location || input.scan_location || input.StatusLocation,
    scanDateTime: input.scan_datetime || input.scanDateTime || input.StatusDateTime || new Date().toISOString(),
    remarks: input.remarks || input.remark || input.Instructions,
    instructions: undefined,
    pickupDate: input.pickup_date || input.PickUpDate || undefined,
    nslCode: input.nsl_code || input.NSLCode || undefined,
    sortCode: input.sort_code || input.Sortcode || undefined,
    referenceNo: input.reference_no || input.ReferenceNo || undefined,
    receivedBy: input.received_by || input.receivedBy || input.ReceivedBy,
  };
}

/**
 * Normalized EPOD payload shape
 */
export interface NormalizedEpod {
  waybill: string;
  orderId?: string | number;
  epodData?: string; // URL or Base64 string
  receivedBy?: string;
  receivedAt?: Date;
  referenceNo?: string;
}

export function normalizeEpodPayload(input: any): NormalizedEpod | null {
  if (!input || typeof input !== 'object') return null;

  // Nested Shipment shape
  if (input.Shipment && typeof input.Shipment === 'object') {
    const s = input.Shipment;
    const waybill = s.AWB || s.awb || s.waybill || s.Waybill || s.waybill_number;
    if (!waybill) return null;
    const epodData = s.EPOD || s.epod || s.pod || s.POD || s.image || s.document || s.url;
    const receivedBy = s.receivedBy || s.received_by || s.ReceivedBy || s.consignee || s.delivered_to;
    const rawTime = s.StatusDateTime || s.timestamp || s.deliveryDate || s.delivered_at;
    const receivedAt = rawTime ? new Date(rawTime) : undefined;
    return {
      waybill: String(waybill).trim(),
      orderId: s.ReferenceNo || s.orderID || s.orderId,
      epodData: epodData ? String(epodData).trim() : undefined,
      receivedBy: receivedBy ? String(receivedBy).trim() : undefined,
      receivedAt: receivedAt && !Number.isNaN(receivedAt.getTime()) ? receivedAt : undefined,
      referenceNo: s.ReferenceNo ? String(s.ReferenceNo) : undefined,
    };
  }

  // Flat shape
  const waybill =
    input.waybill ||
    input.awb ||
    input.AWB ||
    input.Waybill ||
    input.waybill_number ||
    input.waybillNumber ||
    input.waybillId;
  if (!waybill) return null;

  const epodData =
    input.EPOD ||
    input.epod ||
    input.pod ||
    input.POD ||
    input.image ||
    input.document ||
    input.url ||
    input.doc_url ||
    input.signed_url ||
    input.data?.EPOD ||
    input.data?.url ||
    input.data?.epod;

  const receivedBy =
    input.receivedBy ||
    input.received_by ||
    input.ReceivedBy ||
    input.consignee ||
    input.delivered_to ||
    input.signed_by;

  const rawTime =
    input.timestamp ||
    input.scannedAt ||
    input.scanDateTime ||
    input.delivered_at ||
    input.deliveryDate ||
    input.StatusDateTime;
  const receivedAt = rawTime ? new Date(rawTime) : undefined;

  const orderId =
    input.orderID ||
    input.orderId ||
    input.order_id ||
    input.ref_num ||
    input.ReferenceNo;

  return {
    waybill: String(waybill).trim(),
    orderId,
    epodData: epodData ? String(epodData).trim() : undefined,
    receivedBy: receivedBy ? String(receivedBy).trim() : undefined,
    receivedAt: receivedAt && !Number.isNaN(receivedAt.getTime()) ? receivedAt : undefined,
    referenceNo: input.ReferenceNo ? String(input.ReferenceNo) : undefined,
  };
}

// Exported for unit tests so webhook contracts stay pinned in CI
export const __test__ = { normalizeScanPushPayload, normalizeEpodPayload, expandScanPushBodies, parseScanDate };

/**
 * Handle order status transition + WhatsApp notifications.
 */
async function handleStatusTransition(
  order: any,
  newShipmentStatus: string,
  delhiveryStatusText: string,
  location?: string,
  waybill?: string
): Promise<void> {
  if (!order) return;

  // Cancelled, refunded and returned orders are closed: a forward scan must
  // not reopen them or message the customer. A cancelled order whose parcel
  // keeps moving needs a person (the Delhivery cancel did not take).
  if (isCarrierLockedOrderStatus(order.status)) {
    if (needsRtoRefundAfterCancel(order, newShipmentStatus)) {
      try {
        const orderService = (await import('../modules/orders/order.service')).default;
        await orderService.processRtoRefund(order.id);
      } catch (rtoErr: any) {
        logger.error('RTO refund for a cancelled order failed in Delhivery webhook', { error: rtoErr.message });
      }
      return;
    }
    if (
      (order.status === 'CANCELLED' || order.status === 'REFUNDED') &&
      MOVING_SHIPMENT_STATUSES.has(newShipmentStatus) &&
      !order.supportFlag
    ) {
      await prisma.order.update({
        where: { id: order.id },
        data: { hasUrgentSupport: true, supportFlag: PARCEL_MOVING_ON_CLOSED_ORDER },
      });
    }
    logger.warn('Carrier update on a closed order, order left unchanged', {
      orderId: order.id,
      orderStatus: order.status,
      shipmentStatus: newShipmentStatus,
      waybill,
    });
    return;
  }

  switch (newShipmentStatus) {
    case 'CREATED':
      if (['DISPATCH_PENDING', 'SHIPPED', 'IN_TRANSIT'].includes(order.status)) {
        await prisma.order.update({
          where: { id: order.id },
          data: { status: 'DISPATCHED' },
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
      await notificationEngine.notifyInTransit?.(order, waybill, location);
      break;

    case 'OUT_FOR_DELIVERY':
      await prisma.order.update({
        where: { id: order.id },
        data: { status: 'OUT_FOR_DELIVERY' },
      });
      await notificationEngine.notifyOutForDelivery(order, waybill, location);
      break;

    case 'DELIVERED':
      await prisma.order.update({
        where: { id: order.id },
        data: { status: 'DELIVERED', deliveredAt: order.deliveredAt || new Date() },
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

// ────────────────────────────────────────────────────────────
// Route Registration with Comprehensive Aliases
// ────────────────────────────────────────────────────────────

// 1. Scan Push (Status Tracking)
router.post('/delhivery', handleScanPush);
router.post('/delhivery/scan', handleScanPush);
router.post('/delhivery/tracking', handleScanPush);

// 2. EPOD / POD Push (Electronic Proof of Delivery)
router.post('/delhivery/epod', handleEpodPush);
router.post('/delhivery/pod', handleEpodPush);

// 3. QC Image Push (Reverse Logistics QC)
router.post('/delhivery/qc-image', handleQcImagePush);
router.post('/delhivery/qc', handleQcImagePush);

// 4. Sorter Image Push
router.post('/delhivery/sorter-image', handleSorterImagePush);
router.post('/delhivery/sorter', handleSorterImagePush);

export default router;
