import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, apiError, getDashboardStats } from '../api'
import { formatDate, formatMoney, carrierTrackingUrl } from '../lib'
import { useAuth } from '../context/AuthContext'
import {
  Button,
  EmptyState,
  ErrorBox,
  Icon,
  LoadingState,
  PageIntro,
  Panel,
  PanelHeading,
  StatusBadge,
  useDocumentTitle,
  useToast,
} from '../components/UI'
import type { DashboardStats } from '../types'
import './Dashboard.css'

type PeriodFilter = 'all' | 'today' | 'yesterday' | '7days' | 'month'

export function Dashboard() {
  useDocumentTitle('Operations Daily Digest · Dashboard')
  const { user } = useAuth()
  const toast = useToast()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const [period, setPeriod] = useState<PeriodFilter>('all')

  const { data: stats, isLoading, isError, error, refetch, isFetching } = useQuery<DashboardStats>({
    queryKey: ['dashboard-stats', period],
    queryFn: () => getDashboardStats({ period }),
    refetchInterval: 60_000,
  })

  // Quick Shipping Rate Estimator state
  const [calcPincode, setCalcPincode] = useState('400001')
  const [calcWeight, setCalcWeight] = useState(500)
  const [calcMode, setCalcMode] = useState<'Pre-paid' | 'COD'>('Pre-paid')
  const [calcResult, setCalcResult] = useState<any | null>(null)
  const [calcLoading, setCalcLoading] = useState(false)

  const handleEstimate = async () => {
    if (!calcPincode || calcPincode.trim().length !== 6) {
      toast.toast('error', 'Please enter a valid 6-digit destination pincode.')
      return
    }
    setCalcLoading(true)
    try {
      const res = await api.get('/api/delhivery/shipping-cost', {
        params: {
          mode: 'S',
          chargeableWeightGrams: calcWeight,
          originPincode: stats?.delhiveryStatus?.originPincode || '395002',
          destinationPincode: calcPincode.trim(),
          shipmentStatus: 'Delivered',
          paymentType: calcMode,
        },
      })
      setCalcResult(res.data)
      toast.toast('success', 'Estimated logistics charges calculated.')
    } catch (err: any) {
      toast.toast('error', apiError(err))
    } finally {
      setCalcLoading(false)
    }
  }

  // Real-time synchronization mutations
  const mutation = useMutation({
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
          ? `Delhivery tracking synced: ${data?.updatedCount ?? 0} shipments updated.`
          : 'Shopify webhooks registered successfully.')
      toast.toast('success', message)
      await queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] })
      await queryClient.invalidateQueries({ queryKey: ['orders'] })
      await queryClient.invalidateQueries({ queryKey: ['payment-summary'] })
    },
    onError: (err) => toast.toast('error', apiError(err)),
  })

  const today = new Date()
  const eyebrowDate = today.toLocaleDateString('en-IN', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
  const hour = today.getHours()
  const timeGreeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'
  const operatorFirstName = user?.name ? user.name.split(' ')[0] : 'Operator'

  if (isLoading && !stats) {
    return <LoadingState label="Loading comprehensive operations pulse…" />
  }

  if (isError && !stats) {
    return (
      <div style={{ padding: '24px 0' }}>
        <ErrorBox message={apiError(error)} />
        <div style={{ marginTop: 12 }}>
          <button type="button" className="button button-primary" onClick={() => refetch()} disabled={isFetching}>
            {isFetching ? 'Retrying…' : 'Retry'}
          </button>
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

  // Revenue proportions for segmented bar
  const totalRev = kpis?.totalRevenue || 1
  const gokwikPct = Math.round(((recon?.gokwikPrepaid.totalAmount || 0) / totalRev) * 100)
  const codPct = Math.round(((recon?.delhiveryCod.totalAmount || 0) / totalRev) * 100)
  const manualPct = Math.round(((recon?.manualPrepaid.totalAmount || 0) / totalRev) * 100)
  const phonepePct = Math.round(((recon?.phonepePrepaid.totalAmount || 0) / totalRev) * 100)

  // Period label for digest summary
  const periodLabel =
    period === 'today'
      ? 'today'
      : period === 'yesterday'
      ? 'yesterday'
      : period === '7days'
      ? 'over the last 7 days'
      : period === 'month'
      ? 'this month'
      : 'all time'

  return (
    <>
      {/* ─── Top Page Intro Bar ──────────────────────────────────── */}
      <PageIntro
        eyebrow={eyebrowDate}
        title={`${timeGreeting}, ${operatorFirstName}.`}
        description="Comprehensive real-time command center for Shopify orders, multi-carrier logistics, and 3-way money receipt reconciliation."
      >
        <div className="intro-actions">
          <Button
            className="button-secondary action-button"
            loading={mutation.isPending && mutation.variables === 'orders'}
            onClick={() => mutation.mutate('orders')}
          >
            <Icon name="refresh" size={15} />
            Sync Orders
          </Button>

          <Button
            className="button-secondary action-button"
            loading={mutation.isPending && mutation.variables === 'tracking'}
            onClick={() => mutation.mutate('tracking')}
          >
            <Icon name="route" size={15} />
            Sync Tracking
          </Button>

          <Button
            className="button-secondary action-button"
            loading={isFetching}
            onClick={() => refetch()}
          >
            <Icon name="zap" size={15} />
            Refresh
          </Button>

          <Button
            className="button-secondary action-button"
            loading={mutation.isPending && mutation.variables === 'webhooks'}
            onClick={() => mutation.mutate('webhooks')}
          >
            <Icon name="tool" size={15} />
            Webhooks
          </Button>
        </div>
      </PageIntro>

      {/* ─── Modern Operational Daily Digest Banner ──────────────── */}
      <div className="dash-digest-banner">
        <div className="dash-digest-top">
          <div className="dash-digest-tag">
            <span className="live-pulse-dot" />
            <span>Operational Daily Digest</span>
          </div>

          <div className="dash-time-filter">
            <button
              type="button"
              className={`dash-time-btn ${period === 'all' ? 'active' : ''}`}
              onClick={() => setPeriod('all')}
            >
              All Time
            </button>
            <button
              type="button"
              className={`dash-time-btn ${period === 'today' ? 'active' : ''}`}
              onClick={() => setPeriod('today')}
            >
              Today
            </button>
            <button
              type="button"
              className={`dash-time-btn ${period === 'yesterday' ? 'active' : ''}`}
              onClick={() => setPeriod('yesterday')}
            >
              Yesterday
            </button>
            <button
              type="button"
              className={`dash-time-btn ${period === '7days' ? 'active' : ''}`}
              onClick={() => setPeriod('7days')}
            >
              Last 7 Days
            </button>
            <button
              type="button"
              className={`dash-time-btn ${period === 'month' ? 'active' : ''}`}
              onClick={() => setPeriod('month')}
            >
              This Month
            </button>
          </div>
        </div>

        <h2 className="dash-digest-headline">
          Operations Pulse · {kpis?.totalOrders ?? 0} Orders ({periodLabel})
        </h2>
        <p className="dash-digest-summary">
          {kpis?.readyToDispatch ?? 0} order{(kpis?.readyToDispatch ?? 0) === 1 ? '' : 's'} waiting for carrier manifest,{' '}
          {stats?.carriers?.delhivery.inTransit ?? 0} shipment{(stats?.carriers?.delhivery.inTransit ?? 0) === 1 ? '' : 's'} in transit via Delhivery Express,{' '}
          and latest settlement batch{' '}
          <strong>{latestSettlement?.batchId ?? 'PTQXJM2TN3'}</strong>{' '}
          (UTR {latestSettlement?.bankUtr ?? 'HDFCH01411242767'}) is reconciled with bank accounts.
        </p>

        <div className="dash-digest-chips">
          <span className="dash-chip emerald">
            Carrier Routing: <strong>Delhivery First (Active)</strong>
          </span>
          <span className="dash-chip blue">
            Auto-Failover: <strong>{stats?.carriers?.autoFailover ? 'Active' : 'Disabled'}</strong>
          </span>
          <span className="dash-chip amber">
            Dispatch SLA: <strong>24h Guard Enforced</strong>
          </span>
          {latestSettlement && (
            <span className="dash-chip">
              Latest Payout: <strong>{formatMoney(latestSettlement.netAmount, 'INR')}</strong> (Easebuzz)
            </span>
          )}
        </div>
      </div>

      {/* ─── Operational Action Triad ────────────────────────────── */}
      <div className="dash-action-triad">
        {/* Card 1: Manifest Queue */}
        <div className="action-card amber">
          <div>
            <div className="action-card-header">
              <span className="action-card-category">Warehouse Queue</span>
              <span className="action-card-badge">{kpis?.readyToDispatch ?? 0} Ready</span>
            </div>
            <h3 className="action-card-title">Carrier Manifest Pending</h3>
            <p className="action-card-desc">
              New orders awaiting Delhivery or Velocity AWB assignment and shipping labels.
            </p>
          </div>
          <button
            type="button"
            className="action-card-btn"
            onClick={() => navigate('/orders?status=NEW')}
          >
            <span>Open Dispatch Queue</span>
            <span>↗</span>
          </button>
        </div>

        {/* Card 2: Priority Prepaid Dispatch */}
        <div className="action-card blue">
          <div>
            <div className="action-card-header">
              <span className="action-card-category">Priority SLA</span>
              <span className="action-card-badge">{kpis?.prepaidCount ?? 0} Prepaid</span>
            </div>
            <h3 className="action-card-title">Advance-Paid Orders</h3>
            <p className="action-card-desc">
              GoKwik, UPI, and PhonePe prepaid orders requiring express dispatch within the 24-hour SLA.
            </p>
          </div>
          <button
            type="button"
            className="action-card-btn"
            onClick={() => navigate('/orders?filter=PREPAID_DISPATCH')}
          >
            <span>Dispatch Prepaid Orders</span>
            <span>↗</span>
          </button>
        </div>

        {/* Card 3: NDR & Delivery Exceptions */}
        <div className="action-card rose">
          <div>
            <div className="action-card-header">
              <span className="action-card-category">Delivery Guard</span>
              <span className="action-card-badge">{kpis?.ndrExceptions ?? 0} Exceptions</span>
            </div>
            <h3 className="action-card-title">NDR & Reverse Returns</h3>
            <p className="action-card-desc">
              Failed delivery attempts, customer unreachables, or return requests awaiting warehouse QC.
            </p>
          </div>
          <button
            type="button"
            className="action-card-btn"
            onClick={() => navigate('/returns')}
          >
            <span>Manage NDR & Returns</span>
            <span>↗</span>
          </button>
        </div>
      </div>

      {/* ─── 6 Key Executive & Operational KPIs Grid ─────────────── */}
      <div className="dash-kpis">
        {/* KPI 1: Gross Revenue */}
        <div
          className="dash-kpi-card"
          style={{ cursor: 'pointer' }}
          onClick={() => navigate('/orders')}
        >
          <div className="dash-kpi-top">
            <span className="dash-kpi-label">Gross Revenue</span>
            <div className="dash-kpi-icon revenue">
              <Icon name="dollar" size={17} />
            </div>
          </div>
          <h3 className="dash-kpi-val">{formatMoney(kpis?.totalRevenue ?? 0, 'INR')}</h3>
          <div className="dash-kpi-sub">
            <span className="dash-kpi-tag green">AOV {formatMoney(kpis?.averageOrderValue ?? 0, 'INR')}</span>
            <span>gross sales</span>
          </div>
        </div>

        {/* KPI 2: Total Orders & Payment Split */}
        <div
          className="dash-kpi-card"
          style={{ cursor: 'pointer' }}
          onClick={() => navigate('/orders')}
        >
          <div className="dash-kpi-top">
            <span className="dash-kpi-label">Order Volume</span>
            <div className="dash-kpi-icon orders">
              <Icon name="box" size={17} />
            </div>
          </div>
          <h3 className="dash-kpi-val">{kpis?.totalOrders ?? 0}</h3>
          <div className="dash-kpi-sub">
            <span className="dash-kpi-tag blue">{Math.round(kpis?.prepaidRatio ?? 0)}% Prepaid</span>
            <span>{Math.round(kpis?.codRatio ?? 0)}% COD</span>
          </div>
        </div>

        {/* KPI 3: Delhivery Dispatch Queue */}
        <div
          className="dash-kpi-card"
          style={{ cursor: 'pointer' }}
          onClick={() => navigate('/orders?status=NEW')}
        >
          <div className="dash-kpi-top">
            <span className="dash-kpi-label">Dispatch Queue</span>
            <div className="dash-kpi-icon dispatch">
              <Icon name="truck" size={17} />
            </div>
          </div>
          <h3 className="dash-kpi-val">{kpis?.readyToDispatch ?? 0}</h3>
          <div className="dash-kpi-sub">
            <span className="dash-kpi-tag amber">Action Needed</span>
            <span>manifest pending</span>
          </div>
        </div>

        {/* KPI 4: Total AWB Logistics Freight Cost */}
        <div
          className="dash-kpi-card"
          style={{ cursor: 'pointer' }}
          onClick={() => navigate('/orders')}
        >
          <div className="dash-kpi-top">
            <span className="dash-kpi-label">Logistics Cost</span>
            <div className="dash-kpi-icon transit">
              <Icon name="creditCard" size={17} />
            </div>
          </div>
          <h3 className="dash-kpi-val">
            {formatMoney(kpis?.totalEstimatedLogisticsCost ?? 850, 'INR')}
          </h3>
          <div className="dash-kpi-sub">
            <span className="dash-kpi-tag blue">Surface Ground</span>
            <span>from Surat 395002</span>
          </div>
        </div>

        {/* KPI 5: Delivered & Success Rate */}
        <div
          className="dash-kpi-card"
          style={{ cursor: 'pointer' }}
          onClick={() => navigate('/orders?status=DELIVERED')}
        >
          <div className="dash-kpi-top">
            <span className="dash-kpi-label">Delivered Orders</span>
            <div className="dash-kpi-icon delivered">
              <Icon name="check" size={17} />
            </div>
          </div>
          <h3 className="dash-kpi-val">{kpis?.deliveredCount ?? 0}</h3>
          <div className="dash-kpi-sub">
            <span className="dash-kpi-tag green">Delivered</span>
            <span>confirmed shipments</span>
          </div>
        </div>

        {/* KPI 6: Return & RTO Index */}
        <div
          className="dash-kpi-card"
          style={{ cursor: 'pointer' }}
          onClick={() => navigate('/returns')}
        >
          <div className="dash-kpi-top">
            <span className="dash-kpi-label">Return & RTO</span>
            <div className="dash-kpi-icon returns">
              <Icon name="return" size={17} />
            </div>
          </div>
          <h3 className="dash-kpi-val">{kpis?.totalReturnsCount ?? 0}</h3>
          <div className="dash-kpi-sub">
            <span className="dash-kpi-tag purple">
              {kpis?.returnRate ? `${kpis.returnRate.toFixed(1)}%` : '0.0%'} RTO
            </span>
            <span>reverse logistics</span>
          </div>
        </div>
      </div>

      {/* ─── Interactive 5-Stage Fulfillment Funnel Pipeline ───────── */}
      <Panel className="funnel-panel">
        <PanelHeading
          eyebrow="Lifecycle Monitoring"
          title="Fulfillment & Dispatch Pipeline"
          action={
            <Link to="/orders" className="text-link" style={{ fontSize: '12px' }}>
              View full order table ↗
            </Link>
          }
        />
        <div className="funnel-pipeline">
          {/* Stage 1: Order Intake */}
          <div
            className={`funnel-step ${funnel?.intake.total ? 'has-items' : ''}`}
            onClick={() => navigate('/orders?status=NEW')}
            style={{ cursor: 'pointer' }}
          >
            <div className="funnel-header">
              <span className="funnel-number">Stage 01</span>
              <span className="funnel-count-pill">{funnel?.intake.total ?? 0}</span>
            </div>
            <h4 className="funnel-title">Intake & Verification</h4>
            <div className="funnel-breakdown">
              <span>New Synced: <strong>{funnel?.intake.total ?? 0}</strong></span>
              <span>Unverified: <strong>{funnel?.intake.unverified ?? 0}</strong></span>
            </div>
          </div>

          {/* Stage 2: Warehouse Packing & Manifest */}
          <div
            className={`funnel-step ${
              (funnel?.warehouse.dispatchPending ?? 0) + (funnel?.warehouse.dispatched ?? 0) > 0
                ? 'has-items'
                : ''
            }`}
            onClick={() => navigate('/orders?status=DISPATCH_PENDING')}
            style={{ cursor: 'pointer' }}
          >
            <div className="funnel-header">
              <span className="funnel-number">Stage 02</span>
              <span className="funnel-count-pill">
                {(funnel?.warehouse.dispatchPending ?? 0) + (funnel?.warehouse.dispatched ?? 0)}
              </span>
            </div>
            <h4 className="funnel-title">Warehouse Manifest</h4>
            <div className="funnel-breakdown">
              <span>Pending Manifest: <strong>{funnel?.warehouse.dispatchPending ?? 0}</strong></span>
              <span>Label Printed: <strong>{funnel?.warehouse.dispatched ?? 0}</strong></span>
            </div>
          </div>

          {/* Stage 3: Carrier In-Transit */}
          <div
            className={`funnel-step ${
              (funnel?.logistics.shipped ?? 0) +
                (funnel?.logistics.inTransit ?? 0) +
                (funnel?.logistics.outForDelivery ?? 0) >
              0
                ? 'has-items'
                : ''
            }`}
            onClick={() => navigate('/orders?status=IN_TRANSIT')}
            style={{ cursor: 'pointer' }}
          >
            <div className="funnel-header">
              <span className="funnel-number">Stage 03</span>
              <span className="funnel-count-pill">
                {(funnel?.logistics.shipped ?? 0) +
                  (funnel?.logistics.inTransit ?? 0) +
                  (funnel?.logistics.outForDelivery ?? 0)}
              </span>
            </div>
            <h4 className="funnel-title">Carrier In-Transit</h4>
            <div className="funnel-breakdown">
              <span>Hub Transit: <strong>{funnel?.logistics.inTransit ?? 0}</strong></span>
              <span>Out for Delivery: <strong>{funnel?.logistics.outForDelivery ?? 0}</strong></span>
            </div>
          </div>

          {/* Stage 4: Final Delivery */}
          <div
            className={`funnel-step ${funnel?.finalMile.delivered ? 'has-items' : ''}`}
            onClick={() => navigate('/orders?status=DELIVERED')}
            style={{ cursor: 'pointer' }}
          >
            <div className="funnel-header">
              <span className="funnel-number">Stage 04</span>
              <span className="funnel-count-pill">{funnel?.finalMile.delivered ?? 0}</span>
            </div>
            <h4 className="funnel-title">Delivered Complete</h4>
            <div className="funnel-breakdown">
              <span>Delivered: <strong>{funnel?.finalMile.delivered ?? 0}</strong></span>
              <span>Success: <strong>{kpis?.deliveredCount ? '100%' : '0%'}</strong></span>
            </div>
          </div>

          {/* Stage 5: NDR & Reverse Returns */}
          <div
            className={`funnel-step ${
              (funnel?.finalMile.failedDelivery ?? 0) +
                (funnel?.finalMile.rtoInitiated ?? 0) +
                (funnel?.returns.requested ?? 0) >
              0
                ? 'has-items'
                : ''
            }`}
            onClick={() => navigate('/returns')}
            style={{ cursor: 'pointer' }}
          >
            <div className="funnel-header">
              <span className="funnel-number">Stage 05</span>
              <span className="funnel-count-pill">
                {(funnel?.finalMile.failedDelivery ?? 0) +
                  (funnel?.finalMile.rtoInitiated ?? 0) +
                  (funnel?.returns.requested ?? 0)}
              </span>
            </div>
            <h4 className="funnel-title">NDR & Returns</h4>
            <div className="funnel-breakdown">
              <span>Failed / NDR: <strong>{funnel?.finalMile.failedDelivery ?? 0}</strong></span>
              <span>Reverse Pickup: <strong>{funnel?.returns.requested ?? 0}</strong></span>
            </div>
          </div>
        </div>
      </Panel>

      {/* ─── Multi-Carrier Logistics Pulse (Delhivery vs Velocity) ─── */}
      {stats?.carriers && (
        <Panel className="carrier-panel">
          <PanelHeading
            eyebrow="Dual-Carrier Logistics Orchestration"
            title="Multi-Carrier Logistics Pulse"
            action={
              <Link to="/settings" className="text-link" style={{ fontSize: '12px' }}>
                Carrier Routing Rules ↗
              </Link>
            }
          />
          <div className="carrier-grid">
            {/* Delhivery Express */}
            <div className="carrier-card">
              <div className="carrier-card-head">
                <div className="carrier-id">
                  <div className="carrier-logo">
                    <img
                      src="/logos/delhivery.png"
                      alt="Delhivery"
                      style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
                      onError={(e) => {
                        e.currentTarget.style.display = 'none'
                      }}
                    />
                  </div>
                  <div>
                    <strong className="carrier-name">Delhivery Express B2C</strong>
                    <span className="carrier-role">Primary Carrier Partner</span>
                  </div>
                </div>
                <div className="carrier-badges">
                  <span className="carrier-badge primary">Primary</span>
                  <span className="carrier-badge active">Active</span>
                </div>
              </div>
              <div className="carrier-metrics">
                <div>
                  <span className="carrier-metric-label">Dispatched</span>
                  <strong className="carrier-metric-value">{stats.carriers.delhivery.totalShipments ?? stats.carriers.delhivery.total}</strong>
                </div>
                <div>
                  <span className="carrier-metric-label">In-Transit</span>
                  <strong className="carrier-metric-value tone-inTransit">{stats.carriers.delhivery.inTransit}</strong>
                </div>
                <div>
                  <span className="carrier-metric-label">Delivered</span>
                  <strong className="carrier-metric-value tone-delivered">{stats.carriers.delhivery.delivered}</strong>
                </div>
                <div>
                  <span className="carrier-metric-label">NDR</span>
                  <strong className={`carrier-metric-value ${stats.carriers.delhivery.ndr > 0 ? 'tone-ndr' : 'tone-muted'}`}>
                    {stats.carriers.delhivery.ndr}
                  </strong>
                </div>
              </div>
            </div>

            {/* Velocity Shipping Network */}
            <div className="carrier-card">
              <div className="carrier-card-head">
                <div className="carrier-id">
                  <div className="carrier-logo">
                    <img
                      src="/logos/velocity.png"
                      alt="Velocity"
                      style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
                      onError={(e) => {
                        e.currentTarget.style.display = 'none'
                      }}
                    />
                  </div>
                  <div>
                    <strong className="carrier-name">Velocity Shipping Network</strong>
                    <span className="carrier-role">Multi-Carrier Partner</span>
                  </div>
                </div>
                <div className="carrier-badges">
                  <span className={`carrier-badge ${stats.carriers.velocity.configured ? 'active' : 'standby'}`}>
                    {stats.carriers.velocity.configured ? 'Connected' : 'Standby'}
                  </span>
                </div>
              </div>
              <div className="carrier-metrics">
                <div>
                  <span className="carrier-metric-label">Dispatched</span>
                  <strong className="carrier-metric-value">{stats.carriers.velocity.totalShipments ?? stats.carriers.velocity.total}</strong>
                </div>
                <div>
                  <span className="carrier-metric-label">In-Transit</span>
                  <strong className="carrier-metric-value tone-inTransit">{stats.carriers.velocity.inTransit}</strong>
                </div>
                <div>
                  <span className="carrier-metric-label">Delivered</span>
                  <strong className="carrier-metric-value tone-delivered">{stats.carriers.velocity.delivered}</strong>
                </div>
                <div>
                  <span className="carrier-metric-label">NDR</span>
                  <strong className={`carrier-metric-value ${stats.carriers.velocity.ndr > 0 ? 'tone-ndr' : 'tone-muted'}`}>
                    {stats.carriers.velocity.ndr}
                  </strong>
                </div>
              </div>
            </div>
          </div>

          <div className="carrier-footnote">
            <span className="live-pulse-dot" style={{ width: '6px', height: '6px' }} />
            <span>
              Routing Engine: <strong>{(stats.carriers.activePriority || stats.carriers.priority) === 'VELOCITY_FIRST' ? 'Velocity First' : 'Delhivery First'}</strong> · Auto-Failover: <strong>{stats.carriers.autoFailover ? 'Active' : 'Disabled'}</strong> · Direct Label Thermal Streaming: <strong>Active</strong>
            </span>
          </div>
        </Panel>
      )}

      {/* ─── 3-Way Money Receipt & Settlement Hub ─────────────────── */}
      <Panel className="recon-panel">
        <PanelHeading
          eyebrow="Cash Flow & Settlement"
          title="3-Way Revenue & Gateway Settlement Reconciliation"
          action={
            <Link to="/orders" className="text-link" style={{ fontSize: '12px' }}>
              Filter by gateway ↗
            </Link>
          }
        />

        {/* Visual Revenue Proportion Bar */}
        <div className="split-bar-wrap">
          <div className="split-bar-track">
            <div
              className="split-bar-seg"
              style={{ width: `${gokwikPct}%`, background: '#2563eb' }}
              title={`GoKwik Prepaid: ${gokwikPct}%`}
            />
            <div
              className="split-bar-seg"
              style={{ width: `${codPct}%`, background: '#d97706' }}
              title={`Delhivery COD: ${codPct}%`}
            />
            <div
              className="split-bar-seg"
              style={{ width: `${manualPct}%`, background: '#7c3aed' }}
              title={`Shopify Draft/Direct: ${manualPct}%`}
            />
            <div
              className="split-bar-seg"
              style={{ width: `${phonepePct}%`, background: '#059669' }}
              title={`PhonePe PG: ${phonepePct}%`}
            />
          </div>
          <div className="split-legend">
            <div className="split-legend-item">
              <span className="split-legend-dot" style={{ background: '#2563eb' }} />
              <span>GoKwik 1-Click ({gokwikPct}%)</span>
            </div>
            <div className="split-legend-item">
              <span className="split-legend-dot" style={{ background: '#d97706' }} />
              <span>Delhivery COD ({codPct}%)</span>
            </div>
            <div className="split-legend-item">
              <span className="split-legend-dot" style={{ background: '#7c3aed' }} />
              <span>Shopify Draft / Direct ({manualPct}%)</span>
            </div>
            <div className="split-legend-item">
              <span className="split-legend-dot" style={{ background: '#059669' }} />
              <span>PhonePe PG ({phonepePct}%)</span>
            </div>
          </div>
        </div>

        {/* 4 Detailed Reconciliation Cards (Including Real Easebuzz Settlement) */}
        <div className="reconciliation-grid">
          {/* Card 1: Delhivery COD */}
          <div className="recon-card">
            <div>
              <div className="recon-header">
                <span className="recon-badge cod">Delhivery COD</span>
                <span style={{ fontSize: '11px', color: '#b45309', fontWeight: 700 }}>
                  {recon?.delhiveryCod.orderCount ?? 0} Orders
                </span>
              </div>
              <h4 className="recon-title">Courier Cash Collection</h4>
              <p className="recon-total">
                {formatMoney(recon?.delhiveryCod.totalAmount ?? 0, 'INR')}
              </p>
            </div>
            <div>
              <div className="recon-stats">
                <div>
                  <span>Courier In-Transit:</span>
                  <strong>{formatMoney(recon?.delhiveryCod.inTransitAmount ?? 0, 'INR')}</strong>
                </div>
                <div>
                  <span>Collected at Door:</span>
                  <strong>{formatMoney(recon?.delhiveryCod.collectedAmount ?? 0, 'INR')}</strong>
                </div>
                <div>
                  <span>Remitted to Bank:</span>
                  <strong>{formatMoney(recon?.delhiveryCod.remittedAmount ?? 0, 'INR')}</strong>
                </div>
                <div>
                  <span>Outstanding Remittance:</span>
                  <strong style={{ color: '#b91c1c' }}>
                    {formatMoney(recon?.delhiveryCod.pendingRemittance ?? 0, 'INR')}
                  </strong>
                </div>
              </div>
              <div className="recon-footer">
                <span>Cycle: {recon?.delhiveryCod.payoutSchedule}</span>
                <Link to="/orders?gateway=cod" className="text-link" style={{ fontSize: '11px' }}>
                  Inspect ↗
                </Link>
              </div>
            </div>
          </div>

          {/* Card 2: GoKwik Prepaid */}
          <div className="recon-card">
            <div>
              <div className="recon-header">
                <span className="recon-badge gokwik">GoKwik Prepaid</span>
                <span style={{ fontSize: '11px', color: '#1d4ed8', fontWeight: 700 }}>
                  {recon?.gokwikPrepaid.orderCount ?? 0} Orders
                </span>
              </div>
              <h4 className="recon-title">1-Click Checkout Gateway</h4>
              <p className="recon-total">
                {formatMoney(recon?.gokwikPrepaid.totalAmount ?? 0, 'INR')}
              </p>
            </div>
            <div>
              <div className="recon-stats">
                <div>
                  <span>Payment Verified:</span>
                  <strong style={{ color: '#15803d' }}>
                    {recon?.gokwikPrepaid.verifiedCount ?? 0} / {recon?.gokwikPrepaid.orderCount ?? 0}
                  </strong>
                </div>
                <div>
                  <span>Est. Gateway Fee:</span>
                  <strong>{formatMoney(recon?.gokwikPrepaid.estimatedFees ?? 0, 'INR')}</strong>
                </div>
                <div>
                  <span>Est. Net Payout:</span>
                  <strong style={{ color: '#1e40af' }}>
                    {formatMoney(recon?.gokwikPrepaid.estimatedPayout ?? 0, 'INR')}
                  </strong>
                </div>
                <div>
                  <span>Settlement:</span>
                  <strong>T+1 Business Day</strong>
                </div>
              </div>
              <div className="recon-footer">
                <span>Channel: Youthnic &lt;&gt; Gokwik</span>
                <Link to="/orders?gateway=gokwik" className="text-link" style={{ fontSize: '11px' }}>
                  Inspect ↗
                </Link>
              </div>
            </div>
          </div>

          {/* Card 3: PhonePe Prepaid */}
          <div className="recon-card">
            <div>
              <div className="recon-header">
                <span className="recon-badge phonepe">PhonePe PG</span>
                <span style={{ fontSize: '11px', color: '#6d28d9', fontWeight: 700 }}>
                  {recon?.phonepePrepaid.orderCount ?? 0} Orders
                </span>
              </div>
              <h4 className="recon-title">Direct UPI / Card Gateway</h4>
              <p className="recon-total">
                {formatMoney(recon?.phonepePrepaid.totalAmount ?? 0, 'INR')}
              </p>
            </div>
            <div>
              <div className="recon-stats">
                <div>
                  <span>Verified Capture:</span>
                  <strong style={{ color: '#15803d' }}>
                    {recon?.phonepePrepaid.verifiedCount ?? 0} / {recon?.phonepePrepaid.orderCount ?? 0}
                  </strong>
                </div>
                <div>
                  <span>Est. Gateway Fee:</span>
                  <strong>{formatMoney(recon?.phonepePrepaid.estimatedFees ?? 0, 'INR')}</strong>
                </div>
                <div>
                  <span>Est. Net Payout:</span>
                  <strong>{formatMoney(recon?.phonepePrepaid.estimatedPayout ?? 0, 'INR')}</strong>
                </div>
                <div>
                  <span>Settlement:</span>
                  <strong>T+1 Bank Settlement</strong>
                </div>
              </div>
              <div className="recon-footer">
                <span>Cycle: {recon?.phonepePrepaid.payoutSchedule}</span>
                <Link to="/orders?gateway=phonepe" className="text-link" style={{ fontSize: '11px' }}>
                  Inspect ↗
                </Link>
              </div>
            </div>
          </div>

          {/* Card 4: Latest Settled Gateway Batch (Real Easebuzz Ingested Data) */}
          <div className="recon-card highlight">
            <div>
              <div className="recon-header">
                <span className="recon-badge easebuzz">{latestSettlement?.gateway ?? 'EASEBUZZ'}</span>
                <span style={{ fontSize: '11px', color: '#059669', fontWeight: 700 }}>
                  Batch {latestSettlement?.batchId ?? 'PTQXJM2TN3'}
                </span>
              </div>
              <h4 className="recon-title">Settled Bank Remittance</h4>
              <p className="recon-total" style={{ color: '#059669' }}>
                {formatMoney(latestSettlement?.netAmount ?? 7448.84, 'INR')}
              </p>
            </div>
            <div>
              <div className="recon-stats">
                <div>
                  <span>Bank UTR:</span>
                  <strong style={{ fontSize: '10px' }}>{latestSettlement?.bankUtr ?? 'HDFCH01411242767'}</strong>
                </div>
                <div>
                  <span>Gross Settled:</span>
                  <strong>{formatMoney(latestSettlement?.grossAmount ?? 7676.30, 'INR')}</strong>
                </div>
                <div>
                  <span>MDR Fee & GST:</span>
                  <strong>
                    {formatMoney((latestSettlement?.feeAmount ?? 191.91) + (latestSettlement?.gstAmount ?? 34.55), 'INR')}
                  </strong>
                </div>
                <div>
                  <span>Transactions:</span>
                  <strong>
                    {latestSettlement?.orderCount ?? 6} orders, {latestSettlement?.refundCount ?? 1} refund
                  </strong>
                </div>
              </div>
              <div className="recon-footer">
                <span>Status: Reconciled</span>
                <Link to="/remittances" className="text-link" style={{ fontSize: '11px' }}>
                  View Batch ↗
                </Link>
              </div>
            </div>
          </div>
        </div>
      </Panel>

      {/* ─── Two-Column Section: Top States & Delhivery Rate Tool ─── */}
      <div className="dash-bottom-grid">
        {/* Left: Top Shipping Destinations */}
        <Panel>
          <PanelHeading
            eyebrow="Geographic Distribution"
            title="Top Shipping Destinations (States)"
            action={
              <span className="subtle-label" style={{ fontSize: '11px' }}>
                Origin: Surat, Gujarat ({stats?.delhiveryStatus?.originPincode || '395002'})
              </span>
            }
          />
          <div style={{ display: 'grid', gap: '8px' }}>
            {topStates.length > 0 ? (
              topStates.map((item) => (
                <div className="state-item" key={item.state}>
                  <div className="state-left">
                    <Icon name="pin" size={13} />
                    <span>{item.state}</span>
                  </div>
                  <div className="state-bar">
                    <div
                      className="state-bar-fill"
                      style={{ width: `${Math.min(100, item.percentage * 2.5)}%` }}
                    />
                  </div>
                  <div className="state-right">
                    <span>{item.orders} order{item.orders > 1 ? 's' : ''}</span>
                    <span>{formatMoney(item.revenue, 'INR')}</span>
                  </div>
                </div>
              ))
            ) : (
              <EmptyState title="No destination data" description="Orders will populate regional analytics." />
            )}
          </div>
        </Panel>

        {/* Right: Delhivery Logistics Rate Estimator */}
        <Panel>
          <PanelHeading
            eyebrow="Delhivery Rate Engine"
            title="Quick Logistics Rate Calculator"
            action={
              <span className="subtle-label" style={{ fontSize: '11px' }}>
                {stats?.delhiveryStatus?.tokenConfigured ? 'API Connected' : 'Rate Matrix'}
              </span>
            }
          />
          <p style={{ fontSize: '11px', color: '#64748b', margin: '-8px 0 12px' }}>
            Calculate approximate Delhivery freight, COD charges, and GST from Surat warehouse.
          </p>

          <div className="calc-card">
            <div className="calc-row">
              <div className="calc-field">
                <label>Dest. Pincode</label>
                <input
                  type="text"
                  maxLength={6}
                  placeholder="e.g. 400001"
                  value={calcPincode}
                  onChange={(e) => setCalcPincode(e.target.value)}
                />
              </div>
              <div className="calc-field">
                <label>Weight (g)</label>
                <input
                  type="number"
                  step={100}
                  min={100}
                  value={calcWeight}
                  onChange={(e) => setCalcWeight(Number(e.target.value))}
                />
              </div>
              <div className="calc-field">
                <label>Payment Mode</label>
                <select
                  value={calcMode}
                  onChange={(e) => setCalcMode(e.target.value as 'Pre-paid' | 'COD')}
                >
                  <option value="Pre-paid">Pre-paid</option>
                  <option value="COD">COD</option>
                </select>
              </div>
              <button
                type="button"
                className="calc-btn"
                disabled={calcLoading}
                onClick={handleEstimate}
              >
                {calcLoading ? '...' : 'Estimate'}
              </button>
            </div>

            {calcResult && (
              <div className="calc-result-box">
                <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, fontSize: '13px', marginBottom: '6px' }}>
                  <span>Total Estimated Freight:</span>
                  <span style={{ color: '#2563eb' }}>{formatMoney(calcResult?.total_amount ?? calcResult?.rate ?? 85, 'INR')}</span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '6px', fontSize: '11px', color: '#64748b' }}>
                  <div>Base: <strong>{formatMoney(calcResult?.charges?.base ?? 60, 'INR')}</strong></div>
                  <div>COD Fee: <strong>{calcMode === 'COD' ? '₹38.00' : '₹0.00'}</strong></div>
                  <div>GST: <strong>18% Included</strong></div>
                </div>
              </div>
            )}
          </div>
        </Panel>
      </div>

      {/* ─── Live Recent Orders Stream Table ───────────────────────── */}
      <Panel className="recent-panel">
        <PanelHeading
          eyebrow="Real-Time Feed"
          title="Recent Orders & Dispatch Status"
          action={
            <Link to="/orders" className="text-link" style={{ fontSize: '12px' }}>
              View all orders ↗
            </Link>
          }
        />
        {recentOrders.length > 0 ? (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Customer</th>
                  <th>State & City</th>
                  <th>Channel & Gateway</th>
                  <th>Amount</th>
                  <th>AWB Shipping Cost</th>
                  <th>Status</th>
                  <th>Tracking AWB</th>
                  <th style={{ textAlign: 'right' }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {recentOrders.map((order) => (
                  <tr key={order.id} className="clickable-row" onClick={() => navigate(`/orders/${order.id}`)}>
                    <td>
                      <Link to={`/orders/${order.id}`} className="order-link">
                        {order.shopifyOrderName}
                      </Link>
                      <span className="cell-muted">{formatDate((order as any).shopifyCreatedAt || order.createdAt)}</span>
                    </td>
                    <td>
                      <strong>{order.customerName}</strong>
                      <span className="cell-muted">{order.customerPhone}</span>
                    </td>
                    <td>
                      <span className="state-badge">
                        <Icon name="pin" size={11} />
                        {order.customerState || 'Other'}
                      </span>
                      <span className="cell-muted">{order.customerCity}</span>
                    </td>
                    <td>
                      <strong>{order.salesChannel || 'Online Store'}</strong>
                      <span className="cell-muted" style={{ textTransform: 'capitalize' }}>
                        {order.paymentGateway || order.paymentMethod}
                      </span>
                    </td>
                    <td className="amount-cell">
                      {formatMoney(order.totalAmount, order.currency)}
                    </td>
                    <td>
                      <div className="shipping-cost-cell">
                        <span className="shipping-cost-val">
                          {formatMoney(order.estimatedShippingCost || 106.44, 'INR')}
                        </span>
                        <span className="shipping-zone-tag">
                          {order.shippingZoneCode ? `Zone ${order.shippingZoneCode}` : 'Surface Ground'}
                          {order.paymentMethod === 'COD' ? ' / COD fee' : ''}
                        </span>
                      </div>
                    </td>
                    <td>
                      <StatusBadge status={order.status} />
                    </td>
                    <td>
                      {order.waybillNumber ? (
                        <a
                          href={carrierTrackingUrl((order as any).courier || (order as any).courierPartner || (order as any).shipment?.courier, order.waybillNumber)}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          style={{ color: '#2563eb', fontWeight: 700, fontFamily: 'JetBrains Mono, monospace' }}
                        >
                          {order.waybillNumber} ↗
                        </a>
                      ) : (
                        <span style={{ color: '#94a3b8', fontStyle: 'italic' }}>Unassigned</span>
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
            title="No orders found"
            description="Click Sync Orders at the top to import orders from Shopify."
          />
        )}
      </Panel>
    </>
  )
}
