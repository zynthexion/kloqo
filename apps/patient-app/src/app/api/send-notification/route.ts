import { NextRequest, NextResponse } from 'next/server';
import { getMessaging } from 'firebase-admin/messaging';
import { getAdminApp } from '@/lib/firebase-admin';

const app = getAdminApp();

/**
 * API endpoint to send push notifications
 * This endpoint will be called by the notification service
 */

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}

export async function POST(request: NextRequest) {
  try {
    console.log('🔔 API DEBUG: Received notification request');
    const { fcmToken, title, body, data } = await request.json();
    console.log('🔔 API DEBUG: Request data:', {
      hasFCMToken: !!fcmToken,
      fcmTokenLength: fcmToken?.length,
      title,
      body,
      dataType: data?.type
    });

    if (!fcmToken || !title || !body) {
      console.error('🔔 API DEBUG: Missing required parameters');
      return NextResponse.json(
        { error: 'Missing required parameters' },
        { 
          status: 400,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          }
        }
      );
    }

    // In production, use Firebase Admin SDK to send notification
    // For now, we're using the Firebase console or external service
    
    console.log('🔔 API DEBUG: Notification request:', {
      fcmToken: fcmToken.substring(0, 20) + '...',
      title,
      body,
      type: data?.type,
    });

    // Send notification using Firebase Admin SDK
    let fcmSuccess = false;
    let fcmError: any = null;
    
    try {
      if (app) {
        console.log('🔔 API DEBUG: Attempting to send FCM notification');
        // Support custom notification sound via data.notificationSound
        // Sound file should be placed in /public/sounds/ directory
        const message = {
          notification: { title, body },
          data: {
            ...(data || {}),
            // Include notificationSound in data so service worker can access it
            // The service worker will use this to set the notification sound
            ...(data?.notificationSound && { notificationSound: data.notificationSound }),
          },
          token: fcmToken,
          webpush: {
            notification: {
              title,
              body,
              icon: '/icons/icon-192x192.png',
              badge: '/icons/icon-192x192.png',
              // Note: Sound is handled by service worker, not in webpush config
            },
          },
        };

        const messaging = getMessaging(app);
        console.log('🔔 API DEBUG: Calling messaging.send()');
        const messageId = await messaging.send(message);
        console.log('🔔 API DEBUG: FCM notification sent successfully:', messageId);
        fcmSuccess = true;
      } else {
        console.warn('🔔 API DEBUG: Firebase Admin not initialized');
        fcmError = { code: 'FIREBASE_NOT_INITIALIZED', message: 'Firebase Admin SDK not properly initialized' };
      }
    } catch (fcmErrorCaught) {
      fcmError = fcmErrorCaught;
      console.error('🔔 API DEBUG: FCM send error:', fcmErrorCaught);
      if (fcmErrorCaught instanceof Error) {
        console.error('🔔 API DEBUG: FCM error message:', fcmErrorCaught.message);
        console.error('🔔 API DEBUG: FCM error code:', (fcmErrorCaught as any).code);
        console.error('🔔 API DEBUG: FCM error stack:', fcmErrorCaught.stack);
        
        // Log specific FCM error codes
        const errorCode = (fcmErrorCaught as any).code;
        if (errorCode === 'messaging/invalid-registration-token' || errorCode === 'messaging/registration-token-not-registered') {
          console.error('🔔 API DEBUG: ⚠️ INVALID TOKEN - Token is expired or invalid. User needs to refresh their FCM token.');
        } else if (errorCode === 'messaging/invalid-argument') {
          console.error('🔔 API DEBUG: ⚠️ INVALID ARGUMENT - Check token format and message structure.');
        } else if (errorCode === 'messaging/unavailable') {
          console.error('🔔 API DEBUG: ⚠️ FCM SERVICE UNAVAILABLE - Firebase service is temporarily down.');
        }
      }
    }

    // Return response with FCM status
    const responseData: any = {
      success: fcmSuccess,
      message: fcmSuccess ? 'Notification sent successfully' : 'Failed to send notification',
    };

    // Always include details in response for debugging
    responseData.details = {
      fcmSuccess,
      ...(fcmError && {
        error: fcmError.message || 'Unknown error',
        code: (fcmError as any).code || 'UNKNOWN',
        errorInfo: fcmError,
      }),
      fcmToken: fcmToken.substring(0, 20) + '...',
      title,
      body,
    };

    return NextResponse.json(
      responseData,
      { 
        status: fcmSuccess ? 200 : 500,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        }
      }
    );
  } catch (error) {
    console.error('🔔 API DEBUG: Error sending notification:', error);
    if (error instanceof Error) {
      console.error('🔔 API DEBUG: Error message:', error.message);
      console.error('🔔 API DEBUG: Error stack:', error.stack);
    }
    return NextResponse.json(
      { error: 'Failed to send notification' },
      { 
        status: 500,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        }
      }
    );
  }
}


