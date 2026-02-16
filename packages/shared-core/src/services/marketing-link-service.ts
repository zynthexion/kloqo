import { collection, addDoc, serverTimestamp } from 'firebase/firestore';
import type { Firestore } from 'firebase/firestore';

/**
 * Marketing Link Service
 * Generates tracking links for WhatsApp campaigns and logs sends for CTR calculation
 */

export interface MarketingLinkParams {
    magicToken: string;
    ref: string;                    // Campaign identifier (e.g., "booking_confirmed", "reminder_2h")
    campaign: string;               // Campaign name (e.g., "appointment_reminder")
    medium: string;                 // Medium type (e.g., "notification", "batch_reminder", "utility_window")
    clinicId: string;
    phone: string;
    patientName?: string;
    appointmentId?: string;
}

/**
 * Generate a marketing link with tracking parameters and log the send
 * This enables accurate CTR calculation by tracking both sends and clicks
 */
export async function generateAndTrackMarketingLink(
    firestore: Firestore,
    params: MarketingLinkParams
): Promise<string> {
    // 1. Generate tracking link
    const baseUrl = process.env.NEXT_PUBLIC_PATIENT_APP_URL || 'https://app.kloqo.com';
    const url = new URL(`${baseUrl}/magic-login`);

    // Add tracking parameters
    url.searchParams.set('token', params.magicToken);
    url.searchParams.set('ref', params.ref);
    url.searchParams.set('source', 'whatsapp');
    url.searchParams.set('medium', params.medium);
    url.searchParams.set('campaign', params.campaign);
    url.searchParams.set('clinic', params.clinicId);

    if (params.appointmentId) {
        url.searchParams.set('appt', params.appointmentId);
    }

    // 2. Track that we sent this link (for CTR calculation)
    try {
        await addDoc(collection(firestore, 'campaign_sends'), {
            ref: params.ref,
            campaign: params.campaign,
            medium: params.medium,
            clinicId: params.clinicId,
            appointmentId: params.appointmentId || null,
            phone: params.phone,
            patientName: params.patientName || 'Unknown',
            sentAt: serverTimestamp(),
        });
    } catch (error) {
        console.error('[Marketing] Failed to track campaign send:', error);
        // Don't fail the link generation if tracking fails
    }

    return url.toString();
}

/**
 * Generate just the tracking parameters for use in existing template logic
 * This is useful when the template already has the base URL hardcoded.
 */
export async function generateMarketingSuffix(
    firestore: Firestore,
    params: MarketingLinkParams
): Promise<string> {
    // 1. Log the send (same as above)
    try {
        await addDoc(collection(firestore, 'campaign_sends'), {
            ref: params.ref,
            campaign: params.campaign,
            medium: params.medium,
            clinicId: params.clinicId,
            appointmentId: params.appointmentId || null,
            phone: params.phone,
            patientName: params.patientName || 'Unknown',
            sentAt: serverTimestamp(),
        });
    } catch (error) {
        console.error('[Marketing] Failed to track campaign send:', error);
    }

    // 2. Return the suffix: ref=...&source=...&medium=...&campaign=...&clinic=...&token=...[appt=...]
    const searchParams = new URLSearchParams();
    searchParams.set('token', params.magicToken);
    searchParams.set('ref', params.ref);
    searchParams.set('source', 'whatsapp');
    searchParams.set('medium', params.medium);
    searchParams.set('campaign', params.campaign);
    searchParams.set('clinic', params.clinicId);

    if (params.appointmentId) {
        searchParams.set('appt', params.appointmentId);
    }

    return searchParams.toString();
}

/**
 * Extract campaign parameters from URL search params
 */
export function extractCampaignParams(searchParams: URLSearchParams) {
    return {
        ref: searchParams.get('ref') || '',
        source: searchParams.get('source') || '',
        medium: searchParams.get('medium') || '',
        campaign: searchParams.get('campaign') || '',
        clinicId: searchParams.get('clinic') || '',
        appointmentId: searchParams.get('appt') || undefined,
    };
}

/**
 * Check if the current request is from a WhatsApp bot/crawler
 * These bots fetch link previews and should not be counted as real clicks
 */
export function isWhatsAppBot(userAgent: string): boolean {
    const ua = userAgent.toLowerCase();
    return (
        ua.includes('whatsapp') ||
        ua.includes('facebookexternalhit') ||
        ua.includes('metadebugger') ||
        ua.includes('bot')
    );
}

/**
 * Detect device type from user agent
 */
export function getDeviceType(userAgent: string): 'mobile' | 'desktop' | 'tablet' {
    const ua = userAgent.toLowerCase();

    if (ua.includes('tablet') || ua.includes('ipad')) {
        return 'tablet';
    }

    if (ua.includes('mobile') || ua.includes('android') || ua.includes('iphone')) {
        return 'mobile';
    }

    return 'desktop';
}
