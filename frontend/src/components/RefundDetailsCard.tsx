import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { apiError, sendOrderRefundEmail, syncOrderRefundDetails } from '../api'
import { formatDate, formatMoney, getPaymentLogoUrl } from '../lib'
import type { Order, ReturnRecord } from '../types'
import { Icon, useToast } from './UI'

interface RefundDetailsCardProps {
  order: Order
  returnRecord?: ReturnRecord | null
  standalone?: boolean
  compact?: boolean
}

function findAttr(order: Order, names: string[]): string | null {
  const details = order.additionalDetails
  if (!Array.isArray(details)) return null
  const targets = names.map((n) => n.toLowerCase().replace(/[^a-z0-9]/g, ''))
  for (const target of targets) {
    const match = details.find(
      (item) => item?.name && String(item.name).toLowerCase().replace(/[^a-z0-9]/g, '') === target && item.value
    )
    if (match?.value) return String(match.value).trim()
  }
  return null
}

function stageMeta(stage: string | null | undefined, hasBankRef: boolean, isManualCod: boolean): {
  label: string
  toneClass: string
  headline: string
} {
  const s = (stage || '').toUpperCase()
  if (s === 'FAILED') {
    return {
      label: 'Gateway Refund Failed',
      toneClass: 'is-danger',
      headline: 'Refund Failed',
    }
  }
  if (s === 'SETTLED') {
    return {
      label: 'Settled in Gateway Payout',
      toneClass: 'is-success',
      headline: 'Refund Credited & Settled',
    }
  }
  if (s === 'MANUAL_RECORDED' || isManualCod) {
    return {
      label: 'Manual COD Payout',
      toneClass: 'is-success',
      headline: 'Manual COD Refund Recorded',
    }
  }
  if (s === 'CREDITED' || (!s && hasBankRef)) {
    return {
      label: 'Credited · Bank Ref Verified',
      toneClass: 'is-success',
      headline: 'Refund Credited to Source',
    }
  }
  return {
    label: 'Initiated · Awaiting Bank RRN',
    toneClass: 'is-pending',
    headline: 'Refund Processed on Shopify',
  }
}

