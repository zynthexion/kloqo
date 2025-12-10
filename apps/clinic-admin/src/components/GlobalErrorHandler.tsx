'use client';

import { useEffect } from 'react';
import { db } from '@/lib/firebase';
import { logError } from '@/lib/error-logger';
import { setGlobalFirestore } from './ErrorBoundary';
import { useAuth } from '@/firebase';
import { usePathname } from 'next/navigation';
import type { Firestore } from 'firebase/firestore';

export function GlobalErrorHandler() {
  const firestore: Firestore = db;
  const { currentUser } = useAuth();
  const pathname = usePathname();

  // Set global reference for ErrorBoundary
  useEffect(() => {
    setGlobalFirestore(firestore);
  }, [firestore]);

  useEffect(() => {
    if (!firestore || typeof window === 'undefined') return;

    const handleError = (event: ErrorEvent) => {
      const error = event.error || new Error(event.message || 'Unknown error');
      
      logError(error, firestore, {
        userId: currentUser?.uid,
        userRole: 'clinicAdmin',
        page: pathname,
        action: 'unhandled_error',
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
      }).catch(() => {
        // Silently fail
      });
    };

    const handleRejection = (event: PromiseRejectionEvent) => {
      const error = event.reason instanceof Error 
        ? event.reason 
        : new Error(String(event.reason || 'Unhandled promise rejection'));

      logError(error, firestore, {
        userId: currentUser?.uid,
        userRole: 'clinicAdmin',
        page: pathname,
        action: 'unhandled_promise_rejection',
        reason: String(event.reason),
      }).catch(() => {
        // Silently fail
      });
    };

    window.addEventListener('error', handleError);
    window.addEventListener('unhandledrejection', handleRejection);

    return () => {
      window.removeEventListener('error', handleError);
      window.removeEventListener('unhandledrejection', handleRejection);
    };
  }, [firestore, currentUser, pathname]);

  return null;
}
