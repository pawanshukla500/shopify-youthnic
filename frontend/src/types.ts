export type OrderStatus =
  | 'NEW'
  | 'DISPATCH_PENDING'
  | 'DISPATCHED'
  | 'SHIPPED'
  | 'IN_TRANSIT'
  | 'OUT_FOR_DELIVERY'
  | 'DELIVERED'
  | 'FAILED_DELIVERY'
  | 'RTO_INITIATED'
  | 'RTO_DELIVERED'
  | 'RETURN_REQUESTED'
  | 'RETURN_DISPATCHED'
  | 'RETURN_RECEIVED'
  | 'REFUNDED'
  | 'CANCELLED'

export type ShipmentStatus =
  | 'PENDING'
  | 'CREATED'
  | 'PICKED_UP'
  | 'IN_TRANSIT'
  | 'OUT_FOR_DELIVERY'
  | 'DELIVERED'
  | 'FAILED'
  | 'RTO'
  | 'RTO_DELIVERED'
  | 'CANCELLED'
  | 'ERROR'

export type ReturnStatus =
  | 'INITIATED'
  | 'PICKUP_SCHEDULED'
  | 'PICKED_UP'
  | 'IN_TRANSIT'
  | 'RECEIVED'
  | 'QC_PENDING'
  | 'QC_APPROVED'
  | 'QC_REJECTED'
  | 'REFUND_PENDING'
  | 'REFUNDED'
  | 'CANCELLED'

export type QcStatus = 'APPROVED' | 'REJECTED' | 'PARTIAL'
export type RefundStatus = 'NONE' | 'PENDING' | 'PROCESSED' | 'FAILED'

export interface OrderItem {
  id: number
  orderId: number
  shopifyVariantId: string | null
  sku: string | null
  title: string
  variantTitle?: string | null
  imageUrl?: string | null
  quantity: number
  price: number
  returnable: boolean
}

export interface TrackingLog {
  id: number
  shipmentId: number
  status: string
  location: string | null
  remark: string | null
  scannedAt: string
}

export interface Shipment {
  manifestedByOms?: boolean
  pickupBatch?: {
    key: string; pickupLocation: string; pickupDate: string; pickupTime: string; status: string;
    pickupId: string | null; submittedPackageCount: number; message: string | null;
  } | null
  id: number
  orderId: number
  waybillNumber: string | null
  orderIdDelhivery: string | null
  courier: string | null
  paymentMode: string | null
  codAmount: number | null
  declaredValue: number | null
  codCollected: boolean
  codCollectedAt: string | null
  codRemitted: boolean
  codRemittedAt: string | null
  codRemittanceRef: string | null
  codRemittedAmount: number | null
  status: ShipmentStatus
  trackingStatus: string | null
  trackingLocation: string | null
  trackingUpdatedAt: string | null
  trackingHistory: unknown
  labelUrl: string | null
  labelStoragePath?: string | null
  epodStoragePath?: string | null
  epodReceivedBy?: string | null
  epodReceivedAt?: string | null
  signatureStoragePath?: string | null
  declaredWeightGrams?: number | null
  billedWeightGrams?: number | null
  chargedZone?: string | null
  initialCost?: number | null
  reversalAmount?: number | null
  revisedCost?: number | null
  hasReversal?: boolean | null
  reversalReason?: string | null
  totalDebited?: number | null
  totalCredited?: number | null
  netBilledCost?: number | null
  weightMismatch?: boolean
  mismatchDetails?: string | null
  billingStatus?: string | null
  walletTransactions?: WalletTransactionEntry[] | null
  /** Shipping cost per leg incl. GST; ESTIMATE until the Delhivery ledger is uploaded (ACTUAL). */
  forwardCharge?: number | null
  rtoCharge?: number | null
  shippingCostSource?: 'ESTIMATE' | 'ACTUAL' | null
  rtoChargeSource?: 'ESTIMATE' | 'ACTUAL' | null
  shippingCostUpdatedAt?: string | null
  errorMessage: string | null
  retryCount: number
  trackingLogs?: TrackingLog[]
}

