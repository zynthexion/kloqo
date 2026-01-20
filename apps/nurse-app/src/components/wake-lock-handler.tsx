'use client';

import { useEffect, useRef } from 'react';

export default function WakeLockHandler() {
    const wakeLockRef = useRef<any>(null);

    useEffect(() => {
        const requestWakeLock = async () => {
            if (!('wakeLock' in navigator)) {
                console.warn('Screen Wake Lock API is not supported in this browser.');
                return;
            }

            try {
                wakeLockRef.current = await (navigator as any).wakeLock.request('screen');
                console.log('Screen Wake Lock is active.');

                wakeLockRef.current.addEventListener('release', () => {
                    console.log('Screen Wake Lock was released.');
                });
            } catch (err: any) {
                console.error(`${err.name}, ${err.message}`);
            }
        };

        // Initial request
        requestWakeLock();

        // Re-request when visibility changes (if wake lock was released)
        const handleVisibilityChange = async () => {
            if (wakeLockRef.current !== null && document.visibilityState === 'visible') {
                await requestWakeLock();
            }
        };

        document.addEventListener('visibilitychange', handleVisibilityChange);

        return () => {
            document.removeEventListener('visibilitychange', handleVisibilityChange);
            if (wakeLockRef.current) {
                wakeLockRef.current.release().then(() => {
                    wakeLockRef.current = null;
                });
            }
        };
    }, []);

    return null; // This component doesn't render anything
}
