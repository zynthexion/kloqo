'use client';

import { getMessaging, getToken, onMessage, isSupported, type Messaging } from 'firebase/messaging';
import { initializeApp, getApps, getApp, type FirebaseApp } from 'firebase/app';
import { firebaseConfig } from '@kloqo/shared-firebase';
import { logger } from '@/lib/logger';

// Helper function to convert VAPID key from base64url to Uint8Array
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray as Uint8Array;
}

let messaging: Messaging | null = null;

// Get Firebase app instance
const getFirebaseApp = (): FirebaseApp => {
  const apps = getApps();
  if (apps.length === 0) {
    return initializeApp(firebaseConfig);
  }
  return getApp();
};

// Initialize messaging (only in browser)
const initMessaging = async () => {
  if (typeof window === 'undefined') return null;

  try {
    const supported = await isSupported();
    if (!supported) {
      logger.info('Firebase Messaging not supported in this browser');
      return null;
    }

    const app = getFirebaseApp();
    messaging = getMessaging(app);
    return messaging;
  } catch (error) {
    console.error('Error initializing messaging:', error);
    return null;
  }
};

// Request notification permission
export async function requestNotificationPermission(): Promise<boolean> {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    logger.info('Browser does not support notifications');
    return false;
  }

  // Check current permission
  if (Notification.permission === 'granted') {
    return true;
  }

  if (Notification.permission === 'denied') {
    logger.info('Notification permission was denied');
    return false;
  }

  // Request permission
  const permission = await Notification.requestPermission();

  return permission === 'granted';
}

// Get or register service worker for Firebase Messaging
// CRITICAL: We need to use firebase-messaging-sw.js because it has the Firebase messaging code.
// However, if PWA service worker (sw.js) is already registered, we have a conflict.
// Solution: Unregister PWA SW temporarily, register Firebase SW, then re-register PWA SW.
// But actually, only one can control scope '/', so we need to integrate Firebase into PWA SW.
// For now, we'll try to use Firebase SW and handle the conflict.
// Export for manual registration
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  return getServiceWorkerRegistration();
}

async function getServiceWorkerRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    return null;
  }

  try {
    const existingRegistrations = await navigator.serviceWorker.getRegistrations();

    // Check for Firebase messaging service worker first
    const firebaseSW = existingRegistrations.find(
      reg => reg.active?.scriptURL.includes('firebase-messaging-sw.js') ||
        reg.installing?.scriptURL.includes('firebase-messaging-sw.js') ||
        reg.waiting?.scriptURL.includes('firebase-messaging-sw.js')
    );

    if (firebaseSW) {
      logger.debug('✅ Firebase messaging service worker found');
      // Wait for activation if installing
      if (firebaseSW.installing) {
        await new Promise((resolve) => {
          const installing = firebaseSW.installing;
          if (!installing) {
            resolve(null);
            return;
          }
          const checkState = () => {
            if (firebaseSW.active) {
              resolve(null);
            } else {
              setTimeout(checkState, 100);
            }
          };
          installing.addEventListener('statechange', checkState);
          checkState();
        });
      }
      return firebaseSW;
    }

    // Check if PWA service worker is registered (this will conflict)
    const pwaSW = existingRegistrations.find(
      reg => reg.active?.scriptURL.includes('/sw.js')
    );

    if (pwaSW) {
      logger.warn('⚠️ PWA service worker detected. Firebase messaging may not work.');
      logger.warn('⚠️ Unregistering PWA service worker to register Firebase messaging service worker...');

      // Unregister PWA service worker to allow Firebase SW to register
      try {
        await pwaSW.unregister();
        logger.debug('✅ PWA service worker unregistered');
        // Wait a bit for unregistration to complete
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (unregError) {
        console.error('Error unregistering PWA service worker:', unregError);
      }
    }

    // Now register Firebase messaging service worker
    logger.debug('📝 Registering Firebase messaging service worker...');
    const registration = await navigator.serviceWorker.register('/firebase-messaging-sw.js', {
      scope: '/',
    });

    // Wait for activation
    if (registration.installing) {
      await new Promise((resolve) => {
        registration.installing!.addEventListener('statechange', () => {
          if (registration.installing?.state === 'activated' || registration.active) {
            resolve(null);
          }
        });
        // Timeout after 5 seconds
        setTimeout(resolve, 5000);
      });
    }

    logger.debug('✅ Firebase messaging service worker registered');
    return registration;
  } catch (error) {
    console.error('❌ Error with service worker:', error);
    if (error instanceof Error) {
      console.error('Error message:', error.message);
      // If registration failed due to existing SW, try to get it
      if (error.message.includes('already registered') || error.message.includes('script evaluation failed')) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        const existing = registrations.find(reg =>
          reg.active?.scriptURL.includes('firebase-messaging-sw.js')
        );
        if (existing) {
          logger.debug('✅ Found existing Firebase service worker');
          return existing;
        }
      }
    }
    return null;
  }
}

