import axios from 'axios'
import type {
  CodSummary,
  Order,
  OrderStatus,
  PaymentDetails,
  PaymentSummary,
  ReturnRecord,
} from './types'

export const api = axios.create({ baseURL: '/', headers: { 'Content-Type': 'application/json' } })

api.interceptors.request.use((config) => {
  const token = typeof window !== 'undefined' ? localStorage.getItem('youthnic_firebase_token') : null
  if (token && config.headers) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401 && typeof window !== 'undefined') {
      // Clear expired credentials and route to login
      localStorage.removeItem('youthnic_firebase_token')
      localStorage.removeItem('youthnic_auth_user')
      if (window.location.pathname !== '/login') {
        window.location.href = '/login'
      }
    }
    return Promise.reject(error)
  }
)

export function apiError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const message = error.response?.data?.error
    if (typeof message === 'string') return message
    if (error.message) return error.message
  }
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.'
}

export interface GetOrdersParams {
  status?: OrderStatus | ''
  tab?: string
  gateway?: string
  paymentMethod?: string
  search?: string
  filter?: string
  limit?: number
  offset?: number
}

export async function getOrders(paramsOrStatus?: OrderStatus | '' | GetOrdersParams): Promise<Order[]> {
  const params: Record<string, string> = {}
  if (typeof paramsOrStatus === 'string') {
    if (paramsOrStatus) params.status = paramsOrStatus
  } else if (paramsOrStatus) {
    if (paramsOrStatus.status) params.status = paramsOrStatus.status
    if (paramsOrStatus.tab) params.tab = paramsOrStatus.tab
    if (paramsOrStatus.gateway) params.gateway = paramsOrStatus.gateway
    if (paramsOrStatus.paymentMethod) params.paymentMethod = paramsOrStatus.paymentMethod
    if (paramsOrStatus.search) params.search = paramsOrStatus.search
    if (paramsOrStatus.filter) params.filter = paramsOrStatus.filter
    if (paramsOrStatus.limit) params.limit = String(paramsOrStatus.limit)
    if (paramsOrStatus.offset) params.offset = String(paramsOrStatus.offset)
  }

  const response = await api.get<{ orders: Order[] }>('/api/orders', {
    params: Object.keys(params).length ? params : undefined,
  })
  return response.data.orders
}

export async function getOrderTabCounts(): Promise<Record<string, number> & { byStatus?: Record<string, number> }> {
  const response = await api.get<{ success: boolean; counts: Record<string, number> }>('/api/orders/tab-counts')
  return response.data.counts
}

export async function getOrder(id: string): Promise<Order> {
  const response = await api.get<{ order: Order }>(`/api/orders/${id}`)
  return response.data.order
}

export async function getPayment(id: string): Promise<PaymentDetails> {
  const response = await api.get<{ payment: PaymentDetails }>(`/api/orders/${id}/payment`)
  return response.data.payment
}

export async function getShippingEstimate(id: string, weight?: number): Promise<import('./types').ShippingEstimate> {
  const response = await api.get<import('./types').ShippingEstimate>(`/api/orders/${id}/shipping-estimate`, {
    params: weight ? { weight } : undefined,
  })
  return response.data
}

export async function getReturns(status?: string): Promise<ReturnRecord[]> {
  const response = await api.get<{ returns: ReturnRecord[] }>('/api/returns', {
    params: status ? { status } : undefined,
  })
  return response.data.returns
}

export async function getPaymentSummary(): Promise<PaymentSummary> {
  const response = await api.get<PaymentSummary>('/api/payments/summary')
  return response.data
}

export async function getHealth(): Promise<{ status: string; timestamp: string }> {
  const response = await api.get<{ status: string; timestamp: string }>('/api/health')
  return response.data
}

export async function getCodSummary(): Promise<CodSummary> {
  const response = await api.get<CodSummary>('/api/cod/summary')
  return response.data
}

export async function recordCodRemittance(payload: {
  remittanceRef: string
  remittedAt?: string
  waybills: string[]
  amounts?: Record<string, number>
}): Promise<{ success: boolean; updated: number; notFound: string[] }> {
  const response = await api.post('/api/cod/remittance', payload)
  return response.data
}

export async function importCodRemittanceCsv(payload: {
  csvContent: string
}): Promise<{
  success: boolean
  message: string
  updated: number
  notFound: string[]
  totalAmount: number
}> {
  const response = await api.post('/api/cod/remittance/import', payload)
  return response.data
}

