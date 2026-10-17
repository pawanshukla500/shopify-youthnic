import { Link } from 'react-router-dom'
import { formatDate, formatMoney, labelize } from '../lib'
import { orderFinancialSummary } from '../../../src/modules/orders/order-financials'
import type { Order } from '../types'
import { CopyableBadge, Panel, PanelHeading } from './UI'

export function OrderPaymentEvidence({ order }: { order: Order }) {
  const paid = orderFinancialSummary(order, order.items || []).paid
  return <Panel className="order-payment-evidence"><PanelHeading title="Payment & bank evidence" />
    <div className="order-evidence-columns"><div><h3>Customer payment</h3>
      <dl><div><dt>Status</dt><dd>{labelize(order.financialStatus)}</dd></div><div><dt>Recorded paid amount</dt><dd>{paid === null ? 'Not available' : formatMoney(paid, order.currency)}</dd></div>
        <div><dt>Provider</dt><dd>{order.paymentProvider || order.paymentGateway || (order.paymentMethod === 'COD' ? 'Cash on delivery' : 'Not recorded')}</dd></div>
        <div><dt>Transaction ID</dt><dd>{order.gatewayTransactionId ? <CopyableBadge text={order.gatewayTransactionId} /> : 'Not recorded'}</dd></div>
        <div><dt>Checkout reference</dt><dd>{order.paymentReference ? <CopyableBadge text={order.paymentReference} /> : 'Not recorded'}</dd></div></dl>
      <p>This is the customer’s payment reference, not Youthnic’s bank settlement UTR.</p>
    </div><div><h3>Bank settlement</h3><dl><div><dt>Evidence</dt><dd>{!order.paymentReceivedAt ? 'Awaiting bank settlement' : !order.paymentReceivedUtr ? 'Receipt recorded · bank UTR missing' : 'Bank receipt and UTR recorded'}</dd></div>
      <div><dt>Net bank credit</dt><dd>{order.paymentReceivedAt ? formatMoney(order.paymentReceivedAmount, order.currency) : 'Not received yet'}</dd></div>
      <div><dt>Bank UTR</dt><dd>{order.paymentReceivedUtr ? <CopyableBadge text={order.paymentReceivedUtr} /> : 'Not recorded'}</dd></div>
      <div><dt>Settlement reference</dt><dd>{order.paymentReceivedRef ? <CopyableBadge text={order.paymentReceivedRef} /> : 'Not recorded'}</dd></div>
      <div><dt>Recorded on</dt><dd>{formatDate(order.paymentReceivedAt)}</dd></div><div><dt>Source</dt><dd>{labelize(order.paymentReceivedSource)}</dd></div>
      <div><dt>Gateway fee</dt><dd>{formatMoney(order.gatewayFee, order.currency)}</dd></div></dl><Link to="/remittance">Review remittance reports</Link>
    </div></div>
  </Panel>
}
