import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, apiError, getReturns } from '../api'
import { RETURN_STATUSES, formatDate, formatMoney, labelize } from '../lib'
import { Button, EmptyState, ErrorBox, FormField, Icon, LoadingState, PageIntro, Panel, PanelHeading, StatusBadge, useDocumentTitle, useToast } from '../components/UI'

export function Returns() {
  useDocumentTitle('Returns & Refunds')
  const toast = useToast()
  const queryClient = useQueryClient()
  const [status, setStatus] = useState('')
  const [search, setSearch] = useState('')
  const [waybill, setWaybill] = useState('')
  const [qcStatus, setQcStatus] = useState<'APPROVED' | 'REJECTED' | 'PARTIAL'>('APPROVED')
  const [remark, setRemark] = useState('')

  const query = useQuery({ queryKey: ['returns', status || 'all'], queryFn: () => getReturns(status), retry: false })

  const scan = useMutation({
    mutationFn: async () => {
      if (!waybill.trim()) throw new Error('Enter a return waybill.')
      return (await api.post('/api/returns/scan', { waybillNumber: waybill.trim(), qcStatus, qcRemark: remark.trim() || undefined })).data
    },
    onSuccess: async (data) => {
      toast.toast('success', data.message ?? `Package scanned${data.refundProcessed ? ' · Refund processed' : ''}.`)
      setWaybill('')
      setRemark('')
      await queryClient.invalidateQueries({ queryKey: ['returns'] })
      await queryClient.invalidateQueries({ queryKey: ['orders'] })
    },
    onError: (error) => toast.toast('error', apiError(error)),
  })

  const refund = useMutation({
    mutationFn: async ({ id, amount, orderName }: { id: number; amount: number; orderName?: string }) => {
      const confirmed = window.confirm(`Process refund of ${formatMoney(amount)} for ${orderName || `Return #${id}`} directly via Shopify?`)
      if (!confirmed) throw new Error('USER_CANCELLED_REFUND')
      return (await api.post(`/api/returns/${id}/refund`, { partial: false })).data
    },
    onSuccess: async (data) => {
      toast.toast('success', `Shopify refund processed${typeof data.refundAmount === 'number' ? ` · ${formatMoney(data.refundAmount)}` : ''}.`)
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

  // Metrics summary
  const metrics = useMemo(() => {
    const total = returnsList.length
    const pendingQc = returnsList.filter((r) => !r.qcStatus).length
    const approved = returnsList.filter((r) => r.qcStatus === 'APPROVED').length
    const refundedAmt = returnsList.filter((r) => r.refundStatus === 'PROCESSED').reduce((sum, r) => sum + (Number(r.refundAmount) || 0), 0)
    return { total, pendingQc, approved, refundedAmt }
  }, [returnsList])

  // Filtered by search
  const filtered = useMemo(() => {
    if (!search.trim()) return returnsList
    const q = search.trim().toLowerCase()
    return returnsList.filter((item) => {
      const orderMatch = (item.order?.shopifyOrderName || '').toLowerCase().includes(q)
      const awbMatch = (item.returnWaybillNumber || '').toLowerCase().includes(q)
      const reasonMatch = (item.returnReason || '').toLowerCase().includes(q)
      const customerMatch = (item.order?.customerName || '').toLowerCase().includes(q)
      return orderMatch || awbMatch || reasonMatch || customerMatch
    })
  }, [returnsList, search])

  return (
    <>
      <PageIntro
        eyebrow="Reverse Logistics"
        title="Returns & Refunds"
        description="Warehouse scanning, QC inspection, carrier tracking, and automated Shopify refund processing."
      />

      {/* ─── Metrics Cards ────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '14px', marginBottom: '20px' }}>
        <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: '10px', padding: '14px 16px' }}>
          <span style={{ fontSize: '10px', color: '#64748b', fontWeight: 700, textTransform: 'uppercase' }}>Total Returns</span>
          <strong className="tabular-nums" style={{ display: 'block', fontSize: '22px', color: 'var(--ink)', fontWeight: 800, marginTop: '4px' }}>
            {metrics.total}
          </strong>
        </div>
        <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: '10px', padding: '14px 16px' }}>
          <span style={{ fontSize: '10px', color: '#b45309', fontWeight: 700, textTransform: 'uppercase' }}>Pending QC</span>
          <strong className="tabular-nums" style={{ display: 'block', fontSize: '22px', color: '#b45309', fontWeight: 800, marginTop: '4px' }}>
            {metrics.pendingQc}
          </strong>
        </div>
        <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: '10px', padding: '14px 16px' }}>
          <span style={{ fontSize: '10px', color: '#15803d', fontWeight: 700, textTransform: 'uppercase' }}>QC Approved</span>
          <strong className="tabular-nums" style={{ display: 'block', fontSize: '22px', color: '#15803d', fontWeight: 800, marginTop: '4px' }}>
            {metrics.approved}
          </strong>
        </div>
        <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: '10px', padding: '14px 16px' }}>
          <span style={{ fontSize: '10px', color: '#1d4ed8', fontWeight: 700, textTransform: 'uppercase' }}>Total Refunded</span>
          <strong className="tabular-nums" style={{ display: 'block', fontSize: '22px', color: '#1d4ed8', fontWeight: 800, marginTop: '4px' }}>
            {formatMoney(metrics.refundedAmt)}
          </strong>
        </div>
      </div>

      {/* ─── Warehouse Scan Panel ──────────────────────────────── */}
      <Panel className="scan-panel">
        <div className="scan-copy">
          <div className="scan-icon">
            <Icon name="package" size={23} />
          </div>
          <div>
            <p className="eyebrow">Warehouse Action</p>
            <h2>Scan returned package</h2>
            <p>Record a carrier arrival, perform QC inspection, and close the loop.</p>
          </div>
        </div>
        <div className="scan-form">
          <FormField label="Return waybill">
            <input
              value={waybill}
              onChange={(event) => setWaybill(event.target.value)}
              placeholder="Scan or enter waybill"
            />
          </FormField>
          <FormField label="QC outcome">
            <select value={qcStatus} onChange={(event) => setQcStatus(event.target.value as typeof qcStatus)}>
              <option value="APPROVED">Approved (Pass)</option>
              <option value="PARTIAL">Partial (Minor)</option>
              <option value="REJECTED">Rejected (Damaged/Fake)</option>
            </select>
          </FormField>
          <FormField label="Remark (optional)">
            <input
              value={remark}
              onChange={(event) => setRemark(event.target.value)}
              placeholder="Packaging condition notes"
            />
          </FormField>
          <Button className="button-primary scan-submit" loading={scan.isPending} onClick={() => scan.mutate()}>
            <Icon name="check" size={16} />
            Complete scan
          </Button>
        </div>
      </Panel>

      {/* ─── Returns Table & Filter Bar ────────────────────────── */}
      <Panel className="table-panel">
        <PanelHeading
          eyebrow="Return queue"
          title={`All Returns (${filtered.length})`}
          action={
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div className="search-field" style={{ width: '220px', height: '34px' }}>
                <Icon name="search" size={14} />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search order or waybill…"
                />
                {search && (
                  <button className="search-clear-btn" onClick={() => setSearch('')}>
                    ✕
                  </button>
                )}
              </div>

              <FormField label="Filter">
                <select
                  value={status}
                  onChange={(event) => setStatus(event.target.value)}
                  style={{ height: '34px', fontSize: '11px' }}
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
                {filtered.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <Link className="order-link" to={`/orders/${item.orderId}`}>
                        {item.order?.shopifyOrderName ?? `Order #${item.orderId}`}
                      </Link>
                      <span className="cell-muted">{item.order?.customerName ?? 'Customer'}</span>
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
                        <span className="cell-muted">Customer pickup automatic</span>
                      ) : null}
                      {item.trackingStatus ? (
                        <span className="cell-muted">{item.trackingStatus}{item.trackingLocation ? ` · ${item.trackingLocation}` : ''}</span>
                      ) : null}
                      {item.forwardWaybill ? (
                        <span className="cell-muted">Forward {item.forwardWaybill}</span>
                      ) : null}
                    </td>
                    <td>
                      <span className="reason-cell" style={{ fontWeight: 600, color: 'var(--ink)' }}>
                        {item.returnReason}
                      </span>
                      {item.qcRemark && (
                        <span className="cell-muted" style={{ display: 'block', color: 'var(--muted)' }}>
                          Note: {item.qcRemark}
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
                      <StatusBadge status={item.refundStatus} />
                    </td>
                    <td className="amount-cell">
                      <strong>{formatMoney(item.refundAmount)}</strong>
                    </td>
                    <td style={{ fontSize: '10px', color: '#64748b' }}>{formatDate(item.createdAt)}</td>
                    <td style={{ textAlign: 'right' }}>
                      {item.refundStatus !== 'PROCESSED' && (
                        <Button
                          className="button-small button-secondary"
                          style={{ borderColor: '#fca5a5', color: '#b91c1c' }}
                          loading={refund.isPending && refund.variables?.id === item.id}
                          onClick={() =>
                            refund.mutate({
                              id: item.id,
                              amount: item.refundAmount ?? 0,
                              orderName: item.order?.shopifyOrderName,
                            })
                          }
                          disabled={refund.isPending}
                        >
                          <Icon name="dollar" size={12} />
                          Shopify Refund
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            title="No returns found"
            description="Scanned return packages and customer requests will appear here."
            icon="return"
          />
        )}
      </Panel>
    </>
  )
}
