/**
 * Firebase Error Logger - Production Error Tracking
 * Logs errors to Firestore for monitoring and debugging
 */

import { Firestore, collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { db } from './firebase';

export type ErrorSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface ErrorContext {
  userId?: string;
  userRole?: string;
  page?: string;
  action?: string;
  deviceInfo?: {
    userAgent: string;
    platform: string;
    language: string;
    screenWidth?: number;
    screenHeight?: number;
  };
  appVersion?: string;
  [key: string]: any;
}

export interface ErrorLog {
  error: {
    name: string;
    message: string;
    stack?: string;
    code?: string;
  };
  severity: ErrorSeverity;
  context: ErrorContext;
  timestamp: any;
  appName: 'patient-app' | 'nurse-app' | 'clinic-admin';
  sessionId?: string;
}

let errorQueue: ErrorLog[] = [];
let isOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    isOnline = true;
    flushErrorQueue();
  });
  window.addEventListener('offline', () => {
    isOnline = false;
  });
}

function getSessionId(): string {
  if (typeof window === 'undefined') return 'server';
  
  let sessionId = sessionStorage.getItem('error_session_id');
  if (!sessionId) {
    sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    sessionStorage.setItem('error_session_id', sessionId);
  }
  return sessionId;
}

function getDeviceInfo(): ErrorContext['deviceInfo'] {
  if (typeof window === 'undefined') {
    return {
      userAgent: 'server',
      platform: 'server',
      language: 'en',
    };
  }

  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform || 'unknown',
    language: navigator.language || 'en',
    screenWidth: window.screen?.width,
    screenHeight: window.screen?.height,
  };
}

function getCurrentPage(): string {
  if (typeof window === 'undefined') return 'server';
  return window.location.pathname;
}

function determineSeverity(error: Error): ErrorSeverity {
  if (
    error.message.includes('network') ||
    error.message.includes('auth') ||
    error.message.includes('permission') ||
    error.message.includes('payment') ||
    error.message.includes('Failed to fetch')
  ) {
    return 'critical';
  }

  if (
    error.message.includes('undefined') ||
    error.message.includes('null') ||
    error.message.includes('Cannot read') ||
    error.message.includes('validation')
  ) {
    return 'high';
  }

  if (
    error.message.includes('render') ||
    error.message.includes('component') ||
    error.message.includes('hook')
  ) {
    return 'medium';
  }

  return 'low';
}

/**
 * Helper function to remove undefined values from objects
 */
function removeUndefined(obj: any): any {
  if (obj === null || obj === undefined) return null;
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(removeUndefined);
  
  const cleaned: any = {};
  for (const key in obj) {
    if (obj[key] !== undefined) {
      cleaned[key] = removeUndefined(obj[key]);
    }
  }
  return cleaned;
}

export async function logError(
  error: Error | string,
  firestore: Firestore = db,
  context: Partial<ErrorContext> = {}
): Promise<void> {
  try {
    const errorObj = typeof error === 'string' 
      ? new Error(error) 
      : error;

    const errorData: any = {
      name: errorObj.name || 'Error',
      message: errorObj.message || String(error),
    };
    
    // Only include stack and code if they exist and are not undefined
    if (errorObj.stack) {
      errorData.stack = errorObj.stack;
    }
    if ((errorObj as any).code) {
      errorData.code = (errorObj as any).code;
    }

    const errorLog: ErrorLog = {
      error: errorData,
      severity: determineSeverity(errorObj),
      context: {
        ...removeUndefined({
          ...context,
          deviceInfo: getDeviceInfo(),
          page: context.page || getCurrentPage(),
          appVersion: process.env.NEXT_PUBLIC_APP_VERSION || '1.0.0',
        }),
      },
      timestamp: serverTimestamp(),
      appName: 'nurse-app',
      sessionId: getSessionId(),
    };

    // Clean all undefined values from the error log before saving
    const cleanedErrorLog = removeUndefined(errorLog);

    if (isOnline && firestore) {
      try {
        await addDoc(collection(firestore, 'error_logs'), cleanedErrorLog);
      } catch (firestoreError) {
        console.error('Failed to log error to Firestore:', firestoreError);
        errorQueue.push(cleanedErrorLog);
      }
    } else {
      errorQueue.push(cleanedErrorLog);
    }
  } catch (loggingError) {
    console.error('Failed to log error:', loggingError);
    console.error('Original error:', error);
  }
}

async function flushErrorQueue(firestore?: Firestore): Promise<void> {
  if (!isOnline || !firestore || errorQueue.length === 0) return;

  const errorsToFlush = [...errorQueue];
  errorQueue = [];

  for (const errorLog of errorsToFlush) {
    try {
      const cleanedErrorLog = removeUndefined(errorLog);
      await addDoc(collection(firestore, 'error_logs'), cleanedErrorLog);
    } catch (error) {
      errorQueue.push(errorLog);
    }
  }
}

export async function logEvent(
  eventName: string,
  firestore: Firestore = db,
  data: Record<string, any> = {}
): Promise<void> {
  try {
    if (!firestore) return;

    const eventLog = {
      eventName,
      data,
      timestamp: serverTimestamp(),
      appName: 'nurse-app' as const,
      sessionId: getSessionId(),
      page: getCurrentPage(),
      deviceInfo: getDeviceInfo(),
    };

    if (isOnline) {
      await addDoc(collection(firestore, 'event_logs'), eventLog);
    }
  } catch (error) {
    console.error('Failed to log event:', error);
  }
}

export { flushErrorQueue };
