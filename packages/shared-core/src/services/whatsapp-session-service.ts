
import { db } from '@kloqo/shared-firebase';
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';

export interface WhatsAppSession {
    phoneNumber: string;
    clinicId: string;
    clinicName?: string;
    lastInteraction: any;
    lastMessageAt?: any; // Timestamp of last user message for 24h window tracking
    updatedAt: any;
    // Booking Wizard State
    bookingState?: 'idle' | 'doctor_selection' | 'date_selection' | 'slot_selection' | 'patient_selection' | 'info_gathering' | 'confirm_booking';
    bookingData?: {
        doctorId?: string;
        doctorName?: string;
        date?: string;
        slotIndex?: number;
        slotTime?: string;
        patientId?: string;
        patientName?: string;
        patientAge?: number;
        patientSex?: string;
        specialty?: string;
    };
}

export class WhatsAppSessionService {
    private static readonly COLLECTION = 'whatsapp_sessions';

    /**
     * Normalizes a phone number to always include + prefix.
     */
    private static normalizePhoneNumber(phoneNumber: string): string {
        let clean = phoneNumber.trim();
        if (!clean.startsWith('+')) {
            clean = `+${clean}`;
        }
        return clean;
    }

    /**
     * Retrieves a session for a given phone number.
     * @param phoneNumber The patient's WhatsApp phone number.
     */
    static async getSession(phoneNumber: string): Promise<WhatsAppSession | null> {
        try {
            const normalized = this.normalizePhoneNumber(phoneNumber);
            console.log(`[WhatsAppSessionService] Getting session for: ${phoneNumber} (normalized: ${normalized})`);
            const sessionRef = doc(db, this.COLLECTION, normalized);
            const sessionSnap = await getDoc(sessionRef);

            if (sessionSnap.exists()) {
                const data = sessionSnap.data() as WhatsAppSession;
                console.log(`[WhatsAppSessionService] Found session for ${normalized}:`, data);
                return data;
            }

            // Fallback: Check without + prefix (for legacy sessions)
            const fallbackRef = doc(db, this.COLLECTION, normalized.replace(/^\+/, ''));
            const fallbackSnap = await getDoc(fallbackRef);
            if (fallbackSnap.exists()) {
                const data = fallbackSnap.data() as WhatsAppSession;
                console.log(`[WhatsAppSessionService] Found legacy session for ${normalized.replace(/^\+/, '')}:`, data);
                return data;
            }

            console.log(`[WhatsAppSessionService] No session found for ${normalized}`);
            return null;
        } catch (error) {
            console.error('[WhatsAppSessionService] Error getting session:', error);
            return null;
        }
    }

    /**
     * Updates or creates a session with a clinicId.
     * @param phoneNumber The patient's WhatsApp phone number.
     * @param clinicId The ID of the clinic they are interacting with.
     * @param clinicName Optional name of the clinic.
     */
    static async updateSession(phoneNumber: string, clinicId: string, clinicName?: string): Promise<void> {
        try {
            const normalized = this.normalizePhoneNumber(phoneNumber);
            const sessionRef = doc(db, this.COLLECTION, normalized);
            await setDoc(sessionRef, {
                phoneNumber: normalized,
                clinicId,
                clinicName: clinicName || null,
                lastInteraction: serverTimestamp(),
                updatedAt: serverTimestamp()
            }, { merge: true });

            console.log(`[WhatsAppSessionService] Updated session for ${normalized} with clinic ${clinicId}`);
        } catch (error) {
            console.error('[WhatsAppSessionService] Error updating session:', error);
            throw error;
        }
    }

    /**
     * Updates the booking state and data for a session.
     */
    static async updateBookingState(
        phoneNumber: string,
        state: WhatsAppSession['bookingState'],
        data?: Partial<WhatsAppSession['bookingData']>
    ): Promise<void> {
        try {
            const normalized = this.normalizePhoneNumber(phoneNumber);
            const sessionRef = doc(db, this.COLLECTION, normalized);

            const update: any = {
                bookingState: state,
                lastInteraction: serverTimestamp(),
                updatedAt: serverTimestamp()
            };

            if (data) {
                // Merge booking data if provided
                const currentSnap = await getDoc(sessionRef);
                const currentData = currentSnap.exists() ? (currentSnap.data() as WhatsAppSession).bookingData || {} : {};
                update.bookingData = { ...currentData, ...data };
            }

            if (state === 'idle') {
                update.bookingData = null; // Clear booking data when returning to idle
            }

            await setDoc(sessionRef, update, { merge: true });
            console.log(`[WhatsAppSessionService] Updated booking state for ${normalized} to ${state}`);
        } catch (error) {
            console.error('[WhatsAppSessionService] Error updating booking state:', error);
        }
    }

    /**
     * Updates the last message timestamp for 24h window tracking.
     */
    static async updateLastUserMessage(phoneNumber: string): Promise<void> {
        try {
            const normalized = this.normalizePhoneNumber(phoneNumber);
            const sessionRef = doc(db, this.COLLECTION, normalized);
            await setDoc(sessionRef, {
                lastMessageAt: serverTimestamp(),
                updatedAt: serverTimestamp()
            }, { merge: true });
        } catch (error) {
            console.error('[WhatsAppSessionService] Error updating last message timestamp:', error);
        }
    }

    /**
     * Checks if the 24h free service window is open for a user.
     */
    static async isWindowOpen(phoneNumber: string): Promise<boolean> {
        try {
            const session = await this.getSession(phoneNumber);
            if (!session?.lastMessageAt) return false;

            const lastMessageTime = session.lastMessageAt.toDate();
            const now = new Date();
            const diffMs = now.getTime() - lastMessageTime.getTime();
            const diffHours = diffMs / (1000 * 60 * 60);

            console.log(`[WhatsAppSessionService] Window status for ${phoneNumber}: Last msg ${diffHours.toFixed(2)}h ago. Window Open: ${diffHours < 24}`);
            return diffHours < 24;
        } catch (error) {
            console.error('[WhatsAppSessionService] Error checking window status:', error);
            return false;
        }
    }
}
