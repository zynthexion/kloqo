import {
    getFirestore,
    doc,
    serverTimestamp,
    runTransaction,
    collection,
    query,
    where,
    getDocs,
    getDoc,
    updateDoc,
    arrayUnion,
    increment,
    Timestamp,
    Firestore,
    Transaction,
    DocumentReference,
} from 'firebase/firestore';
import { format, parse, addMinutes, subMinutes, differenceInMinutes, isSameDay, parseISO, isAfter, isBefore } from 'date-fns';
import {
    calculateWalkInDetails,
    loadDoctorAndSlots,
    generateNextTokenAndReserveSlot,
    prepareNextTokenNumber,
    commitNextTokenNumber,
    buildReservationDocId,
    prepareAdvanceShift,
    buildOccupiedSlotSet,
    buildCandidateSlots,
    calculatePerSessionReservedSlots,
    fetchDayAppointments,
    findTargetSessionForForceBooking,
    findActiveSessionIndex
} from './walk-in.service';
import {
    getClassicTokenCounterId,
    prepareNextClassicTokenNumber,
    commitNextClassicTokenNumber
} from './appointment-service';
import { getClinicNow, getClinicDateString, getClinicTimeString, getClinicDayOfWeek, parseClinicTime } from '../utils/date-utils';
import { parseTime } from '../utils/break-helpers';
import { generateWalkInTokenNumber } from '../utils/token-utils';
import type { Doctor, Appointment } from '@kloqo/shared-types';

const ACTIVE_STATUSES = ['Pending', 'Confirmed', 'Skipped', 'Completed'];
const ACTIVE_STATUS_SET = new Set(ACTIVE_STATUSES);

export interface StaffBookingPayload {
    clinicId: string;
    doctor: Doctor;
    patientId: string;
    patientName: string;
    age?: number;
    sex?: string;
    place?: string;
    phone: string;
    isForceBooked?: boolean;
    appointmentDate?: Date;
}

export interface BookingResult {
    success: boolean;
    appointmentId: string;
    tokenNumber: string;
    numericToken: number;
    estimatedTime: string;
    patientsAhead: number;
    classicTokenNumber?: string;
}

/**
 * Consolidated Staff Walk-in Booking
 * Reduces round trips by performing all reads in parallel and all writes in one transaction.
 */
