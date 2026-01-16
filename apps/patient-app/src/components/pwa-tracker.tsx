'use client';

import { useEffect } from 'react';
import { useUser } from '@/firebase/auth/use-user';
import { usePwa } from '@/lib/pwa';
import { useFirestore } from '@/firebase';
import { doc, updateDoc, serverTimestamp } from 'firebase/firestore';

export function PwaTracker() {
    const { user } = useUser();
    const { isStandalone } = usePwa();
    const firestore = useFirestore();

    useEffect(() => {
        // Only proceed if:
        // 1. User is logged in
        // 2. App is running in standalone mode (PWA installed)
        // 3. Firestore instance is available
        // 4. We haven't already marked them as installed (optimization)
        if (user && user.uid && isStandalone && firestore) {
            const trackPwaUsage = async () => {
                // If the user profile doesn't have pwaInstalled set to true yet
                if (!user.pwaInstalled) {
                    try {
                        const userRef = doc(firestore, 'users', user.uid);
                        await updateDoc(userRef, {
                            pwaInstalled: true,
                            lastPwaAccess: serverTimestamp()
                        });
                        console.log('📱 User marked as PWA user');
                    } catch (error) {
                        console.error('Error updating PWA status:', error);
                    }
                }
            };

            trackPwaUsage();
        }
    }, [user, isStandalone, firestore]);

    return null; // This component doesn't render anything
}
