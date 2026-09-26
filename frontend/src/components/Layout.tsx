import { useState, type FormEvent } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { getHealth, getOrders, apiError } from '../api'
import { useAuth } from '../context/AuthContext'
import { useTheme } from '../context/ThemeContext'
import { Icon, ErrorBox, type IconName } from './UI'

interface NavItem {
  to: string
  label: string
  icon: IconName
  end?: boolean
  hasPendingBadge?: boolean
}

const operationsNav: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: 'grid', end: true },
  { to: '/orders', label: 'Orders', icon: 'box', hasPendingBadge: true },
  { to: '/products', label: 'Products & Listings', icon: 'package' },
  { to: '/support', label: 'Support & Returns Desk', icon: 'shield' },
  { to: '/communications', label: 'Communications & Emails', icon: 'mail' },
  { to: '/analytics', label: 'Reports & Analytics', icon: 'grid' },
  { to: '/returns', label: 'Returns & Reverse', icon: 'return' },
  { to: '/tracking', label: 'AWB Tracking', icon: 'route' },
]

const financeNav: NavItem[] = [
  { to: '/ledger', label: 'Delhivery Wallet & Ledger', icon: 'creditCard' },
  { to: '/tools', label: 'Rate & Serviceability', icon: 'tool' },
]

const adminNav: NavItem[] = [
  { to: '/settings', label: 'Settings & Integrations', icon: 'settings' },
]

export function Layout() {
  const location = useLocation()
  const navigate = useNavigate()
  const { user, logout } = useAuth()
  const { theme, toggleTheme } = useTheme()
  const [quickSearch, setQuickSearch] = useState('')

  const health = useQuery({ queryKey: ['health'], queryFn: getHealth, retry: false, refetchInterval: 30_000 })
  const pendingOrdersQuery = useQuery({
    queryKey: ['pending-count'],
    queryFn: () => getOrders({ status: 'NEW' }),
    refetchInterval: 30_000,
    retry: false,
  })

  const pendingCount = pendingOrdersQuery.data?.length ?? 0

  const handleQuickSearch = (e: FormEvent) => {
    e.preventDefault()
    if (!quickSearch.trim()) return
    navigate(`/orders?search=${encodeURIComponent(quickSearch.trim())}`)
    setQuickSearch('')
  }

  const handleLogout = () => {
    logout()
    navigate('/login')
  }

  const allNav = [...operationsNav, ...financeNav, ...adminNav]
  const current = allNav.find((item) => (item.end ? location.pathname === item.to : location.pathname.startsWith(item.to)))

  return (
    <div className={`app-shell theme-${theme}`}>
      <aside className="sidebar">
        {/* Brand Header with 3D Youthnic Logo */}
        <div className="brand">
          <div className="brand-logo-wrap">
            <img
              src="/logos/youthnic-bag.png"
              alt="Youthnic"
              className="brand-logo-img"
            />
          </div>
          <div className="brand-text">
            <strong>Youthnic OMS</strong>
            <span>Logistics & Fulfillment</span>
          </div>
          <span className="brand-badge live">V2.0</span>
        </div>

        {/* Quick Search Jump */}
        <form className="sidebar-search-box" onSubmit={handleQuickSearch}>
          <span className="sidebar-search-icon">
            <Icon name="search" size={14} />
          </span>
          <input
            className="sidebar-search-input"
            placeholder="Search order or AWB…"
            value={quickSearch}
            onChange={(e) => setQuickSearch(e.target.value)}
          />
        </form>

        {/* Section 1: Operations */}
        <div className="nav-label">Operations & Fulfillment</div>
        <nav className="sidebar-nav" aria-label="Operations navigation">
          {operationsNav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
            >
              <Icon name={item.icon} size={17} />
              <span>{item.label}</span>
              {item.hasPendingBadge && pendingCount > 0 && (
                <span className="nav-badge-pill" title={`${pendingCount} orders pending dispatch`}>
                  {pendingCount}
                </span>
              )}
            </NavLink>
          ))}
        </nav>

        {/* Section 2: Carrier & Finance */}
        <div className="nav-label" style={{ marginTop: '14px' }}>Logistics & Finance</div>
        <nav className="sidebar-nav" aria-label="Finance navigation">
          {financeNav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
            >
              <Icon name={item.icon} size={17} />
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>

        {/* Section 3: Admin & System */}
        <div className="nav-label" style={{ marginTop: '14px' }}>System Admin</div>
        <nav className="sidebar-nav" aria-label="Administration navigation">
          {adminNav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
            >
              <Icon name={item.icon} size={17} />
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>

        {/* Sidebar Footer with Theme & User Card */}
        <div className="sidebar-footer">
          {/* Quick Theme Switcher Pill in Sidebar */}
          <div className="sidebar-theme-switch" onClick={toggleTheme} title={`Click to switch to ${theme === 'light' ? 'Dark' : 'Light'} Mode`}>
            <span className="sidebar-theme-label">Interface Mode</span>
            <button type="button" className="btn-theme-pill">
              {theme === 'light' ? '☀️ Light' : '🌙 Dark'}
            </button>
          </div>

          <div className="user-profile-card">
            <div className="user-profile-info">
              <div className="user-profile-avatar" title={user?.email || 'Operator'}>
                {user?.avatar || 'YN'}
              </div>
              <div style={{ overflow: 'hidden' }}>
                <div className="user-profile-name">{user?.name || 'Operations Lead'}</div>
                <div className="user-profile-role">{user?.role || 'Surat Hub'}</div>
              </div>
            </div>
            <button
              type="button"
              className="btn-signout"
              onClick={handleLogout}
              title="Sign out of console"
            >
              Sign out
            </button>
          </div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumb">
            <span>Youthnic</span>
            <span className="breadcrumb-slash">/</span>
            <strong>{current?.label ?? 'Console'}</strong>
          </div>
          <div className="topbar-actions">
            {/* Topbar Theme Toggle */}
            <button
              type="button"
              className="theme-toggle-topbar"
              onClick={toggleTheme}
              title={`Switch to ${theme === 'light' ? 'Dark' : 'Light'} Theme`}
            >
              {theme === 'light' ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                  <span>🌙</span>
                  <span style={{ fontSize: '11px', fontWeight: 700 }}>Dark</span>
                </span>
              ) : (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                  <span>☀️</span>
                  <span style={{ fontSize: '11px', fontWeight: 700 }}>Light</span>
                </span>
              )}
            </button>

            <div style={{ fontSize: '11px', color: '#64748b', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Icon name="clock" size={13} />
              <span>{new Date().toLocaleDateString('en-IN', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
            </div>
          </div>
        </header>

        {health.isError && (
          <div className="offline-banner">
            <Icon name="alert" size={19} />
            <div>
              <strong>API server unavailable</strong>
              <span>Start the backend with <code>node dist/index.js</code> on port 3000, then refresh.</span>
            </div>
          </div>
        )}
        {health.isError && health.failureCount > 0 && (
          <div className="sr-only">
            <ErrorBox message={apiError(health.error)} />
          </div>
        )}
        <div className="page-content">
          <Outlet />
        </div>
      </main>
    </div>
  )
}

