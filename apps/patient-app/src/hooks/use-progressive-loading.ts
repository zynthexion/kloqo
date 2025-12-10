/**
 * Progressive Loading Hook
 * 
 * Enables immediate rendering of page structure while data loads progressively.
 * This hook manages loading states in a way that allows components to show
 * their layout immediately and hydrate with data as it becomes available.
 */

import { useState, useEffect, useRef } from 'react';

export interface ProgressiveLoadingState<T> {
  /** Data that's currently available (may be cached or partial) */
  data: T | null;
  /** Whether we're currently loading fresh data */
  isLoading: boolean;
  /** Whether we have any data at all (cached or fresh) */
  hasData: boolean;
  /** Error state if loading failed */
  error: Error | null;
}

export interface ProgressiveLoadingOptions {
  /** Initial data to show immediately (e.g., from cache) */
  initialData?: any;
  /** Whether to show loading state if we have cached data */
  showLoadingWithCache?: boolean;
}

/**
 * Hook for progressive data loading - shows cached data immediately while fetching fresh data
 * 
 * @example
 * ```tsx
 * const { data, isLoading, hasData } = useProgressiveLoading(() => 
 *   fetch('/api/data').then(r => r.json()),
 *   { initialData: cachedData }
 * );
 * 
 * // Render structure immediately
 * return (
 *   <div>
 *     {hasData ? <Content data={data} /> : <Skeleton />}
 *     {isLoading && <LoadingIndicator />}
 *   </div>
 * );
 * ```
 */
export function useProgressiveLoading<T>(
  fetchFn: () => Promise<T>,
  options: ProgressiveLoadingOptions = {}
): ProgressiveLoadingState<T> {
  const { initialData = null, showLoadingWithCache = false } = options;
  const [data, setData] = useState<T | null>(initialData);
  const [isLoading, setIsLoading] = useState(!initialData);
  const [error, setError] = useState<Error | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    
    // If we have initial data, still fetch in background but don't show loading
    if (initialData && !showLoadingWithCache) {
      fetchFn()
        .then((freshData) => {
          if (mountedRef.current) {
            setData(freshData);
            setIsLoading(false);
          }
        })
        .catch((err) => {
          if (mountedRef.current) {
            setError(err);
            setIsLoading(false);
          }
        });
      return;
    }

    // Normal loading flow
    setIsLoading(true);
    setError(null);
    
    fetchFn()
      .then((result) => {
        if (mountedRef.current) {
          setData(result);
          setIsLoading(false);
        }
      })
      .catch((err) => {
        if (mountedRef.current) {
          setError(err);
          setIsLoading(false);
        }
      });

    return () => {
      mountedRef.current = false;
    };
  }, [fetchFn, initialData, showLoadingWithCache]);

  return {
    data,
    isLoading,
    hasData: data !== null,
    error,
  };
}

/**
 * Higher-order component that wraps a component with progressive loading
 * Shows the component structure immediately, then hydrates with data
 * 
 * Note: This HOC is provided as a TypeScript utility. 
 * For actual usage, create a wrapper component in a .tsx file.
 */
export type WithProgressiveLoadingProps<T> = T & {
  data?: any;
  isLoading?: boolean;
};