export interface WalletTransactionEntry {
  txnId: string
  date: string
  type: 'debit' | 'credit'
  amount: number
  description: string
  status: string
  zone?: string
  weight?: number
  closureDate?: string
  orderRef?: string
}

export interface AwbChargesAudit {
  waybill: string
  hasLedgerRecords: boolean
}

export interface ReturnItem {
  id: number
  returnId: number
  orderItemId: number
  quantity: number
  orderItem?: OrderItem
}

export interface Notification {
  id?: number
  orderId?: number
  type?: string
  channel?: string
  status?: string
  message?: string
  sentAt?: string | null
  createdAt?: string
  [key: string]: unknown
}

export interface Order {
  id: number
  shopifyOrderId: string
  shopifyOrderName: string
  shopifyOrderNumber: number
  customerName: string
  customerPhone: string
  customerEmail: string | null
  customerAddress: string
  customerCity: string
  customerState: string
  customerPincode: string
  customerCountry: string
  totalAmount: number
  totalShipping?: number | null
  totalDiscounts?: number | null
  totalTax?: number | null
  totalOutstanding?: number | null
  taxesIncluded?: boolean | null
  taxLines?: Array<{ title: string; rate: number; price: string }> | null
  discountCodes?: Array<{ code: string; amount: string; type: string }> | null
  shippingTitle?: string | null
  shopifyNote?: string | null
  additionalDetails?: Array<{ name: string; value: string }> | null
  currency: string
  paymentMethod: string | null
  financialStatus: string | null
  fulfillmentStatus: string | null
  tags?: string | null
  sourceName: string | null
  salesChannel: string | null
  paymentGateway: string | null
  paymentAggregator?: string | null
  paymentProvider?: string | null
  paymentProviderPaymentId?: string | null
  gokwikPaymentId?: string | null
  gatewayTransactionId: string | null
  paymentAuthorizationKey?: string | null
  paymentVerified: boolean
  paymentVerifiedAt: string | null
  paymentVerificationSource: string | null
  paymentReference: string | null
  status: OrderStatus
  shopifyCreatedAt: string
  shopifyUpdatedAt: string | null
  deliveredAt?: string | null
  /** Money credited to Youthnic's bank (prepaid settlement or COD remittance). */
  paymentReceivedAt?: string | null
  paymentReceivedAmount?: number | null
  paymentReceivedUtr?: string | null
  paymentReceivedRef?: string | null
  paymentReceivedSource?: string | null
  gatewayFee?: number | null
  accountsClosedAt?: string | null
  createdAt: string
  updatedAt: string
  items?: OrderItem[]
  shipment?: Shipment | null
  returns?: ReturnRecord[]
  notifications?: Notification[]
  estimatedShippingCost?: number
  actualShippingCost?: number | null
  shippingAudited?: boolean | null
  weightDiscrepancy?: boolean | null
  weightDiscrepancyNote?: string | null
  shippingZone?: string
  shippingZoneCode?: string
  deliverOrderCount?: number | null
  rtoRiskLevel?: 'LOW' | 'MEDIUM' | 'HIGH' | null
  rtoRiskReason?: string | null
  rtoRiskLabel?: string | null
  expectedDispatchAt?: string | null
  dispatchDelayed?: boolean
  isDispatchOverdue?: boolean
  dispatchOverdueHours?: number
  hasNdrException?: boolean
  hasUrgentSupport?: boolean
  supportFlag?: string | null
}


export interface ReturnRecord {
  id: number
  orderId: number
  shopifyReturnId: string | null
  returnReason: string
  returnStatus: ReturnStatus
  returnWaybillNumber: string | null
  returnShipmentStatus: string | null
  forwardWaybill?: string | null
  carrier?: string | null
  pickupAutomatic?: boolean
  trackingStatus?: string | null
  trackingLocation?: string | null
  labelUrl?: string | null
  refundStatus: RefundStatus
  refundAmount: number | null
  shopifyRefundId: string | null
  refundProcessedAt: string | null
  qcStatus: QcStatus | null
  qcRemark: string | null
  qcCheckedAt: string | null
  customerNotified: boolean
  /** Reverse-pickup shipping cost incl. GST. */
  shippingCharge?: number | null
  shippingCostSource?: 'ESTIMATE' | 'ACTUAL' | null
  errorMessage: string | null
  createdAt: string
  updatedAt: string
  items?: ReturnItem[]
  order?: Order
}

