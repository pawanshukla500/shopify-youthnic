import { Fragment, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { apiError, downloadAccountsReport, downloadAccountsTemplate, getAccountsOverview, getReturnScanStatus, getVelocityRemittanceStatus, importAccountsFile, sendCodRefundDigest, syncReturnScans, syncVelocityRemittance, updateRemittanceUtr, type AccountsImportKind, type AccountsImportRecord } from '../api'
import { Button, CopyableBadge, ErrorBox, FormField, Icon, LoadingState, Panel, PanelHeading, useDocumentTitle, useToast } from '../components/UI'
import { formatDate, formatMoney } from '../lib'
import './Remittances.css'

const providers = ['Delhivery', 'Velocity', 'GoKwik', 'PhonePe', 'Other providers', 'All history']
const options: Array<{ kind: AccountsImportKind; label: string; template: Parameters<typeof downloadAccountsTemplate>[0] }> = [
  { kind: 'DELHIVERY_REMITTANCE', label: 'Delhivery COD remittance', template: 'delhivery-remittance' },
  { kind: 'VELOCITY_REMITTANCE', label: 'Velocity COD remittance', template: 'carrier-remittance' },
  { kind: 'DELHIVERY_CHARGES', label: 'Delhivery freight ledger', template: 'delhivery-charges' },
  { kind: 'GOKWIK_SETTLEMENT', label: 'GoKwik settlement', template: 'gokwik-settlement' },
  { kind: 'PHONEPE_SETTLEMENT', label: 'PhonePe settlement', template: 'phonepe-settlement' },
  { kind: 'PG_SETTLEMENT', label: 'Other gateway settlement', template: 'gokwik-settlement' },
  { kind: 'AMAZON_SHIPPING', label: 'Amazon Shipping remittance', template: 'carrier-remittance' },
  { kind: 'EKART_SHIPPING', label: 'Ekart remittance', template: 'carrier-remittance' },
  { kind: 'GENERIC_CARRIER', label: 'Other carrier remittance', template: 'carrier-remittance' },
]
const istToday = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10)
function evidence(record: AccountsImportRecord) {
  let summary: any = record.summary || {}
  if (typeof summary === 'string') { try { summary = JSON.parse(summary) } catch { summary = {} } }
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) summary = {}
  const rows: any[] = Array.isArray(summary.matchedOrders) ? summary.matchedOrders.filter((row: any) => row && typeof row === 'object') : []
  const utrs = [...new Set(rows.map((row) => row.utr).filter(Boolean))] as string[]
  const refs = [...new Set(rows.map((row) => row.remittanceRef).filter(Boolean))]
  const complete = rows.length > 0 && rows.length === record.matchedCount && rows.every((row) => String(row.utr || '').trim())
  const freight = record.kind === 'DELHIVERY_CHARGES'
  const isZip = record.fileName.toLowerCase().endsWith('.zip') || Boolean(summary.extractedFromZip)
  const extractedFiles: Array<{ fileName: string; sheetName?: string; rowCount?: number }> = Array.isArray(summary.extractedFiles) ? summary.extractedFiles : []
  return { summary, rows, utrs, freight, isZip, extractedFiles, mixed: summary.singleSettlement === false || refs.length > 1 || utrs.length > 1,
    state: freight ? (record.unmatched?.length ? 'Needs matching' : 'Reconciled') : complete ? 'UTR recorded' : 'UTR missing' }
}

