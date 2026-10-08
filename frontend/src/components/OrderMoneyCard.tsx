import { useState } from 'react'
import { accountsStatus, RETURN_WINDOW_DAYS } from '../../../src/modules/orders/order-tabs'
import { apiError, markPaymentReceived } from '../api'
import { formatMoney, shortDate } from '../lib'
import type { Order } from '../types'
import { Button, FormField, Panel, PanelHeading, useToast } from './UI'

const SOURCE_LABELS: Record<string, string> = {
  DELHIVERY_REMITTANCE: 'Delhivery COD remittance',
  PG_SETTLEMENT_REPORT: 'Gateway settlement report',
  PHONEPE_SETTLEMENT_API: 'PhonePe settlement',
  EASEBUZZ_PAYOUT_API: 'Easebuzz payout',
  MANUAL: 'Entered manually',
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="money-row">
      <span>{label}</span>
      <div>{children}</div>
    </div>
  )
}

function costLabel(amount: number | null | undefined, source?: string | null) {
  if (amount === null || amount === undefined) return <span className="money-muted">not known yet</span>
  return (
    <>
      {formatMoney(amount)} <span className="money-muted">{source === 'ACTUAL' ? 'billed' : 'estimate'}</span>
    </>
  )
}

/**
 * Everything the accounts team needs about one order: was the money received
 * into the bank (and the UTR), is the return window over, and what shipping
 * cost — so "is this order done?" has one answer.
 */
export function OrderMoneyCard({ order, onChanged }: { order: Order; onChanged: () => void }) {
  const toast = useToast()
  const status = accountsStatus(order)
  const [editing, setEditing] = useState(false)
  const [utr, setUtr] = useState('')
  const [amount, setAmount] = useState('')
  const [receivedAt, setReceivedAt] = useState('')
  const [saving, setSaving] = useState(false)

  const shipment = order.shipment
  const returnCharge = (order.returns || []).reduce((sum, r) => sum + (r.shippingCharge || 0), 0)
  const returnSource = (order.returns || []).find((r) => r.shippingCostSource)?.shippingCostSource
  const legs = [shipment?.forwardCharge, shipment?.rtoCharge, returnCharge || null].filter(
    (v): v is number => v !== null && v !== undefined
  )
  const totalShipping = legs.length ? legs.reduce((a, b) => a + b, 0) : null

  const save = async () => {
    if (!utr.trim()) {
      toast.toast('error', 'Enter the bank UTR.')
      return
    }
    const parsedAmount = amount.trim() ? Number(amount.replace(/[₹,\s]/g, '')) : undefined
    if (parsedAmount !== undefined && (!Number.isFinite(parsedAmount) || parsedAmount < 0)) {
      toast.toast('error', 'Enter the amount as a number, e.g. 1299.50.')
      return
    }
    setSaving(true)
    try {
      const result = await markPaymentReceived(order.id, {
        utr: utr.trim(),
        amount: parsedAmount,
        receivedAt: receivedAt || undefined,
      })
      toast.toast('success', result.closedNow ? 'Payment recorded. The order is now in Payment Received.' : 'Payment recorded.')
      setEditing(false)
      onChanged()
    } catch (error) {
      toast.toast('error', apiError(error))
    } finally {
      setSaving(false)
    }
  }

  const badge =
    status.state === 'CLOSED'
      ? { text: 'Closed for accounts', className: 'money-badge money-badge-closed' }
      : status.state === 'OPEN'
        ? { text: 'Open', className: 'money-badge money-badge-open' }
        : { text: 'Not a sale', className: 'money-badge' }

  return (
    <Panel>
      <PanelHeading eyebrow="Money & accounts" title="Payment, return window & shipping cost" action={<span className={badge.className}>{badge.text}</span>} />

      <Row label="Payment in bank">
        {order.paymentReceivedAt ? (
          <>
            <strong>{formatMoney(order.paymentReceivedAmount ?? order.totalAmount)}</strong> on {shortDate(order.paymentReceivedAt)}
            <span className="money-muted"> · {SOURCE_LABELS[order.paymentReceivedSource || ''] || order.paymentReceivedSource}</span>
          </>
        ) : (
          <span className="money-muted">
            Not yet. {order.paymentMethod === 'COD' ? 'Comes with the Delhivery COD remittance.' : 'Comes with the gateway settlement.'}
          </span>
        )}
      </Row>
      {order.paymentReceivedUtr && (
        <Row label="Bank UTR">
          <code>{order.paymentReceivedUtr}</code>
          {order.paymentReceivedRef && <span className="money-muted"> · ref {order.paymentReceivedRef}</span>}
        </Row>
      )}
      {order.gatewayFee ? <Row label="Gateway fee">{formatMoney(order.gatewayFee)}</Row> : null}
      {order.paymentMethod !== 'COD' && order.paymentReference && (
        <Row label="Customer payment ref">
          <code>{order.paymentReference}</code>
        </Row>
      )}

      <Row label={`Return window (${RETURN_WINDOW_DAYS} days)`}>
        {status.returnWindowClosesAt
          ? status.returnWindowClosed
            ? <>Closed on {shortDate(status.returnWindowClosesAt.toISOString())}</>
            : <>Open until {shortDate(status.returnWindowClosesAt.toISOString())}</>
          : <span className="money-muted">Starts when the order is delivered</span>}
      </Row>

      <Row label="Shipping cost">
        <div className="money-legs">
          <div>Forward: {costLabel(shipment?.forwardCharge, shipment?.shippingCostSource)}</div>
          {(shipment?.rtoCharge !== null && shipment?.rtoCharge !== undefined) || order.status.startsWith('RTO') ? (
            <div>RTO: {costLabel(shipment?.rtoCharge, shipment?.rtoChargeSource)}</div>
          ) : null}
          {(order.returns || []).some((r) => r.returnWaybillNumber) && (
            <div>Return pickup: {costLabel(returnCharge || null, returnSource)}</div>
          )}
          {totalShipping !== null && legs.length > 1 && <div><strong>Total: {formatMoney(totalShipping)}</strong></div>}
        </div>
      </Row>

      {status.state === 'OPEN' && (
        <Row label="Waiting for">
          <ul className="money-pending">
            {status.pending.map((item) => (
              <li key={item}>
                {item.startsWith('Return window open until') && status.returnWindowClosesAt
                  ? `Return window to close on ${shortDate(status.returnWindowClosesAt.toISOString())}`
                  : item}
              </li>
            ))}
          </ul>
        </Row>
      )}

      {!order.paymentReceivedUtr && status.state !== 'NOT_A_SALE' && (
        <div style={{ marginTop: '10px' }}>
          {!editing ? (
            <Button className="button-secondary button-small" onClick={() => setEditing(true)}>
              {order.paymentReceivedAt ? 'Add bank UTR' : 'Mark payment received'}
            </Button>
          ) : (
            <div className="money-form">
              <FormField label="Bank UTR">
                <input value={utr} onChange={(e) => setUtr(e.target.value)} placeholder="UTR of the credit" />
              </FormField>
              <FormField label="Amount (₹)">
                <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={String(order.totalAmount)} inputMode="decimal" />
              </FormField>
              <FormField label="Received on">
                <input type="date" value={receivedAt} onChange={(e) => setReceivedAt(e.target.value)} />
              </FormField>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end' }}>
                <Button className="button-primary button-small" loading={saving} onClick={save}>Save</Button>
                <Button className="button-secondary button-small" onClick={() => setEditing(false)}>Cancel</Button>
              </div>
            </div>
          )}
        </div>
      )}
    </Panel>
  )
}
