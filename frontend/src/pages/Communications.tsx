import { useState, useMemo, useEffect } from 'react'
import { useDebouncedValue } from '../hooks/useDebouncedValue'
import { useSearchParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getEmailLogs,
  getCommunicationStats,
  sendEmailNotification,
  recordCommunicationConversion,
  getOrders,
  getDelayedInTransitShipments,
  notifyDelayedInTransit,
} from '../api'
import {
  ErrorBox,
  Icon,
  LoadingState,
  PageIntro,
  Panel,
  PanelHeading,
  useDocumentTitle,
  useToast,
} from '../components/UI'
import type { EmailLog, EmailTemplateType, DelayedInTransitShipment } from '../types'

const TEMPLATE_PREVIEWS: Record<
  EmailTemplateType,
  { label: string; icon: string; description: string; color: string; sender: string }
> = {
  TRANSIT_DELAY: {
    label: 'In-Transit Delay Alert',
    icon: 'clock',
    description: 'Notifies customer of route delay, current hub location & revised ETA',
    color: '#d97706',
    sender: 'delivery@youthnic.com',
  },
  RETURN_INITIATED: {
    label: 'Return Pickup Scheduled',
    icon: 'refresh',
    description: 'Official reverse pickup confirmation with Delhivery AWB & guidelines',
    color: '#7c3aed',
    sender: 'return@youthnic.com',
  },
  RETURN_REFUND: {
    label: 'Refund Processed Receipt',
    icon: 'check',
    description: 'Settlement receipt with Refund ID, gateway rail, and credit timeline',
    color: '#059669',
    sender: 'refund@youthnic.com',
  },
  SUPPORT_REPLY: {
    label: 'Customer Support Reply',
    icon: 'message',
    description: 'Official customer care reply with ticket context & tracking quick-link',
    color: '#2563eb',
    sender: 'contact@youthnic.com',
  },
  RETURN_RECEIVED: {
    label: 'Return Item Received',
    icon: 'package',
    description: 'Surat hub arrival notice and quality inspection check-in update',
    color: '#0d9488',
    sender: 'return@youthnic.com',
  },
  DISPATCH_DELAY: {
    label: 'Dispatch SLA Delay',
    icon: 'package',
    description: 'Explains quality check / packaging delay at Surat hub before dispatch',
    color: '#7c3aed',
    sender: 'delivery@youthnic.com',
  },
  IN_TRANSIT: {
    label: 'In-Transit Regular Update',
    icon: 'truck',
    description: 'Active courier tracking update with latest transit hub location',
    color: '#2563eb',
    sender: 'delivery@youthnic.com',
  },
  OUT_FOR_DELIVERY: {
    label: 'Out for Delivery Today',
    icon: 'check',
    description: 'Arriving today alert with prominent COD cash readiness reminder',
    color: '#059669',
    sender: 'delivery@youthnic.com',
  },
  NDR_ALERT: {
    label: 'NDR Reschedule Needed',
    icon: 'alert',
    description: 'Urgent address/time confirmation to avoid RTO after failed attempt',
    color: '#dc2626',
    sender: 'delivery@youthnic.com',
  },
  DELIVERED: {
    label: 'Delivered & Exchange',
    icon: 'gift',
    description: 'Delivery confirmation with 7-day hassle-free WhatsApp size exchange',
    color: '#059669',
    sender: 'orders@youthnic.com',
  },
  ORDER_CONFIRMED: {
    label: 'Order Confirmed',
    icon: 'file',
    description: 'Itemized invoice receipt and estimated dispatch window',
    color: '#475569',
    sender: 'orders@youthnic.com',
  },
  CUSTOM: {
    label: 'Custom Announcement',
    icon: 'message',
    description: 'Custom message body with Youthnic brand banner and button CTA',
    color: '#334155',
    sender: 'contact@youthnic.com',
  },
}