export function Remittances() {
  useDocumentTitle('Payments & remittance')
  const toast = useToast(), cache = useQueryClient()
  const [provider, setProvider] = useState('Delhivery')
  const [month, setMonth] = useState(() => istToday().slice(0, 7))
  const [range, setRange] = useState(false)
  const [start, setStart] = useState(() => `${istToday().slice(0, 7)}-01`), [end, setEnd] = useState(istToday)
  const [search, setSearch] = useState(''), [filter, setFilter] = useState('All statuses')
  const [expanded, setExpanded] = useState<number | null>(null), [uploadOpen, setUploadOpen] = useState(false)
  const [kind, setKind] = useState<AccountsImportKind>('DELHIVERY_REMITTANCE'), [file, setFile] = useState<File | null>(null)
  const [utr, setUtr] = useState(''), [ref, setRef] = useState(''), [duplicate, setDuplicate] = useState(false), [outcome, setOutcome] = useState('')
  const [editing, setEditing] = useState<{ importId: number; orderId?: number; utr: string } | null>(null)
  const params = range ? { startDate: start, endDate: end } : { month }
  const valid = range ? Boolean(start && end && start <= end) : /^\d{4}-\d{2}$/.test(month)
  const query = useQuery({ queryKey: ['accounts-overview', params], queryFn: () => getAccountsOverview(params), enabled: valid, retry: false })
  const refresh = async () => { await Promise.all(['accounts-overview', 'orders', 'order', 'order-activity', 'velocity-remittance-status'].map((key) => cache.invalidateQueries({ queryKey: [key] }))) }
  const report = useMutation({ mutationFn: () => downloadAccountsReport(params), onError: (e) => toast.toast('error', apiError(e)) })
  const template = useMutation({ mutationFn: () => downloadAccountsTemplate(options.find((o) => o.kind === kind)!.template), onError: (e) => toast.toast('error', apiError(e)) })
  const upload = useMutation({
    mutationFn: (force: boolean) => {
      if (!file) throw new Error('Select a report file.')
      if (file.size > 7 * 1024 * 1024) throw new Error('The report must be smaller than 7 MB.')
      return importAccountsFile(kind, file, { utr: utr.trim() || undefined, remittanceRef: ref.trim() || undefined }, force)
    },
    onSuccess: async (r) => { setDuplicate(false); setOutcome(`${r.matchedCount} of ${r.rowCount} rows matched; ${r.unmatched.length} unmatched. ${r.notes.join(' ')}`); toast.toast('success', 'Report processed. Review its bank evidence below.'); await refresh() },
    onError: (e: any) => { setDuplicate(e?.response?.data?.code === 'DUPLICATE_FILE_ALREADY_UPLOADED'); toast.toast('error', apiError(e)) },
  })
  const correction = useMutation({
    mutationFn: () => { if (!editing?.utr.trim()) throw new Error('Enter the bank settlement UTR.'); return updateRemittanceUtr(editing.importId, editing.utr.trim(), editing.orderId) },
    onSuccess: async () => { setEditing(null); toast.toast('success', 'Bank UTR updated; existing amount and settlement date preserved.'); await refresh() },
    onError: (e) => toast.toast('error', apiError(e)),
  })
  const scanStatus = useQuery({ queryKey: ['return-scan-status'], queryFn: getReturnScanStatus, retry: false })
  const scanSync = useMutation({
    mutationFn: () => syncReturnScans(30),
    onSuccess: async (r) => {
      toast.toast('success', `Return scans processed: ${r.scansChecked} scans checked, ${r.matchedOrders} matched orders, ${r.prepaidRefunded} prepaid auto-refunded, ${r.codQueued} COD queued.`)
      await refresh()
    },
    onError: (e) => toast.toast('error', apiError(e)),
  })
  const codDigest = useMutation({
    mutationFn: () => sendCodRefundDigest(),
    onSuccess: (r) => toast.toast(r.sent ? 'success' : 'error', r.message),
    onError: (e) => toast.toast('error', apiError(e)),
  })
  const velocityStatus = useQuery({ queryKey: ['velocity-remittance-status'], queryFn: getVelocityRemittanceStatus, retry: false })
  const velocitySync = useMutation({
    mutationFn: () => syncVelocityRemittance(),
    onSuccess: async (r) => {
      toast.toast('success', r.message || 'Velocity remittances synchronized successfully.')
      await refresh()
      await velocityStatus.refetch()
    },
    onError: (e) => toast.toast('error', apiError(e)),
  })
  const records = useMemo(() => (query.data?.imports || []).filter((r) => {
    const source = r.kind.startsWith('DELHIVERY') ? 'Delhivery' : r.kind === 'VELOCITY_REMITTANCE' ? 'Velocity' : r.kind === 'GOKWIK_SETTLEMENT' ? 'GoKwik' : r.kind === 'PHONEPE_SETTLEMENT' ? 'PhonePe' : 'Other providers'
    const { summary, rows, state, extractedFiles } = evidence(r)
    const text = [r.fileName, r.uploadedBy, summary.remittanceNumber, ...extractedFiles.flatMap((f) => [f.fileName, f.sheetName]), ...rows.flatMap((row) => [row.shopifyOrderName, row.waybillNumber, row.utr])].join(' ').toLowerCase()
    return (provider === 'All history' || provider === source) && (!search || text.includes(search.toLowerCase())) && (filter === 'All statuses' || filter === state)
  }), [query.data, provider, search, filter])
  const metric = (name: string) => query.data?.summary?.find((r) => r.label === name)?.value ?? '—'
  return <div className="remittance-workspace">
    <header className="remittance-header"><div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <h1>Payments & remittance</h1>
        {scanStatus.data?.connected && (
          <span className="remittance-state" title="Read-only Return Scan Database connected">
            Return Scan DB: {scanStatus.data.totalScans?.toLocaleString('en-IN') ?? 0} scans
          </span>
        )}
      </div>
      <p>Bank evidence, settlement matching, UTR tracking, and return refund reconciliation.</p>
    </div>
    <div className="remittance-actions">
      <Button className="button-secondary" loading={velocitySync.isPending} onClick={() => velocitySync.mutate()} title="Sync live remittance records directly from Velocity API (no manual CSV download/upload needed)">
        <Icon name="refresh" size={15} />Sync Velocity API
      </Button>
      <Button className="button-secondary" loading={scanSync.isPending} onClick={() => scanSync.mutate()} title="Sync return scans from read-only RETURN_SCAN_DATABASE and process automatic refunds">
        <Icon name="refresh" size={15} />Sync Return Scans
      </Button>
      <Button className="button-secondary" loading={codDigest.isPending} onClick={() => codDigest.mutate()} title="Send daily manual COD refund digest to listings@vbexports.co.in">
        <Icon name="mail" size={15} />Email COD Refund Digest
      </Button>
      <Button className="button-secondary" aria-expanded={uploadOpen} onClick={() => setUploadOpen(!uploadOpen)}><Icon name="plus" size={15} />Import report</Button>
      <Button className="button-primary" disabled={!valid} loading={report.isPending} onClick={() => report.mutate()}>Export Excel</Button>
    </div></header>
    <div className="remittance-period"><label><input type="checkbox" checked={range} onChange={(e) => setRange(e.target.checked)} />Custom date range</label>
      {range ? <><FormField label="From"><input type="date" value={start} onChange={(e) => setStart(e.target.value)} /></FormField><FormField label="Through"><input type="date" value={end} onChange={(e) => setEnd(e.target.value)} /></FormField></> : <FormField label="Orders placed in"><input type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></FormField>}
      <span>Report dates use Asia/Kolkata. History shows recent uploaded files across all dates.</span></div>
    {!valid && <ErrorBox message="Select a valid report period; end date must not precede start date." />}{query.isLoading && <LoadingState label="Loading settlement evidence…" />}{query.isError && <ErrorBox message={apiError(query.error)} />}
    <div className="remittance-metrics">{[['Orders placed', 'Orders placed'], ['Closed for accounts', 'Closed (delivered, paid, return window over)'], ['Recorded bank credits', 'Received in bank (₹)'], ['Shipping costs', 'Shipping cost total (₹)']].map(([label, key], i) => <div key={key}><span>{label}</span><strong>{i > 1 && typeof metric(key) === 'number' ? formatMoney(Number(metric(key))) : metric(key)}</strong></div>)}</div>
    <p className="remittance-explainer">Shopify “Paid” is customer payment capture—not bank settlement. Accounts close only after delivery, a recorded bank UTR, the return window and no open return. Delhivery remittances and freight costs require uploaded panel reports.</p>
    {uploadOpen && <Panel><PanelHeading title="Import a provider report" action={<Button className="button-secondary" loading={template.isPending} onClick={() => template.mutate()}>Download template</Button>} /><div className="remittance-form-grid">
      <FormField label="Report type"><select value={kind} onChange={(e) => { setKind(e.target.value as AccountsImportKind); setDuplicate(false) }}>{options.map((o) => <option key={o.kind} value={o.kind}>{o.label}</option>)}</select></FormField>
      <FormField label="Report file"><input type="file" accept=".zip,.csv,.xlsx,.tsv,.txt" onChange={(e) => { setFile(e.target.files?.[0] || null); setDuplicate(false); setOutcome('') }} /></FormField>
      {kind !== 'DELHIVERY_CHARGES' && <><FormField label="Bank UTR (optional)"><input value={utr} onChange={(e) => setUtr(e.target.value)} maxLength={160} /></FormField><FormField label="Settlement reference (optional)"><input value={ref} onChange={(e) => setRef(e.target.value)} maxLength={160} /></FormField></>}</div>
      <p className="remittance-explainer">ZIP, XLSX or CSV, up to 7 MB. A typed UTR applies only to a single settlement; mixed files need row-wise UTRs. Duplicate payment guards remain active.</p><Button className="button-primary" loading={upload.isPending} disabled={!file} onClick={() => upload.mutate(false)}>Upload & reconcile</Button>
      {duplicate && <div className="remittance-warning"><p>This report already exists. Add missing UTRs in history rather than crediting the same rows again.</p><Button className="button-secondary" disabled={upload.isPending} onClick={() => { if (window.confirm('Reprocess this report? Existing payment duplicate guards still apply.')) upload.mutate(true) }}>Reprocess matching data</Button></div>}{outcome && <p role="status">{outcome}</p>}</Panel>}
    <nav className="remittance-provider-nav" aria-label="Settlement providers">{providers.map((name) => <button type="button" key={name} aria-pressed={provider === name} onClick={() => { setProvider(name); setFilter('All statuses'); setExpanded(null) }}>{name}</button>)}</nav>
    {provider === 'GoKwik' && (
      <div style={{ display: 'flex', alignItems: 'center', padding: '14px 18px', background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: '10px', marginBottom: '14px', gap: '14px' }}>
        <img src="/logos/gokwik.svg" alt="GoKwik" style={{ height: '26px', objectFit: 'contain' }} onError={(e) => { (e.currentTarget as HTMLElement).style.display = 'none' }} />
        <div>
          <strong style={{ display: 'block', fontSize: '14px', fontWeight: 650 }}>GoKwik Checkout & Payment Settlements</strong>
          <span style={{ fontSize: '12px', color: 'var(--muted)' }}>Prepaid orders processed through GoKwik checkout. Upload settlement reports to match bank credits with customer payments.</span>
        </div>
      </div>
    )}
    {provider === 'PhonePe' && (
      <div style={{ display: 'flex', alignItems: 'center', padding: '14px 18px', background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: '10px', marginBottom: '14px', gap: '14px' }}>
        <img src="/logos/phonepe.svg" alt="PhonePe" style={{ height: '26px', objectFit: 'contain' }} onError={(e) => { (e.currentTarget as HTMLElement).style.display = 'none' }} />
        <div>
          <strong style={{ display: 'block', fontSize: '14px', fontWeight: 650 }}>PhonePe Payment Gateway Settlements</strong>
          <span style={{ fontSize: '12px', color: 'var(--muted)' }}>Direct UPI and PhonePe gateway settlements. Reconcile transaction IDs, merchant fees, and bank UTRs.</span>
        </div>
      </div>
    )}
    {provider === 'Delhivery' && (
      <div style={{ display: 'flex', alignItems: 'center', padding: '14px 18px', background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: '10px', marginBottom: '14px', gap: '14px' }}>
        <img src="/logos/delhivery.svg" alt="Delhivery" style={{ height: '26px', objectFit: 'contain' }} onError={(e) => { (e.currentTarget as HTMLElement).style.display = 'none' }} />
        <div>
          <strong style={{ display: 'block', fontSize: '14px', fontWeight: 650 }}>Delhivery Courier Remittances & Freight Ledgers</strong>
          <span style={{ fontSize: '12px', color: 'var(--muted)' }}>Reconcile COD remittance credits, client remittances (CRN), and freight deductions from Delhivery ONE.</span>
        </div>
      </div>
    )}
    {provider === 'Velocity' && (
      <>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px', background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: '10px', marginBottom: '14px', gap: '16px', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
            <img src="/logos/velocity.svg" alt="Velocity" style={{ height: '26px', objectFit: 'contain' }} onError={(e) => { (e.currentTarget as HTMLElement).style.display = 'none' }} />
            <div>
              <strong style={{ display: 'block', fontSize: '14px', fontWeight: 650 }}>Velocity Direct Finance & Remittance Sync</strong>
              <span style={{ fontSize: '12px', color: 'var(--muted)' }}>
                Direct API reconciliation active. Velocity payouts and COD settlements sync automatically without downloading or uploading CSVs.
                {velocityStatus.data?.lastSync && ` • Last synced: ${formatDate(velocityStatus.data.lastSync)} (${velocityStatus.data.matchedCount} matched)`}
              </span>
            </div>
          </div>
          <Button className="button-primary" loading={velocitySync.isPending} onClick={() => velocitySync.mutate()}>
            <Icon name="refresh" size={14} /> Run Live Sync
          </Button>
        </div>
        <div className="remittance-metrics" style={{ marginBottom: '20px' }}>
          <div>
            <span>COD Settled (₹)</span>
            <strong>{velocityStatus.data?.totalRemittance != null ? formatMoney(velocityStatus.data.totalRemittance) : '₹0.00'}</strong>
          </div>
          <div>
            <span>Audited Freight (₹)</span>
            <strong>{velocityStatus.data?.totalBilledCharges != null ? formatMoney(velocityStatus.data.totalBilledCharges) : '₹0.00'}</strong>
          </div>
          <div>
            <span>Delivered In Network</span>
            <strong>{velocityStatus.data?.summaryReport?.delivered?.count ?? 0}</strong>
          </div>
          <div>
            <span>In Transit / OFD</span>
            <strong>{(velocityStatus.data?.summaryReport?.in_transit?.count || 0) + (velocityStatus.data?.summaryReport?.out_for_delivery?.count || 0)}</strong>
          </div>
        </div>
      </>
    )}
    <Panel><PanelHeading title="Report history & bank evidence" action={<Button className="button-secondary" loading={query.isFetching} onClick={refresh}>Refresh</Button>} />
      <div className="remittance-filters"><FormField label="Find a settlement or order"><input type="search" placeholder="File, order, AWB, UTR or uploader" value={search} onChange={(e) => setSearch(e.target.value)} /></FormField><FormField label="Evidence status"><select value={filter} onChange={(e) => setFilter(e.target.value)}>{['All statuses', 'UTR recorded', 'UTR missing', 'Reconciled', 'Needs matching'].map((s) => <option key={s}>{s}</option>)}</select></FormField></div>
      {editing && <div className="remittance-correction"><FormField label="Correct bank UTR"><input value={editing.utr} maxLength={160} onChange={(e) => setEditing({ ...editing, utr: e.target.value })} /></FormField><Button className="button-primary" loading={correction.isPending} onClick={() => correction.mutate()}>Save UTR</Button><Button className="button-secondary" disabled={correction.isPending} onClick={() => setEditing(null)}>Cancel</Button><p>{editing.orderId ? `Order ${editing.orderId}` : `Import ${editing.importId}`}: changes only the UTR, never the existing payment amount/date.</p></div>}
      <div className="table-wrap"><table className="data-table"><thead><tr><th>Report / settlement</th><th>Uploaded by</th><th>Bank evidence</th><th>Amount</th><th>Matched</th><th>Action</th></tr></thead><tbody>{records.map((r) => {
        const { summary, rows, utrs, freight, isZip, extractedFiles, mixed, state } = evidence(r)
        const hasExcel = (extractedFiles || []).some((f: any) => f.fileName?.toLowerCase().endsWith('.xlsx'))
        const badgeLabel = hasExcel ? 'Excel Extracted • Data in PostgreSQL' : 'Spreadsheet Extracted • Data in PostgreSQL'
        return <Fragment key={r.id}><tr><td><button type="button" className="remittance-expand" aria-expanded={expanded === r.id} onClick={() => setExpanded(expanded === r.id ? null : r.id)}>{summary.remittanceNumber || r.fileName}</button><small>{r.fileName} · {options.find((o) => o.kind === r.kind)?.label}</small>{isZip && <span className="remittance-storage-badge" title="Data extracted and persisted directly to PostgreSQL; no raw ZIP stored on disk"><Icon name="check" size={11} /> {badgeLabel}</span>}</td><td>{r.uploadedBy || 'Not recorded'}<small>{formatDate(r.createdAt)}</small></td>
          <td><span className={`remittance-state ${state.includes('missing') || state.includes('Needs') ? 'needs-review' : ''}`}>{state}</span>{!freight && (utrs.length === 1 ? <CopyableBadge text={utrs[0]} /> : <small>{utrs.length ? `${utrs.length} UTRs—expand for details` : 'Bank UTR not recorded'}</small>)}</td><td>{summary.totalRemittance == null ? 'Not available' : formatMoney(summary.totalRemittance)}<small>{freight ? 'Freight—not a bank credit' : 'Net report amount'}</small></td><td>{r.matchedCount} / {r.rowCount}</td><td>{!freight && <Button className="button-secondary" disabled={mixed || !rows.length} title={mixed ? 'Correct mixed settlements per order below.' : 'Correct one settlement'} onClick={() => setEditing({ importId: r.id, utr: utrs[0] || '' })}>Correct UTR</Button>}</td></tr>
          {expanded === r.id && <tr><td colSpan={6}><div className="remittance-order-list">{isZip && <div className="remittance-extraction-meta"><div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}><strong style={{ color: 'var(--ink)' }}>Storage Verification:</strong><span className="remittance-storage-badge"><Icon name="check" size={11} /> PostgreSQL Relational Storage</span></div><p style={{ margin: '4px 0', fontSize: '12px', color: 'var(--muted)' }}>Raw ZIP archive was unpacked in-memory and not stored on server disk. Persisted into PostgreSQL ({r.matchedCount} orders matched across all extracted sheets).</p>{extractedFiles.length > 0 && <ul style={{ margin: '6px 0 0 16px', fontSize: '12px', paddingLeft: 0 }}>{extractedFiles.map((f: any, i: number) => {
            const isXlsx = f.fileName?.toLowerCase().endsWith('.xlsx');
            return <li key={i}>📄 {isXlsx ? 'Excel Spreadsheet' : 'Spreadsheet'}: <code>{f.fileName}</code> {f.sheetName ? `(${f.sheetName})` : ''} — {f.rowCount ?? 0} rows parsed</li>
          })}</ul>}</div>}<h3>Matched orders</h3>{rows.length ? <table className="data-table"><thead><tr><th>Order / AWB</th><th>Amount</th><th>Bank UTR</th><th>State</th>{!freight && <th>Correction</th>}</tr></thead><tbody>{rows.map((o, index) => <tr key={`${o.orderId}-${index}`}><td>{o.orderId ? <Link to={`/orders/${o.orderId}`}>{o.shopifyOrderName || `Order ${o.orderId}`}</Link> : o.shopifyOrderName || 'Unidentified order'}<small>{o.waybillNumber || 'AWB not provided'}</small></td><td>{o.amount == null ? 'Not available' : formatMoney(o.amount)}</td><td>{freight ? 'Not applicable' : o.utr ? <CopyableBadge text={o.utr} /> : 'UTR missing'}</td><td>{o.status || 'Not recorded'}</td>{!freight && <td><Button className="button-secondary" disabled={!o.orderId} onClick={() => setEditing({ importId: r.id, orderId: o.orderId, utr: o.utr || '' })}>Correct order UTR</Button></td>}</tr>)}</tbody></table> : <p>No order-level evidence stored for this legacy report. Review individual orders before editing.</p>}{!!r.unmatched?.length && <details><summary>{r.unmatched.length} unmatched references</summary><p>{r.unmatched.join(', ')}</p></details>}{summary.notes?.map((note: string) => <p key={note}>{note}</p>)}</div></td></tr>}
        </Fragment>
      })}{!records.length && <tr><td colSpan={6}>No reports match this provider or search. Import a report or choose another filter.</td></tr>}</tbody></table></div>
    </Panel>
  </div>
}