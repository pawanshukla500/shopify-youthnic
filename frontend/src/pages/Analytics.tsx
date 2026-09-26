import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getAnalyticsReport } from '../api'
import { formatMoney } from '../lib'
import { ErrorBox, Icon, LoadingState, PageIntro, Panel, PanelHeading, useDocumentTitle, useToast } from '../components/UI'
import type { MonthlyReportItem, CourierReportItem, StateReportItem } from '../types'

type ActiveTab = 'monthly' | 'courier' | 'state'

export function Analytics() {
  useDocumentTitle('Reports & Analytics')
  const toast = useToast()
  const [activeTab, setActiveTab] = useState<ActiveTab>('monthly')
  const [stateSearch, setStateSearch] = useState('')

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['analytics-report'],
    queryFn: getAnalyticsReport,
    staleTime: 60_000,
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

  if (isLoading) {
    return <LoadingState label="Computing financial P&L, courier performance, and geographic order matrices…" />
  }

  if (isError) {
    return <ErrorBox message={error instanceof Error ? error.message : 'Failed to load analytics reports'} />
  }

  const kpis = data?.kpis

  return (
    <div className="analytics-page">
      <PageIntro
        eyebrow="Intelligence & Financial Reporting"
        title="Executive Reports & Order Analytics"
        description="Comprehensive analysis of order volumes by state, courier logistics performance, and monthly financial P&L."
        action={
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <button
              type="button"
              className="btn-export"
              onClick={() => {
                if (activeTab === 'monthly') exportMonthlyCsv()
                else if (activeTab === 'courier') exportCourierCsv()
                else exportStateCsv()
              }}
              title="Download active report as CSV"
            >
              <Icon name="download" size={15} />
              <span>Export {activeTab === 'monthly' ? 'P&L' : activeTab === 'courier' ? 'Courier' : 'State'} CSV</span>
            </button>
            <button
              type="button"
              className="btn-export"
              style={{ background: '#10b981', color: '#ffffff', borderColor: '#059669' }}
              onClick={() => refetch()}
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
            <div className="kpi-label">Total Order Volume</div>
            <div className="kpi-val">{kpis.totalOrders}</div>
            <span className="kpi-sub">Since 1-July-2026 onwards</span>
          </div>

          <div className="kpi-card">
            <div className="kpi-label">Gross Order Value</div>
            <div className="kpi-val" style={{ color: '#059669' }}>{formatMoney(kpis.totalGrossRevenue, 'INR')}</div>
            <span className="kpi-sub">Cumulative GMV across all channels</span>
          </div>

          <div className="kpi-card">
            <div className="kpi-label">Prepaid Volume Ratio</div>
            <div className="kpi-val" style={{ color: '#2563eb' }}>{kpis.prepaidRatio}%</div>
            <span className="kpi-sub">{kpis.totalPrepaidOrders} Prepaid · {kpis.totalCodOrders} COD</span>
          </div>

          <div className="kpi-card">
            <div className="kpi-label">Logistics Freight Spend</div>
            <div className="kpi-val">{formatMoney(kpis.totalShippingSpend, 'INR')}</div>
            <span className="kpi-sub">Across Delhivery, Ekart & ATS</span>
          </div>

          <div className="kpi-card">
            <div className="kpi-label">Geographic Reach</div>
            <div className="kpi-val" style={{ color: '#7c3aed' }}>{kpis.totalStatesCount} States</div>
            <span className="kpi-sub">Active delivery footprint</span>
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
          <span>Monthly Financial Analysis & P&L</span>
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
          <span>State-wise Geographic Volume ({data?.stateReport?.length ?? 0})</span>
        </button>
      </div>

      {/* TAB 1: Monthly Financial Analysis (Exact sheet replica) */}
      {activeTab === 'monthly' && (
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
      )}

      {/* TAB 2: Courier Performance Breakdown (Exact sheet replica) */}
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
    </div>
  )
}
