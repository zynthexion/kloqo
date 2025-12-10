
'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import AppFrameLayout from "@/components/layout/app-frame";
import HomePage from "@/components/clinic/home-page";
import { Loader2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';

export default function Home() {
  const router = useRouter();
  const { user, loading } = useAuth();

  useEffect(() => {
    if (!loading && !user) {
      router.replace('/login');
    }
  }, [user, loading, router]);

  if (loading) {
    return (
      <AppFrameLayout>
        <div className="flex h-full w-full items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin" />
        </div>
      </AppFrameLayout>
    );
  }

  if (!user) {
    // Still loading or redirecting
    return (
      <AppFrameLayout>
        <div className="flex h-full w-full items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin" />
        </div>
      </AppFrameLayout>
    );
  }

  return (
    <AppFrameLayout showBottomNav>
      <HomePage />
    </AppFrameLayout>
  );
}
