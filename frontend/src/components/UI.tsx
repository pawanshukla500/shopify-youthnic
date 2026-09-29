import { createContext, useContext, useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { labelize, statusTone } from '../lib'

export type IconName =
  | 'grid'
  | 'box'
  | 'return'
  | 'route'
  | 'tool'
  | 'search'
  | 'plus'
  | 'arrow'
  | 'check'
  | 'alert'
  | 'refresh'
  | 'external'
  | 'chevron'
  | 'package'
  | 'shield'
  | 'close'
  | 'clock'
  | 'pin'
  | 'truck'
  | 'trending'
  | 'dollar'
  | 'users'
  | 'bell'
  | 'zap'
  | 'map'
  | 'creditCard'
  | 'download'
  | 'phone'
  | 'message'
  | 'copy'
  | 'tag'
  | 'settings'
  | 'database'
  | 'server'
  | 'key'
  | 'mail'

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  const paths: Record<IconName, ReactNode> = {
    mail: <><rect width="20" height="16" x="2" y="4" rx="2" /><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" /></>,
    grid: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
    box: <><path d="m21 8-9 5-9-5 9-5 9 5Z" /><path d="M3 8v8l9 5 9-5V8M12 13v8" /></>,
    return: <><path d="M9 14 4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 6 6v1" /></>,
    route: <><circle cx="6" cy="19" r="2" /><circle cx="18" cy="5" r="2" /><path d="M6 17v-3a4 4 0 0 1 4-4h4a4 4 0 0 0 4-4" /></>,
    tool: <><path d="m14.7 6.3 3-3a4.2 4.2 0 0 0 0 5.9L11 15.9l-3-3 6.7-6.6Z" /><path d="m6.2 17.8-2.1 2.1a1.5 1.5 0 0 0 2.1 2.1l2.1-2.1" /></>,
    search: <><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 5 5" /></>,
    plus: <><path d="M12 5v14M5 12h14" /></>,
    arrow: <><path d="M5 12h14M13 6l6 6-6 6" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    alert: <><path d="M10.3 3.7 2.5 18a2 2 0 0 0 1.8 3h15.4a2 2 0 0 0 1.8-3L13.7 3.7a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4M12 17h.01" /></>,
    refresh: <><path d="M20 11a8.1 8.1 0 0 0-14.7-4L3 10" /><path d="M3 5v5h5M4 13a8.1 8.1 0 0 0 14.7 4L21 14" /><path d="M21 19v-5h-5" /></>,
    external: <><path d="M14 3h7v7M10 14 21 3M19 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h6" /></>,
    chevron: <path d="m6 9 6 6 6-6" />,
    package: <><path d="m21 8-9 5-9-5 9-5 9 5Z" /><path d="M3 8v8l9 5 9-5V8M12 13v8" /><path d="m7 5 10 5" /></>,
    shield: <><path d="M12 3 4 6v5c0 5 3.4 8.6 8 10 4.6-1.4 8-5 8-10V6l-8-3Z" /><path d="m9 12 2 2 4-4" /></>,
    close: <><path d="M6 6l12 12M18 6 6 18" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    pin: <><path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z" /><circle cx="12" cy="10" r="2.5" /></>,
    truck: <><path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2" /><path d="M15 18H9" /><path d="M19 18h2a1 1 0 0 0 1-1v-5.2a2 2 0 0 0-.6-1.4l-3.2-3.2A2 2 0 0 0 16.8 6H14" /><circle cx="7" cy="18" r="2" /><circle cx="17" cy="18" r="2" /></>,
    trending: <><polyline points="22 7 13.5 15.5 8.5 10.5 2 17" /><polyline points="16 7 22 7 22 13" /></>,
    dollar: <><line x1="12" y1="1" x2="12" y2="23" /><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></>,
    users: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></>,
    bell: <><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></>,
    zap: <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />,
    map: <><polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21" /><line x1="9" y1="3" x2="9" y2="18" /><line x1="15" y1="6" x2="15" y2="21" /></>,
    creditCard: <><rect x="2" y="5" width="20" height="14" rx="2" /><line x1="2" y1="10" x2="22" y2="10" /></>,
    download: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></>,
    phone: <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />,
    message: <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />,
    copy: <><rect width="14" height="14" x="8" y="8" rx="2" ry="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" /></>,
    tag: <><path d="M12 2H2v10l9.29 9.29c.94.94 2.48.94 3.42 0l6.58-6.58c.94-.94.94-2.48 0-3.42L12 2Z" /><circle cx="7" cy="7" r="1.5" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" /></>,
    database: <><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5" /><path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3" /></>,
    server: <><rect width="20" height="8" x="2" y="2" rx="2" ry="2" /><rect width="20" height="8" x="2" y="14" rx="2" ry="2" /><line x1="6" x2="6.01" y1="6" y2="6" /><line x1="6" x2="6.01" y1="18" y2="18" /></>,
    key: <><circle cx="7.5" cy="15.5" r="5.5" /><path d="m21 2-9.6 9.6" /><path d="m15.5 7.5 3 3L22 7l-3-3" /></>,
  }
  return <svg aria-hidden="true" {...common}>{paths[name]}</svg>
}

