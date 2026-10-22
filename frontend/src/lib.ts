import type { OrderStatus, ReturnStatus, ShipmentStatus } from './types'

export const ORDER_STATUSES: OrderStatus[] = [
  'NEW',
  'DISPATCH_PENDING',
  'DISPATCHED',
  'SHIPPED',
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'FAILED_DELIVERY',
  'RTO_INITIATED',
  'RTO_DELIVERED',
  'RETURN_REQUESTED',
  'RETURN_DISPATCHED',
  'RETURN_RECEIVED',
  'REFUNDED',
  'CANCELLED',
]

export type OrderTabKey = 'all' | 'new' | 'dispatch' | 'ready' | 'transit' | 'delivered' | 'closed' | 'return' | 'cancel'

export interface OrderTabDef {
  key: OrderTabKey
  label: string
  hint: string
  statuses: OrderStatus[]
  hasWaybill?: boolean
  color: string
}

/**
 * Orders-page queues. Membership is decided on the server by classifyOrderTab
 * (Shopify tags + Delhivery live tracking). The status lists are only a
 * deep-link hint for ?status= URLs.
 */
export const ORDER_TABS: OrderTabDef[] = [
  { key: 'all', label: 'All', hint: 'Every order received into the OMS.', statuses: [], color: '#2563eb' },
  {
    key: 'new',
    label: 'New Order',
    hint: 'Received, not reviewed, not approved, and not shipped. Unconfirmed COD stays here.',
    statuses: ['NEW'],
    color: '#2563eb',
  },
  {
    key: 'dispatch',
    label: 'Ready to Dispatch',
    hint: 'Prepaid, or COD approved via Low RTO / COD_CONFIRMED. No label yet and nothing updated in Delhivery.',
    statuses: ['DISPATCH_PENDING'],
    hasWaybill: false,
    color: '#dc2626',
  },
  {
    key: 'ready',
    label: 'Ready to Ship',
    hint: 'Label generated with the courier. Still at the seller — Manifested or Not Picked, waiting for pickup.',
    statuses: ['DISPATCHED'],
    hasWaybill: true,
    color: '#059669',
  },
  {
    key: 'transit',
    label: 'In Transit',
    hint: 'Picked up from the seller and moving until it is delivered. Includes out-for-delivery and NDR attempts.',
    statuses: ['SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'FAILED_DELIVERY'],
    color: '#7c3aed',
  },
  {
    key: 'delivered',
    label: 'Delivered',
    hint: 'Delivered to the customer. Moves to Payment Received once the money is in the bank and the 7-day return window is over.',
    statuses: ['DELIVERED'],
    color: '#059669',
  },
  {
    key: 'closed',
    label: 'Payment Received',
    hint: 'Delivered, payment received in the bank (UTR recorded) and the 7-day return window closed. Done for accounts.',
    // No status of its own: the server moves delivered orders here.
    statuses: [],
    color: '#0f766e',
  },
  {
    key: 'return',
    label: 'Return',
    hint: 'RTO and customer return orders.',
    statuses: ['RTO_INITIATED', 'RTO_DELIVERED', 'RETURN_REQUESTED', 'RETURN_DISPATCHED', 'RETURN_RECEIVED', 'REFUNDED'],
    color: '#9333ea',
  },
  {
    key: 'cancel',
    label: 'Cancel',
    hint: 'Cancelled before pickup, including COD_CANCELLED and High RTO cancels.',
    statuses: ['CANCELLED'],
    color: '#64748b',
  },
]

/** Map a legacy ?status= value to its tab (deep-link compat). AWB decides dispatch vs ready. */
export function tabForStatus(status: string | null | undefined, hasWaybill?: boolean | null): OrderTabKey {
  if (!status) return 'all'
  const upper = status.toUpperCase()
  if (upper === 'DISPATCHED' || ((upper === 'DISPATCH_PENDING' || upper === 'NEW') && hasWaybill)) return 'ready'
  if (upper === 'DISPATCH_PENDING') return 'dispatch'
  const found = ORDER_TABS.find((t) => t.statuses.includes(upper as OrderStatus))
  if (!found) return 'all'
  return found.key
}

export const RETURN_STATUSES: ReturnStatus[] = [
  'INITIATED',
  'PICKUP_SCHEDULED',
  'PICKED_UP',
  'IN_TRANSIT',
  'RECEIVED',
  'QC_PENDING',
  'QC_APPROVED',
  'QC_REJECTED',
  'REFUND_PENDING',
  'REFUNDED',
  'CANCELLED',
]

export function labelize(value: string | null | undefined): string {
  if (!value) return '—'
  return value
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

export function formatMoney(amount: number | null | undefined, currency = 'INR'): string {
  if (amount === null || amount === undefined || Number.isNaN(Number(amount))) return '—'
  try {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: currency || 'INR',
      maximumFractionDigits: 2,
    }).format(Number(amount))
  } catch {
    return `₹${Number(amount).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
  }
}

/** Public carrier tracking page. Never use a packing-slip URL here — those S3 links expire. */
export function carrierTrackingUrl(courier: string | null | undefined, waybill: string): string {
  const name = (courier || '').toLowerCase()
  const wb = (waybill || '').trim()
  if (
    name.includes('velocity') ||
    name.includes('shipfastt') ||
    name.includes('amazon') ||
    name.includes('ats') ||
    /^(pd|vehr|vel)/i.test(wb)
  ) {
    return `https://www.velocityshipping.in/track/${encodeURIComponent(wb)}`
  }
  if (name.includes('ekart') || name.includes('proship')) return `https://t.proship.in/${encodeURIComponent(wb)}`
  if (name.includes('bluedart')) return `https://www.bluedart.com/tracking?trackNumber=${encodeURIComponent(wb)}`
  if (name.includes('dtdc')) return `https://www.dtdc.in/tracking/shipment-tracking.asp?trackingNo=${encodeURIComponent(wb)}`
  return `https://www.delhivery.com/track/package/${encodeURIComponent(wb)}`
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

export function shortDate(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }).format(date)
}

export function statusTone(status: string | null | undefined): string {
  const normalized = status ?? ''
  if (['DELIVERED', 'RTO_DELIVERED', 'REFUNDED', 'PROCESSED', 'QC_APPROVED', 'APPROVED'].includes(normalized)) {
    return 'status-success'
  }
  if (['IN_TRANSIT', 'SHIPPED', 'DISPATCHED', 'PICKED_UP', 'OUT_FOR_DELIVERY', 'CREATED'].includes(normalized)) {
    return 'status-info'
  }
  if (['FAILED', 'FAILED_DELIVERY', 'CANCELLED', 'QC_REJECTED', 'REJECTED', 'ERROR'].includes(normalized)) {
    return 'status-danger'
  }
  if (['RETURN_REQUESTED', 'RETURN_DISPATCHED', 'RETURN_RECEIVED', 'QC_PENDING', 'REFUND_PENDING', 'PARTIAL'].includes(normalized)) {
    return 'status-purple'
  }
  return 'status-warning'
}

export function shipmentTone(status: ShipmentStatus | null | undefined): string {
  return statusTone(status)
}
