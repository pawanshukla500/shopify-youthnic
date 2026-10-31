import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  apiError,
  downloadAccountsReport,
  emailAccountsReport,
  getAccountsOverview,
  getStateMonthlyAccounting,
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

      <input
        type="file"
        accept=".csv,.xlsx,.xls"
        onChange={(e) => {
          setFile(e.target.files?.[0] || null)
          setResult(null)
        }}
      />

      {upload.withRemittanceFields && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '8px' }}>
          <FormField label="Bank UTR" hint="Optional, if missing from file">
            <input value={utr} onChange={(e) => setUtr(e.target.value)} placeholder="e.g. AXISP00847547449" />
          </FormField>
          <FormField label="Remittance no." hint="Optional">
            <input value={remittanceRef} onChange={(e) => setRemittanceRef(e.target.value)} placeholder="e.g. R335935…" />
          </FormField>
          <FormField label="Remitted on" hint="Optional">
            <input type="date" value={remittedAt} onChange={(e) => setRemittedAt(e.target.value)} />
          </FormField>
        </div>
      )}

      <div>
        <Button className="button-primary button-small" loading={mutation.isPending} onClick={() => mutation.mutate()}>
          Process file
        </Button>
      </div>

      {result && (
        <div
          style={{
            fontSize: '12px',
            background: 'var(--bg-subtle, rgba(0,0,0,0.02))',
            border: '1px solid var(--line)',
            borderRadius: '6px',
            padding: '8px 10px',
          }}
        >
          <div>
            <strong>{result.matchedCount}</strong> of <strong>{result.rowCount}</strong> rows matched
            {(result.closedNow ?? 0) > 0 && <> · <strong>{result.closedNow}</strong> order(s) moved to Payment Received</>}
          </div>
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
  const [recipients, setRecipients] = useState('accounts2@vbexports.co.in')
  const [ccRecipients, setCcRecipients] = useState('returnorders@vbexports.co.in, vaibhav@vbexports.co.in, accounts@vbexports.co.in')

  const overview = useQuery({ queryKey: ['accounts-overview', month], queryFn: () => getAccountsOverview(month), retry: false })
  const stateAccounting = useQuery({ queryKey: ['state-monthly-accounting', month], queryFn: () => getStateMonthlyAccounting(month), retry: false })

  useEffect(() => {
    if (stateAccounting.data) {
      if (stateAccounting.data.recipients.to.length) setRecipients(stateAccounting.data.recipients.to.join(', '))
      if (stateAccounting.data.recipients.cc.length) setCcRecipients(stateAccounting.data.recipients.cc.join(', '))
    } else if (overview.data) {
      setRecipients(overview.data.recipients.join(', '))
    }
  }, [stateAccounting.data, overview.data])

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['accounts-overview'] })
    queryClient.invalidateQueries({ queryKey: ['state-monthly-accounting'] })
    queryClient.invalidateQueries({ queryKey: ['orders'] })
  }

  const download = useMutation({
    mutationFn: () => downloadAccountsReport(month),
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

  const saveRecipients = useMutation({
    mutationFn: () => saveAccountsRecipients(recipients, ccRecipients),
    onSuccess: (data) => {
      toast.toast('success', `Recipients updated: To: ${data.recipients.join(', ')} · CC: ${data.ccRecipients?.join(', ') || 'None'}`)
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
  const stateData = stateAccounting.data
  const value = (label: string) => data?.summary.find((s) => s.label === label)?.value ?? 0

  const tiles: Array<{ label: string; value: string | number; tone: string }> = stateData
    ? [
        { label: 'Orders placed', value: stateData.totals.totalOrders, tone: 'var(--ink)' },
        { label: 'Opening balance (B/F)', value: formatMoney(stateData.totals.openingBalance || 0), tone: '#64748b' },
        { label: 'Gross sales in period', value: formatMoney(stateData.totals.grossSales), tone: '#1e293b' },
        { label: 'Returns deducted in period', value: `-${formatMoney(stateData.totals.returnsDeducted)}`, tone: '#dc2626' },
        { label: 'Net period sales', value: formatMoney(stateData.totals.netSales), tone: '#0f766e' },
        { label: 'Received in bank', value: formatMoney(stateData.totals.paymentReceived), tone: '#1d4ed8' },
        { label: 'Closing balance (C/F)', value: formatMoney(stateData.totals.closingBalance !== undefined ? stateData.totals.closingBalance : stateData.totals.outstanding), tone: (stateData.totals.closingBalance !== undefined ? stateData.totals.closingBalance : stateData.totals.outstanding) > 0 ? '#b91c1c' : '#15803d' },
      ]
    : data
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
        title="Payments & Accounts (Tally ERP)"
        description="State-wise monthly sales, returns deductions, bank settlement tracking, and automated 10th-of-month Tally ERP closing reports with carry-forward ledger."
        action={
          <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <FormField label="Accounting month">
              <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
            </FormField>
            <Button className="button-primary" loading={download.isPending} onClick={() => download.mutate()}>
              <Icon name="download" size={14} />
              Download Tally Excel (8 Sheets)
            </Button>
            <Button className="button-secondary" loading={email.isPending} onClick={() => email.mutate()}>
              <Icon name="mail" size={14} />
              Email to Accounts Team
            </Button>
          </div>
        }
      />

      {(overview.isLoading || stateAccounting.isLoading) && <LoadingState label="Loading accounting ledger…" />}
      {(overview.isError || stateAccounting.isError) && <ErrorBox message={apiError(overview.error || stateAccounting.error)} />}

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

      {/* State-Wise Monthly Accounts & Tally Ledger Matrix */}
      {stateData && (
        <Panel className="table-panel" style={{ marginBottom: '20px', border: '1px solid var(--accent, #3b82f6)' }}>
          <PanelHeading
            eyebrow="Tally ERP Ledger Matrix with Carry Forward"
            title={`State-Wise Monthly Sales, Returns & Settlement (${stateData.label})`}
            action={
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <span style={{ fontSize: '12px', color: 'var(--muted)' }}>
                  Auto-dispatch: <strong>10th of every month (09:00 IST)</strong>
                </span>
                <Button className="button-secondary button-small" loading={email.isPending} onClick={() => email.mutate()}>
                  <Icon name="mail" size={13} />
                  Send Now
                </Button>
              </div>
            }
          />

          <div style={{ padding: '12px 16px', background: 'var(--bg-subtle, rgba(0,0,0,0.02))', borderBottom: '1px solid var(--line)', fontSize: '13px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 700, color: 'var(--ink)' }}>Formula:</span>
              <code style={{ background: 'var(--panel)', padding: '2px 6px', borderRadius: '4px', border: '1px solid var(--line)', fontWeight: 600 }}>
                Opening Balance (B/F) + Gross Sales - Returns Deducted - Payment Received = Closing Balance (C/F)
              </code>
            </div>
            <div style={{ fontSize: '12px', color: 'var(--muted)' }}>
              <strong>Tally Carry Forward & Cutoff Rule:</strong> Prior month closing balances carry forward automatically as current month opening balance. Returns processed in {stateData.label} are deducted from current month sales. Orders placed in {stateData.label} returned after the month-end are deducted under subsequent month&rsquo;s books.
            </div>
            <div style={{ display: 'flex', gap: '16px', marginTop: '4px', fontSize: '12px', flexWrap: 'wrap' }}>
              <span>Bank Payments by Rail:</span>
              <span>Delhivery COD: <strong>{formatMoney(stateData.totals.delhivery)}</strong></span>
              <span>EaseBuzz: <strong>{formatMoney(stateData.totals.easebuzz)}</strong></span>
              <span>PhonePe: <strong>{formatMoney(stateData.totals.phonepe)}</strong></span>
              <span>Velocity: <strong>{formatMoney(stateData.totals.velocity)}</strong></span>
            </div>
          </div>

          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>State</th>
                  <th style={{ textAlign: 'center' }}>GST POS</th>
                  <th style={{ textAlign: 'center' }}>Orders</th>
                  <th style={{ textAlign: 'right' }}>Opening (B/F) (₹)</th>
                  <th style={{ textAlign: 'right' }}>Gross Sales (₹)</th>
                  <th style={{ textAlign: 'right' }}>Returns Deducted (₹)</th>
                  <th style={{ textAlign: 'right' }}>Net Sales (₹)</th>
                  <th style={{ textAlign: 'right' }}>Payment Received (₹)</th>
                  <th style={{ textAlign: 'right' }}>Closing (C/F) (₹)</th>
                  <th style={{ textAlign: 'right' }}>Delhivery</th>
                  <th style={{ textAlign: 'right' }}>EaseBuzz</th>
                  <th style={{ textAlign: 'right' }}>PhonePe</th>
                  <th style={{ textAlign: 'right' }}>Velocity</th>
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
                      <td className="amount-cell" style={{ color: s.returnsDeducted > 0 ? '#dc2626' : 'inherit' }}>
                        {s.returnsDeducted > 0 ? `-${formatMoney(s.returnsDeducted)}` : '₹0.00'}
                      </td>
                      <td className="amount-cell" style={{ fontWeight: 700 }}>{formatMoney(s.netSales)}</td>
                      <td className="amount-cell" style={{ color: '#16a34a' }}>{formatMoney(s.paymentReceived)}</td>
                      <td className="amount-cell" style={{ fontWeight: 700, color: closing > 0 ? '#b91c1c' : '#15803d' }}>
                        {formatMoney(closing)}
                      </td>
                      <td className="amount-cell" style={{ fontSize: '12px' }}>{s.delhivery ? formatMoney(s.delhivery) : '—'}</td>
                      <td className="amount-cell" style={{ fontSize: '12px' }}>{s.easebuzz ? formatMoney(s.easebuzz) : '—'}</td>
                      <td className="amount-cell" style={{ fontSize: '12px' }}>{s.phonepe ? formatMoney(s.phonepe) : '—'}</td>
                      <td className="amount-cell" style={{ fontSize: '12px' }}>{s.velocity ? formatMoney(s.velocity) : '—'}</td>
                      <td style={{ fontSize: '12px' }}>
                        {Math.abs(closing) <= 0.05 ? (
                          <span style={{ color: '#15803d', fontWeight: 600 }}>Settled</span>
                        ) : (
                          <span style={{ color: '#b91c1c' }}>Carried Fwd</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr style={{ background: 'var(--panel)', fontWeight: 800, borderTop: '2px solid var(--line)' }}>
                  <td>TOTAL (NATIONAL)</td>
                  <td style={{ textAlign: 'center' }}>ALL</td>
                  <td style={{ textAlign: 'center' }}>{stateData.totals.totalOrders}</td>
                  <td className="amount-cell" style={{ color: 'var(--muted)' }}>{formatMoney(stateData.totals.openingBalance || 0)}</td>
                  <td className="amount-cell">{formatMoney(stateData.totals.grossSales)}</td>
                  <td className="amount-cell" style={{ color: '#dc2626' }}>-{formatMoney(stateData.totals.returnsDeducted)}</td>
                  <td className="amount-cell">{formatMoney(stateData.totals.netSales)}</td>
                  <td className="amount-cell" style={{ color: '#16a34a' }}>{formatMoney(stateData.totals.paymentReceived)}</td>
                  <td className="amount-cell" style={{ color: (stateData.totals.closingBalance !== undefined ? stateData.totals.closingBalance : stateData.totals.outstanding) > 0 ? '#b91c1c' : '#15803d' }}>
                    {formatMoney(stateData.totals.closingBalance !== undefined ? stateData.totals.closingBalance : stateData.totals.outstanding)}
                  </td>
                  <td className="amount-cell">{formatMoney(stateData.totals.delhivery)}</td>
                  <td className="amount-cell">{formatMoney(stateData.totals.easebuzz)}</td>
                  <td className="amount-cell">{formatMoney(stateData.totals.phonepe)}</td>
                  <td className="amount-cell">{formatMoney(stateData.totals.velocity)}</td>
                  <td>National Balance</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </Panel>
      )}

      {data && (
        <>
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
              <PanelHeading eyebrow="Monthly report" title={`Automated dispatch on the ${data.reportDay}th of every month`} />
              <p style={{ margin: '0 0 8px', fontSize: '13px' }}>
                {data.reportSentAt
                  ? <>The {data.label} report was emailed on {formatDate(data.reportSentAt.sentAt)} to {data.reportSentAt.to.join(', ')}.</>
                  : <>The {data.label} report goes out on <strong>{nextReportDate(month, data.reportDay)}</strong> at 09:00 IST.</>}
              </p>
              <FormField label="Primary Accounts Email (To)" hint="Main recipient for Tally entries">
                <input value={recipients} onChange={(e) => setRecipients(e.target.value)} placeholder="accounts2@vbexports.co.in" />
              </FormField>
              <FormField label="CC Emails" hint="Comma-separated executive & audit emails">
                <input value={ccRecipients} onChange={(e) => setCcRecipients(e.target.value)} placeholder="returnorders@vbexports.co.in, vaibhav@vbexports.co.in, accounts@vbexports.co.in" />
              </FormField>
              <Button className="button-primary button-small" style={{ marginTop: '8px' }} loading={saveRecipients.isPending} onClick={() => saveRecipients.mutate()}>
                Save recipients &amp; CCs
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
