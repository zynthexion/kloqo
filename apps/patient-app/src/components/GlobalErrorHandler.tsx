'use client';

import { useEffect } from 'react';
import { useFirebase } from '@/firebase/provider';
import { useUser } from '@/firebase/auth/use-user';
import { logError } from '@/lib/error-logger';
import { usePathname } from 'next/navigation';
import type { Firestore } from 'firebase/firestore';

// Store firestore reference globally for ErrorBoundary to use
let globalFirestore: Firestore | null = null;
let globalUser: { uid?: string; role?: string } | null = null;

export function setGlobalFirestore(firestore: Firestore | null) {
  globalFirestore = firestore;
}

export function setGlobalUser(user: { uid?: string; role?: string } | null) {
  globalUser = user;
}

export function getGlobalFirestore() {
  return globalFirestore;
}

/**
 * Global Error Handler - Catches unhandled errors and promise rejections
 * This component should be added to the root layout
 */
export function GlobalErrorHandler() {
  // Use useFirebase instead of useFirestore to handle cases where Firebase might not be available
  const { firestore } = useFirebase() || {};
  const { user } = useUser();
  const pathname = usePathname();

  // Set global references for ErrorBoundary
  useEffect(() => {
    setGlobalFirestore(firestore);
    setGlobalUser(user ? { uid: user.dbUserId, role: user.role } : null);
  }, [firestore, user]);

  useEffect(() => {
    if (!firestore || typeof window === 'undefined') return;

    // Handle unhandled errors
    const handleError = (event: ErrorEvent) => {
      const error = event.error || new Error(event.message || 'Unknown error');

      logError(error, firestore, {
        userId: user?.dbUserId,
        userRole: user?.role,
        page: pathname,
        action: 'unhandled_error',
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
      }).catch(() => {
        // Silently fail - error logging shouldn't break the app
      });
    };

    // Handle unhandled promise rejections
    const handleRejection = (event: PromiseRejectionEvent) => {
      const error = event.reason instanceof Error
        ? event.reason
        : new Error(String(event.reason || 'Unhandled promise rejection'));

      logError(error, firestore, {
        userId: user?.dbUserId,
        userRole: user?.role,
        page: pathname,
        action: 'unhandled_promise_rejection',
        reason: String(event.reason),
      }).catch(() => {
        // Silently fail
      });
    };

    // Attach listeners
    window.addEventListener('error', handleError);
    window.addEventListener('unhandledrejection', handleRejection);

    // Cleanup
    return () => {
      window.removeEventListener('error', handleError);
      window.removeEventListener('unhandledrejection', handleRejection);
    };
  }, [firestore, user, pathname]);

  return null; // This component doesn't render anything
}
