/**
 * Operational order tabs for the Orders page.
 *
 * The eight queues follow warehouse reality, not the raw order.status column.
 * Delhivery's live tracking text (written by the tracking poll / scan webhook)
 * decides whether a labelled parcel is still at the seller or already moving.
 * Shopify tags decide whether a COD order is approved (Low RTO / COD_CONFIRMED)
 * or cancelled (COD_CANCELLED / High RTO) before it ever reaches the courier.
 *
 *   all        every received order
 *   new        received, not approved, not shipped
 *   dispatch   prepaid or COD_CONFIRMED, no label, no Delhivery update
 *   ready      label generated, still under pickup (not picked from the seller)
 *   transit    picked up and moving until the customer receives it
 *   delivered  delivered to the customer
 *   return     RTO and customer returns
 *   cancel     cancelled before pickup, including COD_CANCELLED / High RTO
 */

export const OPERATIONAL_TABS = [
  'new',
  'dispatch',
  'ready',
  'transit',
  'delivered',
  'return',
  'cancel',
] as const;

export type OperationalTab = (typeof OPERATIONAL_TABS)[number];
export type OrderTab = OperationalTab | 'all';

export interface OrderTabShipment {
  status?: string | null;
  waybillNumber?: string | null;
  trackingStatus?: string | null;
  trackingUpdatedAt?: Date | string | null;
  courier?: string | null;
  errorMessage?: string | null;
}

export interface OrderTabSnapshot {
  status?: string | null;
  paymentMethod?: string | null;
  paymentGateway?: string | null;
  financialStatus?: string | null;
  tags?: string | null;
  shipment?: OrderTabShipment | null;
  returns?: Array<{ status?: string | null; returnStatus?: string | null }> | null;
}

const RETURN_ORDER_STATUSES = new Set([
  'RTO_INITIATED',
  'RTO_DELIVERED',
  'RETURN_REQUESTED',
  'RETURN_DISPATCHED',
  'RETURN_RECEIVED',
]);

const TRANSIT_ORDER_STATUSES = new Set([
  'SHIPPED',
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
  'FAILED_DELIVERY',
]);

const COD_CONFIRMED_TAGS = new Set([
  'cod_confirmed',
  'codconfirmed',
  'low_rto',
  'low_rto_risk',
  'c2p_converted',
  'c2p_prepaid_order',
  'confirmed',
]);

const HIGH_RTO_CANCEL_TAGS = new Set([
  'cod_cancelled',
  'cod_canceled',
  'gokwik_cod_blocking',
  'cod_blocking',
  'c2p_order_cancelled',
  'c2p_order_canceled',
  'high_rto',
  'high_rto_cancel',
  'high_rto_risk',
]);

/** Split Shopify's comma-separated tags into exact tokens (never a substring). */
export function orderTagTokens(tags?: string | null): string[] {
  return (tags || '')
    .split(',')
    .map((tag) => tag.trim().toLowerCase().replace(/[\s-]+/g, '_'))
    .filter(Boolean);
}

export function isDelhiveryCourierName(courier?: string | null): boolean {
  if (!courier || !courier.trim()) return true;
  return courier.toLowerCase().includes('delhivery');
}

export function isHighRtoCancel(order: OrderTabSnapshot): boolean {
  return orderTagTokens(order.tags).some((tag) => HIGH_RTO_CANCEL_TAGS.has(tag));
}

export function isPrepaidOrder(order: OrderTabSnapshot): boolean {
  const method = (order.paymentMethod || '').toLowerCase();
  if (method === 'cod' || method.includes('cash')) return false;
  if (
    method.includes('pre-paid') ||
    method.includes('prepaid') ||
    method === 'upi' ||
    method.includes('phonepe')
  ) {
    return true;
  }

  const tokens = orderTagTokens(order.tags);
  const gateway = (order.paymentGateway || '').toLowerCase();
  if ((order.financialStatus || '').toLowerCase() === 'paid') return true;
  if (gateway.includes('phonepe') || gateway.includes('razorpay') || gateway.includes('easebuzz')) {
    return true;
  }
  if (
    (gateway.includes('gokwik') || gateway.includes('kwik')) &&
    (tokens.includes('prepaid') || tokens.includes('upi') || (order.financialStatus || '').toLowerCase() === 'paid')
  ) {
    return true;
  }
  if (tokens.includes('cod') && !tokens.includes('prepaid') && !tokens.includes('upi')) return false;
  return tokens.includes('prepaid') || tokens.includes('upi') || tokens.includes('phonepe');
}

/** COD approved for dispatch: Low RTO / COD_CONFIRMED, not a High RTO cancel. */
export function isCodConfirmed(order: OrderTabSnapshot): boolean {
  if (isPrepaidOrder(order) || isHighRtoCancel(order)) return false;
  const method = (order.paymentMethod || '').toLowerCase();
  if (method && method !== 'cod' && !method.includes('cash')) return false;
  return orderTagTokens(order.tags).some((tag) => COD_CONFIRMED_TAGS.has(tag));
}

