/**
 * Notification Service
 * Sends notifications to patients when appointments are created
 */

import { Firestore, doc, getDoc, collection, query, where, getDocs } from 'firebase/firestore';
import { parse, format, subMinutes } from 'date-fns';
import { parseTime } from '../utils/break-helpers';
import type { Appointment } from '@kloqo/shared-types';

const CONSULTATION_NOTIFICATION_STATUSES = ['Pending', 'Confirmed', 'Skipped', 'Completed', 'No-show'] as const;

export async function sendNotificationToPatient(params: {
    firestore: Firestore;
    patientId: string;
    title: string;
    body: string;
    data: any;
}): Promise<boolean> {
    try {
        const { firestore, patientId, title, body, data } = params;



        // Get patient document to find primaryUserId
        const patientDoc = await getDoc(doc(firestore, 'patients', patientId));
        if (!patientDoc.exists()) {
            console.error('🔔 DEBUG: Patient not found in Firestore');
            return false;
        }

        const patientData = patientDoc.data();
        let userId = patientData.primaryUserId;

        // If primaryUserId is not found in patient document, find it by searching users collection
        if (!userId) {
            const communicationPhone = patientData.communicationPhone || patientData.phone || null;

            if (communicationPhone) {
                try {
                    const usersQuery = query(
                        collection(firestore, 'users'),
                        where('phone', '==', communicationPhone),
                        where('role', '==', 'patient')
                    );
                    const usersSnapshot = await getDocs(usersQuery);

                    if (!usersSnapshot.empty) {
                        const primaryUserDoc = usersSnapshot.docs[0];
                        userId = primaryUserDoc.id;
                    } else {
                        console.warn('🔔 DEBUG: ⚠️ No user found with phone:', communicationPhone, 'and role=patient');
                    }
                } catch (error) {
                    console.error('🔔 DEBUG: ❌ Error searching for primary user by communicationPhone:', error);
                }
            } else {
                console.warn('🔔 DEBUG: ⚠️ Patient has no communicationPhone or phone. Cannot find primary user.');
            }
        }

        if (!userId) {
            console.error('🔔 DEBUG: ❌ No primary user ID found for patient. Cannot send notification.');
            return false;
        }

        // Get user's FCM token
        const userDoc = await getDoc(doc(firestore, 'users', userId));
        if (!userDoc.exists()) {
            console.error('🔔 DEBUG: User not found in Firestore');
            return false;
        }

        const userData = userDoc.data();

        if (!userData.notificationsEnabled) {
            // This is expected - user hasn't enabled notifications in patient app
            // Not an error, just informational
            return false;
        }

        const fcmToken = userData.fcmToken;
        if (!fcmToken) {
            // User has enabled notifications but token is missing - this might need attention
            const reason = userData.fcmTokenUpdatedAt
                ? 'Token was previously saved but is now missing (patient app may need to refresh token)'
                : 'Token never saved (patient app may not have registered for notifications yet)';

            console.warn('🔔 WARNING: User has notifications enabled but no FCM token available', {
                userId,
                phone: userData.phone,
                notificationsEnabled: userData.notificationsEnabled,
                notificationPermissionGranted: userData.notificationPermissionGranted,
                fcmTokenUpdatedAt: userData.fcmTokenUpdatedAt || null,
                reason,
                action: 'Patient needs to grant notification permission and register FCM token in patient app',
            });
            return false;
        }



        // Build API URL
        const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';
        const apiUrl = `${baseUrl}/api/send-notification`;

        // Send notification via API
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                fcmToken,
                title,
                body,
                data,
            }),
        });



        if (!response.ok) {
            const errorText = await response.text();
            let errorData;
            try {
                errorData = JSON.parse(errorText);
            } catch {
                errorData = { message: errorText };
            }

            console.error('🔔 DEBUG: Failed to send notification. Status:', response.status);
            console.error('🔔 DEBUG: Error response:', errorText);

            // Check if token is invalid - this is a recoverable error
            const errorCode = errorData?.details?.code || errorData?.code;
            if (errorCode === 'messaging/registration-token-not-registered' ||
                errorCode === 'messaging/invalid-registration-token') {
                console.warn('🔔 DEBUG: ⚠️ Invalid/expired FCM token. Patient needs to refresh their token.');
                console.warn('🔔 DEBUG: Notification failed but appointment booking will continue.');
                // Return false but don't throw - this allows appointment booking to succeed
                return false;
            }

            return false;
        }

        const responseData = await response.json();
        return true;
    } catch (error) {
        console.error('🔔 DEBUG: Error sending notification to patient:', error);
        if (error instanceof Error) {
            console.error('🔔 DEBUG: Error message:', error.message);
            console.error('🔔 DEBUG: Error stack:', error.stack);
        }
        return false;
    }
}

