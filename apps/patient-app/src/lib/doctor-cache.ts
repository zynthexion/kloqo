/**
 * Doctor data caching utility
 * Provides instant doctor data on repeat visits
 */

import type { Doctor } from '@/lib/types';

const DOCTOR_CACHE_KEY = 'kloqo_doctor_cache';
const CACHE_DURATION = 10 * 60 * 1000; // 10 minutes

type DoctorCacheEntry = {
  doctor: Doctor;
  timestamp: number;
};

export function saveDoctorToCache(doctorId: string, doctor: Doctor) {
  if (typeof window === 'undefined') return;
  try {
    const cacheEntry: DoctorCacheEntry = {
      doctor,
      timestamp: Date.now(),
    };
    localStorage.setItem(`${DOCTOR_CACHE_KEY}_${doctorId}`, JSON.stringify(cacheEntry));
  } catch (error) {
    console.warn('Failed to cache doctor data:', error);
  }
}

export function getDoctorFromCache(doctorId: string): Doctor | null {
  if (typeof window === 'undefined') return null;
  try {
    const cached = localStorage.getItem(`${DOCTOR_CACHE_KEY}_${doctorId}`);
    if (cached) {
      const cacheEntry: DoctorCacheEntry = JSON.parse(cached);
      if (Date.now() - cacheEntry.timestamp < CACHE_DURATION) {
        return cacheEntry.doctor;
      } else {
        // Cache expired
        localStorage.removeItem(`${DOCTOR_CACHE_KEY}_${doctorId}`);
      }
    }
  } catch (error) {
    console.warn('Failed to read doctor cache:', error);
    localStorage.removeItem(`${DOCTOR_CACHE_KEY}_${doctorId}`);
  }
  return null;
}

export function clearDoctorCache(doctorId?: string) {
  if (typeof window === 'undefined') return;
  try {
    if (doctorId) {
      localStorage.removeItem(`${DOCTOR_CACHE_KEY}_${doctorId}`);
    } else {
      // Clear all doctor caches
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (key && key.startsWith(DOCTOR_CACHE_KEY)) {
          localStorage.removeItem(key);
        }
      }
    }
  } catch (error) {
    console.warn('Failed to clear doctor cache:', error);
  }
}







