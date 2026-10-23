import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from 'react-router-dom'
import {
  api,
  apiError,
  getOrder,
  getPayment,
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
  getOrderShippingOptions,
} from '../api'
import { ORDER_TABS, carrierTrackingUrl, formatDate, formatMoney, labelize, isVelocityCourier } from '../lib'
import { classifyOrderTab, isCodConfirmed, isPrepaidOrder } from '../../../src/modules/orders/order-tabs'
import { Button, ButtonGroup, CopyableBadge, EmptyState, ErrorBox, FormField, Icon, InfoCard, LoadingState, PageIntro, Panel, PanelHeading, StatCard, StatusBadge, useDocumentTitle, useToast } from '../components/UI'
import { OrderNextStep } from '../components/OrderNextStep'
import { OrderMoneyCard } from '../components/OrderMoneyCard'
import { OrderFinancialSummary } from '../components/OrderFinancialSummary'
import { OrderTrackingHistory } from '../components/OrderTrackingHistory'
import { OrderActivityFeed } from '../components/OrderActivityFeed'
import { OrderPaymentEvidence } from '../components/OrderPaymentEvidence'
import { OrderPickupStatus } from '../components/OrderPickupStatus'
import { ORDER_SECTIONS, contactPhone, hasCustomerDelivery, type OrderSection } from '../order-workspace'
import type { AccountTrailEvent, Order, OrderItem, ReturnRecord } from '../types'
import './OrderDetail.css'

