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
  return (
    <div className="shopify-paid">
      <div className="shopify-paid-row"><span>Subtotal</span><span>{count} item{count === 1 ? '' : 's'}</span><strong>{display(amounts.subtotal)}</strong></div>
      {(amounts.discount === null || amounts.discount > 0) && (
        <div className="shopify-paid-row"><span>Discount</span><span>{order.discountCodes?.map((code) => code.code).join(', ')}</span><strong>{amounts.discount === null ? 'Not synced' : `-${display(amounts.discount)}`}</strong></div>
      )}
      <div className="shopify-paid-row"><span>Shipping</span><span>{order.shippingTitle || 'Shipping'}</span><strong>{amounts.shipping === 0 ? 'Free' : display(amounts.shipping)}</strong></div>
      <div className="shopify-paid-row"><span>Taxes</span><span>{taxDescription}{amounts.tax !== null ? ` · ${display(amounts.tax)}` : ''}</span><strong>{amounts.tax === null ? 'Not synced' : order.taxesIncluded === true ? 'Included' : display(amounts.tax)}</strong></div>
      <div className="shopify-paid-row is-total"><span>Total</span><span /><strong>{display(amounts.total)}</strong></div>
      <div className="shopify-paid-row is-paid"><span>Paid</span><span>{order.financialStatus === 'refunded' ? 'Refunded' : amounts.paid === 0 ? 'No payment captured' : ''}</span><strong>{display(amounts.paid)}</strong></div>
      {incomplete && <p className="shopify-sync-hint">Breakdown not yet synced. Use “Refresh from Shopify” to load the original shipping, discount and tax amounts.</p>}
    </div>
  )
}
