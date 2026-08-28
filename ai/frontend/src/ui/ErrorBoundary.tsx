// Error boundary — catches render errors and shows a fallback UI

import { Component } from 'react'
import type { ReactNode, ErrorInfo } from 'react'
import { theme } from '../core/theme'

interface Props {
  children: ReactNode
  fallback?: ReactNode
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error.message, info.componentStack?.slice(0, 300))
  }

  render() {
    if (this.state.error) {
      return this.props.fallback || (
        <div style={styles.container}>
          <div style={styles.icon}>⚠</div>
          <div style={styles.title}>Something went wrong</div>
          <div style={styles.message}>{this.state.error.message}</div>
          <button
            type="button"
            style={styles.retry}
            onClick={() => this.setState({ error: null })}
          >
            Try again
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    gap: 12,
    color: theme.colors.text.primary,
    padding: 24,
  },
  icon: { fontSize: '2rem' },
  title: { fontSize: '1.1rem', fontWeight: 600 },
  message: { fontSize: '0.85rem', color: theme.colors.text.secondary, maxWidth: 320, textAlign: 'center', wordBreak: 'break-word' },
  retry: {
    marginTop: 8,
    padding: '6px 16px',
    borderRadius: theme.radius.sm,
    border: `1px solid ${theme.colors.border}`,
    backgroundColor: theme.colors.bg.panel,
    color: theme.colors.text.primary,
    cursor: 'pointer',
    fontSize: '0.85rem',
  },
}
