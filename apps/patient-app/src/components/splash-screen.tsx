'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import splashAnimation from '@/lib/animations/splash.json';

// For the main splash, avoid showing the generic spinner; render nothing while Lottie loads.
const Lottie = dynamic(() => import('lottie-react'), {
  ssr: false,
  loading: () => null,
});

interface SplashScreenProps {
  /** Optional accessible label for screen readers */
  label?: string;
  /** Called once when the splash animation has fully finished playing */
  onComplete?: () => void;
}

export function SplashScreen({ label = 'Loading Kloqo', onComplete }: SplashScreenProps) {
  const [hasNotified, setHasNotified] = useState(false);

  const handleComplete = () => {
    if (hasNotified) return;
    setHasNotified(true);
    if (onComplete) {
      onComplete();
    }
  };

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black"
      aria-label={label}
      role="status"
    >
      <Lottie
        animationData={splashAnimation}
        loop={false}
        autoplay
        initialSegment={[0, 260]}
        onComplete={handleComplete}
        style={{ width: '100vw', height: '100vh' }}
        rendererSettings={{ preserveAspectRatio: 'xMidYMid slice' }}
      />
    </div>
  );
}