export interface AccountTrailEvent {
  id: number
  orderId: number
  returnId: number | null
  eventType: string
  actorType: 'USER' | 'SYSTEM' | 'EXTERNAL'
  actorUid: string | null
  actorEmail: string | null
  actorName: string | null
  actorRole: string | null
  source: string | null
  status: string | null
  amount: number | null
  currency: string | null
  refundMode: string | null
  accountUsed: string | null
  externalReference: string | null
  note: string | null
  evidenceFileName: string | null
  evidenceContentType: string | null
  evidenceUrl: string | null
  metadata?: Record<string, unknown> | null
  createdAt: string
}

export interface PaymentDetails {
  paymentGateway: string | null
  gatewayTransactionId: string | null
  paymentMethod: string | null
  paymentVerified: boolean
  paymentVerifiedAt: string | null
  paymentVerificationSource: string | null
  paymentReference: string | null
  totalAmount: number
  currency: string
  financialStatus: string | null
}

export interface PaymentSummaryGroup {
  paymentGateway: string | null
  _count: { _all: number }
  _sum: { totalAmount: number | null }
}

export interface PaymentSummary {
  byGateway: PaymentSummaryGroup[]
  unverifiedPrepaidOrders: number
  threeWaySummary?: {
    delhiveryCod: {
      channel: string
      source: string
      orderCount: number
      totalAmount: number
      collectedAmount: number
      remittedAmount: number
      outstandingAmount: number
    }
    gokwikPrepaid: {
      channel: string
      source: string
      orderCount: number
      totalAmount: number
      verifiedCount: number
      unverifiedCount: number
    }
    phonepePrepaid: {
      channel: string
      source: string
      orderCount: number
      totalAmount: number
      verifiedCount: number
      unverifiedCount: number
    }
  }
}

export interface ShippingEstimate {
  success: boolean
  orderId: number
  shopifyOrderName: string
  waybillNumber: string | null
  originPincode: string
  destinationPincode: string
  paymentMode: string
  chargeableWeightGrams: number
  charges: any
  actualAudit?: AwbChargesAudit | null
  note: string
}

export interface AuthUser {
  id: string
  name: string
  email: string
  role: string
  avatar: string
}

export interface CodOutstandingEntry {
  shipmentId?: number
  orderId?: number
  waybillNumber: string | null
  orderName: string
  customerName: string
  customerCity?: string | null
  codAmount: number | null
  collectedAt: string | null
}

export interface CodRemittedEntry {
  shipmentId?: number
  orderId?: number
  waybillNumber: string | null
  orderName: string
  customerName: string
  customerCity?: string | null
  codAmount: number | null
  codRemittedAmount: number | null
  remittanceRef: string | null
  remittedAt: string | null
}

export interface CodPendingDeliveryEntry {
  shipmentId?: number
  orderId?: number
  waybillNumber: string | null
  orderName: string
  customerName: string
  customerCity?: string | null
  codAmount: number | null
  status: string
}

export interface CodSummary {
  collectedCount: number
  collectedAmount: number
  remittedCount: number
  remittedAmount: number
  outstandingCount: number
  outstandingAmount: number
  pendingDeliveryCount?: number
  pendingDeliveryAmount?: number
  outstanding: CodOutstandingEntry[]
  remitted?: CodRemittedEntry[]
  pendingDelivery?: CodPendingDeliveryEntry[]
}

