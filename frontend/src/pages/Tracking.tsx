import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { api, apiError, getOrders } from '../api'
import { formatDate } from '../lib'
import { Button, EmptyState, ErrorBox, Icon, LoadingState, PageIntro, Panel, PanelHeading, useDocumentTitle, useToast } from '../components/UI'

function extractEvents(value: unknown): Array<{ status: string; location?: string; remark?: string; date?: string }> {
  if (Array.isArray(value)) return value.map((event) => event as { status: string; location?: string; remark?: string; date?: string })
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of ['events', 'history', 'Scans', 'scans', 'tracking']) if (Array.isArray(record[key])) return extractEvents(record[key])
  }
  return []
}

export function Tracking() {
  useDocumentTitle('Tracking Lookup')
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  const [input, setInput] = useState(params.get('waybill') ?? '')
  const [viewMode, setViewMode] = useState<'timeline' | 'raw'>('timeline')
  const waybill = params.get('waybill') ?? ''

  // Recent shipments query for 1-click test pills
  const ordersQuery = useQuery({ queryKey: ['recent-shipments-tracking'], queryFn: () => getOrders(), retry: false })

  const query = useQuery({
    queryKey: ['tracking', waybill],
    queryFn: async () => (await api.get<{ tracking: unknown }>(`/api/tracking/${encodeURIComponent(waybill)}`)).data.tracking,
    enabled: Boolean(waybill),
    retry: false,
  })

  const events = extractEvents(query.data)

  const copyWaybill = (awb: string) => {
    navigator.clipboard.writeText(awb)
    toast.toast('success', `Waybill ${awb} copied!`)
  }

  const recentWaybills = (ordersQuery.data ?? [])
    .map((o) => ({ orderName: o.shopifyOrderName, waybill: o.shipment?.waybillNumber }))
    .filter((w): w is { orderName: string; waybill: string } => Boolean(w.waybill))
    .slice(0, 6)

  return (
    <>
      <PageIntro
        eyebrow="Carrier Visibility"
        title="Delhivery Tracking Lookup"
        description="Live tracking status, scan timeline, and carrier hub history for any Delhivery shipment."
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
              placeholder="Enter 12-14 digit Delhivery waybill number…"
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

        {/* Quick Recent Waybills */}
        {recentWaybills.length > 0 && (
          <div style={{ marginTop: '12px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '10.5px', color: '#64748b', fontWeight: 600 }}>Recent Waybills:</span>
            {recentWaybills.map((w) => (
              <button
                key={w.waybill}
                onClick={() => {
                  setInput(w.waybill)
                  setParams({ waybill: w.waybill })
                }}
                style={{
                  background: waybill === w.waybill ? '#dbeafe' : '#f1f5f9',
                  border: waybill === w.waybill ? '1px solid #3b82f6' : '1px solid #e2e8f0',
                  borderRadius: '5px',
                  padding: '3px 8px',
                  fontSize: '10px',
                  fontFamily: 'ui-monospace, monospace',
                  color: waybill === w.waybill ? '#1e3a8a' : '#334155',
                  cursor: 'pointer',
                }}
              >
                {w.orderName}: {w.waybill}
              </button>
            ))}
          </div>
        )}

        {waybill && (
          <div style={{ marginTop: '14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '11px', color: '#64748b' }}>Active Tracking:</span>
              <div
                className="waybill-chip"
                onClick={() => copyWaybill(waybill)}
                title="Click to copy waybill"
              >
                <span>{waybill}</span>
                <Icon name="copy" size={12} />
              </div>
            </div>

            <a
              className="button button-secondary button-small"
              href={`https://www.delhivery.com/track/package/${waybill}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              <Icon name="external" size={13} />
              Open on Delhivery.com
            </a>
          </div>
        )}
      </Panel>

      {query.isError && <ErrorBox message={apiError(query.error)} />}
      {query.isLoading && (
        <Panel>
          <LoadingState label="Fetching live carrier telemetry from Delhivery API…" />
        </Panel>
      )}

      {query.data !== undefined && !query.isLoading && (
        <div>
          {/* View toggle tabs */}
          <div style={{ display: 'flex', gap: '8px', marginBottom: '14px' }}>
            <button
              onClick={() => setViewMode('timeline')}
              style={{
                background: viewMode === 'timeline' ? '#2f6df6' : '#fff',
                color: viewMode === 'timeline' ? '#fff' : '#64748b',
                border: '1px solid',
                borderColor: viewMode === 'timeline' ? '#2f6df6' : '#cbd5e1',
                borderRadius: '6px',
                padding: '6px 14px',
                fontSize: '11px',
                fontWeight: 700,
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
              }}
            >
              <Icon name="clock" size={14} />
              Visual Timeline ({events.length} scans)
            </button>

            <button
              onClick={() => setViewMode('raw')}
              style={{
                background: viewMode === 'raw' ? '#2f6df6' : '#fff',
                color: viewMode === 'raw' ? '#fff' : '#64748b',
                border: '1px solid',
                borderColor: viewMode === 'raw' ? '#2f6df6' : '#cbd5e1',
                borderRadius: '6px',
                padding: '6px 14px',
                fontSize: '11px',
                fontWeight: 700,
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
              }}
            >
              <Icon name="tool" size={14} />
              Raw JSON Response
            </button>
          </div>

          {viewMode === 'timeline' ? (
            <Panel>
              <PanelHeading eyebrow="Live Scan Events" title="Shipment Journey" />
              {events.length ? (
                <div className="timeline tracking-timeline">
                  {events.map((event, index) => (
                    <div className="timeline-item" key={`${event.status}-${index}`}>
                      <div className={`timeline-marker ${index === 0 ? 'current' : ''}`}>
                        <Icon name={index === 0 ? 'pin' : 'check'} size={13} />
                      </div>
                      <div className="timeline-copy">
                        <strong style={{ fontSize: '12px', color: index === 0 ? '#1e3a8a' : '#1e293b' }}>
                          {event.status || 'Carrier update'}
                        </strong>
                        <span style={{ fontSize: '11px', color: '#475569' }}>
                          {[event.location, event.remark].filter(Boolean).join(' · ') || 'Hub scan completed'}
                        </span>
                        <time style={{ fontSize: '10px', color: '#94a3b8' }}>
                          {event.date ? formatDate(event.date) : 'Time not reported'}
                        </time>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyState
                  title="No timeline format found"
                  description="The carrier returned data, but not a recognized scan list. Switch to Raw Response tab to inspect the payload."
                  icon="route"
                />
              )}
            </Panel>
          ) : (
            <Panel>
              <PanelHeading eyebrow="Debug view" title="Raw Carrier JSON" />
              <pre className="json-view">{JSON.stringify(query.data, null, 2)}</pre>
            </Panel>
          )}
        </div>
      )}

      {!waybill && (
        <Panel>
          <EmptyState
            title="Enter a waybill or select one above"
            description="The latest carrier scans, delivery checkpoints, and transit telemetry will appear here."
            icon="route"
          />
        </Panel>
      )}
    </>
  )
}
