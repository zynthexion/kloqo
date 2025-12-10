'use client';

import { useState, useEffect } from 'react';

export function usePwa() {
  const [showPrompt, setShowPrompt] = useState(false);
  const [isIOS, setIsIOS] = useState(false);
  const [isStandalone, setIsStandalone] = useState(false);

  useEffect(() => {
    // This code runs only on the client
    const userAgent = window.navigator.userAgent.toLowerCase();
    const isIosDevice = /iphone|ipad|ipod/.test(userAgent);

    // Check if the app is running in standalone mode (i.e., installed)
    const runningStandalone = (window.navigator as any).standalone === true || window.matchMedia('(display-mode: standalone)').matches;

    setIsIOS(isIosDevice);
    setIsStandalone(runningStandalone);

    // Show prompt logic (can be expanded for Android later if needed)
    if (isIosDevice && !runningStandalone) {
      setShowPrompt(true);
    }
  }, []);

  return { showPrompt, isIOS, isStandalone };
}
