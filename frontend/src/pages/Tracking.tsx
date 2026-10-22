import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { api, apiError, getOrders, syncWaybillTrackingLive } from '../api'
import { formatDate } from '../lib'
import { Button, EmptyState, ErrorBox, Icon, LoadingState, PageIntro, Panel, PanelHeading, useDocumentTitle, useToast } from '../components/UI'

type ScanEvent = {
  status: string
  location?: string
  remark?: string
  date?: string
  statusType?: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function eventDate(event: Record<string, unknown>): string | undefined {
  for (const key of ['date', 'dateTime', 'ScanDateTime', 'scannedAt', 'StatusDateTime']) {
    const value = event[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return undefined
}

function normalizeEvent(value: unknown): ScanEvent | null {
  const event = asRecord(value)
  if (!event) return null
  const status = event.status || event.Scan || event.Status || event.rawStatus
  if (typeof status !== 'string' || !status.trim()) return null
  const location = event.location || event.ScanLocation || event.StatusLocation
  const remark = event.remark || event.Instructions || event.instructions
  const statusType = event.statusType || event.ScanType || event.StatusType
  return {
    status,
    location: typeof location === 'string' ? location : undefined,
    remark: typeof remark === 'string' ? remark : undefined,
    date: eventDate(event),
    statusType: typeof statusType === 'string' ? statusType : undefined,
  }
}

function extractEvents(value: unknown): ScanEvent[] {
  if (Array.isArray(value)) {
    return value.map(normalizeEvent).filter((event): event is ScanEvent => Boolean(event))
  }
  const record = asRecord(value)
  if (!record) return []
  for (const key of ['events', 'history', 'Scans', 'scans', 'tracking']) {
    if (Array.isArray(record[key])) return extractEvents(record[key])
  }
  return []
}

function sortNewest(events: ScanEvent[]): ScanEvent[] {
  return [...events].sort((a, b) => {
    const left = a.date ? new Date(a.date).getTime() : 0
    const right = b.date ? new Date(b.date).getTime() : 0
    return (Number.isNaN(right) ? 0 : right) - (Number.isNaN(left) ? 0 : left)
  })
}

export function Tracking() {
  useDocumentTitle('Tracking Lookup')
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  const [input, setInput] = useState(params.get('waybill') ?? '')
  const [viewMode, setViewMode] = useState<'timeline' | 'raw'>('timeline')
  const waybill = params.get('waybill') ?? ''

  const ordersQuery = useQuery({ queryKey: ['recent-shipments-tracking'], queryFn: () => getOrders({ limit: 20 } as any), retry: false })

  const waybillValid = /^[0-9]{10,16}$/.test(waybill.trim())
  const query = useQuery({
    queryKey: ['tracking', waybill],
    queryFn: async () => (await api.get<{ tracking: unknown }>(`/api/tracking/${encodeURIComponent(waybill)}`)).data.tracking,
    enabled: Boolean(waybill) && waybillValid,
    retry: false,
  })

  const events = sortNewest(extractEvents(query.data))
  const detail = asRecord(query.data)

  const queryClient = useQueryClient()
  const [isSyncingLive, setIsSyncingLive] = useState(false)

  const handleSyncLive = async () => {
    if (!waybill) return
    setIsSyncingLive(true)
    try {
      const res = await syncWaybillTrackingLive(waybill)
      toast.toast('success', res.tracking?.status ? `Live Delhivery tracking synced: ${res.tracking.status}` : 'Delhivery tracking refreshed and synced to database.')
      await queryClient.invalidateQueries({ queryKey: ['tracking', waybill] })
      await queryClient.invalidateQueries({ queryKey: ['recent-shipments-tracking'] })
    } catch (err: any) {
      toast.toast('error', apiError(err))
    } finally {
      setIsSyncingLive(false)
    }
  }

  const copyWaybill = async (awb: string) => {
    try {
      await navigator.clipboard.writeText(awb)
      toast.toast('success', `Waybill ${awb} copied`)
    } catch {
      window.prompt('Copy waybill:', awb)
    }
  }

  const recentWaybills = (ordersQuery.data ?? [])
    .map((o) => ({ orderName: o.shopifyOrderName, waybill: o.shipment?.waybillNumber }))
    .filter((w): w is { orderName: string; waybill: string } => Boolean(w.waybill))
    .slice(0, 6)

  const statusText = typeof detail?.status === 'string' ? detail.status : ''
  const source = detail?.source === 'stored' ? 'Saved scans' : 'Live Delhivery'
  const pickupDone = detail?.pickupDone === true

  return (
    <div className="tracking-page">
      <PageIntro
        eyebrow="Carrier Visibility"
        title="Delhivery Tracking Lookup"
        description="Live scan status, hub history, and the dates Delhivery reports for any Youthnic shipment."
      />

      <Panel className="lookup-panel">
        <div className="lookup-form">
          <label className="search-field tracking-search">
            <Icon name="search" size={19} />
            <input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && input.trim()) setParams({ waybill: input.trim() })
              }}
              placeholder="Enter a 10–16 digit Delhivery waybill"
            />
          </label>
          <Button
            className="button-primary"
            disabled={!input.trim()}
            onClick={() => setParams({ waybill: input.trim() })}
          >
            <Icon name="route" size={16} />
            Track Shipment
          </Button>
        </div>

        {recentWaybills.length > 0 && (
          <div className="recent-waybills">
            <span>Recent waybills</span>
            {recentWaybills.map((w) => (
              <button
                key={w.waybill}
                type="button"
                className={waybill === w.waybill ? 'is-active' : ''}
                onClick={() => {
                  setInput(w.waybill)
                  setParams({ waybill: w.waybill })
                }}
              >
                {w.orderName}: {w.waybill}
              </button>
            ))}
          </div>
        )}

        {waybill && (
          <div className="tracking-active-row">
            <div className="tracking-active-id">
              <span>Active tracking</span>
              <button type="button" className="waybill-chip" onClick={() => copyWaybill(waybill)} title="Copy waybill">
                <span>{waybill}</span>
                <Icon name="copy" size={12} />
              </button>
              {detail && <span className="tracking-source">{source}</span>}
            </div>
            <div className="tracking-active-actions">
              <Button
                className="button-secondary button-small"
                onClick={handleSyncLive}
                disabled={isSyncingLive}
                loading={isSyncingLive}
                title="Fetch live tracking events from Delhivery and save them"
              >
                <Icon name="refresh" size={13} />
                <span>{isSyncingLive ? 'Syncing…' : 'Refresh live data'}</span>
              </Button>
              <a
                className="button button-secondary button-small"
                href={carrierTrackingUrl(data?.shipment?.courier, waybill)}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Icon name="external" size={13} />
                Open on Carrier
              </a>
            </div>
          </div>
        )}
      </Panel>

      {waybill && !waybillValid && (
        <ErrorBox message="Enter a valid 10–16 digit Delhivery waybill. No request was sent." />
      )}
      {query.isError && <ErrorBox message={apiError(query.error)} />}
      {query.isLoading && (
        <Panel>
          <LoadingState label="Fetching carrier scans from Delhivery…" />
        </Panel>
      )}

      {query.data !== undefined && !query.isLoading && detail && (
        <>
          <section className="tracking-hero">
            <div>
              <p>Latest status</p>
              <h2>{statusText || 'Waiting for the first scan'}</h2>
              <p className="tracking-hero-meta">
                {typeof detail.location === 'string' && detail.location ? detail.location : 'Location not reported yet'}
                {typeof detail.statusType === 'string' && detail.statusType ? ` · ${detail.statusType}` : ''}
              </p>
            </div>
            <div className={`tracking-pickup ${pickupDone ? 'is-done' : ''}`}>
              <strong>{pickupDone ? 'Pickup confirmed' : 'Awaiting pickup'}</strong>
              <span>
                {typeof detail.pickedupDate === 'string' && detail.pickedupDate
                  ? formatDate(detail.pickedupDate)
                  : pickupDone
                    ? 'Courier has the parcel'
                    : 'Still at the Surat warehouse'}
              </span>
            </div>
          </section>

          <Panel>
            <PanelHeading eyebrow="Delivery intelligence" title="Promise and reference" />
            <div className="tracking-facts">
              <div>
                <span>Status code</span>
                <strong>{typeof detail.statusCode === 'string' && detail.statusCode ? detail.statusCode : '—'}</strong>
              </div>
              <div>
                <span>Expected delivery</span>
                <strong>{typeof detail.expectedDeliveryDate === 'string' ? formatDate(detail.expectedDeliveryDate) : '—'}</strong>
              </div>
              <div>
                <span>Manifested</span>
                <strong>{typeof detail.pickUpDate === 'string' ? formatDate(detail.pickUpDate) : '—'}</strong>
              </div>
              <div>
                <span>Dispatch count</span>
                <strong>{detail.dispatchCount === 0 || detail.dispatchCount ? String(detail.dispatchCount) : '—'}</strong>
              </div>
              {typeof detail.referenceNo === 'string' && detail.referenceNo && (
                <div>
                  <span>Reference</span>
                  <strong className="mono">{detail.referenceNo}</strong>
                </div>
              )}
              {typeof detail.remarks === 'string' && detail.remarks && (
                <div className="tracking-facts-wide">
                  <span>Instructions</span>
                  <strong>{detail.remarks}</strong>
                </div>
              )}
              {typeof detail.liveError === 'string' && detail.liveError && (
                <div className="tracking-facts-wide">
                  <span>Live API</span>
                  <strong>Showing saved scans. Delhivery did not answer: {detail.liveError}</strong>
                </div>
              )}
            </div>
          </Panel>

          <div className="tracking-view-toggle" role="tablist">
            <button type="button" className={viewMode === 'timeline' ? 'is-active' : ''} onClick={() => setViewMode('timeline')}>
              <Icon name="clock" size={14} />
              Timeline ({events.length})
            </button>
            <button type="button" className={viewMode === 'raw' ? 'is-active' : ''} onClick={() => setViewMode('raw')}>
              <Icon name="tool" size={14} />
              Raw response
            </button>
          </div>

          {viewMode === 'timeline' ? (
            <Panel>
              <PanelHeading eyebrow="Scan events" title="Shipment journey" />
              {events.length ? (
                <div className="timeline tracking-timeline">
                  {events.map((event, index) => (
                    <div className="timeline-item" key={`${event.status}-${event.date || index}`}>
                      <div className={`timeline-marker ${index === 0 ? 'current' : ''}`}>
                        <Icon name={index === 0 ? 'pin' : 'check'} size={13} />
                      </div>
                      <div className="timeline-copy">
                        <strong>{event.status}</strong>
                        <span>{[event.location, event.remark].filter(Boolean).join(' · ') || 'Hub scan recorded'}</span>
                        <time>{event.date ? formatDate(event.date) : 'Time not reported'}</time>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyState
                  title="No scans in this response"
                  description="Delhivery returned a status without a scan list. Open Raw response, or refresh live data after the next hub scan."
                  icon="route"
                />
              )}
            </Panel>
          ) : (
            <Panel>
              <PanelHeading eyebrow="Debug view" title="Raw carrier JSON" />
              <pre className="json-view">{JSON.stringify(query.data, null, 2)}</pre>
            </Panel>
          )}
        </>
      )}

      {!waybill && (
        <Panel>
          <EmptyState
            title="Enter a waybill or choose a recent one"
            description="The latest carrier scans, delivery checkpoints, and hub times will appear here."
            icon="route"
          />
        </Panel>
      )}
    </div>
  )
}
