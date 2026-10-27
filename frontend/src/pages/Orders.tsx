import { useMemo, useState, useRef, useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getOrders,
  apiError,
  api,
  confirmCodOrder,
  cancelOrder,
  deleteOrder,
  processRtoRefund,
  handleNdrAction,
  syncOrders,
  syncChannelOrders,
  getDelhiveryChannelStatus,
  downloadBulkLabels,
  downloadBulkInvoices,
  downloadBulkLabelsDirectFile,
  downloadBulkLabelsAndInvoicesDirectFile,
  openPrintableBulkLabelsAndInvoices,
  downloadBulkPackZip,
  downloadBulkPicklist,
  openPrintableBulkPicklist,
  downloadBulkInvoicesDirectFile,
  syncBulkExternalFulfillments,
} from '../api'
import { ORDER_TABS, tabForStatus, formatDate, formatMoney, labelize, isVelocityCourier, type OrderTabKey } from '../lib'
import { classifyOrderTab, isApprovedForDispatch, isCodConfirmed as codConfirmedTag, isManifestRejected, isPrepaidOrder as prepaidOrder, prioritizeOrdersForDispatch } from '../../../src/modules/orders/order-tabs'
import { getOrderTabCounts } from '../api'
import { Button, EmptyState, ErrorBox, FormField, Icon, LoadingState, PageIntro, Panel, StatusBadge, useDocumentTitle, useToast } from '../components/UI'
import { OrderLogisticsActions } from '../components/OrderLogisticsActions'
import type { Order, OrderStatus } from '../types'
import { useNavigate, useSearchParams } from 'react-router-dom'
import './Orders.css'

export type PaymentChannelFilter = 'ALL' | 'DELHIVERY_PENDING_AWB' | 'NEEDS_DISPATCH' | 'DELAYED_DISPATCH' | 'NDR' | 'PREPAID_PENDING' | 'COD' | 'GOKWIK' | 'PHONEPE'

export function renderRtoRiskBadge(order: Order) {
  if (order.paymentMethod !== 'COD') {
    return null
  }
  const level = order.rtoRiskLevel || 'MEDIUM'
  if (level === 'LOW') {
    return (
      <span className="micro-badge micro-badge-emerald" title={order.rtoRiskReason || 'Low risk COD order'}>
        ✓ Low RTO
      </span>
    )
  }
  if (level === 'HIGH') {
    return (
      <span className="micro-badge micro-badge-red" title={order.rtoRiskReason || 'High risk COD order'}>
        ⛔ High RTO
      </span>
    )
  }
  return (
    <span className="micro-badge micro-badge-amber" title={order.rtoRiskReason || 'Medium risk · Unconfirmed COD'}>
      ⚡ Med RTO
    </span>
  )
}

export function isPrepaidOrder(order: Order): boolean {
  return prepaidOrder(order)
}

export function isCodConfirmed(order: Order): boolean {
  return codConfirmedTag(order)
}

/** Same queue as the Ready to Dispatch tab: approved, no label, no Delhivery update. */
export function isDispatchNeeded(order: Order): boolean {
  return classifyOrderTab(order) === 'dispatch'
}

export function ShopifyTagList({ tags }: { tags?: string | null }) {
  if (!tags) return null
  const tagList = tags
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    // Filter out tags that duplicate badges already shown in column 1
    .filter((t) => {
      const lower = t.toLowerCase()
      if (lower.startsWith('delhivery-awb')) return false
      if (lower === 'dispatched' || lower === 'shipped') return false
      if (lower === 'cod' || lower === 'prepaid' || lower === 'pre-paid') return false
      if (lower === 'cod_confirmed' || lower === 'cod confirmed' || lower === 'confirmed') return false
      if (lower === 'kc_abc') return false
      return true
    })
  if (!tagList.length) return null

  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap' }}>
      {tagList.slice(0, 2).map((tag) => {
        const lower = tag.toLowerCase()
        let modifier = 'tag-default'
        if (lower.includes('weight-mismatch') || lower.includes('mismatch')) modifier = 'tag-mismatch'
        else if (lower.includes('rebilled')) modifier = 'tag-rebilled'
        else if (lower.includes('gokwik') || lower.includes('kwik')) modifier = 'tag-gokwik'
        else if (lower.includes('upi')) modifier = 'tag-upi'
        else if (lower.includes('refund') || lower.includes('cancelled')) modifier = 'tag-refund'

        return (
          <span key={tag} className={`shopify-tag-pill ${modifier}`} title={`Shopify Tag: ${tag}`}>
            {tag}
          </span>
        )
      })}
      {tagList.length > 2 && (
        <span className="shopify-tag-pill tag-default" title={tagList.slice(2).join(', ')}>
          +{tagList.length - 2}
        </span>
      )}
    </div>
  )
}

