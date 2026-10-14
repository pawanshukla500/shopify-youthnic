import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button, ErrorBox } from './UI'

interface Props {
  children: ReactNode
  fallbackTitle?: string
}

interface State {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught error:', error, errorInfo)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '24px', maxWidth: '800px', margin: '30px auto' }}>
          <div
            style={{
              background: 'var(--panel, #ffffff)',
              border: '1px solid var(--line, #e2e8f0)',
              borderRadius: '10px',
              padding: '24px',
              boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.08)',
            }}
          >
            <h3 style={{ margin: '0 0 12px', fontSize: '18px', color: '#dc2626' }}>
              {this.props.fallbackTitle || 'Unable to display this view'}
            </h3>
            <p style={{ margin: '0 0 14px', fontSize: '13px', color: 'var(--muted, #64748b)' }}>
              A rendering issue was prevented from crashing the whole console. You can reload or return to the main dashboard.
            </p>
            <ErrorBox message={this.state.error?.message || 'Unknown component rendering error'} />
            <div style={{ marginTop: '16px', display: 'flex', gap: '10px' }}>
              <Button
                className="button-primary"
                onClick={() => {
                  this.setState({ hasError: false, error: null })
                  window.location.reload()
                }}
              >
                Reload
              </Button>
              <Button
                className="button-secondary"
                onClick={() => {
                  window.location.href = '/'
                }}
              >
                Return to Dashboard
              </Button>
            </div>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
