'use client';

import React, { Component, ErrorInfo, ReactNode } from 'react';
import type { Firestore } from 'firebase/firestore';
import { logError } from '@/lib/error-logger';
import { getGlobalFirestore } from './GlobalErrorHandler';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  firestore?: Firestore;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
  }

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      error,
      errorInfo: null,
    };
  }

  async componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // Log error to Firestore if available (use global reference or prop)
    const firestore = this.props.firestore || getGlobalFirestore();
    if (firestore) {
      try {
        await logError(error, firestore, {
          page: typeof window !== 'undefined' ? window.location.pathname : 'unknown',
          action: 'error_boundary',
          componentStack: errorInfo.componentStack,
        });
      } catch (loggingError) {
        // Silently fail - don't break error boundary
        console.error('Failed to log error to Firestore:', loggingError);
      }
    }

    this.setState({
      error,
      errorInfo,
    });

    // Log to console in development
    if (process.env.NODE_ENV === 'development') {
      console.error('ErrorBoundary caught an error:', error, errorInfo);
    }
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="flex min-h-screen items-center justify-center bg-background p-4">
          <Card className="w-full max-w-md">
            <CardHeader>
              <div className="flex items-center gap-2 text-destructive">
                <AlertTriangle className="h-5 w-5" />
                <CardTitle>Something went wrong</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                We're sorry, but something unexpected happened. The error has been logged and we'll look into it.
              </p>
              
              {process.env.NODE_ENV === 'development' && this.state.error && (
                <div className="rounded-md bg-muted p-3">
                  <p className="text-xs font-mono text-destructive">
                    {this.state.error.toString()}
                  </p>
                  {this.state.errorInfo?.componentStack && (
                    <pre className="mt-2 max-h-40 overflow-auto text-xs">
                      {this.state.errorInfo.componentStack}
                    </pre>
                  )}
                </div>
              )}

              <div className="flex gap-2">
                <Button
                  onClick={() => {
                    this.setState({
                      hasError: false,
                      error: null,
                      errorInfo: null,
                    });
                    if (typeof window !== 'undefined') {
                      window.location.reload();
                    }
                  }}
                  className="w-full"
                >
                  Reload Page
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    if (typeof window !== 'undefined') {
                      window.location.href = '/home';
                    }
                  }}
                  className="w-full"
                >
                  Go to Home
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      );
    }

    return this.props.children;
  }
}

/**
 * Hook-based Error Boundary wrapper that provides Firestore for error logging
 */
export function ErrorBoundaryWithLogging({ children }: { children: ReactNode }) {
  // We can't use hooks in ErrorBoundary, so we'll get firestore from a global context
  // The GlobalErrorHandler will handle logging via its own hook access
  return <ErrorBoundary>{children}</ErrorBoundary>;
}