import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, apiError, getCodSummary, recordCodRemittance } from '../api'
import { formatMoney, labelize, shortDate } from '../lib'
import { Button, EmptyState, ErrorBox, FormField, Icon, LoadingState, PageIntro, Panel, PanelHeading, useDocumentTitle, useToast } from '../components/UI'

const PRESET_PINCODES = [
  { city: 'Mumbai', pin: '400001' },
  { city: 'Delhi', pin: '110001' },
  { city: 'Bangalore', pin: '560001' },
  { city: 'Kolkata', pin: '700001' },
  { city: 'Chennai', pin: '600001' },
  { city: 'Surat (Local)', pin: '395002' },
]

export function Tools() {
  useDocumentTitle('Carrier Tools')
  const [pincode, setPincode] = useState('400001')
  const [pincodeRun, setPincodeRun] = useState<string | null>(null)
  const [origin, setOrigin] = useState('395002')
  const [destination, setDestination] = useState('400001')
  const [mot, setMot] = useState<'S' | 'E'>('S')
  const [tatRun, setTatRun] = useState<{ origin: string; destination: string; mot: string } | null>(null)
  const [cost, setCost] = useState({
    mode: 'S',
    weight: '500',
    origin: '395002',
    destination: '400001',
    shipmentStatus: 'Delivered',
    paymentType: 'Pre-paid',
  })
  const [costRun, setCostRun] = useState<typeof cost | null>(null)

  const serviceability = useQuery({
    queryKey: ['serviceability', pincodeRun ?? ''],
    queryFn: async () => (await api.get(`/api/delhivery/serviceability/${encodeURIComponent(pincodeRun ?? '')}`)).data,
    enabled: Boolean(pincodeRun),
    retry: false,
  })

  const tat = useQuery({
    queryKey: ['tat', tatRun],
    queryFn: async () => (await api.get('/api/delhivery/tat', { params: tatRun })).data,
    enabled: Boolean(tatRun),
    retry: false,
  })

  const shippingCost = useQuery({
    queryKey: ['shipping-cost', costRun],
    queryFn: async () =>
      (
        await api.get('/api/delhivery/shipping-cost', {
          params: costRun
            ? {
                mode: costRun.mode,
                chargeableWeightGrams: Math.max(50, parseInt(costRun.weight, 10) || 500),
                originPincode: costRun.origin,
                destinationPincode: costRun.destination,
                shipmentStatus: costRun.shipmentStatus,
                paymentType: costRun.paymentType,
              }
            : undefined,
        })
      ).data,
    enabled: Boolean(costRun),
    retry: false,
  })

  return (
    <>
      <PageIntro
        eyebrow="Carrier Utilities"
        title="Delhivery Logistics Tools"
        description="Verify delivery serviceability, expected TAT promise, calculate shipping costs, and reconcile COD ledger."
      />

      <div className="tools-grid">
        {/* ─── Serviceability Check ───────────────────────────── */}
        <Panel>
          <PanelHeading eyebrow="Pincode Check" title="Delhivery Serviceability" />
          <form
            className="tool-form"
            onSubmit={(event) => {
              event.preventDefault()
              if (pincode.trim()) setPincodeRun(pincode.trim())
            }}
          >
            <FormField label="Destination Pincode">
              <input
                value={pincode}
                onChange={(event) => setPincode(event.target.value)}
                placeholder="e.g. 560001"
                inputMode="numeric"
              />
            </FormField>

            {/* Presets */}
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', margin: '-4px 0 6px' }}>
              {PRESET_PINCODES.map((p) => (
                <button
                  type="button"
                  key={p.pin}
                  onClick={() => {
                    setPincode(p.pin)
                    setPincodeRun(p.pin)
                  }}
                  style={{
                    background: pincode === p.pin ? '#dbeafe' : '#f1f5f9',
                    border: pincode === p.pin ? '1px solid #3b82f6' : '1px solid #e2e8f0',
                    borderRadius: '4px',
                    padding: '2px 7px',
                    fontSize: '9.5px',
                    cursor: 'pointer',
                    color: pincode === p.pin ? '#1e3a8a' : '#475569',
                    fontWeight: 600,
                  }}
                >
                  {p.city}
                </button>
              ))}
            </div>

            <Button className="button-primary" type="submit" loading={serviceability.isFetching}>
              <Icon name="pin" size={16} />
              Check Serviceability
            </Button>
          </form>

          {serviceability.isError && <ErrorBox compact message={apiError(serviceability.error)} />}
          {serviceability.isLoading ? (
            <LoadingState label="Checking Delhivery coverage database…" />
          ) : (
            serviceability.data && (
              <div className="tool-result">
                <div className={`serviceability-result ${serviceability.data.serviceable ? 'is-good' : 'is-bad'}`}>
                  <span className="result-mark">
                    <Icon name={serviceability.data.serviceable ? 'check' : 'close'} size={16} />
                  </span>
                  <div>
                    <strong>{serviceability.data.serviceable ? 'Delivery Available' : 'Not Serviceable'}</strong>
                    <span>{serviceability.data.remark || `Pincode ${pincodeRun} is active in carrier network.`}</span>
                  </div>
                </div>
                <div className="result-grid">
                  <div>
                    <span>Cash on Delivery (COD)</span>
                    <strong style={{ color: serviceability.data.codAvailable ? '#15803d' : '#b91c1c' }}>
                      {serviceability.data.codAvailable ? '✓ Available' : '✕ Unavailable'}
                    </strong>
                  </div>
                  <div>
                    <span>Prepaid Delivery</span>
                    <strong style={{ color: serviceability.data.prepaidAvailable ? '#15803d' : '#b91c1c' }}>
                      {serviceability.data.prepaidAvailable ? '✓ Available' : '✕ Unavailable'}
                    </strong>
                  </div>
                </div>
              </div>
            )
          )}
        </Panel>

        {/* ─── Delivery Promise (TAT) ─────────────────────────── */}
        <Panel>
          <PanelHeading eyebrow="Delivery Promise" title="Turnaround Time (TAT) Lookup" />
          <form
            className="tool-form"
            onSubmit={(event) => {
              event.preventDefault()
              if (origin && destination) setTatRun({ origin, destination, mot })
            }}
          >
            <div className="form-grid-two">
              <FormField label="Origin Pincode (Warehouse)">
                <input value={origin} onChange={(event) => setOrigin(event.target.value)} placeholder="395002" />
              </FormField>
              <FormField label="Destination Pincode">
                <input
                  value={destination}
                  onChange={(event) => setDestination(event.target.value)}
                  placeholder="Destination"
                />
              </FormField>
            </div>
            <FormField label="Mode of Transport">
              <select value={mot} onChange={(event) => setMot(event.target.value as 'S' | 'E')}>
                <option value="S">Surface (Standard)</option>
                <option value="E">Express (Air)</option>
              </select>
            </FormField>
            <Button className="button-primary" type="submit" loading={tat.isFetching}>
              <Icon name="clock" size={16} />
              Lookup Estimated TAT
            </Button>
          </form>

          {tat.isError && <ErrorBox compact message={apiError(tat.error)} />}
          {tat.isLoading ? (
            <LoadingState label="Looking up delivery promise from Delhivery matrix…" />
          ) : (
            tat.data && (
              <div className="simple-result">
                <span>Estimated Transit & Delivery Promise</span>
                <strong>
                  {typeof tat.data === 'object'
                    ? String(tat.data.tat ?? tat.data.deliveryTat ?? tat.data.expectedDays ?? JSON.stringify(tat.data))
                    : String(tat.data)}
                </strong>
              </div>
            )
          )}
        </Panel>

        {/* ─── Shipping Cost Calculator ───────────────────────── */}
        <Panel className="shipping-cost-panel">
          <PanelHeading eyebrow="Rate Calculator" title="Delhivery Shipping Cost per AWB" />
          <form
            className="tool-form"
            onSubmit={(event) => {
              event.preventDefault()
              setCostRun({ ...cost })
            }}
          >
            <div className="form-grid-two">
              <FormField label="Transport Mode">
                <select value={cost.mode} onChange={(event) => setCost({ ...cost, mode: event.target.value })}>
                  <option value="S">Surface</option>
                  <option value="E">Express</option>
                </select>
              </FormField>

              <FormField label="Weight (grams)">
                <input
                  type="number"
                  min="1"
                  value={cost.weight}
                  onChange={(event) => setCost({ ...cost, weight: event.target.value })}
                />
              </FormField>

              <FormField label="Origin (Warehouse)">
                <input
                  value={cost.origin}
                  onChange={(event) => setCost({ ...cost, origin: event.target.value })}
                  placeholder="395002"
                />
              </FormField>

              <FormField label="Destination">
                <input
                  value={cost.destination}
                  onChange={(event) => setCost({ ...cost, destination: event.target.value })}
                  placeholder="Destination"
                />
              </FormField>

              <FormField label="Shipment Status">
                <select
                  value={cost.shipmentStatus}
                  onChange={(event) => setCost({ ...cost, shipmentStatus: event.target.value })}
                >
                  <option>Delivered</option>
                  <option>RTO</option>
                  <option>DTO</option>
                </select>
              </FormField>

              <FormField label="Payment Mode">
                <select
                  value={cost.paymentType}
                  onChange={(event) => setCost({ ...cost, paymentType: event.target.value })}
                >
                  <option>Pre-paid</option>
                  <option>COD</option>
                </select>
              </FormField>
            </div>

            <Button className="button-primary" type="submit" loading={shippingCost.isFetching}>
              <Icon name="tool" size={16} />
              Calculate Rate
            </Button>
          </form>

          {shippingCost.isError && <ErrorBox compact message={apiError(shippingCost.error)} />}
          {shippingCost.isLoading ? (
            <LoadingState label="Querying Delhivery Rate API…" />
          ) : (
            shippingCost.data && (
              <div className="cost-result">
                <span>Estimated Delhivery Carrier Charge</span>
                <strong>
                  {formatMoney(
                    Number(shippingCost.data.shippingCost ?? shippingCost.data.cost ?? shippingCost.data.amount ?? 0)
                  )}
                </strong>
                <small>
                  {labelize(costRun?.mode)} · {costRun?.weight}g · {costRun?.paymentType} · {costRun?.origin} ➔ {costRun?.destination}
                </small>
              </div>
            )
          )}
        </Panel>
      </div>

      {/* ─── COD Reconciliation Ledger ───────────────────────── */}
      <CodReconciliation />

      <div className="tools-footnote">
        <Icon name="alert" size={15} />
        Live rate calculations query Delhivery B2C APIs with merchant account credentials. Billed rates are finalized post hub weighment.
      </div>
    </>
  )
}

