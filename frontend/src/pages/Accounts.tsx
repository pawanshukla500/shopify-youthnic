import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  apiError,
  downloadAccountsReport,
  downloadTallyXml,
  downloadTallyMastersXml,
  emailAccountsReport,
  getAccountsOverview,
  getStateMonthlyAccounting,
  getTrialBalance,
  getJournalVouchers,
  getClosingHistory,
  closeMonthNow,
  getBankStatementLines,
  getGatewayBatches,
  getFreightBills,
  importAccountsFile,
  runAccountsNow,
  saveAccountsRecipients,
  type AccountsImportKind,
  type AccountsImportResult,
} from '../api'
import {
  Button,
  ErrorBox,
  FormField,
  Icon,
  LoadingState,
  PageIntro,
  Panel,
  PanelHeading,
  useDocumentTitle,
  useToast,
} from '../components/UI'
import { formatDate, formatMoney } from '../lib'

function defaultMonth(): string {
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000)
  const year = ist.getUTCMonth() === 0 ? ist.getUTCFullYear() - 1 : ist.getUTCFullYear()
  const month = ist.getUTCMonth() === 0 ? 12 : ist.getUTCMonth()
  return `${year}-${String(month).padStart(2, '0')}`
}

function nextReportDate(month: string, day: number): string {
  const [year, m] = month.split('-').map(Number)
  const next = new Date(Date.UTC(m === 12 ? year + 1 : year, m === 12 ? 0 : m, day))
  return next.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
}

type AccountsTab = 'matrix' | 'gateway' | 'freight' | 'bank' | 'pnl' | 'ledger' | 'vouchers' | 'closing'

const UPLOADS: Array<{
  kind: AccountsImportKind
  title: string
  what: string
  where: string
  withRemittanceFields?: boolean
}> = [
  {
    kind: 'DELHIVERY_REMITTANCE',
    title: 'Delhivery COD remittance',
    what: 'Marks Delhivery COD orders as paid into the bank, with the UTR.',
    where: 'Delhivery One → Finances → Remittance → open a remittance → download the AWB list (.xlsx or .csv).',
    withRemittanceFields: true,
  },
  {
    kind: 'VELOCITY_REMITTANCE',
    title: 'Velocity COD remittance',
    what: 'Marks Velocity COD orders as paid into the bank with UTR.',
    where: 'Velocity Shipping Dashboard → Remittances → download remittance details.',
    withRemittanceFields: true,
  },
  {
    kind: 'DELHIVERY_CHARGES',
    title: 'Delhivery shipping charges',
    what: 'Replaces estimated shipping with actual billed freight: forward, RTO and reverse pickup.',
    where: 'Delhivery One → Finances → Wallet → Transactions → Download Ledger.',
  },
  {
    kind: 'PG_SETTLEMENT',
    title: 'Prepaid settlement & Bank Statement',
    what: 'Reconciles Easebuzz, PhonePe & GoKwik settlements with bank statement lines.',
    where: 'Gateway dashboard → Settlements or Net Banking Statement (.csv / .xlsx).',
  },
]

