/**
 * Notification Configuration Service
 * Manages WhatsApp notification toggle settings from Firestore
 */

import { Firestore, doc, getDoc, collection } from 'firebase/firestore';

// Notification type identifiers
export const NOTIFICATION_TYPES = {
    APPOINTMENT_BOOKED_BY_STAFF: 'appointment_booked_by_staff',
    ARRIVAL_CONFIRMED: 'arrival_confirmed',
    TOKEN_CALLED: 'token_called',
    APPOINTMENT_CANCELLED: 'appointment_cancelled',
    DOCTOR_RUNNING_LATE: 'doctor_running_late',
    BREAK_UPDATE: 'break_update',
    APPOINTMENT_SKIPPED: 'appointment_skipped',
    PEOPLE_AHEAD: 'people_ahead',
    DOCTOR_CONSULTATION_STARTED: 'doctor_consultation_started',
    DAILY_REMINDER: 'daily_reminder',
    FREE_FOLLOWUP_EXPIRY: 'free_followup_expiry',
    CONSULTATION_COMPLETED: 'consultation_completed',
    AI_FALLBACK: 'ai_fallback',
    BOOKING_LINK: 'booking_link',
} as const;

export type NotificationType = typeof NOTIFICATION_TYPES[keyof typeof NOTIFICATION_TYPES];

export interface NotificationConfig {
    id: string;
    name: string;
    description: string;
    whatsappEnabled: boolean;
    pwaEnabled: boolean;
    category: 'booking' | 'status' | 'queue' | 'reminder' | 'follow-up';
    channels: ('whatsapp' | 'pwa')[];
    updatedAt: any;
    updatedBy?: string;
}

