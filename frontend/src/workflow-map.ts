import { isPrepaidOrder } from '../../src/modules/orders/order-tabs'
import { normalizeCourierName } from './lib'
import type { Order, ReturnRecord } from './types'

/**
 * Workflow designer model + order-to-node mapping for the /workflows page.
 *
 * A design is a sequential-workflow-designer definition. Each stage (task) step
 * lists the order states it stands for in `properties.states`; each decision
 * (switch) step has a condition per branch in `properties.conditions`. Both use
 * the same tokens, which `orderFacts` derives from a real order:
 *
 *   order:<OrderStatus>      tab:<Orders page queue>   payment:COD|PREPAID
 *   shipment:<status>        courier:DELHIVERY|VELOCITY|…   ndr:YES
 *   flow:FORWARD|RETURN|EXCHANGE   return:<ReturnStatus>   qc:<QcStatus>
 *   refund:<RefundStatus>    exchange:<replacement status>
 *
 * A token list is comma or newline separated; `key:*` matches any value and
 * `a&b` needs both. Kept DOM-free so tests can import it.
 */

export interface WorkflowStep {
  id: string
  componentType: string
  type: string
  name: string
  // any: mirrors the designer's loose Properties type, so designer definitions pass without casts
  properties: Record<string, any>
  branches?: Record<string, WorkflowStep[]>
}

export interface WorkflowDefinition {
  properties: Record<string, any>
  sequence: WorkflowStep[]
}

export const FACT_KEYS: Array<{ key: string; values: string }> = [
  { key: 'order', values: 'NEW, DISPATCH_PENDING, DISPATCHED, SHIPPED, IN_TRANSIT, OUT_FOR_DELIVERY, DELIVERED, FAILED_DELIVERY, RTO_INITIATED, RTO_DELIVERED, RETURN_REQUESTED, EXCHANGE_REQUESTED, RETURN_DISPATCHED, RETURN_RECEIVED, REFUNDED, CANCELLED' },
  { key: 'tab', values: 'NEW, DISPATCH, READY, TRANSIT, DELIVERED, CLOSED, RETURN, CANCEL (Orders page queue)' },
  { key: 'payment', values: 'COD, PREPAID' },
  { key: 'shipment', values: 'PENDING, CREATED, PICKED_UP, IN_TRANSIT, OUT_FOR_DELIVERY, DELIVERED, FAILED, RTO, RTO_DELIVERED, CANCELLED, ERROR' },
  { key: 'courier', values: 'DELHIVERY, VELOCITY' },
  { key: 'ndr', values: 'YES' },
  { key: 'flow', values: 'FORWARD, RETURN, EXCHANGE' },
  { key: 'return', values: 'INITIATED, PICKUP_SCHEDULED, PICKED_UP, IN_TRANSIT, RECEIVED, QC_PENDING, QC_APPROVED, QC_REJECTED, REFUND_PENDING, REFUNDED, CANCELLED' },
  { key: 'qc', values: 'APPROVED, REJECTED, PARTIAL' },
  { key: 'refund', values: 'NONE, PENDING, PROCESSED, FAILED' },
  { key: 'exchange', values: 'PENDING, DISPATCHED, IN_TRANSIT, DELIVERED' },
]

const token = (key: string, value: string | null | undefined) =>
  value ? `${key}:${value.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_')}` : null

/** The return that describes the order now: newest open one, else newest of any. */
export function activeReturn(returns: ReturnRecord[] | null | undefined): ReturnRecord | null {
  const sorted = [...(returns || [])].sort((a, b) => b.id - a.id)
  return sorted.find((entry) => entry.returnStatus !== 'CANCELLED') ?? sorted[0] ?? null
}

