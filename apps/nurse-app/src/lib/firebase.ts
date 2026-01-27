import { initializeApp, getApps, getApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { initializeAuth, browserLocalPersistence, getAuth, Auth } from "firebase/auth";
import { firebaseConfig } from '@kloqo/shared-firebase';

// Initialize Firebase - Next.js will handle SSR safely
const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();
const db = getFirestore(app);

let auth: Auth;

if (typeof window !== 'undefined' && !getApps().length) {
    // Client-side initialization with persistence
    auth = initializeAuth(app, {
        persistence: browserLocalPersistence,
    });
} else {
    // Server-side or already initialized
    auth = getAuth(app);
}

export { app, db, auth };
