import { useState, useMemo, useEffect, type FormEvent } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getSystemStatus,
  pingIntegrations,
  getSystemUsers,
  createSystemUser,
  updateSystemUser,
  deleteSystemUser,
  setSystemUserPassword,
  getSystemUserResetLink,
  getWebhookSetupStatus,
  registerShopifyWebhooks,
  createDelhiveryWarehouse,
  updateDelhiveryWarehouse,
  testWhatsAppNotification,
  getKapsoStatus,
  updateKapsoConfig,
  getResendStatus,
  updateResendConfig,
  testResendEmail,
} from '../api'
import { ErrorBox, Icon, LoadingState, PageIntro, Panel, PanelHeading, useDocumentTitle, useToast } from '../components/UI'
import type { SystemUser } from '../types'

type SettingsTab = 'stack' | 'users'

const ROLE_OPTIONS = [
  'Admin / System Architect',
  'Operations & Dispatch Lead',
  'Reverse Logistics & QC Specialist',
  '3-Way Payment Reconciliation',
  'Warehouse Inventory Associate',
  'Customer Support Lead',
]

const DEPARTMENT_OPTIONS = [
  'Executive Operations',
  'Surat Fulfillment Center',
  'Warehouse Returns & RTO',
  'Accounts & Delhivery Ledger',
  'Customer Experience Desk',
]

