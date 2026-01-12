'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { X } from 'lucide-react';

/**
 * Component that detects if the PWA is installed and prompts users to open it
 * when they access the site via browser (e.g., scanning QR code)
 */
export function OpenInAppPrompt() {
    const [showPrompt, setShowPrompt] = useState(false);
    const [isStandalone, setIsStandalone] = useState(false);

    useEffect(() => {
        // Check if running in standalone mode (PWA)
        const standalone = window.matchMedia('(display-mode: standalone)').matches ||
            (window.navigator as any).standalone ||
            document.referrer.includes('android-app://');

        setIsStandalone(standalone);

        // Only show prompt if:
        // 1. Not running in standalone mode (i.e., in browser)
        // 2. User hasn't dismissed it in this session
        // 3. PWA is likely installed (check if beforeinstallprompt was already fired and captured)
        if (!standalone && !sessionStorage.getItem('dismissedOpenInApp')) {
            // Small delay to avoid showing immediately on page load
            const timer = setTimeout(() => {
                setShowPrompt(true);
            }, 1500);

            return () => clearTimeout(timer);
        }
    }, []);

    const handleOpenInApp = () => {
        // Try to open the PWA using the custom protocol
        // This will prompt the browser to open the installed app
        const currentUrl = window.location.href;
        const appUrl = `web+kloqo:${currentUrl}`;

        // Attempt to open in app
        window.location.href = appUrl;

        // If the protocol doesn't work (not supported), fall back to showing install prompt
        setTimeout(() => {
            setShowPrompt(false);
            sessionStorage.setItem('dismissedOpenInApp', 'true');
        }, 1000);
    };

    const handleDismiss = () => {
        setShowPrompt(false);
        sessionStorage.setItem('dismissedOpenInApp', 'true');
    };

    // Don't render if in standalone mode or prompt is dismissed
    if (isStandalone || !showPrompt) {
        return null;
    }

    return (
        <div className="fixed bottom-20 left-4 right-4 z-50 animate-in slide-in-from-bottom-5 duration-300">
            <div className="bg-primary text-primary-foreground rounded-lg shadow-lg p-4 flex items-center justify-between gap-3">
                <div className="flex-1">
                    <p className="text-sm font-semibold">Open in Kloqo App</p>
                    <p className="text-xs opacity-90 mt-0.5">For a better experience, open this in the Kloqo app</p>
                </div>
                <div className="flex items-center gap-2">
                    <Button
                        size="sm"
                        variant="secondary"
                        onClick={handleOpenInApp}
                        className="text-xs h-8"
                    >
                        Open
                    </Button>
                    <button
                        onClick={handleDismiss}
                        className="p-1 hover:bg-primary-foreground/20 rounded transition-colors"
                        aria-label="Dismiss"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>
            </div>
        </div>
    );
}