function CodReconciliation() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const summary = useQuery({ queryKey: ['cod-summary'], queryFn: getCodSummary, retry: false })
  const [remittanceRef, setRemittanceRef] = useState('')
  const [remittedAt, setRemittedAt] = useState('')
  const [waybills, setWaybills] = useState('')

  const remittance = useMutation({
    mutationFn: async () => {
      const list = waybills.split(/[\s,]+/).map((w) => w.trim()).filter(Boolean)
      if (!remittanceRef.trim()) throw new Error('Add the remittance number from the Delhivery panel.')
      if (!list.length) throw new Error('Add at least one waybill number.')
      return recordCodRemittance({
        remittanceRef: remittanceRef.trim(),
        remittedAt: remittedAt || undefined,
        waybills: list,
      })
    },
    onSuccess: async (data) => {
      toast.toast(
        'success',
        `Remittance recorded · ${data.updated} shipment(s) marked remitted${
          data.notFound.length ? ` · not found: ${data.notFound.join(', ')}` : ''
        }.`
      )
      setRemittanceRef('')
      setRemittedAt('')
      setWaybills('')
      await queryClient.invalidateQueries({ queryKey: ['cod-summary'] })
      await queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] })
    },
    onError: (error) => toast.toast('error', apiError(error)),
  })

  const data = summary.data
  return (
    <Panel className="cod-panel">
      <PanelHeading eyebrow="Delhivery Remittance Hub" title="COD Reconciliation Ledger" />
      <p className="panel-description">
        Delhivery delivers COD parcels and periodically deposits cash collections into your bank account. “Collected” is detected automatically upon delivery; record remittance bank references below to balance the 3-way money ledger.
      </p>
      {summary.isError && <ErrorBox compact message={apiError(summary.error)} />}
      {summary.isLoading ? (
        <LoadingState label="Loading COD ledger and settlement state…" />
      ) : (
        data && (
          <>
            <div className="result-grid cod-summary-grid">
              <div>
                <span>Collected at Customer Delivery</span>
                <strong style={{ color: '#0f172a' }}>{formatMoney(data.collectedAmount)}</strong>
                <small>{data.collectedCount} delivered shipment(s)</small>
              </div>
              <div>
                <span>Remitted to Bank Account</span>
                <strong style={{ color: '#15803d' }}>{formatMoney(data.remittedAmount)}</strong>
                <small>{data.remittedCount} settled shipment(s)</small>
              </div>
              <div>
                <span>Outstanding Balance Due</span>
                <strong style={{ color: '#b45309' }}>{formatMoney(data.outstandingAmount)}</strong>
                <small>{data.outstandingCount} shipment(s) awaiting remittance</small>
              </div>
            </div>

            {data.outstanding.length ? (
              <div className="table-wrap" style={{ marginTop: '16px' }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Waybill</th>
                      <th>Order</th>
                      <th>Customer</th>
                      <th>COD Amount</th>
                      <th>Delivered / Collected</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.outstanding.map((entry) => (
                      <tr key={entry.waybillNumber ?? entry.orderName}>
                        <td className="mono" style={{ fontWeight: 700, color: '#1e3a8a' }}>
                          {entry.waybillNumber ?? '—'}
                        </td>
                        <td>
                          <strong>{entry.orderName}</strong>
                        </td>
                        <td>{entry.customerName}</td>
                        <td className="amount-cell">{formatMoney(entry.codAmount)}</td>
                        <td>{shortDate(entry.collectedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState
                title="All collected COD is reconciled"
                description="No outstanding deliveries awaiting bank remittance."
                icon="check"
              />
            )}

            <form
              className="tool-form cod-remittance-form"
              onSubmit={(event) => {
                event.preventDefault()
                remittance.mutate()
              }}
              style={{ marginTop: '20px', borderTop: '1px solid #e2e8f0', paddingTop: '16px' }}
            >
              <h3 style={{ margin: '0 0 10px', fontSize: '13px', fontWeight: 750, color: '#1e293b' }}>
                Record Delhivery Remittance Voucher
              </h3>
              <div className="form-grid-two">
                <FormField label="Remittance Reference / UTR Number">
                  <input
                    value={remittanceRef}
                    onChange={(event) => setRemittanceRef(event.target.value)}
                    placeholder="e.g. DLHVREM98765432"
                  />
                </FormField>
                <FormField label="Remitted On (Bank Credit Date)">
                  <input
                    type="date"
                    value={remittedAt}
                    onChange={(event) => setRemittedAt(event.target.value)}
                  />
                </FormField>
              </div>
              <FormField label="Waybill Numbers (Space or Comma Separated)">
                <textarea
                  value={waybills}
                  onChange={(event) => setWaybills(event.target.value)}
                  placeholder="Paste waybill numbers from Delhivery ONE Remittance MIS..."
                  rows={2}
                />
              </FormField>
              <Button className="button-primary" type="submit" loading={remittance.isPending}>
                <Icon name="check" size={16} />
                Reconcile & Settle Waybills
              </Button>
            </form>
          </>
        )
      )}
    </Panel>
  )
}
