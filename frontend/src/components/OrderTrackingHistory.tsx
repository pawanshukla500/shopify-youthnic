import { useId, useState } from 'react'
import { displayTrackingEvents } from '../order-workspace'
import { formatDate } from '../lib'
import type { TrackingLog } from '../types'
import { Icon } from './UI'

export function OrderTrackingHistory({ logs = [], limit = 4 }: { logs?: TrackingLog[]; limit?: number }) {
  const [expanded, setExpanded] = useState(false)
  const id = useId()
  const events = displayTrackingEvents(logs)
  if (!events.length) return <p className="order-empty-hint"><Icon name="clock" size={18} />Tracking activity will appear after the first carrier scan.</p>
  const visible = expanded ? events : events.slice(0, limit)
  return <div className="order-history">
    <div className={`timeline order-history-list ${expanded ? 'is-expanded' : ''}`} id={id} tabIndex={expanded ? 0 : undefined} aria-label="Carrier tracking events">
      {visible.map((log, index) => (
        <div className="timeline-item" key={log.id}>
          <div className={`timeline-marker ${index === 0 ? 'current' : ''}`}><Icon name={index === 0 ? 'pin' : 'check'} size={13} /></div>
          <div className="timeline-copy">
            <strong>{log.status.replace(/^UD\s*:\s*/i, '')}</strong>
            <span>{[log.location, log.remark].filter(Boolean).join(' · ') || 'Carrier update'}</span>
            <time dateTime={log.scannedAt}>{formatDate(log.scannedAt)}</time>
          </div>
        </div>
      ))}
    </div>
    {events.length > limit && <button type="button" className="order-text-action" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(!expanded)}>
      {expanded ? 'Show recent activity' : `View all ${events.length} tracking events`} <Icon name="chevron" size={14} />
    </button>}
  </div>
}
