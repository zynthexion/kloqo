'use client';

import { useEffect } from 'react';
import { requestNotificationPermission, getFCMToken, isNotificationEnabled } from '@/lib/firebase-messaging';
import { useUser } from '@/firebase/auth/use-user';

export function NotificationOnboard() {
  const { user } = useUser();

  useEffect(() => {
    if (!user) return;

    const checkAndRequestPermission = async () => {
      // Check if already enabled
      if (isNotificationEnabled()) {
        return;
      }

      // Check if browser supports notifications
      if (typeof window === 'undefined' || !('Notification' in window)) {
        return;
      }

      // If permission is already denied, don't request again
      if (Notification.permission === 'denied') {
        return;
      }

      // If permission is already granted, just get the token
      if (Notification.permission === 'granted') {
        const token = await getFCMToken();
        if (token && user?.dbUserId) {
          // Use API route which saves to primaryUserId from patient document
          try {
            await fetch(`/api/users/${user.dbUserId}/notifications`, {
              method: 'PATCH',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                fcmToken: token,
                notificationsEnabled: true,
                notificationPermissionGranted: true,
                fcmTokenUpdatedAt: new Date().toISOString(),
              }),
            });
          } catch (error) {
            console.error('Error saving FCM token via API:', error);
          }
        }
        return;
      }

      // Request permission immediately when user logs in (triggers native browser prompt)
      // This will show the default mobile browser notification permission prompt
      try {
        const permissionGranted = await requestNotificationPermission();

        if (permissionGranted) {
          const token = await getFCMToken();
          if (token && user?.dbUserId) {
            // Use API route which saves to primaryUserId from patient document
            try {
              await fetch(`/api/users/${user.dbUserId}/notifications`, {
                method: 'PATCH',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  fcmToken: token,
                  notificationsEnabled: true,
                  notificationPermissionGranted: true,
                  fcmTokenUpdatedAt: new Date().toISOString(),
                }),
              });
            } catch (error) {
              console.error('Error saving FCM token via API:', error);
            }
          }
        }
      } catch (error) {
        console.error('Error requesting notification permission:', error);
      }
    };

    checkAndRequestPermission();
  }, [user]);

  // This component automatically requests notification permission, which triggers
  // the native browser prompt. No UI needed - the browser handles it.
  return null;
}
