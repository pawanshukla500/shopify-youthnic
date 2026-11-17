import { useState, useMemo, type FormEvent } from 'react'
import { useDebouncedValue } from '../hooks/useDebouncedValue'
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
import { formatDate, formatMoney, carrierTrackingUrl, isVelocityCourier } from '../lib'

type FilterTab = 'ALL' | 'URGENT' | 'RETURNS' | 'DELAYS' | 'RESOLVED'

export function SupportDesk() {
  useDocumentTitle('Customer Support & Returns Mail Desk')
  const toast = useToast()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [searchParams] = useSearchParams()

  const [activeTab, setActiveTab] = useState<FilterTab>('ALL')
  const [searchQuery, setSearchQuery] = useState(searchParams.get('search') || '')
  const debouncedSearch = useDebouncedValue(searchQuery, 400)
  const [selectedTicketId, setSelectedTicketId] = useState<number | null>(null)

  // Reply Composer State
  const [replyText, setReplyText] = useState('')
  const [replySubject, setReplySubject] = useState('')
  const [senderEmail, setSenderEmail] = useState<'contact@youthnic.com' | 'return@youthnic.com'>('contact@youthnic.com')
  const [learnPatternToggle, setLearnPatternToggle] = useState(true)
  const [markResolvedToggle, setMarkResolvedToggle] = useState(false)

  // Simulation Modal State — blank by default so a misclick never sends test data to prod.
  const [isSimulateModalOpen, setIsSimulateModalOpen] = useState(false)
  const [simFromEmail, setSimFromEmail] = useState('')
  const [simFromName, setSimFromName] = useState('')
  const [simOrderNumber, setSimOrderNumber] = useState('')
  const [simSubject, setSimSubject] = useState('')
  const [simBody, setSimBody] = useState('')

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
    queryKey: ['support-emails', activeTab, debouncedSearch],
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
        search: debouncedSearch || undefined,
      })
    },
    refetchInterval: 30_000,
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
          eyebrow="Support Desk · AI-Powered Triage"
          title="Customer Inbound & Returns Mail Hub"
          description="Automated triage using Muse Spark 1.3 Contributor model, order urgency flagging, zero-token resolution patterns, and official dispatch from return@youthnic.com."
        />

        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
          {/* Delhivery Diagnostic */}
          <span className="tone-chip tone-chip--success" title={diag?.delhivery?.message}>
            <span className="status-dot" />
            <span>Delhivery: {diag?.delhivery?.status === 'ok' ? `Live (${diag.delhivery.latencyMs}ms)` : 'Error'}</span>
          </span>

          {/* KwikEngage WhatsApp Diagnostic */}
          <span className="tone-chip tone-chip--success" title={diag?.kwikengage?.message || diag?.whatsapp?.message}>
            <span className="status-dot" />
            <span>KwikEngage: {(diag?.kwikengage?.status === 'ok' || diag?.whatsapp?.status === 'ok') ? 'Live Connected' : 'Simulated'}</span>
          </span>

          {/* Firebase RTDB Diagnostic */}
          <span className="tone-chip tone-chip--purple" title="Firebase Realtime Database: shopify-134b9">
            <span className="status-dot" />
            <span>Firebase RTDB: shopify-134b9</span>
          </span>

          {/* Resend Diagnostic */}
          <span className="tone-chip tone-chip--info" title="Sender: return@youthnic.com">
            <span className="status-dot" />
            <span>Resend: return@youthnic.com</span>
          </span>

          {/* Meta Model API Diagnostic */}
          <button
            type="button"
            className="tone-chip tone-chip--purple"
            onClick={() => setIsMetaModalOpen(true)}
            title="Configure Meta Model API key"
          >
            <span className="status-dot" />
            <span>Meta LLM: muse-spark-1.3-contributor</span>
            <Icon name="settings" size={12} />
          </button>

          <button
            type="button"
            className="button button-primary"
            onClick={() => setIsSimulateModalOpen(true)}
          >
            <Icon name="plus" size={14} />
            <span>Simulate Inbound Email</span>
          </button>
        </div>
      </div>

      {/* ─── Metric KPI Cards ────────────────────────────────────── */}
      <div className="kpi-grid-4">
        <div className="surface-card">
          <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Open Support Tickets
          </span>
          <div style={{ fontSize: '24px', fontWeight: 800, color: 'var(--ink)', marginTop: '4px' }}>
            {emailsQuery.data?.openCount ?? 0}
          </div>
          <span style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '2px', display: 'block' }}>
            Awaiting response or reverse pickup
          </span>
        </div>

        <div className="surface-card" style={{ borderColor: 'var(--tone-danger-border)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--tone-danger-fg)', textTransform: 'uppercase', letterSpacing: '0.5px', display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
              <Icon name="alert" size={13} /> Urgent Claims & Defects
            </span>
            <span className="tone-chip tone-chip--danger">Flagged</span>
          </div>
          <div style={{ fontSize: '24px', fontWeight: 800, color: 'var(--tone-danger-fg)', marginTop: '4px' }}>
            {emailsQuery.data?.urgentCount ?? 0}
          </div>
          <span style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '2px', display: 'block' }}>
            High-priority returns & damage reports
          </span>
        </div>

        <div className="surface-card" style={{ borderColor: 'var(--tone-purple-border)' }}>
          <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--tone-purple-fg)', textTransform: 'uppercase', letterSpacing: '0.5px', display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
            <Icon name="return" size={13} /> Return Requests
          </span>
          <div style={{ fontSize: '24px', fontWeight: 800, color: 'var(--tone-purple-fg)', marginTop: '4px' }}>
            {emailsQuery.data?.returnCount ?? 0}
          </div>
          <span style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '2px', display: 'block' }}>
            Doorstep pickup requests
          </span>
        </div>

        <div className="surface-card" style={{ borderColor: 'var(--tone-success-border)' }}>
          <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--tone-success-fg)', textTransform: 'uppercase', letterSpacing: '0.5px', display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
            <Icon name="zap" size={13} /> Self-Learned Resolution Cache
          </span>
          <div style={{ fontSize: '24px', fontWeight: 800, color: 'var(--tone-success-fg)', marginTop: '4px' }}>
            {patternsQuery.data?.patterns?.length ?? 5} Patterns
          </div>
          <span style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '2px', display: 'block' }}>
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
            style={{ color: activeTab === 'URGENT' ? 'var(--tone-danger-fg)' : undefined }}
            onClick={() => setActiveTab('URGENT')}
          >
            <Icon name="alert" size={13} /> Urgent <span className="tab-badge" style={{ background: 'var(--tone-danger-bg)', color: 'var(--tone-danger-fg)' }}>{emailsQuery.data?.urgentCount ?? 0}</span>
          </button>
          <button
            type="button"
            className={`tab-trigger-21st ${activeTab === 'RETURNS' ? 'active' : ''}`}
            onClick={() => setActiveTab('RETURNS')}
          >
            <Icon name="return" size={13} /> Returns <span className="tab-badge">{emailsQuery.data?.returnCount ?? 0}</span>
          </button>
          <button
            type="button"
            className={`tab-trigger-21st ${activeTab === 'DELAYS' ? 'active' : ''}`}
            onClick={() => setActiveTab('DELAYS')}
          >
            <Icon name="clock" size={13} /> Transit Delays
          </button>
          <button
            type="button"
            className={`tab-trigger-21st ${activeTab === 'RESOLVED' ? 'active' : ''}`}
            onClick={() => setActiveTab('RESOLVED')}
          >
            <Icon name="check" size={13} /> Resolved
          </button>
        </div>

        <div className="search-field" style={{ maxWidth: '340px' }}>
          <Icon name="search" size={14} />
          <input
            aria-label="Search support tickets by customer, email, or order"
            placeholder="Search by customer, email, order #…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
      </div>

      {/* ─── Two-Column Support Workspace ──────────────────────────── */}
      <div className="support-workspace-grid">
        {/* LEFT COLUMN: Inbound Ticket Feed */}
        <Panel style={{ maxHeight: 'calc(100vh - 280px)', overflowY: 'auto', padding: '8px' }}>
          <div style={{ display: 'grid', gap: '8px' }}>
            {emailsQuery.isLoading && <LoadingState label="Loading support tickets…" />}
            {tickets.length === 0 && !emailsQuery.isLoading && (
              <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--muted)' }}>
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
                <button
                  key={ticket.id}
                  type="button"
                  onClick={() => setSelectedTicketId(ticket.id)}
                  className={`ticket-card-btn ${isUrgent ? 'is-urgent' : ''} ${isSelected ? 'is-selected' : ''}`}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px', marginBottom: '6px' }}>
                    <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                      {isUrgent ? (
                        <span className="tone-chip tone-chip--danger">URGENT</span>
                      ) : ticket.urgency === 'HIGH' ? (
                        <span className="tone-chip tone-chip--warning">HIGH</span>
                      ) : (
                        <span className="tone-chip">NORMAL</span>
                      )}

                      <span className="tone-chip tone-chip--info">
                        {ticket.category.replace('_', ' ')}
                      </span>

                      {ticket.shopifyOrderName && (
                        <span style={{ fontSize: '10.5px', color: 'var(--ink)', fontWeight: 700, background: 'var(--line-subtle)', padding: '1px 6px', borderRadius: '4px' }}>
                          {ticket.shopifyOrderName}
                        </span>
                      )}
                    </div>

                    <span style={{ fontSize: '10px', color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                      {formatDate(ticket.createdAt)}
                    </span>
                  </div>

                  <div style={{ fontWeight: 700, fontSize: '12.5px', color: 'var(--ink)', marginBottom: '3px' }}>
                    {ticket.subject}
                  </div>

                  <div style={{ fontSize: '11px', color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {ticket.bodyText}
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '6px', fontSize: '11px', color: 'var(--muted)' }}>
                    <span>{ticket.fromName || ticket.fromEmail}</span>
                    <span
                      style={{
                        color: ticket.status === 'RESOLVED' ? 'var(--tone-success-fg)' : ticket.status === 'REPLIED' ? 'var(--tone-info-fg)' : 'var(--tone-warning-fg)',
                        fontWeight: 700,
                      }}
                    >
                      {ticket.status === 'RESOLVED' ? 'Resolved' : ticket.status === 'REPLIED' ? 'Replied' : 'Open'}
                    </span>
                  </div>
                </button>
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
                  <div style={{ fontSize: '11.5px', color: 'var(--muted)', marginTop: '3px' }}>
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
                      style={{ fontSize: '11px', height: '30px', padding: '0 10px', color: 'var(--tone-info-fg)' }}
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
                    <span style={{ fontSize: '11px', color: 'var(--muted)' }}>Linked Order:</span>
                    <div style={{ fontWeight: 800, fontSize: '13px', color: 'var(--ink)' }}>
                      {activeTicket.order.shopifyOrderName} · {formatMoney(activeTicket.order.totalAmount)}
                    </div>
                  </div>
                  <div>
                    <span style={{ fontSize: '11px', color: 'var(--muted)' }}>Shipment Status:</span>
                    <div style={{ fontWeight: 700, fontSize: '12px', color: 'var(--tone-info-fg)' }}>
                      {activeTicket.order.status}
                    </div>
                  </div>
                  {activeTicket.order.shipment?.waybillNumber && (
                    <div>
                      <span style={{ fontSize: '11px', color: 'var(--muted)' }}>{isVelocityCourier(activeTicket.order.shipment?.courier, activeTicket.order.shipment?.waybillNumber) ? 'Velocity' : 'Delhivery'} Waybill:</span>
                      <div>
                        <a
                          href={carrierTrackingUrl(activeTicket.order.shipment?.courier || (activeTicket.order as any).courierPartner, activeTicket.order.shipment.waybillNumber)}
                          target="_blank"
                          rel="noreferrer"
                          style={{ color: 'var(--tone-info-fg)', fontWeight: 700, fontSize: '12px', textDecoration: 'none' }}
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
                <div style={{ fontSize: '11.5px', color: 'var(--muted)', marginTop: '10px', background: 'var(--canvas)', padding: '8px 12px', borderRadius: '6px' }}>
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
                <span style={{ fontSize: '11px', color: 'var(--muted)' }}>
                  Sent to: <code>return@youthnic.com</code>
                </span>
              </div>
              <div style={{ background: 'var(--surface-elevated)', border: '1px solid var(--border-strong)', borderRadius: '8px', padding: '14px', fontSize: '13px', lineHeight: '1.6', color: 'var(--ink)', whiteSpace: 'pre-wrap' }}>
                {activeTicket.bodyText}
              </div>
            </Panel>

            {/* 3. AI Triage & Sentiment Analysis ("Muse Spark 1.3 Contributor") */}
            <Panel style={{ padding: '16px', background: 'var(--surface-elevated)', borderColor: 'var(--line)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px', marginBottom: '10px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <Icon name="zap" size={15} />
                  <strong style={{ fontSize: '13px', color: 'var(--ink)' }}>Muse Spark 1.3 Triage Analysis</strong>
                </div>
                {activeTicket.aiAnalysis?.isLearnedMatch ? (
                  <span className="tone-chip tone-chip--success">
                    0-Token Knowledge Base Match (100% Cache)
                  </span>
                ) : (
                  <span className="tone-chip tone-chip--info">
                    AI Heuristic Inference
                  </span>
                )}
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '8px', marginBottom: '10px', fontSize: '11.5px' }}>
                <div style={{ background: 'var(--panel)', padding: '8px 10px', borderRadius: '6px', border: '1px solid var(--line)' }}>
                  <span style={{ color: 'var(--muted)', display: 'block', fontSize: '10px' }}>INTENT CATEGORY</span>
                  <strong style={{ color: 'var(--ink)' }}>{activeTicket.category.replace('_', ' ')}</strong>
                </div>
                <div style={{ background: 'var(--panel)', padding: '8px 10px', borderRadius: '6px', border: '1px solid var(--line)' }}>
                  <span style={{ color: 'var(--muted)', display: 'block', fontSize: '10px' }}>URGENCY</span>
                  <strong style={{ color: activeTicket.urgency === 'URGENT' ? 'var(--tone-danger-fg)' : 'var(--tone-success-fg)' }}>{activeTicket.urgency}</strong>
                </div>
                <div style={{ background: 'var(--panel)', padding: '8px 10px', borderRadius: '6px', border: '1px solid var(--line)' }}>
                  <span style={{ color: 'var(--muted)', display: 'block', fontSize: '10px' }}>DETECTED SENTIMENT</span>
                  <strong style={{ color: activeTicket.sentiment === 'FRUSTRATED' || activeTicket.sentiment === 'URGENT' ? 'var(--tone-danger-fg)' : 'var(--ink-secondary)' }}>
                    {activeTicket.sentiment}
                  </strong>
                </div>
                <div style={{ background: 'var(--panel)', padding: '8px 10px', borderRadius: '6px', border: '1px solid var(--line)' }}>
                  <span style={{ color: 'var(--muted)', display: 'block', fontSize: '10px' }}>CONFIDENCE</span>
                  <strong style={{ color: 'var(--tone-success-fg)' }}>{Math.round((activeTicket.aiAnalysis?.confidence ?? 0.95) * 100)}%</strong>
                </div>
              </div>

              <div style={{ fontSize: '12px', color: 'var(--ink-secondary)', lineHeight: '1.5', marginBottom: '12px' }}>
                <strong>Recommendation:</strong> {activeTicket.aiAnalysis?.suggestedAction || activeTicket.flagReason}
              </div>

              {/* Action Button: Re-analyze with Meta LLM */}
              <div style={{ display: 'flex', justifyContent: 'flex-end', borderTop: '1px solid var(--line)', paddingTop: '10px' }}>
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={isReanalyzing}
                  onClick={handleReanalyzeWithMetaLlm}
                >
                  <Icon name="refresh" size={13} />
                  <span>{isReanalyzing ? 'Analyzing with Meta LLM...' : 'Re-analyze with Muse Spark 1.3'}</span>
                </button>
              </div>
            </Panel>

            {/* 3B. Autonomous Agent Harness Memory (Firebase RTDB) */}
            {agentMemoryQuery.data?.memory && (
              <Panel style={{ padding: '16px', background: 'var(--tone-purple-bg)', borderColor: 'var(--tone-purple-border)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px', flexWrap: 'wrap', gap: '8px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <Icon name="workflow" size={18} />
                    <div>
                      <h4 style={{ margin: 0, fontSize: '13px', fontWeight: 800, color: 'var(--tone-purple-fg)' }}>
                        Customer Agent Memory (Firebase Realtime Database)
                      </h4>
                      <span style={{ fontSize: '10.5px', color: 'var(--muted)' }}>
                        Node: <code>/agent_memory/customers/{agentMemoryQuery.data.memory.customerIdentifier?.replace(/[^a-zA-Z0-9]/g, '_')}</code>
                      </span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                    <span className="tone-chip tone-chip-purple">
                      Trust Score: {agentMemoryQuery.data.memory.profile?.trustScore ?? 85}/100
                    </span>
                    {agentMemoryQuery.data.memory.profile?.totalOrders > 0 && (
                      <span className="tone-chip tone-chip-success">
                        Orders: {agentMemoryQuery.data.memory.profile.totalOrders}
                      </span>
                    )}
                  </div>
                </div>

                {/* Long-Term Learned Facts */}
                <div style={{ marginBottom: '12px' }}>
                  <span style={{ fontSize: '11px', fontWeight: 750, color: 'var(--tone-purple-fg)', display: 'block', marginBottom: '6px' }}>
                    EXTRACTED LONG-TERM CUSTOMER FACTS
                  </span>
                  {agentMemoryQuery.data.memory.longTermFacts?.length > 0 ? (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                      {agentMemoryQuery.data.memory.longTermFacts.map((fact: string, idx: number) => (
                        <div
                          key={idx}
                          style={{
                            background: 'var(--panel)',
                            border: '1px solid var(--tone-purple-border)',
                            borderRadius: '6px',
                            padding: '4px 10px',
                            fontSize: '11px',
                            color: 'var(--ink)',
                            fontWeight: 500,
                          }}
                        >
                          {fact}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <span style={{ fontSize: '11px', color: 'var(--muted)', fontStyle: 'italic' }}>
                      No previous facts recorded yet. The agent harness extracts facts automatically upon receipt of new messages.
                    </span>
                  )}
                </div>

                {/* Action Audit History */}
                {agentMemoryQuery.data.memory.actionHistory?.length > 0 && (
                  <div>
                    <span style={{ fontSize: '11px', fontWeight: 750, color: 'var(--tone-purple-fg)', display: 'block', marginBottom: '6px' }}>
                      TRIGGERED APP ACTIONS AUDIT
                    </span>
                    <div style={{ display: 'grid', gap: '4px' }}>
                      {agentMemoryQuery.data.memory.actionHistory.slice(-4).map((act: any, idx: number) => (
                        <div
                          key={idx}
                          style={{
                            background: 'var(--panel)',
                            border: '1px solid var(--line)',
                            borderRadius: '6px',
                            padding: '6px 10px',
                            fontSize: '11px',
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            gap: '8px',
                          }}
                        >
                          <div>
                            <strong style={{ color: 'var(--tone-purple-fg)', marginRight: '6px' }}>{act.actionType}</strong>
                            <span style={{ color: 'var(--ink-secondary)' }}>{act.reason}</span>
                          </div>
                          <span style={{ fontSize: '10px', color: 'var(--muted)' }}>{formatDate(act.timestamp)}</span>
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
                  <span style={{ fontSize: '11px', color: 'var(--muted)' }}>
                    Sender configured as: <strong style={{ color: 'var(--tone-purple-fg)' }}>Youthnic &lt;return@youthnic.com&gt;</strong>
                  </span>
                </div>

                <button
                  type="button"
                  className="button button-ghost"
                  style={{ fontSize: '11px', color: 'var(--tone-info-fg)' }}
                  onClick={() => setReplyText(activeTicket.suggestedReply || '')}
                >
                  Reset to AI Suggested Draft
                </button>
              </div>

              <div style={{ display: 'grid', gap: '12px' }}>
                {/* Official Sender Selection */}
                <div style={{ background: 'var(--canvas)', border: '1px solid var(--line)', borderRadius: '8px', padding: '10px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
                  <span style={{ fontSize: '11.5px', color: 'var(--muted)', fontWeight: 750 }}>
                    Dispatch Channel:
                  </span>
                  <div style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', cursor: 'pointer', fontWeight: senderEmail === 'contact@youthnic.com' ? 700 : 500, color: senderEmail === 'contact@youthnic.com' ? 'var(--tone-info-fg)' : 'var(--muted)' }}>
                      <input
                        type="radio"
                        name="senderChoice"
                        checked={senderEmail === 'contact@youthnic.com'}
                        onChange={() => setSenderEmail('contact@youthnic.com')}
                      />
                      <span>Youthnic Support &lt;contact@youthnic.com&gt;</span>
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', cursor: 'pointer', fontWeight: senderEmail === 'return@youthnic.com' ? 700 : 500, color: senderEmail === 'return@youthnic.com' ? 'var(--tone-purple-fg)' : 'var(--muted)' }}>
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
                    <div style={{ fontSize: '12px', color: 'var(--muted)', padding: '12px', textAlign: 'center' }}>
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
                        <span style={{ fontWeight: 700, color: ev.channel === 'WHATSAPP' ? 'var(--tone-success-fg)' : 'var(--tone-info-fg)' }}>
                          {ev.channel === 'WHATSAPP' ? '📱 WhatsApp' : '✉️ Email'}: {ev.title}
                        </span>
                        <span style={{ fontSize: '10.5px', color: 'var(--muted)' }}>
                          {formatDate(ev.timestamp)}
                        </span>
                      </div>
                      <div style={{ color: 'var(--muted)', fontSize: '11.5px' }}>{ev.description}</div>
                    </div>
                  ))}
                </div>
              </Panel>
            )}
          </div>
        ) : (
          <Panel style={{ padding: '40px', textAlign: 'center', color: 'var(--muted)' }}>
            <Icon name="mail" size={32} />
            <h4 style={{ margin: '12px 0 4px', fontSize: '15px', color: 'var(--ink)' }}>Select a Support Ticket</h4>
            <p style={{ margin: 0, fontSize: '12px' }}>Choose a ticket from the left queue to view AI analysis, linked orders, and compose replies.</p>
          </Panel>
        )}
      </div>

      {/* ─── Simulation Modal for Testing Inbound Customer Emails ──── */}
      {isSimulateModalOpen && (
        <div className="modal-backdrop" onClick={() => setIsSimulateModalOpen(false)}>
          <div className="modal-card" role="dialog" aria-modal="true" aria-label="Simulate Inbound Customer Email" style={{ maxWidth: '600px' }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', gap: '12px' }}>
              <div>
                <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 800, color: 'var(--ink)' }}>Simulate Inbound Customer Email</h3>
                <p style={{ margin: '3px 0 0', fontSize: '12px', color: 'var(--muted)' }}>
                  Inject realistic customer scenarios to test Muse Spark 1.3 AI classification, order flagging, and auto-drafting.
                </p>
              </div>
              <button
                type="button"
                className="modal-close-btn"
                aria-label="Close modal"
                onClick={() => setIsSimulateModalOpen(false)}
              >
                <Icon name="close" size={16} />
              </button>
            </div>

            {/* Quick Scenario Buttons */}
            <div style={{ marginBottom: '14px' }}>
              <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--muted)', display: 'block', marginBottom: '6px' }}>
                Select a Realistic Scenario:
              </span>
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="tool-pill-btn"
                  onClick={() => {
                    setSimSubject('Received damaged floral kurti with torn stitch')
                    setSimBody('Hi Youthnic, I opened my package for order #26YOU5752 today and the kurti has torn stitching on the side seam. The fabric is defective. This is very urgent as I need an immediate return or refund.')
                  }}
                >
                  Damaged Kurti (Urgent Return)
                </button>
                <button
                  type="button"
                  className="tool-pill-btn"
                  onClick={() => {
                    setSimSubject('Size fitting issue with kurti set, need size exchange')
                    setSimBody('Dear Youthnic, The kurti set I received is Size S and it is very tight around the chest. Can I please exchange it for Size M? Or else arrange pickup for return.')
                  }}
                >
                  Size Exchange / Fitting
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
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-label="Meta Model API Configuration"
            style={{
              maxWidth: '540px',
              width: '100%',
              padding: '24px',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', gap: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Icon name="settings" size={18} />
                <div>
                  <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 800, color: 'var(--ink)' }}>Meta Model API Configuration</h3>
                  <span style={{ fontSize: '11.5px', color: 'var(--muted)' }}>Configure Muse Spark 1.3 Contributor Agent</span>
                </div>
              </div>
              <button
                type="button"
                className="modal-close-btn"
                aria-label="Close modal"
                onClick={() => setIsMetaModalOpen(false)}
              >
                <Icon name="close" size={16} />
              </button>
            </div>

            <form onSubmit={handleUpdateMetaConfig} style={{ display: 'grid', gap: '14px' }}>
              <div>
                <label htmlFor="meta-api-key-input" style={{ fontSize: '12px', fontWeight: 700, color: 'var(--ink-secondary)', display: 'block', marginBottom: '4px' }}>
                  Meta Model API Key (Bearer Token)
                </label>
                <input
                  id="meta-api-key-input"
                  type="password"
                  className="input"
                  placeholder="Paste your Meta MODEL_API_KEY here"
                  value={metaApiKeyInput}
                  onChange={(e) => setMetaApiKeyInput(e.target.value)}
                  style={{ width: '100%', fontSize: '13px' }}
                />
                <span style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '4px', display: 'block' }}>
                  Current Status: {metaConfigQuery.data?.config?.apiKeySet ? `Configured (${metaConfigQuery.data.config.maskedKey})` : 'Not Set (Using active intelligent offline harness)'}
                </span>
              </div>

              <div>
                <label htmlFor="meta-model-input" style={{ fontSize: '12px', fontWeight: 700, color: 'var(--ink-secondary)', display: 'block', marginBottom: '4px' }}>
                  Active LLM Model
                </label>
                <input
                  id="meta-model-input"
                  type="text"
                  className="input"
                  value={metaModelInput}
                  onChange={(e) => setMetaModelInput(e.target.value)}
                  style={{ width: '100%', fontSize: '13px', background: 'var(--surface-elevated)' }}
                />
                <span style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '4px', display: 'block' }}>
                  Default: <code>muse-spark-1.3-contributor</code> (1M token context, high-efficiency contributor model)
                </span>
              </div>

              <div className="surface-well" style={{ borderRadius: '8px', padding: '12px', fontSize: '11.5px', color: 'var(--ink-secondary)', lineHeight: '1.5' }}>
                <strong>Agent Harness & Memory Architecture:</strong>
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