export interface DashboardStats {
  success: boolean
  timestamp: string
  kpis: {
    totalRevenue: number
    totalOrders: number
    averageOrderValue: number
    prepaidCount: number
    prepaidRevenue: number
    prepaidRatio: number
    codCount: number
    codRevenue: number
    codRatio: number
    readyToDispatch: number
    delayedDispatchCount?: number
    activeShipments: number
    deliveredCount: number
    ndrExceptions: number
    totalReturnsCount: number
    returnRate: number
    totalEstimatedLogisticsCost?: number
  }

  reconciliation: {
    delhiveryCod: {
      orderCount: number
      totalAmount: number
      collectedAmount: number
      remittedAmount: number
      pendingRemittance: number
      inTransitAmount: number
      settlementChannel: string
      payoutSchedule: string
      estimatedCodFee: number
    }
    gokwikPrepaid: {
      orderCount: number
      totalAmount: number
      verifiedCount: number
      unverifiedCount: number
      estimatedFees: number
      estimatedPayout: number
      settlementChannel: string
      payoutSchedule: string
    }
    phonepePrepaid: {
      orderCount: number
      totalAmount: number
      verifiedCount: number
      unverifiedCount: number
      estimatedFees: number
      estimatedPayout: number
      settlementChannel: string
      payoutSchedule: string
    }
    manualPrepaid: {
      orderCount: number
      totalAmount: number
      settlementChannel: string
      payoutSchedule: string
    }
  }
  funnel: {
    intake: { total: number; unverified: number }
    warehouse: { dispatchPending: number; dispatched: number }
    logistics: { shipped: number; inTransit: number; outForDelivery: number }
    finalMile: { delivered: number; failedDelivery: number; rtoInitiated: number; rtoDelivered: number }
    returns: { requested: number; dispatched: number; received: number; refunded: number }
  }
  topStates: Array<{
    state: string
    orders: number
    revenue: number
    citiesCount: number
    percentage: number
  }>
  actionItems: Array<{
    id: string
    priority: 'critical' | 'high' | 'medium' | 'info'
    category: string
    title: string
    description: string
    actionText: string
    filterParam: string
  }>
  recentOrders: Array<{
    id: number
    shopifyOrderId: string
    shopifyOrderName: string
    customerName: string
    customerCity: string
    customerState: string
    customerPhone: string
    totalAmount: number
    currency: string
    status: OrderStatus
    paymentGateway: string | null
    paymentMethod: string | null
    paymentVerified: boolean
    salesChannel: string | null
    itemsCount: number
    waybillNumber: string | null
    estimatedShippingCost?: number
    shippingZone?: string
    shippingZoneCode?: string
    createdAt: string
  }>

  delhiveryStatus: {
    tokenConfigured: boolean
    originPincode: string
    originCity: string
    originState: string
  }
}

export interface MonthlyReportItem {
  month: string
  monthKey: string
  noOfOrders: number
  prepaidCount: number
  prepaidPercent: number
  grossAmount: number
  grossQty: number
  rtoCancelAmount: number
  rtoCancelQty: number
  sellerCancelAmount: number
  sellerCancelQty: number
  forwardSalesAmount: number
  forwardSalesQty: number
  shippingCostF: number
  shippingCostR: number
  codCollectionFee: number
  paymentGatewayFee: number
  receivedPayment: number
}

export interface CourierReportItem {
  courierName: string
  totalOrders: number
  totalCost: number
  totalRtoOrders: number
  avgPerOrderAmount: number
  rtoPercent: number
}

export interface StateReportItem {
  state: string
  orderCount: number
  percentage: number
  grossRevenue: number
  prepaidCount: number
  codCount: number
  prepaidPercent: number
  citiesCount: number
  topCities: string[]
  deliveredCount: number
  rtoCount: number
  rtoRate: number
}

export interface AnalyticsData {
  success: boolean
  timestamp: string
  kpis: {
    totalOrders: number
    totalGrossRevenue: number
    totalPrepaidOrders: number
    totalCodOrders: number
    prepaidRatio: number
    totalShippingSpend: number
    totalStatesCount: number
  }
  monthlyReport: MonthlyReportItem[]
  courierReport: CourierReportItem[]
  stateReport: StateReportItem[]
}

