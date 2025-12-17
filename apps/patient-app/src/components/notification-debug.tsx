'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { debugNotificationSetup, getFCMToken } from '@/lib/firebase-messaging';
import { useUser } from '@/firebase/auth/use-user';
import { Bug } from 'lucide-react';

/**
 * Debug component to check notification setup
 * Can be enabled in production via:
 * 1. URL parameter: ?debug=notifications
 * 2. Secret key combination: Press 'D' 5 times quickly
 */
export function NotificationDebug() {
  const [debugInfo, setDebugInfo] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [isEnabled, setIsEnabled] = useState(false);
  const [keySequence, setKeySequence] = useState<number[]>([]);
  const { user } = useUser();

  const runDebug = async () => {
    setLoading(true);
    try {
      const info = await debugNotificationSetup();

      // Also check Firestore token
      let firestoreToken = null;
      let firestoreError = null;
      if (user?.dbUserId) {
        try {
          const response = await fetch(`/api/users/${user.dbUserId}/notifications`, {
            method: 'GET',
          });
          if (response.ok) {
            const data = await response.json();
            firestoreToken = data.fcmToken || null;
            console.log('[Debug] Firestore token fetched:', firestoreToken ? `${firestoreToken.substring(0, 30)}...` : 'null');
          } else {
            const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
            firestoreError = `HTTP ${response.status}: ${errorData.error || response.statusText}`;
            console.warn('[Debug] Failed to fetch Firestore token:', firestoreError);
          }
        } catch (error) {
          firestoreError = error instanceof Error ? error.message : 'Unknown error';
          console.error('[Debug] Error fetching Firestore token:', firestoreError);
        }
      } else {
        firestoreError = 'User not logged in';
      }

      // Check service worker registrations
      const registrations = await navigator.serviceWorker.getRegistrations();

      setDebugInfo({
        ...info,
        firestoreToken,
        firestoreTokenMatches: info.fcmToken === firestoreToken,
        firestoreError,
        allServiceWorkers: registrations.map(reg => ({
          url: reg.active?.scriptURL || reg.installing?.scriptURL || reg.waiting?.scriptURL,
          state: reg.active ? 'active' : reg.installing ? 'installing' : reg.waiting ? 'waiting' : 'unknown',
          scope: reg.scope,
        })),
      });
    } catch (error) {
      console.error('Debug error:', error);
      setDebugInfo({ error: error instanceof Error ? error.message : 'Unknown error' });
    } finally {
      setLoading(false);
    }
  };

  const testNotification = async () => {
    if (Notification.permission === 'granted') {
      new Notification('Test Notification', {
        body: 'If you see this, notifications are working!',
        icon: '/icons/icon-192x192.png',
      });
    } else {
      alert('Notification permission not granted. Please enable notifications first.');
    }
  };

  const requestPermission = async () => {
    setLoading(true);
    try {
      const { requestNotificationPermission, getFCMToken } = await import('@/lib/firebase-messaging');
      const granted = await requestNotificationPermission();

      if (granted) {
        const token = await getFCMToken();
        if (token && user?.dbUserId) {
          // Save token to Firestore
          await fetch(`/api/users/${user.dbUserId}/notifications`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              fcmToken: token,
              notificationsEnabled: true,
              notificationPermissionGranted: true
            }),
          });
        }
        alert('✅ Notification permission granted! Run debug again to see the token.');
        await runDebug(); // Refresh debug info
      } else {
        alert('❌ Notification permission denied. Please enable it in browser settings.');
      }
    } catch (error) {
      console.error('Error requesting permission:', error);
      alert('Error requesting permission: ' + (error instanceof Error ? error.message : 'Unknown error'));
    } finally {
      setLoading(false);
    }
  };

  const sendTestPushNotification = async () => {
    if (!debugInfo?.fcmToken) {
      alert('❌ No FCM token available. Please run debug first.');
      return;
    }

    setLoading(true);
    try {
      const response = await fetch('/api/send-notification', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          fcmToken: debugInfo.fcmToken,
          title: '🧪 Test Push Notification',
          body: 'This is a test push notification from the debug panel. If you see this, notifications are working!',
          data: {
            type: 'test',
            url: '/appointments',
            notificationSound: '/sounds/notification.wav',
          },
        }),
      });

      const result = await response.json();

      if (response.ok) {
        alert(`✅ Test push notification sent successfully!\n\nMessage ID: ${result.messageId || 'N/A'}\n\nCheck your device for the notification.`);
        console.log('✅ Test push notification sent:', result);
      } else {
        alert(`❌ Failed to send test notification:\n${result.error || result.message || 'Unknown error'}\n\nStatus: ${response.status}`);
        console.error('❌ Failed to send test notification:', result);
      }
    } catch (error) {
      alert(`❌ Error sending test notification:\n${error instanceof Error ? error.message : 'Unknown error'}`);
      console.error('❌ Error sending test notification:', error);
    } finally {
      setLoading(false);
    }
  };

  const saveTokenToFirestore = async () => {
    if (!debugInfo?.fcmToken || !user?.dbUserId) {
      alert('❌ No FCM token or user ID available');
      return;
    }

    setLoading(true);
    try {
      const tokenData = {
        fcmToken: debugInfo.fcmToken,
        notificationsEnabled: true,
        notificationPermissionGranted: true,
        fcmTokenUpdatedAt: new Date().toISOString(),
      };

      console.log('[Debug] Saving token to Firestore:', {
        userId: user.dbUserId,
        tokenLength: debugInfo.fcmToken.length,
        tokenPreview: `${debugInfo.fcmToken.substring(0, 30)}...`,
        data: tokenData,
      });

      const response = await fetch(`/api/users/${user.dbUserId}/notifications`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(tokenData),
      });

      const responseData = await response.json().catch(() => ({}));

      if (response.ok) {
        console.log('[Debug] ✅ Token saved successfully to Firestore');
        alert('✅ Token saved to Firestore! Run debug again to verify.');
        // Refresh debug info
        await runDebug();
      } else {
        const errorMessage = responseData.error || responseData.message || `HTTP ${response.status}: ${response.statusText}`;
        console.error('[Debug] ❌ Failed to save token:', {
          status: response.status,
          statusText: response.statusText,
          error: responseData,
        });
        alert(`❌ Failed to save token:\n\n${errorMessage}\n\nStatus: ${response.status}\n\nCheck console for details.`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('[Debug] ❌ Error saving token to Firestore:', error);
      alert(`❌ Error saving token:\n\n${errorMessage}\n\nCheck console for details.`);
    } finally {
      setLoading(false);
    }
  };

  const resetServiceWorker = async () => {
    if (!('serviceWorker' in navigator)) {
      alert('❌ Service workers not supported in this browser');
      return;
    }

    try {
      setLoading(true);
      console.log('🔄 Resetting service workers...');

      // Get all service worker registrations
      const registrations = await navigator.serviceWorker.getRegistrations();

      if (registrations.length === 0) {
        alert('✅ No service workers found. Page will reload.');
        window.location.reload();
        return;
      }

      // Unregister all service workers
      let unregisteredCount = 0;
      for (const registration of registrations) {
        const unregistered = await registration.unregister();
        if (unregistered) {
          unregisteredCount++;
          console.log('✅ Unregistered:', registration.scope);
        }
      }

      if (unregisteredCount > 0) {
        alert(`✅ ${unregisteredCount} service worker(s) unregistered. Page will reload in 1 second...`);
        setTimeout(() => {
          window.location.reload();
        }, 1000);
      } else {
        alert('⚠️ Could not unregister service workers. Please try clearing browser cache manually.');
      }
    } catch (error) {
      console.error('Error resetting service worker:', error);
      alert('❌ Error resetting service worker: ' + (error instanceof Error ? error.message : 'Unknown error'));
    } finally {
      setLoading(false);
    }
  };

  // Enable debug mode in production via URL parameter or localStorage
  useEffect(() => {
    // Check URL parameter
    if (typeof window !== 'undefined') {
      const urlParams = new URLSearchParams(window.location.search);
      const debugParam = urlParams.get('debug');

      if (debugParam === 'notifications') {
        setIsEnabled(true);
        localStorage.setItem('debugNotifications', 'true');
      } else {
        // Check localStorage for persistent debug mode
        const stored = localStorage.getItem('debugNotifications');
        if (stored === 'true') {
          setIsEnabled(true);
        }
      }
    }
  }, []);

  // Secret key combination: Press 'D' 5 times quickly (within 3 seconds)
  useEffect(() => {
    const handleKeyPress = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'd' || e.key.toLowerCase() === 'D') {
        const now = Date.now();
        const recentKeys = keySequence.filter(timestamp => now - timestamp < 3000);

        if (recentKeys.length >= 4) {
          // 5th 'D' press - enable debug mode!
          setIsEnabled(true);
          localStorage.setItem('debugNotifications', 'true');
          console.log('🔓 Debug mode enabled!');
          setKeySequence([]);
          // Show visual feedback
          alert('🔓 Notification Debug Mode Enabled!');
        } else {
          setKeySequence([...recentKeys, now]);
        }
      } else {
        // Reset sequence if any other key is pressed
        setKeySequence([]);
      }
    };

    window.addEventListener('keydown', handleKeyPress);
    return () => window.removeEventListener('keydown', handleKeyPress);
  }, [keySequence]);

  // Show debug button in production (only visible, not the panel)
  const showDebugButton = process.env.NODE_ENV === 'production' && !isEnabled;

  if (showDebugButton) {
    return (
      <Card className="mt-4 border-dashed">
        <CardContent className="p-4 text-center">
          <p className="text-sm text-muted-foreground mb-2">
            Need to debug notifications?
          </p>
          <Button
            onClick={() => {
              setIsEnabled(true);
              localStorage.setItem('debugNotifications', 'true');
            }}
            variant="outline"
            size="sm"
            className="w-full"
          >
            <Bug className="h-4 w-4 mr-2" />
            Enable Debug Mode
          </Button>
          <p className="text-xs text-muted-foreground mt-2">
            Or press 'D' 5 times quickly, or add ?debug=notifications to URL
          </p>
        </CardContent>
      </Card>
    );
  }

  if (!isEnabled && process.env.NODE_ENV === 'production') {
    return null;
  }

  const disableDebug = () => {
    setIsEnabled(false);
    localStorage.removeItem('debugNotifications');
    setDebugInfo(null);
  };

  return (
    <Card className="mt-4 border-2 border-orange-500">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Bug className="h-5 w-5" />
            🔍 Notification Debug {process.env.NODE_ENV === 'production' && '(Production Mode)'}
          </CardTitle>
          {process.env.NODE_ENV === 'production' && (
            <Button onClick={disableDebug} variant="ghost" size="sm">
              Disable Debug
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2 flex-wrap">
          <Button onClick={runDebug} disabled={loading}>
            {loading ? 'Checking...' : 'Run Debug'}
          </Button>
          {debugInfo?.notificationPermission !== 'granted' && (
            <Button onClick={requestPermission} disabled={loading} variant="default">
              Request Permission
            </Button>
          )}
          {debugInfo?.notificationPermission === 'granted' && (
            <>
              <Button onClick={testNotification} variant="outline">
                Test Local Notification
              </Button>
              {debugInfo?.fcmToken && (
                <Button
                  onClick={sendTestPushNotification}
                  variant="default"
                  disabled={loading}
                >
                  🚀 Send Test Push (FCM)
                </Button>
              )}
            </>
          )}
          <Button onClick={resetServiceWorker} disabled={loading} variant="destructive" size="sm">
            🔄 Reset Service Worker
          </Button>
          {debugInfo?.fcmToken && (!debugInfo?.firestoreToken || !debugInfo?.firestoreTokenMatches) && (
            <Button
              onClick={saveTokenToFirestore}
              disabled={loading}
              variant="secondary"
              size="sm"
            >
              💾 Save Token to Firestore
            </Button>
          )}
        </div>

        {debugInfo && (
          <div className="mt-4 p-4 bg-muted rounded-lg space-y-2 text-sm">
            <div>
              <strong>Service Worker:</strong>{' '}
              {debugInfo.serviceWorkerRegistered ? '✅ Registered' : '❌ Not Registered'}
              {debugInfo.serviceWorkerURL && (
                <div className="text-xs text-muted-foreground ml-4">
                  URL: {debugInfo.serviceWorkerURL}
                </div>
              )}
            </div>
            <div>
              <strong>All Service Workers:</strong>
              <ul className="list-disc ml-6 text-xs">
                {debugInfo.allServiceWorkers?.map((sw: any, i: number) => (
                  <li key={i}>
                    {sw.url} ({sw.state}, scope: {sw.scope})
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <strong>Notification Permission:</strong>{' '}
              {debugInfo.notificationPermission === 'granted' ? '✅ Granted' :
                debugInfo.notificationPermission === 'denied' ? '❌ Denied' :
                  '⚠️ Default (not requested)'}
            </div>
            <div>
              <strong>VAPID Key:</strong>{' '}
              {debugInfo.vapidKeyConfigured ? '✅ Configured' : '❌ Missing'}
            </div>
            <div>
              <strong>FCM Token (Current):</strong>{' '}
              {debugInfo.fcmToken ? (
                <span className="text-xs font-mono break-all">
                  ✅ {debugInfo.fcmToken.substring(0, 50)}...
                </span>
              ) : (
                '❌ Not available'
              )}
            </div>
            <div>
              <strong>FCM Token (Firestore):</strong>{' '}
              {debugInfo.firestoreToken ? (
                <span className="text-xs font-mono break-all">
                  ✅ {debugInfo.firestoreToken.substring(0, 50)}...
                </span>
              ) : debugInfo.firestoreError ? (
                <span className="text-red-600">
                  ❌ Error: {debugInfo.firestoreError}
                </span>
              ) : (
                '❌ Not found'
              )}
            </div>
            <div>
              <strong>Tokens Match:</strong>{' '}
              {debugInfo.firestoreTokenMatches ? '✅ Yes' : '❌ No (token mismatch!)'}
            </div>
            {debugInfo.error && (
              <div className="text-red-500 p-2 bg-red-50 rounded">
                <strong>⚠️ Error:</strong> {debugInfo.error}
              </div>
            )}
            {debugInfo.notificationPermission === 'default' && (
              <div className="text-amber-600 p-2 bg-amber-50 rounded">
                <strong>⚠️ Action Required:</strong> Click "Request Permission" button above to enable notifications.
              </div>
            )}
            {debugInfo.notificationPermission === 'denied' && (
              <div className="text-red-600 p-2 bg-red-50 rounded">
                <strong>❌ Permission Denied:</strong> Please enable notifications in your browser settings, then refresh the page.
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

