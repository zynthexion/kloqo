/**
 * Notification Service
 * Sends notifications to patients when appointments are created
 */

import { Firestore, doc, getDoc, collection, query, where, getDocs, updateDoc } from 'firebase/firestore';
import { parse, format, subMinutes, addMinutes, addDays } from 'date-fns';
import { parseTime } from '../utils/break-helpers';
import { getClinicTimeString, getClinicISOString, getClinicNow, getClinicDateString, parseClinicTime } from '../utils/date-utils';
import { compareAppointments } from './appointment-service';
import type { Appointment } from '@kloqo/shared-types';
import { MagicLinkService } from './magic-link-service';
import { generateAndTrackMarketingLink, generateMarketingSuffix } from './marketing-link-service';
import { WhatsAppSessionService } from './whatsapp-session-service';
import { isNotificationEnabled, NOTIFICATION_TYPES } from './notification-config';

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
        if (contentSid || contentVariables) {
            console.log(`[META-DEBUG] 🧩 Template: ${contentSid}`);
            console.log(`[META-DEBUG] 📝 Variables:`, JSON.stringify(contentVariables, null, 2));
        } else if (message) {
            console.log(`[META-DEBUG] 💬 Text: ${message}`);
        }

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
    firestore: Firestore; // Added for toggle check
}): Promise<boolean> {
    const { communicationPhone, patientName, doctorName, clinicName, date, time, arriveByTime, tokenNumber, appointmentId, showToken = true, magicToken, firestore } = params;

    try {
        // TOGGLE CHECK
        if (!await isNotificationEnabled(firestore, NOTIFICATION_TYPES.APPOINTMENT_BOOKED_BY_STAFF)) {
            console.log(`[WhatsApp] 🚫 Appointment booked/reminder notification is DISABLED. Skipping.`);
            return true;
        }

        // Meta Template Name
        const templateName = 'appointment_reminder_v2';

        let contentVariables: any = {};

        if (showToken) {
            const liveStatusRef = `whatsapp_confirmation`; // USER REQUESTED: Template 1 use whatsapp_confirmation

            const linkParams = await generateMarketingSuffix(firestore, {
                magicToken: magicToken || '',
                ref: liveStatusRef,
                campaign: 'appointment_booking',
                medium: 'notification',
                clinicId: (params as any).clinicId || '', // Assumed present in params or context
                phone: communicationPhone,
                appointmentId
            });
            const liveStatusLink = `${appointmentId}?${linkParams}`;

            contentVariables = {
                "1": patientName,
                "2": doctorName,
                "3": date,
                "4": tokenNumber || '--'
            };
            // console.log(`[WhatsApp] 📄 Using Meta Template (${templateName}) - Token: ${tokenNumber}`); // Redundant with META-DEBUG
        } else {
            const liveStatusRef = `whatsapp_confirmation_no_token`;
            const baseUrl = `${appointmentId}?ref=${liveStatusRef}`;
            const liveStatusLink = magicToken ? `${baseUrl}\u0026magicToken=${magicToken}` : baseUrl;

            contentVariables = {
                "1": patientName,
                "2": doctorName,
                "3": date,
                "4": '--' // No token
            };
            // console.log(`[WhatsApp] 📄 Using Meta Template (${templateName}) - No Token`); // Redundant with META-DEBUG
        }

        return sendWhatsAppMessage({
            to: communicationPhone,
            contentSid: templateName, // Using templateName as contentSid for the API route to handle
            contentVariables
        });
    } catch (error) {
        console.error('[WhatsApp] ❌ Error in confirmation notification:', error);
        return false;
    }
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
    tokenDistribution?: 'classic' | 'advanced';
    classicTokenNumber?: string | number; // UPDATED: Accept both string/number
    isWalkIn?: boolean; // NEW: Differentiates walk-in vs regular
}): Promise<boolean> {
    const { firestore, communicationPhone, patientName, tokenNumber, appointmentId, tokenDistribution, classicTokenNumber, isWalkIn = false } = params;
    console.log(`[Notification] 🔔 sendWhatsAppArrivalConfirmed called for ${patientName}`);

    try {
        // TOGGLE CHECK
        if (!await isNotificationEnabled(firestore, NOTIFICATION_TYPES.ARRIVAL_CONFIRMED)) {
            console.log(`[WhatsApp] 🚫 Arrival confirmed notification is DISABLED. Skipping.`);
            return true; // Return true as if handled
        }

        // Determine which token to display
        let displayToken: string = tokenNumber;
        if (tokenDistribution !== 'advanced') {
            // Safety: Never show 'A' tokens in classic mode
            displayToken = (classicTokenNumber && !String(classicTokenNumber).startsWith('A'))
                ? String(classicTokenNumber)
                : '--';
        }

        if (isWalkIn) {
            // WALK-IN: Window is CLOSED. Send PAID template with Quick Reply to open window.
            console.log(`[WhatsApp] 🚶 Walk-in Arrival: ${patientName}. Opening window with PAID template.`);

            const templateName = 'walkin_arrival_confirmed_malayalam';
            const textFallback = `നമസ്കാരം ${patientName},\n\nനിങ്ങളുടെ ടോക്കൺ ${displayToken} കൗണ്ടറിൽ രജിസ്റ്റർ ചെയ്തിട്ടുണ്ട്. ✅\n\nനിങ്ങളുടെ മുന്നിൽ എത്ര പേരുണ്ടെന്നും, ഡോക്ടറെ കാണാൻ എത്ര സമയം എടുക്കും എന്നും അറിയണോ? 🕒\n\nകൃത്യമായ സമയം ലഭിക്കാൻ താഴെ ക്ലിക്ക് ചെയ്യുക.`;

            return await sendWhatsAppMessage({
                to: communicationPhone,
                contentSid: templateName,
                contentVariables: {
                    "1": patientName,
                    "2": displayToken
                }
            });
        }

        // REGULAR: Window should be OPEN from reminder. Use Smart WhatsApp (FREE if open).
        console.log(`[WhatsApp] 📅 Regular Arrival: ${patientName}. Using Smart optimization.`);

        const token = await MagicLinkService.generateToken(firestore || (null as any), communicationPhone, `live-token/${appointmentId}`);
        const linkSuffix = await generateMarketingSuffix(firestore, {
            magicToken: token,
            ref: 'status_confirmed',
            campaign: 'appointment_reminder',
            medium: 'notification',
            clinicId: (params as any).clinicId || '',
            phone: communicationPhone,
            appointmentId
        });
        const malayalamTextFallback = `നമസ്കാരം ${patientName}, നിങ്ങളുടെ ടോക്കൺ ${displayToken} കൺഫേം ചെയ്തിട്ടുണ്ട്. ലൈവ് സ്റ്റാറ്റസ് അറിയാനായി താഴെ കാണുന്ന ലിങ്കിൽ ക്ലിക്ക് ചെയ്യുക:\n\nhttps://app.kloqo.com/live-token/${appointmentId}?${linkSuffix}`;

        return await sendSmartWhatsAppNotification({
            to: communicationPhone,
            templateName: 'appointment_status_confirmed_mlm',
            templateVariables: {
                "1": patientName,
                "2": displayToken,
                "3": `${appointmentId}?${linkSuffix}`
            },
            textFallback: malayalamTextFallback,
            skipIfClosed: true // Strategy: Only send if it's FREE (window open).
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
    firestore: Firestore; // Added for toggle check
}): Promise<boolean> {
    const { communicationPhone, patientName, magicToken, clinicId, firestore } = params;
    console.log(`[Notification] 🔔 sendWhatsAppAIFallback called for ${communicationPhone}`);

    try {
        // TOGGLE CHECK
        if (!await isNotificationEnabled(firestore, NOTIFICATION_TYPES.AI_FALLBACK)) {
            console.log(`[WhatsApp] 🚫 AI Fallback notification is DISABLED. Skipping.`);
            return true; // Return true as if handled
        }

        const linkSuffix = `?ref=ai_fallback&magicToken=${magicToken}`;
        // Patient app URL with attribution
        let patientAppBaseUrl = process.env.NEXT_PUBLIC_PATIENT_APP_URL || 'https://app.kloqo.com';

        // Construct full URL manually since we are using text
        const redirectPath = clinicId ? `/home?clinicId=${clinicId}` : '/home';
        const fullUrl = `${patientAppBaseUrl}${redirectPath}${linkSuffix}`;

        const messageText = `ക്ഷമിക്കണം, എനിക്ക് പണിത്തിരക്കാണ്. ദയവായി താഴെ കാണുന്ന ലിങ്കിൽ ക്ലിക്ക് ചെയ്ത് തുടരുക:\n\n${fullUrl}`;

        return sendSmartWhatsAppNotification({
            to: communicationPhone,
            textFallback: messageText,
            skipIfClosed: true // Only send if window is open (FREE text)
        });
    } catch (error) {
        console.error('[WhatsApp] ❌ Error in sendWhatsAppAIFallback:', error);
        return false;
    }
}

/**
 * Send WhatsApp booking link for pending appointments
 */
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
    firestore: Firestore; // Added for toggle check
}): Promise<boolean> {
    const { communicationPhone, patientName, clinicName, clinicCode, clinicId, magicToken, redirectPath, firestore } = params;
    console.log(`[Notification] 🔔 sendWhatsAppBookingLink called for ${communicationPhone}`);

    // TOGGLE CHECK
    if (!await isNotificationEnabled(firestore, NOTIFICATION_TYPES.BOOKING_LINK)) {
        console.log(`[WhatsApp] 🚫 Booking link notification is DISABLED. Skipping.`);
        return true; // Return true as if handled
    }

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
    console.log(`[Notification] 🔔 sendWhatsAppText called for ${to}`);
    return sendWhatsAppMessage({
        to,
        contentSid: 'text_message', // Special flag for text
        contentVariables: { text }
    });
}

