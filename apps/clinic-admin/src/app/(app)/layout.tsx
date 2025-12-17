
"use client";

import { Sidebar } from '@/components/layout/sidebar';
import { OnboardingCheck } from '@/components/onboarding/onboarding-check';
import { Suspense, useEffect, useState } from 'react';
import { useAuth } from '@/firebase';
import { useRouter } from 'next/navigation';
import { FirebaseErrorListener } from '@/components/FirebaseErrorListener';
import { useAppointmentStatusUpdater } from '@/hooks/useAppointmentStatusUpdater';
import { useDoctorStatusUpdater } from '@/hooks/useDoctorStatusUpdater';
import { AuthProvider } from './auth-provider';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { GlobalErrorHandler } from '@/components/GlobalErrorHandler';
import { doc, getDoc } from 'firebase/firestore';
import { db, auth } from '@/lib/firebase';
import { signOut } from 'firebase/auth';

function AuthorizedLayout({ children }: { children: React.ReactNode }) {
  // Custom hooks to handle automatic status updates
  useAppointmentStatusUpdater(); // Updates appointment statuses and sets doctors to 'Out'
  useDoctorStatusUpdater(); // Auto-sets doctors to 'Out' when outside availability (In status is manual only)

  return (
    <Suspense fallback={<div className="flex h-screen w-full items-center justify-center"><p>Loading...</p></div>}>
      <ErrorBoundary>
        <div className="flex h-full">
          <OnboardingCheck />
          <FirebaseErrorListener />
          <GlobalErrorHandler />
          <Sidebar />
          <div className="flex-1 flex flex-col h-full overflow-y-auto">
            {children}
          </div>
        </div>
      </ErrorBoundary>
    </Suspense>
  );
}

function AppContent({ children }: { children: React.ReactNode }) {
  const { currentUser, loading } = useAuth();
  const router = useRouter();
  const [isVerifying, setIsVerifying] = useState(true);

  useEffect(() => {
    if (loading) return;

    if (!currentUser) {
      router.push('/');
      return;
    }

    const checkClinicId = async () => {
      try {
        const userDocRef = doc(db, 'users', currentUser.uid);
        const userDoc = await getDoc(userDocRef);
        const userData = userDoc.data();

        if (!userData?.clinicId) {
          console.error("No clinicId found for user. Logging out.");
          await signOut(auth);
          router.push('/');
        } else {
          // Clinic ID exists, allow access
          setIsVerifying(false);
        }
      } catch (error) {
        console.error("Error verifying clinicId:", error);
        // Fail safe: logout
        await signOut(auth);
        router.push('/');
      }
    };

    checkClinicId();
  }, [currentUser, loading, router]);

  if (loading || isVerifying) {
    return (
      <div className="flex h-screen w-full items-center justify-center">
        <p>Loading...</p>
      </div>
    );
  }

  return <AuthorizedLayout>{children}</AuthorizedLayout>;
}


export default function AppLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <AuthProvider>
      <AppContent>{children}</AppContent>
    </AuthProvider>
  );
}
