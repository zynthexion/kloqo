'use client';

import { useEffect } from 'react';
import { useSearchParams } from 'next/navigation';

/**
 * WhatsApp Manager Component
 * 
 * Detects '?wa=true' in the URL and applies the necessary
 * CSS classes and behaviors for a native WhatsApp Mini-App feel.
 */
export function WhatsAppManager() {
    const searchParams = useSearchParams();
    const isWhatsApp = searchParams.get('wa') === 'true';

    useEffect(() => {
        if (isWhatsApp) {
            document.documentElement.classList.add('whatsapp-mode');

            // Additional optimizations for WhatsApp in-app browser
            // Disable pull-to-refresh if needed, etc.
            document.body.style.overscrollBehaviorY = 'contain';
        } else {
            document.documentElement.classList.remove('whatsapp-mode');
        }
    }, [isWhatsApp]);

    return null;
}