export function Communications() {
  useDocumentTitle('Communications & Consumer Emails')
  const toast = useToast()
  const queryClient = useQueryClient()

  // Filters & State
  const [selectedTab, setSelectedTab] = useState<'all' | 'TRANSIT_DELAY' | 'DISPATCH_DELAY' | 'converted'>('all')
  const [search, setSearch] = useState('')
  const [previewTemplate, setPreviewTemplate] = useState<EmailTemplateType>('TRANSIT_DELAY')
  const [previewViewport, setPreviewViewport] = useState<'desktop' | 'mobile'>('desktop')

  // Modals
  const [isSendModalOpen, setIsSendModalOpen] = useState(false)
  const [viewingLog, setViewingLog] = useState<EmailLog | null>(null)

  // Send Form State
  const [selectedOrderId, setSelectedOrderId] = useState<string>('')
  const [customEmail, setCustomEmail] = useState('')
  const [customName, setCustomName] = useState('')
  const [sendTemplate, setSendTemplate] = useState<EmailTemplateType>('TRANSIT_DELAY')
  const [delayReason, setDelayReason] = useState('High transit volume at regional hub & routing check')
  const [newEstimatedDelivery, setNewEstimatedDelivery] = useState('Within 2-3 Business Days')
  const [customMessage, setCustomMessage] = useState('')

  const [searchParams] = useSearchParams()
  useEffect(() => {
    const orderIdParam = searchParams.get('orderId')
    if (orderIdParam) {
      setSelectedOrderId(orderIdParam)
      setIsSendModalOpen(true)
    }
  }, [searchParams])

  const debouncedCommsSearch = useDebouncedValue(search, 400)
  // Queries
  const logsQuery = useQuery({
    queryKey: ['email-logs', debouncedCommsSearch, selectedTab],
    queryFn: () =>
      getEmailLogs({
        search: debouncedCommsSearch.trim() || undefined,
        templateType:
          selectedTab === 'TRANSIT_DELAY' || selectedTab === 'DISPATCH_DELAY'
            ? selectedTab
            : undefined,
        converted: selectedTab === 'converted' ? true : undefined,
        limit: 50,
      }),
    refetchInterval: 60_000,
  })

  const statsQuery = useQuery({
    queryKey: ['communication-stats'],
    queryFn: getCommunicationStats,
    refetchInterval: 60_000,
  })

  const ordersQuery = useQuery({
    queryKey: ['orders-for-email'],
    queryFn: () => getOrders({ limit: 50 } as any),
    staleTime: 60_000,
  })

  // Delayed In-Transit telemetry query
  const delayedShipmentsQuery = useQuery({
    queryKey: ['delayed-in-transit-shipments'],
    queryFn: () => getDelayedInTransitShipments(),
    refetchInterval: 60_000,
  })

  const notifyDelayedMutation = useMutation({
    mutationFn: (variables: {
      orderId?: number
      orderIds?: number[]
      revisedDelivery?: string
      delayReason?: string
      customMessage?: string
    }) => notifyDelayedInTransit(variables),
    onSuccess: (data: { successfulCount: number }) => {
      toast.toast(
        'success',
        `In-transit delay notice sent to ${data.successfulCount} customer(s) from delivery@youthnic.com!`
      )
      queryClient.invalidateQueries({ queryKey: ['delayed-in-transit-shipments'] })
      queryClient.invalidateQueries({ queryKey: ['email-logs'] })
      queryClient.invalidateQueries({ queryKey: ['communication-stats'] })
    },
    onError: (err) => {
      toast.toast('error', `Notification failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
    },
  })

  // Mutations
  const sendEmailMutation = useMutation({
    mutationFn: sendEmailNotification,
    onSuccess: (data) => {
      toast.toast(
        'success',
        data.mode === 'LIVE'
          ? `Live email sent to ${data.recipient} via Resend!`
          : `Simulated email logged for ${data.recipient} (Sandbox Mode)`
      )
      queryClient.invalidateQueries({ queryKey: ['email-logs'] })
      queryClient.invalidateQueries({ queryKey: ['communication-stats'] })
      setIsSendModalOpen(false)
      resetSendForm()
    },
    onError: (err) => {
      toast.toast('error', `Send failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
    },
  })

  const convertMutation = useMutation({
    mutationFn: ({ id, action }: { id: number; action?: string }) =>
      recordCommunicationConversion(id, action),
    onSuccess: () => {
      toast.toast('success', 'Conversion recorded! Customer engagement logged.')
      queryClient.invalidateQueries({ queryKey: ['email-logs'] })
      queryClient.invalidateQueries({ queryKey: ['communication-stats'] })
    },
    onError: (err) => {
      toast.toast('error', `Failed to record conversion: ${err instanceof Error ? err.message : 'Unknown error'}`)
    },
  })

  const resetSendForm = () => {
    setSelectedOrderId('')
    setCustomEmail('')
    setCustomName('')
    setSendTemplate('TRANSIT_DELAY')
    setDelayReason('High transit volume at regional hub & routing check')
    setNewEstimatedDelivery('Within 2-3 Business Days')
    setCustomMessage('')
  }

  // Active in-transit orders from orders query
  const inTransitCount = useMemo(() => {
    const list = ordersQuery.data ?? []
    return list.filter((o) => o.status === 'IN_TRANSIT').length
  }, [ordersQuery.data])

  // Selected order details for pre-filling
  const selectedOrder = useMemo(() => {
    if (!selectedOrderId) return null
    return (ordersQuery.data ?? []).find((o) => String(o.id) === String(selectedOrderId))
  }, [selectedOrderId, ordersQuery.data])

  const stats = statsQuery.data?.stats

  // Filtered logs
  const logs = logsQuery.data?.logs ?? []
  const sendableUnnotifiedCount = useMemo(
    () =>
      (delayedShipmentsQuery.data?.shipments || []).filter(
        (shipment: DelayedInTransitShipment) => !shipment.alreadyNotified && Boolean(shipment.customerEmail)
      ).length,
    [delayedShipmentsQuery.data?.shipments]
  )

  return (
    <div className="communications-page">
      <PageIntro
        eyebrow="Customer Engagement & Transit Telemetry"
        title="Communications & Consumer Email Center"
        description="Dispatch branded logistics alerts, notify customers of in-transit delays, track customer engagement, and measure RTO prevention conversions powered by Resend."
        action={
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
            <button
              type="button"
              className="button button-primary"
              style={{ background: '#2563eb', borderColor: '#1d4ed8' }}
              onClick={() => {
                resetSendForm()
                setIsSendModalOpen(true)
              }}
            >
              <Icon name="mail" size={16} />
              <span>Send Customer Email</span>
            </button>
          </div>
        }
      />

      {/* ─────────────────────────────────────────────────────────────
          1. TOP ANALYTICS & CONVERSION KPI CARDS
          ───────────────────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: '16px', marginBottom: '24px' }}>
        {/* KPI 1: Total Emails Sent */}
        <Panel style={{ padding: '18px 20px', position: 'relative' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
            <div style={{ width: '36px', height: '36px', borderRadius: '10px', background: '#eff6ff', color: '#2563eb', display: 'grid', placeItems: 'center' }}>
              <Icon name="mail" size={18} />
            </div>
            <span className="status-badge status-info">
              {stats?.deliveryRatePercent ?? 100}% Delivered
            </span>
          </div>
          <div style={{ fontSize: '11px', color: '#64748b', fontWeight: 600, textTransform: 'uppercase' }}>
            Total Consumer Emails
          </div>
          <div style={{ fontSize: '26px', fontWeight: 900, color: 'var(--ink)', margin: '4px 0 2px' }}>
            {stats?.totalSent ?? 0}
          </div>
          <div style={{ fontSize: '11.5px', color: '#64748b' }}>
            Delivered: <strong style={{ color: '#059669' }}>{stats?.deliveredCount ?? 0}</strong>
          </div>
        </Panel>

        {/* KPI 2: In-Transit Delay Notices */}
        <Panel style={{ padding: '18px 20px', position: 'relative' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
            <div style={{ width: '36px', height: '36px', borderRadius: '10px', background: '#fffbeb', color: '#d97706', display: 'grid', placeItems: 'center' }}>
              <Icon name="clock" size={18} />
            </div>
            <span className="status-badge status-warning">
              Route Updates
            </span>
          </div>
          <div style={{ fontSize: '11px', color: '#64748b', fontWeight: 600, textTransform: 'uppercase' }}>
            Transit Delay Notices
          </div>
          <div style={{ fontSize: '26px', fontWeight: 900, color: '#d97706', margin: '4px 0 2px' }}>
            {stats?.transitDelaysCount ?? 0}
          </div>
          <div style={{ fontSize: '11.5px', color: '#64748b' }}>
            Dispatch Delays: <strong>{stats?.dispatchDelaysCount ?? 0}</strong>
          </div>
        </Panel>

        {/* KPI 3: Customer Conversion & RTO Prevented */}
        <Panel style={{ padding: '18px 20px', position: 'relative' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
            <div style={{ width: '36px', height: '36px', borderRadius: '10px', background: '#ecfdf5', color: '#059669', display: 'grid', placeItems: 'center' }}>
              <Icon name="check" size={18} />
            </div>
            <span className="status-badge status-success">
              RTO Prevention
            </span>
          </div>
          <div style={{ fontSize: '11px', color: '#64748b', fontWeight: 600, textTransform: 'uppercase' }}>
            Conversion / Engaged Rate
          </div>
          <div style={{ fontSize: '26px', fontWeight: 900, color: '#059669', margin: '4px 0 2px' }}>
            {stats?.conversionRatePercent ?? 0}%
          </div>
          <div style={{ fontSize: '11.5px', color: '#64748b' }}>
            Total Engaged: <strong style={{ color: '#059669' }}>{stats?.convertedCount ?? 0}</strong>
          </div>
        </Panel>

        {/* KPI 4: Active In-Transit Monitored */}
        <Panel style={{ padding: '18px 20px', position: 'relative' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
            <div style={{ width: '36px', height: '36px', borderRadius: '10px', background: '#f3e8ff', color: '#7c3aed', display: 'grid', placeItems: 'center' }}>
              <Icon name="truck" size={18} />
            </div>
            <span className="status-badge status-purple">
              Delhivery Live
            </span>
          </div>
          <div style={{ fontSize: '11px', color: '#64748b', fontWeight: 600, textTransform: 'uppercase' }}>
            In-Transit Monitored
          </div>
          <div style={{ fontSize: '26px', fontWeight: 900, color: '#7c3aed', margin: '4px 0 2px' }}>
            {inTransitCount}
          </div>
          <div style={{ fontSize: '11.5px', color: '#64748b' }}>
            Live packages moving in network
          </div>
        </Panel>
      </div>

      {/* ─────────────────────────────────────────────────────────────
          2. INTERACTIVE EMAIL TEMPLATE SHOWCASE & LIVE PREVIEWER
          ───────────────────────────────────────────────────────────── */}
      <Panel style={{ marginBottom: '24px' }}>
        <PanelHeading
          eyebrow="21st.dev UI/UX Template Architecture"
          title="Interactive Logistics Email Template Showcase"
          action={
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <div style={{ display: 'flex', background: 'var(--line-subtle)', borderRadius: '6px', padding: '2px' }}>
                <button
                  type="button"
                  style={{
                    border: 'none',
                    padding: '4px 10px',
                    borderRadius: '4px',
                    fontSize: '11px',
                    fontWeight: 700,
                    cursor: 'pointer',
                    background: previewViewport === 'desktop' ? '#ffffff' : 'transparent',
                    color: previewViewport === 'desktop' ? '#0f172a' : '#64748b',
                    boxShadow: previewViewport === 'desktop' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
                  }}
                  onClick={() => setPreviewViewport('desktop')}
                >
                  Desktop View
                </button>
                <button
                  type="button"
                  style={{
                    border: 'none',
                    padding: '4px 10px',
                    borderRadius: '4px',
                    fontSize: '11px',
                    fontWeight: 700,
                    cursor: 'pointer',
                    background: previewViewport === 'mobile' ? '#ffffff' : 'transparent',
                    color: previewViewport === 'mobile' ? '#0f172a' : '#64748b',
                    boxShadow: previewViewport === 'mobile' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
                  }}
                  onClick={() => setPreviewViewport('mobile')}
                >
                  Mobile (375px)
                </button>
              </div>

              <button
                type="button"
                className="btn-table-action"
                style={{ background: '#eff6ff', borderColor: '#bfdbfe', color: '#2563eb' }}
                onClick={() => {
                  setSendTemplate(previewTemplate)
                  setIsSendModalOpen(true)
                }}
              >
                <span>Use This Template</span>
              </button>
            </div>
          }
        />

        {/* Template Selector Bar */}
        <div style={{ display: 'flex', gap: '8px', overflowX: 'auto', paddingBottom: '12px', borderBottom: '1px solid var(--line)', marginBottom: '16px' }}>
          {(Object.keys(TEMPLATE_PREVIEWS) as EmailTemplateType[]).map((t) => {
            const item = TEMPLATE_PREVIEWS[t]
            const active = previewTemplate === t
            return (
              <button
                key={t}
                type="button"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '7px 14px',
                  borderRadius: '8px',
                  fontSize: '12px',
                  fontWeight: 700,
                  whiteSpace: 'nowrap',
                  cursor: 'pointer',
                  border: active ? `1.5px solid ${item.color}` : '1px solid var(--line)',
                  background: active ? '#ffffff' : 'var(--canvas)',
                  color: active ? item.color : 'var(--ink)',
                  boxShadow: active ? '0 2px 6px rgba(0,0,0,0.06)' : 'none',
                }}
                onClick={() => setPreviewTemplate(t)}
              >
                <span>{item.label}</span>
              </button>
            )
          })}
        </div>

        {/* Live Preview Container */}
        <div style={{ background: '#f8fafc', border: '1px solid var(--line)', borderRadius: '12px', padding: '24px', display: 'flex', justifyContent: 'center' }}>
          <div
            style={{
              width: previewViewport === 'desktop' ? '100%' : '375px',
              maxWidth: previewViewport === 'desktop' ? '650px' : '375px',
              height: '560px',
              background: '#ffffff',
              borderRadius: previewViewport === 'mobile' ? '32px' : '12px',
              border: previewViewport === 'mobile' ? '10px solid #1e293b' : '1px solid #e2e8f0',
              boxShadow: '0 10px 30px rgba(0,0,0,0.08)',
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
              transition: 'all 0.3s ease',
            }}
          >
            {/* Browser / Device Chrome Header */}
            <div style={{ background: '#0f172a', padding: '10px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', color: '#94a3b8', fontSize: '11px' }}>
              <div style={{ display: 'flex', gap: '5px' }}>
                <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#ef4444' }} />
                <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#f59e0b' }} />
                <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#10b981' }} />
              </div>
              <span style={{ fontWeight: 600 }}>Youthnic Logistics Client Preview</span>
              <span style={{ fontSize: '10px', color: '#64748b' }}>Resend 2026-09</span>
            </div>

            {/* Iframe View */}
            <iframe
              title="Email Template Preview"
              style={{ width: '100%', height: '100%', border: 'none', background: '#f8fafc' }}
              srcDoc={getSampleHtmlForPreview(previewTemplate)}
            />
          </div>
        </div>
      </Panel>

      {/* ─────────────────────────────────────────────────────────────
          2.5. IN-TRANSIT DELAYED SHIPMENTS QUEUE & PROACTIVE NOTIFICATIONS
          ───────────────────────────────────────────────────────────── */}
      <Panel style={{ marginBottom: '24px', border: '1px solid #fde68a', background: '#fffdf5' }}>
        <div style={{ padding: '18px 20px', borderBottom: '1px solid #fef3c7', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div style={{ width: '28px', height: '28px', borderRadius: '8px', background: '#fef3c7', color: '#b45309', display: 'grid', placeItems: 'center' }}>
                <Icon name="truck" size={16} />
              </div>
              <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 800, color: '#92400e' }}>
                In-Transit Overdue & Route Delay Watchlist
              </h3>
              <span style={{ background: '#fef3c7', color: '#b45309', border: '1px solid #fde68a', padding: '2px 8px', borderRadius: '12px', fontSize: '11px', fontWeight: 750 }}>
                {delayedShipmentsQuery.data?.totalDelayed ?? 0} Shipments Flagged
              </span>
            </div>
            <p style={{ margin: '4px 0 0', fontSize: '11.5px', color: '#b45309' }}>
              Packages exceeding expected delivery date or experiencing prolonged regional routing. Dispatches official delay notice from <strong>delivery@youthnic.com</strong>.
            </p>
          </div>

          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            {delayedShipmentsQuery.data && sendableUnnotifiedCount > 0 && (
              <button
                type="button"
                className="button button-primary"
                style={{ background: '#d97706', borderColor: '#b45309', fontSize: '12px', height: '32px' }}
                disabled={notifyDelayedMutation.isPending}
                onClick={() => {
                  const unnotifiedIds = (delayedShipmentsQuery.data?.shipments || [])
                    .filter((s: DelayedInTransitShipment) => !s.alreadyNotified && Boolean(s.customerEmail))
                    .map((s: DelayedInTransitShipment) => s.orderId)
                  if (unnotifiedIds.length > 0) {
                    notifyDelayedMutation.mutate({ orderIds: unnotifiedIds })
                  }
                }}
              >
                {notifyDelayedMutation.isPending ? 'Sending Notices…' : `Notify All Unnotified (${sendableUnnotifiedCount})`}
              </button>
            )}
          </div>
        </div>

        {delayedShipmentsQuery.isLoading ? (
          <div style={{ padding: '24px' }}>
            <LoadingState label="Scanning Delhivery active transit telemetry…" />
          </div>
        ) : !delayedShipmentsQuery.data?.shipments || delayedShipmentsQuery.data.shipments.length === 0 ? (
          <div style={{ padding: '24px', textAlign: 'center', color: '#047857', background: '#ecfdf5', borderRadius: '0 0 12px 12px' }}>
            <span style={{ fontSize: '18px', display: 'block', marginBottom: '4px' }}>✅</span>
            <strong style={{ fontSize: '13px' }}>All Dispatched Shipments Are On Schedule</strong>
            <p style={{ margin: '3px 0 0', fontSize: '11.5px', color: '#065f46' }}>
              Zero shipments have exceeded expected delivery dates. Live Delhivery telemetry is operating within nominal transit SLA.
            </p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Customer Recipient</th>
                  <th>AWB & Courier</th>
                  <th>Current Hub</th>
                  <th>Latest Delhivery Remark</th>
                  <th>Transit Duration</th>
                  <th>Notice Status</th>
                  <th style={{ textAlign: 'right' }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {delayedShipmentsQuery.data.shipments.map((shipment: DelayedInTransitShipment) => (
                  <tr key={shipment.orderId}>
                    <td>
                      <strong style={{ fontSize: '12.5px', color: 'var(--ink)' }}>
                        {shipment.shopifyOrderName}
                      </strong>
                      <div style={{ fontSize: '11px', color: '#64748b' }}>
                        ₹{shipment.totalAmount.toLocaleString('en-IN')}
                      </div>
                    </td>
                    <td>
                      <strong style={{ fontSize: '12px', color: 'var(--ink)', display: 'block' }}>
                        {shipment.customerName}
                      </strong>
                      <span style={{ fontSize: '11px', color: '#2563eb' }}>
                        {shipment.customerEmail || 'No email on record'}
                      </span>
                    </td>
                    <td>
                      {shipment.waybillNumber ? (
                        <a
                          href={`https://www.delhivery.com/track/package/${shipment.waybillNumber}`}
                          target="_blank"
                          rel="noreferrer"
                          style={{ color: '#2563eb', fontWeight: 700, fontSize: '12px', textDecoration: 'none' }}
                        >
                          <code>{shipment.waybillNumber}</code> ↗
                        </a>
                      ) : (
                        <span style={{ color: '#94a3b8' }}>Pending AWB</span>
                      )}
                      <div style={{ fontSize: '10.5px', color: '#64748b' }}>
                        {shipment.courier}
                      </div>
                    </td>
                    <td>
                      <span style={{ fontSize: '12px', fontWeight: 600, color: '#0f172a' }}>
                        {shipment.currentLocation}
                      </span>
                    </td>
                    <td style={{ maxWidth: '250px' }}>
                      <strong style={{ fontSize: '11.5px', color: '#92400e', display: 'block' }}>
                        {shipment.flaggedReason}
                      </strong>
                      <span style={{ fontSize: '11px', color: '#475569', display: 'block', marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={shipment.latestRemark || undefined}>
                        {shipment.latestRemark || 'No courier remark received yet'}
                      </span>
                      {shipment.latestScanAt && (
                        <span style={{ fontSize: '10px', color: '#94a3b8' }}>
                          {new Date(shipment.latestScanAt).toLocaleString('en-IN')}
                        </span>
                      )}
                    </td>
                    <td>
                      <span style={{ fontSize: '12px', fontWeight: 700, color: shipment.daysInTransit >= 5 ? '#dc2626' : '#d97706' }}>
                        {shipment.daysInTransit} Days in Transit
                      </span>
                      {shipment.daysOverdue > 0 && (
                        <div style={{ fontSize: '10.5px', color: '#dc2626', fontWeight: 700 }}>
                          +{shipment.daysOverdue}d Past Expected ETA
                        </div>
                      )}
                    </td>
                    <td>
                      {shipment.alreadyNotified ? (
                        <span style={{ background: '#ecfdf5', color: '#065f46', border: '1px solid #a7f3d0', padding: '3px 8px', borderRadius: '4px', fontSize: '10.5px', fontWeight: 700 }}>
                          ✓ Notified (delivery@youthnic.com)
                        </span>
                      ) : (
                        <span style={{ background: '#fef2f2', color: '#dc2626', border: '1px solid #fecaca', padding: '3px 8px', borderRadius: '4px', fontSize: '10.5px', fontWeight: 700 }}>
                          ● Unnotified
                        </span>
                      )}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button
                        type="button"
                        className="button button-secondary"
                        style={{ fontSize: '11px', height: '28px', padding: '0 10px', color: '#b45309', borderColor: '#fde68a' }}
                        disabled={notifyDelayedMutation.isPending || !shipment.customerEmail}
                        onClick={() => notifyDelayedMutation.mutate({ orderId: shipment.orderId })}
                      >
                        {notifyDelayedMutation.isPending ? 'Sending…' : 'Notify Customer ✉'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {/* ─────────────────────────────────────────────────────────────
          3. COMMUNICATIONS HISTORY & LOGS TABLE
          ───────────────────────────────────────────────────────────── */}
      <Panel style={{ padding: '0', overflow: 'hidden' }}>
        <div style={{ padding: '18px 20px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px' }}>
          <div>
            <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 800, color: 'var(--ink)' }}>
              Customer Communication Logs & Conversion Audit
            </h3>
            <p style={{ margin: '3px 0 0', fontSize: '11px', color: '#64748b' }}>
              Every sent email is persistently tracked with delivery status, tracking link clicks, and customer engagement.
            </p>
          </div>

          <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
            {/* Filter Tabs */}
            <div className="segmented-tabs-container">
              <button
                type="button"
                className={`tab-trigger-21st ${selectedTab === 'all' ? 'active' : ''}`}
                onClick={() => setSelectedTab('all')}
              >
                All Logs
              </button>
              <button
                type="button"
                className={`tab-trigger-21st ${selectedTab === 'TRANSIT_DELAY' ? 'active' : ''}`}
                style={{ color: selectedTab === 'TRANSIT_DELAY' ? '#d97706' : undefined }}
                onClick={() => setSelectedTab('TRANSIT_DELAY')}
              >
                Transit Delays
              </button>
              <button
                type="button"
                className={`tab-trigger-21st ${selectedTab === 'converted' ? 'active' : ''}`}
                style={{ color: selectedTab === 'converted' ? '#059669' : undefined }}
                onClick={() => setSelectedTab('converted')}
              >
                Converted / Engaged
              </button>
            </div>

            {/* Search */}
            <div className="search-field" style={{ maxWidth: '280px' }}>
              <Icon name="search" size={14} />
              <input
                placeholder="Search recipient, order, AWB…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>
        </div>

        {logsQuery.isLoading ? (
          <LoadingState label="Loading customer communication records…" />
        ) : logsQuery.isError ? (
          <div style={{ padding: '20px' }}>
            <ErrorBox message={logsQuery.error instanceof Error ? logsQuery.error.message : 'Failed to query email logs'} />
          </div>
        ) : logs.length === 0 ? (
          <div style={{ padding: '40px', textAlign: 'center', color: '#64748b' }}>
            <Icon name="mail" size={32} />
            <p style={{ marginTop: '8px', fontSize: '13px' }}>
              No communications found. Click "Send Customer Email" to dispatch your first logistics notice.
            </p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Sent Date</th>
                  <th>Order Reference</th>
                  <th>Customer Recipient</th>
                  <th>Notification Template</th>
                  <th>Delivery Status</th>
                  <th>Conversion & Engagement</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <tr key={log.id}>
                    <td>
                      <span style={{ fontSize: '11.5px', color: '#475569', fontWeight: 600 }}>
                        {new Date(log.createdAt).toLocaleDateString('en-IN', {
                          day: '2-digit',
                          month: 'short',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    </td>
                    <td>
                      <div>
                        <strong style={{ fontSize: '12px', color: 'var(--ink)' }}>
                          {log.shopifyOrderName || (log.orderId ? `#${log.orderId}` : '—')}
                        </strong>
                        {log.waybillNumber && (
                          <div style={{ fontSize: '10px', color: '#64748b', marginTop: '1px' }}>
                            AWB: <code>{log.waybillNumber}</code>
                          </div>
                        )}
                      </div>
                    </td>
                    <td>
                      <div>
                        <strong style={{ fontSize: '12px', color: 'var(--ink)', display: 'block' }}>
                          {log.recipientName || 'Customer'}
                        </strong>
                        <span style={{ fontSize: '11px', color: '#2563eb' }}>{log.recipientEmail}</span>
                      </div>
                    </td>
                    <td>
                      <span
                        className="status-badge"
                        style={{
                          background:
                            log.templateType === 'TRANSIT_DELAY'
                              ? '#fffbeb'
                              : log.templateType === 'DISPATCH_DELAY'
                              ? '#f5f3ff'
                              : log.templateType === 'NDR_ALERT'
                              ? '#fef2f2'
                              : '#ecfdf5',
                          color:
                            log.templateType === 'TRANSIT_DELAY'
                              ? '#d97706'
                              : log.templateType === 'DISPATCH_DELAY'
                              ? '#7c3aed'
                              : log.templateType === 'NDR_ALERT'
                              ? '#dc2626'
                              : '#059669',
                          borderColor: 'transparent',
                          fontSize: '11px',
                          fontWeight: 750,
                        }}
                      >
                        {TEMPLATE_PREVIEWS[log.templateType]?.label || log.templateType}
                      </span>
                      {log.delayReason && (
                        <div style={{ fontSize: '10px', color: '#64748b', marginTop: '2px', maxWidth: '240px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {log.delayReason}
                        </div>
                      )}
                    </td>
                    <td>
                      <span
                        className={`status-badge ${
                          log.status === 'SENT' || log.status === 'DELIVERED'
                            ? 'status-success'
                            : log.status === 'SIMULATED'
                            ? 'status-purple'
                            : 'status-danger'
                        }`}
                      >
                        <span className="status-dot" /> {log.status}
                      </span>
                    </td>
                    <td>
                      {log.converted ? (
                        <div style={{ display: 'grid', gap: '2px' }}>
                          <span className="status-badge status-success">
                            <span className="status-dot" /> CONVERTED
                          </span>
                          <span style={{ fontSize: '10px', color: '#059669', fontWeight: 600 }}>
                            {log.conversionAction || 'Clicked Tracking'} ({log.clickCount} clicks)
                          </span>
                        </div>
                      ) : (
                        <span className="status-badge" style={{ background: '#f1f5f9', color: '#64748b' }}>
                          Pending Engagement
                        </span>
                      )}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <div style={{ display: 'inline-flex', gap: '6px' }}>
                        {log.htmlPreview && (
                          <button
                            type="button"
                            className="btn-table-action"
                            style={{ background: '#eff6ff', color: '#2563eb' }}
                            onClick={() => setViewingLog(log)}
                            title="View exact rendered HTML email"
                          >
                            View Email
                          </button>
                        )}
                        {!log.converted && (
                          <button
                            type="button"
                            className="btn-table-action"
                            style={{ background: '#ecfdf5', color: '#059669' }}
                            onClick={() =>
                              convertMutation.mutate({
                                id: log.id,
                                action: 'MANUAL_CONVERSION_CONFIRMED',
                              })
                            }
                            title="Mark customer as verified / confirmed delivery"
                          >
                            Mark Converted
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {/* ─────────────────────────────────────────────────────────────
          4. SEND CUSTOMER EMAIL MODAL
          ───────────────────────────────────────────────────────────── */}
      {isSendModalOpen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1000,
            background: 'rgba(15, 23, 42, 0.65)',
            backdropFilter: 'blur(4px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '20px',
          }}
          onClick={() => setIsSendModalOpen(false)}
        >
          <div
            style={{
              background: 'var(--panel)',
              border: '1px solid var(--line)',
              borderRadius: '16px',
              padding: '28px',
              width: '100%',
              maxWidth: '560px',
              boxShadow: '0 20px 40px rgba(0, 0, 0, 0.25)',
              position: 'relative',
              maxHeight: '90vh',
              overflowY: 'auto',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '20px' }}>
              <div>
                <h3 style={{ margin: 0, fontSize: '18px', fontWeight: 800, color: 'var(--ink)' }}>
                  Dispatch Logistics Customer Email
                </h3>
                <p style={{ margin: '4px 0 0', fontSize: '11.5px', color: '#64748b' }}>
                  Send branded delivery alerts, in-transit delay notices, or custom updates to consumers via Resend.
                </p>
              </div>
              <button
                type="button"
                style={{ background: 'transparent', border: 0, color: '#64748b', cursor: 'pointer', padding: '4px' }}
                onClick={() => setIsSendModalOpen(false)}
              >
                <Icon name="close" size={18} />
              </button>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault()
                const targetEmail = selectedOrder ? selectedOrder.customerEmail : customEmail
                if (!targetEmail) {
                  toast.toast('error', 'Recipient email address is required.')
                  return
                }

                sendEmailMutation.mutate({
                  orderId: selectedOrderId ? Number(selectedOrderId) : undefined,
                  recipientEmail: targetEmail,
                  recipientName: selectedOrder ? selectedOrder.customerName : customName,
                  templateType: sendTemplate,
                  delayReason:
                    sendTemplate === 'TRANSIT_DELAY' || sendTemplate === 'NDR_ALERT'
                      ? delayReason
                      : undefined,
                  newEstimatedDelivery:
                    sendTemplate === 'TRANSIT_DELAY' || sendTemplate === 'DISPATCH_DELAY'
                      ? newEstimatedDelivery
                      : undefined,
                  currentLocation:
                    selectedOrder?.shipment?.trackingLocation ||
                    (sendTemplate === 'TRANSIT_DELAY' ? 'In Transit Regional Hub' : undefined),
                  customMessage: sendTemplate === 'CUSTOM' ? customMessage : undefined,
                })
              }}
              style={{ display: 'grid', gap: '14px' }}
            >
              {/* Order Selector */}
              <div className="form-field">
                <label className="field-label">Select Order from Database (Auto-Fills Details)</label>
                <select
                  value={selectedOrderId}
                  onChange={(e) => {
                    const id = e.target.value
                    setSelectedOrderId(id)
                    const found = (ordersQuery.data ?? []).find((o) => String(o.id) === id)
                    if (found?.customerEmail) {
                      setCustomEmail(found.customerEmail)
                    }
                    if (found?.customerName) {
                      setCustomName(found.customerName)
                    }
                  }}
                >
                  <option value="">-- Or enter custom recipient below --</option>
                  {(ordersQuery.data ?? []).slice(0, 50).map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.shopifyOrderName} · {o.customerName} ({o.status}) {o.customerEmail ? `[${o.customerEmail}]` : '[No Email]'}
                    </option>
                  ))}
                </select>
              </div>

              {/* Recipient Email & Name */}
              <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 0.8fr', gap: '10px' }}>
                <div className="form-field">
                  <label className="field-label">Customer Email Address</label>
                  <input
                    type="email"
                    required
                    placeholder="e.g. customer@example.com"
                    value={selectedOrder?.customerEmail || customEmail}
                    onChange={(e) => setCustomEmail(e.target.value)}
                  />
                </div>
                <div className="form-field">
                  <label className="field-label">Customer Name</label>
                  <input
                    placeholder="e.g. Shilpa Bhosle"
                    value={selectedOrder?.customerName || customName}
                    onChange={(e) => setCustomName(e.target.value)}
                  />
                </div>
              </div>

              {/* Template Type */}
              <div className="form-field">
                <label className="field-label">Logistics Notification Template</label>
                <select
                  value={sendTemplate}
                  onChange={(e) => setSendTemplate(e.target.value as EmailTemplateType)}
                >
                  {(Object.keys(TEMPLATE_PREVIEWS) as EmailTemplateType[]).map((t) => (
                    <option key={t} value={t}>
                      {TEMPLATE_PREVIEWS[t].label} — {TEMPLATE_PREVIEWS[t].description}
                    </option>
                  ))}
                </select>
              </div>

              {/* In-Transit Delay Fields */}
              {sendTemplate === 'TRANSIT_DELAY' && (
                <>
                  <div className="form-field">
                    <label className="field-label">Reason for Transit Delay</label>
                    <select
                      value={delayReason}
                      onChange={(e) => setDelayReason(e.target.value)}
                    >
                      <option value="High transit volume at regional hub & routing check">
                        High transit volume at regional hub & routing check
                      </option>
                      <option value="Logistics network rescheduling due to weather conditions">
                        Logistics network rescheduling due to weather conditions
                      </option>
                      <option value="Courier line-haul transport inspection in progress">
                        Courier line-haul transport inspection in progress
                      </option>
                      <option value="Operational sorting backlog at gateway terminal">
                        Operational sorting backlog at gateway terminal
                      </option>
                    </select>
                  </div>

                  <div className="form-field">
                    <label className="field-label">Revised Expected Delivery Schedule</label>
                    <input
                      placeholder="e.g. Friday, 28-Sep-2026 or Within 2-3 Business Days"
                      value={newEstimatedDelivery}
                      onChange={(e) => setNewEstimatedDelivery(e.target.value)}
                    />
                  </div>
                </>
              )}

              {/* Dispatch SLA Delay Fields */}
              {sendTemplate === 'DISPATCH_DELAY' && (
                <div className="form-field">
                  <label className="field-label">Estimated Dispatch Window</label>
                  <input
                    placeholder="e.g. Within 24-36 Hours from Surat Hub"
                    value={newEstimatedDelivery}
                    onChange={(e) => setNewEstimatedDelivery(e.target.value)}
                  />
                </div>
              )}

              {/* Custom Message Body */}
              {sendTemplate === 'CUSTOM' && (
                <div className="form-field">
                  <label className="field-label">Custom Message Content</label>
                  <textarea
                    rows={4}
                    placeholder="Type your message to the customer..."
                    value={customMessage}
                    onChange={(e) => setCustomMessage(e.target.value)}
                  />
                </div>
              )}

              <div style={{ background: 'var(--canvas)', border: '1px solid var(--line)', borderRadius: '8px', padding: '12px', fontSize: '11px', color: '#475569' }}>
                <div style={{ fontWeight: 700, color: 'var(--ink)', marginBottom: '3px' }}>🔗 Live Click & Conversion Tracking:</div>
                <div>A unique tracking link will be embedded in this email. When the customer opens and clicks the tracking button, it will automatically record a conversion and redirect them to Delhivery live tracking.</div>
              </div>

              <div style={{ display: 'flex', gap: '10px', marginTop: '10px', justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => setIsSendModalOpen(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="button button-primary"
                  style={{ background: '#2563eb', borderColor: '#1d4ed8' }}
                  disabled={sendEmailMutation.isPending}
                >
                  {sendEmailMutation.isPending ? 'Dispatching Email…' : 'Send Consumer Email'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ─────────────────────────────────────────────────────────────
          5. VIEW RENDERED EMAIL MODAL
          ───────────────────────────────────────────────────────────── */}
      {viewingLog && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1000,
            background: 'rgba(15, 23, 42, 0.75)',
            backdropFilter: 'blur(5px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '20px',
          }}
          onClick={() => setViewingLog(null)}
        >
          <div
            style={{
              background: 'var(--panel)',
              border: '1px solid var(--line)',
              borderRadius: '16px',
              padding: '24px',
              width: '100%',
              maxWidth: '720px',
              height: '85vh',
              display: 'flex',
              flexDirection: 'column',
              boxShadow: '0 25px 50px rgba(0, 0, 0, 0.3)',
              position: 'relative',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px', borderBottom: '1px solid var(--line)', paddingBottom: '12px' }}>
              <div>
                <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 800, color: 'var(--ink)' }}>
                  Rendered Email: {viewingLog.subject}
                </h3>
                <div style={{ fontSize: '11px', color: '#64748b', marginTop: '2px' }}>
                  To: <strong>{viewingLog.recipientEmail}</strong> · Status: <span className="status-badge status-success">{viewingLog.status}</span> · Resend ID: <code>{viewingLog.resendId || 'simulated'}</code>
                </div>
              </div>
              <button
                type="button"
                style={{ background: 'transparent', border: 0, color: '#64748b', cursor: 'pointer', padding: '4px' }}
                onClick={() => setViewingLog(null)}
              >
                <Icon name="close" size={18} />
              </button>
            </div>

            <div style={{ flex: 1, borderRadius: '8px', overflow: 'hidden', border: '1px solid var(--line)' }}>
              <iframe
                title="Rendered Email Content"
                style={{ width: '100%', height: '100%', border: 'none' }}
                srcDoc={viewingLog.htmlPreview || '<p>No preview available</p>'}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Generates sample HTML preview for template showcase
 */
function getSampleHtmlForPreview(type: EmailTemplateType): string {
  const sampleItems = [
    {
      title: 'Beige Linen Floral Short Kurti With Farshi Pant Set',
      variantTitle: 'Size: M',
      quantity: 1,
      price: 1899,
    },
  ]

  const data = {
    orderName: '#26YOU5752',
    customerName: 'Shilpa Bhosle',
    recipientEmail: 'shilpab1979.sb@gmail.com',
    waybillNumber: 'PROP0000031386',
    courier: 'Delhivery Express',
    currentLocation: 'Bhiwandi Sorting Center Hub',
    delayReason: 'High transit volume at regional hub & routing inspection',
    newEstimatedDelivery: 'Saturday, 28-Sep-2026',
    refundId: 'RF-26YOU5752',
    refundAmount: 1899,
    items: sampleItems,
    totalAmount: 1899,
    paymentMethod: 'Prepaid (UPI via PhonePe)',
    customerAddress: 'Flat 402, Royal Residency, Mumbai, Maharashtra - 400053',
    customMessage: 'Our Surat team has reviewed your sizing inquiry and arranged reverse pickup.',
    actionUrl: 'https://youthnic2024.myshopify.com',
  }

  // Pre-render preview matching official 21st.dev template layout
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { margin: 0; padding: 20px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f8fafc; color: #1e293b; }
    .card { max-width: 580px; margin: 0 auto; background: #ffffff; border-radius: 14px; border: 1px solid #e2e8f0; overflow: hidden; box-shadow: 0 4px 16px rgba(0,0,0,0.04); }
    .header { background: #ffffff; padding: 20px 24px; border-bottom: 1px solid #f1f5f9; display: flex; justify-content: space-between; align-items: center; }
    .brand { font-size: 20px; font-weight: 900; letter-spacing: 2px; color: #0f172a; }
    .content { padding: 24px; }
    .alert-amber { background: #fffbeb; border: 1px solid #fde68a; border-radius: 10px; padding: 14px 16px; margin-bottom: 20px; color: #92400e; }
    .alert-purple { background: #f5f3ff; border: 1px solid #ddd6fe; border-radius: 10px; padding: 14px 16px; margin-bottom: 20px; color: #5b21b6; }
    .alert-green { background: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 10px; padding: 14px 16px; margin-bottom: 20px; color: #065f46; }
    .alert-blue { background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 10px; padding: 14px 16px; margin-bottom: 20px; color: #1e40af; }
    .status-card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 16px; margin-bottom: 20px; font-size: 13px; }
    .btn { display: inline-block; background: #2563eb; color: #ffffff; font-weight: 700; font-size: 13.5px; text-decoration: none; padding: 12px 24px; border-radius: 8px; }
    .btn-green { background: #059669; }
    .btn-purple { background: #7c3aed; }
    .footer { background: #f1f5f9; padding: 20px 24px; font-size: 11.5px; color: #64748b; border-top: 1px solid #e2e8f0; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <div>
        <div class="brand">YOUTHNIC</div>
        <div style="font-size: 10px; color: #64748b; margin-top: 2px;">Ethnic Elegance · Surat Fulfillment Center</div>
      </div>
      <span style="font-size: 10.5px; font-weight: 700; padding: 4px 10px; border-radius: 20px; background: #f1f5f9; color: #475569; text-transform: uppercase;">
        ${TEMPLATE_PREVIEWS[type]?.sender || 'contact@youthnic.com'}
      </span>
    </div>
    <div class="content">
      ${
        type === 'RETURN_INITIATED'
          ? `
        <div class="alert-purple">
          <strong>🔄 Return Request Approved & Reverse Pickup Scheduled</strong><br>
          <span style="font-size: 12px;">Delhivery Reverse pickup booked for your address within 24-48 business hours.</span>
        </div>
        <p>Dear ${data.customerName},</p>
        <p style="font-size: 13.5px; color: #475569;">We have scheduled a reverse pickup for order ${data.orderName}. Please keep the garment folded with brand tags intact.</p>
        <div class="status-card">
          <div><strong>Return Waybill:</strong> ${data.waybillNumber}</div>
          <div style="margin-top: 4px;"><strong>Courier:</strong> Delhivery Surface Reverse</div>
          <div style="margin-top: 4px;"><strong>Refund Note:</strong> Disbursed immediately once inspected via refund@youthnic.com.</div>
        </div>
        <div style="text-align: center;"><a href="#" class="btn btn-purple">Track Return Progress →</a></div>
      `
          : type === 'RETURN_REFUND'
          ? `
        <div class="alert-green">
          <strong>💸 Full Refund Processed & Verified</strong><br>
          <span style="font-size: 12px;">Returned package verified at Surat hub with 0 issues. Funds credited to account.</span>
        </div>
        <p>Dear ${data.customerName},</p>
        <p style="font-size: 13.5px; color: #475569;">Your return has cleared quality inspection. We have processed a 100% refund of ₹${data.refundAmount}.</p>
        <div class="status-card">
          <div><strong>Refund ID:</strong> <code>${data.refundId}</code></div>
          <div style="margin-top: 4px;"><strong>Refund Amount:</strong> ₹${data.refundAmount}</div>
          <div style="margin-top: 4px;"><strong>Payment Rail:</strong> ${data.paymentMethod}</div>
          <div style="margin-top: 4px;"><strong>Credit SLA:</strong> UPI: Instant · Cards: 2-4 days</div>
        </div>
      `
          : type === 'SUPPORT_REPLY'
          ? `
        <div class="alert-blue">
          <strong>💬 Official Response from Youthnic Support Desk</strong><br>
          <span style="font-size: 12px;">From: contact@youthnic.com · Regarding order ${data.orderName}</span>
        </div>
        <p>Dear ${data.customerName},</p>
        <div style="background: #ffffff; border: 1.5px solid #cbd5e1; border-radius: 8px; padding: 16px; margin: 16px 0; font-size: 13.5px; line-height: 1.6;">
          ${data.customMessage}
        </div>
        <p style="font-size: 12px; color: #64748b;">Simply reply directly to this email at contact@youthnic.com or reach WhatsApp +91 88661 54721.</p>
      `
          : `
        <div class="alert-amber">
          <strong>⚠️ Logistics Routing Notice: In-Transit Delivery Delay</strong><br>
          <span style="font-size: 12px;">Package in safe transit with Delhivery Express but delayed due to hub rescheduling.</span>
        </div>
        <p>Dear ${data.customerName},</p>
        <p style="font-size: 13.5px; color: #475569;">Your order ${data.orderName} is actively monitored. Our Surat dispatch team has escalated routing with Delhivery.</p>
        <div class="status-card">
          <div><strong>AWB:</strong> ${data.waybillNumber}</div>
          <div style="margin-top: 4px;"><strong>Current Hub:</strong> ${data.currentLocation}</div>
          <div style="margin-top: 4px;"><strong>Revised Expected Delivery:</strong> ${data.newEstimatedDelivery}</div>
        </div>
        <div style="text-align: center;"><a href="#" class="btn">Track Live Delivery →</a></div>
      `
      }
    </div>
    <div class="footer">
      Youthnic Surat Fulfillment Center: 7004, Hi-tech Textile Centre, Anjana Farm, Surat, Gujarat 395002<br>
      Returns: return@youthnic.com · Refunds: refund@youthnic.com · Inquiries: contact@youthnic.com
    </div>
  </div>
</body>
</html>`
}
