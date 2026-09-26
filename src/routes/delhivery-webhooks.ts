import { Router, Request, Response } from 'express';
import prisma from '../database/prisma';
import delhiveryService from '../modules/delhivery/delhivery.service';
import notificationEngine from '../modules/notifications/notification.service';
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
 */
router.post('/delhivery', async (req: Request, res: Response): Promise<void> => {
  try {
    const payload = req.body;
    logger.info('Received Delhivery webhook', { payload: JSON.stringify(payload).substring(0, 500) });

    // Delhivery webhook payload structure (may vary based on configuration):
    // {
    //   "waybill": "1234567890",
    //   "status": "Delivered",
    //   "status_type": "DL",
    //   "location": "Mumbai DC",
    //   "scan_datetime": "2024-01-15T10:30:00",
    //   "remarks": "Delivered to customer",
    //   "received_by": "John Doe"
    // }

    // Handle both single object and array of updates
    const updates = Array.isArray(payload) ? payload : [payload];

    for (const update of updates) {
      const waybill = update.waybill || update.awb;
      if (!waybill) {
        logger.warn('Delhivery webhook missing waybill number', { update });
        continue;
      }

      const status = update.status || '';
      const statusType = update.status_type || update.statusType || '';
      const location = update.location || update.scan_location || '';
      const scanDateTime = update.scan_datetime || update.scanDateTime || new Date().toISOString();
      const remarks = update.remarks || update.remark || '';

      logger.info('Processing Delhivery status update', {
        waybill,
        status,
        statusType,
        location,
      });

      // Find the shipment in our DB
      const shipment = await prisma.shipment.findFirst({
        where: { waybillNumber: waybill },
        include: { order: true },
      });

      if (!shipment) {
        logger.warn('Shipment not found for Delhivery webhook waybill', { waybill });
        continue;
      }

      // Save tracking log
      await prisma.trackingLog.create({
        data: {
          shipmentId: shipment.id,
          status: `${statusType}:${status}`,
          location: location || null,
          remark: remarks || null,
          scannedAt: new Date(scanDateTime),
        },
      });

      // Map to our internal status
      const newShipmentStatus = delhiveryService.mapTrackingToShipmentStatus(statusType, status);

      // Check if status changed
      if (newShipmentStatus !== shipment.status) {
        await prisma.shipment.update({
          where: { id: shipment.id },
          data: {
            status: newShipmentStatus as any,
            trackingStatus: status,
            trackingLocation: location || null,
            trackingUpdatedAt: new Date(),
          },
        });

        // Handle order status + notifications
        await handleStatusTransition(shipment.order, newShipmentStatus, status, location);
      } else {
        // Just update tracking info
        await prisma.shipment.update({
          where: { id: shipment.id },
          data: {
            trackingStatus: status,
            trackingLocation: location || null,
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
          message: `Delhivery webhook: ${statusType} - ${status} at ${location}`,
        },
      });
    }

    // Always return 200 quickly so Delhivery doesn't retry
    res.status(200).json({ received: true });
  } catch (error: any) {
    logger.error('Delhivery webhook processing error', { error: error.message });
    // Still return 200 to prevent retries — we'll catch up on polling
    res.status(200).json({ received: true, error: 'processing_error' });
  }
});

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
