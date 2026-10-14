import { useState, useMemo, Fragment } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  apiError,
  downloadAccountsReport,
  downloadAccountsTemplate,
  getAccountsOverview,
  importAccountsFile,
  updateRemittanceUtr,
  type AccountsImportKind,
  type AccountsImportResult,
  type AccountsImportRecord,
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
import { ErrorBoundary } from '../components/ErrorBoundary'
import { formatDate, formatMoney } from '../lib'

function defaultMonth(): string {
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000)
  const year = ist.getUTCMonth() === 0 ? ist.getUTCFullYear() - 1 : ist.getUTCFullYear()
  const month = ist.getUTCMonth() === 0 ? 12 : ist.getUTCMonth()
  return `${year}-${String(month).padStart(2, '0')}`
}

function parseSummary(summary: unknown): Record<string, any> {
  if (!summary) return {}
  if (typeof summary === 'object') return summary as Record<string, any>
  if (typeof summary === 'string') {
    try {
      const parsed = JSON.parse(summary)
      return typeof parsed === 'object' && parsed !== null ? parsed : {}
    } catch {
      return {}
    }
  }
  return {}
}

const UPLOADS: Array<{
  kind: AccountsImportKind
  title: string
  templateKey: 'delhivery-remittance' | 'delhivery-charges' | 'gokwik-settlement'
  what: string
  where: string
  withRemittanceFields?: boolean
}> = [
  {
    kind: 'DELHIVERY_REMITTANCE',
    title: 'Delhivery COD Remittance (ZIP or CSV/XLSX)',
    templateKey: 'delhivery-remittance',
    what: 'Matches delivered COD orders by Waybill / Order No and writes Bank Transaction ID (UTR), marking orders as Payment Received. Direct ZIP files from Delhivery ONE supported.',
    where: 'Delhivery ONE → Finances → Remittance → click remittance number → Download AWB list (.zip, .xlsx or .csv).',
    withRemittanceFields: true,
  },
  {
    kind: 'DELHIVERY_CHARGES',
    title: 'Delhivery Shipping Charges',
    templateKey: 'delhivery-charges',
    what: 'Replaces freight estimates with exact billed shipping charges (Forward, RTO, Reverse pickup) from Delhivery wallet ledger.',
    where: 'Delhivery ONE → Finances → Wallet → Transactions → Download Ledger (or invoice AWB-wise backup).',
  },
  {
    kind: 'PG_SETTLEMENT',
    title: 'GoKwik / PG Settlement (PhonePe / Easebuzz)',
    templateKey: 'gokwik-settlement',
    what: 'Marks prepaid orders as paid into the bank with gateway transaction UTR and deducts MDR fees.',
    where: 'GoKwik Merchant Dashboard / PhonePe Business → Settlements → Download transaction report.',
  },
]

