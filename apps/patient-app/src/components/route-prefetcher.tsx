'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useUser } from '@/firebase/auth/use-user';

const ROUTES_TO_PREFETCH = [
  '/home',
  '/appointments',
  '/consult-today',
  '/profile',
  '/book-appointment',
  '/live-token',
];

/**
 * Prefetches high-traffic routes once the user is authenticated.
 * Runs during idle time so it doesn't block the initial render.
 */
export function RoutePrefetcher() {
  const router = useRouter();
  const { user } = useUser();
  const hasPrefetched = useRef(false);

  useEffect(() => {
    if (!user || hasPrefetched.current) {
      return;
    }

    hasPrefetched.current = true;

    const prefetchRoutes = () => {
      ROUTES_TO_PREFETCH.forEach((route) => {
        try {
          const result = router.prefetch(route) as any;
          // Next.js returns void/Promise depending on environment
          if (result && typeof result === 'object' && typeof result.catch === 'function') {
            result.catch(() => {
              // Ignore failures (e.g., dev mode or route not generated yet)
            });
          }
        } catch {
          // Ignore prefetch errors
        }
      });
    };

    if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
      const idleId = (window as any).requestIdleCallback(prefetchRoutes, { timeout: 2000 });
      return () => {
        if ('cancelIdleCallback' in window) {
          (window as any).cancelIdleCallback(idleId);
        }
      };
    } else {
      const timer = setTimeout(prefetchRoutes, 1500);
      return () => clearTimeout(timer);
    }
  }, [user, router]);

  return null;
}

