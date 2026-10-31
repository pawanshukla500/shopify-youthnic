import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getAnalyticsReport, distributeAnalyticsReport, getDistributionHistory } from '../api'
import { formatMoney } from '../lib'
import { ErrorBox, Icon, LoadingState, PageIntro, Panel, PanelHeading, useDocumentTitle, useToast } from '../components/UI'
import type { CustomerAccountItem } from '../types'

type ActiveTab = 'monthly' | 'courier' | 'state' | 'accounts' | 'distribution'

export function Analytics() {
  useDocumentTitle('Reports & Analytics')
  const toast = useToast()
  const queryClient = useQueryClient()
  const [activeTab, setActiveTab] = useState<ActiveTab>('monthly')
  const [stateSearch, setStateSearch] = useState('')

  // Account Strategist Filters
  const [accountSearch, setAccountSearch] = useState('')
  const [accountSegmentFilter, setAccountSegmentFilter] = useState<string>('ALL')

  // Report Distribution Form State
  const [distRecipient, setDistRecipient] = useState('accounts@youthnic.com')
  const [distRecipientName, setDistRecipientName] = useState('Accounts & Finance')
  const [distReportType, setDistReportType] = useState<
    'EXECUTIVE_PL_DIGEST' | 'CUSTOMER_ACCOUNTS_DIGEST' | 'TERRITORY_LOGISTICS_DIGEST'
  >('EXECUTIVE_PL_DIGEST')
  const [distNotes, setDistNotes] = useState('')
  const [previewLogHtml, setPreviewLogHtml] = useState<string | null>(null)

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['analytics-report'],
    queryFn: getAnalyticsReport,
    staleTime: 60_000,
  })

  const { data: historyData, refetch: refetchHistory } = useQuery({
    queryKey: ['distribution-history'],
    queryFn: () => getDistributionHistory(20),
    enabled: activeTab === 'distribution',
    staleTime: 15_000,
  })

  const distributeMutation = useMutation({
    mutationFn: distributeAnalyticsReport,
    onSuccess: (res) => {
      toast.toast('success', res.message || 'Report distributed successfully!')
      queryClient.invalidateQueries({ queryKey: ['distribution-history'] })
      queryClient.invalidateQueries({ queryKey: ['analytics-report'] })
    },
    onError: (err: any) => {
      toast.toast('error', err.message || 'Failed to distribute report')
    },
  })

  // Filtered states for Geographic tab
  const filteredStates = useMemo(() => {
    const list = data?.stateReport ?? []
    if (!stateSearch.trim()) return list
    const q = stateSearch.toLowerCase().trim()
    return list.filter(
      (s) =>
        s.state.toLowerCase().includes(q) ||
        s.topCities.some((c) => c.toLowerCase().includes(q))
    )
  }, [data?.stateReport, stateSearch])

  // Filtered accounts for Account Strategist tab
  const filteredAccounts = useMemo(() => {
    const list = data?.accountStrategist?.topAccounts ?? []
    let result = list

    if (accountSegmentFilter !== 'ALL') {
      result = result.filter((a) => a.segment === accountSegmentFilter)
    }

    if (accountSearch.trim()) {
      const q = accountSearch.toLowerCase().trim()
      result = result.filter(
        (a) =>
          a.name.toLowerCase().includes(q) ||
          a.phone.includes(q) ||
          (a.email && a.email.toLowerCase().includes(q)) ||
          a.city.toLowerCase().includes(q) ||
          a.state.toLowerCase().includes(q)
      )
    }

    return result
  }, [data?.accountStrategist?.topAccounts, accountSegmentFilter, accountSearch])

  // Monthly summary row
  const monthlySummary = useMemo(() => {
    const list = data?.monthlyReport ?? []
    if (!list.length) return null

    const totalOrders = list.reduce((sum, m) => sum + m.noOfOrders, 0)
    const prepaidCount = list.reduce((sum, m) => sum + m.prepaidCount, 0)
    const grossAmount = list.reduce((sum, m) => sum + m.grossAmount, 0)
    const grossQty = list.reduce((sum, m) => sum + m.grossQty, 0)
    const rtoCancelAmount = list.reduce((sum, m) => sum + m.rtoCancelAmount, 0)
    const rtoCancelQty = list.reduce((sum, m) => sum + m.rtoCancelQty, 0)
    const sellerCancelAmount = list.reduce((sum, m) => sum + m.sellerCancelAmount, 0)
    const sellerCancelQty = list.reduce((sum, m) => sum + m.sellerCancelQty, 0)
    const forwardSalesAmount = list.reduce((sum, m) => sum + m.forwardSalesAmount, 0)
    const forwardSalesQty = list.reduce((sum, m) => sum + m.forwardSalesQty, 0)
    const shippingCostF = list.reduce((sum, m) => sum + m.shippingCostF, 0)
    const shippingCostR = list.reduce((sum, m) => sum + m.shippingCostR, 0)
    const codCollectionFee = list.reduce((sum, m) => sum + m.codCollectionFee, 0)
    const paymentGatewayFee = list.reduce((sum, m) => sum + m.paymentGatewayFee, 0)
    const receivedPayment = list.reduce((sum, m) => sum + m.receivedPayment, 0)

    return {
      month: 'TOTAL',
      monthKey: 'all',
      noOfOrders: totalOrders,
      prepaidCount,
      prepaidPercent: totalOrders > 0 ? Math.round((prepaidCount / totalOrders) * 1000) / 10 : 0,
      grossAmount,
      grossQty,
      rtoCancelAmount,
      rtoCancelQty,
      sellerCancelAmount,
      sellerCancelQty,
      forwardSalesAmount,
      forwardSalesQty,
      shippingCostF,
      shippingCostR,
      codCollectionFee,
      paymentGatewayFee,
      receivedPayment,
    }
  }, [data?.monthlyReport])

  // Courier summary row
  const courierSummary = useMemo(() => {
    const list = data?.courierReport ?? []
    if (!list.length) return null

    const totalOrders = list.reduce((sum, c) => sum + c.totalOrders, 0)
    const totalCost = list.reduce((sum, c) => sum + c.totalCost, 0)
    const totalRtoOrders = list.reduce((sum, c) => sum + c.totalRtoOrders, 0)
    const avgPerOrderAmount = totalOrders > 0 ? Math.round((totalCost / totalOrders) * 100) / 100 : 0
    const rtoPercent = totalOrders > 0 ? Math.round((totalRtoOrders / totalOrders) * 1000) / 10 : 0

    return {
      courierName: 'ALL COURIERS TOTAL',
      totalOrders,
      totalCost,
      totalRtoOrders,
      avgPerOrderAmount,
      rtoPercent,
    }
  }, [data?.courierReport])

  // CSV Exporters
  const exportMonthlyCsv = () => {
    const list = data?.monthlyReport ?? []
    if (!list.length) return

    const headers = [
      'Month',
      'No Of Orders',
      'Prepaid Order Count Only',
      'Prepaid %',
      'Gross (Amount)',
      'Gross (QTY)',
      'RTO, Cancel & RVP (Amount)',
      'RTO RVP (QTY)',
      'Cancel By Seller (Amount)',
      'Cancel By Seller (Qty)',
      'Forward Sales (Amount) [A]',
      'Forward Sales (Qty)',
      'Shipping Cost-(F) [B]',
      'Shipping Cost-(R) [C]',
      'COD-Collection Fees [D]',
      'Payment Gateway Fee Only For Prepaid Orders [E]',
      'Received Payment [F=A-E]',
    ]

    const rows = list.map((m) => [
      `"${m.month}"`,
      m.noOfOrders,
      m.prepaidCount,
      `${m.prepaidPercent}%`,
      m.grossAmount.toFixed(2),
      m.grossQty,
      m.rtoCancelAmount.toFixed(2),
      m.rtoCancelQty,
      m.sellerCancelAmount.toFixed(2),
      m.sellerCancelQty,
      m.forwardSalesAmount.toFixed(2),
      m.forwardSalesQty,
      m.shippingCostF.toFixed(2),
      m.shippingCostR.toFixed(2),
      m.codCollectionFee.toFixed(2),
      m.paymentGatewayFee.toFixed(2),
      m.receivedPayment.toFixed(2),
    ])

    if (monthlySummary) {
      rows.push([
        '"TOTAL"',
        monthlySummary.noOfOrders,
        monthlySummary.prepaidCount,
        `${monthlySummary.prepaidPercent}%`,
        monthlySummary.grossAmount.toFixed(2),
        monthlySummary.grossQty,
        monthlySummary.rtoCancelAmount.toFixed(2),
        monthlySummary.rtoCancelQty,
        monthlySummary.sellerCancelAmount.toFixed(2),
        monthlySummary.sellerCancelQty,
        monthlySummary.forwardSalesAmount.toFixed(2),
        monthlySummary.forwardSalesQty,
        monthlySummary.shippingCostF.toFixed(2),
        monthlySummary.shippingCostR.toFixed(2),
        monthlySummary.codCollectionFee.toFixed(2),
        monthlySummary.paymentGatewayFee.toFixed(2),
        monthlySummary.receivedPayment.toFixed(2),
      ])
    }

    const csvContent = '\uFEFF' + [headers.join(','), ...rows.map((r) => r.join(','))].join('\r\n')
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.setAttribute('download', `youthnic_monthly_financial_report_${new Date().toISOString().slice(0, 10)}.csv`)
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
    toast.toast('success', 'Exported Monthly Financial Report to CSV!')
  }

  const exportCourierCsv = () => {
    const list = data?.courierReport ?? []
    if (!list.length) return

    const headers = ['Courier Name', 'Total Orders', 'Total Cost (INR)', 'Total RTO Orders', 'Average Per Order Amount', 'RTO %']
    const rows = list.map((c) => [
      `"${c.courierName}"`,
      c.totalOrders,
      c.totalCost.toFixed(2),
      c.totalRtoOrders,
      c.avgPerOrderAmount.toFixed(2),
      `${c.rtoPercent}%`,
    ])

    if (courierSummary) {
      rows.push([
        '"ALL COURIERS TOTAL"',
        courierSummary.totalOrders,
        courierSummary.totalCost.toFixed(2),
        courierSummary.totalRtoOrders,
        courierSummary.avgPerOrderAmount.toFixed(2),
        `${courierSummary.rtoPercent}%`,
      ])
    }

    const csvContent = '\uFEFF' + [headers.join(','), ...rows.map((r) => r.join(','))].join('\r\n')
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.setAttribute('download', `youthnic_courier_performance_report_${new Date().toISOString().slice(0, 10)}.csv`)
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
    toast.toast('success', 'Exported Courier Performance Report to CSV!')
  }

  const exportStateCsv = () => {
    const list = data?.stateReport ?? []
    if (!list.length) return

    const headers = ['State', 'Total Orders', '% of Total', 'Gross Revenue (INR)', 'Prepaid Orders', 'COD Orders', 'Prepaid %', 'Cities Count', 'Top Cities', 'Delivered Orders', 'RTO Orders', 'RTO %']
    const rows = list.map((s) => [
      `"${s.state}"`,
      s.orderCount,
      `${s.percentage}%`,
      s.grossRevenue.toFixed(2),
      s.prepaidCount,
      s.codCount,
      `${s.prepaidPercent}%`,
      s.citiesCount,
      `"${s.topCities.join(', ')}"`,
      s.deliveredCount,
      s.rtoCount,
      `${s.rtoRate}%`,
    ])

    const csvContent = '\uFEFF' + [headers.join(','), ...rows.map((r) => r.join(','))].join('\r\n')
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.setAttribute('download', `youthnic_state_distribution_report_${new Date().toISOString().slice(0, 10)}.csv`)
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
    toast.toast('success', 'Exported State Distribution Report to CSV!')
  }

  const exportAccountsCsv = () => {
    const list = data?.accountStrategist?.topAccounts ?? []
    if (!list.length) return

    const headers = ['Phone', 'Customer Name', 'Email', 'City', 'State', 'Orders', 'Delivered', 'RTO', 'Lifetime GMV', 'Health Score', 'RFM Cohort', 'Strategic Play']
    const rows = list.map((a) => [
      `"${a.phone}"`,
      `"${a.name}"`,
      `"${a.email || ''}"`,
      `"${a.city}"`,
      `"${a.state}"`,
      a.orderCount,
      a.deliveredCount,
      a.rtoCount,
      a.lifetimeGross.toFixed(2),
      a.healthScore,
      a.segment,
      `"${a.recommendedPlay}"`,
    ])

    const csvContent = '\uFEFF' + [headers.join(','), ...rows.map((r) => r.join(','))].join('\r\n')
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.setAttribute('download', `youthnic_customer_accounts_rfm_${new Date().toISOString().slice(0, 10)}.csv`)
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
    toast.toast('success', 'Exported Customer Accounts to CSV!')
  }

  if (isLoading) {
    return <LoadingState label="Computing financial P&L, customer accounts LTV, and distribution matrices…" />
  }

  if (isError) {
    return <ErrorBox message={error instanceof Error ? error.message : 'Failed to load analytics reports'} />
  }

  const kpis = data?.kpis
  const insights = data?.executiveInsights
  const accounts = data?.accountStrategist
  const schedule = data?.distributionSchedule

  return (
    <div className="analytics-page">
      <PageIntro
        eyebrow="Intelligence & Executive Reporting"
        title="Executive Analytics, Account Strategy & Report Distribution"
        description="P&L net margin tracking, customer lifetime value (LTV) cohorts, geographic logistics, and automated report distribution."
        action={
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <button
              type="button"
              className="btn-export"
              onClick={() => {
                if (activeTab === 'monthly') exportMonthlyCsv()
                else if (activeTab === 'courier') exportCourierCsv()
                else if (activeTab === 'state') exportStateCsv()
                else if (activeTab === 'accounts') exportAccountsCsv()
                else refetchHistory()
              }}
              title="Download active report as CSV"
            >
              <Icon name="download" size={15} />
              <span>
                Export {activeTab === 'monthly' ? 'P&L' : activeTab === 'courier' ? 'Courier' : activeTab === 'state' ? 'State' : activeTab === 'accounts' ? 'Accounts' : 'Logs'} CSV
              </span>
            </button>
            <button
              type="button"
              className="btn-export"
              style={{ background: '#10b981', color: '#ffffff', borderColor: '#059669' }}
              onClick={() => {
                refetch()
                if (activeTab === 'distribution') refetchHistory()
              }}
              disabled={isFetching}
              title="Refresh live metrics from database"
            >
              <Icon name="refresh" size={15} />
              <span>{isFetching ? 'Refreshing…' : 'Refresh'}</span>
            </button>
          </div>
        }
      />

      {/* KPI Cards Row */}
      {kpis && (
        <div className="kpi-grid" style={{ marginBottom: '24px' }}>
          <div className="kpi-card">
            <div className="kpi-label">Gross Order Volume</div>
            <div className="kpi-val">{kpis.totalOrders}</div>
            <span className="kpi-sub">{kpis.totalStatesCount} states delivery reach</span>
          </div>

          <div className="kpi-card">
            <div className="kpi-label">Gross Revenue (GMV)</div>
            <div className="kpi-val" style={{ color: '#059669' }}>{formatMoney(kpis.totalGrossRevenue, 'INR')}</div>
            <span className="kpi-sub">Across all payment channels</span>
          </div>

          <div className="kpi-card">
            <div className="kpi-label">Realized Net Margin</div>
            <div className="kpi-val" style={{ color: '#047857' }}>
              {insights ? formatMoney(insights.realizedNetMargin, 'INR') : '—'}
            </div>
            <span className="kpi-sub">
              {insights ? `${insights.netMarginPercent}% net margin after deductions` : 'Reconciled bank margin'}
            </span>
          </div>

          <div className="kpi-card">
            <div className="kpi-label">Delivery Success Rate</div>
            <div className="kpi-val" style={{ color: '#2563eb' }}>
              {insights ? `${insights.deliverySuccessRate}%` : `${kpis.prepaidRatio}%`}
            </div>
            <span className="kpi-sub">{kpis.totalPrepaidOrders} Prepaid · {kpis.totalCodOrders} COD</span>
          </div>

          <div className="kpi-card">
            <div className="kpi-label">Customer Accounts LTV</div>
            <div className="kpi-val" style={{ color: '#7c3aed' }}>
              {accounts ? formatMoney(accounts.avgCustomerLtv, 'INR') : '—'}
            </div>
            <span className="kpi-sub">
              {accounts ? `${accounts.repeatCustomerRate}% repeat buyer rate` : 'Customer lifetime value'}
            </span>
          </div>
        </div>
      )}

      {/* Navigation Tabs */}
      <div className="analytics-tabs-bar">
        <button
          type="button"
          className={`analytics-tab-btn ${activeTab === 'monthly' ? 'active' : ''}`}
          onClick={() => setActiveTab('monthly')}
        >
          <Icon name="grid" size={16} />
          <span>Monthly Financial P&L & Strategy</span>
        </button>

        <button
          type="button"
          className={`analytics-tab-btn ${activeTab === 'courier' ? 'active' : ''}`}
          onClick={() => setActiveTab('courier')}
        >
          <Icon name="route" size={16} />
          <span>Courier Logistics & Performance</span>
        </button>

        <button
          type="button"
          className={`analytics-tab-btn ${activeTab === 'state' ? 'active' : ''}`}
          onClick={() => setActiveTab('state')}
        >
          <Icon name="pin" size={16} />
          <span>Geographic Volume ({data?.stateReport?.length ?? 0})</span>
        </button>

        <button
          type="button"
          className={`analytics-tab-btn ${activeTab === 'accounts' ? 'active' : ''}`}
          onClick={() => setActiveTab('accounts')}
        >
          <Icon name="users" size={16} />
          <span>Account Strategist & Customer LTV ({accounts?.totalCustomerAccounts ?? 0})</span>
        </button>

        <button
          type="button"
          className={`analytics-tab-btn ${activeTab === 'distribution' ? 'active' : ''}`}
          onClick={() => setActiveTab('distribution')}
        >
          <Icon name="mail" size={16} />
          <span>Report Distribution & Audit Trail</span>
        </button>
      </div>

      {/* TAB 1: Monthly Financial Analysis (with Analytics Reporter Strategy) */}
      {activeTab === 'monthly' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          {/* Executive Analytics Reporter Strategic Decision Card */}
          {insights && (
            <Panel>
              <PanelHeading
                title="Executive Business Intelligence & Strategy (/agency-analytics-reporter)"
                eyebrow="Decision Support"
              />
              <div style={{ padding: '16px 20px', background: '#f8fafc', borderBottom: '1px solid #e2e8f0' }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '14px', marginBottom: '16px' }}>
                  <div style={{ background: '#ffffff', padding: '12px 14px', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
                    <div style={{ fontSize: '11px', color: '#64748b', fontWeight: 700 }}>AVERAGE ORDER VALUE</div>
                    <div style={{ fontSize: '18px', fontWeight: 800, color: '#0f172a', marginTop: '2px' }}>
                      {formatMoney(insights.averageOrderValue, 'INR')}
                    </div>
                  </div>
                  <div style={{ background: '#ffffff', padding: '12px 14px', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
                    <div style={{ fontSize: '11px', color: '#64748b', fontWeight: 700 }}>MOM REVENUE GROWTH</div>
                    <div style={{ fontSize: '18px', fontWeight: 800, color: insights.momGrowthRate >= 0 ? '#059669' : '#dc2626', marginTop: '2px' }}>
                      {insights.momGrowthRate >= 0 ? `+${insights.momGrowthRate}%` : `${insights.momGrowthRate}%`}
                    </div>
                  </div>
                  <div style={{ background: '#ffffff', padding: '12px 14px', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
                    <div style={{ fontSize: '11px', color: '#64748b', fontWeight: 700 }}>RTO LOSS RATIO</div>
                    <div style={{ fontSize: '18px', fontWeight: 800, color: '#d97706', marginTop: '2px' }}>
                      {insights.rtoLossRate}%
                    </div>
                  </div>
                  <div style={{ background: '#ffffff', padding: '12px 14px', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
                    <div style={{ fontSize: '11px', color: '#64748b', fontWeight: 700 }}>DATA QUALITY & AUDIT SCORE</div>
                    <div style={{ fontSize: '18px', fontWeight: 800, color: '#2563eb', marginTop: '2px' }}>
                      {insights.dataQualityScore}%
                    </div>
                  </div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {insights.strategicRecommendations.map((rec) => (
                    <div
                      key={rec.title}
                      style={{
                        background: '#ffffff',
                        borderLeft: `4px solid ${rec.priority === 'HIGH' ? '#dc2626' : rec.priority === 'MEDIUM' ? '#2563eb' : '#059669'}`,
                        padding: '12px 16px',
                        borderRadius: '0 8px 8px 0',
                        boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                        <span
                          style={{
                            fontSize: '10px',
                            fontWeight: 800,
                            padding: '2px 6px',
                            borderRadius: '4px',
                            color: '#ffffff',
                            background: rec.priority === 'HIGH' ? '#dc2626' : rec.priority === 'MEDIUM' ? '#2563eb' : '#059669',
                          }}
                        >
                          {rec.priority}
                        </span>
                        <strong style={{ fontSize: '13px', color: '#0f172a' }}>{rec.title}</strong>
                      </div>
                      <div style={{ fontSize: '12px', color: '#334155', lineHeight: 1.5 }}>
                        <strong>Action:</strong> {rec.action}
                      </div>
                      <div style={{ fontSize: '11.5px', color: '#64748b', marginTop: '2px' }}>
                        <em>Expected Impact:</em> {rec.impact}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </Panel>
          )}

          <Panel>
            <PanelHeading
              title="Monthly Financial & Operational P&L Analysis"
              eyebrow="Financial Breakdown"
              action={
                <button type="button" className="btn-table-action" onClick={exportMonthlyCsv}>
                  <Icon name="download" size={14} />
                  <span>Download Excel/CSV</span>
                </button>
              }
            />
            <div className="table-wrap report-table-wrap">
              <table className="data-table report-table">
                <thead>
                  <tr>
                    <th style={{ minWidth: '110px' }}>Month</th>
                    <th style={{ textAlign: 'right' }}>No Of Orders</th>
                    <th style={{ textAlign: 'right' }}>Prepaid Count</th>
                    <th style={{ textAlign: 'right' }}>Prepaid %</th>
                    <th style={{ textAlign: 'right' }}>Gross Amount</th>
                    <th style={{ textAlign: 'right' }}>Gross Qty</th>
                    <th style={{ textAlign: 'right' }}>RTO & Cancel (Amt)</th>
                    <th style={{ textAlign: 'right' }}>RTO Qty</th>
                    <th style={{ textAlign: 'right' }}>Seller Cancel (Amt)</th>
                    <th style={{ textAlign: 'right' }}>Seller Qty</th>
                    <th style={{ textAlign: 'right', background: 'rgba(37, 99, 235, 0.08)' }}>Forward Sales [A]</th>
                    <th style={{ textAlign: 'right' }}>Forward Qty</th>
                    <th style={{ textAlign: 'right' }}>Shipping Cost (F) [B]</th>
                    <th style={{ textAlign: 'right' }}>Shipping Cost (R) [C]</th>
                    <th style={{ textAlign: 'right' }}>COD Fee [D]</th>
                    <th style={{ textAlign: 'right' }}>Gateway Fee [E]</th>
                    <th style={{ textAlign: 'right', background: 'rgba(16, 185, 129, 0.12)', color: '#047857' }}>
                      Received Payment [F=A-E]
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data?.monthlyReport?.map((row) => (
                    <tr key={row.monthKey}>
                      <td><strong>{row.month}</strong></td>
                      <td className="mono" style={{ textAlign: 'right' }}>{row.noOfOrders}</td>
                      <td className="mono" style={{ textAlign: 'right' }}>{row.prepaidCount}</td>
                      <td className="mono" style={{ textAlign: 'right', color: '#2563eb', fontWeight: 700 }}>
                        {row.prepaidPercent}%
                      </td>
                      <td className="mono" style={{ textAlign: 'right' }}>{formatMoney(row.grossAmount, 'INR')}</td>
                      <td className="mono" style={{ textAlign: 'right' }}>{row.grossQty}</td>
                      <td className="mono" style={{ textAlign: 'right', color: row.rtoCancelAmount > 0 ? '#b91c1c' : '#64748b' }}>
                        {formatMoney(row.rtoCancelAmount, 'INR')}
                      </td>
                      <td className="mono" style={{ textAlign: 'right' }}>{row.rtoCancelQty}</td>
                      <td className="mono" style={{ textAlign: 'right' }}>{formatMoney(row.sellerCancelAmount, 'INR')}</td>
                      <td className="mono" style={{ textAlign: 'right' }}>{row.sellerCancelQty}</td>
                      <td className="mono" style={{ textAlign: 'right', fontWeight: 800, background: 'rgba(37, 99, 235, 0.04)' }}>
                        {formatMoney(row.forwardSalesAmount, 'INR')}
                      </td>
                      <td className="mono" style={{ textAlign: 'right' }}>{row.forwardSalesQty}</td>
                      <td className="mono" style={{ textAlign: 'right' }}>{formatMoney(row.shippingCostF, 'INR')}</td>
                      <td className="mono" style={{ textAlign: 'right' }}>{formatMoney(row.shippingCostR, 'INR')}</td>
                      <td className="mono" style={{ textAlign: 'right' }}>{formatMoney(row.codCollectionFee, 'INR')}</td>
                      <td className="mono" style={{ textAlign: 'right' }}>{formatMoney(row.paymentGatewayFee, 'INR')}</td>
                      <td className="mono" style={{ textAlign: 'right', fontWeight: 850, color: '#047857', background: 'rgba(16, 185, 129, 0.06)' }}>
                        {formatMoney(row.receivedPayment, 'INR')}
                      </td>
                    </tr>
                  ))}
                </tbody>
                {monthlySummary && (
                  <tfoot>
                    <tr className="report-summary-row">
                      <td><strong>TOTAL</strong></td>
                      <td className="mono" style={{ textAlign: 'right' }}><strong>{monthlySummary.noOfOrders}</strong></td>
                      <td className="mono" style={{ textAlign: 'right' }}><strong>{monthlySummary.prepaidCount}</strong></td>
                      <td className="mono" style={{ textAlign: 'right' }}><strong>{monthlySummary.prepaidPercent}%</strong></td>
                      <td className="mono" style={{ textAlign: 'right' }}><strong>{formatMoney(monthlySummary.grossAmount, 'INR')}</strong></td>
                      <td className="mono" style={{ textAlign: 'right' }}><strong>{monthlySummary.grossQty}</strong></td>
                      <td className="mono" style={{ textAlign: 'right' }}><strong>{formatMoney(monthlySummary.rtoCancelAmount, 'INR')}</strong></td>
                      <td className="mono" style={{ textAlign: 'right' }}><strong>{monthlySummary.rtoCancelQty}</strong></td>
                      <td className="mono" style={{ textAlign: 'right' }}><strong>{formatMoney(monthlySummary.sellerCancelAmount, 'INR')}</strong></td>
                      <td className="mono" style={{ textAlign: 'right' }}><strong>{monthlySummary.sellerCancelQty}</strong></td>
                      <td className="mono" style={{ textAlign: 'right' }}><strong>{formatMoney(monthlySummary.forwardSalesAmount, 'INR')}</strong></td>
                      <td className="mono" style={{ textAlign: 'right' }}><strong>{monthlySummary.forwardSalesQty}</strong></td>
                      <td className="mono" style={{ textAlign: 'right' }}><strong>{formatMoney(monthlySummary.shippingCostF, 'INR')}</strong></td>
                      <td className="mono" style={{ textAlign: 'right' }}><strong>{formatMoney(monthlySummary.shippingCostR, 'INR')}</strong></td>
                      <td className="mono" style={{ textAlign: 'right' }}><strong>{formatMoney(monthlySummary.codCollectionFee, 'INR')}</strong></td>
                      <td className="mono" style={{ textAlign: 'right' }}><strong>{formatMoney(monthlySummary.paymentGatewayFee, 'INR')}</strong></td>
                      <td className="mono" style={{ textAlign: 'right', color: '#047857' }}>
                        <strong>{formatMoney(monthlySummary.receivedPayment, 'INR')}</strong>
                      </td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
            <div className="report-formula-note">
              <span><strong>Formula Key:</strong> [A] Forward Sales = Gross Amount − RTO/Cancellations − Seller Cancellations · [B] Forward Shipping Cost · [C] Reverse/RTO Shipping · [D] COD Handling Fee · [E] Gateway MDR Fees · [F = A − E] Net Received Payout</span>
            </div>
          </Panel>
        </div>
      )}

      {/* TAB 2: Courier Performance Breakdown */}
      {activeTab === 'courier' && (
        <Panel>
          <PanelHeading
            title="Courier Logistics & RTO Performance"
            eyebrow="Logistics Audit"
            action={
              <button type="button" className="btn-table-action" onClick={exportCourierCsv}>
                <Icon name="download" size={14} />
                <span>Download Excel/CSV</span>
              </button>
            }
          />
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Courier Name</th>
                  <th style={{ textAlign: 'right' }}>Total Orders</th>
                  <th style={{ textAlign: 'right' }}>Total Freight Cost</th>
                  <th style={{ textAlign: 'right' }}>Total RTO Orders</th>
                  <th style={{ textAlign: 'right' }}>Average Per Order Amount</th>
                  <th style={{ textAlign: 'right' }}>RTO %</th>
                </tr>
              </thead>
              <tbody>
                {data?.courierReport?.map((c) => (
                  <tr key={c.courierName}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span className="courier-badge">{c.courierName}</span>
                      </div>
                    </td>
                    <td className="mono" style={{ textAlign: 'right', fontWeight: 700 }}>{c.totalOrders}</td>
                    <td className="mono" style={{ textAlign: 'right' }}>{formatMoney(c.totalCost, 'INR')}</td>
                    <td className="mono" style={{ textAlign: 'right', color: c.totalRtoOrders > 0 ? '#b91c1c' : '#64748b' }}>
                      {c.totalRtoOrders}
                    </td>
                    <td className="mono" style={{ textAlign: 'right' }}>{formatMoney(c.avgPerOrderAmount, 'INR')}</td>
                    <td className="mono" style={{ textAlign: 'right' }}>
                      <span className={`rto-rate-pill ${c.rtoPercent > 20 ? 'high' : c.rtoPercent > 10 ? 'medium' : 'low'}`}>
                        {c.rtoPercent}%
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
              {courierSummary && (
                <tfoot>
                  <tr className="report-summary-row">
                    <td><strong>TOTAL</strong></td>
                    <td className="mono" style={{ textAlign: 'right' }}><strong>{courierSummary.totalOrders}</strong></td>
                    <td className="mono" style={{ textAlign: 'right' }}><strong>{formatMoney(courierSummary.totalCost, 'INR')}</strong></td>
                    <td className="mono" style={{ textAlign: 'right' }}><strong>{courierSummary.totalRtoOrders}</strong></td>
                    <td className="mono" style={{ textAlign: 'right' }}><strong>{formatMoney(courierSummary.avgPerOrderAmount, 'INR')}</strong></td>
                    <td className="mono" style={{ textAlign: 'right' }}><strong>{courierSummary.rtoPercent}%</strong></td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </Panel>
      )}

      {/* TAB 3: State-wise Geographic Volume Breakdown */}
      {activeTab === 'state' && (
        <Panel>
          <PanelHeading
            title="State-wise Geographic Volume & Demand Distribution"
            eyebrow="Geographic Heatmap"
            action={
              <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                <input
                  type="text"
                  placeholder="Search state or city…"
                  className="table-search-input"
                  value={stateSearch}
                  onChange={(e) => setStateSearch(e.target.value)}
                />
                <button type="button" className="btn-table-action" onClick={exportStateCsv}>
                  <Icon name="download" size={14} />
                  <span>Download CSV</span>
                </button>
              </div>
            }
          />
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>State</th>
                  <th style={{ textAlign: 'right' }}>Total Orders</th>
                  <th style={{ minWidth: '140px' }}>Volume Share</th>
                  <th style={{ textAlign: 'right' }}>Gross Revenue</th>
                  <th style={{ textAlign: 'right' }}>Prepaid Orders</th>
                  <th style={{ textAlign: 'right' }}>COD Orders</th>
                  <th style={{ textAlign: 'right' }}>Prepaid %</th>
                  <th style={{ textAlign: 'right' }}>Unique Cities</th>
                  <th>Top Destination Hubs</th>
                  <th style={{ textAlign: 'right' }}>Delivered</th>
                </tr>
              </thead>
              <tbody>
                {filteredStates.map((s) => (
                  <tr key={s.state}>
                    <td>
                      <strong>{s.state}</strong>
                    </td>
                    <td className="mono" style={{ textAlign: 'right', fontWeight: 800 }}>
                      {s.orderCount}
                    </td>
                    <td>
                      <div className="volume-bar-container">
                        <div className="volume-bar" style={{ width: `${Math.min(100, s.percentage * 2.5)}%` }} />
                        <span className="volume-bar-label">{s.percentage}%</span>
                      </div>
                    </td>
                    <td className="mono" style={{ textAlign: 'right', fontWeight: 700 }}>
                      {formatMoney(s.grossRevenue, 'INR')}
                    </td>
                    <td className="mono" style={{ textAlign: 'right', color: '#2563eb' }}>
                      {s.prepaidCount}
                    </td>
                    <td className="mono" style={{ textAlign: 'right', color: '#d97706' }}>
                      {s.codCount}
                    </td>
                    <td className="mono" style={{ textAlign: 'right', fontWeight: 700 }}>
                      {s.prepaidPercent}%
                    </td>
                    <td className="mono" style={{ textAlign: 'right' }}>
                      {s.citiesCount}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                        {s.topCities.map((city) => (
                          <span key={city} className="city-pill">
                            {city}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="mono" style={{ textAlign: 'right', color: '#047857', fontWeight: 700 }}>
                      {s.deliveredCount}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {/* TAB 4: Account Strategist & Customer LTV (/agency-account-strategist) */}
      {activeTab === 'accounts' && accounts && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          {/* RFM Cohort Summary Cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '14px' }}>
            <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '10px', padding: '14px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '11px', fontWeight: 800, color: '#166534', textTransform: 'uppercase' }}>Champions</span>
                <span style={{ background: '#166534', color: '#fff', fontSize: '10px', fontWeight: 800, padding: '2px 6px', borderRadius: '4px' }}>
                  {accounts.rfmSummary.champions.count} ACCOUNTS
                </span>
              </div>
              <div style={{ fontSize: '18px', fontWeight: 800, color: '#166534', marginTop: '6px' }}>
                {formatMoney(accounts.rfmSummary.champions.totalRevenue, 'INR')}
              </div>
              <div style={{ fontSize: '11px', color: '#15803d', marginTop: '4px' }}>
                {accounts.rfmSummary.champions.description}
              </div>
              <div style={{ fontSize: '11px', color: '#0f172a', fontWeight: 600, marginTop: '8px', borderTop: '1px dashed #bbf7d0', paddingTop: '6px' }}>
                <em>Play:</em> {accounts.rfmSummary.champions.play}
              </div>
            </div>

            <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: '10px', padding: '14px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '11px', fontWeight: 800, color: '#1e40af', textTransform: 'uppercase' }}>Loyal Customers</span>
                <span style={{ background: '#1e40af', color: '#fff', fontSize: '10px', fontWeight: 800, padding: '2px 6px', borderRadius: '4px' }}>
                  {accounts.rfmSummary.loyal.count} ACCOUNTS
                </span>
              </div>
              <div style={{ fontSize: '18px', fontWeight: 800, color: '#1e40af', marginTop: '6px' }}>
                {formatMoney(accounts.rfmSummary.loyal.totalRevenue, 'INR')}
              </div>
              <div style={{ fontSize: '11px', color: '#1d4ed8', marginTop: '4px' }}>
                {accounts.rfmSummary.loyal.description}
              </div>
              <div style={{ fontSize: '11px', color: '#0f172a', fontWeight: 600, marginTop: '8px', borderTop: '1px dashed #bfdbfe', paddingTop: '6px' }}>
                <em>Play:</em> {accounts.rfmSummary.loyal.play}
              </div>
            </div>

            <div style={{ background: '#f5f3ff', border: '1px solid #ddd6fe', borderRadius: '10px', padding: '14px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '11px', fontWeight: 800, color: '#5b21b6', textTransform: 'uppercase' }}>Potential Loyalists</span>
                <span style={{ background: '#5b21b6', color: '#fff', fontSize: '10px', fontWeight: 800, padding: '2px 6px', borderRadius: '4px' }}>
                  {accounts.rfmSummary.potential.count} ACCOUNTS
                </span>
              </div>
              <div style={{ fontSize: '18px', fontWeight: 800, color: '#5b21b6', marginTop: '6px' }}>
                {formatMoney(accounts.rfmSummary.potential.totalRevenue, 'INR')}
              </div>
              <div style={{ fontSize: '11px', color: '#6d28d9', marginTop: '4px' }}>
                {accounts.rfmSummary.potential.description}
              </div>
              <div style={{ fontSize: '11px', color: '#0f172a', fontWeight: 600, marginTop: '8px', borderTop: '1px dashed #ddd6fe', paddingTop: '6px' }}>
                <em>Play:</em> {accounts.rfmSummary.potential.play}
              </div>
            </div>

            <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '10px', padding: '14px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '11px', fontWeight: 800, color: '#991b1b', textTransform: 'uppercase' }}>At Risk (RTO Flagged)</span>
                <span style={{ background: '#991b1b', color: '#fff', fontSize: '10px', fontWeight: 800, padding: '2px 6px', borderRadius: '4px' }}>
                  {accounts.rfmSummary.atRisk.count} ACCOUNTS
                </span>
              </div>
              <div style={{ fontSize: '18px', fontWeight: 800, color: '#991b1b', marginTop: '6px' }}>
                {formatMoney(accounts.rfmSummary.atRisk.totalRevenue, 'INR')}
              </div>
              <div style={{ fontSize: '11px', color: '#b91c1c', marginTop: '4px' }}>
                {accounts.rfmSummary.atRisk.description}
              </div>
              <div style={{ fontSize: '11px', color: '#0f172a', fontWeight: 600, marginTop: '8px', borderTop: '1px dashed #fecaca', paddingTop: '6px' }}>
                <em>Play:</em> {accounts.rfmSummary.atRisk.play}
              </div>
            </div>
          </div>

          {/* Top Accounts Table */}
          <Panel>
            <PanelHeading
              title="Customer Account Intelligence & Strategic Retention"
              eyebrow="Account Portfolio"
              action={
                <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                  <select
                    className="table-search-input"
                    style={{ width: 'auto' }}
                    value={accountSegmentFilter}
                    onChange={(e) => setAccountSegmentFilter(e.target.value)}
                  >
                    <option value="ALL">All Cohorts ({accounts.topAccounts.length})</option>
                    <option value="CHAMPION">Champions</option>
                    <option value="LOYAL">Loyal Customers</option>
                    <option value="POTENTIAL">Potential Loyalists</option>
                    <option value="AT_RISK">At Risk (RTO)</option>
                    <option value="CANNOT_LOSE">Cannot Lose Them</option>
                    <option value="NEW">New Customers</option>
                  </select>
                  <input
                    type="text"
                    placeholder="Search name, phone, city…"
                    className="table-search-input"
                    value={accountSearch}
                    onChange={(e) => setAccountSearch(e.target.value)}
                  />
                  <button type="button" className="btn-table-action" onClick={exportAccountsCsv}>
                    <Icon name="download" size={14} />
                    <span>Download CSV</span>
                  </button>
                </div>
              }
            />
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Customer Name & Contact</th>
                    <th>Location</th>
                    <th style={{ textAlign: 'center' }}>Orders (Del / RTO)</th>
                    <th style={{ textAlign: 'right' }}>Lifetime GMV</th>
                    <th style={{ textAlign: 'center' }}>Health</th>
                    <th>Cohort</th>
                    <th style={{ minWidth: '220px' }}>Account Strategy Play (/agency-account-strategist)</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredAccounts.map((a: CustomerAccountItem) => (
                    <tr key={a.phone}>
                      <td>
                        <div style={{ fontWeight: 700, color: '#0f172a' }}>{a.name}</div>
                        <div style={{ fontSize: '11px', color: '#64748b' }}>
                          <code>{a.phone}</code>
                          {a.email ? ` · ${a.email}` : ''}
                        </div>
                      </td>
                      <td>
                        <div style={{ fontSize: '12px', fontWeight: 600 }}>{a.city}</div>
                        <div style={{ fontSize: '11px', color: '#64748b' }}>{a.state}</div>
                      </td>
                      <td className="mono" style={{ textAlign: 'center' }}>
                        <strong>{a.orderCount}</strong>
                        <span style={{ fontSize: '11px', color: '#64748b' }}>
                          {' '}(<span style={{ color: '#047857' }}>{a.deliveredCount} del</span>
                          {a.rtoCount > 0 ? <span style={{ color: '#dc2626' }}>, {a.rtoCount} rto</span> : null})
                        </span>
                      </td>
                      <td className="mono" style={{ textAlign: 'right', fontWeight: 800, color: '#0f172a' }}>
                        {formatMoney(a.lifetimeGross, 'INR')}
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <span
                          style={{
                            display: 'inline-block',
                            padding: '3px 8px',
                            borderRadius: '12px',
                            fontSize: '10px',
                            fontWeight: 800,
                            background:
                              a.healthScore === 'GREEN' ? '#dcfce7' : a.healthScore === 'YELLOW' ? '#fef3c7' : '#fee2e2',
                            color:
                              a.healthScore === 'GREEN' ? '#15803d' : a.healthScore === 'YELLOW' ? '#b45309' : '#b91c1c',
                          }}
                        >
                          {a.healthScore}
                        </span>
                      </td>
                      <td>
                        <span
                          style={{
                            display: 'inline-block',
                            padding: '3px 8px',
                            borderRadius: '6px',
                            fontSize: '11px',
                            fontWeight: 700,
                            background: '#f1f5f9',
                            color: '#334155',
                          }}
                        >
                          {a.segment}
                        </span>
                      </td>
                      <td style={{ fontSize: '12px', color: '#1e293b' }}>
                        {a.recommendedPlay}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </div>
      )}

      {/* TAB 5: Report Distribution & Audit Trail (/agency-report-distribution-agent) */}
      {activeTab === 'distribution' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          {/* Automated Distribution Schedules */}
          {schedule && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '14px' }}>
              <div style={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '10px', padding: '16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '11px', fontWeight: 800, color: '#2563eb', textTransform: 'uppercase' }}>
                    DAILY TERRITORY SCHEDULE
                  </span>
                  <span style={{ background: '#dcfce7', color: '#15803d', fontSize: '10px', fontWeight: 800, padding: '2px 8px', borderRadius: '10px' }}>
                    {schedule.dailyReport.status}
                  </span>
                </div>
                <div style={{ fontSize: '16px', fontWeight: 800, color: '#0f172a', marginTop: '6px' }}>
                  {schedule.dailyReport.name}
                </div>
                <div style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>
                  <strong>Cadence:</strong> {schedule.dailyReport.humanSchedule} (<code>{schedule.dailyReport.cron}</code>)
                </div>
                <div style={{ fontSize: '12px', color: '#64748b', marginTop: '2px' }}>
                  <strong>Target Audience:</strong> {schedule.dailyReport.targetAudience}
                </div>
              </div>

              <div style={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '10px', padding: '16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '11px', fontWeight: 800, color: '#7c3aed', textTransform: 'uppercase' }}>
                    WEEKLY EXECUTIVE SCHEDULE
                  </span>
                  <span style={{ background: '#dcfce7', color: '#15803d', fontSize: '10px', fontWeight: 800, padding: '2px 8px', borderRadius: '10px' }}>
                    {schedule.weeklyReport.status}
                  </span>
                </div>
                <div style={{ fontSize: '16px', fontWeight: 800, color: '#0f172a', marginTop: '6px' }}>
                  {schedule.weeklyReport.name}
                </div>
                <div style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>
                  <strong>Cadence:</strong> {schedule.weeklyReport.humanSchedule} (<code>{schedule.weeklyReport.cron}</code>)
                </div>
                <div style={{ fontSize: '12px', color: '#64748b', marginTop: '2px' }}>
                  <strong>Target Audience:</strong> {schedule.weeklyReport.targetAudience}
                </div>
              </div>

              <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '10px', padding: '16px' }}>
                <div style={{ fontSize: '11px', fontWeight: 800, color: '#64748b', textTransform: 'uppercase' }}>
                  DISTRIBUTION AGENT AUDIT STATUS
                </div>
                <div style={{ fontSize: '20px', fontWeight: 900, color: '#0f172a', marginTop: '6px' }}>
                  {schedule.totalDistributionsCount} Dispatches Logged
                </div>
                <div style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>
                  Last run: {schedule.lastDistribution ? `${schedule.lastDistribution.recipient} (${new Date(schedule.lastDistribution.timestamp).toLocaleDateString()})` : 'Never'}
                </div>
              </div>
            </div>
          )}

          {/* On-Demand Report Distribution Form */}
          <Panel>
            <PanelHeading
              title="Manual & On-Demand Report Distribution"
              eyebrow="Instant Trigger"
            />
            <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '16px' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 700, color: '#334155', marginBottom: '6px' }}>
                    Recipient Email Address
                  </label>
                  <input
                    type="email"
                    className="table-search-input"
                    style={{ width: '100%' }}
                    value={distRecipient}
                    onChange={(e) => setDistRecipient(e.target.value)}
                    placeholder="e.g. accounts@youthnic.com"
                  />
                  <div style={{ display: 'flex', gap: '6px', marginTop: '6px' }}>
                    <button
                      type="button"
                      style={{ fontSize: '10px', padding: '2px 6px', borderRadius: '4px', border: '1px solid #cbd5e1', background: '#f8fafc', cursor: 'pointer' }}
                      onClick={() => {
                        setDistRecipient('accounts@youthnic.com')
                        setDistRecipientName('Finance & Accounts')
                      }}
                    >
                      Accounts
                    </button>
                    <button
                      type="button"
                      style={{ fontSize: '10px', padding: '2px 6px', borderRadius: '4px', border: '1px solid #cbd5e1', background: '#f8fafc', cursor: 'pointer' }}
                      onClick={() => {
                        setDistRecipient('management@youthnic.com')
                        setDistRecipientName('Executive Leadership')
                      }}
                    >
                      Leadership
                    </button>
                    <button
                      type="button"
                      style={{ fontSize: '10px', padding: '2px 6px', borderRadius: '4px', border: '1px solid #cbd5e1', background: '#f8fafc', cursor: 'pointer' }}
                      onClick={() => {
                        setDistRecipient('ops@youthnic.com')
                        setDistRecipientName('Operations Lead')
                      }}
                    >
                      Operations
                    </button>
                  </div>
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 700, color: '#334155', marginBottom: '6px' }}>
                    Recipient Name / Department
                  </label>
                  <input
                    type="text"
                    className="table-search-input"
                    style={{ width: '100%' }}
                    value={distRecipientName}
                    onChange={(e) => setDistRecipientName(e.target.value)}
                    placeholder="e.g. Finance & Accounts Desk"
                  />
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 700, color: '#334155', marginBottom: '6px' }}>
                    Report Package
                  </label>
                  <select
                    className="table-search-input"
                    style={{ width: '100%' }}
                    value={distReportType}
                    onChange={(e: any) => setDistReportType(e.target.value)}
                  >
                    <option value="EXECUTIVE_PL_DIGEST">Executive Business Intelligence & P&L Digest</option>
                    <option value="CUSTOMER_ACCOUNTS_DIGEST">Customer Accounts & RFM Expansion Analysis</option>
                    <option value="TERRITORY_LOGISTICS_DIGEST">Territory Distribution & Courier Logistics</option>
                  </select>
                </div>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 700, color: '#334155', marginBottom: '6px' }}>
                  Executive Context / Custom Notes (Optional)
                </label>
                <textarea
                  className="table-search-input"
                  style={{ width: '100%', minHeight: '60px', resize: 'vertical' }}
                  value={distNotes}
                  onChange={(e) => setDistNotes(e.target.value)}
                  placeholder="Add any strategic guidance or highlights for this report distribution run…"
                />
              </div>

              <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                <button
                  type="button"
                  className="btn-export"
                  style={{ background: '#2563eb', color: '#ffffff', borderColor: '#1d4ed8', padding: '10px 20px', fontWeight: 700 }}
                  disabled={distributeMutation.isPending || !distRecipient.trim()}
                  onClick={() => {
                    distributeMutation.mutate({
                      recipientEmail: distRecipient.trim(),
                      recipientName: distRecipientName.trim() || undefined,
                      reportType: distReportType,
                      notes: distNotes.trim() || undefined,
                    })
                  }}
                >
                  <Icon name="mail" size={15} />
                  <span>{distributeMutation.isPending ? 'Distributing Report…' : 'Send Report to Email Now'}</span>
                </button>

                <button
                  type="button"
                  className="btn-export"
                  style={{ background: '#f8fafc', color: '#334155', borderColor: '#cbd5e1' }}
                  disabled={distributeMutation.isPending}
                  onClick={() => {
                    distributeMutation.mutate({
                      recipientEmail: 'management@youthnic.com',
                      recipientName: 'Executive Team',
                      reportType: 'EXECUTIVE_PL_DIGEST',
                      notes: 'Manual trigger of scheduled weekly company-wide roll-up.',
                    })
                  }}
                >
                  <Icon name="refresh" size={14} />
                  <span>Trigger Scheduled Distribution Now</span>
                </button>
              </div>
            </div>
          </Panel>

          {/* Distribution History Audit Log Table */}
          <Panel>
            <PanelHeading
              title="Distribution Audit Trail & Compliance Log (/agency-report-distribution-agent)"
              eyebrow="Activity Ledger"
              action={
                <button type="button" className="btn-table-action" onClick={() => refetchHistory()}>
                  <Icon name="refresh" size={14} />
                  <span>Refresh Ledger</span>
                </button>
              }
            />
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Date & Timestamp</th>
                    <th>Recipient</th>
                    <th>Report Subject</th>
                    <th style={{ textAlign: 'center' }}>Delivery Status</th>
                    <th>Scope / Mode</th>
                  </tr>
                </thead>
                <tbody>
                  {(!historyData?.history || historyData.history.length === 0) ? (
                    <tr>
                      <td colSpan={5} style={{ textAlign: 'center', padding: '24px', color: '#64748b' }}>
                        No reports distributed yet. Click "Send Report to Email Now" above to trigger your first distribution.
                      </td>
                    </tr>
                  ) : (
                    historyData.history.map((log) => (
                      <tr key={log.id}>
                        <td className="mono" style={{ fontSize: '11.5px', color: '#334155' }}>
                          {new Date(log.sentAt || log.createdAt).toLocaleString()}
                        </td>
                        <td>
                          <div style={{ fontWeight: 700, color: '#0f172a' }}>{log.recipientName}</div>
                          <div style={{ fontSize: '11px', color: '#64748b' }}>{log.recipientEmail}</div>
                        </td>
                        <td style={{ fontSize: '12px', fontWeight: 600 }}>
                          {log.subject}
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          <span
                            style={{
                              display: 'inline-block',
                              padding: '3px 8px',
                              borderRadius: '12px',
                              fontSize: '10px',
                              fontWeight: 800,
                              background: log.status === 'SENT' ? '#dcfce7' : log.status === 'SIMULATED' ? '#eff6ff' : '#fee2e2',
                              color: log.status === 'SENT' ? '#15803d' : log.status === 'SIMULATED' ? '#1d4ed8' : '#b91c1c',
                            }}
                          >
                            {log.status}
                          </span>
                        </td>
                        <td style={{ fontSize: '11px', color: '#64748b' }}>
                          <code>{log.metadata?.reportType || 'EXECUTIVE_DIGEST'}</code>
                          {log.metadata?.mode ? ` · ${log.metadata.mode}` : ''}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </Panel>
        </div>
      )}

      {/* Modal to Preview Sent HTML if needed */}
      {previewLogHtml && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.5)',
            zIndex: 9999,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '20px',
          }}
          onClick={() => setPreviewLogHtml(null)}
        >
          <div
            style={{
              background: '#ffffff',
              borderRadius: '12px',
              maxWidth: '750px',
              width: '100%',
              maxHeight: '90vh',
              overflowY: 'auto',
              padding: '24px',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <h3 style={{ margin: 0 }}>Report HTML Preview</h3>
              <button type="button" onClick={() => setPreviewLogHtml(null)} style={{ border: 0, background: 'none', cursor: 'pointer' }}>
                <Icon name="close" size={18} />
              </button>
            </div>
            <div dangerouslySetInnerHTML={{ __html: previewLogHtml }} />
          </div>
        </div>
      )}
    </div>
  )
}
