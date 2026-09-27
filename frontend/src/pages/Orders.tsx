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
  downloadSingleLabelPdf,
  openPrintableOrderLabel,
  openPrintableOrderInvoice,
} from '../api'
import { ORDER_TABS, tabForStatus, formatDate, formatMoney, labelize, type OrderTabKey } from '../lib'
import { getOrderTabCounts } from '../api'
import { Button, EmptyState, ErrorBox, FormField, Icon, LoadingState, PageIntro, Panel, StatusBadge, useDocumentTitle, useToast } from '../components/UI'
import type { Order, OrderStatus } from '../types'
import { useNavigate, useSearchParams } from 'react-router-dom'

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
  const pm = (order.paymentMethod || '').toLowerCase()
  const gw = (order.paymentGateway || '').toLowerCase()
  const tags = (order.tags || '').toLowerCase()
  return (
    pm === 'pre-paid' ||
    pm === 'prepaid' ||
    gw.includes('gokwik') ||
    gw.includes('phonepe') ||
    tags.includes('prepaid') ||
    tags.includes('gokwik') ||
    tags.includes('upi')
  ) && pm !== 'cod' && !gw.includes('cash')
}

export function isCodConfirmed(order: Order): boolean {
  const tags = (order.tags || '').toLowerCase()
  return (
    tags.includes('cod_confirmed') ||
    tags.includes('cod confirmed') ||
    tags.includes('cod-confirmed') ||
    tags.includes('confirmed')
  )
}