function UploadCard({ upload, onDone }: { upload: (typeof UPLOADS)[number]; onDone: () => void }) {
  const toast = useToast()
  const [file, setFile] = useState<File | null>(null)
  const [utr, setUtr] = useState('')
  const [remittanceRef, setRemittanceRef] = useState('')
  const [remittedAt, setRemittedAt] = useState('')
  const [result, setResult] = useState<AccountsImportResult | null>(null)

  const mutation = useMutation({
    mutationFn: () => {
      if (!file) throw new Error('Choose a file first.')
      return importAccountsFile(
        upload.kind,
        file,
        upload.withRemittanceFields ? { utr: utr.trim() || undefined, remittanceRef: remittanceRef.trim() || undefined, remittedAt: remittedAt || undefined } : undefined
      )
    },
    onSuccess: (data) => {
      setResult(data)
      toast.toast(
        data.matchedCount > 0 ? 'success' : 'error',
        `${upload.title}: ${data.matchedCount} of ${data.rowCount} rows matched${data.closedNow ? ` · ${data.closedNow} order(s) moved to Payment Received` : ''}.`
      )
      onDone()
    },
    onError: (error) => toast.toast('error', apiError(error)),
  })

  return (
    <Panel style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div>
        <h3 style={{ margin: 0, fontSize: '15px' }}>{upload.title}</h3>
        <p style={{ margin: '4px 0 0', fontSize: '12px', color: 'var(--muted)' }}>{upload.what}</p>
        <p style={{ margin: '6px 0 0', fontSize: '11px', color: 'var(--muted)' }}>
          <strong>Source:</strong> {upload.where}
        </p>
      </div>

      <input
        type="file"
        accept=".csv,.xlsx,.xls"
        onChange={(e) => setFile(e.target.files?.[0] || null)}
        style={{ fontSize: '13px' }}
      />

      {upload.withRemittanceFields && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
          <FormField label="Bank UTR" hint="Optional if inside file">
            <input value={utr} onChange={(e) => setUtr(e.target.value)} placeholder="e.g. 427218392182" />
          </FormField>
          <FormField label="Remittance Ref" hint="Optional">
            <input value={remittanceRef} onChange={(e) => setRemittanceRef(e.target.value)} placeholder="e.g. REMIT-1234" />
          </FormField>
        </div>
      )}

      <Button
        className="button-primary button-small"
        loading={mutation.isPending}
        disabled={!file}
        onClick={() => mutation.mutate()}
      >
        Upload &amp; Reconcile
      </Button>

      {result && (
        <div style={{ fontSize: '12px', background: 'var(--bg-subtle, rgba(0,0,0,0.02))', padding: '8px', borderRadius: '6px' }}>
          Matched: <strong>{result.matchedCount}</strong> / {result.rowCount} rows
          {result.unmatched && result.unmatched.length > 0 && (
            <span style={{ color: 'var(--muted)', display: 'block', marginTop: '2px' }}>
              Unmatched: {result.unmatched.slice(0, 3).join(', ')}{result.unmatched.length > 3 ? '…' : ''}
            </span>
          )}
        </div>
      )}
    </Panel>
  )
}