export function RefundDetailsCard({
  order,
  returnRecord,
  standalone = false,
  compact = false,
}: RefundDetailsCardProps) {
  const queryClient = useQueryClient()
  const toast = useToast()
  const [syncing, setSyncing] = useState(false)
  const [emailing, setEmailing] = useState(false)

  const summary = order.refundSummary || null
  const isCodOrder = order.paymentMethod === 'COD' || /cash/i.test(order.paymentGateway || '')
  const isManualCod = Boolean(
    summary?.isManualCod ||
    returnRecord?.refundGatewayStatus === 'MANUAL_RECORDED' ||
    order.refundGatewayStatus === 'MANUAL_RECORDED'
  )

  const fallbackRrn = findAttr(order, ['Refund RRN', 'refund_rrn', 'return_rrn'])
  const fallbackArn = findAttr(order, ['Refund ARN', 'refund_arn', 'gateway_refund_id'])
  const fallbackMethod = findAttr(order, ['Payment_Method', 'payment_method'])
  const fallbackSub = findAttr(order, ['Payment_Sub_Method', 'payment_sub_method'])
  const fallbackInstrument = fallbackMethod
    ? fallbackSub && fallbackSub.toLowerCase() !== fallbackMethod.toLowerCase()
      ? `${fallbackMethod === 'Cards' ? `${fallbackSub} Card` : `${fallbackMethod} (${fallbackSub})`}`
      : fallbackMethod
    : null

  const isPartial = order.financialStatus === 'partially_refunded' || Boolean(summary?.isPartial)

  const refundAmount =
    (typeof returnRecord?.refundAmount === 'number' && returnRecord.refundAmount > 0 ? returnRecord.refundAmount : null) ??
    summary?.refundAmount ??
    (isPartial ? null : order.totalAmount)

  const refundRrn = returnRecord?.refundRrn || summary?.refundRrn || order.refundRrn || fallbackRrn || null
  const refundArn = returnRecord?.refundArn || summary?.refundArn || order.refundArn || fallbackArn || null
  const shopifyRefundId = returnRecord?.shopifyRefundId || summary?.shopifyRefundId || null
  const refundTxnId = returnRecord?.refundTransactionId || summary?.refundTransactionId || null
  const settlementBatchUtr = summary?.settlementBatchUtr || null

  const refundSource =
    returnRecord?.refundSource ||
    summary?.refundSource ||
    order.refundSource ||
    (fallbackInstrument
      ? `${fallbackInstrument}${order.paymentProvider ? ` · ${order.paymentProvider}` : ''}`
      : isManualCod
        ? 'Manual Bank / UPI Transfer'
        : isCodOrder
          ? 'COD Order (Manual Payout Pending)'
          : order.paymentProvider || order.paymentGateway || 'Original Payment Source')

  const gatewayStatus =
    returnRecord?.refundGatewayStatus ||
    summary?.refundGatewayStatus ||
    order.refundGatewayStatus ||
    (refundRrn || refundArn ? 'CREDITED' : isManualCod ? 'MANUAL_RECORDED' : 'INITIATED')

  const processedAt = returnRecord?.refundProcessedAt || summary?.refundProcessedAt || null
  const creditedAt = returnRecord?.refundCreditedAt || summary?.refundCreditedAt || null
  const emailSentAt = returnRecord?.refundEmailSentAt || summary?.emailSentAt || null
  const rrnEmailSentAt = summary?.rrnEmailSentAt || null
  const checkoutRef = summary?.checkoutReference || order.paymentReference || null

  const badge = stageMeta(gatewayStatus, Boolean(refundRrn || refundArn), isManualCod)
  const logoUrl = !isManualCod
    ? getPaymentLogoUrl(order.paymentProvider, order.paymentGateway, order.paymentMethod)
    : null

  const copyValue = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      toast.toast('success', `${label} copied: ${value}`)
    } catch {
      toast.toast('error', `Could not copy ${label}`)
    }
  }

  const handleSyncDetails = async () => {
    setSyncing(true)
    try {
      const res = await syncOrderRefundDetails(order.id, true)
      await queryClient.invalidateQueries({ queryKey: ['order', String(order.id)] })
      await queryClient.invalidateQueries({ queryKey: ['returns'] })
      if (res.newReferenceFound) {
        const refParts = [
          res.refundSummary?.refundRrn ? `RRN ${res.refundSummary.refundRrn}` : null,
          res.refundSummary?.refundArn ? `ARN ${res.refundSummary.refundArn}` : null,
        ].filter(Boolean)
        toast.toast(
          'success',
          `Refund details updated (${refParts.join(' · ')})${res.emailSent ? ' and emailed to customer.' : '.'}`
        )
      } else if (res.refundSummary?.refundRrn || res.refundSummary?.refundArn) {
        toast.toast('success', 'Refund RRN / ARN details are already up to date.')
      } else {
        toast.toast('success', 'Checked Shopify: refund is initiated, bank RRN / ARN not published by gateway yet.')
      }
    } catch (err) {
      toast.toast('error', apiError(err))
    } finally {
      setSyncing(false)
    }
  }

  const handleSendEmail = async () => {
    if (!order.customerEmail) {
      toast.toast('error', 'No customer email address is recorded on this order.')
      return
    }
    if (emailSentAt) {
      const ok = window.confirm(
        `A refund receipt was already sent to ${order.customerEmail}. Send an updated receipt with the latest RRN / ARN & refund source now?`
      )
      if (!ok) return
    }
    setEmailing(true)
    try {
      const res = await sendOrderRefundEmail(order.id, returnRecord?.id)
      await queryClient.invalidateQueries({ queryKey: ['order', String(order.id)] })
      const refHint = res.refundRrn
        ? ` (RRN: ${res.refundRrn})`
        : res.refundArn
          ? ` (ARN: ${res.refundArn})`
          : ''
      toast.toast('success', `Refund receipt emailed to ${res.recipient}${refHint}.`)
    } catch (err) {
      toast.toast('error', apiError(err))
    } finally {
      setEmailing(false)
    }
  }

  const innerContent = (
    <div className={`refund-highlight-card ${badge.toneClass} ${compact ? 'is-compact' : ''}`}>
      {/* Top Status & Amount Row */}
      <div className="refund-card-header">
        <div className="refund-card-headline">
          <div className="refund-status-icon" aria-hidden="true">
            <Icon name={badge.toneClass === 'is-danger' ? 'alert' : badge.toneClass === 'is-pending' ? 'clock' : 'check'} size={15} />
          </div>
          <div>
            <div className="refund-card-title-row">
              <strong className="refund-card-title">
                {badge.headline}
                {refundAmount != null ? (
                  <>: <span className="refund-amount-figure">{formatMoney(refundAmount, order.currency)}</span></>
                ) : (
                  <>: <span className="refund-amount-figure">Amount pending sync</span></>
                )}
              </strong>
              {isPartial && <span className="refund-inline-pill is-warn">Partial</span>}
              <span className={`refund-stage-pill ${badge.toneClass}`}>{badge.label}</span>
            </div>
            <div className="refund-card-subline">
              {processedAt && <span>Processed {formatDate(processedAt)}</span>}
              {creditedAt && creditedAt !== processedAt && <span> · Credited {formatDate(creditedAt)}</span>}
              {!processedAt && creditedAt && <span>Credited {formatDate(creditedAt)}</span>}
            </div>
          </div>
        </div>

        <div className="refund-actions">
          {!isManualCod && (
            <button
              type="button"
              className="button button-secondary button-small refund-action-btn"
              disabled={syncing}
              onClick={handleSyncDetails}
              title="Fetch latest Refund RRN, ARN & gateway credit status from Shopify"
            >
              <Icon name="refresh" size={13} />
              <span>{syncing ? 'Syncing…' : 'Sync RRN'}</span>
            </button>
          )}
          <button
            type="button"
            className="button button-secondary button-small refund-action-btn is-email"
            disabled={emailing || !order.customerEmail}
            onClick={handleSendEmail}
            title={
              order.customerEmail
                ? `Send official refund receipt (with RRN, ARN & source) to ${order.customerEmail}`
                : 'No customer email on order'
            }
          >
            <Icon name="mail" size={13} />
            <span>{emailing ? 'Sending…' : emailSentAt ? 'Resend Receipt' : 'Email Receipt'}</span>
          </button>
        </div>
      </div>

      {/* Key Refund Details Grid */}
      <div className="refund-fact-grid">
        {/* 1. Refund RRN (Primary Highlight) */}
        <div className={`refund-fact-tile ${refundRrn ? 'is-primary' : 'is-awaiting'}`}>
          <span className="refund-fact-label">
            {isManualCod ? 'Bank UTR / UPI RRN' : 'Return Refund RRN (Bank / UPI)'}
          </span>
          {refundRrn ? (
            <button
              type="button"
              className="refund-copy-chip is-primary"
              onClick={() => copyValue('Refund RRN', refundRrn)}
              title="Click to copy Refund RRN"
            >
              <span className="mono">{refundRrn}</span>
              <Icon name="copy" size={12} />
            </button>
          ) : (
            <div className="refund-fact-pending">
              <Icon name="clock" size={13} />
              <span>
                {refundArn
                  ? 'Not issued by bank (use ARN)'
                  : isManualCod
                    ? 'UTR not recorded'
                    : 'Awaiting bank RRN (~1–2 hrs)'}
              </span>
            </div>
          )}
        </div>

        {/* 2. Refund Source (Destination) */}
        <div className="refund-fact-tile is-source">
          <span className="refund-fact-label">Refund Source (Credited To)</span>
          <div className="refund-source-value">
            {logoUrl && (
              <img
                src={logoUrl}
                alt=""
                className="refund-source-logo"
                onError={(e) => {
                  ;(e.currentTarget as HTMLElement).style.display = 'none'
                }}
              />
            )}
            <strong>{refundSource}</strong>
          </div>
          <span className="refund-fact-hint">
            {isManualCod ? 'Direct bank / UPI manual payout' : 'Original customer payment source'}
          </span>
        </div>

        {/* 3. Gateway Refund ARN / Reference ID */}
        <div className="refund-fact-tile">
          <span className="refund-fact-label">Gateway Refund ARN / Ref ID</span>
          {refundArn ? (
            <button
              type="button"
              className="refund-copy-chip"
              onClick={() => copyValue('Refund ARN', refundArn)}
              title="Click to copy Gateway Refund ARN"
            >
              <span className="mono">{refundArn}</span>
              <Icon name="copy" size={12} />
            </button>
          ) : (
            <span className="refund-fact-muted">{isManualCod ? 'N/A (Manual COD)' : 'Pending gateway ARN'}</span>
          )}
          {settlementBatchUtr && (
            <span className="refund-fact-hint">
              Settlement UTR: <code className="mono">{settlementBatchUtr}</code>
            </span>
          )}
        </div>

        {/* 4. Shopify Refund ID */}
        <div className="refund-fact-tile">
          <span className="refund-fact-label">Shopify Refund ID</span>
          {shopifyRefundId ? (
            <button
              type="button"
              className="refund-copy-chip"
              onClick={() => copyValue('Shopify Refund ID', shopifyRefundId)}
              title="Click to copy Shopify Refund ID"
            >
              <span className="mono">{shopifyRefundId}</span>
              <Icon name="copy" size={12} />
            </button>
          ) : (
            <span className="refund-fact-muted">{isManualCod ? 'Manual payout (offline)' : 'Not linked'}</span>
          )}
          {refundTxnId && (
            <span className="refund-fact-hint">
              Refund Txn: <code className="mono">{refundTxnId}</code>
            </span>
          )}
        </div>
      </div>

      {/* Footer: Customer Email Delivery & Checkout Cross-Reference */}
      <div className="refund-card-footer">
        <div className="refund-email-status">
          <Icon name={emailSentAt ? 'check' : 'mail'} size={13} />
          {emailSentAt ? (
            <span>
              {rrnEmailSentAt ? 'RRN confirmation emailed' : 'Refund receipt emailed'} to{' '}
              <strong>{order.customerEmail || 'customer'}</strong> · {formatDate(rrnEmailSentAt || emailSentAt)}
            </span>
          ) : order.customerEmail ? (
            <span>Customer refund receipt not sent yet ({order.customerEmail})</span>
          ) : (
            <span>No customer email on file for refund receipt</span>
          )}
        </div>
        {checkoutRef && !compact && (
          <div className="refund-checkout-ref">
            <span>Original Pay Ref:</span>
            <code className="mono">{checkoutRef}</code>
          </div>
        )}
      </div>
    </div>
  )

  if (!standalone) {
    return innerContent
  }

  return (
    <div className="order-return-refund-overview refund-standalone-card">
      <div className="refund-standalone-head">
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div className="refund-standalone-icon" aria-hidden="true">
            <Icon name="creditCard" size={18} />
          </div>
          <div>
            <h3 style={{ margin: 0, fontSize: '14px', fontWeight: 700, color: 'var(--ink)' }}>
              Refund &amp; Settlement Details
            </h3>
            <span style={{ fontSize: '12px', color: 'var(--tone-success-fg)' }}>
              {isManualCod
                ? 'Manual COD payout recorded on this order'
                : 'Direct / RTO refund linked to customer payment source'}
            </span>
          </div>
        </div>
      </div>
      <div style={{ padding: '14px 18px' }}>{innerContent}</div>
    </div>
  )
}
