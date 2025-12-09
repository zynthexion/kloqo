export * from './config';
// Re-export other firebase utilities if needed, or keep this simple for now
import { initializeApp, getApps, getApp, type FirebaseApp } from 'firebase/app';
import { firebaseConfig } from './config';

export function getServerFirebaseApp(): FirebaseApp {
    if (getApps().length > 0) {
        return getApp();
    }
    return initializeApp(firebaseConfig);
}

export function getClientFirebaseApp(): FirebaseApp {
    if (getApps().length > 0) {
        return getApp();
    }
    return initializeApp(firebaseConfig);
}
import { getFirestore, type Firestore } from 'firebase/firestore';

export function getDb(): Firestore {
    return getFirestore(getClientFirebaseApp());
}

export const db = getDb();
