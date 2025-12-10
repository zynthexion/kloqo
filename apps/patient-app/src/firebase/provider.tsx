'use client';
import { createContext, useContext } from 'react';
import type { FirebaseApp } from 'firebase/app';
import type { Auth } from 'firebase/auth';
import type { Firestore } from 'firebase/firestore';
import { FirebaseErrorListener } from '@/components/FirebaseErrorListener';

type FirebaseContextType = {
  firebaseApp: FirebaseApp | null;
  firestore: Firestore | null;
  auth: Auth | null;
};

const FirebaseContext = createContext<FirebaseContextType>({
  firebaseApp: null,
  firestore: null,
  auth: null,
});

export const FirebaseProvider = ({
  children,
  ...props
}: {
  children: React.ReactNode;
  firebaseApp: FirebaseApp;
  firestore: Firestore;
  auth: Auth;
}) => {
  return (
    <FirebaseContext.Provider value={props}>
      {children}
      <FirebaseErrorListener />
    </FirebaseContext.Provider>
  );
};

export const useFirebase = () => useContext(FirebaseContext);

export const useFirebaseApp = () => {
  const { firebaseApp } = useFirebase();
  if (!firebaseApp) {
    if (typeof window === 'undefined') {
      // During SSR/prerendering, return null
      return null;
    }
    // On client side, throw error if provider is missing
    throw new Error('useFirebaseApp must be used within a FirebaseProvider');
  }
  return firebaseApp;
};

export const useFirestore = () => {
  const { firestore } = useFirebase();
  // During prerendering/build time, firestore might not be available
  // Return null instead of throwing to allow build to succeed
  if (!firestore) {
    if (typeof window === 'undefined') {
      // During SSR/prerendering, return null
      return null;
    }
    // On client side, throw error if provider is missing
    throw new Error('useFirestore must be used within a FirebaseProvider');
  }
  return firestore;
};

export const useAuth = () => {
  const { auth } = useFirebase();
  if (!auth) {
    if (typeof window === 'undefined') {
      // During SSR/prerendering, return null
      return null;
    }
    // On client side, throw error if provider is missing
    throw new Error('useAuth must be used within a FirebaseProvider');
  }
  return auth;
};
