import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, apiError } from '../api'
import { formatMoney, labelize } from '../lib'
import { Button, CopyableBadge, ErrorBox, FormField, Icon, Panel, PanelHeading, useToast } from './UI'

interface Activity {
  id: string; type: string; title: string; at: string; actor: string; actorEmail: string | null;
  actorRole: string | null; source: string | null; status: string | null; note: string | null;
  amount: number | null; reference: string | null;
}
const activityLabel = (value: string) => labelize(value.replace(/ /g, '_')).replace(/\b(Utr|Cod|Oms|Ui|Api|Awb)\b/g, (word) => word.toUpperCase())
export function OrderActivityFeed({ orderId, currency }: { orderId: number; currency: string }) {
  const toast = useToast(), cache = useQueryClient()
  const [note, setNote] = useState(''), [writing, setWriting] = useState(false), [all, setAll] = useState(false)
  const requestId = useRef(crypto.randomUUID())
  const query = useQuery({ queryKey: ['order-activity', String(orderId)], queryFn: async () => (await api.get<{ events: Activity[] }>(`/api/orders/${orderId}/activity`)).data.events, retry: false })
  const add = useMutation({
    mutationFn: () => api.post(`/api/orders/${orderId}/activity/notes`, { text: note.trim(), requestId: requestId.current }),
    onSuccess: async () => { setNote(''); setWriting(false); requestId.current = crypto.randomUUID(); toast.toast('success', 'Internal note added.'); await cache.invalidateQueries({ queryKey: ['order-activity', String(orderId)] }) },
    onError: (error) => toast.toast('error', apiError(error)),
  })
  const events = query.data || []
  return <Panel className="order-activity-feed">
    <PanelHeading title="Order activity" action={<Button className="button-secondary" aria-expanded={writing} onClick={() => setWriting(!writing)}>Add internal note</Button>} />
    <p className="field-hint">Staff-only history. Names and sources reflect recorded evidence; historical operators are not guessed.</p>
    {writing && <div className="order-note-form"><FormField label="Internal note"><textarea value={note} onChange={(event) => setNote(event.target.value)} rows={3} maxLength={2000} placeholder="Add context for your team—not sent to the customer." /></FormField><Button className="button-primary" disabled={!note.trim()} loading={add.isPending} onClick={() => add.mutate()}>Post note</Button></div>}
    {query.isError && <ErrorBox message={apiError(query.error)} />}
    {query.isLoading && <p className="field-hint">Loading activity…</p>}
    <div className={`order-audit-events ${all ? 'is-expanded' : ''}`}>
      {(all ? events : events.slice(0, 6)).map((event) => <article key={event.id} className="order-audit-event">
        <div className="order-audit-marker"><Icon name={event.type === 'STAFF_NOTE' ? 'message' : event.type.includes('PAYMENT') || event.type.includes('UTR') ? 'creditCard' : 'clock'} size={15} /></div>
        <div><div className="order-audit-heading"><strong>{event.type === 'CUSTOMER_EMAIL' ? event.title : activityLabel(event.title)}</strong><time dateTime={event.at}>{new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(new Date(event.at))}</time></div>
          <p className="order-audit-actor">{event.actor}{event.actorRole ? ` · ${event.actorRole}` : ''}{event.actorEmail && event.actorEmail !== event.actor ? ` · ${event.actorEmail}` : ''}</p>
          {event.note && <p className="order-audit-note">{event.note}</p>}
          <div className="order-audit-meta">{event.amount !== null && <strong>{formatMoney(event.amount, currency)}</strong>}{event.reference && <CopyableBadge text={event.reference} />}<span>{event.source ? activityLabel(event.source) : ''}{event.status ? ` · ${activityLabel(event.status)}` : ''}</span></div>
        </div>
      </article>)}
    </div>
    {events.length > 6 && <button type="button" className="order-text-action" aria-expanded={all} onClick={() => setAll(!all)}>{all ? 'Show recent order activity' : `View all ${events.length} order events`}</button>}
  </Panel>
}