// Get FCM token
export async function getFCMToken(): Promise<string | null> {
  if (typeof window === 'undefined') {
    return null;
  }

  let swRegistration: ServiceWorkerRegistration | null = null;
  let vapidKey: string | undefined = undefined;

  try {
    console.log('[getFCMToken] Starting token retrieval...');

    // Get existing service worker registration (PWA or Firebase)
    swRegistration = await getServiceWorkerRegistration();
    console.log('[getFCMToken] Service worker registration:', swRegistration ? 'Found' : 'Not found');

    if (swRegistration) {
      console.log('[getFCMToken] Service worker state:', {
        active: !!swRegistration.active,
        installing: !!swRegistration.installing,
        waiting: !!swRegistration.waiting,
        scope: swRegistration.scope,
        scriptURL: swRegistration.active?.scriptURL || swRegistration.installing?.scriptURL || swRegistration.waiting?.scriptURL,
      });
    }

    if (!messaging) {
      console.log('[getFCMToken] Messaging not initialized, initializing...');
      await initMessaging();
    }

    if (!messaging) {
      console.error('[getFCMToken] ❌ Messaging failed to initialize');
      return null;
    }

    const vapidKey = process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY;

    if (!vapidKey) {
      console.error('[getFCMToken] ❌ VAPID key not configured');
      return null;
    }

    console.log('[getFCMToken] VAPID key configured:', vapidKey.substring(0, 20) + '...');
    console.log('[getFCMToken] Requesting FCM token...');

    // Pass service worker registration to getToken
    const token = await getToken(messaging, {
      vapidKey,
      serviceWorkerRegistration: swRegistration || undefined
    });

    if (token) {
      console.log('[getFCMToken] ✅ FCM Token obtained successfully:', token.substring(0, 50) + '...');
      return token;
    } else {
      console.warn('[getFCMToken] ⚠️ No registration token available');
      return null;
    }
  } catch (error) {
    console.error('[getFCMToken] ❌ Error getting FCM token:', error);
    if (error instanceof Error) {
      console.error('[getFCMToken] Error message:', error.message);
      console.error('[getFCMToken] Error name:', error.name);
      if (error.message.includes('push service error')) {
        console.error('[getFCMToken] ⚠️  Push service error detected');
        console.error('[getFCMToken] This usually means:');
        console.error('[getFCMToken] 1. Browser push service is blocked or unavailable');
        console.error('[getFCMToken] 2. VAPID key might be incorrect');
        console.error('[getFCMToken] 3. Service worker push subscription failed');
        console.error('[getFCMToken]');
        console.error('[getFCMToken] Troubleshooting:');
        console.error('[getFCMToken] - Try in Chrome/Edge (best support)');
        console.error('[getFCMToken] - Check browser settings: chrome://settings/content/notifications');
        console.error('[getFCMToken] - Verify VAPID key in Firebase Console');
        console.error('[getFCMToken] - Check if service worker has push event handler');

        // Try to get more details about the push subscription
        if (swRegistration && swRegistration.active) {
          try {
            const subscription = await swRegistration.pushManager.getSubscription();
            console.log('[getFCMToken] Current push subscription:', subscription ? 'Exists' : 'None');
            if (!subscription && vapidKey) {
              console.log('[getFCMToken] No push subscription found. Attempting manual subscription...');
              try {
                const newSubscription = await swRegistration.pushManager.subscribe({
                  userVisibleOnly: true,
                  applicationServerKey: urlBase64ToUint8Array(vapidKey) as BufferSource
                });
                console.log('[getFCMToken] ✅ Manual subscription created successfully');
                console.log('[getFCMToken] Subscription endpoint:', newSubscription.endpoint);
                // Now try getting the token again
                if (messaging) {
                  const retryToken = await getToken(messaging, {
                    vapidKey,
                    serviceWorkerRegistration: swRegistration
                  });
                  if (retryToken) {
                    console.log('[getFCMToken] ✅ Token obtained after manual subscription!');
                    return retryToken;
                  }
                }
              } catch (subError) {
                console.error('[getFCMToken] ❌ Manual subscription failed:', subError);
                if (subError instanceof Error) {
                  console.error('[getFCMToken] Subscription error:', subError.message);
                }
              }
            }
          } catch (subError) {
            console.error('[getFCMToken] Error checking subscription:', subError);
          }
        }
      }
      if (error.message.includes('messaging/registration-token-not-found')) {
        console.error('[getFCMToken] ⚠️  Service worker not registered. Please refresh the page.');
      }
      if (error.message.includes('messaging/failed-service-worker-registration')) {
        console.error('[getFCMToken] ⚠️  Service worker registration failed. Check service worker file.');
      }
      if (error.stack) {
        console.error('[getFCMToken] Error stack:', error.stack);
      }
    }
    return null;
  }
}

