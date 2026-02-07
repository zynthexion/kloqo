'use client';

import { useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { doc, updateDoc } from 'firebase/firestore';
import { useUser } from '@/firebase/auth/use-user';
import { useFirestore } from '@/firebase';

const ATTRIBUTION_STORAGE_KEY = 'kloqo_attribution_ref';

function AttributionLogic() {
    const searchParams = useSearchParams();
    const { user, loading } = useUser();
    const firestore = useFirestore();

    useEffect(() => {
        // 1. Extract ref from URL
        const ref = searchParams.get('ref');

        if (ref) {
            console.log(`[Attribution] 🎯 Found ref in URL: ${ref}`);
            localStorage.setItem(ATTRIBUTION_STORAGE_KEY, ref);
        }

        // 2. Sync to Firestore if user is logged in
        const syncAttribution = async () => {
            if (loading || !user || !firestore) return;

            const storedRef = localStorage.getItem(ATTRIBUTION_STORAGE_KEY);

            // If we have a stored ref AND the user document doesn't have an acquisition source yet
            if (storedRef && !user.acquisitionSource) {
                console.log(`[Attribution] 🚀 Syncing acquisition source '${storedRef}' to user ${user.uid}`);

                try {
                    const userDocRef = doc(firestore, 'users', user.uid);
                    await updateDoc(userDocRef, {
                        acquisitionSource: storedRef,
                        acquisitionTimestamp: new Date().toISOString()
                    });

                    // Clear from local storage once synced to prevent unnecessary updates
                    // localStorage.removeItem(ATTRIBUTION_STORAGE_KEY); 
                    // Actually, we might want to keep it in LS for debugging or for new patient creation
                    // but marking it as "synced" would be better.
                } catch (error) {
                    console.error('[Attribution] ❌ Error syncing to Firestore:', error);
                }
            }
        };

        syncAttribution();
    }, [searchParams, user, loading, firestore]);

    return null;
}

export function AttributionTracker() {
    return (
        <Suspense fallback={null}>
            <AttributionLogic />
        </Suspense>
    );
}
