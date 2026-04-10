import { Component, type ErrorInfo, type ReactNode } from 'react'

type Props = {
  children: ReactNode
  /** Optional label shown in the fallback UI, e.g. "EC2 Console" */
  label?: string
  /** Optional custom fallback element */
  fallback?: ReactNode
}

type State = {
  error: Error | null
}

/**
 * Catches render errors in a subtree and shows a fallback UI instead of
 * crashing the whole app. Wrap major console components with this.
 *
 * Usage:
 *   <ErrorBoundary label="EC2 Console">
 *     <Ec2Console ... />
 *   </ErrorBoundary>
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Log to console so it shows up in DevTools / Electron logs
    console.error(`[ErrorBoundary] ${this.props.label ?? 'Component'} crashed:`, error, info.componentStack)
  }

  handleReset = (): void => {
    this.setState({ error: null })
  }

  render(): ReactNode {
    if (this.state.error) {
      if (this.props.fallback) {
        return this.props.fallback
      }

      return (
        <div className="error-boundary-fallback">
          <div className="error-boundary-icon">⚠</div>
          <div className="error-boundary-title">
            {this.props.label ? `${this.props.label} failed to render` : 'Something went wrong'}
          </div>
          <div className="error-boundary-message">
            {this.state.error.message}
          </div>
          <button className="error-boundary-retry" onClick={this.handleReset}>
            Try again
          </button>
        </div>
      )
    }

    return this.props.children
  }
}
