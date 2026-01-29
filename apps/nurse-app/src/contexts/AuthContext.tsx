'use client';

import React, { createContext, useContext, useEffect, useState } from 'react';
import { onAuthStateChange } from '@/lib/auth';
import { User } from '@/lib/types';

interface AuthContextType {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<User>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Only run in browser (not during SSR)
    if (typeof window === 'undefined') {
      setLoading(false);
      return;
    }

    const startTimestamp = Date.now();
    let timeoutId: NodeJS.Timeout;
    console.log(`[Auth-Debug] Initializing Auth listener...`);

    try {
      const unsubscribe = onAuthStateChange((user) => {
        const elapsed = Date.now() - startTimestamp;
        if (user) {
          console.log(`[Auth-Debug] User detected after ${elapsed}ms: ${user.email} (Clinic: ${user.clinicId})`);
          // Sync localStorage if it's missing but user is logged in
          if (!localStorage.getItem('clinicId') && user.clinicId) {
            console.log(`[Auth-Debug] Syncing missing localStorage from Firebase user data.`);
            localStorage.setItem('clinicId', user.clinicId);
            localStorage.setItem('user', JSON.stringify({
              id: user.uid,
              email: user.email,
              name: user.name,
              clinicId: user.clinicId
            }));
          }
        } else {
          console.log(`[Auth-Debug] No user detected after ${elapsed}ms.`);
        }
        setUser(user);
        setLoading(false);
        if (timeoutId) clearTimeout(timeoutId);
      });

      // Fallback timeout: if Firebase doesn't respond in 12 seconds, stop loading
      // Increased from 3s to 12s to allow for slow mobile PWA cold starts
      timeoutId = setTimeout(() => {
        const elapsed = Date.now() - startTimestamp;
        console.warn(`[Auth-Debug] ⚠️ Auth state check timeout after ${elapsed}ms - proceeding to prevent infinite hang.`);
        setLoading(false);
      }, 12000);

      return () => {
        unsubscribe();
        if (timeoutId) clearTimeout(timeoutId);
      };
    } catch (error) {
      console.error('[Auth-Debug] ❌ Error setting up auth state listener:', error);
      setLoading(false);
      return () => {
        if (timeoutId) clearTimeout(timeoutId);
      };
    }
  }, []);

  const login = async (email: string, password: string): Promise<User> => {
    const { loginNurse } = await import('@/lib/auth');
    return await loginNurse(email, password);
  };

  const logout = async (): Promise<void> => {
    const { logoutNurse } = await import('@/lib/auth');
    await logoutNurse();
    setUser(null);
  };

  const value = {
    user,
    loading,
    login,
    logout,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
