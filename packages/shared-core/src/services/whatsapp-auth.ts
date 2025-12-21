/**
 * WhatsApp Magic Link Authentication
 * 
 * Logic to validate magic tokens and initialize patient sessions
 * for WhatsApp-originated visits.
 */

export interface WhatsAppSession {
    patientId: string;
    userId?: string;
    doctorId?: string;
    clinicId?: string;
    action?: string;
    isWhatsApp: boolean;
}

/**
 * Validates a WhatsApp magic token and returns session data
 */
export function validateWhatsAppToken(token: string): WhatsAppSession | null {
    try {
        if (!token) return null;

        // Decode the base64 token
        const payloadStr = atob(token);
        const payload = JSON.parse(payloadStr);

        // Check if token is older than 24 hours (security measure)
        const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
        if (Date.now() - payload.ts > TWENTY_FOUR_HOURS) {
            console.warn('[WA-AUTH] Token expired');
            return null;
        }

        return {
            patientId: payload.pid,
            userId: payload.uid,
            doctorId: payload.did,
            clinicId: payload.cid,
            action: payload.act,
            isWhatsApp: true
        };
    } catch (error) {
        console.error('[WA-AUTH] Failed to validate token:', error);
        return null;
    }
}
