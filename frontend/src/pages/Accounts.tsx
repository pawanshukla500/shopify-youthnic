import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  apiError,
  downloadAccountsReport,
  emailAccountsReport,
  getAccountsOverview,
  importAccountsFile,
  runAccountsNow,
  saveAccountsRecipients,
  type AccountsImportKind,
  type AccountsImportResult,
} from '../api'
import { Button, ErrorBox, FormField, Icon, LoadingState, PageIntro, Panel, PanelHeading, useDocumentTitle, useToast } from '../components/UI'
import { formatDate, formatMoney } from '../lib'

/** Last month in IST, as YYYY-MM: the report the accounts team closes next. */
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
    what: 'Replaces the estimated shipping cost with what Delhivery actually billed, per AWB: forward, RTO and reverse pickup.',
    where: 'Delhivery One → Finances → Wallet → Transactions → Download Ledger (or an invoice’s AWB-wise backup).',
  },
  {
    kind: 'PG_SETTLEMENT',
    title: 'Prepaid settlement (GoKwik / Easebuzz / PhonePe)',
    what: 'Marks prepaid orders as paid into the bank, with the settlement UTR and gateway fees.',
    where: 'PhonePe Business / Easebuzz / GoKwik dashboard → Settlements → download the transaction-wise settlement report.',
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
          <strong>Where:</strong> {upload.where}
        </p>
      </div>
      <input type="file" accept=".xlsx,.csv,.tsv,.txt" onChange={(event) => { setFile(event.target.files?.[0] || null); setResult(null) }} />
      {upload.withRemittanceFields && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
          <FormField label="UTR / Bank Transaction ID" hint="Used for rows that have none">
            <input value={utr} onChange={(e) => setUtr(e.target.value)} placeholder="e.g. UTIBR52026100800123" />
          </FormField>
          <FormField label="Remittance No">
            <input value={remittanceRef} onChange={(e) => setRemittanceRef(e.target.value)} placeholder="Optional" />
          </FormField>
          <FormField label="Remitted on">
            <input type="date" value={remittedAt} onChange={(e) => setRemittedAt(e.target.value)} />
          </FormField>
        </div>
      )}
      <Button className="button-primary" loading={mutation.isPending} disabled={!file || mutation.isPending} onClick={() => mutation.mutate()}>
        <Icon name="download" size={14} />
        Upload and match
      </Button>
      {result && (
        <div style={{ fontSize: '12px', borderTop: '1px solid var(--line)', paddingTop: '8px' }}>
          <div>
            <strong>{result.matchedCount}</strong> matched of <strong>{result.rowCount}</strong> rows
            {result.unmatched.length > 0 && <> · <strong>{result.unmatched.length}</strong> not found</>}
          </div>
          {result.notes.map((note) => (
            <div key={note} style={{ color: '#b45309', marginTop: '4px' }}>{note}</div>
          ))}
          {result.unmatched.length > 0 && (
            <details style={{ marginTop: '4px' }}>
              <summary>Not found in the OMS</summary>
              <div style={{ fontFamily: 'var(--mono, monospace)', fontSize: '11px', wordBreak: 'break-all' }}>{result.unmatched.slice(0, 100).join(', ')}</div>
            </details>
          )}
          <details style={{ marginTop: '4px' }}>
            <summary>Columns used</summary>
            {Object.entries(result.columns).map(([field, header]) => (
              <div key={field}>{field}: {header || '—'}</div>
            ))}
          </details>
        </div>
      )}
    </Panel>
  )
}

