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
          <>
            <strong>{order.paymentReceivedAmount == null ? 'Amount not recorded' : formatMoney(order.paymentReceivedAmount)}</strong> on {shortDate(order.paymentReceivedAt)}
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
          <div>
            Forward: {costLabel(shipment?.forwardCharge, shipment?.shippingCostSource)}
            {shipment?.shippingCostSource === 'ACTUAL' && (
              <span style={{ marginLeft: '6px', fontSize: '11px', color: '#059669', fontWeight: 700 }}>
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
                📦 Delhivery Shipping Fee Ledger
              </span>
              <span
                style={{
                  fontSize: '10px',
                  padding: '2px 8px',
                  borderRadius: '999px',
                  fontWeight: 750,
                  background:
                    shipment.billingStatus === 'REFUNDED' || (shipment.netBilledCost ?? 0) === 0
                      ? '#ecfdf5'
                      : '#eff6ff',
                  color:
                    shipment.billingStatus === 'REFUNDED' || (shipment.netBilledCost ?? 0) === 0
                      ? '#059669'
                      : '#2563eb',
                  border:
                    shipment.billingStatus === 'REFUNDED' || (shipment.netBilledCost ?? 0) === 0
                      ? '1px solid #a7f3d0'
                      : '1px solid #bfdbfe',
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
                fontSize: '11px',
                background: 'var(--panel)',
                padding: '4px 10px',
                borderRadius: '6px',
                border: '1px solid var(--line)',
              }}
            >
              <span>
                Debited: <strong style={{ color: '#e11d48' }}>-{formatMoney(shipment.totalDebited ?? 0)}</strong>
              </span>
              <span>
                Refunded: <strong style={{ color: '#16a34a' }}>+{formatMoney(shipment.totalCredited ?? 0)}</strong>
              </span>
              <span>
                Net Freight:{' '}
                <strong
                  style={{
                    color:
                      (shipment.netBilledCost ?? 0) === 0 ? '#16a34a' : 'var(--ink)',
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
                fontSize: '11px',
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
                          ? '1px solid #f1f5f9'
                          : 'none',
                    }}
                  >
                    <td style={{ padding: '7px 10px', whiteSpace: 'nowrap', color: 'var(--ink-secondary)' }}>
                      {tx.date}
                    </td>
                    <td style={{ padding: '7px 10px', fontFamily: 'monospace', fontSize: '11px' }}>
                      <span
                        onClick={() => {
                          navigator.clipboard.writeText(tx.txnId)
                          toast.toast('success', `Txn ID ${tx.txnId} copied!`)
                        }}
                        title="Click to copy Txn ID"
                        style={{
                          background: '#f1f5f9',
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
                        <span style={{ fontSize: '9px', opacity: 0.6 }}>📋</span>
                      </span>
                    </td>
                    <td style={{ padding: '7px 10px' }}>
                      <span
                        style={{
                          display: 'inline-block',
                          padding: '1.5px 7px',
                          borderRadius: '4px',
                          fontSize: '9.5px',
                          fontWeight: 750,
                          textTransform: 'uppercase',
                          background: tx.type === 'credit' ? '#dcfce7' : '#ffe4e6',
                          color: tx.type === 'credit' ? '#15803d' : '#be123c',
                        }}
                      >
                        {tx.type}
                      </span>
                    </td>
                    <td style={{ padding: '7px 10px', color: '#1e293b', fontWeight: 550 }}>
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
                        color: tx.type === 'credit' ? '#16a34a' : '#e11d48',
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
      ) : shipment?.waybillNumber ? (
        <div
          style={{
            marginTop: '8px',
            padding: '7px 10px',
            background: 'var(--line-subtle)',
            border: '1px solid #f1f5f9',
            borderRadius: '6px',
            fontSize: '11px',
            color: 'var(--muted)',
          }}
        >
          ℹ️ <strong>Delhivery Shipping Fee Ledger:</strong> Showing estimated rate (
          {formatMoney(shipment.forwardCharge ?? 0)}). Upload your monthly Delhivery Wallet Report
          in <em>Accounts & Remittances</em> to reconcile exact debits & refunds per AWB.
        </div>
      ) : null}

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
