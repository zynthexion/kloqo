'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { trafficTracker } from '@/lib/traffic-tracker';
import { useUser } from '@/firebase/auth/use-user';

/**
 * Traffic Tracker Initializer
 * Automatically captures all visits (direct, indirect) to the patient app.
 * Mounts in RootLayout to ensure 100% coverage.
 */
export function TrafficTrackerInitializer() {
    const pathname = usePathname();
    const { user } = useUser();

    // Initialize once on mount
    useEffect(() => {
        trafficTracker.init(pathname);
    }, []);

    // Identify user when auth state changes
    useEffect(() => {
        if (user?.phoneNumber) {
            trafficTracker.identify(user.phoneNumber, user.patientId || undefined);
        }
    }, [user]);

    return null;
}
