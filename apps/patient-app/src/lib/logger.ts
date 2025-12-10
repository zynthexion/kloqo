/**
 * Logger utility for development and production environments
 * 
 * In development: All logs are printed to console
 * In production: Only errors and warnings are logged
 * 
 * Usage:
 *   import { logger } from '@/lib/logger';
 *   logger.debug('Debug info', { data });
 *   logger.info('Info message');
 *   logger.warn('Warning');
 *   logger.error('Error', error);
 */

const isDevelopment = process.env.NODE_ENV === 'development';
const isDebugEnabled = process.env.NEXT_PUBLIC_DEBUG_BOOKING === 'true';

export const logger = {
    /**
     * Debug logs - only in development or when debug flag is enabled
     * Use for detailed debugging information
     */
    debug: (...args: any[]) => {
        if (isDevelopment || isDebugEnabled) {
            console.log('[DEBUG]', ...args);
        }
    },

    /**
     * Info logs - only in development
     * Use for general information
     */
    info: (...args: any[]) => {
        if (isDevelopment) {
            console.info('[INFO]', ...args);
        }
    },

    /**
     * Warning logs - always logged
     * Use for non-critical issues that should be investigated
     */
    warn: (...args: any[]) => {
        console.warn('[WARN]', ...args);
    },

    /**
     * Error logs - always logged
     * Use for errors and exceptions
     */
    error: (...args: any[]) => {
        console.error('[ERROR]', ...args);
    },

    /**
     * Booking-specific debug logs
     * Controlled by NEXT_PUBLIC_DEBUG_BOOKING environment variable
     */
    booking: (...args: any[]) => {
        if (isDebugEnabled) {
            console.log('[BOOKING]', ...args);
        }
    },
};

/**
 * Helper to sanitize sensitive data before logging
 * Removes or masks sensitive fields like tokens, passwords, etc.
 */
export function sanitizeForLog<T extends Record<string, any>>(data: T): Record<string, any> {
    const sensitiveKeys = ['password', 'token', 'fcmToken', 'apiKey', 'secret'];
    const sanitized: Record<string, any> = { ...data };

    for (const key of Object.keys(sanitized)) {
        if (sensitiveKeys.some(sensitive => key.toLowerCase().includes(sensitive))) {
            sanitized[key] = '[REDACTED]';
        }
    }

    return sanitized;
}
