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

    let timeoutId: NodeJS.Timeout;

    try {
      const unsubscribe = onAuthStateChange((user) => {
        if (user) {
          // Sync localStorage if it's missing but user is logged in
          if (!localStorage.getItem('clinicId') && user.clinicId) {
            localStorage.setItem('clinicId', user.clinicId);
            localStorage.setItem('user', JSON.stringify({
              id: user.uid,
              email: user.email,
              name: user.name,
              clinicId: user.clinicId
            }));
          }
        }
        setUser(user);
        setLoading(false);
        if (timeoutId) clearTimeout(timeoutId);
      });

      // Fallback timeout: if Firebase doesn't respond in 3 seconds, stop loading
      timeoutId = setTimeout(() => {
        console.warn('⚠️ Auth state check timeout - Firebase may not be configured correctly');
        console.warn('Check your .env.local file and browser console for Firebase errors');
        setLoading(false);
      }, 3000);

      return () => {
        unsubscribe();
        if (timeoutId) clearTimeout(timeoutId);
      };
    } catch (error) {
      console.error('❌ Error setting up auth state listener:', error);
      console.error('This usually means Firebase config is missing or invalid');
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