export async function markCodCollected(payload: {
  waybillNumber: string
  collectedAt?: string
}): Promise<{
  success: boolean
  waybillNumber: string
  orderName?: string
  codAmount: number
  codCollected: boolean
}> {
  const response = await api.post('/api/cod/mark-collected', payload)
  return response.data
}

export async function getDashboardStats(): Promise<import('./types').DashboardStats> {
  const response = await api.get<import('./types').DashboardStats>('/api/dashboard/stats')
  return response.data
}

// NOTE: Delhivery wallet/ledger helpers removed 2026-09-28 — no wallet API
// exists (manual CSV removed as not useful). Wallet lives in the ONE panel:
// Finances > Wallet. Per-AWB estimates still come from the live rate API.

export async function confirmCodOrder(orderId: number): Promise<{
  success: boolean
  message: string
  order: import('./types').Order
}> {
  const response = await api.post(`/api/orders/${orderId}/confirm-cod`)
  return response.data
}

export async function cancelOrder(
  orderId: number,
  reason?: string
): Promise<{
  success: boolean
  message: string
  order: import('./types').Order
}> {
  const response = await api.post(`/api/orders/${orderId}/cancel`, { reason })
  return response.data
}

export async function deleteOrder(orderId: number): Promise<{
  success: boolean
  message: string
}> {
  const response = await api.delete(`/api/orders/${orderId}`)
  return response.data
}

export async function processRtoRefund(orderId: number): Promise<{
  success: boolean
  refundId?: string
  message: string
}> {
  const response = await api.post(`/api/orders/${orderId}/rto-refund`)
  return response.data
}

export async function handleNdrAction(
  orderId: number,
  action: 'RE-ATTEMPT' | 'RTO',
  notes?: string
): Promise<{
  success: boolean
  message: string
}> {
  const response = await api.post(`/api/orders/${orderId}/ndr-action`, { action, notes })
  return response.data
}

export type DelhiveryNdrAction = 'RE-ATTEMPT' | 'PICKUP_RESCHEDULE' | 'DEFER_DLV' | 'EDIT_DETAILS'

export async function submitDelhiveryNdr(payload: {
  waybill: string
  action: DelhiveryNdrAction
  deferredDate?: string
  name?: string
  phone?: string
  address?: string
}): Promise<{ success: boolean; uplId?: string; message?: string }> {
  const response = await api.post('/api/delhivery/ndr', payload)
  return response.data
}

export async function getDelhiveryNdrStatus(uplId: string): Promise<any> {
  const response = await api.get(`/api/delhivery/ndr/${encodeURIComponent(uplId)}`)
  return response.data
}

export async function createDelhiveryWarehouse(payload: Record<string, string>): Promise<any> {
  const response = await api.post('/api/delhivery/warehouse', payload)
  return response.data
}

export async function updateDelhiveryWarehouse(payload: Record<string, string>): Promise<any> {
  const response = await api.put('/api/delhivery/warehouse', payload)
  return response.data
}

export async function editDelhiveryShipment(
  waybill: string,
  updates: Partial<{ name: string; phone: string[]; address: string; codAmount: number; weightGrams: number }>
): Promise<any> {
  const response = await api.patch(`/api/delhivery/shipment/${encodeURIComponent(waybill)}`, updates)
  return response.data
}

export async function getAnalyticsReport(): Promise<import('./types').AnalyticsData> {
  const response = await api.get('/api/reports/analytics')
  return response.data
}

export async function getSystemStatus(): Promise<import('./types').SystemStatusData> {
  const response = await api.get<import('./types').SystemStatusData>('/api/settings/system-status')
  return response.data
}

export async function pingIntegrations(): Promise<import('./types').PingResults> {
  const response = await api.post<import('./types').PingResults>('/api/settings/ping')
  return response.data
}

export async function getSystemUsers(): Promise<import('./types').SystemUser[]> {
  const response = await api.get<{ success: boolean; users: import('./types').SystemUser[] }>('/api/settings/users')
  return response.data.users
}

export async function createSystemUser(payload: Partial<import('./types').SystemUser>): Promise<{
  success: boolean
  user: import('./types').SystemUser
  users: import('./types').SystemUser[]
}> {
  const response = await api.post('/api/settings/users', payload)
  return response.data
}