export function Settings() {
  useDocumentTitle('Settings & Integrations')
  const toast = useToast()
  const queryClient = useQueryClient()

  const [activeTab, setActiveTab] = useState<SettingsTab>('stack')
  const [userSearch, setUserSearch] = useState('')
  const [isAddModalOpen, setIsAddModalOpen] = useState(false)
  const [editingUser, setEditingUser] = useState<SystemUser | null>(null)

  // WhatsApp Test Modal state
  const [isWhatsAppTestModalOpen, setIsWhatsAppTestModalOpen] = useState(false)
  const [testPhone, setTestPhone] = useState('9825012345')
  const [testTrigger, setTestTrigger] = useState('COD_CONFIRMATION')
  const [testCustomMsg, setTestCustomMsg] = useState('')

  // Kapso Configuration Modal state
  const [isKapsoConfigModalOpen, setIsKapsoConfigModalOpen] = useState(false)
  const [kapsoApiKey, setKapsoApiKey] = useState('')
  const [kapsoPhoneNumberId, setKapsoPhoneNumberId] = useState('')
  const [kapsoSenderPhone, setKapsoSenderPhone] = useState('+91 88661 54721')

  // Resend Configuration Modal state
  const [isResendModalOpen, setIsResendModalOpen] = useState(false)
  const [resendApiKey, setResendApiKey] = useState('')
  const [resendFromEmail, setResendFromEmail] = useState('Youthnic Logistics <onboarding@resend.dev>')
  const [isTestEmailModalOpen, setIsTestEmailModalOpen] = useState(false)
  const [testEmailTo, setTestEmailTo] = useState('pawanshukla@example.com')
  const [testEmailTemplate, setTestEmailTemplate] = useState('TRANSIT_DELAY')

  // Form state — password at creation + optional new password on edit (admin only).
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    role: ROLE_OPTIONS[1],
    department: DEPARTMENT_OPTIONS[1],
    phone: '',
    status: 'ACTIVE' as 'ACTIVE' | 'INACTIVE',
    password: '',
    newPassword: '',
  })

  // Webhook setup state
  const [webhookStatus, setWebhookStatus] = useState<any>(null)
  const [webhookBusy, setWebhookBusy] = useState(false)

  // Delhivery warehouse register/update (portal tabs 3-4, one-time setup)
  const [whForm, setWhForm] = useState({
    name: 'Surat Warehouse',
    phone: '',
    city: 'Surat',
    pin: '395002',
    address: '',
    email: '',
  })
  const [whBusy, setWhBusy] = useState(false)

  // Esc closes the operator modal (focus-trap lite: autofocus first field via required input).
  useEffect(() => {
    if (!isAddModalOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsAddModalOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isAddModalOpen])

  // Queries
  const statusQuery = useQuery({
    queryKey: ['system-status'],
    queryFn: getSystemStatus,
    refetchInterval: 30_000,
  })

  const usersQuery = useQuery({
    queryKey: ['system-users'],
    queryFn: getSystemUsers,
    staleTime: 10_000,
  })

  const kapsoQuery = useQuery({
    queryKey: ['kapso-status'],
    queryFn: getKapsoStatus,
    staleTime: 15_000,
  })

  const resendQuery = useQuery({
    queryKey: ['resend-status'],
    queryFn: getResendStatus,
    staleTime: 15_000,
  })

  // Mutations
  const pingMutation = useMutation({
    mutationFn: pingIntegrations,
    onSuccess: (data) => {
      const dbMs = data.results.database?.latencyMs ?? 0
      const shopifyMs = data.results.shopify?.latencyMs ?? 0
      const delhiveryMs = data.results.delhivery?.latencyMs ?? 0
      const kapsoMs = data.results.kapso?.latencyMs ?? 0
      toast.toast(
        'success',
        `Live Ping Success! DB: ${dbMs}ms · Shopify: ${shopifyMs}ms · Delhivery: ${delhiveryMs}ms · Kapso: ${kapsoMs}ms`
      )
      queryClient.invalidateQueries({ queryKey: ['system-status'] })
      queryClient.invalidateQueries({ queryKey: ['kapso-status'] })
      queryClient.invalidateQueries({ queryKey: ['resend-status'] })
    },
    onError: (err) => {
      toast.toast('error', `Ping failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
    },
  })

  const updateKapsoMutation = useMutation({
    mutationFn: updateKapsoConfig,
    onSuccess: (data) => {
      toast.toast('success', data.message || 'Kapso configuration updated & verified!')
      queryClient.invalidateQueries({ queryKey: ['kapso-status'] })
      queryClient.invalidateQueries({ queryKey: ['system-status'] })
      setIsKapsoConfigModalOpen(false)
    },
    onError: (err) => {
      toast.toast('error', `Failed to update Kapso credentials: ${err instanceof Error ? err.message : 'Unknown error'}`)
    },
  })

  const updateResendMutation = useMutation({
    mutationFn: updateResendConfig,
    onSuccess: (data) => {
      toast.toast('success', data.message || 'Resend configuration updated!')
      queryClient.invalidateQueries({ queryKey: ['resend-status'] })
      queryClient.invalidateQueries({ queryKey: ['system-status'] })
      setIsResendModalOpen(false)
    },
    onError: (err) => {
      toast.toast('error', `Failed to update Resend config: ${err instanceof Error ? err.message : 'Unknown error'}`)
    },
  })

  const testEmailMutation = useMutation({
    mutationFn: testResendEmail,
    onSuccess: (data) => {
      toast.toast(
        'success',
        data.mode === 'LIVE'
          ? `Live test email sent to ${data.recipient} via Resend!`
          : `Simulated test email logged for ${data.recipient} (Sandbox Mode)`
      )
      setIsTestEmailModalOpen(false)
    },
    onError: (err) => {
      toast.toast('error', `Test email failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
    },
  })

  const testWhatsAppMutation = useMutation({
    mutationFn: testWhatsAppNotification,
    onSuccess: (data) => {
      toast.toast('success', `Test WhatsApp trigger sent to ${data.result?.recipient || testPhone}!`)
      setIsWhatsAppTestModalOpen(false)
    },
    onError: (err) => {
      toast.toast('error', `Failed to send WhatsApp test: ${err instanceof Error ? err.message : 'Unknown error'}`)
    },
  })

  const createUserMutation = useMutation({
    mutationFn: createSystemUser,
    onSuccess: (data: any) => {
      toast.toast('success', `Created operator ${data.user.name} with login ${data.user.loginEnabled ? 'enabled' : 'roster-only'}!${data.warning ? ` ${data.warning}` : ''}`)
      queryClient.invalidateQueries({ queryKey: ['system-users'] })
      setIsAddModalOpen(false)
      resetForm()
    },
    onError: (err) => {
      toast.toast('error', `Failed to create user: ${err instanceof Error ? err.message : 'Unknown error'}`)
    },
  })

  const updateUserMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: Partial<SystemUser> & { newPassword?: string } }) =>
      updateSystemUser(id, payload),
    onSuccess: (data: any) => {
      toast.toast('success', `Updated ${data.user.name} successfully!${data.warning ? ` ${data.warning}` : ''}`)
      queryClient.invalidateQueries({ queryKey: ['system-users'] })
      setEditingUser(null)
      setIsAddModalOpen(false)
      resetForm()
    },
    onError: (err) => {
      toast.toast('error', `Update failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
    },
  })

  const setPasswordMutation = useMutation({
    mutationFn: ({ id, newPassword }: { id: string; newPassword: string }) =>
      setSystemUserPassword(id, newPassword),
    onSuccess: (data) => {
      toast.toast('success', data.message || 'Password updated. Old sessions revoked.')
      setFormData((f) => ({ ...f, newPassword: '' }))
    },
    onError: (err) => {
      toast.toast('error', `Password change failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
    },
  })

  const resetLinkMutation = useMutation({
    mutationFn: (id: string) => getSystemUserResetLink(id),
    onSuccess: async (data) => {
      try {
        await navigator.clipboard.writeText(data.resetLink)
        toast.toast('success', `Reset link for ${data.email} copied to clipboard!`)
      } catch {
        window.prompt('Copy reset link:', data.resetLink)
      }
    },
    onError: (err) => {
      toast.toast('error', `Reset link failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
    },
  })

  const deleteUserMutation = useMutation({
    mutationFn: deleteSystemUser,
    onSuccess: () => {
      toast.toast('success', 'Operator removed successfully!')
      queryClient.invalidateQueries({ queryKey: ['system-users'] })
    },
    onError: (err) => {
      toast.toast('error', `Delete failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
    },
  })

  const resetForm = () => {
    setFormData({
      name: '',
      email: '',
      role: ROLE_OPTIONS[1],
      department: DEPARTMENT_OPTIONS[1],
      phone: '',
      status: 'ACTIVE',
      password: '',
      newPassword: '',
    })
  }

  const handleOpenAdd = () => {
    resetForm()
    setEditingUser(null)
    setIsAddModalOpen(true)
  }

  const handleOpenEdit = (user: SystemUser) => {
    setEditingUser(user)
    setFormData({
      name: user.name,
      email: user.email,
      role: user.role,
      department: user.department,
      phone: user.phone || '',
      status: user.status,
      password: '',
      newPassword: '',
    })
    setIsAddModalOpen(true)
  }

  const handleSubmitForm = (e: FormEvent) => {
    e.preventDefault()
    if (!formData.name.trim() || !formData.email.trim()) {
      toast.toast('error', 'Name and email are required')
      return
    }
    if (!editingUser && (!formData.password || formData.password.length < 6)) {
      toast.toast('error', 'Set a password (min 6 characters) so the operator can sign in.')
      return
    }
    if (editingUser && formData.newPassword && formData.newPassword.length < 6) {
      toast.toast('error', 'New password must be at least 6 characters.')
      return
    }

    if (editingUser) {
      const { password: _omit, ...rest } = formData
      updateUserMutation.mutate({
        id: editingUser.id,
        payload: rest,
      })
    } else {
      createUserMutation.mutate(formData)
    }
  }

  const loadWebhookStatus = async () => {
    setWebhookBusy(true)
    try {
      const data = await getWebhookSetupStatus()
      setWebhookStatus(data)
    } catch (err) {
      toast.toast('error', `Webhook status failed: ${err instanceof Error ? err.message : 'Unknown'}`)
    } finally {
      setWebhookBusy(false)
    }
  }

  const handleRegisterWebhooks = async () => {
    setWebhookBusy(true)
    try {
      const data = await registerShopifyWebhooks()
      toast.toast(data.success ? 'success' : 'error', data.success ? 'Shopify webhooks registered!' : `Some webhooks failed: ${data.results?.filter((r: any) => r.status === 'failed').map((r: any) => r.topic).join(', ')}`)
      await loadWebhookStatus()
    } catch (err) {
      toast.toast('error', `Register failed: ${err instanceof Error ? err.message : 'Unknown'}`)
    } finally {
      setWebhookBusy(false)
    }
  }

  const handleToggleStatus = (user: SystemUser) => {
    const nextStatus = user.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE'
    updateUserMutation.mutate({
      id: user.id,
      payload: { status: nextStatus },
    })
  }

  const handleDeleteUser = (user: SystemUser) => {
    if (window.confirm(`Are you sure you want to remove operator "${user.name}"?`)) {
      deleteUserMutation.mutate(user.id)
    }
  }

  // Filtered operators
  const filteredUsers = useMemo(() => {
    const list = usersQuery.data ?? []
    if (!userSearch.trim()) return list
    const q = userSearch.toLowerCase().trim()
    return list.filter(
      (u) =>
        u.name.toLowerCase().includes(q) ||
        u.email.toLowerCase().includes(q) ||
        u.role.toLowerCase().includes(q) ||
        u.department.toLowerCase().includes(q)
    )
  }, [usersQuery.data, userSearch])

  const statusData = statusQuery.data

  return (
    <div className="settings-page">
      <PageIntro
        eyebrow="System Configuration & Administration"
        title="Settings & Stack Telemetry"
        description="Monitor real-time API integrations, database latency, payment rails, and manage operator team accounts."
        action={
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <button
              type="button"
              className="btn-export"
              onClick={() => pingMutation.mutate()}
              disabled={pingMutation.isPending}
              title="Send live ping diagnostics across DB, Shopify, and Delhivery"
            >
              <Icon name="refresh" size={15} />
              <span>{pingMutation.isPending ? 'Pinging Stack…' : 'Ping All Integrations'}</span>
            </button>
            <button
              type="button"
              className="btn-export"
              style={{ background: '#10b981', color: '#ffffff', borderColor: '#059669' }}
              onClick={handleOpenAdd}
              title="Add a new team operator or admin"
            >
              <Icon name="plus" size={15} />
              <span>Create New Operator</span>
            </button>
          </div>
        }
      />

      {/* Navigation Tabs */}
      <div className="analytics-tabs-bar" style={{ marginBottom: '24px' }}>
        <button
          type="button"
          className={`analytics-tab-btn ${activeTab === 'stack' ? 'active' : ''}`}
          onClick={() => setActiveTab('stack')}
        >
          <Icon name="server" size={16} />
          <span>System Stack & API Status</span>
        </button>
        <button
          type="button"
          className={`analytics-tab-btn ${activeTab === 'users' ? 'active' : ''}`}
          onClick={() => setActiveTab('users')}
        >
          <Icon name="users" size={16} />
          <span>User Creation & Team Access ({usersQuery.data?.length ?? 0})</span>
        </button>
      </div>

      {/* ─────────────────────────────────────────────────────────────
          TAB 1: SYSTEM STACK & API TELEMETRY
          ───────────────────────────────────────────────────────────── */}
      {activeTab === 'stack' && (
        <div style={{ display: 'grid', gap: '22px' }}>
          <Panel style={{ padding: '18px 20px' }}>
            <PanelHeading title="Webhook Setup & Delhivery Access" eyebrow="One-click Shopify registration + Delhivery manual checklist" />
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginTop: 12 }}>
              <button type="button" className="button button-secondary" disabled={webhookBusy} onClick={loadWebhookStatus}>
                {webhookBusy ? 'Checking…' : 'Check webhook status'}
              </button>
              <button type="button" className="button button-primary" disabled={webhookBusy} onClick={handleRegisterWebhooks}>
                {webhookBusy ? 'Working…' : 'Register Shopify webhooks'}
              </button>
            </div>
            {webhookStatus && (
              <div style={{ marginTop: 12, fontSize: 12, display: 'grid', gap: 6, color: '#334155' }}>
                <div>APP_BASE_URL: <code>{webhookStatus.appBaseUrl}</code> {webhookStatus.https ? '· HTTPS OK' : '· NOT HTTPS — webhooks will fail'}</div>
                <div>Shopify → <code>{webhookStatus.shopify?.expectedAddress}</code> · registered: {webhookStatus.shopify?.registered?.length ?? 0}/5 · secret: {webhookStatus.shopify?.webhookSecretConfigured ? 'set' : 'missing'}</div>
                <div>Delhivery → <code>{webhookStatus.delhivery?.expectedAddress}</code> · {webhookStatus.delhivery?.setup} · token: {webhookStatus.delhivery?.apiTokenConfigured ? 'set' : 'missing'} · pickup: <code>{webhookStatus.delhivery?.pickupLocation}</code></div>
                <div>WhatsApp → <code>{webhookStatus.whatsapp?.expectedAddress}</code> · public GET+POST</div>
                <div style={{ color: '#64748b' }}>Limits: {webhookStatus.delhivery?.limits?.trackingCronBatch} · {webhookStatus.delhivery?.limits?.trackBulk} · CLI: <code>npm run delhivery:check</code></div>
              </div>
            )}
          </Panel>
          <Panel style={{ padding: '18px 20px' }}>
            <PanelHeading title="Delhivery Pickup Warehouse" eyebrow="One-time registration · avoids ClientWarehouse-mismatch manifest failures" />
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '10px', marginTop: 12 }}>
              {(['name', 'phone', 'city', 'pin', 'address', 'email'] as const).map((field) => (
                <label key={field} style={{ display: 'grid', gap: 4, fontSize: 11, color: '#64748b', textTransform: 'capitalize' }}>
                  {field}
                  <input
                    value={whForm[field]}
                    onChange={(e) => setWhForm({ ...whForm, [field]: e.target.value })}
                    placeholder={field === 'name' ? 'Surat Warehouse' : field}
                    style={{ fontSize: 12 }}
                  />
                </label>
              ))}
            </div>
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginTop: 12 }}>
              <button
                type="button"
                className="button button-secondary"
                disabled={whBusy}
                onClick={async () => {
                  setWhBusy(true)
                  try {
                    await createDelhiveryWarehouse(whForm)
                    toast.toast('success', `Warehouse "${whForm.name}" registered with Delhivery!`)
                  } catch (err) {
                    toast.toast('error', `Warehouse create failed: ${err instanceof Error ? err.message : 'Unknown'}`)
                  } finally {
                    setWhBusy(false)
                  }
                }}
              >
                {whBusy ? 'Working…' : 'Register warehouse'}
              </button>
              <button
                type="button"
                className="button button-secondary"
                disabled={whBusy || !whForm.name.trim()}
                onClick={async () => {
                  setWhBusy(true)
                  try {
                    await updateDelhiveryWarehouse({ name: whForm.name.trim(), phone: whForm.phone, city: whForm.city, pin: whForm.pin, address: whForm.address, email: whForm.email })
                    toast.toast('success', `Warehouse "${whForm.name}" updated!`)
                  } catch (err) {
                    toast.toast('error', `Warehouse update failed: ${err instanceof Error ? err.message : 'Unknown'}`)
                  } finally {
                    setWhBusy(false)
                  }
                }}
              >
                Update warehouse
              </button>
            </div>
          </Panel>
          {statusQuery.isLoading && (
            <LoadingState label="Inspecting live connection to Shopify, Hostinger VPS, and Delhivery APIs…" />
          )}

          {statusQuery.isError && (
            <ErrorBox message={statusQuery.error instanceof Error ? statusQuery.error.message : 'Failed to query system status'} />
          )}

          {statusData && (
            <>
              {/* Top Architecture Grid */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: '16px' }}>
                {/* 1. Hostinger PostgreSQL Database */}
                <Panel style={{ padding: '18px 20px', position: 'relative' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <div style={{ width: '32px', height: '32px', borderRadius: '8px', background: '#ecfdf5', color: '#059669', display: 'grid', placeItems: 'center' }}>
                        <Icon name="database" size={17} />
                      </div>
                      <div>
                        <strong style={{ fontSize: '13px', display: 'block', color: 'var(--ink)' }}>PostgreSQL VPS</strong>
                        <span style={{ fontSize: '10.5px', color: '#64748b' }}>Hostinger 31.97.234.18</span>
                      </div>
                    </div>
                    <span className="status-badge status-success">
                      <span className="status-dot" /> LIVE
                    </span>
                  </div>
                  <div style={{ fontSize: '11.5px', display: 'grid', gap: '6px', color: '#475569' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: '#64748b' }}>Port & DB:</span>
                      <strong style={{ color: 'var(--ink)' }}>5433 · shopify_express</strong>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: '#64748b' }}>Total Orders:</span>
                      <strong style={{ color: '#059669', fontWeight: 800 }}>{statusData.database.totalOrders} Synced</strong>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: '#64748b' }}>Shipments & Returns:</span>
                      <strong style={{ color: 'var(--ink)' }}>{statusData.database.totalShipments} / {statusData.database.totalReturns}</strong>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: '#64748b' }}>Connection Pool:</span>
                      <span style={{ color: '#059669', fontWeight: 700 }}>Prisma Active</span>
                    </div>
                  </div>
                </Panel>

                {/* 2. Shopify 2026-07 Engine */}
                <Panel style={{ padding: '18px 20px', position: 'relative' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <div style={{ width: '32px', height: '32px', borderRadius: '8px', background: '#eff6ff', color: '#2563eb', display: 'grid', placeItems: 'center' }}>
                        <Icon name="package" size={17} />
                      </div>
                      <div>
                        <strong style={{ fontSize: '13px', display: 'block', color: 'var(--ink)' }}>Shopify API</strong>
                        <span style={{ fontSize: '10.5px', color: '#64748b' }}>v{statusData.shopify.apiVersion} (2026-07)</span>
                      </div>
                    </div>
                    <span className="status-badge status-info">
                      <span className="status-dot" /> CONNECTED
                    </span>
                  </div>
                  <div style={{ fontSize: '11.5px', display: 'grid', gap: '6px', color: '#475569' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: '#64748b' }}>Store Domain:</span>
                      <strong style={{ color: 'var(--ink)', fontSize: '10.5px' }}>youthnic2024.myshopify.com</strong>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: '#64748b' }}>Ingestion Floor:</span>
                      <strong style={{ color: '#2563eb' }}>1-July-2026 Onward</strong>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: '#64748b' }}>Auth Mode:</span>
                      <span style={{ color: 'var(--ink)', fontWeight: 600 }}>Custom App Token</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: '#64748b' }}>Sync Frequency:</span>
                      <span style={{ color: '#059669', fontWeight: 700 }}>Continuous / Live</span>
                    </div>
                  </div>
                </Panel>

                {/* 3. Delhivery Express Logistics */}
                <Panel style={{ padding: '18px 20px', position: 'relative' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <div style={{ width: '32px', height: '32px', borderRadius: '8px', background: '#fef3c7', color: '#d97706', display: 'grid', placeItems: 'center' }}>
                        <Icon name="truck" size={17} />
                      </div>
                      <div>
                        <strong style={{ fontSize: '13px', display: 'block', color: 'var(--ink)' }}>Delhivery Express</strong>
                        <span style={{ fontSize: '10.5px', color: '#64748b' }}>Production Express API</span>
                      </div>
                    </div>
                    <span className="status-badge status-warning">
                      <span className="status-dot" /> ACTIVE
                    </span>
                  </div>
                  <div style={{ fontSize: '11.5px', display: 'grid', gap: '6px', color: '#475569' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: '#64748b' }}>Surat Origin Hub:</span>
                      <strong style={{ color: 'var(--ink)' }}>{statusData.delhivery.originHub}</strong>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: '#64748b' }}>Origin Pincode:</span>
                      <strong style={{ color: '#d97706' }}>{statusData.delhivery.originPincode} (Surat)</strong>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: '#64748b' }}>Shipping Mode:</span>
                      <span style={{ color: 'var(--ink)', fontWeight: 600 }}>{statusData.delhivery.shippingMode} ({statusData.delhivery.labelSize})</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: '#64748b' }}>Wallet Ledger:</span>
                      <span style={{ color: '#64748b', fontWeight: 600 }}>ONE panel only (no API)</span>
                    </div>
                  </div>
                </Panel>

                {/* 4. Runtime & Host Uptime */}
                <Panel style={{ padding: '18px 20px', position: 'relative' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <div style={{ width: '32px', height: '32px', borderRadius: '8px', background: '#f3e8ff', color: '#7c3aed', display: 'grid', placeItems: 'center' }}>
                        <Icon name="server" size={17} />
                      </div>
                      <div>
                        <strong style={{ fontSize: '13px', display: 'block', color: 'var(--ink)' }}>Node & Express</strong>
                        <span style={{ fontSize: '10.5px', color: '#64748b' }}>{statusData.stack.nodeVersion} · {statusData.stack.platform}</span>
                      </div>
                    </div>
                    <span className="status-badge status-purple">
                      <span className="status-dot" /> PORT {statusData.stack.port}
                    </span>
                  </div>
                  <div style={{ fontSize: '11.5px', display: 'grid', gap: '6px', color: '#475569' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: '#64748b' }}>Uptime:</span>
                      <strong style={{ color: 'var(--ink)' }}>{Math.floor(statusData.stack.uptimeSeconds / 60)} mins</strong>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: '#64748b' }}>Memory RSS:</span>
                      <strong style={{ color: '#7c3aed' }}>{statusData.stack.memoryRssMb} MB</strong>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: '#64748b' }}>Heap Allocated:</span>
                      <span style={{ color: 'var(--ink)', fontWeight: 600 }}>{statusData.stack.memoryHeapUsedMb} MB</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: '#64748b' }}>Environment:</span>
                      <span style={{ textTransform: 'uppercase', color: '#059669', fontWeight: 700 }}>{statusData.stack.env}</span>
                    </div>
                  </div>
                </Panel>

                {/* Resend Email Gateway Integration */}
                <Panel>
                  <PanelHeading
                    eyebrow="Automated Customer Email Gateway"
                    title="Resend Mail API & Transit Notification Engine"
                    action={
                      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                        <button
                          type="button"
                          className="btn-table-action"
                          style={{ background: '#f5f3ff', borderColor: '#ddd6fe', color: '#6366f1' }}
                          onClick={() => {
                            setResendApiKey('')
                            setResendFromEmail(resendQuery.data?.fromEmail || 'Youthnic Logistics <onboarding@resend.dev>')
                            setIsResendModalOpen(true)
                          }}
                          title="Configure Resend API credentials"
                        >
                          <Icon name="key" size={13} />
                          <span>Configure Resend</span>
                        </button>
                        <button
                          type="button"
                          className="btn-table-action"
                          style={{ background: '#ecfdf5', borderColor: '#a7f3d0', color: '#047857' }}
                          onClick={() => setIsTestEmailModalOpen(true)}
                          title="Send a test email notification"
                        >
                          <Icon name="mail" size={14} />
                          <span>Test Email</span>
                        </button>
                      </div>
                    }
                  />
                  <div style={{ fontSize: '12px', display: 'grid', gap: '10px', color: '#475569' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', paddingBottom: '8px', borderBottom: '1px solid var(--line)' }}>
                      <span style={{ color: '#64748b' }}>Platform Status:</span>
                      {resendQuery.data?.status === 'ok' ? (
                        <span className="status-badge status-success">
                          <span className="status-dot" /> LIVE CONNECTED ({resendQuery.data.latencyMs}ms)
                        </span>
                      ) : resendQuery.data?.apiKeyConfigured ? (
                        <span className="status-badge status-warning">
                          <span className="status-dot" /> API KEY CONFIGURED
                        </span>
                      ) : (
                        <span className="status-badge status-purple">
                          <span className="status-dot" /> SANDBOX SIMULATED (FULL PREVIEW)
                        </span>
                      )}
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', paddingBottom: '8px', borderBottom: '1px solid var(--line)' }}>
                      <span style={{ color: '#64748b' }}>Endpoint:</span>
                      <code style={{ fontSize: '10.5px', background: 'var(--line-subtle)', padding: '2px 6px', borderRadius: '4px', color: '#6366f1' }}>
                        https://api.resend.com/emails
                      </code>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', paddingBottom: '8px', borderBottom: '1px solid var(--line)' }}>
                      <span style={{ color: '#64748b' }}>Configured Sender:</span>
                      <strong style={{ color: 'var(--ink)' }}>
                        {resendQuery.data?.fromEmail || 'Youthnic Logistics <onboarding@resend.dev>'}
                      </strong>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', paddingBottom: '8px', borderBottom: '1px solid var(--line)' }}>
                      <span style={{ color: '#64748b' }}>Conversion Tracking:</span>
                      <span style={{ color: '#059669', fontWeight: 700, fontSize: '11.5px' }}>
                        Active (Click-to-Convert Redirect Endpoint Enabled)
                      </span>
                    </div>
                    <div>
                      <span style={{ color: '#64748b', fontSize: '11px', display: 'block', marginBottom: '6px' }}>Supported Customer Delay & Transit Templates:</span>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '11px', background: 'var(--canvas)', padding: '5px 8px', borderRadius: '6px' }}>
                          <span>⏱️ <strong>In-Transit Weather / Route Delay</strong></span>
                          <span style={{ color: '#d97706', fontSize: '10px', fontWeight: 700 }}>Proactive Alert</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '11px', background: 'var(--canvas)', padding: '5px 8px', borderRadius: '6px' }}>
                          <span>🏭 <strong>Warehouse SLA Dispatch Delay</strong></span>
                          <span style={{ color: '#ef4444', fontSize: '10px', fontWeight: 700 }}>QC Priority</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '11px', background: 'var(--canvas)', padding: '5px 8px', borderRadius: '6px' }}>
                          <span>🚚 <strong>Out For Delivery Alert</strong></span>
                          <span style={{ color: '#2563eb', fontSize: '10px', fontWeight: 700 }}>COD Readiness</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '11px', background: 'var(--canvas)', padding: '5px 8px', borderRadius: '6px' }}>
                          <span>⚠️ <strong>NDR Delivery Reschedule</strong></span>
                          <span style={{ color: '#9333ea', fontSize: '10px', fontWeight: 700 }}>RTO Prevention</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </Panel>
              </div>

              {/* Payment Rails & Checkout Aggregators */}
              <Panel>
                <PanelHeading
                  eyebrow="Payment Rails & Settlement Partners"
                  title="Checkout Aggregators & Reconciliation Status"
                  action={
                    <span style={{ fontSize: '11px', color: '#64748b', fontWeight: 600 }}>
                      Configured for 100% 3-Way Order Reconciliation
                    </span>
                  }
                />
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: '14px' }}>
                  {/* GoKwik */}
                  <div style={{ border: '1px solid var(--line)', borderRadius: '10px', padding: '14px', background: 'var(--canvas)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
                      <img src="/logos/gokwik.png" alt="GoKwik" style={{ height: '24px', objectFit: 'contain' }} onError={(e) => { (e.target as HTMLElement).style.display = 'none' }} />
                      <div>
                        <strong style={{ fontSize: '12px', display: 'block', color: 'var(--ink)' }}>GoKwik</strong>
                        <span style={{ fontSize: '10px', color: '#64748b' }}>Checkout Aggregator</span>
                      </div>
                    </div>
                    <div style={{ fontSize: '10.5px', color: '#475569', display: 'grid', gap: '4px' }}>
                      <div>• Automated COD Confirmation tags</div>
                      <div>• RTO Risk scores & delivery history</div>
                      <div>• Headless checkout routing</div>
                    </div>
                  </div>

                  {/* Easebuzz */}
                  <div style={{ border: '1px solid var(--line)', borderRadius: '10px', padding: '14px', background: 'var(--canvas)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
                      <img src="/logos/easebuzz.png" alt="Easebuzz" style={{ height: '24px', objectFit: 'contain' }} onError={(e) => { (e.target as HTMLElement).style.display = 'none' }} />
                      <div>
                        <strong style={{ fontSize: '12px', display: 'block', color: 'var(--ink)' }}>Easebuzz</strong>
                        <span style={{ fontSize: '10px', color: '#64748b' }}>Settlement Partner</span>
                      </div>
                    </div>
                    <div style={{ fontSize: '10.5px', color: '#475569', display: 'grid', gap: '4px' }}>
                      <div>• Primary UPI & NetBanking collection</div>
                      <div>• Direct bank settlement verification</div>
                      <div>• Transaction ID matching (E2609...)</div>
                    </div>
                  </div>

                  {/* PhonePe */}
                  <div style={{ border: '1px solid var(--line)', borderRadius: '10px', padding: '14px', background: 'var(--canvas)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
                      <img src="/logos/phonepe.png" alt="PhonePe" style={{ height: '24px', objectFit: 'contain' }} onError={(e) => { (e.target as HTMLElement).style.display = 'none' }} />
                      <div>
                        <strong style={{ fontSize: '12px', display: 'block', color: 'var(--ink)' }}>PhonePe</strong>
                        <span style={{ fontSize: '10px', color: '#64748b' }}>Secondary UPI Rail</span>
                      </div>
                    </div>
                    <div style={{ fontSize: '10.5px', color: '#475569', display: 'grid', gap: '4px' }}>
                      <div>• Instant UPI Intent & QR Gateway</div>
                      <div>• UTR reconciliation mapping</div>
                      <div>• High-traffic backup gateway</div>
                    </div>
                  </div>

                  {/* COD Remittance */}
                  <div style={{ border: '1px solid var(--line)', borderRadius: '10px', padding: '14px', background: 'var(--canvas)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
                      <img src="/logos/delhivery.png" alt="Delhivery" style={{ height: '20px', objectFit: 'contain' }} onError={(e) => { (e.target as HTMLElement).style.display = 'none' }} />
                      <div>
                        <strong style={{ fontSize: '12px', display: 'block', color: 'var(--ink)' }}>Delhivery COD</strong>
                        <span style={{ fontSize: '10px', color: '#64748b' }}>Cash Remittance</span>
                      </div>
                    </div>
                    <div style={{ fontSize: '10.5px', color: '#475569', display: 'grid', gap: '4px' }}>
                      <div>• Cash on Delivery collection</div>
                      <div>• Live rate-API freight estimates</div>
                      <div>• Automated discrepancy flagging</div>
                    </div>
                  </div>
                </div>
              </Panel>

              {/* Webhook Endpoints & Automated Communications */}
              <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 0.8fr', gap: '18px' }}>
                <Panel>
                  <PanelHeading
                    eyebrow="Real-Time Event Ingestion"
                    title="Active Webhook Endpoints"
                  />
                  <div className="table-wrap">
                    <table className="data-table" style={{ minWidth: '550px' }}>
                      <thead>
                        <tr>
                          <th>Event Name</th>
                          <th>Webhook Route</th>
                          <th>Method</th>
                          <th>Latency</th>
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {statusData.webhooks.map((w) => (
                          <tr key={w.name}>
                            <td>
                              <strong>{w.name}</strong>
                            </td>
                            <td>
                              <code style={{ fontSize: '10.5px', background: 'var(--line-subtle)', padding: '2px 6px', borderRadius: '4px' }}>
                                {w.path}
                              </code>
                            </td>
                            <td>
                              <span style={{ fontSize: '10px', fontWeight: 800, color: '#2563eb' }}>{w.method}</span>
                            </td>
                            <td>
                              <span style={{ fontSize: '11px', color: '#059669', fontWeight: 700 }}>{w.latency || '10ms'}</span>
                            </td>
                            <td>
                              <span className="status-badge status-success">
                                <span className="status-dot" /> ACTIVE
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Panel>

                <Panel>
                  <PanelHeading
                    eyebrow="Automated Customer Communications"
                    title="Kapso AI WhatsApp Platform (Cloud REST API)"
                    action={
                      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                        <button
                          type="button"
                          className="btn-table-action"
                          style={{ background: '#eff6ff', borderColor: '#bfdbfe', color: '#2563eb' }}
                          onClick={() => {
                            if (kapsoQuery.data?.senderPhone) {
                              setKapsoSenderPhone(kapsoQuery.data.senderPhone)
                            }
                            setIsKapsoConfigModalOpen(true)
                          }}
                          title="Configure Kapso API Key and Sender Number"
                        >
                          <Icon name="key" size={13} />
                          <span>Configure API</span>
                        </button>
                        <button
                          type="button"
                          className="btn-table-action"
                          style={{ background: '#ecfdf5', borderColor: '#a7f3d0', color: '#047857' }}
                          onClick={() => setIsWhatsAppTestModalOpen(true)}
                          title="Send a live test trigger to your WhatsApp number"
                        >
                          <Icon name="message" size={14} />
                          <span>Test Trigger</span>
                        </button>
                      </div>
                    }
                  />
                  <div style={{ fontSize: '12px', display: 'grid', gap: '10px', color: '#475569' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', paddingBottom: '8px', borderBottom: '1px solid var(--line)' }}>
                      <span style={{ color: '#64748b' }}>Platform Status:</span>
                      {kapsoQuery.data?.status === 'ok' ? (
                        <span className="status-badge status-success">
                          <span className="status-dot" /> LIVE CONNECTED ({kapsoQuery.data.latencyMs}ms)
                        </span>
                      ) : kapsoQuery.data?.apiKeyConfigured ? (
                        <span className="status-badge status-warning">
                          <span className="status-dot" /> CREDENTIALS CONFIGURED
                        </span>
                      ) : (
                        <span className="status-badge status-purple">
                          <span className="status-dot" /> SANDBOX / READY
                        </span>
                      )}
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', paddingBottom: '8px', borderBottom: '1px solid var(--line)' }}>
                      <span style={{ color: '#64748b' }}>API Base URL:</span>
                      <code style={{ fontSize: '10.5px', background: 'var(--line-subtle)', padding: '2px 6px', borderRadius: '4px', color: '#2563eb' }}>
                        https://api.kapso.ai
                      </code>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', paddingBottom: '8px', borderBottom: '1px solid var(--line)' }}>
                      <span style={{ color: '#64748b' }}>Authorization:</span>
                      <strong style={{ color: 'var(--ink)', fontSize: '11px' }}>
                        {kapsoQuery.data?.apiKeyConfigured ? 'Bearer [CONFIGURED]' : 'Bearer ${env:KAPSO_API_KEY}'}
                      </strong>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', paddingBottom: '8px', borderBottom: '1px solid var(--line)' }}>
                      <span style={{ color: '#64748b' }}>Registered Sender:</span>
                      <strong style={{ color: 'var(--ink)' }}>
                        {kapsoQuery.data?.senderPhone || '+91 88661 54721'}
                      </strong>
                    </div>
                    {kapsoQuery.data?.connectedNumbers && kapsoQuery.data.connectedNumbers.length > 0 && (
                      <div style={{ display: 'flex', justifyContent: 'space-between', paddingBottom: '8px', borderBottom: '1px solid var(--line)' }}>
                        <span style={{ color: '#64748b' }}>Connected WhatsApp:</span>
                        <span style={{ color: '#059669', fontWeight: 700, fontSize: '11.5px' }}>
                          {kapsoQuery.data.connectedNumbers[0]?.verified_name || 'Verified'} ({kapsoQuery.data.connectedNumbers[0]?.display_phone_number || kapsoQuery.data.connectedNumbers[0]?.id})
                        </span>
                      </div>
                    )}
                    <div>
                      <span style={{ color: '#64748b', fontSize: '11px', display: 'block', marginBottom: '6px' }}>Critical Trigger Automations:</span>
                      <div style={{ display: 'grid', gap: '5px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '11px', background: 'var(--canvas)', padding: '5px 8px', borderRadius: '6px' }}>
                          <span>⚡ <strong>COD Confirmation</strong></span>
                          <span style={{ color: '#059669', fontSize: '10px', fontWeight: 700 }}>Auto Tag Sync</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '11px', background: 'var(--canvas)', padding: '5px 8px', borderRadius: '6px' }}>
                          <span>🚀 <strong>Delhivery Dispatched</strong></span>
                          <span style={{ color: '#2563eb', fontSize: '10px', fontWeight: 700 }}>Click-to-Track</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '11px', background: 'var(--canvas)', padding: '5px 8px', borderRadius: '6px' }}>
                          <span>🚚 <strong>Out for Delivery</strong></span>
                          <span style={{ color: '#d97706', fontSize: '10px', fontWeight: 700 }}>COD Cash Alert</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '11px', background: 'var(--canvas)', padding: '5px 8px', borderRadius: '6px' }}>
                          <span>⚠️ <strong>NDR Reschedule Help</strong></span>
                          <span style={{ color: '#ef4444', fontSize: '10px', fontWeight: 700 }}>RTO Prevent Link</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </Panel>
              </div>
            </>
          )}
        </div>
      )}

      {/* ─────────────────────────────────────────────────────────────
          TAB 2: USER CREATION & TEAM MANAGEMENT
          ───────────────────────────────────────────────────────────── */}
      {activeTab === 'users' && (
        <div style={{ display: 'grid', gap: '20px' }}>
          {/* Filters & Actions Bar */}
          <Panel style={{ padding: '16px 20px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '14px' }}>
              <div className="search-field" style={{ maxWidth: '380px' }}>
                <Icon name="search" size={15} />
                <input
                  placeholder="Filter operators by name, email, or role…"
                  value={userSearch}
                  onChange={(e) => setUserSearch(e.target.value)}
                />
              </div>

              <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                <span style={{ fontSize: '11.5px', color: '#64748b', fontWeight: 600 }}>
                  Showing {filteredUsers.length} of {usersQuery.data?.length ?? 0} active console accounts
                </span>
                <button
                  type="button"
                  className="button button-primary"
                  onClick={handleOpenAdd}
                >
                  <Icon name="plus" size={15} />
                  <span>Add Operator</span>
                </button>
              </div>
            </div>
          </Panel>

          {/* Users Table */}
          <Panel style={{ padding: '0', overflow: 'hidden' }}>
            {usersQuery.isLoading ? (
              <LoadingState label="Loading team operators and permissions…" />
            ) : filteredUsers.length === 0 ? (
              <div style={{ padding: '40px', textAlign: 'center', color: '#64748b' }}>
                <Icon name="users" size={32} />
                <p style={{ marginTop: '8px', fontSize: '13px' }}>No operators match your filter.</p>
              </div>
            ) : (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Operator</th>
                      <th>Role & Scope</th>
                      <th>Department</th>
                      <th>Contact Phone</th>
                      <th>Status</th>
                      <th>Last Active</th>
                      <th style={{ textAlign: 'right' }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredUsers.map((user) => (
                      <tr key={user.id}>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                            <div
                              style={{
                                width: '32px',
                                height: '32px',
                                borderRadius: '50%',
                                background: 'linear-gradient(135deg, #2563eb, #1e40af)',
                                color: '#ffffff',
                                display: 'grid',
                                placeItems: 'center',
                                fontWeight: 800,
                                fontSize: '11px',
                                flexShrink: 0,
                              }}
                            >
                              {user.avatar || 'OP'}
                            </div>
                            <div>
                              <strong style={{ fontSize: '12px', color: 'var(--ink)' }}>{user.name}</strong>
                              <span style={{ fontSize: '10.5px', color: '#64748b' }}>{user.email}</span>
                            </div>
                          </div>
                        </td>
                        <td>
                          <span
                            style={{
                              fontSize: '11px',
                              fontWeight: 750,
                              color: user.role.includes('Admin')
                                ? '#7c3aed'
                                : user.role.includes('Finance')
                                ? '#2563eb'
                                : user.role.includes('QC')
                                ? '#d97706'
                                : '#059669',
                            }}
                          >
                            {user.role}
                          </span>
                        </td>
                        <td>
                          <span style={{ fontSize: '11px', color: '#475569' }}>{user.department}</span>
                        </td>
                        <td>
                          <span style={{ fontSize: '11px', color: '#64748b' }}>{user.phone || '—'}</span>
                        </td>
                        <td>
                          <button
                            type="button"
                            onClick={() => handleToggleStatus(user)}
                            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
                            title="Click to toggle status"
                          >
                            <span className={`status-badge ${user.status === 'ACTIVE' ? 'status-success' : 'status-danger'}`}>
                              <span className="status-dot" /> {user.status}
                            </span>
                          </button>
                        </td>
                        <td>
                          <span style={{ fontSize: '10.5px', color: '#64748b' }}>{user.lastActive || 'Never'}</span>
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <div style={{ display: 'inline-flex', gap: '6px' }}>
                            <button
                              type="button"
                              className="btn-table-action"
                              onClick={() => handleOpenEdit(user)}
                              title="Edit user details"
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              className="btn-table-action"
                              style={{ color: '#ef4444' }}
                              onClick={() => handleDeleteUser(user)}
                              title="Remove operator account"
                            >
                              Remove
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </div>
      )}

      {/* ─────────────────────────────────────────────────────────────
          CREATE / EDIT OPERATOR MODAL
          ───────────────────────────────────────────────────────────── */}
      {isAddModalOpen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1000,
            background: 'rgba(15, 23, 42, 0.65)',
            backdropFilter: 'blur(4px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '20px',
          }}
          onClick={() => setIsAddModalOpen(false)}
        >
          <div
            style={{
              background: 'var(--panel)',
              border: '1px solid var(--line)',
              borderRadius: '16px',
              padding: '28px',
              width: '100%',
              maxWidth: '520px',
              boxShadow: '0 20px 40px rgba(0, 0, 0, 0.25)',
              position: 'relative',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '20px' }}>
              <div>
                <h3 style={{ margin: 0, fontSize: '18px', fontWeight: 800, color: 'var(--ink)' }}>
                  {editingUser ? 'Edit Operator Account' : 'Create New Team Operator'}
                </h3>
                <p style={{ margin: '4px 0 0', fontSize: '11.5px', color: '#64748b' }}>
                  Assign role permissions for Surat fulfillment, QC scans, or finance auditing.
                </p>
              </div>
              <button
                type="button"
                style={{ background: 'transparent', border: 0, color: '#64748b', cursor: 'pointer', padding: '4px' }}
                onClick={() => setIsAddModalOpen(false)}
              >
                <Icon name="close" size={18} />
              </button>
            </div>

            <form onSubmit={handleSubmitForm} style={{ display: 'grid', gap: '14px' }}>
              <div className="form-field">
                <label className="field-label">Full Name</label>
                <input
                  required
                  placeholder="e.g. Ramesh Patel"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                />
              </div>

              <div className="form-field">
                <label className="field-label">Email Address</label>
                <input
                  type="email"
                  required
                  placeholder="e.g. ramesh@youthnic.com"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                />
              </div>

              <div className="form-field">
                <label className="field-label">Role & Permissions</label>
                <select
                  value={formData.role}
                  onChange={(e) => setFormData({ ...formData, role: e.target.value })}
                >
                  {ROLE_OPTIONS.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </div>

              <div className="form-field">
                <label className="field-label">Department / Hub</label>
                <select
                  value={formData.department}
                  onChange={(e) => setFormData({ ...formData, department: e.target.value })}
                >
                  {DEPARTMENT_OPTIONS.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              </div>

              <div className="form-field">
                <label className="field-label">Contact Phone</label>
                <input
                  placeholder="e.g. +91 98250 12345"
                  value={formData.phone}
                  onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                />
              </div>

              <div className="form-field">
                <label className="field-label">Account Status</label>
                <select
                  value={formData.status}
                  onChange={(e) => setFormData({ ...formData, status: e.target.value as 'ACTIVE' | 'INACTIVE' })}
                >
                  <option value="ACTIVE">ACTIVE (Authorized to access OMS console)</option>
                  <option value="INACTIVE">INACTIVE (Access Suspended)</option>
                </select>
              </div>

              {!editingUser ? (
                <div className="form-field">
                  <label className="field-label">Login Password (min 6 chars)</label>
                  <input
                    type="password"
                    required
                    minLength={6}
                    autoComplete="new-password"
                    placeholder="Set initial password for sign-in"
                    value={formData.password}
                    onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                  />
                  <span style={{ fontSize: '11px', color: '#64748b' }}>Admin sets this now — operator signs in with email + this password.</span>
                </div>
              ) : (
                <>
                  <div className="form-field">
                    <label className="field-label">Change Password (optional)</label>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <input
                        type="password"
                        minLength={6}
                        autoComplete="new-password"
                        placeholder="New password — leave blank to keep current"
                        value={formData.newPassword}
                        onChange={(e) => setFormData({ ...formData, newPassword: e.target.value })}
                        style={{ flex: 1 }}
                      />
                      <button
                        type="button"
                        className="button button-secondary"
                        disabled={!formData.newPassword || formData.newPassword.length < 6 || setPasswordMutation.isPending}
                        onClick={() => setPasswordMutation.mutate({ id: editingUser.id, newPassword: formData.newPassword })}
                      >
                        {setPasswordMutation.isPending ? 'Saving…' : 'Set'}
                      </button>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                    <span style={{ fontSize: '11px', color: '#64748b' }}>Login: {editingUser.loginEnabled === false ? 'disabled (roster-only)' : editingUser.firebaseUid ? `Firebase linked` : 'roster-only'}</span>
                    <button
                      type="button"
                      className="button button-secondary"
                      disabled={resetLinkMutation.isPending}
                      onClick={() => resetLinkMutation.mutate(editingUser.id)}
                    >
                      {resetLinkMutation.isPending ? 'Generating…' : 'Copy reset link'}
                    </button>
                  </div>
                </>
              )}

              <div style={{ display: 'flex', gap: '10px', marginTop: '10px', justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => setIsAddModalOpen(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="button button-primary"
                  disabled={createUserMutation.isPending || updateUserMutation.isPending}
                >
                  {editingUser ? 'Save Changes' : 'Create Operator Account'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ─────────────────────────────────────────────────────────────
          KAPSO WHATSAPP TEST MODAL
          ───────────────────────────────────────────────────────────── */}
      {isWhatsAppTestModalOpen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1000,
            background: 'rgba(15, 23, 42, 0.65)',
            backdropFilter: 'blur(4px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '20px',
          }}
          onClick={() => setIsWhatsAppTestModalOpen(false)}
        >
          <div
            style={{
              background: 'var(--panel)',
              border: '1px solid var(--line)',
              borderRadius: '16px',
              padding: '28px',
              width: '100%',
              maxWidth: '520px',
              boxShadow: '0 20px 40px rgba(0, 0, 0, 0.25)',
              position: 'relative',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '20px' }}>
              <div>
                <h3 style={{ margin: 0, fontSize: '18px', fontWeight: 800, color: 'var(--ink)' }}>
                  Test Kapso WhatsApp Trigger
                </h3>
                <p style={{ margin: '4px 0 0', fontSize: '11.5px', color: '#64748b' }}>
                  Send a live or test trigger to any phone number via Kapso WhatsApp platform.
                </p>
              </div>
              <button
                type="button"
                style={{ background: 'transparent', border: 0, color: '#64748b', cursor: 'pointer', padding: '4px' }}
                onClick={() => setIsWhatsAppTestModalOpen(false)}
              >
                <Icon name="close" size={18} />
              </button>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault()
                testWhatsAppMutation.mutate({
                  phone: testPhone,
                  trigger: testTrigger,
                  customMessage: testCustomMsg,
                })
              }}
              style={{ display: 'grid', gap: '14px' }}
            >
              <div className="form-field">
                <label className="field-label">Recipient Mobile Number (E.164 / 10 Digits)</label>
                <input
                  required
                  placeholder="e.g. 9825012345 or +919825012345"
                  value={testPhone}
                  onChange={(e) => setTestPhone(e.target.value)}
                />
              </div>

              <div className="form-field">
                <label className="field-label">Critical Trigger Type</label>
                <select
                  value={testTrigger}
                  onChange={(e) => setTestTrigger(e.target.value)}
                >
                  <option value="COD_CONFIRMATION">⚡ COD Confirmation (1-Click Customer Verification)</option>
                  <option value="ORDER_SHIPPED">🚀 Delhivery Dispatched (Live AWB Tracking Link)</option>
                  <option value="OUT_FOR_DELIVERY">🚚 Out for Delivery Alert (COD Cash Readiness)</option>
                  <option value="NDR_ALERT">⚠️ NDR Delivery Help (Urgent Reschedule to avoid RTO)</option>
                  <option value="DELIVERED">🎉 Order Delivered (Feedback & Size Exchange)</option>
                  <option value="CUSTOM">💬 Custom Message Body</option>
                </select>
              </div>

              {testTrigger === 'CUSTOM' && (
                <div className="form-field">
                  <label className="field-label">Custom WhatsApp Message</label>
                  <textarea
                    rows={3}
                    placeholder="Enter message text..."
                    value={testCustomMsg}
                    onChange={(e) => setTestCustomMsg(e.target.value)}
                  />
                </div>
              )}

              <div style={{ background: 'var(--canvas)', border: '1px solid var(--line)', borderRadius: '8px', padding: '12px', fontSize: '11px', color: '#475569' }}>
                <div style={{ fontWeight: 700, color: 'var(--ink)', marginBottom: '4px' }}>📡 Kapso WhatsApp REST API:</div>
                <div>Configured endpoint: <code>https://api.kapso.ai</code></div>
                <div style={{ marginTop: '2px' }}>Bearer Token: <code>&#36;{'{env:KAPSO_API_KEY}'}</code></div>
              </div>

              <div style={{ display: 'flex', gap: '10px', marginTop: '10px', justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => setIsWhatsAppTestModalOpen(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="button button-primary"
                  style={{ background: '#10b981', borderColor: '#059669' }}
                  disabled={testWhatsAppMutation.isPending}
                >
                  {testWhatsAppMutation.isPending ? 'Dispatching…' : 'Send WhatsApp Message'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ─────────────────────────────────────────────────────────────
          KAPSO WHATSAPP CONFIGURATION MODAL
          ───────────────────────────────────────────────────────────── */}
      {isKapsoConfigModalOpen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1000,
            background: 'rgba(15, 23, 42, 0.65)',
            backdropFilter: 'blur(4px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '20px',
          }}
          onClick={() => setIsKapsoConfigModalOpen(false)}
        >
          <div
            style={{
              background: 'var(--panel)',
              border: '1px solid var(--line)',
              borderRadius: '16px',
              padding: '28px',
              width: '100%',
              maxWidth: '540px',
              boxShadow: '0 20px 40px rgba(0, 0, 0, 0.25)',
              position: 'relative',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '20px' }}>
              <div>
                <h3 style={{ margin: 0, fontSize: '18px', fontWeight: 800, color: 'var(--ink)' }}>
                  Configure Kapso AI WhatsApp REST API
                </h3>
                <p style={{ margin: '4px 0 0', fontSize: '11.5px', color: '#64748b' }}>
                  Update live credentials for automated COD confirmation and Delhivery tracking WhatsApp triggers.
                </p>
              </div>
              <button
                type="button"
                style={{ background: 'transparent', border: 0, color: '#64748b', cursor: 'pointer', padding: '4px' }}
                onClick={() => setIsKapsoConfigModalOpen(false)}
              >
                <Icon name="close" size={18} />
              </button>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault()
                updateKapsoMutation.mutate({
                  apiKey: kapsoApiKey.trim(),
                  phoneNumberId: kapsoPhoneNumberId.trim() || undefined,
                  senderPhone: kapsoSenderPhone.trim() || undefined,
                })
              }}
              style={{ display: 'grid', gap: '14px' }}
            >
              <div className="form-field">
                <label className="field-label">Kapso API Key (Bearer Token)</label>
                <input
                  type="password"
                  placeholder="Enter your Kapso API key (e.g. kps_live_...)"
                  value={kapsoApiKey}
                  onChange={(e) => setKapsoApiKey(e.target.value)}
                />
                <span style={{ fontSize: '10.5px', color: '#64748b', marginTop: '3px' }}>
                  Supplied in Authorization header: <code>Bearer [YOUR_KEY]</code> and <code>X-API-Key</code>.
                </span>
              </div>

              <div className="form-field">
                <label className="field-label">WhatsApp Sender Phone Number</label>
                <input
                  placeholder="e.g. +91 88661 54721"
                  value={kapsoSenderPhone}
                  onChange={(e) => setKapsoSenderPhone(e.target.value)}
                />
                <span style={{ fontSize: '10.5px', color: '#64748b', marginTop: '3px' }}>
                  Display phone number for outbound notifications.
                </span>
              </div>

              <div className="form-field">
                <label className="field-label">Meta Phone Number ID (Optional)</label>
                <input
                  placeholder="Leave empty to auto-discover via Kapso Platform API"
                  value={kapsoPhoneNumberId}
                  onChange={(e) => setKapsoPhoneNumberId(e.target.value)}
                />
                <span style={{ fontSize: '10.5px', color: '#64748b', marginTop: '3px' }}>
                  Kapso will automatically query <code>/platform/v1/whatsapp/phone_numbers</code> if omitted.
                </span>
              </div>

              <div style={{ background: 'var(--canvas)', border: '1px solid var(--line)', borderRadius: '8px', padding: '12px', fontSize: '11px', color: '#475569' }}>
                <div style={{ fontWeight: 700, color: 'var(--ink)', marginBottom: '4px' }}>🔐 Persistence & MCP Sync:</div>
                <div>Updating these values immediately updates the active runtime service and persists <code>KAPSO_API_KEY</code> and <code>KAPSO_PHONE_NUMBER_ID</code> to your local <code>.env</code> file.</div>
              </div>

              <div style={{ display: 'flex', gap: '10px', marginTop: '10px', justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => setIsKapsoConfigModalOpen(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="button button-primary"
                  disabled={updateKapsoMutation.isPending}
                >
                  {updateKapsoMutation.isPending ? 'Verifying & Saving…' : 'Save & Verify Kapso Connection'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Configure Resend Modal */}
      {isResendModalOpen && (
        <div className="modal-backdrop" onClick={() => setIsResendModalOpen(false)}>
          <div className="modal-card" style={{ maxWidth: '540px' }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <div>
                <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 700 }}>Configure Resend Mail Integration</h3>
                <p style={{ margin: '3px 0 0', fontSize: '12px', color: '#64748b' }}>
                  Provide your Resend API credentials to send live branded customer notifications.
                </p>
              </div>
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setIsResendModalOpen(false)}
                style={{ padding: '4px' }}
              >
                ✕
              </button>
            </div>

            <form
              onSubmit={(e: FormEvent) => {
                e.preventDefault()
                updateResendMutation.mutate({
                  apiKey: resendApiKey,
                  fromEmail: resendFromEmail,
                })
              }}
              style={{ display: 'grid', gap: '14px' }}
            >
              <div className="form-field">
                <label className="field-label">Resend API Key</label>
                <input
                  type="password"
                  placeholder="re_xxxxxxxxxxxxxxxxxxxxxxxx"
                  value={resendApiKey}
                  onChange={(e) => setResendApiKey(e.target.value)}
                />
                <span style={{ fontSize: '10.5px', color: '#64748b', marginTop: '3px' }}>
                  From your <a href="https://resend.com/api-keys" target="_blank" rel="noreferrer" style={{ color: '#6366f1' }}>Resend Console</a>. If left empty, system operates in high-fidelity simulated sandbox mode.
                </span>
              </div>

              <div className="form-field">
                <label className="field-label">From Email Address & Name</label>
                <input
                  placeholder="Youthnic Logistics <onboarding@resend.dev>"
                  value={resendFromEmail}
                  onChange={(e) => setResendFromEmail(e.target.value)}
                />
                <span style={{ fontSize: '10.5px', color: '#64748b', marginTop: '3px' }}>
                  Use <code>Youthnic Logistics &lt;onboarding@resend.dev&gt;</code> for testing or your verified sending domain (e.g., <code>orders@youthnic.com</code>).
                </span>
              </div>

              <div style={{ background: 'var(--canvas)', border: '1px solid var(--line)', borderRadius: '8px', padding: '12px', fontSize: '11px', color: '#475569' }}>
                <div style={{ fontWeight: 700, color: 'var(--ink)', marginBottom: '4px' }}>🔐 Persistence & Security:</div>
                <div>Updating these values immediately updates the active runtime email service and persists <code>RESEND_API_KEY</code> and <code>RESEND_FROM_EMAIL</code> to your <code>.env</code> file.</div>
              </div>

              <div style={{ display: 'flex', gap: '10px', marginTop: '10px', justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => setIsResendModalOpen(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="button button-primary"
                  disabled={updateResendMutation.isPending}
                >
                  {updateResendMutation.isPending ? 'Verifying & Saving…' : 'Save & Verify Resend Configuration'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Test Email Modal */}
      {isTestEmailModalOpen && (
        <div className="modal-backdrop" onClick={() => setIsTestEmailModalOpen(false)}>
          <div className="modal-card" style={{ maxWidth: '500px' }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <div>
                <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 700 }}>Send Test Notification Email</h3>
                <p style={{ margin: '3px 0 0', fontSize: '12px', color: '#64748b' }}>
                  Validate Resend dispatch, layout rendering, and click-to-convert tracking.
                </p>
              </div>
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setIsTestEmailModalOpen(false)}
                style={{ padding: '4px' }}
              >
                ✕
              </button>
            </div>

            <form
              onSubmit={(e: FormEvent) => {
                e.preventDefault()
                testEmailMutation.mutate({
                  to: testEmailTo,
                  templateType: testEmailTemplate,
                })
              }}
              style={{ display: 'grid', gap: '14px' }}
            >
              <div className="form-field">
                <label className="field-label">Recipient Email</label>
                <input
                  type="email"
                  required
                  placeholder="customer@example.com"
                  value={testEmailTo}
                  onChange={(e) => setTestEmailTo(e.target.value)}
                />
              </div>

              <div className="form-field">
                <label className="field-label">Email Notification Template</label>
                <select
                  value={testEmailTemplate}
                  onChange={(e) => setTestEmailTemplate(e.target.value)}
                >
                  <option value="TRANSIT_DELAY">⏱️ Transit Delay Alert (Bad Weather/Route Delay)</option>
                  <option value="DISPATCH_DELAY">🏭 Warehouse Dispatch SLA Delay</option>
                  <option value="IN_TRANSIT">🚚 In-Transit Journey Tracking</option>
                  <option value="OUT_FOR_DELIVERY">📦 Out For Delivery (Cash Alert)</option>
                  <option value="NDR_ATTEMPT">⚠️ NDR Delivery Reschedule (RTO Prevent)</option>
                  <option value="DELIVERED">🎉 Order Delivered & Feedback</option>
                  <option value="ORDER_CONFIRMED">✅ Order Confirmed & Dispatch Preparation</option>
                </select>
              </div>

              <div style={{ display: 'flex', gap: '10px', marginTop: '10px', justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => setIsTestEmailModalOpen(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="button button-primary"
                  disabled={testEmailMutation.isPending}
                >
                  {testEmailMutation.isPending ? 'Sending Test…' : 'Send Test Notification'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

    </div>
  )
}