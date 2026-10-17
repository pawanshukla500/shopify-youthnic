import type { Order, TrackingLog } from './types'

export const ORDER_SECTIONS = [
  { key: 'overview', label: 'Overview' },
  { key: 'shipment', label: 'Shipment' },
  { key: 'payments', label: 'Payments' },
  { key: 'returns', label: 'Returns' },
  { key: 'details', label: 'Details' },
] as const
export type OrderSection = typeof ORDER_SECTIONS[number]['key']

export function contactPhone(phone: string | null | undefined): string {
  const digits = (phone || '').replace(/\D/g, '')
  return digits.length === 10 ? `91${digits}` : digits
}

/** UI eligibility only; the server remains authoritative. RTO is not delivery to the buyer. */
export function hasCustomerDelivery(order: Order): boolean {
  if (['CANCELLED', 'RTO_INITIATED', 'RTO_DELIVERED', 'REFUNDED'].includes(order.status)) return false
  return Boolean(order.deliveredAt) || order.status === 'DELIVERED' || order.shipment?.status === 'DELIVERED'
}

/** Merge equivalent webhook/poll display scans only. Stored carrier history is untouched. */
export function displayTrackingEvents(logs: TrackingLog[] = []): TrackingLog[] {
  const normalize = (value: string | null | undefined) => (value || '').trim().replace(/\s+/g, ' ').toLowerCase()
  const seen = new Set<string>()
  return [...logs].sort((a, b) => (Date.parse(b.scannedAt) || 0) - (Date.parse(a.scannedAt) || 0))
    .filter((log) => {
      const parsed = Date.parse(log.scannedAt)
      const status = normalize(log.status).replace(/^ud\s*:\s*/, '')
      const key = JSON.stringify([Number.isFinite(parsed) ? parsed : log.scannedAt, status, normalize(log.location), normalize(log.remark)])
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}
