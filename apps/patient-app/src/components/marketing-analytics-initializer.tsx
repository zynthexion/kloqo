'use client';

import { useEffect } from 'react';
import { useSearchParams, usePathname } from 'next/navigation';
import { marketingAnalytics } from '@/lib/marketing-analytics';
import { useUser } from '@/firebase/auth/use-user';

/**
 * Marketing Analytics Initializer
 * Initializes session tracking when user arrives via marketing link.
 * Also restores campaign context from sessionStorage after magic-link redirect
 * (URL params are lost after window.location.href navigation).
 */
export function MarketingAnalyticsInitializer() {
    const searchParams = useSearchParams();
    const pathname = usePathname();
    const { user } = useUser();

    // Initialize analytics on mount — check URL params first, then fall back to sessionStorage
    useEffect(() => {
        const ref = searchParams.get('ref');
        const campaign = searchParams.get('campaign');

        if (ref && campaign) {
            // Params are in URL (e.g., user arrived via a marketing link directly)
            marketingAnalytics.init(searchParams);

            if (user?.phoneNumber) {
                marketingAnalytics.identify(user.phoneNumber, user.patientId);
            }
        } else {
            // Check sessionStorage for params persisted during magic-link redirect
            try {
                const stored = sessionStorage.getItem('kloqo_campaign_params');
                if (stored) {
                    const params = JSON.parse(stored);
                    // Only restore once — clear immediately to prevent re-init on future navigations
                    sessionStorage.removeItem('kloqo_campaign_params');

                    // Reconstruct a URLSearchParams from stored object and initialize
                    const syntheticParams = new URLSearchParams(params);
                    marketingAnalytics.init(syntheticParams);
                    console.log('[Analytics] Restored campaign params from sessionStorage:', params);

                    if (user?.phoneNumber) {
                        marketingAnalytics.identify(user.phoneNumber, user.patientId);
                    }
                }
            } catch (e) {
                // sessionStorage not available (e.g., private mode), ignore
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [user]);

    // Track page views on every route change
    useEffect(() => {
        marketingAnalytics.trackPageView(pathname);
    }, [pathname]);

    return null;
}