function RemittanceUploadCard({
  upload,
  onDone,
}: {
  upload: (typeof UPLOADS)[number]
  onDone: () => void
}) {
  const toast = useToast()
  const [file, setFile] = useState<File | null>(null)
  const [utr, setUtr] = useState('')
  const [remittanceRef, setRemittanceRef] = useState('')
  const [remittedAt, setRemittedAt] = useState('')
  const [result, setResult] = useState<AccountsImportResult | null>(null)

  const mutation = useMutation({
    mutationFn: () => {
      if (!file) throw new Error('Please select a file to upload.')
      return importAccountsFile(
        upload.kind,
        file,
        upload.withRemittanceFields
          ? {
              utr: utr.trim() || undefined,
              remittanceRef: remittanceRef.trim() || undefined,
              remittedAt: remittedAt || undefined,
            }
          : undefined
      )
    },
    onSuccess: (data) => {
      setResult(data)
      const dupCount = data.skippedDuplicates?.length || 0
      const message = `${upload.title}: ${data.matchedCount} of ${data.rowCount} rows matched.${
        dupCount > 0 ? ` · ${dupCount} duplicate tracking ID(s) skipped` : ''
      }${data.closedNow ? ` · ${data.closedNow} order(s) moved to Payment Received` : ''}`
      toast.toast(data.matchedCount > 0 || dupCount > 0 ? 'success' : 'error', message)
      onDone()
    },
    onError: (error) => toast.toast('error', apiError(error)),
  })

  return (
    <Panel style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
        <div>
          <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 700 }}>{upload.title}</h3>
          <p style={{ margin: '4px 0 0', fontSize: '12px', color: 'var(--muted)' }}>{upload.what}</p>
        </div>
        <button
          type="button"
          onClick={() => downloadAccountsTemplate(upload.templateKey)}
          title="Download sample CSV template"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            fontSize: '11px',
            padding: '4px 8px',
            borderRadius: '4px',
            border: '1px solid var(--line)',
            background: 'var(--bg-subtle, #f8fafc)',
            color: 'var(--ink)',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          <Icon name="download" size={12} />
          Template
        </button>
      </div>

      <div style={{ background: 'var(--bg-subtle, #f8fafc)', border: '1px solid var(--line)', borderRadius: '6px', padding: '8px 10px', fontSize: '11px', color: 'var(--muted)' }}>
        <strong>Source:</strong> {upload.where}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: '#047857' }}>
        <Icon name="shield" size={13} />
        <span><strong>Duplicate Guard Active:</strong> Tracking IDs already remitted cannot be uploaded twice.</span>
      </div>

      <div>
        <input
          type="file"
          accept=".xlsx,.csv,.tsv,.txt,.zip"
          onChange={(event) => {
            setFile(event.target.files?.[0] || null)
            setResult(null)
          }}
        />
        {upload.kind === 'DELHIVERY_REMITTANCE' && (
          <p style={{ margin: '4px 0 0', fontSize: '11px', color: '#2563eb' }}>
            ⚡ Direct <strong>.zip</strong> upload supported (e.g. <code>R3359352026101200000.zip</code>). Auto-extracts CSV, remittance ref and date.
          </p>
        )}
      </div>

      {upload.withRemittanceFields && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '8px' }}>
          <FormField label="Bank's Transaction ID / UTR" hint="Optional now, can add later">
            <input value={utr} onChange={(e) => setUtr(e.target.value)} placeholder="e.g. AXISP00847547449" />
          </FormField>
          <FormField label="Remittance No" hint="Auto-read from filename if empty">
            <input value={remittanceRef} onChange={(e) => setRemittanceRef(e.target.value)} placeholder="e.g. R3359352026101300001" />
          </FormField>
          <FormField label="Remittance Date" hint="Auto-read from batch ref">
            <input type="date" value={remittedAt} onChange={(e) => setRemittedAt(e.target.value)} />
          </FormField>
        </div>
      )}

      <Button
        className="button-primary"
        loading={mutation.isPending}
        disabled={!file || mutation.isPending}
        onClick={() => mutation.mutate()}
      >
        <Icon name="download" size={14} />
        Upload &amp; Reconcile
      </Button>

      {result && (
        <div style={{ fontSize: '12px', borderTop: '1px solid var(--line)', paddingTop: '10px' }}>
          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
            <span><strong>{result.matchedCount}</strong> of <strong>{result.rowCount}</strong> rows matched</span>
            {result.totalRemittance && (
              <span style={{ color: '#047857', fontWeight: 700 }}>
                · Total Remitted: {formatMoney(result.totalRemittance)}
              </span>
            )}
            {result.skippedDuplicates && result.skippedDuplicates.length > 0 && (
              <span style={{ color: '#b45309', fontWeight: 600 }}>
                · <strong>{result.skippedDuplicates.length}</strong> duplicate tracking ID(s) skipped
              </span>
            )}
            {result.unmatched && result.unmatched.length > 0 && (
              <span style={{ color: '#dc2626' }}>· <strong>{result.unmatched.length}</strong> not found</span>
            )}
          </div>

          {Array.isArray(result.notes) && result.notes.map((note) => (
            <div key={note} style={{ color: '#b45309', marginTop: '6px', fontSize: '11px', background: '#fef3c7', padding: '4px 8px', borderRadius: '4px' }}>
              {note}
            </div>
          ))}

          {result.skippedDuplicates && result.skippedDuplicates.length > 0 && (
            <details style={{ marginTop: '6px' }}>
              <summary style={{ cursor: 'pointer', color: '#b45309', fontSize: '11px' }}>
                View {result.skippedDuplicates.length} skipped duplicate tracking IDs
              </summary>
              <div style={{ fontFamily: 'var(--mono, monospace)', fontSize: '11px', wordBreak: 'break-all', marginTop: '4px', background: 'var(--bg-subtle, #f8fafc)', padding: '6px', borderRadius: '4px' }}>
                {result.skippedDuplicates.slice(0, 100).join(', ')}
              </div>
            </details>
          )}

          {result.unmatched && result.unmatched.length > 0 && (
            <details style={{ marginTop: '6px' }}>
              <summary style={{ cursor: 'pointer', color: '#dc2626', fontSize: '11px' }}>
                View {result.unmatched.length} unmatched references
              </summary>
              <div style={{ fontFamily: 'var(--mono, monospace)', fontSize: '11px', wordBreak: 'break-all', marginTop: '4px', background: 'var(--bg-subtle, #f8fafc)', padding: '6px', borderRadius: '4px' }}>
                {result.unmatched.slice(0, 100).join(', ')}
              </div>
            </details>
          )}
        </div>
      )}
    </Panel>
  )
}