/** Facts about a real order, as `key:VALUE` tokens. */
export function orderFacts(order: Order): string[] {
  const shipment = order.shipment
  const ret = activeReturn(order.returns)
  const openReturn = ret && ret.returnStatus !== 'CANCELLED' ? ret : null
  const hasShipment = Boolean(shipment?.waybillNumber || shipment?.courier)
  return [
    token('order', order.status),
    token('tab', order.operationalTab),
    token('payment', isPrepaidOrder(order) ? 'PREPAID' : 'COD'),
    token('shipment', shipment?.status),
    hasShipment ? token('courier', normalizeCourierName(shipment?.courier, shipment?.labelUrl, shipment?.waybillNumber)) : null,
    order.hasNdrException ? 'ndr:YES' : null,
    token('flow', openReturn ? (openReturn.isExchange ? 'EXCHANGE' : 'RETURN') : 'FORWARD'),
    token('return', ret?.returnStatus),
    token('qc', ret?.qcStatus),
    ret ? token('refund', ret.refundStatus) : null,
    token('exchange', ret?.isExchange ? ret.exchangeForwardStatus : null),
  ].filter((value): value is string => Boolean(value))
}

const TOKEN_GROUP = /^[A-Z_]+:[A-Z0-9_*]+(&[A-Z_]+:[A-Z0-9_*]+)*$/

function tokenParts(text: unknown): string[] {
  if (typeof text !== 'string') return []
  return text
    .split(/[,\n]/)
    .map((part) => part.trim().replace(/\s*([:&])\s*/g, '$1').toUpperCase())
    .filter(Boolean)
}

/** Split a token list ("order:NEW, tab:dispatch") into normalised tokens. */
export function parseTokens(text: unknown): string[] {
  return tokenParts(text).filter((part) => TOKEN_GROUP.test(part))
}

/** Parts of a token list that are not `key:VALUE` tokens (typos), for the editor. */
export function invalidTokens(text: unknown): string[] {
  return tokenParts(text).filter((part) => !TOKEN_GROUP.test(part))
}

/**
 * The order a lookup means: exact order name (with or without #) or AWB first
 * (forward, return or replacement), else the first search result.
 */
