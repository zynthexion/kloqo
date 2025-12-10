/**
 * Patient data caching utility
 * Provides instant patient data on repeat visits
 */

import type { Patient } from '@/lib/types';

const PATIENT_CACHE_KEY = 'kloqo_patient_cache';
const PATIENT_LIST_CACHE_KEY = 'kloqo_patient_list_cache';
const CACHE_DURATION = 10 * 60 * 1000; // 10 minutes

type PatientCacheEntry = {
  patient: Patient;
  timestamp: number;
};

type PatientListCacheEntry = {
  primary: (Patient & { id: string }) | null;
  relatives: (Patient & { id: string })[];
  timestamp: number;
};

export function savePatientToCache(patientId: string, patient: Patient) {
  if (typeof window === 'undefined') return;
  try {
    const cacheEntry: PatientCacheEntry = {
      patient,
      timestamp: Date.now(),
    };
    localStorage.setItem(`${PATIENT_CACHE_KEY}_${patientId}`, JSON.stringify(cacheEntry));
  } catch (error) {
    console.warn('Failed to cache patient data:', error);
  }
}

export function getPatientFromCache(patientId: string): Patient | null {
  if (typeof window === 'undefined') return null;
  try {
    const cached = localStorage.getItem(`${PATIENT_CACHE_KEY}_${patientId}`);
    if (cached) {
      const cacheEntry: PatientCacheEntry = JSON.parse(cached);
      if (Date.now() - cacheEntry.timestamp < CACHE_DURATION) {
        return cacheEntry.patient;
      } else {
        // Cache expired
        localStorage.removeItem(`${PATIENT_CACHE_KEY}_${patientId}`);
      }
    }
  } catch (error) {
    console.warn('Failed to read patient cache:', error);
    localStorage.removeItem(`${PATIENT_CACHE_KEY}_${patientId}`);
  }
  return null;
}

export function clearPatientCache(patientId?: string) {
  if (typeof window === 'undefined') return;
  try {
    if (patientId) {
      localStorage.removeItem(`${PATIENT_CACHE_KEY}_${patientId}`);
    } else {
      // Clear all patient caches
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (key && key.startsWith(PATIENT_CACHE_KEY)) {
          localStorage.removeItem(key);
        }
      }
    }
  } catch (error) {
    console.warn('Failed to clear patient cache:', error);
  }
}

/**
 * Cache patient list (primary + relatives) by phone number
 */
export function savePatientListToCache(phone: string, primary: (Patient & { id: string }) | null, relatives: (Patient & { id: string })[]) {
  if (typeof window === 'undefined') return;
  try {
    const cacheEntry: PatientListCacheEntry = {
      primary,
      relatives,
      timestamp: Date.now(),
    };
    localStorage.setItem(`${PATIENT_LIST_CACHE_KEY}_${phone}`, JSON.stringify(cacheEntry));
  } catch (error) {
    console.warn('Failed to cache patient list:', error);
  }
}

/**
 * Get cached patient list (primary + relatives) by phone number
 */
export function getPatientListFromCache(phone: string): { primary: (Patient & { id: string }) | null; relatives: (Patient & { id: string })[] } | null {
  if (typeof window === 'undefined') return null;
  try {
    const cached = localStorage.getItem(`${PATIENT_LIST_CACHE_KEY}_${phone}`);
    if (cached) {
      const cacheEntry: PatientListCacheEntry = JSON.parse(cached);
      if (Date.now() - cacheEntry.timestamp < CACHE_DURATION) {
        return {
          primary: cacheEntry.primary,
          relatives: cacheEntry.relatives,
        };
      } else {
        // Cache expired
        localStorage.removeItem(`${PATIENT_LIST_CACHE_KEY}_${phone}`);
      }
    }
  } catch (error) {
    console.warn('Failed to read patient list cache:', error);
    localStorage.removeItem(`${PATIENT_LIST_CACHE_KEY}_${phone}`);
  }
  return null;
}

/**
 * Clear patient list cache for a phone number
 */
export function clearPatientListCache(phone?: string) {
  if (typeof window === 'undefined') return;
  try {
    if (phone) {
      localStorage.removeItem(`${PATIENT_LIST_CACHE_KEY}_${phone}`);
    } else {
      // Clear all patient list caches
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (key && key.startsWith(PATIENT_LIST_CACHE_KEY)) {
          localStorage.removeItem(key);
        }
      }
    }
  } catch (error) {
    console.warn('Failed to clear patient list cache:', error);
  }
}

