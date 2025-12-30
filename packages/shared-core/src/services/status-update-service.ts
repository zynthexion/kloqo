import { collection, query, where, getDocs, updateDoc, doc, writeBatch, getDoc } from 'firebase/firestore';
import { db } from '@kloqo/shared-firebase';
import { format, parse, addHours, addMinutes, subMinutes, isAfter, isBefore, isWithinInterval } from 'date-fns';
import type { Appointment, Doctor } from '@kloqo/shared-types';
import { sendAppointmentSkippedNotification } from './notification-service';
import { getClinicDateString, getClinicDayOfWeek, getClinic24hTimeString, getClinicNow } from '../utils/date-utils';
import { rebalanceWalkInSchedule } from './walk-in.service';

/**
 * Updates appointment statuses and doctor consultation statuses when the app opens
 */
export async function updateAppointmentAndDoctorStatuses(clinicId: string): Promise<void> {
    try {


        // Update appointment statuses
        await updateAppointmentStatuses(clinicId);

        // Update doctor consultation statuses
        await updateDoctorConsultationStatuses(clinicId);

        ('Status updates completed successfully');
    } catch (error) {
        console.error('Error updating statuses:', error);
        throw error;
    }
}

/**
 * Updates appointment statuses:
 * 1. Pending → Skipped when arrive-by time (appointment time - 15 minutes) has passed and appointment is still Pending (not Confirmed)
 * 2. Skipped → No-show when appointment time + 15 minutes has passed
 */
