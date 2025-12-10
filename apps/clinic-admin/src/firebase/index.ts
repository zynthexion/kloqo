
"use client";

import { auth } from '@/lib/firebase';
import { User as FirebaseUser } from 'firebase/auth';
import { createContext, useContext } from 'react';

interface AuthContextType {
    currentUser: FirebaseUser | null;
    loading: boolean;
}

export const AuthContext = createContext<AuthContextType>({
    currentUser: null,
    loading: true,
});

export const useAuth = () => {
    return useContext(AuthContext);
};
