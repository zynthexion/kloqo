
"use client";

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useAuth } from '@/firebase';

export function OnboardingCheck() {
  const auth = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!auth.currentUser || auth.loading) return;
    
    // If the user is already on the onboarding page, don't do anything.
    if (pathname === '/onboarding') return;

    const checkOnboardingStatus = async () => {
      try {
        const userDocRef = doc(db, "users", auth.currentUser!.uid);
        const userDoc = await getDoc(userDocRef);

        if (userDoc.exists()) {
          const userData = userDoc.data();
          const clinicId = userData.clinicId;

          if (clinicId) {
            const clinicDocRef = doc(db, "clinics", clinicId);
            const clinicDoc = await getDoc(clinicDocRef);

            if (clinicDoc.exists()) {
              const clinicData = clinicDoc.data();
              
              // First check registration status
              const registrationStatus = clinicData.registrationStatus;
              
              if (registrationStatus === 'Pending') {
                // Redirect to registration status page
                router.push('/registration-status');
                return;
              }
              
              if (registrationStatus === 'Rejected') {
                // Redirect to registration status page
                router.push('/registration-status');
                return;
              }
              
              // Only check onboarding status if registration is approved (or not set for backward compatibility)
              if (registrationStatus === 'Approved' || !registrationStatus) {
                // Redirect to onboarding if the clinic's onboarding status is "Pending"
                if (clinicData.onboardingStatus === "Pending") {
                  router.push('/onboarding');
                }
                // If "Completed", do nothing and let the user access the app.
              }
            } else {
              // Clinic document doesn't exist, something is wrong, go to onboarding.
              router.push('/onboarding');
            }
          } else {
            // No clinicId on user, go to onboarding.
            router.push('/onboarding');
          }
        } else {
          // User document doesn't exist, go to onboarding.
          router.push('/onboarding');
        }
      } catch (error) {
        console.error("Error checking onboarding status:", error);
        // In case of an error, it might be safer to redirect to a safe page or show an error,
        // but for now, we'll let them stay. A more robust app might redirect to an error page.
      }
    };

    checkOnboardingStatus();

  }, [auth.currentUser, auth.loading, router, pathname]);

  return null;
}