export function isDispatchNeeded(order: Order): boolean {
  if (['CANCELLED', 'DELIVERED', 'SHIPPED', 'RTO_DELIVERED'].includes(order.status)) return false
  if (order.shipment?.waybillNumber && order.shipment?.status !== 'ERROR') return false
  if (!['NEW', 'DISPATCH_PENDING'].includes(order.status) && order.shipment?.status !== 'ERROR') return false

  // 1. Prepaid order needs dispatch
  if (isPrepaidOrder(order)) return true

  // 2. Confirmed COD order needs dispatch
  if (isCodConfirmed(order)) return true

  return false
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
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', flexWrap: 'wrap' }}>
      {tagList.slice(0, 2).map((tag) => {
        const lower = tag.toLowerCase()
        let modifier = 'tag-default'
        if (lower.includes('weight-mismatch') || lower.includes('mismatch')) modifier = 'tag-mismatch'
        else if (lower.includes('rebilled')) modifier = 'tag-rebilled'
        else if (lower.includes('gokwik') || lower.includes('kwik')) modifier = 'tag-gokwik'
        else if (lower.includes('upi')) modifier = 'tag-upi'
        else if (lower.includes('refund') || lower.includes('cancelled')) modifier = 'tag-refund'

        return (
          <span key={tag} className={`shopify-tag-pill ${modifier}`} style={{ fontSize: '9px', padding: '1px 5px', height: '17px', lineHeight: '15px' }} title={`Shopify Tag: ${tag}`}>
            {tag}
          </span>
        )
      })}
      {tagList.length > 2 && (
        <span className="shopify-tag-pill tag-default" style={{ fontSize: '9px', padding: '1px 5px', height: '17px', lineHeight: '15px' }} title={tagList.slice(2).join(', ')}>
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
  const [dispatchingId, setDispatchingId] = useState<number | null>(null)
  const [confirmingCodId, setConfirmingCodId] = useState<number | null>(null)

  // Trigger Modals for Cancel / Delete
  const [orderToCancel, setOrderToCancel] = useState<Order | null>(null)
  const [cancelReason, setCancelReason] = useState<string>('customer')
  const [isCancelling, setIsCancelling] = useState(false)

  const [orderToDelete, setOrderToDelete] = useState<Order | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  // NDR Resolution Modal States
  const [orderForNdr, setOrderForNdr] = useState<Order | null>(null)
  const [ndrActionType, setNdrActionType] = useState<'RE-ATTEMPT' | 'RTO'>('RE-ATTEMPT')
  const [ndrNotes, setNdrNotes] = useState('')
  const [isSubmittingNdr, setIsSubmittingNdr] = useState(false)

  // RTO Auto-Refund action state
  const [refundingOrderId, setRefundingOrderId] = useState<number | null>(null)

  // Multi-select row checkboxes
  const [selectedOrderIds, setSelectedOrderIds] = useState<Set<number>>(new Set())
  const [isBulkDispatching, setIsBulkDispatching] = useState(false)
  const [isBulkVerifying, setIsBulkVerifying] = useState(false)
  const [isBulkConfirmingCod, setIsBulkConfirmingCod] = useState(false)
  const [isBulkGeneratingLabels, setIsBulkGeneratingLabels] = useState(false)
  const [isBulkGeneratingInvoices, setIsBulkGeneratingInvoices] = useState(false)
  const [showPickupModal, setShowPickupModal] = useState(false)
  const [pickupDate, setPickupDate] = useState(() => new Date().toISOString().split('T')[0])
  const [pickupTime, setPickupTime] = useState('14:00:00')
  const [pickupLocation, setPickupLocation] = useState('Surat Warehouse')
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
  const handleSingleDispatch = async (orderId: number) => {
    setDispatchingId(orderId)
    try {
      const res = await api.post(`/api/orders/${orderId}/dispatch`)
      toast.toast('success', `Order dispatched · Delhivery AWB: ${res.data.waybillNumber || 'Assigned'}`)
      await queryClient.invalidateQueries({ queryKey: ['orders'] })
    } catch (err: any) {
      toast.toast('error', apiError(err))
    } finally {
      setDispatchingId(null)
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
      toast.toast('success', res.message || `Order ${orderToCancel.shopifyOrderName} cancelled.`)
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
  const handleConfirmNdr = async () => {
    if (!orderForNdr) return
    setIsSubmittingNdr(true)
    try {
      const res = await handleNdrAction(orderForNdr.id, ndrActionType, ndrNotes)
      toast.toast('success', res.message || 'NDR action recorded successfully!')
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
      toast.toast('success', `Synced ${count} orders from Shopify!`)
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
      list = list.filter((o) => !o.shipment?.waybillNumber && o.fulfillmentStatus !== 'fulfilled' && o.status !== 'CANCELLED')
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
      if (!o.shipment?.waybillNumber && o.fulfillmentStatus !== 'fulfilled' && o.status !== 'CANCELLED') {
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

  // Bulk Dispatch action
  const handleBulkDispatch = async () => {
    const candidateOrders = filtered.filter(
      (o) => selectedOrderIds.has(o.id) && ['NEW', 'DISPATCH_PENDING'].includes(o.status)
    )
    if (!candidateOrders.length) {
      toast.toast('error', 'None of the selected orders are ready for dispatch (must be in NEW or DISPATCH_PENDING status).')
      return
    }

    setIsBulkDispatching(true)
    try {
      const candidateIds = candidateOrders.map((o) => o.id)
      const res: any = await api.post('/api/orders/bulk-dispatch', { orderIds: candidateIds })
      const dispatched = res.data?.dispatched ?? res.dispatched ?? 0
      const failed = res.data?.failed ?? res.failed ?? 0
      toast.toast('success', `Dispatched ${dispatched} order${dispatched > 1 ? 's' : ''} to Delhivery!${failed > 0 ? ` (${failed} skipped/failed)` : ''}`)
      setSelectedOrderIds(new Set())
      await queryClient.invalidateQueries({ queryKey: ['orders'] })
    } catch (err: any) {
      toast.toast('error', apiError(err))
    } finally {
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

  // Bulk Download GST Invoices
  const handleBulkDownloadInvoices = async () => {
    const ids = Array.from(selectedOrderIds)
    if (!ids.length) return
    setIsBulkGeneratingInvoices(true)
    try {
      await downloadBulkInvoices(ids)
      toast.toast('success', `Generated GST tax invoices for ${ids.length} orders!`)
    } catch (err: any) {
      toast.toast('error', err.message || 'Failed to generate bulk invoices')
    } finally {
      setIsBulkGeneratingInvoices(false)
    }
  }

  // Submit Delhivery Pickup
  const handleSchedulePickup = async () => {
    setIsSubmittingPickup(true)
    try {
      const count = selectedOrderIds.size || 1
      const res = await api.post('/api/delhivery/pickup', {
        pickupDate,
        pickupTime,
        packageCount: count,
        pickupLocation,
      })
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
      const courier = order.shipment?.courier || 'Cash'
      const courierLower = courier.toLowerCase()
      const courierLabel = courierLower.includes('cod') ? courier : `${courier} COD`

      return (
        <div className="payment-cell">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', fontWeight: 700, color: '#b45309' }}>
            {courierLower === 'delhivery' ? (
              <img
                src="/logos/delhivery.png"
                alt="Delhivery"
                style={{ height: '11px', maxWidth: '55px', objectFit: 'contain' }}
              />
            ) : (
              <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#f59e0b' }} />
            )}
            {courierLabel}
          </span>
          <span className="cell-muted">
            {isRemitted ? 'Remitted to Bank' : isCollected ? 'Collected at Door' : 'Collection Pending'}
          </span>
        </div>
      )
    }

    if (agg.includes('gokwik') || gw.includes('gokwik') || gw.includes('kwik') || sc.includes('gokwik')) {
      const isEasebuzz = (provider || '').toLowerCase().includes('easebuzz')
      return (
        <div className="payment-cell">
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', fontWeight: 700, color: '#034694' }}>
              <img
                src="/logos/gokwik.png"
                alt="GoKwik"
                style={{ height: '13px', maxWidth: '55px', objectFit: 'contain' }}
              />
            </span>
            {isEasebuzz && (
              <>
                <span style={{ fontSize: '10px', color: '#94a3b8', fontWeight: 600 }}>via</span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', fontWeight: 700, color: '#0f172a' }}>
                  <img
                    src="/logos/easebuzz.png"
                    alt="Easebuzz"
                    style={{ height: '12px', maxWidth: '55px', objectFit: 'contain' }}
                  />
                </span>
              </>
            )}
            {!isEasebuzz && provider && (
              <span style={{ fontSize: '10px', color: '#475569', fontWeight: 600 }}>({provider})</span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '5px', marginTop: '2px' }}>
            <span className={`verified-badge ${order.paymentVerified ? 'verified' : 'unverified'}`}>
              {order.paymentVerified ? 'Captured & Verified' : 'Verification Pending'}
            </span>
            {order.paymentProviderPaymentId && (
              <span
                style={{ fontSize: '9.5px', color: '#64748b', fontFamily: 'monospace' }}
                title={`Easebuzz Payment ID: ${order.paymentProviderPaymentId}`}
              >
                {order.paymentProviderPaymentId.length > 10
                  ? `${order.paymentProviderPaymentId.slice(0, 10)}…`
                  : order.paymentProviderPaymentId}
              </span>
            )}
          </div>
        </div>
      )
    }

    if (gw.includes('phonepe') || gw.includes('phone_pe')) {
      return (
        <div className="payment-cell">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontWeight: 700, color: '#6d28d9' }}>
            <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#8b5cf6' }} />
            PhonePe PG
          </span>
          <span className={`verified-badge ${order.paymentVerified ? 'verified' : 'unverified'}`}>
            {order.paymentVerified ? 'Captured & Verified' : 'Verification Pending'}
          </span>
        </div>
      )
    }

    return (
      <div className="payment-cell">
        <span>{order.paymentMethod || 'Prepaid'}</span>
        <span className="cell-muted">{order.paymentGateway || 'Standard Gateway'}</span>
      </div>
    )
  }

  return (
    <>
      <PageIntro
        eyebrow="Order management"
        title="Orders"
        description="Comprehensive order lifecycle, Delhivery dispatch, line item SKUs & imagery, and 3-way payment reconciliation."
      />

      {/* 3-way money receipt summary chips */}
      <div className="metric-grid" style={{ marginBottom: '16px' }}>
        <div
          className={`metric-card clickable-row ${channelFilter === 'ALL' ? 'selected-metric' : ''}`}
          onClick={() => setChannelFilter('ALL')}
          style={{ cursor: 'pointer', border: channelFilter === 'ALL' ? '2px solid #2f6df6' : undefined }}
        >
          <div className="metric-icon" style={{ background: '#eaf1ff', color: '#2f6df6' }}>
            <Icon name="box" size={19} />
          </div>
          <div>
            <span className="metric-label">All Orders</span>
            <strong>{formatMoney(metrics.totalAmt)}</strong>
            <span className="metric-sub">{metrics.totalCount} orders total</span>
          </div>
        </div>

        {/* ⚡ Urgent Needs Dispatch Filter Chip (Prepaid & Confirmed COD) */}
        <div
          className={`metric-card clickable-row ${channelFilter === 'NEEDS_DISPATCH' || channelFilter === 'PREPAID_PENDING' ? 'selected-metric' : ''}`}
          onClick={() => setChannelFilter((channelFilter === 'NEEDS_DISPATCH' || channelFilter === 'PREPAID_PENDING') ? 'ALL' : 'NEEDS_DISPATCH')}
          style={{
            cursor: 'pointer',
            border: (channelFilter === 'NEEDS_DISPATCH' || channelFilter === 'PREPAID_PENDING') ? '2px solid #ef4444' : '1px solid #fee2e2',
            background: (channelFilter === 'NEEDS_DISPATCH' || channelFilter === 'PREPAID_PENDING') ? '#fef2f2' : '#fff5f5',
          }}
        >
          <div className="metric-icon" style={{ background: '#fee2e2', color: '#dc2626' }}>
            <Icon name="package" size={19} />
          </div>
          <div>
            <span className="metric-label" style={{ color: '#b91c1c', display: 'flex', alignItems: 'center', gap: '5px' }}>
              <span className="pulsing-red-dot" /> ⚡ Needs Dispatch
            </span>
            <strong style={{ color: '#991b1b' }}>{metrics.needsDispatchCount} pending</strong>
            <span className="metric-sub" style={{ color: '#b91c1c' }}>Prepaid & Confirmed COD</span>
          </div>
        </div>

        {/* 🛍️ Delhivery One Channel: Pending AWB Chip */}
        <div
          className={`metric-card clickable-row ${channelFilter === 'DELHIVERY_PENDING_AWB' ? 'selected-metric' : ''}`}
          onClick={() => setChannelFilter(channelFilter === 'DELHIVERY_PENDING_AWB' ? 'ALL' : 'DELHIVERY_PENDING_AWB')}
          style={{
            cursor: 'pointer',
            border: channelFilter === 'DELHIVERY_PENDING_AWB' ? '2px solid #059669' : undefined,
          }}
        >
          <div className="metric-icon" style={{ background: '#ecfdf5', color: '#16a34a' }}>
            <Icon name="truck" size={17} />
          </div>
          <div>
            <span className="metric-label" style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
              <span className="pulsing-green-dot" /> Delhivery Channel
            </span>
            <strong>{metrics.pendingAwbCount} Pending AWB</strong>
            <span className="metric-sub" style={{ color: '#16a34a' }}>Shopify: youthnic2024</span>
          </div>
        </div>

        <div
          className={`metric-card clickable-row ${channelFilter === 'COD' ? 'selected-metric' : ''}`}
          onClick={() => setChannelFilter('COD')}
          style={{ cursor: 'pointer', border: channelFilter === 'COD' ? '2px solid #f59e0b' : undefined }}
        >
          <div className="metric-icon" style={{ background: '#fffbeb', color: '#d97706' }}>
            <Icon name="package" size={19} />
          </div>
          <div>
            <span className="metric-label">Cash on Delivery (COD)</span>
            <strong>{formatMoney(metrics.codAmt)}</strong>
            <span className="metric-sub">{metrics.codCount} COD orders</span>
          </div>
        </div>

        <div
          className={`metric-card clickable-row ${channelFilter === 'GOKWIK' ? 'selected-metric' : ''}`}
          onClick={() => setChannelFilter('GOKWIK')}
          style={{ cursor: 'pointer', border: channelFilter === 'GOKWIK' ? '2px solid #3b82f6' : undefined }}
        >
          <div className="metric-icon" style={{ background: '#eff6ff', color: '#2563eb' }}>
            <Icon name="shield" size={19} />
          </div>
          <div>
            <span className="metric-label">GoKwik Prepaid</span>
            <strong>{formatMoney(metrics.gokwikAmt)}</strong>
            <span className="metric-sub">{metrics.gokwikCount} 1-click orders</span>
          </div>
        </div>

        <div
          className={`metric-card clickable-row ${channelFilter === 'PHONEPE' ? 'selected-metric' : ''}`}
          onClick={() => setChannelFilter('PHONEPE')}
          style={{ cursor: 'pointer', border: channelFilter === 'PHONEPE' ? '2px solid #8b5cf6' : undefined }}
        >
          <div className="metric-icon" style={{ background: '#f5f3ff', color: '#7c3aed' }}>
            <Icon name="check" size={19} />
          </div>
          <div>
            <span className="metric-label">PhonePe Prepaid</span>
            <strong>{formatMoney(metrics.phonepeAmt)}</strong>
            <span className="metric-sub">{metrics.phonepeCount} PG orders</span>
          </div>
        </div>

        {/* 5. Delayed Dispatch SLA Alert Chip */}
        {metrics.delayedDispatchCount > 0 && (
          <div
            className={`metric-card clickable-row ${channelFilter === 'DELAYED_DISPATCH' ? 'selected-metric' : ''}`}
            onClick={() => setChannelFilter(channelFilter === 'DELAYED_DISPATCH' ? 'ALL' : 'DELAYED_DISPATCH')}
            style={{
              cursor: 'pointer',
              border: channelFilter === 'DELAYED_DISPATCH' ? '2px solid #e11d48' : '1px solid #fecdd3',
              background: channelFilter === 'DELAYED_DISPATCH' ? '#ffe4e6' : '#fff1f2',
            }}
          >
            <div className="metric-icon" style={{ background: '#ffe4e6', color: '#e11d48' }}>
              <Icon name="alert" size={19} />
            </div>
            <div>
              <span className="metric-label" style={{ color: '#be123c', display: 'flex', alignItems: 'center', gap: '5px' }}>
                <span className="pulsing-red-dot" /> ⚠️ SLA Overdue
              </span>
              <strong style={{ color: '#9f1239' }}>{metrics.delayedDispatchCount} orders</strong>
              <span className="metric-sub" style={{ color: '#be123c' }}>&gt;24h Dispatch SLA</span>
            </div>
          </div>
        )}

        {/* 6. NDR Exceptions Chip */}
        {metrics.ndrCount > 0 && (
          <div
            className={`metric-card clickable-row ${channelFilter === 'NDR' ? 'selected-metric' : ''}`}
            onClick={() => setChannelFilter(channelFilter === 'NDR' ? 'ALL' : 'NDR')}
            style={{
              cursor: 'pointer',
              border: channelFilter === 'NDR' ? '2px solid #ea580c' : '1px solid #ffedd5',
              background: channelFilter === 'NDR' ? '#ffedd5' : '#fff7ed',
            }}
          >
            <div className="metric-icon" style={{ background: '#ffedd5', color: '#ea580c' }}>
              <Icon name="route" size={19} />
            </div>
            <div>
              <span className="metric-label" style={{ color: '#c2410c', display: 'flex', alignItems: 'center', gap: '5px' }}>
                <span className="pulsing-red-dot" /> 🚨 NDR Exceptions
              </span>
              <strong style={{ color: '#9a3412' }}>{metrics.ndrCount} failed</strong>
              <span className="metric-sub" style={{ color: '#c2410c' }}>Action Needed</span>
            </div>
          </div>
        )}

        {/* 7. AWB Logistics Total Cost Metric */}
        <div className="metric-card" style={{ background: '#f8fafc', border: '1px solid #e2e8f0' }}>
          <div className="metric-icon" style={{ background: '#ecfdf5', color: '#059669' }}>
            <Icon name="truck" size={19} />
          </div>
          <div>
            <span className="metric-label">AWB Logistics Cost</span>
            <strong style={{ color: '#0f172a' }}>{formatMoney(metrics.totalShippingCost, 'INR')}</strong>
            <span className="metric-sub">avg {formatMoney(metrics.avgShippingCost, 'INR')} / AWB</span>
          </div>
        </div>
      </div>

      {/* Delayed Dispatch SLA Warning Banner */}
      {metrics.delayedDispatchCount > 0 && (
        <div className="sla-warning-banner">
          <div className="sla-warning-left">
            <div className="sla-warning-icon">⚠️</div>
            <div>
              <h4 className="sla-warning-title">
                {metrics.delayedDispatchCount} Order{metrics.delayedDispatchCount > 1 ? 's' : ''} Overdue for Dispatch (&gt;24h SLA)
              </h4>
              <p className="sla-warning-desc">
                These orders have exceeded the 24-hour dispatch SLA without Delhivery AWB generation. Expedite dispatch to safeguard customer delivery timelines.
              </p>
            </div>
          </div>
          <button
            type="button"
            className="btn-row-action danger"
            style={{ height: '32px', padding: '0 12px', fontSize: '12px' }}
            onClick={() => setChannelFilter(channelFilter === 'DELAYED_DISPATCH' ? 'ALL' : 'DELAYED_DISPATCH')}
          >
            {channelFilter === 'DELAYED_DISPATCH' ? 'Show All Orders' : `View ${metrics.delayedDispatchCount} Overdue Orders`}
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
              title={tab.key === 'all' ? 'All orders' : `${tab.label}: ${tab.statuses.join(', ')}`}
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
          <div className="table-wrap">
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
                  <th>Order & Date</th>
                  <th>Product & SKU</th>
                  <th>Customer & Destination</th>
                  <th>Order Value & Freight</th>
                  <th>Payment Stream</th>
                  <th>Status</th>
                  <th>Logistics & Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((order) => {
                  const isChecked = selectedOrderIds.has(order.id)
                  const primaryItem = order.items && order.items.length > 0 ? order.items[0] : null
                  const isPrepaid = isPrepaidOrder(order)
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

                      {/* 1. Order & Date */}
                      <td style={{ verticalAlign: 'top', minWidth: '190px' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap' }}>
                            <a className="order-link">{order.shopifyOrderName}</a>
                            {order.isDispatchOverdue && (
                              <span className="sla-delayed-badge" style={{ fontSize: '9px', padding: '1px 5px' }} title={`Overdue for dispatch by ${order.dispatchOverdueHours}h (>24h SLA). Expedite shipping.`}>
                                ⚠️ +{order.dispatchOverdueHours}h
                              </span>
                            )}
                            {(order.hasNdrException || order.status === 'FAILED_DELIVERY') && (
                              <span className="ndr-badge" style={{ fontSize: '9px', padding: '1px 5px' }} title="Delivery attempt failed. Action needed with courier / customer.">
                                🚨 NDR
                              </span>
                            )}
                            {order.hasUrgentSupport && (
                              <span
                                className="sla-delayed-badge"
                                style={{ background: '#fee2e2', color: '#b91c1c', borderColor: '#fca5a5', cursor: 'pointer', fontSize: '9px', padding: '1px 5px' }}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  navigate(`/support?search=${order.shopifyOrderName}`)
                                }}
                                title={`Urgent customer support inquiry: ${order.supportFlag || 'Action needed'}. Click to view in Support Desk.`}
                              >
                                🚨 Support
                              </span>
                            )}
                          </div>
                          <span className="cell-muted" style={{ fontSize: '10.5px', display: 'block', margin: '1px 0 2px' }}>
                            {formatDate(order.shopifyCreatedAt || order.createdAt)} · #{order.shopifyOrderId}
                          </span>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '3px', flexWrap: 'wrap' }}>
                            <span className="micro-badge micro-badge-channel" title="Store: youthnic2024.myshopify.com">
                              🛍️ Shopify
                            </span>
                            {order.shipment?.status === 'CANCELLED' ? (
                              <span className="micro-badge micro-badge-gray" title="Delhivery shipment cancelled by seller">
                                ✕ Cancelled
                              </span>
                            ) : order.shipment?.status === 'ERROR' ? (
                              <span
                                className="micro-badge"
                                style={{ background: '#fee2e2', color: '#991b1b', border: '1px solid #f87171' }}
                                title={order.shipment.errorMessage || 'Manifest failed'}
                              >
                                ⚠️ Manifest Failed
                              </span>
                            ) : order.shipment?.waybillNumber ? (
                              <span className="micro-badge micro-badge-green" title={`AWB: ${order.shipment.waybillNumber}`}>
                                ✓ Manifested
                              </span>
                            ) : order.fulfillmentStatus !== 'fulfilled' && order.status !== 'CANCELLED' ? (
                              <span className="micro-badge micro-badge-blue" title="Pending Delhivery AWB assignment">
                                📦 Pending AWB
                              </span>
                            ) : null}
                            {isPrepaid ? (
                              <span className="micro-badge micro-badge-blue" title="Prepaid order">
                                ⚡ Prepaid
                              </span>
                            ) : (
                              <span className="micro-badge micro-badge-amber" title="Cash on Delivery">
                                COD
                              </span>
                            )}
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

                      {/* 3. Customer & Destination (Merged clean 2-line layout) */}
                      <td>
                        <strong>{order.customerName}</strong>
                        <span className="cell-muted" style={{ fontSize: '11px', display: 'block' }}>{order.customerPhone || 'No phone'}</span>
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', marginTop: '3px', fontSize: '11px', color: '#475569' }}>
                          <Icon name="pin" size={11} />
                          <span>{order.customerCity ? `${order.customerCity}, ` : ''}{order.customerState || 'Other'}</span>
                          <span className="mono" style={{ fontSize: '10px', color: '#64748b' }}>({order.customerPincode})</span>
                        </div>
                      </td>

                      {/* 4. Order Value & Freight (Merged) */}
                      <td>
                        <div className="amount-cell" style={{ fontWeight: 800 }}>{formatMoney(order.totalAmount, order.currency)}</div>
                        <div className="shipping-cost-cell" style={{ marginTop: '2px' }}>
                          <span className="shipping-cost-val" style={{ fontSize: '11px' }}>
                            Est: {formatMoney(order.estimatedShippingCost || 106.44, 'INR')}
                          </span>
                          {(order.actualShippingCost && order.actualShippingCost > 0) || (order.shipment?.netBilledCost && order.shipment.netBilledCost > 0) ? (
                            <span style={{ fontSize: '10px', color: (order.weightDiscrepancy || order.shipment?.weightMismatch) ? '#b91c1c' : '#047857', fontWeight: 750 }}>
                              Billed: {formatMoney(order.actualShippingCost ?? order.shipment?.netBilledCost ?? 0, 'INR')}
                              {(order.weightDiscrepancy || order.shipment?.weightMismatch) ? ' ⚠️' : ''}
                            </span>
                          ) : null}
                          <span className="shipping-zone-tag">
                            {order.shipment?.chargedZone ? `Zone ${order.shipment.chargedZone}` : order.shippingZoneCode ? `Zone ${order.shippingZoneCode}` : 'Surface'}
                          </span>
                        </div>
                      </td>

                      {/* 5. Payment Stream */}
                      <td>{renderPaymentBadge(order)}</td>

                      {/* 6. Status */}
                      <td>
                        <StatusBadge status={order.status} />
                      </td>

                      {/* 7. Logistics & Interactive Actions */}
                      <td className="mono">
                        <div className="actions-cell-stack">
                          {order.shipment?.waybillNumber ? (
                            <>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                                <a
                                  href={
                                    order.shipment.labelUrl ||
                                    (order.shipment.courier?.toLowerCase() === 'ekart'
                                      ? `https://t.proship.in/${order.shipment.waybillNumber}`
                                      : `https://www.delhivery.com/track/package/${order.shipment.waybillNumber}`)
                                  }
                                  target="_blank"
                                  rel="noreferrer"
                                  onClick={(e) => e.stopPropagation()}
                                  style={{ color: '#2563eb', fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '11px' }}
                                  title={`Track on ${order.shipment.courier || 'Carrier'}`}
                                >
                                  {order.shipment.courier?.toLowerCase() === 'delhivery' ? (
                                    <span style={{ display: 'inline-flex', alignItems: 'center', background: '#f8fafc', border: '1px solid #e2e8f0', padding: '1px 5px', borderRadius: '4px' }}>
                                      <img src="/logos/delhivery.png" alt="Delhivery" style={{ height: '9.5px', maxWidth: '45px', objectFit: 'contain' }} />
                                    </span>
                                  ) : (
                                    <span style={{ fontSize: '9.5px', background: '#f1f5f9', padding: '1px 5px', borderRadius: '4px', color: '#475569', fontWeight: 600 }}>
                                      {order.shipment.courier || 'Delhivery'}
                                    </span>
                                  )}
                                  {order.shipment.waybillNumber} ↗
                                </a>
                                {order.shipment.courier?.toLowerCase() === 'delhivery' && (
                                  <button
                                    type="button"
                                    className="btn-label-sm"
                                    onClick={async (e) => {
                                      e.stopPropagation()
                                      try {
                                        await downloadSingleLabelPdf(order.shipment!.waybillNumber!)
                                        toast.toast('success', `Downloaded label for ${order.shipment!.waybillNumber}`)
                                      } catch (err: any) {
                                        toast.toast('error', err.message || 'Failed to download label')
                                      }
                                    }}
                                    title="Download Delhivery label PDF"
                                  >
                                    <Icon name="download" size={11} /> Label
                                  </button>
                                )}
                              </div>
                              <div className="actions-cell-row">
                                {(order.hasNdrException || ['FAILED_DELIVERY', 'RTO_INITIATED'].includes(order.status)) && (
                                  <button
                                    type="button"
                                    className="btn-ndr-action"
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      setOrderForNdr(order)
                                    }}
                                    title="Resolve Delivery Failure / NDR with courier"
                                  >
                                    🚨 Resolve NDR
                                  </button>
                                )}

                                {order.status === 'RTO_DELIVERED' && (
                                  order.paymentMethod !== 'COD' && order.financialStatus !== 'refunded' ? (
                                    <button
                                      type="button"
                                      className="btn-rto-refund"
                                      disabled={refundingOrderId === order.id}
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        handleProcessRtoRefund(order)
                                      }}
                                      title="Auto-refund prepaid order via Easebuzz / PhonePe"
                                    >
                                      {refundingOrderId === order.id ? 'Refunding…' : '💸 Auto-Refund'}
                                    </button>
                                  ) : (
                                    <span style={{ fontSize: '10px', background: '#ecfdf5', color: '#047857', border: '1px solid #a7f3d0', padding: '2px 6px', borderRadius: '4px', fontWeight: 700 }}>
                                      ✓ Restocked
                                    </span>
                                  )
                                )}

                                <button
                                  type="button"
                                  className="btn-row-action"
                                  style={{ color: '#0284c7', borderColor: 'rgba(2,132,199,0.3)', display: 'inline-flex', alignItems: 'center', gap: '3px' }}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    openPrintableOrderLabel(order.id)
                                  }}
                                  title="Print Delhivery 4R Shipping Label"
                                >
                                  🏷️ Label
                                </button>

                                <button
                                  type="button"
                                  className="btn-row-action"
                                  style={{ color: '#059669', borderColor: 'rgba(5,150,105,0.3)', display: 'inline-flex', alignItems: 'center', gap: '3px' }}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    openPrintableOrderInvoice(order.id)
                                  }}
                                  title="Print GST Commercial Tax Invoice"
                                >
                                  🧾 Invoice
                                </button>

                                <button
                                  type="button"
                                  className="btn-row-action"
                                  style={{ color: '#6366f1', borderColor: 'rgba(99,102,241,0.25)', display: 'inline-flex', alignItems: 'center', gap: '3px' }}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    navigate(`/communications?orderId=${order.id}`)
                                  }}
                                  title="Send transit delay, dispatch update, or delivery alert email to customer"
                                >
                                  <Icon name="mail" size={11} /> Email
                                </button>

                                {!['CANCELLED', 'DELIVERED', 'RTO_DELIVERED', 'REFUNDED'].includes(order.status) && (
                                  <button
                                    type="button"
                                    className="btn-row-action danger"
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      setOrderToCancel(order)
                                    }}
                                    title="Cancel order and trigger Delhivery cancellation"
                                  >
                                    ✕ Cancel
                                  </button>
                                )}
                              </div>
                            </>
                          ) : (
                            <>
                              {order.shipment?.status === 'ERROR' && order.shipment.errorMessage && (
                                <div
                                  style={{
                                    fontSize: '10px',
                                    color: '#991b1b',
                                    background: '#fef2f2',
                                    padding: '3px 6px',
                                    borderRadius: '4px',
                                    border: '1px solid #fecaca',
                                    marginBottom: '4px',
                                    lineHeight: '1.25',
                                    maxWidth: '220px',
                                    wordBreak: 'break-word',
                                  }}
                                  title={order.shipment.errorMessage}
                                >
                                  ⚠️ <strong>Manifest Failed:</strong>{' '}
                                  {order.shipment.errorMessage.includes('insufficient balance')
                                    ? 'Low Delhivery Wallet Balance (Recharge wallet)'
                                    : order.shipment.errorMessage}
                                </div>
                              )}
                              <div className="actions-cell-row">
                                {(order.hasNdrException || ['FAILED_DELIVERY', 'RTO_INITIATED'].includes(order.status)) && (
                                  <button
                                    type="button"
                                    className="btn-ndr-action"
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      setOrderForNdr(order)
                                    }}
                                    title="Resolve Delivery Failure / NDR"
                                  >
                                    🚨 Resolve NDR
                                  </button>
                                )}

                                {order.status === 'RTO_DELIVERED' && (
                                  order.paymentMethod !== 'COD' && order.financialStatus !== 'refunded' ? (
                                    <button
                                      type="button"
                                      className="btn-rto-refund"
                                      disabled={refundingOrderId === order.id}
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        handleProcessRtoRefund(order)
                                      }}
                                      title="Auto-refund prepaid order via Easebuzz / PhonePe"
                                    >
                                      {refundingOrderId === order.id ? 'Refunding…' : '💸 Auto-Refund'}
                                    </button>
                                  ) : (
                                    <span style={{ fontSize: '10px', background: '#ecfdf5', color: '#047857', border: '1px solid #a7f3d0', padding: '2px 6px', borderRadius: '4px', fontWeight: 700 }}>
                                      ✓ Restocked
                                    </span>
                                  )
                                )}

                                {needsDispatch ? (
                                  <button
                                    type="button"
                                    className="prepaid-dispatch-btn"
                                    disabled={dispatchingId === order.id}
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      handleSingleDispatch(order.id)
                                    }}
                                    title="Create Delhivery shipment & trigger fulfillment on Shopify"
                                  >
                                    <Icon name="package" size={13} />
                                    {dispatchingId === order.id ? 'Booking…' : '⚡ Dispatch'}
                                  </button>
                                ) : (!isCodConf && ['NEW', 'DISPATCH_PENDING'].includes(order.status)) ? (
                                  <button
                                    type="button"
                                    className="btn-confirm-cod-sm"
                                    disabled={confirmingCodId === order.id}
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      handleConfirmCod(order.id)
                                    }}
                                    title="Verify COD buyer intent and move to Needs Dispatch queue"
                                  >
                                    <Icon name="check" size={13} />
                                    {confirmingCodId === order.id ? 'Confirming…' : '✓ Confirm COD'}
                                  </button>
                                ) : null}

                                <button
                                  type="button"
                                  className="btn-row-action"
                                  style={{ color: '#6366f1', borderColor: 'rgba(99,102,241,0.25)', display: 'inline-flex', alignItems: 'center', gap: '3px' }}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    navigate(`/communications?orderId=${order.id}`)
                                  }}
                                  title="Send transit delay, dispatch update, or delivery alert email to customer"
                                >
                                  <Icon name="mail" size={11} /> Email
                                </button>

                                {!['CANCELLED', 'REFUNDED'].includes(order.status) && (
                                  <button
                                    type="button"
                                    className="btn-row-action danger"
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      setOrderToCancel(order)
                                    }}
                                    title="Cancel order"
                                  >
                                    ✕ Cancel
                                  </button>
                                )}

                                {order.status === 'CANCELLED' && (
                                  <button
                                    type="button"
                                    className="btn-row-action danger"
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      setOrderToDelete(order)
                                    }}
                                    title="Permanently delete cancelled order"
                                  >
                                    🗑️ Delete
                                  </button>
                                )}
                              </div>
                            </>
                          )}
                        </div>
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
        {selectedOrderIds.size > 0 && <div style={{ height: '90px', transition: 'height 0.2s ease' }} />}
      </Panel>

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
            onClick={handleBulkDispatch}
            disabled={isBulkDispatching}
            title="Create Delhivery shipments for all selected orders"
          >
            <Icon name="package" size={15} />
            <span className="bulk-btn-label">{isBulkDispatching ? 'Dispatching…' : 'Dispatch'}</span>
          </button>

          <button
            type="button"
            className="bulk-btn bulk-btn-secondary"
            onClick={handleBulkDownloadLabels}
            disabled={isBulkGeneratingLabels}
            title="Download consolidated Delhivery 4R thermal shipping labels"
          >
            <Icon name="tag" size={15} />
            <span className="bulk-btn-label">{isBulkGeneratingLabels ? 'Generating…' : 'Labels'}</span>
            <span className="bulk-btn-meta">4R</span>
          </button>

          <button
            type="button"
            className="bulk-btn bulk-btn-secondary"
            onClick={handleBulkDownloadInvoices}
            disabled={isBulkGeneratingInvoices}
            title="Download consolidated GST tax invoices"
          >
            <Icon name="download" size={15} />
            <span className="bulk-btn-label">{isBulkGeneratingInvoices ? 'Generating…' : 'Invoices'}</span>
            <span className="bulk-btn-meta">GST</span>
          </button>

          <button
            type="button"
            className="bulk-btn bulk-btn-secondary"
            onClick={() => setShowPickupModal(true)}
            title="Schedule Delhivery courier pickup from Surat Warehouse"
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
                  <p className="modal-desc">Request courier dispatch from your registered fulfillment location.</p>
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

            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 700, marginBottom: '4px', color: '#475569' }}>
                  Pickup Warehouse Location
                </label>
                <input
                  type="text"
                  className="search-input"
                  style={{ width: '100%', padding: '8px 12px' }}
                  value={pickupLocation}
                  onChange={(e) => setPickupLocation(e.target.value)}
                  placeholder="e.g. Surat Warehouse"
                />
                <span style={{ fontSize: '11px', color: '#64748b', marginTop: '2px', display: 'block' }}>
                  Must match the registered pickup location name in Delhivery ONE.
                </span>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 700, marginBottom: '4px', color: '#475569' }}>
                    Pickup Date
                  </label>
                  <input
                    type="date"
                    className="search-input"
                    style={{ width: '100%', padding: '8px 12px' }}
                    value={pickupDate}
                    onChange={(e) => setPickupDate(e.target.value)}
                  />
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 700, marginBottom: '4px', color: '#475569' }}>
                    Pickup Slot Time
                  </label>
                  <input
                    type="text"
                    className="search-input"
                    style={{ width: '100%', padding: '8px 12px' }}
                    value={pickupTime}
                    onChange={(e) => setPickupTime(e.target.value)}
                    placeholder="14:00:00"
                  />
                </div>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 700, marginBottom: '4px', color: '#475569' }}>
                  Expected Package Count
                </label>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <input
                    type="number"
                    min={1}
                    className="search-input"
                    style={{ width: '120px', padding: '8px 12px' }}
                    value={selectedOrderIds.size || 1}
                    readOnly
                  />
                  <span style={{ fontSize: '12px', color: '#64748b' }}>
                    Based on {selectedOrderIds.size || 1} selected order{selectedOrderIds.size > 1 ? 's' : ''}.
                  </span>
                </div>
              </div>

              <div style={{ background: '#f8fafc', padding: '10px 12px', borderRadius: '6px', border: '1px solid #e2e8f0', fontSize: '11px', color: '#475569' }}>
                ℹ️ <strong>Delhivery Surface Express:</strong> Pickup is scheduled for your warehouse address at HTC Market - 1, Surat. The courier van will arrive to collect ready parcels.
              </div>
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
                  ? '🔄 Schedule Re-Attempt'
                  : '↩️ Mark Return to Origin (RTO)'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}


