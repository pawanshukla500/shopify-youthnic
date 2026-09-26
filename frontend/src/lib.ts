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
