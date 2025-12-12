import {
    collection,
    query,
    where,
    getDocs,
    doc,
    writeBatch,
    Timestamp,
    getDoc,
    type Firestore
} from 'firebase/firestore';
import { format, addMinutes, parseISO } from 'date-fns';
import type { Appointment, BreakPeriod } from '@kloqo/shared-types';
import { parseTime } from '../utils/break-helpers';
import { sendBreakUpdateNotification } from './notification-service';

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

        const appointmentsQuery = query(
            collection(db, 'appointments'),
            where('doctor', '==', doctorName),
            where('clinicId', '==', clinicId),
            where('date', '==', dateStr),
            where('sessionIndex', '==', sessionIndex)
        );

        const snapshot = await getDocs(appointmentsQuery);

        const updates: {
            originalDocRef: any;
            newDocRef: any;
            originalData: Appointment;
            newData: any;
        }[] = [];

        snapshot.docs.forEach(docSnap => {
            const appt = docSnap.data() as Appointment;

            // Skip if already cancelled (standard check)
            if (appt.status === 'Cancelled') return;

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

            // Calculate new token numbers for A tokens only (W tokens stay the same)
            let newNumericToken = appt.numericToken;
            let newTokenNumber = appt.tokenNumber;

            // Only update token numbers for Advance bookings (A tokens)
            // Walk-ins (W tokens) keep their original token numbers
            if (appt.tokenNumber && !appt.tokenNumber.startsWith('W') && newSlotIndex !== null) {
                // For A tokens, recalculate based on new slot position
                // numericToken is the sequential number (1, 2, 3, etc.)
                // tokenNumber is the formatted string (e.g., "A001", "A002")
                newNumericToken = newSlotIndex + 1; // Slot 0 = Token 1, Slot 1 = Token 2, etc.
                newTokenNumber = `A${String(newNumericToken).padStart(3, '0')}`;
            }

            // Prepare data for new appointment
            const newDocRef = doc(collection(db, 'appointments'));
            const newData = {
                ...appt,
                id: newDocRef.id, // Explicitly set new ID
                time: newTimeStr,
                arriveByTime: format(newArriveBy, 'hh:mm a'),
                ...(newSlotIndex !== null ? { slotIndex: newSlotIndex } : {}),
                ...(newCutOffTime ? { cutOffTime: Timestamp.fromDate(newCutOffTime) } : {}),
                ...(newNoShowTime ? { noShowTime: Timestamp.fromDate(newNoShowTime) } : {}),
                ...(newNumericToken !== appt.numericToken ? { numericToken: newNumericToken } : {}),
                ...(newTokenNumber !== appt.tokenNumber ? { tokenNumber: newTokenNumber } : {}),
                previousAppointmentId: docSnap.id
            };

            updates.push({
                originalDocRef: doc(db, 'appointments', docSnap.id),
                newDocRef,
                originalData: appt,
                newData
            });
        });

        const batch = writeBatch(db);

        for (const update of updates) {
            // 1. Mark Original as Completed (blocked during break)
            batch.update(update.originalDocRef, {
                status: 'Completed',
                cancelledByBreak: true
            });

            // 2. Delete the slot reservation for the original appointment
            // This ensures the slot is properly blocked during the break
            const slotIndex = update.originalData.slotIndex;
            if (typeof slotIndex === 'number') {
                const reservationId = `${clinicId}_${doctorName}_${dateStr}_slot_${slotIndex}`;
                const reservationRef = doc(db, 'slot-reservations', reservationId);
                batch.delete(reservationRef);
            }

            // 3. Create New shifted appointment
            batch.set(update.newDocRef, update.newData);
        }

        if (updates.length > 0) {
            await batch.commit();

            // 4. Send Notifications for Shifted Appointments
            // We do this AFTER the batch commit to ensure data consistency
            // If notifications fail, the schedule change is still valid
            try {
                // Fetch clinic name for notifications
                let clinicName = 'The Clinic';
                try {
                    const clinicDoc = await getDoc(doc(db, 'clinics', clinicId));
                    if (clinicDoc.exists()) {
                        clinicName = clinicDoc.data().name || 'The Clinic';
                    }
                } catch (err) {
                    console.warn('[BREAK SERVICE] Failed to fetch clinic name for notifications:', err);
                }

                // Send notifications in parallel (ignoring failures)
                await Promise.allSettled(updates.map(async (update) => {
                    const { originalData, newData, newDocRef } = update;

                    if (!originalData.patientId) return;

                    try {
                        await sendBreakUpdateNotification({
                            firestore: db,
                            patientId: originalData.patientId,
                            appointmentId: newDocRef.id, // Use new appointment ID
                            doctorName: doctorName,
                            clinicName: clinicName,
                            oldTime: originalData.time,
                            newTime: newData.time,
                            oldDate: originalData.date, // Should be same date
                            newDate: newData.date,      // Should be same date
                            reason: 'Doctor break scheduled',
                            oldArriveByTime: originalData.arriveByTime,
                            newArriveByTime: newData.arriveByTime
                        });
                    } catch (notifErr) {
                        console.error(`[BREAK SERVICE] Failed to notify patient ${originalData.patientId} about schedule change:`, notifErr);
                    }
                }));

            } catch (notificationError) {
                console.error('[BREAK SERVICE] Error in notification block:', notificationError);
                // Don't throw here - the main operation (schedule shift) succeeded
            }
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