export async function completeStaffWalkInBooking(
    firestore: Firestore,
    payload: StaffBookingPayload
): Promise<BookingResult> {
    const { clinicId, doctor, patientId, patientName, age, sex, place, phone, isForceBooked, appointmentDate: inputDate } = payload;

    const now = getClinicNow();
    const date = inputDate || now;
    const dateStr = getClinicDateString(date);

    // 1. Parallel Pre-fetch (Consistent Reads)
    // These are outside the transaction but help fail fast or provide data for the transaction
    const clinicRef = doc(firestore, 'clinics', clinicId);
    const patientRef = doc(firestore, 'patients', patientId);

    const [clinicSnap, patientSnap, doctorDataRaw, appointments] = await Promise.all([
        getDoc(clinicRef),
        getDoc(patientRef),
        loadDoctorAndSlots(firestore, clinicId, doctor.name, date, doctor.id),
        fetchDayAppointments(firestore, clinicId, doctor.name, date)
    ]);

    if (!clinicSnap.exists()) throw new Error('Clinic not found');
    const clinicData = clinicSnap.data();
    const walkInTokenAllotment = Number(clinicData?.walkInTokenAllotment ?? 5);
    const tokenDistribution = clinicData?.tokenDistribution || 'classic';

    // CRITICAL: For walk-in bookings, restrict to active session only
    const allSlots = doctorDataRaw.slots;
    let slots = allSlots;
    let activeSessionIndex: number | null = null;

    // Identify "Active Session" for this walk-in
    // TODO: RESTORE ORIGINAL LOGIC AFTER TESTING.
    // Original logic: Picks first session starting within 30 minutes.
    // Testing logic: Picks first session that hasn't ended and has capacity.
    activeSessionIndex = findActiveSessionIndex(
        doctorDataRaw.doctor,
        allSlots,
        appointments,
        now,
        tokenDistribution
    );


    // If strictly checking active sessions fail, but we are Force Booking, we relax the constraint.
    // We assume the user knows what they are doing (booking into an "Overtime" or "Next" session).
    if (activeSessionIndex === null && isForceBooked) {
        activeSessionIndex = findTargetSessionForForceBooking(doctorDataRaw.doctor, now);
    }

    if (activeSessionIndex === null) {
        // If no active session (e.g. in a break/gap), default to the next available session
        const nextSlot = allSlots.find(s => isAfter(s.time, now));
        if (nextSlot) {
            activeSessionIndex = nextSlot.sessionIndex;
            console.log('[BOOKING:SERVER] No active session (Gap), defaulting to next session:', activeSessionIndex);
        } else {
            // Fallback: If absolutely no future slots, try last session (Overtime)
            if (allSlots.length > 0) {
                activeSessionIndex = allSlots[allSlots.length - 1].sessionIndex;
            } else {
                throw new Error('No walk-in slots are available. The next session has not started yet.');
            }
        }
    }

    // Filter slots to include active and future sessions to allow spillover
    slots = allSlots.filter((s) => s.sessionIndex >= activeSessionIndex);

    const doctorData = { doctor: doctorDataRaw.doctor, slots };

    // 2. Initial Calculation (Optimistic)
    const walkInDetails = await calculateWalkInDetails(
        firestore,
        doctorData.doctor,
        walkInTokenAllotment,
        0,
        isForceBooked || false
    );

    const finalForceBook = isForceBooked || walkInDetails.isForceBooked || false;

    if (!walkInDetails || walkInDetails.slotIndex == null) {
        throw new Error('No walk-in slots are available.');
    }

    // 3. The Unified Transaction
    // This is the CORE optimization: One commit for ALL changes
    const result = await runTransaction(firestore, async (transaction) => {
        // A. Multi-read Section (All transaction reads MUST be first)

        // A1. Token Counter
        const counterDocId = `${clinicId}_${doctor.name}_${dateStr}_W`
            .replace(/\s+/g, '_')
            .replace(/[^a-zA-Z0-9_]/g, '');
        const counterRef = doc(firestore, 'token-counters', counterDocId);
        const counterState = await prepareNextTokenNumber(transaction, counterRef);

        // A2. Appointments (for shift logic)
        const appointmentsRef = collection(firestore, 'appointments');
        const appointmentsQuery = query(
            appointmentsRef,
            where('clinicId', '==', clinicId),
            where('doctor', '==', doctor.name),
            where('date', '==', dateStr)
        );
        const apptSnapshot = await getDocs(appointmentsQuery);
        const apptDocRefs = apptSnapshot.docs.map(d => doc(firestore, 'appointments', d.id));
        const apptSnapshots = await Promise.all(apptDocRefs.map(ref => transaction.get(ref)));
        const effectiveAppointments = apptSnapshots
            .filter(s => s.exists())
            .map(s => ({ ...s.data(), id: s.id } as Appointment));

        // A3. Slot Reservation Check
        const reservationId = buildReservationDocId(clinicId, doctor.name, dateStr, walkInDetails.slotIndex);
        const reservationRef = doc(firestore, 'slot-reservations', reservationId);
        const reservationSnap = await transaction.get(reservationRef);

        // A4. Classic Token Counter (Read before any writes)
        let classicCounterState: any = null;
        let classicCounterRef: any = null;
        if (tokenDistribution !== 'advanced') {
            const classicCounterId = getClassicTokenCounterId(clinicId, doctor.name, dateStr, activeSessionIndex);
            classicCounterRef = doc(firestore, 'token-counters', classicCounterId);
            classicCounterState = await prepareNextClassicTokenNumber(transaction, classicCounterRef);
        }

        if (reservationSnap.exists()) {
            const resData = reservationSnap.data();
            // If already booked, check if it's a known appointment that can be shifted
            if (resData.status === 'booked') {
                const blockingApptId = resData.appointmentId;
                // If the appointment exists in our effective list, prepareAdvanceShift will handle moving it.
                // If it's NOT in our list, it's a conflict we can't resolve (e.g. unknown booking).
                const isShiftable = effectiveAppointments.some(a => a.id === blockingApptId);

                if (!isShiftable) {
                    throw new Error('Slot already booked by another user.');
                }
            }
        }

        // B. Logic Section (No network calls)
        const nextWalkInNumericToken = doctorData.slots.length + counterState.nextNumber + 100;

        // CRITICAL: Filter appointments to only include those in the active session
        let sessionFilteredAppointments = effectiveAppointments;
        if (activeSessionIndex !== null) {
            sessionFilteredAppointments = effectiveAppointments.filter(appointment => {
                // Include appointment if it has the same sessionIndex
                if (appointment.sessionIndex === activeSessionIndex) {
                    return true;
                }
                // Also include if slotIndex maps to the active session (fallback for older appointments)
                if (typeof appointment.slotIndex === 'number' && appointment.slotIndex < allSlots.length) {
                    return allSlots[appointment.slotIndex]?.sessionIndex === activeSessionIndex;
                }
                return false;
            });
        }

        const shiftPlan = await prepareAdvanceShift({
            transaction,
            firestore,
            clinicId,
            doctorName: doctor.name,
            dateStr,
            slots: doctorData.slots,
            doctor: doctorData.doctor,
            now,
            walkInSpacingValue: walkInTokenAllotment,
            effectiveAppointments: sessionFilteredAppointments,
            totalSlots: doctorData.slots.length,
            newWalkInNumericToken: nextWalkInNumericToken,
            forceBook: finalForceBook,
        });

        if (!shiftPlan.newAssignment) {
            throw new Error('No walk-in slots are available.');
        }

        // --- SURGICAL FIX: Remap slot indices that overflow into future sessions ---
        // Prevents blocking the physical slots of the next session caused by dense slot numbering
        const remapOverflowSlotIndex = (originalIndex: number): number => {
            const conflictingSlot = allSlots.find(s => s.index === originalIndex);
            // If slot exists physically but belongs to a different session, we have a collision
            if (activeSessionIndex !== null && conflictingSlot && conflictingSlot.sessionIndex !== activeSessionIndex) {
                // Remap to high range (10000+) to avoid collision while preserving relative sort order
                return 10000 + originalIndex;
            }
            return originalIndex;
        };

        const finalNewSlotIndex = remapOverflowSlotIndex(shiftPlan.newAssignment.slotIndex);
        const finalAppointmentUpdates = shiftPlan.appointmentUpdates.map(u => ({
            ...u,
            slotIndex: remapOverflowSlotIndex(u.slotIndex)
        }));

        const tokenNumber = generateWalkInTokenNumber(nextWalkInNumericToken, shiftPlan.newAssignment.sessionIndex);
        const newDocRef = doc(collection(firestore, 'appointments'));

        // C. Write Section

        // C1. Update Token Counter
        commitNextTokenNumber(transaction, counterRef, counterState);

        // C2. Reservation Update
        // Use remapped slot index for reservation
        const finalReservationId = buildReservationDocId(clinicId, doctor.name, dateStr, finalNewSlotIndex);
        const finalReservationRef = doc(firestore, 'slot-reservations', finalReservationId);

        transaction.set(finalReservationRef, {
            clinicId,
            doctorName: doctor.name,
            date: dateStr,
            slotIndex: finalNewSlotIndex,
            status: 'booked',
            appointmentId: newDocRef.id,
            bookedAt: serverTimestamp(),
            reservedBy: 'walk-in-booking'
        });

        // C3. Appointment Creation
        // For force-booked appointments, use the estimated time from walkInDetails
        // instead of the physical slot time (which may be incorrect for overflow slots)
        const appointmentTime = finalForceBook && walkInDetails.estimatedTime
            ? new Date(walkInDetails.estimatedTime)
            : shiftPlan.newAssignment.slotTime;

        let classicTokenNumber: string | undefined;
        if (tokenDistribution !== 'advanced' && classicCounterState && classicCounterRef) {
            classicTokenNumber = classicCounterState.nextNumber.toString().padStart(3, '0');
            commitNextClassicTokenNumber(transaction, classicCounterRef, classicCounterState);
        }

        const appointmentData = {
            id: newDocRef.id,
            patientId,
            patientName,
            age,
            sex,
            place,
            communicationPhone: phone,
            doctorId: doctor.id,
            doctor: doctor.name,
            department: doctor.department,
            bookedVia: 'Walk-in',
            date: dateStr,
            time: getClinicTimeString(appointmentTime),
            arriveByTime: getClinicTimeString(appointmentTime),
            status: 'Confirmed',
            tokenNumber,
            numericToken: nextWalkInNumericToken,
            clinicId,
            slotIndex: finalNewSlotIndex,
            sessionIndex: shiftPlan.newAssignment.sessionIndex,
            createdAt: serverTimestamp(),
            cutOffTime: Timestamp.fromDate(subMinutes(appointmentTime, 15)),
            noShowTime: Timestamp.fromDate(addMinutes(appointmentTime, 15)),
            isForceBooked: finalForceBook,
            ...(tokenDistribution !== 'advanced' && { confirmedAt: serverTimestamp(), classicTokenNumber }),
        };
        transaction.set(newDocRef, appointmentData);

        // C4. Update Shifted Appointments
        for (const update of finalAppointmentUpdates) {
            transaction.update(update.docRef, {
                slotIndex: update.slotIndex,
                sessionIndex: update.sessionIndex,
                time: update.timeString,
                arriveByTime: update.arriveByTime,
                cutOffTime: Timestamp.fromDate(update.cutOffTime),
                noShowTime: Timestamp.fromDate(update.noShowTime),
            });
        }

        // C4b. Delete Stale Reservations (Deferred from prepareAdvanceShift)
        if (shiftPlan.reservationDeletes) {
            for (const ref of shiftPlan.reservationDeletes) {
                transaction.delete(ref);
            }
        }

        // C4c. Execute Deferred Reservation Writes (e.g. Bucket)
        if (shiftPlan.reservationWrites) {
            for (const write of shiftPlan.reservationWrites) {
                transaction.set(write.ref, write.data);
            }
        }

        // C5. Update Patient Profile
        transaction.update(patientRef, {
            clinicIds: arrayUnion(clinicId),
            totalAppointments: increment(1),
            visitHistory: arrayUnion(newDocRef.id),
            updatedAt: serverTimestamp(),
        });

        return {
            success: true,
            appointmentId: newDocRef.id,
            tokenNumber,
            numericToken: nextWalkInNumericToken,
            estimatedTime: shiftPlan.newAssignment.slotTime.toISOString(),
            patientsAhead: walkInDetails.patientsAhead,
            classicTokenNumber,
        };
    });

    return result;
}

