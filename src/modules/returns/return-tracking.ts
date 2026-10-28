import prisma from '../../database/prisma';
import notificationEngine from '../notifications/notification.service';
import logger from '../../utils/logger';

/**
 * Reverse AWBs are tracked with the same Delhivery scans as forward shipments.
 * Status moves on its own — warehouse staff do not mark pickup or transit.
 *
 * Delivered-to-warehouse becomes QC_PENDING. Refund still waits for the
 * warehouse scan so a courier "delivered" scan cannot refund a garment
 * that has not been inspected.
 */

export type CarrierReturnStatus = 'PICKUP_SCHEDULED' | 'PICKED_UP' | 'IN_TRANSIT' | 'QC_PENDING' | 'CANCELLED';

const RANK: Record<string, number> = {
  INITIATED: 0,
  PICKUP_SCHEDULED: 1,
  PICKED_UP: 2,
  IN_TRANSIT: 3,
  QC_PENDING: 4,
  RECEIVED: 4,
  QC_APPROVED: 5,
  QC_REJECTED: 5,
  REFUND_PENDING: 6,
  REFUNDED: 7,
  CANCELLED: 8,
};

export function mapCarrierScanToReturnStatus(
  statusType: string,
  status: string,
  remarks?: string
): CarrierReturnStatus | null {
  const kind = (statusType || '').toUpperCase();
  const label = (status || '').toUpperCase();
  const hint = `${label} ${(remarks || '').toUpperCase()}`;

  if (kind === 'CN' || label.includes('CANCEL')) return 'CANCELLED';

  if (
    kind === 'DL' &&
    (label === 'DELIVERED' || label.startsWith('DELIVERED') || label === 'DTO' || label.includes('DTO'))
  ) {
    return 'QC_PENDING';
  }

  if (
    label.includes('PICKED UP') ||
    label.includes('PICKUP DONE') ||
    label.includes('PICKEDUP')
  ) {
    return 'PICKED_UP';
  }
  if (kind === 'PU') return 'PICKED_UP';

  if (
    label.includes('IN TRANSIT') ||
    label === 'PENDING' ||
    label === 'DISPATCHED' ||
    label.includes('OUT FOR DELIVERY') ||
    kind === 'RT'
  ) {
    return 'IN_TRANSIT';
  }

  if (
    kind === 'PP' ||
    label.includes('MANIFEST') ||
    label.includes('NOT PICK') ||
    label === 'OPEN' ||
    label === 'SCHEDULED' ||
    hint.includes('PICKUP SCHEDULED')
  ) {
    return 'PICKUP_SCHEDULED';
  }

  return null;
}

export function shouldAdvanceReturnStatus(current: string, next: CarrierReturnStatus): boolean {
  if (current === next) return false;
  if (['REFUNDED', 'QC_APPROVED', 'QC_REJECTED', 'REFUND_PENDING'].includes(current)) return false;
  if (current === 'CANCELLED') return false;
  if (next === 'CANCELLED') return true;
  if (current === 'QC_PENDING' || current === 'RECEIVED') return false;
  return (RANK[next] ?? 0) > (RANK[current] ?? 0);
}

/**
 * Move the parent order only forward along the return lane, and only once
 * the forward shipment is already delivered (or the return lane has started).
 */
export function orderStatusForReturn(
  returnStatus: CarrierReturnStatus,
  currentOrderStatus: string,
  hasActiveReplacement = false
): string | null {
  if (currentOrderStatus === 'REFUNDED' || currentOrderStatus === 'CANCELLED') return null;

  if (returnStatus === 'CANCELLED') {
    if (currentOrderStatus === 'EXCHANGE_REQUESTED' && hasActiveReplacement) return null;
    return (currentOrderStatus === 'RETURN_REQUESTED' || currentOrderStatus === 'EXCHANGE_REQUESTED') ? 'DELIVERED' : null;
  }

  const target =
    returnStatus === 'PICKUP_SCHEDULED'
      ? (currentOrderStatus === 'EXCHANGE_REQUESTED' ? 'EXCHANGE_REQUESTED' : 'RETURN_REQUESTED')
      : returnStatus === 'QC_PENDING'
        ? 'RETURN_RECEIVED'
        : 'RETURN_DISPATCHED';

  const allowedFrom = new Set(['DELIVERED', 'RETURN_REQUESTED', 'EXCHANGE_REQUESTED', 'RETURN_DISPATCHED', 'RETURN_RECEIVED']);
  if (!allowedFrom.has(currentOrderStatus)) return null;

  const orderRank: Record<string, number> = {
    DELIVERED: 0,
    RETURN_REQUESTED: 1,
    EXCHANGE_REQUESTED: 1,
    RETURN_DISPATCHED: 2,
    RETURN_RECEIVED: 3,
    REFUNDED: 9,
  };
  if ((orderRank[target] ?? 0) <= (orderRank[currentOrderStatus] ?? 0)) return null;
  return target;
}

