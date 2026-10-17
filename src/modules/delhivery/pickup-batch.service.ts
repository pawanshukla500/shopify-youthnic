import prisma from '../../database/prisma';
import { config } from '../../config';
import delhiveryService from './delhivery.service';
import { nextDayWarehousePickupSlot } from './pickup-schedule';
import { recordAccountTrailEvent, type AccountTrailActor } from '../accounts/account-trail.service';
import logger from '../../utils/logger';

const MAX_ATTEMPTS = 5;
const RETRY_MS = 20 * 60 * 1000;
const liveOrder = { status: 'DISPATCHED' as const, shopifyCreatedAt: { gte: config.shopify.syncStartDate } };

export async function queueManifestForPickup(orderId: number, waybill: string, actor?: AccountTrailActor, now = new Date()) {
  const shipment = await prisma.shipment.findUnique({ where: { orderId }, include: { order: true, pickupBatch: true } });
  if (!shipment || !shipment.manifestedByOms || shipment.waybillNumber !== waybill || shipment.status !== 'CREATED'
    || shipment.order.status !== 'DISPATCHED' || shipment.order.shopifyCreatedAt < config.shopify.syncStartDate
    || !/delhivery/i.test(shipment.courier || '') || shipment.paymentMode === 'Pickup') return null;
  if (shipment.pickupBatchKey) return shipment.pickupBatch;
  const slot = nextDayWarehousePickupSlot(shipment.omsManifestedAt || now, config.delhivery.pickupTime);
  const location = shipment.manifestPickupLocation || config.delhivery.pickupLocation;
  const key = `${encodeURIComponent(location)}:${slot.date}`;
  const batch = await prisma.warehousePickupBatch.upsert({
    where: { key }, update: {},
    create: { key, pickupLocation: location, pickupDate: slot.date, pickupTime: slot.time, nextAttemptAt: new Date(now.getTime() + 2 * 60 * 1000) },
  });
  const assigned = await prisma.shipment.updateMany({
    where: { id: shipment.id, waybillNumber: waybill, status: 'CREATED', pickupBatchKey: null, order: liveOrder },
    data: { pickupBatchKey: key },
  });
  if (assigned.count && batch.status === 'EMPTY') await prisma.warehousePickupBatch.updateMany({
    where: { key, status: 'EMPTY' }, data: { status: 'QUEUED', nextAttemptAt: new Date(now.getTime() + 2 * 60 * 1000) },
  });
  if (assigned.count) await recordAccountTrailEvent({
    orderId, eventType: 'PICKUP_QUEUED', actorType: actor ? 'USER' : 'SYSTEM', actor,
    source: 'OMS_PICKUP', status: batch.status, externalReference: waybill,
    note: `Parcel queued for warehouse pickup on ${slot.date} at ${slot.time} IST.`,
    metadata: { pickupBatchKey: key, warehouse: location, targetDate: slot.date },
  }).catch((error) => logger.warn('Pickup queue audit could not be stored', { orderId, error: error.message }));
  return batch;
}