export async function updateSystemUser(
  id: string,
  payload: Partial<import('./types').SystemUser>
): Promise<{
  success: boolean
  user: import('./types').SystemUser
  users: import('./types').SystemUser[]
}> {
  const response = await api.put(`/api/settings/users/${id}`, payload)
  return response.data
}

export async function deleteSystemUser(id: string): Promise<{
  success: boolean
  users: import('./types').SystemUser[]
}> {
  const response = await api.delete(`/api/settings/users/${id}`)
  return response.data
}

export async function setSystemUserPassword(id: string, newPassword: string): Promise<{ success: boolean; message: string }> {
  const response = await api.post(`/api/settings/users/${id}/set-password`, { newPassword })
  return response.data
}

export async function getSystemUserResetLink(id: string): Promise<{ success: boolean; email: string; resetLink: string }> {
  const response = await api.post(`/api/settings/users/${id}/reset-link`)
  return response.data
}

export async function getWebhookSetupStatus(): Promise<any> {
  const response = await api.get('/api/setup/webhooks/status')
  return response.data
}

export async function registerShopifyWebhooks(): Promise<any> {
  const response = await api.post('/api/setup/webhooks')
  return response.data
}

export async function testWhatsAppNotification(payload: {
  phone: string
  trigger?: string
  customMessage?: string
}): Promise<{
  success: boolean
  result: any
}> {
  const response = await api.post('/api/settings/whatsapp/test', payload)
  return response.data
}

export async function sendOrderWhatsAppTrigger(
  orderId: number,
  payload: { trigger?: string; customText?: string }
): Promise<{
  success: boolean
  result: any
  orderId: number
  trigger: string
}> {
  const response = await api.post(`/api/orders/${orderId}/whatsapp-trigger`, payload)
  return response.data
}

// ─── Kapso AI WhatsApp Configuration & Status ────────────
export async function getKapsoStatus(): Promise<import('./types').KapsoStatusData> {
  const response = await api.get<import('./types').KapsoStatusData>('/api/settings/whatsapp/status')
  return response.data
}

export async function updateKapsoConfig(payload: {
  apiKey: string
  phoneNumberId?: string
  senderPhone?: string
}): Promise<{
  success: boolean
  message: string
  ping: import('./types').KapsoStatusData
}> {
  const response = await api.post('/api/settings/whatsapp/config', payload)
  return response.data
}

// ─── Shopify Products & Listings API (A-to-Z Management) ─
export async function getProducts(params?: {
  status?: string
  title?: string
  product_type?: string
  vendor?: string
  limit?: number
  page_info?: string
}): Promise<{
  success: boolean
  products: import('./types').ShopifyProduct[]
  total: number
}> {
  const response = await api.get('/api/products', { params })
  return response.data
}

export async function getProductSummary(): Promise<{
  success: boolean
  summary: import('./types').ProductSummaryData
}> {
  const response = await api.get('/api/products/summary')
  return response.data
}

export async function getProduct(id: string | number): Promise<{
  success: boolean
  product: import('./types').ShopifyProduct
}> {
  const response = await api.get(`/api/products/${id}`)
  return response.data
}

export async function createProduct(payload: import('./types').CreateProductInput): Promise<{
  success: boolean
  product: import('./types').ShopifyProduct
  message: string
}> {
  const response = await api.post('/api/products', payload)
  return response.data
}

export async function updateProduct(
  id: string | number,
  payload: import('./types').UpdateProductInput
): Promise<{
  success: boolean
  product: import('./types').ShopifyProduct
  message: string
}> {
  const response = await api.put(`/api/products/${id}`, payload)
  return response.data
}

export async function deleteProduct(id: string | number): Promise<{
  success: boolean
  message: string
}> {
  const response = await api.delete(`/api/products/${id}`)
  return response.data
}

export async function setProductStatus(
  id: string | number,
  status: 'active' | 'draft' | 'archived'
): Promise<{
  success: boolean
  product: import('./types').ShopifyProduct
  message: string
}> {
  const response = await api.post(`/api/products/${id}/status`, { status })
  return response.data
}

export async function setVariantInventory(payload: {
  inventoryItemId: number
  available: number
  locationId?: number
}): Promise<{
  success: boolean
  available: number
}> {
  const response = await api.post('/api/products/inventory/set', payload)
  return response.data
}

