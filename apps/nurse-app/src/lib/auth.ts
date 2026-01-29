import { signInWithEmailAndPassword, signOut, onAuthStateChanged } from 'firebase/auth';
import { auth } from './firebase';
import { doc, getDoc } from 'firebase/firestore';
import { db } from './firebase';
import { User } from './types';

export async function loginNurse(email: string, password: string): Promise<User> {
  try {
    const userCredential = await signInWithEmailAndPassword(auth, email, password);
    const user = userCredential.user;

    // Get additional user data from Firestore
    const userDoc = await getDoc(doc(db, 'users', user.uid));
    const userData = userDoc.data();

    if (!userData) {
      const error = new Error('User data not found');
      error.name = 'UserDataNotFound';
      throw error;
    }

    if (userData.role !== 'clinicAdmin') {
      const error = new Error('User does not have clinic admin access');
      error.name = 'AccessDenied';
      throw error;
    }

    // Return user with additional data
    return {
      uid: user.uid,
      phone: userData.phone,
      role: userData.role,
      clinicId: userData.clinicId,
      email: userData.email,
      name: userData.name,
      designation: userData.designation,
      onboarded: userData.onboarded
    } as User;

  } catch (error) {
    console.error('Nurse login error:', error);
    throw error;
  }
}

export async function logoutNurse(): Promise<void> {
  try {
    await signOut(auth);
  } catch (error) {
    console.error('Logout error:', error);
    throw error;
  }
}

export function onAuthStateChange(callback: (user: User | null) => void) {
  return onAuthStateChanged(auth, async (user) => {
    if (user) {
      try {
        // Get additional user data from Firestore
        const userDoc = await getDoc(doc(db, 'users', user.uid));
        const userData = userDoc.data();

        if (userData) {
          callback({
            uid: user.uid,
            phone: userData.phone,
            role: userData.role,
            clinicId: userData.clinicId,
            email: userData.email,
            name: userData.name,
            designation: userData.designation,
            onboarded: userData.onboarded
          } as User);
        } else {
          callback(null);
        }
      } catch (error: any) {
        console.error('[Auth-Debug] ❌ Error getting user data from Firestore:', error);
        // Log additional info if available (e.g. error code)
        if (error.code) console.error(`[Auth-Debug] Error Code: ${error.code}`);
        callback(null);
      }
    } else {
      callback(null);
    }
  });
}

export { auth };