function DelhiveryRemittanceLogTable({
  imports,
  onRefresh,
}: {
  imports: AccountsImportRecord[]
  onRefresh: () => void
}) {
  const toast = useToast()
  const [search, setSearch] = useState('')
  const [stateFilter, setStateFilter] = useState<'ALL' | 'Completed' | 'Pending'>('ALL')
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [editingUtrId, setEditingUtrId] = useState<number | null>(null)
  const [editingUtrValue, setEditingUtrValue] = useState('')

  const safeImports = useMemo(() => (Array.isArray(imports) ? imports : []), [imports])

  const remittanceImports = useMemo(() => {
    return safeImports.filter((imp) => imp && imp.kind === 'DELHIVERY_REMITTANCE')
  }, [safeImports])

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase()
    return remittanceImports.filter((row) => {
      if (!row) return false
      const s = parseSummary(row.summary)
      const fileName = String(row.fileName || '')
      const ref = String(s.remittanceNumber || fileName)
      const utr = String(s.bankTransactionId || '')
      const matchesSearch =
        !query ||
        ref.toLowerCase().includes(query) ||
        utr.toLowerCase().includes(query) ||
        fileName.toLowerCase().includes(query)

      const state = String(s.state || (utr ? 'Completed' : 'Pending'))
      const matchesState = stateFilter === 'ALL' || state === stateFilter
      return matchesSearch && matchesState
    })
  }, [remittanceImports, search, stateFilter])

  const utrMutation = useMutation({
    mutationFn: ({ id, utr }: { id: number; utr: string }) => updateRemittanceUtr(id, utr),
    onSuccess: (data) => {
      toast.toast('success', `Bank Transaction ID updated! ${data.closedNow} order(s) moved to Payment Received.`)
      setEditingUtrId(null)
      setEditingUtrValue('')
      onRefresh()
    },
    onError: (err) => toast.toast('error', apiError(err)),
  })

  const formatRemittanceDate = (isoOrCreated?: string | null) => {
    if (!isoOrCreated) return '—'
    try {
      const d = new Date(isoOrCreated)
      if (Number.isNaN(d.getTime())) return String(isoOrCreated)
      return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    } catch {
      return String(isoOrCreated)
    }
  }

  return (
    <Panel className="table-panel" style={{ marginTop: '24px' }}>
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--line)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <h2 style={{ fontSize: '18px', fontWeight: 800, margin: 0 }}>2-Day Remittances</h2>
              <span
                style={{
                  background: 'var(--bg-subtle, #f1f5f9)',
                  padding: '2px 8px',
                  borderRadius: '12px',
                  fontSize: '11px',
                  fontWeight: 600,
                  color: 'var(--muted)',
                }}
              >
                Delhivery ONE Synchronized
              </span>
            </div>
            <p style={{ margin: '4px 0 0', fontSize: '12px', color: 'var(--muted)' }}>
              Your bank account will be credited 2 days post daily remittance · <strong>Account: ICICI - XXXXXXXXX1409</strong>
            </p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
            <input
              type="search"
              placeholder="Search by Remittance Number / UTR"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{
                fontSize: '12px',
                padding: '6px 12px',
                borderRadius: '6px',
                border: '1px solid var(--line)',
                minWidth: '240px',
              }}
            />
            <select
              value={stateFilter}
              onChange={(e) => setStateFilter(e.target.value as any)}
              style={{
                fontSize: '12px',
                padding: '6px 10px',
                borderRadius: '6px',
                border: '1px solid var(--line)',
                background: 'var(--panel)',
              }}
            >
              <option value="ALL">All States</option>
              <option value="Completed">Completed</option>
              <option value="Pending">Pending</option>
            </select>
            <Button className="button-secondary" onClick={onRefresh} style={{ padding: '6px 10px', fontSize: '12px' }}>
              <Icon name="refresh" size={13} />
              Refresh
            </Button>
          </div>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div style={{ padding: '32px', textAlign: 'center', color: 'var(--muted)', fontSize: '13px' }}>
          {remittanceImports.length === 0
            ? 'No Delhivery COD remittances uploaded yet. Upload your first remittance ZIP or CSV file above.'
            : 'No remittances matching your search criteria.'}
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th style={{ width: '40px' }}></th>
                <th>REMITTANCE NUMBER</th>
                <th>DATE</th>
                <th>BANK'S TRANSACTION ID</th>
                <th>STATE</th>
                <th style={{ textAlign: 'right' }}>TOTAL REMITTANCE</th>
                <th>MATCHED ORDERS</th>
                <th>ACTIONS</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => {
                const s = parseSummary(row.summary)
                const fileName = String(row.fileName || '')
                const ref = String(s.remittanceNumber || (fileName ? fileName.replace(/\.zip|\.csv|\.xlsx/i, '') : `Batch-${row.id}`))
                const date = s.remittanceDate || row.createdAt
                const utr = s.bankTransactionId ? String(s.bankTransactionId) : ''
                const isCompleted = s.state === 'Completed' || Boolean(utr)
                const total = s.totalRemittance ?? (row.matchedCount > 0 ? '—' : 0)
                const isExpanded = expandedId === row.id
                const isEditingThisUtr = editingUtrId === row.id
                const matchedOrders = Array.isArray(s.matchedOrders) ? s.matchedOrders : []

                return (
                  <Fragment key={row.id}>
                    <tr
                      style={{
                        background: isExpanded ? 'var(--bg-subtle, #f8fafc)' : undefined,
                        cursor: 'pointer',
                      }}
                      onClick={() => setExpandedId(isExpanded ? null : row.id)}
                    >
                      <td style={{ textAlign: 'center', color: 'var(--muted)' }}>
                        <Icon name={isExpanded ? 'chevron' : 'arrow'} size={12} />
                      </td>
                      <td>
                        <span style={{ fontFamily: 'var(--mono, monospace)', fontWeight: 700, color: '#2563eb' }}>
                          {ref}
                        </span>
                        {fileName.toLowerCase().endsWith('.zip') && (
                          <span style={{ marginLeft: '6px', fontSize: '10px', background: '#dbeafe', color: '#1e40af', padding: '1px 5px', borderRadius: '4px' }}>
                            ZIP
                          </span>
                        )}
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>{formatRemittanceDate(date)}</td>
                      <td onClick={(e) => e.stopPropagation()}>
                        {isEditingThisUtr ? (
                          <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                            <input
                              type="text"
                              value={editingUtrValue}
                              placeholder="e.g. AXISP00847034515"
                              onChange={(e) => setEditingUtrValue(e.target.value)}
                              style={{ fontSize: '11px', padding: '3px 6px', width: '160px', fontFamily: 'monospace' }}
                              autoFocus
                            />
                            <Button
                              className="button-primary"
                              style={{ padding: '3px 8px', fontSize: '11px' }}
                              loading={utrMutation.isPending}
                              disabled={!editingUtrValue.trim() || utrMutation.isPending}
                              onClick={() => utrMutation.mutate({ id: row.id, utr: editingUtrValue.trim() })}
                            >
                              Save
                            </Button>
                            <Button
                              className="button-secondary"
                              style={{ padding: '3px 8px', fontSize: '11px' }}
                              onClick={() => setEditingUtrId(null)}
                            >
                              Cancel
                            </Button>
                          </div>
                        ) : utr ? (
                          <span style={{ fontFamily: 'var(--mono, monospace)', fontSize: '12px', fontWeight: 600, color: '#047857' }}>
                            {utr}
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => {
                              setEditingUtrId(row.id)
                              setEditingUtrValue('')
                            }}
                            style={{
                              background: '#fef3c7',
                              color: '#b45309',
                              border: '1px solid #fde68a',
                              borderRadius: '4px',
                              padding: '2px 8px',
                              fontSize: '11px',
                              fontWeight: 600,
                              cursor: 'pointer',
                            }}
                          >
                            + Add Bank UTR
                          </button>
                        )}
                      </td>
                      <td>
                        <span
                          style={{
                            background: isCompleted ? '#dcfce7' : '#fef3c7',
                            color: isCompleted ? '#15803d' : '#b45309',
                            padding: '3px 10px',
                            borderRadius: '999px',
                            fontSize: '11px',
                            fontWeight: 700,
                            display: 'inline-block',
                          }}
                        >
                          {isCompleted ? 'Completed' : 'Pending'}
                        </span>
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 800, fontSize: '13px' }}>
                        {typeof total === 'number' ? formatMoney(total) : total}
                      </td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <span style={{ fontWeight: 700, color: '#047857' }}>{row.matchedCount} orders</span>
                          {Array.isArray(s.skippedDuplicates) && s.skippedDuplicates.length > 0 && (
                            <span
                              style={{
                                background: '#fef3c7',
                                color: '#b45309',
                                fontSize: '10px',
                                fontWeight: 700,
                                padding: '1px 5px',
                                borderRadius: '4px',
                              }}
                              title={`${s.skippedDuplicates.length} duplicates blocked`}
                            >
                              {s.skippedDuplicates.length} dupes skipped
                            </span>
                          )}
                        </div>
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <div style={{ display: 'flex', gap: '6px' }}>
                          <Button
                            className="button-secondary"
                            style={{ padding: '3px 8px', fontSize: '11px' }}
                            onClick={() => setExpandedId(isExpanded ? null : row.id)}
                          >
                            {isExpanded ? 'Hide' : 'View Orders'}
                          </Button>
                          {!utr && !isEditingThisUtr && (
                            <Button
                              className="button-secondary"
                              style={{ padding: '3px 8px', fontSize: '11px', color: '#b45309' }}
                              onClick={() => {
                                setEditingUtrId(row.id)
                                setEditingUtrValue('')
                              }}
                            >
                              Update UTR
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>

                    {/* Expandable Order Details Row */}
                    {isExpanded && (
                      <tr key={`${row.id}-details`} style={{ background: 'var(--bg-subtle, #f8fafc)' }}>
                        <td colSpan={8} style={{ padding: '12px 20px 20px 48px' }}>
                          <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: '8px', padding: '12px' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                              <h4 style={{ margin: 0, fontSize: '13px', fontWeight: 700 }}>
                                Orders in Remittance Batch {ref} ({matchedOrders.length || row.matchedCount} items)
                              </h4>
                              <span style={{ fontSize: '11px', color: 'var(--muted)' }}>
                                Uploaded: {formatDate(row.createdAt)} by {row.uploadedBy || 'system'}
                              </span>
                            </div>

                            {matchedOrders.length > 0 ? (
                              <div style={{ maxHeight: '280px', overflowY: 'auto' }}>
                                <table style={{ width: '100%', fontSize: '11px', borderCollapse: 'collapse' }}>
                                  <thead>
                                    <tr style={{ borderBottom: '1px solid var(--line)', textAlign: 'left', color: 'var(--muted)' }}>
                                      <th style={{ padding: '6px 8px' }}>Order ID</th>
                                      <th style={{ padding: '6px 8px' }}>Waybill / AWB</th>
                                      <th style={{ padding: '6px 8px' }}>City</th>
                                      <th style={{ padding: '6px 8px', textAlign: 'right' }}>COD Amount</th>
                                      <th style={{ padding: '6px 8px' }}>Status</th>
                                      <th style={{ padding: '6px 8px' }}>Bank UTR</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {matchedOrders.map((o: any, idx: number) => {
                                      const orderName = String(o?.shopifyOrderName || '')
                                      const searchParam = orderName.replace(/^#/, '')
                                      return (
                                        <tr key={idx} style={{ borderBottom: '1px solid var(--line)' }}>
                                          <td style={{ padding: '6px 8px', fontWeight: 700 }}>
                                            <a href={`/orders?search=${encodeURIComponent(searchParam)}`} style={{ color: '#2563eb', textDecoration: 'none' }}>
                                              {orderName || '—'}
                                            </a>
                                          </td>
                                          <td style={{ padding: '6px 8px', fontFamily: 'monospace' }}>{o?.waybillNumber || '—'}</td>
                                          <td style={{ padding: '6px 8px' }}>{o?.city || '—'}</td>
                                          <td style={{ padding: '6px 8px', textAlign: 'right', fontWeight: 600 }}>
                                            {typeof o?.amount === 'number' ? formatMoney(o.amount) : (o?.amount || '—')}
                                          </td>
                                          <td style={{ padding: '6px 8px', color: '#15803d', fontWeight: 600 }}>{o?.status || 'DELIVERED'}</td>
                                          <td style={{ padding: '6px 8px', fontFamily: 'monospace', color: utr ? '#15803d' : 'var(--muted)' }}>
                                            {o?.utr || utr || 'Pending'}
                                          </td>
                                        </tr>
                                      )
                                    })}
                                  </tbody>
                                </table>
                              </div>
                            ) : (
                              <p style={{ margin: 0, fontSize: '12px', color: 'var(--muted)' }}>
                                Matched {row.matchedCount} orders. Detailed per-row snapshots available for newly uploaded files.
                              </p>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  )
}

function RemittancesContent() {
  useDocumentTitle('Remittance Upload & Logs')
  const toast = useToast()
  const queryClient = useQueryClient()
  const [filterMode, setFilterMode] = useState<'month' | 'range'>('month')
  const [month, setMonth] = useState(defaultMonth)
  const [startDate, setStartDate] = useState(() => {
    const d = new Date()
    d.setDate(1)
    return d.toISOString().slice(0, 10)
  })
  const [endDate, setEndDate] = useState(() => new Date().toISOString().slice(0, 10))

  const queryParams = filterMode === 'range' ? { startDate, endDate } : { month }

  const overview = useQuery({
    queryKey: ['accounts-overview', queryParams],
    queryFn: () => getAccountsOverview(queryParams),
    retry: false,
  })

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['accounts-overview'] })
    queryClient.invalidateQueries({ queryKey: ['orders'] })
  }

  const downloadReport = useMutation({
    mutationFn: () => downloadAccountsReport(queryParams),
    onSuccess: () => toast.toast('success', 'Excel reconciliation report downloaded successfully.'),
    onError: (error) => toast.toast('error', apiError(error)),
  })

  const data = overview.data
  const value = (label: string) => {
    if (!data || !Array.isArray(data.summary)) return 0
    const item = data.summary.find((s) => s.label === label)
    return item?.value ?? 0
  }

  const rawImports = Array.isArray(data?.imports) ? data.imports : []

  return (
    <>
      <PageIntro
        eyebrow="Carrier & Payment Reconciliation"
        title="Remittance Upload &amp; Settlement Logs"
        description="Reconcile Delhivery COD remittances, shipping charge ledgers, and prepaid gateway settlements against Youthnic Shopify orders. Strict duplicate protection blocks re-uploading the same tracking IDs."
        action={
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
            <div style={{ display: 'flex', background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: '6px', padding: '2px' }}>
              <button
                type="button"
                onClick={() => setFilterMode('month')}
                style={{
                  border: 'none',
                  background: filterMode === 'month' ? 'var(--primary)' : 'transparent',
                  color: filterMode === 'month' ? '#fff' : 'var(--ink)',
                  fontSize: '12px',
                  fontWeight: 600,
                  padding: '4px 10px',
                  borderRadius: '4px',
                  cursor: 'pointer',
                }}
              >
                Month
              </button>
              <button
                type="button"
                onClick={() => setFilterMode('range')}
                style={{
                  border: 'none',
                  background: filterMode === 'range' ? 'var(--primary)' : 'transparent',
                  color: filterMode === 'range' ? '#fff' : 'var(--ink)',
                  fontSize: '12px',
                  fontWeight: 600,
                  padding: '4px 10px',
                  borderRadius: '4px',
                  cursor: 'pointer',
                }}
              >
                Date Range
              </button>
            </div>

            {filterMode === 'month' ? (
              <input
                type="month"
                value={month}
                onChange={(e) => setMonth(e.target.value)}
                style={{ fontSize: '12px', padding: '5px 8px', borderRadius: '6px', border: '1px solid var(--line)' }}
              />
            ) : (
              <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  style={{ fontSize: '12px', padding: '5px 8px', borderRadius: '6px', border: '1px solid var(--line)' }}
                />
                <span style={{ fontSize: '12px', color: 'var(--muted)' }}>to</span>
                <input
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  style={{ fontSize: '12px', padding: '5px 8px', borderRadius: '6px', border: '1px solid var(--line)' }}
                />
              </div>
            )}

            <Button
              className="button-primary"
              loading={downloadReport.isPending}
              onClick={() => downloadReport.mutate()}
            >
              <Icon name="download" size={14} />
              Download Excel Report
            </Button>
          </div>
        }
      />

      {overview.isLoading && <LoadingState label="Loading reconciliation records…" />}
      {overview.isError && <ErrorBox message={apiError(overview.error)} />}

      {data && (
        <>
          {/* Summary Tiles */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px', marginBottom: '16px' }}>
            <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: '10px', padding: '14px 16px' }}>
              <span style={{ fontSize: '11px', color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase' }}>Orders Placed</span>
              <strong className="tabular-nums" style={{ display: 'block', fontSize: '22px', color: 'var(--ink)', fontWeight: 800, marginTop: '4px' }}>
                {value('Orders placed')}
              </strong>
            </div>

            <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: '10px', padding: '14px 16px' }}>
              <span style={{ fontSize: '11px', color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase' }}>Payment Received / Closed</span>
              <strong className="tabular-nums" style={{ display: 'block', fontSize: '22px', color: '#0f766e', fontWeight: 800, marginTop: '4px' }}>
                {value('Closed (delivered, paid, return window over)')}
              </strong>
            </div>

            <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: '10px', padding: '14px 16px' }}>
              <span style={{ fontSize: '11px', color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase' }}>Received in Bank</span>
              <strong className="tabular-nums" style={{ display: 'block', fontSize: '22px', color: '#1d4ed8', fontWeight: 800, marginTop: '4px' }}>
                {formatMoney(Number(value('Received in bank (₹)')))}
              </strong>
            </div>

            <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: '10px', padding: '14px 16px' }}>
              <span style={{ fontSize: '11px', color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase' }}>Delhivery Shipping Cost</span>
              <strong className="tabular-nums" style={{ display: 'block', fontSize: '22px', color: '#b45309', fontWeight: 800, marginTop: '4px' }}>
                {formatMoney(Number(value('Shipping cost total (₹)')))}
              </strong>
            </div>
          </div>

          {/* Upload Cards Grid */}
          <h2 style={{ fontSize: '16px', margin: '20px 0 10px', fontWeight: 700 }}>Upload Remittance &amp; Settlement Files</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '14px' }}>
            {UPLOADS.map((upload) => (
              <RemittanceUploadCard key={upload.kind} upload={upload} onDone={refresh} />
            ))}
          </div>

          {/* Delhivery ONE Synchronized Remittance Log Table */}
          <DelhiveryRemittanceLogTable imports={rawImports} onRefresh={refresh} />

          {/* Complete System Upload & Deduplication History */}
          <Panel className="table-panel" style={{ marginTop: '24px' }}>
            <PanelHeading
              eyebrow="System Logs"
              title={`All Upload Files History & Audit Logs (${rawImports.length})`}
            />
            {rawImports.length === 0 ? (
              <p style={{ fontSize: '13px', color: 'var(--muted)', padding: '16px' }}>No files uploaded yet.</p>
            ) : (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Uploaded At</th>
                      <th>Type</th>
                      <th>File Name</th>
                      <th>Total Rows</th>
                      <th>Matched</th>
                      <th>Duplicates Prevented</th>
                      <th>Not Found</th>
                      <th>Uploaded By</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rawImports.map((row) => {
                      const s = parseSummary(row.summary)
                      const skippedCount = Array.isArray(s.skippedDuplicates)
                        ? s.skippedDuplicates.length
                        : (Number(s.alreadyRemittedCount) || 0)
                      const unmatchedList = Array.isArray(row.unmatched)
                        ? row.unmatched
                        : typeof row.unmatched === 'string'
                        ? (() => { try { return JSON.parse(row.unmatched) } catch { return [] } })()
                        : []

                      return (
                        <tr key={row.id}>
                          <td>{formatDate(row.createdAt)}</td>
                          <td>
                            <span style={{ fontWeight: 600 }}>
                              {UPLOADS.find((u) => u.kind === row.kind)?.title || row.kind}
                            </span>
                          </td>
                          <td style={{ fontFamily: 'var(--mono, monospace)', fontSize: '12px' }}>{row.fileName}</td>
                          <td>{row.rowCount}</td>
                          <td style={{ color: '#047857', fontWeight: 700 }}>{row.matchedCount}</td>
                          <td>
                            {skippedCount > 0 ? (
                              <span
                                style={{
                                  background: '#fef3c7',
                                  color: '#b45309',
                                  padding: '2px 8px',
                                  borderRadius: '999px',
                                  fontSize: '11px',
                                  fontWeight: 700,
                                }}
                                title={`${skippedCount} duplicate tracking IDs blocked`}
                              >
                                {skippedCount} skipped
                              </span>
                            ) : (
                              <span style={{ color: 'var(--muted)', fontSize: '11px' }}>0</span>
                            )}
                          </td>
                          <td>
                            {unmatchedList.length > 0 ? (
                              <span style={{ color: '#dc2626', fontWeight: 600 }}>{unmatchedList.length}</span>
                            ) : (
                              <span style={{ color: 'var(--muted)', fontSize: '11px' }}>0</span>
                            )}
                          </td>
                          <td>{row.uploadedBy || '—'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </>
      )}
    </>
  )
}

export function Remittances() {
  return (
    <ErrorBoundary fallbackTitle="Unable to load Remittance Logs">
      <RemittancesContent />
    </ErrorBoundary>
  )
}
