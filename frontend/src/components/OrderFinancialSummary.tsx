import { orderFinancialSummary } from '../../../src/modules/orders/order-financials'
import { formatMoney } from '../lib'
import type { Order, OrderItem } from '../types'

export function OrderFinancialSummary({ order, items, currency }: { order: Order; items: OrderItem[]; currency: string }) {
  const amounts = orderFinancialSummary(order, items)
  const display = (value: number | null) => value === null ? 'Not synced' : formatMoney(value, currency)
  const count = items.reduce((sum, item) => sum + item.quantity, 0)
  const taxDescription = order.taxLines?.map((line) =>
    `${line.title} ${Math.round(line.rate * 10000) / 100}%`
  ).join(' · ') || 'Shopify tax'
  const incomplete = amounts.shipping === null || amounts.discount === null || amounts.tax === null

  const paidAmount = amounts.paid ?? 0
  const paidTone =
    order.financialStatus === 'refunded'
      ? 'is-paid-none'
      : paidAmount <= 0
        ? 'is-paid-none'
        : amounts.total !== null && paidAmount >= amounts.total
          ? 'is-paid-ok'
          : 'is-paid-part'
  const paidCaption =
    order.financialStatus === 'refunded'
      ? 'Refunded to customer'
      : paidAmount <= 0
        ? 'No payment captured'
        : amounts.total !== null && paidAmount >= amounts.total
          ? 'Fully paid'
          : 'Partially paid'

  return (
    <div className="shopify-paid">
      <div className="shopify-paid-row"><span className="shopify-paid-label">Subtotal</span><span className="shopify-paid-desc">{count} item{count === 1 ? '' : 's'}</span><strong>{display(amounts.subtotal)}</strong></div>
      {(amounts.discount === null || amounts.discount > 0) && (
        <div className="shopify-paid-row"><span className="shopify-paid-label">Discount</span><span className="shopify-paid-desc">{order.discountCodes?.map((code) => code.code).join(', ') || '—'}</span><strong>{amounts.discount === null ? 'Not synced' : `-${display(amounts.discount)}`}</strong></div>
      )}
      <div className="shopify-paid-row"><span className="shopify-paid-label">Shipping</span><span className="shopify-paid-desc">{order.shippingTitle || 'Shipping'}</span><strong>{amounts.shipping === 0 ? 'Free' : display(amounts.shipping)}</strong></div>
      <div className="shopify-paid-row"><span className="shopify-paid-label">Taxes</span><span className="shopify-paid-desc">{taxDescription}{amounts.tax !== null ? ` · ${display(amounts.tax)}` : ''}</span><strong>{amounts.tax === null ? 'Not synced' : order.taxesIncluded === true ? 'Included' : display(amounts.tax)}</strong></div>
      <div className="shopify-paid-row is-total"><span className="shopify-paid-label">Total</span><span className="shopify-paid-desc" /><strong>{display(amounts.total)}</strong></div>
      <div className={`shopify-paid-row is-paid ${paidTone}`}>
        <span className="shopify-paid-label">Paid</span>
        <span className="shopify-paid-desc">{paidCaption}</span>
        <strong><span className="shopify-paid-dot" aria-hidden="true" />{display(amounts.paid)}</strong>
      </div>
      {incomplete && <p className="shopify-sync-hint">Breakdown not yet synced. Use “Refresh from Shopify” to load the original shipping, discount and tax amounts.</p>}
    </div>
  )
}
