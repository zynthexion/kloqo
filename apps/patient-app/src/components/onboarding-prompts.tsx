'use client';

import { useEffect, useState } from 'react';
import { Download, X, Share } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useRouter } from 'next/navigation';

type PermissionType = 'pwa';

export function OnboardingPrompts() {
  const [showPWAPrompt, setShowPWAPrompt] = useState(false);
  const [isMounted, setIsMounted] = useState(false);
  
  const router = useRouter();

  useEffect(() => {
    setIsMounted(true);
  }, []);

  useEffect(() => {
    if (!isMounted) return;
    
    // Check if onboarding is complete
    const onboardingComplete = localStorage.getItem('onboardingComplete');
    if (onboardingComplete === 'true') {
      return;
    }

    // REMOVED: Location prompt - browser will handle it natively when location is requested
    // REMOVED: Notification prompt - browser will handle it natively when notifications are requested
    // No need for custom prompts as they cause duplicate prompts

    // Check PWA install prompt
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || (window.navigator as any).standalone === true;
    const pwaDismissed = localStorage.getItem('pwaPromptDismissed');
    
    if (!isStandalone && !pwaDismissed) {
      // Check if device is iOS or Android
      const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
      const isAndroid = /Android/.test(navigator.userAgent);
      
      // For iOS, show custom prompt
      if (isIOS) {
        setTimeout(() => setShowPWAPrompt(true), 6000);
      }
      // For Android/Chrome, browser will show native install prompt automatically
    }
  }, [isMounted]);

  const handleDismissPWA = () => {
    setShowPWAPrompt(false);
    localStorage.setItem('pwaPromptDismissed', 'true');
  };

  const handleDismissAll = () => {
    setShowPWAPrompt(false);
    localStorage.setItem('onboardingComplete', 'true');
  };

  // Show only PWA prompt (location and notification prompts removed - browser handles them natively)
  const activePrompt = showPWAPrompt ? 'pwa' : null;

  if (!activePrompt) return null;

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-end justify-center p-4">
      <Card className="w-full max-w-md animate-in slide-in-from-bottom-10">
        <CardContent className="p-6">
          {activePrompt === 'pwa' && (
            <>
              <div className="flex items-center gap-3 mb-4">
                <div className="w-12 h-12 rounded-full bg-purple-100 flex items-center justify-center">
                  <Download className="w-6 h-6 text-purple-600" />
                </div>
                <div className="flex-1">
                  <h3 className="font-semibold text-lg">Install App</h3>
                  <p className="text-sm text-muted-foreground">
                    Add Kloqo to your home screen for quick access
                  </p>
                </div>
              </div>
              <div className="space-y-2">
                <div className="text-xs text-muted-foreground mb-4">
                  <p className="mb-2">For the best experience:</p>
                  <ol className="list-decimal list-inside space-y-1">
                    <li>Tap the Share button</li>
                    <li>Scroll down and tap "Add to Home Screen"</li>
                    <li>Tap "Add" to confirm</li>
                  </ol>
                </div>
                <div className="flex gap-2">
                  <Button 
                    variant="outline" 
                    className="flex-1"
                    onClick={handleDismissPWA}
                  >
                    Maybe Later
                  </Button>
                  <Button 
                    className="flex-1"
                    onClick={handleDismissPWA}
                  >
                    Got It
                  </Button>
                </div>
              </div>
            </>
          )}

          {/* Close button */}
          <Button
            variant="ghost"
            size="icon"
            className="absolute top-2 right-2 h-8 w-8 text-muted-foreground"
            onClick={handleDismissAll}
          >
            <X className="h-4 w-4" />
            <span className="sr-only">Close</span>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

