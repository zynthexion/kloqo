import { NextRequest, NextResponse } from 'next/server';
import { getMessaging } from 'firebase-admin/messaging';
import { getAdminApp, getAdminFirestore } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';

const app = getAdminApp();

/**
 * API endpoint to send push notifications
 * This endpoint will be called by the notification service
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export async function OPTIONS(request: NextRequest) {
  /* console.log('🔔 API DEBUG: OPTIONS Request Received'); */
  return NextResponse.json({}, {
    status: 200,
    headers: corsHeaders,
  });
}

export async function POST(request: NextRequest) {
  let dbSuccess = false;
  let fcmSuccess = false;
  let dbError: any = null;
  let fcmError: any = null;
  let requestData: any = {};

  try {
    requestData = await request.json();
    const { fcmToken, title: originalTitle, body: originalBody, data, userId, language } = requestData;

    console.log('🔔 [API-DEBUG] Received notification request:', {
      userId,
      type: data?.type,
      hasFcmToken: !!fcmToken,
      fcmTokenPrefix: fcmToken?.substring(0, 10),
      language
    });

    let finalTitle = originalTitle;
    let finalBody = originalBody;

    // Handle Malayalam Translation
    if (language === 'ml') {
      const mlContent = getMalayalamContent(data?.type, data, originalBody);
      if (mlContent) {
        finalTitle = mlContent.title;
        finalBody = mlContent.body;
      }
    }

    if (!fcmToken) {
      console.error('🔔 [API-DEBUG] FAILURE: Missing fcmToken');
      return NextResponse.json(
        { error: 'Missing required parameters' },
        { status: 400, headers: corsHeaders }
      );
    }

    // 1. Save to Firestore
    if (userId) {
      try {
        console.log(`🔔 [DB-DEBUG] Attempting to save notification for user: ${userId}`);
        const firestore = getAdminFirestore();
        const notifRef = firestore.collection('users').doc(userId).collection('notifications');
        const newDoc = await notifRef.add({
          title: finalTitle,
          body: finalBody,
          data: data || {},
          read: false,
          createdAt: FieldValue.serverTimestamp(),
          timestamp: Date.now(),
        });
        console.log(`🔔 [DB-DEBUG] SUCCESS. Document written with ID: ${newDoc.id}`);
        dbSuccess = true;

        // Cleanup old notifications (non-blocking)
        const headerNotificationsRef = firestore.collection('users').doc(userId).collection('notifications');
        const cleanup = async () => {
          try {
            const snapshot = await headerNotificationsRef.orderBy('createdAt', 'desc').get();
            if (snapshot.size > 50) {
              const batch = firestore.batch();
              snapshot.docs.slice(50).forEach(doc => batch.delete(doc.ref));
              await batch.commit();
            }
          } catch (e) { console.error('Cleanup error', e); }
        };
        cleanup();

      } catch (err) {
        console.error('🔔 [DB-DEBUG] FAILURE. Error saving to Firestore:', err);
        if (err instanceof Error) {
          console.error('🔔 [DB-DEBUG] Error Stack:', err.stack);
        }
        dbSuccess = false;
        dbError = err instanceof Error ? err.message : String(err);
      }
    } else {
      console.warn('🔔 [DB-DEBUG] SKIPPED. No userId provided in request.');
    }

    // 2. Send FCM
    try {
      if (app) {
        console.log('🔔 [FCM-DEBUG] Attempting to send FCM notification via Admin SDK');
        const messageData = {
          ...(data || {}),
          ...(data?.notificationSound && { notificationSound: data.notificationSound }),
        };

        // Determine target URL if not present
        const type = messageData.type;
        let targetUrl = messageData.url;

        if (!targetUrl) {
          if (
            type === 'token_called' ||
            type === 'doctor_consultation_started' ||
            type === 'queue_update' ||
            type === 'appointment_skipped' ||
            type === 'doctor_late' ||
            type === 'appointment_reminder' ||
            (finalTitle && finalTitle.includes('Upcoming Appointment'))
          ) {
            targetUrl = '/live-token';
          } else {
            // Default for others (confirmed, cancelled, rescheduled)
            targetUrl = '/appointments';
          }
        }
        messageData.url = targetUrl;

        // FCM requires all data values to be strings
        // Convert any non-string values to strings to prevent failures
        const stringifiedData: Record<string, string> = {};
        Object.entries(messageData).forEach(([key, value]) => {
          if (value !== null && value !== undefined) {
            stringifiedData[key] = String(value);
          }
        });

        // Create data payload with all necessary info (including title/body)
        // This makes it a "Data-Only" message so the browser doesn't auto-show a notification
        // The Service Worker will handle display manually to prevent duplicates
        const messagePayload = {
          ...stringifiedData,
          title: finalTitle,
          body: finalBody,
          icon: '/icons/icon-192x192.png',
        };

        const message = {
          data: messagePayload,
          token: fcmToken,
          webpush: {
            fcmOptions: {
              link: targetUrl
            }
          },
        };

        const messaging = getMessaging(app);
        const messageId = await messaging.send(message);
        console.log('🔔 [FCM-DEBUG] SUCCESS: FCM notification sent, messageId:', messageId);
        fcmSuccess = true;
      } else {
        console.warn('🔔 [FCM-DEBUG] FAILURE: Firebase Admin not initialized');
        fcmError = 'Firebase Admin SDK not properly initialized';
      }
    } catch (err) {
      console.error('🔔 [FCM-DEBUG] FAILURE: Error sending FCM:', err);
      fcmSuccess = false;
      fcmError = err instanceof Error ? err.message : String(err);
    }

    // 3. Construct Response
    // We consider it a "success" (200) if either DB write or FCM send worked.
    // We return 500 only if BOTH failed (when both were attempted).

    const isPartialSuccess = dbSuccess || fcmSuccess;
    const status = isPartialSuccess ? 200 : 500;

    console.log(`🔔 [API] Notification processing complete. DB Success: ${dbSuccess}, FCM Success: ${fcmSuccess}.`);

    return NextResponse.json({
      success: isPartialSuccess,
      dbSuccess,
      fcmSuccess,
      message: isPartialSuccess ? 'Notification processed' : 'Failed to process notification',
      errors: {
        db: dbError,
        fcm: fcmError
      },
      details: {
        userId: userId,
        fcmTokenPrefix: fcmToken?.substring(0, 10)
      }
    }, {
      status,
      headers: corsHeaders
    });

  } catch (error) {
    console.error('Top-level error in API:', error);
    return NextResponse.json(
      { error: 'Internal Server Error', details: error instanceof Error ? error.message : String(error) },
      {
        status: 500,
        headers: corsHeaders
      }
    );
  }
}