export function Button({ className = '', loading = false, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean }) {
  return (
    <button className={`button ${className}`} disabled={loading || props.disabled} {...props}>
      {loading && <span className="spinner spinner-light" />}
      {children}
    </button>
  )
}

export function ButtonGroup({ children, className = '', style }: { children: ReactNode; className?: string; style?: React.CSSProperties }) {
  return <div className={`button-group ${className}`} style={style}>{children}</div>
}

export function StatusBadge({ status, label }: { status: string | null | undefined; label?: string }) {
  return <span className={`status-badge ${statusTone(status)}`}><span className="status-dot" />{label ?? labelize(status)}</span>
}

export function Panel({ children, className = '', style }: { children: ReactNode; className?: string; style?: React.CSSProperties }) {
  return <section className={`panel ${className}`} style={style}>{children}</section>
}


export function PanelHeading({ eyebrow, title, action }: { eyebrow?: string; title: ReactNode; action?: ReactNode }) {
  return (
    <div className="panel-heading">
      <div>
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h2 className="panel-title">{title}</h2>
      </div>
      {action}
    </div>
  )
}

export function EmptyState({ title, description, icon = 'box' }: { title: string; description?: string; icon?: IconName }) {
  return <div className="empty-state"><div className="empty-icon"><Icon name={icon} size={24} /></div><h3>{title}</h3>{description && <p>{description}</p>}</div>
}

export function LoadingState({ label = 'Loading data…' }: { label?: string }) {
  return <div className="loading-state"><span className="spinner" />{label}</div>
}

export function ErrorBox({ message, compact = false }: { message: string; compact?: boolean }) {
  return <div className={`error-box ${compact ? 'error-box-compact' : ''}`}><Icon name="alert" size={18} /><span>{message}</span></div>
}

type Toast = { id: number; kind: 'success' | 'error'; message: string }
const ToastContext = createContext<{ toast: (kind: Toast['kind'], message: string) => void } | null>(null)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const toast = (kind: Toast['kind'], message: string) => {
    const id = Date.now() + Math.random()
    setToasts((current) => [...current, { id, kind, message }])
    window.setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), 4200)
  }
  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="toast-stack" aria-live="polite">
        {toasts.map((item) => <div className={`toast toast-${item.kind}`} key={item.id}><Icon name={item.kind === 'success' ? 'check' : 'alert'} size={17} /><span>{item.message}</span><button aria-label="Dismiss" onClick={() => setToasts((current) => current.filter((toast) => toast.id !== item.id))}><Icon name="close" size={14} /></button></div>)}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  const value = useContext(ToastContext)
  if (!value) throw new Error('useToast must be used inside ToastProvider')
  return value
}

export function FormField({ label, hint, children, className = '' }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return <label className={`form-field ${className}`}><span className="field-label">{label}</span>{children}{hint && <span className="field-hint">{hint}</span>}</label>
}

export function PageIntro({ eyebrow, title, description, action, children }: { eyebrow?: string; title: string; description?: string; action?: ReactNode; children?: ReactNode }) {
  return <div className="page-intro"><div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h1>{title}</h1>{description && <p className="page-description">{description}</p>}</div>{children ?? action}</div>
}

export function useDocumentTitle(title: string) {
  useEffect(() => { document.title = `${title} · Youthnic OMS` }, [title])
}

// ─── 21st.dev Inspired UI/UX Design Pro Primitives ──────────────────────────