// Cache for notification settings (5 minute TTL)
const notificationCache = new Map<string, { enabled: boolean; timestamp: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Check if a notification type is enabled for a specific channel
 * Uses caching to minimize Firestore reads
 */
export async function isNotificationEnabled(
    firestore: Firestore,
    notificationType: NotificationType,
    channel: 'whatsapp' | 'pwa' = 'whatsapp'
): Promise<boolean> {
    try {
        // Check cache first
        const cacheKey = `${notificationType}_${channel}`;
        const cached = notificationCache.get(cacheKey);
        const now = Date.now();

        if (cached && (now - cached.timestamp) < CACHE_TTL) {
            console.log(`[NotificationConfig] Cache hit for ${cacheKey}: ${cached.enabled}`);
            return cached.enabled;
        }

        // Fetch from Firestore
        const configRef = doc(firestore, 'system-config', 'notifications', 'templates', notificationType);
        const configSnap = await getDoc(configRef);

        if (!configSnap.exists()) {
            // If config doesn't exist, default to enabled
            console.info(`[NotificationConfig] ℹ️ Using default 'enabled' state for ${notificationType} (${channel}). (Config document not yet initialized in Firestore)`);
            notificationCache.set(cacheKey, { enabled: true, timestamp: now });
            return true;
        }

        const config = configSnap.data() as any;
        const enabled = channel === 'whatsapp'
            ? (config.whatsappEnabled ?? config.enabled ?? true)
            : (config.pwaEnabled ?? true);

        // Update cache
        notificationCache.set(cacheKey, { enabled, timestamp: now });
        console.log(`[NotificationConfig] Fetched ${cacheKey}: ${enabled}`);

        return enabled;
    } catch (error) {
        console.error(`[NotificationConfig] Error checking notification status for ${notificationType} (${channel}):`, error);
        // On error, default to enabled to avoid breaking notifications
        return true;
    }
}

/**
 * Clear the notification cache (useful for testing or manual refresh)
 */
export function clearNotificationCache(): void {
    notificationCache.clear();
    console.log('[NotificationConfig] Cache cleared');
}

/**
 * Get all notification configurations
 * Used by Super Admin UI
 */
export async function getAllNotificationConfigs(firestore: Firestore): Promise<NotificationConfig[]> {
    try {
        const configs: NotificationConfig[] = [];

        for (const notificationType of Object.values(NOTIFICATION_TYPES)) {
            const configRef = doc(firestore, 'system-config', 'notifications', 'templates', notificationType);
            const configSnap = await getDoc(configRef);

            if (configSnap.exists()) {
                configs.push({ id: notificationType, ...configSnap.data() } as NotificationConfig);
            }
        }

        return configs;
    } catch (error) {
        console.error('[NotificationConfig] Error fetching all configs:', error);
        return [];
    }
}

/**
 * Notification metadata for UI display
 */
export const NOTIFICATION_METADATA: Record<NotificationType, { name: string; description: string; category: NotificationConfig['category']; channels: NotificationConfig['channels'] }> = {
    [NOTIFICATION_TYPES.APPOINTMENT_BOOKED_BY_STAFF]: {
        name: 'Appointment Booked by Staff',
        description: 'Sent when nurse/admin books an appointment for a patient',
        category: 'booking',
        channels: ['whatsapp', 'pwa'],
    },
    [NOTIFICATION_TYPES.ARRIVAL_CONFIRMED]: {
        name: 'Arrival Confirmed',
        description: 'Sent when patient arrives at clinic. (WA Templates: walkin_arrival_confirmed_malayalam / appointment_status_confirmed_mlm)',
        category: 'status',
        channels: ['whatsapp', 'pwa'],
    },
    [NOTIFICATION_TYPES.TOKEN_CALLED]: {
        name: 'Token Called',
        description: 'Sent when patient\'s token is called for consultation. (WA Template: token_called_quick_reply_ml)',
        category: 'queue',
        channels: ['whatsapp', 'pwa'],
    },
    [NOTIFICATION_TYPES.APPOINTMENT_CANCELLED]: {
        name: 'Appointment Cancelled',
        description: 'Sent when an appointment is cancelled. (WA Template: appointment_cancelled_ml)',
        category: 'status',
        channels: ['whatsapp', 'pwa'],
    },
    [NOTIFICATION_TYPES.DOCTOR_RUNNING_LATE]: {
        name: 'Doctor Running Late',
        description: 'Sent when doctor is running behind schedule',
        category: 'status',
        channels: ['whatsapp', 'pwa'],
    },
    [NOTIFICATION_TYPES.BREAK_UPDATE]: {
        name: 'Break Update',
        description: 'Sent when doctor takes a break affecting patient appointments',
        category: 'status',
        channels: ['whatsapp', 'pwa'],
    },
    [NOTIFICATION_TYPES.APPOINTMENT_SKIPPED]: {
        name: 'Appointment Skipped',
        description: 'Sent when patient misses their appointment window',
        category: 'status',
        channels: ['whatsapp', 'pwa'],
    },
    [NOTIFICATION_TYPES.PEOPLE_AHEAD]: {
        name: 'Queue Updates (People Ahead)',
        description: 'Sent to inform patients about their position in queue',
        category: 'queue',
        channels: ['whatsapp', 'pwa'],
    },
    [NOTIFICATION_TYPES.DOCTOR_CONSULTATION_STARTED]: {
        name: 'Doctor Consultation Started',
        description: 'Sent when doctor starts consultation with a patient',
        category: 'queue',
        channels: ['whatsapp', 'pwa'],
    },
    [NOTIFICATION_TYPES.DAILY_REMINDER]: {
        name: 'Daily Reminder (5 PM / 7 AM)',
        description: 'Batch reminders sent at 5 PM (next day) and 7 AM (same day)',
        category: 'reminder',
        channels: ['whatsapp', 'pwa'],
    },
    [NOTIFICATION_TYPES.FREE_FOLLOWUP_EXPIRY]: {
        name: 'Free Follow-Up Expiry',
        description: 'Sent when free follow-up period is about to expire',
        category: 'follow-up',
        channels: ['whatsapp', 'pwa'],
    },
    [NOTIFICATION_TYPES.CONSULTATION_COMPLETED]: {
        name: 'Consultation Completed (Checkout)',
        description: 'Sent when a patient\'s consultation is finished',
        category: 'status',
        channels: ['pwa'],
    },
    [NOTIFICATION_TYPES.AI_FALLBACK]: {
        name: 'AI Fallback Link',
        description: 'Sent when consultation cannot be booked via WhatsApp AI bot',
        category: 'booking',
        channels: ['whatsapp'],
    },
    [NOTIFICATION_TYPES.BOOKING_LINK]: {
        name: 'Direct Booking Link',
        description: 'Sent when a direct booking link is requested or shared',
        category: 'booking',
        channels: ['whatsapp'],
    },
};