export async function addProductImage(
  productId: string | number,
  src: string,
  alt?: string
): Promise<{
  success: boolean
  image: import('./types').ShopifyProductImage
}> {
  const response = await api.post(`/api/products/${productId}/images`, { src, alt })
  return response.data
}

export async function deleteProductImage(
  productId: string | number,
  imageId: string | number
): Promise<{
  success: boolean
}> {
  const response = await api.delete(`/api/products/${productId}/images/${imageId}`)
  return response.data
}

// ─── Consumer Email Communications & Resend ─────────────

export async function getEmailLogs(params?: {
  page?: number
  limit?: number
  orderId?: number
  templateType?: string
  status?: string
  converted?: boolean
  search?: string
}): Promise<{
  success: boolean
  logs: import('./types').EmailLog[]
  total: number
  page: number
  limit: number
  totalPages: number
}> {
  const response = await api.get('/api/communications/logs', { params })
  return response.data
}

export async function getCommunicationStats(): Promise<{
  success: boolean
  stats: import('./types').CommunicationStats
}> {
  const response = await api.get('/api/communications/stats')
  return response.data
}

export async function getEmailLog(id: number | string): Promise<{
  success: boolean
  log: import('./types').EmailLog
}> {
  const response = await api.get(`/api/communications/logs/${id}`)
  return response.data
}

export async function sendEmailNotification(payload: import('./types').SendEmailPayload): Promise<{
  success: boolean
  mode: string
  logId?: number
  resendId?: string
  recipient: string
  subject: string
  htmlPreview?: string
  message?: string
  error?: string
}> {
  const response = await api.post('/api/communications/send', payload)
  return response.data
}

export async function recordCommunicationConversion(
  id: number | string,
  action?: string
): Promise<{
  success: boolean
  log: import('./types').EmailLog
}> {
  const response = await api.post(`/api/communications/${id}/convert`, { action })
  return response.data
}

export async function getDelayedInTransitShipments(days?: number): Promise<{
  success: boolean
  totalDelayed: number
  unnotifiedCount: number
  thresholdDays: number
  shipments: import('./types').DelayedInTransitShipment[]
}> {
  const response = await api.get('/api/communications/delayed-in-transit', {
    params: days ? { days } : undefined,
  })
  return response.data
}

export async function notifyDelayedInTransit(payload: {
  orderId?: number
  orderIds?: number[]
  revisedDelivery?: string
  delayReason?: string
  customMessage?: string
}): Promise<{
  success: boolean
  totalProcessed: number
  successfulCount: number
  results: any[]
}> {
  const response = await api.post('/api/communications/notify-delayed-transit', payload)
  return response.data
}

export async function getResendStatus(): Promise<import('./types').ResendStatusData> {
  const response = await api.get('/api/settings/resend/status')
  return response.data
}

export async function updateResendConfig(payload: {
  apiKey?: string
  fromEmail?: string
}): Promise<{
  success: boolean
  message: string
  ping: import('./types').ResendStatusData
}> {
  const response = await api.post('/api/settings/resend/config', payload)
  return response.data
}

export async function testResendEmail(payload: {
  to: string
  templateType?: string
}): Promise<{
  success: boolean
  mode: string
  recipient: string
  subject: string
  message?: string
  error?: string
}> {
  const response = await api.post('/api/settings/resend/test', payload)
  return response.data
}

// ─── Customer Support, Inbound Email & Knowledge Base APIs ───────

export async function getSupportDiagnostics(): Promise<import('./types').SupportDiagnosticsData> {
  const response = await api.get('/api/support/diagnostics')
  return response.data
}

export async function getSupportEmails(params?: {
  page?: number
  limit?: number
  urgency?: string
  category?: string
  status?: string
  search?: string
}): Promise<{
  success: boolean
  total: number
  urgentCount: number
  openCount: number
  returnCount: number
  emails: import('./types').InboundEmail[]
}> {
  const response = await api.get('/api/support/emails', { params })
  return response.data
}

export async function ingestInboundEmail(payload: {
  fromEmail: string
  fromName?: string
  subject: string
  bodyText: string
  toEmail?: string
  orderNumber?: string
}): Promise<{
  success: boolean
  ticket: import('./types').InboundEmail
  analysis: any
  message: string
}> {
  const response = await api.post('/api/support/inbound', payload)
  return response.data
}

