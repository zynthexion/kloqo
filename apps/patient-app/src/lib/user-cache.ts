/**
 * User data caching utility for faster page loads
 * Stores user data in localStorage to enable progressive loading
 */

import type { AppUser } from '@/firebase/auth/use-user';

const USER_CACHE_KEY = 'kloqo_user_cache';
const CACHE_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

interface CachedUserData {
  user: AppUser;
  timestamp: number;
}

export const userCache = {
  /**
   * Get cached user data if still valid
   */
  get(): AppUser | null {
    if (typeof window === 'undefined') return null;

    try {
      const cached = localStorage.getItem(USER_CACHE_KEY);
      if (!cached) return null;

      const { user, timestamp }: CachedUserData = JSON.parse(cached);
      const now = Date.now();

      // Check if cache is still valid (within expiry time)
      if (now - timestamp < CACHE_EXPIRY_MS) {
        return user;
      }

      // Cache expired, remove it
      localStorage.removeItem(USER_CACHE_KEY);
      return null;
    } catch (error) {
      console.error('[UserCache] Error reading cache:', error);
      return null;
    }
  },

  /**
   * Store user data in cache
   */
  set(user: AppUser): void {
    if (typeof window === 'undefined') return;

    try {
      const cached: CachedUserData = {
        user,
        timestamp: Date.now(),
      };
      localStorage.setItem(USER_CACHE_KEY, JSON.stringify(cached));
    } catch (error) {
      console.error('[UserCache] Error storing cache:', error);
    }
  },

  /**
   * Clear cached user data
   */
  clear(): void {
    if (typeof window === 'undefined') return;
    localStorage.removeItem(USER_CACHE_KEY);
  },

  /**
   * Check if cache exists and is valid
   */
  isValid(): boolean {
    return this.get() !== null;
  },
};