async function updateAppointmentStatuses(clinicId: string): Promise<void> {
    const now = getClinicNow();
    const today = getClinicDateString(now);



    // Query Pending and Skipped appointments for today
    const appointmentsRef = collection(db, 'appointments');
    const q = query(
        appointmentsRef,
        where('clinicId', '==', clinicId),
        where('date', '==', today),
        where('status', 'in', ['Pending', 'Skipped'])
    );

    const querySnapshot = await getDocs(q);


    // Get all doctors for this clinic to access their consultationStatus and availability
    const doctorsRef = collection(db, 'doctors');
    const doctorsQuery = query(
        doctorsRef,
        where('clinicId', '==', clinicId)
    );
    const doctorsSnapshot = await getDocs(doctorsQuery);
    const doctorsMap = new Map<string, Doctor>();
    doctorsSnapshot.forEach((doc) => {
        const doctor = { id: doc.id, ...doc.data() } as Doctor;
        doctorsMap.set(doctor.name, doctor);
    });

    const appointmentsToSkip: { id: string; appointment: Appointment }[] = [];
    const appointmentsToMarkNoShow: { id: string; appointment: Appointment }[] = [];

    querySnapshot.forEach((docSnapshot) => {
        const appointment = docSnapshot.data() as Appointment;

        try {
            // Get doctor information
            const doctor = doctorsMap.get(appointment.doctor);
            if (!doctor) {
                console.warn(`Doctor not found for appointment ${docSnapshot.id}: ${appointment.doctor}`);
                // Fall back to old logic if doctor not found
                if (appointment.status === 'Pending') {
                    let cutOffTime: Date;
                    if (appointment.cutOffTime) {
                        cutOffTime = appointment.cutOffTime instanceof Date
                            ? appointment.cutOffTime
                            : appointment.cutOffTime?.toDate
                                ? appointment.cutOffTime.toDate()
                                : new Date(appointment.cutOffTime);
                    } else {
                        const appointmentDate = parse(appointment.date, 'd MMMM yyyy', new Date());
                        const appointmentTime = parseTime(appointment.time, appointmentDate);
                        cutOffTime = subMinutes(appointmentTime, 15);
                    }
                    if (isAfter(now, cutOffTime) || now.getTime() >= cutOffTime.getTime()) {
                        appointmentsToSkip.push({ id: docSnapshot.id, appointment });
                    }
                } else if (appointment.status === 'Skipped') {
                    let noShowTime: Date;
                    if (appointment.noShowTime) {
                        noShowTime = appointment.noShowTime instanceof Date
                            ? appointment.noShowTime
                            : appointment.noShowTime?.toDate
                                ? appointment.noShowTime.toDate()
                                : new Date(appointment.noShowTime);
                    } else {
                        const appointmentDate = parse(appointment.date, 'd MMMM yyyy', new Date());
                        const appointmentTime = parseTime(appointment.time, appointmentDate);
                        noShowTime = addMinutes(appointmentTime, 15);
                    }
                    if (isAfter(now, noShowTime) || now.getTime() >= noShowTime.getTime()) {
                        appointmentsToMarkNoShow.push({ id: docSnapshot.id, appointment });
                    }
                }
                return;
            }

            const consultationStatus = doctor.consultationStatus || 'Out';

            if (appointment.status === 'Pending') {
                // Use stored cutOffTime from database (includes doctor delay if any)
                let cutOffTime: Date;
                if (appointment.cutOffTime) {
                    // Convert Firestore timestamp to Date
                    cutOffTime = appointment.cutOffTime instanceof Date
                        ? appointment.cutOffTime
                        : appointment.cutOffTime?.toDate
                            ? appointment.cutOffTime.toDate()
                            : new Date(appointment.cutOffTime);
                } else {
                    // Fallback: calculate if not stored (for old appointments)
                    const appointmentDate = parse(appointment.date, 'd MMMM yyyy', new Date());
                    const appointmentTime = parseTime(appointment.time, appointmentDate);
                    cutOffTime = subMinutes(appointmentTime, 15);
                }

                // Check if current time is greater than stored cutOffTime
                const shouldSkipByTime = isAfter(now, cutOffTime) || now.getTime() >= cutOffTime.getTime();

                if (shouldSkipByTime) {
                    // If doctor is 'Out', check if cutOffTime is after the next upcoming availability start time
                    if (consultationStatus === 'Out') {
                        const nextAvailabilityStart = getNextUpcomingAvailabilityStartTime(doctor, now);

                        if (nextAvailabilityStart) {
                            // Only skip if cutOffTime is before or equal to availability start time
                            // If cutOffTime is after availability start, don't skip (doctor hasn't started yet)
                            if (isAfter(cutOffTime, nextAvailabilityStart) || cutOffTime.getTime() > nextAvailabilityStart.getTime()) {
                                // cutOffTime is after availability start - don't skip

                                return;
                            }
                        }
                        // If no availability found or cutOffTime is before availability start, proceed with skip
                    }

                    // Doctor is 'In' or cutOffTime is before availability start - proceed with skip
                    appointmentsToSkip.push({ id: docSnapshot.id, appointment });
                }
            } else if (appointment.status === 'Skipped') {
                // Use stored noShowTime from database (includes doctor delay if any)
                let noShowTime: Date;
                if (appointment.noShowTime) {
                    // Convert Firestore timestamp to Date
                    noShowTime = appointment.noShowTime instanceof Date
                        ? appointment.noShowTime
                        : appointment.noShowTime?.toDate
                            ? appointment.noShowTime.toDate()
                            : new Date(appointment.noShowTime);
                } else {
                    // Fallback: calculate if not stored (for old appointments)
                    const appointmentDate = parse(appointment.date, 'd MMMM yyyy', new Date());
                    const appointmentTime = parseTime(appointment.time, appointmentDate);
                    noShowTime = addMinutes(appointmentTime, 15);
                }

                // Check if current time is greater than stored noShowTime
                const shouldMarkNoShow = isAfter(now, noShowTime) || now.getTime() >= noShowTime.getTime();

                if (shouldMarkNoShow) {
                    // Only mark as no-show if doctor is 'In'
                    // If doctor is 'Out', don't mark as no-show (doctor hasn't started yet)
                    if (consultationStatus === 'In') {
                        appointmentsToMarkNoShow.push({ id: docSnapshot.id, appointment });
                    } else {

                    }
                }
            }
        } catch (error) {
            console.error('Error processing appointment:', docSnapshot.id, error);
        }
    });

    // Update Pending → Skipped
    if (appointmentsToSkip.length > 0) {

        const batch = writeBatch(db);

        appointmentsToSkip.forEach(({ id }) => {
            const appointmentRef = doc(db, 'appointments', id);
            batch.update(appointmentRef, {
                status: 'Skipped',
                skippedAt: new Date(),
                updatedAt: new Date()
            });
        });

        await batch.commit();


        // Send notifications for skipped appointments
        for (const { id, appointment } of appointmentsToSkip) {
            try {
                if (!appointment.patientId) {

                    continue;
                }

                // Get clinic name
                const clinicDoc = await getDoc(doc(db, 'clinics', clinicId));
                const clinicName = clinicDoc.exists() ? clinicDoc.data()?.name || 'The clinic' : 'The clinic';

                await sendAppointmentSkippedNotification({
                    firestore: db,
                    patientId: appointment.patientId,
                    appointmentId: id,
                    doctorName: appointment.doctor,
                    clinicName,
                    date: appointment.date,
                    time: appointment.time,
                    tokenNumber: appointment.tokenNumber || 'N/A',
                });

            } catch (notifError) {
                console.error(`Failed to send skipped notification for appointment ${id}:`, notifError);
                // Don't fail the status update if notification fails
            }
        }
    }

    // Update Skipped → No-show
    if (appointmentsToMarkNoShow.length > 0) {

        const batch = writeBatch(db);

        appointmentsToMarkNoShow.forEach(({ id }) => {
            const appointmentRef = doc(db, 'appointments', id);
            batch.update(appointmentRef, {
                status: 'No-show',
                updatedAt: new Date()
            });
        });

        await batch.commit();


        // Delay reduction and slot reassignment removed in simplified flow
        // Send No-show notifications

        const rebalanceGroups = new Map<string, { clinicId: string; doctorName: string; doctorId?: string | undefined; date: string }>();
        appointmentsToMarkNoShow.forEach(({ appointment }) => {
            if (!appointment.clinicId || !appointment.doctor || !appointment.date) return;
            const key = `${appointment.clinicId}|${appointment.doctor}|${appointment.date}`;
            if (!rebalanceGroups.has(key)) {
                rebalanceGroups.set(key, {
                    clinicId: appointment.clinicId,
                    doctorName: appointment.doctor,
                    doctorId: appointment.doctorId,
                    date: appointment.date,
                });
            }
        });

        for (const group of rebalanceGroups.values()) {
            try {
                await rebalanceWalkInSchedule(
                    db,
                    group.clinicId,
                    group.doctorName,
                    parse(group.date, 'd MMMM yyyy', new Date())
                );
            } catch (rebalanceError) {
                console.error('Failed to rebalance walk-in schedule after marking no-show:', rebalanceError, group);
            }
        }
    }
}

