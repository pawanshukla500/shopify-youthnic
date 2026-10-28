import { accountsStatus, classifyOrderTab } from '../../../src/modules/orders/order-tabs'
import { formatMoney, shortDate, isVelocityCourier } from '../lib'
import type { Order } from '../types'
import { Button, Icon, type IconName } from './UI'

type Tone = 'info' | 'warn' | 'danger' | 'success' | 'neutral'

interface Step {
  tone: Tone
  title: string
  text: string
  action?: { label: string; icon: IconName; onClick: () => void; loading?: boolean; disabled?: boolean }
}

export interface OrderNextStepProps {
  order: Order
  isPrepaid: boolean
  isCodConfirmed: boolean
  isDispatchNeeded: boolean
  canDispatch: boolean
  dispatching: boolean
  confirmingCod: boolean
  refundingRto: boolean
  onDispatch: () => void
  onConfirmCod: () => void
  onPrintLabel: () => void
  onResolveNdr: () => void
  onRtoRefund: () => void
  onChooseCarrier?: () => void
  onClearManifestReview?: () => void
  clearingManifestReview?: boolean
}

/**
 * The one thing that matters for this order right now, with the one button
 * that moves it forward. Replaces the stack of dispatch / SLA / NDR / RTO
 * banners: an order is only ever in one of these situations.
 */
function nextStep(p: OrderNextStepProps): Step {
  const { order } = p
  const shipment = order.shipment
  const tab = classifyOrderTab(order)
  if (order.supportFlag === 'MANIFEST_REVIEW' && !shipment?.waybillNumber && order.fulfillmentStatus !== 'fulfilled') {
    return {
      tone: 'warn',
      title: 'Manifest needs review',
      text: 'Delhivery did not confirm the previous manifest. Check Delhivery ONE, or switch to Velocity / clear this flag to dispatch.',
      action: p.onChooseCarrier
        ? { label: 'Ship with Velocity / Choose courier', icon: 'package', onClick: p.onChooseCarrier }
        : p.onClearManifestReview
        ? { label: 'Clear review', icon: 'check', onClick: p.onClearManifestReview, loading: p.clearingManifestReview }
        : undefined,
    }
  }

  if (order.status === 'CANCELLED') {
    return { tone: 'neutral', title: 'Cancelled', text: 'This order was cancelled. Nothing to ship or collect.' }
  }
  if (order.hasNdrException || order.status === 'FAILED_DELIVERY') {
    return {
      tone: 'danger',
      title: 'Delivery failed: action needed',
      text: `Delhivery reported "${shipment?.trackingStatus || 'delivery attempt failed'}"${shipment?.trackingLocation ? ` at ${shipment.trackingLocation}` : ''}. Ask for a re-attempt or send it back.`,
      action: { label: 'Resolve NDR', icon: 'alert', onClick: p.onResolveNdr },
    }
  }
  if (order.status === 'RTO_DELIVERED') {
    if (order.paymentMethod !== 'COD' && order.financialStatus !== 'refunded') {
      return {
        tone: 'warn',
        title: 'Back at the warehouse: refund due',
        text: `The parcel came back (RTO). Refund ${formatMoney(order.totalAmount)} to the customer.`,
        action: { label: 'Refund RTO order', icon: 'dollar', onClick: p.onRtoRefund, loading: p.refundingRto },
      }
    }
    return { tone: 'neutral', title: 'Back at the warehouse (RTO)', text: order.paymentMethod === 'COD' ? 'COD order: no payment was taken, so nothing to refund.' : 'Refunded.' }
  }
  if (order.status === 'RTO_INITIATED') {
    return { tone: 'warn', title: 'Coming back to the warehouse (RTO)', text: 'Delhivery is returning the parcel. Nothing to do until it arrives.' }
  }
  if (order.status.startsWith('RETURN')) {
    return { tone: 'info', title: 'Customer return in progress', text: 'Scan the parcel on the Returns page when it reaches the warehouse.' }
  }
  if (order.status === 'REFUNDED') {
    return { tone: 'neutral', title: 'Refunded', text: 'The customer has been refunded.' }
  }

  if (p.isDispatchNeeded) {
    const overdue = order.isDispatchOverdue ? ` Dispatch is ${order.dispatchOverdueHours || 0}h past the 24h target.` : ''
    return {
      tone: order.isDispatchOverdue ? 'danger' : 'info',
      title: p.isPrepaid ? 'Paid: ready to dispatch' : 'COD confirmed: ready to dispatch',
      text: `${p.isPrepaid ? `Paid online${order.paymentProvider ? ` via ${order.paymentProvider}` : ''}.` : 'The customer confirmed the COD order.'} Book shipment with courier partner.${overdue}`,
      action: { label: `Dispatch with ${isVelocityCourier(order.shipment?.courier, order.shipment?.labelUrl, order.shipment?.waybillNumber) ? 'Velocity' : 'Delhivery'}`, icon: 'package', onClick: p.onDispatch, loading: p.dispatching, disabled: !p.canDispatch || p.dispatching },
    }
  }
  if (tab === 'new' && order.paymentMethod === 'COD' && !p.isCodConfirmed) {
    return {
      tone: 'warn',
      title: 'COD not confirmed yet',
      text: 'Confirm the order with the customer (call or WhatsApp) before it can be dispatched.',
      action: p.canDispatch ? { label: 'Confirm COD', icon: 'check', onClick: p.onConfirmCod, loading: p.confirmingCod } : undefined,
    }
  }
  if (tab === 'ready') {
    return {
      tone: 'info',
      title: 'Label ready: waiting for pickup',
      text: `AWB ${shipment?.waybillNumber}. Print the label, pack the parcel and hand it to the courier partner.`,
      action: { label: 'Print label', icon: 'download', onClick: p.onPrintLabel },
    }
  }
  if (tab === 'transit') {
    return {
      tone: 'info',
      title: `On the way (${isVelocityCourier(order.shipment?.courier, order.shipment?.labelUrl, order.shipment?.waybillNumber) ? 'Velocity' : 'Delhivery'})`,
      text: [shipment?.trackingStatus, shipment?.trackingLocation].filter(Boolean).join(' · ') || 'In transit.',
    }
  }
  if (tab === 'delivered' || tab === 'closed') {
    const accounts = accountsStatus(order)
    const closesOn = accounts.returnWindowClosesAt ? shortDate(accounts.returnWindowClosesAt.toISOString()) : null
    if (accounts.state === 'CLOSED') {
      return {
        tone: 'success',
        title: 'Done: payment received',
        text: `Money in the bank on ${shortDate(order.paymentReceivedAt)}${order.paymentReceivedUtr ? ` (UTR ${order.paymentReceivedUtr})` : ''}. Return window closed on ${closesOn}.`,
      }
    }
    const waiting: string[] = []
    if (!accounts.paymentReceived) {
      waiting.push(
        order.paymentReceivedAt
          ? 'the bank UTR of the payment is added'
          : order.paymentMethod === 'COD'
            ? `the ${isVelocityCourier(order.shipment?.courier, order.shipment?.labelUrl, order.shipment?.waybillNumber) ? 'Velocity' : 'Delhivery'} COD remittance (with UTR) arrives`
            : 'the gateway settlement (with UTR) arrives'
      )
    }
    if (accounts.openReturn) waiting.push('the open return is finished')
    if (!accounts.returnWindowClosed && closesOn) waiting.push(`the return window closes on ${closesOn}`)
    return {
      tone: 'info',
      title: `Delivered${order.deliveredAt ? ` on ${shortDate(order.deliveredAt)}` : ''}`,
      text: waiting.length
        ? `Moves to Payment Received once ${waiting.join(' and ')}.`
        : 'Moves to Payment Received at the next hourly check.',
    }
  }
  return { tone: 'neutral', title: 'Order received', text: 'Waiting to be reviewed.' }
}

