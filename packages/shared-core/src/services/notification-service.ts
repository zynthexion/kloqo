/**
 * Notification Service
 * Sends notifications to patients when appointments are created
 */

import { Firestore, doc, getDoc, collection, query, where, getDocs, updateDoc } from 'firebase/firestore';
import { parse, format, subMinutes, addMinutes } from 'date-fns';
import { parseTime } from '../utils/break-helpers';
import { getClinicTimeString, getClinicISOString, getClinicNow } from '../utils/date-utils';
import { compareAppointments } from './appointment-service';
import type { Appointment } from '@kloqo/shared-types';
import { MagicLinkService } from './magic-link-service';

declare const window: any;

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
            console.warn(`[Notification] ⚠️ Patient not found: ${patientId}`);
            return false;
        }

        const patientData = patientDoc.data();
        let userId: string | undefined;

        // User resolution logic based on isPrimary flag
        if (patientData.isPrimary) {
            userId = patientData.primaryUserId;
        } else {
            // Fallthrough to phone lookup logic below
        }

        // Search by phone if userId is not set (either !isPrimary or primaryUserId was missing/null)
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
                    }
                } catch (error) {
                    console.error('Error searching for primary user by communicationPhone:', error);
                }
            }
        }

        if (!userId) {
            console.warn(`[Notification] ⚠️ Could not resolve userId for patient ${patientId}. isPrimary: ${patientData.isPrimary}, primaryUserId: ${patientData.primaryUserId}, communicationPhone: ${patientData.communicationPhone || patientData.phone}`);
            return false;
        }

        console.log(`[Notification] 🎯 DEBUG: Resolved userId: ${userId} for patient: ${patientId}`);

        // Get user's FCM token
        const userDoc = await getDoc(doc(firestore, 'users', userId));
        if (!userDoc.exists()) {
            console.warn(`[Notification] ⚠️ User document not found: ${userId}`);
            return false;
        }

        const userData = userDoc.data();

        if (!userData.notificationsEnabled) {
            // This is expected - user hasn't enabled notifications in patient app
            console.info(`[Notification] ℹ️ Notifications disabled for user ${userId} (patient: ${patientId}). User needs to enable notifications in app settings.`);
            return false;
        }

        const fcmToken = userData.fcmToken;
        if (!fcmToken) {
            console.warn(`[Notification] ⚠️ No FCM token for user ${userId} (patient: ${patientId}). User may not have granted notification permissions or token failed to sync.`);
            return false;
        }

        console.log(`[Notification] 🎯 DEBUG: Found FCM Token (prefix): ${fcmToken.substring(0, 10)}... for user: ${userId}`);

        const language = userData.language || 'en';

        // Build API URL
        let baseUrl = process.env.NEXT_PUBLIC_BASE_URL;

        if (typeof window !== 'undefined' && window.location.hostname === 'localhost') {
            baseUrl = 'http://localhost:3000'; // Patient app likely on 3000 (default)
        }

        // Fallback or default
        baseUrl = baseUrl || 'https://app.kloqo.com';

        const apiUrl = `${baseUrl}/api/send-notification`;
        console.log(`[Notification] 🎯 DEBUG: Calling API: ${apiUrl} for patient: ${patientId}`);

        // Send notification via API
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                userId, // Pass userId so the API can save to history
                fcmToken,
                title,
                body,
                data,
                language,
            }),
        });

        if (!response.ok) {
            console.error(`[Notification] ❌ API Failed for patient ${patientId}:`, response.statusText, response.status);
            const errorText = await response.text();
            console.error(`[Notification] ❌ API Error Body:`, errorText);
            return false;
        }

        const responseData = await response.json() as any;
        console.log(`[Notification] ✅ Successfully sent to patient ${patientId} (user: ${userId}):`, { title, type: data?.type, message: responseData.message });
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
 * Send WhatsApp message using the clinic's local API
 */
export async function sendWhatsAppMessage(params: {
    to: string;
    message?: string;
    contentSid?: string;
    contentVariables?: any;
}): Promise<boolean> {
    try {
        const { to, message, contentSid, contentVariables } = params;

        // Build API URL
        let baseUrl: string;
        if (typeof window !== 'undefined') {
            // Use the current origin (nurse.kloqo.com, admin.kloqo.com, or localhost)
            baseUrl = window.location.origin;
        } else {
            // Fallback for server-side or non-browser environments
            baseUrl = process.env.NEXT_PUBLIC_BASE_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://app.kloqo.com');
        }

        const apiUrl = `${baseUrl}/api/send-sms`;
        console.log(`[WhatsApp] 🎯 DEBUG: Calling WhatsApp API: ${apiUrl} for: ${to} (BaseURL: ${baseUrl})`);

        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                to,
                message,
                channel: 'whatsapp',
                contentSid,
                contentVariables,
            }),
        });

        if (!response.ok) {
            console.error(`[WhatsApp] ❌ API Failed for ${to}:`, response.statusText, response.status);
            return false;
        }

        console.log(`[WhatsApp] ✅ Successfully triggered WhatsApp for ${to}`);
        return true;
    } catch (error) {
        console.error('[WhatsApp] ❌ Error calling WhatsApp API:', error);
        return false;
    }
}

