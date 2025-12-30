// Service Worker Version: 2.2 - Improved duplicate prevention and iOS sound handling
// Import Firebase scripts
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js');

console.log('🔧 Service Worker v2.1 loaded - Notification fixes active');

// Firebase configuration - this should match your firebase-config.env
const firebaseConfig = {
  apiKey: "AIzaSyDFki6NQ82GGRMR53BJ63Kkl0Y96sLbMH0",
  authDomain: "kloqo-clinic-multi-33968-4c50b.firebaseapp.com",
  projectId: "kloqo-clinic-multi-33968-4c50b",
  storageBucket: "kloqo-clinic-multi-33968-4c50b.appspot.com",
  messagingSenderId: "932946841357",
  appId: "1:932946841357:web:d626e91ed38b4a8baf6a44"
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);

// Retrieve an instance of Firebase Messaging
const messaging = firebase.messaging();

// Track if notification was shown to prevent duplicates
let notificationShownForCurrentPush = false;

// Track recently shown notifications to prevent duplicates within short time window
const recentNotifications = new Map();
const DUPLICATE_PREVENTION_WINDOW = 60000; // 60 seconds - catch duplicates even with delays

// Sound mapping for different notification types
// You can customize these paths to your own sound files
// Currently all notifications use notification.wav as default
const NOTIFICATION_SOUNDS = {
  'appointment_confirmed': '/sounds/notification.wav',
  'appointment_reminder': '/sounds/notification.wav',
  'token_called': '/sounds/notification.wav',
  'appointment_cancelled': '/sounds/notification.wav',
  'default': '/sounds/notification.wav', // Default sound for all notifications
};

// Handle background messages
messaging.onBackgroundMessage((payload) => {
  console.log('📨 Background message received via onBackgroundMessage:', payload);
  console.log('📨 Has notification object:', !!payload.notification);

  if (!payload.notification && !payload.data) {
    console.warn('⚠️ Payload has no notification or data object, cannot show notification');
    return Promise.resolve();
  }

  // Support both notification payload and data-only payload
  const notificationTitle = payload.notification?.title || payload.data?.title || 'Kloqo';
  const notificationBody = payload.notification?.body || payload.data?.body || 'You have a new notification';
  const notificationIcon = payload.notification?.icon || '/icons/icon-192x192.png';

  // Use unique tag to prevent duplicates
  // Include notification type in tag to make it unique even for same appointmentId
  const notificationType = payload.data?.type || 'notification';
  const appointmentId = payload.data?.appointmentId || '';
  const fcmMessageId = payload.fcmMessageId || payload.messageId || '';

  // Create unique tag: type_appointmentId or type_fcmMessageId or type_timestamp
  let uniqueTag;
  if (appointmentId) {
    uniqueTag = `${notificationType}_${appointmentId}`;
  } else if (fcmMessageId) {
    uniqueTag = `${notificationType}_${fcmMessageId}`;
  } else {
    uniqueTag = `${notificationType}_${Date.now()}`;
  }

  console.log('📨 Preparing notification:', {
    title: notificationTitle,
    body: notificationBody,
    tag: uniqueTag,
    type: notificationType,
    appointmentId: appointmentId || 'none',
    fcmMessageId: fcmMessageId || 'none'
  });

  // Determine notification sound based on data type or use default
  // ALWAYS use notification.wav as default sound
  // Priority: 1. payload.data.notificationSound (explicit), 2. sound mapping by type, 3. default
  // Supported formats: MP3, WAV, OGG
  let notificationSound = '/sounds/notification.wav'; // Always use notification.wav

  // Only override if explicitly specified in payload
  if (payload.data?.notificationSound) {
    notificationSound = payload.data.notificationSound;
  } else if (NOTIFICATION_SOUNDS[payload.data?.type]) {
    notificationSound = NOTIFICATION_SOUNDS[payload.data?.type];
  }

  console.log('🔊 Notification sound:', {
    explicit: payload.data?.notificationSound,
    type: payload.data?.type,
    selectedSound: notificationSound
  });

  // Detect if device is iOS (iOS doesn't support custom notification sounds)
  const isIOS = /iPhone|iPad|iPod/.test(self.navigator?.userAgent || '');

  // Determine target URL based on notification type/title
  let targetUrl = '/appointments';

  if (
    notificationTitle.includes('Upcoming Appointment') ||
    notificationType === 'appointment_reminder' ||
    notificationType === 'token_called' ||
    notificationType === 'doctor_consultation_started'
  ) {
    targetUrl = '/live-token';
  }

  const notificationOptions = {
    body: notificationBody,
    icon: notificationIcon,
    badge: '/icons/icon-192x192.png',
    tag: uniqueTag, // Unique tag prevents duplicate notifications
    requireInteraction: false,
    silent: false, // Ensure notification makes sound/vibration
    vibrate: [200, 100, 200], // Vibration pattern for mobile (Android only)
    // Only add sound on Android - iOS doesn't support custom sounds for web notifications
    ...(notificationSound && !isIOS && { sound: notificationSound }),
    data: {
      ...payload.data,
      url: payload.data?.url || targetUrl
    }
  };

  if (isIOS) {
    console.log('📱 iOS device detected - custom sound not supported, using system default');
  }

  // Check if this notification was shown recently to prevent duplicates
  const now = Date.now();

  // Check by unique tag
  const recentTime = recentNotifications.get(uniqueTag);
  if (recentTime && (now - recentTime) < DUPLICATE_PREVENTION_WINDOW) {
    console.warn('⚠️ Duplicate notification prevented (by tag):', {
      tag: uniqueTag,
      timeSinceLast: now - recentTime,
      window: DUPLICATE_PREVENTION_WINDOW
    });
    return Promise.resolve();
  }

  // Also check by FCM message ID to prevent duplicates from same message
  if (fcmMessageId) {
    const recentByMessageId = recentNotifications.get(`msg_${fcmMessageId}`);
    if (recentByMessageId && (now - recentByMessageId) < DUPLICATE_PREVENTION_WINDOW) {
      console.warn('⚠️ Duplicate notification prevented (by message ID):', {
        fcmMessageId,
        timeSinceLast: now - recentByMessageId,
        window: DUPLICATE_PREVENTION_WINDOW
      });
      return Promise.resolve();
    }
    recentNotifications.set(`msg_${fcmMessageId}`, now);
  }

  // Mark this notification as shown
  recentNotifications.set(uniqueTag, now);
  // Clean up old entries (older than 1 minute)
  for (const [tag, timestamp] of recentNotifications.entries()) {
    if (now - timestamp > 60000) {
      recentNotifications.delete(tag);
    }
  }

  // Check if notification already shown for this push event
  if (notificationShownForCurrentPush) {
    console.warn('⚠️ Notification already shown for this push event, preventing duplicate');
    return Promise.resolve();
  }

  notificationShownForCurrentPush = true;
  console.log('📨 Showing notification with options:', notificationOptions);

  // Show notification with error handling
  return self.registration.showNotification(notificationTitle, notificationOptions)
    .then(() => {
      console.log('✅ Background notification shown successfully via onBackgroundMessage');
    })
    .catch((error) => {
      console.error('❌ Error showing background notification:', error);
      console.error('Error details:', {
        errorMessage: error.message,
        errorName: error.name,
        notificationTitle,
        hasNotification: !!payload.notification,
        hasData: !!payload.data,
        hasRegistration: !!self.registration
      });
      notificationShownForCurrentPush = false;
    });
});

