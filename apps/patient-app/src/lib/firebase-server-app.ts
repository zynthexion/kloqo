import type { FirebaseApp } from 'firebase/app';
import { getApp, getApps, initializeApp } from 'firebase/app';
import { firebaseConfig } from '@kloqo/shared-firebase';

let serverApp: FirebaseApp | null = null;

export function getServerFirebaseApp(): FirebaseApp {
  if (serverApp) {
    return serverApp;
  }

  const existing = getApps().find((app) => app.name === 'server-lite');
  if (existing) {
    serverApp = existing;
  } else {
    serverApp = initializeApp(firebaseConfig, 'server-lite');
  }

  return serverApp;
}









