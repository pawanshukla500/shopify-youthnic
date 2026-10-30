import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, apiError, getReturns } from '../api'
import { RETURN_STATUSES, formatDate, formatMoney, labelize } from '../lib'
import { Button, EmptyState, ErrorBox, FormField, Icon, LoadingState, PageIntro, Panel, PanelHeading, StatusBadge, useDocumentTitle, useToast } from '../components/UI'
import { ManualRefundModal } from '../components/ManualRefundModal'
import './Returns.css'

type FilterTab = 'ALL' | 'QC_PASSED_UNREFUNDED' | 'COD_DUE' | 'EXCHANGES' | 'PENDING_QC' | 'REFUNDED'

export function Returns() {
  useDocumentTitle('Returns & Refunds')
  const toast = useToast()
  const queryClient = useQueryClient()
  const [status, setStatus] = useState('')
  const [search, setSearch] = useState('')
  const [filterTab, setFilterTab] = useState<FilterTab>('ALL')
  const [waybill, setWaybill] = useState('')
  const [qcStatus, setQcStatus] = useState<'APPROVED' | 'REJECTED' | 'PARTIAL'>('APPROVED')
  const [remark, setRemark] = useState('')
  const [manualRefundTarget, setManualRefundTarget] = useState<{
    orderId: number
    shopifyOrderName: string
    suggestedAmount: number
    returnId?: number
    returnWaybill?: string
    customerName?: string
  } | null>(null)

  const query = useQuery({ queryKey: ['returns', status || 'all'], queryFn: () => getReturns(status), retry: false })

  const scan = useMutation({
    mutationFn: async () => {
      if (!waybill.trim()) throw new Error('Enter a return waybill.')
      return (await api.post('/api/returns/scan', { waybillNumber: waybill.trim(), qcStatus, qcRemark: remark.trim() || undefined })).data
    },
    onSuccess: async (data) => {
      toast.toast(
        data.refundError ? 'error' : 'success',
        data.message ?? `Package scanned${data.refundProcessed ? ' · Refund processed' : ''}.`
      )
      setWaybill('')
      setRemark('')
      await queryClient.invalidateQueries({ queryKey: ['returns'] })
      await queryClient.invalidateQueries({ queryKey: ['orders'] })
    },
    onError: (error) => toast.toast('error', apiError(error)),
  })

  const refund = useMutation({
    mutationFn: async ({ id, orderName, approveQc }: { id: number; orderName?: string; approveQc?: boolean }) => {
      const confirmed = window.confirm(
        approveQc
          ? `Approve QC and refund the returned items of ${orderName || `Return #${id}`} via Shopify?`
          : `Refund the returned items of ${orderName || `Return #${id}`} via Shopify? Shopify calculates the amount from what the customer paid.`
      )
      if (!confirmed) throw new Error('USER_CANCELLED_REFUND')
      return (await api.post(`/api/returns/${id}/refund`, { approveQc })).data
    },
    onSuccess: async (data) => {
      if (data.moneyMoved === false) {
        toast.toast('error', 'Shopify recorded the refund, but this order has no online payment (COD). Pay the customer by UPI or bank transfer.')
      } else {
        toast.toast('success', `Shopify refund processed${typeof data.refundAmount === 'number' ? ` · ${formatMoney(data.refundAmount)}` : ''}.`)
      }
      await queryClient.invalidateQueries({ queryKey: ['returns'] })
      await queryClient.invalidateQueries({ queryKey: ['orders'] })
    },
    onError: (error) => {
      if (error instanceof Error && error.message === 'USER_CANCELLED_REFUND') return
      toast.toast('error', apiError(error))
    },
  })

  const copyWaybill = async (awb: string) => {
    try {
      await navigator.clipboard.writeText(awb)
      toast.toast('success', `Waybill ${awb} copied!`)
    } catch {
      window.prompt('Copy waybill:', awb)
    }
  }

  const returnsList = query.data ?? []

  const isUnrefundedQcPassed = (r: (typeof returnsList)[number]) => {
    if (r.isExchange) return false
    const isSettled = r.order?.financialStatus === 'refunded' || r.order?.status === 'REFUNDED' || r.refundStatus === 'PROCESSED'
    if (isSettled) return false
    const qcPassed = r.qcStatus === 'APPROVED' || r.qcStatus === 'PARTIAL'
    const packageReceived = Boolean(r.receivedAt || r.returnStatus === 'RECEIVED' || r.returnStatus === 'QC_PENDING' || r.trackingStatus === 'DTO')
    return qcPassed || packageReceived
  }

  // Metrics summary
  const metrics = useMemo(() => {
    const total = returnsList.length
    const qcPassedUnrefunded = returnsList.filter(isUnrefundedQcPassed).length
    const pendingQc = returnsList.filter((r) => !r.qcStatus).length
    const approved = returnsList.filter((r) => r.qcStatus === 'APPROVED').length
    const exchanges = returnsList.filter((r) => r.isExchange).length
    const codDue = returnsList.filter((r) => {
      const isCod = r.order?.paymentMethod === 'COD' || /cash/i.test(r.order?.paymentGateway || '')
      const isSettled = r.order?.financialStatus === 'refunded' || r.order?.status === 'REFUNDED' || r.refundStatus === 'PROCESSED'
      const qcPassed = r.qcStatus === 'APPROVED' || r.qcStatus === 'PARTIAL'
      return isCod && qcPassed && !isSettled && !r.isExchange
    }).length
    const settled = returnsList.filter((r) => {
      return r.order?.financialStatus === 'refunded' || r.order?.status === 'REFUNDED' || r.refundStatus === 'PROCESSED'
    }).length
    const refundedAmt = returnsList
      .filter((r) => r.refundStatus === 'PROCESSED' || r.order?.financialStatus === 'refunded')
      .reduce((sum, r) => sum + (Number(r.refundAmount) || 0), 0)
    return { total, qcPassedUnrefunded, pendingQc, approved, exchanges, codDue, settled, refundedAmt }
  }, [returnsList])

  // Filtered by tab and search
  const filtered = useMemo(() => {
    let items = returnsList

    if (filterTab === 'QC_PASSED_UNREFUNDED') {
      items = items.filter(isUnrefundedQcPassed)
    } else if (filterTab === 'COD_DUE') {
      items = items.filter((r) => {
        const isCod = r.order?.paymentMethod === 'COD' || /cash/i.test(r.order?.paymentGateway || '')
        const isSettled = r.order?.financialStatus === 'refunded' || r.order?.status === 'REFUNDED' || r.refundStatus === 'PROCESSED'
        const qcPassed = r.qcStatus === 'APPROVED' || r.qcStatus === 'PARTIAL'
        return isCod && qcPassed && !isSettled && !r.isExchange
      })
    } else if (filterTab === 'EXCHANGES') {
      items = items.filter((r) => r.isExchange)
    } else if (filterTab === 'PENDING_QC') {
      items = items.filter((r) => !r.qcStatus)
    } else if (filterTab === 'REFUNDED') {
      items = items.filter((r) => r.order?.financialStatus === 'refunded' || r.order?.status === 'REFUNDED' || r.refundStatus === 'PROCESSED')
    }

    if (!search.trim()) return items
    const q = search.trim().toLowerCase()
    return items.filter((item) => {
      const orderMatch = (item.order?.shopifyOrderName || '').toLowerCase().includes(q)
      const awbMatch = (item.returnWaybillNumber || '').toLowerCase().includes(q)
      const reasonMatch = (item.returnReason || '').toLowerCase().includes(q)
      const customerMatch = (item.order?.customerName || '').toLowerCase().includes(q)
      return orderMatch || awbMatch || reasonMatch || customerMatch
    })
  }, [returnsList, filterTab, search])

  return (
    <div className="returns-workspace">
      <PageIntro
        eyebrow="Reverse Logistics & Settlements"
        title="Returns & Refunds"
        description="Warehouse barcode intake, QC inspection, courier tracking, COD manual payout verification, and single-refund settlements."
      />

      {/* ─── Metrics Ribbon ────────────────────────────────────── */}
      <div className="returns-metrics-grid">
        <div
          className={`returns-metric-card ${filterTab === 'ALL' ? 'active' : ''}`}
          onClick={() => setFilterTab('ALL')}
          title="Click to view all returns"
        >
          <div className="returns-metric-label">
            <span>Total Returns</span>
            <Icon name="package" size={14} />
          </div>
          <strong className="returns-metric-value">{metrics.total}</strong>
        </div>

        <div
          className={`returns-metric-card highlight-amber ${filterTab === 'QC_PASSED_UNREFUNDED' ? 'active' : ''}`}
          onClick={() => setFilterTab('QC_PASSED_UNREFUNDED')}
          title="Click to view returns with QC passed or received at warehouse but not yet refunded (COD & Prepaid)"
          style={{ cursor: 'pointer' }}
        >
          <div className="returns-metric-label" style={{ color: '#b45309' }}>
            <span>QC Passed (Unrefunded)</span>
            <Icon name="alert-triangle" size={14} />
          </div>
          <strong className="returns-metric-value" style={{ color: '#b45309' }}>{metrics.qcPassedUnrefunded}</strong>
        </div>

        <div
          className={`returns-metric-card ${filterTab === 'PENDING_QC' ? 'active' : ''}`}
          onClick={() => setFilterTab('PENDING_QC')}
          title="Click to view returns pending QC"
        >
          <div className="returns-metric-label" style={{ color: '#b45309' }}>
            <span>Pending QC</span>
            <Icon name="clock" size={14} />
          </div>
          <strong className="returns-metric-value" style={{ color: '#b45309' }}>{metrics.pendingQc}</strong>
        </div>

        <div
          className={`returns-metric-card highlight-amber ${filterTab === 'COD_DUE' ? 'active' : ''}`}
          onClick={() => setFilterTab('COD_DUE')}
          title="Click to view COD returns waiting for manual payout"
        >
          <div className="returns-metric-label" style={{ color: '#b45309' }}>
            <span>COD Refund Due</span>
            <Icon name="dollar" size={14} />
          </div>
          <strong className="returns-metric-value" style={{ color: '#b45309' }}>{metrics.codDue}</strong>
        </div>

        <div
          className={`returns-metric-card ${filterTab === 'EXCHANGES' ? 'active' : ''}`}
          onClick={() => setFilterTab('EXCHANGES')}
          title="Click to view size exchange returns"
        >
          <div className="returns-metric-label" style={{ color: '#6b21a8' }}>
            <span>Size Exchanges</span>
            <Icon name="refresh" size={14} />
          </div>
          <strong className="returns-metric-value" style={{ color: '#6b21a8' }}>{metrics.exchanges}</strong>
        </div>

        <div
          className={`returns-metric-card ${filterTab === 'REFUNDED' ? 'active' : ''}`}
          onClick={() => setFilterTab('REFUNDED')}
          title="Click to view settled / refunded returns"
        >
          <div className="returns-metric-label" style={{ color: '#15803d' }}>
            <span>Settled / Refunded</span>
            <Icon name="check" size={14} />
          </div>
          <strong className="returns-metric-value" style={{ color: '#15803d' }}>{metrics.settled}</strong>
        </div>
      </div>

      {/* ─── Warehouse Scan Box ──────────────────────────────── */}
      <div className="scan-panel-card">
        <div className="scan-header-section">
          <div className="scan-icon-bubble">
            <Icon name="package" size={22} />
          </div>
          <div>
            <div style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', color: 'var(--muted)', letterSpacing: '0.04em' }}>
              Warehouse Intake
            </div>
            <div style={{ fontSize: '16px', fontWeight: 700, color: 'var(--ink)' }}>
              Scan Return Package
            </div>
            <div style={{ fontSize: '12px', color: 'var(--muted)' }}>
              Scan barcode gun (Enter triggers submit) · Records QC arrival
            </div>
          </div>
        </div>

        <div className="scan-form-row">
          <div className="scan-input-waybill">
            <FormField label="Return Waybill">
              <input
                value={waybill}
                onChange={(event) => setWaybill(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    scan.mutate()
                  }
                }}
                placeholder="Scan or enter waybill (press Enter)"
                autoFocus
              />
            </FormField>
          </div>
          <div className="scan-select-outcome">
            <FormField label="QC Outcome">
              <select value={qcStatus} onChange={(event) => setQcStatus(event.target.value as typeof qcStatus)}>
                <option value="APPROVED">Approved (Pass)</option>
                <option value="PARTIAL">Partial (Minor issue)</option>
                <option value="REJECTED">Rejected (Damaged / Fake)</option>
              </select>
            </FormField>
          </div>
          <div className="scan-input-remark">
            <FormField label="QC Remark (optional)">
              <input
                value={remark}
                onChange={(event) => setRemark(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    scan.mutate()
                  }
                }}
                placeholder="Condition notes..."
              />
            </FormField>
          </div>
          <div>
            <Button
              className="button-primary"
              style={{ minHeight: '38px', padding: '0 18px', fontWeight: 650 }}
              loading={scan.isPending}
              onClick={() => scan.mutate()}
            >
              <Icon name="check" size={15} />
              Complete Scan
            </Button>
          </div>
        </div>
      </div>

      {/* ─── Returns Table & Filter Bar ────────────────────────── */}
      <Panel className="table-panel">
        <PanelHeading
          eyebrow="Reverse logistics queue"
          title={`Returns Queue (${filtered.length})`}
          action={
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div className="search-field" style={{ width: '220px', height: '34px' }}>
                <Icon name="search" size={14} />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search order, waybill, customer…"
                />
                {search && (
                  <button className="search-clear-btn" onClick={() => setSearch('')}>
                    ✕
                  </button>
                )}
              </div>

              <FormField label="Status">
                <select
                  value={status}
                  onChange={(event) => setStatus(event.target.value)}
                  style={{ height: '34px', fontSize: '12px' }}
                >
                  <option value="">All statuses</option>
                  {RETURN_STATUSES.map((item) => (
                    <option value={item} key={item}>
                      {labelize(item)}
                    </option>
                  ))}
                </select>
              </FormField>
            </div>
          }
        />

        {/* Quick Filter Navigation Tabs */}
        <div className="returns-filter-nav">
          <button
            className={`returns-tab-btn ${filterTab === 'ALL' ? 'active' : ''}`}
            onClick={() => setFilterTab('ALL')}
          >
            All Returns
            <span className="returns-tab-count">{metrics.total}</span>
          </button>
          <button
            className={`returns-tab-btn ${filterTab === 'QC_PASSED_UNREFUNDED' ? 'active' : ''}`}
            onClick={() => setFilterTab('QC_PASSED_UNREFUNDED')}
          >
            QC Passed (Unrefunded)
            <span className="returns-tab-count" style={{ background: '#fef3c7', color: '#92400e', fontWeight: 700 }}>
              {metrics.qcPassedUnrefunded}
            </span>
          </button>
          <button
            className={`returns-tab-btn ${filterTab === 'COD_DUE' ? 'active' : ''}`}
            onClick={() => setFilterTab('COD_DUE')}
          >
            COD Refund Due
            <span className="returns-tab-count" style={{ background: '#fef3c7', color: '#92400e' }}>
              {metrics.codDue}
            </span>
          </button>
          <button
            className={`returns-tab-btn ${filterTab === 'EXCHANGES' ? 'active' : ''}`}
            onClick={() => setFilterTab('EXCHANGES')}
          >
            Size Exchanges
            <span className="returns-tab-count" style={{ background: '#f3e8ff', color: '#6b21a8' }}>
              {metrics.exchanges}
            </span>
          </button>
          <button
            className={`returns-tab-btn ${filterTab === 'PENDING_QC' ? 'active' : ''}`}
            onClick={() => setFilterTab('PENDING_QC')}
          >
            Pending QC
            <span className="returns-tab-count" style={{ background: '#fee2e2', color: '#991b1b' }}>
              {metrics.pendingQc}
            </span>
          </button>
          <button
            className={`returns-tab-btn ${filterTab === 'REFUNDED' ? 'active' : ''}`}
            onClick={() => setFilterTab('REFUNDED')}
          >
            Settled / Refunded
            <span className="returns-tab-count" style={{ background: '#dcfce7', color: '#166534' }}>
              {metrics.settled}
            </span>
          </button>
        </div>

        {query.isError && <ErrorBox message={apiError(query.error)} />}
        {query.isLoading ? (
          <LoadingState label="Loading returns queue…" />
        ) : filtered.length ? (
          <div className="table-wrap">
            <table className="data-table returns-table">
              <thead>
                <tr>
                  <th>Order & Customer</th>
                  <th>Return Tracking</th>
                  <th>Reason & Remark</th>
                  <th>Return Status</th>
                  <th>QC</th>
                  <th>Refund Status</th>
                  <th>Amount</th>
                  <th>Created</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((item) => {
                  const isCod = item.order?.paymentMethod === 'COD' || /cash/i.test(item.order?.paymentGateway || '')
                  const isRefunded =
                    item.order?.financialStatus === 'refunded' ||
                    item.order?.status === 'REFUNDED' ||
                    item.refundStatus === 'PROCESSED'
                  return (
                    <tr key={item.id}>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                          <Link className="order-link" to={`/orders/${item.orderId}`}>
                            {item.order?.shopifyOrderName ?? `Order #${item.orderId}`}
                          </Link>
                          {item.isExchange && (
                            <span className="badge-pill badge-exchange">
                              Exchange
                            </span>
                          )}
                          <span className={`badge-pill ${isCod ? 'badge-cod' : 'badge-prepaid'}`}>
                            {isCod ? 'COD' : 'Prepaid'}
                          </span>
                        </div>
                        <span className="cell-muted" style={{ display: 'block', marginTop: '3px' }}>
                          {item.order?.customerName ?? 'Customer'}
                        </span>
                      </td>
                      <td>
                        {item.returnWaybillNumber ? (
                          <div
                            className="waybill-chip"
                            onClick={() => copyWaybill(item.returnWaybillNumber || '')}
                            title="Click to copy waybill"
                          >
                            <span>{item.returnWaybillNumber}</span>
                            <Icon name="copy" size={11} />
                          </div>
                        ) : (
                          <span className="cell-muted">Waybill pending</span>
                        )}
                        {item.pickupAutomatic ? (
                          <span className="cell-muted" style={{ display: 'block', fontSize: '11px', marginTop: '2px' }}>
                            Auto carrier pickup
                          </span>
                        ) : null}
                        {item.trackingStatus ? (
                          <span className="cell-muted" style={{ display: 'block', fontSize: '11px' }}>
                            {item.trackingStatus}
                            {item.trackingLocation ? ` · ${item.trackingLocation}` : ''}
                          </span>
                        ) : null}
                        {item.forwardWaybill ? (
                          <div className="awb-forward-chip" title="Original forward AWB">
                            <Icon name="package" size={10} />
                            <span>Fwd {item.forwardWaybill}</span>
                          </div>
                        ) : null}
                      </td>
                      <td>
                        <span className="reason-cell" style={{ fontWeight: 650, color: 'var(--ink)' }}>
                          {item.returnReason}
                        </span>
                        {item.qcRemark && (
                          <span className="cell-muted" style={{ display: 'block', color: 'var(--muted)', marginTop: '2px', fontSize: '11px' }}>
                            QC Note: {item.qcRemark}
                          </span>
                        )}
                      </td>
                      <td>
                        <StatusBadge status={item.returnStatus} />
                      </td>
                      <td>
                        {item.qcStatus ? (
                          <StatusBadge status={item.qcStatus} />
                        ) : (
                          <span className="cell-muted">Pending QC</span>
                        )}
                      </td>
                      <td>
                        {item.isExchange ? (
                          <span className="badge-pill badge-exchange">Size Replacement (No Cash Refund)</span>
                        ) : isRefunded ? (
                          <span className="badge-pill badge-settled">✓ Refunded</span>
                        ) : isCod && (item.qcStatus === 'APPROVED' || item.qcStatus === 'PARTIAL' || item.returnStatus === 'QC_PENDING' || item.trackingStatus === 'DTO' || Boolean(item.receivedAt)) ? (
                          <span className="badge-pill badge-refund-due">Manual Refund Due</span>
                        ) : !isCod && (item.refundStatus === 'NONE' || item.refundStatus === 'FAILED') && Boolean(item.receivedAt || item.returnStatus === 'RECEIVED' || item.returnStatus === 'QC_PENDING' || item.trackingStatus === 'DTO') ? (
                          <span className="badge-pill" style={{ background: '#fee2e2', color: '#991b1b', fontWeight: 650 }}>Refund Pending Push</span>
                        ) : (
                          <StatusBadge status={item.refundStatus} />
                        )}
                      </td>
                      <td className="amount-cell">
                        <strong>{formatMoney(item.refundAmount)}</strong>
                      </td>
                      <td style={{ fontSize: '11px', color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                        {formatDate(item.createdAt)}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {item.isExchange ? (
                          <span style={{ fontSize: '11px', color: '#6b21a8', fontWeight: 650 }}>
                            Size Replacement
                          </span>
                        ) : isRefunded ? (
                          <span style={{ fontSize: '11px', color: '#15803d', fontWeight: 650 }}>
                            ✓ Settled
                          </span>
                        ) : isCod ? (
                          item.qcStatus === 'APPROVED' || item.qcStatus === 'PARTIAL' || Boolean(item.receivedAt || item.returnStatus === 'RECEIVED' || item.returnStatus === 'QC_PENDING' || item.trackingStatus === 'DTO') ? (
                            <Button
                              className="button-small button-primary"
                              style={{ background: '#b45309', borderColor: '#b45309', color: '#fff', fontSize: '11px', fontWeight: 650 }}
                              onClick={() =>
                                setManualRefundTarget({
                                  orderId: item.orderId,
                                  shopifyOrderName: item.order?.shopifyOrderName || `Order #${item.orderId}`,
                                  suggestedAmount: Number(item.refundAmount) || Number(item.order?.totalAmount) || 0,
                                  returnId: item.id,
                                  returnWaybill: item.returnWaybillNumber || undefined,
                                  customerName: item.order?.customerName,
                                })
                              }
                            >
                              <Icon name="dollar" size={12} />
                              Record COD Refund
                            </Button>
                          ) : (
                            <span className="cell-muted">In Transit</span>
                          )
                        ) : (item.refundStatus === 'NONE' || item.refundStatus === 'FAILED') &&
                          (item.qcStatus === 'APPROVED' || item.qcStatus === 'PARTIAL') ? (
                          <Button
                            className="button-small button-secondary"
                            style={{ borderColor: '#fca5a5', color: '#b91c1c', fontSize: '11px' }}
                            loading={refund.isPending && refund.variables?.id === item.id}
                            onClick={() =>
                              refund.mutate({
                                id: item.id,
                                orderName: item.order?.shopifyOrderName,
                              })
                            }
                            disabled={refund.isPending}
                          >
                            <Icon name="dollar" size={12} />
                            Shopify Auto-Refund
                          </Button>
                        ) : (item.refundStatus === 'NONE' || item.refundStatus === 'FAILED') &&
                          Boolean(item.receivedAt || item.returnStatus === 'RECEIVED' || item.returnStatus === 'QC_PENDING' || item.trackingStatus === 'DTO') ? (
                          <Button
                            className="button-small button-primary"
                            style={{ background: '#059669', borderColor: '#059669', color: '#fff', fontSize: '11px', fontWeight: 650 }}
                            loading={refund.isPending && refund.variables?.id === item.id}
                            onClick={() =>
                              refund.mutate({
                                id: item.id,
                                orderName: item.order?.shopifyOrderName,
                                approveQc: true,
                              })
                            }
                            disabled={refund.isPending}
                            title="Package received at warehouse: approve QC and push refund to Shopify"
                          >
                            <Icon name="check" size={12} />
                            Approve QC & Refund
                          </Button>
                        ) : (
                          <span className="cell-muted">QC Required</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            title="No returns found"
            description="Scanned return packages and customer requests matching your filters will appear here."
            icon="return"
          />
        )}
      </Panel>

      {manualRefundTarget && (
        <ManualRefundModal
          isOpen={Boolean(manualRefundTarget)}
          onClose={() => setManualRefundTarget(null)}
          orderId={manualRefundTarget.orderId}
          shopifyOrderName={manualRefundTarget.shopifyOrderName}
          suggestedAmount={manualRefundTarget.suggestedAmount}
          returnId={manualRefundTarget.returnId}
          returnWaybill={manualRefundTarget.returnWaybill}
          customerName={manualRefundTarget.customerName}
        />
      )}
    </div>
  )
}
