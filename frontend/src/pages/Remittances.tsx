import { useState, useMemo, useRef, Fragment } from 'react'
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
  type IconName,
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

type CarrierTab = 'DELHIVERY' | 'GOKWIK' | 'PHONEPE' | 'OTHER' | 'LOGS'

interface DuplicateErrorInfo {
  error: string
  code: string
  existingImport?: {
    id: number
    fileName: string
    createdAt: string
    matchedCount: number
    totalRemittance?: number | null
    bankTransactionId?: string | null
    remittanceNumber?: string | null
  }
}

interface UploadConfig {
  kind: AccountsImportKind
  title: string
  providerName: string
  templateKey: 'delhivery-remittance' | 'delhivery-charges' | 'gokwik-settlement' | 'phonepe-settlement' | 'carrier-remittance'
  what: string
  where: string
  badgeText?: string
  withRemittanceFields?: boolean
}

// ─── Prominent Drag & Drop File Zone ─────────────────────────────────────────

function DropZoneUpload({
  file,
  onFileSelect,
  accept = '.xlsx,.csv,.tsv,.txt,.zip',
  hint = 'Supports direct .ZIP (e.g. R3359352026101200000.zip), .XLSX, or .CSV',
  title = 'Click here to choose file or drag & drop it here',
}: {
  file: File | null
  onFileSelect: (file: File | null) => void
  accept?: string
  hint?: string
  title?: string
}) {
  const [isDragging, setIsDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      onFileSelect(e.dataTransfer.files[0])
    }
  }

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
  }

  return (
    <div style={{ width: '100%' }}>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        style={{ display: 'none' }}
        onChange={(e) => onFileSelect(e.target.files?.[0] || null)}
      />

      {!file ? (
        <div
          onClick={() => inputRef.current?.click()}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          style={{
            border: isDragging ? '2px dashed #2563eb' : '2px dashed #3b82f6',
            background: isDragging ? '#eff6ff' : 'var(--bg-subtle, #f0f7ff)',
            borderRadius: '10px',
            padding: '24px 16px',
            textAlign: 'center',
            cursor: 'pointer',
            transition: 'all 0.2s ease',
          }}
        >
          <div
            style={{
              width: '48px',
              height: '48px',
              borderRadius: '50%',
              background: isDragging ? '#dbeafe' : '#dbeafe',
              color: '#2563eb',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto 10px',
            }}
          >
            <Icon name="download" size={24} />
          </div>

          <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--ink, #0f172a)', marginBottom: '4px' }}>
            {title}
          </div>
          <div style={{ fontSize: '12px', color: 'var(--muted, #64748b)', marginBottom: '12px' }}>
            {hint}
          </div>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              background: '#2563eb',
              color: '#ffffff',
              fontSize: '12px',
              fontWeight: 700,
              padding: '7px 18px',
              borderRadius: '6px',
              boxShadow: '0 2px 4px rgba(37,99,235,0.2)',
            }}
          >
            <Icon name="download" size={13} />
            Browse File to Upload
          </span>
        </div>
      ) : (
        <div
          style={{
            border: '2px solid #16a34a',
            background: '#f0fdf4',
            borderRadius: '10px',
            padding: '16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div
              style={{
                width: '42px',
                height: '42px',
                borderRadius: '8px',
                background: '#dcfce7',
                color: '#16a34a',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <Icon name="check" size={24} />
            </div>
            <div>
              <div style={{ fontSize: '14px', fontWeight: 700, color: '#166534', wordBreak: 'break-all' }}>
                {file.name}
              </div>
              <div style={{ fontSize: '12px', color: '#15803d', marginTop: '2px' }}>
                Size: {formatFileSize(file.size)} · Ready to upload &amp; reconcile
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onFileSelect(null)
              if (inputRef.current) inputRef.current.value = ''
            }}
            style={{
              background: '#ffffff',
              border: '1px solid #bbf7d0',
              color: '#dc2626',
              fontSize: '12px',
              fontWeight: 600,
              padding: '6px 14px',
              borderRadius: '6px',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            Change File
          </button>
        </div>
      )}
    </div>
  )
}

// ─── Single-Click Zero-Fuss Upload Card ──────────────────────────────────────

function UniversalUploadCard({
  config,
  onDone,
}: {
  config: UploadConfig
  onDone: () => void
}) {
  const toast = useToast()
  const [file, setFile] = useState<File | null>(null)
  const [showOverrides, setShowOverrides] = useState(false)
  const [utr, setUtr] = useState('')
  const [remittanceRef, setRemittanceRef] = useState('')
  const [remittedAt, setRemittedAt] = useState('')
  const [result, setResult] = useState<AccountsImportResult | null>(null)
  const [duplicateError, setDuplicateError] = useState<DuplicateErrorInfo | null>(null)

  const mutation = useMutation({
    mutationFn: (options?: { force?: boolean }) => {
      if (!file) throw new Error('Please select a file to upload.')
      return importAccountsFile(
        config.kind,
        file,
        config.withRemittanceFields
          ? {
              utr: utr.trim() || undefined,
              remittanceRef: remittanceRef.trim() || undefined,
              remittedAt: remittedAt || undefined,
            }
          : undefined,
        options?.force
      )
    },
    onSuccess: (data) => {
      setResult(data)
      setDuplicateError(null)
      const dupCount = data.skippedDuplicates?.length || 0
      const message = `${config.title}: ${data.matchedCount} of ${data.rowCount} rows matched.${
        dupCount > 0 ? ` · ${dupCount} duplicate tracking ID(s) skipped` : ''
      }${data.closedNow ? ` · ${data.closedNow} order(s) moved to Payment Received` : ''}`
      toast.toast(data.matchedCount > 0 || dupCount > 0 ? 'success' : 'error', message)
      onDone()
    },
    onError: (error: any) => {
      const data = error?.response?.data
      if (data?.code === 'DUPLICATE_FILE_ALREADY_UPLOADED') {
        setDuplicateError(data)
        toast.toast('error', 'Duplicate file upload blocked.')
      } else {
        setDuplicateError(null)
        toast.toast('error', apiError(error))
      }
    },
  })

  return (
    <Panel style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 700 }}>{config.title}</h3>
            {config.badgeText && (
              <span
                style={{
                  background: '#dbeafe',
                  color: '#1d4ed8',
                  fontSize: '10px',
                  fontWeight: 700,
                  padding: '2px 6px',
                  borderRadius: '4px',
                }}
              >
                {config.badgeText}
              </span>
            )}
          </div>
          <p style={{ margin: '4px 0 0', fontSize: '12px', color: 'var(--muted)' }}>{config.what}</p>
        </div>
        <button
          type="button"
          onClick={() => downloadAccountsTemplate(config.templateKey)}
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

      <div
        style={{
          background: 'var(--bg-subtle, #f8fafc)',
          border: '1px solid var(--line)',
          borderRadius: '6px',
          padding: '8px 10px',
          fontSize: '11px',
          color: 'var(--muted)',
        }}
      >
        <strong>Source:</strong> {config.where}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: '#047857' }}>
        <Icon name="shield" size={13} />
        <span>
          <strong>Duplicate Guard Active:</strong> Already-uploaded files and duplicate tracking IDs are blocked.
        </span>
      </div>

      {/* Prominent Drag & Drop File Zone */}
      <DropZoneUpload
        file={file}
        onFileSelect={(selected) => {
          setFile(selected)
          setResult(null)
          setDuplicateError(null)
        }}
        hint="Direct .zip (e.g. R3359352026101200000.zip), .xlsx, or .csv supported."
      />

      {/* Duplicate Error Banner (When Operator attempts duplicate upload) */}
      {duplicateError && (
        <div
          style={{
            background: '#fef2f2',
            border: '2px solid #ef4444',
            borderRadius: '8px',
            padding: '12px 14px',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#991b1b', fontWeight: 700, fontSize: '13px' }}>
            <Icon name="alert" size={16} />
            <span>Duplicate File Detected — Upload Blocked</span>
          </div>
          <p style={{ margin: 0, fontSize: '12px', color: '#7f1d1d', lineHeight: 1.4 }}>
            {duplicateError.error}
          </p>
          {duplicateError.existingImport && (
            <div style={{ fontSize: '11px', color: '#7f1d1d', background: '#fee2e2', padding: '6px 10px', borderRadius: '4px' }}>
              <strong>Already in Database:</strong> Batch #{duplicateError.existingImport.id} ({duplicateError.existingImport.fileName})
              {duplicateError.existingImport.totalRemittance ? ` · Total: ${formatMoney(duplicateError.existingImport.totalRemittance)}` : ''}
              {duplicateError.existingImport.bankTransactionId ? ` · UTR: ${duplicateError.existingImport.bankTransactionId}` : ''}
            </div>
          )}
          <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
            <Button
              className="button-secondary"
              style={{ fontSize: '11px', padding: '4px 10px' }}
              onClick={() => setDuplicateError(null)}
            >
              Cancel
            </Button>
            <Button
              className="button-primary"
              style={{ fontSize: '11px', padding: '4px 10px', background: '#dc2626', borderColor: '#b91c1c' }}
              loading={mutation.isPending}
              onClick={() => mutation.mutate({ force: true })}
            >
              Force Re-Upload (Override)
            </Button>
          </div>
        </div>
      )}

      {/* Optional Manual Overrides (Accordion for data entry flexibility) */}
      {config.withRemittanceFields && (
        <div>
          <button
            type="button"
            onClick={() => setShowOverrides(!showOverrides)}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--muted)',
              fontSize: '11px',
              padding: '2px 0',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
            }}
          >
            <Icon name={showOverrides ? 'chevron' : 'arrow'} size={11} />
            {showOverrides ? 'Hide Manual Override Fields' : 'Manual Overrides (Optional — leave blank to auto-detect)'}
          </button>
          {showOverrides && (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
                gap: '8px',
                marginTop: '8px',
                background: 'var(--bg-subtle, #f8fafc)',
                padding: '8px',
                borderRadius: '6px',
              }}
            >
              <FormField label="Bank's UTR / Transaction ID" hint="Used if file lacks UTR">
                <input value={utr} onChange={(e) => setUtr(e.target.value)} placeholder="e.g. AXISP00847547449" />
              </FormField>
              <FormField label="Remittance Ref" hint="Auto-read from filename if empty">
                <input value={remittanceRef} onChange={(e) => setRemittanceRef(e.target.value)} placeholder="e.g. R3359352026101300001" />
              </FormField>
              <FormField label="Remittance Date" hint="Auto-read from batch">
                <input type="date" value={remittedAt} onChange={(e) => setRemittedAt(e.target.value)} />
              </FormField>
            </div>
          )}
        </div>
      )}

      {/* Prominent Action Button */}
      <Button
        className="button-primary"
        loading={mutation.isPending}
        disabled={!file || mutation.isPending}
        onClick={() => mutation.mutate()}
        style={{
          width: '100%',
          padding: '12px',
          fontSize: '14px',
          fontWeight: 700,
          background: file ? '#16a34a' : undefined,
          borderColor: file ? '#15803d' : undefined,
          color: '#ffffff',
          boxShadow: file ? '0 4px 6px -1px rgba(22, 163, 74, 0.25)' : undefined,
        }}
      >
        <Icon name={file ? 'check' : 'download'} size={15} />
        {file
          ? `Upload & Reconcile ${file.name}`
          : `Select or Drop File Above to Reconcile`}
      </Button>

      {/* Upload Outcome Snapshot */}
      {result && (
        <div style={{ fontSize: '12px', borderTop: '1px solid var(--line)', paddingTop: '10px' }}>
          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
            <span>
              <strong>{result.matchedCount}</strong> of <strong>{result.rowCount}</strong> rows matched
            </span>
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

          {Array.isArray(result.notes) &&
            result.notes.map((note) => (
              <div
                key={note}
                style={{
                  color: '#b45309',
                  marginTop: '6px',
                  fontSize: '11px',
                  background: '#fef3c7',
                  padding: '4px 8px',
                  borderRadius: '4px',
                }}
              >
                {note}
              </div>
            ))}
        </div>
      )}
    </Panel>
  )
}