/**
 * Send appointment confirmed notification when nurse/clinic books appointment
 */
export async function sendAppointmentBookedByStaffNotification(params: {
    firestore: Firestore;
    patientId: string;
    appointmentId: string;
    doctorName: string;
    clinicName: string;
    date: string;
    time: string;
    tokenNumber: string;
    bookedBy: 'nurse' | 'admin';
    arriveByTime?: string;
}): Promise<boolean> {
    const { firestore, patientId, appointmentId, doctorName, clinicName, date, time, tokenNumber, bookedBy, arriveByTime } = params;

    // Always display user time based on arriveByTime - 15 minutes (or time - 15 if arriveByTime missing)
    let displayTime = time;
    try {
        const appointmentDate = parse(date, 'd MMMM yyyy', new Date());
        const baseTime = parseTime(arriveByTime || time, appointmentDate);
        const shownTime = subMinutes(baseTime, 15);
        displayTime = format(shownTime, 'hh:mm a');
    } catch (error) {
        console.error('Error calculating displayTime for booking notification:', error);
    }

    return sendNotificationToPatient({
        firestore,
        patientId,
        title: 'Appointment Booked',
        body: `${clinicName} has booked an appointment with Dr. ${doctorName} on ${date} at ${displayTime}. Token: ${tokenNumber}`,
        data: {
            type: 'appointment_confirmed',
            appointmentId,
            doctorName,
            date,
            time: displayTime,
            tokenNumber,
            bookedBy,
            url: '/appointments', // Click will open appointments page
        },
    });
}

/**
 * Send notification when patient's token is called
 */
export async function sendTokenCalledNotification(params: {
    firestore: Firestore;
    patientId: string;
    appointmentId: string;
    clinicName: string;
    tokenNumber: string;
    doctorName: string;
}): Promise<boolean> {
    const { firestore, patientId, appointmentId, clinicName, tokenNumber, doctorName } = params;

    return sendNotificationToPatient({
        firestore,
        patientId,
        title: 'Your Turn!',
        body: `Token ${tokenNumber} for Dr. ${doctorName} is now being served at ${clinicName}. Please proceed to the clinic.`,
        data: {
            type: 'token_called',
            appointmentId,
            clinicName,
            tokenNumber,
            doctorName,
        },
    });
}

/**
 * Send notification when appointment is cancelled
 */
export async function sendAppointmentCancelledNotification(params: {
    firestore: Firestore;
    patientId: string;
    appointmentId: string;
    doctorName: string;
    clinicName: string;
    date: string;
    time: string;
    cancelledBy: 'patient' | 'clinic';
    arriveByTime?: string;
}): Promise<boolean> {
    const { firestore, patientId, appointmentId, doctorName, clinicName, date, time, cancelledBy, arriveByTime } = params;

    // Always display user time based on arriveByTime - 15 minutes (or time - 15 if arriveByTime missing)
    let displayTime = time;
    try {
        const appointmentDate = parse(date, 'd MMMM yyyy', new Date());
        const baseTime = parseTime(arriveByTime || time, appointmentDate);
        const shownTime = subMinutes(baseTime, 15);
        displayTime = format(shownTime, 'hh:mm a');
    } catch (error) {
        console.error('Error calculating displayTime for cancellation notification:', error);
    }

    return sendNotificationToPatient({
        firestore,
        patientId,
        title: 'Appointment Cancelled',
        body: cancelledBy === 'patient'
            ? `Your appointment with Dr. ${doctorName} on ${date} at ${displayTime} has been cancelled.`
            : `${clinicName} has cancelled your appointment with Dr. ${doctorName} on ${date} at ${displayTime}.`,
        data: {
            type: 'appointment_cancelled',
            appointmentId,
            doctorName,
            clinicName,
            date,
            time: displayTime,
            cancelledBy,
        },
    });
}

/**
 * Send notification when doctor is running late
 */
export async function sendDoctorRunningLateNotification(params: {
    firestore: Firestore;
    patientId: string;
    appointmentId: string;
    doctorName: string;
    clinicName: string;
    delayMinutes: number;
}): Promise<boolean> {
    const { firestore, patientId, appointmentId, doctorName, clinicName, delayMinutes } = params;

    return sendNotificationToPatient({
        firestore,
        patientId,
        title: 'Doctor Running Late',
        body: `Dr. ${doctorName} at ${clinicName} is running approximately ${delayMinutes} minutes late.`,
        data: {
            type: 'doctor_late',
            appointmentId,
            doctorName,
            clinicName,
            delayMinutes,
        },
    });
}

