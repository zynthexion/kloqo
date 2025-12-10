'use client';

import { useState, useEffect, useRef } from 'react';

// Type for the beforeinstallprompt event
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function usePwa() {
  const [showPrompt, setShowPrompt] = useState(false);
  const [isIOS, setIsIOS] = useState(false);
  const [isStandalone, setIsStandalone] = useState(false);
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isInstallable, setIsInstallable] = useState(false);

  useEffect(() => {
    // This code runs only on the client
    const userAgent = window.navigator.userAgent.toLowerCase();
    const isIosDevice = /iphone|ipad|ipod/.test(userAgent);
    
    // Check if the app is running in standalone mode (i.e., installed)
    const runningStandalone = (window.navigator as any).standalone === true || window.matchMedia('(display-mode: standalone)').matches;

    setIsIOS(isIosDevice);
    setIsStandalone(runningStandalone);
    
    // Show prompt logic for iOS
    if (isIosDevice && !runningStandalone) {
      setShowPrompt(true);
    }

    // Listen for the beforeinstallprompt event (Android/Chrome)
    const handleBeforeInstallPrompt = (e: Event) => {
      // Prevent the default mini-infobar from appearing
      e.preventDefault();
      
      // Store the event so it can be triggered later
      setDeferredPrompt(e as BeforeInstallPromptEvent);
      setIsInstallable(true);
      
      console.log('🔔 PWA install prompt available');
    };

    // Listen for app installed event
    const handleAppInstalled = () => {
      console.log('✅ PWA was installed');
      setDeferredPrompt(null);
      setIsInstallable(false);
      setIsStandalone(true);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleAppInstalled);
    };
  }, []);

  // Function to trigger the native install prompt
  const promptInstall = async (): Promise<boolean> => {
    if (!deferredPrompt) {
      console.warn('Install prompt not available');
      return false;
    }

    try {
      // Show the native install prompt
      await deferredPrompt.prompt();
      
      // Wait for user's response
      const { outcome } = await deferredPrompt.userChoice;
      
      if (outcome === 'accepted') {
        console.log('✅ User accepted the install prompt');
        setDeferredPrompt(null);
        setIsInstallable(false);
        return true;
      } else {
        console.log('❌ User dismissed the install prompt');
        return false;
      }
    } catch (error) {
      console.error('Error showing install prompt:', error);
      return false;
    }
  };

  return { 
    showPrompt, 
    isIOS, 
    isStandalone, 
    isInstallable, 
    deferredPrompt,
    promptInstall 
  };
}