export async function submitPickupBatch(key: string, actor?: AccountTrailActor, now = new Date(), manual = false) {
  const batch = await prisma.warehousePickupBatch.findUnique({ where: { key } });
  if (!batch) throw new Error('Pickup batch not found.');
  if (batch.status === 'SENDING' && batch.claimedAt && now.getTime() - batch.claimedAt.getTime() > 10 * 60 * 1000) {
    await prisma.warehousePickupBatch.updateMany({
      where: { key, status: 'SENDING', claimedAt: batch.claimedAt },
      data: { status: 'REVIEW', message: 'Previous submission did not finish. Check Delhivery ONE; no duplicate request was sent.' },
    });
    return prisma.warehousePickupBatch.findUnique({ where: { key } });
  }
  const cap = batch.status === 'BLOCKED' ? 24 : MAX_ATTEMPTS;
  if (!['QUEUED', 'FAILED', 'BLOCKED'].includes(batch.status) || batch.attempts >= cap
    || (!manual && batch.nextAttemptAt > now)) return batch;
  const target = new Date(`${batch.pickupDate}T${batch.pickupTime}+05:30`);
  if (!Number.isFinite(target.getTime()) || target <= now) {
    return prisma.warehousePickupBatch.update({ where: { key }, data: { status: 'REVIEW', message: 'Pickup slot has passed. Review before arranging another request.' } });
  }
  const claimed = await prisma.warehousePickupBatch.updateMany({
    where: { key, status: batch.status, attempts: batch.attempts },
    data: { status: 'SENDING', claimedAt: now, attempts: { increment: 1 } },
  });
  if (!claimed.count) return prisma.warehousePickupBatch.findUnique({ where: { key } });
  const parcels = await prisma.shipment.findMany({
    where: { pickupBatchKey: key, manifestedByOms: true, status: 'CREATED', waybillNumber: { not: null }, order: liveOrder },
    select: { id: true, orderId: true, waybillNumber: true },
  });
  if (!parcels.length) return prisma.warehousePickupBatch.update({ where: { key }, data: { status: 'EMPTY', message: 'No live manifested parcels remain in this batch.' } });
  const legacy = await prisma.pickupRequest.findFirst({
    where: { pickupLocation: batch.pickupLocation, pickupDate: batch.pickupDate, direction: 'FORWARD', status: { in: ['SCHEDULED', 'ALREADY_OPEN'] } },
    orderBy: { createdAt: 'desc' },
  });
  const result = legacy
    ? { success: Boolean(legacy.pickupId) && legacy.status === 'SCHEDULED', uncertain: !legacy.pickupId || legacy.status !== 'SCHEDULED', pickupId: legacy.pickupId, alreadyOpen: false, message: 'Existing warehouse pickup record found; no second request sent.' }
    : await delhiveryService.requestPickup(batch.pickupDate, batch.pickupTime, parcels.length, batch.pickupLocation);
  const status = result.success ? 'SCHEDULED' : result.uncertain ? 'REVIEW'
    : batch.attempts + 1 >= (result.alreadyOpen ? 24 : MAX_ATTEMPTS) ? 'REVIEW' : result.alreadyOpen ? 'BLOCKED' : 'FAILED';
  // Failed persistence leaves SENDING durable; recovery requires review, never another blind POST.
  const saved = await prisma.warehousePickupBatch.update({
    where: { key }, data: {
      status, pickupId: result.pickupId || null, submittedPackageCount: result.success ? parcels.length : 0,
      message: result.message, nextAttemptAt: new Date(now.getTime() + (result.alreadyOpen ? 60 * 60 * 1000 : RETRY_MS)),
    },
  });
  for (const parcel of parcels) await recordAccountTrailEvent({
    orderId: parcel.orderId, eventType: 'PICKUP_REQUESTED', actorType: actor ? 'USER' : 'SYSTEM', actor,
    source: 'OMS_PICKUP', status, externalReference: `${key}:${batch.attempts + 1}`,
    note: result.message, metadata: { pickupId: result.pickupId || null, targetDate: batch.pickupDate, submittedCount: saved.submittedPackageCount },
  }).catch((error) => logger.warn('Pickup audit could not be stored', { orderId: parcel.orderId, error: error.message }));
  return saved;
}

export async function processPickupBatches(now = new Date()) {
  if (!config.delhivery.autoPickup) return { scheduled: false, skipped: true, message: 'Automatic pickup is disabled.' };
  const unqueued = await prisma.shipment.findMany({
    where: { pickupBatchKey: null, manifestedByOms: true, status: 'CREATED', waybillNumber: { not: null }, courier: { contains: 'delhivery', mode: 'insensitive' },
      order: { ...liveOrder, dispatchedAt: { gte: new Date(now.getTime() - 48 * 3600 * 1000) } } },
    include: { order: true }, take: 100,
  });
  for (const shipment of unqueued) {
    await queueManifestForPickup(shipment.orderId, shipment.waybillNumber!, undefined, shipment.order.dispatchedAt || now)
      .catch((error) => logger.error('Pickup queue recovery failed', { orderId: shipment.orderId, error: error.message }));
  }
  const batches = await prisma.warehousePickupBatch.findMany({
    where: { status: { in: ['QUEUED', 'FAILED', 'BLOCKED', 'SENDING'] }, nextAttemptAt: { lte: now } },
    orderBy: { createdAt: 'asc' }, take: 20,
  });
  let scheduled = 0;
  for (const batch of batches) {
    try { if ((await submitPickupBatch(batch.key, undefined, now))?.status === 'SCHEDULED') scheduled++; }
    catch (error: any) { logger.error('Pickup batch failed; claim retained for review', { key: batch.key, error: error.message }); }
  }
  return { scheduled: scheduled > 0, skipped: !batches.length, message: `${scheduled} warehouse pickup batch(es) scheduled.` };
}

/** Manual scheduling uses exactly the same queue/claim; count is server-derived, not trusted UI input. */
export async function scheduleWaitingParcels(actor?: AccountTrailActor) {
  const waiting = await prisma.shipment.findMany({
    where: { pickupBatchKey: null, manifestedByOms: true, status: 'CREATED', waybillNumber: { not: null }, courier: { contains: 'delhivery', mode: 'insensitive' }, order: liveOrder },
    select: { orderId: true, waybillNumber: true },
  });
  for (const shipment of waiting) await queueManifestForPickup(shipment.orderId, shipment.waybillNumber!, actor);
  const slot = nextDayWarehousePickupSlot(new Date(), config.delhivery.pickupTime);
  const key = `${encodeURIComponent(config.delhivery.pickupLocation)}:${slot.date}`;
  const existing = await prisma.warehousePickupBatch.findUnique({ where: { key } });
  return existing ? submitPickupBatch(key, actor, new Date(), true) : null;
}