/**
 * Send WhatsApp confirmation for staff-booked appointments
 */
export async function sendWhatsAppAppointmentConfirmed(params: {
    communicationPhone: string;
    patientName: string;
    doctorName: string;
    clinicName: string;
    date: string;
    time: string;
    arriveByTime: string;
    tokenNumber: string;
    appointmentId: string;
    showToken?: boolean;
    magicToken?: string; // NEW: Supporting magic links
}): Promise<boolean> {
    const { communicationPhone, patientName, doctorName, clinicName, date, time, arriveByTime, tokenNumber, appointmentId, showToken = true, magicToken } = params;

    // Meta Template Names
    const templateWithToken = 'appointment_confirmed_ml';
    const templateNoToken = 'appointment_confirmed_no_token_ml';

    // Patient app URL with attribution
    let patientAppBaseUrl = process.env.NEXT_PUBLIC_PATIENT_APP_URL || 'https://app.kloqo.com';

    let templateName = templateWithToken;
    let contentVariables: any = {};

    if (showToken) {
        templateName = templateWithToken;
        const liveStatusRef = `whatsapp_confirmation`; // USER REQUESTED: Template 1 use whatsapp_confirmation
        const baseUrl = `${appointmentId}?ref=${liveStatusRef}`;
        const liveStatusLink = magicToken ? `${baseUrl}&magicToken=${magicToken}` : baseUrl;

        contentVariables = {
            "1": patientName,
            "2": doctorName,
            "3": clinicName,
            "4": date,
            "5": tokenNumber || '--',
            "6": arriveByTime,
            "7": liveStatusLink // Button dynamic URL suffix
        };
        console.log(`[WhatsApp] 📄 Using Meta Template (appointment_confirmed_ml) - Token: ${tokenNumber}`);
    } else {
        templateName = templateNoToken;
        const liveStatusRef = `whatsapp_confirmation_no_token`;
        const baseUrl = `${appointmentId}?ref=${liveStatusRef}`;
        const liveStatusLink = magicToken ? `${baseUrl}&magicToken=${magicToken}` : baseUrl;

        contentVariables = {
            "1": patientName,
            "2": doctorName,
            "3": clinicName,
            "4": date,
            "5": arriveByTime,
            "6": liveStatusLink
        };
        console.log(`[WhatsApp] 📄 Using Meta Template (appointment_confirmed_no_token_ml)`);
    }

    return sendWhatsAppMessage({
        to: communicationPhone,
        contentSid: templateName, // Using templateName as contentSid for the API route to handle
        contentVariables
    });
}

/**
 * Send WhatsApp "Arrival Confirmed" with Magic Link for status transitions
 */
export async function sendWhatsAppArrivalConfirmed(params: {
    firestore: Firestore;
    communicationPhone: string;
    patientName: string;
    tokenNumber: string;
    appointmentId: string;
}): Promise<boolean> {
    const { firestore, communicationPhone, patientName, tokenNumber, appointmentId } = params;

    try {
        // 1. Generate a magic token
        const token = await MagicLinkService.generateToken(params.firestore || (null as any), communicationPhone, `live-token/${appointmentId}`);

        // 2. Prepare Template
        const templateName = 'appointment_status_confirmed_ml';
        const liveStatusRef = `status_confirmed`;
        const linkSuffix = `${appointmentId}?ref=${liveStatusRef}&magicToken=${token}`;

        const contentVariables = {
            "1": patientName,
            "2": tokenNumber,
            "3": linkSuffix // Button dynamic URL suffix
        };

        console.log(`[WhatsApp] 📄 Using Meta Template (appointment_status_confirmed_ml) - Token: ${tokenNumber}`);

        return sendWhatsAppMessage({
            to: communicationPhone,
            contentSid: templateName,
            contentVariables
        });
    } catch (error) {
        console.error('[WhatsApp] ❌ Error in sendWhatsAppArrivalConfirmed:', error);
        return false;
    }
}

