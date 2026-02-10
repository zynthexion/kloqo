'use client';

import { useEffect } from 'react';
import { useSearchParams, usePathname } from 'next/navigation';
import { marketingAnalytics } from '@/lib/marketing-analytics';
import { useUser } from '@/firebase/auth/use-user';

/**
 * Marketing Analytics Initializer
 * Initializes session tracking when user arrives via marketing link
 * Tracks page views throughout the app
 */
export function MarketingAnalyticsInitializer() {
    const searchParams = useSearchParams();
    const pathname = usePathname();
    const { user } = useUser();

    // Initialize analytics on mount if marketing params present
    useEffect(() => {
        const ref = searchParams.get('ref');
        const campaign = searchParams.get('campaign');

        if (ref && campaign) {
            // Initialize with campaign params
            // Phone and patientId will be populated from magic token on backend
            marketingAnalytics.init(searchParams);
        }
    }, [searchParams, user]);

    // Track page views on route change
    useEffect(() => {
        marketingAnalytics.trackPageView(pathname);
    }, [pathname]);

    return null; // This component doesn't render anything
}
