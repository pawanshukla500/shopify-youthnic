import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, apiError, getDashboardStats } from '../api'
import { formatDate, formatMoney } from '../lib'
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

export function Dashboard() {
  useDocumentTitle('Dashboard')
  const { user } = useAuth()
  const toast = useToast()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const { data: stats, isLoading, isError, error, refetch, isFetching } = useQuery<DashboardStats>({
    queryKey: ['dashboard-stats'],
    queryFn: getDashboardStats,
    refetchInterval: 30000,
  })

  // Quick Shipping Rate Estimator state
  const [calcPincode, setCalcPincode] = useState('400001')
  const [calcWeight, setCalcWeight] = useState(500)
  const [calcMode, setCalcMode] = useState<'Pre-paid' | 'COD'>('Pre-paid')
  const [calcResult, setCalcResult] = useState<any | null>(null)
  const [calcLoading, setCalcLoading] = useState(false)

  const handleEstimate = async () => {
    if (!calcPincode || calcPincode.length < 6) {
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
          destinationPincode: calcPincode,
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

  // Sync mutations
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
          ? `Orders synced · ${data?.syncedCount ?? 0} updated, ${data?.dispatchedCount ?? 0} auto-dispatched.`
          : type === 'tracking'
          ? `Delhivery tracking synced · ${data?.updatedCount ?? 0} shipments updated.`
          : 'Shopify webhooks registered successfully.')
      toast.toast('success', message)
      await queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] })
      await queryClient.invalidateQueries({ queryKey: ['orders'] })
      await queryClient.invalidateQueries({ queryKey: ['payment-summary'] })
    },
    onError: (err) => toast.toast('error', apiError(err)),
  })

  const today = new Date()
  const eyebrow = today.toLocaleDateString('en-IN', {
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
    return <ErrorBox message={apiError(error)} />
  }

  const kpis = stats?.kpis
  const recon = stats?.reconciliation
  const funnel = stats?.funnel
  const topStates = stats?.topStates ?? []
  const actionItems = stats?.actionItems ?? []
  const recentOrders = stats?.recentOrders ?? []

  // Revenue proportions for segmented bar
  const totalRev = kpis?.totalRevenue || 1
  const gokwikPct = Math.round(((recon?.gokwikPrepaid.totalAmount || 0) / totalRev) * 100)
  const codPct = Math.round(((recon?.delhiveryCod.totalAmount || 0) / totalRev) * 100)
  const manualPct = Math.round(((recon?.manualPrepaid.totalAmount || 0) / totalRev) * 100)
  const phonepePct = Math.round(((recon?.phonepePrepaid.totalAmount || 0) / totalRev) * 100)

  return (
    <>
      {/* ─── Page Intro & Real-time Sync Controls ────────────────── */}
      <PageIntro
        eyebrow={eyebrow}
        title={`${timeGreeting}, ${operatorFirstName}.`}
        description="Comprehensive real-time command center for Shopify orders, Delhivery logistics, and 3-way money receipt reconciliation."
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

      {/* ─── Operational Attention Items (Alert Bar) ──────────────── */}
      {actionItems.length > 0 && (
        <div className="action-center">
          <div className="action-center-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span className="live-dot" />
              <strong style={{ fontSize: '11px', letterSpacing: '0.06em', textTransform: 'uppercase', color: '#64748b' }}>
                Priority Action Center · {actionItems.length} Attention Items
              </strong>
            </div>
            <span style={{ fontSize: '11px', color: '#94a3b8' }}>
              Action required to meet fulfillment SLAs and safeguard cash flow
            </span>
          </div>

          {actionItems.map((item) => {
            let iconName: 'zap' | 'alert' | 'truck' | 'shield' | 'clock' = 'alert'
            if (item.id.includes('prepaid')) iconName = 'zap'
            else if (item.id.includes('sla') || item.id.includes('delayed')) iconName = 'clock'
            else if (item.id.includes('dispatch') || item.id.includes('manifest')) iconName = 'truck'
            else if (item.id.includes('ndr')) iconName = 'alert'
            else if (item.id.includes('unverified') || item.id.includes('payment')) iconName = 'shield'

            return (
              <div className={`alert-card ${item.priority}`} key={item.id}>
                <div className="alert-card-left">
                  <div className={`alert-icon-wrap ${item.priority}`}>
                    <Icon name={iconName} size={16} />
                  </div>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '2px', flexWrap: 'wrap' }}>
                      <span className="alert-badge">{item.category}</span>
                      <h4 className="alert-title">{item.title}</h4>
                    </div>
                    <p className="alert-desc">{item.description}</p>
                  </div>
                </div>
                <button
                  className="alert-btn"
                  onClick={() => {
                    if (item.filterParam.includes('returns')) {
                      navigate('/returns')
                    } else {
                      navigate(`/orders?${item.filterParam}`)
                    }
                  }}
                >
                  <span>{item.actionText}</span>
                  <Icon name="arrow" size={13} />
                </button>
              </div>
            )
          })}
        </div>
      )}

      {/* ─── 6 Key Executive & Operational KPIs ────────────────────── */}
      <div className="dash-kpis">
        {/* KPI 1: Gross Revenue */}
        <div className="dash-kpi-card">
          <div className="dash-kpi-top">
            <span className="dash-kpi-label">Gross Revenue</span>
            <div className="dash-kpi-icon revenue">
              <Icon name="dollar" size={18} />
            </div>
          </div>
          <h3 className="dash-kpi-val">{formatMoney(kpis?.totalRevenue ?? 0, 'INR')}</h3>
          <div className="dash-kpi-sub">
            <span className="dash-kpi-tag green">AOV {formatMoney(kpis?.averageOrderValue ?? 0, 'INR')}</span>
            <span>across all sales</span>
          </div>
        </div>

        {/* KPI 2: Total Orders & Payment Split */}
        <div className="dash-kpi-card">
          <div className="dash-kpi-top">
            <span className="dash-kpi-label">Total Orders</span>
            <div className="dash-kpi-icon orders">
              <Icon name="box" size={18} />
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
              <Icon name="truck" size={18} />
            </div>
          </div>
          <h3 className="dash-kpi-val">{kpis?.readyToDispatch ?? 0}</h3>
          <div className="dash-kpi-sub">
            <span className="dash-kpi-tag amber">Action Required</span>
            <span>AWB manifest pending</span>
          </div>
        </div>

        {/* KPI 4: Total AWB Logistics Freight Cost */}
        <div
          className="dash-kpi-card"
          style={{ cursor: 'pointer' }}
          onClick={() => navigate('/orders')}
        >
          <div className="dash-kpi-top">
            <span className="dash-kpi-label">AWB Logistics Cost</span>
            <div className="dash-kpi-icon transit">
              <Icon name="truck" size={18} />
            </div>
          </div>
          <h3 className="dash-kpi-val">
            {formatMoney(kpis?.totalEstimatedLogisticsCost ?? 850, 'INR')}
          </h3>
          <div className="dash-kpi-sub">
            <span className="dash-kpi-tag blue">All AWBs</span>
            <span>Estimated freight & COD</span>
          </div>
        </div>


        {/* KPI 5: Delivered & Success Rate */}
        <div
          className="dash-kpi-card"
          style={{ cursor: 'pointer' }}
          onClick={() => navigate('/orders?status=DELIVERED')}
        >
          <div className="dash-kpi-top">
            <span className="dash-kpi-label">Delivered Success</span>
            <div className="dash-kpi-icon delivered">
              <Icon name="check" size={18} />
            </div>
          </div>
          <h3 className="dash-kpi-val">{kpis?.deliveredCount ?? 0}</h3>
          <div className="dash-kpi-sub">
            <span className="dash-kpi-tag green">Complete</span>
            <span>Confirmed deliveries</span>
          </div>
        </div>

        {/* KPI 6: Return & RTO Index */}
        <div
          className="dash-kpi-card"
          style={{ cursor: 'pointer' }}
          onClick={() => navigate('/returns')}
        >
          <div className="dash-kpi-top">
            <span className="dash-kpi-label">Return & RTO Rate</span>
            <div className="dash-kpi-icon returns">
              <Icon name="return" size={18} />
            </div>
          </div>
          <h3 className="dash-kpi-val">{kpis?.totalReturnsCount ?? 0}</h3>
          <div className="dash-kpi-sub">
            <span className="dash-kpi-tag purple">
              {kpis?.returnRate ? `${kpis.returnRate.toFixed(1)}%` : '0.0%'} RTO
            </span>
            <span>Reverse pickups</span>
          </div>
        </div>
      </div>

      {/* ─── Interactive 5-Stage Fulfillment Funnel Pipeline ───────── */}
      <Panel className="funnel-panel">
        <PanelHeading
          eyebrow="Lifecycle Monitoring"
          title="Fulfillment & Dispatch Pipeline"
          action={
            <Link to="/orders" className="text-link">
              View full order table <Icon name="arrow" size={14} />
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

          {/* Stage 3: Delhivery In-Transit */}
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
            <h4 className="funnel-title">Delhivery In-Transit</h4>
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
            <h4 className="funnel-title">Final Mile Delivery</h4>
            <div className="funnel-breakdown">
              <span>Delivered: <strong>{funnel?.finalMile.delivered ?? 0}</strong></span>
              <span>Delivery Success: <strong>{kpis?.deliveredCount ? '100%' : '0%'}</strong></span>
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
            <h4 className="funnel-title">NDR & Returns (RVP)</h4>
            <div className="funnel-breakdown">
              <span>Failed / NDR: <strong>{funnel?.finalMile.failedDelivery ?? 0}</strong></span>
              <span>Reverse Pickup: <strong>{funnel?.returns.requested ?? 0}</strong></span>
            </div>
          </div>
        </div>
      </Panel>

      {/* ─── 3-Way Money Receipt & Settlement Hub ─────────────────── */}
      <Panel style={{ marginBottom: '22px' }}>
        <PanelHeading
          eyebrow="Cash Flow & Settlement"
          title="3-Way Revenue & Money Receipt Reconciliation"
          action={
            <Link to="/orders" className="text-link">
              Filter by gateway <Icon name="arrow" size={14} />
            </Link>
          }
        />

        {/* Visual Revenue Split Bar */}
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
              style={{ width: `${phonepePct}%`, background: '#9333ea' }}
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
              <span className="split-legend-dot" style={{ background: '#9333ea' }} />
              <span>PhonePe PG ({phonepePct}%)</span>
            </div>
          </div>
        </div>

        {/* 3 Detailed Reconciliation Cards */}
        <div className="reconciliation-grid">
          {/* Card 1: Delhivery COD */}
          <div className="recon-card cod">
            <div>
              <div className="recon-header">
                <span className="recon-badge cod">Delhivery COD</span>
                <span style={{ fontSize: '10px', color: '#b45309', fontWeight: 700 }}>
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
                <Link to="/orders?gateway=cod" className="text-link" style={{ fontSize: '10px' }}>
                  Inspect →
                </Link>
              </div>
            </div>
          </div>

          {/* Card 2: GoKwik Prepaid */}
          <div className="recon-card gokwik">
            <div>
              <div className="recon-header">
                <span className="recon-badge gokwik">GoKwik Prepaid</span>
                <span style={{ fontSize: '10px', color: '#1d4ed8', fontWeight: 700 }}>
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
                  <span>Channel Source:</span>
                  <strong>Youthnic &lt;&gt; Gokwik</strong>
                </div>
              </div>
              <div className="recon-footer">
                <span>Cycle: {recon?.gokwikPrepaid.payoutSchedule}</span>
                <Link to="/orders?gateway=gokwik" className="text-link" style={{ fontSize: '10px' }}>
                  Inspect →
                </Link>
              </div>
            </div>
          </div>

          {/* Card 3: PhonePe Prepaid */}
          <div className="recon-card phonepe">
            <div>
              <div className="recon-header">
                <span className="recon-badge phonepe">PhonePe PG</span>
                <span style={{ fontSize: '10px', color: '#6d28d9', fontWeight: 700 }}>
                  {recon?.phonepePrepaid.orderCount ?? 0} Orders
                </span>
              </div>
              <h4 className="recon-title">Direct Payment Gateway</h4>
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
                  <span>Channel Source:</span>
                  <strong>PhonePe UPI / Cards</strong>
                </div>
              </div>
              <div className="recon-footer">
                <span>Cycle: {recon?.phonepePrepaid.payoutSchedule}</span>
                <Link to="/orders?gateway=phonepe" className="text-link" style={{ fontSize: '10px' }}>
                  Inspect →
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
              <span className="subtle-label">
                Origin: Surat, Gujarat ({stats?.delhiveryStatus?.originPincode || '395002'})
              </span>
            }
          />
          <div style={{ display: 'grid', gap: '8px' }}>
            {topStates.length > 0 ? (
              topStates.map((item) => (
                <div className="state-item" key={item.state}>
                  <div className="state-left">
                    <Icon name="pin" size={14} />
                    <span>{item.state}</span>
                  </div>
                  <div className="state-bar">
                    <div
                      className="state-bar-fill"
                      style={{ width: `${Math.min(100, item.percentage * 2.2)}%` }}
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
              <span className="subtle-label">
                {stats?.delhiveryStatus?.tokenConfigured ? 'API Connected' : 'Rate Matrix'}
              </span>
            }
          />
          <p style={{ fontSize: '11px', color: '#64748b', margin: '-10px 0 14px' }}>
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
                <label>Mode</label>
                <select
                  value={calcMode}
                  onChange={(e) => setCalcMode(e.target.value as 'Pre-paid' | 'COD')}
                >
                  <option value="Pre-paid">Pre-paid</option>
                  <option value="COD">COD</option>
                </select>
              </div>
              <button className="calc-btn" disabled={calcLoading} onClick={handleEstimate}>
                {calcLoading ? '...' : 'Estimate'}
              </button>
            </div>

            {calcResult && (
              <div className="calc-result-box">
                <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 800, fontSize: '13px', marginBottom: '6px' }}>
                  <span>Total Estimated Freight:</span>
                  <span>{formatMoney(calcResult?.total_amount ?? calcResult?.rate ?? 85, 'INR')}</span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '6px', fontSize: '10px' }}>
                  <div>Base: <strong>{formatMoney(calcResult?.charges?.base ?? 60, 'INR')}</strong></div>
                  <div>COD Fee: <strong>{calcMode === 'COD' ? '₹38.00' : '₹0.00'}</strong></div>
                  <div>GST: <strong>18% Included</strong></div>
                </div>
              </div>
            )}
          </div>
        </Panel>
      </div>

      {/* ─── Live Recent Orders Stream ─────────────────────────────── */}
      <Panel className="recent-panel">
        <PanelHeading
          eyebrow="Real-Time Feed"
          title="Recent Orders & Dispatch Status"
          action={
            <Link to="/orders" className="text-link">
              View all orders <Icon name="arrow" size={14} />
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
                  <th>State</th>
                  <th>Channel & Gateway</th>
                  <th>Order Amount</th>
                  <th>AWB Shipping Cost</th>
                  <th>Status</th>
                  <th>Delhivery AWB</th>
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
                          {order.paymentMethod === 'COD' ? ' · COD fee' : ''}
                        </span>
                      </div>
                    </td>
                    <td>
                      <StatusBadge status={order.status} />
                    </td>
                    <td className="mono">
                      {order.waybillNumber ? (
                        <a
                          href={`https://www.delhivery.com/track/package/${order.waybillNumber}`}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          style={{ color: '#2563eb', fontWeight: 700 }}
                        >
                          {order.waybillNumber} ↗
                        </a>
                      ) : (
                        <span style={{ color: '#94a3b8' }}>Unassigned</span>
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

