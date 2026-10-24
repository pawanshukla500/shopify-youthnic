import { Link } from 'react-router-dom'
import { formatDate, formatMoney, labelize, getPaymentLogoUrl } from '../lib'
import { orderFinancialSummary } from '../../../src/modules/orders/order-financials'
import type { Order } from '../types'
import { CopyableBadge, Panel, PanelHeading } from './UI'

export function OrderPaymentEvidence({ order }: { order: Order }) {
  const paid = orderFinancialSummary(order, order.items || []).paid
  const isCod = order.paymentMethod === 'COD' || /cod|cash/i.test(order.paymentMethod || '')
  const isVelocityShipment = Boolean(
    order.shipment?.courier &&
      (order.shipment.courier.toLowerCase().includes('velocity') ||
        order.shipment.labelUrl?.includes('velocity') ||
        order.paymentReceivedSource === 'Velocity')
  )

  const paymentLogo = getPaymentLogoUrl(order.paymentProvider, order.paymentGateway, order.paymentMethod)
  const settlementLogo = getPaymentLogoUrl(
    undefined,
    undefined,
    undefined,
    isCod && isVelocityShipment ? 'Velocity' : order.paymentReceivedSource
  )

  return (
    <Panel className="order-payment-evidence">
      <PanelHeading title="Payment & bank evidence" />
      <div className="order-evidence-columns">
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
            <h3 style={{ margin: 0 }}>Customer payment</h3>
            {paymentLogo && (
              <img
                src={paymentLogo}
                alt=""
                style={{ height: '22px', maxWidth: '85px', objectFit: 'contain' }}
                onError={(e) => {
                  ;(e.currentTarget as HTMLElement).style.display = 'none'
                }}
              />
            )}
          </div>
          <dl>
            <div>
              <dt>Payment Mode</dt>
              <dd>
                <strong>{isCod ? 'Cash on Delivery (COD)' : 'Pre-paid (Online)'}</strong>
              </dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{labelize(order.financialStatus)}</dd>
            </div>
            <div>
              <dt>Recorded paid amount</dt>
              <dd>{paid === null ? 'Not available' : formatMoney(paid, order.currency)}</dd>
            </div>
            <div>
              <dt>Provider / Gateway</dt>
              <dd>
                {isCod
                  ? 'Cash on Delivery'
                  : order.paymentProvider || order.paymentGateway || 'GoKwik / PhonePe'}
              </dd>
            </div>
            <div>
              <dt>Transaction ID</dt>
              <dd>
                {order.gatewayTransactionId ? (
                  <CopyableBadge text={order.gatewayTransactionId} />
                ) : (
                  'Not recorded'
                )}
              </dd>
            </div>
            <div>
              <dt>Checkout reference</dt>
              <dd>
                {order.paymentReference ? <CopyableBadge text={order.paymentReference} /> : 'Not recorded'}
              </dd>
            </div>
          </dl>
          <p>
            {isCod
              ? isVelocityShipment
                ? 'COD order handled via Velocity. Cash is collected at doorstep by the delivery agent and remitted directly to Youthnic.'
                : 'Customer payment is collected at doorstep in cash by the courier partner upon delivery.'
              : `Prepaid order: payment was captured at checkout via ${order.paymentProvider || order.paymentGateway || 'online payment gateway'}.`}
          </p>
        </div>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
            <h3 style={{ margin: 0 }}>Bank settlement & Remittance</h3>
            {settlementLogo && (
              <img
                src={settlementLogo}
                alt=""
                style={{ height: '22px', maxWidth: '85px', objectFit: 'contain' }}
                onError={(e) => {
                  ;(e.currentTarget as HTMLElement).style.display = 'none'
                }}
              />
            )}
          </div>
          <dl>
            <div>
              <dt>Remittance Status</dt>
              <dd>
                {isCod && isVelocityShipment && order.shipment?.codRemitted
                  ? (order.paymentReceivedUtr || (order.shipment?.codRemittanceRef && order.shipment.codRemittanceRef !== 'VELOCITY_REMITTANCE'))
                    ? 'Remitted by Velocity via Bank UTR'
                    : 'Remitted by Velocity · Bank UTR in transit'
                  : isCod && isVelocityShipment && order.shipment?.codCollected
                  ? 'Cash Collected · Awaiting Velocity Remittance Cycle'
                  : !order.paymentReceivedAt
                  ? isCod
                    ? 'Awaiting delivery & cash collection'
                    : 'Awaiting gateway bank settlement'
                  : !order.paymentReceivedUtr
                  ? 'Receipt recorded · bank UTR missing'
                  : 'Bank receipt and UTR recorded'}
              </dd>
            </div>
            <div>
              <dt>Net bank credit</dt>
              <dd>
                {order.paymentReceivedAt
                  ? formatMoney(order.paymentReceivedAmount, order.currency)
                  : order.shipment?.codRemittedAmount
                  ? formatMoney(order.shipment.codRemittedAmount, order.currency)
                  : 'Not received yet'}
              </dd>
            </div>
            <div>
              <dt>Bank UTR</dt>
              <dd>
                {order.paymentReceivedUtr ? (
                  <CopyableBadge text={order.paymentReceivedUtr} />
                ) : order.shipment?.codRemittanceRef && order.shipment.codRemittanceRef !== 'VELOCITY_REMITTANCE' ? (
                  <CopyableBadge text={order.shipment.codRemittanceRef} />
                ) : (
                  'Not recorded'
                )}
              </dd>
            </div>
            <div>
              <dt>Settlement reference</dt>
              <dd>
                {order.paymentReceivedRef ? (
                  <CopyableBadge text={order.paymentReceivedRef} />
                ) : order.shipment?.codRemittanceRef ? (
                  <CopyableBadge text={order.shipment.codRemittanceRef} />
                ) : (
                  'Not recorded'
                )}
              </dd>
            </div>
            <div>
              <dt>Recorded on</dt>
              <dd>{formatDate(order.paymentReceivedAt || order.shipment?.codRemittedAt)}</dd>
            </div>
            <div>
              <dt>Settlement Source</dt>
              <dd>
                {isCod && isVelocityShipment
                  ? 'Velocity COD Remittance'
                  : labelize(order.paymentReceivedSource) || (isCod ? 'Courier COD' : 'Payment Gateway')}
              </dd>
            </div>
            <div>
              <dt>Gateway fee</dt>
              <dd>{formatMoney(order.gatewayFee, order.currency)}</dd>
            </div>
          </dl>
          <Link to="/remittance">Review remittance reports</Link>
        </div>
      </div>
    </Panel>
  )
}
