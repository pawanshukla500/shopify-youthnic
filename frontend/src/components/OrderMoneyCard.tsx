import { useState } from 'react'
import { accountsStatus, RETURN_WINDOW_DAYS } from '../../../src/modules/orders/order-tabs'
import { apiError, markPaymentReceived } from '../api'
import { formatMoney, isVelocityCourier, shortDate } from '../lib'
import type { Order } from '../types'
import { Button, FormField, Panel, PanelHeading, useToast } from './UI'

const SOURCE_LABELS: Record<string, string> = {
  DELHIVERY_REMITTANCE: 'Delhivery COD remittance',
  VELOCITY_REMITTANCE: 'Velocity COD remittance',
  Velocity: 'Velocity COD remittance',
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
    if (parsedAmount === undefined && !order.paymentReceivedAt) {
      toast.toast('error', 'Enter the actual net amount credited to the bank.')
      return
    }
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
          <div>
            <div>
              <strong>{order.paymentReceivedAmount == null ? 'Amount not recorded' : formatMoney(order.paymentReceivedAmount)}</strong> on {shortDate(order.paymentReceivedAt)}
              <span className="money-muted"> · {SOURCE_LABELS[order.paymentReceivedSource || ''] || order.paymentReceivedSource}</span>
            </div>
            {order.gatewayFee && order.totalAmount ? (
              <div style={{ fontSize: '12px', color: 'var(--muted-light)', marginTop: '2px' }}>
                Net credited after deducting gateway fee & GST (Gross {formatMoney(order.totalAmount)} − Fee {formatMoney(order.gatewayFee)})
              </div>
            ) : null}
          </div>
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
      {order.gatewayFee ? (
        <Row label="Gateway fee">
          <strong>{formatMoney(order.gatewayFee)}</strong>
          <span className="money-muted"> · deducted at gateway (incl. 18% GST)</span>
        </Row>
      ) : null}
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
          <div>
            Forward: {costLabel(shipment?.forwardCharge, shipment?.shippingCostSource)}
            {shipment?.shippingCostSource === 'ACTUAL' && (
              <span style={{ marginLeft: '6px', fontSize: '12px', color: 'var(--tone-success-fg)', fontWeight: 700 }}>
                (Wallet Ledger Reconciled)
              </span>
            )}
          </div>
          {(shipment?.rtoCharge !== null && shipment?.rtoCharge !== undefined) || order.status.startsWith('RTO') ? (
            <div>RTO: {costLabel(shipment?.rtoCharge, shipment?.rtoChargeSource)}</div>
          ) : null}
          {(order.returns || []).some((r) => r.returnWaybillNumber) && (
            <div>Return pickup: {costLabel(returnCharge || null, returnSource)}</div>
          )}
          {totalShipping !== null && legs.length > 1 && <div><strong>Total: {formatMoney(totalShipping)}</strong></div>}
        </div>
      </Row>

      {/* ─── Delhivery Shipping Fee Ledger (WalletReport Actual Billed Debits & Refunds) ─── */}
      {shipment?.walletTransactions && shipment.walletTransactions.length > 0 ? (
        <div
          style={{
            marginTop: '12px',
            marginBottom: '4px',
            padding: '12px 14px',
            background: 'var(--line-subtle)',
            border: '1px solid var(--line)',
            borderRadius: '9px',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: '8px',
              marginBottom: '10px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '12.5px', fontWeight: 750, color: 'var(--ink)' }}>
                {shipment.courier || 'Courier'} shipping fee ledger
              </span>
              <span
                style={{
                  fontSize: '12px',
                  padding: '2px 8px',
                  borderRadius: '999px',
                  fontWeight: 750,
                  background:
                    shipment.billingStatus === 'REFUNDED' || (shipment.netBilledCost ?? 0) === 0
                      ? 'var(--tone-success-bg)'
                      : 'var(--tone-info-bg)',
                  color:
                    shipment.billingStatus === 'REFUNDED' || (shipment.netBilledCost ?? 0) === 0
                      ? 'var(--tone-success-fg)'
                      : 'var(--tone-info-fg)',
                  border:
                    shipment.billingStatus === 'REFUNDED' || (shipment.netBilledCost ?? 0) === 0
                      ? '1px solid var(--tone-success-border)'
                      : '1px solid var(--tone-info-border)',
                }}
              >
                {shipment.billingStatus === 'REFUNDED' || (shipment.netBilledCost ?? 0) === 0
                  ? 'Full Freight Refunded (Not Picked)'
                  : 'Actual Wallet Billed'}
              </span>
            </div>

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                fontSize: '12px',
                background: 'var(--panel)',
                padding: '4px 10px',
                borderRadius: '6px',
                border: '1px solid var(--line)',
              }}
            >
              <span>
                Debited: <strong style={{ color: 'var(--tone-danger-fg)' }}>-{formatMoney(shipment.totalDebited ?? 0)}</strong>
              </span>
              <span>
                Refunded: <strong style={{ color: 'var(--tone-success-fg)' }}>+{formatMoney(shipment.totalCredited ?? 0)}</strong>
              </span>
              <span>
                Net Freight:{' '}
                <strong
                  style={{
                    color:
                      (shipment.netBilledCost ?? 0) === 0 ? 'var(--tone-success-fg)' : 'var(--ink)',
                  }}
                >
                  {formatMoney(shipment.netBilledCost ?? 0)}
                </strong>
              </span>
            </div>
          </div>

          <div
            style={{
              overflowX: 'auto',
              border: '1px solid var(--line)',
              borderRadius: '7px',
              background: 'var(--panel)',
            }}
          >
            <table
              style={{
                width: '100%',
                fontSize: '12px',
                borderCollapse: 'collapse',
                textAlign: 'left',
              }}
            >
              <thead>
                <tr style={{ background: 'var(--line-subtle)', borderBottom: '1px solid var(--line)', color: 'var(--ink-secondary)' }}>
                  <th style={{ padding: '7px 10px', fontWeight: 650 }}>Date & Time</th>
                  <th style={{ padding: '7px 10px', fontWeight: 650 }}>Txn ID</th>
                  <th style={{ padding: '7px 10px', fontWeight: 650 }}>Type</th>
                  <th style={{ padding: '7px 10px', fontWeight: 650 }}>Description / Status</th>
                  <th style={{ padding: '7px 10px', fontWeight: 650 }}>Zone & Weight</th>
                  <th style={{ padding: '7px 10px', fontWeight: 650, textAlign: 'right' }}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {shipment.walletTransactions.map((tx, idx) => (
                  <tr
                    key={tx.txnId || idx}
                    style={{
                      borderBottom:
                        idx < shipment.walletTransactions!.length - 1
                          ? '1px solid var(--line)'
                          : 'none',
                    }}
                  >
                    <td style={{ padding: '7px 10px', whiteSpace: 'nowrap', color: 'var(--ink-secondary)' }}>
                      {tx.date}
                    </td>
                    <td style={{ padding: '7px 10px', fontFamily: 'monospace', fontSize: '12px' }}>
                      <span
                        onClick={() => {
                          navigator.clipboard.writeText(tx.txnId)
                          toast.toast('success', `Txn ID ${tx.txnId} copied!`)
                        }}
                        title="Click to copy Txn ID"
                        style={{
                          background: 'var(--surface-elevated)',
                          padding: '2px 5px',
                          borderRadius: '4px',
                          border: '1px solid var(--line)',
                          cursor: 'pointer',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '4px',
                        }}
                      >
                        <code>{tx.txnId}</code>
                        <span style={{ fontSize: '12px', opacity: 0.6 }}>📋</span>
                      </span>
                    </td>
                    <td style={{ padding: '7px 10px' }}>
                      <span
                        style={{
                          display: 'inline-block',
                          padding: '1.5px 7px',
                          borderRadius: '4px',
                          fontSize: '12px',
                          fontWeight: 750,
                          textTransform: 'uppercase',
                          background: tx.type === 'credit' ? 'var(--tone-success-bg)' : 'var(--tone-danger-bg)',
                          color: tx.type === 'credit' ? 'var(--tone-success-fg)' : 'var(--tone-danger-fg)',
                        }}
                      >
                        {tx.type}
                      </span>
                    </td>
                    <td style={{ padding: '7px 10px', color: 'var(--ink)', fontWeight: 550 }}>
                      {tx.description}
                    </td>
                    <td style={{ padding: '7px 10px', color: 'var(--muted)' }}>
                      {tx.zone ? `Zone ${tx.zone}` : ''}
                      {tx.weight ? ` · ${tx.weight}g` : ''}
                      {tx.status && !tx.description.includes(tx.status) ? ` · ${tx.status}` : ''}
                    </td>
                    <td
                      style={{
                        padding: '7px 10px',
                        textAlign: 'right',
                        fontWeight: 750,
                        color: tx.type === 'credit' ? 'var(--tone-success-fg)' : 'var(--tone-danger-fg)',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {tx.type === 'credit' ? `+${formatMoney(tx.amount)}` : `-${formatMoney(tx.amount)}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : shipment?.waybillNumber && shipment.shippingCostSource !== 'ACTUAL' ? (
        <div
          style={{
            marginTop: '8px',
            padding: '7px 10px',
            background: 'var(--line-subtle)',
            border: '1px solid var(--line)',
            borderRadius: '6px',
            fontSize: '12px',
            color: 'var(--muted)',
          }}
        >
          Estimated shipping cost {formatMoney(shipment.forwardCharge ?? 0)}.{' '}
          {isVelocityCourier(shipment.courier, shipment.waybillNumber)
            ? <>Use <em>Sync Velocity Details</em> on the Shipment tab to pull the billed charge.</>
            : (shipment.courier || '').toLowerCase().includes('delhivery')
              ? <>The exact charge appears once the Delhivery freight ledger is uploaded in <em>Payments &amp; Remittance</em>.</>
              : 'The exact charge appears once the carrier bill is recorded.'}
        </div>
      ) : null}

      {status.state === 'OPEN' && (
        <Row label="Waiting for">
          <ul className="money-pending" role="list">
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
