import {
    collection,
    query,
    where,
    getDocs,
    doc,
    writeBatch,
    Timestamp,
    type Firestore
} from 'firebase/firestore';
import { format, addMinutes, parseISO } from 'date-fns';
import type { Appointment, BreakPeriod } from '@kloqo/shared-types';
import { parseTime } from '../utils/break-helpers';

/**
 * Shifts appointments physically (updates slotIndex and time) to accommodate a new break.
 * This ensures that if the break is later cancelled, the original slots appear as "gaps" (empty).
 */
export async function shiftAppointmentsForNewBreak(
    db: Firestore,
    breakPeriod: BreakPeriod,
    sessionIndex: number,
    date: Date,
    doctorName: string,
    clinicId: string,
    averageConsultingTime: number = 15
): Promise<void> {
    try {
        const dateStr = format(date, 'd MMMM yyyy');
        const breakStart = parseISO(breakPeriod.startTime);
        const breakDuration = breakPeriod.duration || 0;

        console.log('[BREAK SERVICE] Starting adjustment for new break', {
            breakStart: format(breakStart, 'hh:mm a'),
            breakDuration,
            date: dateStr,
            sessionIndex,
            doctorName,
            clinicId
        });

        const appointmentsQuery = query(
            collection(db, 'appointments'),
            where('doctor', '==', doctorName),
            where('clinicId', '==', clinicId),
            where('date', '==', dateStr),
            where('sessionIndex', '==', sessionIndex)
        );

        const snapshot = await getDocs(appointmentsQuery);

        const appointmentsToUpdate: {
            id: string;
            adjustedArriveByTime: string;
            newTime: string;
            newSlotIndex: number | null;
            newCutOffTime: Date | null;
            newNoShowTime: Date | null;
            oldTime: string;
        }[] = [];

        snapshot.docs.forEach(docSnap => {
            const appt = docSnap.data() as Appointment;

            const baseTimeStr = appt.arriveByTime || appt.time;
            if (!baseTimeStr) return;

            const apptArriveBy = parseTime(baseTimeStr, date);

            // Only adjust appointments that are on/after the break start
            if (apptArriveBy.getTime() < breakStart.getTime()) {
                return;
            }

            const cutOffDate = appt.cutOffTime && typeof (appt.cutOffTime as any).toDate === 'function'
                ? (appt.cutOffTime as any).toDate()
                : appt.cutOffTime instanceof Date
                    ? appt.cutOffTime
                    : null;

            const noShowDate = appt.noShowTime && typeof (appt.noShowTime as any).toDate === 'function'
                ? (appt.noShowTime as any).toDate()
                : appt.noShowTime instanceof Date
                    ? appt.noShowTime
                    : null;

            const newArriveBy = addMinutes(apptArriveBy, breakDuration);
            const newCutOffTime = cutOffDate ? addMinutes(cutOffDate, breakDuration) : null;
            const newNoShowTime = noShowDate ? addMinutes(noShowDate, breakDuration) : null;

            // Shift 'time' and 'slotIndex'
            const slotsToShift = Math.ceil(breakDuration / averageConsultingTime);
            const newTimeStr = format(newArriveBy, 'hh:mm a');
            const newSlotIndex = typeof appt.slotIndex === 'number' ? appt.slotIndex + slotsToShift : null;

            appointmentsToUpdate.push({
                id: docSnap.id,
                adjustedArriveByTime: format(newArriveBy, 'hh:mm a'),
                newTime: newTimeStr,
                newSlotIndex,
                newCutOffTime,
                newNoShowTime,
                oldTime: appt.time
            });
        });

        const batch = writeBatch(db);
        for (const appt of appointmentsToUpdate) {
            const apptRef = doc(db, 'appointments', appt.id);
            batch.update(apptRef, {
                time: appt.newTime,
                arriveByTime: appt.adjustedArriveByTime,
                ...(appt.newSlotIndex !== null ? { slotIndex: appt.newSlotIndex } : {}),
                ...(appt.newCutOffTime ? { cutOffTime: Timestamp.fromDate(appt.newCutOffTime) } : {}),
                ...(appt.newNoShowTime ? { noShowTime: Timestamp.fromDate(appt.newNoShowTime) } : {}),
            });
        }

        if (appointmentsToUpdate.length > 0) {
            await batch.commit();
            console.log(`[BREAK SERVICE] ✅ Successfully adjusted ${appointmentsToUpdate.length} appointments`, {
                breakStart: format(breakStart, 'hh:mm a'),
                firstAdjustment: appointmentsToUpdate[0]?.oldTime + ' -> ' + appointmentsToUpdate[0]?.newTime
            });
        }
    } catch (error) {
        console.error('[BREAK SERVICE] ❌ Error shifting appointments:', error);
        throw error;
    }
}

/**
 * Validates that extending a session does not overlap with the start of the next session.
 */
export function validateBreakOverlapWithNextSession(
    doctor: Partial<any>, // Using any/Partial<Doctor> to avoid strict type issues if Doctor type is complex
    date: Date,
    sessionIndex: number,
    extendedEndTime: Date
): { valid: boolean; error?: string } {
    if (!doctor?.availabilitySlots?.length) {
        return { valid: true };
    }

    const dayOfWeek = format(date, 'EEEE');
    const availabilityForDay = doctor.availabilitySlots.find((slot: any) => slot.day === dayOfWeek);

    if (!availabilityForDay?.timeSlots?.length) {
        return { valid: true };
    }

    // Find the current session to get its original end time (for debugging mostly)
    // and to find the NEXT session.
    // Assuming availabilityForDay.timeSlots are sorted by time (which they usually are).
    // If not, we should sort them.
    const sortedSessions = [...availabilityForDay.timeSlots].sort((a, b) => {
        const startA = parseTime(a.from, date).getTime();
        const startB = parseTime(b.from, date).getTime();
        return startA - startB;
    });

    // Find index in the sorted array (sessionIndex passed might correspond to original index, 
    // but usually they are index-ordered. Let's assume sessionIndex matches the sorted order for now,
    // OR we find the session by index if it's strictly index-based).
    // Actually, sessionIndex is usually the index in availabilityForDay.timeSlots.
    const currentSession = availabilityForDay.timeSlots[sessionIndex];
    if (!currentSession) return { valid: true };

    // Find the next session that starts AFTER the current session
    // We need to parse times to compare
    const currentStart = parseTime(currentSession.from, date);

    // Check all other sessions
    let nextSessionStart: Date | null = null;

    for (let i = 0; i < availabilityForDay.timeSlots.length; i++) {
        if (i === sessionIndex) continue; // Skip current session

        const session = availabilityForDay.timeSlots[i];
        const start = parseTime(session.from, date);

        // If this session starts after current session, it's a candidate for "next session"
        if (start.getTime() > currentStart.getTime()) {
            if (!nextSessionStart || start.getTime() < nextSessionStart.getTime()) {
                nextSessionStart = start;
            }
        }
    }

    if (nextSessionStart) {
        // Check for overlap
        // If extended end time > next session start time
        if (extendedEndTime.getTime() > nextSessionStart.getTime()) {
            // We allow touching (end == start)? usually not, best to have 0 overlap.
            return {
                valid: false,
                error: `Extending this session (to ${format(extendedEndTime, 'hh:mm a')}) overlaps with the next session starting at ${format(nextSessionStart, 'hh:mm a')}.`
            };
        }
    }

    return { valid: true };
}