export function InfoCard({
  children,
  className = '',
  style,
  hoverable = false,
}: {
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
  hoverable?: boolean;
}) {
  return (
    <div
      className={`info-card-pro ${hoverable ? 'hoverable' : ''} ${className}`}
      style={style}
    >
      {children}
    </div>
  );
}

export function StatCard({
  title,
  value,
  subtext,
  icon,
  trend,
  accentColor = '#2563eb',
  className = '',
  onClick,
}: {
  title: string;
  value: ReactNode;
  subtext?: string;
  icon?: IconName;
  trend?: { value: string; isPositive: boolean };
  accentColor?: string;
  className?: string;
  onClick?: () => void;
}) {
  return (
    <div
      className={`stat-card-pro ${onClick ? 'clickable' : ''} ${className}`}
      onClick={onClick}
      style={{ '--stat-accent': accentColor } as React.CSSProperties}
    >
      <div className="stat-card-top">
        <span className="stat-card-title">{title}</span>
        {icon && (
          <div className="stat-card-icon-wrap" style={{ color: accentColor, background: `${accentColor}14` }}>
            <Icon name={icon} size={15} />
          </div>
        )}
      </div>
      <div className="stat-card-value">{value}</div>
      {(subtext || trend) && (
        <div className="stat-card-footer">
          {trend && (
            <span className={`stat-card-trend ${trend.isPositive ? 'trend-up' : 'trend-down'}`}>
              <Icon name={trend.isPositive ? 'trending' : 'arrow'} size={12} />
              {trend.value}
            </span>
          )}
          {subtext && <span className="stat-card-subtext">{subtext}</span>}
        </div>
      )}
    </div>
  );
}

export function CopyableBadge({
  text,
  label,
  monospace = true,
  className = '',
}: {
  text: string;
  label?: string;
  monospace?: boolean;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      type="button"
      className={`copyable-badge-pro ${copied ? 'copied' : ''} ${className}`}
      onClick={handleCopy}
      title="Click to copy to clipboard"
    >
      {label && <span className="copyable-badge-label">{label}:</span>}
      <span className={`copyable-badge-text ${monospace ? 'mono' : ''}`}>{text}</span>
      <span className="copyable-badge-icon">
        <Icon name={copied ? 'check' : 'copy'} size={12} />
      </span>
      {copied && <span className="copyable-badge-tooltip">Copied!</span>}
    </button>
  );
}

export interface StepperStep {
  id: string;
  title: string;
  description?: string;
  timestamp?: string;
}

export function ProgressStepperPro({
  steps,
  currentStepIndex,
  isError = false,
  errorReason,
  className = '',
}: {
  steps: StepperStep[];
  currentStepIndex: number;
  isError?: boolean;
  errorReason?: string;
  className?: string;
}) {
  const progressPercent = Math.max(0, Math.min(100, (currentStepIndex / Math.max(1, steps.length - 1)) * 100));

  return (
    <div className={`progress-stepper-pro ${className}`}>
      <div className="stepper-track-wrap">
        <div className="stepper-track-bg" />
        <div
          className={`stepper-track-fill ${isError ? 'track-error' : ''}`}
          style={{ width: `${progressPercent}%` }}
        />
        <div className="stepper-steps-row">
          {steps.map((step, idx) => {
            const isCompleted = idx < currentStepIndex;
            const isCurrent = idx === currentStepIndex;

            return (
              <div
                key={step.id}
                className={`stepper-step-node ${
                  isCompleted
                    ? 'completed'
                    : isCurrent
                    ? isError
                      ? 'error'
                      : 'active'
                    : 'pending'
                }`}
              >
                <div className="stepper-node-circle">
                  {isCompleted ? (
                    <Icon name="check" size={12} />
                  ) : isCurrent ? (
                    <span className="stepper-node-pulse" />
                  ) : (
                    <span>{idx + 1}</span>
                  )}
                </div>
                <div className="stepper-node-info">
                  <span className="stepper-node-title">{step.title}</span>
                  {step.description && <span className="stepper-node-desc">{step.description}</span>}
                  {step.timestamp && <span className="stepper-node-time">{step.timestamp}</span>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {isError && errorReason && (
        <div className="stepper-error-banner">
          <Icon name="alert" size={14} />
          <span>{errorReason}</span>
        </div>
      )}
    </div>
  );
}