// ─── Synchronized Remittance & Settlement Table ──────────────────────────────

function CarrierRemittanceTable({
  title,
  subtitle,
  emptyMessage,
  carrierBadge,
  imports,
  onRefresh,
}: {
  title: string
  subtitle: string
  emptyMessage: string
  carrierBadge: string
  imports: AccountsImportRecord[]
  onRefresh: () => void
}) {
  const toast = useToast()
  const [search, setSearch] = useState('')
  const [stateFilter, setStateFilter] = useState<'ALL' | 'Completed' | 'Pending'>('ALL')
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [editingUtrId, setEditingUtrId] = useState<number | null>(null)
  const [editingUtrValue, setEditingUtrValue] = useState('')

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase()
    return imports.filter((row) => {
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
  }, [imports, search, stateFilter])

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
    <Panel className="table-panel" style={{ marginTop: '20px' }}>
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--line)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <h2 style={{ fontSize: '17px', fontWeight: 800, margin: 0 }}>{title}</h2>
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
                {carrierBadge}
              </span>
            </div>
            <p style={{ margin: '4px 0 0', fontSize: '12px', color: 'var(--muted)' }}>{subtitle}</p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
            <input
              type="search"
              placeholder="Search Remittance No / UTR / File…"
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
          {imports.length === 0 ? emptyMessage : 'No remittances matching your search criteria.'}
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th style={{ width: '40px' }}></th>
                <th>REMITTANCE / BATCH NO</th>
                <th>DATE</th>
                <th>BANK'S TRANSACTION ID / UTR</th>
                <th>STATE</th>
                <th style={{ textAlign: 'right' }}>TOTAL AMOUNT</th>
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
                          <span
                            style={{
                              marginLeft: '6px',
                              fontSize: '10px',
                              background: '#dbeafe',
                              color: '#1e40af',
                              padding: '1px 5px',
                              borderRadius: '4px',
                            }}
                          >
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
                          <span style={{ fontFamily: 'var(--mono, monospace)', fontSize: '12px', fontWeight: 600 }}>
                            {utr}
                          </span>
                        ) : (
                          <span style={{ color: '#b45309', fontSize: '11px', fontStyle: 'italic' }}>
                            Awaiting Bank UTR
                          </span>
                        )}
                      </td>
                      <td>
                        <span
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '4px',
                            padding: '2px 8px',
                            borderRadius: '12px',
                            fontSize: '11px',
                            fontWeight: 700,
                            background: isCompleted ? '#dcfce7' : '#fef3c7',
                            color: isCompleted ? '#166534' : '#92400e',
                          }}
                        >
                          <span
                            style={{
                              width: '6px',
                              height: '6px',
                              borderRadius: '50%',
                              background: isCompleted ? '#16a34a' : '#d97706',
                            }}
                          />
                          {isCompleted ? 'Completed' : 'Pending'}
                        </span>
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 700 }}>
                        {typeof total === 'number' ? formatMoney(total) : total}
                      </td>
                      <td>
                        <span style={{ fontWeight: 700, color: '#047857' }}>{row.matchedCount}</span> orders
                        {isExpanded && <span style={{ fontSize: '11px', color: 'var(--muted)', marginLeft: '4px' }}>(expanded)</span>}
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        {!isEditingThisUtr && (
                          <button
                            type="button"
                            onClick={() => {
                              setEditingUtrId(row.id)
                              setEditingUtrValue(utr)
                            }}
                            style={{
                              border: '1px solid var(--line)',
                              background: 'var(--panel)',
                              fontSize: '11px',
                              padding: '2px 8px',
                              borderRadius: '4px',
                              cursor: 'pointer',
                              color: 'var(--ink)',
                            }}
                          >
                            {utr ? 'Edit UTR' : '+ Add UTR'}
                          </button>
                        )}
                      </td>
                    </tr>

                    {/* Order Drilldown Snapshot */}
                    {isExpanded && (
                      <tr key={`${row.id}-details`} style={{ background: 'var(--bg-subtle, #f8fafc)' }}>
                        <td colSpan={8} style={{ padding: '12px 20px' }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--ink)' }}>
                                Matched Order Snapshots for Batch {ref} ({matchedOrders.length} orders shown):
                              </span>
                              <span style={{ fontSize: '11px', color: 'var(--muted)' }}>
                                Source File: <code>{row.fileName}</code>
                              </span>
                            </div>

                            {matchedOrders.length > 0 ? (
                              <div style={{ maxHeight: '240px', overflowY: 'auto', border: '1px solid var(--line)', borderRadius: '6px', background: 'var(--panel)' }}>
                                <table className="data-table" style={{ fontSize: '11px', margin: 0 }}>
                                  <thead>
                                    <tr>
                                      <th>Shopify Order</th>
                                      <th>Tracking / AWB</th>
                                      <th>Destination City</th>
                                      <th style={{ textAlign: 'right' }}>Amount</th>
                                      <th>Status</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {matchedOrders.map((mo, idx) => (
                                      <tr key={idx}>
                                        <td style={{ fontWeight: 600 }}>{mo.shopifyOrderName || `#${mo.orderId}`}</td>
                                        <td style={{ fontFamily: 'monospace' }}>{mo.waybillNumber || '—'}</td>
                                        <td>{mo.city || '—'}</td>
                                        <td style={{ textAlign: 'right', fontWeight: 600 }}>{formatMoney(mo.amount || 0)}</td>
                                        <td>
                                          <span style={{ background: '#dcfce7', color: '#166534', padding: '1px 6px', borderRadius: '4px', fontSize: '10px', fontWeight: 700 }}>
                                            {mo.status || 'DELIVERED'}
                                          </span>
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            ) : (
                              <p style={{ margin: 0, fontSize: '12px', color: 'var(--muted)' }}>
                                Matched {row.matchedCount} orders. Detailed per-order snapshots available for newly uploaded batches.
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

// ─── Main Unified Remittance & Settlement Page ───────────────────────────────

function RemittancesContent() {
  useDocumentTitle('Payments & Remittance')
  const toast = useToast()
  const queryClient = useQueryClient()
  const [activeTab, setActiveTab] = useState<CarrierTab>('DELHIVERY')
  const [otherCarrierType, setOtherCarrierType] = useState<AccountsImportKind>('AMAZON_SHIPPING')

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

  // Split imports by provider
  const delhiveryImports = useMemo(() => {
    return rawImports.filter((imp) => imp && imp.kind === 'DELHIVERY_REMITTANCE')
  }, [rawImports])

  const gokwikImports = useMemo(() => {
    return rawImports.filter(
      (imp) => imp && (imp.kind === 'GOKWIK_SETTLEMENT' || (imp.kind === 'PG_SETTLEMENT' && imp.fileName.toLowerCase().includes('gokwik')))
    )
  }, [rawImports])

  const phonepeImports = useMemo(() => {
    return rawImports.filter(
      (imp) => imp && (imp.kind === 'PHONEPE_SETTLEMENT' || (imp.kind === 'PG_SETTLEMENT' && imp.fileName.toLowerCase().includes('phonepe')))
    )
  }, [rawImports])

  const otherImports = useMemo(() => {
    return rawImports.filter(
      (imp) =>
        imp &&
        (imp.kind === 'AMAZON_SHIPPING' ||
          imp.kind === 'EKART_SHIPPING' ||
          imp.kind === 'GENERIC_CARRIER' ||
          (!['DELHIVERY_REMITTANCE', 'DELHIVERY_CHARGES', 'GOKWIK_SETTLEMENT', 'PHONEPE_SETTLEMENT'].includes(imp.kind) &&
            !imp.fileName.toLowerCase().includes('delhivery') &&
            !imp.fileName.toLowerCase().includes('gokwik') &&
            !imp.fileName.toLowerCase().includes('phonepe')))
    )
  }, [rawImports])

  const CARRIER_TABS: Array<{ id: CarrierTab; label: string; icon: IconName; count: number }> = [
    { id: 'DELHIVERY', label: 'Delhivery', icon: 'truck', count: delhiveryImports.length },
    { id: 'GOKWIK', label: 'GoKwik', icon: 'zap', count: gokwikImports.length },
    { id: 'PHONEPE', label: 'PhonePe', icon: 'creditCard', count: phonepeImports.length },
    { id: 'OTHER', label: 'Other Carriers', icon: 'package', count: otherImports.length },
    { id: 'LOGS', label: 'Audit Logs & History', icon: 'database', count: rawImports.length },
  ]

  return (
    <>
      <PageIntro
        eyebrow="Logistics & Finance"
        title="Payments &amp; Remittance Hub"
        description="Unified reconciliation for Delhivery COD remittances, GoKwik prepaid settlements, PhonePe Business, and partner carriers. Direct ZIP file uploads with strict duplicate protection."
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
          {/* Top Summary Metrics */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px', marginBottom: '20px' }}>
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

          {/* Provider Navigation Tabs with High Contrast Design */}
          <div
            style={{
              display: 'flex',
              gap: '8px',
              padding: '6px',
              background: 'var(--bg-subtle, #f1f5f9)',
              borderRadius: '12px',
              border: '1px solid var(--line, #e2e8f0)',
              marginBottom: '20px',
              overflowX: 'auto',
              flexWrap: 'wrap',
            }}
          >
            {CARRIER_TABS.map((tab) => {
              const isActive = activeTab === tab.id
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '8px',
                    padding: '9px 18px',
                    borderRadius: '8px',
                    border: isActive ? '1px solid #1d4ed8' : '1px solid #cbd5e1',
                    background: isActive ? '#2563eb' : '#ffffff',
                    color: isActive ? '#ffffff' : '#334155',
                    fontSize: '13px',
                    fontWeight: isActive ? 700 : 600,
                    cursor: 'pointer',
                    boxShadow: isActive
                      ? '0 2px 4px rgba(37, 99, 235, 0.25)'
                      : '0 1px 2px rgba(0, 0, 0, 0.05)',
                    transition: 'all 0.15s ease',
                    whiteSpace: 'nowrap',
                  }}
                >
                  <Icon name={tab.icon} size={16} />
                  <span>{tab.label}</span>
                  <span
                    style={{
                      background: isActive ? 'rgba(255,255,255,0.25)' : '#e2e8f0',
                      color: isActive ? '#ffffff' : '#475569',
                      padding: '2px 7px',
                      borderRadius: '10px',
                      fontSize: '11px',
                      fontWeight: 700,
                    }}
                  >
                    {tab.count}
                  </span>
                </button>
              )
            })}
          </div>

          {/* 1. DELHIVERY TAB */}
          {activeTab === 'DELHIVERY' && (
            <div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '16px' }}>
                <UniversalUploadCard
                  config={{
                    kind: 'DELHIVERY_REMITTANCE',
                    title: 'Delhivery COD Remittance (ZIP or CSV/XLSX)',
                    providerName: 'Delhivery Remittance',
                    templateKey: 'delhivery-remittance',
                    badgeText: 'Auto-Extracts ZIP',
                    what: 'Matches delivered COD orders by Waybill / Order No and writes Bank Transaction ID (UTR), marking orders as Payment Received.',
                    where: 'Delhivery ONE → Finances → Remittance → click remittance number → Download AWB list (.zip, .xlsx or .csv).',
                    withRemittanceFields: true,
                  }}
                  onDone={refresh}
                />
                <UniversalUploadCard
                  config={{
                    kind: 'DELHIVERY_CHARGES',
                    title: 'Delhivery Shipping Charges Ledger',
                    providerName: 'Delhivery Ledger',
                    templateKey: 'delhivery-charges',
                    what: 'Replaces freight estimates with exact billed shipping charges (Forward, RTO, Reverse pickup) from Delhivery wallet ledger.',
                    where: 'Delhivery ONE → Finances → Wallet → Transactions → Download Ledger (or invoice AWB-wise backup).',
                  }}
                  onDone={refresh}
                />
              </div>

              <CarrierRemittanceTable
                title="Delhivery 2-Day Remittances"
                subtitle="Your bank account is credited 2 days post daily remittance · Delhivery ONE Synchronized"
                carrierBadge="Delhivery ONE"
                emptyMessage="No Delhivery COD remittances uploaded yet. Upload your first remittance ZIP or CSV file above."
                imports={delhiveryImports}
                onRefresh={refresh}
              />
            </div>
          )}

          {/* 2. GOKWIK TAB */}
          {activeTab === 'GOKWIK' && (
            <div>
              <div style={{ maxWidth: '640px', marginBottom: '14px' }}>
                <UniversalUploadCard
                  config={{
                    kind: 'GOKWIK_SETTLEMENT',
                    title: 'GoKwik Prepaid Settlement Report (ZIP, CSV, or XLSX)',
                    providerName: 'GoKwik Settlements',
                    templateKey: 'gokwik-settlement',
                    badgeText: 'MDR Deducted',
                    what: 'Matches prepaid orders, marks orders as Payment Received, logs settlement UTR, and accounts for gateway fees.',
                    where: 'GoKwik Merchant Dashboard → Settlements → Download transaction-wise settlement report.',
                    withRemittanceFields: true,
                  }}
                  onDone={refresh}
                />
              </div>

              <CarrierRemittanceTable
                title="GoKwik Prepaid Settlements &amp; MDR"
                subtitle="Prepaid orders settled via GoKwik Checkout with payment gateway deductions"
                carrierBadge="GoKwik Gateway"
                emptyMessage="No GoKwik settlement reports uploaded yet. Upload your settlement file above."
                imports={gokwikImports}
                onRefresh={refresh}
              />
            </div>
          )}

          {/* 3. PHONEPE TAB */}
          {activeTab === 'PHONEPE' && (
            <div>
              <div style={{ maxWidth: '640px', marginBottom: '14px' }}>
                <UniversalUploadCard
                  config={{
                    kind: 'PHONEPE_SETTLEMENT',
                    title: 'PhonePe Business Settlement Report (ZIP, CSV, or XLSX)',
                    providerName: 'PhonePe Settlements',
                    templateKey: 'phonepe-settlement',
                    badgeText: 'Axis / HDFC UTR',
                    what: 'Matches orders paid via PhonePe Business, writes bank settlement UTR, and tallies net credited money into ICICI.',
                    where: 'PhonePe Business Dashboard → Settlements → Download Daily Settlement Report.',
                    withRemittanceFields: true,
                  }}
                  onDone={refresh}
                />
              </div>

              <CarrierRemittanceTable
                title="PhonePe Business Settlements"
                subtitle="Settlement transactions credited to your bank account from PhonePe Business"
                carrierBadge="PhonePe PG"
                emptyMessage="No PhonePe settlement reports uploaded yet. Upload your settlement file above."
                imports={phonepeImports}
                onRefresh={refresh}
              />
            </div>
          )}

          {/* 4. OTHER CARRIERS TAB (Amazon Shipping, Ekart, Generic) */}
          {activeTab === 'OTHER' && (
            <div>
              <div style={{ maxWidth: '640px', marginBottom: '14px' }}>
                <div style={{ marginBottom: '8px' }}>
                  <label style={{ fontSize: '12px', fontWeight: 600, display: 'block', marginBottom: '4px' }}>
                    Select Carrier Partner:
                  </label>
                  <select
                    value={otherCarrierType}
                    onChange={(e) => setOtherCarrierType(e.target.value as any)}
                    style={{
                      fontSize: '12px',
                      padding: '6px 10px',
                      borderRadius: '6px',
                      border: '1px solid var(--line)',
                      background: 'var(--panel)',
                      width: '100%',
                    }}
                  >
                    <option value="AMAZON_SHIPPING">Amazon Shipping</option>
                    <option value="EKART_SHIPPING">Ekart Logistics</option>
                    <option value="GENERIC_CARRIER">Other / Generic Carrier</option>
                  </select>
                </div>

                <UniversalUploadCard
                  config={{
                    kind: otherCarrierType,
                    title: `${
                      otherCarrierType === 'AMAZON_SHIPPING'
                        ? 'Amazon Shipping'
                        : otherCarrierType === 'EKART_SHIPPING'
                        ? 'Ekart Logistics'
                        : 'Partner Carrier'
                    } Remittance Report (ZIP, CSV, XLSX)`,
                    providerName: 'Carrier Remittance',
                    templateKey: 'carrier-remittance',
                    badgeText: 'Extensible Courier',
                    what: 'Matches parcels by AWB or order number, marks delivered orders as Payment Received, and records UTR.',
                    where: 'Carrier Merchant Portal → Billing / Remittances → Download Remittance Statement.',
                    withRemittanceFields: true,
                  }}
                  onDone={refresh}
                />
              </div>

              <CarrierRemittanceTable
                title="Partner Carrier Remittances"
                subtitle="Amazon Shipping, Ekart Logistics, and third-party courier partner remittances"
                carrierBadge="Partner Couriers"
                emptyMessage="No partner carrier remittances uploaded yet. Select your courier partner and upload above."
                imports={otherImports}
                onRefresh={refresh}
              />
            </div>
          )}

          {/* 5. AUDIT LOGS & HISTORY TAB */}
          {activeTab === 'LOGS' && (
            <Panel className="table-panel">
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
                        <th>Carrier / Provider</th>
                        <th>File Name</th>
                        <th>Total Rows</th>
                        <th>Matched Orders</th>
                        <th>Duplicates Blocked</th>
                        <th>Not Found</th>
                        <th>Uploaded By</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rawImports.map((row) => {
                        const s = parseSummary(row.summary)
                        const skippedCount = Array.isArray(s.skippedDuplicates)
                          ? s.skippedDuplicates.length
                          : Number(s.alreadyRemittedCount) || 0
                        const unmatchedList = Array.isArray(row.unmatched)
                          ? row.unmatched
                          : typeof row.unmatched === 'string'
                          ? (() => {
                              try {
                                return JSON.parse(row.unmatched)
                              } catch {
                                return []
                              }
                            })()
                          : []

                        const providerLabel =
                          row.kind === 'DELHIVERY_REMITTANCE'
                            ? 'Delhivery Remittance'
                            : row.kind === 'DELHIVERY_CHARGES'
                            ? 'Delhivery Charges'
                            : row.kind === 'GOKWIK_SETTLEMENT'
                            ? 'GoKwik Settlement'
                            : row.kind === 'PHONEPE_SETTLEMENT'
                            ? 'PhonePe Settlement'
                            : row.kind === 'AMAZON_SHIPPING'
                            ? 'Amazon Shipping'
                            : row.kind === 'EKART_SHIPPING'
                            ? 'Ekart Logistics'
                            : row.kind

                        return (
                          <tr key={row.id}>
                            <td>{formatDate(row.createdAt)}</td>
                            <td>
                              <span style={{ fontWeight: 600 }}>{providerLabel}</span>
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
          )}
        </>
      )}
    </>
  )
}

export function Remittances() {
  return (
    <ErrorBoundary fallbackTitle="Unable to load Payments & Remittance Hub">
      <RemittancesContent />
    </ErrorBoundary>
  )
}
