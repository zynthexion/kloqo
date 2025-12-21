'use client';
import { useEffect, useState, createContext, useContext, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { collection, doc, getDoc, query, where, getDocs } from 'firebase/firestore';
import { useAuth, useFirestore } from '@/firebase';
import { onAuthStateChanged, signOut, type User } from 'firebase/auth';
import { userCache } from '@/lib/user-cache';


export type AppUser = {
    uid: string;
    dbUserId: string; // The actual Firestore Document ID (users/{id})
    patientId: string | null;
    phoneNumber: string | null;
    displayName?: string;
    name?: string; // Name from patients collection
    place?: string;
    clinicIds?: string[];
    role?: 'patient' | 'clinicAdmin'; // User role for routing and permissions
};

type UserContextType = {
    user: AppUser | null;
    loading: boolean;
    logout: () => void;
};

const UserContext = createContext<UserContextType | undefined>(undefined);

export function UserProvider({ children }: { children: React.ReactNode }) {
    // Try to load from cache first for instant initial render
    const cachedUser = userCache.get();
    const [user, setUser] = useState<AppUser | null>(cachedUser);
    const [loading, setLoading] = useState(!cachedUser); // If cache exists, don't show loading
    const router = useRouter();
    const auth = useAuth();
    const firestore = useFirestore();

    const fetchAppUserDetails = useCallback(async (firebaseUser: User | { patientId: string, userId?: string, isWhatsApp: boolean }): Promise<AppUser> => {
        const isVirtual = 'isWhatsApp' in firebaseUser && firebaseUser.isWhatsApp;
        const patientIdToSet = isVirtual ? firebaseUser.patientId : null;
        console.log(`[useUser] fetchAppUserDetails - isVirtual: ${isVirtual}`, firebaseUser);

        if (isVirtual) {
            // Handle virtual WhatsApp session
            try {
                if (firestore) {
                    const patientDocRef = doc(firestore, 'patients', firebaseUser.patientId);
                    const patientDocSnap = await getDoc(patientDocRef);

                    if (patientDocSnap.exists()) {
                        const patientData = patientDocSnap.data();
                        console.log('[useUser] Virtual patient details found:', patientData.name);
                        // Use the userId from the session if available, otherwise fallback to wa_ prefix
                        const uid = firebaseUser.userId || `wa_${firebaseUser.patientId}`;
                        return {
                            uid: uid,
                            dbUserId: firebaseUser.userId || patientData.primaryUserId || firebaseUser.patientId,
                            patientId: firebaseUser.patientId,
                            phoneNumber: patientData.phone || patientData.communicationPhone || null,
                            displayName: patientData.name || 'WhatsApp User',
                            name: patientData.name || undefined,
                            place: patientData.place || '',
                            clinicIds: patientData.clinicIds || [],
                            role: 'patient' as const
                        };
                    } else {
                        console.warn('[useUser] Virtual patient document not found:', firebaseUser.patientId);
                    }
                }
            } catch (e) {
                console.error('[useUser] Error fetching virtual patient details:', e);
            }

            // Fallback for virtual session
            const uid = firebaseUser.userId || `wa_${firebaseUser.patientId}`;
            return {
                uid: uid,
                dbUserId: firebaseUser.userId || firebaseUser.patientId,
                patientId: firebaseUser.patientId,
                phoneNumber: null,
                displayName: 'WhatsApp User',
                role: 'patient' as const
            };
        }

        const actualFirebaseUser = firebaseUser as User;
        if (!firestore || !actualFirebaseUser.phoneNumber) {
            return {
                uid: actualFirebaseUser.uid,
                dbUserId: actualFirebaseUser.uid,
                patientId: null,
                phoneNumber: actualFirebaseUser.phoneNumber,
                displayName: actualFirebaseUser.displayName || 'User',
                role: 'patient' as const
            };
        }

        let resolvedDbUserId = actualFirebaseUser.uid;
        try {
            // Step 1: Get the user document directly by UID
            const userDocRef = doc(firestore, 'users', actualFirebaseUser.uid);
            const userDocSnap = await getDoc(userDocRef);

            let userDocData: any = null;

            if (userDocSnap.exists()) {
                userDocData = userDocSnap.data();
                resolvedDbUserId = actualFirebaseUser.uid;
            } else {
                // Fallback: Search by phone number if document doesn't exist by UID
                if (actualFirebaseUser.phoneNumber) {
                    const usersByPhoneQuery = query(
                        collection(firestore, 'users'),
                        where('phone', '==', actualFirebaseUser.phoneNumber)
                    );
                    const usersByPhoneSnap = await getDocs(usersByPhoneQuery);

                    if (!usersByPhoneSnap.empty) {
                        // Filter for patient role only
                        const patientUsers = usersByPhoneSnap.docs
                            .map(d => ({ id: d.id, ...d.data() } as any))
                            .filter((u: any) => u.role === 'patient');

                        if (patientUsers.length > 0) {
                            const firstPatientUser = patientUsers[0];
                            userDocData = firstPatientUser;
                            resolvedDbUserId = firstPatientUser.id;
                        }
                    }
                }
            }

            if (userDocData) {
                let patientId = userDocData.patientId;

                // If no patientId in user document, try to find patient by phone number
                if (!patientId && actualFirebaseUser.phoneNumber) {
                    const patientsByPhoneQuery = query(
                        collection(firestore, 'patients'),
                        where('phone', '==', actualFirebaseUser.phoneNumber)
                    );
                    const patientsByPhoneSnap = await getDocs(patientsByPhoneQuery);

                    if (!patientsByPhoneSnap.empty) {
                        // Get the primary patient or first patient
                        const patients = patientsByPhoneSnap.docs.map(d => ({ id: d.id, ...d.data() } as any));
                        const primaryPatient = patients.find((p: any) => p.isPrimary) || patients[0];
                        patientId = primaryPatient.id;
                    }
                }

                if (patientId) {
                    // Step 2: Use patientId to get the patient document from 'patients' collection
                    const patientDocRef = doc(firestore, 'patients', patientId);
                    const patientDocSnap = await getDoc(patientDocRef);

                    if (patientDocSnap.exists()) {
                        const patientData = patientDocSnap.data();
                        const clinicIds = patientData.clinicIds || [];
                        const patientName = patientData.name || null;

                        return {
                            uid: actualFirebaseUser.uid,
                            dbUserId: resolvedDbUserId,
                            patientId: patientId,
                            phoneNumber: actualFirebaseUser.phoneNumber,
                            displayName: patientName || actualFirebaseUser.displayName || 'User',
                            name: patientName || undefined, // Name directly from patients collection
                            place: patientData.place || '',
                            clinicIds: clinicIds,
                            role: 'patient' as const
                        };
                    }
                }
            }
        } catch (e) {
            // Silently fail and return fallback user object
        }

        // Fallback if anything fails
        return {
            uid: actualFirebaseUser.uid,
            dbUserId: resolvedDbUserId, // Use the resolved ID if found, otherwise default from init
            patientId: null,
            phoneNumber: actualFirebaseUser.phoneNumber,
            displayName: actualFirebaseUser.displayName || 'User',
            place: '',
            clinicIds: [],
            role: 'patient' as const
        };
    }, [firestore]);

    useEffect(() => {
        if (!auth) {
            setLoading(false);
            return;
        }

        const checkVirtualSession = async () => {
            const waAuthData = typeof window !== 'undefined' ? sessionStorage.getItem('wa_auth_data') : null;
            if (waAuthData) {
                console.log('[useUser] Found virtual WhatsApp session data');
                try {
                    const session = JSON.parse(waAuthData);
                    if (session.patientId) {
                        const appUser = await fetchAppUserDetails({
                            patientId: session.patientId,
                            userId: session.userId,
                            isWhatsApp: true
                        });
                        if (appUser) {
                            console.log('[useUser] Successfully loaded virtual user:', appUser.displayName);
                            setUser(appUser);
                            return true;
                        }
                    }
                } catch (e) {
                    console.error('[useUser] Parsing error for virtual session:', e);
                }
            }
            return false;
        };

        const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
            console.log('[useUser] onAuthStateChanged - firebaseUser:', firebaseUser?.uid || 'null');
            if (firebaseUser) {
                const appUser = await fetchAppUserDetails(firebaseUser);
                setUser(appUser);
                userCache.set(appUser);
                setLoading(false);
            } else {
                // Check for virtual WhatsApp session if no traditional auth
                const hasVirtual = await checkVirtualSession();
                if (!hasVirtual) {
                    console.log('[useUser] No traditional or virtual session found');
                    setUser(null);
                    userCache.clear();
                }
                setLoading(false);
            }
        });

        return () => unsubscribe();
    }, [auth, fetchAppUserDetails]);

    const logout = useCallback(() => {
        if (!auth) return;
        // Clear cache before logout
        userCache.clear();
        // Clear WhatsApp session
        if (typeof window !== 'undefined') {
            sessionStorage.removeItem('wa_auth_data');
            sessionStorage.removeItem('wa_mode');
        }
        signOut(auth).then(() => {
            setUser(null);
            router.push('/login');
        });
    }, [auth, router]);

    return (
        <UserContext.Provider value={{ user, loading, logout }}>
            {children}
        </UserContext.Provider>
    );
}

export const useUser = () => {
    const context = useContext(UserContext);
    // During prerendering/build time, or if provider is not yet available (e.g., during initial render),
    // return a safe fallback instead of throwing
    // Components should check loading/user states to handle these cases
    if (context === undefined) {
        // Always return a safe default - prevents runtime errors
        // Components can check loading/user states to handle provider not ready
        return { user: null, loading: true, logout: () => { } };
    }
    return context;
};