/**
 * Smart WhatsApp Notification - Optimizes cost by checking 24h window
 * Sends free text if window is open, otherwise sends paid template or skips.
 */
export async function sendSmartWhatsAppNotification(params: {
    to: string;
    templateName?: string;
    templateVariables?: any;
    textFallback: string;
    alwaysSend?: boolean; // If true, send template even if window closed (e.g., Doctor In)
    skipIfClosed?: boolean; // If true, skip message if window closed (e.g., Review)
}): Promise<boolean> {
    const { to, templateName, templateVariables, textFallback, alwaysSend = false, skipIfClosed = false } = params;
    console.log(`[Notification] 🔔 sendSmartWhatsAppNotification called for ${to}`);

    try {
        // Check if 24h window is open
        const isWindowOpen = await WhatsAppSessionService.isWindowOpen(to);

        if (isWindowOpen) {
            // Window is open -> Send FREE text message
            console.log(`[WhatsApp Smart] 💚 Window OPEN for ${to}. Sending FREE text.`);
            console.log(`[META-DEBUG] 💬 Smart Free Text: ${textFallback}`);
            return sendWhatsAppText({ to, text: textFallback });
        } else {
            // Window is closed
            if (skipIfClosed) {
                console.log(`[WhatsApp Smart] ⏭️ Window CLOSED for ${to}. Skipping message (skipIfClosed=true).`);
                return false;
            }

            if (alwaysSend && templateName) {
                // Send template even if window closed (e.g., Doctor In - critical info)
                console.log(`[WhatsApp Smart] 📤 Window CLOSED for ${to}. Sending PAID template (${templateName}). Cost: ~12p`);
                console.log(`[META-DEBUG] 🧩 Smart Notification Template: ${templateName}`);
                console.log(`[META-DEBUG] 📝 Smart Notification Variables:`, JSON.stringify(templateVariables, null, 2));
                return sendWhatsAppMessage({
                    to,
                    contentSid: templateName,
                    contentVariables: templateVariables
                });
            }

            // Default: Skip if no template or not alwaysSend
            console.log(`[WhatsApp Smart] ⏭️ Window CLOSED for ${to}. No template provided or alwaysSend=false. Skipping.`);
            return false;
        }
    } catch (error) {
        console.error('[WhatsApp Smart] ❌ Error in sendSmartWhatsAppNotification:', error);
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
    console.log(`[Notification] 🔔 sendAppointmentBookedByStaffNotification called for ${appointmentId}. Distribution: ${tokenDistribution}, ClassicToken: ${classicTokenNumber}, Token: ${tokenNumber}`);

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

    const isClassic = tokenDistribution !== 'advanced';

    if (isClassic) {
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

    let pwaResult = true;
    if (await isNotificationEnabled(firestore, NOTIFICATION_TYPES.APPOINTMENT_BOOKED_BY_STAFF, 'pwa')) {
        pwaResult = await sendNotificationToPatient({
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
    } else {
        console.log(`[PWA] 🚫 Appointment booked notification is DISABLED. Skipping PWA.`);
    }

    // TOGGLE CHECK for WhatsApp
    if (communicationPhone && !await isNotificationEnabled(firestore, NOTIFICATION_TYPES.APPOINTMENT_BOOKED_BY_STAFF)) {
        console.log(`[WhatsApp] 🚫 Appointment booked by staff notification is DISABLED. Skipping WhatsApp.`);
        // Note: PWA notification still proceeds below
    } else if (communicationPhone) {
        // WhatsApp Split-Batch Logic:
        // 1. If appointment is for TODAY AND it is currently after 7 PM -> Send Immediately.
        // 2. Otherwise -> Skip (Will be caught by 5 PM / 7 AM batch reminders).
        const isAdvancedBooking = tokenNumber && tokenNumber.startsWith('A');
        if (isAdvancedBooking) {
            const now = getClinicNow();
            const currentHour = now.getHours();
            const todayStr = getClinicDateString(now);
            const tomorrow = addDays(now, 1);
            const tomorrowStr = getClinicDateString(tomorrow);

            const isAppointmentToday = date === todayStr;
            const isAppointmentTomorrow = date === tomorrowStr;

            // Condition for immediate sending:
            // 1. If for TODAY and booked after 7 AM (Missed the morning batch)
            // 2. If for TOMORROW and booked after 5 PM (Missed the evening batch)
            const shouldSendImmediately =
                (isAppointmentToday && currentHour >= 7) ||
                (isAppointmentTomorrow && currentHour >= 17);

            if (shouldSendImmediately) {
                let whatsappShowToken = true;
                if (tokenDistribution !== 'advanced') {
                    whatsappShowToken = !!classicTokenNumber && !String(classicTokenNumber).startsWith('A');
                }

                try {
                    console.log(`[Notification] 📱 Missed batch window detected (${date}, curr: ${currentHour}h). Sending WhatsApp immediately.`);
                    await sendWhatsAppAppointmentConfirmed({
                        communicationPhone: communicationPhone,
                        patientName: patientName || 'Patient',
                        doctorName,
                        clinicName,
                        date,
                        time: arriveByTime || time,
                        arriveByTime: displayTime,
                        tokenNumber: (tokenDistribution !== 'advanced')
                            ? (classicTokenNumber && !String(classicTokenNumber).startsWith('A') ? classicTokenNumber : '--')
                            : tokenNumber,
                        appointmentId,
                        showToken: whatsappShowToken,
                        firestore
                    });

                    // Mark as sent in Firestore
                    await updateDoc(doc(firestore, 'appointments', appointmentId), {
                        whatsappConfirmationSent: true
                    });
                } catch (error) {
                    console.error('[Notification] ❌ Failed to send WhatsApp notification:', error);
                }
            } else {
                console.log(`[Notification] ⏳ Appointment (${date}) outside immediate window (${currentHour}h). Scheduled for batch (5 PM / 7 AM).`);
            }
        } else {
            console.log(`[Notification] 👤 Non-advanced booking (Walk-in/Classic) - skipping staff booking WhatsApp (Wait for Arrival message).`);
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
    tokenDistribution?: 'classic' | 'advanced';
    classicTokenNumber?: string;
    communicationPhone?: string; // New: optional phone for WhatsApp
    patientName?: string; // New: for WhatsApp template
}): Promise<boolean> {
    const { firestore, patientId, appointmentId, clinicName, tokenNumber, doctorName, cancelledByBreak, tokenDistribution, classicTokenNumber, communicationPhone, patientName } = params;
    console.log(`[Notification] 🔔 sendTokenCalledNotification called for ${appointmentId}`);

    if (cancelledByBreak) {
        console.info(`[Notification] ℹ️ Skipping token called notification for appointment ${appointmentId} because it was affected by a break.`);
        return true;
    }

    // Determine which token to display for Classic vs Advanced
    let displayToken = tokenNumber;
    let showToken = true;

    if (tokenDistribution !== 'advanced') {
        // For Classic mode: Only show classicTokenNumber if it exists
        // Hide internal 'A' tokens (Advanced tokens) until patient is confirmed
        if (classicTokenNumber) {
            displayToken = classicTokenNumber;
            showToken = true;
        } else if (tokenNumber && (tokenNumber.startsWith('W') || /^\d+$/.test(tokenNumber))) {
            // Walk-in or numeric tokens are OK to show
            displayToken = tokenNumber;
            showToken = true;
        } else {
            // Internal 'A' token in Classic mode -> Hide it
            showToken = false;
        }
    } else {
        // Advanced mode: Always show the token
        showToken = !!tokenNumber;
        displayToken = tokenNumber;
    }

    // 1. PWA/Push Notification
    const pwaResult = await sendNotificationToPatient({
        firestore,
        patientId,
        title: 'Your Turn',
        body: `Your token has been called at ${clinicName}.${showToken ? ` Token: ${displayToken}` : ''}`,
        data: {
            type: 'token_called',
            appointmentId,
            clinicName,
            tokenNumber: displayToken, // Might be empty string
            doctorName,
        },
    });

    // 2. WhatsApp Notification
    if (communicationPhone) {
        // TOGGLE CHECK
        if (!await isNotificationEnabled(firestore, NOTIFICATION_TYPES.TOKEN_CALLED)) {
            console.log(`[WhatsApp] 🚫 Token called notification is DISABLED. Skipping.`);
        } else {
            console.log(`[Notification] 📱 Triggering Smart WhatsApp for Token Called: ${tokenNumber}`);

            const magicToken = await MagicLinkService.generateToken(firestore, communicationPhone, `live-token/${appointmentId}`);
            const linkSuffix = await generateMarketingSuffix(firestore, {
                magicToken,
                ref: 'token_called',
                campaign: 'token_updates',
                medium: 'notification',
                clinicId: (params as any).clinicId || '',
                phone: communicationPhone,
                appointmentId
            });
            const textFallback = `നമസ്കാരം ${patientName || 'Patient'}, ഡോ. ${doctorName} നിങ്ങളുടെ ടോക്കൺ (${tokenNumber}) വിളിച്ചിരിക്കുന്നു. ദയവായി കൺസൾട്ടേഷൻ റൂമിലേക്ക് വരിക. ലൈവ് സ്റ്റാറ്റസ്: https://app.kloqo.com/live-token/${appointmentId}?${linkSuffix}`;

            await sendSmartWhatsAppNotification({
                to: communicationPhone,
                templateName: 'token_called_quick_reply_ml',
                templateVariables: {
                    "1": patientName || 'Patient',
                    "2": tokenNumber,
                    "3": `${appointmentId}?${linkSuffix}`
                },
                textFallback,
                alwaysSend: true
            });
        }
    }

    return pwaResult;
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
    communicationPhone?: string; // New: optional phone for WhatsApp
    patientName?: string; // New: for WhatsApp template
}): Promise<boolean> {
    const { firestore, patientId, appointmentId, doctorName, clinicName, date, time, cancelledBy, arriveByTime, cancelledByBreak, communicationPhone, patientName } = params;
    console.log(`[Notification] 🔔 sendAppointmentCancelledNotification called for ${appointmentId}`);

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

    // 1. PWA/Push Notification
    let pwaResult = true;
    if (await isNotificationEnabled(firestore, NOTIFICATION_TYPES.APPOINTMENT_CANCELLED, 'pwa')) {
        pwaResult = await sendNotificationToPatient({
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
    } else {
        console.log(`[PWA] 🚫 Appointment cancelled notification is DISABLED. Skipping PWA.`);
    }

    // 2. WhatsApp Notification
    if (communicationPhone) {
        // TOGGLE CHECK
        if (!await isNotificationEnabled(firestore, NOTIFICATION_TYPES.APPOINTMENT_CANCELLED)) {
            console.log(`[WhatsApp] 🚫 Appointment cancelled notification is DISABLED. Skipping.`);
        } else {
            try {
                console.log(`[Notification] 📱 Triggering Smart WhatsApp for Appointment Cancelled: ${appointmentId}`);

                const textFallback = cancelledBy === 'patient'
                    ? `നമസ്കാരം ${patientName || 'Patient'}, ഡോ. ${doctorName} മായി ${date} ${displayTime} ന് ഉണ്ടായിരുന്ന നിങ്ങളുടെ അപ്പോയിന്റ്മെന്റ് റദ്ദാക്കിയിട്ടുണ്ട്.`
                    : `നമസ്കാരം ${patientName || 'Patient'}, ${clinicName}-ൽ ഡോ. ${doctorName} മായി ${date} ${displayTime} ന് ഉണ്ടായിരുന്ന നിങ്ങളുടെ അപ്പോയിന്റ്മെന്റ് റദ്ദാക്കിയിട്ടുണ്ട്.`;

                await sendSmartWhatsAppNotification({
                    to: communicationPhone,
                    templateName: 'appointment_cancelled_ml',
                    templateVariables: {
                        "1": patientName || 'Patient',
                        "2": doctorName,
                        "3": date,
                        "4": displayTime,
                        "5": clinicName
                    },
                    textFallback,
                    alwaysSend: true // Critical info, send paid template if window closed
                });
            } catch (error) {
                console.error('[Notification] ❌ Failed to send Smart WhatsApp (Appointment Cancelled):', error);
            }
        }
    }

    return pwaResult;
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
    communicationPhone?: string; // New: optional phone for WhatsApp
    patientName?: string; // New: for WhatsApp template
}): Promise<boolean> {
    const { firestore, patientId, appointmentId, doctorName, clinicName, delayMinutes, cancelledByBreak, communicationPhone, patientName } = params;
    console.log(`[Notification] 🔔 sendDoctorRunningLateNotification called for ${appointmentId}`);

    if (cancelledByBreak) {
        console.info(`[Notification] ℹ️ Skipping doctor late notification for appointment ${appointmentId} because it was affected by a break.`);
        return true;
    }

    // 1. PWA/Push Notification
    let pwaResult = true;
    if (await isNotificationEnabled(firestore, NOTIFICATION_TYPES.DOCTOR_RUNNING_LATE, 'pwa')) {
        pwaResult = await sendNotificationToPatient({
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
    } else {
        console.log(`[PWA] 🚫 Doctor running late notification is DISABLED. Skipping PWA.`);
    }

    // 2. WhatsApp Notification
    if (communicationPhone) {
        // TOGGLE CHECK
        if (!await isNotificationEnabled(firestore, NOTIFICATION_TYPES.DOCTOR_RUNNING_LATE)) {
            console.log(`[WhatsApp] 🚫 Doctor running late notification is DISABLED. Skipping.`);
        } else {
            try {
                console.log(`[Notification] 📱 Triggering Smart WhatsApp for Doctor Running Late: ${doctorName}`);

                const textFallback = `നമസ്കാരം ${patientName || 'Patient'}, ${clinicName}-ൽ ഡോ. ${doctorName} ഏകദേശം ${delayMinutes} മിനിറ്റ് വൈകിയാണ് കൺസൾട്ടേഷൻ ആരംഭിക്കുന്നത്.`;

                await sendSmartWhatsAppNotification({
                    to: communicationPhone,
                    templateName: 'doctor_running_late_ml',
                    templateVariables: {
                        "1": patientName || 'Patient',
                        "2": doctorName,
                        "3": clinicName,
                        "4": delayMinutes
                    },
                    textFallback,
                    alwaysSend: true // Critical info, send paid template if window closed
                });
            } catch (error) {
                console.error('[Notification] ❌ Failed to send Smart WhatsApp (Doctor Running Late):', error);
            }
        }
    }

    return pwaResult;
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
    communicationPhone?: string; // New: optional phone for WhatsApp
    patientName?: string; // New: for WhatsApp template
}): Promise<boolean> {
    const { firestore, patientId, appointmentId, doctorName, clinicName, oldTime, newTime, oldDate, newDate, reason, oldArriveByTime, newArriveByTime, cancelledByBreak, communicationPhone, patientName } = params;
    console.log(`[Notification] 🔔 sendBreakUpdateNotification called for ${appointmentId}`);

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

    // 1. PWA/Push Notification
    let pwaResult = true;
    if (await isNotificationEnabled(firestore, NOTIFICATION_TYPES.BREAK_UPDATE, 'pwa')) {
        pwaResult = await sendNotificationToPatient({
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
    } else {
        console.log(`[PWA] 🚫 Break update notification is DISABLED. Skipping PWA.`);
    }

    // 2. WhatsApp Notification
    if (communicationPhone) {
        // TOGGLE CHECK
        if (!await isNotificationEnabled(firestore, NOTIFICATION_TYPES.BREAK_UPDATE)) {
            console.log(`[WhatsApp] 🚫 Break update notification is DISABLED. Skipping.`);
        } else {
            try {
                const textFallback = `നമസ്കാരം ${patientName || 'Patient'}, ${clinicName}-ൽ ഡോ. ${doctorName} ഇപ്പോൾ ഒരു ചെറിയ ബ്രേക്കിലാണ്. നിങ്ങളുടെ ടോക്കൺ സമയം അല്പം മാറിയിട്ടുണ്ട്. അസൗകര്യത്തിൽ ഖേദിക്കുന്നു.`;

                await sendSmartWhatsAppNotification({
                    to: communicationPhone,
                    templateName: 'doctor_break_update_ml',
                    templateVariables: {
                        "1": patientName || 'Patient',
                        "2": doctorName,
                        "3": clinicName
                    },
                    textFallback,
                    alwaysSend: true
                });
            } catch (error) {
                console.error('[WhatsApp] ❌ Error in break notification:', error);
            }
        }
    }

    return pwaResult;
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
    communicationPhone?: string; // New: optional phone for WhatsApp
    patientName?: string; // New: for WhatsApp template
}): Promise<boolean> {
    const { firestore, patientId, appointmentId, doctorName, clinicName, date, time, tokenNumber, cancelledByBreak, communicationPhone, patientName } = params;
    console.log(`[Notification] 🔔 sendAppointmentSkippedNotification called for ${appointmentId}`);

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

    // 1. PWA/Push Notification
    let pwaResult = true;
    if (await isNotificationEnabled(firestore, NOTIFICATION_TYPES.APPOINTMENT_SKIPPED, 'pwa')) {
        pwaResult = await sendNotificationToPatient({
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
    } else {
        console.log(`[PWA] 🚫 Appointment skipped notification is DISABLED. Skipping PWA.`);
    }

    // 2. WhatsApp Notification
    if (communicationPhone) {
        // TOGGLE CHECK
        if (!await isNotificationEnabled(firestore, NOTIFICATION_TYPES.APPOINTMENT_SKIPPED)) {
            console.log(`[WhatsApp] 🚫 Appointment skipped notification is DISABLED. Skipping.`);
        } else {
            try {
                console.log(`[Notification] 📱 Triggering Smart WhatsApp for Appointment Skipped: ${appointmentId}`);

                const textFallback = `നമസ്കാരം ${patientName || 'Patient'}, ഡോ. ${doctorName} മായി ${date} ${displayTime} ന് ഉണ്ടായിരുന്ന നിങ്ങളുടെ അപ്പോയിന്റ്മെന്റ് (ടോക്കൺ: ${tokenNumber}) ഒഴിവാക്കിയിട്ടുണ്ട്. അപ്പോയിന്റ്മെന്റ് സമയത്തിന് 5 മിനിറ്റ് മുൻപ് നിങ്ങൾ എത്തിച്ചേരാത്തതിനാലാണിത്.`;

                await sendSmartWhatsAppNotification({
                    to: communicationPhone,
                    templateName: 'appointment_skipped_ml',
                    templateVariables: {
                        "1": patientName || 'Patient',
                        "2": doctorName,
                        "3": date,
                        "4": displayTime,
                        "5": tokenNumber
                    },
                    textFallback,
                    alwaysSend: true // Critical info, send paid template if window closed
                });
            } catch (error) {
                console.error('[Notification] ❌ Failed to send Smart WhatsApp (Appointment Skipped):', error);
            }
        }
    }

    return pwaResult;
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
    communicationPhone?: string; // New: optional phone for WhatsApp
    patientName?: string; // New: for WhatsApp template
} | any): Promise<boolean> {
    const { firestore, patientId, appointmentId, clinicName, tokenNumber, doctorName, peopleAhead, appointmentTime, appointmentDate, cancelledByBreak, breakDuration, tokenDistribution, averageConsultingTime, communicationPhone, patientName } = params;
    console.log(`[Notification] 🔔 sendPeopleAheadNotification called for ${appointmentId}`);

    if (cancelledByBreak) {
        console.info(`[Notification] ℹ️ Skipping people ahead notification for appointment ${appointmentId} because it was cancelled by a break.`);
        return true;
    }

    // For Advanced: (arriveByTime - 15 minutes)
    // For Classic: (CurrentTime + (peopleAhead * averageConsultingTime))
    let displayTime = appointmentTime;
    const isClassic = tokenDistribution !== 'advanced';

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

    // 1. PWA/Push Notification
    let pwaResult = true;
    if (await isNotificationEnabled(firestore, NOTIFICATION_TYPES.PEOPLE_AHEAD, 'pwa')) {
        pwaResult = await sendNotificationToPatient({
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
    } else {
        console.log(`[PWA] 🚫 People ahead notification is DISABLED. Skipping PWA.`);
    }

    // 2. WhatsApp Notification
    if (communicationPhone) {
        // TOGGLE CHECK
        if (!await isNotificationEnabled(firestore, NOTIFICATION_TYPES.PEOPLE_AHEAD)) {
            console.log(`[WhatsApp] 🚫 People ahead notification is DISABLED. Skipping.`);
        } else {
            try {
                console.log(`[Notification] 📱 Triggering Smart WhatsApp for People Ahead: ${peopleAhead}`);

                let whatsappTextFallback = '';
                let whatsappTemplateName = '';
                let whatsappTemplateVariables: any = {};

                if (peopleAhead === 0) {
                    whatsappTemplateName = 'you_are_next_ml';
                    whatsappTemplateVariables = {
                        "1": patientName || 'Patient',
                        "2": doctorName,
                        "3": clinicName,
                        "4": tokenNumber || ''
                    };
                    whatsappTextFallback = `നമസ്കാരം ${patientName || 'Patient'}, നിങ്ങൾ അടുത്തതായി ഡോ. ${doctorName} നെ കാണും. ${clinicName}-ൽ നിങ്ങളുടെ ടോക്കൺ: ${tokenNumber || ''}`;
                    if (breakDuration && breakDuration > 0) {
                        whatsappTextFallback = `നമസ്കാരം ${patientName || 'Patient'}, ഡോക്ടർ ${breakDuration} മിനിറ്റ് ബ്രേക്കിലാണ്. ബ്രേക്കിന് ശേഷം നിങ്ങൾ അടുത്തതായി ഡോ. ${doctorName} നെ കാണും. ${clinicName}-ൽ നിങ്ങളുടെ ടോക്കൺ: ${tokenNumber || ''}`;
                    }
                } else {
                    whatsappTemplateName = 'queue_update_ml';
                    whatsappTemplateVariables = {
                        "1": patientName || 'Patient',
                        "2": peopleAheadText,
                        "3": doctorName,
                        "4": clinicName,
                        "5": tokenNumber || ''
                    };
                    whatsappTextFallback = `നമസ്കാരം ${patientName || 'Patient'}, നിങ്ങൾക്ക് മുന്നിൽ ${peopleAheadText} ഉണ്ട്. നിങ്ങൾ അടുത്തതായി ഡോ. ${doctorName} നെ കാണും. ${clinicName}-ൽ നിങ്ങളുടെ ടോക്കൺ: ${tokenNumber || ''}`;
                    if (breakDuration && breakDuration > 0) {
                        whatsappTextFallback = `നമസ്കാരം ${patientName || 'Patient'}, നിങ്ങൾക്ക് മുന്നിൽ ${peopleAheadText} ഉണ്ട്. ഡോക്ടർ ${breakDuration} മിനിറ്റ് ബ്രേക്കിലാണ്. നിങ്ങൾ അടുത്തതായി ഡോ. ${doctorName} നെ കാണും. ${clinicName}-ൽ നിങ്ങളുടെ ടോക്കൺ: ${tokenNumber || ''}`;
                    }
                }

                await sendSmartWhatsAppNotification({
                    to: communicationPhone,
                    templateName: whatsappTemplateName,
                    templateVariables: whatsappTemplateVariables,
                    textFallback: whatsappTextFallback,
                    alwaysSend: true // Critical info, send paid template if window closed
                });
            } catch (error) {
                console.error('[Notification] ❌ Failed to send Smart WhatsApp (People Ahead):', error);
            }
        }
    }

    return pwaResult;
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
    communicationPhone?: string; // New: optional phone for WhatsApp
    patientName?: string; // New: for WhatsApp template
} | any): Promise<boolean> {
    const { firestore, patientId, appointmentId, clinicName, tokenNumber, doctorName, appointmentTime, appointmentDate, arriveByTime, cancelledByBreak, tokenDistribution, averageConsultingTime, peopleAhead, communicationPhone, patientName } = params;
    console.log(`[Notification] 🔔 sendDoctorConsultationStartedNotification called for ${appointmentId}`);

    if (cancelledByBreak) {
        console.info(`[Notification] ℹ️ Skipping consultation started notification for appointment ${appointmentId} because it was affected by a break.`);
        return true;
    }

    // For Advanced: (arriveByTime - 15 minutes if available, otherwise appointmentTime - 15)
    // For Classic: (CurrentTime + (peopleAhead * averageConsultingTime))
    let displayTime = appointmentTime;
    const isClassic = tokenDistribution !== 'advanced';

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

    // 1. PWA/Push Notification
    let pwaResult = true;
    if (await isNotificationEnabled(firestore, NOTIFICATION_TYPES.DOCTOR_CONSULTATION_STARTED, 'pwa')) {
        pwaResult = await sendNotificationToPatient({
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
    } else {
        console.log(`[PWA] 🚫 Consultation started notification is DISABLED. Skipping PWA.`);
    }

    // 2. WhatsApp Notification
    if (communicationPhone) {
        // TOGGLE CHECK
        if (!await isNotificationEnabled(firestore, NOTIFICATION_TYPES.DOCTOR_CONSULTATION_STARTED)) {
            console.log(`[WhatsApp] 🚫 Consultation started notification is DISABLED. Skipping.`);
        } else {
            try {
                console.log(`[Notification] 📱 Triggering Smart WhatsApp for Consultation Started: ${doctorName} (Using ${!!tokenNumber && tokenNumber !== 'N/A' ? 'Token' : 'Pending'} Template)`);

                // Generate Magic Link for auto-login
                const magicToken = await MagicLinkService.generateToken(firestore, communicationPhone, `live-token/${appointmentId}`);

                const hasToken = !!tokenNumber && tokenNumber !== 'N/A' && tokenNumber !== '';
                const templateName = hasToken ? 'doctor_consultation_started_ml' : 'doctor_in_pending_ml';
                const ref = hasToken ? 'consultation_started' : 'doctor_in_pending';

                const linkParams = await generateMarketingSuffix(firestore, {
                    magicToken,
                    ref,
                    campaign: 'consultation_updates',
                    medium: 'notification',
                    clinicId: (params as any).clinicId || '',
                    phone: communicationPhone,
                    appointmentId
                });
                const linkSuffix = `${appointmentId}?${linkParams}`;

                const textFallback = hasToken
                    ? `നമസ്കാരം ${patientName || 'Patient'},\n\nഡോക്ടർ ${doctorName} കൺസൾട്ടേഷൻ ആരംഭിച്ചു. 🟢\n\nനിങ്ങളുടെ ടോക്കൺ നമ്പർ: ${tokenNumber}\n\nനിങ്ങളുടെ മുൻപിൽ എത്ര പേര് ഉണ്ട് എന്ന് അറിയാനും , എത്ര നേരം കാത്തിരിക്കണം എന്നും അറിയാനായി താഴെ ക്ലിക്ക് ചെയ്ത് സ്റ്റാറ്റസ് പരിശോധിക്കുക:\n\nhttps://app.kloqo.com/live-token/${linkSuffix}`
                    : `നമസ്കാരം ${patientName || 'Patient'}, ഡോ. ${doctorName} ഇപ്പോൾ ക്ലിനിക്കിൽ കൺസൾട്ടേഷൻ ആരംഭിച്ചിട്ടുണ്ട്. നിങ്ങളുടെ ഊഴം എപ്പോൾ വരുമെന്ന് അറിയാനും തത്സമയ അപ്ഡേറ്റുകൾ ലഭിക്കാനും താഴെ കാണുന്ന ലിങ്കിൽ ലോഗിൻ ചെയ്യുക:\n\nhttps://app.kloqo.com/live-token/${linkSuffix}`;

                const templateVariables = hasToken
                    ? {
                        "1": patientName || 'Patient',
                        "2": doctorName,
                        "3": tokenNumber,
                        "4": linkSuffix
                    }
                    : {
                        "1": patientName || 'Patient',
                        "2": doctorName,
                        "3": clinicName,
                        "4": linkSuffix
                    };

                await sendSmartWhatsAppNotification({
                    to: communicationPhone,
                    templateName,
                    templateVariables,
                    textFallback,
                    alwaysSend: true // Critical info, send paid template if window closed
                });
            } catch (error) {
                console.error('[Notification] ❌ Failed to send Smart WhatsApp (Consultation Started):', error);
            }
        }
    }

    return pwaResult;
}

/**
 * Send notification when patient is checked out/consultation completed
 */
export async function sendPatientCheckoutNotification(params: {
    firestore: Firestore;
    patientId: string;
    appointmentId: string;
    doctorName: string;
    clinicName: string;
}): Promise<boolean> {
    const { firestore, patientId, appointmentId, doctorName, clinicName } = params;
    console.log(`[Notification] 🔔 sendPatientCheckoutNotification called for ${appointmentId}`);

    if (!await isNotificationEnabled(firestore, NOTIFICATION_TYPES.CONSULTATION_COMPLETED, 'pwa')) {
        console.log(`[PWA] 🚫 Consultation completed notification is DISABLED. Skipping PWA.`);
        return true;
    }

    return sendNotificationToPatient({
        firestore,
        patientId,
        title: 'Consultation Completed',
        body: `Thank you for visiting ${clinicName}. Your consultation with Dr. ${doctorName} is complete.`,
        data: {
            type: 'consultation_completed',
            appointmentId,
            doctorName,
            clinicName,
        },
    });
}

/**
 * Send daily reminder for appointments
 */
export async function sendDailyReminderNotification(params: {
    firestore: Firestore;
    patientId: string;
    appointmentId: string;
    doctorName: string;
    clinicName: string;
    date: string;
    time: string;
    arriveByTime?: string;
}): Promise<boolean> {
    const { firestore, patientId, appointmentId, doctorName, clinicName, date, time, arriveByTime } = params;
    console.log(`[Notification] 🔔 sendDailyReminderNotification called for ${appointmentId}`);

    // Always display user time based on arriveByTime - 15 minutes (or time - 15 if arriveByTime missing)
    let displayTime = time;
    try {
        const appointmentDate = parse(date, 'd MMMM yyyy', new Date());
        const baseTime = parseTime(arriveByTime || time, appointmentDate);
        const shownTime = subMinutes(baseTime, 15);
        displayTime = getClinicTimeString(shownTime);
    } catch (error) {
        console.error('Error calculating displayTime for daily reminder notification:', error);
    }

    if (!await isNotificationEnabled(firestore, NOTIFICATION_TYPES.DAILY_REMINDER, 'pwa')) {
        console.log(`[PWA] 🚫 Daily reminder notification is DISABLED. Skipping PWA.`);
        return true;
    }

    return sendNotificationToPatient({
        firestore,
        patientId,
        title: 'Appointment Reminder',
        body: `Reminder: You have an appointment with Dr. ${doctorName} today, ${date} at ${displayTime}.`,
        data: {
            type: 'appointment_reminder',
            appointmentId,
            doctorName,
            clinicName,
            date,
            time,
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
    console.log(`[Notification] 🔔 notifySessionPatientsOfConsultationStart called for clinic ${clinicId}, doctor ${doctorName}, date ${date}, session ${sessionIndex}`);
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
        console.log(`[Notification] No appointments found for consultation start notification for clinic ${clinicId}, doctor ${doctorName}, date ${date}, session ${sessionIndex}`);
        return;
    }

    const { compareAppointments, compareAppointmentsClassic } = await import('./appointment-service');
    const sortedAppointments = appointmentsSnapshot.docs
        .map(doc => ({ id: doc.id, ...doc.data() } as Appointment))
        .sort(tokenDistribution !== 'advanced' ? compareAppointmentsClassic : compareAppointments);

    await Promise.all(
        sortedAppointments.map(async (appointment, index) => {
            if (!appointment.patientId) return;

            try {
                await sendDoctorConsultationStartedNotification({
                    firestore,
                    patientId: appointment.patientId,
                    appointmentId: appointment.id,
                    clinicName,
                    tokenNumber: (tokenDistribution !== 'advanced' && appointment.classicTokenNumber) ? appointment.classicTokenNumber : (tokenDistribution !== 'advanced' ? '' : (appointment.tokenNumber || 'N/A')),
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
    console.log(`[Notification] 🔔 notifyNextPatientsWhenCompleted called for completed appointment ${completedAppointmentId}`);

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
        const sortedAppointments = allAppointments.sort(tokenDistribution !== 'advanced' ? compareAppointmentsClassic : compareAppointments);

        // Get appointments that come after the completed one
        const nextAppointments = sortedAppointments.filter(apt => {
            const comparison = tokenDistribution !== 'advanced'
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
                    tokenNumber: (tokenDistribution !== 'advanced' && appointment.classicTokenNumber) ? appointment.classicTokenNumber : (tokenDistribution !== 'advanced' ? '' : appointment.tokenNumber),
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
    console.log(`[Notification] 🔔 sendFreeFollowUpExpiryNotification called for patient ${patientId}`);

    if (!await isNotificationEnabled(firestore, NOTIFICATION_TYPES.FREE_FOLLOWUP_EXPIRY, 'pwa')) {
        console.log(`[PWA] 🚫 Follow-up expiry notification is DISABLED. Skipping PWA.`);
        return true;
    }

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

        // 4. Also process WhatsApp Batch Reminders (5 PM / 7 AM)
        await processWhatsAppBatchReminders({ firestore, clinicId });

    } catch (error) {
        console.error('[DAILY REMINDER] Error:', error);
    }
}

/**
 * Process WhatsApp Batch Reminders (5 PM Day-Before / 7 AM Same-Day)
 */
export async function processWhatsAppBatchReminders(params: {
    firestore: Firestore;
    clinicId: string;
}): Promise<void> {
    const { firestore, clinicId } = params;
    const now = getClinicNow();
    const currentHour = now.getHours();
    const todayStr = getClinicDateString(now);

    // Determine batch type based on hour
    // Batch 1: 5 PM - 7 PM (Day-before reminders for tomorrow)
    // Batch 2: 7 AM - 9 AM (Same-day reminders for today)
    let batchType: '5PM' | '7AM' | null = null;
    let targetDateStr: string;

    if (currentHour >= 17 && currentHour < 19) {
        batchType = '5PM';
        const tomorrow = addMinutes(now, 24 * 60);
        targetDateStr = getClinicDateString(tomorrow);
    } else if (currentHour >= 7 && currentHour < 9) {
        batchType = '7AM';
        targetDateStr = todayStr;
    } else {
        console.log(`[WhatsApp Batch] ⏳ Current time (${currentHour}h) is outside batch windows (7-9 AM, 5-7 PM).`);
        return;
    }

    console.log(`[WhatsApp Batch] 🚀 Starting ${batchType} batch for clinic ${clinicId} (Appointments on ${targetDateStr})`);

    try {
        // Query appointments for the target date that haven't received this specific reminder
        const trackingField = batchType === '5PM' ? 'whatsappReminder5PMSent' : 'whatsappReminder7AMSent';

        const q = query(
            collection(firestore, 'appointments'),
            where('clinicId', '==', clinicId),
            where('date', '==', targetDateStr),
            where('status', 'in', ['Pending', 'Confirmed']),
            where(trackingField, '!=', true)
        );

        const snapshot = await getDocs(q);
        if (snapshot.empty) {
            console.log(`[WhatsApp Batch] No pending appointments found for ${batchType} batch.`);
            return;
        }

        // Get Clinic details for Magic Link logic
        const clinicDoc = await getDoc(doc(firestore, 'clinics', clinicId));
        const clinicData = clinicDoc.exists() ? clinicDoc.data() : {};
        const clinicName = clinicData.name || 'The Clinic';
        const tokenDistribution = clinicData.tokenDistribution || 'advanced';

        for (const appDoc of snapshot.docs) {
            const appointment = { id: appDoc.id, ...appDoc.data() } as Appointment;

            // Skip if already confirmed immediately (for same-day evening bookings)
            if (batchType === '7AM' && appointment.whatsappConfirmationSent) {
                console.log(`[WhatsApp Batch] Skipping ${appointment.id} - already sent immediate confirmation.`);
                continue;
            }

            // Variable Mapping
            // 1: Patient, 2: Doctor, 3: Clinic, 4: Date, 5: Token, 6: ArriveBy, 7: Link
            // Calculate display reporting time (15m before arriveBy or time)
            let displayTime = appointment.time;
            try {
                const appointmentDate = parse(appointment.date, 'd MMMM yyyy', new Date());
                const baseTime = parseClinicTime(appointment.arriveByTime || appointment.time, appointmentDate);
                displayTime = getClinicTimeString(subMinutes(baseTime, 15));
            } catch (e) {
                console.error('Error parsing time for batch reminder:', e);
            }

            const tokenToDisplay = (tokenDistribution !== 'advanced' && appointment.classicTokenNumber)
                ? String(appointment.classicTokenNumber)
                : (tokenDistribution !== 'advanced' ? '--' : (appointment.tokenNumber || '--'));

            try {
                console.log(`[WhatsApp Batch] Sending ${batchType} reminder to ${appointment.patientName} (${appointment.id})`);
                await sendWhatsAppAppointmentConfirmed({
                    communicationPhone: appointment.communicationPhone,
                    patientName: appointment.patientName,
                    doctorName: appointment.doctor,
                    clinicName,
                    date: appointment.date,
                    time: appointment.arriveByTime || appointment.time,
                    arriveByTime: displayTime,
                    tokenNumber: tokenToDisplay,
                    appointmentId: appointment.id,
                    showToken: tokenDistribution === 'advanced' || !!appointment.classicTokenNumber,
                    firestore
                });

                // Update tracking fields
                await updateDoc(doc(firestore, 'appointments', appDoc.id), {
                    [trackingField]: true,
                    whatsappConfirmationSent: true // Mark as confirmed overall so we don't send again
                });
            } catch (error) {
                console.error(`[WhatsApp Batch] ❌ Failed to send for app ${appointment.id}:`, error);
            }
        }

    } catch (error) {
        console.error('[WhatsApp Batch] ❌ Error processing batch:', error);
    }
}