// Helper function to parse time string
function parseTime(timeStr: string, referenceDate: Date): Date {
    try {
        return parse(timeStr, 'hh:mm a', referenceDate);
    } catch {
        // Fallback to 24h format
        const [hours, minutes] = timeStr.split(':').map(Number);
        const date = new Date(referenceDate);
        date.setHours(hours, minutes, 0, 0);
        return date;
    }
}

/**
 * Gets the next upcoming availability start time for a doctor today
 * Returns the start time of the first session that hasn't ended yet, or null if none found
 */
function getNextUpcomingAvailabilityStartTime(doctor: Doctor, now: Date): Date | null {
    if (!doctor.availabilitySlots || doctor.availabilitySlots.length === 0) {
        return null;
    }

    const todayDay = getClinicDayOfWeek(now);
    const todayAvailability = doctor.availabilitySlots.find((slot: { day: string; timeSlots?: Array<{ from: string; to: string }> }) =>
        slot.day.toLowerCase() === todayDay.toLowerCase()
    );

    if (!todayAvailability || !todayAvailability.timeSlots || todayAvailability.timeSlots.length === 0) {
        return null;
    }

    // Find the next session (first session that hasn't ended yet)
    for (let i = 0; i < todayAvailability.timeSlots.length; i++) {
        const session = todayAvailability.timeSlots[i];
        try {
            const sessionStart = parseTime(session.from, now);
            const sessionEnd = parseTime(session.to, now);

            // If current time is before session end, this is the next session
            if (isBefore(now, sessionEnd) || now.getTime() === sessionEnd.getTime()) {
                return sessionStart;
            }
        } catch (error) {
            // Skip if parsing fails
            console.warn(`Error parsing session time for doctor ${doctor.name}:`, error);
            continue;
        }
    }

    // No upcoming session found (all sessions have ended)
    return null;
}

