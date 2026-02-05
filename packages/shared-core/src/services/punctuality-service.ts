import { addDoc, collection, serverTimestamp, type Firestore } from 'firebase/firestore';
import { format } from 'date-fns';

export type PunctualityEventType = 'IN' | 'OUT' | 'BREAK_START' | 'BREAK_END' | 'EXTENSION';

/**
 * Logs a punctuality event for a doctor.
 * @param db Firestore instance
 * @param clinicId Clinic ID
 * @param doctor Doctor object (needs id, name, and availabilitySlots)
 * @param type Event type ('IN', 'OUT', 'BREAK_START', 'BREAK_END', 'EXTENSION')
 * @param sessionIndex (Optional) Current session index
 * @param metadata (Optional) Additional metadata
 */
export const logPunctualityEvent = async (
    db: Firestore,
    clinicId: string,
    doctor: { id: string; name: string; availabilitySlots?: any[] },
    type: PunctualityEventType,
    sessionIndex?: number,
    metadata?: any
) => {
    try {
        const now = new Date();
        const todayDay = format(now, 'EEEE');
        const todayStr = format(now, 'd MMMM yyyy');
        let scheduledTime: string | null = null;
        let finalSessionIndex = sessionIndex;

        if (doctor.availabilitySlots) {
            const todaysAvailability = doctor.availabilitySlots?.find(s => s.day === todayDay);
            if (todaysAvailability?.timeSlots) {
                // If sessionIndex is explicitly provided, use it
                if (sessionIndex !== undefined && todaysAvailability.timeSlots[sessionIndex]) {
                    const session = todaysAvailability.timeSlots[sessionIndex];
                    if (type === 'IN' || type === 'BREAK_START' || type === 'EXTENSION') {
                        scheduledTime = session.from;
                    } else if (type === 'OUT' || type === 'BREAK_END') {
                        scheduledTime = session.to;
                    }
                } else if (type === 'IN') {
                    // If marking IN but no sessionIndex, find the session that fits best
                    // (either active now or the first one of the day if we're early, or the last if we're late)
                    const slots = todaysAvailability.timeSlots;

                    // Simple logic: find session that is either current OR upcoming OR the one that just passed
                    // We'll just pick the first one where 'now' is before 'to', or the last if all passed.
                    let foundIndex = -1;
                    for (let i = 0; i < slots.length; i++) {
                        const s = slots[i];
                        // If we are before the end of this session, this is our best "intended" session
                        // (handles both early arrival for next session and late arrival for current)
                        if (now <= parseClinicTime(s.to, now)) {
                            foundIndex = i;
                            break;
                        }
                    }
                    if (foundIndex === -1 && slots.length > 0) {
                        foundIndex = slots.length - 1; // Last session (overtime)
                    }

                    if (foundIndex !== -1) {
                        finalSessionIndex = foundIndex;
                        scheduledTime = slots[foundIndex].from;
                    }
                }
            }
        }

        await addDoc(collection(db, 'doctor_punctuality_logs'), {
            clinicId,
            doctorId: doctor.id,
            doctorName: doctor.name,
            date: todayStr,
            sessionIndex: finalSessionIndex !== undefined ? finalSessionIndex : null,
            type,
            timestamp: serverTimestamp(),
            scheduledTime,
            metadata: metadata ?? {}
        });
    } catch (error) {
        console.error('Error logging punctuality event:', error);
    }
};
