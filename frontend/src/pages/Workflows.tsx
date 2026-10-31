import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { getOrderTabCounts, getReturns } from '../api'
import { Button, Icon, PageIntro, Panel, PanelHeading, useDocumentTitle, useToast } from '../components/UI'
import './Workflows.css'

type WorkflowStage = 'ALL' | 'DISPATCH' | 'TRACKING' | 'RETURNS' | 'QC_REFUND'

export function Workflows() {
  useDocumentTitle('Workflow Trees · Architect View')
  const toast = useToast()
  const navigate = useNavigate()
  const [activeStage, setActiveStage] = useState<WorkflowStage>('ALL')
  const [showInvariants, setShowInvariants] = useState(true)

  // Fetch live counts for order queues and return states
  const tabCountsQuery = useQuery({
    queryKey: ['orders', 'tab-counts'],
    queryFn: getOrderTabCounts,
    staleTime: 15_000,
    retry: false,
  })

  const returnsQuery = useQuery({
    queryKey: ['returns', 'all'],
    queryFn: () => getReturns(),
    staleTime: 15_000,
    retry: false,
  })

  const counts = tabCountsQuery.data ?? {}
  const byStatus = counts.byStatus ?? {}
  const returnsList = returnsQuery.data ?? []

  // Compute live return metrics
  const returnMetrics = useMemo(() => {
    const total = returnsList.length
    const qcPassedUnrefunded = returnsList.filter((r) => {
      if (r.isExchange) return false
      const isSettled = r.order?.financialStatus === 'refunded' || r.order?.status === 'REFUNDED' || r.refundStatus === 'PROCESSED'
      if (isSettled) return false
      const qcPassed = r.qcStatus === 'APPROVED' || r.qcStatus === 'PARTIAL'
      const received = Boolean(r.receivedAt || r.returnStatus === 'RECEIVED' || r.returnStatus === 'QC_PENDING' || r.trackingStatus === 'DTO')
      return qcPassed || received
    }).length

    const pendingQc = returnsList.filter((r) => !r.qcStatus && r.returnStatus !== 'CANCELLED').length
    const exchanges = returnsList.filter((r) => r.isExchange && r.returnStatus !== 'CANCELLED').length
    const codDue = returnsList.filter((r) => {
      const isCod = r.order?.paymentMethod === 'COD' || /cash/i.test(r.order?.paymentGateway || '')
      const isSettled = r.order?.financialStatus === 'refunded' || r.order?.status === 'REFUNDED' || r.refundStatus === 'PROCESSED'
      const qcPassed = r.qcStatus === 'APPROVED' || r.qcStatus === 'PARTIAL'
      return isCod && qcPassed && !isSettled && !r.isExchange
    }).length
    const refunded = returnsList.filter((r) => r.refundStatus === 'PROCESSED' || r.order?.financialStatus === 'refunded').length

    return { total, qcPassedUnrefunded, pendingQc, exchanges, codDue, refunded }
  }, [returnsList])

  const copyMermaidDiagram = () => {
    const mermaid = `flowchart TD
    subgraph S1["1. ORDER INGESTION & DISPATCH"]
        A1["Shopify Webhook: orders/create"] --> A2{"Payment Method"}
        A2 -->|Prepaid| A3["Status: NEW / DISPATCH_PENDING"]
        A2 -->|COD| A4{"GoKwik RTO Score"}
        A4 -->|Confirmed| A3
        A4 -->|High RTO / Cancel| A7["Status: COD_CANCELLED"]
        A3 --> A8["Acquire dispatchLockedAt (2-min TTL)"]
        A8 --> A9{"Courier Routing Engine"}
        A9 -->|Velocity Primary| A10["Velocity API Forward Shipment"]
        A9 -->|Delhivery Fallback| A11["Delhivery API Forward Shipment"]
        A10 --> A12["Generate AWB & youthnic2024 Thermal Slip"]
        A11 --> A12
        A12 --> A13["Fulfill on Shopify + Customer WhatsApp"]
        A13 --> A14["Status: DISPATCHED / Ready to Ship"]
    end
    subgraph S2["2. DELIVERY & LOGISTICS TRACKING"]
        A14 --> B1["Courier Webhooks + 30-min Poller"]
        B1 --> B2{"Terminal Event"}
        B2 -->|Delivered| B3["Status: DELIVERED / codCollected: true"]
        B2 -->|NDR / Exception| B4["NDR Action & Customer Re-attempt"]
        B2 -->|RTO Initiated| B5["Status: RTO_INITIATED -> RTO_DELIVERED"]
    end
    subgraph S3["3. RETURNS & SIZE EXCHANGES"]
        B3 --> C1{"Customer Request"}
        C1 -->|Size Exchange| C2["Create Size Exchange (EX-FWD)"]
        C1 -->|Standard Return| C3["Create Pro-Rated Return"]
        C2 --> C4["Reverse Pickup + Replacement Forward"]
        C3 --> C5["Reverse Pickup AWB Booked"]
        C4 --> C6["Reverse In-Transit -> Warehouse Arrival"]
        C5 --> C6
    end
    subgraph S4["4. QC VERIFICATION & REFUND SETTLEMENT"]
        C6 --> D1["Warehouse Gun Scan (/api/returns/scan)"]
        D1 --> D2{"Is Size Exchange?"}
        D2 -->|Yes| D3["Mark RECEIVED & QC Passed / NO REFUND"]
        D2 -->|No| D4{"Payment Method"}
        D4 -->|Prepaid| D5["Shopify API Auto-Refund (idempotency: oms-return-id)"]
        D5 --> D6["Status: REFUNDED"]
        D4 -->|COD| D7["Flag: COD_MANUAL_REFUND_DUE"]
        D7 --> D8["Operator Verifies UPI/Bank Screenshot Proof"]
        D8 --> D9["Record in Account Trail (Cumulative Cap Verified)"]
    end`
    navigator.clipboard.writeText(mermaid)
    toast.toast('success', 'Mermaid workflow architecture copied to clipboard!')
  }

  return (
    <div className="workflows-page">
      <PageIntro
        eyebrow="System Architecture & State Machine"
        title="Workflow Trees · Architect View"
        description="Comprehensive interactive visualization of end-to-end fulfillment, courier routing, reverse logistics, and verified financial settlement lifecycles."
        action={
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <Button
              className="button-secondary"
              onClick={() => {
                tabCountsQuery.refetch()
                returnsQuery.refetch()
                toast.toast('success', 'Refreshing live workflow counts...')
              }}
            >
              <Icon name="refresh" size={14} />
              Refresh Queues
            </Button>
            <Button className="button-secondary" onClick={copyMermaidDiagram}>
              <Icon name="copy" size={14} />
              Export Diagram
            </Button>
          </div>
        }
      />

      {/* Top Level Operational Ribbon */}
      <div className="workflow-ribbon-grid">
        <div className="wf-ribbon-card" onClick={() => navigate('/orders?tab=new')}>
          <div className="wf-ribbon-header">
            <span>New Orders</span>
            <Icon name="box" size={15} />
          </div>
          <strong className="wf-ribbon-val">{counts.new ?? 0}</strong>
          <span className="wf-ribbon-sub">Awaiting operator / auto-dispatch</span>
        </div>

        <div className="wf-ribbon-card" onClick={() => navigate('/orders?tab=dispatch')}>
          <div className="wf-ribbon-header" style={{ color: '#d97706' }}>
            <span>Dispatch Pending</span>
            <Icon name="clock" size={15} />
          </div>
          <strong className="wf-ribbon-val" style={{ color: '#d97706' }}>
            {counts.dispatch ?? 0}
          </strong>
          <span className="wf-ribbon-sub">Locked or queuing for manifest</span>
        </div>

        <div className="wf-ribbon-card" onClick={() => navigate('/orders?tab=ready')}>
          <div className="wf-ribbon-header" style={{ color: '#2563eb' }}>
            <span>Dispatched / In-Flight</span>
            <Icon name="truck" size={15} />
          </div>
          <strong className="wf-ribbon-val" style={{ color: '#2563eb' }}>
            {(counts.ready ?? 0) + (counts.transit ?? 0)}
          </strong>
          <span className="wf-ribbon-sub">AWB assigned & with courier</span>
        </div>

        <div className="wf-ribbon-card" onClick={() => navigate('/returns?tab=EXCHANGES')}>
          <div className="wf-ribbon-header" style={{ color: '#7c3aed' }}>
            <span>Active Exchanges</span>
            <Icon name="refresh" size={15} />
          </div>
          <strong className="wf-ribbon-val" style={{ color: '#7c3aed' }}>
            {returnMetrics.exchanges}
          </strong>
          <span className="wf-ribbon-sub">Reverse + forward replacement</span>
        </div>

        <div className="wf-ribbon-card" onClick={() => navigate('/returns?tab=QC_PASSED_UNREFUNDED')}>
          <div className="wf-ribbon-header" style={{ color: '#dc2626' }}>
            <span>QC Passed (Unrefunded)</span>
            <Icon name="alert" size={15} />
          </div>
          <strong className="wf-ribbon-val" style={{ color: '#dc2626' }}>
            {returnMetrics.qcPassedUnrefunded}
          </strong>
          <span className="wf-ribbon-sub">Action required to settle</span>
        </div>

        <div className="wf-ribbon-card" onClick={() => navigate('/remittance')}>
          <div className="wf-ribbon-header" style={{ color: '#16a34a' }}>
            <span>Delivered & Closed</span>
            <Icon name="check" size={15} />
          </div>
          <strong className="wf-ribbon-val" style={{ color: '#16a34a' }}>
            {(counts.delivered ?? 0) + (counts.closed ?? 0)}
          </strong>
          <span className="wf-ribbon-sub">Settled in ledger</span>
        </div>
      </div>

      {/* Invariants & Production Safety Guarantees Bar */}
      <Panel className="wf-invariants-panel">
        <PanelHeading
          eyebrow="System Verification"
          title="Architectural Invariants & Idempotency Safeguards"
          action={
            <Button
              className="button-ghost"
              style={{ fontSize: '12px', padding: '4px 8px' }}
              onClick={() => setShowInvariants(!showInvariants)}
            >
              {showInvariants ? 'Hide Invariants' : 'Show Invariants'}
            </Button>
          }
        />
        {showInvariants && (
          <div className="wf-invariants-grid">
            <div className="wf-guard-item">
              <div className="wf-guard-tag active">
                <span className="live-dot" /> Lock Guard
              </div>
              <strong>2-Minute Dispatch Mutex</strong>
              <p>
                <code>Order.dispatchLockedAt</code> acquires an atomic lock prior to calling Velocity or Delhivery APIs, preventing duplicate shipments on rapid clicks or concurrent cron jobs.
              </p>
            </div>

            <div className="wf-guard-item">
              <div className="wf-guard-tag active">
                <span className="live-dot" /> Leakage Prevention
              </div>
              <strong>Exchange Scan Auto-Refund Suppression</strong>
              <p>
                Warehouse barcode scans verify <code>isExchange: true</code> and strictly suppress <code>orderService.processRtoRefund()</code>, preventing double compensation on replacement orders.
              </p>
            </div>

            <div className="wf-guard-item">
              <div className="wf-guard-tag active">
                <span className="live-dot" /> Multi-Item Support
              </div>
              <strong>Cumulative Refund Cap Validation</strong>
              <p>
                Multi-item orders allow sequential partial returns scoped per <code>returnId</code> while enforcing <code>cumulativeRefunded + amount &le; order.totalAmount</code> to block excess payouts.
              </p>
            </div>

            <div className="wf-guard-item">
              <div className="wf-guard-tag active">
                <span className="live-dot" /> Concurrency Guard
              </div>
              <strong>Atomic Webhook Dispatch Claim</strong>
              <p>
                Velocity reverse pickup webhooks atomically claim <code>CLAIMED_FOR_DISPATCH</code> before triggering forward exchange fulfillment, eliminating duplicate replacement AWB creation.
              </p>
            </div>
          </div>
        )}
      </Panel>

      {/* Stage Selector Tabs */}
      <div className="wf-tabs-container">
        <button
          className={`wf-stage-tab ${activeStage === 'ALL' ? 'active' : ''}`}
          onClick={() => setActiveStage('ALL')}
        >
          <Icon name="workflow" size={16} />
          Unified Architecture (All 4 Pipelines)
        </button>
        <button
          className={`wf-stage-tab ${activeStage === 'DISPATCH' ? 'active' : ''}`}
          onClick={() => setActiveStage('DISPATCH')}
        >
          <Icon name="box" size={16} />
          1. Forward Dispatching & Routing
        </button>
        <button
          className={`wf-stage-tab ${activeStage === 'TRACKING' ? 'active' : ''}`}
          onClick={() => setActiveStage('TRACKING')}
        >
          <Icon name="route" size={16} />
          2. Delivery & In-Transit Tracking
        </button>
        <button
          className={`wf-stage-tab ${activeStage === 'RETURNS' ? 'active' : ''}`}
          onClick={() => setActiveStage('RETURNS')}
        >
          <Icon name="return" size={16} />
          3. Returns & Size Exchanges
        </button>
        <button
          className={`wf-stage-tab ${activeStage === 'QC_REFUND' ? 'active' : ''}`}
          onClick={() => setActiveStage('QC_REFUND')}
        >
          <Icon name="dollar" size={16} />
          4. QC Verification & Refunds
        </button>
      </div>

      {/* Interactive Workflow Canvas */}
      <div className="wf-trees-canvas">
        {/* ========================================================
            TREE 1: ORDER INGESTION & DISPATCHING
           ======================================================== */}
        {(activeStage === 'ALL' || activeStage === 'DISPATCH') && (
          <div className="wf-tree-section">
            <div className="wf-tree-header">
              <div className="wf-section-badge s1">Stage 1</div>
              <div className="wf-section-title">
                <h3>Order Ingestion & Forward Dispatch Pipeline</h3>
                <p>Shopify webhook deduplication, GoKwik RTO risk gating, mutex locking, and carrier routing</p>
              </div>
            </div>

            <div className="wf-nodes-flow">
              {/* Node 1.1 */}
              <div className="wf-node-card">
                <div className="wf-node-top">
                  <span className="wf-node-pill pill-gray">Webhook Ingest</span>
                  <span className="wf-node-id">01</span>
                </div>
                <h4>Shopify <code>orders/create</code></h4>
                <p>Stateless payload verification with 15-minute TTL cache and database unique constraint on <code>shopifyOrderId</code>.</p>
                <div className="wf-node-meta">
                  <span className="wf-badge-tag">Stateless JWT</span>
                  <span className="wf-badge-tag">Idempotent</span>
                </div>
              </div>

              <div className="wf-arrow-connector">→</div>

              {/* Node 1.2 */}
              <div className="wf-node-card decision-node">
                <div className="wf-node-top">
                  <span className="wf-node-pill pill-amber">Decision Point</span>
                  <span className="wf-node-id">02</span>
                </div>
                <h4>Payment & Risk Split</h4>
                <p>
                  <strong>Prepaid:</strong> Immediate verification.<br />
                  <strong>COD:</strong> GoKwik RTO scoring & customer phone verification.
                </p>
                <div className="wf-branch-pills">
                  <span className="wf-branch-pill green">Prepaid: Auto-Ready</span>
                  <span className="wf-branch-pill red">High RTO: Cancel</span>
                </div>
              </div>

              <div className="wf-arrow-connector">→</div>

              {/* Node 1.3 */}
              <div className="wf-node-card highlighted-node">
                <div className="wf-node-top">
                  <span className="wf-node-pill pill-blue">Queue State</span>
                  <span className="wf-node-count-badge">{counts.new ?? 0}</span>
                </div>
                <h4>NEW / DISPATCH_PENDING</h4>
                <p>Orders ready for warehouse packing. Prioritized by delivery SLA and stock availability.</p>
                <div className="wf-node-action">
                  <Link to="/orders?tab=new" className="wf-action-link">
                    Open New Orders ({counts.new ?? 0}) →
                  </Link>
                </div>
              </div>

              <div className="wf-arrow-connector">→</div>

              {/* Node 1.4 */}
              <div className="wf-node-card">
                <div className="wf-node-top">
                  <span className="wf-node-pill pill-purple">Concurrency Gate</span>
                  <span className="wf-node-id">04</span>
                </div>
                <h4>Atomic Dispatch Lock</h4>
                <p>Acquires <code>Order.dispatchLockedAt</code> (2-minute TTL). Prevents double booking during concurrent bulk dispatches.</p>
                <div className="wf-node-meta">
                  <span className="wf-badge-tag">Atomic DB Mutex</span>
                </div>
              </div>

              <div className="wf-arrow-connector">→</div>

              {/* Node 1.5 */}
              <div className="wf-node-card decision-node">
                <div className="wf-node-top">
                  <span className="wf-node-pill pill-blue">Routing Engine</span>
                  <span className="wf-node-id">05</span>
                </div>
                <h4>Carrier Routing Choice</h4>
                <p>
                  <strong>Velocity:</strong> Primary/cheaper aggregator with auto-failover.<br />
                  <strong>Delhivery:</strong> B2C surface fallback.
                </p>
                <div className="wf-branch-pills">
                  <span className="wf-branch-pill blue">Velocity B2C</span>
                  <span className="wf-branch-pill orange">Delhivery Surface</span>
                </div>
              </div>

              <div className="wf-arrow-connector">→</div>

              {/* Node 1.6 */}
              <div className="wf-node-card success-node">
                <div className="wf-node-top">
                  <span className="wf-node-pill pill-green">Terminal Manifest</span>
                  <span className="wf-node-count-badge">{(counts.ready ?? 0) + (counts.transit ?? 0)}</span>
                </div>
                <h4>AWB Generated & Dispatched</h4>
                <p>AWB assigned, thermal packing slip generated with <code>youthnic2024</code>, and Shopify order fulfilled.</p>
                <div className="wf-node-action">
                  <Link to="/orders?tab=ready" className="wf-action-link">
                    View Dispatched ({counts.ready ?? 0}) →
                  </Link>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ========================================================
            TREE 2: IN-TRANSIT & DELIVERY TRACKING
           ======================================================== */}
        {(activeStage === 'ALL' || activeStage === 'TRACKING') && (
          <div className="wf-tree-section">
            <div className="wf-tree-header">
              <div className="wf-section-badge s2">Stage 2</div>
              <div className="wf-section-title">
                <h3>Delivery & Logistics Tracking State Machine</h3>
                <p>Real-time courier webhooks, 30-minute background pollers, NDR resolution, and terminal states</p>
              </div>
            </div>

            <div className="wf-nodes-flow">
              {/* Node 2.1 */}
              <div className="wf-node-card">
                <div className="wf-node-top">
                  <span className="wf-node-pill pill-blue">In Transit</span>
                  <span className="wf-node-count-badge">{counts.transit ?? 0}</span>
                </div>
                <h4>Courier Handover & Transit</h4>
                <p>Package picked up from warehouse hub. Tracked via Velocity & Delhivery push webhooks and periodic cron pollers.</p>
                <div className="wf-node-action">
                  <Link to="/orders?tab=transit" className="wf-action-link">
                    View In Transit ({counts.transit ?? 0}) →
                  </Link>
                </div>
              </div>

              <div className="wf-arrow-connector">→</div>

              {/* Node 2.2 */}
              <div className="wf-node-card">
                <div className="wf-node-top">
                  <span className="wf-node-pill pill-blue">Destination Hub</span>
                  <span className="wf-node-id">02</span>
                </div>
                <h4>Out for Delivery (OFD)</h4>
                <p>Package is on the delivery vehicle. Customer receives WhatsApp alert with live courier contact and delivery OTP.</p>
                <div className="wf-node-meta">
                  <span className="wf-badge-tag">WhatsApp Alert</span>
                  <span className="wf-badge-tag">Live OTP</span>
                </div>
              </div>

              <div className="wf-arrow-connector">→</div>

              {/* Node 2.3 */}
              <div className="wf-node-card decision-node">
                <div className="wf-node-top">
                  <span className="wf-node-pill pill-amber">Terminal Evaluation</span>
                  <span className="wf-node-id">03</span>
                </div>
                <h4>Delivery Outcome</h4>
                <p>Courier driver records delivery confirmation, non-delivery reason (NDR), or customer rejection.</p>
                <div className="wf-branch-pills">
                  <span className="wf-branch-pill green">Successful Delivery</span>
                  <span className="wf-branch-pill red">RTO / NDR Rejection</span>
                </div>
              </div>

              <div className="wf-arrow-connector">→</div>

              {/* Node 2.4 - Branch A */}
              <div className="wf-node-card success-node">
                <div className="wf-node-top">
                  <span className="wf-node-pill pill-green">Terminal Success</span>
                  <span className="wf-node-count-badge">{counts.delivered ?? 0}</span>
                </div>
                <h4>DELIVERED (COD Collected)</h4>
                <p>Courier collects COD payment. Marked delivered, closes 7-day customer window, feeds Accounts remittance ledger.</p>
                <div className="wf-node-action">
                  <Link to="/orders?tab=delivered" className="wf-action-link">
                    View Delivered ({counts.delivered ?? 0}) →
                  </Link>
                </div>
              </div>

              {/* Node 2.4 - Branch B */}
              <div className="wf-node-card danger-node">
                <div className="wf-node-top">
                  <span className="wf-node-pill pill-red">Return to Origin</span>
                  <span className="wf-node-id">RTO</span>
                </div>
                <h4>RTO_INITIATED → RTO_DELIVERED</h4>
                <p>Failed delivery / NDR exhausted. Reverse parcel routes back to warehouse hub for intake and restocking.</p>
                <div className="wf-node-action">
                  <Link to="/orders?tab=cancel" className="wf-action-link">
                    View Cancel/RTO →
                  </Link>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ========================================================
            TREE 3: RETURNS & SIZE EXCHANGES
           ======================================================== */}
        {(activeStage === 'ALL' || activeStage === 'RETURNS') && (
          <div className="wf-tree-section">
            <div className="wf-tree-header">
              <div className="wf-section-badge s3">Stage 3</div>
              <div className="wf-section-title">
                <h3>Customer Returns & Size Exchanges Lifecycle</h3>
                <p>Reverse pickup dispatching, dual-AWB replacement workflows, and warehouse hub transit</p>
              </div>
            </div>

            <div className="wf-nodes-flow">
              {/* Node 3.1 */}
              <div className="wf-node-card">
                <div className="wf-node-top">
                  <span className="wf-node-pill pill-blue">Initiation</span>
                  <span className="wf-node-id">01</span>
                </div>
                <h4>Customer Support / Desk Request</h4>
                <p>Customer initiates return within 7-day window. Desk operator checks eligibility and inspects photos.</p>
                <div className="wf-node-action">
                  <Link to="/support" className="wf-action-link">
                    Support Desk →
                  </Link>
                </div>
              </div>

              <div className="wf-arrow-connector">→</div>

              {/* Node 3.2 */}
              <div className="wf-node-card decision-node">
                <div className="wf-node-top">
                  <span className="wf-node-pill pill-purple">Dual Path</span>
                  <span className="wf-node-id">02</span>
                </div>
                <h4>Exchange vs Standard Return</h4>
                <p>
                  <strong>Exchange:</strong> Customer wants different size.<br />
                  <strong>Return:</strong> Customer requests monetary refund.
                </p>
                <div className="wf-branch-pills">
                  <span className="wf-branch-pill purple">Size Exchange</span>
                  <span className="wf-branch-pill blue">Standard Return</span>
                </div>
              </div>

              <div className="wf-arrow-connector">→</div>

              {/* Node 3.3 - Branch Exchange */}
              <div className="wf-node-card highlighted-node">
                <div className="wf-node-top">
                  <span className="wf-node-pill pill-purple">Dual AWB Booking</span>
                  <span className="wf-node-count-badge">{returnMetrics.exchanges}</span>
                </div>
                <h4>Size Exchange Flow (<code>-EX-FWD</code>)</h4>
                <p>
                  Simultaneously books:<br />
                  1. Reverse Pickup AWB (old item)<br />
                  2. Forward Replacement AWB (new size)<br />
                  Guarded by <code>CLAIMED_FOR_DISPATCH</code> mutex.
                </p>
                <div className="wf-node-action">
                  <Link to="/returns?tab=EXCHANGES" className="wf-action-link">
                    Active Exchanges ({returnMetrics.exchanges}) →
                  </Link>
                </div>
              </div>

              <div className="wf-arrow-connector">→</div>

              {/* Node 3.4 */}
              <div className="wf-node-card">
                <div className="wf-node-top">
                  <span className="wf-node-pill pill-gray">Reverse Logistics</span>
                  <span className="wf-node-id">04</span>
                </div>
                <h4>Carrier Reverse Pickup</h4>
                <p>Velocity / Delhivery picks up old item from customer doorstep with return packing slip.</p>
                <div className="wf-node-meta">
                  <span className="wf-badge-tag">Reverse Tracking</span>
                </div>
              </div>

              <div className="wf-arrow-connector">→</div>

              {/* Node 3.5 */}
              <div className="wf-node-card">
                <div className="wf-node-top">
                  <span className="wf-node-pill pill-blue">Intake Ready</span>
                  <span className="wf-node-count-badge">{returnMetrics.pendingQc}</span>
                </div>
                <h4>Arrived at Warehouse Hub</h4>
                <p>Reverse parcel arrives at warehouse loading dock. Ready for operator barcode scan and QC check.</p>
                <div className="wf-node-action">
                  <Link to="/returns?tab=PENDING_QC" className="wf-action-link">
                    Scan Intake Queue ({returnMetrics.pendingQc}) →
                  </Link>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ========================================================
            TREE 4: QC VERIFICATION & FINANCIAL SETTLEMENT
           ======================================================== */}
        {(activeStage === 'ALL' || activeStage === 'QC_REFUND') && (
          <div className="wf-tree-section">
            <div className="wf-tree-header">
              <div className="wf-section-badge s4">Stage 4</div>
              <div className="wf-section-title">
                <h3>Warehouse QC Verification & Refund Settlement Tree</h3>
                <p>Barcode gun intake, exchange refund suppression, Shopify API auto-refund, and COD manual payout verification</p>
              </div>
            </div>

            <div className="wf-nodes-flow">
              {/* Node 4.1 */}
              <div className="wf-node-card">
                <div className="wf-node-top">
                  <span className="wf-node-pill pill-blue">Intake Scan</span>
                  <span className="wf-node-id">01</span>
                </div>
                <h4>Warehouse Barcode Gun Scan</h4>
                <p>Operator scans return AWB via <code>POST /api/returns/scan</code>. Verifies parcel contents and records condition.</p>
                <div className="wf-node-action">
                  <Link to="/returns" className="wf-action-link">
                    Open Returns Scanner →
                  </Link>
                </div>
              </div>

              <div className="wf-arrow-connector">→</div>

              {/* Node 4.2 */}
              <div className="wf-node-card decision-node">
                <div className="wf-node-top">
                  <span className="wf-node-pill pill-amber">Security Gate</span>
                  <span className="wf-node-id">02</span>
                </div>
                <h4>Is Size Exchange?</h4>
                <p>
                  <strong>If Exchange:</strong> Suppresses monetary refund! Forward replacement item satisfies order.<br />
                  <strong>If Standard Return:</strong> Proceeds to financial refund.
                </p>
                <div className="wf-branch-pills">
                  <span className="wf-branch-pill purple">Exchange: Suppress Refund</span>
                  <span className="wf-branch-pill green">Return: Refund Item</span>
                </div>
              </div>

              <div className="wf-arrow-connector">→</div>

              {/* Node 4.3 */}
              <div className="wf-node-card decision-node">
                <div className="wf-node-top">
                  <span className="wf-node-pill pill-blue">Payment Gateway</span>
                  <span className="wf-node-id">03</span>
                </div>
                <h4>Prepaid vs COD Settlement</h4>
                <p>
                  <strong>Prepaid:</strong> Automated Shopify refund with idempotency key.<br />
                  <strong>COD:</strong> Queued for manual UPI bank proof verification.
                </p>
                <div className="wf-branch-pills">
                  <span className="wf-branch-pill green">Prepaid: Auto API</span>
                  <span className="wf-branch-pill orange">COD: Manual Review</span>
                </div>
              </div>

              <div className="wf-arrow-connector">→</div>

              {/* Node 4.4 - Branch Prepaid */}
              <div className="wf-node-card success-node">
                <div className="wf-node-top">
                  <span className="wf-node-pill pill-green">Shopify Auto-API</span>
                  <span className="wf-node-id">Prepaid</span>
                </div>
                <h4>Prepaid Idempotent Auto-Refund</h4>
                <p>
                  Calls Shopify <code>refunds.json</code> with key <code>oms-return-&#123;id&#125;</code>. Restocks inventory and marks <code>REFUNDED</code>.
                </p>
                <div className="wf-node-action">
                  <Link to="/returns?tab=REFUNDED" className="wf-action-link">
                    Settled Returns ({returnMetrics.refunded}) →
                  </Link>
                </div>
              </div>

              {/* Node 4.4 - Branch COD */}
              <div className="wf-node-card highlighted-node">
                <div className="wf-node-top">
                  <span className="wf-node-pill pill-amber">Manual Payout</span>
                  <span className="wf-node-count-badge">{returnMetrics.codDue}</span>
                </div>
                <h4>COD Manual Payout Review</h4>
                <p>
                  Operator verifies customer UPI/bank details, uploads payment screenshot, enters UTR, validates cumulative order total limit.
                </p>
                <div className="wf-node-action">
                  <Link to="/returns?tab=COD_DUE" className="wf-action-link">
                    COD Due Queue ({returnMetrics.codDue}) →
                  </Link>
                </div>
              </div>

              <div className="wf-arrow-connector">→</div>

              {/* Node 4.5 */}
              <div className="wf-node-card success-node">
                <div className="wf-node-top">
                  <span className="wf-node-pill pill-green">Accounts Ledger</span>
                  <span className="wf-node-id">05</span>
                </div>
                <h4>Settled in Account Trail</h4>
                <p>
                  <code>AccountTrailEvent</code> recorded in database. Linked with Velocity / Delhivery COD remittance ledger.
                </p>
                <div className="wf-node-action">
                  <Link to="/remittance" className="wf-action-link">
                    Open Accounts & Remittance →
                  </Link>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
