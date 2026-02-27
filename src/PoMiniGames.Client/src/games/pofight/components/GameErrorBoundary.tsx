import { Component, ReactNode } from 'react';

interface Props {
    children: ReactNode;
    fallback?: ReactNode;
}

interface State {
    hasError: boolean;
    error: Error | null;
}

export class GameErrorBoundary extends Component<Props, State> {
    constructor(props: Props) {
        super(props);
        this.state = { hasError: false, error: null };
    }

    static getDerivedStateFromError(error: Error): State {
        return { hasError: true, error };
    }

    componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
        console.error('Game Error:', error);
        console.error('Component Stack:', errorInfo.componentStack);
    }

    handleRetry = () => {
        this.setState({ hasError: false, error: null });
        window.location.reload();
    };

    render() {
        if (this.state.hasError) {
            if (this.props.fallback) {
                return this.props.fallback;
            }

            return (
                <div className="flex flex-col items-center justify-center w-full h-full bg-zinc-900 text-white p-8">
                    <div className="max-w-md text-center">
                        <h1 className="text-4xl font-bold text-red-500 mb-4">
                            ⚠️ Game Error
                        </h1>
                        <p className="text-zinc-400 mb-6">
                            Something went wrong while loading the game.
                        </p>
                        <div className="bg-zinc-800 rounded-lg p-4 mb-6 text-left">
                            <code className="text-sm text-red-400 break-all">
                                {this.state.error?.message || 'Unknown error'}
                            </code>
                        </div>
                        <button
                            onClick={this.handleRetry}
                            className="px-6 py-3 bg-cyan-600 hover:bg-cyan-500 rounded-lg font-bold transition-colors"
                        >
                            🔄 Retry
                        </button>
                    </div>
                </div>
            );
        }

        return this.props.children;
    }
}