export async function getSupportEmail(id: number | string): Promise<{
  success: boolean
  email: import('./types').InboundEmail
  customerHistory: import('./types').CustomerHistoryEvent[]
}> {
  const response = await api.get(`/api/support/emails/${id}`)
  return response.data
}

export async function replySupportEmail(
  id: number | string,
  payload: {
    replyText: string
    customSubject?: string
    fromEmail?: string
    resolved?: boolean
    learnPattern?: boolean
    patternKey?: string
  }
): Promise<{
  success: boolean
  ticket: import('./types').InboundEmail
  resendResult: any
  learnedPattern?: any
  message: string
}> {
  const response = await api.post(`/api/support/emails/${id}/reply`, payload)
  return response.data
}

export async function learnKnowledgePattern(
  id: number | string,
  payload: {
    patternKey?: string
    intent?: string
    keywords?: string
    approvedReply?: string
    recommendedUrgency?: string
    suggestedAction?: string
  }
): Promise<{
  success: boolean
  pattern: import('./types').SupportKnowledgePattern
  message: string
}> {
  const response = await api.post(`/api/support/emails/${id}/learn`, payload)
  return response.data
}

export async function getCustomerSupportHistory(key: string): Promise<{
  success: boolean
  key: string
  firebaseEvents: import('./types').CustomerHistoryEvent[]
  localInboundEmails: import('./types').InboundEmail[]
  localOrders: any[]
}> {
  const response = await api.get(`/api/support/customer-history/${encodeURIComponent(key)}`)
  return response.data
}

export async function getKnowledgePatterns(): Promise<{
  success: boolean
  patterns: import('./types').SupportKnowledgePattern[]
}> {
  const response = await api.get('/api/support/knowledge-patterns')
  return response.data
}

// ─── Meta LLM Agent Harness & Memory ──────────────────

export async function analyzeConversationAgent(payload: {
  customerIdentifier: string
  text: string
  channel?: 'EMAIL' | 'WHATSAPP' | 'CHAT'
  subject?: string
  orderNumberHint?: string
  autoExecuteActions?: boolean
}): Promise<{
  success: boolean
  analysis: any
  triggeredActions: any[]
  customerMemory: any
  matchedOrder: any
  message: string
}> {
  const response = await api.post('/api/support/conversation/analyze', payload)
  return response.data
}

export async function getCustomerAgentMemory(customerKey: string): Promise<{
  success: boolean
  memory: any
}> {
  const response = await api.get(`/api/support/agent/memory/${encodeURIComponent(customerKey)}`)
  return response.data
}

export async function getMetaAgentConfig(): Promise<{
  success: boolean
  config: { apiKeySet: boolean; maskedKey: string; model: string; baseUrl: string }
}> {
  const response = await api.get('/api/support/agent/config')
  return response.data
}

export async function updateMetaAgentConfig(payload: {
  apiKey?: string
  model?: string
  baseUrl?: string
}): Promise<{
  success: boolean
  config: { apiKeySet: boolean; maskedKey: string; model: string; baseUrl: string }
  message: string
}> {
  const response = await api.post('/api/support/agent/config', payload)
  return response.data
}

export async function executeAgentAction(payload: {
  customerIdentifier: string
  actionType: string
  orderId?: number
  params?: any
}): Promise<{
  success: boolean
  actionType: string
  result: any
}> {
  const response = await api.post('/api/support/agent/actions/execute', payload)
  return response.data
}

export async function syncOrders(): Promise<{ success: boolean; syncedCount: number; dispatchedCount: number }> {
  const response = await api.post('/api/orders/sync')
  return response.data
}

export async function syncChannelOrders(): Promise<{ success: boolean; syncedCount: number; message?: string }> {
  const response = await api.post('/api/orders/sync-channel')
  return response.data
}

export async function getDelhiveryChannelStatus(): Promise<{
  success: boolean
  channel: {
    name: string
    platform: string
    shopDomain: string
    status: string
    syncStartDate: string
    autoPaymentStatusUpdate: boolean
  }
  stats: {
    totalChannelOrders: number
    pendingAwb: number
    manifested: number
    inTransit: number
  }
}> {
  const response = await api.get('/api/delhivery/channel-status')
  return response.data
}

export function getAuthToken(): string {
  return typeof window !== 'undefined' ? (localStorage.getItem('youthnic_firebase_token') || '') : ''
}

