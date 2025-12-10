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
    if (!firestore || !user?.uid) return;

    const refreshTokenOnLoad = async () => {
      try {
        // Get current token from Firestore
        const userDoc = await getDoc(doc(firestore, 'users', user.uid));
        const storedToken = userDoc.exists() ? userDoc.data()?.fcmToken : null;
        setCurrentToken(storedToken);
        
        // Always refresh token on app load to ensure it's valid
        // This handles cases where token became invalid
        const { getFCMToken } = await import('@/lib/firebase-messaging');
        const { isNotificationEnabled } = await import('@/lib/firebase-messaging');
        
        if (isNotificationEnabled()) {
              const newToken = await getFCMToken();
          
          // Check if we're on localhost (for better error messages)
          const isLocalhost = typeof window !== 'undefined' && 
            (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
          
          if (newToken) {
            // Check if we need to update (new token or notifications not enabled)
            const userData = userDoc.exists() ? userDoc.data() : {};
            const needsUpdate = newToken !== storedToken || !userData.notificationsEnabled;
            
            if (needsUpdate) {
              try {
                // Find primaryUserId from patient document and save token directly to it
                let primaryUserIdToSave: string | null = null;
                
                // Step 1: Find the patient document associated with logged-in user
                let patientIdToUse: string | null = user.patientId || null;
                if (!patientIdToUse && userDoc.exists()) {
                  const userDocData = userDoc.data();
                  patientIdToUse = userDocData.patientId || null;
                }
                
                // Step 2: If no patientId, try to find patient by phone number
                if (!patientIdToUse) {
                  const phoneToSearch = user.phoneNumber || (userDoc.exists() ? userDoc.data()?.phone || userDoc.data()?.phoneNumber : null);
                  if (phoneToSearch) {
                    try {
                      const { collection, query: firestoreQuery, where: firestoreWhere, getDocs } = await import('firebase/firestore');
                      const patientsQuery = firestoreQuery(
                        collection(firestore, 'patients'),
                        firestoreWhere('phone', '==', phoneToSearch)
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
                    const patientDoc = await getDoc(doc(firestore, 'patients', patientIdToUse));
                    if (patientDoc.exists()) {
                      const patientData = patientDoc.data() as Patient;
                      primaryUserIdToSave = patientData.primaryUserId || null;
                    }
                  } catch (error) {
                    console.error('[MessagingInitializer] Error getting primaryUserId from patient document:', error);
                  }
                }
                
                // Save token to primaryUserId document (NOT to logged-in user's UID)
                if (primaryUserIdToSave) {
                  try {
                    await setDoc(
                      doc(firestore, 'users', primaryUserIdToSave),
                      {
                        fcmToken: newToken,
                        notificationsEnabled: true,
                        notificationPermissionGranted: true,
                        fcmTokenUpdatedAt: new Date().toISOString(),
                      },
                      { merge: true }
                    );
                  } catch (saveError) {
                    console.error('[MessagingInitializer] Failed to save token to primaryUserId:', saveError);
                    throw saveError; // Fail if we can't save to primaryUserId
                  }
                } else {
                  console.error('[MessagingInitializer] Cannot save FCM token - primaryUserId not found in patient document');
                }

                setCurrentToken(newToken);
              } catch (saveError) {
                console.error('[MessagingInitializer] Failed to save token to Firestore:', saveError);
              }
            }
          }
        }
      } catch (error) {
        // Silent fail for token generation errors
      }
    };

    refreshTokenOnLoad();
  }, [firestore, user?.uid]);

  // Setup token refresh listener
  useEffect(() => {
    if (!firestore || !user?.uid) return;

    const cleanup = setupTokenRefreshListener(
      async (newToken) => {
        // Update token in Firestore when it refreshes
        // Also ensure notificationsEnabled is set to true if we have a token
        try {
          // Find primaryUserId from patient document and save token directly to it
          let primaryUserIdToSave: string | null = null;
          
          // Step 1: Find the patient document associated with logged-in user
          let patientIdToUse: string | null = user.patientId || null;
          if (!patientIdToUse) {
            try {
              const userDocRef = doc(firestore, 'users', user.uid);
              const userDocSnap = await getDoc(userDocRef);
              if (userDocSnap.exists()) {
                const userDocData = userDocSnap.data();
                patientIdToUse = userDocData.patientId || null;
              }
            } catch (error) {
              // Silent fail - continue with patient lookup
            }
          }
          
          // Step 2: If no patientId, try to find patient by phone number
          if (!patientIdToUse) {
            const phoneToSearch = user.phoneNumber || null;
            if (phoneToSearch) {
              try {
                const { collection, query: firestoreQuery, where: firestoreWhere, getDocs } = await import('firebase/firestore');
                const patientsQuery = firestoreQuery(
                  collection(firestore, 'patients'),
                  firestoreWhere('phone', '==', phoneToSearch)
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
              const patientDoc = await getDoc(doc(firestore, 'patients', patientIdToUse));
              if (patientDoc.exists()) {
                const patientData = patientDoc.data() as Patient;
                primaryUserIdToSave = patientData.primaryUserId || null;
              }
            } catch (error) {
              console.error('[MessagingInitializer] Error getting primaryUserId from patient document:', error);
            }
          }
          
          // Save token to primaryUserId document (NOT to logged-in user's UID)
          if (primaryUserIdToSave) {
            try {
              await setDoc(
                doc(firestore, 'users', primaryUserIdToSave),
                {
                  fcmToken: newToken,
                  notificationsEnabled: true,
                  notificationPermissionGranted: true,
                  fcmTokenUpdatedAt: new Date().toISOString(),
                },
                { merge: true }
              );
            } catch (saveError) {
              console.error('[MessagingInitializer] Failed to save token to primaryUserId:', saveError);
              throw saveError; // Fail if we can't save to primaryUserId
            }
          } else {
            console.error('[MessagingInitializer] Cannot save FCM token - primaryUserId not found in patient document');
          }

          setCurrentToken(newToken); // Update local state
        } catch (saveError) {
          console.error('[MessagingInitializer] Failed to save refreshed token to Firestore:', saveError);
          // Still update local state even if Firestore save fails
          setCurrentToken(newToken);
        }
      },
      currentToken, // Pass current token for comparison
      5 * 60 * 1000 // Check every 5 minutes
    );

    // Cleanup on unmount
    return cleanup;
  }, [firestore, user?.uid, currentToken]);

  return null;
}