/** Prepaid, or COD the customer approved. These wait in Ready to Dispatch until a label exists. */
export function isApprovedForDispatch(order: OrderTabSnapshot): boolean {
  if (isHighRtoCancel(order)) return false;
  return isPrepaidOrder(order) || isCodConfirmed(order);
}

export function mapShopifyShipmentStatus(
  shipmentStatus?: string | null
): 'CREATED' | 'IN_TRANSIT' | 'OUT_FOR_DELIVERY' | 'DELIVERED' | 'FAILED' | 'RTO' | 'RTO_DELIVERED' {
  switch ((shipmentStatus || '').toLowerCase()) {
    case 'delivered':
      return 'DELIVERED';
    case 'rto_delivered':
      return 'RTO_DELIVERED';
    case 'rto':
    case 'return_to_origin':
      return 'RTO';
    case 'failure':
    case 'attempted_delivery':
      return 'FAILED';
    case 'out_for_delivery':
      return 'OUT_FOR_DELIVERY';
    case 'in_transit':
      return 'IN_TRANSIT';
    default:
      // confirmed / label_printed / label_purchased / ready_for_pickup / empty
      // means the label exists and the seller is still waiting for pickup.
      return 'CREATED';
  }
}

export function trackingLabelFromShopify(shipmentStatus?: string | null): string {
  if (!shipmentStatus || mapShopifyShipmentStatus(shipmentStatus) === 'CREATED') {
    return 'Label generated';
  }
  return shipmentStatus.replace(/_/g, ' ');
}

function hasWaybill(order: OrderTabSnapshot): boolean {
  return Boolean(order.shipment?.waybillNumber);
}

function hasOpenReturn(order: OrderTabSnapshot): boolean {
  return (order.returns || []).some((entry) => {
    const status = entry?.returnStatus || entry?.status;
    return Boolean(status) && status !== 'CANCELLED';
  });
}

function isFinancialCancel(order: OrderTabSnapshot): boolean {
  const financial = (order.financialStatus || '').toLowerCase();
  return financial === 'voided' || financial === 'refunded';
}

function isShopifySyntheticTracking(text: string): boolean {
  return /^in transit\s*·/i.test(text.trim());
}

function isNotPickedText(text: string): boolean {
  const value = text.trim();
  if (!value) return false;
  if (/seller\s*cancel/i.test(value)) return false;
  if (isShopifySyntheticTracking(value)) return true;
  const withoutNotPicked = value.replace(/not\s*pick(?:ed)?/gi, '');
  const mentionsMovement = /in\s*transit|out\s*for\s*delivery|picked\s*up|pickup\s*done|\bdispatched\b|reached/i.test(
    withoutNotPicked
  );
  if (mentionsMovement) return false;
  return /manifest|not\s*pick|label\s*generated|softdata|awaiting\s*pickup|pickup\s*scheduled|\bopen\b|\bscheduled\b/i.test(
    value
  );
}

function isPickedText(text: string): boolean {
  const value = text.trim();
  if (!value || isNotPickedText(value)) return false;
  return /picked\s*up|pickup\s*done|in\s*transit|out\s*for\s*delivery|\bdispatched\b|reached|\bpending\b/i.test(
    value
  );
}

function isRtoSignal(text: string, shipStatus: string): boolean {
  if (shipStatus === 'RTO' || shipStatus === 'RTO_DELIVERED') return true;
  if (/seller\s*cancel/i.test(text)) return false;
  return /\brto\b|return to origin|\bdto\b/i.test(text);
}

function isDeliveredSignal(text: string, shipStatus: string): boolean {
  if (isRtoSignal(text, shipStatus)) return false;
  if (shipStatus === 'DELIVERED') return true;
  return /\bdelivered\b/i.test(text);
}

function isSellerCancelSignal(text: string, shipStatus: string): boolean {
  if (/seller\s*cancel/i.test(text)) return true;
  if (shipStatus === 'CANCELLED') return true;
  if (/\bcancel(?:l)?ed\b/i.test(text) && !isPickedText(text)) return true;
  return false;
}

export type CourierStage = 'none' | 'label' | 'transit' | 'delivered' | 'rto' | 'cancel';

/**
 * Where the parcel actually is, preferring a Delhivery poll over Shopify's
 * fulfillment status. A Delhivery waybill with no live scan yet is "label"
 * (Ready to Ship), including the case where Shopify already said in_transit.
 */