export function getAuthenticatedUrl(path: string): string {
  const token = getAuthToken()
  if (!token) return path
  const separator = path.includes('?') ? '&' : '?'
  return `${path}${separator}token=${encodeURIComponent(token)}`
}

export async function downloadBulkLabels(orderIds: number[]): Promise<void> {
  const response = await api.post('/api/orders/bulk-labels', { orderIds }, { responseType: 'text' })
  const html = response.data
  const printWindow = window.open('', '_blank')
  if (printWindow) {
    printWindow.document.write(html)
    printWindow.document.close()
  } else {
    const blob = new Blob([html], { type: 'text/html' })
    const url = URL.createObjectURL(blob)
    window.open(url, '_blank')
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function filenameFromDisposition(header: string | undefined, fallback: string): string {
  if (header) {
    const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header)
    if (match?.[1]) return decodeURIComponent(match[1].trim())
  }
  return fallback
}

/**
 * Download GST invoices ONE BY ONE in download mode — one file per order ID,
 * in the order selected. Sequential (not parallel) with a short pause so the
 * browser queues each download instead of blocking them, and with zero
 * window.open calls so pop-up blockers can never swallow them.
 *
 * NOTE: invoice files are print-optimized HTML (the backend has no PDF
 * renderer). Each downloaded file opens in the browser → Ctrl/Cmd+P →
 * "Save as PDF". Filenames come from the server (Invoice-<orderName>.html).
 */
export async function downloadBulkInvoices(
  orderIds: number[],
  onProgress?: (done: number, total: number) => void
): Promise<{ downloaded: number; failed: number[] }> {
  const failed: number[] = []
  let downloaded = 0
  for (let i = 0; i < orderIds.length; i++) {
    const id = orderIds[i]
    try {
      const response = await api.get(`/api/orders/${id}/invoice/download`, {
        responseType: 'blob',
      })
      const blob = new Blob([response.data], { type: 'text/html;charset=utf-8' })
      const url = window.URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.setAttribute(
        'download',
        filenameFromDisposition(response.headers?.['content-disposition'], `Invoice-${id}.html`)
      )
      document.body.appendChild(link)
      link.click()
      link.remove()
      // Let the browser finish queuing this download before starting the next.
      await sleep(300)
      window.URL.revokeObjectURL(url)
      downloaded++
    } catch {
      failed.push(id)
    } finally {
      onProgress?.(i + 1, orderIds.length)
    }
    // Stagger files so multi-download permission prompts trigger once, not per file.
    if (i < orderIds.length - 1) await sleep(600)
  }
  return { downloaded, failed }
}

export async function downloadSingleLabelPdf(waybillNumber: string): Promise<void> {
  const response = await api.get(`/api/delhivery/label/${waybillNumber}/download`, {
    responseType: 'blob',
  })
  const blob = new Blob([response.data], { type: 'application/pdf' })
  const url = window.URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.setAttribute('download', `delhivery-label-${waybillNumber}.pdf`)
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.URL.revokeObjectURL(url)
}

export function openPrintableOrderLabel(orderId: number): void {
  window.open(getAuthenticatedUrl(`/api/orders/${orderId}/label`), '_blank')
}

export function openPrintableOrderInvoice(orderId: number): void {
  window.open(getAuthenticatedUrl(`/api/orders/${orderId}/invoice`), '_blank')
}

/**
 * Directly download an order's shipping label as a file (PDF or HTML)
 * WITHOUT opening in a new tab.
 */
export async function downloadOrderLabelFile(orderId: number, waybillNumber?: string): Promise<void> {
  const response = await api.get(`/api/orders/${orderId}/label/download`, {
    responseType: 'blob',
  })
  const rawContentType = response.headers?.['content-type']
  const contentType = typeof rawContentType === 'string' ? rawContentType : 'application/octet-stream'
  const isPdf = contentType.includes('pdf')
  const ext = isPdf ? 'pdf' : 'html'
  const fallbackFilename = waybillNumber
    ? `delhivery-label-${waybillNumber}.${ext}`
    : `delhivery-label-order-${orderId}.${ext}`
  const rawDisposition = response.headers?.['content-disposition']
  const filename = filenameFromDisposition(
    typeof rawDisposition === 'string' ? rawDisposition : undefined,
    fallbackFilename
  )

  const blob = new Blob([response.data], { type: contentType })
  const url = window.URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.setAttribute('download', filename)
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.URL.revokeObjectURL(url)
}

/**
 * Directly download bulk shipping labels as a single consolidated HTML file
 * WITHOUT opening in a new tab.
 */
export async function downloadBulkLabelsDirectFile(orderIds: number[]): Promise<void> {
  const response = await api.post(
    '/api/orders/bulk-labels/download',
    { orderIds },
    { responseType: 'blob' }
  )
  const rawDisposition = response.headers?.['content-disposition']
  const filename = filenameFromDisposition(
    typeof rawDisposition === 'string' ? rawDisposition : undefined,
    `Bulk-Labels-${orderIds.length}-Orders.html`
  )
  const blob = new Blob([response.data], { type: 'text/html;charset=utf-8' })
  const url = window.URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.setAttribute('download', filename)
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.URL.revokeObjectURL(url)
}

/**
 * Open single order's combined Label + Invoice in preview / print tab (label then invoice)
 */
export function openPrintableOrderLabelAndInvoice(orderId: number): void {
  window.open(getAuthenticatedUrl(`/api/orders/${orderId}/label-and-invoice`), '_blank')
}

/**
 * Directly download single order's combined Label + Invoice as a file (label then invoice)
 * WITHOUT opening in a new tab.
 */
export async function downloadSingleLabelAndInvoiceFile(orderId: number, orderName?: string): Promise<void> {
  const response = await api.get(`/api/orders/${orderId}/label-and-invoice/download`, {
    responseType: 'blob',
  })
  const rawDisposition = response.headers?.['content-disposition']
  const filename = filenameFromDisposition(
    typeof rawDisposition === 'string' ? rawDisposition : undefined,
    `Label-Invoice-${orderName ? orderName.replace('#', '') : orderId}.html`
  )
  const blob = new Blob([response.data], { type: 'text/html;charset=utf-8' })
  const url = window.URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.setAttribute('download', filename)
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.URL.revokeObjectURL(url)
}

/**
 * Open multi-order combined Labels + Invoices in preview / print tab
 * (strictly alternating: Order 1 Label -> Order 1 Invoice -> Order 2 Label -> Order 2 Invoice...)
 */
export async function openPrintableBulkLabelsAndInvoices(orderIds: number[]): Promise<void> {
  const response = await api.post(
    '/api/orders/bulk-labels-and-invoices',
    { orderIds },
    { responseType: 'text' }
  )
  const html = response.data
  const printWindow = window.open('', '_blank')
  if (printWindow) {
    printWindow.document.write(html)
    printWindow.document.close()
  } else {
    const blob = new Blob([html], { type: 'text/html' })
    const url = URL.createObjectURL(blob)
    window.open(url, '_blank')
  }
}

/**
 * Directly download multi-order combined Labels + Invoices as a file
 * (strictly alternating: Order 1 Label -> Order 1 Invoice -> Order 2 Label -> Order 2 Invoice...)
 * WITHOUT opening in a new tab.
 */
export async function downloadBulkLabelsAndInvoicesDirectFile(orderIds: number[]): Promise<void> {
  const response = await api.post(
    '/api/orders/bulk-labels-and-invoices/download',
    { orderIds },
    { responseType: 'blob' }
  )
  const rawDisposition = response.headers?.['content-disposition']
  const filename = filenameFromDisposition(
    typeof rawDisposition === 'string' ? rawDisposition : undefined,
    `Bulk-Labels-And-Invoices-${orderIds.length}-Orders.html`
  )
  const blob = new Blob([response.data], { type: 'text/html;charset=utf-8' })
  const url = window.URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.setAttribute('download', filename)
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.URL.revokeObjectURL(url)
}

/**
 * Directly trigger live Delhivery tracking for an order and return fresh tracking & shipment data
 */
export async function syncOrderTrackingLive(orderId: number): Promise<{
  success: boolean
  tracking: any
  shipment: any
}> {
  const response = await api.post(`/api/orders/${orderId}/track`)
  return response.data
}

/**
 * Directly trigger live Delhivery tracking for a waybill number
 */
export async function syncWaybillTrackingLive(waybillNumber: string): Promise<{
  success: boolean
  tracking: any
  shipment: any
}> {
  const response = await api.post(`/api/tracking/${encodeURIComponent(waybillNumber)}/sync`)
  return response.data
}

