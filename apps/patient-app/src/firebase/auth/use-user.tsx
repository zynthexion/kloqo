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
    pwaInstalled?: boolean;
    acquisitionSource?: string;
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

    const fetchAppUserDetails = useCallback(async (firebaseUser: User): Promise<AppUser> => {
        let patientIdToSet: string | null = null;
        // Default dbUserId to uid if no resolution happens (will be overridden if found)
        let resolvedDbUserId: string = firebaseUser.uid;

        if (!firestore || !firebaseUser.phoneNumber) {
            return {
                uid: firebaseUser.uid,
                dbUserId: firebaseUser.uid,
                patientId: null,
                phoneNumber: firebaseUser.phoneNumber,
                displayName: firebaseUser.displayName || 'User',
                role: 'patient' as const
            };
        }

        try {
            // Step 1: Get the user document directly by UID
            const userDocRef = doc(firestore, 'users', firebaseUser.uid);
            const userDocSnap = await getDoc(userDocRef);

            let userDocData: any = null;

            if (userDocSnap.exists()) {
                userDocData = userDocSnap.data();
                resolvedDbUserId = firebaseUser.uid;
            } else {
                // Fallback: Search by phone number if document doesn't exist by UID
                if (firebaseUser.phoneNumber) {
                    const usersByPhoneQuery = query(
                        collection(firestore, 'users'),
                        where('phone', '==', firebaseUser.phoneNumber)
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
                patientIdToSet = patientId;

                // If no patientId in user document, try to find patient by phone number
                if (!patientId && firebaseUser.phoneNumber) {
                    const patientsByPhoneQuery = query(
                        collection(firestore, 'patients'),
                        where('phone', '==', firebaseUser.phoneNumber)
                    );
                    const patientsByPhoneSnap = await getDocs(patientsByPhoneQuery);

                    if (!patientsByPhoneSnap.empty) {
                        // Get the primary patient or first patient
                        const patients = patientsByPhoneSnap.docs.map(d => ({ id: d.id, ...d.data() } as any));
                        const primaryPatient = patients.find((p: any) => p.isPrimary) || patients[0];
                        patientId = primaryPatient.id;
                        patientIdToSet = patientId;
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
                            uid: firebaseUser.uid,
                            dbUserId: resolvedDbUserId,
                            patientId: patientId,
                            phoneNumber: firebaseUser.phoneNumber,
                            displayName: patientName || firebaseUser.displayName || 'User',
                            name: patientName || undefined, // Name directly from patients collection
                            place: patientData.place || '',
                            clinicIds: clinicIds,
                            role: 'patient' as const,
                            pwaInstalled: userDocData.pwaInstalled,
                            acquisitionSource: userDocData.acquisitionSource
                        };
                    }
                }
            }
        } catch (e) {
            // Silently fail and return fallback user object
        }

        // Fallback if anything fails
        return {
            uid: firebaseUser.uid,
            dbUserId: resolvedDbUserId, // Use the resolved ID if found, otherwise default from init
            patientId: patientIdToSet,
            phoneNumber: firebaseUser.phoneNumber,
            displayName: firebaseUser.displayName || 'User',
            place: '',
            clinicIds: [],
            role: 'patient' as const,
            pwaInstalled: false,
            acquisitionSource: undefined
        };
    }, [firestore]);

    useEffect(() => {
        if (!auth) {
            setLoading(false);
            return;
        }

        const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
            if (firebaseUser) {
                const appUser = await fetchAppUserDetails(firebaseUser);
                setUser(appUser);
                // Cache user data for faster subsequent loads
                userCache.set(appUser);
            } else {
                setUser(null);
                // Clear cache on logout
                userCache.clear();
            }
            setLoading(false);
        });

        return () => unsubscribe();
    }, [auth, fetchAppUserDetails]);

    const logout = useCallback(() => {
        if (!auth) return;
        // Clear cache before logout
        userCache.clear();
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