export default function AccountsPage() {
  useDocumentTitle('Payments & Accounts (Tally ERP)')
  const toast = useToast()
  const queryClient = useQueryClient()
  const [month, setMonth] = useState(defaultMonth)
  const [activeTab, setActiveTab] = useState<AccountsTab>('matrix')

  const overview = useQuery({
    queryKey: ['accounts-overview', month],
    queryFn: () => getAccountsOverview(month),
  })

  const stateAccounting = useQuery({
    queryKey: ['state-monthly-accounting', month],
    queryFn: () => getStateMonthlyAccounting(month),
  })

  const trialBalanceQuery = useQuery({
    queryKey: ['trial-balance', month],
    queryFn: () => getTrialBalance(month),
    enabled: activeTab === 'ledger' || activeTab === 'pnl',
  })

  const vouchersQuery = useQuery({
    queryKey: ['journal-vouchers', month],
    queryFn: () => getJournalVouchers(month),
    enabled: activeTab === 'vouchers',
  })

  const closingHistoryQuery = useQuery({
    queryKey: ['closing-history'],
    queryFn: getClosingHistory,
    enabled: activeTab === 'closing',
  })

  const bankLinesQuery = useQuery({
    queryKey: ['bank-statement-lines'],
    queryFn: () => getBankStatementLines(50),
    enabled: activeTab === 'bank',
  })

  const gatewayBatchesQuery = useQuery({
    queryKey: ['gateway-batches'],
    queryFn: getGatewayBatches,
    enabled: activeTab === 'gateway',
  })

  const freightBillsQuery = useQuery({
    queryKey: ['freight-bills'],
    queryFn: getFreightBills,
    enabled: activeTab === 'freight',
  })

  const [recipients, setRecipients] = useState('')
  const [ccRecipients, setCcRecipients] = useState('')

  useEffect(() => {
    if (stateAccounting.data?.recipients) {
      setRecipients(stateAccounting.data.recipients.to.join(', '))
      setCcRecipients(stateAccounting.data.recipients.cc.join(', '))
    }
  }, [stateAccounting.data?.recipients])

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['accounts-overview'] })
    queryClient.invalidateQueries({ queryKey: ['state-monthly-accounting'] })
    queryClient.invalidateQueries({ queryKey: ['trial-balance'] })
    queryClient.invalidateQueries({ queryKey: ['journal-vouchers'] })
    queryClient.invalidateQueries({ queryKey: ['closing-history'] })
    queryClient.invalidateQueries({ queryKey: ['bank-statement-lines'] })
    queryClient.invalidateQueries({ queryKey: ['gateway-batches'] })
    queryClient.invalidateQueries({ queryKey: ['freight-bills'] })
  }

  const downloadExcel = useMutation({
    mutationFn: () => downloadAccountsReport(month),
    onSuccess: () => toast.toast('success', `Tally Excel report for ${month} downloaded.`),
    onError: (error) => toast.toast('error', apiError(error)),
  })

  const downloadXml = useMutation({
    mutationFn: () => downloadTallyXml(month),
    onSuccess: () => toast.toast('success', `TallyPrime XML voucher file for ${month} downloaded.`),
    onError: (error) => toast.toast('error', apiError(error)),
  })

  const downloadMasters = useMutation({
    mutationFn: () => downloadTallyMastersXml(),
    onSuccess: () => toast.toast('success', 'Tally Masters XML downloaded successfully.'),
    onError: (error) => toast.toast('error', apiError(error)),
  })

  const email = useMutation({
    mutationFn: () => emailAccountsReport(month, recipients, ccRecipients),
    onSuccess: (data) => {
      toast.toast('success', `Tally report emailed to ${data.sentTo.join(', ')}${data.ccTo?.length ? ` (CC: ${data.ccTo.join(', ')})` : ''}.`)
      refresh()
    },
    onError: (error) => toast.toast('error', apiError(error)),
  })

  const saveRecipientsMutation = useMutation({
    mutationFn: () => saveAccountsRecipients(recipients, ccRecipients),
    onSuccess: (data) => {
      toast.toast('success', `Recipients updated: To: ${data.recipients.join(', ')} · CC: ${data.ccRecipients?.join(', ') || 'None'}`)
      refresh()
    },
    onError: (error) => toast.toast('error', apiError(error)),
  })

  const closeMonthMutation = useMutation({
    mutationFn: () => closeMonthNow(month, false),
    onSuccess: (data) => {
      toast.toast('success', `Month ${data.period} closed! Net Sales: ₹${data.netSales}, Net Bank: ₹${data.netBankReceipts}.`)
      refresh()
    },
    onError: (error) => toast.toast('error', apiError(error)),
  })

  const runNow = useMutation({
    mutationFn: runAccountsNow,
    onSuccess: (data) => {
      toast.toast('success', `${data.closed} order(s) moved to Payment Received · ${data.shippingEstimates} shipping estimate(s) fetched.`)
      refresh()
    },
    onError: (error) => toast.toast('error', apiError(error)),
  })

  const stateData = stateAccounting.data
  const tbData = trialBalanceQuery.data

  const tabs: Array<{ key: AccountsTab; label: string; icon: any }> = [
    { key: 'matrix', label: 'State-Wise Matrix', icon: 'table' },
    { key: 'gateway', label: 'Gateway Expenses', icon: 'credit-card' },
    { key: 'freight', label: 'Freight Expenses', icon: 'truck' },
    { key: 'bank', label: 'Bank & UTR Reconcile', icon: 'check-circle' },
    { key: 'pnl', label: 'Monthly P&L', icon: 'pie-chart' },
    { key: 'ledger', label: 'Trial Balance', icon: 'file-text' },
    { key: 'vouchers', label: 'Tally Vouchers', icon: 'download' },
    { key: 'closing', label: 'Closing Snapshots', icon: 'lock' },
  ]

  const tiles = stateData ? [
    { label: 'Orders placed', value: stateData.totals.totalOrders, tone: 'var(--ink)' },
    { label: 'Opening balance (B/F)', value: formatMoney(stateData.totals.openingBalance || 0), tone: '#64748b' },
    { label: 'Gross sales in period', value: formatMoney(stateData.totals.grossSales), tone: '#1e293b' },
    { label: 'Returns deducted', value: `-${formatMoney(stateData.totals.returnsDeducted)}`, tone: '#dc2626' },
    { label: 'Net period sales', value: formatMoney(stateData.totals.netSales), tone: '#0f766e' },
    { label: 'Received in bank', value: formatMoney(stateData.totals.paymentReceived), tone: '#1d4ed8' },
    { label: 'Closing balance (C/F)', value: formatMoney(stateData.totals.closingBalance !== undefined ? stateData.totals.closingBalance : stateData.totals.outstanding), tone: (stateData.totals.closingBalance !== undefined ? stateData.totals.closingBalance : stateData.totals.outstanding) > 0 ? '#b91c1c' : '#15803d' },
  ] : []

  return (
    <>
      <PageIntro
        eyebrow="Financial Operations & Tally ERP"
        title="Youthnic Accounting & Reconciliation"
        description="Double-entry financial ledger, dynamic GST, GoKwik/Easebuzz & PhonePe MDR expenses, Delhivery & Velocity freight, and official TallyPrime integration."
        action={
          <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <FormField label="Accounting month">
              <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
            </FormField>
            <Button className="button-secondary" loading={downloadMasters.isPending} onClick={() => downloadMasters.mutate()}>
              <Icon name="download" size={14} />
              Tally Masters
            </Button>
            <Button className="button-primary" loading={downloadXml.isPending} onClick={() => downloadXml.mutate()}>
              <Icon name="download" size={14} />
              TallyPrime XML
            </Button>
            <Button className="button-secondary" loading={downloadExcel.isPending} onClick={() => downloadExcel.mutate()}>
              <Icon name="download" size={14} />
              Tally Excel (8 Sheets)
            </Button>
            <Button className="button-secondary" loading={email.isPending} onClick={() => email.mutate()}>
              <Icon name="mail" size={14} />
              Email Report
            </Button>
            <Button className="button-primary" style={{ background: '#059669' }} loading={closeMonthMutation.isPending} onClick={() => closeMonthMutation.mutate()}>
              <Icon name="check" size={14} />
              Close Month
            </Button>
          </div>
        }
      />

      {/* KPI Header Tiles */}
      {tiles.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '12px', marginBottom: '16px' }}>
          {tiles.map((tile) => (
            <div key={tile.label} style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: '10px', padding: '14px 16px' }}>
              <span style={{ fontSize: '11px', color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase' }}>{tile.label}</span>
              <strong className="tabular-nums" style={{ display: 'block', fontSize: '19px', color: tile.tone, fontWeight: 800, marginTop: '4px' }}>
                {tile.value}
              </strong>
            </div>
          ))}
        </div>
      )}

      {/* Tab Navigation */}
      <div style={{ display: 'flex', gap: '4px', borderBottom: '2px solid var(--line)', marginBottom: '20px', overflowX: 'auto' }}>
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setActiveTab(t.key)}
            style={{
              padding: '10px 16px',
              border: 'none',
              background: 'none',
              cursor: 'pointer',
              fontWeight: activeTab === t.key ? 700 : 500,
              fontSize: '13px',
              color: activeTab === t.key ? '#2563eb' : 'var(--muted)',
              borderBottom: activeTab === t.key ? '2px solid #2563eb' : '2px solid transparent',
              marginBottom: '-2px',
              whiteSpace: 'nowrap',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {(overview.isLoading || stateAccounting.isLoading) && <LoadingState label="Loading accounting ledger…" />}
      {(overview.isError || stateAccounting.isError) && <ErrorBox message={apiError(overview.error || stateAccounting.error)} />}

      {/* TAB 1: State-Wise Matrix */}
      {activeTab === 'matrix' && stateData && (
        <Panel className="table-panel" style={{ marginBottom: '20px', border: '1px solid var(--accent, #3b82f6)' }}>
          <PanelHeading
            eyebrow="Tally ERP Ledger Matrix with Carry Forward & Dynamic GST"
            title={`State-Wise Sales, Returns & Settlement (${stateData.label})`}
          />
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>State</th>
                  <th style={{ textAlign: 'center' }}>GST POS</th>
                  <th style={{ textAlign: 'center' }}>Orders</th>
                  <th style={{ textAlign: 'right' }}>Opening (B/F)</th>
                  <th style={{ textAlign: 'right' }}>Gross Sales</th>
                  <th style={{ textAlign: 'right' }}>Taxable</th>
                  <th style={{ textAlign: 'right' }}>Output GST</th>
                  <th style={{ textAlign: 'right' }}>Returns</th>
                  <th style={{ textAlign: 'right' }}>Net Sales</th>
                  <th style={{ textAlign: 'right' }}>Payment Received</th>
                  <th style={{ textAlign: 'right' }}>Closing (C/F)</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {stateData.states.map((s) => {
                  const closing = s.closingBalance !== undefined ? s.closingBalance : s.outstanding
                  return (
                    <tr key={s.state}>
                      <td><strong>{s.state}</strong></td>
                      <td style={{ textAlign: 'center', fontSize: '12px', color: 'var(--muted)' }}>{s.gstStateCode || '—'}</td>
                      <td style={{ textAlign: 'center' }}>{s.orderCount}</td>
                      <td className="amount-cell" style={{ color: 'var(--muted)' }}>{formatMoney(s.openingBalance || 0)}</td>
                      <td className="amount-cell">{formatMoney(s.grossSales)}</td>
                      <td className="amount-cell">{formatMoney(s.taxableSales || 0)}</td>
                      <td className="amount-cell">{formatMoney(s.gstAmount || 0)}</td>
                      <td className="amount-cell" style={{ color: s.returnsDeducted > 0 ? '#dc2626' : 'inherit' }}>
                        {s.returnsDeducted > 0 ? `-${formatMoney(s.returnsDeducted)}` : '₹0.00'}
                      </td>
                      <td className="amount-cell" style={{ fontWeight: 700 }}>{formatMoney(s.netSales)}</td>
                      <td className="amount-cell" style={{ color: '#16a34a' }}>{formatMoney(s.paymentReceived)}</td>
                      <td className="amount-cell" style={{ fontWeight: 700, color: closing > 0 ? '#b91c1c' : '#15803d' }}>
                        {formatMoney(closing)}
                      </td>
                      <td style={{ fontSize: '12px' }}>
                        {Math.abs(closing) <= 0.05 ? <span style={{ color: '#15803d', fontWeight: 600 }}>Settled</span> : <span style={{ color: '#b91c1c' }}>Carried Fwd</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {/* TAB 2: Gateway Expenses */}
      {activeTab === 'gateway' && (
        <Panel className="table-panel">
          <PanelHeading eyebrow="Payment Processing Deductions" title="Easebuzz, GoKwik & PhonePe Settlement Batches" />
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Batch ID</th>
                  <th>Gateway</th>
                  <th>Settlement Date</th>
                  <th style={{ textAlign: 'right' }}>Gross Collection</th>
                  <th style={{ textAlign: 'right' }}>MDR Fee</th>
                  <th style={{ textAlign: 'right' }}>Input GST (18%)</th>
                  <th style={{ textAlign: 'right' }}>Net Bank Credit</th>
                  <th>Bank UTR</th>
                  <th>Verification</th>
                </tr>
              </thead>
              <tbody>
                {gatewayBatchesQuery.data && gatewayBatchesQuery.data.length > 0 ? (
                  gatewayBatchesQuery.data.map((b: any) => (
                    <tr key={b.id}>
                      <td><code>{b.batchId}</code></td>
                      <td><strong>{b.gateway}</strong></td>
                      <td>{formatDate(b.settlementDate)}</td>
                      <td className="amount-cell">{formatMoney(Number(b.grossAmount))}</td>
                      <td className="amount-cell" style={{ color: '#dc2626' }}>{formatMoney(Number(b.feeAmount))}</td>
                      <td className="amount-cell">{formatMoney(Number(b.gstAmount))}</td>
                      <td className="amount-cell" style={{ color: '#16a34a', fontWeight: 700 }}>{formatMoney(Number(b.netAmount))}</td>
                      <td><code>{b.bankUtr || '—'}</code></td>
                      <td>
                        <span style={{ color: b.verificationStatus === 'VERIFIED' ? '#15803d' : '#b45309', fontWeight: 600, fontSize: '12px' }}>
                          {b.verificationStatus}
                        </span>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr><td colSpan={9} style={{ textAlign: 'center', color: 'var(--muted)' }}>No settlement batches recorded yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {/* TAB 3: Freight Expenses */}
      {activeTab === 'freight' && (
        <Panel className="table-panel">
          <PanelHeading eyebrow="Logistics Invoicing" title="Delhivery & Velocity Freight Invoices" />
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Invoice No</th>
                  <th>Carrier</th>
                  <th>Period</th>
                  <th style={{ textAlign: 'right' }}>Forward Freight</th>
                  <th style={{ textAlign: 'right' }}>RTO Freight</th>
                  <th style={{ textAlign: 'right' }}>Reverse Freight</th>
                  <th style={{ textAlign: 'right' }}>Surcharges</th>
                  <th style={{ textAlign: 'right' }}>Input GST</th>
                  <th style={{ textAlign: 'right' }}>Total Billed</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {freightBillsQuery.data && freightBillsQuery.data.length > 0 ? (
                  freightBillsQuery.data.map((f: any) => (
                    <tr key={f.id}>
                      <td><code>{f.invoiceNumber}</code></td>
                      <td><strong>{f.carrier}</strong></td>
                      <td>{f.period}</td>
                      <td className="amount-cell">{formatMoney(Number(f.forwardFreight))}</td>
                      <td className="amount-cell">{formatMoney(Number(f.rtoFreight))}</td>
                      <td className="amount-cell">{formatMoney(Number(f.reverseFreight))}</td>
                      <td className="amount-cell">{formatMoney(Number(f.surcharges))}</td>
                      <td className="amount-cell">{formatMoney(Number(f.gstAmount))}</td>
                      <td className="amount-cell" style={{ fontWeight: 700, color: '#dc2626' }}>{formatMoney(Number(f.totalBilled))}</td>
                      <td><span style={{ color: '#15803d', fontWeight: 600, fontSize: '12px' }}>{f.reconciliationStatus}</span></td>
                    </tr>
                  ))
                ) : (
                  <tr><td colSpan={10} style={{ textAlign: 'center', color: 'var(--muted)' }}>No freight invoices recorded yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {/* TAB 4: Bank Statement Reconciliation */}
      {activeTab === 'bank' && (
        <Panel className="table-panel">
          <PanelHeading eyebrow="Authorized Bank Statements" title="Bank Credit & UTR Verification Lines" />
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Bank / Statement</th>
                  <th>Description</th>
                  <th>Reference / UTR</th>
                  <th style={{ textAlign: 'right' }}>Credit (Deposit)</th>
                  <th>Match Status</th>
                  <th>Matched Ref</th>
                </tr>
              </thead>
              <tbody>
                {bankLinesQuery.data && bankLinesQuery.data.length > 0 ? (
                  bankLinesQuery.data.map((l: any) => (
                    <tr key={l.id}>
                      <td>{formatDate(l.transactionDate)}</td>
                      <td>{l.statement?.bankName || 'HDFC Bank'}</td>
                      <td style={{ fontSize: '12px', maxWidth: '300px' }}>{l.description}</td>
                      <td><code>{l.referenceNo || '—'}</code></td>
                      <td className="amount-cell" style={{ color: '#16a34a', fontWeight: 700 }}>{formatMoney(Number(l.credit))}</td>
                      <td>
                        <span style={{
                          color: l.status === 'VERIFIED' ? '#15803d' : (l.status === 'AMOUNT_MISMATCH' ? '#dc2626' : '#64748b'),
                          fontWeight: 600,
                          fontSize: '12px',
                        }}>
                          {l.status}
                        </span>
                      </td>
                      <td><code>{l.matchedRef || '—'}</code></td>
                    </tr>
                  ))
                ) : (
                  <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--muted)' }}>No bank statement lines uploaded yet. Upload statement in Bring In Payments section below.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {/* TAB 5: Monthly P&L */}
      {activeTab === 'pnl' && tbData && (
        <Panel style={{ padding: '24px' }}>
          <PanelHeading eyebrow="Operating Statement" title={`Monthly Profit & Loss (${month})`} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px', marginTop: '16px' }}>
            <div style={{ border: '1px solid var(--line)', borderRadius: '8px', padding: '16px' }}>
              <h4 style={{ margin: '0 0 12px', color: '#15803d' }}>Income &amp; Net Turnover</h4>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
                <span>Gross Apparel Sales</span>
                <strong>{formatMoney(stateData?.totals.grossSales || 0)}</strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--line)', color: '#dc2626' }}>
                <span>Less: Sales Returns &amp; Credit Notes</span>
                <strong>-{formatMoney(stateData?.totals.returnsDeducted || 0)}</strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', fontWeight: 800, fontSize: '15px' }}>
                <span>Net Operating Turnover</span>
                <span>{formatMoney(stateData?.totals.netSales || 0)}</span>
              </div>
            </div>

            <div style={{ border: '1px solid var(--line)', borderRadius: '8px', padding: '16px' }}>
              <h4 style={{ margin: '0 0 12px', color: '#b91c1c' }}>Direct Operational Expenses</h4>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
                <span>Gateway Processing Fees (Easebuzz/GoKwik/PhonePe)</span>
                <strong>{formatMoney(tbData.rows.filter(r => r.accountCode.startsWith('EXPENSE_PG')).reduce((a, b) => a + b.periodDebit, 0))}</strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
                <span>Logistics &amp; Freight (Delhivery/Velocity)</span>
                <strong>{formatMoney(tbData.rows.filter(r => r.accountCode.startsWith('EXPENSE_FREIGHT')).reduce((a, b) => a + b.periodDebit, 0))}</strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', fontWeight: 800, fontSize: '15px', color: '#b91c1c' }}>
                <span>Total Operational Deductions</span>
                <span>{formatMoney(tbData.rows.filter(r => r.accountType === 'EXPENSE').reduce((a, b) => a + b.periodDebit, 0))}</span>
              </div>
            </div>
          </div>
        </Panel>
      )}

      {/* TAB 6: Trial Balance */}
      {activeTab === 'ledger' && tbData && (
        <Panel className="table-panel">
          <PanelHeading
            eyebrow="Double-Entry Financial Accounting"
            title={`General Ledger Trial Balance (${month})`}
            action={
              <span style={{ fontSize: '13px', fontWeight: 700, color: tbData.isBalanced ? '#15803d' : '#dc2626' }}>
                {tbData.isBalanced ? '✓ Balanced (Total Debits == Total Credits)' : '⚠ Imbalanced'}
              </span>
            }
          />
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Account Code</th>
                  <th>Account Name</th>
                  <th>Classification</th>
                  <th style={{ textAlign: 'right' }}>Period Debit (₹)</th>
                  <th style={{ textAlign: 'right' }}>Period Credit (₹)</th>
                  <th style={{ textAlign: 'right' }}>Closing Balance</th>
                </tr>
              </thead>
              <tbody>
                {tbData.rows.map((row) => (
                  <tr key={row.accountCode}>
                    <td><code>{row.accountCode}</code></td>
                    <td><strong>{row.accountName}</strong></td>
                    <td style={{ fontSize: '12px', color: 'var(--muted)' }}>{row.accountType} ({row.subType})</td>
                    <td className="amount-cell">{row.periodDebit ? formatMoney(row.periodDebit) : '—'}</td>
                    <td className="amount-cell">{row.periodCredit ? formatMoney(row.periodCredit) : '—'}</td>
                    <td className="amount-cell" style={{ fontWeight: 600 }}>
                      {row.closingDebit > 0 ? `${formatMoney(row.closingDebit)} Dr` : (row.closingCredit > 0 ? `${formatMoney(row.closingCredit)} Cr` : '₹0.00')}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ background: 'var(--panel)', fontWeight: 800, borderTop: '2px solid var(--line)' }}>
                  <td colSpan={3}>TOTAL</td>
                  <td className="amount-cell">{formatMoney(tbData.totalDebit)}</td>
                  <td className="amount-cell">{formatMoney(tbData.totalCredit)}</td>
                  <td>{tbData.isBalanced ? '✓ BALANCED' : 'IMBALANCE'}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </Panel>
      )}

      {/* TAB 7: Tally Vouchers */}
      {activeTab === 'vouchers' && (
        <Panel className="table-panel">
          <PanelHeading
            eyebrow="TallyPrime Vouchers"
            title={`Balanced Double-Entry Vouchers (${month})`}
            action={
              <div style={{ display: 'flex', gap: '8px' }}>
                <Button className="button-secondary button-small" loading={downloadMasters.isPending} onClick={() => downloadMasters.mutate()}>
                  <Icon name="download" size={13} />
                  Export Masters XML
                </Button>
                <Button className="button-primary button-small" loading={downloadXml.isPending} onClick={() => downloadXml.mutate()}>
                  <Icon name="download" size={13} />
                  Export Vouchers XML
                </Button>
              </div>
            }
          />
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Voucher No</th>
                  <th>Type</th>
                  <th>Date</th>
                  <th>Reference</th>
                  <th style={{ textAlign: 'right' }}>Debit (₹)</th>
                  <th style={{ textAlign: 'right' }}>Credit (₹)</th>
                  <th>Narration</th>
                </tr>
              </thead>
              <tbody>
                {vouchersQuery.data && vouchersQuery.data.length > 0 ? (
                  vouchersQuery.data.map((v: any) => (
                    <tr key={v.id}>
                      <td><code>{v.entryNumber}</code></td>
                      <td><strong>{v.voucherType}</strong></td>
                      <td>{formatDate(v.documentDate)}</td>
                      <td>{v.reference || '—'}</td>
                      <td className="amount-cell">{formatMoney(Number(v.totalDebit))}</td>
                      <td className="amount-cell">{formatMoney(Number(v.totalCredit))}</td>
                      <td style={{ fontSize: '12px' }}>{v.narration}</td>
                    </tr>
                  ))
                ) : (
                  <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--muted)' }}>No vouchers posted for this period yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {/* TAB 8: Closing Snapshots */}
      {activeTab === 'closing' && (
        <Panel className="table-panel">
          <PanelHeading eyebrow="Audit & Compliance" title="Immutable Monthly Closing Snapshots" />
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Period</th>
                  <th>Status</th>
                  <th>Closed On</th>
                  <th>Closed By</th>
                  <th style={{ textAlign: 'right' }}>Net Sales</th>
                  <th style={{ textAlign: 'right' }}>Bank Received</th>
                  <th style={{ textAlign: 'right' }}>Closing Receivable</th>
                </tr>
              </thead>
              <tbody>
                {closingHistoryQuery.data && closingHistoryQuery.data.length > 0 ? (
                  closingHistoryQuery.data.map((s: any) => (
                    <tr key={s.id}>
                      <td><strong>{s.period}</strong></td>
                      <td>
                        <span style={{ color: s.status === 'CLOSED' ? '#15803d' : '#b45309', fontWeight: 700, fontSize: '12px' }}>
                          {s.status}
                        </span>
                      </td>
                      <td>{formatDate(s.closedAt)}</td>
                      <td>{s.closedBy || 'SYSTEM'}</td>
                      <td className="amount-cell">{formatMoney(Number(s.netSales))}</td>
                      <td className="amount-cell" style={{ color: '#16a34a' }}>{formatMoney(Number(s.netBankReceipts))}</td>
                      <td className="amount-cell" style={{ fontWeight: 700 }}>{formatMoney(Number(s.closingReceivable))}</td>
                    </tr>
                  ))
                ) : (
                  <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--muted)' }}>No closed monthly snapshots recorded yet. Click "Close Month" above to finalize {month}.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {/* Uploads & Connectors Section */}
      <h2 style={{ fontSize: '16px', margin: '24px 0 12px' }}>Bring in Payments, Settlements &amp; Shipping Charges</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '12px' }}>
        {UPLOADS.map((upload) => (
          <UploadCard key={upload.kind} upload={upload} onDone={refresh} />
        ))}
      </div>

      {/* Configuration & Recipients Section */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '12px', marginTop: '20px' }}>
        <Panel>
          <PanelHeading eyebrow="Monthly report" title={`Automated dispatch on the 10th of every month`} />
          <p style={{ margin: '0 0 8px', fontSize: '13px' }}>
            The report goes out on <strong>{nextReportDate(month, 10)}</strong> at 09:00 IST.
          </p>
          <FormField label="Primary Accounts Email (To)" hint="Main recipient for Tally entries">
            <input value={recipients} onChange={(e) => setRecipients(e.target.value)} placeholder="accounts2@vbexports.co.in" />
          </FormField>
          <FormField label="CC Emails" hint="Comma-separated executive & audit emails">
            <input value={ccRecipients} onChange={(e) => setCcRecipients(e.target.value)} placeholder="returnorders@vbexports.co.in, vaibhav@vbexports.co.in, accounts@vbexports.co.in" />
          </FormField>
          <Button className="button-primary button-small" style={{ marginTop: '8px' }} loading={saveRecipientsMutation.isPending} onClick={() => saveRecipientsMutation.mutate()}>
            Save recipients &amp; CCs
          </Button>
        </Panel>

        <Panel>
          <PanelHeading eyebrow="Connections" title="Active Financial Integrations" />
          <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '13px', lineHeight: 1.7 }}>
            <li>Delhivery Rate API: <strong>{overview.data?.connectors?.delhiveryRateApi ? 'on (live)' : 'off (missing token)'}</strong></li>
            <li>PhonePe Settlement API &amp; Report Reconciler: <strong>{overview.data?.connectors?.phonepeSettlementApi ? 'on (live)' : 'off (unconfigured)'}</strong></li>
            <li>Easebuzz &amp; GoKwik Payout API / Deduplication: <strong>{overview.data?.connectors?.easebuzzPayoutApi ? 'on (live)' : 'off (unconfigured)'}</strong></li>
            <li>Velocity Shipping &amp; COD Remittance: <strong>on</strong></li>
            <li>Double-Entry General Ledger: <strong>active (Debits == Credits)</strong></li>
            <li>TallyPrime XML Export: <strong>ready</strong></li>
          </ul>
        </Panel>
      </div>
    </>
  )
}