export function Accounts() {
  useDocumentTitle('Payments & Accounts')
  const toast = useToast()
  const queryClient = useQueryClient()
  const [month, setMonth] = useState(defaultMonth)
  const [recipients, setRecipients] = useState('')

  const overview = useQuery({ queryKey: ['accounts-overview', month], queryFn: () => getAccountsOverview(month), retry: false })
  useEffect(() => {
    if (overview.data) setRecipients(overview.data.recipients.join(', '))
  }, [overview.data?.recipients.join(',')])

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['accounts-overview'] })
    queryClient.invalidateQueries({ queryKey: ['orders'] })
  }

  const download = useMutation({
    mutationFn: () => downloadAccountsReport(month),
    onError: (error) => toast.toast('error', apiError(error)),
  })
  const email = useMutation({
    mutationFn: () => emailAccountsReport(month),
    onSuccess: (data) => {
      toast.toast('success', `Report emailed to ${data.sentTo.join(', ')}.`)
      refresh()
    },
    onError: (error) => toast.toast('error', apiError(error)),
  })
  const saveRecipients = useMutation({
    mutationFn: () => saveAccountsRecipients(recipients),
    onSuccess: (data) => {
      toast.toast('success', data.recipients.length ? `Report will go to ${data.recipients.join(', ')}.` : 'Recipients cleared.')
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

  const data = overview.data
  const value = (label: string) => data?.summary.find((s) => s.label === label)?.value ?? 0
  const tiles: Array<{ label: string; value: string | number; tone: string }> = data
    ? [
        { label: 'Orders placed', value: value('Orders placed'), tone: 'var(--ink)' },
        { label: 'Payment received & closed', value: value('Closed (delivered, paid, return window over)'), tone: '#0f766e' },
        { label: 'Still open', value: value('Open'), tone: '#b45309' },
        { label: 'Received in bank', value: formatMoney(Number(value('Received in bank (₹)'))), tone: '#1d4ed8' },
      ]
    : []

  return (
    <>
      <PageIntro
        eyebrow="Logistics & Finance"
        title="Payments & Accounts"
        description="Money received per order with its bank UTR, shipping cost per AWB, and the monthly closing report for the accounts team."
        action={
          <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <FormField label="Orders placed in">
              <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
            </FormField>
            <Button className="button-primary" loading={download.isPending} onClick={() => download.mutate()}>
              <Icon name="download" size={14} />
              Download Excel
            </Button>
            <Button className="button-secondary" loading={email.isPending} onClick={() => email.mutate()}>
              <Icon name="mail" size={14} />
              Email to accounts
            </Button>
          </div>
        }
      />

      {overview.isLoading && <LoadingState label="Loading the month…" />}
      {overview.isError && <ErrorBox message={apiError(overview.error)} />}

      {data && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px', marginBottom: '16px' }}>
            {tiles.map((tile) => (
              <div key={tile.label} style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: '10px', padding: '14px 16px' }}>
                <span style={{ fontSize: '11px', color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase' }}>{tile.label}</span>
                <strong className="tabular-nums" style={{ display: 'block', fontSize: '22px', color: tile.tone, fontWeight: 800, marginTop: '4px' }}>
                  {tile.value}
                </strong>
              </div>
            ))}
          </div>

          <Panel>
            <PanelHeading
              eyebrow={data.label}
              title="How an order closes"
              action={
                <Button className="button-secondary button-small" loading={runNow.isPending} onClick={() => runNow.mutate()}>
                  <Icon name="refresh" size={13} />
                  Check now
                </Button>
              }
            />
            <p style={{ margin: '0 0 10px', fontSize: '13px' }}>
              An order moves to <strong>Payment Received</strong> when it is <strong>delivered</strong>, its money is
              <strong> in Youthnic&rsquo;s bank</strong> (prepaid settlement or Delhivery COD remittance, with UTR), and the
              <strong> 7-day return window</strong> has passed with no open return. This is checked every hour.
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '8px', fontSize: '13px' }}>
              {[
                ['Waiting for delivery', '   …waiting for delivery'],
                ['Waiting for payment in bank', '   …waiting for payment in bank'],
                ['Return window still open', '   …return window still open'],
                ['Return in progress', '   …return in progress'],
              ].map(([labelText, key]) => (
                <div key={key} style={{ border: '1px solid var(--line)', borderRadius: '8px', padding: '8px 10px' }}>
                  {labelText}: <strong>{value(key)}</strong>
                </div>
              ))}
            </div>
          </Panel>

          <h2 style={{ fontSize: '16px', margin: '20px 0 8px' }}>Bring in payments and shipping costs</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '12px' }}>
            {UPLOADS.map((upload) => (
              <UploadCard key={upload.kind} upload={upload} onDone={refresh} />
            ))}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '12px', marginTop: '16px' }}>
            <Panel>
              <PanelHeading eyebrow="Monthly report" title={`Emailed on the ${data.reportDay}th of every month`} />
              <p style={{ margin: '0 0 8px', fontSize: '13px' }}>
                {data.reportSentAt
                  ? <>The {data.label} report was emailed on {formatDate(data.reportSentAt.sentAt)} to {data.reportSentAt.to.join(', ')}.</>
                  : <>The {data.label} report goes out on <strong>{nextReportDate(month, data.reportDay)}</strong> at 09:00 IST.</>}
              </p>
              <FormField label="Send the report to" hint="Comma-separated email addresses of the accounts team">
                <input value={recipients} onChange={(e) => setRecipients(e.target.value)} placeholder="accounts@youthnic.com, finance@vbexports.co.in" />
              </FormField>
              <Button className="button-primary button-small" style={{ marginTop: '8px' }} loading={saveRecipients.isPending} onClick={() => saveRecipients.mutate()}>
                Save recipients
              </Button>
            </Panel>

            <Panel>
              <PanelHeading eyebrow="Connections" title="Where the numbers come from" />
              <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '13px', lineHeight: 1.7 }}>
                <li>
                  Shipping cost estimates (Delhivery rate API): <strong>{data.connectors.delhiveryRateApi ? 'on' : 'off'}</strong>. Exact charges come from the ledger upload.
                </li>
                <li>
                  PhonePe settlement API: <strong>{data.connectors.phonepeSettlementApi ? 'on' : 'needs API keys'}</strong>
                  {!data.connectors.phonepeSettlementApi && ' (Client ID / Secret from PhonePe; until then upload the settlement report)'}
                </li>
                <li>
                  Easebuzz payout API: <strong>{data.connectors.easebuzzPayoutApi ? 'on' : 'needs API keys'}</strong>
                </li>
                <li>
                  Delhivery COD remittance: <strong>upload only</strong> (Delhivery has no remittance API)
                </li>
                <li>
                  Report email (Resend): <strong>{data.connectors.email ? 'on' : 'not configured'}</strong>
                </li>
              </ul>
            </Panel>
          </div>

          <Panel className="table-panel" style={{ marginTop: '16px' }}>
            <PanelHeading eyebrow={data.label} title={`Open orders (${data.openOrders.length})`} />
            {data.openOrders.length === 0 ? (
              <p style={{ fontSize: '13px', color: 'var(--muted)' }}>Every order placed this month is closed or not a sale.</p>
            ) : (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr><th>Order</th><th>Mode</th><th style={{ textAlign: 'right' }}>Value</th><th>Waiting for</th></tr>
                  </thead>
                  <tbody>
                    {data.openOrders.map((row) => (
                      <tr key={row.orderNo}>
                        <td><strong>{row.orderNo}</strong></td>
                        <td>{row.paymentMode}</td>
                        <td className="amount-cell">{formatMoney(row.orderValue)}</td>
                        <td style={{ fontSize: '12px' }}>{row.pending}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <Panel className="table-panel" style={{ marginTop: '16px' }}>
            <PanelHeading eyebrow="History" title="Uploaded files" />
            {data.imports.length === 0 ? (
              <p style={{ fontSize: '13px', color: 'var(--muted)' }}>No files uploaded yet.</p>
            ) : (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr><th>When</th><th>Type</th><th>File</th><th>Matched</th><th>Not found</th><th>By</th></tr>
                  </thead>
                  <tbody>
                    {data.imports.map((row) => (
                      <tr key={row.id}>
                        <td>{formatDate(row.createdAt)}</td>
                        <td>{UPLOADS.find((u) => u.kind === row.kind)?.title || row.kind}</td>
                        <td>{row.fileName}</td>
                        <td>{row.matchedCount} / {row.rowCount}</td>
                        <td>{row.unmatched?.length || 0}</td>
                        <td>{row.uploadedBy || '—'}</td>
                      </tr>
                    ))}
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
