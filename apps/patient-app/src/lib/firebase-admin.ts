import {
  App,
  cert,
  getApp,
  getApps,
  initializeApp,
  applicationDefault,
} from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

let adminApp: App | null = null;

function initAdminApp(): App {
  if (adminApp) return adminApp;

  if (getApps().length > 0) {
    adminApp = getApp();
    return adminApp;
  }

  const hasServiceAccount =
    process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_CLIENT_EMAIL;

  const projectId =
    process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;

  if (hasServiceAccount) {
    adminApp = initializeApp({
      credential: cert({
        projectId,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
    });
    console.log('✅ Firebase Admin initialized with service account');
    return adminApp;
  }

  adminApp = initializeApp({
    credential: applicationDefault(),
    projectId,
  });
  console.log('✅ Firebase Admin initialized with default credentials');
  return adminApp;
}

export function getAdminApp(): App {
  return initAdminApp();
}

export function getAdminFirestore() {
  return getFirestore(getAdminApp());
}

