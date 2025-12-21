import { format } from 'date-fns';

/**
 * WhatsApp Integration Service
 * 
 * Provides utilities for generating magic links and formatting 
 * WhatsApp-optimized messages.
 */

interface DeepLinkOptions {
    baseUrl: string;
    patientId: string;
    doctorId?: string;
    clinicId?: string;
    action?: 'book' | 'view' | 'live';
}

/**
 * Generates a magic link for WhatsApp with a secure token
 * (Simplified for now - using base64 for POC)
 */
export function generateWhatsAppMagicLink(options: DeepLinkOptions): string {
    const { baseUrl, patientId, doctorId, clinicId, action = 'book' } = options;

    // Create a payload for the magic link
    const payload = JSON.stringify({
        pid: patientId,
        did: doctorId,
        cid: clinicId,
        act: action,
        ts: Date.now()
    });

    // In production, this would be encrypted/signed
    const token = btoa(payload);

    const url = new URL(baseUrl);
    url.searchParams.set('wa', 'true');
    url.searchParams.set('tk', token);

    return url.toString();
}

/**
 * Formats a message for WhatsApp with bolding and spacing
 */
export function formatWhatsAppMessage(message: string): string {
    // Basic WhatsApp markdown formatting
    // We can add more sophisticated template handling here later
    return message;
}

/**
 * Example template for a booking confirmation
 */
export function getBookingConfirmationTemplate(doctorName: string, time: string, clinicName: string): string {
    return [
        `*Appointment Confirmed!* ✅`,
        ``,
        `Hello, your appointment with *Dr. ${doctorName}* at *${clinicName}* is confirmed.`,
        ``,
        `📅 *Time:* ${time}`,
        ``,
        `You can track your live token number here:`,
    ].join('\n');
}
