import { Component, type ReactNode, type ErrorInfo } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
  children: ReactNode;
  /** Optional label shown in the error card (e.g. "Connect Five") */
  gameName?: string;
}

interface State {
  hasError: boolean;
  message: string;
}

/**
 * Catches errors thrown by lazy-loaded game chunks (e.g. chunk load failures
 * when the backend is offline) and shows a friendly recovery UI instead of a
 * blank screen.
 */
export class GameErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: unknown): State {
    const message =
      error instanceof Error ? error.message : 'An unexpected error occurred.';
    return { hasError: true, message };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[GameErrorBoundary]', error, info.componentStack);
  }

  handleRetry = () => {
    this.setState({ hasError: false, message: '' });
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '60vh',
          gap: '1rem',
          color: 'var(--color-text-secondary, #aaa)',
          padding: '2rem',
          textAlign: 'center',
        }}
      >
        <AlertTriangle size={40} color="var(--color-warning, #f59e0b)" />
        <h2 style={{ color: 'var(--color-text-primary, #fff)', margin: 0, fontSize: '1.25rem' }}>
          {this.props.gameName ? `Could not load ${this.props.gameName}` : 'Could not load game'}
        </h2>
        <p style={{ margin: 0, fontSize: '0.875rem', maxWidth: 360 }}>
          {this.state.message.includes('fetch') || this.state.message.includes('network')
            ? 'The game bundle could not be downloaded. Check your connection and try again.'
            : this.state.message}
        </p>
        <button
          onClick={this.handleRetry}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            padding: '0.5rem 1.25rem',
            borderRadius: '9999px',
            border: '1px solid var(--color-border, #333)',
            background: 'transparent',
            color: 'var(--color-text-primary, #fff)',
            cursor: 'pointer',
            fontSize: '0.875rem',
          }}
        >
          <RefreshCw size={14} />
          Try again
        </button>
      </div>
    );
  }
}
