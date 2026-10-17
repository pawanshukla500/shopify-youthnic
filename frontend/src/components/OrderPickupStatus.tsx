import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api, apiError } from '../api'
import { labelize } from '../lib'
import type { Order } from '../types'
import { Button, CopyableBadge, Panel, PanelHeading, useToast } from './UI'

export function OrderPickupStatus({ order }: { order: Order }) {
  const toast = useToast(), cache = useQueryClient()
  const batch = order.shipment?.pickupBatch
  const submit = useMutation({
    mutationFn: async () => (await api.post(`/api/orders/${order.id}/pickup`)).data,
    onSuccess: async (data) => {
      toast.toast(data.success ? 'success' : 'error', data.message || (data.success ? 'Warehouse pickup scheduled.' : 'Pickup was not confirmed. Review the batch status.'))
      await cache.invalidateQueries({ queryKey: ['order', String(order.id)] })
      await cache.invalidateQueries({ queryKey: ['order-activity', String(order.id)] })
    },
    onError: (error) => toast.toast('error', apiError(error)),
  })
  if (!order.shipment?.waybillNumber) return null
  return <Panel className="order-pickup-status"><PanelHeading title="Warehouse pickup" />
    {batch ? <><div className="order-preview-facts">
      <div><span>Target date / time (IST)</span><strong>{batch.pickupDate} · {batch.pickupTime}</strong></div>
      <div><span>Warehouse batch</span><strong>{labelize(batch.status)}</strong></div>
      <div><span>Carrier pickup ID</span>{batch.pickupId ? <CopyableBadge text={batch.pickupId} /> : <strong>Not confirmed yet</strong>}</div>
    </div><p className="field-hint">Warehouse: {batch.pickupLocation}. This parcel is locally associated with the warehouse batch; this is not proof of a carrier scan or per-AWB allocation. Submitted package count: {batch.submittedPackageCount}.</p>
      {batch.message && <p className="field-hint">{batch.message}</p>}
    </> : <p className="field-hint">No OMS pickup batch is recorded for this AWB. External fulfillments are not scheduled automatically.</p>}
    {order.shipment.manifestedByOms && order.status === 'DISPATCHED' && order.shipment.status === 'CREATED' && (!batch || ['QUEUED', 'FAILED', 'BLOCKED'].includes(batch.status)) &&
      <Button className="button-secondary" loading={submit.isPending} onClick={() => submit.mutate()}>Submit warehouse batch now</Button>}
  </Panel>
}
