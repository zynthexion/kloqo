import {
    collection,
    query,
    where,
    getDocs,
    doc,
    writeBatch,
    Timestamp,
    serverTimestamp,
    getDoc,
    limit,
    type Firestore
} from 'firebase/firestore';
import { format, addMinutes, parseISO, differenceInMinutes } from 'date-fns';
import type { Appointment, BreakPeriod } from '@kloqo/shared-types';
import { parseTime } from '../utils/break-helpers';
import { getClinicDateString, getClinicDayOfWeek, getClinicTimeString } from '../utils/date-utils';
import { buildReservationDocId } from '../utils/reservation-utils';
import { sendBreakUpdateNotification } from './notification-service';

/**
 * Generate an online appointment token number with session index
 * Format: A{sessionIndex+1}-{numericToken:003}
 * Examples: A1-001 (Session 0), A2-001 (Session 1), A3-015 (Session 2)
 */
function generateOnlineTokenNumber(numericToken: number, sessionIndex: number): string {
    const sessionLabel = sessionIndex + 1;
    const tokenPart = String(numericToken).padStart(3, '0');
    return `A${sessionLabel}-${tokenPart}`;
}

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
        const dateStr = getClinicDateString(date);

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
            // Skip cancelled appointments UNLESS they are cancelled break-blocks (we'll reuse those)
            if (appt.status === 'Cancelled' && !appt.cancelledByBreak) return;

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

        // Need session start info for slot calculations at the top
        // But we are in a static context or service? We have 'sessionIndex'.
        // We actually need to fetch doctor data FIRST if we want accurate slot indices.
        // However, 'snapshot' contains 'd.slotIndex'. We rely on that.
        // To classify "In Break" vs "Post Break", we use time comparison.
        // To calculate "Slots", we need averageConsultingTime. 

        // 1. ANALYZE PHASE: Calculate Dynamic Shift Amount
        // We must fetch doctor data first to know sessionStart? 
        // Or assume slots map to time perfectly? 
        // We need 'startSlotIndex' and 'endSlotIndex' for the break.
        // Calculating them:
        // (BreakStart - SessionStart) / Duration.
        // Where is SessionStart? We don't have it yet.
        // Hack: We can estimate startSlotIndex via date diff if we assume session starts exactly on a slot boundary?
        // Better: Fetch doctor data NOW, before the loop.

        const doctorQuery = query(collection(db, 'doctors'), where('name', '==', doctorName), limit(1));
        const doctorSnap = await getDocs(doctorQuery);
        let startSlotIndex = 0;
        let endSlotIndex = 0;
        let sessionStart: Date | null = null;
        let slotIndexOffset = 0;
        let doctorData: any = null;

        if (!doctorSnap.empty) {
            doctorData = doctorSnap.docs[0].data();

            // HARDEN: Use DB value if valid, overriding function argument
            if (doctorData.averageConsultingTime) {
                console.log('[BREAK SERVICE] Overriding consulting time from DB:', doctorData.averageConsultingTime);
                averageConsultingTime = doctorData.averageConsultingTime;
            }

            const dayOfWeek = getClinicDayOfWeek(date);
            const availabilitySlot = doctorData.availabilitySlots?.find((s: any) => s.day === dayOfWeek);
            if (availabilitySlot?.timeSlots?.[sessionIndex]) {
                const sessionTime = availabilitySlot.timeSlots[sessionIndex];
                sessionStart = parseTime(sessionTime.from, date);

                sessionStart = parseTime(sessionTime.from, date);

                // CRITICAL FIX: Use Segmented Indexing (1000, 2000...) instead of Continuous Summation
                // Default base offset
                let calculatedOffset = sessionIndex * 1000;

                // DYNAMIC CALIBRATION: Check existing appointments to determine exact offset (handling 0-based vs 1-based)
                // We scan the snapshot for a valid appointment to anchor our index calculation.
                if (!snapshot.empty) {
                    for (const docSnap of snapshot.docs) {
                        const appt = docSnap.data() as Appointment;
                        const baseTimeStr = appt.arriveByTime || appt.time;
                        if (typeof appt.slotIndex === 'number' && baseTimeStr) {
                            const apptTime = parseTime(baseTimeStr, date);
                            // Only use if same session
                            if (appt.sessionIndex === sessionIndex) {
                                const diffMinutes = differenceInMinutes(apptTime, sessionStart);
                                const slotDiff = Math.floor(diffMinutes / averageConsultingTime);
                                const impliedOffset = appt.slotIndex - slotDiff;

                                // Sanity check: Offset should be close to sessionIndex * 1000
                                if (Math.abs(impliedOffset - (sessionIndex * 1000)) < 100) {
                                    calculatedOffset = impliedOffset;
                                    console.log('[BREAK SERVICE] Calibrated slotIndexOffset:', calculatedOffset, 'using appt', appt.id);
                                    break;
                                }
                            }
                        }
                    }
                }

                slotIndexOffset = calculatedOffset;

                const breakStartDiff = differenceInMinutes(breakStart, sessionStart);
                const breakEndDiff = differenceInMinutes(breakEnd, sessionStart);

                startSlotIndex = Math.floor(breakStartDiff / averageConsultingTime) + slotIndexOffset;
                endSlotIndex = Math.ceil(breakEndDiff / averageConsultingTime) - 1 + slotIndexOffset;

                // Safety: Expand range to include any pre-identified cancelled slots (from Time Matching)
                // This ensures we don't miss slots due to rounding or slight time misalignments
                if (cancelledSlotIndices.size > 0) {
                    const minCancelled = Math.min(...Array.from(cancelledSlotIndices));
                    const maxCancelled = Math.max(...Array.from(cancelledSlotIndices));
                    startSlotIndex = Math.min(startSlotIndex, minCancelled);
                    endSlotIndex = Math.max(endSlotIndex, maxCancelled);
                }

                console.log('[BREAK SERVICE] Calculated indices for session', sessionIndex, {
                    slotIndexOffset,
                    startSlotIndex,
                    endSlotIndex,
                    breakStart: getClinicTimeString(breakStart),
                    breakEnd: getClinicTimeString(breakEnd)
                });
            }
        }

        // Now valid analysis
        let dynamicShiftAmount = 0;
        const displacedAppointments: any[] = [];
        const slotsMap = new Map<number, { hasBreak: boolean, hasActive: boolean }>();
        for (let i = startSlotIndex; i <= endSlotIndex; i++) slotsMap.set(i, { hasBreak: false, hasActive: false });

        snapshot.docs.forEach(doc => {
            const d = doc.data();
            if (typeof d.slotIndex === 'number' && d.slotIndex >= startSlotIndex && d.slotIndex <= endSlotIndex) {
                if (d.cancelledByBreak) {
                    const s = slotsMap.get(d.slotIndex); if (s) s.hasBreak = true;
                }
                if (d.status !== 'Cancelled' && !d.cancelledByBreak && !d.status.startsWith('Completed')) {
                    displacedAppointments.push({ ...d, id: doc.id });
                    const s = slotsMap.get(d.slotIndex); if (s) s.hasActive = true;
                }
            }
        });
        displacedAppointments.sort((a, b) => (a.slotIndex || 0) - (b.slotIndex || 0));

        for (let i = startSlotIndex; i <= endSlotIndex; i++) {
            const s = slotsMap.get(i);
            if (!s) continue;

            // PRIORITY FIX:
            // 1. If there is an Active Appt, we MUST add delay (+1) to make room for it,
            //    regardless of whether there's a "dead" break block underneath.
            // 2. If it's empty (no break, no active), we add delay (+1) to extend the break.
            // 3. If it's purely dead (hasBreak, !hasActive), we add nothing (+0).

            if (s.hasActive) {
                dynamicShiftAmount += 1;
            } else {
                // Gap or existing break block: no extra shift needed for the rest of the schedule
                dynamicShiftAmount += 0;
            }
        }

        // 2. REACTIVATE CANCELLED BREAK-BLOCKS PHASE
        // Before creating new dummy appointments, reactivate any cancelled break-blocks
        // that fall within the new break period
        console.log('[BREAK SERVICE] 🔍 Starting reactivation phase');
        console.log('[BREAK SERVICE] Break period:', {
            start: getClinicTimeString(breakStart),
            end: getClinicTimeString(breakEnd),
            duration: breakDuration
        });
        console.log('[BREAK SERVICE] Total appointments found:', snapshot.docs.length);

        const reactivateBatch = writeBatch(db);
        let reactivatedCount = 0;
        let cancelledBreakBlocksFound = 0;

        snapshot.docs.forEach(docSnap => {
            const appt = docSnap.data() as Appointment;

            // Debug: Log all appointments
            console.log('[BREAK SERVICE] Checking appointment:', {
                id: docSnap.id,
                time: appt.time,
                status: appt.status,
                cancelledByBreak: appt.cancelledByBreak,
                slotIndex: appt.slotIndex
            });

            // Only process cancelled break-blocks
            if (!(appt.cancelledByBreak === true && appt.status === 'Cancelled')) {
                console.log('[BREAK SERVICE] ❌ Skipping - not a cancelled break-block');
                return;
            }

            cancelledBreakBlocksFound++;
            console.log('[BREAK SERVICE] ✓ Found cancelled break-block');

            const baseTimeStr = appt.arriveByTime || appt.time;
            if (!baseTimeStr) {
                console.log('[BREAK SERVICE] ❌ Skipping - no time string');
                return;
            }

            const apptArriveBy = parseTime(baseTimeStr, date);
            apptArriveBy.setSeconds(0, 0);

            console.log('[BREAK SERVICE] Time comparison:', {
                apptTime: getClinicTimeString(apptArriveBy),
                apptTimestamp: apptArriveBy.getTime(),
                breakStartTimestamp: breakStart.getTime(),
                breakEndTimestamp: breakEnd.getTime(),
                isWithinBreak: apptArriveBy.getTime() >= breakStart.getTime() && apptArriveBy.getTime() < breakEnd.getTime()
            });

            // Check if this cancelled break-block falls within the new break period
            if (apptArriveBy.getTime() >= breakStart.getTime() &&
                apptArriveBy.getTime() < breakEnd.getTime()) {
                console.log('[BREAK SERVICE] ✅ Reactivating appointment:', docSnap.id);
                // Reactivate this break-block by changing status back to Completed
                reactivateBatch.update(docSnap.ref, {
                    status: 'Completed'
                });
                reactivatedCount++;
            } else {
                console.log('[BREAK SERVICE] ❌ Outside break period, not reactivating');
            }
        });

        console.log('[BREAK SERVICE] Summary:', {
            totalAppointments: snapshot.docs.length,
            cancelledBreakBlocksFound,
            reactivatedCount
        });

        if (reactivatedCount > 0) {
            console.log('[BREAK SERVICE] 💾 Committing reactivation batch...');
            await reactivateBatch.commit();
            console.log(`[BREAK SERVICE] ✅ Reactivated ${reactivatedCount} cancelled break-blocks`);
        }

        // Check if we need to proceed with shifting
        // Note: We no longer return early here if dynamicShiftAmount === 0 
        // because we still need to create dummy appointments for empty slots 
        // to block the backend scheduler from booking into the break.


        // 3. SHIFT PHASE
        snapshot.docs.forEach(docSnap => {
            const appt = docSnap.data() as Appointment;
            // SAFETY CHECK: Never shift an appointment that was cancelled by a break
            if (appt.cancelledByBreak) return;
            // Skip if already cancelled (standard check)
            if (appt.status === 'Cancelled') return;

            const baseTimeStr = appt.arriveByTime || appt.time;
            if (!baseTimeStr) return;

            const apptArriveBy = parseTime(baseTimeStr, date);

            // Skip appointments before the break
            if (apptArriveBy.getTime() < breakStart.getTime()) return;

            // Determine Shift Logic
            const isDisplaced = displacedAppointments.some(d => d.id === docSnap.id);
            let effectiveShiftSlots = 0;
            let effectiveShiftMinutes = 0;

            if (isDisplaced) {
                // Compact Shift: Move to start of post-break + relative index
                // Target Slot = (EndSlotIndex + 1) + (RelativeIndex in Displaced)
                const relativeIndex = displacedAppointments.findIndex(d => d.id === docSnap.id);
                const targetSlot = (endSlotIndex + 1) + relativeIndex;
                effectiveShiftSlots = targetSlot - (appt.slotIndex || 0);
                effectiveShiftMinutes = effectiveShiftSlots * averageConsultingTime;
            } else {
                // Post-Break Item: Shift by calculated dynamic delay
                effectiveShiftSlots = dynamicShiftAmount;
                effectiveShiftMinutes = dynamicShiftAmount * averageConsultingTime;
            }

            const newArriveBy = addMinutes(apptArriveBy, effectiveShiftMinutes);
            const cutOffDate = appt.cutOffTime instanceof Timestamp ? appt.cutOffTime.toDate() : null;
            const noShowDate = appt.noShowTime instanceof Timestamp ? appt.noShowTime.toDate() : null;
            const newCutOffTime = cutOffDate ? addMinutes(cutOffDate, effectiveShiftMinutes) : null;
            const newNoShowTime = noShowDate ? addMinutes(noShowDate, effectiveShiftMinutes) : null;
            const newTimeStr = getClinicTimeString(newArriveBy);

            let newSlotIndex: number | null = null;
            if (typeof appt.slotIndex === 'number') {
                newSlotIndex = appt.slotIndex + effectiveShiftSlots;
            }

            // Prepare data for new appointment
            const newDocRef = doc(collection(db, 'appointments'));

            // BUSINESS LOGIC: When appointments are shifted, change 'Skipped' to 'Pending'
            // since they're getting a new time slot and should be re-attempted
            const newStatus = appt.status === 'Skipped' ? 'Pending' : appt.status;

            const newData = {
                ...appt,
                id: newDocRef.id,
                status: newStatus,
                time: newTimeStr,
                arriveByTime: getClinicTimeString(newArriveBy),
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

        const newlyBlockedSlots = new Set<number>();

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

                // Track that this slot is now blocked by a ghost appointment
                if (typeof update.originalData.slotIndex === 'number') {
                    newlyBlockedSlots.add(update.originalData.slotIndex);
                }

                // 2. Delete the slot reservation for the original appointment
                // This ensures the slot is properly blocked during the break
                const slotIndex = update.originalData.slotIndex;
                if (typeof slotIndex === 'number') {
                    const reservationId = buildReservationDocId(clinicId, doctorName, dateStr, slotIndex);
                    const reservationRef = doc(db, 'slot-reservations', reservationId);
                    batch.delete(reservationRef);
                }
            } else {
                // Appointment is AFTER the break, just delete the original
                // CRITICAL: Also delete its old reservation using sanitized ID
                const slotIndex = update.originalData.slotIndex;
                if (typeof slotIndex === 'number') {
                    const reservationId = buildReservationDocId(clinicId, doctorName, dateStr, slotIndex);
                    const reservationRef = doc(db, 'slot-reservations', reservationId);
                    batch.delete(reservationRef);
                }
                batch.delete(update.originalDocRef);
            }

            // 3. Create New shifted appointment
            batch.set(update.newDocRef, update.newData);

            // 4. Create New slot reservation for the shifted appointment
            // This ensures concurrent bookings respect the shifted positions
            if (typeof update.newData.slotIndex === 'number') {
                const newReservationId = buildReservationDocId(clinicId, doctorName, dateStr, update.newData.slotIndex);
                const newReservationRef = doc(db, 'slot-reservations', newReservationId);
                batch.set(newReservationRef, {
                    clinicId,
                    doctorName,
                    date: dateStr,
                    slotIndex: update.newData.slotIndex,
                    status: 'booked',
                    appointmentId: update.newDocRef.id,
                    bookedAt: serverTimestamp(),
                    reservedBy: 'appointment-booking' // Shifted appointments are treated as advance bookings
                });
            }
        }

        // --- NEW LOGIC: Create Dummy Appointments for Empty Slots in Break ---
        try {
            // Re-fetch appointments to get updated status after reactivation
            const updatedSnapshot = await getDocs(appointmentsQuery);

            // Re-scan strictly for blocking slots (cancelledByBreak items with status Completed)
            // Active items are moving, so they don't block.
            const existingSlots = new Set<number>();
            updatedSnapshot.docs.forEach(doc => {
                const d = doc.data();
                // Include both newly blocked slots and reactivated break-blocks
                if (typeof d.slotIndex === 'number' && d.cancelledByBreak && d.status === 'Completed') {
                    existingSlots.add(d.slotIndex);
                }
            });

            for (let i = startSlotIndex; i <= endSlotIndex; i++) {
                if (existingSlots.has(i) || newlyBlockedSlots.has(i)) {
                    continue; // Already handled (marked completed or ghost exists)
                }

                // Create Dummy Appointment
                // Need sessionStart if not present? We fetched it in Analysis phase.
                // We declared 'sessionStart' in the upper scope?
                // Wait, 'sessionStart' was declared inside the 'if (!doctorSnap.empty)' block in Phase 1.
                // We need it here.
                // I will assume for now we can recalculate it or access it if I lift the variable.
                // To be safe, let's assume 'sessionStart' needs to be available. 
                // The previous code block (Phase 1) declared `let sessionStart: Date | null = null;` at top level.
                // So it should be available here if Phase 1 set it.

                // Correct slot time: sessionStart + (relative index * duration)
                // Relative index = (absolute index i) - (stable offset of session start)
                if (!sessionStart) continue;
                const relativeIndex = i - slotIndexOffset;
                const slotTime = addMinutes(sessionStart, relativeIndex * averageConsultingTime);
                const dummyId = doc(collection(db, 'appointments')).id;
                const dummyRef = doc(db, 'appointments', dummyId);

                const cutOffTime = addMinutes(slotTime, -15);
                const noShowTime = addMinutes(slotTime, 15);

                const dummyAppt = {
                    id: dummyId,
                    clinicId,
                    doctor: doctorName,
                    doctorId: doctorData?.id || '', // Use cached doctorData
                    department: doctorData?.department || 'General',
                    patientName: 'kloqo dummy',
                    patientId: 'dummy-break-patient',
                    age: 0,
                    sex: 'Other',
                    place: 'Kloqo Clinic',
                    phone: '0000000000',
                    communicationPhone: '0000000000',
                    date: dateStr,
                    time: getClinicTimeString(slotTime),
                    arriveByTime: getClinicTimeString(slotTime),
                    cutOffTime: Timestamp.fromDate(cutOffTime),
                    noShowTime: Timestamp.fromDate(noShowTime),
                    slotIndex: i,
                    status: 'Completed',
                    cancelledByBreak: true,
                    sessionIndex,
                    createdAt: Timestamp.now(),
                    bookedVia: 'BreakBlock',
                    tokenNumber: 'Break',
                    numericToken: 0,
                    previousAppointmentId: ''
                };

                batch.set(dummyRef, dummyAppt);
            }
        } catch (err) {
            console.error('[BREAK SERVICE] Error creating dummy appointments:', err);
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
                    const newTokenNumber = generateOnlineTokenNumber(newNumericToken, appt.sessionIndex || 0);

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

    const dayOfWeek = getClinicDayOfWeek(date);
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
                error: `Extending this session (to ${getClinicTimeString(extendedEndTime)}) overlaps with the next session starting at ${getClinicTimeString(nextSessionStart)}.`
            };
        }
    }

    return { valid: true };
}
