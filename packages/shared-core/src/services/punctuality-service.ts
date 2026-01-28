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

        if (sessionIndex !== undefined && doctor.availabilitySlots) {
            const todaysAvailability = doctor.availabilitySlots?.find(s => s.day === todayDay);
            if (todaysAvailability?.timeSlots[sessionIndex]) {
                const session = todaysAvailability.timeSlots[sessionIndex];
                if (type === 'IN' || type === 'BREAK_START' || type === 'EXTENSION') {
                    scheduledTime = session.from;
                } else if (type === 'OUT' || type === 'BREAK_END') {
                    scheduledTime = session.to;
                }
            }
        }

        await addDoc(collection(db, 'doctor_punctuality_logs'), {
            clinicId,
            doctorId: doctor.id,
            doctorName: doctor.name,
            date: todayStr,
            sessionIndex: sessionIndex !== undefined ? sessionIndex : null,
            type,
            timestamp: serverTimestamp(),
            scheduledTime,
            metadata: metadata ?? {}
        });
    } catch (error) {
        console.error('Error logging punctuality event:', error);
    }
};
