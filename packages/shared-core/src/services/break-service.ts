import {
    collection,
    query,
    where,
    getDocs,
    doc,
    writeBatch,
    Timestamp,
    getDoc,
    limit,
    type Firestore
} from 'firebase/firestore';
import { format, addMinutes, parseISO, differenceInMinutes } from 'date-fns';
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

        // Parse break start from formatted time
        const breakStart = breakPeriod.startTimeFormatted
            ? parseTime(breakPeriod.startTimeFormatted, date)
            : parseISO(breakPeriod.startTime);

        // Normalize to remove seconds/milliseconds
        breakStart.setSeconds(0, 0);

        const breakDuration = breakPeriod.duration || 0;

        // CRITICAL FIX: Calculate breakEnd using duration, NOT formatted time
        // endTimeFormatted "03:29 PM" parses to 3:29:00, but we need 3:30:00
        // So we must use: breakStart + duration = 3:00:00 + 30 min = 3:30:00
        const breakEnd = addMinutes(breakStart, breakDuration);

        // Normalize to remove seconds/milliseconds
        breakEnd.setSeconds(0, 0);

        const appointmentsQuery = query(
            collection(db, 'appointments'),
            where('doctor', '==', doctorName),
            where('clinicId', '==', clinicId),
            where('date', '==', dateStr),
            where('sessionIndex', '==', sessionIndex)
        );

        const snapshot = await getDocs(appointmentsQuery);

        // First pass: identify which slots will be cancelled by the break
        // This helps us calculate where to shift appointments to
        const cancelledSlotIndices = new Set<number>();

        snapshot.docs.forEach(docSnap => {
            const appt = docSnap.data() as Appointment;
            if (appt.status === 'Cancelled') return;

            const baseTimeStr = appt.arriveByTime || appt.time;
            if (!baseTimeStr) return;

            const apptArriveBy = parseTime(baseTimeStr, date);
            // Normalize to remove seconds/milliseconds for accurate comparison
            apptArriveBy.setSeconds(0, 0);

            // Check if this appointment falls within the break period
            // Appointment is cancelled if: breakStart <= apptTime < breakEnd
            if (apptArriveBy.getTime() >= breakStart.getTime() &&
                apptArriveBy.getTime() < breakEnd.getTime()) {
                if (typeof appt.slotIndex === 'number') {
                    cancelledSlotIndices.add(appt.slotIndex);
                }
            }
        });

        // Find the last slot that will be cancelled
        const lastCancelledSlot = cancelledSlotIndices.size > 0
            ? Math.max(...Array.from(cancelledSlotIndices))
            : -1;

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

            // Only shift appointments that are at or after the break start
            if (apptArriveBy.getTime() < breakStart.getTime()) {
                return; // Skip appointments before the break
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

            // Calculate new slot index
            // For appointments during the break: shift to after the last cancelled slot
            // For appointments after the break: shift by break duration
            const slotsToShift = Math.ceil(breakDuration / averageConsultingTime);
            const newTimeStr = format(newArriveBy, 'hh:mm a');

            let newSlotIndex: number | null = null;

            if (typeof appt.slotIndex === 'number') {
                // UNIFORM SHIFTING:
                // Regardless of whether it's during or after the break,
                // we shift everything by the break duration (tokens count).
                // This ensures "Index 0" becomes "Index 6" (if break is 6 slots).
                // It also aligns with the time calculation (Time + Duration).

                newSlotIndex = appt.slotIndex + slotsToShift;
            }

            // Prepare data for new appointment
            // Note: Token numbers will be resequenced collectively after all shifts are complete
            const newDocRef = doc(collection(db, 'appointments'));
            const newData = {
                ...appt,
                id: newDocRef.id, // Explicitly set new ID
                time: newTimeStr,
                arriveByTime: format(newArriveBy, 'hh:mm a'),
                ...(newSlotIndex !== null ? { slotIndex: newSlotIndex } : {}),
                ...(newCutOffTime ? { cutOffTime: Timestamp.fromDate(newCutOffTime) } : {}),
                ...(newNoShowTime ? { noShowTime: Timestamp.fromDate(newNoShowTime) } : {}),
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
            const originalTime = parseTime(update.originalData.arriveByTime || update.originalData.time, date);
            originalTime.setSeconds(0, 0);

            // CRITICAL FIX: Only mark as cancelled if appointment is DURING the break
            // Appointments AFTER the break should be shifted but NOT cancelled
            const isDuringBreak = originalTime.getTime() >= breakStart.getTime() &&
                originalTime.getTime() < breakEnd.getTime();

            if (isDuringBreak) {
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
            } else {
                // Appointment is AFTER the break, just delete the original
                batch.delete(update.originalDocRef);
            }

            // 3. Create New shifted appointment
            batch.set(update.newDocRef, update.newData);
        }

        // --- NEW LOGIC: Create Dummy Appointments for Empty Slots in Break ---
        try {
            // we need the doctor to find session start time for accurate slot index calculation
            const doctorsQuery = query(
                collection(db, 'doctors'),
                where('name', '==', doctorName),
                where('clinicId', '==', clinicId),
                limit(1)
            );
            const doctorSnapshot = await getDocs(doctorsQuery);

            if (!doctorSnapshot.empty) {
                const doctorDoc = doctorSnapshot.docs[0];
                const doctorData = doctorDoc.data();

                // Find session start time
                const dayOfWeek = format(date, 'EEEE');
                const availabilitySlot = doctorData.availabilitySlots?.find((s: any) => s.day === dayOfWeek);
                if (availabilitySlot && availabilitySlot.timeSlots && availabilitySlot.timeSlots[sessionIndex]) {
                    const sessionTime = availabilitySlot.timeSlots[sessionIndex];
                    const sessionStart = parseTime(sessionTime.from, date);

                    // Calculate first and last slot index of the break
                    // slotIndex = (Time - SessionStart) / duration
                    const breakStartDiff = differenceInMinutes(breakStart, sessionStart);
                    const startSlotIndex = Math.floor(breakStartDiff / averageConsultingTime);

                    const breakEndDiff = differenceInMinutes(breakEnd, sessionStart);
                    // endSlotIndex is exclusive of the end time, so -1
                    // e.g. 12:00-12:30 (30 mins). Slots 0, 1, 2, 3, 4, 5.
                    // 30 / 5 = 6. Last slot is 5.
                    const endSlotIndex = Math.ceil(breakEndDiff / averageConsultingTime) - 1;

                    // Map of existing appointments by slotIndex to check for availability
                    const existingSlots = new Set<number>();
                    snapshot.docs.forEach(doc => {
                        const d = doc.data();
                        if (typeof d.slotIndex === 'number' && d.status !== 'Cancelled') {
                            existingSlots.add(d.slotIndex);
                        }
                    });

                    for (let i = startSlotIndex; i <= endSlotIndex; i++) {
                        if (existingSlots.has(i)) {
                            continue; // Already handled (marked completed)
                        }

                        // Create Dummy Appointment
                        // slot time
                        const slotTime = addMinutes(sessionStart, i * averageConsultingTime);
                        const dummyId = doc(collection(db, 'appointments')).id;
                        const dummyRef = doc(db, 'appointments', dummyId);

                        const cutOffTime = addMinutes(slotTime, -15); // Standard 15 min buffer
                        const noShowTime = addMinutes(slotTime, 15);

                        const dummyAppt = {
                            id: dummyId,
                            clinicId,
                            doctor: doctorName,
                            doctorId: doctorDoc.id, // We have reading doctor doc now
                            department: doctorData.department || 'General', // Get from doctor
                            patientName: 'kloqo dummy', // As requested by user
                            patientId: 'dummy-break-patient',
                            age: 0,
                            sex: 'Other',
                            place: 'Kloqo Clinic',
                            phone: '0000000000',
                            communicationPhone: '0000000000',
                            date: dateStr,
                            time: format(slotTime, 'hh:mm a'),
                            arriveByTime: format(slotTime, 'hh:mm a'),
                            cutOffTime: Timestamp.fromDate(cutOffTime),
                            noShowTime: Timestamp.fromDate(noShowTime),
                            slotIndex: i,
                            status: 'Completed',
                            cancelledByBreak: true,
                            sessionIndex,
                            createdAt: Timestamp.now(),
                            bookedVia: 'BreakBlock', // Internal
                            tokenNumber: 'Break', // Or leave empty? 'Break' might confuse sorting? Using 'Break' or '0'
                            numericToken: 0,
                            previousAppointmentId: ''
                        };

                        batch.set(dummyRef, dummyAppt);
                    }
                }
            }
        } catch (err) {
            console.error('[BREAK SERVICE] Error creating dummy appointments:', err);
            // Don't fail the whole shift operation if this fails, just log it.
        }

        if (updates.length > 0 || true) { // Always commit if we have dummy updates too? Yes.
            await batch.commit();

            // 4. Resequence tokens for ALL appointments based on slotIndex
            // User requirement: "All appointments will be based on the slotIndex. will be slotIndex + 1"
            try {
                // Fetch ALL appointments (both completed and pending) to determine correct token numbers
                const allAppointmentsQuery = query(
                    collection(db, 'appointments'),
                    where('doctor', '==', doctorName),
                    where('clinicId', '==', clinicId),
                    where('date', '==', dateStr)
                );

                const allAppointmentsSnapshot = await getDocs(allAppointmentsQuery);
                const allAppts = allAppointmentsSnapshot.docs
                    .map(docSnap => ({ ...docSnap.data() as Appointment, id: docSnap.id }))
                    .filter(appt => appt.tokenNumber?.startsWith('A')) // Only A tokens
                    .sort((a, b) => (a.slotIndex ?? 0) - (b.slotIndex ?? 0));

                const resequenceBatch = writeBatch(db);
                let updatedCount = 0;

                allAppts.forEach((appt) => {
                    // Safety check: Needs a slotIndex
                    if (typeof appt.slotIndex !== 'number') return;

                    // Skip dummy break appointments (they use 'Break')
                    if (appt.cancelledByBreak && appt.tokenNumber === 'Break') return;

                    const newNumericToken = appt.slotIndex + 1;
                    const newTokenNumber = `A${String(newNumericToken).padStart(3, '0')}`;

                    // Only update if the token has changed
                    if (appt.numericToken !== newNumericToken || appt.tokenNumber !== newTokenNumber) {
                        const apptRef = doc(db, 'appointments', appt.id);
                        resequenceBatch.update(apptRef, {
                            numericToken: newNumericToken,
                            tokenNumber: newTokenNumber
                        });
                        updatedCount++;
                    }
                });

                if (updatedCount > 0) {
                    await resequenceBatch.commit();
                    console.log(`[BREAK SERVICE] ✅ Resequenced ${updatedCount} A tokens`);
                }
            } catch (resequenceError) {
                console.error('[BREAK SERVICE] ❌ Error resequencing tokens:', resequenceError);
                // Don't throw - the main operation (schedule shift) succeeded
            }

            // 5. Send Notifications for Shifted Appointments
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
