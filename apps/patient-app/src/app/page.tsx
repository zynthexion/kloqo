'use client';

import { useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useUser } from '@/firebase/auth/use-user';
import { Skeleton } from '@/components/ui/skeleton';
import { SplashScreen } from '@/components/splash-screen';

function RootPageContent() {
  const { user, loading } = useUser();
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    // Wait until the authentication state is fully loaded
    if (loading) {
      return;
    }

    // If the user is authenticated, always redirect to the home page.
    // This is the definitive destination for any logged-in user hitting the root.
    if (user) {
      router.replace('/home');
      return;
    }

    // If the user is not authenticated, redirect them to the login page.
    const params = new URLSearchParams(searchParams);
    const clinicId = params.get('clinicId')?.trim();
    
    const loginParams = new URLSearchParams();
    if (clinicId) {
      loginParams.set('clinicId', clinicId);
      // Set the post-login redirect destination.
      loginParams.set('redirect', `/consult-today?clinicId=${clinicId}`);
    }
    
    // Redirect to the login page with the appropriate parameters.
    router.replace(`/login?${loginParams.toString()}`);

  }, [user, loading, router, searchParams]);

  // Show minimal skeleton instead of spinner for faster perceived loading
  return (
    <SplashScreen />
  );
}

export default function RootPage() {
  return (
    <Suspense
      fallback={
        <SplashScreen />
      }
    >
      <RootPageContent />
    </Suspense>
  );
}