/**
 * Send notification when doctor goes on break and appointment time changes
 */
export async function sendBreakUpdateNotification(params: {
    firestore: Firestore;
    patientId: string;
    appointmentId: string;
    doctorName: string;
    clinicName: string;
    oldTime: string;
    newTime: string;
    oldDate?: string;
    newDate?: string;
    reason?: string;
    oldArriveByTime?: string;
    newArriveByTime?: string;
}): Promise<boolean> {
    const { firestore, patientId, appointmentId, doctorName, clinicName, oldTime, newTime, oldDate, newDate, reason, oldArriveByTime, newArriveByTime } = params;

    let displayOldTime = oldTime;
    let displayNewTime = newTime;

    try {
        // Get appointment date from appointmentId if needed for old time calculation
        let oldAppointmentDate: Date = new Date();
        if (oldDate) {
            oldAppointmentDate = parse(oldDate, 'd MMMM yyyy', new Date());
        } else {
            const appointmentDoc = await getDoc(doc(firestore, 'appointments', appointmentId));
            if (appointmentDoc.exists()) {
                const appointmentData = appointmentDoc.data() as Appointment;
                oldAppointmentDate = parse(appointmentData.date, 'd MMMM yyyy', new Date());
            }
        }

        // Calculate displayOldTime from oldArriveByTime - 15 minutes (or oldTime - 15 if oldArriveByTime not available)
        const oldBaseTime = parseTime(oldArriveByTime || oldTime, oldAppointmentDate);
        displayOldTime = format(subMinutes(oldBaseTime, 15), 'hh:mm a');

        // Get appointment date for new time calculation
        let newAppointmentDate: Date = new Date();
        if (newDate) {
            newAppointmentDate = parse(newDate, 'd MMMM yyyy', new Date());
        } else {
            // Fallback to oldAppointmentDate if newDate is not provided
            newAppointmentDate = oldAppointmentDate;
        }

        // Calculate displayNewTime from newArriveByTime - 15 minutes (or newTime - 15 if newArriveByTime not available)
        const newBaseTime = parseTime(newArriveByTime || newTime, newAppointmentDate);
        displayNewTime = format(subMinutes(newBaseTime, 15), 'hh:mm a');

    } catch (error) {
        console.error('Error calculating display times for reschedule notification:', error);
    }

    // Construct notification body with dates
    const oldDateTimeString = `${oldDate ? `${oldDate} at ` : ''}${displayOldTime}`;
    const newDateTimeString = `${newDate ? `${newDate} at ` : ''}${displayNewTime}`;

    return sendNotificationToPatient({
        firestore,
        patientId,
        title: 'Appointment Time Changed',
        body: `${clinicName} has rescheduled your appointment with Dr. ${doctorName} from ${oldDateTimeString} to ${newDateTimeString}.${reason ? ` Reason: ${reason}` : ''}`,
        data: {
            type: 'appointment_rescheduled',
            appointmentId,
            doctorName,
            clinicName,
            oldTime: displayOldTime,
            newTime: displayNewTime,
            oldDate,
            newDate,
            reason,
        },
    });
}

/**
 * Send notification when appointment is marked as Skipped
 */
export async function sendAppointmentSkippedNotification(params: {
    firestore: Firestore;
    patientId: string;
    appointmentId: string;
    doctorName: string;
    clinicName: string;
    date: string;
    time: string;
    tokenNumber: string;
}): Promise<boolean> {
    const { firestore, patientId, appointmentId, doctorName, clinicName, date, time, tokenNumber } = params;

    return sendNotificationToPatient({
        firestore,
        patientId,
        title: 'Appointment Skipped',
        body: `Your appointment with Dr. ${doctorName} on ${date} at ${time} (Token: ${tokenNumber}) has been marked as Skipped because you didn't confirm your arrival 5 minutes before the appointment time.`,
        data: {
            type: 'appointment_skipped',
            appointmentId,
            doctorName,
            clinicName,
            date,
            time,
            tokenNumber,
            url: '/live-token', // Click will open live token page
        },
    });
}

/**
 * Send notification to patients about how many people are ahead of them
 */
