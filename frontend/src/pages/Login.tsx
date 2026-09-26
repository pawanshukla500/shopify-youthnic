import { useState, type FormEvent } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useTheme } from '../context/ThemeContext'
import { Icon, useDocumentTitle } from '../components/UI'

export function Login() {
  useDocumentTitle('Youthnic · Sign In')
  const { login, register, loginWithGoogle, resetPassword } = useAuth()
  const { theme, toggleTheme } = useTheme()
  const navigate = useNavigate()
  const location = useLocation()

  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('returnorders@vbexports.co.in')
  const [password, setPassword] = useState('Xchange4SHOPIFY$')
  const [showPassword, setShowPassword] = useState(false)
  const [rememberMe, setRememberMe] = useState(true)
  const [loading, setLoading] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const redirectPath = (location.state as any)?.from?.pathname || '/'

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!email.trim()) {
      setError('Please enter your work email address.')
      return
    }
    setLoading(true)
    setError(null)
    setNotice(null)
    try {
      if (mode === 'signup') {
        if (!password || password.length < 6) {
          throw new Error('Password must be at least 6 characters.')
        }
        await register(email, password, name)
      } else {
        await login(email, password)
      }
      navigate(redirectPath, { replace: true })
    } catch (err: any) {
      setError(err?.message || 'Authentication failed. Please verify credentials.')
    } finally {
      setLoading(false)
    }
  }

  const handleGoogleLogin = async () => {
    setLoading(true)
    setError(null)
    setNotice(null)
    try {
      await loginWithGoogle()
      navigate(redirectPath, { replace: true })
    } catch (err: any) {
      setError(err?.message || 'Google sign-in was cancelled or failed.')
    } finally {
      setLoading(false)
    }
  }

  const handleForgotPassword = async () => {
    if (!email.trim()) {
      setError('Please enter your email address in the field above to receive a reset link.')
      return
    }
    setResetting(true)
    setError(null)
    setNotice(null)
    try {
      await resetPassword(email)
      setNotice(`Password reset link sent to ${email.trim()}. Please check your inbox.`)
    } catch (err: any) {
      setError(err?.message || 'Failed to send password reset email.')
    } finally {
      setResetting(false)
    }
  }

  return (
    <div className={`login-minimal-viewport theme-${theme}`}>
      {/* Floating Theme Switcher */}
      <div className="login-theme-bar">
        <button
          type="button"
          className="login-theme-toggle-btn"
          onClick={toggleTheme}
          title={`Switch to ${theme === 'light' ? 'Dark' : 'Light'} Mode`}
        >
          {theme === 'light' ? (
            <>
              <span className="theme-toggle-icon">🌙</span>
              <span>Dark Mode</span>
            </>
          ) : (
            <>
              <span className="theme-toggle-icon">☀️</span>
              <span>Light Mode</span>
            </>
          )}
        </button>
      </div>

      {/* Subtle Ambient Radial Glow */}
      <div className="login-ambient-mesh" />

      {/* Central Minimalist Card */}
      <div className="login-minimal-card">
        {/* Brand Header */}
        <div className="login-minimal-brand">
          <div className="login-brand-squircle">
            <img
              src="/logos/youthnic-bag.png"
              alt="Youthnic"
              className="login-brand-logo-img"
            />
          </div>
          <div className="login-brand-meta">
            <h1 className="login-brand-name">YOUTHNIC</h1>
            <span className="login-brand-badge">Surat Operations Hub</span>
          </div>
        </div>

        {/* Title & Subtitle */}
        <div className="login-header-group">
          <h2 className="login-main-title">
            {mode === 'signin' ? 'Welcome back' : 'Create Account'}
          </h2>
          <p className="login-sub-title">
            {mode === 'signin'
              ? 'Sign in to access your operations dashboard'
              : 'Register your operator credentials with Firebase'}
          </p>
        </div>

        {/* Mode Segmented Switcher */}
        <div className="login-segmented-control">
          <button
            type="button"
            className={`login-segment-tab ${mode === 'signin' ? 'active' : ''}`}
            onClick={() => {
              setMode('signin')
              setError(null)
              setNotice(null)
            }}
          >
            Sign In
          </button>
          <button
            type="button"
            className={`login-segment-tab ${mode === 'signup' ? 'active' : ''}`}
            onClick={() => {
              setMode('signup')
              setError(null)
              setNotice(null)
            }}
          >
            Create Account
          </button>
        </div>

        {/* Google SSO Button */}
        <button
          type="button"
          onClick={handleGoogleLogin}
          disabled={loading}
          className="login-google-btn"
        >
          <svg className="google-icon" viewBox="0 0 24 24" width="18" height="18">
            <path
              fill="#4285F4"
              d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.8-2.4 3.66v3.04h3.88c2.27-2.09 3.665-5.17 3.665-9.14z"
            />
            <path
              fill="#34A853"
              d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.04c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.1-6.72-4.93H1.24v3.13C3.26 21.36 7.33 24 12 24z"
            />
            <path
              fill="#FBBC05"
              d="M5.28 14.28c-.25-.72-.38-1.49-.38-2.28s.13-1.56.38-2.28V6.59H1.24C.45 8.16 0 9.99 0 12s.45 3.84 1.24 5.41l4.04-3.13z"
            />
            <path
              fill="#EA4335"
              d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.33 0 3.26 2.64 1.24 6.59l4.04 3.13c.95-2.83 3.6-4.97 6.72-4.97z"
            />
          </svg>
          <span>Continue with Google</span>
        </button>

        {/* Minimal Divider */}
        <div className="login-divider-row">
          <span className="divider-line" />
          <span className="divider-label">or email</span>
          <span className="divider-line" />
        </div>

        {/* Error Alert */}
        {error && (
          <div className="login-alert-box error">
            <Icon name="alert" size={15} />
            <span>{error}</span>
          </div>
        )}

        {/* Success Notice */}
        {notice && (
          <div className="login-alert-box success">
            <Icon name="check" size={15} />
            <span>{notice}</span>
          </div>
        )}

        {/* Form Inputs */}
        <form onSubmit={handleSubmit} className="login-minimal-form">
          {mode === 'signup' && (
            <div className="login-field-group">
              <label htmlFor="name" className="login-field-label">
                Full Name
              </label>
              <div className="login-input-box">
                <Icon name="users" size={15} />
                <input
                  id="name"
                  type="text"
                  placeholder="Pawan Shukla"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </div>
            </div>
          )}

          <div className="login-field-group">
            <label htmlFor="email" className="login-field-label">
              Work Email
            </label>
            <div className="login-input-box">
              <Icon name="pin" size={15} />
              <input
                id="email"
                type="email"
                placeholder="returnorders@vbexports.co.in"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                required
              />
            </div>
          </div>

          <div className="login-field-group">
            <div className="login-label-split">
              <label htmlFor="password" className="login-field-label">
                Password
              </label>
              {mode === 'signin' && (
                <button
                  type="button"
                  onClick={handleForgotPassword}
                  disabled={resetting}
                  className="login-forgot-link"
                >
                  {resetting ? 'Sending link...' : 'Forgot password?'}
                </button>
              )}
            </div>
            <div className="login-input-box">
              <Icon name="shield" size={15} />
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                placeholder={mode === 'signup' ? 'At least 6 characters' : '••••••••••••'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                required
              />
              <button
                type="button"
                className="login-eye-toggle"
                onClick={() => setShowPassword(!showPassword)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                <Icon name={showPassword ? 'close' : 'check'} size={14} />
              </button>
            </div>
          </div>

          {mode === 'signin' && (
            <div className="login-remember-row">
              <label className="login-remember-label">
                <input
                  type="checkbox"
                  checked={rememberMe}
                  onChange={(e) => setRememberMe(e.target.checked)}
                />
                <span>Remember this terminal</span>
              </label>
            </div>
          )}

          <button
            type="submit"
            className="login-primary-submit-btn"
            disabled={loading}
          >
            {loading ? (
              <span className="login-btn-loading">
                <span className="spinner spinner-light" />
                <span>Authenticating...</span>
              </span>
            ) : (
              <span>{mode === 'signin' ? 'Sign In' : 'Create Account'}</span>
            )}
          </button>
        </form>

        {/* Minimal Footer */}
        <div className="login-bottom-toggle">
          {mode === 'signin' ? (
            <p>
              Don't have an account?{' '}
              <button
                type="button"
                onClick={() => {
                  setMode('signup')
                  setError(null)
                  setNotice(null)
                }}
                className="login-toggle-link"
              >
                Sign up
              </button>
            </p>
          ) : (
            <p>
              Already have an account?{' '}
              <button
                type="button"
                onClick={() => {
                  setMode('signin')
                  setError(null)
                  setNotice(null)
                }}
                className="login-toggle-link"
              >
                Sign in
              </button>
            </p>
          )}
        </div>

        <div className="login-security-tag">
          <Icon name="shield" size={13} />
          <span>Protected by Firebase Authentication · TLS 1.3</span>
        </div>
      </div>
    </div>
  )
}