// Listen for foreground messages
export function setupForegroundMessageListener() {
  if (typeof window === 'undefined') {
    return;
  }

  initMessaging().then(() => {
    if (messaging) {
      onMessage(messaging, (payload) => {
        logger.debug('Message received in foreground:', payload);

        // Check permission before showing notification
        if (Notification.permission !== 'granted') {
          console.warn('Notification permission not granted, cannot display notification');
          return;
        }

        // Display notification
        if (payload.notification) {
          const notificationTitle = payload.notification.title || 'New notification';
          const notificationOptions: NotificationOptions = {
            body: payload.notification.body,
            icon: '/icons/icon-192x192.png',
            badge: '/icons/icon-192x192.png',
            tag: payload.data?.type || 'notification',
            data: payload.data,
          };

          new Notification(notificationTitle, notificationOptions);
        }
      });
    }
  });
}

// Check if notifications are currently enabled
export function isNotificationEnabled(): boolean {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return false;
  }
  return Notification.permission === 'granted';
}

/**
 * Setup token refresh monitoring
 * Periodically checks if FCM token has changed and updates Firestore
 * Note: onTokenRefresh is not available in web SDK, so we use periodic checks
 * @param onTokenUpdate - Callback function to update token in Firestore
 * @param currentToken - Current token stored in Firestore to compare against
 * @param checkInterval - Interval in milliseconds to check for token changes (default: 5 minutes)
 */
export function setupTokenRefreshListener(
  onTokenUpdate: (token: string) => Promise<void>,
  currentToken: string | null = null,
  checkInterval: number = 5 * 60 * 1000 // 5 minutes
): () => void {
  if (typeof window === 'undefined') {
    return () => { }; // Return no-op cleanup function
  }

  let intervalId: NodeJS.Timeout | null = null;
  let lastCheckedToken: string | null = currentToken;

  const checkToken = async () => {
    try {
      // Get existing service worker registration (PWA or Firebase)
      const swRegistration = await getServiceWorkerRegistration();

      if (!messaging) {
        await initMessaging();
      }

      if (!messaging) {
        return;
      }

      const vapidKey = process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY;
      if (!vapidKey) {
        return;
      }

      // Get current token from Firebase with service worker registration
      const newToken = await getToken(messaging, {
        vapidKey,
        serviceWorkerRegistration: swRegistration || undefined
      });

      if (newToken && newToken !== lastCheckedToken) {
        logger.debug('🔄 FCM Token changed:', newToken.substring(0, 50) + '...');

        try {
          // Call the callback to update Firestore
          await onTokenUpdate(newToken);
          lastCheckedToken = newToken;
          logger.debug('✅ Token updated in Firestore successfully');
        } catch (error) {
          console.error('❌ Failed to update token in Firestore:', error);
          if (error instanceof Error) {
            console.error('Error details:', error.message);
          }
        }
      }
    } catch (error) {
      console.error('Error checking token refresh:', error);
    }
  };

  // Start periodic checking
  intervalId = setInterval(checkToken, checkInterval);

  // Also check on visibility change (when user returns to tab)
  const handleVisibilityChange = () => {
    if (document.visibilityState === 'visible') {
      checkToken();
    }
  };

  document.addEventListener('visibilitychange', handleVisibilityChange);

  // Return cleanup function
  return () => {
    if (intervalId) {
      clearInterval(intervalId);
    }
    document.removeEventListener('visibilitychange', handleVisibilityChange);
  };
}

