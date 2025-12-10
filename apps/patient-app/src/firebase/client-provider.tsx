'use client';
import { useState, useEffect } from 'react';
import { initializeFirebase } from '@/firebase';
import { FirebaseProvider } from '@/firebase/provider';
import { UserProvider } from './auth/use-user';
import { Skeleton } from '@/components/ui/skeleton';

export function FirebaseClientProvider({ children }: { children: React.ReactNode }) {
  const [firebaseInstances, setFirebaseInstances] = useState<{
    firebaseApp: any;
    firestore: any;
    auth: any;
  } | null>(null);

  useEffect(() => {
    // Only initialize Firebase on the client side
    const { firebaseApp, firestore, auth } = initializeFirebase();
    setFirebaseInstances({ firebaseApp, firestore, auth });
  }, []);

  if (!firebaseInstances) {
    // Return a minimal skeleton during SSR/hydration for faster perceived loading
    return (
      <div className="flex h-screen w-full items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4">
          <Skeleton className="h-12 w-12 rounded-full" />
          <Skeleton className="h-4 w-32" />
        </div>
      </div>
    );
  }

  return (
    <FirebaseProvider firebaseApp={firebaseInstances.firebaseApp} firestore={firebaseInstances.firestore} auth={firebaseInstances.auth}>
      <UserProvider>{children}</UserProvider>
    </FirebaseProvider>
  );
}
