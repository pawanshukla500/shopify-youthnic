import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  downloadOrderLabelFile,
  downloadSingleInvoiceFile,
  downloadSingleLabelAndInvoiceFile,
  downloadSingleLabelPdf,
  openPrintableOrderInvoice,
  openPrintableOrderLabel,
  openPrintableOrderLabelAndInvoice,
  syncExternalOrderFulfillment,
} from '../api'
import { carrierTrackingUrl } from '../lib'
import { isManifestRejected } from '../../../src/modules/orders/order-tabs'
import type { Order } from '../types'
import { Icon } from './UI'

type Toast = (kind: 'success' | 'error', message: string) => void

export function OrderLogisticsActions({
  order,
  needsDispatch,
  isCodConfirmed,
  dispatching,
  confirmingCod,
  refunding,
  onDispatch,
  onConfirmCod,
  onCancel,
  onDelete,
  onNdr,
  onRefund,
  onEmail,
  onChanged,
  toast,
}: {
  order: Order
  needsDispatch: boolean
  isCodConfirmed: boolean
  dispatching: boolean
  confirmingCod: boolean
  refunding: boolean
  onDispatch: () => void
  onConfirmCod: () => void
  onCancel: () => void
  onDelete: () => void
  onNdr: () => void
  onRefund: () => void
  onEmail: () => void
  onChanged: () => void
  toast: Toast
}) {
  const [open, setOpen] = useState(false)
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  // A low-wallet manifest stores a reserved AWB that Delhivery never created.
  // Hide it so the row stays a dispatch action, not a carrier tracking link.
  const manifestRejected = isManifestRejected(order)
  const waybill = manifestRejected ? undefined : order.shipment?.waybillNumber
  const activeReturn = (order.returns || []).find((row) => !['REFUNDED', 'CANCELLED'].includes(row.returnStatus))
  const showNdr = Boolean(order.hasNdrException || ['FAILED_DELIVERY', 'RTO_INITIATED'].includes(order.status))
  const showRtoRefund = order.status === 'RTO_DELIVERED' && order.paymentMethod !== 'COD' && order.financialStatus !== 'refunded'
  const showRestocked = order.status === 'RTO_DELIVERED' && !showRtoRefund
  const canCancel = waybill
    ? !['CANCELLED', 'DELIVERED', 'RTO_DELIVERED', 'REFUNDED'].includes(order.status)
    : !['CANCELLED', 'REFUNDED'].includes(order.status)
  const awaitingPickup = Boolean(
    waybill && (order.shipment?.status === 'CREATED' || /manifest/i.test(order.shipment?.trackingStatus || ''))
  )

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node) && !buttonRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    const dismiss = () => setOpen(false)
    document.addEventListener('mousedown', close)
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    return () => {
      document.removeEventListener('mousedown', close)
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
    }
  }, [open])

  const toggleMenu = () => {
    if (open) {
      setOpen(false)
      return
    }
    const rect = buttonRef.current?.getBoundingClientRect()
    if (!rect) return
    setMenuPos({ top: rect.bottom + 4, left: Math.max(8, rect.right - 188) })
    setOpen(true)
  }

  const run = async (label: string, action: () => Promise<void>) => {
    try {
      await action()
    } catch (err: any) {
      toast('error', err?.message || `Could not ${label}`)
    }
  }

  return (
    <div className="logistics-cell" onClick={(event) => event.stopPropagation()}>
      {waybill ? (
        <a
          href={carrierTrackingUrl(order.shipment?.courier, waybill)}
          target="_blank"
          rel="noreferrer"
          className="waybill-track-link logistics-awb"
          title={`Track ${waybill} on ${order.shipment?.courier || 'Delhivery'}`}
        >
          {order.shipment?.courier?.toLowerCase() === 'delhivery' ? (
            <img src="/logos/delhivery.png" alt="" className="logistics-carrier-mark" />
          ) : (
            <span className="logistics-carrier-name">{order.shipment?.courier || 'Carrier'}</span>
          )}
          <span className="mono">{waybill}</span>
        </a>
      ) : null}

      {activeReturn?.returnWaybillNumber ? (
        <a
          href={carrierTrackingUrl(activeReturn.carrier, activeReturn.returnWaybillNumber)}
          target="_blank"
          rel="noreferrer"
          className="reverse-awb"
          title="Reverse pickup. Delhivery updates this from carrier scans."
        >
          <Icon name="return" size={11} />
          <span className="mono">{activeReturn.returnWaybillNumber}</span>
          <span>{activeReturn.trackingStatus || activeReturn.returnStatus.toLowerCase().replace(/_/g, ' ')}</span>
        </a>
      ) : null}

      {order.shipment?.status === 'ERROR' && order.shipment.errorMessage ? (
        <div className="manifest-error" title={order.shipment.errorMessage}>
          {order.shipment.errorMessage.toLowerCase().includes('insufficient balance')
            ? 'Low Delhivery wallet'
            : 'Manifest failed'}
        </div>
      ) : null}

      <div className="logistics-actions">
        {waybill ? (
          <>
            <button
              type="button"
              className="btn-pack btn-pack-primary"
              title="Print label, then invoice"
              onClick={() => openPrintableOrderLabelAndInvoice(order.id)}
            >
              Print
            </button>
            <button
              type="button"
              className="btn-pack"
              title="Download label, then invoice"
              onClick={() =>
                run('download the pack', async () => {
                  await downloadSingleLabelAndInvoiceFile(order.id, waybill)
                  toast('success', `Downloaded label and invoice for ${order.shopifyOrderName}`)
                })
              }
            >
              <Icon name="download" size={13} />
            </button>
          </>
        ) : needsDispatch ? (
          <button type="button" className="btn-pack btn-pack-primary" disabled={dispatching} onClick={onDispatch}>
            {dispatching ? 'Booking…' : 'Dispatch'}
          </button>
        ) : !isCodConfirmed && ['NEW', 'DISPATCH_PENDING'].includes(order.status) ? (
          <button type="button" className="btn-pack btn-pack-amber" disabled={confirmingCod} onClick={onConfirmCod}>
            {confirmingCod ? 'Confirming…' : 'Confirm COD'}
          </button>
        ) : null}

        {showNdr ? (
          <button type="button" className="btn-pack btn-pack-danger" onClick={onNdr}>
            NDR
          </button>
        ) : null}

        <div className="row-more" ref={menuRef}>
          <button
            type="button"
            className="btn-pack"
            ref={buttonRef}
            aria-expanded={open}
            aria-haspopup="menu"
            onClick={toggleMenu}
          >
            More
          </button>
          {open && menuPos ? (
            <div className="row-more-menu" role="menu" style={{ position: 'fixed', top: menuPos.top, left: menuPos.left }}>
              {waybill ? (
                <>
                  <button type="button" role="menuitem" onClick={() => { setOpen(false); openPrintableOrderLabel(order.id) }}>
                    Print label
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setOpen(false)
                      run('download the label', async () => {
                        await downloadOrderLabelFile(order.id, waybill)
                        toast('success', `Downloaded label for ${order.shopifyOrderName}`)
                      })
                    }}
                  >
                    Download label
                  </button>
                  {order.shipment?.courier?.toLowerCase() === 'delhivery' ? (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setOpen(false)
                        run('download the Delhivery PDF', async () => {
                          await downloadSingleLabelPdf(waybill)
                          toast('success', `Downloaded label for ${waybill}`)
                        })
                      }}
                    >
                      Delhivery PDF
                    </button>
                  ) : null}
                  <button type="button" role="menuitem" onClick={() => { setOpen(false); openPrintableOrderInvoice(order.id) }}>
                    Print invoice
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setOpen(false)
                      run('download the invoice', async () => {
                        await downloadSingleInvoiceFile(order.id, order.shopifyOrderName)
                        toast('success', `Downloaded invoice for ${order.shopifyOrderName}`)
                      })
                    }}
                  >
                    Download invoice
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setOpen(false)
                    run('fetch the AWB', async () => {
                      const res = await syncExternalOrderFulfillment(order.id)
                      if (res.found && res.waybillNumber) {
                        toast('success', `Found AWB ${res.waybillNumber}`)
                        onChanged()
                      } else {
                        toast('error', res.message || 'No external fulfillment found yet.')
                      }
                    })
                  }}
                >
                  Fetch AWB
                </button>
              )}
              {order.status === 'DELIVERED' && !activeReturn ? (
                <Link role="menuitem" to={`/orders/${order.id}#return-panel`} onClick={() => setOpen(false)}>
                  Create reverse pickup
                </Link>
              ) : null}
              <button type="button" role="menuitem" onClick={() => { setOpen(false); onEmail() }}>
                Email customer
              </button>
              {showRtoRefund ? (
                <button type="button" role="menuitem" disabled={refunding} onClick={() => { setOpen(false); onRefund() }}>
                  {refunding ? 'Refunding…' : 'Auto-refund'}
                </button>
              ) : null}
              {showRestocked ? <span className="row-more-note">COD restocked</span> : null}
              {canCancel ? (
                <button type="button" role="menuitem" className="is-danger" onClick={() => { setOpen(false); onCancel() }}>
                  Cancel order
                </button>
              ) : null}
              {order.status === 'CANCELLED' ? (
                <button type="button" role="menuitem" className="is-danger" onClick={() => { setOpen(false); onDelete() }}>
                  Delete order
                </button>
              ) : null}
              {awaitingPickup ? <span className="row-more-note">Awaiting courier pickup</span> : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
