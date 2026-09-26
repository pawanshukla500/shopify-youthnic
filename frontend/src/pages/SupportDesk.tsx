import { useState, useMemo, type FormEvent } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  getSupportDiagnostics,
  getSupportEmails,
  getSupportEmail,
  ingestInboundEmail,
  replySupportEmail,
  learnKnowledgePattern,
  getCustomerSupportHistory,
  getKnowledgePatterns,
  analyzeConversationAgent,
  getCustomerAgentMemory,
  getMetaAgentConfig,
  updateMetaAgentConfig,
  apiError,
} from '../api'
import { ErrorBox, Icon, LoadingState, PageIntro, Panel, PanelHeading, useDocumentTitle, useToast } from '../components/UI'
import type { InboundEmail, CustomerHistoryEvent } from '../types'
import { formatDate, formatMoney } from '../lib'

type FilterTab = 'ALL' | 'URGENT' | 'RETURNS' | 'DELAYS' | 'RESOLVED'

export function SupportDesk() {
  useDocumentTitle('Customer Support & Returns Mail Desk')
  const toast = useToast()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [searchParams] = useSearchParams()

  const [activeTab, setActiveTab] = useState<FilterTab>('ALL')
  const [searchQuery, setSearchQuery] = useState(searchParams.get('search') || '')
  const [selectedTicketId, setSelectedTicketId] = useState<number | null>(null)

  // Reply Composer State
  const [replyText, setReplyText] = useState('')
  const [replySubject, setReplySubject] = useState('')
  const [senderEmail, setSenderEmail] = useState<'contact@youthnic.com' | 'return@youthnic.com'>('contact@youthnic.com')
  const [learnPatternToggle, setLearnPatternToggle] = useState(true)
  const [markResolvedToggle, setMarkResolvedToggle] = useState(false)

  // Simulation Modal State
  const [isSimulateModalOpen, setIsSimulateModalOpen] = useState(false)
  const [simFromEmail, setSimFromEmail] = useState('neha.verma@example.com')
  const [simFromName, setSimFromName] = useState('Neha Verma')
  const [simOrderNumber, setSimOrderNumber] = useState('26YOU5752')
  const [simSubject, setSimSubject] = useState('Received damaged floral kurti with torn stitch')
  const [simBody, setSimBody] = useState(
    'Hi Youthnic, I received my order #26YOU5752 today and upon opening the packet, the floral kurti has torn stitching on the left seam. This is very defective. I want an immediate return and refund. Please arrange pickup.'
  )

  // History Tab
  const [showHistoryDrawer, setShowHistoryDrawer] = useState(false)

  // Meta LLM Configuration Modal State
  const [isMetaModalOpen, setIsMetaModalOpen] = useState(false)
  const [metaApiKeyInput, setMetaApiKeyInput] = useState('')
  const [metaModelInput, setMetaModelInput] = useState('muse-spark-1.3-contributor')
  const [isTestingMeta, setIsTestingMeta] = useState(false)
  const [isReanalyzing, setIsReanalyzing] = useState(false)

  // Queries
  const diagnosticsQuery = useQuery({
    queryKey: ['support-diagnostics'],
    queryFn: getSupportDiagnostics,
    refetchInterval: 30_000,
  })

  const emailsQuery = useQuery({
    queryKey: ['support-emails', activeTab, searchQuery],
    queryFn: () => {
      let urgency: string | undefined = undefined
      let category: string | undefined = undefined
      let status: string | undefined = undefined

      if (activeTab === 'URGENT') urgency = 'URGENT'
      else if (activeTab === 'RETURNS') category = 'RETURN_REQUEST'
      else if (activeTab === 'DELAYS') category = 'TRANSIT_DELAY'
      else if (activeTab === 'RESOLVED') status = 'RESOLVED'

      return getSupportEmails({
        urgency,
        category,
        status,
        search: searchQuery || undefined,
      })
    },
    refetchInterval: 15_000,
  })

  const selectedEmailQuery = useQuery({
    queryKey: ['support-email', selectedTicketId],
    queryFn: () => (selectedTicketId ? getSupportEmail(selectedTicketId) : null),
    enabled: Boolean(selectedTicketId),
  })

  const patternsQuery = useQuery({
    queryKey: ['knowledge-patterns'],
    queryFn: getKnowledgePatterns,
    staleTime: 30_000,
  })

  const customerHistoryQuery = useQuery({
    queryKey: ['customer-history', selectedEmailQuery.data?.email?.fromEmail],
    queryFn: () =>
      selectedEmailQuery.data?.email?.fromEmail
        ? getCustomerSupportHistory(selectedEmailQuery.data.email.fromEmail)
        : null,
    enabled: Boolean(selectedEmailQuery.data?.email?.fromEmail),
  })

  // Customer Agent Memory query (Firebase RTDB)
  const agentMemoryQuery = useQuery({
    queryKey: ['agent-memory', selectedEmailQuery.data?.email?.fromEmail],
    queryFn: () =>
      selectedEmailQuery.data?.email?.fromEmail
        ? getCustomerAgentMemory(selectedEmailQuery.data.email.fromEmail)
        : null,
    enabled: Boolean(selectedEmailQuery.data?.email?.fromEmail),
    refetchInterval: 20_000,
  })

  // Meta LLM Config query
  const metaConfigQuery = useQuery({
    queryKey: ['meta-llm-config'],
    queryFn: getMetaAgentConfig,
  })

  // Set selected ticket default on initial load
  const tickets = emailsQuery.data?.emails || []
  const activeTicket = selectedEmailQuery.data?.email || (tickets.length > 0 && selectedTicketId === null ? tickets[0] : tickets.find(t => t.id === selectedTicketId))

  // When active ticket changes, populate reply draft and default sender
  useMemo(() => {
    if (activeTicket) {
      if (selectedTicketId !== activeTicket.id) {
        setSelectedTicketId(activeTicket.id)
      }
      setReplySubject(`Re: ${activeTicket.subject}`)
      setReplyText(activeTicket.replyText || activeTicket.suggestedReply || '')
      if (activeTicket.category === 'RETURN_REQUEST' || activeTicket.category === 'EXCHANGE_REQUEST') {
        setSenderEmail('return@youthnic.com')
      } else {
        setSenderEmail('contact@youthnic.com')
      }
    }
  }, [activeTicket?.id])

  // Mutations
  const replyMutation = useMutation({
    mutationFn: (variables: { id: number; replyText: string; customSubject?: string; fromEmail?: string; resolved: boolean; learnPattern: boolean }) =>
      replySupportEmail(variables.id, {
        replyText: variables.replyText,
        customSubject: variables.customSubject,
        fromEmail: variables.fromEmail,
        resolved: variables.resolved,
        learnPattern: variables.learnPattern,
      }),
    onSuccess: (data, variables) => {
      toast.toast('success', `Reply dispatched from ${variables.fromEmail || 'contact@youthnic.com'} to ${data.ticket.fromEmail}!`)
      queryClient.invalidateQueries({ queryKey: ['support-emails'] })
      queryClient.invalidateQueries({ queryKey: ['support-email', selectedTicketId] })
      queryClient.invalidateQueries({ queryKey: ['customer-history'] })
      queryClient.invalidateQueries({ queryKey: ['knowledge-patterns'] })
      queryClient.invalidateQueries({ queryKey: ['orders'] })
    },
    onError: (err) => {
      toast.toast('error', `Failed to send reply: ${apiError(err)}`)
    },
  })

  const simulateMutation = useMutation({
    mutationFn: ingestInboundEmail,
    onSuccess: (data) => {
      toast.toast(
        'success',
        `Simulated inbound email ingested & triaged as ${data.ticket.urgency} (${data.ticket.category})!`
      )
      setIsSimulateModalOpen(false)
      setSelectedTicketId(data.ticket.id)
      queryClient.invalidateQueries({ queryKey: ['support-emails'] })
      queryClient.invalidateQueries({ queryKey: ['orders'] })
      queryClient.invalidateQueries({ queryKey: ['agent-memory'] })
    },
    onError: (err) => {
      toast.toast('error', `Simulation failed: ${apiError(err)}`)
    },
  })

  const handleUpdateMetaConfig = async (e: FormEvent) => {
    e.preventDefault()
    try {
      setIsTestingMeta(true)
      await updateMetaAgentConfig({
        apiKey: metaApiKeyInput || undefined,
        model: metaModelInput,
      })
      toast.toast('success', 'Meta Model API configuration updated!')
      queryClient.invalidateQueries({ queryKey: ['meta-llm-config'] })
      queryClient.invalidateQueries({ queryKey: ['support-diagnostics'] })
      setIsMetaModalOpen(false)
    } catch (err: any) {
      toast.toast('error', `Failed to update config: ${apiError(err)}`)
    } finally {
      setIsTestingMeta(false)
    }
  }

  const handleReanalyzeWithMetaLlm = async () => {
    if (!activeTicket) return
    try {
      setIsReanalyzing(true)
      const result = await analyzeConversationAgent({
        customerIdentifier: activeTicket.fromEmail,
        text: activeTicket.bodyText || '',
        subject: activeTicket.subject,
        channel: 'EMAIL',
        orderNumberHint: activeTicket.shopifyOrderName || undefined,
        autoExecuteActions: true,
      })
      toast.toast(
        'success',
        `Analyzed with ${result.analysis.modelUsed}! Intent: ${result.analysis.intent}, Actions: ${result.triggeredActions.length}`
      )
      if (result.analysis.draftReply) {
        setReplyText(result.analysis.draftReply)
      }
      queryClient.invalidateQueries({ queryKey: ['support-emails'] })
      queryClient.invalidateQueries({ queryKey: ['support-email', activeTicket.id] })
      queryClient.invalidateQueries({ queryKey: ['agent-memory', activeTicket.fromEmail] })
      queryClient.invalidateQueries({ queryKey: ['customer-history', activeTicket.fromEmail] })
      queryClient.invalidateQueries({ queryKey: ['orders'] })
    } catch (err: any) {
      toast.toast('error', `Agent analysis failed: ${apiError(err)}`)
    } finally {
      setIsReanalyzing(false)
    }
  }

  const diag = diagnosticsQuery.data

  return (
    <div className="orders-page" style={{ maxWidth: '1440px', margin: '0 auto', paddingBottom: '60px' }}>
      {/* ─── Page Intro & Real-time Diagnostics ──────────────────── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '16px', marginBottom: '20px' }}>
        <PageIntro
          eyebrow="21st.dev Support Desk · AI-Powered Triage"
          title="Customer Inbound & Returns Mail Hub"
          description="Automated triage using Muse Spark 1.3 Contributor model, order urgency flagging, zero-token resolution patterns, and official dispatch from return@youthnic.com."
        />

        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
          {/* Delhivery Diagnostic */}
          <div className="status-badge" style={{ background: '#ecfdf5', borderColor: '#a7f3d0', color: '#047857' }} title={diag?.delhivery?.message}>
            <span className="status-dot" style={{ background: '#10b981' }} />
            <span>Delhivery: {diag?.delhivery?.status === 'ok' ? `Live (${diag.delhivery.latencyMs}ms)` : 'Error'}</span>
          </div>

          {/* Kapso Diagnostic */}
          <div className="status-badge" style={{ background: '#f0fdf4', borderColor: '#bbf7d0', color: '#15803d' }} title={diag?.kapso?.message}>
            <span className="status-dot" style={{ background: '#22c55e' }} />
            <span>Kapso WhatsApp: {diag?.kapso?.status === 'ok' ? 'Live Connected' : 'Simulated'}</span>
          </div>

          {/* Firebase RTDB Diagnostic */}
          <div className="status-badge" style={{ background: '#f5f3ff', borderColor: '#ddd6fe', color: '#6d28d9' }} title="Firebase Realtime Database: shopify-134b9">
            <span className="status-dot" style={{ background: '#8b5cf6' }} />
            <span>Firebase RTDB: shopify-134b9</span>
          </div>

          {/* Resend Diagnostic */}
          <div className="status-badge" style={{ background: '#eff6ff', borderColor: '#bfdbfe', color: '#1d4ed8' }} title="Sender: return@youthnic.com">
            <span className="status-dot" style={{ background: '#3b82f6' }} />
            <span>Resend: return@youthnic.com</span>
          </div>

          {/* Meta Model API Diagnostic (muse-spark-1.3-contributor) */}
          <div
            className="status-badge"
            style={{
              background: '#faf5ff',
              borderColor: '#e9d5ff',
              color: '#7e22ce',
              cursor: 'pointer',
            }}
            onClick={() => setIsMetaModalOpen(true)}
            title="Click to configure Meta Model API key"
          >
            <span className="status-dot" style={{ background: '#a855f7' }} />
            <span>Meta LLM: muse-spark-1.3-contributor</span>
            <span style={{ fontSize: '10px', marginLeft: '4px', textDecoration: 'underline' }}>⚙</span>
          </div>

          <button
            type="button"
            className="button button-primary"
            style={{ height: '32px', fontSize: '12px', padding: '0 12px' }}
            onClick={() => setIsSimulateModalOpen(true)}
          >
            <Icon name="plus" size={14} />
            <span>Simulate Inbound Email</span>
          </button>
        </div>
      </div>

      {/* ─── Metric KPI Cards ────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '14px', marginBottom: '22px' }}>
        <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: '10px', padding: '16px' }}>
          <span style={{ fontSize: '11px', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Open Support Tickets
          </span>
          <div style={{ fontSize: '24px', fontWeight: 800, color: 'var(--ink)', marginTop: '4px' }}>
            {emailsQuery.data?.openCount ?? 0}
          </div>
          <span style={{ fontSize: '11px', color: '#64748b', marginTop: '2px', display: 'block' }}>
            Awaiting response or reverse pickup
          </span>
        </div>

        <div style={{ background: 'var(--panel)', border: '1px solid #fecaca', borderRadius: '10px', padding: '16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '11px', fontWeight: 700, color: '#dc2626', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              🚨 Urgent Claims & Defects
            </span>
            <span style={{ background: '#fee2e2', color: '#b91c1c', fontSize: '10px', padding: '1px 6px', borderRadius: '4px', fontWeight: 700 }}>
              Flagged
            </span>
          </div>
          <div style={{ fontSize: '24px', fontWeight: 800, color: '#b91c1c', marginTop: '4px' }}>
            {emailsQuery.data?.urgentCount ?? 0}
          </div>
          <span style={{ fontSize: '11px', color: '#dc2626', marginTop: '2px', display: 'block' }}>
            High-priority returns & damage reports
          </span>
        </div>

        <div style={{ background: 'var(--panel)', border: '1px solid #ddd6fe', borderRadius: '10px', padding: '16px' }}>
          <span style={{ fontSize: '11px', fontWeight: 700, color: '#6d28d9', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            🔄 Return Requests
          </span>
          <div style={{ fontSize: '24px', fontWeight: 800, color: '#6d28d9', marginTop: '4px' }}>
            {emailsQuery.data?.returnCount ?? 0}
          </div>
          <span style={{ fontSize: '11px', color: '#7c3aed', marginTop: '2px', display: 'block' }}>
            Doorstep pickup requests
          </span>
        </div>

        <div style={{ background: 'var(--panel)', border: '1px solid #a7f3d0', borderRadius: '10px', padding: '16px' }}>
          <span style={{ fontSize: '11px', fontWeight: 700, color: '#047857', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            ⚡ Self-Learned Resolution Cache
          </span>
          <div style={{ fontSize: '24px', fontWeight: 800, color: '#047857', marginTop: '4px' }}>
            {patternsQuery.data?.patterns?.length ?? 5} Patterns
          </div>
          <span style={{ fontSize: '11px', color: '#059669', marginTop: '2px', display: 'block' }}>
            0-token offline pattern matching active
          </span>
        </div>
      </div>

      {/* ─── Filters & Search Bar ─────────────────────────────────── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '14px', flexWrap: 'wrap', marginBottom: '18px' }}>
        <div className="segmented-tabs-container">
          <button
            type="button"
            className={`tab-trigger-21st ${activeTab === 'ALL' ? 'active' : ''}`}
            onClick={() => setActiveTab('ALL')}
          >
            All Tickets <span className="tab-badge">{emailsQuery.data?.total ?? 0}</span>
          </button>
          <button
            type="button"
            className={`tab-trigger-21st ${activeTab === 'URGENT' ? 'active' : ''}`}
            style={{ color: activeTab === 'URGENT' ? '#ef4444' : undefined }}
            onClick={() => setActiveTab('URGENT')}
          >
            🚨 Urgent <span className="tab-badge" style={{ background: 'rgba(239, 68, 68, 0.15)', color: '#ef4444' }}>{emailsQuery.data?.urgentCount ?? 0}</span>
          </button>
          <button
            type="button"
            className={`tab-trigger-21st ${activeTab === 'RETURNS' ? 'active' : ''}`}
            onClick={() => setActiveTab('RETURNS')}
          >
            🔄 Returns <span className="tab-badge">{emailsQuery.data?.returnCount ?? 0}</span>
          </button>
          <button
            type="button"
            className={`tab-trigger-21st ${activeTab === 'DELAYS' ? 'active' : ''}`}
            onClick={() => setActiveTab('DELAYS')}
          >
            ⏱️ Transit Delays
          </button>
          <button
            type="button"
            className={`tab-trigger-21st ${activeTab === 'RESOLVED' ? 'active' : ''}`}
            onClick={() => setActiveTab('RESOLVED')}
          >
            ✓ Resolved
          </button>
        </div>

        <div className="search-field" style={{ maxWidth: '340px' }}>
          <Icon name="search" size={14} />
          <input
            placeholder="Search by customer, email, order #…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
      </div>

      {/* ─── Two-Column Support Workspace ──────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(340px, 1fr) minmax(500px, 1.6fr)', gap: '20px', alignItems: 'start' }}>
        {/* LEFT COLUMN: Inbound Ticket Feed */}
        <Panel style={{ maxHeight: 'calc(100vh - 280px)', overflowY: 'auto', padding: '8px' }}>
          <div style={{ display: 'grid', gap: '8px' }}>
            {emailsQuery.isLoading && <LoadingState label="Loading support tickets…" />}
            {tickets.length === 0 && !emailsQuery.isLoading && (
              <div style={{ textAlign: 'center', padding: '40px 20px', color: '#64748b' }}>
                <Icon name="mail" size={32} />
                <p style={{ marginTop: '8px', fontSize: '13px', fontWeight: 600 }}>No support tickets in this queue</p>
                <button
                  type="button"
                  className="button button-secondary"
                  style={{ marginTop: '8px', fontSize: '12px' }}
                  onClick={() => setIsSimulateModalOpen(true)}
                >
                  Simulate a customer inquiry
                </button>
              </div>
            )}

            {tickets.map((ticket) => {
              const isSelected = selectedTicketId === ticket.id
              const isUrgent = ticket.urgency === 'URGENT'

              return (
                <div
                  key={ticket.id}
                  onClick={() => setSelectedTicketId(ticket.id)}
                  style={{
                    padding: '12px 14px',
                    borderRadius: '8px',
                    border: isSelected ? '2px solid #2563eb' : isUrgent ? '1px solid #fecaca' : '1px solid var(--line)',
                    background: isSelected ? 'var(--canvas)' : isUrgent ? '#fff5f5' : 'var(--panel)',
                    cursor: 'pointer',
                    transition: 'all 0.15s ease',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px', marginBottom: '6px' }}>
                    <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                      {isUrgent ? (
                        <span style={{ background: '#fee2e2', color: '#b91c1c', fontSize: '10px', fontWeight: 800, padding: '1px 6px', borderRadius: '4px' }}>
                          🚨 URGENT
                        </span>
                      ) : ticket.urgency === 'HIGH' ? (
                        <span style={{ background: '#fef3c7', color: '#b45309', fontSize: '10px', fontWeight: 800, padding: '1px 6px', borderRadius: '4px' }}>
                          ⚡ HIGH
                        </span>
                      ) : (
                        <span style={{ background: '#f1f5f9', color: '#475569', fontSize: '10px', fontWeight: 600, padding: '1px 6px', borderRadius: '4px' }}>
                          NORMAL
                        </span>
                      )}

                      <span style={{ fontSize: '10.5px', color: '#2563eb', fontWeight: 700, background: '#eff6ff', padding: '1px 6px', borderRadius: '4px' }}>
                        {ticket.category.replace('_', ' ')}
                      </span>

                      {ticket.shopifyOrderName && (
                        <span style={{ fontSize: '10.5px', color: 'var(--ink)', fontWeight: 700, background: 'var(--line-subtle)', padding: '1px 6px', borderRadius: '4px' }}>
                          {ticket.shopifyOrderName}
                        </span>
                      )}
                    </div>

                    <span style={{ fontSize: '10px', color: '#64748b', whiteSpace: 'nowrap' }}>
                      {formatDate(ticket.createdAt)}
                    </span>
                  </div>

                  <div style={{ fontWeight: 700, fontSize: '12.5px', color: 'var(--ink)', marginBottom: '3px' }}>
                    {ticket.subject}
                  </div>

                  <div style={{ fontSize: '11px', color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {ticket.bodyText}
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '6px', fontSize: '10.5px', color: '#475569' }}>
                    <span>{ticket.fromName || ticket.fromEmail}</span>
                    <span
                      style={{
                        color: ticket.status === 'RESOLVED' ? '#059669' : ticket.status === 'REPLIED' ? '#2563eb' : '#d97706',
                        fontWeight: 700,
                      }}
                    >
                      {ticket.status === 'RESOLVED' ? '✓ Resolved' : ticket.status === 'REPLIED' ? '💬 Replied' : '● Open'}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        </Panel>

        {/* RIGHT COLUMN: Active Ticket Workspace */}
        {activeTicket ? (
          <div style={{ display: 'grid', gap: '16px' }}>
            {/* 1. Linked Order Context Card */}
            <Panel style={{ padding: '16px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '12px' }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 800 }}>
                      Ticket #{activeTicket.id}: {activeTicket.fromName || activeTicket.fromEmail}
                    </h3>
                    {activeTicket.urgency === 'URGENT' && (
                      <span style={{ background: '#fee2e2', color: '#b91c1c', fontSize: '10px', fontWeight: 800, padding: '2px 8px', borderRadius: '4px' }}>
                        🚨 ACTION REQUIRED
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: '11.5px', color: '#64748b', marginTop: '3px' }}>
                    From: <strong>{activeTicket.fromEmail}</strong> · Received: {formatDate(activeTicket.createdAt)}
                  </div>
                </div>

                <div style={{ display: 'flex', gap: '6px' }}>
                  <button
                    type="button"
                    className="button button-secondary"
                    style={{ fontSize: '11px', height: '30px', padding: '0 10px' }}
                    onClick={() => setShowHistoryDrawer(!showHistoryDrawer)}
                  >
                    <Icon name="clock" size={13} />
                    <span>Customer History</span>
                  </button>
                  {activeTicket.order && (
                    <button
                      type="button"
                      className="button button-secondary"
                      style={{ fontSize: '11px', height: '30px', padding: '0 10px', color: '#2563eb' }}
                      onClick={() => navigate(`/orders/${activeTicket.order?.id}`)}
                    >
                      <Icon name="external" size={13} />
                      <span>Open in OMS</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Linked Order Banner */}
              {activeTicket.order ? (
                <div style={{ background: 'var(--canvas)', border: '1px solid var(--line)', borderRadius: '8px', padding: '12px 14px', marginTop: '14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
                  <div>
                    <span style={{ fontSize: '11px', color: '#64748b' }}>Linked Order:</span>
                    <div style={{ fontWeight: 800, fontSize: '13px', color: 'var(--ink)' }}>
                      {activeTicket.order.shopifyOrderName} · {formatMoney(activeTicket.order.totalAmount)}
                    </div>
                  </div>
                  <div>
                    <span style={{ fontSize: '11px', color: '#64748b' }}>Shipment Status:</span>
                    <div style={{ fontWeight: 700, fontSize: '12px', color: '#2563eb' }}>
                      {activeTicket.order.status}
                    </div>
                  </div>
                  {activeTicket.order.shipment?.waybillNumber && (
                    <div>
                      <span style={{ fontSize: '11px', color: '#64748b' }}>Delhivery Waybill:</span>
                      <div>
                        <a
                          href={`https://www.delhivery.com/track/package/${activeTicket.order.shipment.waybillNumber}`}
                          target="_blank"
                          rel="noreferrer"
                          style={{ color: '#2563eb', fontWeight: 700, fontSize: '12px', textDecoration: 'none' }}
                        >
                          {activeTicket.order.shipment.waybillNumber} ↗
                        </a>
                      </div>
                    </div>
                  )}
                  {activeTicket.order.hasUrgentSupport && (
                    <div style={{ background: '#fee2e2', border: '1px solid #fca5a5', padding: '4px 10px', borderRadius: '6px', fontSize: '11px', color: '#991b1b', fontWeight: 700 }}>
                      ⚠️ Order flagged: {activeTicket.order.supportFlag}
                    </div>
                  )}
                </div>
              ) : (
                <div style={{ fontSize: '11.5px', color: '#64748b', marginTop: '10px', background: 'var(--canvas)', padding: '8px 12px', borderRadius: '6px' }}>
                  ℹ️ No exact order linked automatically. You can specify order number in reply.
                </div>
              )}
            </Panel>

            {/* 2. Customer Inbound Email Bubble */}
            <Panel style={{ padding: '16px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <span style={{ fontSize: '12px', fontWeight: 750, color: 'var(--ink)' }}>
                  Customer Message: "{activeTicket.subject}"
                </span>
                <span style={{ fontSize: '11px', color: '#64748b' }}>
                  Sent to: <code>return@youthnic.com</code>
                </span>
              </div>
              <div style={{ background: '#ffffff', border: '1px solid #cbd5e1', borderRadius: '8px', padding: '14px', fontSize: '13px', lineHeight: '1.6', color: '#1e293b', whiteSpace: 'pre-wrap' }}>
                {activeTicket.bodyText}
              </div>
            </Panel>

            {/* 3. AI Triage & Sentiment Analysis ("Muse Spark 1.3 Contributor") */}
            <Panel style={{ padding: '16px', background: '#f8fafc', borderColor: '#e2e8f0' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span style={{ fontSize: '14px' }}>✨</span>
                  <strong style={{ fontSize: '13px', color: '#0f172a' }}>Muse Spark 1.3 Triage Analysis</strong>
                </div>
                {activeTicket.aiAnalysis?.isLearnedMatch ? (
                  <span style={{ background: '#ecfdf5', color: '#047857', border: '1px solid #a7f3d0', fontSize: '10.5px', padding: '2px 8px', borderRadius: '4px', fontWeight: 700 }}>
                    ⚡ 0-Token Knowledge Base Match (100% Cache)
                  </span>
                ) : (
                  <span style={{ background: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe', fontSize: '10.5px', padding: '2px 8px', borderRadius: '4px', fontWeight: 700 }}>
                    ✨ AI Heuristic Inference
                  </span>
                )}
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '8px', marginBottom: '10px', fontSize: '11.5px' }}>
                <div style={{ background: '#ffffff', padding: '8px 10px', borderRadius: '6px', border: '1px solid #e2e8f0' }}>
                  <span style={{ color: '#64748b', display: 'block', fontSize: '10px' }}>INTENT CATEGORY</span>
                  <strong style={{ color: '#0f172a' }}>{activeTicket.category.replace('_', ' ')}</strong>
                </div>
                <div style={{ background: '#ffffff', padding: '8px 10px', borderRadius: '6px', border: '1px solid #e2e8f0' }}>
                  <span style={{ color: '#64748b', display: 'block', fontSize: '10px' }}>URGENCY</span>
                  <strong style={{ color: activeTicket.urgency === 'URGENT' ? '#b91c1c' : '#047857' }}>{activeTicket.urgency}</strong>
                </div>
                <div style={{ background: '#ffffff', padding: '8px 10px', borderRadius: '6px', border: '1px solid #e2e8f0' }}>
                  <span style={{ color: '#64748b', display: 'block', fontSize: '10px' }}>DETECTED SENTIMENT</span>
                  <strong style={{ color: activeTicket.sentiment === 'FRUSTRATED' || activeTicket.sentiment === 'URGENT' ? '#b91c1c' : '#334155' }}>
                    {activeTicket.sentiment}
                  </strong>
                </div>
                <div style={{ background: '#ffffff', padding: '8px 10px', borderRadius: '6px', border: '1px solid #e2e8f0' }}>
                  <span style={{ color: '#64748b', display: 'block', fontSize: '10px' }}>CONFIDENCE</span>
                  <strong style={{ color: '#047857' }}>{Math.round((activeTicket.aiAnalysis?.confidence ?? 0.95) * 100)}%</strong>
                </div>
              </div>

              <div style={{ fontSize: '12px', color: '#475569', lineHeight: '1.5', marginBottom: '12px' }}>
                <strong>Recommendation:</strong> {activeTicket.aiAnalysis?.suggestedAction || activeTicket.flagReason}
              </div>

              {/* Action Button: Re-analyze with Meta LLM */}
              <div style={{ display: 'flex', justifyContent: 'flex-end', borderTop: '1px solid #e2e8f0', paddingTop: '10px' }}>
                <button
                  type="button"
                  className="button button-secondary"
                  style={{
                    fontSize: '11.5px',
                    height: '28px',
                    padding: '0 12px',
                    background: '#ffffff',
                    color: '#7e22ce',
                    borderColor: '#d8b4fe',
                  }}
                  disabled={isReanalyzing}
                  onClick={handleReanalyzeWithMetaLlm}
                >
                  <Icon name="refresh" size={12} />
                  <span>{isReanalyzing ? 'Analyzing with Meta LLM...' : '⚡ Re-analyze with Muse Spark 1.3 Contributor'}</span>
                </button>
              </div>
            </Panel>

            {/* 3B. Autonomous Agent Harness Memory (Firebase RTDB) */}
            {agentMemoryQuery.data?.memory && (
              <Panel style={{ padding: '16px', background: '#faf5ff', borderColor: '#e9d5ff' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontSize: '16px' }}>🧠</span>
                    <div>
                      <h4 style={{ margin: 0, fontSize: '13px', fontWeight: 800, color: '#581c87' }}>
                        Customer Agent Memory (Firebase Realtime Database)
                      </h4>
                      <span style={{ fontSize: '10.5px', color: '#7e22ce' }}>
                        Node: <code>/agent_memory/customers/{agentMemoryQuery.data.memory.customerIdentifier?.replace(/[^a-zA-Z0-9]/g, '_')}</code>
                      </span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                    <span style={{ background: '#f3e8ff', color: '#6b21a8', fontSize: '11px', fontWeight: 700, padding: '2px 8px', borderRadius: '4px', border: '1px solid #d8b4fe' }}>
                      Trust Score: {agentMemoryQuery.data.memory.profile?.trustScore ?? 85}/100
                    </span>
                    {agentMemoryQuery.data.memory.profile?.totalOrders > 0 && (
                      <span style={{ background: '#ecfdf5', color: '#065f46', fontSize: '11px', fontWeight: 700, padding: '2px 8px', borderRadius: '4px', border: '1px solid #a7f3d0' }}>
                        Orders: {agentMemoryQuery.data.memory.profile.totalOrders}
                      </span>
                    )}
                  </div>
                </div>

                {/* Long-Term Learned Facts */}
                <div style={{ marginBottom: '12px' }}>
                  <span style={{ fontSize: '11px', fontWeight: 750, color: '#6b21a8', display: 'block', marginBottom: '6px' }}>
                    📌 EXTRACTED LONG-TERM CUSTOMER FACTS
                  </span>
                  {agentMemoryQuery.data.memory.longTermFacts?.length > 0 ? (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                      {agentMemoryQuery.data.memory.longTermFacts.map((fact: string, idx: number) => (
                        <div
                          key={idx}
                          style={{
                            background: '#ffffff',
                            border: '1px solid #d8b4fe',
                            borderRadius: '6px',
                            padding: '4px 10px',
                            fontSize: '11px',
                            color: '#581c87',
                            fontWeight: 500,
                          }}
                        >
                          ✦ {fact}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <span style={{ fontSize: '11px', color: '#9333ea', fontStyle: 'italic' }}>
                      No previous facts recorded yet. The agent harness extracts facts automatically upon receipt of new messages.
                    </span>
                  )}
                </div>

                {/* Action Audit History */}
                {agentMemoryQuery.data.memory.actionHistory?.length > 0 && (
                  <div>
                    <span style={{ fontSize: '11px', fontWeight: 750, color: '#6b21a8', display: 'block', marginBottom: '6px' }}>
                      ⚡ TRIGGERED APP ACTIONS AUDIT
                    </span>
                    <div style={{ display: 'grid', gap: '4px' }}>
                      {agentMemoryQuery.data.memory.actionHistory.slice(-4).map((act: any, idx: number) => (
                        <div
                          key={idx}
                          style={{
                            background: '#ffffff',
                            border: '1px solid #e9d5ff',
                            borderRadius: '6px',
                            padding: '6px 10px',
                            fontSize: '11px',
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                          }}
                        >
                          <div>
                            <strong style={{ color: '#6b21a8', marginRight: '6px' }}>{act.actionType}</strong>
                            <span style={{ color: '#4b5563' }}>{act.reason}</span>
                          </div>
                          <span style={{ fontSize: '10px', color: '#9ca3af' }}>{formatDate(act.timestamp)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </Panel>
            )}

            {/* 4. Official Reply Composer (return@youthnic.com) */}
            <Panel style={{ padding: '16px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                <div>
                  <h4 style={{ margin: 0, fontSize: '14px', fontWeight: 800 }}>
                    Official Reply Composer
                  </h4>
                  <span style={{ fontSize: '11px', color: '#64748b' }}>
                    Sender configured as: <strong style={{ color: '#6d28d9' }}>Youthnic &lt;return@youthnic.com&gt;</strong>
                  </span>
                </div>

                <button
                  type="button"
                  className="button button-ghost"
                  style={{ fontSize: '11px', color: '#2563eb' }}
                  onClick={() => setReplyText(activeTicket.suggestedReply || '')}
                >
                  Reset to AI Suggested Draft
                </button>
              </div>

              <div style={{ display: 'grid', gap: '12px' }}>
                {/* Official Sender Selection */}
                <div style={{ background: 'var(--canvas)', border: '1px solid var(--line)', borderRadius: '8px', padding: '10px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
                  <span style={{ fontSize: '11.5px', color: '#64748b', fontWeight: 750 }}>
                    Dispatch Channel:
                  </span>
                  <div style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', cursor: 'pointer', fontWeight: senderEmail === 'contact@youthnic.com' ? 700 : 500, color: senderEmail === 'contact@youthnic.com' ? '#2563eb' : '#475569' }}>
                      <input
                        type="radio"
                        name="senderChoice"
                        checked={senderEmail === 'contact@youthnic.com'}
                        onChange={() => setSenderEmail('contact@youthnic.com')}
                      />
                      <span>Youthnic Support &lt;contact@youthnic.com&gt;</span>
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', cursor: 'pointer', fontWeight: senderEmail === 'return@youthnic.com' ? 700 : 500, color: senderEmail === 'return@youthnic.com' ? '#7c3aed' : '#475569' }}>
                      <input
                        type="radio"
                        name="senderChoice"
                        checked={senderEmail === 'return@youthnic.com'}
                        onChange={() => setSenderEmail('return@youthnic.com')}
                      />
                      <span>Youthnic Returns &lt;return@youthnic.com&gt;</span>
                    </label>
                  </div>
                </div>

                <div className="form-field">
                  <label className="field-label">Subject</label>
                  <input
                    value={replySubject}
                    onChange={(e) => setReplySubject(e.target.value)}
                  />
                </div>

                <div className="form-field">
                  <label className="field-label">Message Body</label>
                  <textarea
                    rows={7}
                    style={{ fontFamily: 'inherit', fontSize: '13px', lineHeight: '1.6', padding: '10px', borderRadius: '6px', border: '1px solid var(--line)', background: 'var(--panel)', color: 'var(--ink)' }}
                    value={replyText}
                    onChange={(e) => setReplyText(e.target.value)}
                  />
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
                  <div style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={learnPatternToggle}
                        onChange={(e) => setLearnPatternToggle(e.target.checked)}
                      />
                      <span>🧠 Teach to Knowledge Base (Learns pattern for zero-token future answers)</span>
                    </label>

                    <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={markResolvedToggle}
                        onChange={(e) => setMarkResolvedToggle(e.target.checked)}
                      />
                      <span>✓ Mark as Resolved</span>
                    </label>
                  </div>

                  <button
                    type="button"
                    className="button button-primary"
                    style={{ background: senderEmail === 'return@youthnic.com' ? '#7c3aed' : '#2563eb', borderColor: senderEmail === 'return@youthnic.com' ? '#6d28d9' : '#1d4ed8' }}
                    disabled={replyMutation.isPending || !replyText.trim()}
                    onClick={() =>
                      replyMutation.mutate({
                        id: activeTicket.id,
                        replyText,
                        customSubject: replySubject,
                        fromEmail: senderEmail,
                        resolved: markResolvedToggle,
                        learnPattern: learnPatternToggle,
                      })
                    }
                  >
                    {replyMutation.isPending ? `Sending from ${senderEmail}…` : `Send Official Reply (${senderEmail}) →`}
                  </button>
                </div>
              </div>
            </Panel>

            {/* 5. Unified Customer History Timeline Drawer */}
            {showHistoryDrawer && (
              <Panel style={{ padding: '16px' }}>
                <PanelHeading
                  eyebrow="Unified Multi-Channel History"
                  title={`Customer Timeline: ${activeTicket.fromEmail}`}
                  action={
                    <button
                      type="button"
                      className="button button-ghost"
                      onClick={() => setShowHistoryDrawer(false)}
                    >
                      Close ✕
                    </button>
                  }
                />

                <div style={{ display: 'grid', gap: '10px', marginTop: '10px' }}>
                  {customerHistoryQuery.data?.firebaseEvents?.length === 0 && (
                    <div style={{ fontSize: '12px', color: '#64748b', padding: '12px', textAlign: 'center' }}>
                      No prior Firebase RTDB events for this customer yet.
                    </div>
                  )}

                  {customerHistoryQuery.data?.firebaseEvents?.map((ev, idx) => (
                    <div
                      key={ev.id || idx}
                      style={{
                        padding: '10px 12px',
                        borderRadius: '6px',
                        border: '1px solid var(--line)',
                        background: 'var(--canvas)',
                        fontSize: '12px',
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '3px' }}>
                        <span style={{ fontWeight: 700, color: ev.channel === 'WHATSAPP' ? '#15803d' : '#2563eb' }}>
                          {ev.channel === 'WHATSAPP' ? '📱 WhatsApp' : '✉️ Email'}: {ev.title}
                        </span>
                        <span style={{ fontSize: '10.5px', color: '#64748b' }}>
                          {formatDate(ev.timestamp)}
                        </span>
                      </div>
                      <div style={{ color: '#475569', fontSize: '11.5px' }}>{ev.description}</div>
                    </div>
                  ))}
                </div>
              </Panel>
            )}
          </div>
        ) : (
          <Panel style={{ padding: '40px', textAlign: 'center', color: '#64748b' }}>
            <Icon name="mail" size={32} />
            <h4 style={{ margin: '12px 0 4px', fontSize: '15px', color: 'var(--ink)' }}>Select a Support Ticket</h4>
            <p style={{ margin: 0, fontSize: '12px' }}>Choose a ticket from the left queue to view AI analysis, linked orders, and compose replies.</p>
          </Panel>
        )}
      </div>

      {/* ─── Simulation Modal for Testing Inbound Customer Emails ──── */}
      {isSimulateModalOpen && (
        <div className="modal-backdrop" onClick={() => setIsSimulateModalOpen(false)}>
          <div className="modal-card" style={{ maxWidth: '600px' }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <div>
                <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 800 }}>Simulate Inbound Customer Email</h3>
                <p style={{ margin: '3px 0 0', fontSize: '12px', color: '#64748b' }}>
                  Inject realistic customer scenarios to test Muse Spark 1.3 AI classification, order flagging, and auto-drafting.
                </p>
              </div>
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setIsSimulateModalOpen(false)}
              >
                ✕
              </button>
            </div>

            {/* Quick Scenario Buttons */}
            <div style={{ marginBottom: '14px' }}>
              <span style={{ fontSize: '11px', fontWeight: 700, color: '#64748b', display: 'block', marginBottom: '6px' }}>
                Select a Realistic Scenario:
              </span>
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="button button-secondary"
                  style={{ fontSize: '11px', padding: '4px 8px', height: '26px' }}
                  onClick={() => {
                    setSimSubject('Received damaged floral kurti with torn stitch')
                    setSimBody('Hi Youthnic, I opened my package for order #26YOU5752 today and the kurti has torn stitching on the side seam. The fabric is defective. This is very urgent as I need an immediate return or refund.')
                  }}
                >
                  🚨 Damaged Kurti (Urgent Return)
                </button>
                <button
                  type="button"
                  className="button button-secondary"
                  style={{ fontSize: '11px', padding: '4px 8px', height: '26px' }}
                  onClick={() => {
                    setSimSubject('Size fitting issue with kurti set, need size exchange')
                    setSimBody('Dear Youthnic, The kurti set I received is Size S and it is very tight around the chest. Can I please exchange it for Size M? Or else arrange pickup for return.')
                  }}
                >
                  🔄 Size Exchange / Fitting
                </button>
                <button
                  type="button"
                  className="button button-secondary"
                  style={{ fontSize: '11px', padding: '4px 8px', height: '26px' }}
                  onClick={() => {
                    setSimSubject('Where is my package? Expected delivery was 2 days ago')
                    setSimBody('Hello, my order #26YOU5752 has not arrived yet. The Delhivery tracking is stuck on transit. Please check what is the delay and confirm when delivery will happen.')
                  }}
                >
                  ⏱️ In-Transit Delay Complaint
                </button>
                <button
                  type="button"
                  className="button button-secondary"
                  style={{ fontSize: '11px', padding: '4px 8px', height: '26px' }}
                  onClick={() => {
                    setSimSubject('Delivery boy marked customer unreachable without calling me')
                    setSimBody('I was at home all day waiting. Suddenly I got SMS that delivery failed because customer was unreachable. The delivery boy never even called my phone! Please escalate.')
                  }}
                >
                  ⚠️ Courier Fake Attempt Dispute
                </button>
              </div>
            </div>

            <form
              onSubmit={(e: FormEvent) => {
                e.preventDefault()
                simulateMutation.mutate({
                  fromEmail: simFromEmail,
                  fromName: simFromName,
                  subject: simSubject,
                  bodyText: simBody,
                  orderNumber: simOrderNumber || undefined,
                  toEmail: 'return@youthnic.com',
                })
              }}
              style={{ display: 'grid', gap: '12px' }}
            >
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                <div className="form-field">
                  <label className="field-label">Customer Name</label>
                  <input
                    value={simFromName}
                    onChange={(e) => setSimFromName(e.target.value)}
                    required
                  />
                </div>
                <div className="form-field">
                  <label className="field-label">Customer Email</label>
                  <input
                    type="email"
                    value={simFromEmail}
                    onChange={(e) => setSimFromEmail(e.target.value)}
                    required
                  />
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                <div className="form-field">
                  <label className="field-label">Linked Order Number (Optional)</label>
                  <input
                    placeholder="#26YOU5752"
                    value={simOrderNumber}
                    onChange={(e) => setSimOrderNumber(e.target.value)}
                  />
                </div>
                <div className="form-field">
                  <label className="field-label">Destination Inbox</label>
                  <input
                    disabled
                    value="return@youthnic.com"
                    style={{ background: 'var(--canvas)' }}
                  />
                </div>
              </div>

              <div className="form-field">
                <label className="field-label">Email Subject</label>
                <input
                  value={simSubject}
                  onChange={(e) => setSimSubject(e.target.value)}
                  required
                />
              </div>

              <div className="form-field">
                <label className="field-label">Email Body</label>
                <textarea
                  rows={4}
                  value={simBody}
                  onChange={(e) => setSimBody(e.target.value)}
                  required
                />
              </div>

              <div style={{ display: 'flex', gap: '10px', marginTop: '6px', justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => setIsSimulateModalOpen(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="button button-primary"
                  disabled={simulateMutation.isPending}
                >
                  {simulateMutation.isPending ? 'Analyzing with AI…' : 'Ingest & Trigger AI Triage →'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {/* ─── Meta LLM API Settings Modal ──────────────────────── */}
      {isMetaModalOpen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15, 23, 42, 0.65)',
            backdropFilter: 'blur(3px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100,
            padding: '16px',
          }}
        >
          <div
            style={{
              background: '#ffffff',
              borderRadius: '14px',
              maxWidth: '540px',
              width: '100%',
              padding: '24px',
              boxShadow: '0 20px 40px rgba(0,0,0,0.2)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontSize: '20px' }}>⚡</span>
                <div>
                  <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 800 }}>Meta Model API Configuration</h3>
                  <span style={{ fontSize: '11.5px', color: '#64748b' }}>Configure Muse Spark 1.3 Contributor Agent</span>
                </div>
              </div>
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setIsMetaModalOpen(false)}
                style={{ fontSize: '16px', padding: '4px 8px' }}
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleUpdateMetaConfig} style={{ display: 'grid', gap: '14px' }}>
              <div>
                <label style={{ fontSize: '12px', fontWeight: 700, color: '#334155', display: 'block', marginBottom: '4px' }}>
                  Meta Model API Key (Bearer Token)
                </label>
                <input
                  type="password"
                  className="input"
                  placeholder="Paste your Meta MODEL_API_KEY here"
                  value={metaApiKeyInput}
                  onChange={(e) => setMetaApiKeyInput(e.target.value)}
                  style={{ width: '100%', fontSize: '13px' }}
                />
                <span style={{ fontSize: '11px', color: '#64748b', marginTop: '4px', display: 'block' }}>
                  Current Status: {metaConfigQuery.data?.config?.apiKeySet ? `Configured (${metaConfigQuery.data.config.maskedKey})` : 'Not Set (Using active intelligent offline harness)'}
                </span>
              </div>

              <div>
                <label style={{ fontSize: '12px', fontWeight: 700, color: '#334155', display: 'block', marginBottom: '4px' }}>
                  Active LLM Model
                </label>
                <input
                  type="text"
                  className="input"
                  value={metaModelInput}
                  onChange={(e) => setMetaModelInput(e.target.value)}
                  style={{ width: '100%', fontSize: '13px', background: '#f8fafc' }}
                />
                <span style={{ fontSize: '11px', color: '#64748b', marginTop: '4px', display: 'block' }}>
                  Default: <code>muse-spark-1.3-contributor</code> (1M token context, high-efficiency contributor model)
                </span>
              </div>

              <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '12px', fontSize: '11.5px', color: '#475569', lineHeight: '1.5' }}>
                ℹ️ <strong>Agent Harness & Memory Architecture:</strong>
                <ul style={{ margin: '6px 0 0 16px', padding: 0 }}>
                  <li>Conversation turns are recorded in <strong>Firebase Realtime Database</strong>.</li>
                  <li>Long-term facts and customer profiles persist across turns.</li>
                  <li>Orders are automatically flagged and tracked via Delhivery Express APIs.</li>
                </ul>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '8px' }}>
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => setIsMetaModalOpen(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="button button-primary"
                  disabled={isTestingMeta}
                >
                  {isTestingMeta ? 'Saving & Testing...' : 'Save Configuration'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