export interface PatientBookingPayload {
    patientId: string;
    doctor: Doctor;
    clinicId: string;
    appointmentType: 'Walk-in';
    patientProfile?: any;
    formData: {
        name: string;
        age?: number;
        sex?: string;
        place?: string;
        phone?: string;
    };
}

/**
 * Consolidated Patient Walk-in Booking (for API routes)
 * Similar to staff booking but handles patient creation logic and duplicate checks internally.
 */
export async function completePatientWalkInBooking(
    firestore: Firestore,
    payload: PatientBookingPayload
): Promise<BookingResult> {
    const { patientId, doctor, clinicId, formData, patientProfile } = payload;

    const now = getClinicNow();
    const date = now;
    const dateStr = getClinicDateString(date);

    // 1. Parallel Pre-fetch
    const clinicRef = doc(firestore, 'clinics', clinicId);
    const patientRef = doc(firestore, 'patients', patientId);

    const [clinicSnap, patientSnap, doctorDataRaw, appointments] = await Promise.all([
        getDoc(clinicRef),
        getDoc(patientRef),
        loadDoctorAndSlots(firestore, clinicId, doctor.name, date, doctor.id),
        fetchDayAppointments(firestore, clinicId, doctor.name, date)
    ]);

    if (!clinicSnap.exists()) throw new Error('Clinic not found');
    const clinicDataFromSnap = clinicSnap.data();
    const walkInTokenAllotment = Number(clinicDataFromSnap?.walkInTokenAllotment ?? 5);
    const tokenDistribution = clinicDataFromSnap?.tokenDistribution || 'classic';

    // CRITICAL: For walk-in bookings, restrict to active session only
    // This prevents concurrent bookings from spilling over into distant future sessions
    const allSlots = doctorDataRaw.slots;
    let slots = allSlots;
    let activeSessionIndex: number | null = null;

    // Identify "Active Session" for this walk-in
    // TODO: RESTORE ORIGINAL LOGIC AFTER TESTING.
    // Original logic: Picks first session starting within 30 minutes.
    // Testing logic: Picks first session that hasn't ended and has capacity.
    activeSessionIndex = findActiveSessionIndex(
        doctorDataRaw.doctor,
        allSlots,
        appointments,
        now,
        tokenDistribution
    );


    // 1b. Duplicate Check
    const duplicateCheckQuery = query(
        collection(firestore, 'appointments'),
        where('patientId', '==', patientId),
        where('doctor', '==', doctor.name),
        where('date', '==', dateStr),
        where('status', 'in', ['Pending', 'Confirmed', 'Skipped'])
    );
    const duplicateSnapshot = await getDocs(duplicateCheckQuery);
    // Filter out "ghost" appointments from the duplicate check
    const activeDuplicates = duplicateSnapshot.docs.filter(docSnap => {
        const data = docSnap.data();
        // Completed/Skipped are already excluded from the query above if needed
        // But we double check the cancelledByBreak logic
        return !data.cancelledByBreak || data.status === 'Skipped';
    });

    if (activeDuplicates.length > 0) {
        throw new Error('You already have an appointment today with this doctor.');
    }

    const patientData = patientSnap.data();
    const communicationPhone = patientData?.communicationPhone || patientData?.phone || formData.phone || '';

    // 2. Initial Calculation
    console.log('[BOOKING:SERVER] Calculating server-side walk-in details...');
    const walkInDetails = await calculateWalkInDetails(
        firestore,
        doctorDataRaw.doctor,
        walkInTokenAllotment
    );

    // CRITICAL FIX: Use the session index from walk-in calculations as the source of truth.
    // This ensures consistency between the preview (which the user sees) and the final booking.
    // If calculateWalkInDetails detected it needs to force-book/overtime, it will return the correct session index.
    activeSessionIndex = walkInDetails.sessionIndex;

    const finalForceBook = walkInDetails.isForceBooked || false;
    console.log('[BOOKING:SERVER] Server calculation result:', {
        slotIndex: walkInDetails.slotIndex,
        estimated: walkInDetails.estimatedTime,
        patientsAhead: walkInDetails.patientsAhead,
        numericToken: walkInDetails.numericToken,
        sessionIndex: activeSessionIndex,
        isForceBooked: finalForceBook
    });

    if (!walkInDetails || walkInDetails.slotIndex == null) {
        throw new Error('No walk-in slots are available.');
    }

    // Filter slots to include active session AND future sessions to allow spillover
    slots = allSlots.filter((s) => s.sessionIndex >= (activeSessionIndex ?? 0));
    const doctorData = { doctor: doctorDataRaw.doctor, slots };

    // 3. Unified Transaction
    return await runTransaction(firestore, async (transaction) => {
        // A. Multi-read Section
        const counterDocId = `${clinicId}_${doctor.name}_${dateStr}_W`
            .replace(/\s+/g, '_')
            .replace(/[^a-zA-Z0-9_]/g, '');
        const counterRef = doc(firestore, 'token-counters', counterDocId);
        const counterState = await prepareNextTokenNumber(transaction, counterRef);

        const appointmentsRef = collection(firestore, 'appointments');
        const appointmentsQuery = query(
            appointmentsRef,
            where('clinicId', '==', clinicId),
            where('doctor', '==', doctor.name),
            where('date', '==', dateStr)
        );
        const apptSnapshot = await getDocs(appointmentsQuery);
        const apptDocRefs = apptSnapshot.docs.map(d => doc(firestore, 'appointments', d.id));
        const apptSnapshots = await Promise.all(apptDocRefs.map(ref => transaction.get(ref)));
        const effectiveAppointments = apptSnapshots
            .filter(s => s.exists())
            .map(s => ({ ...s.data(), id: s.id } as Appointment));

        // A4. Classic Token Counter (Read before any writes)
        let classicCounterState: any = null;
        let classicCounterRef: any = null;
        if (tokenDistribution !== 'advanced') {
            const classicCounterId = getClassicTokenCounterId(clinicId, doctor.name, dateStr, activeSessionIndex);
            classicCounterRef = doc(firestore, 'token-counters', classicCounterId);
            classicCounterState = await prepareNextClassicTokenNumber(transaction, classicCounterRef);
        }

        // B. Logic Section
        const nextWalkInNumericToken = doctorData.slots.length + counterState.nextNumber + 100;

        // CRITICAL: Filter appointments to only include those in the active session
        let sessionFilteredAppointments = effectiveAppointments;
        if (activeSessionIndex !== null) {
            sessionFilteredAppointments = effectiveAppointments.filter(appointment => {
                // Include appointment if it belongs to active or future session
                if (typeof appointment.sessionIndex === 'number' && appointment.sessionIndex >= activeSessionIndex) {
                    return true;
                }
                // Also include if slotIndex maps to the active session (fallback for older appointments)
                if (typeof appointment.slotIndex === 'number' && appointment.slotIndex < allSlots.length) {
                    return allSlots[appointment.slotIndex]?.sessionIndex >= activeSessionIndex;
                }
                return false;
            });
        }

        const shiftPlan = await prepareAdvanceShift({
            transaction,
            firestore,
            clinicId,
            doctorName: doctor.name,
            dateStr,
            slots: doctorData.slots,
            doctor: doctorData.doctor,
            now,
            walkInSpacingValue: walkInTokenAllotment,
            effectiveAppointments: sessionFilteredAppointments,
            totalSlots: doctorData.slots.length,
            newWalkInNumericToken: nextWalkInNumericToken,
            forceBook: finalForceBook,
        });

        if (!shiftPlan.newAssignment) {
            throw new Error('No walk-in slots are available.');
        }

        // --- SURGICAL FIX: Remap slot indices that overflow into future sessions ---
        // Prevents blocking the physical slots of the next session caused by dense slot numbering
        const remapOverflowSlotIndex = (originalIndex: number): number => {
            const conflictingSlot = allSlots.find(s => s.index === originalIndex);
            // If slot exists physically but belongs to a different session, we have a collision
            if (activeSessionIndex !== null && conflictingSlot && conflictingSlot.sessionIndex !== activeSessionIndex) {
                // Remap to high range (10000+) to avoid collision while preserving relative sort order
                return 10000 + originalIndex;
            }
            return originalIndex;
        };

        const finalNewSlotIndex = remapOverflowSlotIndex(shiftPlan.newAssignment.slotIndex);
        const finalAppointmentUpdates = shiftPlan.appointmentUpdates.map(u => ({
            ...u,
            slotIndex: remapOverflowSlotIndex(u.slotIndex)
        }));

        const tokenNumber = generateWalkInTokenNumber(nextWalkInNumericToken, shiftPlan.newAssignment.sessionIndex);

        const newDocRef = doc(collection(firestore, 'appointments'));

        // C. Write Section
        commitNextTokenNumber(transaction, counterRef, counterState);

        // Re-define reservationRef using the confirmed slot index
        const reservationId = buildReservationDocId(clinicId, doctor.name, dateStr, finalNewSlotIndex);
        const reservationRef = doc(firestore, 'slot-reservations', reservationId);


        transaction.set(reservationRef, {
            clinicId,
            doctorName: doctor.name,
            date: dateStr,
            slotIndex: finalNewSlotIndex,

            status: 'booked',
            appointmentId: newDocRef.id,
            bookedAt: serverTimestamp(),
            reservedBy: 'walk-in-booking'
        });

        // For force-booked appointments, use the estimated time from walkInDetails
        // instead of the physical slot time (which may be incorrect for overflow slots)
        const appointmentTime = finalForceBook && walkInDetails.estimatedTime
            ? new Date(walkInDetails.estimatedTime)
            : shiftPlan.newAssignment.slotTime;

        let classicTokenNumber: string | undefined;
        if (tokenDistribution !== 'advanced' && classicCounterState && classicCounterRef) {
            classicTokenNumber = classicCounterState.nextNumber.toString().padStart(3, '0');
            commitNextClassicTokenNumber(transaction, classicCounterRef, classicCounterState);
        }

        transaction.set(newDocRef, {
            id: newDocRef.id,
            patientId,
            patientName: formData.name,
            age: formData.age,
            sex: formData.sex,
            place: formData.place,
            communicationPhone,
            doctorId: doctor.id,
            doctor: doctor.name,
            department: doctor.department,
            bookedVia: 'Walk-in',
            date: dateStr,
            time: getClinicTimeString(appointmentTime),
            arriveByTime: getClinicTimeString(appointmentTime),
            status: 'Confirmed',
            tokenNumber,
            numericToken: nextWalkInNumericToken,
            clinicId,
            slotIndex: finalNewSlotIndex,

            sessionIndex: shiftPlan.newAssignment.sessionIndex,
            createdAt: serverTimestamp(),
            cutOffTime: Timestamp.fromDate(subMinutes(appointmentTime, 15)),
            noShowTime: Timestamp.fromDate(addMinutes(appointmentTime, 15)),
            isForceBooked: finalForceBook,
            patientProfile: patientProfile ?? null,
            walkInPatientsAhead: (walkInDetails.perceivedPatientsAhead !== undefined) ? walkInDetails.perceivedPatientsAhead : walkInDetails.patientsAhead,
            ...(tokenDistribution !== 'advanced' && { confirmedAt: serverTimestamp(), classicTokenNumber }),
        });

        for (const update of finalAppointmentUpdates) {

            transaction.update(update.docRef, {
                slotIndex: update.slotIndex,
                sessionIndex: update.sessionIndex,
                time: update.timeString,
                arriveByTime: update.arriveByTime,
                noShowTime: Timestamp.fromDate(update.noShowTime),
                cutOffTime: Timestamp.fromDate(update.cutOffTime),
                updatedAt: serverTimestamp(),
            });
        }

        // Deferred Deletes/Writes for Patient Flow
        if (shiftPlan.reservationDeletes) {
            for (const ref of shiftPlan.reservationDeletes) {
                transaction.delete(ref);
            }
        }
        if (shiftPlan.reservationWrites) {
            for (const write of shiftPlan.reservationWrites) {
                transaction.set(write.ref, write.data);
            }
        }

        transaction.update(patientRef, {
            clinicIds: arrayUnion(clinicId),
            totalAppointments: increment(1),
            visitHistory: arrayUnion(newDocRef.id),
            updatedAt: serverTimestamp(),
        });

        return {
            success: true,
            appointmentId: newDocRef.id,
            tokenNumber,
            numericToken: nextWalkInNumericToken,
            estimatedTime: shiftPlan.newAssignment.slotTime.toISOString(),
            patientsAhead: (walkInDetails.perceivedPatientsAhead !== undefined) ? walkInDetails.perceivedPatientsAhead : walkInDetails.patientsAhead,
            classicTokenNumber,
        };
    });
}
