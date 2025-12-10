
"use client";

import { Sidebar } from '@/components/layout/sidebar';
import { OnboardingCheck } from '@/components/onboarding/onboarding-check';
import { Suspense, useEffect } from 'react';
import { useAuth } from '@/firebase';
import { useRouter } from 'next/navigation';
import { FirebaseErrorListener } from '@/components/FirebaseErrorListener';
import { useAppointmentStatusUpdater } from '@/hooks/useAppointmentStatusUpdater';
import { useDoctorStatusUpdater } from '@/hooks/useDoctorStatusUpdater';
import { AuthProvider } from './auth-provider';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { GlobalErrorHandler } from '@/components/GlobalErrorHandler';

function AppContent({ children }: { children: React.ReactNode }) {
  const { currentUser, loading } = useAuth();
  const router = useRouter();

  // Custom hooks to handle automatic status updates
  useAppointmentStatusUpdater(); // Updates appointment statuses and sets doctors to 'Out'
  useDoctorStatusUpdater(); // Auto-sets doctors to 'Out' when outside availability (In status is manual only)

  useEffect(() => {
    if (!loading && !currentUser) {
      router.push('/');
    }
  }, [currentUser, loading, router]);
  
  if (loading || !currentUser) {
    return (
        <div className="flex h-screen w-full items-center justify-center">
            <p>Loading...</p>
        </div>
    );
  }

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