/**
 * Updates doctor consultation status to 'Out' if current time is outside their availability
 */
async function updateDoctorConsultationStatuses(clinicId: string): Promise<void> {
    const now = new Date();
    const currentTime = getClinic24hTimeString(now);
    const currentDay = getClinicDayOfWeek(now); // e.g., 'Monday', 'Tuesday'



    // Query all doctors for this clinic
    const doctorsRef = collection(db, 'doctors');
    const q = query(
        doctorsRef,
        where('clinicId', '==', clinicId)
    );

    const querySnapshot = await getDocs(q);


    const doctorsToUpdate: { id: string; doctor: Doctor }[] = [];

    querySnapshot.forEach((docSnapshot) => {
        const doctor = docSnapshot.data() as Doctor;



        // Check if doctor should be marked as 'Out'
        // Only auto-set to 'Out', never auto-set to 'In' (manual only)
        const shouldBeOut = shouldDoctorBeOut(doctor, currentDay, currentTime);

        // REMOVED: Auto-set to 'Out' logic - doctors can now manually set status to 'In' before availability time
        // Status changes are now completely manual - no automatic 'Out' based on availability
    });



    if (doctorsToUpdate.length > 0) {


        // Use batch update for better performance
        const batch = writeBatch(db);

        doctorsToUpdate.forEach(({ id }) => {
            const doctorRef = doc(db, 'doctors', id);
            batch.update(doctorRef, {
                consultationStatus: 'Out',
                updatedAt: new Date()
            });

        });

        await batch.commit();

    }
}

/**
 * Parses appointment date and time into a Date object
 */
function parseAppointmentDateTime(dateStr: string, timeStr: string): Date | null {
    try {
        // Parse date in "d MMMM yyyy" format (e.g., "15 October 2024")
        const appointmentDate = parse(dateStr, "d MMMM yyyy", new Date());

        // Parse time - handle both "HH:mm" and "h:mm a" formats
        let hours: number, minutes: number;

        if (timeStr.includes('AM') || timeStr.includes('PM')) {
            // Parse time in "h:mm a" format (e.g., "2:30 PM")
            const timePart = timeStr.replace(/\s*(AM|PM)/i, '');
            const [h, m] = timePart.split(':').map(Number);
            const isPM = /PM/i.test(timeStr);
            hours = isPM ? (h === 12 ? 12 : h + 12) : (h === 12 ? 0 : h);
            minutes = m;
        } else {
            // Parse time in "HH:mm" format (e.g., "14:30")
            const [h, m] = timeStr.split(':').map(Number);
            hours = h;
            minutes = m;
        }

        appointmentDate.setHours(hours, minutes, 0, 0);

        return appointmentDate;
    } catch (error) {
        console.error('Error parsing appointment date/time:', error, { dateStr, timeStr });
        return null;
    }
}

/**
 * Determines if a doctor should be marked as 'Out' based on their availability
 */