export interface SystemUser {
  id: string
  name: string
  email: string
  role: string
  department: string
  phone: string
  status: 'ACTIVE' | 'INACTIVE'
  avatar: string
  createdAt: string
  lastActive: string
  firebaseUid?: string | null
  loginEnabled?: boolean
}

export interface WebhookEndpoint {
  name: string
  path: string
  method: string
  active: boolean
  latency?: string
}

export interface SystemStatusData {
  success: boolean
  timestamp: string
  stack: {
    nodeVersion: string
    platform: string
    architecture: string
    uptimeSeconds: number
    memoryRssMb: number
    memoryHeapUsedMb: number
    env: string
    port: number
  }
  database: {
    status: string
    provider: string
    host: string
    databaseName: string
    connectionPool: string
    totalOrders: number
    totalShipments: number
    totalReturns: number
    latestOrderName: string
    latestOrderDate: string | null
  }
  shopify: {
    status: string
    shopDomain: string
    apiVersion: string
    authMode: string
    syncStartDate: string
    webhooksConfigured: boolean
    endpointUrl: string
  }
  delhivery: {
    status: string
    environment: string
    originHub: string
    originPincode: string
    city: string
    state: string
    shippingMode: string
    labelSize: string
    baseUrl: string
  }
  payments: {
    gokwik: {
      name: string
      role: string
      status: string
      features: string[]
    }
    easebuzz: {
      name: string
      role: string
      status: string
      features: string[]
    }
    phonepe: {
      name: string
      role: string
      status: string
      features: string[]
    }
    codEngine: {
      name: string
      role: string
      status: string
      features: string[]
    }
  }
  whatsapp: {
    provider: string
    status: string
    senderPhone: string
    activeTemplates: string[]
  }
  kwikengage?: {
    status: string
    apiEndpoint?: string
    merchantId?: string
    authHeader: string
    senderNumber: string
    wabaId?: string
    criticalTriggers: Array<{ name: string; code: string; action: string }>
  }
  webhooks: WebhookEndpoint[]
}

export interface PingResults {
  success: boolean
  timestamp: string
  results: Record<string, { status: 'ok' | 'error'; latencyMs: number; message?: string }>
}

export interface KwikEngageStatusData {
  success: boolean
  status: 'ok' | 'unauthorized' | 'error'
  latencyMs: number
  apiUrl?: string
  merchantId?: string
  senderPhone: string
  wabaId?: string
  apiKeyConfigured: boolean
  merchantIdConfigured: boolean
  message?: string
}

export interface ShopifyProductImage {
  id?: number
  product_id?: number
  position?: number
  created_at?: string
  updated_at?: string
  alt?: string | null
  width?: number
  height?: number
  src: string
  variant_ids?: number[]
  admin_graphql_api_id?: string
}

export interface ShopifyProductOption {
  id?: number
  product_id?: number
  name: string
  position?: number
  values: string[]
}

export interface ShopifyProductVariant {
  id?: number
  product_id?: number
  title: string
  price: string
  sku?: string | null
  position?: number
  inventory_policy?: string
  compare_at_price?: string | null
  fulfillment_service?: string
  inventory_management?: string | null
  option1?: string | null
  option2?: string | null
  option3?: string | null
  created_at?: string
  updated_at?: string
  taxable?: boolean
  barcode?: string | null
  grams?: number
  weight?: number
  weight_unit?: string
  inventory_item_id?: number
  inventory_quantity?: number
  old_inventory_quantity?: number
  requires_shipping?: boolean
  admin_graphql_api_id?: string
}

export interface ShopifyProduct {
  id: number
  title: string
  body_html?: string | null
  vendor: string
  product_type?: string
  created_at?: string
  handle?: string
  updated_at?: string
  published_at?: string | null
  template_suffix?: string | null
  status: 'active' | 'draft' | 'archived'
  published_scope?: string
  tags?: string
  admin_graphql_api_id?: string
  variants: ShopifyProductVariant[]
  options: ShopifyProductOption[]
  images: ShopifyProductImage[]
  image?: ShopifyProductImage | null
  total_inventory?: number
}