/**
 * Sends a professional AI Fallback message with a Magic Link when AI is busy/exhausted.
 */
export async function sendWhatsAppAIFallback(params: {
    communicationPhone: string;
    patientName?: string;
    magicToken: string;
    clinicId?: string;
}): Promise<boolean> {
    const { communicationPhone, patientName, magicToken, clinicId } = params;

    try {
        const templateName = 'ai_fallback_ml';
        // Redirect to clinic home or global home
        const redirectPath = clinicId ? `/home?clinicId=${clinicId}` : '/home';
        const linkSuffix = `?ref=ai_fallback&magicToken=${magicToken}`;

        const contentVariables = {
            "1": patientName || 'സുഹൃത്തേ',
            "2": linkSuffix // Button dynamic URL suffix
        };

        console.log(`[WhatsApp] 🤖 Sending AI Fallback (ai_fallback_ml) to: ${communicationPhone}`);

        return sendWhatsAppMessage({
            to: communicationPhone,
            contentSid: templateName,
            contentVariables
        });
    } catch (error) {
        console.error('[WhatsApp] ❌ Error in sendWhatsAppAIFallback:', error);
        return false;
    }
}

/**
 * Send WhatsApp booking link for pending appointments
 */
export async function sendWhatsAppBookingLink(params: {
    communicationPhone: string;
    patientName: string;
    clinicName: string;
    clinicCode: string; // e.g., KQ-NZYX (for display in body)
    clinicId: string; // Firestore ID for the URL
    magicToken?: string;
    redirectPath?: string;
}): Promise<boolean> {
    const { communicationPhone, patientName, clinicName, clinicCode, clinicId, magicToken, redirectPath } = params;

    const templateName = 'appointment_requested_ml';
    const ref = 'whatsapp_booking_link';

    // Meta template button URL is: https://app.kloqo.com/clinics/{{1}}
    // So {{1}} will be replaced with the button parameter
    // We need to send: clinicId?ref=...&redirect=...&magicToken=...
    const baseSuffix = `${clinicId}?ref=${ref}${redirectPath ? `&redirect=${encodeURIComponent(redirectPath)}` : ''}`;
    const linkSuffix = magicToken ? `${baseSuffix}&magicToken=${magicToken}` : baseSuffix;

    const contentVariables = {
        "1": patientName,
        "2": clinicName,
        "3": clinicCode, // Reference ID / Code (for display in message body)
        "4": linkSuffix // This goes to the button URL as {{1}}
    };

    console.log(`[WhatsApp] 📄 Using Meta Template (appointment_requested_ml) for ${patientName}`);

    return sendWhatsAppMessage({
        to: communicationPhone,
        contentSid: templateName,
        contentVariables
    });
}

/**
 * Sends a free-form text message via WhatsApp (24h window only).
 */