function shouldDoctorBeOut(doctor: Doctor, currentDay: string, currentTime: string): boolean {


    // If no availability slots, mark as 'Out'
    if (!doctor.availabilitySlots || doctor.availabilitySlots.length === 0) {

        return true;
    }

    // Find today's availability slot
    const todaySlot = doctor.availabilitySlots.find((slot: { day: string; timeSlots?: Array<{ from: string; to: string }> }) =>
        slot.day.toLowerCase() === currentDay.toLowerCase()
    );



    if (!todaySlot || !todaySlot.timeSlots || todaySlot.timeSlots.length === 0) {

        return true;
    }

    // Check if current time is within any of the doctor's time slots
    const isWithinAnySlot = todaySlot.timeSlots.some((slot: { from: string; to: string }) => {
        const isWithin = isTimeWithinSlot(currentTime, slot.from, slot.to);

        return isWithin;
    });


    return !isWithinAnySlot;
}

/**
 * Checks if a time is within a time slot
 */
function isTimeWithinSlot(currentTime: string, slotStart: string, slotEnd: string): boolean {
    try {


        // Parse current time (already in HH:mm format)
        const [currentHour, currentMinute] = currentTime.split(':').map(Number);
        const currentMinutes = currentHour * 60 + currentMinute;

        // Parse slot times - handle both "HH:mm" and "h:mm a" formats
        const startMinutes = parseTimeToMinutes(slotStart);
        const endMinutes = parseTimeToMinutes(slotEnd);

        const isWithin = currentMinutes >= startMinutes && currentMinutes <= endMinutes;



        // Special test for Saturday 9 AM - 1 PM case
        if (slotStart === "09:00 AM" && slotEnd === "01:00 PM") {

        }

        return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
    } catch (error) {
        console.error('Error checking time within slot:', error, { currentTime, slotStart, slotEnd });
        return false;
    }
}

/**
 * Parses time string to minutes since midnight
 */
function parseTimeToMinutes(timeStr: string): number {
    try {


        if (timeStr.includes('AM') || timeStr.includes('PM')) {
            // Parse time in "h:mm a" format (e.g., "9:00 AM", "01:00 PM")
            const timePart = timeStr.replace(/\s*(AM|PM)/i, '');
            const [h, m] = timePart.split(':').map(Number);
            const isPM = /PM/i.test(timeStr);

            let hours: number;
            if (isPM) {
                // PM: 12 PM stays 12, 1-11 PM become 13-23
                hours = h === 12 ? 12 : h + 12;
            } else {
                // AM: 12 AM becomes 0, 1-11 AM stay 1-11
                hours = h === 12 ? 0 : h;
            }

            const minutes = hours * 60 + m;

            return minutes;
        } else {
            // Parse time in "HH:mm" format (e.g., "09:00")
            const [h, m] = timeStr.split(':').map(Number);
            const minutes = h * 60 + m;

            return minutes;
        }
    } catch (error) {
        console.error('Error parsing time to minutes:', error, { timeStr });
        return 0;
    }
}

/**
 * Updates a single appointment status
 */
export async function updateSingleAppointmentStatus(
    appointmentId: string,
    status: 'Confirmed' | 'Pending' | 'Cancelled' | 'Completed' | 'No-show' | 'Skipped'
): Promise<void> {
    try {
        const appointmentRef = doc(db, 'appointments', appointmentId);
        const updateFields: any = { status, updatedAt: new Date() };
        if (status === 'Completed') {
            updateFields.completedAt = new Date();
        }
        await updateDoc(appointmentRef, updateFields);

    } catch (error) {
        console.error('Error updating appointment status:', error);
        throw error;
    }
}

/**
 * Updates a single doctor consultation status
 */
export async function updateSingleDoctorStatus(
    doctorId: string,
    consultationStatus: 'In' | 'Out'
): Promise<void> {
    try {
        const doctorRef = doc(db, 'doctors', doctorId);
        await updateDoc(doctorRef, {
            consultationStatus,
            updatedAt: new Date()
        });

    } catch (error) {
        console.error('Error updating doctor status:', error);
        throw error;
    }
}
