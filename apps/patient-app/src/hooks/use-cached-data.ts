'use client';

import { useEffect, useState, useRef } from 'react';

/**
 * Hydrates data from localStorage and keeps it in sync as fresh data arrives.
 * Works best with JSON-serializable data (arrays/objects without functions).
 */
export function useCachedData<T>(
  storageKey: string | null,
  incomingData: T | undefined,
  dataReady: boolean
): T | null {
  const [cachedData, setCachedData] = useState<T | null>(null);
  const [hasHydrated, setHasHydrated] = useState(false);
  const lastSerializedRef = useRef<string | null>(null);

  // Hydrate from storage on mount/key change
  useEffect(() => {
    if (!storageKey || hasHydrated) {
      return;
    }

    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        setCachedData(parsed);
        lastSerializedRef.current = raw;
      }
    } catch (error) {
      console.warn('Unable to parse cached data:', error);
    } finally {
      setHasHydrated(true);
    }
  }, [storageKey, hasHydrated]);

  // Persist new data when ready
  useEffect(() => {
    if (!storageKey || !dataReady || typeof incomingData === 'undefined') {
      return;
    }

    try {
      const serializedIncoming = JSON.stringify(incomingData);
      
      // Only update if the data has actually changed (compare with ref to avoid dependency loop)
      if (serializedIncoming !== lastSerializedRef.current) {
        localStorage.setItem(storageKey, serializedIncoming);
        lastSerializedRef.current = serializedIncoming;
        setCachedData(incomingData);
      }
    } catch (error) {
      console.warn('Unable to cache data:', error);
    }
  }, [storageKey, incomingData, dataReady]);

  return cachedData;
}


