import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  api,
  apiError,
  bulkDispatchOrders,
  confirmCodOrder,
  dispatchOrder,
  getDashboardStats,
  getGatewayBatchDetail,
  getOrders,
} from '../api'
import { formatDate, formatMoney, carrierTrackingUrl, isVelocityCourier } from '../lib'
import { useAuth } from '../context/AuthContext'
import {
  Button,
  CopyableBadge,
  EmptyState,
  ErrorBox,
  Icon,
  LoadingState,
  StatusBadge,
  useDocumentTitle,
  useToast,
} from '../components/UI'
import type { DashboardStats, Order } from '../types'
import './Dashboard.css'

type PeriodFilter = 'all' | 'today' | 'yesterday' | '7days' | 'month'
type QueueModalKind = 'dispatch' | 'prepaid' | 'ndr' | 'new' | null

const PERIOD_OPTIONS: Array<{ key: PeriodFilter; label: string; summaryText: string }> = [
  { key: 'all', label: 'All Time', summaryText: 'all time' },
  { key: 'today', label: 'Today', summaryText: 'today' },
  { key: 'yesterday', label: 'Yesterday', summaryText: 'yesterday' },
  { key: '7days', label: '7 Days', summaryText: 'in the last 7 days' },
  { key: 'month', label: 'Month', summaryText: 'this month' },
]

