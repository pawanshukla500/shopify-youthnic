/**
 * Lifecycle rules shared by every path that moves an order or shipment:
 * the Delhivery scan webhook, the tracking cron and the Shopify sync.
 *
 * Keeping them in one place stops the two carrier paths from disagreeing
 * (one marking COD collected and the other not, one cancelling the order and
 * the other ignoring it) and stops late or forged data from undoing a state
 * the OMS already closed.
 */

/**
 * Order states the OMS owns after the customer received the parcel. A Shopify
 * sync must not overwrite them: a refund's own orders/updated webhook would
 * otherwise put a REFUNDED order back to DELIVERED and allow a second return.
 */
export const OMS_OWNED_ORDER_STATUSES = new Set([
  'RETURN_REQUESTED',
  'RETURN_DISPATCHED',
  'RETURN_RECEIVED',
  'REFUNDED',
]);

/**
 * Orders a forward carrier scan must not move or message. A cancelled or
 * refunded order stays put, and the customer gets no shipping messages for it;
 * a parcel that keeps moving is flagged for a person instead.
 */
export const CARRIER_LOCKED_ORDER_STATUSES = new Set([
  'CANCELLED',
  ...OMS_OWNED_ORDER_STATUSES,
]);

/** Shipment states that end the forward journey. Only an authenticated carrier read may set them. */
export const TERMINAL_SHIPMENT_STATUSES = new Set(['DELIVERED', 'RTO_DELIVERED', 'CANCELLED']);

/** Shipment states in which the parcel is physically moving with the courier. */
export const MOVING_SHIPMENT_STATUSES = new Set([
  'PICKED_UP',
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
  'FAILED',
  'DELIVERED',
]);

/** Support flag set when a cancelled or refunded order's parcel keeps moving. */
export const PARCEL_MOVING_ON_CLOSED_ORDER = 'PARCEL_MOVING_ON_CLOSED_ORDER';

export function isCarrierLockedOrderStatus(status?: string | null): boolean {
  return CARRIER_LOCKED_ORDER_STATUSES.has(status || '');
}

/**
 * A prepaid order cancelled after pickup comes back as RTO. Shopify's cancel
 * does not refund it by itself, so the RTO refund must still run for it even
 * though the cancelled order is otherwise closed to carrier updates.
 */
export function needsRtoRefundAfterCancel(
  order: { status?: string | null; paymentMethod?: string | null },
  newShipmentStatus: string
): boolean {
  return order.status === 'CANCELLED' && newShipmentStatus === 'RTO_DELIVERED' && order.paymentMethod !== 'COD';
}

/**
 * Newest scan time already recorded in a shipment's trackingHistory, or null.
 * Accepts both the webhook shape (dateTime) and the tracking API shape (date).
 */
export function latestScanAt(history: unknown): Date | null {
  if (!Array.isArray(history)) return null;
  let latest: number | null = null;
  for (const row of history) {
    const raw = (row as any)?.dateTime || (row as any)?.date;
    if (!raw) continue;
    const time = new Date(raw).getTime();
    if (Number.isNaN(time)) continue;
    if (latest === null || time > latest) latest = time;
  }
  return latest === null ? null : new Date(latest);
}

/**
 * A pushed scan is older than one already applied. Applying it would move the
 * shipment backwards (a late "In Transit" after "Delivered").
 */
export function isStaleScan(scannedAt: Date, history: unknown): boolean {
  const latest = latestScanAt(history);
  return latest !== null && scannedAt.getTime() < latest.getTime();
}

/**
 * Shipment fields to write when a parcel is delivered. The courier collects
 * the cash at delivery, so a COD shipment's amount is now owed by Delhivery.
 */
export function deliveredShipmentData(
  shipment: { paymentMode?: string | null; codAmount?: number | null; codCollected?: boolean | null },
  now: Date = new Date()
): { codCollected?: boolean; codCollectedAt?: Date } {
  if (shipment.paymentMode === 'COD' && (shipment.codAmount || 0) > 0 && !shipment.codCollected) {
    return { codCollected: true, codCollectedAt: now };
  }
  return {};
}
