"use client"

import { useState, useEffect, useCallback } from 'react';

// This hook is designed to cause a re-render on the client after hydration
// to ensure the UI reflects the value from localStorage without causing a hydration mismatch.
function useLocalStorage<T>(key: string, initialValue: T): [T, (value: T | ((val: T) => T)) => void] {
  const [storedValue, setStoredValue] = useState<T>(initialValue);

  useEffect(() => {
    // This effect runs only on the client, after the initial render.
    let currentValue: T;
    try {
      const item = window.localStorage.getItem(key);
      currentValue = item ? JSON.parse(item) : initialValue;
    } catch (error) {
      currentValue = initialValue;
      console.error(error);
    }
    setStoredValue(currentValue);
  }, [key, initialValue]);


  const setValue = useCallback((value: T | ((val: T) => T)) => {
    try {
      const valueToStore = value instanceof Function ? value(storedValue) : value;
      setStoredValue(valueToStore);
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(key, JSON.stringify(valueToStore));
      }
    } catch (error) {
      console.log(error);
    }
  }, [key, storedValue]);

  return [storedValue, setValue];
}

export default useLocalStorage;
