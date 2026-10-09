import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from 'react-router-dom'
import {
  api,
  apiError,
  getOrder,
  getPayment,
  getShippingEstimate,
  confirmCodOrder,
  cancelOrder,
  deleteOrder,
  processRtoRefund,
  handleNdrAction,
  sendOrderWhatsAppTrigger,
  downloadSingleLabelPdf,
  openPrintableOrderLabel,
  openPrintableOrderInvoice,
  downloadOrderLabelFile,
  downloadSingleLabelAndInvoiceFile,
  openPrintableOrderLabelAndInvoice,
  syncOrderTrackingLive,
  downloadSingleInvoiceFile,
  downloadBulkPackZip,
  syncExternalOrderFulfillment,
} from '../api'
import { carrierTrackingUrl, formatDate, formatMoney, labelize } from '../lib'
import { classifyOrderTab, isCodConfirmed, isPrepaidOrder } from '../../../src/modules/orders/order-tabs'
import { Button, ButtonGroup, CopyableBadge, EmptyState, ErrorBox, FormField, Icon, InfoCard, LoadingState, PageIntro, Panel, PanelHeading, StatCard, StatusBadge, useDocumentTitle, useToast } from '../components/UI'
import type { Order, OrderItem, ReturnRecord } from '../types'

export function OrderDetail() {
  useDocumentTitle('Order detail')
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const toast = useToast()
  const queryClient = useQueryClient()
  const orderQuery = useQuery({ queryKey: ['order', id], queryFn: () => getOrder(id), enabled: Boolean(id), retry: false })
  const paymentQuery = useQuery({ queryKey: ['payment', id], queryFn: () => getPayment(id), enabled: Boolean(id), retry: false })
  const estimateQuery = useQuery({ queryKey: ['shipping-estimate', id], queryFn: () => getShippingEstimate(id), enabled: Boolean(id), retry: false })
  const [selected, setSelected] = useState<Record<number, number>>({})
  const [reason, setReason] = useState('')
  const [returnTracking, setReturnTracking] = useState('')
  const [carrier, setCarrier] = useState('Delhivery')

  // Cancel / Delete / Confirm COD States
  const [showCancelModal, setShowCancelModal] = useState(false)
  const [cancelReason, setCancelReason] = useState('customer')
  const [isCancelling, setIsCancelling] = useState(false)

  const [showDeleteModal, setShowDeleteModal] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [isConfirmingCod, setIsConfirmingCod] = useState(false)

  // Live Delhivery Tracking Sync State
  const [isSyncingTracking, setIsSyncingTracking] = useState(false)
  const [isDownloadingLabel, setIsDownloadingLabel] = useState(false)
  const [isDownloadingLabelAndInvoice, setIsDownloadingLabelAndInvoice] = useState(false)
  const [isDownloadingInvoice, setIsDownloadingInvoice] = useState(false)
  const [isDownloadingPack, setIsDownloadingPack] = useState(false)
  const [isFetchingExternalAwb, setIsFetchingExternalAwb] = useState(false)

  // NDR Resolution States
  const [showNdrModal, setShowNdrModal] = useState(false)
  const [ndrActionType, setNdrActionType] = useState<'RE-ATTEMPT' | 'RTO'>('RE-ATTEMPT')
  const [ndrNotes, setNdrNotes] = useState('')
  const [isSubmittingNdr, setIsSubmittingNdr] = useState(false)

  // Edit delivery details (Delhivery Edit Order API: phone/address while Manifested/In Transit/Pending)
  const [showEditDetails, setShowEditDetails] = useState(false)
  const [editPhone, setEditPhone] = useState('')
  const [editAddress, setEditAddress] = useState('')
  const [isSavingEdit, setIsSavingEdit] = useState(false)

  // RTO Refund State
  const [isRefundingRto, setIsRefundingRto] = useState(false)

  // Kapso WhatsApp Modal State
  const [moreOpen, setMoreOpen] = useState(false)
  const [morePos, setMorePos] = useState<{ top: number; left: number } | null>(null)
  const moreRef = useRef<HTMLDivElement>(null)
  const moreButtonRef = useRef<HTMLButtonElement>(null)
  const [showWhatsAppModal, setShowWhatsAppModal] = useState(false)
  const [whatsAppTrigger, setWhatsAppTrigger] = useState('COD_CONFIRMATION')
  const [whatsAppCustomText, setWhatsAppCustomText] = useState('')
  const [isSendingWhatsApp, setIsSendingWhatsApp] = useState(false)

  const order = orderQuery.data

  const action = useMutation({
    mutationFn: async (kind: 'dispatch' | 'verify' | 'label' | 'cancel') => {
      if (kind === 'dispatch') return (await api.post(`/api/orders/${id}/dispatch`)).data
      if (kind === 'verify') return (await api.post(`/api/orders/${id}/payment/verify`)).data
      if (kind === 'label') return (await api.get(`/api/delhivery/label/${order?.shipment?.waybillNumber}`)).data
      return (await api.post(`/api/delhivery/shipment/${order?.shipment?.waybillNumber}/cancel`)).data
    },
    onSuccess: async (data, kind) => {
      if (kind === 'label') {
        if (order?.id) openPrintableOrderLabel(order.id)
        toast.toast('success', 'Printable label opened. Packing-slip links expire, so this stays inside Youthnic.')
      } else if (kind === 'verify') {
        toast.toast(data.verified ? 'success' : 'error', data.reason ?? (data.verified ? 'Payment verified.' : 'Payment could not be verified.'))
      } else if (kind === 'dispatch') {
        toast.toast('success', `Order dispatched${data.waybillNumber ? ` · Waybill ${data.waybillNumber}` : ''}.`)
      } else toast.toast('success', 'Shipment cancellation requested.')
      await queryClient.invalidateQueries({ queryKey: ['order', id] })
      await queryClient.invalidateQueries({ queryKey: ['orders'] })
      await queryClient.invalidateQueries({ queryKey: ['payment', id] })
    },
    onError: (error) => toast.toast('error', apiError(error)),
  })

  const refundMutation = useMutation({
    mutationFn: async () => {
      const confirmed = window.confirm(`Issue Shopify refund of ${formatMoney(order?.totalAmount || 0)} for order ${order?.shopifyOrderName}? This will process the refund directly through Shopify.`)
      if (!confirmed) throw new Error('USER_CANCELLED_REFUND')
      return (await api.post(`/api/orders/${id}/refund`, {
        amount: order?.totalAmount,
        reason: 'Customer return / Merchant refund',
      })).data
    },
    onSuccess: async (data) => {
      toast.toast('success', `Shopify refund processed successfully · ID: ${data.refundId}`)
      await queryClient.invalidateQueries({ queryKey: ['order', id] })
      await queryClient.invalidateQueries({ queryKey: ['orders'] })
      await queryClient.invalidateQueries({ queryKey: ['payment', id] })
      await queryClient.invalidateQueries({ queryKey: ['returns'] })
    },
    onError: (error) => {
      if (error instanceof Error && error.message === 'USER_CANCELLED_REFUND') return
      toast.toast('error', apiError(error))
    },
  })

  const returnMutation = useMutation({
    mutationFn: async () => {
      if (!reason.trim()) throw new Error('Add a reason before creating the return.')
      const items = Object.entries(selected).filter(([, quantity]) => quantity > 0).map(([orderItemId, quantity]) => ({ orderItemId: Number(orderItemId), quantity }))
      if (!items.length) throw new Error('Select at least one item to return.')
      return (await api.post(`/api/orders/${id}/returns`, {
        returnReason: reason.trim(),
        items,
        returnWaybillNumber: returnTracking.trim() || undefined,
        carrierName: carrier.trim() || 'Delhivery',
        triggerShopify: true,
      })).data
    },
    onSuccess: async (data) => {
      toast.toast(
        'success',
        data.shopifyReturnId
          ? `Reverse AWB ${data.returnWaybill} is live and Shopify return ${data.shopifyReturnId.split('/').pop()} is open.`
          : data.pickupAutomatic
          ? `Reverse AWB ${data.returnWaybill} is live. Delhivery will pick up from the customer — status updates from carrier scans.`
          : `Return linked with waybill ${data.returnWaybill}${data.shopifyTriggered ? ' · Synced to Shopify' : ''}.`
      )
      setSelected({})
      setReason('')
      setReturnTracking('')
      await queryClient.invalidateQueries({ queryKey: ['order', id] })
      await queryClient.invalidateQueries({ queryKey: ['returns'] })
    },
    onError: (error) => toast.toast('error', apiError(error)),
  })

  useEffect(() => {
    if (!orderQuery.data || window.location.hash !== '#return-panel') return
    document.getElementById('return-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [orderQuery.data])

  useEffect(() => {
    if (!moreOpen) return
    const close = (event: MouseEvent) => {
      const target = event.target as Node
      if (!moreRef.current?.contains(target) && !moreButtonRef.current?.contains(target)) setMoreOpen(false)
    }
    const dismiss = () => setMoreOpen(false)
    document.addEventListener('mousedown', close)
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    return () => {
      document.removeEventListener('mousedown', close)
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
    }
  }, [moreOpen])

  const canDispatch = order && ['NEW', 'DISPATCH_PENDING'].includes(order.status)
  if (orderQuery.isLoading) return <LoadingState label="Loading order detail…" />
  if (orderQuery.isError || !order) return <><PageIntro eyebrow="Order detail" title="Order not found" /><ErrorBox message={orderQuery.error ? apiError(orderQuery.error) : 'The requested order could not be found.'} /></>
  const payment = paymentQuery.data

  const cleanPhone = (order.customerPhone || '').replace(/\D/g, '')

  const copyAddress = () => {
    const fullAddr = [order.customerAddress, order.customerCity, `${order.customerState} ${order.customerPincode}`, order.customerCountry].filter(Boolean).join(', ')
    navigator.clipboard.writeText(fullAddr)
    toast.toast('success', 'Full customer delivery address copied to clipboard!')
  }

  const copyWaybill = (awb: string) => {
    navigator.clipboard.writeText(awb)
    toast.toast('success', `Delhivery Waybill ${awb} copied!`)
  }

  const isPrepaid = isPrepaidOrder(order)
  const isCodConf = isCodConfirmed(order)
  const isDispatchNeeded = classifyOrderTab(order) === 'dispatch'

  const isNdrOrRtoShipment = Boolean(
    order.hasNdrException ||
    ['FAILED_DELIVERY', 'RTO_INITIATED', 'RTO_DELIVERED'].includes(order.status) ||
    ['FAILED', 'RTO', 'RTO_DELIVERED'].includes(order.shipment?.status || '') ||
    (order.shipment?.trackingStatus && /fail|attempt|undeliver|rto|return/i.test(order.shipment.trackingStatus))
  )

  // Single order COD confirmation handler
  const handleConfirmCod = async () => {
    if (!order) return
    setIsConfirmingCod(true)
    try {
      const res = await confirmCodOrder(order.id)
      toast.toast('success', res.message || 'Order confirmed and ready for dispatch!')
      await queryClient.invalidateQueries({ queryKey: ['order', id] })
      await queryClient.invalidateQueries({ queryKey: ['orders'] })
    } catch (err: any) {
      toast.toast('error', apiError(err))
    } finally {
      setIsConfirmingCod(false)
    }
  }

  // Cancel order handler
  const handleConfirmCancel = async () => {
    if (!order) return
    setIsCancelling(true)
    try {
      const res = await cancelOrder(order.id, cancelReason)
      toast.toast(res.warning ? 'error' : 'success', res.warning || res.message || `Order ${order.shopifyOrderName} cancelled.`)
      setShowCancelModal(false)
      await queryClient.invalidateQueries({ queryKey: ['order', id] })
      await queryClient.invalidateQueries({ queryKey: ['orders'] })
    } catch (err: any) {
      toast.toast('error', apiError(err))
    } finally {
      setIsCancelling(false)
    }
  }

  // Delete order handler
  const handleConfirmDelete = async () => {
    if (!order) return
    setIsDeleting(true)
    try {
      const res = await deleteOrder(order.id)
      toast.toast('success', res.message || `Order ${order.shopifyOrderName} deleted.`)
      setShowDeleteModal(false)
      navigate('/orders')
    } catch (err: any) {
      toast.toast('error', apiError(err))
    } finally {
      setIsDeleting(false)
    }
  }

  // NDR Resolution Handler
  const handleConfirmNdr = async () => {
    if (!order) return
    setIsSubmittingNdr(true)
    try {
      const res = await handleNdrAction(order.id, ndrActionType, ndrNotes)
      toast.toast('success', res.message || 'NDR action scheduled successfully!')
      setShowNdrModal(false)
      setNdrNotes('')
      await queryClient.invalidateQueries({ queryKey: ['order', id] })
      await queryClient.invalidateQueries({ queryKey: ['orders'] })
    } catch (err: any) {
      toast.toast('error', apiError(err))
    } finally {
      setIsSubmittingNdr(false)
    }
  }

  // RTO Auto-Refund (Prepaid via Shopify to Easebuzz/PhonePe) or Restock (COD) Handler
  const handleProcessRtoRefund = async () => {
    if (!order) return
    if (order.paymentMethod === 'COD') {
      setIsRefundingRto(true)
      try {
        const res = await processRtoRefund(order.id)
        toast.toast('success', res.message || 'COD Order marked RTO Delivered & Restocked.')
        await queryClient.invalidateQueries({ queryKey: ['order', id] })
        await queryClient.invalidateQueries({ queryKey: ['orders'] })
      } catch (err: any) {
        toast.toast('error', apiError(err))
      } finally {
        setIsRefundingRto(false)
      }
      return
    }

    const confirmed = window.confirm(
      `Issue automated full refund of ₹${order.totalAmount} for ${order.shopifyOrderName}? Funds will route back through ${order.paymentProvider || order.paymentGateway || 'Easebuzz / PhonePe'}.`
    )
    if (!confirmed) return

    setIsRefundingRto(true)
    try {
      const res = await processRtoRefund(order.id)
      toast.toast('success', res.message || 'Auto-refund processed successfully!')
      await queryClient.invalidateQueries({ queryKey: ['order', id] })
      await queryClient.invalidateQueries({ queryKey: ['orders'] })
    } catch (err: any) {
      toast.toast('error', apiError(err))
    } finally {
      setIsRefundingRto(false)
    }
  }

  // Kapso WhatsApp Trigger Handler
  const handleSendWhatsApp = async () => {
    if (!order) return
    setIsSendingWhatsApp(true)
    try {
      await sendOrderWhatsAppTrigger(order.id, {
        trigger: whatsAppTrigger,
        customText: whatsAppCustomText,
      })
      toast.toast('success', `WhatsApp notification sent to ${order.customerPhone} via Kapso!`)
      setShowWhatsAppModal(false)
      setWhatsAppCustomText('')
      await queryClient.invalidateQueries({ queryKey: ['order', id] })
    } catch (err: any) {
      toast.toast('error', apiError(err))
    } finally {
      setIsSendingWhatsApp(false)
    }
  }

  // Live Delhivery Tracking sync handler
  const handleSyncTracking = async () => {
    if (!order) return
    setIsSyncingTracking(true)
    try {
      const res = await syncOrderTrackingLive(order.id)
      const scanCount = res.shipment?.trackingLogs?.length || res.tracking?.scans?.length || 0
      toast.toast('success', `Live tracking refreshed${scanCount ? ` · ${scanCount} scans recorded` : ''}!`)
      await queryClient.invalidateQueries({ queryKey: ['order', id] })
      await queryClient.invalidateQueries({ queryKey: ['orders'] })
    } catch (err: any) {
      toast.toast('error', apiError(err))
    } finally {
      setIsSyncingTracking(false)
    }
  }

  // Direct Label download handler (saves file, does not open in new tab)
  const handleDownloadLabel = async () => {
    if (!order) return
    setIsDownloadingLabel(true)
    try {
      await downloadOrderLabelFile(order.id, order.shipment?.waybillNumber || order.shopifyOrderName)
      toast.toast('success', 'Delhivery shipping label downloaded directly.')
    } catch (err: any) {
      toast.toast('error', apiError(err))
    } finally {
      setIsDownloadingLabel(false)
    }
  }

  // Direct Combined Label + Invoice download handler (strictly alternating: Label then Invoice, saves file)
  const handleDownloadLabelAndInvoice = async () => {
    if (!order) return
    setIsDownloadingLabelAndInvoice(true)
    try {
      await downloadSingleLabelAndInvoiceFile(order.id, order.shipment?.waybillNumber || order.shopifyOrderName)
      toast.toast('success', 'Combined Shipping Label + Invoice downloaded directly.')
    } catch (err: any) {
      toast.toast('error', apiError(err))
    } finally {
      setIsDownloadingLabelAndInvoice(false)
    }
  }

  // Direct GST Tax Invoice download handler (saves file, does not open in new tab)
  const handleDownloadInvoice = async () => {
    if (!order) return
    setIsDownloadingInvoice(true)
    try {
      await downloadSingleInvoiceFile(order.id, order.shopifyOrderName)
      toast.toast('success', `Downloaded GST Invoice for ${order.shopifyOrderName}`)
    } catch (err: any) {
      toast.toast('error', apiError(err))
    } finally {
      setIsDownloadingInvoice(false)
    }
  }

  // Direct Order Pack (ZIP) download handler (contains Picklist + Collated Label & Invoice + Folders + Manifest)
  const handleDownloadOrderPack = async () => {
    if (!order) return
    setIsDownloadingPack(true)
    try {
      await downloadBulkPackZip([order.id])
      toast.toast('success', `Downloaded complete order pack (ZIP) for ${order.shopifyOrderName}!`)
    } catch (err: any) {
      toast.toast('error', apiError(err))
    } finally {
      setIsDownloadingPack(false)
    }
  }

  // Fetch external fulfillment (Shopify OMS Guru / Delhivery ONE panel manifest)
  const handleFetchExternalFulfillment = async () => {
    if (!order) return
    setIsFetchingExternalAwb(true)
    try {
      const res = await syncExternalOrderFulfillment(order.id)
      if (res.found && res.waybillNumber) {
        toast.toast('success', `Found tracking ID: ${res.waybillNumber} (${res.courier || 'Delhivery'})! Synced to Shopify.`)
        await queryClient.invalidateQueries({ queryKey: ['order', id] })
        await queryClient.invalidateQueries({ queryKey: ['orders'] })
      } else {
        toast.toast('error', res.message || 'No external fulfillment found for this order on Shopify or Delhivery ONE.')
      }
    } catch (err: any) {
      toast.toast('error', apiError(err))
    } finally {
      setIsFetchingExternalAwb(false)
    }
  }

  const paid =
    order.financialStatus === 'paid' ||
    order.financialStatus === 'partially_paid' ||
    isPrepaid ||
    Boolean(order.paymentVerified)
  const paymentPill =
    order.financialStatus === 'refunded'
      ? { label: 'Refunded', tone: 'shopify-pill-neutral' }
      : order.financialStatus === 'partially_refunded'
        ? { label: 'Partially refunded', tone: 'shopify-pill-pending' }
        : paid
          ? { label: 'Paid', tone: 'shopify-pill-paid' }
          : { label: order.paymentMethod === 'COD' ? 'Payment pending' : 'Unpaid', tone: 'shopify-pill-pending' }
  const hasWaybill = Boolean(order.shipment?.waybillNumber)
  const fulfillmentPill = (() => {
    if (order.status === 'CANCELLED') return { label: 'Cancelled', tone: 'shopify-pill-alert' }
    if (order.status === 'DELIVERED') return { label: 'Delivered', tone: 'shopify-pill-paid' }
    if (order.status.startsWith('RETURN') || order.status === 'REFUNDED') return { label: labelize(order.status), tone: 'shopify-pill-progress' }
    if (order.status.startsWith('RTO') || order.status === 'FAILED_DELIVERY') return { label: labelize(order.status), tone: 'shopify-pill-alert' }
    if (hasWaybill || order.fulfillmentStatus === 'fulfilled' || ['DISPATCHED', 'SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY'].includes(order.status)) {
      return { label: 'Fulfilled', tone: 'shopify-pill-progress' }
    }
    return { label: 'Unfulfilled', tone: 'shopify-pill-pending' }
  })()
  const canRefund = order.financialStatus !== 'refunded' && order.status !== 'CANCELLED'
  const openMore = () => {
    if (moreOpen) {
      setMoreOpen(false)
      return
    }
    const rect = moreButtonRef.current?.getBoundingClientRect()
    if (!rect) return
    setMorePos({ top: rect.bottom + 6, left: Math.max(8, rect.right - 248) })
    setMoreOpen(true)
  }
  const closeMore = () => setMoreOpen(false)

  return <>
    <div className="shopify-order-top">
      <button type="button" className="shopify-back" onClick={() => navigate('/orders')}>
        <Icon name="arrow" size={16} />
        Orders
      </button>
      <div className="shopify-order-actions">
        {canRefund && (
          <button
            type="button"
            className="shopify-btn"
            disabled={refundMutation.isPending}
            onClick={() => refundMutation.mutate()}
          >
            {refundMutation.isPending ? 'Refunding…' : 'Refund'}
          </button>
        )}
        <div className="shopify-more" ref={moreRef}>
          <button type="button" className="shopify-btn" ref={moreButtonRef} aria-expanded={moreOpen} onClick={openMore}>
            More actions
            <Icon name="chevron" size={14} />
          </button>
          {moreOpen && morePos && (
            <div className="shopify-more-menu" role="menu" style={{ top: morePos.top, left: morePos.left }}>
              <div className="shopify-more-label">Documents</div>
              <button type="button" role="menuitem" disabled={isDownloadingLabel} onClick={() => { closeMore(); handleDownloadLabel() }}>Download label</button>
              <button type="button" role="menuitem" onClick={() => { closeMore(); openPrintableOrderLabel(order.id) }}>Print label</button>
              <button type="button" role="menuitem" disabled={isDownloadingLabelAndInvoice} onClick={() => { closeMore(); handleDownloadLabelAndInvoice() }}>Download label + invoice</button>
              <button type="button" role="menuitem" onClick={() => { closeMore(); openPrintableOrderLabelAndInvoice(order.id) }}>Print label + invoice</button>
              <button type="button" role="menuitem" onClick={() => { closeMore(); openPrintableOrderInvoice(order.id) }}>GST tax invoice</button>
              <button type="button" role="menuitem" disabled={isDownloadingInvoice} onClick={() => { closeMore(); handleDownloadInvoice() }}>Download invoice</button>
              <button type="button" role="menuitem" disabled={isDownloadingPack} onClick={() => { closeMore(); handleDownloadOrderPack() }}>Order pack (ZIP)</button>
              {hasWaybill && order.shipment?.courier?.toLowerCase() === 'delhivery' && (
                <button type="button" role="menuitem" onClick={() => { closeMore(); action.mutate('label') }}>Delhivery packing slip</button>
              )}
              <div className="shopify-more-label">Customer</div>
              <button type="button" role="menuitem" onClick={() => { closeMore(); setShowWhatsAppModal(true) }}>WhatsApp alert</button>
              <button type="button" role="menuitem" onClick={() => { closeMore(); navigate(`/communications?orderId=${order.id}`) }}>Email customer</button>
              {hasWaybill && (
                <a role="menuitem" href={carrierTrackingUrl(order.shipment?.courier, order.shipment!.waybillNumber!)} target="_blank" rel="noreferrer" onClick={closeMore}>Track shipment</a>
              )}
              <div className="shopify-more-label">Order</div>
              {!hasWaybill && (
                <button type="button" role="menuitem" disabled={isFetchingExternalAwb} onClick={() => { closeMore(); handleFetchExternalFulfillment() }}>Fetch Delhivery AWB</button>
              )}
              {hasWaybill && (
                <button type="button" role="menuitem" onClick={() => { closeMore(); setShowEditDetails(true); document.getElementById('shipment-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }}>Edit phone / address</button>
              )}
              {order.status === 'DELIVERED' && (
                <button type="button" role="menuitem" onClick={() => { closeMore(); document.getElementById('return-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }}>Create reverse pickup</button>
              )}
              {(order.hasNdrException || ['FAILED_DELIVERY', 'RTO_INITIATED'].includes(order.status)) && (
                <button type="button" role="menuitem" onClick={() => { closeMore(); setShowNdrModal(true) }}>Resolve NDR</button>
              )}
              {order.status === 'RTO_DELIVERED' && order.paymentMethod !== 'COD' && order.financialStatus !== 'refunded' && (
                <button type="button" role="menuitem" disabled={isRefundingRto} onClick={() => { closeMore(); handleProcessRtoRefund() }}>Process RTO refund</button>
              )}
              {order.hasUrgentSupport && (
                <button type="button" role="menuitem" onClick={() => { closeMore(); navigate(`/support?search=${order.shopifyOrderName}`) }}>Open support ticket</button>
              )}
              {order.status !== 'CANCELLED' ? (
                <button type="button" role="menuitem" className="is-danger" onClick={() => { closeMore(); setShowCancelModal(true) }}>Cancel order</button>
              ) : (
                <button type="button" role="menuitem" className="is-danger" onClick={() => { closeMore(); setShowDeleteModal(true) }}>Delete order</button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>

    <div className="shopify-order-title">
      <h1>{order.shopifyOrderName}</h1>
      <button
        type="button"
        className="order-copy-chip"
        title="Copy order name"
        onClick={() => {
          navigator.clipboard.writeText(order.shopifyOrderName)
          toast.toast('success', `Order name ${order.shopifyOrderName} copied!`)
        }}
      >
        <Icon name="copy" size={14} />
      </button>
      <span className={`shopify-pill ${paymentPill.tone}`}>{paymentPill.label}</span>
      <span className={`shopify-pill ${fulfillmentPill.tone}`}>{fulfillmentPill.label}</span>
      <StatusBadge status={order.status} />
      {order.hasUrgentSupport && (
        <button type="button" className="shopify-pill shopify-pill-alert" onClick={() => navigate(`/support?search=${order.shopifyOrderName}`)}>
          Support
        </button>
      )}
    </div>
    <p className="shopify-order-meta">
      {formatDate(order.shopifyCreatedAt || order.createdAt)} from {order.salesChannel || 'Online Store'}
      {order.customerCity ? ` · ${order.customerCity}, ${order.customerState}` : ''}
    </p>
    {/* ─── UI UX Max Pro: Urgent Dispatch Alert Banner ─────── */}
    {isDispatchNeeded && (
      <div className="prepaid-alert-banner">
        <div className="prepaid-alert-left">
          <div className="prepaid-alert-icon" style={{ background: isPrepaid ? '#2563eb' : '#059669' }}>⚡</div>
          <div>
            <h4 className="prepaid-alert-title" style={{ color: isPrepaid ? '#1e3a8a' : '#065f46' }}>
              {isPrepaid ? 'URGENT: PREPAID ORDER AWAITING DISPATCH' : 'COD CONFIRMED: READY FOR IMMEDIATE DISPATCH'}
            </h4>
            <p className="prepaid-alert-desc">
              {isPrepaid
                ? `Customer has paid in advance via ${order.paymentGateway || 'Prepaid / UPI'}. Prioritize Delhivery AWB manifest and handover immediately.`
                : `Customer purchase intent has been verified via COD confirmation tag. Ready to manifest and book Delhivery shipment.`}
            </p>
          </div>
        </div>
        <Button
          className="button-primary"
          style={{
            background: isPrepaid ? '#2563eb' : '#059669',
            borderColor: isPrepaid ? '#1d4ed8' : '#047857',
            color: '#fff',
            whiteSpace: 'nowrap'
          }}
          disabled={!canDispatch || action.isPending}
          loading={action.isPending && action.variables === 'dispatch'}
          onClick={() => action.mutate('dispatch')}
        >
          <Icon name="package" size={16} />
          {isPrepaid ? 'Priority Delhivery Dispatch' : 'Dispatch with Delhivery'}
        </Button>
      </div>
    )}

    {/* Delayed Dispatch SLA Overdue Alert */}
    {order.isDispatchOverdue && (
      <div className="sla-warning-banner" style={{ marginTop: '12px', marginBottom: '12px' }}>
        <div className="sla-warning-left">
          <div className="sla-warning-icon">⚠️</div>
          <div>
            <h4 className="sla-warning-title">
              Dispatch SLA Breached (+{order.dispatchOverdueHours || 24} Hours Overdue)
            </h4>
            <p className="sla-warning-desc">
              Order placed on {formatDate(order.shopifyCreatedAt || order.createdAt)}. Expected dispatch SLA (within 24 hours) was {formatDate(order.expectedDispatchAt || new Date(new Date(order.shopifyCreatedAt || order.createdAt).getTime() + 24 * 3600 * 1000).toISOString())}. Expedite Delhivery manifest immediately to avoid customer cancellation.
            </p>
          </div>
        </div>
        {canDispatch && (
          <Button
            className="button-primary"
            style={{ background: '#be123c', borderColor: '#9f1239', color: '#fff', whiteSpace: 'nowrap' }}
            disabled={action.isPending}
            loading={action.isPending && action.variables === 'dispatch'}
            onClick={() => action.mutate('dispatch')}
          >
            <Icon name="package" size={15} />
            Dispatch Urgently
          </Button>
        )}
      </div>
    )}

    {/* NDR Delivery Exception Alert Card */}
    {(order.hasNdrException || ['FAILED_DELIVERY', 'RTO_INITIATED'].includes(order.status)) && (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px',
          background: 'linear-gradient(135deg, #fff1f2 0%, #ffe4e6 100%)',
          border: '1.5px solid #fecdd3',
          borderLeft: '5px solid #e11d48',
          borderRadius: '8px',
          padding: '12px 16px',
          marginTop: '12px',
          marginBottom: '12px',
          boxShadow: '0 2px 4px rgba(225, 29, 72, 0.08)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div
            style={{
              width: '36px',
              height: '36px',
              borderRadius: '50%',
              background: '#ffe4e6',
              color: '#e11d48',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '18px',
              flexShrink: 0,
            }}
          >
            🚨
          </div>
          <div>
            <h4 style={{ margin: 0, color: '#9f1239', fontSize: '14px', fontWeight: 800 }}>
              NDR Delivery Exception · Action Required
            </h4>
            <p style={{ margin: '2px 0 0 0', color: '#be123c', fontSize: '12px' }}>
              Courier ({order.shipment?.courier || 'Delhivery'}) reported: <strong>{order.shipment?.trackingStatus || 'Delivery attempt failed'}</strong>
              {order.shipment?.trackingLocation ? ` at ${order.shipment.trackingLocation}` : ''}.
              Resolve delivery exception with courier re-attempt or mark RTO.
            </p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <Button
            className="button-primary"
            style={{ background: '#be123c', borderColor: '#9f1239', color: '#fff', whiteSpace: 'nowrap' }}
            onClick={() => setShowNdrModal(true)}
          >
            <Icon name="alert" size={15} />
            Resolve NDR Exception
          </Button>
        </div>
      </div>
    )}

    {/* RTO Delivery & Auto-Refund Banner */}
    {(order.status === 'RTO_DELIVERED' || order.status === 'RTO_INITIATED') && (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px',
          background: order.paymentMethod !== 'COD' ? '#eff6ff' : '#f0fdf4',
          border: order.paymentMethod !== 'COD' ? '1.5px solid #bfdbfe' : '1.5px solid #bbf7d0',
          borderLeft: order.paymentMethod !== 'COD' ? '5px solid #2563eb' : '5px solid #16a34a',
          borderRadius: '8px',
          padding: '12px 16px',
          marginTop: '12px',
          marginBottom: '12px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div
            style={{
              width: '36px',
              height: '36px',
              borderRadius: '50%',
              background: order.paymentMethod !== 'COD' ? '#dbeafe' : '#dcfce7',
              color: order.paymentMethod !== 'COD' ? '#1d4ed8' : '#15803d',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '18px',
              flexShrink: 0,
            }}
          >
            {order.paymentMethod !== 'COD' ? '💸' : '📦'}
          </div>
          <div>
            <h4 style={{ margin: 0, color: order.paymentMethod !== 'COD' ? '#1e40af' : '#166534', fontSize: '14px', fontWeight: 800 }}>
              {order.status === 'RTO_DELIVERED' ? 'Returned Package Safely Received at Warehouse' : 'Package in Transit to Warehouse (RTO Initiated)'}
            </h4>
            <p style={{ margin: '2px 0 0 0', color: order.paymentMethod !== 'COD' ? '#1d4ed8' : '#15803d', fontSize: '12px' }}>
              {order.paymentMethod !== 'COD'
                ? order.financialStatus === 'refunded'
                  ? `Full refund of ₹${order.totalAmount} has been processed via Shopify back to ${order.paymentProvider || order.paymentGateway || 'Easebuzz / PhonePe'}. Tags applied: RTO_DELIVERED, RTO_AUTO_REFUNDED.`
                  : `Prepaid Order · Package has been returned. Click below to issue full refund of ₹${order.totalAmount} via Shopify directly to ${order.paymentProvider || order.paymentGateway || 'Easebuzz / PhonePe'}.`
                : 'COD Order · Returned goods restocked into warehouse inventory. No customer refund required.'}
            </p>
          </div>
        </div>
        {order.paymentMethod !== 'COD' && order.financialStatus !== 'refunded' && (
          <Button
            className="button-primary"
            style={{ background: '#2563eb', borderColor: '#1d4ed8', color: '#fff', whiteSpace: 'nowrap' }}
            disabled={isRefundingRto}
            loading={isRefundingRto}
            onClick={handleProcessRtoRefund}
          >
            <Icon name="check" size={15} />
            💸 Process Auto-Refund
          </Button>
        )}
      </div>
    )}

    <div className="detail-grid">
      <div className="detail-main">
        <Panel className="shopify-card" style={{ padding: 0 }}>
          <div className="shopify-card-head">
            <span className={`shopify-pill ${fulfillmentPill.tone}`}>{fulfillmentPill.label}</span>
            {canDispatch && isDispatchNeeded ? (
              <button
                type="button"
                className="shopify-btn shopify-btn-primary"
                disabled={action.isPending}
                onClick={() => action.mutate('dispatch')}
              >
                {action.isPending && action.variables === 'dispatch' ? 'Dispatching…' : 'Dispatch'}
              </button>
            ) : canDispatch && !isCodConf && (order.paymentMethod === 'COD' || order.shipment?.paymentMode === 'COD') ? (
              <button type="button" className="shopify-btn shopify-btn-primary" disabled={isConfirmingCod} onClick={handleConfirmCod}>
                {isConfirmingCod ? 'Confirming…' : 'Confirm COD'}
              </button>
            ) : hasWaybill ? (
              <button type="button" className="shopify-btn shopify-btn-primary" onClick={() => openPrintableOrderLabel(order.id)}>
                Print label
              </button>
            ) : null}
          </div>
          <div className="shopify-ship-line">
            {order.shipment?.courier || 'Standard shipping'}
            {hasWaybill ? ` · AWB ${order.shipment?.waybillNumber}` : ' · Not yet fulfilled'}
          </div>
          <ItemsTable items={order.items ?? []} currency={order.currency} order={order} section="lines" />
        </Panel>

        <Panel className="shopify-card" style={{ padding: 0 }}>
          <div className="shopify-card-head">
            <span className={`shopify-pill ${paymentPill.tone}`}>{paymentPill.label}</span>
          </div>
          <ItemsTable items={order.items ?? []} currency={order.currency} order={order} section="summary" />
        </Panel>

        <OrderLifecycleStepper order={order} />

        {/* ─── Live Delhivery Tracking & Parcel Journey ───────────────────────── */}
        <Panel id="shipment-panel">
          <PanelHeading
            eyebrow={order.shipment?.courier?.toLowerCase() === 'delhivery' ? 'Delhivery Express Network' : 'Carrier Logistics'}
            title={
              order.shipment?.courier?.toLowerCase() === 'delhivery' ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
                  <img src="/logos/delhivery.png" alt="Delhivery" style={{ height: '14px', objectFit: 'contain' }} />
                  <span>Live Delhivery Tracking & Parcel Journey</span>
                </span>
              ) : (
                `${order.shipment?.courier || 'Carrier'} Shipment Tracking`
              )
            }
            action={
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
                {order.shipment?.waybillNumber ? (
                  <Button
                    className="button-secondary button-small"
                    onClick={handleSyncTracking}
                    disabled={isSyncingTracking}
                    loading={isSyncingTracking}
                    title="Poll Delhivery API in real-time for latest parcel tracking events"
                    style={{ height: '28px', fontSize: '11px', display: 'inline-flex', alignItems: 'center', gap: '5px' }}
                  >
                    <Icon name="refresh" size={12} />
                    <span>{isSyncingTracking ? 'Syncing Delhivery…' : '⚡ Refresh Live Tracking'}</span>
                  </Button>
                ) : (
                  <Button
                    className="button-secondary button-small"
                    onClick={handleFetchExternalFulfillment}
                    disabled={isFetchingExternalAwb}
                    loading={isFetchingExternalAwb}
                    title="Check if order was manifested in Delhivery ONE panel or fulfilled in OMS Guru and retrieve AWB"
                    style={{ height: '28px', fontSize: '11px', display: 'inline-flex', alignItems: 'center', gap: '5px', color: '#7c3aed', borderColor: '#c4b5fd' }}
                  >
                    <Icon name="zap" size={12} />
                    <span>{isFetchingExternalAwb ? 'Checking…' : '⚡ Get External AWB'}</span>
                  </Button>
                )}
                {order.shipment?.status && <StatusBadge status={order.shipment.status} />}
              </div>
            }
          />

          {order.shipment ? (
            <>
              {/* Visual 5-Stage Parcel Transit Stepper */}
              <div className="order-stepper-card" style={{ marginBottom: '16px', background: '#f8fafc' }}>
                <div className="order-stepper-header" style={{ marginBottom: '14px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontSize: '12px', fontWeight: 800, color: '#0f172a' }}>
                      Package Transit Status
                    </span>
                    {isNdrOrRtoShipment && (
                      <span className="ndr-badge" style={{ fontSize: '10px', padding: '1px 6px' }}>
                        🚨 Delivery Exception / NDR
                      </span>
                    )}
                  </div>
                  <span style={{ fontSize: '11px', color: '#64748b' }}>
                    AWB: <strong className="mono" style={{ color: '#1e3a8a' }}>{order.shipment.waybillNumber || 'Unassigned'}</strong>
                    {order.shipment.trackingLocation ? ` · Location: ${order.shipment.trackingLocation}` : ''}
                  </span>
                </div>

                {(() => {
                  const s = (order.shipment.status || '').toUpperCase()
                  const ts = (order.shipment.trackingStatus || '').toLowerCase()
                  let stage = 1
                  if (s === 'DELIVERED') stage = 5
                  else if (s === 'OUT_FOR_DELIVERY' || ts.includes('out for delivery') || ts.includes('dispatched for delivery')) stage = 4
                  else if (s === 'IN_TRANSIT' || ts.includes('in transit') || ts.includes('reached') || ts.includes('bag') || ts.includes('connection') || ts.includes('hub')) stage = 3
                  else if (s === 'PICKED_UP' || ts.includes('picked') || ts.includes('pickup') || ts.includes('inward')) stage = 2

                  const steps = [
                    { num: 1, title: 'Manifested', subtitle: 'AWB Created', icon: 'package' as const },
                    { num: 2, title: 'Picked Up', subtitle: 'Surat Hub', icon: 'truck' as const },
                    { num: 3, title: 'In Transit', subtitle: order.shipment.trackingLocation || 'Linehaul Hubs', icon: 'route' as const },
                    { num: 4, title: 'Out for Delivery', subtitle: order.customerCity || 'Courier Van', icon: 'truck' as const },
                    { num: 5, title: 'Delivered', subtitle: stage === 5 ? 'Handed Over' : 'Pending', icon: 'check' as const },
                  ]
                  const fillPercent = ((stage - 1) / (steps.length - 1)) * 100

                  return (
                    <div className="order-stepper-progress">
                      <div className="order-stepper-track-bg" />
                      <div
                        className="order-stepper-track-fill"
                        style={{
                          width: `calc(${fillPercent}% - 32px)`,
                          background: isNdrOrRtoShipment ? 'linear-gradient(90deg, #f59e0b, #ef4444)' : 'linear-gradient(90deg, #2563eb, #10b981)',
                        }}
                      />
                      {steps.map((st) => {
                        const isCompleted = st.num < stage
                        const isActive = st.num === stage
                        return (
                          <div
                            key={st.num}
                            className={`order-step-node ${isCompleted ? 'completed' : ''} ${isActive ? 'active' : ''}`}
                          >
                            <div
                              className="order-step-circle"
                              style={isActive && isNdrOrRtoShipment ? { background: '#ef4444', borderColor: '#ef4444', color: '#fff' } : undefined}
                            >
                              {isCompleted ? <Icon name="check" size={15} /> : <Icon name={st.icon} size={15} />}
                            </div>
                            <span className="order-step-title">{st.title}</span>
                            <span className="order-step-subtitle">{st.subtitle}</span>
                          </div>
                        )
                      })}
                    </div>
                  )
                })()}
              </div>

              {/* 21st.dev Design Pro: Summary Telemetry Metric Cards */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: '12px', marginTop: '12px', marginBottom: '14px' }}>
                <StatCard
                  title={`${order.shipment.courier || 'Carrier'} AWB`}
                  value={
                    order.shipment.waybillNumber ? (
                      <CopyableBadge text={order.shipment.waybillNumber} monospace={true} />
                    ) : (
                      <span style={{ fontSize: '13px', color: '#94a3b8' }}>Not assigned</span>
                    )
                  }
                  icon="tag"
                  accentColor="#2563eb"
                  subtext={order.shipment.courier || 'Delhivery Express'}
                />

                <StatCard
                  title="Tracking Status"
                  value={<span style={{ fontSize: '14px', fontWeight: 700, color: '#0f172a' }}>{order.shipment.trackingStatus ?? 'Awaiting carrier scan'}</span>}
                  icon="truck"
                  accentColor={isNdrOrRtoShipment ? '#dc2626' : '#059669'}
                  subtext={order.shipment.status ? `Status: ${order.shipment.status}` : undefined}
                />

                <StatCard
                  title="Current Location"
                  value={<span style={{ fontSize: '14px', fontWeight: 700, color: '#0f172a' }}>{order.shipment.trackingLocation ?? 'Origin Hub (Surat)'}</span>}
                  icon="pin"
                  accentColor="#0284c7"
                  subtext={order.customerCity ? `Destination: ${order.customerCity}` : 'In Transit'}
                />

                {order.shipment.paymentMode === 'COD' && (
                  <StatCard
                    title="COD Ledger"
                    value={<span style={{ fontSize: '16px', fontWeight: 800, color: '#92400e' }}>{formatMoney(order.shipment.codAmount, order.currency)}</span>}
                    icon="creditCard"
                    accentColor="#d97706"
                    subtext={
                      order.shipment.codRemitted
                        ? `Remitted by ${order.shipment.courier || 'Carrier'}${order.shipment.codRemittanceRef ? ` · Ref: ${order.shipment.codRemittanceRef}` : ''}`
                        : order.shipment.codCollected
                        ? 'Collected · Pending remittance'
                        : 'Cash pending delivery collection'
                    }
                  />
                )}
              </div>

              {/* Quick Shipping & Document Actions */}
              <div className="shipment-actions" style={{ marginTop: '14px', flexWrap: 'wrap', gap: '8px' }}>
                {order.shipment.waybillNumber && (
                  <>
                    <button
                      type="button"
                      className="button button-secondary"
                      onClick={handleDownloadLabel}
                      disabled={isDownloadingLabel}
                      title="Directly download official Delhivery shipping label file (no new tab)"
                      style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                    >
                      <Icon name="download" size={15} />
                      <span>{isDownloadingLabel ? 'Downloading…' : '📥 Download Label (File)'}</span>
                    </button>

                    <button
                      type="button"
                      className="button button-secondary"
                      onClick={() => openPrintableOrderLabel(order.id)}
                      title="View & print Delhivery 4R Thermal Shipping Label"
                      style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                    >
                      <Icon name="external" size={15} />
                      <span>🏷️ Print Label</span>
                    </button>

                    <button
                      type="button"
                      className="button button-secondary"
                      onClick={handleDownloadLabelAndInvoice}
                      disabled={isDownloadingLabelAndInvoice}
                      title="Directly download combined Label + Invoice as file (sequenced: Label then Invoice, no new tab)"
                      style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', color: '#7c3aed', borderColor: '#ddd6fe', background: '#f5f3ff' }}
                    >
                      <Icon name="download" size={15} />
                      <span>{isDownloadingLabelAndInvoice ? 'Downloading…' : '📥 Download Label + Inv'}</span>
                    </button>

                    <button
                      type="button"
                      className="button button-secondary"
                      onClick={() => openPrintableOrderLabelAndInvoice(order.id)}
                      title="Print combined Label then Invoice (Order 1 Label, then Order 1 Invoice)"
                      style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', color: '#7c3aed', borderColor: '#ddd6fe', background: '#f5f3ff' }}
                    >
                      <Icon name="external" size={15} />
                      <span>🏷️🧾 Print Label + Inv</span>
                    </button>

                    <button
                      type="button"
                      className="button button-secondary"
                      onClick={() => openPrintableOrderInvoice(order.id)}
                      title="Print official GST Commercial Tax Invoice"
                      style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', color: '#059669', borderColor: '#a7f3d0', background: '#ecfdf5' }}
                    >
                      <Icon name="external" size={15} />
                      <span>🧾 GST Tax Invoice</span>
                    </button>

                    <button
                      type="button"
                      className="button button-secondary"
                      onClick={handleDownloadInvoice}
                      disabled={isDownloadingInvoice}
                      title="Directly download official GST tax invoice file (no new tab)"
                      style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', color: '#059669', borderColor: '#a7f3d0', background: '#ecfdf5' }}
                    >
                      <Icon name="download" size={15} />
                      <span>{isDownloadingInvoice ? 'Downloading…' : '📥 Download Invoice (File)'}</span>
                    </button>

                    <button
                      type="button"
                      className="button button-secondary"
                      onClick={handleDownloadOrderPack}
                      disabled={isDownloadingPack}
                      title="Download complete fulfillment pack ZIP for this order (Picklist + Collated Label & Invoice + Manifest CSV)"
                      style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', color: '#047857', borderColor: '#6ee7b7', background: '#ecfdf5', fontWeight: 700 }}
                    >
                      <Icon name="package" size={15} />
                      <span>{isDownloadingPack ? 'Zipping…' : '📦 Order Pack (ZIP)'}</span>
                    </button>

                    <a
                      className="button button-secondary"
                      href={carrierTrackingUrl(order.shipment.courier, order.shipment.waybillNumber)}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={`Open tracking page on ${order.shipment.courier || 'Delhivery'}`}
                    >
                      <Icon name="route" size={15} />
                      <span>Track on {order.shipment.courier || 'Delhivery'} ↗</span>
                    </a>
                  </>
                )}

                {order.shipment.courier?.toLowerCase() === 'delhivery' && (
                  <Button
                    className="button-danger-ghost"
                    disabled={!order.shipment.waybillNumber || action.isPending || order.shipment.status === 'CANCELLED'}
                    loading={action.isPending && action.variables === 'cancel'}
                    onClick={() => {
                      if (window.confirm('Cancel this Delhivery shipment?')) {
                        action.mutate('cancel')
                      }
                    }}
                  >
                    <Icon name="close" size={15} />
                    <span>Cancel shipment</span>
                  </Button>
                )}

                {(order.shipment.epodStoragePath || order.shipment.status === 'DELIVERED') && (
                  <Button
                    className="button-secondary"
                    onClick={async () => {
                      try {
                        const res = await api.get(`/api/orders/${order.id}/epod`);
                        if (res.data?.epodUrl) {
                          window.open(res.data.epodUrl, '_blank');
                        } else {
                          toast.toast('success', res.data?.message || 'EPOD is being generated by Delhivery');
                        }
                      } catch (err: any) {
                        toast.toast('error', err.response?.data?.error || 'EPOD not available yet');
                      }
                    }}
                  >
                    <Icon name="check" size={15} />
                    <span>View EPOD</span>
                  </Button>
                )}

                {order.shipment.courier?.toLowerCase() === 'delhivery' && order.shipment.waybillNumber && (
                  <Button
                    className="button-secondary"
                    onClick={() => {
                      setEditPhone(order.customerPhone || '')
                      setEditAddress(
                        [order.customerAddress, order.customerCity, order.customerState, order.customerPincode]
                          .filter(Boolean)
                          .join(', ')
                      )
                      setShowEditDetails((v) => !v)
                    }}
                  >
                    <Icon name="tool" size={15} />
                    <span>{showEditDetails ? 'Hide correction' : 'Correct phone / address'}</span>
                  </Button>
                )}
              </div>

              {(order.shipment.epodStoragePath || order.shipment.epodReceivedBy) && (
                <div style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: '8px', padding: '10px 14px', marginTop: '12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: '#166534' }}>
                    <span style={{ fontSize: '16px' }}>📋</span>
                    <div>
                      <strong>Electronic Proof of Delivery (EPOD) Verified</strong>
                      <div style={{ fontSize: '11px', color: '#15803d', marginTop: '1px' }}>
                        {order.shipment.epodReceivedBy ? `Received by: ${order.shipment.epodReceivedBy}` : 'Signed & Delivered'}
                        {order.shipment.epodReceivedAt && ` • ${new Date(order.shipment.epodReceivedAt).toLocaleString('en-IN')}`}
                      </div>
                    </div>
                  </div>
                  <Button
                    className="button-small button-secondary"
                    onClick={async () => {
                      try {
                        const res = await api.get(`/api/orders/${order.id}/epod`);
                        if (res.data?.epodUrl) {
                          window.open(res.data.epodUrl, '_blank');
                        } else {
                          toast.toast('success', 'EPOD link is processing');
                        }
                      } catch (err: any) {
                        toast.toast('error', 'EPOD download failed');
                      }
                    }}
                  >
                    Open EPOD Image
                  </Button>
                </div>
              )}

              {showEditDetails && order.shipment?.waybillNumber && (
                <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '12px', marginTop: '10px', display: 'grid', gap: '8px' }}>
                  <span style={{ fontSize: '11px', color: '#64748b' }}>
                    Pushes corrected details to Delhivery (Edit Order API — allowed while Manifested / In Transit / Pending).
                  </span>
                  <input
                    type="text"
                    placeholder="Corrected 10-digit phone"
                    value={editPhone}
                    onChange={(e) => setEditPhone(e.target.value)}
                    style={{ width: '100%' }}
                  />
                  <input
                    type="text"
                    placeholder="Corrected address with pincode"
                    value={editAddress}
                    onChange={(e) => setEditAddress(e.target.value)}
                    style={{ width: '100%' }}
                  />
                  <div>
                    <Button
                      className="button-primary"
                      disabled={isSavingEdit || (!editPhone.trim() && !editAddress.trim())}
                      loading={isSavingEdit}
                      onClick={async () => {
                        setIsSavingEdit(true)
                        try {
                          await api.patch(`/api/delhivery/shipment/${encodeURIComponent(order.shipment?.waybillNumber || '')}`, {
                            ...(editPhone.trim() ? { phone: [editPhone.trim()] } : {}),
                            ...(editAddress.trim() ? { address: editAddress.trim() } : {}),
                          })
                          toast.toast('success', 'Corrected details pushed to Delhivery!')
                          setShowEditDetails(false)
                          await queryClient.invalidateQueries({ queryKey: ['order', id] })
                        } catch (err: any) {
                          toast.toast('error', apiError(err))
                        } finally {
                          setIsSavingEdit(false)
                        }
                      }}
                    >
                      Push to Delhivery
                    </Button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <EmptyState
              title={order.fulfillmentStatus === 'fulfilled' ? 'Fulfilled on Shopify' : 'Shipment not created'}
              description={
                order.fulfillmentStatus === 'fulfilled'
                  ? 'This order has a fulfillment record on Shopify. Click "Sync Shopify" or dispatch with Delhivery to sync waybill tracking.'
                  : 'Click "Dispatch with Delhivery" to generate waybill and assign shipment.'
              }
              icon="route"
            />
          )}
        </Panel>

        {/* ─── Carrier Logistics Charges / Economics ──────────────── */}
        <Panel>
          <PanelHeading
            eyebrow="Carrier economics"
            title={
              order.shipment?.courier && order.shipment.courier.toLowerCase() !== 'delhivery' ? (
                `${order.shipment.courier} Logistics`
              ) : (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
                  <img src="/logos/delhivery.png" alt="Delhivery" style={{ height: '13px', objectFit: 'contain' }} />
                  <span>Delhivery Logistics Charges</span>
                </span>
              )
            }
          />
          {order.shipment?.courier && order.shipment.courier.toLowerCase() !== 'delhivery' ? (
            <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#1e293b', fontWeight: 700, fontSize: '13px' }}>
                <Icon name="package" size={18} />
                <span>Fulfilled via {order.shipment.courier} (AWB: {order.shipment.waybillNumber})</span>
              </div>
              <p style={{ margin: '8px 0 0 0', fontSize: '12px', color: '#64748b', lineHeight: 1.5 }}>
                This order was dispatched via external carrier <strong>{order.shipment.courier}</strong>. Live tracking status is synced directly from Shopify fulfillments. Delhivery rate estimation applies only to orders dispatched through Delhivery; billed amounts are checked in the Delhivery ONE panel.
              </p>
            </div>
          ) : estimateQuery.isLoading ? (
            <LoadingState label="Calculating carrier logistics charges…" />
          ) : estimateQuery.data ? (
            <div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px', background: '#f8fafc', padding: '12px', borderRadius: '8px', marginBottom: '10px' }}>
                <div>
                  <span className="detail-label">Origin Pincode</span>
                  <strong className="mono" style={{ color: '#1e3a8a' }}>{estimateQuery.data.originPincode} (Surat)</strong>
                </div>
                <div>
                  <span className="detail-label">Destination Pincode</span>
                  <strong className="mono" style={{ color: '#0f172a' }}>{estimateQuery.data.destinationPincode} ({order.customerCity})</strong>
                </div>
                <div>
                  <span className="detail-label">Chargeable Weight</span>
                  <strong>{estimateQuery.data.chargeableWeightGrams}g</strong>
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 14px', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: '8px' }}>
                <div>
                  <span style={{ fontSize: '10px', color: '#1e40af', textTransform: 'uppercase', fontWeight: 700 }}>
                    Estimated Shipping Cost
                  </span>
                  <strong style={{ display: 'block', fontSize: '20px', color: '#1e3a8a', fontWeight: 800 }}>
                    {formatMoney(Number(estimateQuery.data.charges?.total_amount ?? estimateQuery.data.charges?.shippingCost ?? estimateQuery.data.charges?.cost ?? estimateQuery.data.charges?.amount ?? 0))}
                  </strong>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <span style={{ display: 'block', fontSize: '11px', color: '#1d4ed8', fontWeight: 700 }}>
                    Mode: {order.paymentMethod === 'COD' ? 'Surface COD' : 'Surface Prepaid'}
                  </span>
                  <span style={{ fontSize: '9.5px', color: '#64748b' }}>Zone: Domestic Surface</span>
                </div>
              </div>

              {/* ─── Actual billed charges live in the Delhivery ONE panel ─── */}
              {order.shipment?.waybillNumber && (
                <div style={{ marginTop: '14px', paddingTop: '14px', borderTop: '1px dashed #cbd5e1' }}>
                  <div style={{ fontSize: '11px', color: '#475569', lineHeight: 1.6 }}>
                    🧾 Actual billed debits, weight re-weighments and reversals live in{' '}
                    <strong>Delhivery ONE → Finances → Wallet → Transactions</strong> (search AWB{' '}
                    <code>{order.shipment.waybillNumber}</code>). Delhivery offers no wallet
                    API, so billed amounts are checked in the panel, not here.
                  </div>
                </div>
              )}

              <p style={{ margin: '8px 0 0', fontSize: '10.5px', color: '#64748b', lineHeight: 1.45 }}>
                ℹ️ Computed via Delhivery Rate API. Actual billed logistics charges per AWB are audited post-delivery upon hub weighment and billed in the Delhivery ONE Billing MIS.
              </p>
            </div>
          ) : (
            <p style={{ fontSize: '11px', color: '#94a3b8' }}>Logistics charges will be calculated based on destination pincode and shipment weight.</p>
          )}
        </Panel>

        {/* ─── Carrier Tracking Timeline ────────────────────────── */}
        <Panel>
          <PanelHeading eyebrow="Carrier events" title="Tracking timeline" />
          {order.shipment?.trackingLogs?.length ? (
            <div className="timeline">
              {[...order.shipment.trackingLogs]
                .sort((a, b) => new Date(b.scannedAt).getTime() - new Date(a.scannedAt).getTime())
                .map((log, index) => (
                  <div className="timeline-item" key={log.id}>
                    <div className={`timeline-marker ${index === 0 ? 'current' : ''}`}>
                      <Icon name={index === 0 ? 'pin' : 'check'} size={13} />
                    </div>
                    <div className="timeline-copy">
                      <strong>{log.status}</strong>
                      <span>{[log.location, log.remark].filter(Boolean).join(' · ') || 'Carrier update'}</span>
                      <time>{formatDate(log.scannedAt)}</time>
                    </div>
                  </div>
                ))}
            </div>
          ) : (
            <EmptyState
              title="No tracking events yet"
              description="Delhivery carrier scans will appear here as the shipment moves through hubs."
              icon="clock"
            />
          )}
        </Panel>
      </div>

      <div className="detail-side">
        <Panel>
          <PanelHeading eyebrow="Customer" title={order.customerName} />
          <div className="customer-detail">
            <div className="customer-avatar">
              {order.customerName.split(' ').map((part) => part[0]).slice(0, 2).join('').toUpperCase()}
            </div>
            <div>
              <strong style={{ fontSize: '14px', color: 'var(--ink)' }}>{order.customerName}</strong>
              <span style={{ fontSize: '11px', color: 'var(--ink-secondary)' }}>{order.customerPhone || 'No phone'}</span>
              <span style={{ fontSize: '11px', color: 'var(--muted)' }}>{order.customerEmail ?? 'No email provided'}</span>
            </div>
          </div>
          <div className="address-card">
            <Icon name="pin" size={20} />
            <div style={{ flex: 1 }}>
              <strong style={{ fontSize: '12px', color: 'var(--ink)' }}>{order.customerAddress}</strong>
              <span style={{ fontSize: '11px', color: 'var(--ink-secondary)', marginTop: '2px', display: 'block' }}>
                {order.customerCity}, {order.customerState} — <strong className="mono">{order.customerPincode}</strong>
              </span>
              <span style={{ fontSize: '10px', color: 'var(--muted)' }}>{order.customerCountry}</span>
            </div>
          </div>
          <div className="customer-quick-actions">
            {cleanPhone ? (
              <a className="quick-action-btn quick-action-wa" href={`https://wa.me/91${cleanPhone}?text=${encodeURIComponent(`Hi ${order.customerName}, this is regarding your order ${order.shopifyOrderName} from our store.`)}`} target="_blank" rel="noopener noreferrer">
                <Icon name="message" size={14} /> WhatsApp Chat
              </a>
            ) : (
              <button className="quick-action-btn quick-action-wa" disabled><Icon name="message" size={14} /> No WhatsApp</button>
            )}
            {cleanPhone ? (
              <a className="quick-action-btn quick-action-call" href={`tel:${cleanPhone}`}><Icon name="phone" size={14} /> Call Customer</a>
            ) : (
              <button className="quick-action-btn quick-action-call" disabled><Icon name="phone" size={14} /> No Phone</button>
            )}
            <button className="quick-action-btn quick-action-copy" onClick={copyAddress}><Icon name="copy" size={14} /> Copy Address</button>
          </div>
        </Panel>
        {/* ─── GoKwik Buyer Intelligence & RTO Risk Assessment ─── */}
        <Panel>
          <PanelHeading
            eyebrow="GoKwik Buyer Intelligence"
            title="RTO Risk Assessment"
            action={
              <span className={`rto-risk-pill ${(order.rtoRiskLevel || 'MEDIUM').toLowerCase()}`} style={{ fontSize: '11px', padding: '2px 8px' }}>
                {order.rtoRiskLevel === 'LOW'
                  ? '✓ Low RTO Risk'
                  : order.rtoRiskLevel === 'HIGH'
                  ? '⛔ High RTO Risk'
                  : '⚡ Medium RTO Risk'}
              </span>
            }
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '7px', padding: '10px 12px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                <span className="detail-label">GoKwik Delivery Track Record</span>
                <span style={{ fontSize: '11px', fontWeight: 800, color: (order.deliverOrderCount || 0) >= 2 ? '#047857' : '#b45309' }}>
                  {order.deliverOrderCount ?? 0} Prior Deliveries
                </span>
              </div>
              <p style={{ margin: 0, fontSize: '11.5px', color: '#334155', lineHeight: 1.45 }}>
                {order.rtoRiskReason ||
                  (order.paymentMethod !== 'COD'
                    ? 'Prepaid order captured upfront · Zero RTO risk'
                    : isCodConf
                    ? 'Customer purchase intent verified via WhatsApp COD confirmation'
                    : 'Awaiting customer COD confirmation before dispatch')}
              </p>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
              <div style={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '6px', padding: '8px 10px' }}>
                <span className="detail-label">Payment Mode</span>
                <strong style={{ fontSize: '12px', color: '#0f172a' }}>{order.paymentMethod || 'Prepaid'}</strong>
              </div>
              <div style={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '6px', padding: '8px 10px' }}>
                <span className="detail-label">COD Confirmation</span>
                <strong style={{ fontSize: '12px', color: isCodConf ? '#047857' : '#64748b' }}>
                  {isCodConf ? '✓ Confirmed' : order.paymentMethod === 'COD' ? 'Pending' : 'N/A (Prepaid)'}
                </strong>
              </div>
            </div>
          </div>
        </Panel>

        {/* ─── UI UX Max Pro: Shopify Order Tags & Channel Sync ─── */}
        <Panel>
          <PanelHeading
            eyebrow="Shopify Store Metadata"
            title="Order Tags & Channel Sync"
            action={
              <span className="shopify-channel-pill">
                <Icon name="tag" size={11} /> Shopify Synced
              </span>
            }
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div>
              <span className="detail-label" style={{ marginBottom: '6px', display: 'block' }}>
                Store Tags (Payment & Automation)
              </span>
              {order.tags ? (
                <div className="shopify-tags-list">
                  {order.tags.split(',').map((t) => t.trim()).filter(Boolean).map((tag) => {
                    const lower = tag.toLowerCase()
                    let modifier = 'tag-default'
                    if (lower.includes('weight-mismatch') || lower.includes('mismatch')) modifier = 'tag-mismatch'
                    else if (lower.includes('rebilled')) modifier = 'tag-rebilled'
                    else if (lower.includes('gokwik') || lower.includes('kwik')) modifier = 'tag-gokwik'
                    else if (lower.includes('prepaid')) modifier = 'tag-prepaid'
                    else if (lower.includes('upi')) modifier = 'tag-upi'
                    else if (lower.includes('cod')) modifier = 'tag-cod'
                    else if (lower.includes('dispatch') || lower.includes('awb')) modifier = 'tag-dispatched'
                    else if (lower.includes('refund')) modifier = 'tag-refund'

                    return (
                      <span key={tag} className={`shopify-tag-pill ${modifier}`} style={{ fontSize: '11px', padding: '3px 9px' }}>
                        {tag}
                      </span>
                    )
                  })}
                </div>
              ) : (
                <span style={{ fontSize: '12px', color: '#94a3b8' }}>No tags assigned on Shopify</span>
              )}
            </div>

            <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '10px 12px', fontSize: '11px', color: '#334155', display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontWeight: 700, color: '#0f172a' }}>🔗 Delhivery ONE Channel Link</span>
                <span style={{ color: '#16a34a', fontWeight: 700 }}>● Active</span>
              </div>
              <p style={{ margin: 0, fontSize: '10.5px', color: '#64748b', lineHeight: 1.4 }}>
                When Shopify is linked in Delhivery ONE, dispatches triggered from this OMS automatically update Shopify fulfillment tracking with carrier <strong>Delhivery</strong> and append the generated AWB to order tags.
              </p>
            </div>
          </div>
        </Panel>

        {/* ─── Financials & 3-Way Money Reconciliation ─────────── */}
        <Panel>
          <PanelHeading
            eyebrow="Financials"
            title="Payment & Receipt"
            action={
              <span className={`payment-state ${payment?.paymentVerified ?? order.paymentVerified ? 'verified' : ''}`}>
                <span />
                {payment?.paymentVerified ?? order.paymentVerified ? 'Verified' : 'Unverified'}
              </span>
            }
          />
          {paymentQuery.isError ? (
            <ErrorBox compact message={apiError(paymentQuery.error)} />
          ) : (
            <div className="payment-detail">
              {/* ─── GoKwik / Easebuzz Aggregated Partner Payment Card ─── */}
              {(order.paymentAggregator === 'GoKwik' ||
                (order.paymentGateway || '').toLowerCase().includes('kwik') ||
                order.paymentProvider) && (
                <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '10px', padding: '14px', marginBottom: '14px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px', flexWrap: 'wrap', gap: '6px' }}>
                    <span style={{ fontSize: '11px', fontWeight: 800, color: '#0f172a', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                      Payment Routing & Partner Settlement
                    </span>
                    <span className={`verified-badge ${order.paymentVerified ? 'verified' : 'unverified'}`}>
                      {order.paymentVerified ? 'Captured & Verified' : 'Verification Pending'}
                    </span>
                  </div>

                  {/* Flow Banner */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', background: '#fff', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '10px 14px', marginBottom: '12px', flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <img src="/logos/gokwik.png" alt="GoKwik" style={{ height: '20px', objectFit: 'contain' }} />
                      <div>
                        <div style={{ fontSize: '11.5px', fontWeight: 700, color: '#034694' }}>GoKwik Checkout</div>
                        <div style={{ fontSize: '9.5px', color: '#64748b' }}>Order & 1-Click Aggregator</div>
                      </div>
                    </div>
                    <span style={{ color: '#94a3b8', fontSize: '13px', fontWeight: 700 }}>➔</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <img src="/logos/easebuzz.png" alt="Easebuzz" style={{ height: '18px', objectFit: 'contain' }} />
                      <div>
                        <div style={{ fontSize: '11.5px', fontWeight: 700, color: '#0f172a' }}>
                          {order.paymentProvider || 'Easebuzz'}
                        </div>
                        <div style={{ fontSize: '9.5px', color: '#059669', fontWeight: 600 }}>Acquiring Payment Partner</div>
                      </div>
                    </div>
                  </div>

                  {/* IDs Grid */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '8px' }}>
                    {order.paymentProviderPaymentId && (
                      <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: '6px', padding: '7px 9px' }}>
                        <span className="detail-label" style={{ fontSize: '10px', color: '#64748b' }}>Easebuzz Payment ID</span>
                        <div
                          className="waybill-chip"
                          onClick={() => {
                            navigator.clipboard.writeText(order.paymentProviderPaymentId || '')
                            toast.toast('success', 'Easebuzz Payment ID copied!')
                          }}
                          style={{ marginTop: '2px', cursor: 'pointer' }}
                          title="Click to copy Easebuzz ID"
                        >
                          <span className="mono" style={{ fontSize: '11px', fontWeight: 700, color: '#0f172a' }}>
                            {order.paymentProviderPaymentId}
                          </span>
                          <Icon name="copy" size={11} />
                        </div>
                      </div>
                    )}
                    {order.gokwikPaymentId && (
                      <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: '6px', padding: '7px 9px' }}>
                        <span className="detail-label" style={{ fontSize: '10px', color: '#64748b' }}>GoKwik Payment ID</span>
                        <div
                          className="waybill-chip"
                          onClick={() => {
                            navigator.clipboard.writeText(order.gokwikPaymentId || '')
                            toast.toast('success', 'GoKwik Payment ID copied!')
                          }}
                          style={{ marginTop: '2px', cursor: 'pointer' }}
                          title="Click to copy GoKwik ID"
                        >
                          <span className="mono" style={{ fontSize: '11px', fontWeight: 700, color: '#034694' }}>
                            {order.gokwikPaymentId}
                          </span>
                          <Icon name="copy" size={11} />
                        </div>
                      </div>
                    )}
                    {order.paymentReference && (
                      <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: '6px', padding: '7px 9px' }}>
                        <span className="detail-label" style={{ fontSize: '10px', color: '#64748b' }}>Bank Reference / UTR</span>
                        <div
                          className="waybill-chip"
                          onClick={() => {
                            navigator.clipboard.writeText(order.paymentReference || '')
                            toast.toast('success', 'Bank UTR copied!')
                          }}
                          style={{ marginTop: '2px', cursor: 'pointer' }}
                          title="Click to copy Bank UTR"
                        >
                          <span className="mono" style={{ fontSize: '11px', fontWeight: 700, color: '#15803d' }}>
                            {order.paymentReference}
                          </span>
                          <Icon name="copy" size={11} />
                        </div>
                      </div>
                    )}
                    {order.paymentAuthorizationKey && (
                      <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: '6px', padding: '7px 9px' }}>
                        <span className="detail-label" style={{ fontSize: '10px', color: '#64748b' }}>Authorization Key</span>
                        <div
                          className="waybill-chip"
                          onClick={() => {
                            navigator.clipboard.writeText(order.paymentAuthorizationKey || '')
                            toast.toast('success', 'Auth Key copied!')
                          }}
                          style={{ marginTop: '2px', cursor: 'pointer' }}
                          title="Click to copy Auth Key"
                        >
                          <span className="mono" style={{ fontSize: '11px', fontWeight: 700, color: '#475569' }}>
                            {order.paymentAuthorizationKey}
                          </span>
                          <Icon name="copy" size={11} />
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              <DetailRow
                label="Amount"
                value={formatMoney(payment?.totalAmount ?? order.totalAmount, payment?.currency ?? order.currency)}
                strong
              />
              <DetailRow label="Method" value={payment?.paymentMethod ?? order.paymentMethod} />
              <DetailRow
                label="Money Source"
                value={
                  order.paymentMethod === 'COD' ? (
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                      {order.shipment?.courier?.toLowerCase() === 'delhivery' && (
                        <img src="/logos/delhivery.png" alt="Delhivery" style={{ height: '11px', objectFit: 'contain' }} />
                      )}
                      <span>{order.shipment?.courier || 'Cash'} on Delivery Collection</span>
                    </div>
                  ) : order.paymentAggregator === 'GoKwik' || (order.paymentGateway || '').toLowerCase().includes('gokwik') ? (
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                      <img src="/logos/gokwik.png" alt="GoKwik" style={{ height: '14px', objectFit: 'contain' }} />
                      <span style={{ color: '#94a3b8', fontSize: '11px' }}>via</span>
                      <img src="/logos/easebuzz.png" alt="Easebuzz" style={{ height: '13px', objectFit: 'contain' }} />
                      <span style={{ fontWeight: 600, color: '#0f172a' }}>{order.paymentProvider || 'Easebuzz'}</span>
                    </div>
                  ) : (order.paymentGateway || '').toLowerCase().includes('phonepe') ? (
                    'PhonePe Payment Gateway'
                  ) : (
                    payment?.paymentGateway ?? order.paymentGateway
                  )
                }
              />
              {order.paymentAggregator && (
                <DetailRow
                  label="Aggregator"
                  value={
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                      {order.paymentAggregator.toLowerCase() === 'gokwik' && (
                        <img src="/logos/gokwik.png" alt="GoKwik" style={{ height: '13px', objectFit: 'contain' }} />
                      )}
                      <span>{order.paymentAggregator} Checkout</span>
                    </div>
                  }
                />
              )}
              {order.paymentProvider && (
                <DetailRow
                  label="Acquiring Partner"
                  value={
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                      {order.paymentProvider.toLowerCase() === 'easebuzz' && (
                        <img src="/logos/easebuzz.png" alt="Easebuzz" style={{ height: '13px', objectFit: 'contain' }} />
                      )}
                      <span style={{ fontWeight: 700, color: '#0f172a' }}>{order.paymentProvider}</span>
                    </div>
                  }
                />
              )}
              <DetailRow label="Gateway" value={payment?.paymentGateway ?? order.paymentGateway} />
              <DetailRow
                label="Transaction ID"
                value={payment?.gatewayTransactionId ?? order.gatewayTransactionId}
                mono
                copyable
                onCopy={(val) => {
                  navigator.clipboard.writeText(val)
                  toast.toast('success', 'Transaction ID copied!')
                }}
              />
              <DetailRow label="Financial status" value={payment?.financialStatus ?? order.financialStatus} />
              <DetailRow label="Channel" value={order.salesChannel} />
              <DetailRow label="Verified at" value={formatDate(payment?.paymentVerifiedAt ?? order.paymentVerifiedAt)} />

              {!order.paymentVerified && (
                <Button
                  className="button-primary full-button"
                  loading={action.isPending && action.variables === 'verify'}
                  onClick={() => action.mutate('verify')}
                >
                  <Icon name="shield" size={16} />
                  Verify payment
                </Button>
              )}

              {/* Direct Shopify Refund Option */}
              {order.status !== 'REFUNDED' && (
                <div style={{ marginTop: '14px', paddingTop: '14px', borderTop: '1px dashed #e2e8f0', display: 'flex', flexDirection: 'column', gap: '7px' }}>
                  <Button
                    className="button-secondary full-button"
                    style={{ borderColor: '#fca5a5', color: '#b91c1c', background: '#fff5f5' }}
                    loading={refundMutation.isPending}
                    onClick={() => refundMutation.mutate()}
                  >
                    <Icon name="dollar" size={15} />
                    Issue Shopify Refund ({formatMoney(order.totalAmount, order.currency)})
                  </Button>
                  <span style={{ fontSize: '10px', color: '#64748b', textAlign: 'center' }}>
                    ⚡ Processes refund directly via Shopify API. Shopify automatically routes the refund back through {order.paymentAggregator || 'GoKwik'}{order.paymentProvider ? ` / ${order.paymentProvider}` : ''} to the customer.
                  </span>
                </div>
              )}
            </div>
          )}
        </Panel>

        {/* ─── Customer Notifications ───────────────────────────── */}
        <Panel>
          <PanelHeading eyebrow="Customer communication" title="Notifications" />
          {order.notifications?.length ? (
            <div className="notification-list">
              {order.notifications.map((notice, index) => (
                <div className="notification-row" key={notice.id ?? index}>
                  <div className="notification-icon">
                    <Icon name="check" size={14} />
                  </div>
                  <div>
                    <strong>{notice.type ?? notice.channel ?? 'Notification'}</strong>
                    <span>{notice.message ?? notice.status ?? 'Sent'}</span>
                    <time>{formatDate(notice.sentAt ?? notice.createdAt)}</time>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState title="No notifications" description="Messages sent for this order will appear here." icon="box" />
          )}
        </Panel>

        {/* ─── Reverse Logistics & Return Management ─────────────── */}
        <ReturnForm
          order={order}
          items={(order.items ?? []).filter((item) => item.returnable)}
          selected={selected}
          setSelected={setSelected}
          reason={reason}
          setReason={setReason}
          returnTracking={returnTracking}
          setReturnTracking={setReturnTracking}
          carrier={carrier}
          setCarrier={setCarrier}
          loading={returnMutation.isPending}
          onSubmit={() => returnMutation.mutate()}
        />
      </div>
    </div>

    {/* ─── Cancel Order Confirmation Trigger Modal ─── */}
    {showCancelModal && order && (
      <div className="modal-backdrop" onClick={() => !isCancelling && setShowCancelModal(false)}>
        <div className="modal-card" onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <div className="modal-header-left">
              <div className="modal-icon-badge danger">
                <Icon name="alert" size={20} />
              </div>
              <div>
                <h3 className="modal-title">Cancel Order {order.shopifyOrderName}</h3>
                <p className="modal-desc">Review cancellation details before proceeding.</p>
              </div>
            </div>
            <button
              type="button"
              className="modal-close-btn"
              disabled={isCancelling}
              onClick={() => setShowCancelModal(false)}
            >
              <Icon name="close" size={16} />
            </button>
          </div>

          <div className="modal-body">
            <div className="modal-order-summary-box">
              <div className="modal-order-summary-left">
                <span className="modal-order-name">{order.shopifyOrderName} · {order.customerName}</span>
                <span className="modal-order-sub">
                  {order.customerCity}, {order.customerState} · {order.paymentMethod}
                </span>
              </div>
              <span className="modal-order-amount">{formatMoney(order.totalAmount, order.currency)}</span>
            </div>

            {order.shipment?.waybillNumber && (
              <div className="modal-warning-alert">
                <Icon name="alert" size={16} />
                <div>
                  <strong>{order.shipment.courier || 'Carrier'} Shipment Active (AWB: {order.shipment.waybillNumber})</strong>
                  <div style={{ marginTop: '2px' }}>
                    {order.shipment.courier?.toLowerCase() === 'delhivery'
                      ? 'Cancelling this order will automatically trigger a shipment cancellation request to Delhivery.'
                      : `This order is fulfilled via ${order.shipment.courier || 'an external carrier'}. Cancelling will update Shopify order status.`}
                  </div>
                </div>
              </div>
            )}

            <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '8px', padding: '10px 12px', fontSize: '11px', color: '#166534', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Icon name="check" size={16} />
              <span>Shopify order will be marked cancelled and tagged with CANCELLED.</span>
            </div>

            <FormField label="Cancellation Reason">
              <select
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                disabled={isCancelling}
                style={{ width: '100%' }}
              >
                <option value="customer">Customer changed mind / requested cancellation</option>
                <option value="customer_unreachable">Customer unreachable for COD confirmation</option>
                <option value="fraud">Fraudulent / suspicious order</option>
                <option value="inventory">Inventory unavailable / out of stock</option>
                <option value="declined">Incomplete address / undeliverable location</option>
                <option value="other">Other reason</option>
              </select>
            </FormField>
          </div>

          <div className="modal-footer">
            <button
              type="button"
              className="modal-btn-cancel"
              disabled={isCancelling}
              onClick={() => setShowCancelModal(false)}
            >
              Never Mind
            </button>
            <button
              type="button"
              className="modal-btn-danger"
              disabled={isCancelling}
              onClick={handleConfirmCancel}
            >
              <Icon name="close" size={14} />
              {isCancelling ? 'Cancelling Order…' : 'Confirm Order Cancellation'}
            </button>
          </div>
        </div>
      </div>
    )}

    {/* ─── Delete Order Confirmation Trigger Modal ─── */}
    {showDeleteModal && order && (
      <div className="modal-backdrop" onClick={() => !isDeleting && setShowDeleteModal(false)}>
        <div className="modal-card" onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <div className="modal-header-left">
              <div className="modal-icon-badge danger">
                <Icon name="alert" size={20} />
              </div>
              <div>
                <h3 className="modal-title">Delete Order {order.shopifyOrderName}</h3>
                <p className="modal-desc">Permanent deletion confirmation</p>
              </div>
            </div>
            <button
              type="button"
              className="modal-close-btn"
              disabled={isDeleting}
              onClick={() => setShowDeleteModal(false)}
            >
              <Icon name="close" size={16} />
            </button>
          </div>

          <div className="modal-body">
            <div className="modal-order-summary-box">
              <div className="modal-order-summary-left">
                <span className="modal-order-name">{order.shopifyOrderName} · {order.customerName}</span>
                <span className="modal-order-sub">Status: {order.status}</span>
              </div>
              <span className="modal-order-amount">{formatMoney(order.totalAmount, order.currency)}</span>
            </div>

            <div className="modal-danger-alert">
              <Icon name="alert" size={18} />
              <div>
                <strong>Warning: This action cannot be undone.</strong>
                <div style={{ marginTop: '2px' }}>
                  This order, including its items, shipments, and payment records, will be permanently removed from the system database.
                </div>
              </div>
            </div>
          </div>

          <div className="modal-footer">
            <button
              type="button"
              className="modal-btn-cancel"
              disabled={isDeleting}
              onClick={() => setShowDeleteModal(false)}
            >
              Keep Order
            </button>
            <button
              type="button"
              className="modal-btn-danger"
              disabled={isDeleting}
              onClick={handleConfirmDelete}
            >
              <Icon name="close" size={14} />
              {isDeleting ? 'Deleting Order…' : 'Permanently Delete'}
            </button>
          </div>
        </div>
      </div>
    )}

    {/* ─── NDR Exception Resolution Modal ─── */}
    {showNdrModal && order && (
      <div className="modal-backdrop" onClick={() => !isSubmittingNdr && setShowNdrModal(false)}>
        <div className="modal-card" onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <div className="modal-header-left">
              <div className="modal-icon-badge danger">
                <Icon name="alert" size={20} />
              </div>
              <div>
                <h3 className="modal-title">NDR Exception: {order.shopifyOrderName}</h3>
                <p className="modal-desc">Delivery attempt failed · Schedule re-attempt or return</p>
              </div>
            </div>
            <button
              type="button"
              className="modal-close-btn"
              disabled={isSubmittingNdr}
              onClick={() => setShowNdrModal(false)}
            >
              <Icon name="close" size={16} />
            </button>
          </div>

          <div className="modal-body">
            <div className="modal-order-summary-box">
              <div className="modal-order-summary-left">
                <span className="modal-order-name">{order.shopifyOrderName} · {order.customerName}</span>
                <span className="modal-order-sub">
                  {order.customerPhone} · {order.customerCity}, {order.customerState} ({order.customerPincode})
                </span>
              </div>
              <span className="modal-order-amount">{formatMoney(order.totalAmount, order.currency)}</span>
            </div>

            {order.shipment && (
              <div style={{ background: '#fff1f2', border: '1px solid #fecdd3', borderRadius: '8px', padding: '12px', fontSize: '12px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                  <span style={{ fontWeight: 700, color: '#9f1239' }}>
                    Courier Status: {order.shipment.courier || 'Delhivery'} (AWB: {order.shipment.waybillNumber})
                  </span>
                  <span style={{ fontWeight: 700, color: '#be123c' }}>
                    {order.shipment.trackingStatus || 'Failed Delivery Attempt'}
                  </span>
                </div>
                <div style={{ color: '#881337', fontSize: '11.5px' }}>
                  Location: {order.shipment.trackingLocation || 'Destination Delivery Center'}
                </div>
              </div>
            )}

            <FormField label="Select NDR Action">
              <div style={{ display: 'flex', gap: '10px', marginTop: '6px' }}>
                <label
                  style={{
                    flex: 1,
                    border: ndrActionType === 'RE-ATTEMPT' ? '2px solid #2563eb' : '1px solid #cbd5e1',
                    background: ndrActionType === 'RE-ATTEMPT' ? '#eff6ff' : '#ffffff',
                    borderRadius: '8px',
                    padding: '12px',
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="radio"
                    name="ndrDetailAction"
                    value="RE-ATTEMPT"
                    checked={ndrActionType === 'RE-ATTEMPT'}
                    onChange={() => setNdrActionType('RE-ATTEMPT')}
                    style={{ marginRight: '8px' }}
                  />
                  <strong>🔄 Re-attempt Delivery</strong>
                  <p style={{ margin: '4px 0 0 0', fontSize: '11px', color: '#475569' }}>
                    Request courier to re-attempt delivery tomorrow & notify customer via WhatsApp.
                  </p>
                </label>

                <label
                  style={{
                    flex: 1,
                    border: ndrActionType === 'RTO' ? '2px solid #dc2626' : '1px solid #cbd5e1',
                    background: ndrActionType === 'RTO' ? '#fef2f2' : '#ffffff',
                    borderRadius: '8px',
                    padding: '12px',
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="radio"
                    name="ndrDetailAction"
                    value="RTO"
                    checked={ndrActionType === 'RTO'}
                    onChange={() => setNdrActionType('RTO')}
                    style={{ marginRight: '8px' }}
                  />
                  <strong>↩️ Return to Origin (RTO)</strong>
                  <p style={{ margin: '4px 0 0 0', fontSize: '11px', color: '#475569' }}>
                    Package will be returned to our Surat warehouse. (Prepaid orders get auto-refunded upon warehouse delivery).
                  </p>
                </label>
              </div>
            </FormField>

            <FormField label="Instruction / Courier Remarks (Optional)">
              <input
                type="text"
                placeholder="e.g. Customer requested evening delivery / Verified alternate phone"
                value={ndrNotes}
                onChange={(e) => setNdrNotes(e.target.value)}
                disabled={isSubmittingNdr}
                style={{ width: '100%' }}
              />
            </FormField>
          </div>

          <div className="modal-footer">
            <button
              type="button"
              className="modal-btn-cancel"
              disabled={isSubmittingNdr}
              onClick={() => setShowNdrModal(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="modal-btn-primary"
              style={{
                background: ndrActionType === 'RE-ATTEMPT' ? '#2563eb' : '#dc2626',
                color: '#fff',
                border: 'none',
                borderRadius: '6px',
                padding: '8px 16px',
                fontWeight: 700,
                cursor: 'pointer',
              }}
              disabled={isSubmittingNdr}
              onClick={handleConfirmNdr}
            >
              {isSubmittingNdr
                ? 'Submitting Action…'
                : ndrActionType === 'RE-ATTEMPT'
                ? '🔄 Schedule Courier Re-Attempt'
                : '↩️ Mark Return to Origin (RTO)'}
            </button>
          </div>
        </div>
      </div>
    )}

    {/* ─── Kapso AI WhatsApp Trigger Modal ─── */}
    {showWhatsAppModal && order && (
      <div className="modal-backdrop" onClick={() => !isSendingWhatsApp && setShowWhatsAppModal(false)}>
        <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '540px' }}>
          <div className="modal-header">
            <div className="modal-header-left">
              <div className="modal-icon-badge" style={{ background: '#dcfce7', color: '#16a34a' }}>
                <Icon name="message" size={20} />
              </div>
              <div>
                <h3 className="modal-title">Send WhatsApp via Kapso</h3>
                <p className="modal-desc">Trigger critical automated notification to customer</p>
              </div>
            </div>
            <button
              type="button"
              className="modal-close-btn"
              disabled={isSendingWhatsApp}
              onClick={() => setShowWhatsAppModal(false)}
            >
              <Icon name="close" size={16} />
            </button>
          </div>

          <div className="modal-body">
            <div className="modal-order-summary-box">
              <div className="modal-order-summary-left">
                <span className="modal-order-name">{order.shopifyOrderName} · {order.customerName}</span>
                <span className="modal-order-sub">
                  Recipient Phone: <strong>{order.customerPhone || 'Not Available'}</strong>
                </span>
              </div>
              <span className="modal-order-amount">{formatMoney(order.totalAmount, order.currency)}</span>
            </div>

            <FormField label="Select WhatsApp Trigger Event">
              <select
                value={whatsAppTrigger}
                onChange={(e) => setWhatsAppTrigger(e.target.value)}
                disabled={isSendingWhatsApp}
                style={{ width: '100%' }}
              >
                <option value="COD_CONFIRMATION">1. COD Confirmation (Prompt customer to reply '1' to verify & tag)</option>
                <option value="ORDER_SHIPPED">2. Order Dispatched (Include Delhivery tracking link & AWB)</option>
                <option value="OUT_FOR_DELIVERY">3. Out For Delivery (Notify customer to keep cash/UPI QR ready)</option>
                <option value="NDR_ALERT">4. NDR Alert (Delivery exception notice & reschedule link)</option>
                <option value="DELIVERED">5. Order Delivered (Confirmation & exchange/support link)</option>
                <option value="CUSTOM">6. Custom Message (Send specific instruction to customer)</option>
              </select>
            </FormField>

            {whatsAppTrigger === 'CUSTOM' ? (
              <FormField label="Custom Message Text">
                <textarea
                  value={whatsAppCustomText}
                  onChange={(e) => setWhatsAppCustomText(e.target.value)}
                  placeholder="Enter custom message to send directly to customer's WhatsApp..."
                  rows={3}
                  disabled={isSendingWhatsApp}
                  style={{ width: '100%' }}
                />
              </FormField>
            ) : (
              <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '12px', fontSize: '11.5px', color: '#475569' }}>
                <strong style={{ color: '#0f172a', display: 'block', marginBottom: '4px' }}>
                  ℹ️ Template Preview
                </strong>
                {whatsAppTrigger === 'COD_CONFIRMATION' && (
                  <div>
                    "Namaste {order.customerName}! Your COD order {order.shopifyOrderName} for {formatMoney(order.totalAmount, order.currency)} has been received. Reply '1' or 'CONFIRM' to verify your delivery address."
                  </div>
                )}
                {whatsAppTrigger === 'ORDER_SHIPPED' && (
                  <div>
                    "Namaste {order.customerName}! Good news! Your order {order.shopifyOrderName} has been handed over to Delhivery Courier. Track live: https://www.delhivery.com/track/package/{order.shipment?.waybillNumber || 'AWB'}."
                  </div>
                )}
                {whatsAppTrigger === 'OUT_FOR_DELIVERY' && (
                  <div>
                    "Namaste {order.customerName}! Your parcel {order.shopifyOrderName} is Out For Delivery today. Please keep ₹{order.totalAmount} ready in Cash or UPI QR."
                  </div>
                )}
                {whatsAppTrigger === 'NDR_ALERT' && (
                  <div>
                    "Alert: We attempted to deliver your order {order.shopifyOrderName} today via Delhivery, but could not connect. Please update delivery instructions."
                  </div>
                )}
                {whatsAppTrigger === 'DELIVERED' && (
                  <div>
                    "Namaste {order.customerName}! Your package {order.shopifyOrderName} has been delivered successfully. Thank you for shopping with us!"
                  </div>
                )}
              </div>
            )}

            <div style={{ background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: '8px', padding: '10px 12px', fontSize: '11px', color: '#065f46', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Icon name="check" size={16} />
              <span>Sent via Kapso AI WhatsApp Cloud & synced with OMS Notification history.</span>
            </div>
          </div>

          <div className="modal-footer">
            <button
              type="button"
              className="modal-btn-cancel"
              disabled={isSendingWhatsApp}
              onClick={() => setShowWhatsAppModal(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button-primary"
              style={{ background: '#16a34a', borderColor: '#15803d' }}
              disabled={isSendingWhatsApp || (!order.customerPhone && whatsAppTrigger !== 'CUSTOM')}
              onClick={handleSendWhatsApp}
            >
              <Icon name="message" size={14} />
              {isSendingWhatsApp ? 'Sending via Kapso…' : 'Send WhatsApp Message'}
            </button>
          </div>
        </div>
      </div>
    )}
  </>
}

/* ─── UI UX Max Pro: 5-Stage Order Lifecycle Stepper ─────────── */
function OrderLifecycleStepper({ order }: { order: Order }) {
  const stage = useMemo(() => {
    if (order.status === 'DELIVERED') return 5
    if (order.status === 'OUT_FOR_DELIVERY' || order.status === 'IN_TRANSIT' || (order.shipment?.trackingLogs?.length ?? 0) > 1) return 4
    if (order.shipment?.waybillNumber || order.status === 'DISPATCHED') return 3
    if (order.paymentVerified || order.paymentMethod === 'PREPAID') return 2
    return 1
  }, [order])

  const steps = [
    { num: 1, title: 'Order Placed', subtitle: formatDate(order.shopifyCreatedAt || order.createdAt), icon: 'box' as const },
    {
      num: 2,
      title: 'Payment Confirmed',
      subtitle: order.paymentVerified ? 'Verified' : order.paymentMethod === 'COD' ? 'COD Pending' : 'Prepaid',
      icon: 'shield' as const,
    },
    {
      num: 3,
      title: 'Dispatched',
      subtitle: order.shipment?.waybillNumber ? `AWB ${order.shipment.waybillNumber.slice(-6)}` : 'Pending dispatch',
      icon: 'package' as const,
    },
    {
      num: 4,
      title: 'In Transit',
      subtitle: order.shipment?.trackingLocation || (stage >= 4 ? 'On the way' : 'Awaiting transit'),
      icon: 'truck' as const,
    },
    {
      num: 5,
      title: 'Delivered',
      subtitle: stage === 5 ? 'Completed' : 'Pending delivery',
      icon: 'check' as const,
    },
  ]

  const fillPercent = ((stage - 1) / (steps.length - 1)) * 100

  return (
    <div className="order-stepper-card">
      <div className="order-stepper-header">
        <h3>Order Fulfillment Progress</h3>
        <span style={{ fontSize: '11px', color: '#64748b' }}>
          Stage <strong>{stage}</strong> of 5 · Current Status: <strong style={{ color: '#1e3a8a' }}>{labelize(order.status)}</strong>
        </span>
      </div>
      <div className="order-stepper-progress">
        <div className="order-stepper-track-bg" />
        <div className="order-stepper-track-fill" style={{ width: `calc(${fillPercent}% - 32px)` }} />
        {steps.map((s) => {
          const isCompleted = s.num < stage
          const isActive = s.num === stage
          return (
            <div
              key={s.num}
              className={`order-step-node ${isCompleted ? 'completed' : ''} ${isActive ? 'active' : ''}`}
            >
              <div className="order-step-circle">
                {isCompleted ? <Icon name="check" size={15} /> : <Icon name={s.icon} size={15} />}
              </div>
              <span className="order-step-title">{s.title}</span>
              <span className="order-step-subtitle">{s.subtitle}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* ─── UI UX Max Pro: Order Contents Table & Financial Breakdown ─ */
function ItemsTable({ items, currency, order, section = 'both' }: { items: OrderItem[]; currency: string; order: Order; section?: 'lines' | 'summary' | 'both' }) {
  const toast = useToast()

  const copySku = (sku: string) => {
    navigator.clipboard.writeText(sku)
    toast.toast('success', `SKU ${sku} copied!`)
  }

  if (!items.length && section === 'lines') {
    return <EmptyState title="No line items" description="This order has no item records." icon="box" />
  }

  const subtotal = items.reduce((sum, item) => sum + (Number(item.price) || 0) * (Number(item.quantity) || 1), 0)
  const shippingFee = Number(order.totalShipping) || 0
  const grandTotal = Number(order.totalAmount) || (subtotal + shippingFee)
  const discount = Math.max(0, (subtotal + shippingFee) - grandTotal)
  const estimatedTax = Math.round((grandTotal * 0.18 / 1.18) * 100) / 100
  const itemCount = items.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0)
  const collected = order.financialStatus === 'refunded'
    ? 0
    : order.financialStatus === 'paid' || order.financialStatus === 'partially_paid' || (order.paymentMethod !== 'COD' && order.paymentMethod !== null)
      ? grandTotal
      : 0

  const lines = (
    <div className="shopify-lines">
      {items.map((item) => (
        <div className="shopify-line" key={item.id}>
          {item.imageUrl ? (
            <img src={item.imageUrl} alt="" />
          ) : (
            <div className="product-thumb-fallback"><Icon name="box" size={16} /></div>
          )}
          <div>
            <div className="shopify-line-title">{item.title}</div>
            {item.variantTitle ? <span className="shopify-line-sku">{item.variantTitle}</span> : null}
            {item.sku ? (
              <button type="button" className="shopify-line-sku" onClick={() => copySku(item.sku || '')} title="Copy SKU">
                {item.sku}
              </button>
            ) : null}
          </div>
          <span className="shopify-line-qty">{item.quantity}</span>
          <div className="shopify-line-money">
            <strong>{formatMoney(item.price * item.quantity, currency)}</strong>
            {item.quantity > 1 ? <small>{formatMoney(item.price, currency)} each</small> : null}
          </div>
        </div>
      ))}
    </div>
  )

  const summary = (
    <div className="shopify-paid">
      <div className="shopify-paid-row"><span>Subtotal</span><span>{itemCount || items.length} item{(itemCount || items.length) === 1 ? '' : 's'}</span><strong>{formatMoney(subtotal, currency)}</strong></div>
      <div className="shopify-paid-row"><span>Shipping</span><span>{order.shipment?.courier || 'Standard'}</span><strong>{shippingFee === 0 ? 'Free' : formatMoney(shippingFee, currency)}</strong></div>
      {discount > 0 && (
        <div className="shopify-paid-row"><span>Discount</span><span /><strong>-{formatMoney(discount, currency)}</strong></div>
      )}
      <div className="shopify-paid-row"><span>Tax included</span><span>GST</span><strong>{formatMoney(estimatedTax, currency)}</strong></div>
      <div className="shopify-paid-row is-total"><span>Total</span><span /><strong>{formatMoney(grandTotal, currency)}</strong></div>
      <div className="shopify-paid-row"><span>Paid</span><span>{order.financialStatus === 'refunded' ? 'Refunded' : order.paymentMethod === 'COD' && collected === 0 ? 'Due on delivery' : ''}</span><strong>{formatMoney(collected, currency)}</strong></div>
    </div>
  )

  if (section === 'lines') return lines
  if (section === 'summary') return summary
  return <>{lines}{summary}</>
}

function DetailRow({
  label,
  value,
  strong = false,
  mono = false,
  copyable = false,
  onCopy,
}: {
  label: string
  value: React.ReactNode
  strong?: boolean
  mono?: boolean
  copyable?: boolean
  onCopy?: (val: string) => void
}) {
  return (
    <div className="detail-row">
      <span>{label}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <strong className={`${strong ? 'detail-value-strong' : ''} ${mono ? 'mono' : ''}`}>{value ?? '—'}</strong>
        {copyable && typeof value === 'string' && (
          <button
            onClick={() => onCopy && onCopy(value)}
            style={{ background: 'none', border: 0, padding: 0, color: '#94a3b8', cursor: 'pointer', display: 'grid', placeItems: 'center' }}
            title="Copy value"
          >
            <Icon name="copy" size={13} />
          </button>
        )}
      </div>
    </div>
  )
}

const RETURN_REASONS = ['Damaged product', 'Quality is not good', 'Changed mind', 'Size mismatch', 'Wrong item', 'Others']

function ReturnForm({
  order,
  items,
  selected,
  setSelected,
  reason,
  setReason,
  returnTracking,
  setReturnTracking,
  carrier,
  setCarrier,
  loading,
  onSubmit,
}: {
  order: Order
  items: OrderItem[]
  selected: Record<number, number>
  setSelected: (value: Record<number, number>) => void
  reason: string
  setReason: (value: string) => void
  returnTracking: string
  setReturnTracking: (value: string) => void
  carrier: string
  setCarrier: (value: string) => void
  loading: boolean
  onSubmit: () => void
}) {
  const [linkExisting, setLinkExisting] = useState(false)
  const active = (order.returns || []).find((row) => !['REFUNDED', 'CANCELLED'].includes(row.returnStatus))
  const tracking = order.shipment?.trackingStatus || ''
  const delivered =
    order.status === 'DELIVERED' ||
    Boolean(order.deliveredAt) ||
    order.shipment?.status === 'DELIVERED' ||
    (/delivered/i.test(tracking) && !/undeliver/i.test(tracking))
  const forwardAwb = order.shipment?.waybillNumber

  return (
    <Panel className="return-form-panel" id="return-panel">
      <PanelHeading eyebrow="Reverse logistics" title="Create reverse pickup" />
      {active ? (
        <ActiveReturnCard record={active} />
      ) : (
        <>
          <p className="panel-description">
            This opens a Shopify return on the order and books the reverse pickup the way Delhivery ONE “Initiate Return” does: same sale order id, the delivered forward AWB as the reference, and the return location set to the Surat warehouse. Delhivery assigns the reverse waybill. Pickup and transit update from carrier scans.
          </p>

          {forwardAwb ? (
            <div className="reverse-forward-link">
              <span>Forward AWB</span>
              <strong className="mono">{forwardAwb}</strong>
              <span className={delivered ? 'is-ready' : 'is-wait'}>{delivered ? 'Delivered' : order.status.replace(/_/g, ' ').toLowerCase()}</span>
            </div>
          ) : (
            <p className="field-hint">This order has no forward Delhivery AWB yet, so a reverse pickup cannot be tied to it.</p>
          )}

          {items.length ? (
            <div className="return-items">
              {items.map((item) => {
                const quantity = selected[item.id] ?? 0
                return (
                  <div className={`return-item ${quantity ? 'selected' : ''}`} key={item.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={quantity > 0}
                        onChange={(event) => setSelected({ ...selected, [item.id]: event.target.checked ? 1 : 0 })}
                      />
                      <span>
                        {item.title}
                        <small>
                          <span className="sku-badge">{item.sku || 'No SKU'}</span>
                          {' · '}{item.quantity} available
                        </small>
                      </span>
                    </label>
                    {quantity > 0 && (
                      <input
                        className="quantity-input"
                        aria-label={`Quantity for ${item.title}`}
                        type="number"
                        min={1}
                        max={item.quantity}
                        value={quantity}
                        onChange={(event) =>
                          setSelected({
                            ...selected,
                            [item.id]: Math.max(1, Math.min(item.quantity, Number(event.target.value) || 1)),
                          })
                        }
                      />
                    )}
                  </div>
                )
              })}
            </div>
          ) : (
            <p className="field-hint">No returnable items on this order.</p>
          )}

          <div className="reason-chips" role="group" aria-label="Return reason">
            {RETURN_REASONS.map((preset) => (
              <button
                type="button"
                key={preset}
                className={reason === preset ? 'is-selected' : ''}
                onClick={() => setReason(preset)}
              >
                {preset}
              </button>
            ))}
          </div>

          <FormField label="Return reason">
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="What should the pickup executive know?"
              rows={2}
            />
          </FormField>

          <ol className="reverse-steps">
            <li>Delhivery manifests a reverse AWB against {forwardAwb || 'this order'}.</li>
            <li>The customer pickup is scheduled by Delhivery. A warehouse pickup request is not used for returns.</li>
            <li>Scans move the return the same way a forward shipment moves. Refund still waits for warehouse QC.</li>
          </ol>

          <button type="button" className="reverse-link-toggle" onClick={() => {
            setLinkExisting((value) => !value)
            if (linkExisting) {
              setCarrier('Delhivery')
              setReturnTracking('')
            } else {
              setCarrier('Other')
            }
          }}>
            {linkExisting ? 'Use automatic Delhivery pickup' : 'Link an AWB that already exists'}
          </button>

          {linkExisting ? (
            <div className="reverse-manual">
              <FormField label="Carrier">
                <select value={carrier} onChange={(event) => setCarrier(event.target.value)}>
                  <option value="Delhivery">Delhivery</option>
                  <option value="Other">Other carrier</option>
                </select>
              </FormField>
              <FormField label="Existing return AWB">
                <input
                  value={returnTracking}
                  onChange={(event) => setReturnTracking(event.target.value)}
                  placeholder="Numeric Delhivery AWB"
                />
              </FormField>
            </div>
          ) : null}

          <Button className="button-primary full-button" loading={loading} disabled={!items.length || !delivered} onClick={onSubmit}>
            <Icon name="return" size={16} />
            Create reverse pickup
          </Button>
          {!delivered ? <p className="field-hint">Available once the forward shipment is delivered.</p> : null}
        </>
      )}
    </Panel>
  )
}

function ActiveReturnCard({ record }: { record: ReturnRecord }) {
  const queryClient = useQueryClient()
  const toast = useToast()
  const [reason, setReason] = useState(record.returnReason || 'Others')
  const [saving, setSaving] = useState(false)
  const editable = ['INITIATED', 'PICKUP_SCHEDULED'].includes(record.returnStatus)

  const saveReason = async () => {
    setSaving(true)
    try {
      const res = await api.patch(`/api/returns/${record.id}/reason`, { returnReason: reason })
      toast.toast(
        'success',
        res.data.delhiveryUpdated
          ? `Reason updated on Delhivery as ${res.data.delhiveryReason}.`
          : `Reason saved. ${res.data.delhiveryError || 'Delhivery keeps the reason from when the reverse pickup was created.'}`
      )
      await queryClient.invalidateQueries({ queryKey: ['order', String(record.orderId)] })
      await queryClient.invalidateQueries({ queryKey: ['returns'] })
    } catch (error) {
      toast.toast('error', apiError(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="active-return-card">
      <div>
        <span className="eyebrow">Reverse in progress</span>
        <strong className="mono">{record.returnWaybillNumber || 'Waybill pending'}</strong>
        <p>
          {record.pickupAutomatic
            ? 'Customer pickup was scheduled by Delhivery. Status follows carrier scans.'
            : 'This return is linked to an existing waybill.'}
          {record.forwardWaybill ? ` Forward AWB ${record.forwardWaybill}.` : ''}
          {record.shopifyReturnId ? ` Shopify return ${record.shopifyReturnId.split('/').pop()}.` : ''}
        </p>
        <p className="cell-muted">Reason: {record.returnReason}</p>
        {editable ? (
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '8px' }}>
            <select value={reason} onChange={(event) => setReason(event.target.value)} aria-label="Update return reason">
              {(RETURN_REASONS.includes(record.returnReason) ? RETURN_REASONS : [record.returnReason, ...RETURN_REASONS]).map((preset) => (
                <option key={preset} value={preset}>{preset}</option>
              ))}
            </select>
            <button type="button" className="btn-pack" disabled={saving || reason === record.returnReason} onClick={saveReason}>
              {saving ? 'Saving…' : 'Update reason'}
            </button>
          </div>
        ) : null}
      </div>
      <StatusBadge status={record.returnStatus} />
      {record.trackingStatus ? <span className="cell-muted">{record.trackingStatus}{record.trackingLocation ? ` · ${record.trackingLocation}` : ''}</span> : null}
    </div>
  )
}