export function resolveCourierStage(order: OrderTabSnapshot): CourierStage {
  const shipment = order.shipment;
  if (!shipment?.waybillNumber) {
    return (shipment?.status || '').toUpperCase() === 'CANCELLED' ? 'cancel' : 'none';
  }

  const text = shipment.trackingStatus || '';
  const shipStatus = (shipment.status || '').toUpperCase();
  const live = Boolean(shipment.trackingUpdatedAt);

  if (isRtoSignal(text, shipStatus)) return 'rto';
  if (isDeliveredSignal(text, shipStatus)) return 'delivered';
  if (isSellerCancelSignal(text, shipStatus)) return 'cancel';

  if (live) {
    if (isNotPickedText(text)) return 'label';
    if (isPickedText(text)) return 'transit';
    if (['PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'FAILED'].includes(shipStatus)) return 'transit';
    return 'label';
  }

  if (isDelhiveryCourierName(shipment.courier)) {
    if (['OUT_FOR_DELIVERY', 'FAILED', 'PICKED_UP'].includes(shipStatus)) return 'transit';
    // IN_TRANSIT / CREATED / PENDING with no Delhivery poll is still at the seller.
    return 'label';
  }

  if (['PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'FAILED'].includes(shipStatus)) return 'transit';
  return 'label';
}

/** Map a live Delhivery shipment back onto the order status machine. */
export function orderStatusFromLiveTracking(shipment?: OrderTabShipment | null): string | null {
  if (!shipment?.trackingUpdatedAt) return null;
  const stage = resolveCourierStage({ status: 'NEW', shipment });
  switch (stage) {
    case 'delivered':
      return 'DELIVERED';
    case 'rto':
      return (shipment.status || '').toUpperCase() === 'RTO_DELIVERED' ? 'RTO_DELIVERED' : 'RTO_INITIATED';
    case 'cancel':
      return 'CANCELLED';
    case 'label':
      return 'DISPATCHED';
    case 'transit': {
      const shipStatus = (shipment.status || '').toUpperCase();
      const text = shipment.trackingStatus || '';
      if (shipStatus === 'OUT_FOR_DELIVERY' || /out for delivery/i.test(text)) return 'OUT_FOR_DELIVERY';
      if (shipStatus === 'FAILED') return 'FAILED_DELIVERY';
      if (shipStatus === 'PICKED_UP') return 'SHIPPED';
      return 'IN_TRANSIT';
    }
    default:
      return null;
  }
}

/**
 * A waybill saved when Delhivery rejected the manifest (low prepaid wallet,
 * or any other create failure). That number is only reserved — Delhivery has
 * no package, so tracking and webhooks never move it. A later live scan means
 * the package does exist.
 */
export function isManifestRejected(order: OrderTabSnapshot): boolean {
  const shipStatus = (order.shipment?.status || '').toUpperCase();
  const err = (order.shipment?.errorMessage || '').toLowerCase();
  const rejected =
    shipStatus === 'ERROR' ||
    /insufficient balance|manifest failed|manifest was rejected|low delhivery wallet/.test(err);
  if (!rejected) return false;
  if (!order.shipment?.trackingUpdatedAt) return true;
  const text = (order.shipment.trackingStatus || '').trim();
  if (!text || /^unknown$/i.test(text) || /not manifested/i.test(text)) return true;
  const stage = resolveCourierStage(order);
  return stage !== 'label' && stage !== 'transit' && stage !== 'delivered' && stage !== 'rto';
}

/**
 * Exactly one operational tab. Higher-priority outcomes (RTO, delivered,
 * cancel-before-pickup) win over the forward pipeline.
 */
export function classifyOrderTab(order: OrderTabSnapshot): OperationalTab {
  const stage = resolveCourierStage(order);

  if (RETURN_ORDER_STATUSES.has(order.status || '') || stage === 'rto' || hasOpenReturn(order)) {
    return 'return';
  }

  if (order.status === 'REFUNDED') {
    if (stage === 'none' || stage === 'label' || stage === 'cancel') return 'cancel';
    return 'return';
  }

  if (stage === 'delivered' || order.status === 'DELIVERED') {
    return 'delivered';
  }

  const awaitingPickup = stage === 'none' || stage === 'label';
  const preShipCancel =
    order.status === 'CANCELLED' ||
    stage === 'cancel' ||
    (isHighRtoCancel(order) && awaitingPickup) ||
    (isFinancialCancel(order) && awaitingPickup);

  if (preShipCancel && stage !== 'transit') {
    return 'cancel';
  }

  // Low-wallet / rejected manifests keep a reserved AWB that is not a shipment.
  // Those orders go back to Ready to Dispatch. Cancel and RTO already returned.
  if (isManifestRejected(order)) return 'dispatch';

  if (stage === 'transit') return 'transit';
  if (stage === 'label' || hasWaybill(order)) return 'ready';

  if (TRANSIT_ORDER_STATUSES.has(order.status || '')) return 'transit';

  if (isApprovedForDispatch(order)) return 'dispatch';
  return 'new';
}

export function isOperationalTab(tab?: string | null): tab is OperationalTab {
  return OPERATIONAL_TABS.includes((tab || '') as OperationalTab);
}
