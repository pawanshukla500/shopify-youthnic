import { Router, Request, Response } from 'express';
import prisma from '../database/prisma';
import config from '../config';
import velocityService from '../modules/velocity/velocity.service';
import trackingService from '../modules/tracking/tracking.service';
import logger from '../utils/logger';
import { recordAccountTrailEvent } from '../modules/accounts/account-trail.service';

const router = Router();

/**
 * POST /api/webhooks/velocity or /webhooks/velocity
 *
 * Receives real-time shipment status change webhooks from Velocity Shipping.
 * Payload structure per Velocity documentation:
 * {
 *   event: "status_change",
 *   event_id: string,
 *   event_timestamp: string,
 *   data: {
 *     shipment_id: string,
 *     tracking_number: string,
 *     order_id: string,
 *     order_external_id: string,
 *     order_display_id: string,
 *     status: string,
 *     sub_status: string,
 *     carrier_name: string,
 *     estimated_delivery_date: string,
 *     delivered_at?: string,
 *     tracking_url?: string
 *   }
 * }
 */
export async function handleVelocityWebhook(req: Request, res: Response): Promise<void> {
  const eventId = req.body?.event_id;
  const eventType = req.body?.event || 'status_change';
  const data = req.body?.data;

  logger.info('Received Velocity webhook', {
    eventId,
    eventType,
    trackingNumber: data?.tracking_number,
    status: data?.status,
    subStatus: data?.sub_status,
  });

  // Check auth header: supports HMAC (x-velocity-signature) and API Key (x-api-key, Bearer token)
  const signature = (req.headers['x-velocity-signature'] ||
    req.headers['x-hmac-signature'] ||
    req.headers['x-signature']) as string | undefined;

  const apiKeyHeader = (req.headers['x-api-key'] ||
    req.headers['api-key'] ||
    req.headers['x-velocity-token']) as string | undefined;

  const authHeader = req.headers['authorization'] as string | undefined;
  const bearerToken = authHeader?.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : undefined;

  const queryKey = (req.query?.secret || req.query?.api_key) as string | undefined;
  const clientKey = apiKeyHeader || bearerToken || queryKey;

  const expectedSecret = config.velocity.webhookSecret;
  const expectedToken = config.velocity.apiToken;

  if (signature) {
    if (!velocityService.verifyWebhookSignature(req.body, signature)) {
      logger.warn('Velocity webhook HMAC signature verification failed', { eventId });
      res.status(401).json({ error: 'Invalid webhook signature' });
      return;
    }
  } else if (clientKey) {
    const matchSecret = expectedSecret && clientKey === expectedSecret;
    const matchToken = expectedToken && clientKey === expectedToken;
    if ((expectedSecret || expectedToken) && !matchSecret && !matchToken) {
      logger.warn('Velocity webhook API Key verification failed', { eventId });
      res.status(401).json({ error: 'Invalid webhook API Key' });
      return;
    }
  } else if (expectedSecret) {
    logger.warn('Velocity webhook missing required authentication header/secret', { eventId });
    res.status(401).json({ error: 'Missing webhook authentication' });
    return;
  }

  // Velocity expects a quick 200 OK within 5 seconds
  if (!data?.tracking_number) {
    res.status(200).json({ success: true, message: 'Ignored webhook without tracking_number' });
    return;
  }

  const trackingNumber = String(data.tracking_number).trim();
  const rawStatus = data.status || data.sub_status || 'in_transit';

  try {
    // 1. Locate the shipment
    let shipment = await prisma.shipment.findFirst({
      where: { waybillNumber: trackingNumber },
      include: { order: { include: { items: true } } },
    });

    // Fallback: match by external order ID or display ID if waybill not yet bound
    if (!shipment && (data.order_external_id || data.order_display_id)) {
      const orderRef = (data.order_external_id || data.order_display_id).trim();
      const order = await prisma.order.findFirst({
        where: {
          OR: [
            { shopifyOrderName: orderRef },
            { shopifyOrderName: `#${orderRef.replace('#', '')}` },
            { shopifyOrderId: orderRef },
          ],
        },
        include: { shipment: true, items: true },
      });

      if (order) {
        if (order.shipment) {
          if (order.shipment.waybillNumber && order.shipment.waybillNumber !== trackingNumber) {
            logger.warn('Velocity webhook ignored: matches superseded waybill on order with active shipment', {
              trackingNumber,
              activeWaybill: order.shipment.waybillNumber,
              orderName: order.shopifyOrderName,
              status: rawStatus,
            });
            res.status(200).json({
              success: true,
              message: 'Webhook received for superseded waybill, ignored to protect active shipment',
            });
            return;
          }
          // If the existing shipment record has no waybill assigned, bind the incoming tracking number
          if (!order.shipment.waybillNumber) {
            const updatedShipment = await prisma.shipment.update({
              where: { id: order.shipment.id },
              data: {
                waybillNumber: trackingNumber,
                courier: data.carrier_name ? `Velocity (${data.carrier_name})` : (order.shipment.courier || 'Velocity'),
                labelUrl: data.label_url || order.shipment.labelUrl || undefined,
              },
            });
            shipment = { ...updatedShipment, order } as any;
          } else {
            shipment = { ...order.shipment, order } as any;
          }
        } else {
          // Guard: if the order is already CANCELLED or REFUNDED, do not reopen it to DISPATCHED
          const isTerminated = ['CANCELLED', 'REFUNDED'].includes(order.status);

          const createdShipment = await prisma.shipment.create({
            data: {
              orderId: order.id,
              waybillNumber: trackingNumber,
              courier: data.carrier_name ? `Velocity (${data.carrier_name})` : 'Velocity',
              paymentMode: order.paymentMethod === 'COD' ? 'COD' : 'Pre-paid',
              codAmount: order.paymentMethod === 'COD' ? order.totalAmount || 0 : 0,
              status: isTerminated ? 'CANCELLED' : 'CREATED',
              trackingStatus: 'Label generated',
              labelUrl: data.label_url || undefined,
            },
          });
          if (!isTerminated) {
            await prisma.order.update({
              where: { id: order.id },
              data: { status: 'DISPATCHED', dispatchedAt: order.dispatchedAt || new Date() },
            });
          }
          shipment = { ...createdShipment, order } as any;
        }
      }
    }

    if (!shipment) {
      logger.info('Velocity webhook: Shipment not found for tracking number', { trackingNumber });
      res.status(200).json({ success: true, message: 'Shipment not found in OMS, recorded' });
      return;
    }

    // 2. Map Velocity status to internal status
    const mapped = velocityService.mapTrackingToShipmentStatus(rawStatus);
    const oldShipmentStatus = shipment.status;
    const newShipmentStatus = mapped.shipmentStatus;

    // 3. Process status transition if status changed
    if (newShipmentStatus !== oldShipmentStatus) {
      // Use trackingService's transition handler to update order, send WhatsApp alerts, etc.
      const scanLocation = data.location || data.city || data.destination || data.origin || undefined;
      await (trackingService as any).handleStatusChange(
        shipment,
        oldShipmentStatus,
        newShipmentStatus,
        mapped.description,
        scanLocation
      );
    }

    // 4. Update shipment details (location, EDD, tracking history)
    await prisma.shipment.update({
      where: { id: shipment.id },
      data: {
        courier: shipment.courier || 'Velocity',
        trackingStatus: mapped.description,
        trackingUpdatedAt: new Date(),
        expectedDeliveryDate: data.estimated_delivery_date
          ? new Date(data.estimated_delivery_date)
          : undefined,
        labelUrl: shipment.labelUrl || data.label_url || undefined,
      },
    });

    // 5. Add tracking log
    await prisma.trackingLog.create({
      data: {
        shipmentId: shipment.id,
        status: mapped.description,
        location: data.carrier_name || 'Velocity Hub',
        remark: data.sub_status || data.status,
        scannedAt: data.delivered_at
          ? new Date(data.delivered_at)
          : req.body.event_timestamp
          ? new Date(req.body.event_timestamp)
          : new Date(),
      },
    }).catch(() => undefined);

    // 6. Record audit trail
    if (shipment.orderId) {
      await recordAccountTrailEvent({
        orderId: shipment.orderId,
        eventType: 'WEBHOOK_RECEIVED',
        actorType: 'SYSTEM',
        source: 'VELOCITY_WEBHOOK',
        status: 'COMPLETED',
        externalReference: trackingNumber,
        note: `Velocity webhook status: ${rawStatus} → ${mapped.description}`,
      }).catch((e) => logger.warn('Audit trail failed for Velocity webhook', { error: e.message }));
    }

    res.status(200).json({
      success: true,
      message: 'Status processed successfully',
      shipmentStatus: newShipmentStatus,
    });
  } catch (err: any) {
    logger.error('Error processing Velocity webhook', { error: err.message, trackingNumber });
    // Always return 200 so Velocity does not disable webhook due to consecutive 500 errors
    res.status(200).json({ success: false, error: err.message });
  }
}

router.post('/webhooks/velocity', handleVelocityWebhook);
router.post('/api/webhooks/velocity', handleVelocityWebhook);

export default router;