export interface ProductSummaryData {
  total: number
  active: number
  draft: number
  archived: number
  outOfStock: number
  lowStock: number
  totalInventory: number
}

export interface CreateProductInput {
  title: string
  body_html?: string
  vendor?: string
  product_type?: string
  status?: 'active' | 'draft' | 'archived'
  tags?: string
  price?: string | number
  compare_at_price?: string | number
  sku?: string
  barcode?: string
  inventory_quantity?: number
  images?: Array<{ src: string; alt?: string; position?: number }>
  options?: Array<{ name: string; values: string[] }>
  variants?: Array<{
    title?: string
    price: string | number
    compare_at_price?: string | number | null
    sku?: string
    barcode?: string
    inventory_quantity?: number
    option1?: string
    option2?: string
    option3?: string
    weight?: number
    weight_unit?: string
    requires_shipping?: boolean
  }>
}

export interface UpdateProductInput {
  title?: string
  body_html?: string
  vendor?: string
  product_type?: string
  status?: 'active' | 'draft' | 'archived'
  tags?: string
  images?: Array<{ id?: number; src: string; alt?: string; position?: number }>
  variants?: Array<{
    id?: number
    title?: string
    price?: string | number
    compare_at_price?: string | number | null
    sku?: string
    barcode?: string
    inventory_quantity?: number
    option1?: string
    option2?: string
    option3?: string
    weight?: number
    weight_unit?: string
  }>
}

// ─── Consumer Email Communications & Resend ─────────────
export type EmailTemplateType =
  | 'TRANSIT_DELAY'
  | 'DISPATCH_DELAY'
  | 'IN_TRANSIT'
  | 'OUT_FOR_DELIVERY'
  | 'NDR_ALERT'
  | 'DELIVERED'
  | 'ORDER_CONFIRMED'
  | 'RETURN_INITIATED'
  | 'RETURN_RECEIVED'
  | 'RETURN_REFUND'
  | 'SUPPORT_REPLY'
  | 'CUSTOM'

export interface DelayedInTransitShipment {
  orderId: number
  shopifyOrderId: string
  shopifyOrderName: string
  customerName: string
  customerEmail: string | null
  customerPhone: string
  totalAmount: number
  waybillNumber: string | null
  courier: string
  currentLocation: string
  status: string
  latestRemark: string | null
  latestScanStatus: string | null
  latestScanAt: string | null
  flaggedReason: string
  expectedDeliveryDate: string | null
  dispatchedAt: string
  daysInTransit: number
  daysOverdue: number
  isPastExpectedDate: boolean
  alreadyNotified: boolean
  lastNotifiedAt: string | null
  itemCount: number
  items: Array<{ title: string; quantity: number; price: number }>
}

export interface EmailLog {
  id: number
  orderId?: number | null
  shopifyOrderName?: string | null
  recipientEmail: string
  recipientName?: string | null
  subject: string
  templateType: EmailTemplateType
  status: 'SENT' | 'DELIVERED' | 'FAILED' | 'SIMULATED' | 'PENDING'
  resendId?: string | null
  waybillNumber?: string | null
  courier?: string | null
  currentLocation?: string | null
  delayReason?: string | null
  expectedDeliveryDate?: string | null
  htmlPreview?: string | null
  errorMessage?: string | null
  converted: boolean
  conversionAction?: string | null
  conversionAt?: string | null
  openCount: number
  clickCount: number
  lastEngagedAt?: string | null
  metadata?: any
  createdAt: string
  sentAt?: string | null
  order?: {
    id: number
    shopifyOrderName: string
    status: string
    totalAmount: number
    paymentMethod: string | null
  } | null
}

export interface CommunicationStats {
  totalSent: number
  deliveredCount: number
  convertedCount: number
  conversionRatePercent: number
  deliveryRatePercent: number
  transitDelaysCount: number
  dispatchDelaysCount: number
  byTemplate: Record<string, number>
}