export function OrderDetail() {
  useDocumentTitle('Order detail')
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const toast = useToast()
  const queryClient = useQueryClient()
  const orderQuery = useQuery({ queryKey: ['order', id], queryFn: () => getOrder(id), enabled: Boolean(id), retry: false })
  const paymentQuery = useQuery({ queryKey: ['payment', id], queryFn: () => getPayment(id), enabled: Boolean(id), retry: false })
  const [selected, setSelected] = useState<Record<number, number>>({})
  const [reason, setReason] = useState('')
  const [returnTracking, setReturnTracking] = useState('')
  const [carrier, setCarrier] = useState('Delhivery')
  const [section, setSection] = useState<OrderSection>(() => window.location.hash === '#return-panel' ? 'returns' : 'overview')
  useEffect(() => {
    if (orderQuery.dataUpdatedAt) queryClient.invalidateQueries({ queryKey: ['order-activity', id] })
  }, [orderQuery.dataUpdatedAt, id, queryClient])
  const sectionRefs = useRef<Array<HTMLButtonElement | null>>([])

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

  // KwikEngage WhatsApp Modal State
  const [moreOpen, setMoreOpen] = useState(false)
  const [morePos, setMorePos] = useState<{ top: number; left: number } | null>(null)
  const moreRef = useRef<HTMLDivElement>(null)
  const moreButtonRef = useRef<HTMLButtonElement>(null)
  const [showWhatsAppModal, setShowWhatsAppModal] = useState(false)
  const [whatsAppTrigger, setWhatsAppTrigger] = useState('COD_CONFIRMATION')
  const [whatsAppCustomText, setWhatsAppCustomText] = useState('')
  const [isSendingWhatsApp, setIsSendingWhatsApp] = useState(false)

  // Courier partner selection state
  const [showCarrierModal, setShowCarrierModal] = useState(false)
  const [shippingOptions, setShippingOptions] = useState<Array<{
    courier: string
    carrierId?: string
    carrierName: string
    serviceable: boolean
    rate: number
    freightCharge?: number
    codCharge?: number
    estimatedDays?: number
    description: string
    isRecommended?: boolean
  }>>([])
  const [loadingShippingOptions, setLoadingShippingOptions] = useState(false)
  const [selectedOptionIndex, setSelectedOptionIndex] = useState<number>(0)

  // Switch courier partner state
  const [showSwitchCourierModal, setShowSwitchCourierModal] = useState(false)
  const [switchCourierName, setSwitchCourierName] = useState('Velocity')
  const [switchWaybill, setSwitchWaybill] = useState('')

  const clearManifestReview = useMutation({
    mutationFn: () => api.post(`/api/orders/${id}/clear-manifest-review`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['order', id] })
      await queryClient.invalidateQueries({ queryKey: ['orders'] })
      toast.toast('success', 'Manifest review flag cleared.')
    },
    onError: (error) => toast.toast('error', apiError(error)),
  })

  const updateCourierMutation = useMutation({
    mutationFn: (data: { courier: string; waybillNumber?: string }) =>
      api.post(`/api/orders/${id}/update-courier`, data),
    onSuccess: async (res) => {
      setShowSwitchCourierModal(false)
      await queryClient.invalidateQueries({ queryKey: ['order', id] })
      await queryClient.invalidateQueries({ queryKey: ['orders'] })
      toast.toast('success', `Courier partner updated to ${res.data.courier || 'selected courier'}.`)
    },
    onError: (error) => toast.toast('error', apiError(error)),
  })

  const order = orderQuery.data
  const refreshShopify = useMutation({
    mutationFn: () => api.post(`/api/orders/${id}/refresh-shopify`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['order', id] })
      await queryClient.invalidateQueries({ queryKey: ['orders'] })
      toast.toast('success', 'Order details refreshed from Shopify.')
    },
    onError: (error) => toast.toast('error', apiError(error)),
  })

  const action = useMutation({
    mutationFn: async (kind: 'dispatch' | 'verify' | 'label' | 'cancel' | { kind: 'dispatch'; courier?: string; velocityCarrierId?: string }) => {
      const actionKind = typeof kind === 'object' ? kind.kind : kind
      if (actionKind === 'dispatch') {
        const body = typeof kind === 'object' ? { courier: kind.courier, velocityCarrierId: kind.velocityCarrierId } : undefined
        return (await api.post(`/api/orders/${id}/dispatch`, body)).data
      }
      if (actionKind === 'verify') return (await api.post(`/api/orders/${id}/payment/verify`)).data
      if (actionKind === 'label') return (await api.get(`/api/delhivery/label/${order?.shipment?.waybillNumber}`)).data
      return (await api.post(`/api/delhivery/shipment/${order?.shipment?.waybillNumber}/cancel`)).data
    },
    onSuccess: async (data, kind) => {
      const actionKind = typeof kind === 'object' ? kind.kind : kind
      if (actionKind === 'label') {
        if (order?.id) openPrintableOrderLabel(order.id)
        toast.toast('success', 'Printable label opened. Packing-slip links expire, so this stays inside Youthnic.')
      } else if (actionKind === 'verify') {
        toast.toast(data.verified ? 'success' : 'error', data.reason ?? (data.verified ? 'Payment verified.' : 'Payment could not be verified.'))
      } else if (actionKind === 'dispatch') {
        toast.toast('success', `Order dispatched${data.waybillNumber ? ` · Waybill ${data.waybillNumber}` : ''}${data.courier ? ` via ${data.courier}` : ''}.`)
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
      toast.toast('success', data.moneyMoved === false
        ? 'Refund recorded, but no online payment was available. Pay the customer manually and record it in Payments.'
        : `Shopify refund processed successfully · ID: ${data.refundId}`)
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
    const followHash = () => setSection(window.location.hash === '#return-panel' ? 'returns' : 'overview')
    followHash()
    window.addEventListener('hashchange', followHash)
    return () => window.removeEventListener('hashchange', followHash)
  }, [id])

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (moreOpen) {
        setMoreOpen(false)
        moreButtonRef.current?.focus()
      }
      if (!isCancelling) setShowCancelModal(false)
      if (!isDeleting) setShowDeleteModal(false)
      if (!isSubmittingNdr) setShowNdrModal(false)
      if (!isSendingWhatsApp) setShowWhatsAppModal(false)
      if (!action.isPending) setShowCarrierModal(false)
      if (!updateCourierMutation.isPending) setShowSwitchCourierModal(false)
    }
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  }, [moreOpen, isCancelling, isDeleting, isSubmittingNdr, isSendingWhatsApp, action.isPending, updateCourierMutation.isPending])

  useEffect(() => {
    if (!showCancelModal && !showDeleteModal && !showNdrModal && !showWhatsAppModal && !showCarrierModal && !showSwitchCourierModal) return
    const previous = document.activeElement as HTMLElement | null
    const dialog = document.querySelector<HTMLElement>('.shopify-order-page .modal-card')
    const controls = () => Array.from(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]') || [])
    controls()[0]?.focus()
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const items = controls()
      const first = items[0]
      const last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    dialog?.addEventListener('keydown', trap)
    return () => { dialog?.removeEventListener('keydown', trap); previous?.focus() }
  }, [showCancelModal, showDeleteModal, showNdrModal, showWhatsAppModal, showCarrierModal, showSwitchCourierModal])

  useEffect(() => {
    if (!moreOpen) return
    const close = (event: MouseEvent) => {
      const target = event.target as Node
      if (!moreRef.current?.contains(target) && !moreButtonRef.current?.contains(target)) setMoreOpen(false)
    }
    const dismiss = (event: Event) => {
      if (event.type === 'scroll' && event.target instanceof Node && moreRef.current?.contains(event.target)) return
      if (event.type === 'resize') { setMoreOpen(false); return }
      const rect = moreButtonRef.current?.getBoundingClientRect()
      if (!rect || rect.bottom < 0 || rect.top > window.innerHeight) { setMoreOpen(false); return }
      setMorePos({ top: rect.bottom + 6, left: Math.max(8, rect.right - 248) })
    }
    document.addEventListener('mousedown', close)
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    return () => {
      document.removeEventListener('mousedown', close)
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
    }
  }, [moreOpen])

  const canDispatch = order && ['NEW', 'DISPATCH_PENDING'].includes(order.status) && order.supportFlag !== 'MANIFEST_REVIEW'
  if (orderQuery.isLoading) return <LoadingState label="Loading order detail…" />
  if (orderQuery.isError || !order) return <><PageIntro eyebrow="Order detail" title="Order not found" /><ErrorBox message={orderQuery.error ? apiError(orderQuery.error) : 'The requested order could not be found.'} /></>
  const payment = paymentQuery.data

  const cleanPhone = contactPhone(order.customerPhone)

  const openSection = (value: OrderSection) => {
    setSection(value)
    requestAnimationFrame(() => document.getElementById(`order-section-${value}`)?.focus())
  }
  const editShipment = () => {
    setEditPhone(order.customerPhone || '')
    setEditAddress([order.customerAddress, order.customerCity, order.customerState, order.customerPincode].filter(Boolean).join(', '))
    setShowEditDetails(true)
    openSection('shipment')
  }

  const copyAddress = () => {
    const fullAddr = [order.customerAddress, order.customerCity, `${order.customerState} ${order.customerPincode}`, order.customerCountry].filter(Boolean).join(', ')
    navigator.clipboard.writeText(fullAddr)
    toast.toast('success', 'Full customer delivery address copied to clipboard!')
  }

  const copyWaybill = (awb: string) => {
    navigator.clipboard.writeText(awb)
    toast.toast('success', `${order.shipment?.courier || 'Tracking'} AWB ${awb} copied!`)
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

  // KwikEngage WhatsApp Trigger Handler
  const handleSendWhatsApp = async () => {
    if (!order) return
    setIsSendingWhatsApp(true)
    try {
      await sendOrderWhatsAppTrigger(order.id, {
        trigger: whatsAppTrigger,
        customText: whatsAppCustomText,
      })
      toast.toast('success', `WhatsApp notification sent to ${order.customerPhone} via KwikEngage!`)
      setShowWhatsAppModal(false)
      setWhatsAppCustomText('')
      await queryClient.invalidateQueries({ queryKey: ['order', id] })
    } catch (err: any) {
      toast.toast('error', apiError(err))
    } finally {
      setIsSendingWhatsApp(false)
    }
  }

  // Carrier partner discovery and dispatch
  const handleOpenCarrierModal = async () => {
    if (!order?.id) return
    setShowCarrierModal(true)
    setLoadingShippingOptions(true)
    try {
      const res = await getOrderShippingOptions(order.id)
      let opts = res.options || []
      if (!opts.length) {
        opts = []
        if (res.delhivery) {
          opts.push({
            courier: 'Delhivery',
            carrierName: `Delhivery (${res.delhivery.shippingMode || 'Surface'})`,
            serviceable: res.delhivery.serviceable,
            rate: res.delhivery.estimatedCost || 0,
            estimatedDays: 4,
            description: res.delhivery.remark || 'Delhivery direct surface',
            isRecommended: res.recommendedCarrier === 'Delhivery',
          })
        }
        if (res.velocity?.rates?.length) {
          for (const r of res.velocity.rates) {
            opts.push({
              courier: 'Velocity',
              carrierId: r.carrierId,
              carrierName: `Velocity (${r.carrierName})`,
              serviceable: res.velocity.serviceable,
              rate: r.totalCharge || 0,
              freightCharge: r.freightCharge,
              codCharge: r.codCharge,
              estimatedDays: r.expectedDeliveryDays,
              description: r.zone ? `Zone: ${r.zone}` : 'Velocity Aggregator Partner',
              isRecommended: res.recommendedCarrier === 'Velocity',
            })
          }
        } else if (res.velocity) {
          opts.push({
            courier: 'Velocity',
            carrierName: 'Velocity (Best Available Partner)',
            serviceable: res.velocity.serviceable,
            rate: 0,
            description: res.velocity.remark || 'Velocity aggregator routing',
            isRecommended: res.recommendedCarrier === 'Velocity',
          })
        }
      }
      const normalized = opts.map((o: any) => ({
        ...o,
        carrierName: o.carrierName || o.courier,
      }))
      setShippingOptions(normalized)
      const recommendedIdx = normalized.findIndex((o: any) => o.isRecommended && o.serviceable)
      const firstServiceable = normalized.findIndex((o: any) => o.serviceable)
      setSelectedOptionIndex(recommendedIdx >= 0 ? recommendedIdx : (firstServiceable >= 0 ? firstServiceable : 0))
    } catch (err: any) {
      toast.toast('error', apiError(err))
    } finally {
      setLoadingShippingOptions(false)
    }
  }

  const handleDispatchSelectedCarrier = () => {
    const selected = shippingOptions[selectedOptionIndex]
    if (!selected) return
    setShowCarrierModal(false)
    action.mutate({
      kind: 'dispatch',
      courier: selected.courier,
      velocityCarrierId: selected.carrierId,
    })
  }

  // EPOD viewer is used twice on this page (shipment actions + verified
  // banner); one shared loader keeps the empty/error toasts identical.
  const openEpod = async () => {
    if (!order) return
    try {
      const res = await api.get(`/api/orders/${order.id}/epod`)
      if (res.data?.epodUrl) {
        window.open(res.data.epodUrl, '_blank')
      } else {
        toast.toast('success', res.data?.message || 'EPOD is being generated by Delhivery')
      }
    } catch (err: any) {
      toast.toast('error', err.response?.data?.error || 'EPOD not available yet')
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
    (!order.financialStatus && Boolean(order.paymentVerified))
  const paymentPill =
    order.financialStatus === 'refunded'
      ? { label: 'Refunded', tone: 'shopify-pill-neutral' }
      : order.financialStatus === 'partially_refunded'
        ? { label: 'Partially refunded', tone: 'shopify-pill-pending' }
        : order.financialStatus === 'partially_paid'
          ? { label: 'Partially paid', tone: 'shopify-pill-pending' }
        : paid
          ? { label: 'Paid', tone: 'shopify-pill-neutral' }
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
  // Active return detection for reverse transit trail
  const returnTagMatch = (order.tags || '').match(/Return[-_]?AWB:?\s*([A-Za-z0-9]+)/i)
  const tagReturnAwb = returnTagMatch ? returnTagMatch[1] : null
  const activeReturnRecord = (order.returns || []).find((r: any) => !['CANCELLED'].includes(r.returnStatus))
  const returnAwb = activeReturnRecord?.returnWaybillNumber || tagReturnAwb || null
  const isReturnOrder = Boolean(
    returnAwb ||
    order.status?.toUpperCase().includes('RETURN') ||
    (order.tags || '').toLowerCase().includes('return')
  )

  // The Orders tab this order sits in, e.g. "Ready to Dispatch" or "Payment Received".
  const stageTab = ORDER_TABS.find((tab) => tab.key === classifyOrderTab(order))
  const canRefund = order.financialStatus !== 'refunded' && order.status !== 'CANCELLED'
  const itemCount = (order.items || []).reduce((sum, item) => sum + item.quantity, 0)
  const openMore = () => {
    if (moreOpen) {
      setMoreOpen(false)
      return
    }
    const rect = moreButtonRef.current?.getBoundingClientRect()
    if (!rect) return
    setMorePos({ top: rect.bottom + 6, left: Math.max(8, rect.right - 248) })
    setMoreOpen(true)
    requestAnimationFrame(() => moreRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true }))
  }
  const closeMore = () => setMoreOpen(false)

  return <div className="shopify-order-page order-workspace">
    <div className="shopify-order-top">
      <button type="button" className="shopify-back" onClick={() => navigate('/orders')}>
        <Icon name="arrow" size={16} />
        Orders
      </button>
      <div className="shopify-order-actions">
        <button type="button" className="shopify-btn" disabled={refreshShopify.isPending} onClick={() => refreshShopify.mutate()}>
          <Icon name="refresh" size={14} />
          {refreshShopify.isPending ? 'Refreshing…' : 'Refresh from Shopify'}
        </button>
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
            <div className="shopify-more-menu" role="menu" aria-label="Order actions" style={{ top: morePos.top, left: morePos.left }} onKeyDown={(event) => {
              const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)'))
              const index = controls.indexOf(document.activeElement as HTMLElement)
              if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                event.preventDefault()
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + controls.length) % controls.length
                controls[next]?.focus()
              }
            }}>
              <div className="shopify-more-label">Documents</div>
              <button type="button" role="menuitem" disabled={!hasWaybill || isDownloadingLabel} onClick={() => { closeMore(); handleDownloadLabel() }}>Download label</button>
              <button type="button" role="menuitem" disabled={!hasWaybill} onClick={() => { closeMore(); openPrintableOrderLabel(order.id) }}>Print label</button>
              <button type="button" role="menuitem" disabled={!hasWaybill || isDownloadingLabelAndInvoice} onClick={() => { closeMore(); handleDownloadLabelAndInvoice() }}>Download label + invoice</button>
              <button type="button" role="menuitem" disabled={!hasWaybill} onClick={() => { closeMore(); openPrintableOrderLabelAndInvoice(order.id) }}>Print label + invoice</button>
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
              <button type="button" role="menuitem" onClick={() => { closeMore(); setSwitchCourierName(order.shipment?.courier || 'Velocity'); setSwitchWaybill(order.shipment?.waybillNumber || ''); setShowSwitchCourierModal(true) }}>Switch courier partner</button>
              {order.supportFlag === 'MANIFEST_REVIEW' && (
                <button type="button" role="menuitem" disabled={clearManifestReview.isPending} onClick={() => { closeMore(); clearManifestReview.mutate() }}>Clear manifest review</button>
              )}
              {!hasWaybill && (
                <button type="button" role="menuitem" disabled={isFetchingExternalAwb} onClick={() => { closeMore(); handleFetchExternalFulfillment() }}>Fetch Delhivery AWB</button>
              )}
              {hasWaybill && !['DELIVERED', 'RTO_DELIVERED', 'CANCELLED'].includes(order.shipment?.status || '') && (
                <button type="button" role="menuitem" onClick={() => { closeMore(); editShipment() }}>Edit phone / address</button>
              )}
              {order.status === 'DELIVERED' && (
                <button type="button" role="menuitem" onClick={() => { closeMore(); openSection('returns') }}>Create reverse pickup</button>
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
        aria-label="Copy order name"
        onClick={() => {
          navigator.clipboard.writeText(order.shopifyOrderName)
          toast.toast('success', `Order name ${order.shopifyOrderName} copied!`)
        }}
      >
        <Icon name="copy" size={13} />
      </button>
      <span className="shopify-pill-cluster">
        <span className={`shopify-pill ${paymentPill.tone}`}>{paymentPill.label}</span>
        <span className={`shopify-pill ${fulfillmentPill.tone}`}>{fulfillmentPill.label}</span>
        <span className="shopify-order-stage" title={stageTab?.hint}>{stageTab?.label || labelize(order.status)}</span>
        {order.hasUrgentSupport && (
          <button type="button" className="shopify-pill shopify-pill-alert" onClick={() => navigate(`/support?search=${order.shopifyOrderName}`)}>
            Support
          </button>
        )}
      </span>
    </div>
    <div className="shopify-order-meta">
      <span>{formatDate(order.shopifyCreatedAt || order.createdAt)}</span>
      <span className="meta-sep" aria-hidden="true">·</span>
      <span>via {order.salesChannel || 'Online Store'}</span>
      {order.customerCity ? (
        <>
          <span className="meta-sep" aria-hidden="true">·</span>
          <span>{order.customerCity}, {order.customerState}</span>
        </>
      ) : ''}
    </div>
    <OrderNextStep
      order={order}
      isPrepaid={isPrepaid}
      isCodConfirmed={isCodConf}
      isDispatchNeeded={isDispatchNeeded}
      canDispatch={Boolean(canDispatch)}
      dispatching={action.isPending && (action.variables === 'dispatch' || (typeof action.variables === 'object' && action.variables.kind === 'dispatch'))}
      confirmingCod={isConfirmingCod}
      refundingRto={isRefundingRto}
      onDispatch={() => action.mutate('dispatch')}
      onChooseCarrier={handleOpenCarrierModal}
      onConfirmCod={handleConfirmCod}
      onPrintLabel={() => openPrintableOrderLabel(order.id)}
      onResolveNdr={() => setShowNdrModal(true)}
      onRtoRefund={handleProcessRtoRefund}
      onClearManifestReview={() => clearManifestReview.mutate()}
      clearingManifestReview={clearManifestReview.isPending}
    />

    <div className="order-section-nav" role="tablist" aria-label="Order sections">
      {ORDER_SECTIONS.map((tab, index) => (
        <button type="button" role="tab" key={tab.key} id={`order-tab-${tab.key}`} aria-label={tab.label} aria-controls={`order-section-${tab.key}`}
          aria-selected={section === tab.key} tabIndex={section === tab.key ? 0 : -1}
          ref={(element) => { sectionRefs.current[index] = element }}
          onClick={() => setSection(tab.key)} onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
            event.preventDefault()
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? ORDER_SECTIONS.length - 1
              : (index + (event.key === 'ArrowRight' ? 1 : -1) + ORDER_SECTIONS.length) % ORDER_SECTIONS.length
            setSection(ORDER_SECTIONS[next].key)
            sectionRefs.current[next]?.focus()
          }}>{tab.label}
            {tab.key === 'overview' && itemCount ? <span className="order-tab-count">{itemCount}</span> : null}
            {tab.key === 'returns' && order.returns?.length ? <span className="order-tab-count">{order.returns.length}</span> : null}
          </button>
      ))}
    </div>
    <div className="detail-grid">
      <div className="detail-main">
        <section className="order-section" id="order-section-overview" role="tabpanel" aria-labelledby="order-tab-overview" tabIndex={-1} hidden={section !== 'overview'}>
        <Panel className="shopify-card" style={{ padding: 0 }}>
          <div className="shopify-card-head">
            <h2>Order items <span className="order-item-count">{itemCount}</span></h2>
            <span className={`shopify-pill ${fulfillmentPill.tone}`}>{fulfillmentPill.label}</span>
          </div>
          <div className="shopify-ship-line">
            {order.shipment?.courier || (hasWaybill ? 'Standard Shipping' : (order.shippingTitle || 'Shipping'))}
            {hasWaybill ? ` · AWB ${order.shipment?.waybillNumber}` : ' · Not yet fulfilled'}
          </div>
          <ItemsTable items={order.items ?? []} currency={order.currency} order={order} section="lines" />
        </Panel>
        <Panel className="shopify-card" style={{ padding: 0 }}>
          <div className="shopify-card-head">
            <h2>Payment summary</h2>
            <span className={`shopify-pill ${paymentPill.tone}`}>{paymentPill.label}</span>
          </div>
          <ItemsTable items={order.items ?? []} currency={order.currency} order={order} section="summary" />
        </Panel>
        {order.shipment?.waybillNumber && <Panel className="order-shipment-preview">
          <PanelHeading title="Shipment" action={<button type="button" className="order-text-action" onClick={() => openSection('shipment')}>Manage shipment <Icon name="arrow" size={14} /></button>} />
          <div className="order-preview-facts">
            <div><span>Tracking number</span><CopyableBadge text={order.shipment.waybillNumber} monospace /></div>
            <div><span>Carrier status</span><strong>{order.shipment.trackingStatus || labelize(order.shipment.status)}</strong></div>
            <div><span>Last location</span><strong>{order.shipment.trackingLocation || 'Awaiting carrier scan'}</strong></div>
          </div>
        </Panel>}
        <Panel className="order-activity-panel">
          <PanelHeading title="Recent carrier activity" />
          <OrderTrackingHistory logs={order.shipment?.trackingLogs} />
        </Panel>
        <OrderPaymentEvidence order={order} />
        <OrderActivityFeed orderId={order.id} currency={order.currency} />
        </section>


        <section className="order-section" id="order-section-payments" role="tabpanel" aria-labelledby="order-tab-payments" tabIndex={-1} hidden={section !== 'payments'}>
        <OrderMoneyCard
          order={order}
          onChanged={() => {
            queryClient.invalidateQueries({ queryKey: ['order', id] })
            queryClient.invalidateQueries({ queryKey: ['orders'] })
          }}
        />
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
                  <div style={{ background: 'var(--line-subtle)', border: '1px solid var(--line)', borderRadius: '10px', padding: '14px', marginBottom: '14px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px', flexWrap: 'wrap', gap: '6px' }}>
                      <span style={{ fontSize: '11px', fontWeight: 800, color: 'var(--ink)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                        Payment Routing & Partner Settlement
                      </span>
                      <span className={`verified-badge ${order.paymentVerified ? 'verified' : 'unverified'}`}>
                        {order.paymentVerified ? 'Captured & Verified' : 'Verification Pending'}
                      </span>
                    </div>

                    {/* Flow Banner */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: '8px', padding: '10px 14px', marginBottom: '12px', flexWrap: 'wrap' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <img src="/logos/gokwik.png" alt="GoKwik" style={{ height: '20px', objectFit: 'contain' }} />
                        <div>
                          <div style={{ fontSize: '11.5px', fontWeight: 700, color: '#034694' }}>GoKwik Checkout</div>
                          <div style={{ fontSize: '9.5px', color: 'var(--muted)' }}>Order & 1-Click Aggregator</div>
                        </div>
                      </div>
                      <span style={{ color: '#94a3b8', fontSize: '13px', fontWeight: 700 }} aria-hidden="true">→</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <img src="/logos/easebuzz.png" alt="Easebuzz" style={{ height: '18px', objectFit: 'contain' }} />
                        <div>
                          <div style={{ fontSize: '11.5px', fontWeight: 700, color: 'var(--ink)' }}>
                            {order.paymentProvider || 'Easebuzz'}
                          </div>
                          <div style={{ fontSize: '9.5px', color: '#059669', fontWeight: 600 }}>Acquiring Payment Partner</div>
                        </div>
                      </div>
                    </div>

                    {/* IDs Grid */}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '8px' }}>
                      {order.paymentProviderPaymentId && (
                        <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: '6px', padding: '7px 9px' }}>
                          <span className="detail-label" style={{ fontSize: '10px', color: 'var(--muted)' }}>Easebuzz Payment ID</span>
                          <div
                            className="waybill-chip"
                            onClick={() => {
                              navigator.clipboard.writeText(order.paymentProviderPaymentId || '')
                              toast.toast('success', 'Easebuzz Payment ID copied!')
                            }}
                            style={{ marginTop: '2px', cursor: 'pointer' }}
                            title="Click to copy Easebuzz ID"
                          >
                            <span className="mono" style={{ fontSize: '11px', fontWeight: 700, color: 'var(--ink)' }}>
                              {order.paymentProviderPaymentId}
                            </span>
                            <Icon name="copy" size={11} />
                          </div>
                        </div>
                      )}
                      {order.gokwikPaymentId && (
                        <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: '6px', padding: '7px 9px' }}>
                          <span className="detail-label" style={{ fontSize: '10px', color: 'var(--muted)' }}>GoKwik Payment ID</span>
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
                        <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: '6px', padding: '7px 9px' }}>
                          <span className="detail-label" style={{ fontSize: '10px', color: 'var(--muted)' }}>Customer checkout reference</span>
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
                        <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: '6px', padding: '7px 9px' }}>
                          <span className="detail-label" style={{ fontSize: '10px', color: 'var(--muted)' }}>Authorization Key</span>
                          <div
                            className="waybill-chip"
                            onClick={() => {
                              navigator.clipboard.writeText(order.paymentAuthorizationKey || '')
                              toast.toast('success', 'Auth Key copied!')
                            }}
                            style={{ marginTop: '2px', cursor: 'pointer' }}
                            title="Click to copy Auth Key"
                          >
                            <span className="mono" style={{ fontSize: '11px', fontWeight: 700, color: 'var(--ink-secondary)' }}>
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
                        <span style={{ fontWeight: 600, color: 'var(--ink)' }}>{order.paymentProvider || 'Easebuzz'}</span>
                      </div>
                    ) : (order.paymentGateway || '').toLowerCase().includes('phonepe') ? (
                      <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                        <img src="/logos/phonepe.png" alt="PhonePe" style={{ height: '14px', objectFit: 'contain' }} />
                        <span>PhonePe Payment Gateway</span>
                      </div>
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
                        <span style={{ fontWeight: 700, color: 'var(--ink)' }}>{order.paymentProvider}</span>
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
                {canRefund && (
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
                    <span style={{ fontSize: '10px', color: 'var(--muted)', textAlign: 'center' }}>
                      Processes refund directly via Shopify API. Shopify automatically routes the refund back through {order.paymentAggregator || 'GoKwik'}{order.paymentProvider ? ` / ${order.paymentProvider}` : ''} to the customer.
                    </span>
                  </div>
                )}
              </div>
            )}
          </Panel>
        <AccountTrailPanel orderId={order.id} returns={order.returns ?? []} defaultAmount={order.totalAmount} currency={order.currency} />
        </section>

        {/* ─── Live Delhivery Tracking & Parcel Journey ───────────────────────── */}
        <section className="order-section" id="order-section-shipment" role="tabpanel" aria-labelledby="order-tab-shipment" tabIndex={-1} hidden={section !== 'shipment'}>
        <Panel id="shipment-panel">
          <PanelHeading
            title={
              isVelocityCourier(order.shipment?.courier, order.shipment?.waybillNumber) ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '22px', height: '22px', borderRadius: '5px', background: '#7c3aed', color: '#fff', fontSize: '12px', fontWeight: 900 }}>⚡</span>
                  <span style={{ fontWeight: 700 }}>{order.shipment?.courier || 'Velocity'} Aggregator Logistics</span>
                </span>
              ) : order.shipment?.courier?.toLowerCase() === 'delhivery' ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
                  <img src="/logos/delhivery.png" alt="Delhivery" style={{ height: '14px', objectFit: 'contain' }} />
                  <span>Shipment details</span>
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
                    title={isVelocityCourier(order.shipment?.courier, order.shipment?.waybillNumber) ? "Poll Velocity Aggregator in real-time for live tracking, freight debits & COD remittance" : "Poll Delhivery API in real-time for latest parcel tracking events"}
                    style={{ height: '28px', fontSize: '11px', display: 'inline-flex', alignItems: 'center', gap: '5px' }}
                  >
                    <Icon name="refresh" size={12} />
                    <span>{isSyncingTracking ? 'Syncing Tracking…' : isVelocityCourier(order.shipment?.courier, order.shipment?.waybillNumber) ? 'Sync Velocity Details' : 'Refresh Live Tracking'}</span>
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
                    <span>{isFetchingExternalAwb ? 'Checking…' : 'Get External AWB'}</span>
                  </Button>
                )}
                {order.shipment?.status && <StatusBadge status={order.shipment.status} />}
              </div>
            }
          />

          {order.shipment ? (
            <>
              {/* 21st.dev Design Pro: Summary Telemetry Metric Cards */}
              <div className="order-shipment-facts">
                <StatCard
                  title={isReturnOrder && returnAwb ? 'Return Courier AWB' : `${order.shipment.courier || 'Carrier'} AWB`}
                  value={
                    isReturnOrder && returnAwb ? (
                      <CopyableBadge text={returnAwb} monospace={true} />
                    ) : order.shipment.waybillNumber ? (
                      <CopyableBadge text={order.shipment.waybillNumber} monospace={true} />
                    ) : (
                      <span style={{ fontSize: '13px', color: '#94a3b8' }}>Not assigned</span>
                    )
                  }
                  icon={isReturnOrder ? 'refresh' : 'tag'}
                  accentColor={isReturnOrder ? '#7c3aed' : '#2563eb'}
                  subtext={
                    isReturnOrder && returnAwb && order.shipment.waybillNumber
                      ? `Forward AWB: ${order.shipment.waybillNumber} (Delivered)`
                      : (order.shipment.courier || 'Delhivery Express')
                  }
                />

                <StatCard
                  title={isReturnOrder ? 'Reverse Tracking Status' : 'Tracking Status'}
                  value={
                    <span style={{ fontSize: '14px', fontWeight: 700, color: 'var(--ink)' }}>
                      {isReturnOrder
                        ? (order.shipment.trackingStatus ?? labelize(order.status))
                        : (order.shipment.trackingStatus ?? (order.shipment?.status || order.status ? labelize(order.shipment?.status ?? order.status) : 'Awaiting carrier scan'))}
                    </span>
                  }
                  icon="truck"
                  accentColor={isNdrOrRtoShipment ? '#dc2626' : isReturnOrder ? '#7c3aed' : '#059669'}
                  subtext={order.shipment.status ? `Status: ${order.shipment.status}` : undefined}
                />

                <StatCard
                  title="Current Location"
                  value={<span>{order.shipment.trackingLocation ?? 'Awaiting carrier scan'}</span>}
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

                <StatCard
                  title="Shipping Fee Ledger"
                  value={
                    <span
                      style={{
                        fontSize: '16px',
                        fontWeight: 800,
                        color:
                          order.shipment.shippingCostSource === 'ACTUAL'
                            ? (order.shipment.netBilledCost ?? 0) === 0
                              ? '#059669'
                              : '#1e293b'
                            : 'var(--muted)',
                      }}
                    >
                      {formatMoney(
                        order.shipment.shippingCostSource === 'ACTUAL'
                          ? (order.shipment.netBilledCost ?? order.shipment.forwardCharge ?? 0)
                          : (order.shipment.forwardCharge ?? 0),
                        order.currency
                      )}
                    </span>
                  }
                  icon="dollar"
                  accentColor={
                    order.shipment.shippingCostSource === 'ACTUAL'
                      ? (order.shipment.netBilledCost ?? 0) === 0
                        ? '#10b981'
                        : '#2563eb'
                      : '#94a3b8'
                  }
                  subtext={
                    order.shipment.shippingCostSource === 'ACTUAL'
                      ? order.shipment.billingStatus === 'REFUNDED' || (order.shipment.netBilledCost ?? 0) === 0
                        ? `Refunded: +${formatMoney(order.shipment.totalCredited ?? 0)} · Full freight refund`
                        : `Debited: ${formatMoney(order.shipment.totalDebited ?? 0)} · Wallet reconciled`
                      : 'Estimated rate card cost · Wallet report pending'
                  }
                />
              </div>

              {/* Velocity Aggregator Telemetry: Multi-Courier Partner, Freight Charges & COD Remittance */}
              {isVelocityCourier(order.shipment?.courier, order.shipment?.waybillNumber) && (
                <div style={{ background: '#f5f3ff', border: '1px solid #ddd6fe', borderRadius: '8px', padding: '12px 16px', marginTop: '14px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px', fontSize: '12px' }}>
                  <div>
                    <div style={{ color: '#6d28d9', fontWeight: 700, fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>⚡ Aggregator Partner</div>
                    <div style={{ fontWeight: 800, fontSize: '14px', color: '#1e1b4b', marginTop: '2px' }}>{order.shipment.courier || 'Velocity'}</div>
                    <div style={{ color: '#6b7280', fontSize: '11px' }}>AWB: <span style={{ fontFamily: 'monospace' }}>{order.shipment.waybillNumber}</span></div>
                  </div>
                  <div>
                    <div style={{ color: '#6d28d9', fontWeight: 700, fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>💰 Freight Billing</div>
                    <div style={{ fontWeight: 800, fontSize: '14px', color: '#1e1b4b', marginTop: '2px' }}>
                      {order.shipment.netBilledCost != null && order.shipment.netBilledCost > 0
                        ? formatMoney(order.shipment.netBilledCost, order.currency)
                        : order.shipment.forwardCharge != null
                        ? `${formatMoney(order.shipment.forwardCharge, order.currency)} (Est)`
                        : 'Pending Audit'}
                    </div>
                    <div style={{ color: '#6b7280', fontSize: '11px' }}>
                      Status: <strong>{order.shipment.billingStatus || 'ESTIMATED'}</strong>
                      {order.shipment.totalDebited ? ` · Debited: ${formatMoney(order.shipment.totalDebited, order.currency)}` : ''}
                    </div>
                  </div>
                  {order.shipment.paymentMode === 'COD' && (
                    <div>
                      <div style={{ color: '#6d28d9', fontWeight: 700, fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>🏦 COD Remittance & Settlement</div>
                      <div style={{ fontWeight: 800, fontSize: '14px', color: order.shipment.codRemitted ? '#047857' : '#b45309', marginTop: '2px' }}>
                        {order.shipment.codRemitted
                          ? `Remitted: ${formatMoney(order.shipment.codRemittedAmount ?? order.shipment.codAmount ?? 0, order.currency)}`
                          : order.shipment.codCollected
                          ? 'Collected · Bank Settlement Pending'
                          : 'Awaiting Delivery Collection'}
                      </div>
                      <div style={{ color: '#6b7280', fontSize: '11px' }}>
                        {order.shipment.codRemittanceRef ? (
                          <>Bank UTR / Ref: <CopyableBadge text={order.shipment.codRemittanceRef} monospace={true} /></>
                        ) : (
                          'Bank UTR appears upon Velocity settlement'
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Shipping Logistics Actions (Document downloads available in More Actions menu) */}
              <div className="shipment-actions" style={{ marginTop: '14px', flexWrap: 'wrap', gap: '8px' }}>
                {isReturnOrder && returnAwb ? (
                  <a
                    className="button button-secondary"
                    href={carrierTrackingUrl(order.shipment.courier || 'Delhivery', returnAwb)}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={`Open Return tracking on ${order.shipment.courier || 'Delhivery'}`}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', color: '#7c3aed', borderColor: '#c4b5fd', background: '#f5f3ff', fontWeight: 600 }}
                  >
                    <Icon name="refresh" size={15} />
                    <span>Track Return AWB ({returnAwb.slice(-6)})</span>
                  </a>
                ) : null}

                {order.shipment.waybillNumber && (
                  <a
                    className="button button-secondary"
                    href={carrierTrackingUrl(order.shipment.courier, order.shipment.waybillNumber)}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={`Open tracking page on ${order.shipment.courier || 'Delhivery'}`}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                  >
                    <Icon name="route" size={15} />
                    <span>Track on {order.shipment.courier || 'Delhivery'}</span>
                  </a>
                )}

                <Button
                  className="button-secondary"
                  onClick={() => {
                    setSwitchCourierName(order.shipment?.courier || 'Velocity')
                    setSwitchWaybill(order.shipment?.waybillNumber || '')
                    setShowSwitchCourierModal(true)
                  }}
                  title="Switch courier partner or update tracking details"
                >
                  <Icon name="truck" size={15} />
                  <span>Switch courier partner</span>
                </Button>

                {!['DELIVERED', 'RTO_DELIVERED', 'CANCELLED'].includes(order.shipment.status) && (
                  <Button
                    className="button-danger-ghost"
                    disabled={!order.shipment.waybillNumber || action.isPending || order.shipment.status === 'CANCELLED'}
                    loading={action.isPending && action.variables === 'cancel'}
                    onClick={() => {
                      if (window.confirm(`Cancel this ${order.shipment?.courier || 'carrier'} shipment?`)) {
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
                    onClick={openEpod}
                  >
                    <Icon name="check" size={15} />
                    <span>View EPOD</span>
                  </Button>
                )}

                {order.shipment.waybillNumber && !['DELIVERED', 'RTO_DELIVERED', 'CANCELLED'].includes(order.shipment.status) && (
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
                    <Icon name="check" size={16} />
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
                    onClick={openEpod}
                  >
                    Open EPOD Image
                  </Button>
                </div>
              )}

              {showEditDetails && order.shipment?.waybillNumber && (
                <div style={{ background: 'var(--line-subtle)', border: '1px solid var(--line)', borderRadius: '8px', padding: '12px', marginTop: '10px', display: 'grid', gap: '8px' }}>
                  <span style={{ fontSize: '11px', color: 'var(--muted)' }}>
                    {isVelocityCourier(order.shipment?.courier, order.shipment?.waybillNumber)
                      ? 'Pushes corrected details to Velocity Shipping Network (Edit Order API).'
                      : 'Pushes corrected details to Delhivery (Edit Order API — allowed while Manifested / In Transit / Pending).'}
                  </span>
                  <label className="form-field"><span className="field-label">Corrected phone</span><input
                    type="text"
                    placeholder="Corrected 10-digit phone"
                    value={editPhone}
                    onChange={(e) => setEditPhone(e.target.value)}
                    style={{ width: '100%' }}
                  /></label>
                  <label className="form-field"><span className="field-label">Corrected address</span><input
                    type="text"
                    placeholder="Corrected address with pincode"
                    value={editAddress}
                    onChange={(e) => setEditAddress(e.target.value)}
                    style={{ width: '100%' }}
                  /></label>
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

        <OrderPickupStatus order={order} />
        {/* ─── Carrier Tracking Timeline ────────────────────────── */}
        <Panel>
          <PanelHeading title="Tracking history" />
          <OrderTrackingHistory logs={order.shipment?.trackingLogs} limit={6} />
        </Panel>
        </section>
        <section className="order-section" id="order-section-returns" role="tabpanel" aria-labelledby="order-tab-returns" tabIndex={-1} hidden={section !== 'returns'}>
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
        </section>
        <section className="order-section" id="order-section-details" role="tabpanel" aria-labelledby="order-tab-details" tabIndex={-1} hidden={section !== 'details'}>
          {/* ─── GoKwik Buyer Intelligence & RTO Risk Assessment ─── */}
          <Panel>
            <PanelHeading
              eyebrow="GoKwik Buyer Intelligence"
              title="RTO Risk Assessment"
              action={
                <span className={`rto-risk-pill ${(order.rtoRiskLevel || 'MEDIUM').toLowerCase()}`} style={{ fontSize: '11px', padding: '2px 8px', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                  {order.rtoRiskLevel === 'LOW'
                    ? '✓ Low RTO Risk'
                    : order.rtoRiskLevel === 'HIGH'
                    ? <><Icon name="alert" size={11} /> High RTO Risk</>
                    : 'Medium RTO Risk'}
                </span>
              }
            />
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div style={{ background: 'var(--line-subtle)', border: '1px solid var(--line)', borderRadius: '7px', padding: '10px 12px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                  <span className="detail-label">GoKwik Delivery Track Record</span>
                  <span style={{ fontSize: '11px', fontWeight: 800, color: (order.deliverOrderCount || 0) >= 2 ? '#047857' : '#b45309' }}>
                    {order.deliverOrderCount ?? 0} Prior Deliveries
                  </span>
                </div>
                <p style={{ margin: 0, fontSize: '11.5px', color: 'var(--ink-secondary)', lineHeight: 1.45 }}>
                  {order.rtoRiskReason ||
                    (order.paymentMethod !== 'COD'
                      ? 'Prepaid order captured upfront · Zero RTO risk'
                      : isCodConf
                      ? 'Customer purchase intent verified via WhatsApp COD confirmation'
                      : 'Awaiting customer COD confirmation before dispatch')}
                </p>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: '6px', padding: '8px 10px' }}>
                  <span className="detail-label">Payment Mode</span>
                  <strong style={{ fontSize: '12px', color: 'var(--ink)' }}>{order.paymentMethod || 'Prepaid'}</strong>
                </div>
                <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: '6px', padding: '8px 10px' }}>
                  <span className="detail-label">COD Confirmation</span>
                  <strong style={{ fontSize: '12px', color: isCodConf ? '#047857' : 'var(--muted)' }}>
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
                    {order.tags.split(',').map((t) => t.trim()).filter(Boolean).map((tag, index) => {
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
                        <span key={`${tag}-${index}`} className={`shopify-tag-pill ${modifier}`} style={{ fontSize: '11px', padding: '3px 9px' }}>
                          {tag}
                        </span>
                      )
                    })}
                  </div>
                ) : (
                  <span style={{ fontSize: '12px', color: '#94a3b8' }}>No tags assigned on Shopify</span>
                )}
              </div>

              <div style={{ background: 'var(--line-subtle)', border: '1px solid var(--line)', borderRadius: '8px', padding: '10px 12px', fontSize: '11px', color: 'var(--ink-secondary)', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontWeight: 700, color: 'var(--ink)' }}>Delhivery ONE Channel Link</span>
                  <span style={{ color: '#16a34a', fontWeight: 700 }}>● Active</span>
                </div>
                <p style={{ margin: 0, fontSize: '10.5px', color: 'var(--muted)', lineHeight: 1.4 }}>
                  When Shopify is linked in Delhivery ONE, dispatches triggered from this OMS automatically update Shopify fulfillment tracking with carrier <strong>Delhivery</strong> and append the generated AWB to order tags.
                </p>
              </div>
            </div>
          </Panel>

          {/* ─── Financials & 3-Way Money Reconciliation ─────────── */}


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
                      <time dateTime={(notice.sentAt ?? notice.createdAt) ? String(notice.sentAt ?? notice.createdAt) : undefined}>{formatDate(notice.sentAt ?? notice.createdAt)}</time>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState title="No notifications" description="Messages sent for this order will appear here." icon="box" />
            )}
          </Panel>
        </section>
      </div>

      <div className="detail-side">
        <Panel>
          <PanelHeading title="Customer" />
          <div className="customer-detail">
            <div className="customer-avatar">
              {order.customerName.split(' ').map((part) => part[0]).slice(0, 2).join('').toUpperCase()}
            </div>
            <div>
              <strong style={{ fontSize: '14px', color: 'var(--ink)' }}>{order.customerName}</strong>
              <span style={{ fontSize: '11.5px', color: 'var(--ink-secondary)' }}>{order.customerPhone || 'No phone'}</span>
              <span style={{ fontSize: '11.5px', color: 'var(--muted)' }}>{order.customerEmail ?? 'No email provided'}</span>
            </div>
          </div>
          <div className="address-card">
            <button
              type="button"
              className="address-copy-btn"
              title="Copy full delivery address"
              aria-label="Copy full delivery address"
              onClick={copyAddress}
            >
              <Icon name="copy" size={12} />
            </button>
            <Icon name="pin" size={16} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <strong style={{ fontSize: '12.5px', color: 'var(--ink)' }}>{order.customerAddress}</strong>
              <span style={{ fontSize: '11.5px', color: 'var(--ink-secondary)', marginTop: '3px', display: 'block' }}>
                {order.customerCity}, {order.customerState} — <strong className="mono">{order.customerPincode}</strong>
              </span>
              <span style={{ fontSize: '11px', color: 'var(--muted)' }}>{order.customerCountry}</span>
            </div>
          </div>
          <div className="customer-quick-actions">
            {cleanPhone ? (
              <a className="quick-action-btn quick-action-wa" aria-label="WhatsApp Chat" href={`https://wa.me/${cleanPhone}?text=${encodeURIComponent(`Hi ${order.customerName}, this is regarding your order ${order.shopifyOrderName} from our store.`)}`} target="_blank" rel="noopener noreferrer">
                <Icon name="message" size={14} /> WhatsApp
              </a>
            ) : (
              <button className="quick-action-btn quick-action-wa" aria-label="WhatsApp Chat" disabled><Icon name="message" size={14} /> WhatsApp</button>
            )}
            {cleanPhone ? (
              <a className="quick-action-btn quick-action-call" aria-label="Call Customer" href={`tel:${cleanPhone}`}><Icon name="phone" size={14} /> Call</a>
            ) : (
              <button className="quick-action-btn quick-action-call" aria-label="Call Customer" disabled><Icon name="phone" size={14} /> Call</button>
            )}
            <button className="quick-action-btn quick-action-copy" aria-label="Copy Address" onClick={copyAddress}><Icon name="copy" size={14} /> Copy</button>
          </div>
        </Panel>


        {/* ─── Reverse Logistics & Return Management ─────────────── */}

        <Panel className="shopify-order-notes">
          <h2>Notes</h2>
          {order.shopifyNote ? <p>{order.shopifyNote}</p> : (
            <p className="shopify-note-empty"><Icon name="box" size={14} /> No notes from Shopify.</p>
          )}
        </Panel>
        {Boolean(order.additionalDetails?.length) && (
          <Panel className="shopify-order-notes">
            <details>
              <summary>Additional details <span>{order.additionalDetails!.length}</span></summary>
              <dl className="shopify-additional-details">
                {order.additionalDetails!.map((attribute, index) => (
                  <div key={`${attribute.name}-${index}`}><dt>{attribute.name}</dt><dd>{attribute.value}</dd></div>
                ))}
              </dl>
            </details>
          </Panel>
        )}
      </div>
    </div>

    {/* ─── Cancel Order Confirmation Trigger Modal ─── */}
    {showCancelModal && order && (
      <div className="modal-backdrop" onClick={() => !isCancelling && setShowCancelModal(false)}>
        <div className="modal-card" role="dialog" aria-modal="true" aria-label="Cancel order" onClick={(e) => e.stopPropagation()}>
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
        <div className="modal-card" role="dialog" aria-modal="true" aria-label="Delete order" onClick={(e) => e.stopPropagation()}>
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
        <div className="modal-card" role="dialog" aria-modal="true" aria-label="Resolve NDR" onClick={(e) => e.stopPropagation()}>
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

            <fieldset className="order-ndr-options">
              <legend>Select NDR action</legend>
              <div style={{ display: 'flex', gap: '10px', marginTop: '6px' }}>
                <label
                  style={{
                    flex: 1,
                    border: ndrActionType === 'RE-ATTEMPT' ? '2px solid #2563eb' : '1px solid #cbd5e1',
                    background: ndrActionType === 'RE-ATTEMPT' ? '#eff6ff' : 'var(--panel)',
                    borderRadius: '8px',
                    padding: '12px',
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="radio"
                    name="ndrDetailAction"
                    value="RE-ATTEMPT"
                    aria-label="Re-attempt delivery"
                    checked={ndrActionType === 'RE-ATTEMPT'}
                    onChange={() => setNdrActionType('RE-ATTEMPT')}
                    style={{ marginRight: '8px' }}
                  />
                  <strong>🔄 Re-attempt Delivery</strong>
                  <p style={{ margin: '4px 0 0 0', fontSize: '11px', color: 'var(--ink-secondary)' }}>
                    Request courier to re-attempt delivery tomorrow & notify customer via WhatsApp.
                  </p>
                </label>

                <label
                  style={{
                    flex: 1,
                    border: ndrActionType === 'RTO' ? '2px solid #dc2626' : '1px solid #cbd5e1',
                    background: ndrActionType === 'RTO' ? '#fef2f2' : 'var(--panel)',
                    borderRadius: '8px',
                    padding: '12px',
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="radio"
                    name="ndrDetailAction"
                    value="RTO"
                    aria-label="Return to origin"
                    checked={ndrActionType === 'RTO'}
                    onChange={() => setNdrActionType('RTO')}
                    style={{ marginRight: '8px' }}
                  />
                  <strong>↩️ Return to Origin (RTO)</strong>
                  <p style={{ margin: '4px 0 0 0', fontSize: '11px', color: 'var(--ink-secondary)' }}>
                    Package will be returned to our Surat warehouse. (Prepaid orders get auto-refunded upon warehouse delivery).
                  </p>
                </label>
              </div>
            </fieldset>

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
                color: 'var(--panel)',
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

    {/* ─── KwikEngage WhatsApp Trigger Modal ─── */}
    {showWhatsAppModal && order && (
      <div className="modal-backdrop" onClick={() => !isSendingWhatsApp && setShowWhatsAppModal(false)}>
        <div className="modal-card" role="dialog" aria-modal="true" aria-label="Send WhatsApp message" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '540px' }}>
          <div className="modal-header">
            <div className="modal-header-left">
              <div className="modal-icon-badge" style={{ background: '#dcfce7', color: '#16a34a' }}>
                <Icon name="message" size={20} />
              </div>
              <div>
                <h3 className="modal-title">Send WhatsApp via KwikEngage</h3>
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
              <div style={{ background: 'var(--line-subtle)', border: '1px solid var(--line)', borderRadius: '8px', padding: '12px', fontSize: '11.5px', color: 'var(--ink-secondary)' }}>
                <strong style={{ color: 'var(--ink)', display: 'block', marginBottom: '4px' }}>
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
              <span>Sent via KwikEngage Official WhatsApp Cloud & synced with OMS Notification history.</span>
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
              {isSendingWhatsApp ? 'Sending via KwikEngage…' : 'Send WhatsApp Message'}
            </button>
          </div>
        </div>
      </div>
    )}

    {/* ─── Courier Partner Selection Modal ─── */}
    {showCarrierModal && (
      <div className="modal-backdrop" onClick={() => !action.isPending && setShowCarrierModal(false)}>
        <div className="modal-card" role="dialog" aria-modal="true" aria-label="Select courier partner" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '640px' }}>
          <div className="modal-header">
            <div className="modal-header-left">
              <div className="modal-icon-badge info">
                <Icon name="truck" size={20} />
              </div>
              <div>
                <h3 className="modal-title">Select Courier Partner</h3>
                <p className="modal-desc">Compare real-time shipping rate cards and delivery SLAs for {order?.shopifyOrderName}.</p>
              </div>
            </div>
            <button
              type="button"
              className="modal-close-btn"
              disabled={action.isPending}
              onClick={() => setShowCarrierModal(false)}
            >
              <Icon name="close" size={16} />
            </button>
          </div>

          <div className="modal-body">
            {loadingShippingOptions ? (
              <div style={{ padding: '32px 16px', textAlign: 'center' }}>
                <LoadingState label="Discovering serviceability & carrier rate cards…" />
              </div>
            ) : shippingOptions.length === 0 ? (
              <EmptyState title="No couriers available" description="Could not discover serviceable courier partners for this pincode." icon="alert" />
            ) : (
              <div className="carrier-options-list" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {shippingOptions.map((opt, idx) => {
                  const isSelected = selectedOptionIndex === idx
                  return (
                    <div
                      key={idx}
                      onClick={() => opt.serviceable && setSelectedOptionIndex(idx)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '12px 16px',
                        borderRadius: '8px',
                        border: `2px solid ${isSelected ? 'var(--color-primary, #6366f1)' : 'var(--color-border, #e2e8f0)'}`,
                        background: isSelected ? 'var(--color-primary-light, #f5f7ff)' : opt.serviceable ? 'var(--color-bg-card, #ffffff)' : 'var(--color-bg-subtle, #f8fafc)',
                        cursor: opt.serviceable ? 'pointer' : 'not-allowed',
                        opacity: opt.serviceable ? 1 : 0.6,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                        <input
                          type="radio"
                          name="carrier-choice"
                          checked={isSelected}
                          disabled={!opt.serviceable}
                          onChange={() => setSelectedOptionIndex(idx)}
                          style={{ margin: 0 }}
                        />
                        <div>
                          <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px' }}>
                            {opt.carrierName || opt.courier}
                            {opt.isRecommended && (
                              <span style={{ fontSize: '11px', background: '#dcfce7', color: '#166534', padding: '2px 6px', borderRadius: '4px', fontWeight: 500 }}>
                                Recommended
                              </span>
                            )}
                          </div>
                          <div style={{ fontSize: '12px', color: 'var(--color-text-muted, #64748b)' }}>
                            {opt.description}
                            {opt.estimatedDays ? ` · SLA: ~${opt.estimatedDays} days` : ''}
                          </div>
                        </div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        {opt.serviceable ? (
                          <>
                            <div style={{ fontWeight: 700, fontSize: '15px' }}>
                              {opt.rate > 0 ? formatMoney(opt.rate) : 'Live Rate'}
                            </div>
                            <span style={{ fontSize: '11px', color: '#16a34a' }}>● Serviceable</span>
                          </>
                        ) : (
                          <span style={{ fontSize: '11px', color: '#dc2626' }}>● Unserviceable</span>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          <div className="modal-footer" style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', padding: '16px 20px', borderTop: '1px solid var(--color-border, #e2e8f0)' }}>
            <button
              type="button"
              className="button-secondary"
              disabled={action.isPending}
              onClick={() => setShowCarrierModal(false)}
            >
              Cancel
            </button>
            <Button
              className="button-primary"
              loading={action.isPending}
              disabled={loadingShippingOptions || !shippingOptions[selectedOptionIndex]?.serviceable}
              onClick={handleDispatchSelectedCarrier}
            >
              <Icon name="package" size={15} />
              Dispatch with {shippingOptions[selectedOptionIndex]?.carrierName || 'Courier'}
            </Button>
          </div>
        </div>
      </div>
    )}

    {/* ─── Switch Courier Partner Modal ─── */}
    {showSwitchCourierModal && order && (
      <div className="modal-backdrop" onClick={() => !updateCourierMutation.isPending && setShowSwitchCourierModal(false)}>
        <div className="modal-card" role="dialog" aria-modal="true" aria-label="Switch Courier Partner" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '520px' }}>
          <div className="modal-header">
            <div className="modal-header-left">
              <div className="modal-icon-badge info">
                <Icon name="truck" size={20} />
              </div>
              <div>
                <h3 className="modal-title">Switch Courier Partner</h3>
                <p className="modal-desc">Assign or override the shipping partner for {order.shopifyOrderName}.</p>
              </div>
            </div>
            <button
              type="button"
              className="modal-close-btn"
              disabled={updateCourierMutation.isPending}
              onClick={() => setShowSwitchCourierModal(false)}
            >
              <Icon name="close" size={16} />
            </button>
          </div>

          <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <FormField label="Courier Partner">
              <select
                className="input-select"
                value={switchCourierName}
                onChange={(e) => setSwitchCourierName(e.target.value)}
                disabled={updateCourierMutation.isPending}
                style={{ width: '100%' }}
              >
                <option value="Velocity">Velocity (Aggregator)</option>
                <option value="Delhivery">Delhivery Express</option>
                <option value="Amazon Transportation">Amazon ATS</option>
                <option value="Ekart">Ekart Logistics</option>
                <option value="Blue Dart">Blue Dart</option>
                <option value="Shadowfax">Shadowfax</option>
                <option value="DTDC">DTDC</option>
                <option value="Smartr">Smartr Logistics</option>
                <option value="Ecom Express">Ecom Express</option>
                <option value="India Post">India Post</option>
              </select>
            </FormField>

            <FormField label="AWB / Tracking Number">
              <input
                type="text"
                className="input-text"
                value={switchWaybill}
                onChange={(e) => setSwitchWaybill(e.target.value)}
                placeholder="Enter waybill / tracking number"
                disabled={updateCourierMutation.isPending}
                style={{ width: '100%', fontFamily: 'monospace' }}
              />
            </FormField>

            <div style={{ background: 'var(--line-subtle, #f8fafc)', border: '1px solid var(--line, #e2e8f0)', borderRadius: '8px', padding: '12px', fontSize: '12px', color: 'var(--ink-secondary, #64748b)' }}>
              {switchCourierName.toLowerCase().includes('velocity') ? (
                <span>⚡ Switching to <strong>Velocity</strong> automatically links tracking at <code>velocityshipping.in</code>, clears any Delhivery manifest errors, and connects live financial reconciliation.</span>
              ) : (
                <span>📦 Updating courier will refresh live tracking links and update customer notifications.</span>
              )}
            </div>
          </div>

          <div className="modal-footer" style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', padding: '16px 20px', borderTop: '1px solid var(--color-border, #e2e8f0)' }}>
            <button
              type="button"
              className="button-secondary"
              disabled={updateCourierMutation.isPending}
              onClick={() => setShowSwitchCourierModal(false)}
            >
              Cancel
            </button>
            <Button
              className="button-primary"
              loading={updateCourierMutation.isPending}
              disabled={updateCourierMutation.isPending}
              onClick={() => {
                updateCourierMutation.mutate({
                  courier: switchCourierName,
                  waybillNumber: switchWaybill,
                })
              }}
            >
              <Icon name="check" size={15} />
              Save Courier Partner
            </Button>
          </div>
        </div>
      </div>
    )}
  </div>
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
          <span className="shopify-line-unit">{formatMoney(item.price, currency)} <span aria-hidden="true">×</span> <span className="shopify-line-qty" aria-label={`Quantity ${item.quantity}`}>{item.quantity}</span></span>
          <div className="shopify-line-money">
            <strong>{formatMoney(item.price * item.quantity, currency)}</strong>
            {item.quantity > 1 ? <small>{formatMoney(item.price, currency)} each</small> : null}
          </div>
        </div>
      ))}
    </div>
  )

  const summary = <OrderFinancialSummary order={order} items={items} currency={currency} />

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

async function encodeFileBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return window.btoa(binary)
}

function AccountTrailPanel({
  orderId,
  returns,
  defaultAmount,
  currency,
}: {
  orderId: number
  returns: ReturnRecord[]
  defaultAmount: number
  currency: string
}) {
  const queryClient = useQueryClient()
  const toast = useToast()
  const [formOpen, setFormOpen] = useState(false)
  const [amount, setAmount] = useState(String(defaultAmount))
  const [returnId, setReturnId] = useState('')
  const [refundMode, setRefundMode] = useState('')
  const [accountUsed, setAccountUsed] = useState('')
  const [externalReference, setExternalReference] = useState('')
  const [note, setNote] = useState('')
  const [evidenceFile, setEvidenceFile] = useState<File | null>(null)
  const [proofPreview, setProofPreview] = useState<string | null>(null)

  const trailQuery = useQuery({
    queryKey: ['account-trail', orderId],
    queryFn: async () => (await api.get<{ events: AccountTrailEvent[] }>(`/api/orders/${orderId}/account-trail`)).data.events,
    retry: false,
  })

  useEffect(() => {
    if (!evidenceFile) {
      setProofPreview(null)
      return
    }
    const previewUrl = URL.createObjectURL(evidenceFile)
    setProofPreview(previewUrl)
    return () => URL.revokeObjectURL(previewUrl)
  }, [evidenceFile])

  const manualRefundMutation = useMutation({
    mutationFn: async () => {
      const numericAmount = Number(amount)
      if (!Number.isFinite(numericAmount) || numericAmount <= 0) throw new Error('Enter a refund amount greater than zero.')
      if (!refundMode) throw new Error('Choose how the refund was sent.')
      if (!accountUsed.trim()) throw new Error('Enter the account or payment source used.')
      if (evidenceFile && evidenceFile.size > 5 * 1024 * 1024) throw new Error('Screenshot must be smaller than 5 MB.')
      if (!window.confirm('Record this manual refund as already sent? This only saves the audit record; it will not transfer money or create another Shopify refund.')) {
        throw new Error('USER_CANCELLED_REFUND_RECORD')
      }
      const evidence = evidenceFile
        ? { fileName: evidenceFile.name, contentType: evidenceFile.type, contentBase64: await encodeFileBase64(evidenceFile) }
        : undefined
      return (await api.post(`/api/orders/${orderId}/refunds/manual`, {
        amount: numericAmount,
        returnId: returnId ? Number(returnId) : undefined,
        refundMode,
        accountUsed: accountUsed.trim(),
        externalReference: externalReference.trim() || undefined,
        note: note.trim() || undefined,
        evidence,
      })).data.event as AccountTrailEvent
    },
    onSuccess: async () => {
      toast.toast('success', 'Manual refund recorded in the account trail.')
      setFormOpen(false)
      setEvidenceFile(null)
      setExternalReference('')
      setNote('')
      await queryClient.invalidateQueries({ queryKey: ['account-trail', orderId] })
      await queryClient.invalidateQueries({ queryKey: ['order', String(orderId)] })
    },
    onError: (error) => {
      if (error instanceof Error && error.message === 'USER_CANCELLED_REFUND_RECORD') return
      toast.toast('error', apiError(error))
    },
  })

  return (
    <Panel className="account-trail-panel">
      <PanelHeading eyebrow="Financial audit" title="COD approval & refund trail" />
      <p className="panel-description">A permanent, user-attributed trail of COD approval, return creation, and refunds. Manual entries record a payout already sent; they never initiate a transfer.</p>
      <Button className="button-secondary" onClick={() => setFormOpen((open) => !open)}>
        <Icon name="plus" size={15} />
        {formOpen ? 'Close manual refund form' : 'Record manual refund'}
      </Button>

      {formOpen && (
        <div className="account-trail-form">
          <div className="account-trail-form-grid">
            <FormField label="Refund amount">
              <input type="number" min="0.01" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} />
            </FormField>
            <FormField label="Refund mode">
              <select value={refundMode} onChange={(event) => setRefundMode(event.target.value)}>
                <option value="">Choose refund mode</option>
                <option value="ORIGINAL_PAYMENT_METHOD">Original payment method</option>
                <option value="UPI">UPI</option>
                <option value="BANK_TRANSFER">Bank transfer</option>
                <option value="CASH">Cash</option>
                <option value="OTHER">Other</option>
              </select>
            </FormField>
            <FormField label="Account / source used">
              <input value={accountUsed} onChange={(event) => setAccountUsed(event.target.value)} placeholder="e.g. HDFC current account ··4821" maxLength={160} />
              <small className="field-hint">Use a safe label or masked suffix only—never enter a full card or bank number.</small>
            </FormField>
            <FormField label="Related return (optional)">
              <select value={returnId} onChange={(event) => setReturnId(event.target.value)}>
                <option value="">Order-level refund</option>
                {returns.map((record) => <option key={record.id} value={record.id}>Return #{record.id} · {record.returnStatus}{record.returnWaybillNumber ? ` · AWB ${record.returnWaybillNumber}` : ''}</option>)}
              </select>
            </FormField>
            <FormField label="Payment reference (optional)">
              <input value={externalReference} onChange={(event) => setExternalReference(event.target.value)} placeholder="UTR / transaction reference" maxLength={160} />
            </FormField>
            <FormField label="Note (optional)">
              <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2} placeholder="Reason or reconciliation note" maxLength={1000} />
            </FormField>
          </div>
          <FormField label="Payout screenshot (optional)">
            <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => setEvidenceFile(event.target.files?.[0] ?? null)} />
            <small className="field-hint">PNG, JPEG, or WebP; up to 5 MB. Stored privately; the audit view uses a short-lived link.</small>
          </FormField>
          {proofPreview && evidenceFile ? <img className="account-trail-proof-preview" src={proofPreview} alt={`Preview of ${evidenceFile.name}`} /> : null}
          <div className="account-trail-form-actions">
            <Button className="button-primary" loading={manualRefundMutation.isPending} onClick={() => manualRefundMutation.mutate()}>
              Save refund audit record
            </Button>
          </div>
        </div>
      )}

      <div className="account-trail-events">
        {trailQuery.isLoading ? <p className="field-hint">Loading account trail…</p> : null}
        {trailQuery.isError ? <ErrorBox message={apiError(trailQuery.error)} /> : null}
        {trailQuery.isSuccess && !trailQuery.data.length ? <EmptyState title="No account events yet" description="COD approvals, returns, and refunds will appear here." icon="box" /> : null}
        {trailQuery.data?.map((event) => (
          <article className="account-trail-event" key={event.id}>
            <div className="account-trail-event-heading">
              <strong>{event.eventType.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase())}</strong>
              {event.status ? <StatusBadge status={event.status} /> : null}
            </div>
            <p className="account-trail-actor">
              {event.actorName || event.actorEmail || (event.actorType === 'SYSTEM' ? 'System automation' : event.actorType)}
              {event.actorRole ? ` · ${event.actorRole}` : ''}
              {event.actorEmail && event.actorName ? ` · ${event.actorEmail}` : ''}
            </p>
            <time dateTime={event.createdAt ? String(event.createdAt) : undefined}>{formatDate(event.createdAt)}{event.source ? ` · ${event.source.replace(/_/g, ' ')}` : ''}</time>
            {event.amount !== null ? <div className="account-trail-money">{formatMoney(event.amount, event.currency || currency)}</div> : null}
            {event.refundMode || event.accountUsed ? (
              <div className="account-trail-meta">
                {event.refundMode ? <span>Mode: {event.refundMode.replace(/_/g, ' ').toLowerCase()}</span> : null}
                {event.accountUsed ? <span>Account: {event.accountUsed}</span> : null}
              </div>
            ) : null}
            {event.returnId ? <span className="account-trail-reference">Return #{event.returnId}</span> : null}
            {event.externalReference ? <span className="account-trail-reference">Reference: {event.externalReference}</span> : null}
            {event.note ? <p className="account-trail-note">{event.note}</p> : null}
            {event.evidenceUrl ? <a className="account-trail-evidence" href={event.evidenceUrl} target="_blank" rel="noreferrer">View payout screenshot{event.evidenceFileName ? ` · ${event.evidenceFileName}` : ''}</a> : null}
          </article>
        ))}
      </div>
    </Panel>
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
  const delivered = hasCustomerDelivery(order)
  const forwardAwb = order.shipment?.waybillNumber
  if (!active && !delivered) return (
    <Panel className="order-return-eligibility" id="return-panel">
      <PanelHeading title="Returns & reverse pickup" />
      <div className="order-eligibility-message"><Icon name="return" size={24} /><div>
        <h3>Customer delivery required</h3>
        <p>A reverse pickup becomes available after the customer receives the parcel. In-transit and RTO shipments cannot start a customer return.</p>
        {forwardAwb && <p>Forward AWB: <strong>{forwardAwb}</strong></p>}
      </div></div>
    </Panel>
  )

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
