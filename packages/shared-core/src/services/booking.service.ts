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
import { format, parse, addMinutes, subMinutes, differenceInMinutes, isSameDay, parseISO, isAfter } from 'date-fns';
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
} from './walk-in.service';
import { getClinicNow, getClinicDateString } from '../utils/date-utils';
import { parseTime } from '../utils/break-helpers';
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
    const dateStr = format(date, 'd MMMM yyyy');

    // 1. Parallel Pre-fetch (Consistent Reads)
    // These are outside the transaction but help fail fast or provide data for the transaction
    const clinicRef = doc(firestore, 'clinics', clinicId);
    const patientRef = doc(firestore, 'patients', patientId);

    const [clinicSnap, patientSnap, doctorData] = await Promise.all([
        getDoc(clinicRef),
        getDoc(patientRef),
        loadDoctorAndSlots(firestore, clinicId, doctor.name, date, doctor.id)
    ]);

    if (!clinicSnap.exists()) throw new Error('Clinic not found');
    const walkInTokenAllotment = Number(clinicSnap.data()?.walkInTokenAllotment ?? 5);

    // 2. Initial Calculation (Optimistic)
    const walkInDetails = await calculateWalkInDetails(
        firestore,
        doctorData.doctor,
        walkInTokenAllotment,
        0,
        isForceBooked || false
    );

    if (!walkInDetails || walkInDetails.slotIndex == null) {
        throw new Error('No walk-in slots available.');
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

        if (reservationSnap.exists()) {
            const resData = reservationSnap.data();
            // If already booked and NOT by us, conflict
            if (resData.status === 'booked') {
                throw new Error('Slot already booked by another user.');
            }
        }

        // B. Logic Section (No network calls)
        const nextWalkInNumericToken = doctorData.slots.length + counterState.nextNumber + 100;

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
            effectiveAppointments,
            totalSlots: doctorData.slots.length,
            newWalkInNumericToken: nextWalkInNumericToken,
            forceBook: isForceBooked,
        });

        if (!shiftPlan.newAssignment) {
            throw new Error('Scheduling conflict - please try again.');
        }

        const tokenNumber = `W${String(nextWalkInNumericToken).padStart(3, '0')}`;
        const newDocRef = doc(collection(firestore, 'appointments'));

        // C. Write Section

        // C1. Update Token Counter
        commitNextTokenNumber(transaction, counterRef, counterState);

        // C2. Reservation Update
        transaction.set(reservationRef, {
            clinicId,
            doctorName: doctor.name,
            date: dateStr,
            slotIndex: shiftPlan.newAssignment.slotIndex,
            status: 'booked',
            appointmentId: newDocRef.id,
            bookedAt: serverTimestamp(),
            reservedBy: 'walk-in-booking'
        });

        // C3. Appointment Creation
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
            time: format(shiftPlan.newAssignment.slotTime, 'hh:mm a'),
            arriveByTime: format(shiftPlan.newAssignment.slotTime, 'hh:mm a'),
            status: 'Confirmed',
            tokenNumber,
            numericToken: nextWalkInNumericToken,
            clinicId,
            slotIndex: shiftPlan.newAssignment.slotIndex,
            sessionIndex: shiftPlan.newAssignment.sessionIndex,
            createdAt: serverTimestamp(),
            cutOffTime: Timestamp.fromDate(subMinutes(shiftPlan.newAssignment.slotTime, 15)),
            noShowTime: Timestamp.fromDate(addMinutes(shiftPlan.newAssignment.slotTime, 15)),
            isForceBooked: isForceBooked || false,
        };
        transaction.set(newDocRef, appointmentData);

        // C4. Update Shifted Appointments
        for (const update of shiftPlan.appointmentUpdates) {
            transaction.update(update.docRef, {
                slotIndex: update.slotIndex,
                sessionIndex: update.sessionIndex,
                time: update.timeString,
                noShowTime: Timestamp.fromDate(update.noShowTime),
            });
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
    const dateStr = format(date, 'd MMMM yyyy');

    // 1. Parallel Pre-fetch
    const clinicRef = doc(firestore, 'clinics', clinicId);
    const patientRef = doc(firestore, 'patients', patientId);

    const [clinicSnap, patientSnap, doctorData] = await Promise.all([
        getDoc(clinicRef),
        getDoc(patientRef),
        loadDoctorAndSlots(firestore, clinicId, doctor.name, date, doctor.id)
    ]);

    if (!clinicSnap.exists()) throw new Error('Clinic not found');
    const walkInTokenAllotment = Number(clinicSnap.data()?.walkInTokenAllotment ?? 5);

    // 1b. Duplicate Check
    const duplicateCheckQuery = query(
        collection(firestore, 'appointments'),
        where('patientId', '==', patientId),
        where('doctor', '==', doctor.name),
        where('date', '==', dateStr),
        where('status', 'in', ACTIVE_STATUSES)
    );
    const duplicateSnapshot = await getDocs(duplicateCheckQuery);
    if (!duplicateSnapshot.empty) {
        throw new Error('You already have an appointment today with this doctor.');
    }

    const patientData = patientSnap.data();
    const communicationPhone = patientData?.communicationPhone || patientData?.phone || formData.phone || '';

    // 2. Initial Calculation
    const walkInDetails = await calculateWalkInDetails(
        firestore,
        doctorData.doctor,
        walkInTokenAllotment
    );

    if (!walkInDetails || walkInDetails.slotIndex == null) {
        throw new Error('No walk-in slots available.');
    }

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

        const reservationId = buildReservationDocId(clinicId, doctor.name, dateStr, walkInDetails.slotIndex);
        const reservationRef = doc(firestore, 'slot-reservations', reservationId);
        const reservationSnap = await transaction.get(reservationRef);

        if (reservationSnap.exists() && reservationSnap.data()?.status === 'booked') {
            throw new Error('Slot already booked.');
        }

        // B. Logic Section
        const nextWalkInNumericToken = doctorData.slots.length + counterState.nextNumber + 100;

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
            effectiveAppointments,
            totalSlots: doctorData.slots.length,
            newWalkInNumericToken: nextWalkInNumericToken,
            forceBook: false,
        });

        if (!shiftPlan.newAssignment) {
            throw new Error('Scheduling conflict.');
        }

        const tokenNumber = `W${String(nextWalkInNumericToken).padStart(3, '0')}`;
        const newDocRef = doc(collection(firestore, 'appointments'));

        // C. Write Section
        commitNextTokenNumber(transaction, counterRef, counterState);

        transaction.set(reservationRef, {
            clinicId,
            doctorName: doctor.name,
            date: dateStr,
            slotIndex: shiftPlan.newAssignment.slotIndex,
            status: 'booked',
            appointmentId: newDocRef.id,
            bookedAt: serverTimestamp(),
            reservedBy: 'walk-in-booking'
        });

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
            time: format(shiftPlan.newAssignment.slotTime, 'hh:mm a'),
            arriveByTime: format(shiftPlan.newAssignment.slotTime, 'hh:mm a'),
            status: 'Confirmed',
            tokenNumber,
            numericToken: nextWalkInNumericToken,
            clinicId,
            slotIndex: shiftPlan.newAssignment.slotIndex,
            sessionIndex: shiftPlan.newAssignment.sessionIndex,
            createdAt: serverTimestamp(),
            cutOffTime: Timestamp.fromDate(subMinutes(shiftPlan.newAssignment.slotTime, 15)),
            noShowTime: Timestamp.fromDate(addMinutes(shiftPlan.newAssignment.slotTime, 15)),
            patientProfile: patientProfile ?? null,
            walkInPatientsAhead: walkInDetails.patientsAhead,
        });

        for (const update of shiftPlan.appointmentUpdates) {
            transaction.update(update.docRef, {
                slotIndex: update.slotIndex,
                sessionIndex: update.sessionIndex,
                time: update.timeString,
                noShowTime: Timestamp.fromDate(update.noShowTime),
            });
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
            patientsAhead: walkInDetails.patientsAhead,
        };
    });
}