const TONE_ICONS: Record<Tone, IconName> = {
  info: 'package',
  warn: 'alert',
  danger: 'alert',
  success: 'check',
  neutral: 'clock',
}

export function OrderNextStep(props: OrderNextStepProps) {
  const step = nextStep(props)
  return (
    <div className={`next-step next-step-${step.tone}`} role="status">
      <div className="next-step-icon" aria-hidden="true">
        <Icon name={TONE_ICONS[step.tone]} size={16} />
      </div>
      <div className="next-step-copy">
        <strong>{step.title}</strong>
        <span>{step.text}</span>
      </div>
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        {props.onChooseCarrier && (props.isDispatchNeeded || props.order.supportFlag === 'MANIFEST_REVIEW') && !props.order.shipment?.waybillNumber && props.order.fulfillmentStatus !== 'fulfilled' && (
          <Button className="button-secondary" disabled={(!props.canDispatch && props.order.supportFlag !== 'MANIFEST_REVIEW') || props.dispatching} onClick={props.onChooseCarrier} title="Compare rates and select courier partner">
            <Icon name="truck" size={14} />
            Choose courier
          </Button>
        )}
        {props.onClearManifestReview && props.order.supportFlag === 'MANIFEST_REVIEW' && !props.order.shipment?.waybillNumber && (
          <Button className="button-secondary" loading={props.clearingManifestReview} onClick={props.onClearManifestReview} title="Clear manifest review flag">
            <Icon name="check" size={14} />
            Clear review
          </Button>
        )}
        {step.action && (
          <Button className="button-primary" loading={step.action.loading} disabled={step.action.disabled} onClick={step.action.onClick}>
            <Icon name={step.action.icon} size={15} />
            {step.action.label}
          </Button>
        )}
      </div>
    </div>
  )
}
