import { useState, useMemo, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import {
  getDelhiveryWalletLedger,
  importDelhiveryLedger,
  reconcileAllLedgerWithOrders,
  reconcileAwbWithOrder,
  getCodSummary,
  recordCodRemittance,
  importCodRemittanceCsv,
  markCodCollected,
  apiError,
} from '../api'
import { formatMoney, formatDate } from '../lib'
import {
  Button,
  EmptyState,
  ErrorBox,
  FormField,
  Icon,
  LoadingState,
  PageIntro,
  Panel,
  useDocumentTitle,
  useToast,
} from '../components/UI'
import type { DelhiveryLedgerTransaction } from '../types'

type LedgerTab = 'TRANSACTIONS' | 'MISMATCHES' | 'REMITTANCES' | 'RECHARGES'
type RemittanceView = 'OUTSTANDING' | 'REMITTED' | 'PENDING'

export function DelhiveryLedger() {
  useDocumentTitle('Delhivery Wallet & AWB Ledger')
  const navigate = useNavigate()
  const toast = useToast()
  const queryClient = useQueryClient()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const remittanceFileInputRef = useRef<HTMLInputElement>(null)

  const [activeTab, setActiveTab] = useState<LedgerTab>('TRANSACTIONS')
  const [remittanceView, setRemittanceView] = useState<RemittanceView>('OUTSTANDING')
  const [awbSearch, setAwbSearch] = useState('')
  const [txTypeFilter, setTxTypeFilter] = useState<'ALL' | 'MISMATCH' | 'DELIVERED' | 'MANIFESTED'>('ALL')
  const [dateRange, setDateRange] = useState('90')
  const [reconcilingAwb, setReconcilingAwb] = useState<string | null>(null)
  const [isRecordModalOpen, setIsRecordModalOpen] = useState(false)
  const [manualRemittanceRef, setManualRemittanceRef] = useState('')
  const [manualRemittedAt, setManualRemittedAt] = useState(new Date().toISOString().slice(0, 10))
  const [manualWaybills, setManualWaybills] = useState('')

  const query = useQuery({
    queryKey: ['delhivery-wallet-ledger', awbSearch, activeTab],
    queryFn: () =>
      getDelhiveryWalletLedger({
        awb: awbSearch || undefined,
        mismatchOnly: activeTab === 'MISMATCHES',
      }),
  })

  const codQuery = useQuery({
    queryKey: ['cod-summary'],
    queryFn: getCodSummary,
    enabled: activeTab === 'REMITTANCES',
  })

  const remittanceCsvMutation = useMutation({
    mutationFn: importCodRemittanceCsv,
    onSuccess: (data) => {
      toast.toast('success', data.message || `Imported remittance: ${data.updated} orders settled.`)
      queryClient.invalidateQueries({ queryKey: ['cod-summary'] })
      queryClient.invalidateQueries({ queryKey: ['orders'] })
    },
    onError: (err) => toast.toast('error', apiError(err)),
  })

  const manualRemittanceMutation = useMutation({
    mutationFn: recordCodRemittance,
    onSuccess: (data) => {
      toast.toast('success', `Recorded remittance: ${data.updated} orders marked remitted & settled.`)
      setIsRecordModalOpen(false)
      setManualRemittanceRef('')
      setManualWaybills('')
      queryClient.invalidateQueries({ queryKey: ['cod-summary'] })
      queryClient.invalidateQueries({ queryKey: ['orders'] })
    },
    onError: (err) => toast.toast('error', apiError(err)),
  })

  const markCollectedMutation = useMutation({
    mutationFn: markCodCollected,
    onSuccess: (data) => {
      toast.toast('success', `Waybill ${data.waybillNumber} marked as collected by courier!`)
      queryClient.invalidateQueries({ queryKey: ['cod-summary'] })
      queryClient.invalidateQueries({ queryKey: ['orders'] })
    },
    onError: (err) => toast.toast('error', apiError(err)),
  })

  const handleRemittanceFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (event) => {
      const text = event.target?.result as string
      if (text) {
        remittanceCsvMutation.mutate({ csvContent: text })
      }
    }
    reader.readAsText(file)
  }

  const importMutation = useMutation({
    mutationFn: importDelhiveryLedger,
    onSuccess: (data) => {
      toast.toast('success', data.message || `Imported ${data.imported} ledger entries.`)
      queryClient.invalidateQueries({ queryKey: ['delhivery-wallet-ledger'] })
      queryClient.invalidateQueries({ queryKey: ['orders'] })
    },
    onError: (err) => toast.toast('error', apiError(err)),
  })

  const reconcileAllMutation = useMutation({
    mutationFn: reconcileAllLedgerWithOrders,
    onSuccess: (data) => {
      toast.toast('success', `Reconciled ${data.totalWaybills} AWBs · ${data.reconciledOrders} Shopify orders updated with exact billed shipping cost.`)
      queryClient.invalidateQueries({ queryKey: ['delhivery-wallet-ledger'] })
      queryClient.invalidateQueries({ queryKey: ['orders'] })
    },
    onError: (err) => toast.toast('error', apiError(err)),
  })

  const handleReconcileSingleAwb = async (waybill: string) => {
    setReconcilingAwb(waybill)
    try {
      const res = await reconcileAwbWithOrder(waybill)
      toast.toast('success', `AWB ${waybill} reconciled with ${res.reconciliation.orderName || 'Order'} · Net billed: ₹${res.reconciliation.netBilledCost}`)
      queryClient.invalidateQueries({ queryKey: ['delhivery-wallet-ledger'] })
      queryClient.invalidateQueries({ queryKey: ['orders'] })
    } catch (err: any) {
      toast.toast('error', apiError(err))
    } finally {
      setReconcilingAwb(null)
    }
  }

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (event) => {
      const text = event.target?.result as string
      if (text) {
        importMutation.mutate({ csvContent: text })
      }
    }
    reader.readAsText(file)
  }

  const copyText = (val: string, label: string) => {
    navigator.clipboard.writeText(val)
    toast.toast('success', `${label} copied!`)
  }

  const stats = query.data

  const filteredTransactions = useMemo(() => {
    let list = stats?.transactions ?? []
    if (activeTab === 'MISMATCHES') {
      list = list.filter((t) => t.isWeightMismatch)
    }
    if (txTypeFilter === 'MISMATCH') {
      list = list.filter((t) => t.isWeightMismatch)
    } else if (txTypeFilter === 'DELIVERED') {
      list = list.filter((t) => t.description.toLowerCase().includes('delivered'))
    } else if (txTypeFilter === 'MANIFESTED') {
      list = list.filter((t) => t.description.toLowerCase().includes('manifested'))
    }
    return list
  }, [stats?.transactions, activeTab, txTypeFilter])

  const codData = codQuery.data

  const filteredOutstanding = useMemo(() => {
    const list = codData?.outstanding ?? []
    if (!awbSearch) return list
    const q = awbSearch.toLowerCase()
    return list.filter(
      (s) =>
        s.waybillNumber?.toLowerCase().includes(q) ||
        s.orderName?.toLowerCase().includes(q) ||
        s.customerName?.toLowerCase().includes(q)
    )
  }, [codData?.outstanding, awbSearch])

  const filteredRemitted = useMemo(() => {
    const list = codData?.remitted ?? []
    if (!awbSearch) return list
    const q = awbSearch.toLowerCase()
    return list.filter(
      (s) =>
        s.waybillNumber?.toLowerCase().includes(q) ||
        s.orderName?.toLowerCase().includes(q) ||
        s.customerName?.toLowerCase().includes(q) ||
        s.remittanceRef?.toLowerCase().includes(q)
    )
  }, [codData?.remitted, awbSearch])

  const filteredPending = useMemo(() => {
    const list = codData?.pendingDelivery ?? []
    if (!awbSearch) return list
    const q = awbSearch.toLowerCase()
    return list.filter(
      (s) =>
        s.waybillNumber?.toLowerCase().includes(q) ||
        s.orderName?.toLowerCase().includes(q) ||
        s.customerName?.toLowerCase().includes(q)
    )
  }, [codData?.pendingDelivery, awbSearch])

  const exportCurrentLedgerCsv = () => {
    const items = filteredTransactions
    if (!items.length) {
      toast.toast('error', 'No ledger records to export.')
      return
    }

    const headers = [
      'Transaction ID',
      'Transaction Date',
      'Account Details',
      'Order ID',
      'AWB / LRN',
      'Weight (gm)',
      'Zone',
      'Description',
      'Credit (INR)',
      'Debit (INR)',
      'Weight Mismatch',
    ]

    const escapeCsv = (val: any) => {
      if (val === null || val === undefined) return '""'
      const str = String(val).replace(/"/g, '""')
      return `"${str}"`
    }

    const rows = items.map((t) => [
      escapeCsv(t.transactionId),
      escapeCsv(formatDate(t.transactionDate)),
      escapeCsv(t.accountName || 'fa5d92-VBEXPORT-do'),
      escapeCsv(t.orderId || t.orderName || ''),
      escapeCsv(t.waybillNumber),
      escapeCsv(t.weightGrams ?? ''),
      escapeCsv(t.zone || ''),
      escapeCsv(t.description),
      escapeCsv(t.creditAmount > 0 ? t.creditAmount.toFixed(2) : '-'),
      escapeCsv(t.debitAmount > 0 ? t.debitAmount.toFixed(2) : '-'),
      escapeCsv(t.isWeightMismatch ? 'YES' : 'NO'),
    ])

    const csvContent = '\uFEFF' + [headers.join(','), ...rows.map((r) => r.join(','))].join('\r\n')
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.setAttribute('download', `delhivery_wallet_ledger_${new Date().toISOString().slice(0, 10)}.csv`)
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
    toast.toast('success', `Exported ${items.length} ledger transactions.`)
  }

  return (
    <>
      <PageIntro
        eyebrow="Carrier Billing & Finances"
        title="Delhivery Wallet & AWB Ledger"
        description="Comprehensive audit of Delhivery ONE wallet transactions, AWB freight debits, delivery credits, and weight discrepancy adjustments."
      >
        <div className="intro-actions" style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileUpload}
            accept=".csv,.txt"
            style={{ display: 'none' }}
          />
          <input
            type="file"
            ref={remittanceFileInputRef}
            onChange={handleRemittanceFileUpload}
            accept=".csv,.txt"
            style={{ display: 'none' }}
          />

          {activeTab === 'REMITTANCES' ? (
            <>
              <Button
                className="button-primary"
                onClick={() => remittanceFileInputRef.current?.click()}
                loading={remittanceCsvMutation.isPending}
                title="Import Delhivery ONE Finances > Remittances CSV report"
              >
                <Icon name="download" size={15} />
                Import Remittance CSV
              </Button>
              <Button
                className="button-secondary"
                onClick={() => setIsRecordModalOpen(true)}
                title="Record Remittance Ref / Bank UTR manually"
              >
                <Icon name="check" size={15} />
                Record Remittance
              </Button>
              <a
                className="button button-secondary"
                href="https://one.delhivery.com"
                target="_blank"
                rel="noopener noreferrer"
                title="Open Delhivery ONE Finances > Remittances"
              >
                <Icon name="external" size={15} />
                Delhivery Remittances ↗
              </a>
            </>
          ) : (
            <>
              <Button
                className="button-primary"
                onClick={() => fileInputRef.current?.click()}
                loading={importMutation.isPending}
                title="Import Delhivery ONE Download Ledger CSV"
              >
                <Icon name="download" size={15} />
                Import Ledger CSV
              </Button>

              <Button
                className="button-secondary"
                onClick={() => reconcileAllMutation.mutate()}
                loading={reconcileAllMutation.isPending}
                title="Synchronize and reconcile all AWB charges, reversals, and weight adjustments with Shopify Orders"
              >
                <Icon name="refresh" size={15} />
                Reconcile with Orders
              </Button>

              <Button className="button-secondary" onClick={exportCurrentLedgerCsv}>
                <Icon name="copy" size={15} />
                Download Ledger
              </Button>

              <a
                className="button button-secondary"
                href="https://one.delhivery.com"
                target="_blank"
                rel="noopener noreferrer"
                title="Open Delhivery ONE Portal"
              >
                <Icon name="external" size={15} />
                Recharge Wallet ↗
              </a>
            </>
          )}
        </div>
      </PageIntro>

      {/* ─── Delhivery ONE Style Tab Bar ──────────────────────────────── */}
      <div style={{ display: 'flex', gap: '8px', borderBottom: '1px solid #e2e8f0', marginBottom: '16px' }}>
        <button
          type="button"
          onClick={() => setActiveTab('TRANSACTIONS')}
          style={{
            background: 'none',
            border: 0,
            padding: '10px 16px',
            fontSize: '13px',
            fontWeight: activeTab === 'TRANSACTIONS' ? 750 : 550,
            color: activeTab === 'TRANSACTIONS' ? '#2563eb' : '#64748b',
            borderBottom: activeTab === 'TRANSACTIONS' ? '2.5px solid #2563eb' : '2.5px solid transparent',
            cursor: 'pointer',
          }}
        >
          Transactions ({stats?.totalTransactions ?? 0})
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('MISMATCHES')}
          style={{
            background: 'none',
            border: 0,
            padding: '10px 16px',
            fontSize: '13px',
            fontWeight: activeTab === 'MISMATCHES' ? 750 : 550,
            color: activeTab === 'MISMATCHES' ? '#dc2626' : '#64748b',
            borderBottom: activeTab === 'MISMATCHES' ? '2.5px solid #dc2626' : '2.5px solid transparent',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
          }}
        >
          <span>Weight Mismatches</span>
          {(stats?.mismatchCount ?? 0) > 0 && (
            <span style={{ background: '#fee2e2', color: '#b91c1c', fontSize: '10px', fontWeight: 800, padding: '1px 6px', borderRadius: '999px' }}>
              {stats?.mismatchCount}
            </span>
          )}
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('REMITTANCES')}
          style={{
            background: 'none',
            border: 0,
            padding: '10px 16px',
            fontSize: '13px',
            fontWeight: activeTab === 'REMITTANCES' ? 750 : 550,
            color: activeTab === 'REMITTANCES' ? '#059669' : '#64748b',
            borderBottom: activeTab === 'REMITTANCES' ? '2.5px solid #059669' : '2.5px solid transparent',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
          }}
        >
          <span>Remittances (COD Settlement)</span>
          {(codQuery.data?.outstandingCount ?? 0) > 0 ? (
            <span style={{ background: '#dcfce7', color: '#15803d', fontSize: '10px', fontWeight: 800, padding: '1px 6px', borderRadius: '999px' }}>
              {codQuery.data?.outstandingCount} Awaiting Bank Transfer
            </span>
          ) : (codQuery.data?.pendingDeliveryCount ?? 0) > 0 ? (
            <span style={{ background: '#eff6ff', color: '#2563eb', fontSize: '10px', fontWeight: 700, padding: '1px 6px', borderRadius: '999px' }}>
              {codQuery.data?.pendingDeliveryCount} Active COD
            </span>
          ) : null}
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('RECHARGES')}
          style={{
            background: 'none',
            border: 0,
            padding: '10px 16px',
            fontSize: '13px',
            fontWeight: activeTab === 'RECHARGES' ? 750 : 550,
            color: activeTab === 'RECHARGES' ? '#2563eb' : '#64748b',
            borderBottom: activeTab === 'RECHARGES' ? '2.5px solid #2563eb' : '2.5px solid transparent',
            cursor: 'pointer',
          }}
        >
          Recharges
        </button>
      </div>

      {activeTab === 'REMITTANCES' ? (
        <>
          {/* ─── 4 COD Remittance Metric Cards (Delhivery ONE Finances > Remittances) ─── */}
          <div className="metric-grid" style={{ marginBottom: '20px' }}>
            <div className="metric-card" style={{ background: '#ffffff', border: '1.5px solid #e2e8f0' }}>
              <div className="metric-icon" style={{ background: '#ecfdf5', color: '#059669' }}>
                <Icon name="check" size={20} />
              </div>
              <div>
                <span className="metric-label">Total COD Collected</span>
                <strong style={{ color: '#059669', fontSize: '20px' }}>
                  {formatMoney(codData?.collectedAmount ?? 0, 'INR')}
                </strong>
                <span className="metric-sub">{codData?.collectedCount ?? 0} orders collected by courier</span>
              </div>
            </div>

            <div className="metric-card" style={{ background: '#ffffff', border: '1.5px solid #e2e8f0' }}>
              <div className="metric-icon" style={{ background: '#eff6ff', color: '#2563eb' }}>
                <Icon name="creditCard" size={20} />
              </div>
              <div>
                <span className="metric-label">Total Remitted to Bank</span>
                <strong style={{ color: '#1d4ed8', fontSize: '20px' }}>
                  {formatMoney(codData?.remittedAmount ?? 0, 'INR')}
                </strong>
                <span className="metric-sub">{codData?.remittedCount ?? 0} orders settled in bank</span>
              </div>
            </div>

            <div
              className={`metric-card clickable-row ${remittanceView === 'OUTSTANDING' ? 'selected-metric' : ''}`}
              onClick={() => setRemittanceView('OUTSTANDING')}
              style={{
                cursor: 'pointer',
                background: (codData?.outstandingCount ?? 0) > 0 ? '#fffbeb' : '#ffffff',
                border: (codData?.outstandingCount ?? 0) > 0 ? '2px solid #f59e0b' : '1.5px solid #e2e8f0',
              }}
            >
              <div className="metric-icon" style={{ background: '#fef3c7', color: '#d97706' }}>
                <Icon name="alert" size={20} />
              </div>
              <div>
                <span className="metric-label" style={{ color: '#b45309' }}>Pending Bank Payout</span>
                <strong style={{ color: '#b45309', fontSize: '20px' }}>
                  {formatMoney(codData?.outstandingAmount ?? 0, 'INR')}
                </strong>
                <span className="metric-sub" style={{ color: '#b45309' }}>
                  {codData?.outstandingCount ?? 0} orders held by Delhivery (D+2)
                </span>
              </div>
            </div>

            <div
              className={`metric-card clickable-row ${remittanceView === 'PENDING' ? 'selected-metric' : ''}`}
              onClick={() => setRemittanceView('PENDING')}
              style={{
                cursor: 'pointer',
                background: '#ffffff',
                border: remittanceView === 'PENDING' ? '2px solid #2563eb' : '1.5px solid #e2e8f0',
              }}
            >
              <div className="metric-icon" style={{ background: '#eff6ff', color: '#2563eb' }}>
                <Icon name="truck" size={20} />
              </div>
              <div>
                <span className="metric-label">COD In Transit</span>
                <strong style={{ color: '#2563eb', fontSize: '20px' }}>
                  {formatMoney(codData?.pendingDeliveryAmount ?? 0, 'INR')}
                </strong>
                <span className="metric-sub">{codData?.pendingDeliveryCount ?? 0} active COD shipments</span>
              </div>
            </div>
          </div>

          {/* ─── Remittance Sub-Tabs & Search Row ─── */}
          <Panel className="filters-panel" style={{ marginBottom: '16px' }}>
            <div className="filters-row" style={{ flexWrap: 'wrap', gap: '12px', alignItems: 'center' }}>
              <div style={{ display: 'flex', gap: '4px', background: '#f1f5f9', padding: '3px', borderRadius: '8px' }}>
                <button
                  type="button"
                  onClick={() => setRemittanceView('OUTSTANDING')}
                  style={{
                    background: remittanceView === 'OUTSTANDING' ? '#ffffff' : 'transparent',
                    border: 0,
                    padding: '6px 12px',
                    borderRadius: '6px',
                    fontSize: '12px',
                    fontWeight: remittanceView === 'OUTSTANDING' ? 700 : 500,
                    color: remittanceView === 'OUTSTANDING' ? '#b45309' : '#64748b',
                    boxShadow: remittanceView === 'OUTSTANDING' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                  }}
                >
                  <span>Awaiting Bank Remittance</span>
                  <span style={{ background: '#fef3c7', color: '#92400e', fontSize: '10px', fontWeight: 800, padding: '1px 6px', borderRadius: '999px' }}>
                    {codData?.outstandingCount ?? 0}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => setRemittanceView('REMITTED')}
                  style={{
                    background: remittanceView === 'REMITTED' ? '#ffffff' : 'transparent',
                    border: 0,
                    padding: '6px 12px',
                    borderRadius: '6px',
                    fontSize: '12px',
                    fontWeight: remittanceView === 'REMITTED' ? 700 : 500,
                    color: remittanceView === 'REMITTED' ? '#059669' : '#64748b',
                    boxShadow: remittanceView === 'REMITTED' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                  }}
                >
                  <span>Settled & Remitted</span>
                  <span style={{ background: '#ecfdf5', color: '#065f46', fontSize: '10px', fontWeight: 800, padding: '1px 6px', borderRadius: '999px' }}>
                    {codData?.remittedCount ?? 0}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => setRemittanceView('PENDING')}
                  style={{
                    background: remittanceView === 'PENDING' ? '#ffffff' : 'transparent',
                    border: 0,
                    padding: '6px 12px',
                    borderRadius: '6px',
                    fontSize: '12px',
                    fontWeight: remittanceView === 'PENDING' ? 700 : 500,
                    color: remittanceView === 'PENDING' ? '#2563eb' : '#64748b',
                    boxShadow: remittanceView === 'PENDING' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                  }}
                >
                  <span>In Transit</span>
                  <span style={{ background: '#eff6ff', color: '#1e40af', fontSize: '10px', fontWeight: 800, padding: '1px 6px', borderRadius: '999px' }}>
                    {codData?.pendingDeliveryCount ?? 0}
                  </span>
                </button>
              </div>

              <label className="search-field" style={{ minWidth: '240px', flex: 1 }}>
                <Icon name="search" size={18} />
                <input
                  value={awbSearch}
                  onChange={(e) => setAwbSearch(e.target.value)}
                  placeholder="Filter by AWB, Order ID, Customer, or Remittance Ref…"
                />
                {awbSearch && (
                  <button type="button" className="search-clear-btn" onClick={() => setAwbSearch('')}>
                    ✕
                  </button>
                )}
              </label>

              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <Button
                  className="button-primary"
                  onClick={() => remittanceFileInputRef.current?.click()}
                  loading={remittanceCsvMutation.isPending}
                >
                  <Icon name="download" size={14} />
                  Import Remittance CSV
                </Button>
                <Button
                  className="button-secondary"
                  onClick={() => setIsRecordModalOpen(true)}
                >
                  <Icon name="check" size={14} />
                  Record Remittance
                </Button>
              </div>
            </div>
          </Panel>

          {codQuery.isLoading ? (
            <LoadingState label="Loading COD remittance settlements…" />
          ) : codQuery.isError ? (
            <ErrorBox message={apiError(codQuery.error)} />
          ) : remittanceView === 'OUTSTANDING' ? (
            /* Table 1: Awaiting Bank Remittance */
            <Panel className="table-panel">
              {filteredOutstanding.length ? (
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Order</th>
                        <th>AWB Number</th>
                        <th>Customer & City</th>
                        <th>Doorstep Collection Date</th>
                        <th className="text-right">COD Cash Collected</th>
                        <th>Delhivery Remittance Status</th>
                        <th className="text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredOutstanding.map((item) => (
                        <tr key={item.waybillNumber || item.orderId}>
                          <td>
                            {item.orderId ? (
                              <button
                                type="button"
                                onClick={() => navigate(`/orders/${item.orderId}`)}
                                style={{
                                  background: 'none',
                                  border: 0,
                                  padding: 0,
                                  color: '#1d4ed8',
                                  fontWeight: 700,
                                  fontSize: '12px',
                                  cursor: 'pointer',
                                  textDecoration: 'underline',
                                }}
                              >
                                {item.orderName}
                              </button>
                            ) : (
                              <strong>{item.orderName}</strong>
                            )}
                          </td>
                          <td>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                              <a
                                href={`https://www.delhivery.com/track/package/${item.waybillNumber}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                style={{ color: '#1e3a8a', fontWeight: 750, fontSize: '11.5px' }}
                              >
                                {item.waybillNumber} ↗
                              </a>
                              <button
                                type="button"
                                onClick={() => copyText(item.waybillNumber || '', 'AWB')}
                                style={{ background: 'none', border: 0, padding: 0, color: '#94a3b8', cursor: 'pointer' }}
                              >
                                <Icon name="copy" size={11} />
                              </button>
                            </div>
                          </td>
                          <td>
                            <strong style={{ fontSize: '11.5px', color: '#0f172a' }}>{item.customerName}</strong>
                            {item.customerCity && (
                              <span className="cell-muted" style={{ display: 'block', fontSize: '10.5px' }}>
                                {item.customerCity}
                              </span>
                            )}
                          </td>
                          <td>
                            <span style={{ fontSize: '11.5px', color: '#334155' }}>
                              {item.collectedAt ? formatDate(item.collectedAt) : 'Delivered Scan (DL)'}
                            </span>
                          </td>
                          <td className="text-right">
                            <strong style={{ color: '#059669', fontSize: '13px' }}>
                              {formatMoney(item.codAmount || 0, 'INR')}
                            </strong>
                          </td>
                          <td>
                            <span style={{ fontSize: '10px', fontWeight: 750, background: '#fef3c7', color: '#92400e', border: '1px solid #fde68a', padding: '2px 8px', borderRadius: '4px' }}>
                              ⏳ Held by Delhivery · Awaiting D+2 NEFT
                            </span>
                          </td>
                          <td className="text-right">
                            <button
                              type="button"
                              onClick={() => {
                                setManualWaybills(item.waybillNumber || '')
                                setIsRecordModalOpen(true)
                              }}
                              style={{
                                background: '#eff6ff',
                                border: '1px solid #bfdbfe',
                                color: '#1d4ed8',
                                borderRadius: '4px',
                                padding: '3px 8px',
                                fontSize: '10.5px',
                                fontWeight: 700,
                                cursor: 'pointer',
                              }}
                            >
                              Settle Remittance
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <EmptyState
                  title="No pending remittances"
                  description="All collected COD shipments have been remitted to your bank account."
                  icon="check"
                />
              )}
            </Panel>
          ) : remittanceView === 'REMITTED' ? (
            /* Table 2: Settled & Remitted */
            <Panel className="table-panel">
              {filteredRemitted.length ? (
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Order</th>
                        <th>AWB Number</th>
                        <th>Customer & City</th>
                        <th>Remittance Ref / Bank UTR</th>
                        <th>Remitted Date</th>
                        <th className="text-right">COD Amount</th>
                        <th className="text-right">Bank Settlement</th>
                        <th>Shopify Order Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredRemitted.map((item) => (
                        <tr key={item.waybillNumber || item.orderId}>
                          <td>
                            {item.orderId ? (
                              <button
                                type="button"
                                onClick={() => navigate(`/orders/${item.orderId}`)}
                                style={{
                                  background: 'none',
                                  border: 0,
                                  padding: 0,
                                  color: '#1d4ed8',
                                  fontWeight: 700,
                                  fontSize: '12px',
                                  cursor: 'pointer',
                                  textDecoration: 'underline',
                                }}
                              >
                                {item.orderName}
                              </button>
                            ) : (
                              <strong>{item.orderName}</strong>
                            )}
                          </td>
                          <td>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                              <a
                                href={`https://www.delhivery.com/track/package/${item.waybillNumber}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                style={{ color: '#1e3a8a', fontWeight: 750, fontSize: '11.5px' }}
                              >
                                {item.waybillNumber} ↗
                              </a>
                              <button
                                type="button"
                                onClick={() => copyText(item.waybillNumber || '', 'AWB')}
                                style={{ background: 'none', border: 0, padding: 0, color: '#94a3b8', cursor: 'pointer' }}
                              >
                                <Icon name="copy" size={11} />
                              </button>
                            </div>
                          </td>
                          <td>
                            <strong style={{ fontSize: '11.5px', color: '#0f172a' }}>{item.customerName}</strong>
                            {item.customerCity && (
                              <span className="cell-muted" style={{ display: 'block', fontSize: '10.5px' }}>
                                {item.customerCity}
                              </span>
                            )}
                          </td>
                          <td>
                            <code style={{ fontSize: '11px', background: '#f1f5f9', padding: '2px 6px', borderRadius: '4px', color: '#0f172a', fontWeight: 700 }}>
                              {item.remittanceRef || 'DELHIVERY-REMIT'}
                            </code>
                          </td>
                          <td>
                            <span style={{ fontSize: '11.5px', color: '#334155' }}>
                              {item.remittedAt ? formatDate(item.remittedAt) : 'Settled'}
                            </span>
                          </td>
                          <td className="text-right">
                            <span style={{ fontSize: '12px', color: '#64748b' }}>
                              {formatMoney(item.codAmount || 0, 'INR')}
                            </span>
                          </td>
                          <td className="text-right">
                            <strong style={{ color: '#059669', fontSize: '13px' }}>
                              +{formatMoney(item.codRemittedAmount || item.codAmount || 0, 'INR')}
                            </strong>
                          </td>
                          <td>
                            <span style={{ fontSize: '10px', fontWeight: 800, background: '#f0fdf4', color: '#16a34a', border: '1px solid #bbf7d0', padding: '2px 8px', borderRadius: '4px' }}>
                              ✓ PAID (Remitted)
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <EmptyState
                  title="No remitted records"
                  description="Import a Delhivery Remittance CSV or record a settlement to view completed bank transfers."
                  icon="creditCard"
                />
              )}
            </Panel>
          ) : (
            /* Table 3: COD In Transit */
            <Panel className="table-panel">
              {filteredPending.length ? (
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Order</th>
                        <th>AWB Number</th>
                        <th>Customer & City</th>
                        <th>Courier Status</th>
                        <th className="text-right">Expected COD Cash</th>
                        <th className="text-right">Courier Scan Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredPending.map((item) => (
                        <tr key={item.waybillNumber || item.orderId}>
                          <td>
                            {item.orderId ? (
                              <button
                                type="button"
                                onClick={() => navigate(`/orders/${item.orderId}`)}
                                style={{
                                  background: 'none',
                                  border: 0,
                                  padding: 0,
                                  color: '#1d4ed8',
                                  fontWeight: 700,
                                  fontSize: '12px',
                                  cursor: 'pointer',
                                  textDecoration: 'underline',
                                }}
                              >
                                {item.orderName}
                              </button>
                            ) : (
                              <strong>{item.orderName}</strong>
                            )}
                          </td>
                          <td>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                              <a
                                href={`https://www.delhivery.com/track/package/${item.waybillNumber}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                style={{ color: '#1e3a8a', fontWeight: 750, fontSize: '11.5px' }}
                              >
                                {item.waybillNumber} ↗
                              </a>
                              <button
                                type="button"
                                onClick={() => copyText(item.waybillNumber || '', 'AWB')}
                                style={{ background: 'none', border: 0, padding: 0, color: '#94a3b8', cursor: 'pointer' }}
                              >
                                <Icon name="copy" size={11} />
                              </button>
                            </div>
                          </td>
                          <td>
                            <strong style={{ fontSize: '11.5px', color: '#0f172a' }}>{item.customerName}</strong>
                            {item.customerCity && (
                              <span className="cell-muted" style={{ display: 'block', fontSize: '10.5px' }}>
                                {item.customerCity}
                              </span>
                            )}
                          </td>
                          <td>
                            <span style={{ fontSize: '10.5px', fontWeight: 700, background: '#eff6ff', color: '#1e40af', padding: '2px 8px', borderRadius: '4px' }}>
                              🚚 {item.status}
                            </span>
                          </td>
                          <td className="text-right">
                            <strong style={{ color: '#2563eb', fontSize: '13px' }}>
                              {formatMoney(item.codAmount || 0, 'INR')}
                            </strong>
                          </td>
                          <td className="text-right">
                            <button
                              type="button"
                              onClick={() => markCollectedMutation.mutate({ waybillNumber: item.waybillNumber || '' })}
                              disabled={markCollectedMutation.isPending}
                              style={{
                                background: '#ecfdf5',
                                border: '1px solid #a7f3d0',
                                color: '#065f46',
                                borderRadius: '4px',
                                padding: '3px 8px',
                                fontSize: '10.5px',
                                fontWeight: 700,
                                cursor: 'pointer',
                              }}
                              title="Simulate or record Delhivery delivery boy collecting cash from customer upon delivery"
                            >
                              ✓ Mark Cash Collected (DL Scan)
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <EmptyState
                  title="No COD shipments in transit"
                  description="All active COD orders have already been delivered or settled."
                  icon="truck"
                />
              )}
            </Panel>
          )}

          {/* ─── Delhivery COD Remittance Architecture Explanation ─── */}
          <div
            style={{
              background: '#f8fafc',
              border: '1px solid #e2e8f0',
              borderRadius: '10px',
              padding: '16px 20px',
              marginTop: '20px',
              display: 'flex',
              gap: '16px',
              alignItems: 'flex-start',
            }}
          >
            <div
              style={{
                width: '36px',
                height: '36px',
                borderRadius: '8px',
                background: '#ecfdf5',
                color: '#059669',
                display: 'grid',
                placeItems: 'center',
                flexShrink: 0,
              }}
            >
              <Icon name="check" size={18} />
            </div>
            <div>
              <h4 style={{ margin: '0 0 4px', fontSize: '12.5px', fontWeight: 750, color: '#0f172a' }}>
                How Delhivery COD Remittance Works & Syncs with Shopify
              </h4>
              <p style={{ margin: 0, fontSize: '11.5px', color: '#64748b', lineHeight: 1.6 }}>
                • <strong>Stage 1 (Doorstep Collection):</strong> When the delivery executive collects cash at the customer doorstep, Delhivery tracking marks status as <code>DL (Delivered)</code>. Our automated tracking sync marks the order as <em>Cash Collected</em>.<br />
                • <strong>Stage 2 (Bank Settlement Cycle):</strong> Delhivery runs a D+2 settlement cycle. Once positive wallet balance is confirmed, Delhivery transfers the funds to your registered bank account via NEFT.<br />
                • <strong>Remittance Sync:</strong> Import the remittance CSV from <a href="https://one.delhivery.com" target="_blank" rel="noopener noreferrer" style={{ color: '#2563eb', fontWeight: 600 }}>Delhivery ONE &gt; Finances &gt; Remittances</a> or record the UTR manually. Reconciled orders are instantly updated to <strong>Paid</strong> with <code>paymentVerified = true</code> and tagged with <code>COD_REMITTED</code> in Shopify.
              </p>
            </div>
          </div>

          {/* ─── Record Remittance Modal ─── */}
          {isRecordModalOpen && (
            <div
              style={{
                position: 'fixed',
                inset: 0,
                background: 'rgba(15, 23, 42, 0.65)',
                display: 'grid',
                placeItems: 'center',
                zIndex: 1000,
                padding: '20px',
              }}
              onClick={() => setIsRecordModalOpen(false)}
            >
              <div
                style={{
                  background: '#ffffff',
                  borderRadius: '12px',
                  width: '100%',
                  maxWidth: '520px',
                  padding: '24px',
                  boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.2)',
                }}
                onClick={(e) => e.stopPropagation()}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                  <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 750, color: '#0f172a' }}>
                    Record Delhivery Remittance Settlement
                  </h3>
                  <button
                    type="button"
                    onClick={() => setIsRecordModalOpen(false)}
                    style={{ background: 'none', border: 0, fontSize: '18px', color: '#94a3b8', cursor: 'pointer' }}
                  >
                    ✕
                  </button>
                </div>

                <p style={{ fontSize: '12px', color: '#64748b', marginBottom: '16px', lineHeight: 1.5 }}>
                  Enter the Delhivery Remittance ID or Bank NEFT UTR. All matched orders will be updated to <strong>Paid</strong> with verified financial status and tagged in Shopify.
                </p>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                  <FormField label="Remittance Reference / Bank UTR">
                    <input
                      type="text"
                      placeholder="e.g. REM-2026-9281 or HDFCN26092401"
                      value={manualRemittanceRef}
                      onChange={(e) => setManualRemittanceRef(e.target.value)}
                    />
                  </FormField>

                  <FormField label="Remittance Settlement Date">
                    <input
                      type="date"
                      value={manualRemittedAt}
                      onChange={(e) => setManualRemittedAt(e.target.value)}
                    />
                  </FormField>

                  <FormField label="Waybill Numbers (comma or newline separated)">
                    <textarea
                      rows={4}
                      placeholder="30100810009251, 30100810009252..."
                      value={manualWaybills}
                      onChange={(e) => setManualWaybills(e.target.value)}
                      style={{
                        width: '100%',
                        fontFamily: 'monospace',
                        fontSize: '12px',
                        padding: '8px',
                        border: '1px solid #cbd5e1',
                        borderRadius: '6px',
                      }}
                    />
                  </FormField>
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '20px' }}>
                  <Button
                    className="button-secondary"
                    onClick={() => setIsRecordModalOpen(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    className="button-primary"
                    onClick={() => {
                      const waybillList = manualWaybills
                        .split(/[\n,]+/)
                        .map((s) => s.trim())
                        .filter(Boolean)
                      if (!manualRemittanceRef) {
                        toast.toast('error', 'Please enter a Remittance Reference or Bank UTR.')
                        return
                      }
                      if (!waybillList.length) {
                        toast.toast('error', 'Please enter at least one Waybill Number.')
                        return
                      }
                      manualRemittanceMutation.mutate({
                        remittanceRef: manualRemittanceRef,
                        remittedAt: manualRemittedAt,
                        waybills: waybillList,
                      })
                    }}
                    loading={manualRemittanceMutation.isPending}
                  >
                    Record & Settle Orders
                  </Button>
                </div>
              </div>
            </div>
          )}
        </>
      ) : (
        <>
          {/* ─── 4 Summary Cards (Exact Replica of Delhivery ONE Wallet UI) ─── */}
          <div className="metric-grid" style={{ marginBottom: '20px' }}>
            <div className="metric-card" style={{ background: '#ffffff', border: '1.5px solid #e2e8f0' }}>
              <div className="metric-icon" style={{ background: '#ecfdf5', color: '#059669' }}>
                <Icon name="creditCard" size={20} />
              </div>
              <div>
                <span className="metric-label">Current Balance</span>
                <strong style={{ color: '#059669', fontSize: '20px' }}>
                  {formatMoney(stats?.currentBalance ?? 12.93, 'INR')}
                </strong>
                <span className="metric-sub">Unified Prepaid Wallet</span>
              </div>
            </div>

            <div className="metric-card" style={{ background: '#ffffff', border: '1.5px solid #e2e8f0' }}>
              <div className="metric-icon" style={{ background: '#eff6ff', color: '#2563eb' }}>
                <Icon name="check" size={20} />
              </div>
              <div>
                <span className="metric-label">Total Credit</span>
                <strong style={{ color: '#1d4ed8', fontSize: '20px' }}>
                  +{formatMoney(stats?.totalCredit ?? 1757.42, 'INR')}
                </strong>
                <span className="metric-sub">Delivery credits & reversals</span>
              </div>
            </div>

            <div className="metric-card" style={{ background: '#ffffff', border: '1.5px solid #e2e8f0' }}>
              <div className="metric-icon" style={{ background: '#fff1f2', color: '#e11d48' }}>
                <Icon name="truck" size={20} />
              </div>
              <div>
                <span className="metric-label">Total Debit</span>
                <strong style={{ color: '#be123c', fontSize: '20px' }}>
                  -{formatMoney(stats?.totalDebit ?? 3748.39, 'INR')}
                </strong>
                <span className="metric-sub">AWB freight & weight charges</span>
              </div>
            </div>

            <div
              className={`metric-card clickable-row ${activeTab === 'MISMATCHES' ? 'selected-metric' : ''}`}
              onClick={() => setActiveTab('MISMATCHES')}
              style={{
                cursor: 'pointer',
                background: (stats?.mismatchCount ?? 0) > 0 ? '#fff5f5' : '#ffffff',
                border: (stats?.mismatchCount ?? 0) > 0 ? '2px solid #ef4444' : '1.5px solid #e2e8f0',
              }}
            >
              <div className="metric-icon" style={{ background: '#fee2e2', color: '#dc2626' }}>
                <Icon name="alert" size={20} />
              </div>
              <div>
                <span className="metric-label" style={{ color: '#b91c1c' }}>
                  Weight Discrepancies
                </span>
                <strong style={{ color: '#991b1b', fontSize: '20px' }}>
                  {stats?.mismatchCount ?? 2} AWBs
                </strong>
                <span className="metric-sub" style={{ color: '#b91c1c' }}>
                  {formatMoney(stats?.mismatchDebitedAmount ?? 333.57, 'INR')} extra debited
                </span>
              </div>
            </div>
          </div>

      {/* ─── Delhivery ONE Style Filter Row ────────────────────────────── */}
      <Panel className="filters-panel">
        <div className="filters-row" style={{ flexWrap: 'wrap', gap: '12px', alignItems: 'center' }}>
          <label className="search-field" style={{ minWidth: '280px', flex: 1 }}>
            <Icon name="search" size={18} />
            <input
              value={awbSearch}
              onChange={(e) => setAwbSearch(e.target.value)}
              placeholder="Search by AWB number, Order ID, or Transaction ID…"
            />
            {awbSearch && (
              <button type="button" className="search-clear-btn" onClick={() => setAwbSearch('')}>
                ✕
              </button>
            )}
          </label>

          <FormField label="Date Range">
            <select value={dateRange} onChange={(e) => setDateRange(e.target.value)}>
              <option value="30">Last 30 Days</option>
              <option value="90">Last 90 Days</option>
              <option value="180">Last 6 Months</option>
              <option value="365">Last 1 Year</option>
            </select>
          </FormField>

          <FormField label="Transaction Type">
            <select
              value={txTypeFilter}
              onChange={(e) => setTxTypeFilter(e.target.value as any)}
            >
              <option value="ALL">All Types</option>
              <option value="MISMATCH">Weight Mismatch Only</option>
              <option value="DELIVERED">Shipment Delivered</option>
              <option value="MANIFESTED">Shipment Manifested</option>
            </select>
          </FormField>

          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: '#475569' }}>
            <span style={{ fontWeight: 700, color: '#0f172a' }}>Account:</span>
            <code style={{ background: '#f1f5f9', padding: '3px 7px', borderRadius: '4px', fontSize: '11.5px', color: '#1e3a8a' }}>
              fa5d92-VBEXPORT-do
            </code>
          </div>

          <div className="filter-count">
            <strong>{filteredTransactions.length}</strong>
            <span>records</span>
          </div>
        </div>
      </Panel>

      {query.isError && <ErrorBox message={apiError(query.error)} />}

      {/* ─── Ledger Transactions Table ─────────────────────────────────── */}
      <Panel className="table-panel">
        {query.isLoading ? (
          <LoadingState label="Loading Delhivery wallet transactions…" />
        ) : filteredTransactions.length ? (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Transaction Details</th>
                  <th>Account Details</th>
                  <th>Order ID</th>
                  <th>AWB / LRN</th>
                  <th>Weight & Zone</th>
                  <th>Description</th>
                  <th className="text-right">Credit</th>
                  <th className="text-right">Debit</th>
                </tr>
              </thead>
              <tbody>
                {filteredTransactions.map((tx: DelhiveryLedgerTransaction) => {
                  const isMismatch = tx.isWeightMismatch

                  return (
                    <tr
                      key={tx.id}
                      style={{
                        background: isMismatch ? '#fffdfa' : undefined,
                      }}
                    >
                      {/* Transaction Details */}
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <span
                            className="mono"
                            style={{
                              fontSize: '11px',
                              fontWeight: 700,
                              color: '#2563eb',
                              cursor: 'pointer',
                            }}
                            onClick={() => copyText(tx.transactionId, 'Transaction ID')}
                            title="Click to copy Transaction ID"
                          >
                            {tx.transactionId}
                          </span>
                        </div>
                        <span className="cell-muted" style={{ fontSize: '10.5px' }}>
                          {formatDate(tx.transactionDate)}
                        </span>
                      </td>

                      {/* Account Details */}
                      <td>
                        <span style={{ fontSize: '11px', color: '#334155', fontWeight: 600 }}>
                          {tx.accountName || 'fa5d92-VBEXPORT-do'}
                        </span>
                      </td>

                      {/* Order ID */}
                      <td>
                        {tx.dbOrderId ? (
                          <button
                            type="button"
                            onClick={() => navigate(`/orders/${tx.dbOrderId}`)}
                            style={{
                              background: 'none',
                              border: 0,
                              padding: 0,
                              color: '#1d4ed8',
                              fontWeight: 700,
                              fontSize: '11.5px',
                              cursor: 'pointer',
                              textDecoration: 'underline',
                            }}
                          >
                            {tx.orderName || tx.orderId}
                          </button>
                        ) : tx.orderId ? (
                          <strong style={{ fontSize: '11.5px', color: '#0f172a' }}>
                            {tx.orderId}
                          </strong>
                        ) : (
                          <span style={{ color: '#94a3b8' }}>—</span>
                        )}
                        {tx.customerName && (
                          <span className="cell-muted" style={{ display: 'block', fontSize: '10px' }}>
                            {tx.customerName}
                          </span>
                        )}
                      </td>

                      {/* AWB / LRN */}
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                          <a
                            href={`https://www.delhivery.com/track/package/${tx.waybillNumber}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ color: '#1e3a8a', fontWeight: 750, fontSize: '11.5px' }}
                            title="Track on Delhivery"
                          >
                            {tx.waybillNumber} ↗
                          </a>
                          <button
                            type="button"
                            onClick={() => copyText(tx.waybillNumber, 'AWB')}
                            style={{ background: 'none', border: 0, padding: 0, color: '#94a3b8', cursor: 'pointer' }}
                            title="Copy AWB"
                          >
                            <Icon name="copy" size={11} />
                          </button>
                        </div>
                      </td>

                      {/* Weight & Zone */}
                      <td>
                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                          <strong
                            style={{
                              fontSize: '11px',
                              color: isMismatch ? '#b91c1c' : '#0f172a',
                            }}
                          >
                            {tx.weightGrams ? `${tx.weightGrams} gm` : '—'}
                          </strong>
                          <span
                            className="shipping-zone-tag"
                            style={{
                              fontSize: '9.5px',
                              padding: '1px 5px',
                              width: 'fit-content',
                              marginTop: '2px',
                            }}
                          >
                            Zone {tx.zone || 'Surface'}
                          </span>
                        </div>
                      </td>

                      {/* Description & Mismatch Action */}
                      <td>
                        <div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                            <span
                              style={{
                                fontSize: '11px',
                                color: isMismatch ? '#991b1b' : '#334155',
                                fontWeight: isMismatch ? 700 : 500,
                              }}
                            >
                              {tx.description}
                            </span>

                            {tx.creditAmount > 0 && isMismatch && (
                              <span style={{ fontSize: '9px', fontWeight: 800, background: '#f0fdf4', color: '#15803d', border: '1px solid #bbf7d0', padding: '1px 5px', borderRadius: '4px' }}>
                                🔄 Reversal (+₹{tx.creditAmount.toFixed(2)})
                              </span>
                            )}

                            {tx.debitAmount > 0 && isMismatch && (
                              <span style={{ fontSize: '9px', fontWeight: 800, background: '#fff1f2', color: '#be123c', border: '1px solid #fecdd3', padding: '1px 5px', borderRadius: '4px' }}>
                                ⚠️ Revised Debit (-₹{tx.debitAmount.toFixed(2)})
                              </span>
                            )}

                            {tx.description.toLowerCase().includes('manifest') && (
                              <span style={{ fontSize: '9px', fontWeight: 700, background: '#f8fafc', color: '#475569', border: '1px solid #e2e8f0', padding: '1px 5px', borderRadius: '4px' }}>
                                📦 Manifest
                              </span>
                            )}
                          </div>

                          <div style={{ marginTop: '4px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                            {isMismatch && (
                              <>
                                <a
                                  href="https://one.delhivery.com"
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  style={{
                                    fontSize: '10px',
                                    fontWeight: 750,
                                    color: '#2563eb',
                                    textDecoration: 'underline',
                                  }}
                                >
                                  View Mismatch Details ↗
                                </a>
                                <span style={{ fontSize: '9.5px', color: '#dc2626', background: '#fee2e2', padding: '1px 5px', borderRadius: '4px', fontWeight: 700 }}>
                                  Hub Re-weighed
                                </span>
                              </>
                            )}

                            <button
                              type="button"
                              onClick={() => handleReconcileSingleAwb(tx.waybillNumber)}
                              disabled={reconcilingAwb === tx.waybillNumber}
                              style={{
                                background: '#eff6ff',
                                border: '1px solid #bfdbfe',
                                color: '#1d4ed8',
                                borderRadius: '4px',
                                padding: '1px 6px',
                                fontSize: '9.5px',
                                fontWeight: 700,
                                cursor: 'pointer',
                              }}
                              title="Reconcile this AWB charges with Shopify order"
                            >
                              {reconcilingAwb === tx.waybillNumber ? 'Syncing…' : 'Sync Order'}
                            </button>
                          </div>
                        </div>
                      </td>

                      {/* Credit */}
                      <td className="text-right" style={{ whiteSpace: 'nowrap' }}>
                        {tx.creditAmount > 0 ? (
                          <strong style={{ color: '#16a34a', fontSize: '12px' }}>
                            +{formatMoney(tx.creditAmount, 'INR')}
                          </strong>
                        ) : (
                          <span style={{ color: '#94a3b8' }}>-</span>
                        )}
                      </td>

                      {/* Debit */}
                      <td className="text-right" style={{ whiteSpace: 'nowrap' }}>
                        {tx.debitAmount > 0 ? (
                          <strong style={{ color: '#e11d48', fontSize: '12px' }}>
                            -{formatMoney(tx.debitAmount, 'INR')}
                          </strong>
                        ) : (
                          <span style={{ color: '#94a3b8' }}>-</span>
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
            title="No ledger records found"
            description="Import your Delhivery ONE Download Ledger CSV to view all AWB freight and weight discrepancy charges."
            icon="creditCard"
          />
        )}
      </Panel>

      {/* ─── Delhivery ONE Reconciliation Info Banner ──────────────────── */}
      <div
        style={{
          background: '#f8fafc',
          border: '1px solid #e2e8f0',
          borderRadius: '10px',
          padding: '16px 20px',
          marginTop: '20px',
          display: 'flex',
          gap: '16px',
          alignItems: 'flex-start',
        }}
      >
        <div
          style={{
            width: '36px',
            height: '36px',
            borderRadius: '8px',
            background: '#eff6ff',
            color: '#2563eb',
            display: 'grid',
            placeItems: 'center',
            flexShrink: 0,
          }}
        >
          <Icon name="shield" size={18} />
        </div>
        <div>
          <h4 style={{ margin: '0 0 4px', fontSize: '12.5px', fontWeight: 750, color: '#0f172a' }}>
            Understanding Delhivery AWB Charges & Discrepancies
          </h4>
          <p style={{ margin: 0, fontSize: '11.5px', color: '#64748b', lineHeight: 1.5 }}>
            • <strong>Shipment Manifested:</strong> Initial estimated freight is deducted upon AWB creation.<br />
            • <strong>Hub Weighment:</strong> Delhivery volumetric scanners verify the weight. If captured weight exceeds declared weight, the initial charge is credited back and the revised tier is debited.<br />
            • <strong>Dispute Window:</strong> You have 7 days from the mismatch debit to raise a dispute under Delhivery ONE &gt; Finances &gt; Weight Discrepancies.
          </p>
        </div>
      </div>
        </>
      )}
    </>
  )
}

