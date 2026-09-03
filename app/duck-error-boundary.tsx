'use client';

import * as React from 'react';

// Catches render-time errors from the example output (including rejections in
// nested async children React resolves after run() returned). Mirrors
// app/alizarin-error-boundary.tsx.
export default class DuckErrorBoundary extends React.Component<
  { children: React.ReactNode; resetKey?: unknown },
  { error: Error | null }
> {
  constructor(props: { children: React.ReactNode; resetKey?: unknown }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidUpdate(prev: { resetKey?: unknown }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      return <div className="alizarin-error">Error while rendering: {this.state.error.message}</div>;
    }
    return this.props.children;
  }
}
