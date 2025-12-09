'use client';

import React, { createContext, useContext, useEffect, useState } from 'react';
import { onAuthStateChanged, signInWithEmailAndPassword, signOut, User as FirebaseUser } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from '@/lib/firebase';

interface AuthContextType {
  user: FirebaseUser | null;
  userRole: string | null;
  loading: boolean;
  isSuperAdmin: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [userRole, setUserRole] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      setUser(firebaseUser);
      
      if (firebaseUser) {
        try {
          const userDoc = await getDoc(doc(db, 'users', firebaseUser.uid));
          if (userDoc.exists()) {
            const userData = userDoc.data();
            setUserRole(userData.role || null);
          } else {
            setUserRole(null);
          }
        } catch (error) {
          console.error('Error fetching user role:', error);
          setUserRole(null);
        }
      } else {
        setUserRole(null);
      }
      
      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  const login = async (email: string, password: string) => {
    try {
      const userCredential = await signInWithEmailAndPassword(auth, email, password);
      console.log('Login successful, user UID:', userCredential.user.uid);
      
      // Try to get user document with retry logic
      let userDoc;
      let attempts = 0;
      const maxAttempts = 3;
      
      while (attempts < maxAttempts) {
        try {
          userDoc = await getDoc(doc(db, 'users', userCredential.user.uid));
          if (userDoc.exists()) break;
        } catch (docError) {
          console.warn(`Attempt ${attempts + 1} failed to read user document:`, docError);
        }
        
        attempts++;
        if (attempts < maxAttempts) {
          // Wait a bit before retrying (exponential backoff)
          await new Promise(resolve => setTimeout(resolve, 500 * attempts));
        }
      }
      
      console.log('User document exists:', userDoc?.exists());
      
      if (userDoc?.exists()) {
        const userData = userDoc.data();
        console.log('User data:', userData);
        console.log('User role:', userData.role);
        
        // Trim and normalize the role for comparison
        const userRole = String(userData.role || '').trim();
        
        if (userRole !== 'superAdmin') {
          console.error('Access denied - role is:', JSON.stringify(userRole), 'expected: superAdmin');
          await signOut(auth);
          throw new Error(`Access denied. SuperAdmin access required. Current role: ${userRole || 'none'}`);
        }
        setUserRole(userRole);
        console.log('Login completed successfully');
      } else {
        console.error('User document does not exist in Firestore after', maxAttempts, 'attempts');
        // Don't sign out immediately - let the useEffect check handle it
        // The role will be null and the redirect will happen
        throw new Error('User not found in database. Please contact support.');
      }
    } catch (error: any) {
      console.error('Login error:', error);
      if (error.code === 'auth/user-not-found' || error.code === 'auth/wrong-password') {
        throw new Error('Invalid email or password.');
      } else if (error.code === 'auth/too-many-requests') {
        throw new Error('Too many failed login attempts. Please try again later.');
      } else if (error.code === 'permission-denied') {
        throw new Error('Permission denied. Make sure Firestore rules are deployed correctly.');
      } else if (error.message) {
        throw error;
      } else {
        throw new Error('Login failed. Please try again.');
      }
    }
  };

  const logout = async () => {
    await signOut(auth);
    setUserRole(null);
  };

  const isSuperAdmin = userRole === 'superAdmin';

  return (
    <AuthContext.Provider value={{ user, userRole, loading, isSuperAdmin, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