export function pickOrder(orders: Order[], query: string): Order | null {
  const q = query.trim().replace(/^#/, '').toLowerCase()
  const same = (value?: string | null) => Boolean(value) && value!.trim().replace(/^#/, '').toLowerCase() === q
  return (
    orders.find(
      (order) =>
        same(order.shopifyOrderName) ||
        same(order.shipment?.waybillNumber) ||
        (order.returns || []).some((entry) => same(entry.returnWaybillNumber) || same(entry.exchangeForwardAwb))
    ) ??
    orders[0] ??
    null
  )
}

/** True when any token in `text` holds for the facts. */
export function matchesFacts(text: unknown, facts: string[]): boolean {
  const known = new Set(facts.map((fact) => fact.toUpperCase()))
  const keys = new Set([...known].map((fact) => fact.split(':')[0]))
  return parseTokens(text).some((group) =>
    group.split('&').every((part) => (part.endsWith(':*') ? keys.has(part.slice(0, -2)) : known.has(part)))
  )
}

export interface OrderPath {
  /** Furthest stage on the route whose states match the order, or null. */
  currentId: string | null
  /** Steps on the route before the current stage. */
  passedIds: string[]
  /** Every step on the route, in order (decisions included). */
  routeIds: string[]
  /** Branch taken at each decision on the route. */
  branches: Record<string, string>
}

function containsMatch(sequence: WorkflowStep[], facts: string[]): boolean {
  return sequence.some((step) =>
    step.componentType === 'switch'
      ? Object.values(step.branches || {}).some((branch) => containsMatch(branch, facts))
      : matchesFacts(step.properties?.states, facts)
  )
}

/**
 * Pick the branch an order took at a decision: the first branch whose condition
 * holds, else the first that holds a matching stage, else the first branch with
 * no condition (the default). Null when nothing decides it yet.
 */
export function chooseBranch(step: WorkflowStep, facts: string[]): string | null {
  const entries = Object.entries(step.branches || {})
  const conditions: Record<string, string> = step.properties?.conditions || {}
  const byCondition = entries.find(([name]) => matchesFacts(conditions[name], facts))
  if (byCondition) return byCondition[0]
  const byContent = entries.find(([, branch]) => containsMatch(branch, facts))
  if (byContent) return byContent[0]
  return entries.find(([name]) => parseTokens(conditions[name]).length === 0)?.[0] ?? null
}

/** Walk the design along the branches the order took and find where it sits. */
export function resolveOrderPath(definition: WorkflowDefinition, facts: string[]): OrderPath {
  const routeIds: string[] = []
  const branches: Record<string, string> = {}
  let currentIndex = -1

  const walk = (sequence: WorkflowStep[]) => {
    for (const step of sequence) {
      routeIds.push(step.id)
      if (step.componentType === 'switch') {
        const branch = chooseBranch(step, facts)
        if (branch !== null) {
          branches[step.id] = branch
          walk(step.branches?.[branch] || [])
        }
      } else if (matchesFacts(step.properties?.states, facts)) {
        currentIndex = routeIds.length - 1
      }
    }
  }
  walk(definition.sequence)

  return {
    currentId: currentIndex >= 0 ? routeIds[currentIndex] : null,
    passedIds: currentIndex >= 0 ? routeIds.slice(0, currentIndex) : [],
    routeIds,
    branches,
  }
}

/** Every step id in a definition, depth first. */
export function allStepIds(sequence: WorkflowStep[]): string[] {
  return sequence.flatMap((step) => [
    step.id,
    ...Object.values(step.branches || {}).flatMap((branch) => allStepIds(branch)),
  ])
}

export function findStep(sequence: WorkflowStep[], id: string): WorkflowStep | null {
  for (const step of sequence) {
    if (step.id === id) return step
    for (const branch of Object.values(step.branches || {})) {
      const found = findStep(branch, id)
      if (found) return found
    }
  }
  return null
}

// ─── Default design: the real order lifecycle in this codebase ──────────────

const stage = (id: string, type: string, name: string, states: string, note = ''): WorkflowStep => ({
  id,
  componentType: 'task',
  type,
  name,
  properties: { states, note },
})

const decision = (
  id: string,
  name: string,
  branches: Array<[name: string, condition: string, steps: WorkflowStep[]]>,
  note = ''
): WorkflowStep => ({
  id,
  componentType: 'switch',
  type: 'decision',
  name,
  properties: { conditions: Object.fromEntries(branches.map(([branch, condition]) => [branch, condition])), note },
  branches: Object.fromEntries(branches.map(([branch, , steps]) => [branch, steps])),
})

const reversePickup = (id: string) =>
  stage(id, 'returns', 'Reverse pickup', 'return:PICKUP_SCHEDULED, return:PICKED_UP, return:IN_TRANSIT, order:RETURN_DISPATCHED', 'Delhivery reverse AWB; pickup scheduled when the reverse order is manifested.')

export const DEFAULT_WORKFLOW: WorkflowDefinition = {
  properties: { name: 'Youthnic order lifecycle' },
  sequence: [
    stage('received', 'order', 'Order received', 'order:NEW', 'Shopify orders/create webhook or sync.'),
    decision('payment-type', 'Payment type', [
      ['Prepaid', 'payment:PREPAID', []],
      ['COD', 'payment:COD', [stage('cod-confirm', 'order', 'COD confirmation', 'tab:NEW', 'Waits for GoKwik / WhatsApp confirmation (COD_CONFIRMED or Low RTO tag).')]],
    ]),
    decision('approval', 'Approved?', [
      ['Approved', '', []],
      ['Cancelled', 'order:CANCELLED, tab:CANCEL', [stage('cancelled', 'order', 'Cancelled before pickup', 'order:CANCELLED, tab:CANCEL', 'COD_CANCELLED / High RTO cancel or a manual cancel.')]],
    ]),
    stage('ready', 'order', 'Ready to dispatch', 'order:DISPATCH_PENDING, tab:DISPATCH', 'Prepaid or COD-confirmed, waiting for a label.'),
    decision('courier', 'Courier routing', [
      ['Delhivery', 'courier:DELHIVERY', [stage('delhivery-awb', 'shipping', 'Delhivery AWB + label', 'order:DISPATCHED, tab:READY')]],
      ['Velocity', 'courier:VELOCITY', [stage('velocity-awb', 'shipping', 'Velocity AWB + label', 'order:DISPATCHED, tab:READY')]],
    ], 'Carrier priority comes from Settings > Shipping priority.'),
    stage('picked-up', 'shipping', 'Picked up', 'order:SHIPPED, shipment:PICKED_UP'),
    stage('in-transit', 'shipping', 'In transit', 'order:IN_TRANSIT'),
    stage('out-for-delivery', 'shipping', 'Out for delivery', 'order:OUT_FOR_DELIVERY'),
    decision('delivery-outcome', 'Delivery outcome', [
      ['Delivered', 'shipment:DELIVERED, order:DELIVERED, flow:RETURN, flow:EXCHANGE', [
        stage('delivered', 'shipping', 'Delivered', 'order:DELIVERED'),
        decision('after-delivery', 'After delivery', [
          ['Kept', 'flow:FORWARD', [stage('closed', 'money', 'Payment received · closed', 'tab:CLOSED', 'Money in bank (UTR), 7-day return window over, no open return.')]],
          ['Return', 'flow:RETURN', [
            stage('return-requested', 'returns', 'Return requested', 'order:RETURN_REQUESTED, return:INITIATED'),
            reversePickup('return-pickup'),
            stage('return-received', 'returns', 'Received at warehouse', 'order:RETURN_RECEIVED, return:RECEIVED', 'Barcode scan on the Returns desk.'),
            stage('return-qc', 'returns', 'QC check', 'return:QC_PENDING'),
            decision('qc-result', 'QC result', [
              ['Passed', 'qc:APPROVED, qc:PARTIAL, return:QC_APPROVED, return:REFUND_PENDING, return:REFUNDED', [
                stage('refund-pending', 'money', 'Refund pending', 'return:QC_APPROVED, return:REFUND_PENDING, refund:PENDING'),
                stage('refunded', 'money', 'Refunded', 'return:REFUNDED, refund:PROCESSED, order:REFUNDED'),
              ]],
              ['Rejected', 'qc:REJECTED, return:QC_REJECTED', [stage('qc-rejected', 'returns', 'QC rejected', 'return:QC_REJECTED')]],
            ]),
          ]],
          ['Exchange', 'flow:EXCHANGE', [
            stage('exchange-requested', 'returns', 'Exchange requested', 'order:EXCHANGE_REQUESTED, return:INITIATED'),
            reversePickup('exchange-pickup'),
            stage('exchange-received', 'returns', 'Received + QC', 'return:RECEIVED, return:QC_PENDING, return:QC_APPROVED'),
            stage('replacement-shipped', 'shipping', 'Replacement shipped', 'exchange:DISPATCHED, exchange:IN_TRANSIT'),
            stage('replacement-delivered', 'shipping', 'Replacement delivered', 'exchange:DELIVERED'),
          ]],
        ]),
      ]],
      ['NDR / RTO', 'order:FAILED_DELIVERY, order:RTO_INITIATED, order:RTO_DELIVERED, shipment:FAILED, shipment:RTO, shipment:RTO_DELIVERED, ndr:YES', [
        stage('ndr', 'shipping', 'NDR · delivery failed', 'order:FAILED_DELIVERY, ndr:YES', 'Re-attempt, change address or mark RTO from the order page.'),
        stage('rto-transit', 'shipping', 'RTO in transit', 'order:RTO_INITIATED, shipment:RTO'),
        stage('rto-received', 'returns', 'RTO received', 'order:RTO_DELIVERED, shipment:RTO_DELIVERED'),
        stage('rto-refund', 'money', 'Prepaid RTO refund', 'order:REFUNDED', 'Prepaid only; COD RTO just restocks.'),
      ]],
    ]),
  ],
}