export async function sendPeopleAheadNotification(params: {
    firestore: Firestore;
    patientId: string;
    appointmentId: string;
    clinicName: string;
    tokenNumber: string;
    doctorName: string;
    peopleAhead: number;
    appointmentTime: string;
    appointmentDate: string;
}): Promise<boolean> {
    const { firestore, patientId, appointmentId, clinicName, tokenNumber, doctorName, peopleAhead, appointmentTime, appointmentDate } = params;

    // Calculate display time (arriveByTime - 15 minutes)
    let displayTime = appointmentTime;
    try {
        const appointmentDateObj = parse(appointmentDate, 'd MMMM yyyy', new Date());
        const appointmentDateTime = parseTime(appointmentTime, appointmentDateObj);
        const displayDateTime = subMinutes(appointmentDateTime, 15);
        displayTime = format(displayDateTime, 'hh:mm a');
    } catch (error) {
        console.error('Error calculating display time:', error);
    }

    const peopleAheadText = peopleAhead === 1 ? '1 person' : `${peopleAhead} people`;
    const body = peopleAhead === 0
        ? `There is ${peopleAheadText} ahead of you. You will be next to see Dr. ${doctorName} at ${clinicName}. Your appointment time: ${displayTime}. Token: ${tokenNumber}`
        : `There ${peopleAhead === 1 ? 'is' : 'are'} ${peopleAheadText} ahead of you. You will be next to see Dr. ${doctorName} at ${clinicName}. Your appointment time: ${displayTime}. Token: ${tokenNumber}`;

    return sendNotificationToPatient({
        firestore,
        patientId,
        title: peopleAhead === 0 ? 'You are Next!' : `Queue Update: ${peopleAheadText} Ahead`,
        body,
        data: {
            type: 'queue_update',
            appointmentId,
            clinicName,
            tokenNumber,
            doctorName,
            peopleAhead,
            appointmentTime: displayTime,
            appointmentDate,
            url: '/live-token',
        },
    });
}

/**
 * Send notification when doctor starts consultation (status becomes 'In')
 */
export async function sendDoctorConsultationStartedNotification(params: {
    firestore: Firestore;
    patientId: string;
    appointmentId: string;
    clinicName: string;
    tokenNumber: string;
    doctorName: string;
    appointmentTime: string;
    appointmentDate: string;
    arriveByTime?: string;
}): Promise<boolean> {
    const { firestore, patientId, appointmentId, clinicName, tokenNumber, doctorName, appointmentTime, appointmentDate, arriveByTime } = params;

    // Calculate display time (arriveByTime - 15 minutes if available, otherwise appointmentTime - 15)
    let displayTime = appointmentTime;
    try {
        const appointmentDateObj = parse(appointmentDate, 'd MMMM yyyy', new Date());
        if (arriveByTime) {
            const arriveByDateTime = parseTime(arriveByTime, appointmentDateObj);
            const displayDateTime = subMinutes(arriveByDateTime, 15);
            displayTime = format(displayDateTime, 'hh:mm a');
        } else {
            const appointmentDateTime = parseTime(appointmentTime, appointmentDateObj);
            const displayDateTime = subMinutes(appointmentDateTime, 15);
            displayTime = format(displayDateTime, 'hh:mm a');
        }
    } catch (error) {
        console.error('Error calculating display time:', error);
    }

    return sendNotificationToPatient({
        firestore,
        patientId,
        title: 'Doctor Consultation Started',
        body: `Dr. ${doctorName} has started consultation at ${clinicName}. Your appointment time: ${displayTime}. Token: ${tokenNumber}`,
        data: {
            type: 'doctor_consultation_started',
            appointmentId,
            clinicName,
            tokenNumber,
            doctorName,
            appointmentTime: displayTime,
            appointmentDate,
            url: '/live-token',
        },
    });
}

type ConsultationNotificationStatus = typeof CONSULTATION_NOTIFICATION_STATUSES[number];

type NotifySessionPatientsParams = {
    firestore: Firestore;
    clinicId: string;
    clinicName: string;
    doctorName: string;
    date: string;
    sessionIndex: number | undefined;
};

