import { initializeApp, getApps, getApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth, setPersistence, browserLocalPersistence } from "firebase/auth";
import { firebaseConfig } from '@kloqo/shared-firebase';

// Initialize Firebase - Next.js will handle SSR safely
const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();
const db = getFirestore(app);
const auth = getAuth(app);

// Explicitly set persistence to local to survive browser/app restarts
if (typeof window !== 'undefined') {
    setPersistence(auth, browserLocalPersistence).catch((err) => {
        console.error("Firebase persistence error:", err);
    });
}

export { app, db, auth };
