/**
 * Debounced time hook to avoid excessive re-renders
 * Updates time less frequently to reduce slot calculation overhead
 */

import { useState, useEffect, useRef } from 'react';

export function useDebouncedTime(intervalMs: number = 60000) {
  const [currentTime, setCurrentTime] = useState(new Date());
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    // Update immediately on mount
    setCurrentTime(new Date());

    // Then update at specified intervals (default 1 minute)
    intervalRef.current = setInterval(() => {
      setCurrentTime(new Date());
    }, intervalMs);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [intervalMs]);

  return currentTime;
}







