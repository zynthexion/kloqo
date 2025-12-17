'use client';

import { useEffect, useState } from 'react';
import { setupForegroundMessageListener, setupTokenRefreshListener, registerServiceWorker } from '@/lib/firebase-messaging';
import { doc, setDoc, getDoc } from 'firebase/firestore';
import { useFirebase } from '@/firebase/provider';
import { useUser } from '@/firebase/auth/use-user';
import { Patient } from '@/lib/types';

export function MessagingInitializer() {
  const { firestore } = useFirebase() || {};
  const { user } = useUser();
  const [currentToken, setCurrentToken] = useState<string | null>(null);

  useEffect(() => {
    // Register service worker on app load (independent of permission)
    // This ensures service worker is available even before permission is granted
    const registerSW = async () => {
      try {
        await registerServiceWorker();
      } catch (error) {
        console.error('[MessagingInitializer] Error registering service worker:', error);
      }
    };

    registerSW();

    // Setup foreground message listener
    setupForegroundMessageListener();
  }, []);

  // Get current token from Firestore and refresh it immediately on app load
  useEffect(() => {
    // Rely on dbUserId which is resolved by useUser hook
    if (!firestore || !user?.dbUserId) return;

    const refreshTokenOnLoad = async () => {
      try {
        // Get current token from Firestore using resolved dbUserId
        const userDocRef = doc(firestore, 'users', user.dbUserId);
        const userDoc = await getDoc(userDocRef);
        const storedToken = userDoc.exists() ? userDoc.data()?.fcmToken : null;
        setCurrentToken(storedToken);

        // Always refresh token on app load to ensure it's valid
        const { getFCMToken } = await import('@/lib/firebase-messaging');
        const { isNotificationEnabled } = await import('@/lib/firebase-messaging');

        if (isNotificationEnabled()) {
          const newToken = await getFCMToken();

          if (newToken) {
            // Check if we need to update (new token or notifications not enabled)
            const userData = userDoc.exists() ? userDoc.data() : {};
            const needsUpdate = newToken !== storedToken || !userData.notificationsEnabled;

            if (needsUpdate) {
              try {
                await setDoc(
                  userDocRef,
                  {
                    fcmToken: newToken,
                    uid: user.uid, // Link auth UID to firestore doc for security rules
                    notificationsEnabled: true,
                    notificationPermissionGranted: true,
                    fcmTokenUpdatedAt: new Date().toISOString(),
                  },
                  { merge: true }
                );
                console.log('[MessagingInitializer] Token saved to users/', user.dbUserId);
              } catch (saveError) {
                console.error('[MessagingInitializer] Failed to save token to Firestore:', saveError);
                throw saveError;
              }
              setCurrentToken(newToken);
            }
          }
        }
      } catch (error) {
        // Silent fail for token generation errors
      }
    };

    refreshTokenOnLoad();
  }, [firestore, user?.dbUserId]);

  // Setup token refresh listener
  useEffect(() => {
    if (!firestore || !user?.dbUserId) return;

    const cleanup = setupTokenRefreshListener(
      async (newToken) => {
        try {
          // Save token to resolved dbUserId
          await setDoc(
            doc(firestore, 'users', user.dbUserId),
            {
              fcmToken: newToken,
              uid: user.uid, // Link auth UID to firestore doc for security rules
              notificationsEnabled: true,
              notificationPermissionGranted: true,
              fcmTokenUpdatedAt: new Date().toISOString(),
            },
            { merge: true }
          );
          console.log('[MessagingInitializer] Refreshed Token saved to users/', user.dbUserId);
          setCurrentToken(newToken);
        } catch (saveError) {
          console.error('[MessagingInitializer] Failed to save refreshed token to Firestore:', saveError);
          setCurrentToken(newToken);
        }
      },
      currentToken, // Pass current token for comparison
      5 * 60 * 1000 // Check every 5 minutes
    );

    // Cleanup on unmount
    return cleanup;
  }, [firestore, user?.dbUserId, currentToken]);

  return null;
}