export interface ReturnCarrierScan {
  statusType?: string;
  status: string;
  location?: string;
  remarks?: string;
  scannedAt?: Date;
  history?: Array<{ status: string; statusType?: string; location?: string; dateTime?: string; remark?: string }>;
}

/**
 * Apply one Delhivery scan to the return that owns this waybill.
 * Returns false when the waybill is not a return (caller should keep looking).
 */
export async function applyReturnCarrierScan(waybill: string, scan: ReturnCarrierScan): Promise<'missing' | 'updated' | 'seen'> {
  const record = await prisma.return.findFirst({
    where: { returnWaybillNumber: waybill },
    include: { order: true },
  });
  if (!record) return 'missing';

  const next = mapCarrierScanToReturnStatus(scan.statusType || '', scan.status, scan.remarks);
  const advance = next ? shouldAdvanceReturnStatus(record.returnStatus, next) : false;
  const hasActiveReplacement = Boolean(record.isExchange && (record.exchangeForwardAwb || record.exchangeForwardShipmentId));
  const orderStatus = advance && next ? orderStatusForReturn(next, record.order.status, hasActiveReplacement) : null;

  const previous = Array.isArray(record.trackingHistory) ? (record.trackingHistory as any[]) : [];
  const incoming = (scan.history && scan.history.length ? scan.history : [
    {
      status: scan.status,
      statusType: scan.statusType || '',
      location: scan.location || '',
      dateTime: (scan.scannedAt || new Date()).toISOString(),
      remark: scan.remarks,
    },
  ]).filter((row) => row?.status);
  const trackingHistory = [...previous];
  for (const row of incoming) {
    const duplicate = trackingHistory.some(
      (existing) => existing?.status === row.status && existing?.dateTime === row.dateTime
    );
    if (!duplicate) trackingHistory.push(row);
  }

  await prisma.return.update({
    where: { id: record.id },
    data: {
      ...(advance && next ? { returnStatus: next } : {}),
      returnShipmentStatus: scan.status || record.returnShipmentStatus,
      trackingStatus: scan.status || null,
      trackingLocation: scan.location || null,
      trackingUpdatedAt: new Date(),
      trackingHistory: trackingHistory.slice(-80) as any,
      ...(advance && next === 'PICKED_UP' && !record.pickedUpAt ? { pickedUpAt: new Date() } : {}),
      ...(advance && next === 'QC_PENDING' && !record.receivedAt ? { receivedAt: new Date() } : {}),
      ...(orderStatus ? { order: { update: { status: orderStatus as any } } } : {}),
    },
  });

  if (advance) {
    await prisma.syncLog.create({
      data: {
        orderId: record.orderId,
        syncType: 'RETURN_TRACKING',
        status: 'SUCCESS',
        message: `Reverse AWB ${waybill}: ${scan.statusType || 'scan'} ${scan.status} → ${next}`,
      },
    });
    logger.info('Reverse shipment status updated from carrier scan', {
      waybill,
      returnId: record.id,
      from: record.returnStatus,
      to: next,
      orderStatus,
    });
  }

  if (advance && next === 'QC_PENDING') {
    try {
      await notificationEngine.notifyReturnReceived(record.order);
    } catch (err: any) {
      logger.warn('Return-received notification failed', { waybill, error: err.message });
    }
  }

  return advance ? 'updated' : 'seen';
}