export async function sendWhatsAppText(params: {
    to: string;
    text: string;
}): Promise<boolean> {
    const { to, text } = params;
    return sendWhatsAppMessage({
        to,
        contentSid: 'text_message', // Special flag for text
        contentVariables: { text }
    });
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
    cancelledByBreak?: boolean;
    communicationPhone?: string; // New: optional phone for WhatsApp
    patientName?: string; // New: for WhatsApp template
    tokenDistribution?: 'classic' | 'advanced'; // New: needed for logic
    classicTokenNumber?: string; // New: needed for logic
}): Promise<boolean> {
    const {
        firestore,
        patientId,
        appointmentId,
        doctorName,
        clinicName,
        date,
        time,
        tokenNumber,
        bookedBy,
        arriveByTime,
        cancelledByBreak,
        communicationPhone,
        patientName,
        tokenDistribution,
        classicTokenNumber,
    } = params;

    if (cancelledByBreak) {
        console.info(`[Notification] ℹ️ Skipping booked notification for appointment ${appointmentId} because it was affected by a break.`);
        return true;
    }

    // Always display user time based on arriveByTime - 15 minutes (or time - 15 if arriveByTime missing)
    // EXCEPTION: For "Walk-in" (W) tokens, display the exact time as they are already at the clinic.
    let displayTime = time;
    try {
        if (tokenNumber && tokenNumber.startsWith('W')) {
            // For Walk-in, show the exact time (which is the estimated start time)
            displayTime = time;
        } else {
            // For regular tokens, show reporting time (15 mins early)
            const appointmentDate = parse(date, 'd MMMM yyyy', new Date());
            const baseTime = parseTime(arriveByTime || time, appointmentDate);
            const shownTime = subMinutes(baseTime, 15);
            displayTime = getClinicTimeString(shownTime);
        }
    } catch (error) {
        console.error('Error calculating displayTime for booking notification:', error);
    }

    // STRICT LOGIC for Push Notification (matches client-side service):
    // If Classic Clinic -> Only show classicTokenNumber (if exists).
    // If Advanced -> Show tokenNumber.
    // For Staff Booking, tokenNumber might be 'A...' or 'W...'. 

    let pushShowToken = true;
    let pushTokenDisplay = tokenNumber;

    if (tokenDistribution === 'classic') {
        if (classicTokenNumber) {
            pushTokenDisplay = classicTokenNumber;
            pushShowToken = true;
        } else if (tokenNumber && (tokenNumber.startsWith('W') || /^\d+$/.test(tokenNumber))) {
            // Walk-in / numeric -> Show it
            pushTokenDisplay = tokenNumber;
            pushShowToken = true;
        } else {
            // Classic mode but 'A' token -> Hide it
            pushShowToken = false;
        }
    } else {
        // Advanced -> Show whatever token we have
        pushShowToken = !!tokenNumber;
    }

    const pwaResult = await sendNotificationToPatient({
        firestore,
        patientId,
        title: 'Appointment Booked',
        body: `${clinicName} has booked an appointment with Dr. ${doctorName} on ${date} at ${displayTime}.${pushShowToken ? ` Token: ${pushTokenDisplay}` : ''}`,
        data: {
            type: 'appointment_confirmed',
            appointmentId,
            doctorName,
            date,
            time: displayTime,
            tokenNumber: pushTokenDisplay,
            bookedBy,
            url: '/appointments', // Click will open appointments page
        },
    });

    // Handle WhatsApp notification for "A" tokens
    const isAdvancedBooking = tokenNumber && tokenNumber.startsWith('A');
    if (isAdvancedBooking && communicationPhone) {
        // Determine if we show token in WhatsApp
        // Same logic: If Classic mode AND no classicTokenNumber -> HIDE.
        // But 'A' token usually implies no classicTokenNumber yet (pre-arrival).

        let whatsappShowToken = true;
        if (tokenDistribution === 'classic') {
            if (classicTokenNumber) {
                // If we somehow have a classic token for an A booking (maybe confirmed?), show it.
                // But usually A token means pre-arrival.
                // If we want to show classic token, we should pass THAT number.
                // But params.tokenNumber is 'A...'.
                // If classicTokenNumber exists, we probably want to send THAT too?
                // But this block is specifically "Handle WhatsApp for 'A' tokens".
                // If it's Classic, we want to HIDE the 'A' token.
                whatsappShowToken = false;
            } else {
                whatsappShowToken = false; // Confirm hide A token for Classic
            }
        }

        try {
            console.log(`[Notification] 📱 Triggering WhatsApp for Advanced Booking: ${tokenNumber} (ShowToken: ${whatsappShowToken})`);
            await sendWhatsAppAppointmentConfirmed({
                communicationPhone: communicationPhone,
                patientName: patientName || 'Patient',
                doctorName,
                clinicName,
                date,
                time: arriveByTime || time, // Slot time
                arriveByTime: displayTime,  // Reporting time (15m early)
                tokenNumber,
                appointmentId,
                showToken: whatsappShowToken
            });
        } catch (error) {
            console.error('[Notification] ❌ Failed to send WhatsApp notification:', error);
        }
    }

    return pwaResult;
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
    cancelledByBreak?: boolean;
}): Promise<boolean> {
    const { firestore, patientId, appointmentId, clinicName, tokenNumber, doctorName, cancelledByBreak } = params;

    if (cancelledByBreak) {
        console.info(`[Notification] ℹ️ Skipping token called notification for appointment ${appointmentId} because it was cancelled by a break.`);
        return true;
    }

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
    cancelledByBreak?: boolean;
}): Promise<boolean> {
    const { firestore, patientId, appointmentId, doctorName, clinicName, date, time, cancelledBy, arriveByTime, cancelledByBreak } = params;

    if (cancelledByBreak) {
        console.info(`[Notification] ℹ️ Skipping cancellation notification for appointment ${appointmentId} because it was cancelled by a break.`);
        return true; // Return true as we've "handled" it by skipping
    }

    // Always display user time based on arriveByTime - 15 minutes (or time - 15 if arriveByTime missing)
    let displayTime = time;
    try {
        const appointmentDate = parse(date, 'd MMMM yyyy', new Date());
        const baseTime = parseTime(arriveByTime || time, appointmentDate);
        const shownTime = subMinutes(baseTime, 15);
        displayTime = getClinicTimeString(shownTime);
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
    cancelledByBreak?: boolean;
}): Promise<boolean> {
    const { firestore, patientId, appointmentId, doctorName, clinicName, delayMinutes, cancelledByBreak } = params;

    if (cancelledByBreak) {
        console.info(`[Notification] ℹ️ Skipping doctor late notification for appointment ${appointmentId} because it was affected by a break.`);
        return true;
    }

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
    cancelledByBreak?: boolean;
}): Promise<boolean> {
    const { firestore, patientId, appointmentId, doctorName, clinicName, oldTime, newTime, oldDate, newDate, reason, oldArriveByTime, newArriveByTime, cancelledByBreak } = params;

    if (cancelledByBreak) {
        console.info(`[Notification] ℹ️ Skipping break update notification for appointment ${appointmentId} because it was affected by a break.`);
        return true;
    }

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
        displayOldTime = getClinicTimeString(subMinutes(oldBaseTime, 15));

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
        displayNewTime = getClinicTimeString(subMinutes(newBaseTime, 15));

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
    cancelledByBreak?: boolean;
}): Promise<boolean> {
    const { firestore, patientId, appointmentId, doctorName, clinicName, date, time, tokenNumber, cancelledByBreak } = params;

    if (cancelledByBreak) {
        console.info(`[Notification] ℹ️ Skipping skipped notification for appointment ${appointmentId} because it was affected by a break.`);
        return true;
    }

    // Always display user time based on 15 minutes early reporting
    let displayTime = time;
    try {
        const appointmentDate = parse(date, 'd MMMM yyyy', new Date());
        // For skipped, we usually have the raw slot time. Subtract 15m for reporting time.
        const baseTime = parseTime(time, appointmentDate);
        const shownTime = subMinutes(baseTime, 15);
        displayTime = getClinicTimeString(shownTime);
    } catch (error) {
        console.error('Error calculating displayTime for skipped notification:', error);
    }

    return sendNotificationToPatient({
        firestore,
        patientId,
        title: 'Appointment Skipped',
        body: `Your appointment with Dr. ${doctorName} on ${date} at ${displayTime} (Token: ${tokenNumber}) has been marked as Skipped because you didn't confirm your arrival 5 minutes before the appointment time.`,
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
    cancelledByBreak?: boolean;
    breakDuration?: number;
    tokenDistribution?: 'classic' | 'advanced';
    averageConsultingTime?: number;
} | any): Promise<boolean> {
    const { firestore, patientId, appointmentId, clinicName, tokenNumber, doctorName, peopleAhead, appointmentTime, appointmentDate, cancelledByBreak, breakDuration, tokenDistribution, averageConsultingTime } = params;

    if (cancelledByBreak) {
        console.info(`[Notification] ℹ️ Skipping people ahead notification for appointment ${appointmentId} because it was cancelled by a break.`);
        return true;
    }

    // Calculate display time
    // For Advanced: (arriveByTime - 15 minutes)
    // For Classic: (CurrentTime + (peopleAhead * averageConsultingTime))
    let displayTime = appointmentTime;
    const isClassic = tokenDistribution === 'classic';

    try {
        if (isClassic) {
            const now = getClinicNow();
            const waitTime = peopleAhead * (averageConsultingTime || 15);
            const estimatedTurnTime = addMinutes(now, waitTime);
            displayTime = getClinicTimeString(estimatedTurnTime);
        } else {
            const appointmentDateObj = parse(appointmentDate, 'd MMMM yyyy', new Date());
            const appointmentDateTime = parseTime(appointmentTime, appointmentDateObj);
            const displayDateTime = subMinutes(appointmentDateTime, 15);
            displayTime = getClinicTimeString(displayDateTime);
        }
    } catch (error) {
        console.error('Error calculating display time:', error);
    }

    const peopleAheadText = peopleAhead === 1 ? '1 person' : `${peopleAhead} people`;

    let body = '';
    let title = '';

    if (peopleAhead === 0) {
        title = 'You are Next!';
        if (breakDuration && breakDuration > 0) {
            body = `The doctor is on a ${breakDuration}-minute break. You will be next to see Dr. ${doctorName} at ${clinicName} after the break.${!isClassic ? ` Your appointment time: ${displayTime}.` : ` Expected turn time: ${displayTime}.`}${tokenNumber ? ` Token: ${tokenNumber}` : ''}`;
        } else {
            body = `There is ${peopleAheadText} ahead of you. You will be next to see Dr. ${doctorName} at ${clinicName}.${!isClassic ? ` Your appointment time: ${displayTime}.` : ` Expected turn time: ${displayTime}.`}${tokenNumber ? ` Token: ${tokenNumber}` : ''}`;
        }
    } else {
        title = `Queue Update: ${peopleAheadText} Ahead`;
        if (breakDuration && breakDuration > 0) {
            body = `There ${peopleAhead === 1 ? 'is' : 'are'} ${peopleAheadText} ahead of you. A ${breakDuration}-minute break is also scheduled before your turn. You will see Dr. ${doctorName} at ${clinicName}.${!isClassic ? ` Your appointment time: ${displayTime}.` : ` Expected turn time: ${displayTime}.`}${tokenNumber ? ` Token: ${tokenNumber}` : ''}`;
        } else {
            body = `There ${peopleAhead === 1 ? 'is' : 'are'} ${peopleAheadText} ahead of you. You will be next to see Dr. ${doctorName} at ${clinicName}.${!isClassic ? ` Your appointment time: ${displayTime}.` : ` Expected turn time: ${displayTime}.`}${tokenNumber ? ` Token: ${tokenNumber}` : ''}`;
        }
    }

    return sendNotificationToPatient({
        firestore,
        patientId,
        title,
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
    cancelledByBreak?: boolean;
    tokenDistribution?: 'classic' | 'advanced';
    averageConsultingTime?: number;
    peopleAhead?: number; // Optional: used for classic estimated time calculation
} | any): Promise<boolean> {
    const { firestore, patientId, appointmentId, clinicName, tokenNumber, doctorName, appointmentTime, appointmentDate, arriveByTime, cancelledByBreak, tokenDistribution, averageConsultingTime, peopleAhead } = params;

    if (cancelledByBreak) {
        console.info(`[Notification] ℹ️ Skipping consultation started notification for appointment ${appointmentId} because it was cancelled by a break.`);
        return true;
    }

    // Calculate display time
    // For Advanced: (arriveByTime - 15 minutes if available, otherwise appointmentTime - 15)
    // For Classic: (CurrentTime + (peopleAhead * averageConsultingTime))
    let displayTime = appointmentTime;
    const isClassic = tokenDistribution === 'classic';

    try {
        if (isClassic && typeof peopleAhead === 'number') {
            const now = getClinicNow();
            const waitTime = peopleAhead * (averageConsultingTime || 15);
            const estimatedTurnTime = addMinutes(now, waitTime);
            displayTime = getClinicTimeString(estimatedTurnTime);
        } else {
            const appointmentDateObj = parse(appointmentDate, 'd MMMM yyyy', new Date());
            if (arriveByTime) {
                const arriveByDateTime = parseTime(arriveByTime, appointmentDateObj);
                const displayDateTime = subMinutes(arriveByDateTime, 15);
                displayTime = getClinicTimeString(displayDateTime);
            } else {
                const appointmentDateTime = parseTime(appointmentTime, appointmentDateObj);
                const displayDateTime = subMinutes(appointmentDateTime, 15);
                displayTime = getClinicTimeString(displayDateTime);
            }
        }
    } catch (error) {
        console.error('Error calculating display time:', error);
    }

    const timeLabel = isClassic ? 'Expected turn time' : 'Your appointment time';

    return sendNotificationToPatient({
        firestore,
        patientId,
        title: 'Doctor Consultation Started',
        body: `Dr. ${doctorName} has started consultation at ${clinicName}.${displayTime ? ` ${timeLabel}: ${displayTime}.` : ''}${tokenNumber ? ` Token: ${tokenNumber}` : ''}`,
        data: {
            type: 'token_distribution_started',
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
    tokenDistribution?: 'classic' | 'advanced';
    averageConsultingTime?: number;
};

export async function notifySessionPatientsOfConsultationStart({
    firestore,
    clinicId,
    clinicName,
    doctorName,
    date,
    sessionIndex,
    tokenDistribution,
    averageConsultingTime,
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

    const { compareAppointments, compareAppointmentsClassic } = await import('./appointment-service');
    const sortedAppointments = appointmentsSnapshot.docs
        .map(doc => ({ id: doc.id, ...doc.data() } as Appointment))
        .sort(tokenDistribution === 'classic' ? compareAppointmentsClassic : compareAppointments);

    await Promise.all(
        sortedAppointments.map(async (appointment, index) => {
            if (!appointment.patientId) return;

            try {
                await sendDoctorConsultationStartedNotification({
                    firestore,
                    patientId: appointment.patientId,
                    appointmentId: appointment.id,
                    clinicName,
                    tokenNumber: (tokenDistribution === 'classic' && appointment.classicTokenNumber) ? appointment.classicTokenNumber : (tokenDistribution === 'classic' ? '' : (appointment.tokenNumber || 'N/A')),
                    doctorName: appointment.doctor,
                    appointmentTime: appointment.time,
                    appointmentDate: appointment.date,
                    arriveByTime: appointment.arriveByTime,
                    cancelledByBreak: appointment.cancelledByBreak,
                    tokenDistribution,
                    averageConsultingTime,
                    peopleAhead: index,
                });
            } catch (error) {
                console.error(`Failed to notify patient ${appointment.patientId} for appointment ${appointment.id}`, error);
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
            where('status', 'in', ['Pending', 'Confirmed', 'Completed', 'Skipped'])
        );

        const appointmentsSnapshot = await getDocs(appointmentsQuery);
        const allAppointments = appointmentsSnapshot.docs
            .map(doc => ({ id: doc.id, ...doc.data() } as Appointment))
            .filter(apt => apt.id !== completedAppointmentId);

        // Get clinic data for tokenDistribution
        const clinicDoc = await getDoc(doc(firestore, 'clinics', completedAppointment.clinicId));
        const tokenDistribution = clinicDoc.exists() ? clinicDoc.data()?.tokenDistribution : 'advanced';

        // Get doctor data for averageConsultingTime
        // We'll use doctor name to find the doctor doc (consistent with other logic)
        const doctorsQuery = query(
            collection(firestore, 'doctors'),
            where('clinicId', '==', completedAppointment.clinicId),
            where('name', '==', completedAppointment.doctor)
        );
        const doctorsSnapshot = await getDocs(doctorsQuery);
        let averageConsultingTime = 15;
        let doctorStatus: 'In' | 'Out' = 'Out';
        if (!doctorsSnapshot.empty) {
            const doctorData = doctorsSnapshot.docs[0].data();
            averageConsultingTime = doctorData?.averageConsultingTime || 15;
            doctorStatus = doctorData?.consultationStatus || 'Out';
        }

        const { compareAppointments, compareAppointmentsClassic } = await import('./appointment-service');

        // Sort using appropriate logic
        const sortedAppointments = allAppointments.sort(tokenDistribution === 'classic' ? compareAppointmentsClassic : compareAppointments);

        // Get appointments that come after the completed one
        const nextAppointments = sortedAppointments.filter(apt => {
            const comparison = tokenDistribution === 'classic'
                ? compareAppointmentsClassic(apt, completedAppointment)
                : compareAppointments(apt, completedAppointment);
            return comparison > 0;
        });

        // Send notifications to next patients (limit to first 3 to avoid spam)
        const appointmentsToNotify = nextAppointments
            .filter(apt => apt.status !== 'Completed' && apt.status !== 'Skipped')
            .slice(0, 3);

        // Find existing break gaps
        const breaks = nextAppointments.filter(apt => apt.status === 'Completed' && apt.patientId === 'dummy-break-patient');

        const completedSlotIndex = completedAppointment.slotIndex || -1;

        for (let i = 0; i < appointmentsToNotify.length; i++) {
            const appointment = appointmentsToNotify[i];
            const peopleAhead = i; // Number of appointments ahead (0-indexed)

            if (!appointment.patientId) continue;

            // Detect if there is a break before this patient
            let breakDuration = 0;
            const patientSlotIndex = appointment.slotIndex || -1;

            if (patientSlotIndex !== -1) {
                // Sum up durations of dummy break appointments that appear before this patient
                // but after the completed one
                const now = getClinicNow();
                const breaksBeforePatient = breaks.filter(b => {
                    if (typeof b.slotIndex !== 'number') return false;
                    const indexMatch = b.slotIndex > completedSlotIndex && b.slotIndex < patientSlotIndex;
                    if (!indexMatch) return false;

                    // Sync Break Cancellation: If doctor is 'In', ignore active breaks
                    if (doctorStatus === 'In') {
                        try {
                            const appointmentDateObj = parse(b.date, 'd MMMM yyyy', new Date());
                            const breakTime = parseTime(b.time, appointmentDateObj);
                            const breakEndTime = addMinutes(breakTime, averageConsultingTime);

                            // If currently within THIS break slot, ignore it if doctor is 'In'
                            if (now >= breakTime && now < breakEndTime) {
                                return false;
                            }
                        } catch (e) {
                            console.error('Error parsing break time for notification filter:', e);
                        }
                    }
                    return true;
                });

                // Calculate duration based on remaining valid dummy appointments
                breakDuration = breaksBeforePatient.length * averageConsultingTime;
            }

            try {
                await sendPeopleAheadNotification({
                    firestore,
                    patientId: appointment.patientId,
                    appointmentId: appointment.id,
                    clinicName,
                    tokenNumber: (tokenDistribution === 'classic' && appointment.classicTokenNumber) ? appointment.classicTokenNumber : (tokenDistribution === 'classic' ? '' : appointment.tokenNumber),
                    doctorName: appointment.doctor,
                    peopleAhead,
                    appointmentTime: appointment.time,
                    appointmentDate: appointment.date,
                    cancelledByBreak: appointment.cancelledByBreak,
                    breakDuration,
                    tokenDistribution,
                    averageConsultingTime,
                });
            } catch (error) {
                console.error(`Failed to send notification to patient ${appointment.patientId}:`, error);
            }
        }
    } catch (error) {
        console.error('Error notifying next patients:', error);
    }
}

/**
 * Send notification for Free Follow-up Expiry
 */
export async function sendFreeFollowUpExpiryNotification(params: {
    firestore: Firestore;
    patientId: string;
    doctorName: string;
    clinicName: string;
    remainingDays: number;
}): Promise<boolean> {
    const { firestore, patientId, doctorName, clinicName, remainingDays } = params;

    return sendNotificationToPatient({
        firestore,
        patientId,
        title: 'Free Follow-up Expiring Soon',
        body: `You have ${remainingDays} more days to visit Dr. ${doctorName} for free.`,
        data: {
            type: 'free_followup_expiry',
            doctorName,
            clinicName,
            remainingDays,
        },
    });
}

/**
 * Check and send daily reminders for all doctors in a clinic
 * Intended to be run once per day from the Nurse/Admin App
 */
export async function checkAndSendDailyReminders(params: {
    firestore: Firestore;
    clinicId: string;
}): Promise<void> {
    const { firestore, clinicId } = params;
    const todayStr = getClinicISOString(getClinicNow());

    try {
        console.log(`[DAILY REMINDER] Starting check for clinic ${clinicId} on ${todayStr}`);

        // 1. Get all doctors for this clinic
        const doctorsQuery = query(
            collection(firestore, 'doctors'),
            where('clinicId', '==', clinicId)
        );
        const doctorsSnapshot = await getDocs(doctorsQuery);

        if (doctorsSnapshot.empty) {
            console.log('[DAILY REMINDER] No doctors found.');
            return;
        }

        const doctors = doctorsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as any));

        // 2. Process each doctor
        for (const doctor of doctors) {
            const freeFollowUpDays = doctor.freeFollowUpDays;

            // Skip if not configured or too short (need at least 4 days to give a 3-day warning)
            if (!freeFollowUpDays || freeFollowUpDays <= 3) continue;

            // Calculate the target "Completed Date"
            // Formula: CompletedDate = Today - (freeFollowUpDays - 3)
            const daysAgo = freeFollowUpDays - 3;
            // Approximate days calculation using 24h * 60m
            const targetDate = subMinutes(new Date(), daysAgo * 24 * 60);
            const targetDateStr = getClinicISOString(targetDate);

            console.log(`[DAILY REMINDER] Dr. ${doctor.name}: Checking appointments from ${targetDateStr} (Free Days: ${freeFollowUpDays})`);

            // 3. Find eligible appointments
            const appointmentsQuery = query(
                collection(firestore, 'appointments'),
                where('doctor', '==', doctor.name),
                where('clinicId', '==', clinicId),
                where('date', '==', targetDateStr),
                where('status', '==', 'Completed')
            );

            const appointmentsSnapshot = await getDocs(appointmentsQuery);

            for (const appDoc of appointmentsSnapshot.docs) {
                const appointment = appDoc.data();

                // Check if already sent
                if (appointment.freeFollowUpNotificationSent) continue;

                console.log(`[DAILY REMINDER] Sending to patient ${appointment.patientId} for appointment ${appDoc.id}`);

                // Send Notification
                const success = await sendFreeFollowUpExpiryNotification({
                    firestore,
                    patientId: appointment.patientId,
                    doctorName: doctor.name,
                    clinicName: appointment.clinicName || 'The Clinic',
                    remainingDays: 3
                });

                if (success) {
                    // Mark as sent
                    await updateDoc(doc(firestore, 'appointments', appDoc.id), {
                        freeFollowUpNotificationSent: true
                    });
                }
            }
        }
        console.log('[DAILY REMINDER] Check complete.');

    } catch (error) {
        console.error('[DAILY REMINDER] Error:', error);
    }
}