// Handle push events (required for push subscriptions to work)
self.addEventListener('push', (event) => {
  console.log('📬 Push event received:', event);
  console.log('📬 Push event has data:', !!event.data);

  // Reset flag for new push
  notificationShownForCurrentPush = false;

  // Firebase handles push messages via onBackgroundMessage
  // The push event listener is mainly for logging and as a fallback
  if (event.data) {
    try {
      const payload = event.data.json();
      console.log('📬 Push payload parsed:', payload);
      console.log('📬 Has notification object:', !!payload.notification);

      if (payload.notification) {
        console.log('📬 Notification will be handled by onBackgroundMessage handler');
      }

      // Firebase's onBackgroundMessage will handle showing the notification
      // We don't need to manually show it here to avoid duplicates
    } catch (e) {
      console.error('❌ Error parsing push data:', e);
      console.error('Error message:', e.message);
      console.error('Error stack:', e.stack);
    }
  } else {
    console.log('⚠️ Push event has no data');
  }
});

// Handle notification clicks
self.addEventListener('notificationclick', (event) => {
  console.log('Notification clicked:', event);

  event.notification.close();

  const data = event.notification.data;

  // Use the url from data, or default to appointments page
  let urlToOpen = data?.url || '/appointments';

  // If url is relative, make it absolute
  if (urlToOpen.startsWith('/')) {
    const origin = self.location.origin;
    urlToOpen = `${origin}${urlToOpen}`;
  }

  console.log('Opening URL:', urlToOpen);

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        // Check if there's already a window/tab open matching the origin
        for (const client of clientList) {
          const clientUrl = new URL(client.url, self.location.origin);
          if (clientUrl.origin === self.location.origin && 'focus' in client) {
            client.focus();
            if ('navigate' in client) {
              client.navigate(urlToOpen);
            }
            return;
          }
        }
        // If there's no open window, open a new one
        if (clients.openWindow) {
          return clients.openWindow(urlToOpen);
        }
      })
  );
});