export function Dashboard() {
  useDocumentTitle('Dashboard')
  const { user } = useAuth()
  const toast = useToast()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const [period, setPeriod] = useState<PeriodFilter>('all')
  const [queueModal, setQueueModal] = useState<QueueModalKind>(null)
  const [settlementModalBatchId, setSettlementModalBatchId] = useState<string | null>(null)
  const [rateModalOpen, setRateModalOpen] = useState(false)

  // Modal in-flight tracking
  const [dispatchingOrderId, setDispatchingOrderId] = useState<number | null>(null)
  const [confirmingCodId, setConfirmingCodId] = useState<number | null>(null)
  const [isBulkDispatching, setIsBulkDispatching] = useState(false)

  // Rate calculator state inside pop-up
  const [calcPincode, setCalcPincode] = useState('400001')
  const [calcWeight, setCalcWeight] = useState(500)
  const [calcMode, setCalcMode] = useState<'Pre-paid' | 'COD'>('Pre-paid')
  const [calcResult, setCalcResult] = useState<any | null>(null)
  const [calcLoading, setCalcLoading] = useState(false)

  const { data: stats, isLoading, isError, error, refetch, isFetching } = useQuery<DashboardStats>({
    queryKey: ['dashboard-stats', period],
    queryFn: () => getDashboardStats({ period }),
    refetchInterval: 60_000,
  })

  // Queue modal query (only runs while queueModal is open)
  const queueQuery = useQuery<Order[]>({
    queryKey: ['dashboard-queue-modal', queueModal],
    enabled: queueModal !== null,
    queryFn: async () => {
      if (queueModal === 'dispatch') return getOrders({ tab: 'dispatch', limit: 50 })
      if (queueModal === 'prepaid') return getOrders({ filter: 'PREPAID_DISPATCH', limit: 50 })
      if (queueModal === 'ndr') return getOrders({ filter: 'NDR', limit: 50 })
      if (queueModal === 'new') return getOrders({ tab: 'new', limit: 50 })
      return []
    },
  })

  // Settlement batch detail query (only runs while settlement modal is open)
  const batchDetailQuery = useQuery<any>({
    queryKey: ['dashboard-settlement-batch', settlementModalBatchId],
    enabled: Boolean(settlementModalBatchId),
    queryFn: () => getGatewayBatchDetail(settlementModalBatchId!),
  })

  // Escape key closes whichever pop-up modal is open
  useEffect(() => {
    if (!queueModal && !settlementModalBatchId && !rateModalOpen) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (!isBulkDispatching) setQueueModal(null)
      setSettlementModalBatchId(null)
      setRateModalOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [queueModal, settlementModalBatchId, rateModalOpen, isBulkDispatching])

  const refreshAllOperationalQueries = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] }),
      queryClient.invalidateQueries({ queryKey: ['dashboard-queue-modal'] }),
      queryClient.invalidateQueries({ queryKey: ['orders'] }),
      queryClient.invalidateQueries({ queryKey: ['pending-count'] }),
      queryClient.invalidateQueries({ queryKey: ['payment-summary'] }),
    ])
  }

  const syncMutation = useMutation({
    mutationFn: async (type: 'orders' | 'tracking' | 'webhooks') => {
      if (type === 'orders') return (await api.post('/api/orders/sync')).data
      if (type === 'tracking') return (await api.post('/api/tracking/sync')).data
      return (await api.post('/api/setup/webhooks')).data
    },
    onSuccess: async (data, type) => {
      const message =
        data?.message ??
        (type === 'orders'
          ? `Orders synced: ${data?.syncedCount ?? 0} updated, ${data?.dispatchedCount ?? 0} auto-dispatched.`
          : type === 'tracking'
          ? `Tracking synced: ${data?.updatedCount ?? 0} shipments updated.`
          : 'Shopify webhooks registered.')
      toast.toast('success', message)
      await refreshAllOperationalQueries()
    },
    onError: (err) => toast.toast('error', apiError(err)),
  })

  const handleDispatchOne = async (orderId: number) => {
    if (dispatchingOrderId !== null || isBulkDispatching) return
    setDispatchingOrderId(orderId)
    try {
      const res = await dispatchOrder(orderId)
      toast.toast('success', `Dispatched via ${res.courier} · AWB ${res.waybillNumber}`)
      await refreshAllOperationalQueries()
    } catch (err) {
      toast.toast('error', apiError(err))
    } finally {
      setDispatchingOrderId(null)
    }
  }

  const handleConfirmCod = async (orderId: number) => {
    if (confirmingCodId !== null) return
    setConfirmingCodId(orderId)
    try {
      const res = await confirmCodOrder(orderId)
      toast.toast('success', res.message || 'COD order moved to Dispatch queue.')
      await refreshAllOperationalQueries()
    } catch (err) {
      toast.toast('error', apiError(err))
    } finally {
      setConfirmingCodId(null)
    }
  }

  const handleBulkDispatchModal = async () => {
    const orders = queueQuery.data ?? []
    if (!orders.length || isBulkDispatching) return
    setIsBulkDispatching(true)
    try {
      const ids = orders.slice(0, 50).map((o) => o.id)
      const res = await bulkDispatchOrders(ids)
      toast.toast(
        res.failed > 0 ? 'error' : 'success',
        `Dispatched ${res.dispatched} of ${res.total} orders${res.failed > 0 ? ` (${res.failed} failed)` : ''}.`
      )
      await refreshAllOperationalQueries()
    } catch (err) {
      toast.toast('error', apiError(err))
    } finally {
      setIsBulkDispatching(false)
    }
  }

  const handleEstimate = async () => {
    const cleanPin = calcPincode.trim()
    if (!/^\d{6}$/.test(cleanPin)) {
      toast.toast('error', 'Enter a valid 6-digit destination pincode.')
      return
    }
    setCalcLoading(true)
    try {
      const res = await api.get('/api/delhivery/shipping-cost', {
        params: {
          mode: 'S',
          chargeableWeightGrams: calcWeight,
          originPincode: stats?.delhiveryStatus?.originPincode || '395002',
          destinationPincode: cleanPin,
          shipmentStatus: 'Delivered',
          paymentType: calcMode,
        },
      })
      setCalcResult(res.data)
    } catch (err) {
      toast.toast('error', apiError(err))
    } finally {
      setCalcLoading(false)
    }
  }

  const today = new Date()
  const hour = today.getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'
  const operatorName = user?.name ? user.name.split(' ')[0] : 'Operator'
  const dateLabel = today.toLocaleDateString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })

  if (isLoading && !stats) {
    return <LoadingState label="Loading operations overview…" />
  }

  if (isError && !stats) {
    return (
      <div style={{ padding: '24px 0' }}>
        <ErrorBox message={apiError(error)} />
        <div style={{ marginTop: 12 }}>
          <Button className="button-primary" onClick={() => refetch()} disabled={isFetching}>
            {isFetching ? 'Retrying…' : 'Retry'}
          </Button>
        </div>
      </div>
    )
  }

  const kpis = stats?.kpis
  const recon = stats?.reconciliation
  const funnel = stats?.funnel
  const topStates = stats?.topStates ?? []
  const recentOrders = stats?.recentOrders ?? []
  const latestSettlement = stats?.latestSettlement
  const periodMeta = PERIOD_OPTIONS.find((p) => p.key === period) ?? PERIOD_OPTIONS[0]

  const readyToDispatch = kpis?.readyToDispatch ?? 0
  const prepaidPendingCount = kpis?.prepaidPendingDispatchCount ?? 0
  const delayedCount = kpis?.delayedDispatchCount ?? 0
  const ndrExceptions = kpis?.ndrExceptions ?? 0

  // Proportional revenue bar
  const totalRev = kpis?.totalRevenue || 1
  const gokwikPct = Math.round(((recon?.gokwikPrepaid.totalAmount || 0) / totalRev) * 100)
  const codPct = Math.round(((recon?.delhiveryCod.totalAmount || 0) / totalRev) * 100)
  const phonepePct = Math.round(((recon?.phonepePrepaid.totalAmount || 0) / totalRev) * 100)
  const manualPct = Math.max(0, 100 - gokwikPct - codPct - phonepePct)

  const stage2Total = (funnel?.warehouse.dispatchPending ?? 0) + (funnel?.warehouse.dispatched ?? 0)
  const stage3Total =
    (funnel?.logistics.shipped ?? 0) +
    (funnel?.logistics.inTransit ?? 0) +
    (funnel?.logistics.outForDelivery ?? 0)
  const stage5Total =
    (funnel?.finalMile.failedDelivery ?? 0) +
    (funnel?.finalMile.rtoInitiated ?? 0) +
    (funnel?.returns.requested ?? 0)

  const queueModalMeta: Record<
    Exclude<QueueModalKind, null>,
    { title: string; desc: string; tone: 'amber' | 'blue' | 'red' | 'green'; fullPath: string }
  > = {
    dispatch: {
      title: 'Ready to Dispatch Queue',
      desc: 'Approved orders ready for Delhivery or Velocity AWB generation.',
      tone: 'amber',
      fullPath: '/orders?tab=dispatch',
    },
    prepaid: {
      title: 'Priority Prepaid Dispatch',
      desc: 'Paid orders via GoKwik, UPI, or PhonePe waiting for carrier manifest.',
      tone: 'blue',
      fullPath: '/orders?filter=PREPAID_DISPATCH',
    },
    ndr: {
      title: 'NDR & Delivery Exceptions',
      desc: 'Shipments with failed delivery attempts or active RTO initiation.',
      tone: 'red',
      fullPath: '/orders?filter=NDR',
    },
    new: {
      title: 'New Intake & Unconfirmed COD',
      desc: 'Recently synced Shopify orders pending COD approval or payment verification.',
      tone: 'green',
      fullPath: '/orders?tab=new',
    },
  }

  return (
    <div className="dash-wrap">
      {/* ─── 1. Simple Native Header + Controls ─────────────────── */}
      <header className="dash-header">
        <div className="dash-header-left">
          <div className="dash-meta-line">
            <span className="dash-live-dot" aria-hidden="true" />
            <span>{dateLabel}</span>
            <span>·</span>
            <span>{kpis?.totalOrders ?? 0} orders ({periodMeta.summaryText})</span>
          </div>
          <h1 className="dash-title">{greeting}, {operatorName}.</h1>
          <p className="dash-subtitle">
            <button type="button" className="dash-subtitle-link" onClick={() => setQueueModal('dispatch')}>
              {readyToDispatch} ready to manifest
            </button>
            {' · '}
            <button type="button" className="dash-subtitle-link" onClick={() => setQueueModal('ndr')}>
              {ndrExceptions} NDR exceptions
            </button>
            {latestSettlement && (
              <>
                {' · Latest Easebuzz payout '}
                <button
                  type="button"
                  className="dash-subtitle-link"
                  onClick={() => setSettlementModalBatchId(latestSettlement.batchId)}
                >
                  {formatMoney(latestSettlement.netAmount, 'INR')} ({latestSettlement.bankUtr || latestSettlement.batchId})
                </button>
              </>
            )}
          </p>
        </div>

        <div className="dash-controls">
          <div className="dash-period-tabs" role="tablist" aria-label="Dashboard period filter">
            {PERIOD_OPTIONS.map((opt) => (
              <button
                key={opt.key}
                type="button"
                role="tab"
                aria-selected={period === opt.key}
                className={`dash-period-btn ${period === opt.key ? 'active' : ''}`}
                onClick={() => setPeriod(opt.key)}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <div className="dash-toolbar">
            <Button
              className="button-secondary button-small"
              onClick={() => {
                setCalcResult(null)
                setRateModalOpen(true)
              }}
            >
              <Icon name="tool" size={14} />
              Rate Calc
            </Button>
            <Button
              className="button-secondary button-small"
              loading={syncMutation.isPending && syncMutation.variables === 'orders'}
              onClick={() => syncMutation.mutate('orders')}
            >
              <Icon name="refresh" size={14} />
              Sync Orders
            </Button>
            <Button
              className="button-secondary button-small"
              loading={syncMutation.isPending && syncMutation.variables === 'tracking'}
              onClick={() => syncMutation.mutate('tracking')}
            >
              <Icon name="route" size={14} />
              Sync Tracking
            </Button>
            <Button
              className="button-secondary button-small"
              loading={isFetching}
              onClick={() => refetch()}
            >
              <Icon name="zap" size={14} />
              Refresh
            </Button>
            <Button
              className="button-secondary button-small"
              loading={syncMutation.isPending && syncMutation.variables === 'webhooks'}
              onClick={() => syncMutation.mutate('webhooks')}
            >
              Webhooks
            </Button>
          </div>
        </div>
      </header>

      {/* ─── 2. Operational Triage Strip (Opens Pop-up Drawers) ───── */}
      <section className="dash-triage-grid" aria-label="Immediate operational queues">
        <button type="button" className="dash-triage-card" onClick={() => setQueueModal('dispatch')}>
          <div className="dash-triage-main">
            <span className="dash-triage-kicker">
              <span className="dash-triage-dot amber" />
              Dispatch Queue
            </span>
            <div className="dash-triage-value-row">
              <span className="dash-triage-num">{readyToDispatch}</span>
              <span className="dash-triage-title">Manifest Pending</span>
            </div>
            <span className="dash-triage-desc">
              {delayedCount > 0 ? `${delayedCount} past 24h SLA` : 'Approved orders awaiting AWB'}
            </span>
          </div>
          <span className="dash-triage-cta">Review</span>
        </button>

        <button type="button" className="dash-triage-card" onClick={() => setQueueModal('prepaid')}>
          <div className="dash-triage-main">
            <span className="dash-triage-kicker">
              <span className="dash-triage-dot blue" />
              Priority SLA
            </span>
            <div className="dash-triage-value-row">
              <span className="dash-triage-num">{prepaidPendingCount}</span>
              <span className="dash-triage-title">Prepaid Unshipped</span>
            </div>
            <span className="dash-triage-desc">
              {prepaidPendingCount > 0
                ? 'Advance-paid orders awaiting manifest'
                : 'All prepaid dispatch requests cleared'}
            </span>
          </div>
          <span className="dash-triage-cta">Inspect</span>
        </button>

        <button type="button" className="dash-triage-card" onClick={() => setQueueModal('ndr')}>
          <div className="dash-triage-main">
            <span className="dash-triage-kicker">
              <span className="dash-triage-dot red" />
              Delivery Guard
            </span>
            <div className="dash-triage-value-row">
              <span className="dash-triage-num">{ndrExceptions}</span>
              <span className="dash-triage-title">NDR & RTO Alerts</span>
            </div>
            <span className="dash-triage-desc">
              Failed attempts & active reverse returns
            </span>
          </div>
          <span className="dash-triage-cta">Review</span>
        </button>
      </section>

      {/* ─── 3. Unified 6-Metric Overview Bar ───────────────────── */}
      <section className="dash-metrics-bar" aria-label="Key business metrics">
        <button type="button" className="dash-metric-cell" onClick={() => navigate('/orders')}>
          <div className="dash-metric-head">
            <span>Gross Revenue</span>
            <Icon name="dollar" size={14} />
          </div>
          <span className="dash-metric-value">{formatMoney(kpis?.totalRevenue ?? 0, 'INR')}</span>
          <span className="dash-metric-sub">
            AOV <strong>{formatMoney(kpis?.averageOrderValue ?? 0, 'INR')}</strong>
          </span>
        </button>

        <button type="button" className="dash-metric-cell" onClick={() => navigate('/orders')}>
          <div className="dash-metric-head">
            <span>Orders</span>
            <Icon name="box" size={14} />
          </div>
          <span className="dash-metric-value">{kpis?.totalOrders ?? 0}</span>
          <span className="dash-metric-sub">
            <strong>{Math.round(kpis?.prepaidRatio ?? 0)}%</strong> Prepaid · <strong>{Math.round(kpis?.codRatio ?? 0)}%</strong> COD
          </span>
        </button>

        <button type="button" className="dash-metric-cell" onClick={() => setQueueModal('dispatch')}>
          <div className="dash-metric-head">
            <span>Ready to Ship</span>
            <Icon name="truck" size={14} />
          </div>
          <span className="dash-metric-value">{readyToDispatch}</span>
          <span className="dash-metric-sub">
            <strong>{funnel?.warehouse.dispatched ?? 0}</strong> labelled
          </span>
        </button>

        <button type="button" className="dash-metric-cell" onClick={() => setRateModalOpen(true)}>
          <div className="dash-metric-head">
            <span>Est. Freight</span>
            <Icon name="creditCard" size={14} />
          </div>
          <span className="dash-metric-value">{formatMoney(kpis?.totalEstimatedLogisticsCost ?? 0, 'INR')}</span>
          <span className="dash-metric-sub">Open rate calculator</span>
        </button>

        <button type="button" className="dash-metric-cell" onClick={() => navigate('/orders?tab=delivered')}>
          <div className="dash-metric-head">
            <span>Delivered</span>
            <Icon name="check" size={14} />
          </div>
          <span className="dash-metric-value">{kpis?.deliveredCount ?? 0}</span>
          <span className="dash-metric-sub">Confirmed deliveries</span>
        </button>

        <button type="button" className="dash-metric-cell" onClick={() => navigate('/returns')}>
          <div className="dash-metric-head">
            <span>Returns & RTO</span>
            <Icon name="return" size={14} />
          </div>
          <span className="dash-metric-value">{kpis?.totalReturnsCount ?? 0}</span>
          <span className="dash-metric-sub">
            <strong>{kpis?.returnRate ? `${kpis.returnRate.toFixed(1)}%` : '0.0%'}</strong> rate
          </span>
        </button>
      </section>

      {/* ─── 4. Flat 5-Stage Fulfillment Rail ───────────────────── */}
      <section className="dash-card" aria-label="Fulfillment pipeline">
        <div className="dash-card-head">
          <div>
            <h2 className="dash-card-title">Fulfillment Pipeline</h2>
            <p className="dash-card-subtitle">Click any stage to open queue or inspect orders</p>
          </div>
          <Link to="/orders" className="dash-link-btn">
            View all orders ↗
          </Link>
        </div>

        <div className="dash-pipeline-rail">
          <button
            type="button"
            className={`dash-stage-btn ${(funnel?.intake.total ?? 0) > 0 ? 'has-active' : ''}`}
            onClick={() => setQueueModal('new')}
          >
            <div className="dash-stage-top">
              <span className="dash-stage-name">1. Intake</span>
              <span className="dash-stage-count">{funnel?.intake.total ?? 0}</span>
            </div>
            <div className="dash-stage-lines">
              <span className="dash-stage-line">
                <span>New orders</span>
                <strong>{funnel?.intake.total ?? 0}</strong>
              </span>
              <span className="dash-stage-line">
                <span>Unverified</span>
                <strong>{funnel?.intake.unverified ?? 0}</strong>
              </span>
            </div>
          </button>

          <button
            type="button"
            className={`dash-stage-btn ${stage2Total > 0 ? 'is-warning' : ''}`}
            onClick={() => setQueueModal('dispatch')}
          >
            <div className="dash-stage-top">
              <span className="dash-stage-name">2. Manifest</span>
              <span className="dash-stage-count">{stage2Total}</span>
            </div>
            <div className="dash-stage-lines">
              <span className="dash-stage-line">
                <span>Pending manifest</span>
                <strong>{funnel?.warehouse.dispatchPending ?? 0}</strong>
              </span>
              <span className="dash-stage-line">
                <span>Label printed</span>
                <strong>{funnel?.warehouse.dispatched ?? 0}</strong>
              </span>
            </div>
          </button>

          <button
            type="button"
            className={`dash-stage-btn ${stage3Total > 0 ? 'has-active' : ''}`}
            onClick={() => navigate('/orders?tab=transit')}
          >
            <div className="dash-stage-top">
              <span className="dash-stage-name">3. In Transit</span>
              <span className="dash-stage-count">{stage3Total}</span>
            </div>
            <div className="dash-stage-lines">
              <span className="dash-stage-line">
                <span>Hub transit</span>
                <strong>{(funnel?.logistics.shipped ?? 0) + (funnel?.logistics.inTransit ?? 0)}</strong>
              </span>
              <span className="dash-stage-line">
                <span>Out for delivery</span>
                <strong>{funnel?.logistics.outForDelivery ?? 0}</strong>
              </span>
            </div>
          </button>

          <button
            type="button"
            className={`dash-stage-btn ${(funnel?.finalMile.delivered ?? 0) > 0 ? 'has-active' : ''}`}
            onClick={() => navigate('/orders?tab=delivered')}
          >
            <div className="dash-stage-top">
              <span className="dash-stage-name">4. Delivered</span>
              <span className="dash-stage-count">{funnel?.finalMile.delivered ?? 0}</span>
            </div>
            <div className="dash-stage-lines">
              <span className="dash-stage-line">
                <span>Completed</span>
                <strong>{funnel?.finalMile.delivered ?? 0}</strong>
              </span>
              <span className="dash-stage-line">
                <span>Delivery rate</span>
                <strong>
                  {kpis?.totalOrders
                    ? `${Math.round(((funnel?.finalMile.delivered ?? 0) / kpis.totalOrders) * 100)}%`
                    : '0%'}
                </strong>
              </span>
            </div>
          </button>

          <button
            type="button"
            className={`dash-stage-btn ${stage5Total > 0 ? 'is-warning' : ''}`}
            onClick={() => setQueueModal('ndr')}
          >
            <div className="dash-stage-top">
              <span className="dash-stage-name">5. NDR & Returns</span>
              <span className="dash-stage-count">{stage5Total}</span>
            </div>
            <div className="dash-stage-lines">
              <span className="dash-stage-line">
                <span>NDR / Failed</span>
                <strong>{funnel?.finalMile.failedDelivery ?? 0}</strong>
              </span>
              <span className="dash-stage-line">
                <span>RTO · Returns Req</span>
                <strong>{(funnel?.finalMile.rtoInitiated ?? 0)} · {(funnel?.returns.requested ?? 0)}</strong>
              </span>
            </div>
          </button>
        </div>
      </section>

      {/* ─── 5. Two-Column Split: Carriers & Money Reconciliation ─ */}
      <div className="dash-two-col">
        {/* Left: Carriers */}
        <section className="dash-card" aria-label="Carrier status">
          <div className="dash-card-head">
            <div>
              <h2 className="dash-card-title">Courier Partners</h2>
              <p className="dash-card-subtitle">Live shipment distribution</p>
            </div>
            <Link to="/settings" className="dash-link-btn">
              Routing Rules ↗
            </Link>
          </div>

          {stats?.carriers && (
            <div className="dash-carrier-list">
              <div className="dash-carrier-row">
                <div className="dash-carrier-head">
                  <div className="dash-carrier-brand">
                    <div className="dash-carrier-logo">
                      <img
                        src="/logos/delhivery.png"
                        alt="Delhivery"
                        style={{ maxWidth: '100%', maxHeight: '100%' }}
                        onError={(e) => {
                          e.currentTarget.style.display = 'none'
                        }}
                      />
                    </div>
                    <div>
                      <div className="dash-carrier-title">Delhivery Express B2C</div>
                      <div className="dash-carrier-role">Surface & Air</div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    {(stats.carriers.activePriority || stats.carriers.priority) === 'DELHIVERY_FIRST' && (
                      <span className="dash-badge blue">Primary</span>
                    )}
                    <span className="dash-badge green">{stats.carriers.delhivery.status || 'Active'}</span>
                  </div>
                </div>
                <div className="dash-carrier-stats">
                  <div className="dash-carrier-stat">
                    <span>Dispatched</span>
                    <strong>{stats.carriers.delhivery.totalShipments ?? stats.carriers.delhivery.total}</strong>
                  </div>
                  <div className="dash-carrier-stat">
                    <span>In-Transit</span>
                    <strong className="tone-blue">{stats.carriers.delhivery.inTransit}</strong>
                  </div>
                  <div className="dash-carrier-stat">
                    <span>Delivered</span>
                    <strong className="tone-green">{stats.carriers.delhivery.delivered}</strong>
                  </div>
                  <div className="dash-carrier-stat">
                    <span>NDR</span>
                    <strong className={stats.carriers.delhivery.ndr > 0 ? 'tone-red' : ''}>
                      {stats.carriers.delhivery.ndr}
                    </strong>
                  </div>
                </div>
              </div>

              <div className="dash-carrier-row">
                <div className="dash-carrier-head">
                  <div className="dash-carrier-brand">
                    <div className="dash-carrier-logo">
                      <img
                        src="/logos/velocity.png"
                        alt="Velocity"
                        style={{ maxWidth: '100%', maxHeight: '100%' }}
                        onError={(e) => {
                          e.currentTarget.style.display = 'none'
                        }}
                      />
                    </div>
                    <div>
                      <div className="dash-carrier-title">Velocity Shipping Network</div>
                      <div className="dash-carrier-role">Aggregator Failover</div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    {(stats.carriers.activePriority || stats.carriers.priority) === 'VELOCITY_FIRST' && (
                      <span className="dash-badge blue">Primary</span>
                    )}
                    <span className={`dash-badge ${stats.carriers.velocity.configured ? 'green' : 'amber'}`}>
                      {stats.carriers.velocity.configured ? 'Connected' : 'Standby'}
                    </span>
                  </div>
                </div>
                <div className="dash-carrier-stats">
                  <div className="dash-carrier-stat">
                    <span>Dispatched</span>
                    <strong>{stats.carriers.velocity.totalShipments ?? stats.carriers.velocity.total}</strong>
                  </div>
                  <div className="dash-carrier-stat">
                    <span>In-Transit</span>
                    <strong className="tone-blue">{stats.carriers.velocity.inTransit}</strong>
                  </div>
                  <div className="dash-carrier-stat">
                    <span>Delivered</span>
                    <strong className="tone-green">{stats.carriers.velocity.delivered}</strong>
                  </div>
                  <div className="dash-carrier-stat">
                    <span>NDR</span>
                    <strong className={stats.carriers.velocity.ndr > 0 ? 'tone-red' : ''}>
                      {stats.carriers.velocity.ndr}
                    </strong>
                  </div>
                </div>
              </div>

              <div className="dash-routing-note">
                Priority: <strong>{(stats.carriers.activePriority || stats.carriers.priority) === 'VELOCITY_FIRST' ? 'Velocity First' : 'Delhivery First'}</strong>
                {' · Auto-Failover: '}
                <strong>{stats.carriers.autoFailover ? 'Enabled' : 'Disabled'}</strong>
              </div>
            </div>
          )}
        </section>

        {/* Right: Cash Flow & Easebuzz Settlements */}
        <section className="dash-card" aria-label="Payment and settlement summary">
          <div className="dash-card-head">
            <div>
              <h2 className="dash-card-title">Payments & Settlements</h2>
              <p className="dash-card-subtitle">Gateway breakdown and bank remittance</p>
            </div>
            <Link to="/remittance" className="dash-link-btn">
              Remittances ↗
            </Link>
          </div>

          <div className="dash-split-bar" title={`GoKwik ${gokwikPct}% · Delhivery COD ${codPct}% · PhonePe ${phonepePct}% · Other ${manualPct}%`}>
            <div className="dash-split-seg" style={{ width: `${gokwikPct}%`, background: 'var(--blue)' }} />
            <div className="dash-split-seg" style={{ width: `${codPct}%`, background: 'var(--amber)' }} />
            <div className="dash-split-seg" style={{ width: `${phonepePct}%`, background: 'var(--green)' }} />
            <div className="dash-split-seg" style={{ width: `${manualPct}%`, background: 'var(--muted-light)' }} />
          </div>

          <div className="dash-recon-rows">
            <div className="dash-recon-row">
              <div className="dash-recon-row-left">
                <span className="dash-recon-name">
                  Delhivery COD
                  <span className="dash-badge amber">{recon?.delhiveryCod.orderCount ?? 0} orders</span>
                </span>
                <span className="dash-recon-meta">
                  Remitted {formatMoney(recon?.delhiveryCod.remittedAmount ?? 0, 'INR')} · Pending{' '}
                  {formatMoney(recon?.delhiveryCod.pendingRemittance ?? 0, 'INR')}
                </span>
              </div>
              <div className="dash-recon-right">
                <div className="dash-recon-amt">{formatMoney(recon?.delhiveryCod.totalAmount ?? 0, 'INR')}</div>
                <Link to="/orders?gateway=cod" className="dash-link-btn" style={{ padding: '2px 0', fontSize: '12px' }}>
                  Orders ↗
                </Link>
              </div>
            </div>

            <div className="dash-recon-row">
              <div className="dash-recon-row-left">
                <span className="dash-recon-name">
                  GoKwik Prepaid
                  <span className="dash-badge blue">{recon?.gokwikPrepaid.orderCount ?? 0} orders</span>
                </span>
                <span className="dash-recon-meta">
                  {recon?.gokwikPrepaid.verifiedCount ?? 0} verified · Est. net {formatMoney(recon?.gokwikPrepaid.estimatedPayout ?? 0, 'INR')}
                </span>
              </div>
              <div className="dash-recon-right">
                <div className="dash-recon-amt">{formatMoney(recon?.gokwikPrepaid.totalAmount ?? 0, 'INR')}</div>
                <Link to="/orders?gateway=gokwik" className="dash-link-btn" style={{ padding: '2px 0', fontSize: '12px' }}>
                  Orders ↗
                </Link>
              </div>
            </div>

            <div className="dash-recon-row">
              <div className="dash-recon-row-left">
                <span className="dash-recon-name">
                  PhonePe & Direct
                  <span className="dash-badge green">
                    {(recon?.phonepePrepaid.orderCount ?? 0) + (recon?.manualPrepaid.orderCount ?? 0)} orders
                  </span>
                </span>
                <span className="dash-recon-meta">
                  PhonePe PG ({recon?.phonepePrepaid.orderCount ?? 0}) & Manual ({recon?.manualPrepaid.orderCount ?? 0})
                </span>
              </div>
              <div className="dash-recon-right">
                <div className="dash-recon-amt">
                  {formatMoney((recon?.phonepePrepaid.totalAmount ?? 0) + (recon?.manualPrepaid.totalAmount ?? 0), 'INR')}
                </div>
                <Link to="/orders?gateway=phonepe" className="dash-link-btn" style={{ padding: '2px 0', fontSize: '12px' }}>
                  Orders ↗
                </Link>
              </div>
            </div>
          </div>

          {latestSettlement ? (
            <div className="dash-settlement-strip">
              <div className="dash-settlement-info">
                <div className="dash-settlement-title">
                  <span>Latest {latestSettlement.gateway} Payout</span>
                  <span className="dash-badge green">{formatMoney(latestSettlement.netAmount, 'INR')}</span>
                </div>
                <div className="dash-settlement-meta">
                  Batch <span className="dash-mono-code">{latestSettlement.batchId}</span>
                  {' · UTR '}
                  <span className="dash-mono-code">{latestSettlement.bankUtr || 'Pending'}</span>
                  {' · '}
                  {latestSettlement.orderCount} orders, {latestSettlement.refundCount} refund
                </div>
              </div>
              <Button
                className="button-secondary button-small"
                onClick={() => setSettlementModalBatchId(latestSettlement.batchId)}
              >
                Inspect Batch
              </Button>
            </div>
          ) : (
            <div className="dash-routing-note" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>No gateway settlement batch synced yet.</span>
              <Link to="/remittance" className="dash-link-btn">Open Remittances ↗</Link>
            </div>
          )}
        </section>
      </div>

      {/* ─── 6. Top Destinations Strip ──────────────────────────── */}
      <section className="dash-card" aria-label="Top shipping destinations">
        <div className="dash-card-head">
          <div>
            <h2 className="dash-card-title">Top Shipping Destinations</h2>
            <p className="dash-card-subtitle">
              Origin hub: {stats?.delhiveryStatus?.originCity || 'Surat'}, {stats?.delhiveryStatus?.originState || 'Gujarat'} ({stats?.delhiveryStatus?.originPincode || '395002'})
            </p>
          </div>
        </div>

        {topStates.length > 0 ? (
          <div className="dash-states-grid">
            {topStates.map((item) => (
              <div className="dash-state-row" key={item.state}>
                <div className="dash-state-top">
                  <span className="dash-state-name">
                    <Icon name="pin" size={12} />
                    {item.state}
                  </span>
                  <span className="dash-state-val">
                    {item.orders} · <strong>{formatMoney(item.revenue, 'INR')}</strong>
                  </span>
                </div>
                <div className="dash-state-track">
                  <div className="dash-state-fill" style={{ width: `${Math.min(100, Math.round(item.percentage * 2.5))}%` }} />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState title="No destination data for this period" description="Try switching to 7 Days or All Time." />
        )}
      </section>

      {/* ─── 7. Recent Orders Table ─────────────────────────────── */}
      <section className="dash-card" aria-label="Recent orders">
        <div className="dash-card-head">
          <div>
            <h2 className="dash-card-title">Recent Orders</h2>
            <p className="dash-card-subtitle">Latest {recentOrders.length} orders matching selected window</p>
          </div>
          <Link to="/orders" className="dash-link-btn">
            View all orders ↗
          </Link>
        </div>

        {recentOrders.length > 0 ? (
          <div className="dash-table-wrap">
            <table className="dash-table">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Customer</th>
                  <th>Destination</th>
                  <th>Channel</th>
                  <th>Amount</th>
                  <th>Est. Freight</th>
                  <th>Status</th>
                  <th>AWB</th>
                  <th style={{ textAlign: 'right' }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {recentOrders.map((order) => (
                  <tr key={order.id} onClick={() => navigate(`/orders/${order.id}`)}>
                    <td>
                      <Link
                        to={`/orders/${order.id}`}
                        className="dash-order-num"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {order.shopifyOrderName}
                      </Link>
                      <span className="dash-cell-sub">{formatDate((order as any).shopifyCreatedAt || order.createdAt)}</span>
                    </td>
                    <td>
                      <strong>{order.customerName}</strong>
                      <span className="dash-cell-sub">{order.customerPhone}</span>
                    </td>
                    <td>
                      <span>{order.customerState || 'Other'}</span>
                      <span className="dash-cell-sub">{order.customerCity}</span>
                    </td>
                    <td>
                      <span>{order.salesChannel || 'Online Store'}</span>
                      <span className="dash-cell-sub" style={{ textTransform: 'capitalize' }}>
                        {order.paymentGateway || order.paymentMethod}
                      </span>
                    </td>
                    <td className="dash-num-cell">{formatMoney(order.totalAmount, order.currency)}</td>
                    <td className="dash-num-cell">
                      {formatMoney(order.estimatedShippingCost ?? 0, 'INR')}
                      <span className="dash-cell-sub">
                        {order.shippingZoneCode ? `Zone ${order.shippingZoneCode}` : 'Surface'}
                      </span>
                    </td>
                    <td>
                      <StatusBadge status={order.status} />
                    </td>
                    <td>
                      {order.waybillNumber ? (
                        <a
                          href={carrierTrackingUrl((order as any).courier || (order as any).shipment?.courier, order.waybillNumber)}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="dash-mono-code"
                          style={{ color: 'var(--blue)' }}
                        >
                          {order.waybillNumber} ↗
                        </a>
                      ) : (
                        <span className="dash-cell-sub">Unassigned</span>
                      )}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <Button
                        className="button-secondary button-small"
                        onClick={(e) => {
                          e.stopPropagation()
                          navigate(`/orders/${order.id}`)
                        }}
                      >
                        Inspect
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            title="No orders found in this period"
            description="Switch time filter at the top right or click Sync Orders."
          />
        )}
      </section>

      {/* ─── POP-UP 1: Dispatch & Operational Queue Modal ────────── */}
      {queueModal && (
        <div
          className="dash-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="dash-queue-modal-title"
          onClick={() => !isBulkDispatching && setQueueModal(null)}
        >
          <div className="dash-modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="dash-modal-header">
              <div className="dash-modal-title-group">
                <div className={`dash-modal-icon ${queueModalMeta[queueModal].tone}`}>
                  <Icon name={queueModal === 'ndr' ? 'alert' : queueModal === 'new' ? 'box' : 'truck'} size={18} />
                </div>
                <div>
                  <h3 id="dash-queue-modal-title" className="dash-modal-title">
                    {queueModalMeta[queueModal].title}
                    {queueQuery.data ? ` (${queueQuery.data.length})` : ''}
                  </h3>
                  <p className="dash-modal-desc">{queueModalMeta[queueModal].desc}</p>
                </div>
              </div>
              <button
                type="button"
                className="dash-modal-close"
                aria-label="Close popup"
                disabled={isBulkDispatching}
                onClick={() => setQueueModal(null)}
              >
                <Icon name="close" size={18} />
              </button>
            </div>

            <div className="dash-modal-body">
              {queueQuery.isLoading ? (
                <LoadingState label="Loading queue orders…" />
              ) : queueQuery.isError ? (
                <ErrorBox message={apiError(queueQuery.error)} />
              ) : (queueQuery.data?.length ?? 0) === 0 ? (
                <EmptyState
                  title="Queue is clear"
                  description="No orders currently require action in this queue."
                  icon="check"
                />
              ) : (
                <div className="dash-modal-list">
                  {queueQuery.data!.map((order) => {
                    const isCod = order.paymentMethod === 'COD'
                    const needsDispatchAction = queueModal === 'dispatch' || queueModal === 'prepaid'
                    const needsCodApprove = queueModal === 'new' && isCod && !order.shipment?.waybillNumber
                    const isVelocity = isVelocityCourier(order.shipment?.courier, order.shipment?.labelUrl, order.shipment?.waybillNumber)

                    return (
                      <div className="dash-modal-item" key={order.id}>
                        <div className="dash-modal-item-left">
                          <div className="dash-modal-item-top">
                            <Link
                              to={`/orders/${order.id}`}
                              className="dash-order-num"
                              onClick={() => setQueueModal(null)}
                            >
                              {order.shopifyOrderName}
                            </Link>
                            <StatusBadge status={order.status} />
                            <span className={`dash-badge ${isCod ? 'amber' : 'blue'}`}>
                              {isCod ? 'COD' : 'Prepaid'} · {formatMoney(order.totalAmount, order.currency)}
                            </span>
                          </div>
                          <div className="dash-modal-item-sub">
                            {order.customerName} · {order.customerCity}, {order.customerState} {order.customerPincode}
                            {order.shipment?.trackingStatus ? ` · ${order.shipment.trackingStatus}` : ''}
                            {order.shipment?.waybillNumber ? ` · AWB ${order.shipment.waybillNumber}` : ''}
                            {isVelocity ? ' (Velocity)' : ''}
                          </div>
                        </div>

                        <div className="dash-modal-item-actions">
                          {needsDispatchAction && (
                            <Button
                              className="button-primary button-small"
                              loading={dispatchingOrderId === order.id}
                              disabled={isBulkDispatching || (dispatchingOrderId !== null && dispatchingOrderId !== order.id)}
                              onClick={() => handleDispatchOne(order.id)}
                            >
                              Dispatch AWB
                            </Button>
                          )}
                          {needsCodApprove && (
                            <Button
                              className="button-primary button-small"
                              loading={confirmingCodId === order.id}
                              disabled={confirmingCodId !== null && confirmingCodId !== order.id}
                              onClick={() => handleConfirmCod(order.id)}
                            >
                              Approve COD
                            </Button>
                          )}
                          <Button
                            className="button-secondary button-small"
                            onClick={() => {
                              setQueueModal(null)
                              navigate(`/orders/${order.id}`)
                            }}
                          >
                            View
                          </Button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            <div className="dash-modal-footer">
              <Button
                className="button-secondary"
                disabled={isBulkDispatching}
                onClick={() => {
                  const target = queueModalMeta[queueModal].fullPath
                  setQueueModal(null)
                  navigate(target)
                }}
              >
                Open Full Orders View ↗
              </Button>
              <div style={{ display: 'flex', gap: '8px' }}>
                <Button
                  className="button-secondary"
                  disabled={isBulkDispatching}
                  onClick={() => setQueueModal(null)}
                >
                  Close
                </Button>
                {(queueModal === 'dispatch' || queueModal === 'prepaid') && (queueQuery.data?.length ?? 0) > 0 && (
                  <Button
                    className="button-primary"
                    loading={isBulkDispatching}
                    disabled={dispatchingOrderId !== null}
                    onClick={handleBulkDispatchModal}
                  >
                    Dispatch All ({Math.min(50, queueQuery.data!.length)})
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ─── POP-UP 2: Gateway Settlement Batch Breakdown Modal ──── */}
      {settlementModalBatchId && (
        <div
          className="dash-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="dash-settlement-modal-title"
          onClick={() => setSettlementModalBatchId(null)}
        >
          <div className="dash-modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="dash-modal-header">
              <div className="dash-modal-title-group">
                <div className="dash-modal-icon green">
                  <Icon name="dollar" size={18} />
                </div>
                <div>
                  <h3 id="dash-settlement-modal-title" className="dash-modal-title">
                    Settlement Batch · {settlementModalBatchId}
                  </h3>
                  <p className="dash-modal-desc">
                    Verified payment gateway remittance details from Gmail ingestion
                  </p>
                </div>
              </div>
              <button
                type="button"
                className="dash-modal-close"
                aria-label="Close settlement popup"
                onClick={() => setSettlementModalBatchId(null)}
              >
                <Icon name="close" size={18} />
              </button>
            </div>

            <div className="dash-modal-body">
              {batchDetailQuery.isLoading ? (
                <LoadingState label="Loading batch transactions…" />
              ) : batchDetailQuery.isError ? (
                <ErrorBox message={apiError(batchDetailQuery.error)} />
              ) : batchDetailQuery.data ? (
                <>
                  <div className="dash-modal-summary-grid">
                    <div className="dash-modal-stat">
                      <span>Net Bank Payout</span>
                      <strong style={{ color: '#059669' }}>
                        {formatMoney(Number(batchDetailQuery.data.netAmount ?? 0), 'INR')}
                      </strong>
                    </div>
                    <div className="dash-modal-stat">
                      <span>Gross Settled</span>
                      <strong>{formatMoney(Number(batchDetailQuery.data.grossAmount ?? 0), 'INR')}</strong>
                    </div>
                    <div className="dash-modal-stat">
                      <span>Fees + GST</span>
                      <strong>
                        {formatMoney(
                          Number(batchDetailQuery.data.feeAmount ?? 0) + Number(batchDetailQuery.data.gstAmount ?? 0),
                          'INR'
                        )}
                      </strong>
                    </div>
                    <div className="dash-modal-stat">
                      <span>Payout Date</span>
                      <strong>{formatDate(batchDetailQuery.data.settlementDate)}</strong>
                    </div>
                  </div>

                  {batchDetailQuery.data.bankUtr && (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
                      <CopyableBadge label="Bank UTR" text={batchDetailQuery.data.bankUtr} />
                      <span className="dash-badge green">
                        {batchDetailQuery.data.settledOrders?.length ?? batchDetailQuery.data.orderCount ?? 0} settled orders ·{' '}
                        {batchDetailQuery.data.settledRefunds?.length ?? batchDetailQuery.data.refundCount ?? 0} refunds
                      </span>
                    </div>
                  )}

                  {(batchDetailQuery.data.settledOrders?.length ?? 0) > 0 && (
                    <div>
                      <h4 style={{ margin: '6px 0 8px', fontSize: '13px', fontWeight: 700, color: 'var(--ink)' }}>
                        Settled Orders ({batchDetailQuery.data.settledOrders.length})
                      </h4>
                      <div className="dash-modal-list">
                        {batchDetailQuery.data.settledOrders.map((row: any) => (
                          <div className="dash-modal-item" key={row.id}>
                            <div className="dash-modal-item-left">
                              <div className="dash-modal-item-top">
                                <strong>{row.shopifyOrderName || row.merchantTrxnId || `Txn #${row.id}`}</strong>
                                <span className={`dash-badge ${row.status === 'MATCHED' ? 'green' : 'amber'}`}>
                                  {row.status}
                                </span>
                              </div>
                              <div className="dash-modal-item-sub">
                                Easebuzz <span className="dash-mono-code">{row.easebuzzTrxnId || '—'}</span>
                                {row.customerPhone ? ` · ${row.customerPhone}` : ''}
                              </div>
                            </div>
                            <div style={{ textAlign: 'right' }}>
                              <div className="dash-num-cell">{formatMoney(Number(row.netAmount ?? 0), 'INR')}</div>
                              <div className="dash-modal-item-sub">
                                Gross {formatMoney(Number(row.transactionAmount ?? 0), 'INR')}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {(batchDetailQuery.data.settledRefunds?.length ?? 0) > 0 && (
                    <div>
                      <h4 style={{ margin: '6px 0 8px', fontSize: '13px', fontWeight: 700, color: 'var(--ink)' }}>
                        Refund Debits ({batchDetailQuery.data.settledRefunds.length})
                      </h4>
                      <div className="dash-modal-list">
                        {batchDetailQuery.data.settledRefunds.map((refRow: any) => (
                          <div className="dash-modal-item" key={refRow.id}>
                            <div className="dash-modal-item-left">
                              <div className="dash-modal-item-top">
                                <strong>{refRow.shopifyOrderName || refRow.merchantTrxnId || `Refund #${refRow.id}`}</strong>
                                <span className="dash-badge red">{refRow.status}</span>
                              </div>
                              <div className="dash-modal-item-sub">
                                Refund ID <span className="dash-mono-code">{refRow.refundId || refRow.easebuzzTrxnId || '—'}</span>
                              </div>
                            </div>
                            <div className="dash-num-cell" style={{ color: 'var(--red)' }}>
                              -{formatMoney(Math.abs(Number(refRow.settlementAmount ?? refRow.refundAmount ?? 0)), 'INR')}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              ) : null}
            </div>

            <div className="dash-modal-footer">
              <Button
                className="button-secondary"
                onClick={() => {
                  setSettlementModalBatchId(null)
                  navigate('/remittance')
                }}
              >
                Open Payments & Remittance ↗
              </Button>
              <Button className="button-primary" onClick={() => setSettlementModalBatchId(null)}>
                Close
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ─── POP-UP 3: Quick Delhivery Freight Calculator Modal ───── */}
      {rateModalOpen && (
        <div
          className="dash-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="dash-rate-modal-title"
          onClick={() => setRateModalOpen(false)}
        >
          <div className="dash-modal-card compact" onClick={(e) => e.stopPropagation()}>
            <div className="dash-modal-header">
              <div className="dash-modal-title-group">
                <div className="dash-modal-icon blue">
                  <Icon name="tool" size={18} />
                </div>
                <div>
                  <h3 id="dash-rate-modal-title" className="dash-modal-title">Delhivery Rate Estimator</h3>
                  <p className="dash-modal-desc">
                    From Surat hub ({stats?.delhiveryStatus?.originPincode || '395002'}) · Surface ground matrix
                  </p>
                </div>
              </div>
              <button
                type="button"
                className="dash-modal-close"
                aria-label="Close rate estimator"
                onClick={() => setRateModalOpen(false)}
              >
                <Icon name="close" size={18} />
              </button>
            </div>

            <div className="dash-modal-body">
              <div className="dash-calc-grid">
                <div className="dash-calc-field">
                  <label htmlFor="dash-calc-pincode">Destination Pincode</label>
                  <input
                    id="dash-calc-pincode"
                    type="text"
                    maxLength={6}
                    value={calcPincode}
                    onChange={(e) => setCalcPincode(e.target.value)}
                    placeholder="400001"
                  />
                </div>
                <div className="dash-calc-field">
                  <label htmlFor="dash-calc-weight">Weight (grams)</label>
                  <input
                    id="dash-calc-weight"
                    type="number"
                    min={100}
                    step={100}
                    value={calcWeight}
                    onChange={(e) => setCalcWeight(Number(e.target.value))}
                  />
                </div>
                <div className="dash-calc-field">
                  <label htmlFor="dash-calc-mode">Payment Mode</label>
                  <select
                    id="dash-calc-mode"
                    value={calcMode}
                    onChange={(e) => setCalcMode(e.target.value as 'Pre-paid' | 'COD')}
                  >
                    <option value="Pre-paid">Pre-paid</option>
                    <option value="COD">COD</option>
                  </select>
                </div>
              </div>

              {calcResult && (
                <div className="dash-calc-result">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                    <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--ink)' }}>Estimated Freight</span>
                    <span style={{ fontSize: '18px', fontWeight: 800, color: 'var(--blue)', fontVariantNumeric: 'tabular-nums' }}>
                      {formatMoney(calcResult?.total_amount ?? calcResult?.rate ?? 85, 'INR')}
                    </span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: 'var(--muted)' }}>
                    <span>Base: <strong>{formatMoney(calcResult?.charges?.base ?? 60, 'INR')}</strong></span>
                    <span>COD Fee: <strong>{calcMode === 'COD' ? '₹38.00' : '₹0.00'}</strong></span>
                    <span>GST: <strong>18% incl.</strong></span>
                  </div>
                </div>
              )}
            </div>

            <div className="dash-modal-footer">
              <Button
                className="button-secondary"
                onClick={() => {
                  setRateModalOpen(false)
                  navigate('/tools')
                }}
              >
                Full Rate & Serviceability ↗
              </Button>
              <div style={{ display: 'flex', gap: '8px' }}>
                <Button className="button-secondary" onClick={() => setRateModalOpen(false)}>
                  Close
                </Button>
                <Button className="button-primary" loading={calcLoading} onClick={handleEstimate}>
                  Calculate Freight
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
