'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallbackTitle?: string;
}

interface State {
  error: Error | null;
}

/** Keeps the SPA shell alive when a page/card tree throws. */
export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[AppErrorBoundary]', error, info.componentStack);
  }

  private handleRetry = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      return (
        <div className="mx-auto flex min-h-[40vh] max-w-lg flex-col items-center justify-center gap-3 px-4 text-center">
          <p className="text-sm font-medium text-zinc-200">
            {this.props.fallbackTitle || '页面出错了'}
          </p>
          <p className="max-w-md break-words text-xs text-zinc-500">
            {this.state.error.message || '未知错误'}
          </p>
          <button
            type="button"
            onClick={this.handleRetry}
            className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800"
          >
            重试
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