// Debug function to check notification setup
export async function debugNotificationSetup(): Promise<{
  serviceWorkerRegistered: boolean;
  serviceWorkerURL: string | null;
  notificationPermission: NotificationPermission;
  fcmToken: string | null;
  vapidKeyConfigured: boolean;
  error?: string;
}> {
  const result: {
    serviceWorkerRegistered: boolean;
    serviceWorkerURL: string | null;
    notificationPermission: NotificationPermission;
    fcmToken: string | null;
    vapidKeyConfigured: boolean;
    error?: string;
  } = {
    serviceWorkerRegistered: false,
    serviceWorkerURL: null,
    notificationPermission: Notification.permission,
    fcmToken: null,
    vapidKeyConfigured: !!process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY,
  };

  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    result.error = 'Service workers not supported';
    return result;
  }

  try {
    const registrations = await navigator.serviceWorker.getRegistrations();

    // Check for Firebase messaging service worker (check all states: active, installing, waiting)
    const firebaseSW = registrations.find(
      reg => {
        const url = reg.active?.scriptURL || reg.installing?.scriptURL || reg.waiting?.scriptURL || '';
        return url.includes('firebase-messaging-sw.js');
      }
    );

    if (firebaseSW) {
      result.serviceWorkerRegistered = true;
      result.serviceWorkerURL = firebaseSW.active?.scriptURL || firebaseSW.installing?.scriptURL || firebaseSW.waiting?.scriptURL || null;
    }

    // Only try to get FCM token if permission is granted
    if (result.notificationPermission === 'granted') {
      try {
        console.log('[DEBUG] Attempting to get FCM token...');
        console.log('[DEBUG] Service worker registration:', result.serviceWorkerRegistered);
        console.log('[DEBUG] Service worker URL:', result.serviceWorkerURL);

        // Ensure messaging is initialized
        if (!messaging) {
          console.log('[DEBUG] Messaging not initialized, initializing...');
          await initMessaging();
        }

        if (!messaging) {
          result.error = 'Firebase Messaging failed to initialize';
          return result;
        }

        console.log('[DEBUG] Getting FCM token with service worker...');
        const token = await getFCMToken();
        console.log('[DEBUG] FCM token result:', token ? `${token.substring(0, 50)}...` : 'null');
        result.fcmToken = token;

        if (!token) {
          result.error = 'FCM token is null. Check console for detailed error messages.';
        }
      } catch (tokenError) {
        console.error('[DEBUG] Error getting FCM token:', tokenError);
        if (tokenError instanceof Error) {
          console.error('[DEBUG] Error message:', tokenError.message);
          console.error('[DEBUG] Error stack:', tokenError.stack);
          result.error = `Failed to get FCM token: ${tokenError.message}`;
        } else {
          result.error = 'Failed to get FCM token: Unknown error';
        }
      }
    } else {
      result.error = `Notification permission is "${result.notificationPermission}". Please grant permission first.`;
    }
  } catch (error) {
    console.error('Error in debugNotificationSetup:', error);
    result.error = error instanceof Error ? error.message : 'Unknown error';
  }

  return result;
}

// Initialize messaging on module load
if (typeof window !== 'undefined') {
  initMessaging();
}

