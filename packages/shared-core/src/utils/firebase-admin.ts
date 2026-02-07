
import * as admin from 'firebase-admin';

export function getFirebaseAdmin() {
    if (admin.apps.length > 0) {
        return admin.app();
    }

    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

    if (!projectId || !clientEmail || !privateKey) {
        throw new Error('Missing Firebase Admin configuration in environment variables.');
    }

    return admin.initializeApp({
        credential: admin.credential.cert({
            projectId,
            clientEmail,
            privateKey,
        }),
    });
}

export const getServerFirebaseApp = getFirebaseAdmin;