export interface SendEmailPayload {
  orderId?: number
  recipientEmail?: string
  recipientName?: string
  templateType: EmailTemplateType
  subject?: string
  delayReason?: string
  newEstimatedDelivery?: string
  currentLocation?: string
  customMessage?: string
}

export interface ResendStatusData {
  success: boolean
  status: 'ok' | 'unauthorized' | 'not_configured'
  latencyMs: number
  apiKeyConfigured: boolean
  fromEmail: string
  message?: string
}


// ─── Customer Support, Inbound Emails & Self-Learning Types ───────

export interface InboundEmail {
  id: number
  orderId?: number | null
  shopifyOrderId?: string | null
  shopifyOrderName?: string | null
  fromEmail: string
  fromName?: string | null
  toEmail: string
  subject: string
  bodyText?: string | null
  bodyHtml?: string | null
  category: 'RETURN_REQUEST' | 'EXCHANGE_REQUEST' | 'TRANSIT_DELAY' | 'DAMAGED_ITEM' | 'CANCELLATION' | 'GENERAL_INQUIRY'
  urgency: 'URGENT' | 'HIGH' | 'NORMAL' | 'LOW'
  sentiment: 'FRUSTRATED' | 'URGENT' | 'NEUTRAL' | 'POSITIVE'
  flagReason?: string | null
  aiAnalysis?: {
    reasoning?: string
    confidence?: number
    isLearnedMatch?: boolean
    suggestedAction?: string
  } | null
  suggestedReply?: string | null
  status: 'OPEN' | 'IN_REVIEW' | 'REPLIED' | 'RESOLVED' | 'CLOSED'
  replyText?: string | null
  repliedAt?: string | null
  resolvedBy?: string | null
  channel: string
  firebaseRtdbPath?: string | null
  createdAt: string
  updatedAt: string
  order?: {
    id: number
    shopifyOrderName: string
    status: string
    totalAmount: number
    customerPhone: string
    customerEmail?: string | null
    hasUrgentSupport?: boolean
    supportFlag?: string | null
    shipment?: {
      waybillNumber?: string | null
      status?: string
      courier?: string | null
      trackingLocation?: string | null
      trackingStatus?: string | null
    } | null
  } | null
}

export interface SupportKnowledgePattern {
  id: number
  patternKey: string
  intent: string
  keywords: string
  recommendedUrgency: string
  suggestedAction: string
  autoReplyTemplate: string
  confidence: number
  usageCount: number
  isLearned: boolean
  createdAt: string
  updatedAt: string
}

export interface CustomerHistoryEvent {
  id?: string
  type: 'INBOUND_EMAIL' | 'OUTBOUND_EMAIL' | 'WHATSAPP' | 'DELHIVERY_TRACKING' | 'ORDER_EVENT'
  channel: 'EMAIL' | 'WHATSAPP' | 'SYSTEM' | 'DELHIVERY'
  title: string
  description: string
  timestamp: string
  sender?: string
  recipient?: string
  orderId?: number
  shopifyOrderName?: string
  urgency?: string
  status?: string
}

export interface SupportDiagnosticsData {
  timestamp: string
  delhivery: {
    status: 'ok' | 'error'
    latencyMs: number
    tokenConfigured: boolean
    message: string
  }
  kwikengage?: {
    status: 'ok' | 'error' | 'unauthorized'
    latencyMs: number
    apiUrl?: string
    merchantId?: string
    senderPhone: string
    wabaId?: string
    apiKeyConfigured: boolean
    merchantIdConfigured?: boolean
    message?: string
  }
  whatsapp?: {
    status: 'ok' | 'error' | 'unauthorized'
    latencyMs: number
    message?: string
  }
  firebase: {
    status: 'ok' | 'error' | 'auth_required'
    latencyMs: number
    project: string
    databaseUrl: string
    error?: string
  }
  resend: {
    status: 'ok' | 'unauthorized' | 'not_configured'
    latencyMs: number
    apiKeyConfigured: boolean
    fromEmail: string
    message?: string
    senderDefault: string
  }
}
