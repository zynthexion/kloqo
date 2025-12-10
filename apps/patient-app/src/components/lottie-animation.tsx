'use client';

import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';

// Lazy load Lottie to reduce initial bundle size
const Lottie = dynamic(() => import('lottie-react'), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center" aria-hidden="true">
      <div className="w-20 h-20 animate-pulse bg-muted rounded-full" />
    </div>
  ),
});

interface LottieAnimationProps {
  animationData: any;
  className?: string;
  size?: number;
  autoplay?: boolean;
  loop?: boolean;
  speed?: number;
  onComplete?: () => void;
}

/**
 * Optimized Lottie animation component with performance best practices:
 * - Lazy loads Lottie library
 * - Pauses when not visible (using Intersection Observer API)
 * - Configurable size and playback options
 */
export function LottieAnimation({
  animationData,
  className = '',
  size = 200,
  autoplay = true,
  loop = false,
  speed = 1,
  onComplete,
}: LottieAnimationProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const lottieRef = useRef<any>(null);
  const [isVisible, setIsVisible] = useState(true);
  const [hasPlayed, setHasPlayed] = useState(false);

  // Use native Intersection Observer API (no dependency needed)
  useEffect(() => {
    if (!containerRef.current || typeof window === 'undefined') return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        setIsVisible(entry.isIntersecting);
      },
      { threshold: 0.1 }
    );

    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    if (lottieRef.current) {
      if (isVisible && autoplay && (!hasPlayed || loop)) {
        lottieRef.current.setSpeed(speed);
        lottieRef.current.play();
        if (!loop && !hasPlayed) {
          setHasPlayed(true);
        }
      } else if (!isVisible || (!autoplay && !loop)) {
        lottieRef.current.pause();
      }
    }
  }, [isVisible, autoplay, loop, speed, hasPlayed]);

  // Handle animation complete
  useEffect(() => {
    if (lottieRef.current && onComplete && !loop) {
      const checkComplete = () => {
        if (lottieRef.current && lottieRef.current.isPaused && hasPlayed) {
          onComplete();
        }
      };
      const interval = setInterval(checkComplete, 100);
      return () => clearInterval(interval);
    }
  }, [onComplete, loop, hasPlayed]);

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <Lottie
        lottieRef={lottieRef}
        animationData={animationData}
        loop={loop}
        autoplay={autoplay && isVisible}
        style={{ width: size, height: size }}
        rendererSettings={{
          preserveAspectRatio: 'xMidYMid slice',
        }}
      />
    </div>
  );
}

