import { NextRequest, NextResponse } from 'next/server';
import { getFirestore, doc, setDoc, getDoc, collection, query, where, getDocs } from 'firebase/firestore/lite';
import { getServerFirebaseApp } from '@/lib/firebase-server-app';
import { Patient } from '@/lib/types';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 200,
    headers: corsHeaders,
  });
}

// GET handler to retrieve notification settings
export async function GET(request: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
  try {
    const { userId } = await params;
    const firestore = getFirestore(getServerFirebaseApp());
    const userRef = doc(firestore, 'users', userId);
    
    const userDoc = await getDoc(userRef);
    
    if (!userDoc.exists()) {
      return NextResponse.json(
        { error: 'User not found' },
        {
          status: 404,
          headers: corsHeaders,
        }
      );
    }

    const userData = userDoc.data();
    
    return NextResponse.json(
      {
        fcmToken: userData.fcmToken || null,
        notificationsEnabled: userData.notificationsEnabled || false,
        notificationPermissionGranted: userData.notificationPermissionGranted || false,
        fcmTokenUpdatedAt: userData.fcmTokenUpdatedAt || null,
      },
      {
        headers: corsHeaders,
      }
    );
  } catch (error) {
    console.error('[notifications] Failed to get notification settings', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { error: 'Failed to get notification settings', details: errorMessage },
      {
        status: 500,
        headers: corsHeaders,
      }
    );
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
  try {
    const { userId } = await params;
    const firestore = getFirestore(getServerFirebaseApp());
    const userRef = doc(firestore, 'users', userId);
    const payload = await request.json();

    // Get user document first to check for patientId and phone before updating
    const userDocBeforeUpdate = await getDoc(userRef);
    const userDataBeforeUpdate = userDocBeforeUpdate.exists() ? userDocBeforeUpdate.data() : {};
    const patientId = userDataBeforeUpdate.patientId || payload.patientId;

    // Save FCM token directly to primaryUserId from patient document (NOT to userId)
    if (payload.fcmToken) {
      let primaryUserIdToSave: string | null = null;
      
      // Step 1: Find patient document
      let patientIdToUse: string | null = patientId || null;
      
      // Step 2: If no patientId, try to find patient by phone number
      if (!patientIdToUse) {
        const phoneToSearch = userDataBeforeUpdate.phone || userDataBeforeUpdate.phoneNumber;
        if (phoneToSearch) {
          try {
            const patientsQuery = query(
              collection(firestore, 'patients'),
              where('phone', '==', phoneToSearch)
            );
            const patientsSnapshot = await getDocs(patientsQuery);
            if (!patientsSnapshot.empty) {
              const primaryPatient = patientsSnapshot.docs.find(d => d.data().isPrimary) || patientsSnapshot.docs[0];
              patientIdToUse = primaryPatient.id;
            }
          } catch (error) {
            // Silent fail - continue with patient lookup
          }
        }
      }
      
      // Step 3: Get primaryUserId directly from patient document
      if (patientIdToUse) {
        try {
          const patientDocRef = doc(firestore, 'patients', patientIdToUse);
          const patientDoc = await getDoc(patientDocRef);
          if (patientDoc.exists()) {
            const patientData = patientDoc.data() as Patient;
            primaryUserIdToSave = patientData.primaryUserId || null;
          }
        } catch (error) {
          console.error('[notifications] Error getting primaryUserId from patient document:', error);
        }
      }
      
      // Save token to primaryUserId document (NOT to logged-in user's userId)
      if (primaryUserIdToSave) {
        try {
          const primaryUserRef = doc(firestore, 'users', primaryUserIdToSave);
          await setDoc(
            primaryUserRef,
            {
              fcmToken: payload.fcmToken,
              notificationsEnabled: payload.notificationsEnabled !== undefined ? payload.notificationsEnabled : true,
              notificationPermissionGranted: payload.notificationPermissionGranted !== undefined ? payload.notificationPermissionGranted : true,
              fcmTokenUpdatedAt: payload.fcmTokenUpdatedAt || new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
            { merge: true }
          );
        } catch (saveError) {
          console.error('[notifications] Failed to save token to primaryUserId:', saveError);
          throw saveError; // Fail if we can't save to primaryUserId
        }
      } else {
        console.error('[notifications] Cannot save FCM token - primaryUserId not found in patient document');
        return NextResponse.json(
          { error: 'Cannot save FCM token - primaryUserId not found in patient document' },
          {
            status: 400,
            headers: corsHeaders,
          }
        );
      }
    }

    return NextResponse.json(
      { success: true },
      {
        headers: corsHeaders,
      }
    );
  } catch (error) {
    console.error('[notifications] Failed to update notification settings', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const errorCode = (error as any)?.code || 'UNKNOWN';
    return NextResponse.json(
      { error: 'Failed to update notification settings', details: errorMessage, code: errorCode },
      {
        status: 500,
        headers: corsHeaders,
      }
    );
  }
}