export function Orders() {
  useDocumentTitle('Orders')
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const toast = useToast()
  const queryClient = useQueryClient()
  const searchInputRef = useRef<HTMLInputElement>(null)

  const initialFilter: PaymentChannelFilter =
    searchParams.get('filter') === 'PREPAID_DISPATCH' || searchParams.get('filter') === 'NEEDS_DISPATCH'
      ? 'NEEDS_DISPATCH'
      : searchParams.get('filter') === 'DELAYED_DISPATCH'
      ? 'DELAYED_DISPATCH'
      : searchParams.get('filter') === 'NDR'
      ? 'NDR'
      : 'ALL'
  const initialTab: OrderTabKey = (searchParams.get('tab') as OrderTabKey) ||
    tabForStatus(searchParams.get('status') as OrderStatus | null)
  const [channelFilter, setChannelFilter] = useState<PaymentChannelFilter>(initialFilter)
  const [activeTab, setActiveTab] = useState<OrderTabKey>(initialTab)
  const [selectedState, setSelectedState] = useState<string>('')
  const [search, setSearch] = useState('')
  // Slim SLA strip — dismissed by the user until the next reload / count change
  const [slaDismissed, setSlaDismissed] = useState(false)
  // Every order with a dispatch request in flight. One shared id let a click on
  // row B re-enable row A's button while A was still manifesting.
  const [dispatchingIds, setDispatchingIds] = useState<Set<number>>(() => new Set())
  const [confirmingCodId, setConfirmingCodId] = useState<number | null>(null)

  // Trigger Modals for Cancel / Delete
  const [orderToCancel, setOrderToCancel] = useState<Order | null>(null)
  const [cancelReason, setCancelReason] = useState<string>('customer')
  const [isCancelling, setIsCancelling] = useState(false)

  const [orderToDelete, setOrderToDelete] = useState<Order | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  // NDR Resolution Modal States
  const [orderForNdr, setOrderForNdr] = useState<Order | null>(null)
  const [ndrActionType, setNdrActionType] = useState<'RE-ATTEMPT' | 'RTO' | 'DEFER_DLV' | 'EDIT_DETAILS'>('RE-ATTEMPT')
  const [ndrNotes, setNdrNotes] = useState('')
  const [ndrDeferDate, setNdrDeferDate] = useState(() => new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10))
  const [ndrEditPhone, setNdrEditPhone] = useState('')
  const [ndrEditAddress, setNdrEditAddress] = useState('')
  const [isSubmittingNdr, setIsSubmittingNdr] = useState(false)

  // Prefill correction fields + reset action when the NDR modal opens
  useEffect(() => {
    if (orderForNdr) {
      setNdrActionType('RE-ATTEMPT')
      setNdrNotes('')
      setNdrDeferDate(new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10))
      setNdrEditPhone(orderForNdr.customerPhone || '')
      setNdrEditAddress(
        [orderForNdr.customerAddress, orderForNdr.customerCity, orderForNdr.customerState, orderForNdr.customerPincode]
          .filter(Boolean)
          .join(', ')
      )
    }
  }, [orderForNdr])

  // RTO Auto-Refund action state
  const [refundingOrderId, setRefundingOrderId] = useState<number | null>(null)

  // Multi-select row checkboxes
  const [selectedOrderIds, setSelectedOrderIds] = useState<Set<number>>(new Set())
  const [isBulkDispatching, setIsBulkDispatching] = useState(false)
  const [bulkDispatchProgress, setBulkDispatchProgress] = useState<{
    current: number
    total: number
    orderName: string
    completed: number
    failed: number
  } | null>(null)
  const [isBulkVerifying, setIsBulkVerifying] = useState(false)
  const [isBulkConfirmingCod, setIsBulkConfirmingCod] = useState(false)
  const [isBulkGeneratingLabels, setIsBulkGeneratingLabels] = useState(false)
  const [isBulkGeneratingInvoices, setIsBulkGeneratingInvoices] = useState(false)
  const [showPickupModal, setShowPickupModal] = useState(false)
  const [isSubmittingPickup, setIsSubmittingPickup] = useState(false)

  const query = useQuery({
    queryKey: ['orders', activeTab],
    queryFn: () => getOrders(activeTab === 'all' ? '' : { tab: activeTab }),
    retry: false,
  })

  const tabCountsQuery = useQuery({
    queryKey: ['orders', 'tab-counts'],
    queryFn: getOrderTabCounts,
    retry: false,
    staleTime: 15_000,
  })
  const tabCounts = tabCountsQuery.data ?? {}

  const setTabAndUrl = (tab: OrderTabKey) => {
    setActiveTab(tab)
    setSelectedOrderIds(new Set())
    const next = new URLSearchParams(searchParams)
    if (tab === 'all') next.delete('tab')
    else next.set('tab', tab)
    next.delete('status')
    navigate(`/orders${next.toString() ? `?${next.toString()}` : ''}`, { replace: true })
  }

  useEffect(() => {
    const f = searchParams.get('filter')
    if (f === 'PREPAID_DISPATCH' || f === 'NEEDS_DISPATCH') {
      setChannelFilter('NEEDS_DISPATCH')
    } else if (f === 'DELAYED_DISPATCH') {
      setChannelFilter('DELAYED_DISPATCH')
    } else if (f === 'NDR') {
      setChannelFilter('NDR')
    }
    const tabParam = searchParams.get('tab') as OrderTabKey | null
    if (tabParam && ORDER_TABS.some((t) => t.key === tabParam)) {
      setActiveTab(tabParam)
    } else {
      const st = searchParams.get('status') as OrderStatus | null
      if (st) setActiveTab(tabForStatus(st))
    }
  }, [searchParams])

  // Single order dispatch action
  const handleSingleDispatch = async (orderId: number, courier?: 'Delhivery' | 'Velocity' | 'auto') => {
    if (dispatchingIds.has(orderId)) return
    setDispatchingIds((prev) => new Set(prev).add(orderId))
    try {
      const res = await api.post(`/api/orders/${orderId}/dispatch`, { courier })
      const courierName = res.data.courier || (courier && courier !== 'auto' ? courier : 'Delhivery')
      const waybillNumber = res.data.waybillNumber || 'Assigned'
      toast.toast('success', `Order dispatched · ${courierName} AWB: ${waybillNumber}`)
      // Real-time optimistic update: order immediately moves from Dispatch to Ready to Ship
      queryClient.setQueriesData<Order[]>({ queryKey: ['orders'] }, (old) => {
        if (!Array.isArray(old)) return old
        return old.map((item) =>
          item.id === orderId
            ? {
                ...item,
                status: 'DISPATCHED',
                dispatchedAt: new Date().toISOString(),
                shipment: {
                  ...(item.shipment || {}),
                  id: item.shipment?.id || 0,
                  orderId: item.id,
                  status: 'CREATED',
                  waybillNumber,
                  courier: courierName,
                  trackingStatus: 'Label generated',
                  errorMessage: null,
                },
              }
            : item
        ) as Order[]
      })
      await queryClient.invalidateQueries({ queryKey: ['orders'] })
    } catch (err: any) {
      toast.toast('error', apiError(err))
    } finally {
      setDispatchingIds((prev) => {
        const next = new Set(prev)
        next.delete(orderId)
        return next
      })
    }
  }

  // Confirm COD action
  const handleConfirmCod = async (orderId: number) => {
    setConfirmingCodId(orderId)
    try {
      const res = await confirmCodOrder(orderId)
      toast.toast('success', res.message || 'Order confirmed and ready for dispatch!')
      await queryClient.invalidateQueries({ queryKey: ['orders'] })
    } catch (err: any) {
      toast.toast('error', apiError(err))
    } finally {
      setConfirmingCodId(null)
    }
  }

  // Cancel order action (triggered from confirmation modal)
  const handleConfirmCancel = async () => {
    if (!orderToCancel) return
    setIsCancelling(true)
    try {
      const res = await cancelOrder(orderToCancel.id, cancelReason)
      toast.toast(res.warning ? 'error' : 'success', res.warning || res.message || `Order ${orderToCancel.shopifyOrderName} cancelled.`)
      setOrderToCancel(null)
      await queryClient.invalidateQueries({ queryKey: ['orders'] })
    } catch (err: any) {
      toast.toast('error', apiError(err))
    } finally {
      setIsCancelling(false)
    }
  }

  // Delete order action (triggered from confirmation modal)
  const handleConfirmDelete = async () => {
    if (!orderToDelete) return
    setIsDeleting(true)
    try {
      const res = await deleteOrder(orderToDelete.id)
      toast.toast('success', res.message || `Order ${orderToDelete.shopifyOrderName} deleted.`)
      setOrderToDelete(null)
      await queryClient.invalidateQueries({ queryKey: ['orders'] })
    } catch (err: any) {
      toast.toast('error', apiError(err))
    } finally {
      setIsDeleting(false)
    }
  }

  // Handle NDR Action confirmation
  // RE-ATTEMPT/RTO go through the order-level flow (internal status + WhatsApp);
  // DEFER_DLV/EDIT_DETAILS call Delhivery's async NDR API directly (returns UPL id).
  const handleConfirmNdr = async () => {
    if (!orderForNdr) return
    setIsSubmittingNdr(true)
    try {
      if (ndrActionType === 'DEFER_DLV' || ndrActionType === 'EDIT_DETAILS') {
        const waybill = orderForNdr.shipment?.waybillNumber
        if (!waybill) throw new Error('No AWB on this order — cannot raise a Delhivery NDR action.')
        if (ndrActionType === 'DEFER_DLV' && !/^\d{4}-\d{2}-\d{2}$/.test(ndrDeferDate)) {
          throw new Error('Pick a deferred date (YYYY-MM-DD, within 6 days).')
        }
        if (ndrActionType === 'EDIT_DETAILS' && !ndrEditPhone.trim() && !ndrEditAddress.trim()) {
          throw new Error('Enter a corrected phone and/or address.')
        }
        const res = await api.post('/api/delhivery/ndr', {
          waybill,
          action: ndrActionType,
          deferredDate: ndrActionType === 'DEFER_DLV' ? ndrDeferDate : undefined,
          phone: ndrActionType === 'EDIT_DETAILS' ? ndrEditPhone.trim() || undefined : undefined,
          address: ndrActionType === 'EDIT_DETAILS' ? ndrEditAddress.trim() || undefined : undefined,
        })
        const uplId = res.data?.uplId
        toast.toast('success', `Delhivery NDR ${ndrActionType} submitted${uplId ? ` · UPL: ${uplId}` : ''}! Check status via AWB Tracking.`)
      } else {
        const res = await handleNdrAction(orderForNdr.id, ndrActionType, ndrNotes)
        toast.toast('success', res.message || 'NDR action recorded successfully!')
      }
      setOrderForNdr(null)
      setNdrNotes('')
      await queryClient.invalidateQueries({ queryKey: ['orders'] })
    } catch (err: any) {
      toast.toast('error', apiError(err))
    } finally {
      setIsSubmittingNdr(false)
    }
  }

  // Handle RTO Auto-Refund (Prepaid via Shopify to Easebuzz/PhonePe) or Restock (COD)
  const handleProcessRtoRefund = async (order: Order) => {
    if (order.paymentMethod === 'COD') {
      try {
        setRefundingOrderId(order.id)
        const res = await processRtoRefund(order.id)
        toast.toast('success', res.message || 'COD Order marked RTO Delivered & Restocked.')
        await queryClient.invalidateQueries({ queryKey: ['orders'] })
      } catch (err: any) {
        toast.toast('error', apiError(err))
      } finally {
        setRefundingOrderId(null)
      }
      return
    }

    const confirmed = window.confirm(
      `Issue automated full refund of ₹${order.totalAmount} for ${order.shopifyOrderName}? Funds will route back through ${order.paymentProvider || order.paymentGateway || 'Easebuzz / PhonePe'}.`
    )
    if (!confirmed) return

    setRefundingOrderId(order.id)
    try {
      const res = await processRtoRefund(order.id)
      toast.toast('success', res.message || 'Auto-refund processed successfully!')
      await queryClient.invalidateQueries({ queryKey: ['orders'] })
    } catch (err: any) {
      toast.toast('error', apiError(err))
    } finally {
      setRefundingOrderId(null)
    }
  }

  // Shopify manual sync action
  const [isSyncingShopify, setIsSyncingShopify] = useState(false)
  const handleSyncShopify = async () => {
    setIsSyncingShopify(true)
    try {
      const res: any = await api.post('/api/orders/sync')
      const count = res.data?.syncedCount ?? res.syncedCount ?? 0
      // Sync also auto-dispatches approved orders from the last 48 hours; say so.
      const dispatched = res.data?.dispatchedCount ?? 0
      toast.toast(
        'success',
        `Synced ${count} orders from Shopify${dispatched > 0 ? ` and auto-dispatched ${dispatched} ready order${dispatched === 1 ? '' : 's'} to Delhivery` : ''}.`
      )
      await queryClient.invalidateQueries({ queryKey: ['orders'] })
    } catch (err: any) {
      toast.toast('error', apiError(err))
    } finally {
      setIsSyncingShopify(false)
    }
  }

  // Delhivery One Channel Sync action
  const [isSyncingChannel, setIsSyncingChannel] = useState(false)
  const handleSyncChannel = async () => {
    setIsSyncingChannel(true)
    try {
      const res = await syncChannelOrders()
      toast.toast('success', `Synchronized ${res.syncedCount} channel orders with Delhivery One!`)
      await queryClient.invalidateQueries({ queryKey: ['orders'] })
    } catch (err: any) {
      toast.toast('error', apiError(err))
    } finally {
      setIsSyncingChannel(false)
    }
  }

  // External Fulfillment & Delhivery ONE Panel AWB Reconciliation action
  const [isSyncingExternal, setIsSyncingExternal] = useState(false)
  const handleSyncExternalFulfillments = async () => {
    setIsSyncingExternal(true)
    try {
      const ids = selectedOrderIds.size ? Array.from(selectedOrderIds) : undefined
      const res = await syncBulkExternalFulfillments(ids)
      toast.toast(
        'success',
        `Reconciled ${res.reconciledCount} external fulfillment(s) from Delhivery ONE / OMS Guru!`
      )
      await queryClient.invalidateQueries({ queryKey: ['orders'] })
    } catch (err: any) {
      toast.toast('error', apiError(err))
    } finally {
      setIsSyncingExternal(false)
    }
  }

  // Keyboard shortcut: '/' focuses the search input
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.key === '/' &&
        document.activeElement !== searchInputRef.current &&
        !(document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement)
      ) {
        e.preventDefault()
        searchInputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  // Extract unique customer states for the State dropdown filter
  const uniqueStates = useMemo(() => {
    const states = new Set<string>()
    for (const o of query.data ?? []) {
      if (o.customerState) states.add(o.customerState.trim())
    }
    return Array.from(states).sort()
  }, [query.data])

  // Filter logic across search (order #, customer, state, city, pincode, waybill, tags, SKU, item title), status, state, and payment streams
  const filtered = useMemo(() => {
    let list = query.data ?? []

    // 1. Channel Filter (Delhivery One Pending AWB + 3-way payment receiving + prepaid urgent dispatch + needs dispatch + SLA delayed + NDR)
    if (channelFilter === 'DELHIVERY_PENDING_AWB') {
      list = list.filter(
        (o) =>
          (!o.shipment?.waybillNumber || isManifestRejected(o)) &&
          o.fulfillmentStatus !== 'fulfilled' &&
          o.status !== 'CANCELLED'
      )
    } else if (channelFilter === 'PREPAID_PENDING' || channelFilter === 'NEEDS_DISPATCH') {
      list = list.filter((o) => isDispatchNeeded(o))
    } else if (channelFilter === 'DELAYED_DISPATCH') {
      list = list.filter(
        (o) =>
          o.isDispatchOverdue ||
          o.dispatchDelayed ||
          (['NEW', 'DISPATCH_PENDING'].includes(o.status) && (o.dispatchOverdueHours ?? 0) > 0)
      )
    } else if (channelFilter === 'NDR') {
      list = list.filter(
        (o) =>
          o.hasNdrException ||
          ['FAILED_DELIVERY', 'RTO_INITIATED'].includes(o.status) ||
          (o.shipment?.trackingStatus && /fail|attempt|undeliver/i.test(o.shipment.trackingStatus))
      )
    } else if (channelFilter === 'COD') {
      list = list.filter((o) => o.paymentMethod === 'COD' || o.shipment?.paymentMode === 'COD')
    } else if (channelFilter === 'GOKWIK') {
      list = list.filter((o) => {
        const gw = (o.paymentGateway || '').toLowerCase()
        const sc = (o.salesChannel || '').toLowerCase()
        const tags = (o.tags || '').toLowerCase()
        return (gw.includes('gokwik') || gw.includes('kwik') || sc.includes('gokwik') || tags.includes('gokwik')) && o.paymentMethod !== 'COD'
      })
    } else if (channelFilter === 'PHONEPE') {
      list = list.filter((o) => {
        const gw = (o.paymentGateway || '').toLowerCase()
        const tags = (o.tags || '').toLowerCase()
        return (gw.includes('phonepe') || gw.includes('phone_pe') || tags.includes('phonepe')) && o.paymentMethod !== 'COD'
      })
    }

    // 2. State Filter
    if (selectedState) {
      list = list.filter(
        (o) => (o.customerState || '').trim().toLowerCase() === selectedState.toLowerCase()
      )
    }

    // 3. Search filter across all order and SKU / product details / tags
    const needle = search.trim().toLowerCase()
    if (!needle) return list

    return list.filter((order) => {
      const topFields = [
        order.shopifyOrderName,
        order.shopifyOrderId,
        order.customerName,
        order.customerPhone,
        order.customerEmail,
        order.customerCity,
        order.customerState,
        order.customerPincode,
        order.salesChannel,
        order.paymentGateway,
        order.tags,
        order.shipment?.waybillNumber,
      ].some((value) => value?.toLowerCase().includes(needle))

      if (topFields) return true

      // Match item SKU, title, variant
      const itemMatch = (order.items || []).some(
        (item) =>
          item.sku?.toLowerCase().includes(needle) ||
          item.title?.toLowerCase().includes(needle) ||
          item.variantTitle?.toLowerCase().includes(needle)
      )

      return itemMatch
    })
  }, [query.data, channelFilter, selectedState, search])

  // Checkbox selection state
  const isAllSelected = filtered.length > 0 && filtered.every((o) => selectedOrderIds.has(o.id))
  const isSomeSelected = filtered.some((o) => selectedOrderIds.has(o.id))

  const handleSelectAll = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.checked) {
      setSelectedOrderIds(new Set(filtered.map((o) => o.id)))
    } else {
      setSelectedOrderIds(new Set())
    }
  }

  const toggleSelectOne = (id: number, e: React.MouseEvent | React.ChangeEvent) => {
    e.stopPropagation()
    const next = new Set(selectedOrderIds)
    if (next.has(id)) {
      next.delete(id)
    } else {
      next.add(id)
    }
    setSelectedOrderIds(next)
  }

  // Summary counts and amounts
  const metrics = useMemo(() => {
    const all = query.data ?? []
    let totalAmt = 0
    let codAmt = 0
    let codCount = 0
    let gokwikAmt = 0
    let gokwikCount = 0
    let phonepeAmt = 0
    let phonepeCount = 0
    let totalShippingCost = 0
    let needsDispatchCount = 0
    let delayedDispatchCount = 0
    let ndrCount = 0
    let pendingAwbCount = 0

    for (const o of all) {
      if (
        (!o.shipment?.waybillNumber || isManifestRejected(o)) &&
        o.fulfillmentStatus !== 'fulfilled' &&
        o.status !== 'CANCELLED'
      ) {
        pendingAwbCount++
      }
      if (isDispatchNeeded(o)) {
        needsDispatchCount++
      }
      if (
        o.isDispatchOverdue ||
        o.dispatchDelayed ||
        (['NEW', 'DISPATCH_PENDING'].includes(o.status) && (o.dispatchOverdueHours ?? 0) > 0)
      ) {
        delayedDispatchCount++
      }
      if (
        o.hasNdrException ||
        ['FAILED_DELIVERY', 'RTO_INITIATED'].includes(o.status) ||
        (o.shipment?.trackingStatus && /fail|attempt|undeliver/i.test(o.shipment.trackingStatus))
      ) {
        ndrCount++
      }

      totalAmt += o.totalAmount || 0
      totalShippingCost += o.estimatedShippingCost || 106.44
      const isCod = o.paymentMethod === 'COD' || o.shipment?.paymentMode === 'COD'
      const gw = (o.paymentGateway || '').toLowerCase()
      const sc = (o.salesChannel || '').toLowerCase()
      const tags = (o.tags || '').toLowerCase()

      if (isCod) {
        codCount++
        codAmt += o.totalAmount || 0
      } else if (gw.includes('gokwik') || gw.includes('kwik') || sc.includes('gokwik') || tags.includes('gokwik')) {
        gokwikCount++
        gokwikAmt += o.totalAmount || 0
      } else if (gw.includes('phonepe') || gw.includes('phone_pe') || tags.includes('phonepe')) {
        phonepeCount++
        phonepeAmt += o.totalAmount || 0
      }
    }

    const avgShippingCost = all.length > 0 ? totalShippingCost / all.length : 0

    return {
      totalCount: all.length,
      totalAmt,
      codCount,
      codAmt,
      gokwikCount,
      gokwikAmt,
      phonepeCount,
      phonepeAmt,
      prepaidPendingCount: needsDispatchCount,
      needsDispatchCount,
      delayedDispatchCount,
      ndrCount,
      pendingAwbCount,
      totalShippingCost,
      avgShippingCost,
    }
  }, [query.data])

  // CSV Report Generator with full details & UTF-8 BOM
  const exportCsv = (ordersToExport: Order[]) => {
    if (!ordersToExport.length) {
      toast.toast('error', 'No orders to export.')
      return
    }

    const headers = [
      'Order Name',
      'Shopify Order ID',
      'Shopify Tags',
      'Order Date',
      'Customer Name',
      'Phone',
      'Email',
      'Address',
      'City',
      'State',
      'Pincode',
      'SKUs',
      'Line Items Details',
      'Items Count',
      'Total Amount (INR)',
      'Payment Method',
      'Payment Gateway',
      'Payment Verified',
      'Sales Channel',
      'Delhivery Waybill',
      'Shipping Zone',
      'AWB Freight Cost (INR)',
      'Order Status',
    ]

    const escapeCsv = (val: any) => {
      if (val === null || val === undefined) return '""'
      const str = String(val).replace(/"/g, '""')
      return `"${str}"`
    }

    const rows = ordersToExport.map((o) => {
      const skus = (o.items || []).map((i) => i.sku || 'N/A').join(', ')
      const itemsDetail = (o.items || [])
        .map((i) => `${i.title} (${i.sku || 'No SKU'}) x${i.quantity}`)
        .join(' | ')
      const itemsCount = (o.items || []).reduce((sum, i) => sum + (i.quantity || 1), 0)

      return [
        escapeCsv(o.shopifyOrderName),
        escapeCsv(o.shopifyOrderId),
        escapeCsv(o.tags || ''),
        escapeCsv(formatDate(o.shopifyCreatedAt || o.createdAt)),
        escapeCsv(o.customerName),
        escapeCsv(o.customerPhone),
        escapeCsv(o.customerEmail || ''),
        escapeCsv(o.customerAddress),
        escapeCsv(o.customerCity),
        escapeCsv(o.customerState),
        escapeCsv(o.customerPincode),
        escapeCsv(skus),
        escapeCsv(itemsDetail),
        escapeCsv(itemsCount),
        escapeCsv(o.totalAmount.toFixed(2)),
        escapeCsv(o.paymentMethod || 'Prepaid'),
        escapeCsv(o.paymentGateway || 'Manual'),
        escapeCsv(o.paymentVerified ? 'Verified' : 'Pending'),
        escapeCsv(o.salesChannel || 'Shopify'),
        escapeCsv(o.shipment?.waybillNumber || 'Unassigned'),
        escapeCsv(o.shippingZoneCode ? `Zone ${o.shippingZoneCode}` : 'Surface Ground'),
        escapeCsv((o.estimatedShippingCost || 106.44).toFixed(2)),
        escapeCsv(o.status),
      ].join(',')
    })

    const csvContent = '\uFEFF' + [headers.join(','), ...rows].join('\r\n')
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.setAttribute('download', `atlas_orders_report_${new Date().toISOString().slice(0, 10)}.csv`)
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)

    toast.toast('success', `Exported ${ordersToExport.length} orders report to CSV.`)
  }

  // Bulk Dispatch action: Processes orders sequentially one-by-one in real-time,
  // moving each successfully manifested order into Ready to Ship immediately,
  // while surfacing individual carrier/Velocity error responses without blocking.
  const handleBulkDispatch = async (courierChoice?: 'Delhivery' | 'Velocity' | 'auto') => {
    const selected = filtered.filter((o) => selectedOrderIds.has(o.id))
    const hasLiveAwb = (o: Order) =>
      Boolean(o.shipment?.waybillNumber) && !['ERROR', 'CANCELLED'].includes(o.shipment?.status || '')
    const candidateOrders = selected.filter(
      (o) => ['NEW', 'DISPATCH_PENDING'].includes(o.status) && isApprovedForDispatch(o) && !hasLiveAwb(o)
    )
    const notEligible = selected.length - candidateOrders.length
    if (!candidateOrders.length) {
      toast.toast(
        'error',
        'None of the selected orders can be dispatched. Only prepaid or confirmed-COD orders without an AWB are dispatched; confirm COD orders first.'
      )
      return
    }

    setIsBulkDispatching(true)
    // Prioritize: Prepaid orders ALWAYS dispatched first (FIFO), then COD (FIFO)
    const prioritizedCandidates = prioritizeOrdersForDispatch(candidateOrders)
    let completedCount = 0
    let failedCount = 0
    let prepaidDispatched = 0
    let codDispatched = 0
    const failures: Array<{ orderId: number; orderName: string; error: string }> = []

    try {
      for (let i = 0; i < prioritizedCandidates.length; i++) {
        const order = prioritizedCandidates[i]
        setBulkDispatchProgress({
          current: i + 1,
          total: prioritizedCandidates.length,
          orderName: order.shopifyOrderName,
          completed: completedCount,
          failed: failedCount,
        })
        setDispatchingIds((prev) => new Set(prev).add(order.id))

        try {
          const res = await api.post(`/api/orders/${order.id}/dispatch`, { courier: courierChoice })
          completedCount++
          const isPrepaid = prepaidOrder(order)
          if (isPrepaid) prepaidDispatched++
          else codDispatched++

          const waybillNumber = res.data.waybillNumber || 'Assigned'
          const courierName = res.data.courier || (courierChoice && courierChoice !== 'auto' ? courierChoice : 'Delhivery')

          // Immediately remove the successfully dispatched order from selected IDs
          setSelectedOrderIds((prev) => {
            const next = new Set(prev)
            next.delete(order.id)
            return next
          })

          // Real-time optimistic update of React Query order cache so the order
          // immediately leaves Dispatch and appears in Ready to Ship!
          queryClient.setQueriesData<Order[]>({ queryKey: ['orders'] }, (old) => {
            if (!Array.isArray(old)) return old
            return old.map((item) =>
              item.id === order.id
                ? {
                    ...item,
                    status: 'DISPATCHED',
                    dispatchedAt: new Date().toISOString(),
                    shipment: {
                      ...(item.shipment || {}),
                      id: item.shipment?.id || 0,
                      orderId: item.id,
                      status: 'CREATED',
                      waybillNumber,
                      courier: courierName,
                      trackingStatus: 'Label generated',
                      errorMessage: null,
                    },
                  }
                : item
            ) as Order[]
          })
        } catch (err: any) {
          failedCount++
          const errorMsg = apiError(err)
          failures.push({ orderId: order.id, orderName: order.shopifyOrderName, error: errorMsg })
          // Surface individual Velocity / carrier error response immediately so user sees what failed in real time
          toast.toast('error', `${order.shopifyOrderName}: ${errorMsg}`)
        } finally {
          setDispatchingIds((prev) => {
            const next = new Set(prev)
            next.delete(order.id)
            return next
          })
        }
      }

      // Re-sync with server state after the full queue has completed
      await queryClient.invalidateQueries({ queryKey: ['orders'] })

      const prioritySummary = completedCount > 0 ? ` (${prepaidDispatched} Prepaid prioritized, ${codDispatched} COD on FIFO)` : ''
      const parts = [`Dispatched ${completedCount} order${completedCount === 1 ? '' : 's'}${prioritySummary} to Ready to Ship.`]
      if (notEligible > 0) parts.push(`${notEligible} not eligible (unconfirmed COD or already manifested) were skipped.`)
      if (failures.length > 0) {
        const shown = failures.slice(0, 3).map((f) => `${f.orderName}: ${f.error}`)
        parts.push(`${failures.length} failed: ${shown.join(' | ')}${failures.length > 3 ? ' …' : ''}`)
      }
      toast.toast(failures.length > 0 ? 'error' : 'success', parts.join(' '))

      // Keep only failed orders selected so they can be fixed and retried
      setSelectedOrderIds(new Set(failures.map((f) => f.orderId)))
    } catch (err: any) {
      toast.toast('error', apiError(err))
    } finally {
      setBulkDispatchProgress(null)
      setIsBulkDispatching(false)
    }
  }

  // Bulk Confirm COD action
  const handleBulkConfirmCod = async () => {
    const candidateOrders = filtered.filter(
      (o) => selectedOrderIds.has(o.id) && !isCodConfirmed(o) && (o.paymentMethod === 'COD' || o.shipment?.paymentMode === 'COD')
    )
    if (!candidateOrders.length) {
      toast.toast('error', 'None of the selected orders are unconfirmed COD orders.')
      return
    }

    setIsBulkConfirmingCod(true)
    let confirmedCount = 0
    let failedCount = 0

    for (const order of candidateOrders) {
      try {
        await confirmCodOrder(order.id)
        confirmedCount++
      } catch (err) {
        failedCount++
      }
    }

    setIsBulkConfirmingCod(false)
    toast.toast('success', `Confirmed ${confirmedCount} COD orders for dispatch.${failedCount > 0 ? ` (${failedCount} failed)` : ''}`)
    setSelectedOrderIds(new Set())
    await queryClient.invalidateQueries({ queryKey: ['orders'] })
  }

  // Bulk Payment Verification action
  const handleBulkVerify = async () => {
    const candidateOrders = filtered.filter((o) => selectedOrderIds.has(o.id) && !o.paymentVerified)
    if (!candidateOrders.length) {
      toast.toast('success', 'All selected orders are already verified.')
      return
    }

    setIsBulkVerifying(true)
    let verifiedCount = 0

    for (const order of candidateOrders) {
      try {
        await api.post(`/api/orders/${order.id}/payment/verify`)
        verifiedCount++
      } catch (err) {
        // ignore
      }
    }

    setIsBulkVerifying(false)
    toast.toast('success', `Verified payments for ${verifiedCount} orders.`)
    await queryClient.invalidateQueries({ queryKey: ['orders'] })
  }

  // Bulk Download Shipping Labels
  const handleBulkDownloadLabels = async () => {
    const ids = Array.from(selectedOrderIds)
    if (!ids.length) return
    setIsBulkGeneratingLabels(true)
    try {
      await downloadBulkLabels(ids)
      toast.toast('success', `Generated 4R shipping labels for ${ids.length} orders!`)
    } catch (err: any) {
      toast.toast('error', err.message || 'Failed to generate bulk shipping labels')
    } finally {
      setIsBulkGeneratingLabels(false)
    }
  }

  // Bulk Download Shipping Labels (Direct File Download - No new tab)
  const [isBulkDownloadingLabelsDirect, setIsBulkDownloadingLabelsDirect] = useState(false)
  const handleBulkDownloadLabelsDirect = async () => {
    const ids = Array.from(selectedOrderIds)
    if (!ids.length) return
    setIsBulkDownloadingLabelsDirect(true)
    try {
      await downloadBulkLabelsDirectFile(ids)
      toast.toast('success', `Downloaded consolidated shipping labels for ${ids.length} orders!`)
    } catch (err: any) {
      toast.toast('error', err.message || 'Failed to download bulk shipping labels')
    } finally {
      setIsBulkDownloadingLabelsDirect(false)
    }
  }

  // Bulk Download Labels + Invoices (Direct File Download - Strictly alternating: Label then Invoice - No new tab)
  const [isBulkDownloadingLabelsAndInvoicesDirect, setIsBulkDownloadingLabelsAndInvoicesDirect] = useState(false)
  const handleBulkDownloadLabelsAndInvoicesDirect = async () => {
    const ids = Array.from(selectedOrderIds)
    if (!ids.length) return
    setIsBulkDownloadingLabelsAndInvoicesDirect(true)
    try {
      await downloadBulkLabelsAndInvoicesDirectFile(ids)
      toast.toast('success', `Downloaded combined Labels + Invoices for ${ids.length} orders (sequenced: Label then Invoice)!`)
    } catch (err: any) {
      toast.toast('error', err.message || 'Failed to download bulk labels and invoices')
    } finally {
      setIsBulkDownloadingLabelsAndInvoicesDirect(false)
    }
  }

  // Bulk Print Labels + Invoices (Preview tab - Strictly alternating: Label then Invoice)
  const [isBulkPrintingLabelsAndInvoices, setIsBulkPrintingLabelsAndInvoices] = useState(false)
  const handleBulkPrintLabelsAndInvoices = async () => {
    const ids = Array.from(selectedOrderIds)
    if (!ids.length) return
    setIsBulkPrintingLabelsAndInvoices(true)
    try {
      await openPrintableBulkLabelsAndInvoices(ids)
      toast.toast('success', `Opened combined Labels + Invoices print preview for ${ids.length} orders!`)
    } catch (err: any) {
      toast.toast('error', err.message || 'Failed to open printable labels and invoices')
    } finally {
      setIsBulkPrintingLabelsAndInvoices(false)
    }
  }

  // Bulk Download GST Invoices — one file per order, sequentially in download mode
  const [invoiceProgress, setInvoiceProgress] = useState<{ done: number; total: number } | null>(null)
  const handleBulkDownloadInvoices = async () => {
    const ids = Array.from(selectedOrderIds)
    if (!ids.length) return
    setIsBulkGeneratingInvoices(true)
    setInvoiceProgress({ done: 0, total: ids.length })
    try {
      const { downloaded, failed } = await downloadBulkInvoices(ids, (done, total) =>
        setInvoiceProgress({ done, total })
      )
      if (failed.length === 0) {
        toast.toast(
          'success',
          `Downloaded ${downloaded}/${ids.length} GST invoices — open each file and Print → Save as PDF.`
        )
      } else {
        toast.toast(
          'error',
          `Downloaded ${downloaded}/${ids.length} invoices. ${failed.length} failed — retry them individually. If the browser blocked multiple downloads, click Allow in the address bar and retry.`
        )
      }
    } catch (err: any) {
      toast.toast('error', err.message || 'Failed to generate bulk invoices')
    } finally {
      setIsBulkGeneratingInvoices(false)
      setInvoiceProgress(null)
    }
  }

  // Bulk Download Complete Pack (ZIP: Picklist + Collated Labels & Invoices + Individual Docs + Manifest CSV)
  const [isBulkDownloadingPackZip, setIsBulkDownloadingPackZip] = useState(false)
  const handleBulkDownloadPackZip = async () => {
    const ids = Array.from(selectedOrderIds)
    if (!ids.length) return
    setIsBulkDownloadingPackZip(true)
    try {
      await downloadBulkPackZip(ids)
      toast.toast('success', `Downloaded complete bulk pack (ZIP) for ${ids.length} orders!`)
    } catch (err: any) {
      toast.toast('error', err.message || 'Failed to download bulk pack ZIP')
    } finally {
      setIsBulkDownloadingPackZip(false)
    }
  }

  // Bulk Download Consolidated Picklist (Direct File Download)
  const [isBulkDownloadingPicklist, setIsBulkDownloadingPicklist] = useState(false)
  const handleBulkDownloadPicklist = async () => {
    const ids = Array.from(selectedOrderIds)
    if (!ids.length) return
    setIsBulkDownloadingPicklist(true)
    try {
      await downloadBulkPicklist(ids)
      toast.toast('success', `Downloaded consolidated SKU picklist for ${ids.length} orders!`)
    } catch (err: any) {
      toast.toast('error', err.message || 'Failed to download picklist')
    } finally {
      setIsBulkDownloadingPicklist(false)
    }
  }

  // Bulk Print Picklist (Preview Tab)
  const [isBulkPrintingPicklist, setIsBulkPrintingPicklist] = useState(false)
  const handleBulkPrintPicklist = async () => {
    const ids = Array.from(selectedOrderIds)
    if (!ids.length) return
    setIsBulkPrintingPicklist(true)
    try {
      await openPrintableBulkPicklist(ids)
      toast.toast('success', `Opened consolidated SKU picklist print preview for ${ids.length} orders!`)
    } catch (err: any) {
      toast.toast('error', err.message || 'Failed to open picklist')
    } finally {
      setIsBulkPrintingPicklist(false)
    }
  }

  // Bulk Download GST Invoices (Single Consolidated File - Direct Download)
  const [isBulkDownloadingInvoicesDirect, setIsBulkDownloadingInvoicesDirect] = useState(false)
  const handleBulkDownloadInvoicesDirect = async () => {
    const ids = Array.from(selectedOrderIds)
    if (!ids.length) return
    setIsBulkDownloadingInvoicesDirect(true)
    try {
      await downloadBulkInvoicesDirectFile(ids)
      toast.toast('success', `Downloaded consolidated GST invoices for ${ids.length} orders!`)
    } catch (err: any) {
      toast.toast('error', err.message || 'Failed to download consolidated invoices')
    } finally {
      setIsBulkDownloadingInvoicesDirect(false)
    }
  }

  // Submit Delhivery Pickup
  const handleSchedulePickup = async () => {
    setIsSubmittingPickup(true)
    try {
      const res = await api.post('/api/delhivery/pickup', {})
      if (res.data?.success) {
        toast.toast('success', res.data.message || 'Pickup scheduled successfully!')
        setShowPickupModal(false)
      } else {
        toast.toast('error', res.data?.message || 'Failed to schedule pickup')
      }
    } catch (err: any) {
      toast.toast('error', apiError(err))
    } finally {
      setIsSubmittingPickup(false)
    }
  }

  const renderPaymentBadge = (order: Order) => {
    const isCod = order.paymentMethod === 'COD' || order.shipment?.paymentMode === 'COD'
    const gw = (order.paymentGateway || '').toLowerCase()
    const sc = (order.salesChannel || '').toLowerCase()
    const agg = (order.paymentAggregator || '').toLowerCase()
    const provider = order.paymentProvider || ''

    if (isCod) {
      const isRemitted = order.shipment?.codRemitted
      const isCollected = order.shipment?.codCollected
      const isVel = isVelocityCourier(order.shipment?.courier, order.shipment?.waybillNumber)
      const courier = isVel ? 'Velocity' : ((order.shipment?.courier || '').toLowerCase().includes('delhivery') ? 'Delhivery' : (order.shipment?.courier || 'Delhivery'))
      const courierLabel = `${courier} COD`

      return (
        <div className="pay-cell">
          <span className="pay-pill is-cod" title="Cash on Delivery order">
            {courier.toLowerCase() === 'delhivery' ? (
              <img src="/logos/delhivery.png" alt="Delhivery" />
            ) : isVel ? (
              <img src="/logos/velocity.svg" alt="Velocity" />
            ) : (
              <span className="pay-dot" />
            )}
            {courierLabel}
          </span>
          <span className={`pay-sub ${isRemitted ? 'is-ok' : isCollected ? 'is-ok' : 'is-warn'}`}>
            {isRemitted
              ? order.paymentReceivedUtr
                ? 'Remitted · UTR recorded'
                : 'Remitted · UTR missing'
              : isCollected
                ? 'Collected at door'
                : 'Collection pending'}
          </span>
        </div>
      )
    }

    if (agg.includes('gokwik') || gw.includes('gokwik') || gw.includes('kwik') || sc.includes('gokwik') || (order.tags || '').toLowerCase().includes('gokwik') || provider.toLowerCase().includes('easebuzz') || gw.toLowerCase().includes('easebuzz')) {
      return (
        <div className="pay-cell">
          <span className="pay-pill is-gokwik" title="GoKwik 1-click checkout via Easebuzz">
            <img src="/logos/gokwik.png" alt="GoKwik" />
            <span className="pay-pill-via">
              (Easebuzz)
            </span>
          </span>
          <span className={`pay-sub ${order.paymentVerified ? 'is-ok' : 'is-warn'}`}>
            {order.paymentVerified ? 'Captured & verified' : 'Verification pending'}
            {order.paymentProviderPaymentId && (
              <span className="pay-ref" title={`Easebuzz Payment ID: ${order.paymentProviderPaymentId}`}>
                {order.paymentProviderPaymentId.length > 10
                  ? `${order.paymentProviderPaymentId.slice(0, 10)}…`
                  : order.paymentProviderPaymentId}
              </span>
            )}
          </span>
        </div>
      )
    }

    if (gw.includes('phonepe') || gw.includes('phone_pe')) {
      return (
        <div className="pay-cell">
          <span className="pay-pill is-phonepe" title="PhonePe payment gateway">
            <span className="pay-dot" />
            PhonePe PG
          </span>
          <span className={`pay-sub ${order.paymentVerified ? 'is-ok' : 'is-warn'}`}>
            {order.paymentVerified ? 'Captured & verified' : 'Verification pending'}
          </span>
        </div>
      )
    }

    return (
      <div className="pay-cell">
        <span className="pay-pill">{order.paymentMethod || 'Prepaid'}</span>
        <span className="pay-sub">{order.paymentGateway || 'Standard gateway'}</span>
      </div>
    )
  }

  return (
    <div className="orders-page">
      <PageIntro
        eyebrow="Order management"
        title="Orders"
        description="Comprehensive order lifecycle, Delhivery dispatch, line item SKUs & imagery, and 3-way payment reconciliation."
      />

      {/* Uniform single-row KPI stat strip — every card shares one typography scale */}
      <div className="kpi-strip" role="group" aria-label="Order payment stream summary">
        <button
          type="button"
          className={`kpi-stat ${channelFilter === 'ALL' ? 'is-active' : ''}`}
          onClick={() => setChannelFilter('ALL')}
          title="Show all orders"
        >
          <span className="kpi-stat-label">All Orders</span>
          <span className="kpi-stat-value">{formatMoney(metrics.totalAmt)}</span>
          <span className="kpi-stat-sub">{metrics.totalCount} orders total</span>
        </button>

        {/* ⚡ Urgent Needs Dispatch (Prepaid & Confirmed COD) */}
        <button
          type="button"
          className={`kpi-stat ${channelFilter === 'NEEDS_DISPATCH' || channelFilter === 'PREPAID_PENDING' ? 'is-active' : ''}`}
          onClick={() => setChannelFilter((channelFilter === 'NEEDS_DISPATCH' || channelFilter === 'PREPAID_PENDING') ? 'ALL' : 'NEEDS_DISPATCH')}
          title="Prepaid & confirmed-COD orders awaiting AWB generation"
        >
          <span className="kpi-stat-label">
            <span className="kpi-dot is-red" /> Needs Dispatch
          </span>
          <span className="kpi-stat-value is-danger">{metrics.needsDispatchCount} pending</span>
          <span className="kpi-stat-sub">Prepaid & confirmed COD</span>
        </button>

        {/* 🛍️ Delhivery One Channel: Pending AWB */}
        <button
          type="button"
          className={`kpi-stat ${channelFilter === 'DELHIVERY_PENDING_AWB' ? 'is-active' : ''}`}
          onClick={() => setChannelFilter(channelFilter === 'DELHIVERY_PENDING_AWB' ? 'ALL' : 'DELHIVERY_PENDING_AWB')}
          title="Shopify channel orders still awaiting a Delhivery AWB"
        >
          <span className="kpi-stat-label">
            <span className="kpi-dot is-green" /> Delhivery Channel
          </span>
          <span className="kpi-stat-value">{metrics.pendingAwbCount} Pending AWB</span>
          <span className="kpi-stat-sub">Shopify: youthnic2024</span>
        </button>

        <button
          type="button"
          className={`kpi-stat ${channelFilter === 'COD' ? 'is-active' : ''}`}
          onClick={() => setChannelFilter(channelFilter === 'COD' ? 'ALL' : 'COD')}
          title="Cash on Delivery orders"
        >
          <span className="kpi-stat-label">Cash on Delivery</span>
          <span className="kpi-stat-value">{formatMoney(metrics.codAmt)}</span>
          <span className="kpi-stat-sub">{metrics.codCount} COD orders</span>
        </button>

        <button
          type="button"
          className={`kpi-stat ${channelFilter === 'GOKWIK' ? 'is-active' : ''}`}
          onClick={() => setChannelFilter(channelFilter === 'GOKWIK' ? 'ALL' : 'GOKWIK')}
          title="GoKwik 1-click prepaid orders"
        >
          <span className="kpi-stat-label">GoKwik Prepaid</span>
          <span className="kpi-stat-value">{formatMoney(metrics.gokwikAmt)}</span>
          <span className="kpi-stat-sub">{metrics.gokwikCount} 1-click orders</span>
        </button>

        <button
          type="button"
          className={`kpi-stat ${channelFilter === 'PHONEPE' ? 'is-active' : ''}`}
          onClick={() => setChannelFilter(channelFilter === 'PHONEPE' ? 'ALL' : 'PHONEPE')}
          title="PhonePe payment gateway orders"
        >
          <span className="kpi-stat-label">PhonePe Prepaid</span>
          <span className="kpi-stat-value">{formatMoney(metrics.phonepeAmt)}</span>
          <span className="kpi-stat-sub">{metrics.phonepeCount} PG orders</span>
        </button>

        {/* ⚠️ SLA Overdue (conditional) */}
        {metrics.delayedDispatchCount > 0 && (
          <button
            type="button"
            className={`kpi-stat ${channelFilter === 'DELAYED_DISPATCH' ? 'is-active' : ''}`}
            onClick={() => setChannelFilter(channelFilter === 'DELAYED_DISPATCH' ? 'ALL' : 'DELAYED_DISPATCH')}
            title="Orders past the 24-hour dispatch SLA"
          >
            <span className="kpi-stat-label">
              <span className="kpi-dot is-red" /> SLA Overdue
            </span>
            <span className="kpi-stat-value is-danger">{metrics.delayedDispatchCount} orders</span>
            <span className="kpi-stat-sub">&gt;24h dispatch SLA</span>
          </button>
        )}

        {/* 🚨 NDR Exceptions (conditional) */}
        {metrics.ndrCount > 0 && (
          <button
            type="button"
            className={`kpi-stat ${channelFilter === 'NDR' ? 'is-active' : ''}`}
            onClick={() => setChannelFilter(channelFilter === 'NDR' ? 'ALL' : 'NDR')}
            title="Non-delivery reports needing action"
          >
            <span className="kpi-stat-label">
              <span className="kpi-dot is-red" /> NDR Exceptions
            </span>
            <span className="kpi-stat-value is-warning">{metrics.ndrCount} failed</span>
            <span className="kpi-stat-sub">Action needed</span>
          </button>
        )}

        {/* AWB logistics cost — informational, not a filter */}
        <div className="kpi-stat kpi-stat-static" title="Total estimated AWB freight across the current order set">
          <span className="kpi-stat-label">AWB Logistics Cost</span>
          <span className="kpi-stat-value">{formatMoney(metrics.totalShippingCost, 'INR')}</span>
          <span className="kpi-stat-sub">avg {formatMoney(metrics.avgShippingCost, 'INR')} / AWB</span>
        </div>
      </div>

      {/* Slim dismissible SLA strip — replaces the old heavy red banner */}
      {metrics.delayedDispatchCount > 0 && !slaDismissed && channelFilter !== 'DELAYED_DISPATCH' && (
        <div className="sla-strip" role="alert">
          <span className="sla-strip-icon">
            <Icon name="alert" size={15} />
          </span>
          <span className="sla-strip-text">
            <strong>{metrics.delayedDispatchCount} order{metrics.delayedDispatchCount > 1 ? 's' : ''} overdue for dispatch</strong>
            {' '}— past the 24h SLA without AWB generation. Expedite to protect delivery timelines.
          </span>
          <button
            type="button"
            className="sla-strip-action"
            onClick={() => setChannelFilter('DELAYED_DISPATCH')}
          >
            View {metrics.delayedDispatchCount} overdue
          </button>
          <button
            type="button"
            className="sla-strip-dismiss"
            onClick={() => setSlaDismissed(true)}
            title="Dismiss warning"
            aria-label="Dismiss SLA warning"
          >
            <Icon name="close" size={12} />
          </button>
        </div>
      )}

      {/* Operational stage tabs — New / Ready to Ship / In Transit / Delivered / Return / Cancel */}
      <div className="analytics-tabs-bar" style={{ marginBottom: '16px', flexWrap: 'wrap' }} role="tablist" aria-label="Order stages">
        {ORDER_TABS.map((tab) => {
          const count = tabCounts[tab.key]
          const isActive = activeTab === tab.key
          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={isActive}
              className={`analytics-tab-btn ${isActive ? 'active' : ''}`}
              onClick={() => setTabAndUrl(tab.key)}
              title={tab.hint}
              style={isActive ? { borderColor: tab.color, color: tab.color } : undefined}
            >
              <span>{tab.label}</span>
              <span className="tab-badge" style={isActive ? { background: tab.color, color: '#fff' } : undefined}>
                {count ?? '…'}
              </span>
            </button>
          )
        })}
      </div>
      <p style={{ margin: '-8px 0 16px', color: '#64748b', fontSize: '13px' }}>
        {ORDER_TABS.find((tab) => tab.key === activeTab)?.hint}
      </p>

      <Panel className="filters-panel">
        <div className="filters-row" style={{ flexWrap: 'wrap', gap: '12px', alignItems: 'center' }}>
          {/* Enhanced Search Bar */}
          <label className="search-field" style={{ minWidth: '280px', flex: 1 }}>
            <Icon name="search" size={18} />
            <input
              ref={searchInputRef}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search by order #, SKU, product, customer, phone, state, or AWB…"
            />
            {search ? (
              <button
                type="button"
                className="search-clear-btn"
                onClick={() => setSearch('')}
                title="Clear search"
              >
                ✕
              </button>
            ) : (
              <span className="search-shortcut" title="Press / to search">/</span>
            )}
          </label>

          <FormField label="Customer State">
            <select
              value={selectedState}
              onChange={(event) => setSelectedState(event.target.value)}
            >
              <option value="">All States ({uniqueStates.length})</option>
              {uniqueStates.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </FormField>

          <FormField label="Stage">
            <select
              value={activeTab}
              onChange={(event) => setTabAndUrl(event.target.value as OrderTabKey)}
              title="Order stage — same as tabs above"
            >
              {ORDER_TABS.map((tab) => (
                <option key={tab.key} value={tab.key}>
                  {tab.label}{tabCounts[tab.key] !== undefined ? ` (${tabCounts[tab.key]})` : ''}
                </option>
              ))}
            </select>
          </FormField>

          {/* Sync Orders from Shopify Button */}
          <button
            type="button"
            className="btn-export"
            style={{ background: '#2563eb', color: '#ffffff', borderColor: '#1d4ed8' }}
            onClick={handleSyncShopify}
            disabled={isSyncingShopify}
            title="Fetch new and historical orders directly from Shopify"
          >
            <Icon name="refresh" size={15} />
            <span>{isSyncingShopify ? 'Syncing Shopify…' : 'Sync Shopify'}</span>
          </button>

          {/* Sync Delhivery Channel Button */}
          <button
            type="button"
            className="btn-export"
            style={{ background: '#059669', color: '#ffffff', borderColor: '#047857' }}
            onClick={handleSyncChannel}
            disabled={isSyncingChannel}
            title="Synchronize all unfulfilled orders with Delhivery One Shopify channel"
          >
            <Icon name="truck" size={15} />
            <span>{isSyncingChannel ? 'Syncing Channel…' : '🛍️ Sync Delhivery Channel'}</span>
          </button>

          {/* Fetch External Fulfillment / Delhivery ONE AWBs Button */}
          <button
            type="button"
            className="btn-export"
            style={{ background: '#7c3aed', color: '#ffffff', borderColor: '#6d28d9' }}
            onClick={handleSyncExternalFulfillments}
            disabled={isSyncingExternal}
            title="Automatically check and fetch fulfillment tracking & carrier for orders manifested via OMS Guru, external apps, or directly in Delhivery ONE panel"
          >
            <Icon name="zap" size={15} />
            <span>{isSyncingExternal ? 'Fetching AWBs…' : '⚡ Fetch External AWBs'}</span>
          </button>

          {/* Download Report Button */}
          <button
            type="button"
            className="btn-export"
            onClick={() => exportCsv(selectedOrderIds.size > 0 ? filtered.filter((o) => selectedOrderIds.has(o.id)) : filtered)}
            title="Download CSV report of orders"
          >
            <Icon name="download" size={15} />
            <span>
              {selectedOrderIds.size > 0
                ? `Export Selected (${selectedOrderIds.size})`
                : `Export Report (${filtered.length})`}
            </span>
          </button>

          <div className="filter-count">
            <strong>{filtered.length}</strong>
            <span>matching orders</span>
          </div>
        </div>
      </Panel>

      {query.isError && <ErrorBox message={apiError(query.error)} />}

      <Panel className="table-panel">
        {query.isLoading ? (
          <LoadingState label="Loading orders with SKUs and images…" />
        ) : filtered.length ? (
          <div className="table-wrap orders-table-wrap">
            <table className="data-table orders-table">
              <thead>
                <tr>
                  <th className="checkbox-cell">
                    <input
                      type="checkbox"
                      className="custom-checkbox"
                      checked={isAllSelected}
                      ref={(el) => {
                        if (el) el.indeterminate = isSomeSelected && !isAllSelected
                      }}
                      onChange={handleSelectAll}
                      title="Select / Deselect all"
                    />
                  </th>
                  <th className="col-order">Order</th>
                  <th className="col-product">Product</th>
                  <th className="col-customer">Customer</th>
                  <th className="col-value">Value & Freight</th>
                  <th className="col-pay">Payment</th>
                  <th className="col-status">Status</th>
                  <th className="col-logistics">Logistics & Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((order) => {
                  const isChecked = selectedOrderIds.has(order.id)
                  const primaryItem = order.items && order.items.length > 0 ? order.items[0] : null
                  const isCodConf = isCodConfirmed(order)
                  const needsDispatch = isDispatchNeeded(order)

                  return (
                    <tr
                      key={order.id}
                      className={`clickable-row ${isChecked ? 'row-selected' : ''}`}
                      onClick={() => navigate(`/orders/${order.id}`)}
                    >
                      <td
                        className="checkbox-cell"
                        onClick={(e) => toggleSelectOne(order.id, e)}
                      >
                        <input
                          type="checkbox"
                          className="custom-checkbox"
                          checked={isChecked}
                          onChange={(e) => toggleSelectOne(order.id, e)}
                        />
                      </td>

                      {/* 1. Order — name, alert flags, date line, one manifest-state pill,
                          hover-reveal extras (RTO risk, Shopify tags) */}
                      <td>
                        <div className="order-cell">
                          <div className="order-cell-top">
                            <a className="order-name">{order.shopifyOrderName}</a>
                            {order.isDispatchOverdue && (
                              <span className="flag-chip is-warning" title={`Overdue for dispatch by ${order.dispatchOverdueHours}h (>24h SLA). Expedite shipping.`}>
                                +{order.dispatchOverdueHours}h
                              </span>
                            )}
                            {(order.hasNdrException || order.status === 'FAILED_DELIVERY') && (
                              <span className="flag-chip is-danger" title="Delivery attempt failed. Action needed with courier / customer.">
                                NDR
                              </span>
                            )}
                            {order.hasUrgentSupport && (
                              <span
                                className="flag-chip is-support"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  navigate(`/support?search=${order.shopifyOrderName}`)
                                }}
                                title={`Urgent customer support inquiry: ${order.supportFlag || 'Action needed'}. Click to view in Support Desk.`}
                              >
                                Support
                              </span>
                            )}
                          </div>
                          <span className="order-cell-sub">
                            {formatDate(order.shopifyCreatedAt || order.createdAt)} · #{order.shopifyOrderId} · Shopify
                          </span>
                          {order.shipment?.status === 'CANCELLED' ? (
                            <span className="order-state-pill is-cancelled" title="Delhivery shipment cancelled by seller">
                              <span className="state-dot" /> Cancelled
                            </span>
                          ) : order.shipment?.status === 'ERROR' ? (
                            <span className="order-state-pill is-failed" title={order.shipment.errorMessage || 'Manifest failed'}>
                              <span className="state-dot" /> Manifest failed
                            </span>
                          ) : order.shipment?.waybillNumber ? (
                            <span className="order-state-pill is-manifested" title={`AWB: ${order.shipment.waybillNumber}`}>
                              <span className="state-dot" /> Manifested
                            </span>
                          ) : order.fulfillmentStatus !== 'fulfilled' && order.status !== 'CANCELLED' ? (
                            <span className="order-state-pill is-pending" title="Pending Delhivery AWB assignment">
                              <span className="state-dot" /> Pending AWB
                            </span>
                          ) : null}
                          <div className="order-cell-extras">
                            {renderRtoRiskBadge(order)}
                            <ShopifyTagList tags={order.tags} />
                          </div>
                        </div>
                      </td>

                      {/* 2. Product Preview & SKU Column */}
                      <td>
                        {primaryItem ? (
                          <div className="order-product-cell">
                            {primaryItem.imageUrl ? (
                              <img
                                src={primaryItem.imageUrl}
                                alt={primaryItem.title}
                                className="product-thumb"
                                loading="lazy"
                              />
                            ) : (
                              <div className="product-thumb-fallback">
                                <Icon name="box" size={18} />
                              </div>
                            )}
                            <div className="product-meta">
                              <span className="product-title" title={primaryItem.title}>
                                {primaryItem.title}
                              </span>
                              <div className="product-sub-row">
                                <span className="sku-badge" title={`SKU: ${primaryItem.sku || 'N/A'}`}>
                                  {primaryItem.sku || 'No SKU'}
                                </span>
                                <span className="qty-tag">x{primaryItem.quantity}</span>
                              </div>
                              {order.items && order.items.length > 1 && (
                                <span className="more-items-badge" title="Multiple items in this order">
                                  +{order.items.length - 1} more item{order.items.length > 2 ? 's' : ''}
                                </span>
                              )}
                            </div>
                          </div>
                        ) : (
                          <span className="cell-muted">No items</span>
                        )}
                      </td>

                      {/* 3. Customer & Destination */}
                      <td>
                        <span className="customer-name" title={order.customerName}>{order.customerName}</span>
                        <span className="customer-sub">{order.customerPhone || 'No phone'}</span>
                        <span className="customer-loc">
                          <Icon name="pin" size={11} />
                          <span>{order.customerCity ? `${order.customerCity}, ` : ''}{order.customerState || 'Other'}</span>
                          <span className="pincode">({order.customerPincode})</span>
                        </span>
                      </td>

                      {/* 4. Order Value & Freight */}
                      <td>
                        <span className="order-value">{formatMoney(order.totalAmount, order.currency)}</span>
                        <div className="order-value-sub">
                          <span>Est. {formatMoney(order.estimatedShippingCost || 106.44, 'INR')}</span>
                          {(order.actualShippingCost && order.actualShippingCost > 0) || (order.shipment?.netBilledCost && order.shipment.netBilledCost > 0) ? (
                            <span
                              className={`billed ${(order.weightDiscrepancy || order.shipment?.weightMismatch) ? 'is-mismatch' : ''}`}
                              title={(order.weightDiscrepancy || order.shipment?.weightMismatch) ? 'Billed freight differs from estimate — weight mismatch flagged' : 'Final billed freight'}
                            >
                              Billed {formatMoney(order.actualShippingCost ?? order.shipment?.netBilledCost ?? 0, 'INR')}
                            </span>
                          ) : null}
                          <span className="zone-tag">
                            {order.shipment?.chargedZone ? `Zone ${order.shipment.chargedZone}` : order.shippingZoneCode ? `Zone ${order.shippingZoneCode}` : 'Surface'}
                          </span>
                        </div>
                      </td>

                      {/* 5. Payment */}
                      <td>{renderPaymentBadge(order)}</td>

                      {/* 6. Status + pickup state (Ready tab: label generated → awaiting pickup vs picked) */}
                      <td>
                        <div className="status-cell">
                          <StatusBadge status={order.status} />
                          {(activeTab === 'ready' || activeTab === 'transit' || activeTab === 'all') && order.shipment?.waybillNumber && (
                            order.shipment?.status === 'CREATED' || /manifest/i.test(order.shipment?.trackingStatus || '') ? (
                              <span className="status-sub" title={`Label generated ${order.shipment?.waybillNumber} — courier has not picked up yet (Delhivery: ${order.shipment?.trackingStatus || 'Manifested'}). Hand over the parcel + refresh tracking.`}>
                                <span className="status-dot is-amber" /> Awaiting pickup
                              </span>
                            ) : ['PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED'].includes(order.shipment?.status || '') ? (
                              <span className="status-sub" title={`Courier picked up ${order.shipment?.waybillNumber}${order.shipment?.trackingLocation ? ` — ${order.shipment.trackingLocation}` : ''}.`}>
                                <span className="status-dot is-green" /> Picked up
                              </span>
                            ) : null
                          )}
                        </div>
                      </td>

                      {/* 7. Logistics — compact pack actions. Extra documents live in More. */}
                      <td>
                        <OrderLogisticsActions
                          order={order}
                          needsDispatch={needsDispatch}
                          isCodConfirmed={isCodConf}
                          dispatching={dispatchingIds.has(order.id)}
                          confirmingCod={confirmingCodId === order.id}
                          refunding={refundingOrderId === order.id}
                          onDispatch={() => handleSingleDispatch(order.id)}
                          onConfirmCod={() => handleConfirmCod(order.id)}
                          onCancel={() => setOrderToCancel(order)}
                          onDelete={() => setOrderToDelete(order)}
                          onNdr={() => setOrderForNdr(order)}
                          onRefund={() => handleProcessRtoRefund(order)}
                          onEmail={() => navigate(`/communications?orderId=${order.id}`)}
                          onChanged={() => queryClient.invalidateQueries({ queryKey: ['orders'] })}
                          toast={toast.toast}
                        />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            title="No matching orders"
            description={
              search || selectedState || channelFilter !== 'ALL'
                ? 'Try a different search term or clear your state/stage filters.'
                : activeTab === 'all'
                  ? 'Orders from Shopify will appear here after your first sync.'
                  : `No orders in “${ORDER_TABS.find((t) => t.key === activeTab)?.label}” stage yet.`
            }
            icon="box"
          />
        )}
        {selectedOrderIds.size > 0 && <div className="bulk-spacer" />}
      </Panel>

      {/* Real-time Bulk Dispatch Floating Progress Banner */}
      {bulkDispatchProgress && (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: 'fixed',
            bottom: '84px',
            right: '24px',
            zIndex: 9999,
            background: 'rgba(15, 23, 42, 0.96)',
            border: '1px solid rgba(139, 92, 246, 0.5)',
            borderRadius: '10px',
            padding: '12px 18px',
            boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.5), 0 0 15px rgba(139, 92, 246, 0.3)',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            minWidth: '320px',
            backdropFilter: 'blur(8px)',
            color: '#f8fafc',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
            <span style={{ fontSize: '13px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span className="kpi-dot is-amber" style={{ width: 8, height: 8 }} />
              Dispatching: {bulkDispatchProgress.orderName}
            </span>
            <span style={{ fontSize: '12px', color: '#a78bfa', fontWeight: 600 }}>
              {bulkDispatchProgress.current} / {bulkDispatchProgress.total}
            </span>
          </div>
          <div style={{ width: '100%', height: '6px', background: 'rgba(255, 255, 255, 0.1)', borderRadius: '3px', overflow: 'hidden' }}>
            <div
              style={{
                width: `${Math.round((bulkDispatchProgress.current / bulkDispatchProgress.total) * 100)}%`,
                height: '100%',
                background: 'linear-gradient(90deg, #8b5cf6 0%, #ec4899 100%)',
                transition: 'width 0.3s ease',
              }}
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#94a3b8' }}>
            <span>Processing real-time &rarr; Ready to Ship</span>
            <span>{bulkDispatchProgress.completed} ready{bulkDispatchProgress.failed > 0 ? ` · ${bulkDispatchProgress.failed} failed` : ''}</span>
          </div>
        </div>
      )}

      {/* Floating Bulk Action Toolbar */}
      {selectedOrderIds.size > 0 && (
        <div className="bulk-action-bar" role="toolbar" aria-label="Bulk actions">
          <span className="bulk-count-badge">{selectedOrderIds.size}</span>
          <span className="bulk-count-label">
            {selectedOrderIds.size === 1 ? 'order' : 'orders'} selected
          </span>

          <span className="bulk-divider" aria-hidden="true" />

          <button
            type="button"
            className="bulk-btn bulk-btn-primary"
            onClick={() => handleBulkDispatch()}
            disabled={isBulkDispatching}
            title="Dispatch selected orders sequentially in real time using carrier priority and automatic routing"
          >
            <Icon name="package" size={15} />
            <span className="bulk-btn-label">
              {bulkDispatchProgress
                ? `Dispatching ${bulkDispatchProgress.current}/${bulkDispatchProgress.total}…`
                : isBulkDispatching
                ? 'Dispatching…'
                : 'Dispatch'}
            </span>
          </button>

          {/* Direct File Download Labels (No new tab) */}
          <button
            type="button"
            className="bulk-btn bulk-btn-secondary"
            onClick={handleBulkDownloadLabelsDirect}
            disabled={isBulkDownloadingLabelsDirect}
            title="Directly download consolidated Delhivery 4R thermal shipping labels as a file without opening in a new tab"
          >
            <Icon name="download" size={15} />
            <span className="bulk-btn-label">{isBulkDownloadingLabelsDirect ? 'Downloading…' : 'DL Labels'}</span>
            <span className="bulk-btn-meta">File</span>
          </button>

          {/* Print Labels (New Tab) */}
          <button
            type="button"
            className="bulk-btn bulk-btn-secondary"
            onClick={handleBulkDownloadLabels}
            disabled={isBulkGeneratingLabels}
            title="Open printable preview tab of Delhivery 4R thermal shipping labels"
          >
            <Icon name="tag" size={15} />
            <span className="bulk-btn-label">{isBulkGeneratingLabels ? 'Generating…' : 'Print Labels'}</span>
            <span className="bulk-btn-meta">4R</span>
          </button>

          {/* Direct File Download Combined Labels + Invoices (Strictly alternating: Label then Invoice - No new tab) */}
          <button
            type="button"
            className="bulk-btn bulk-btn-secondary"
            onClick={handleBulkDownloadLabelsAndInvoicesDirect}
            disabled={isBulkDownloadingLabelsAndInvoicesDirect}
            title="Directly download combined shipping labels and GST invoices (strictly sequenced: Order 1 Label -> Order 1 Invoice -> Order 2 Label -> Order 2 Invoice...) without opening a new tab"
            style={{ background: 'rgba(124, 58, 237, 0.28)', borderColor: 'rgba(196, 181, 253, 0.4)' }}
          >
            <Icon name="download" size={15} />
            <span className="bulk-btn-label">{isBulkDownloadingLabelsAndInvoicesDirect ? 'Downloading…' : 'DL Label+Inv'}</span>
            <span className="bulk-btn-meta">Seq</span>
          </button>

          {/* Print Preview Combined Labels + Invoices (Strictly alternating: Label then Invoice) */}
          <button
            type="button"
            className="bulk-btn bulk-btn-secondary"
            onClick={handleBulkPrintLabelsAndInvoices}
            disabled={isBulkPrintingLabelsAndInvoices}
            title="Open printable tab of combined shipping labels and GST invoices (strictly sequenced: Order 1 Label -> Order 1 Invoice -> Order 2 Label -> Order 2 Invoice...)"
            style={{ background: 'rgba(124, 58, 237, 0.28)', borderColor: 'rgba(196, 181, 253, 0.4)' }}
          >
            <Icon name="tag" size={15} />
            <span className="bulk-btn-label">{isBulkPrintingLabelsAndInvoices ? 'Opening…' : 'Print Label+Inv'}</span>
            <span className="bulk-btn-meta">Seq</span>
          </button>

          <button
            type="button"
            className="bulk-btn bulk-btn-secondary"
            onClick={handleBulkDownloadInvoices}
            disabled={isBulkGeneratingInvoices}
            title="Download one GST invoice file per selected order, sequentially"
          >
            <Icon name="download" size={15} />
            <span className="bulk-btn-label">
              {isBulkGeneratingInvoices && invoiceProgress
                ? `Invoice ${invoiceProgress.done}/${invoiceProgress.total}…`
                : isBulkGeneratingInvoices
                  ? 'Generating…'
                  : 'Invoices'}
            </span>
            <span className="bulk-btn-meta">GST</span>
          </button>

          {/* Direct Bulk Invoices Download (Single combined file, no new tab) */}
          <button
            type="button"
            className="bulk-btn bulk-btn-secondary"
            onClick={handleBulkDownloadInvoicesDirect}
            disabled={isBulkDownloadingInvoicesDirect}
            title="Directly download consolidated GST invoices for all selected orders into a single file without opening a new tab"
          >
            <Icon name="download" size={15} />
            <span className="bulk-btn-label">{isBulkDownloadingInvoicesDirect ? 'Downloading…' : 'DL Invoices'}</span>
            <span className="bulk-btn-meta">File</span>
          </button>

          {/* Consolidated Picklist (Direct File Download) */}
          <button
            type="button"
            className="bulk-btn bulk-btn-secondary"
            onClick={handleBulkDownloadPicklist}
            disabled={isBulkDownloadingPicklist}
            title="Download consolidated SKU picklist for warehouse fulfillment (groups quantities e.g. SKU1=2, SKU2=3)"
            style={{ background: 'rgba(59, 130, 246, 0.25)', borderColor: 'rgba(147, 197, 253, 0.5)' }}
          >
            <Icon name="box" size={15} />
            <span className="bulk-btn-label">{isBulkDownloadingPicklist ? 'Generating…' : 'Picklist'}</span>
            <span className="bulk-btn-meta">SKUs</span>
          </button>

          {/* Complete Bulk Pack (ZIP Archive: Picklist + Collated Labels & Invoices + Individual Docs + Manifest CSV) */}
          <button
            type="button"
            className="bulk-btn bulk-btn-secondary"
            onClick={handleBulkDownloadPackZip}
            disabled={isBulkDownloadingPackZip}
            title="Download complete fulfillment package ZIP (Picklist + Collated Labels & Invoices + Individual folders + Manifest CSV)"
            style={{ background: 'rgba(16, 185, 129, 0.28)', borderColor: 'rgba(110, 231, 183, 0.5)', fontWeight: 700 }}
          >
            <Icon name="package" size={15} />
            <span className="bulk-btn-label">{isBulkDownloadingPackZip ? 'Zipping…' : '📦 Pack (ZIP)'}</span>
            <span className="bulk-btn-meta">All-in-1</span>
          </button>

          {/* Fetch External AWBs (Selected Orders) */}
          <button
            type="button"
            className="bulk-btn bulk-btn-secondary"
            onClick={handleSyncExternalFulfillments}
            disabled={isSyncingExternal}
            title="Automatically fetch tracking IDs & carrier names from OMS Guru / Shopify fulfillments or Delhivery ONE panel"
            style={{ background: 'rgba(124, 58, 237, 0.25)', borderColor: 'rgba(196, 181, 253, 0.5)' }}
          >
            <Icon name="zap" size={15} />
            <span className="bulk-btn-label">{isSyncingExternal ? 'Fetching…' : '⚡ Get AWBs'}</span>
            <span className="bulk-btn-meta">Auto</span>
          </button>

          <button
            type="button"
            className="bulk-btn bulk-btn-secondary"
            onClick={() => setShowPickupModal(true)}
            title="Forward parcels: a warehouse pickup is created automatically after dispatch. Use this to submit the same guarded next-day warehouse batch."
          >
            <Icon name="truck" size={15} />
            <span className="bulk-btn-label">Schedule Pickup</span>
          </button>

          <button
            type="button"
            className="bulk-btn bulk-btn-secondary"
            onClick={handleBulkConfirmCod}
            disabled={isBulkConfirmingCod}
            title="Confirm selected unconfirmed COD orders"
          >
            <Icon name="check" size={15} />
            <span className="bulk-btn-label">{isBulkConfirmingCod ? 'Confirming…' : 'Confirm COD'}</span>
          </button>

          <button
            type="button"
            className="bulk-btn bulk-btn-secondary"
            onClick={() => exportCsv(filtered.filter((o) => selectedOrderIds.has(o.id)))}
            title="Export selected orders as CSV"
          >
            <Icon name="download" size={15} />
            <span className="bulk-btn-label">Export</span>
            <span className="bulk-btn-meta">CSV</span>
          </button>

          <button
            type="button"
            className="bulk-btn bulk-btn-secondary"
            onClick={handleBulkVerify}
            disabled={isBulkVerifying}
            title="Verify payments for selected orders"
          >
            <Icon name="shield" size={15} />
            <span className="bulk-btn-label">{isBulkVerifying ? 'Verifying…' : 'Verify Payments'}</span>
          </button>

          <button
            type="button"
            className="bulk-btn bulk-btn-ghost bulk-btn-icon-only"
            onClick={() => setSelectedOrderIds(new Set())}
            title="Clear selection"
            aria-label="Clear selection"
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      )}

      {/* ─── Delhivery Pickup Scheduling Modal ─── */}
      {showPickupModal && (
        <div className="modal-backdrop" onClick={() => !isSubmittingPickup && setShowPickupModal(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '500px' }}>
            <div className="modal-header">
              <div className="modal-header-left">
                <div className="modal-icon-badge primary" style={{ background: '#e0f2fe', color: '#0284c7' }}>
                  <Icon name="truck" size={20} />
                </div>
                <div>
                  <h3 className="modal-title">Schedule Delhivery Pickup</h3>
                  <p className="modal-desc">Forward warehouse pickup. Delhivery allows one open request per location. Reverse customer pickups are booked when you create a return, not here.</p>
                </div>
              </div>
              <button
                type="button"
                className="modal-close-btn"
                disabled={isSubmittingPickup}
                onClick={() => setShowPickupModal(false)}
              >
                ✕
              </button>
            </div>

            <div className="modal-body">
              <p>Accepted OMS labels are automatically grouped for the next calendar day in Asia/Kolkata. The registered warehouse and slot come from server configuration.</p>
              <p>This submits the warehouse batch of live manifested parcels, not the selected-order count. Picked-up, cancelled, reverse and external shipments are excluded. An existing confirmed batch is reused.</p>
              <p>A response without a confirmed pickup ID is shown for review, never treated as a scheduled pickup.</p>
            </div>

            <div className="modal-footer" style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '12px' }}>
              <button
                type="button"
                className="modal-btn-cancel"
                disabled={isSubmittingPickup}
                onClick={() => setShowPickupModal(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="modal-btn-primary"
                style={{
                  background: '#0284c7',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '6px',
                  padding: '8px 16px',
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
                disabled={isSubmittingPickup}
                onClick={handleSchedulePickup}
              >
                {isSubmittingPickup ? 'Scheduling with Delhivery...' : '🚚 Schedule Pickup'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Cancel Order Confirmation Trigger Modal ─── */}
      {orderToCancel && (
        <div className="modal-backdrop" onClick={() => !isCancelling && setOrderToCancel(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-header-left">
                <div className="modal-icon-badge danger">
                  <Icon name="alert" size={20} />
                </div>
                <div>
                  <h3 className="modal-title">Cancel Order {orderToCancel.shopifyOrderName}</h3>
                  <p className="modal-desc">Review cancellation details before proceeding.</p>
                </div>
              </div>
              <button
                type="button"
                className="modal-close-btn"
                disabled={isCancelling}
                onClick={() => setOrderToCancel(null)}
              >
                <Icon name="close" size={16} />
              </button>
            </div>

            <div className="modal-body">
              <div className="modal-order-summary-box">
                <div className="modal-order-summary-left">
                  <span className="modal-order-name">{orderToCancel.shopifyOrderName} · {orderToCancel.customerName}</span>
                  <span className="modal-order-sub">
                    {orderToCancel.customerCity}, {orderToCancel.customerState} · {orderToCancel.paymentMethod}
                  </span>
                </div>
                <span className="modal-order-amount">{formatMoney(orderToCancel.totalAmount, orderToCancel.currency)}</span>
              </div>

              {orderToCancel.shipment?.waybillNumber && (
                <div className="modal-warning-alert">
                  <Icon name="alert" size={16} />
                  <div>
                    <strong>{orderToCancel.shipment.courier || 'Carrier'} Shipment Active (AWB: {orderToCancel.shipment.waybillNumber})</strong>
                    <div style={{ marginTop: '2px' }}>
                      {orderToCancel.shipment.courier?.toLowerCase() === 'delhivery'
                        ? 'Cancelling this order will automatically trigger a shipment cancellation request to Delhivery.'
                        : `This order is fulfilled via ${orderToCancel.shipment.courier || 'an external carrier'}. Cancelling will update Shopify order status.`}
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
                onClick={() => setOrderToCancel(null)}
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
      {orderToDelete && (
        <div className="modal-backdrop" onClick={() => !isDeleting && setOrderToDelete(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-header-left">
                <div className="modal-icon-badge danger">
                  <Icon name="alert" size={20} />
                </div>
                <div>
                  <h3 className="modal-title">Delete Order {orderToDelete.shopifyOrderName}</h3>
                  <p className="modal-desc">Permanent deletion confirmation</p>
                </div>
              </div>
              <button
                type="button"
                className="modal-close-btn"
                disabled={isDeleting}
                onClick={() => setOrderToDelete(null)}
              >
                <Icon name="close" size={16} />
              </button>
            </div>

            <div className="modal-body">
              <div className="modal-order-summary-box">
                <div className="modal-order-summary-left">
                  <span className="modal-order-name">{orderToDelete.shopifyOrderName} · {orderToDelete.customerName}</span>
                  <span className="modal-order-sub">Status: {orderToDelete.status}</span>
                </div>
                <span className="modal-order-amount">{formatMoney(orderToDelete.totalAmount, orderToDelete.currency)}</span>
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
                onClick={() => setOrderToDelete(null)}
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
      {orderForNdr && (
        <div className="modal-backdrop" onClick={() => !isSubmittingNdr && setOrderForNdr(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-header-left">
                <div className="modal-icon-badge danger">
                  <Icon name="alert" size={20} />
                </div>
                <div>
                  <h3 className="modal-title">NDR Exception: {orderForNdr.shopifyOrderName}</h3>
                  <p className="modal-desc">Delivery attempt failed · Immediate action required</p>
                </div>
              </div>
              <button
                type="button"
                className="modal-close-btn"
                disabled={isSubmittingNdr}
                onClick={() => setOrderForNdr(null)}
              >
                <Icon name="close" size={16} />
              </button>
            </div>

            <div className="modal-body">
              <div className="modal-order-summary-box">
                <div className="modal-order-summary-left">
                  <span className="modal-order-name">{orderForNdr.shopifyOrderName} · {orderForNdr.customerName}</span>
                  <span className="modal-order-sub">
                    {orderForNdr.customerPhone} · {orderForNdr.customerCity}, {orderForNdr.customerState} ({orderForNdr.customerPincode})
                  </span>
                </div>
                <span className="modal-order-amount">{formatMoney(orderForNdr.totalAmount, orderForNdr.currency)}</span>
              </div>

              {orderForNdr.shipment && (
                <div style={{ background: '#fff1f2', border: '1px solid #fecdd3', borderRadius: '8px', padding: '12px', fontSize: '12px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                    <span style={{ fontWeight: 700, color: '#9f1239' }}>
                      Courier Status: {orderForNdr.shipment.courier || 'Delhivery'} (AWB: {orderForNdr.shipment.waybillNumber})
                    </span>
                    <span style={{ fontWeight: 700, color: '#be123c' }}>
                      {orderForNdr.shipment.trackingStatus || 'Failed Delivery Attempt'}
                    </span>
                  </div>
                  <div style={{ color: '#881337', fontSize: '11.5px' }}>
                    Location: {orderForNdr.shipment.trackingLocation || 'Destination Delivery Center'}
                  </div>
                </div>
              )}

              <FormField label="Select NDR Action">
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginTop: '6px' }}>
                  <label
                    style={{
                      border: ndrActionType === 'RE-ATTEMPT' ? '2px solid #2563eb' : '1px solid #cbd5e1',
                      background: ndrActionType === 'RE-ATTEMPT' ? '#eff6ff' : '#ffffff',
                      borderRadius: '8px',
                      padding: '12px',
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="radio"
                      name="ndrAction"
                      value="RE-ATTEMPT"
                      checked={ndrActionType === 'RE-ATTEMPT'}
                      onChange={() => setNdrActionType('RE-ATTEMPT')}
                      style={{ marginRight: '8px' }}
                    />
                    <strong>🔄 Re-attempt Delivery</strong>
                    <p style={{ margin: '4px 0 0 0', fontSize: '11px', color: '#475569' }}>
                      Request Delhivery to re-attempt delivery tomorrow and trigger WhatsApp alert to customer.
                    </p>
                  </label>

                  <label
                    style={{
                      border: ndrActionType === 'DEFER_DLV' ? '2px solid #7c3aed' : '1px solid #cbd5e1',
                      background: ndrActionType === 'DEFER_DLV' ? '#f5f3ff' : '#ffffff',
                      borderRadius: '8px',
                      padding: '12px',
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="radio"
                      name="ndrAction"
                      value="DEFER_DLV"
                      checked={ndrActionType === 'DEFER_DLV'}
                      onChange={() => setNdrActionType('DEFER_DLV')}
                      style={{ marginRight: '8px' }}
                    />
                    <strong>📅 Defer Delivery Date</strong>
                    <p style={{ margin: '4px 0 0 0', fontSize: '11px', color: '#475569' }}>
                      Delhivery async NDR API — deferred date max 6 days out. Returns UPL id.
                    </p>
                  </label>

                  <label
                    style={{
                      border: ndrActionType === 'EDIT_DETAILS' ? '2px solid #059669' : '1px solid #cbd5e1',
                      background: ndrActionType === 'EDIT_DETAILS' ? '#ecfdf5' : '#ffffff',
                      borderRadius: '8px',
                      padding: '12px',
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="radio"
                      name="ndrAction"
                      value="EDIT_DETAILS"
                      checked={ndrActionType === 'EDIT_DETAILS'}
                      onChange={() => setNdrActionType('EDIT_DETAILS')}
                      style={{ marginRight: '8px' }}
                    />
                    <strong>✏️ Correct Phone / Address</strong>
                    <p style={{ margin: '4px 0 0 0', fontSize: '11px', color: '#475569' }}>
                      Push corrected consignee details to Delhivery while package is pending.
                    </p>
                  </label>

                  <label
                    style={{
                      border: ndrActionType === 'RTO' ? '2px solid #dc2626' : '1px solid #cbd5e1',
                      background: ndrActionType === 'RTO' ? '#fef2f2' : '#ffffff',
                      borderRadius: '8px',
                      padding: '12px',
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="radio"
                      name="ndrAction"
                      value="RTO"
                      checked={ndrActionType === 'RTO'}
                      onChange={() => setNdrActionType('RTO')}
                      style={{ marginRight: '8px' }}
                    />
                    <strong>↩️ Return to Origin (RTO)</strong>
                    <p style={{ margin: '4px 0 0 0', fontSize: '11px', color: '#475569' }}>
                      Cancel delivery and return package to Surat warehouse.
                    </p>
                  </label>
                </div>
              </FormField>

              {ndrActionType === 'DEFER_DLV' && (
                <FormField label="Deferred delivery date (max 6 days out)">
                  <input
                    type="date"
                    value={ndrDeferDate}
                    min={new Date().toISOString().slice(0, 10)}
                    max={new Date(Date.now() + 6 * 86400000).toISOString().slice(0, 10)}
                    onChange={(e) => setNdrDeferDate(e.target.value)}
                    disabled={isSubmittingNdr}
                    style={{ width: '100%' }}
                  />
                </FormField>
              )}

              {ndrActionType === 'EDIT_DETAILS' && (
                <>
                  <FormField label="Corrected phone">
                    <input
                      type="text"
                      placeholder="10-digit customer phone"
                      value={ndrEditPhone}
                      onChange={(e) => setNdrEditPhone(e.target.value)}
                      disabled={isSubmittingNdr}
                      style={{ width: '100%' }}
                    />
                  </FormField>
                  <FormField label="Corrected address">
                    <input
                      type="text"
                      placeholder="Full corrected delivery address with pincode"
                      value={ndrEditAddress}
                      onChange={(e) => setNdrEditAddress(e.target.value)}
                      disabled={isSubmittingNdr}
                      style={{ width: '100%' }}
                    />
                  </FormField>
                </>
              )}

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
                onClick={() => setOrderForNdr(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="modal-btn-primary"
                style={{
                  background:
                    ndrActionType === 'RE-ATTEMPT'
                      ? '#2563eb'
                      : ndrActionType === 'DEFER_DLV'
                        ? '#7c3aed'
                        : ndrActionType === 'EDIT_DETAILS'
                          ? '#059669'
                          : '#dc2626',
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
                    ? '🔄 Schedule Re-Attempt'
                    : ndrActionType === 'DEFER_DLV'
                      ? '📅 Defer Delivery'
                      : ndrActionType === 'EDIT_DETAILS'
                        ? '✏️ Push Corrected Details'
                        : '↩️ Mark Return to Origin (RTO)'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}