export async function notifySessionPatientsOfConsultationStart({
    firestore,
    clinicId,
    clinicName,
    doctorName,
    date,
    sessionIndex,
}: NotifySessionPatientsParams): Promise<void> {
    if (sessionIndex === undefined) {
        console.warn('Cannot notify consultation start without session index');
        return;
    }

    const appointmentStatuses = [...CONSULTATION_NOTIFICATION_STATUSES] as ConsultationNotificationStatus[];
    const appointmentsQuery = query(
        collection(firestore, 'appointments'),
        where('clinicId', '==', clinicId),
        where('doctor', '==', doctorName),
        where('date', '==', date),
        where('status', 'in', appointmentStatuses),
        where('sessionIndex', '==', sessionIndex)
    );

    const appointmentsSnapshot = await getDocs(appointmentsQuery);
    if (appointmentsSnapshot.empty) {
        return;
    }

    await Promise.all(
        appointmentsSnapshot.docs.map(async (docSnap) => {
            const appointment = docSnap.data() as Appointment;
            if (!appointment.patientId) return;

            try {
                await sendDoctorConsultationStartedNotification({
                    firestore,
                    patientId: appointment.patientId,
                    appointmentId: docSnap.id,
                    clinicName,
                    tokenNumber: appointment.tokenNumber || 'N/A',
                    doctorName: appointment.doctor,
                    appointmentTime: appointment.time,
                    appointmentDate: appointment.date,
                    arriveByTime: appointment.arriveByTime,
                });
            } catch (error) {
                console.error(`Failed to notify patient ${appointment.patientId} for appointment ${docSnap.id}`, error);
            }
        })
    );
}

/**
 * Notify next patients in queue when an appointment is completed
 */
export async function notifyNextPatientsWhenCompleted(params: {
    firestore: Firestore;
    completedAppointmentId: string;
    completedAppointment: Appointment;
    clinicName: string;
}): Promise<void> {
    const { firestore, completedAppointmentId, completedAppointment, clinicName } = params;

    try {
        // Get all appointments for the same doctor and date
        const appointmentsQuery = query(
            collection(firestore, 'appointments'),
            where('doctor', '==', completedAppointment.doctor),
            where('date', '==', completedAppointment.date),
            where('status', 'in', ['Pending', 'Confirmed'])
        );

        const appointmentsSnapshot = await getDocs(appointmentsQuery);
        const allAppointments = appointmentsSnapshot.docs
            .map(doc => ({ id: doc.id, ...doc.data() } as Appointment))
            .filter(apt => apt.id !== completedAppointmentId);

        // Sort by slotIndex or time
        const sortedAppointments = allAppointments.sort((a, b) => {
            if (typeof a.slotIndex === 'number' && typeof b.slotIndex === 'number') {
                return a.slotIndex - b.slotIndex;
            }
            // Fallback to time comparison
            try {
                const dateA = parse(a.date, 'd MMMM yyyy', new Date());
                const dateB = parse(b.date, 'd MMMM yyyy', new Date());
                const timeA = parseTime(a.time, dateA);
                const timeB = parseTime(b.time, dateB);
                return timeA.getTime() - timeB.getTime();
            } catch {
                return 0;
            }
        });

        // Get appointments that come after the completed one
        const completedSlotIndex = typeof completedAppointment.slotIndex === 'number' ? completedAppointment.slotIndex : -1;
        const nextAppointments = sortedAppointments.filter(apt => {
            if (typeof apt.slotIndex === 'number' && completedSlotIndex >= 0) {
                return apt.slotIndex > completedSlotIndex;
            }
            // Fallback to time comparison
            try {
                const dateCompleted = parse(completedAppointment.date, 'd MMMM yyyy', new Date());
                const dateApt = parse(apt.date, 'd MMMM yyyy', new Date());
                const timeCompleted = parseTime(completedAppointment.time, dateCompleted);
                const timeApt = parseTime(apt.time, dateApt);
                return timeApt.getTime() > timeCompleted.getTime();
            } catch {
                return false;
            }
        });

        // Send notifications to next patients (limit to first 3 to avoid spam)
        const appointmentsToNotify = nextAppointments.slice(0, 3);
        for (let i = 0; i < appointmentsToNotify.length; i++) {
            const appointment = appointmentsToNotify[i];
            const peopleAhead = i; // Number of appointments ahead (0-indexed)

            if (!appointment.patientId) continue;

            try {
                await sendPeopleAheadNotification({
                    firestore,
                    patientId: appointment.patientId,
                    appointmentId: appointment.id,
                    clinicName,
                    tokenNumber: appointment.tokenNumber,
                    doctorName: appointment.doctor,
                    peopleAhead,
                    appointmentTime: appointment.time,
                    appointmentDate: appointment.date,
                });
            } catch (error) {
                console.error(`Failed to send notification to patient ${appointment.patientId}:`, error);
                // Continue with other notifications
            }
        }
    } catch (error) {
        console.error('Error notifying next patients:', error);
    }
}
