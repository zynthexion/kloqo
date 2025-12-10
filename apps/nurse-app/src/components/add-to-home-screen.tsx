'use client';

import { useState, useEffect } from 'react';
import { usePwa } from '@/lib/pwa';
import { Button } from '@/components/ui/button';
import { Share, X } from 'lucide-react';
import { Card, CardContent } from './ui/card';

export default function AddToHomeScreenPrompt() {
  const { showPrompt, isIOS, isStandalone } = usePwa();
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const promptDismissed = localStorage.getItem('pwaPromptDismissed');
    if (showPrompt && isIOS && !isStandalone && !promptDismissed) {
      setIsVisible(true);
    }
  }, [showPrompt, isIOS, isStandalone]);

  const handleDismiss = () => {
    localStorage.setItem('pwaPromptDismissed', 'true');
    setIsVisible(false);
  };

  if (!isVisible) {
    return null;
  }

  return (
    <div className="fixed bottom-16 left-1/2 -translate-x-1/2 w-[calc(100%-2rem)] max-w-sm z-50">
       <Card className="bg-background/95 backdrop-blur-sm shadow-2xl animate-in slide-in-from-bottom-10">
        <CardContent className="p-4 relative">
             <Button
                variant="ghost"
                size="icon"
                className="absolute top-2 right-2 h-6 w-6 text-muted-foreground"
                onClick={handleDismiss}
              >
                <X className="h-4 w-4" />
                <span className="sr-only">Dismiss</span>
              </Button>
            <div className="flex items-center gap-4">
                <div className="flex-1">
                    <p className="font-semibold text-sm">Install the App</p>
                    <p className="text-xs text-muted-foreground mt-1">
                        For the best experience, add kloqo to your home screen. Tap the <Share className="inline h-3 w-3 mx-0.5" /> icon and then 'Add to Home Screen'.
                    </p>
                </div>
            </div>
        </CardContent>
       </Card>
    </div>
  );
}