function getMalayalamContent(type: any, data: any, originalBody: string): { title: string, body: string } | null {
  if (!data) return null;

  switch (type) {
    case 'appointment_confirmed':
      const confirmTokenSuffix = data.tokenNumber ? ` ടോക്കൺ: ${data.tokenNumber}` : '';
      return {
        title: 'അപ്പോയിന്റ്മെന്റ് സ്ഥിരീകരിച്ചു',
        body: `ഡോ. ${data.doctorName}-യുമായുള്ള നിങ്ങളുടെ അപ്പോയിന്റ്മെന്റ് ${data.date}, ${data.time}-ന് സ്ഥിരീകരിച്ചു.${confirmTokenSuffix}`
      };
    case 'token_called':
      return {
        title: 'നിങ്ങളുടെ ഊഴമായി!',
        body: `${data.clinicName}-ൽ ഡോ. ${data.doctorName}-നെ കാണാനുള്ള ടോക്കൺ ${data.tokenNumber} ഇപ്പോൾ വിളിക്കുന്നു. ദയവായി ക്ലിനിക്കിലേക്ക് നീങ്ങുക.`
      };
    case 'appointment_cancelled':
      const isPatient = data.cancelledBy === 'patient';
      return {
        title: 'അപ്പോയിന്റ്മെന്റ് റദ്ദാക്കി',
        body: isPatient
          ? `ഡോ. ${data.doctorName}-യുമായുള്ള (തീയതി: ${data.date}, സമയം: ${data.time}) അപ്പോയിന്റ്മെന്റ് റദ്ദാക്കിയിരിക്കുന്നു.`
          : `${data.clinicName}, ഡോ. ${data.doctorName}-യുമായുള്ള (തീയതി: ${data.date}, സമയം: ${data.time}) നിങ്ങളുടെ അപ്പോയിന്റ്മെന്റ് റദ്ദാക്കി.`
      };
    case 'doctor_late':
      return {
        title: 'ഡോക്ടർ വൈകുന്നു',
        body: `${data.clinicName}-ലെ ഡോ. ${data.doctorName} ഏകദേശം ${data.delayMinutes} മിനിറ്റ് വൈകിയാണ് നടക്കുന്നത്.`
      };
    case 'appointment_rescheduled':
      return {
        title: 'സമയക്രമം മാറ്റി',
        body: `${data.clinicName}, ഡോ. ${data.doctorName}-യുമായുള്ള അപ്പോയിന്റ്മെന്റ് സമയം മാറ്റിയിരിക്കുന്നു. പുതിയ സമയം: ${data.newTime}.`
      };
    case 'appointment_skipped':
      return {
        title: 'അപ്പോയിന്റ്മെന്റ് സ്കിപ്പ് ചെയ്തു',
        body: `കൃത്യസമയത്ത് റിപ്പോർട്ട് ചെയ്യാത്തതിനാൽ ഡോ. ${data.doctorName}-യുമായുള്ള നിങ്ങളുടെ അപ്പോയിന്റ്മെന്റ് (ടോക്കൺ: ${data.tokenNumber}) സ്കിപ്പ് ചെയ്തിരിക്കുന്നു.`
      };
    case 'queue_update':
      const count = data.peopleAhead;
      const personText = count === 1 ? 'ഒരാൾ' : `${count} പേർ`;
      if (count === 0) {
        return {
          title: 'നിങ്ങളാണ് അടുത്തത്!',
          body: `നിങ്ങൾക്ക് മുമ്പിൽ 0 ആളുകൾ. ഡോ. ${data.doctorName}-നെ കാണാൻ നിങ്ങൾക്കാണ് അടുത്ത ഊഴം.`
        };
      }
      return {
        title: `ക്യൂ അപ്‌ഡേറ്റ്: ${count} പേർ മുന്നിലുണ്ട്`,
        body: `നിങ്ങൾക്ക് മുമ്പിൽ ${personText} ഉണ്ട്. ഡോ. ${data.doctorName}-നെ കാണാനുള്ള നിങ്ങളുടെ ഊഴം അടുത്തു വരുന്നു.`
      };
    case 'doctor_consultation_started':
      return {
        title: 'കൺസൾട്ടേഷൻ ആരംഭിച്ചു',
        body: `ഡോ. ${data.doctorName}, ${data.clinicName}-ൽ കൺസൾട്ടേഷൻ ആരംഭിച്ചു. നിങ്ങളുടെ സമയം: ${data.appointmentTime}.`
      };
    case 'appointment_reminder':
      const tokenSuffix = data.tokenNumber ? ` ടോക്കൺ: ${data.tokenNumber}` : '';
      return {
        title: 'വരാനിരിക്കുന്ന അപ്പോയിന്റ്മെന്റ്',
        body: `ഡോ. ${data.doctorName}-യുമായുള്ള നിങ്ങളുടെ അപ്പോയിന്റ്മെന്റ് 2 മണിക്കൂറിനുള്ളിൽ ${data.time}-ന് ആണ്.${tokenSuffix}`
      };
    case 'free_followup_expiry':
      return {
        title: 'സൗജന്യ പരിശോധന അവസാനിക്കുന്നു',
        body: `ഡോ. ${data.doctorName}-നെ സൗജന്യമായി കാണാൻ 3 ദിവസങ്ങൾ കൂടി മാത്രം.`
      };
    default:
      return null;
  }
}


