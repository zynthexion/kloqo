

import { NextRequest, NextResponse } from 'next/server';
import {
    CodeService,
    sendWhatsAppText,
    WhatsAppSessionService,
    computeQueues,
    getClinicDateString,
    getClinicTimeString,
    getClinicNow,
    getPatientByPhone,
    getRelativesByPatientId,
    GlobalSearchService,
    MagicLinkService,
    sendWhatsAppAIFallback,
    sendSmartWhatsAppNotification,
} from '@kloqo/shared-core';
import { getFirebaseAdmin } from '../../../../../../../packages/shared-core/src/utils/firebase-admin';
import { MagicLinkAdminService } from '../../../../../../../packages/shared-core/src/services/magic-link-admin-service';
import { AIService, AI_ERROR_BUSY } from '../../../../../../../packages/shared-core/src/services/ai-service';
import { collection, query, where, getDocs, doc, getDoc, Timestamp, getFirestore, setDoc, serverTimestamp, runTransaction } from 'firebase/firestore';
import {
    getClinicISOString,
    parseClinicDate,
    loadDoctorAndSlots,
    generateNextTokenAndReserveSlot,
    managePatient,
    sendAppointmentBookedByStaffNotification,
    sendWhatsAppAppointmentConfirmed,
    sendWhatsAppBookingLink
} from '@kloqo/shared-core';
import { isSameDay, isBefore, addMinutes, subMinutes, format as dateFnsFormat } from 'date-fns';

const VERIFY_TOKEN = 'kloqo-whatsapp-webhook-verify-token';

export async function GET(request: NextRequest) {
    const searchParams = request.nextUrl.searchParams;
    const mode = searchParams.get('hub.mode');
    const token = searchParams.get('hub.verify_token');
    const challenge = searchParams.get('hub.challenge');

    if (mode && token) {
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            console.log('WEBHOOK_VERIFIED');
            return new NextResponse(challenge, { status: 200 });
        } else {
            return new NextResponse('Forbidden', { status: 403 });
        }
    }
    return new NextResponse('Bad Request', { status: 400 });
}

export async function POST(request: NextRequest) {
    const adminApp = getFirebaseAdmin();
    const adminDb = adminApp.firestore();
    const db = getFirestore();
    try {
        const body = await request.json();
        console.log('[WhatsApp Webhook] Received:', JSON.stringify(body, null, 2));

        if (body.object) {
            if (
                body.entry &&
                body.entry[0].changes &&
                body.entry[0].changes[0] &&
                body.entry[0].changes[0].value.messages &&
                body.entry[0].changes[0].value.messages[0]
            ) {
                const message = body.entry[0].changes[0].value.messages[0];
                const from = message.from;
                const messageBody = message.text?.body;

                // 228: Retrieve session early for logging and context
                const session = from ? await WhatsAppSessionService.getSession(from) : null;

                if (from) {
                    // CRITICAL: Update last message timestamp for 24h window tracking for ALL messages (text or button)
                    // 228: Pass clinicId to ensure document structure is complete
                    await WhatsAppSessionService.updateLastUserMessage(from, session?.clinicId);
                    console.log(`[WhatsApp Webhook] ✅ Updated lastMessageAt and structure for ${from}`);
                }

                if (messageBody) {
                    console.log(`[WhatsApp Webhook] Message from ${from}: ${messageBody}`);

                    // 0. Lookup Patient Identity
                    const patient = await getPatientByPhone(from);
                    const patientName = patient?.name;
                    const greetingBase = patientName ? `നമസ്കാരം ${patientName}! ` : "നമസ്കാരം! ";

                    // 0a. ONE-TIME Tutorial Video Send (first reply ever)
                    if (patient?.id && !patient?.tutorialVideoSentAt) {
                        try {
                            const mediaConfigSnap = await adminDb.collection('system-config').doc('whatsapp_media').get();
                            const mediaId = mediaConfigSnap.data()?.tutorialVideoMediaId;

                            if (mediaId) {
                                const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID!;
                                const accessToken = process.env.WHATSAPP_ACCESS_TOKEN!;
                                const { WhatsAppService } = await import('@kloqo/shared-core');
                                const whatsappService = new WhatsAppService(phoneNumberId, accessToken);

                                // Send the tutorial video
                                await whatsappService.sendVideoMessage(from, mediaId);
                                console.log(`[WhatsApp Webhook] 🎬 Tutorial video sent to ${from}`);

                                // Send magic link (plain text) for marketing tracking
                                const { generateMarketingSuffix, MagicLinkService, sendWhatsAppText } = await import('@kloqo/shared-core');
                                const magicToken = await MagicLinkService.generateToken(adminDb as any, from, 'live-token');
                                const linkSuffix = await generateMarketingSuffix(db as any, {
                                    magicToken,
                                    ref: 'tutorial_sent',
                                    campaign: 'onboarding',
                                    medium: 'whatsapp',
                                    clinicId: session?.clinicId || '',
                                    phone: from,
                                    patientName: patientName || 'Unknown',
                                });
                                const magicLink = `https://app.kloqo.com/live-token?${linkSuffix}`;
                                await sendWhatsAppText({ to: from, text: magicLink });

                                // Mark as sent — never send again
                                await adminDb.collection('patients').doc(patient.id).update({
                                    tutorialVideoSentAt: new Date(),
                                });
                                console.log(`[WhatsApp Webhook] ✅ Tutorial video + link sent. Marked tutorialVideoSentAt on patient ${patient.id}`);
                            } else {
                                console.warn('[WhatsApp Webhook] ⚠️ No tutorialVideoMediaId in system-config/whatsapp_media. Skipping video send.');
                            }
                        } catch (videoError) {
                            console.error('[WhatsApp Webhook] ❌ Error sending tutorial video:', videoError);
                            // Non-fatal: continue handling the message normally
                        }
                    }

                    // 1. Check for Clinic Code (KQ-XXXX)
                    const codeMatch = messageBody.match(/^KQ-?[A-Z0-9]{4}$/i);
                    if (codeMatch) {
                        try {
                            const code = codeMatch[0];
                            const clinic = await CodeService.getClinicByCode(code);

                            if (clinic) {
                                // Persist session
                                await WhatsAppSessionService.updateSession(from, clinic.id);

                                // Log voucher engagement for marketing tracking
                                try {
                                    const engagementRef = doc(collection(db, 'marketing_engagement'));
                                    await setDoc(engagementRef, {
                                        source: 'voucher',
                                        clinicCode: code,
                                        clinicId: clinic.id,
                                        phone: from,
                                        patientName: patientName || 'Unknown',
                                        timestamp: serverTimestamp()
                                    });
                                    console.log(`[WhatsApp Webhook] 📊 Logged voucher engagement: ${code} for ${from}`);
                                } catch (engagementError) {
                                    console.error('[WhatsApp Webhook] Error logging voucher engagement:', engagementError);
                                }

                                await sendWhatsAppText({
                                    to: from,
                                    text: `${greetingBase}${clinic.name}-ലേക്ക് സ്വാഗതം! 👋\n\nവിവരങ്ങൾക്കായി താഴെ പറയുന്ന നമ്പറുകൾ ടൈപ്പ് ചെയ്യുക:\n1. ഡോക്ടറുടെ ലഭ്യത\n2. പ്രവർത്തന സമയം\n3. ക്യൂ നില\n4. അപ്പോയിന്റ്മെന്റ് ബുക്കിംഗ്`
                                });
                            } else {
                                await sendWhatsAppText({
                                    to: from,
                                    text: "ക്ഷമിക്കണം, ഈ കോഡിലുള്ള ഒരു ക്ലിനിക് കണ്ടെത്താനായില്ല. ദയവായി കോഡ് പരിശോധിക്കുക."
                                });
                            }
                        } catch (error) {
                            console.error('Error handling clinic code:', error);
                        }
                        return new NextResponse('EVENT_RECEIVED', { status: 200 });
                    }

                    // 1b. Check for Button Clicks / Interactive Messages
                    const buttonText = message.button?.text || message.interactive?.button_reply?.title;
                    const buttonPayload = message.button?.payload || message.interactive?.button_reply?.id;

                    if (buttonText || buttonPayload) {
                        try {
                            const interactionRef = doc(collection(db, 'marketing_interactions'));
                            await setDoc(interactionRef, {
                                phone: from,
                                buttonText: buttonText || buttonPayload,
                                timestamp: serverTimestamp(),
                                patientName: patientName || 'Unknown',
                                // Try to correlate with a session if possible
                                clinicId: session?.clinicId || null,
                            });
                            console.log(`[WhatsApp Webhook] 📊 Logged button interaction: ${buttonText || buttonPayload} from ${from}`);
                        } catch (interactionError) {
                            console.error('[WhatsApp Webhook] Error logging interaction:', interactionError);
                        }
                    }

                    if (buttonText === 'സമയം അറിയണം') {
                        console.log(`[WhatsApp Webhook] 🕒 Handle 'Know Time' button click for ${from}`);
                        const session = await WhatsAppSessionService.getSession(from);
                        const patient = await getPatientByPhone(from);

                        if (session?.clinicId && patient) {
                            try {
                                const clinicDoc = await getDoc(doc(db, 'clinics', session.clinicId));
                                const clinicData = clinicDoc.data();

                                // Find active appointment for today
                                const now = getClinicNow();
                                const today = getClinicDateString(now);
                                const appointmentsRef = collection(db, 'appointments');
                                const aQuery = query(
                                    appointmentsRef,
                                    where('patientId', '==', patient.id),
                                    where('clinicId', '==', session.clinicId),
                                    where('date', '==', today)
                                );
                                const aSnap = await getDocs(aQuery);

                                if (!aSnap.empty) {
                                    const appointment = aSnap.docs[0].data();
                                    const doctorName = appointment.doctor;

                                    // Get Queue Status
                                    const dQuery = query(collection(db, 'doctors'), where('clinicId', '==', session.clinicId), where('name', '==', doctorName));
                                    const dSnap = await getDocs(dQuery);
                                    let peopleAhead = 0;
                                    let estTime = appointment.time;

                                    if (!dSnap.empty) {
                                        const doctorDoc = dSnap.docs[0];
                                        const dData = doctorDoc.data();

                                        // Fetch all appointments for today to compute queue (Server Side)
                                        const adminApp = getFirebaseAdmin();
                                        const adminDb = adminApp.firestore();

                                        const allAptsQuery = query(appointmentsRef, where('clinicId', '==', session.clinicId), where('doctor', '==', doctorName), where('date', '==', today));
                                        const allAptsSnap = await getDocs(allAptsQuery);
                                        const allApts = allAptsSnap.docs.map(d => ({ id: d.id, ...d.data() } as any));

                                        const queueState = await computeQueues(allApts, doctorName, doctorDoc.id, session.clinicId, today, 0, dData.consultationStatus);

                                        // Find patient position
                                        const pos = queueState.arrivedQueue.findIndex((a: any) => a.id === aSnap.docs[0].id);
                                        peopleAhead = pos >= 0 ? pos : 0;
                                    }

                                    const magicToken = await MagicLinkAdminService.generateTokenAdmin(adminDb, from, `/live-token/${aSnap.docs[0].id}`);
                                    const linkSuffix = `${aSnap.docs[0].id}?ref=wa_button&token=${magicToken}`;

                                    const malayalamTextFallback = `നന്ദി. നിലവിൽ നിങ്ങളുടെ മുൻപിൽ ${peopleAhead} പേർ ഉണ്ട്. പ്രതീക്ഷിക്കുന്ന സമയം: ${estTime}.\n\nതത്സമയ വിവരങ്ങൾക്കായി താഴെ കാണുന്ന ലിങ്ക് ഉപയോഗിക്കുക:\n\nhttps://app.kloqo.com/live-token/${linkSuffix}`;

                                    await sendSmartWhatsAppNotification({
                                        to: from,
                                        templateName: 'appointment_status_confirmed_mlm',
                                        templateVariables: {
                                            "1": patient.name || 'Patient',
                                            "2": appointment.classicTokenNumber || appointment.tokenNumber,
                                            "3": linkSuffix
                                        },
                                        textFallback: malayalamTextFallback,
                                        alwaysSend: true // Session is open, but we use this for the premium button
                                    });
                                } else {
                                    await sendWhatsAppText({ to: from, text: "ക്ഷമിക്കണം, ഇന്ന് നിങ്ങൾക്ക് അപ്പോയിന്റ്മെന്റുകൾ ഒന്നും ഉള്ളതായി കാണുന്നില്ല." });
                                }
                            } catch (error) {
                                console.error('[WhatsApp Webhook] Status check error:', error);
                            }
                        } else {
                            await sendWhatsAppText({ to: from, text: "ക്ഷമിക്കണം, നിങ്ങളുടെ വിവരങ്ങൾ കണ്ടെത്താൻ കഴിഞ്ഞില്ല. ദയവായി ക്ലിനിക്കുമായി ബന്ധപ്പെടുക." });
                        }
                        return new NextResponse('EVENT_RECEIVED', { status: 200 });
                    }

                    // 2b. Direct Booking via App (Magic Link)
                    if (messageBody.toLowerCase().includes('book') || messageBody === '4') {
                        console.log(`[WhatsApp Webhook] 📚 Handling 'book' command for session:`, session?.clinicId);
                        if (session?.clinicId) {
                            try {
                                const clinicDoc = await getDoc(doc(db, 'clinics', session.clinicId));
                                const clinicData = clinicDoc.data();
                                const clinicCode = clinicData?.shortCode || 'clinic';

                                console.log(`[WhatsApp Webhook] 🔗 Generating Magic Link for ${from} | Clinic: ${clinicData?.name}`);

                                // Use Admin SDK to bypass client permissions
                                const magicToken = await MagicLinkAdminService.generateTokenAdmin(adminDb, from, `/book-appointment?clinicId=${session.clinicId}`);
                                console.log(`[WhatsApp Webhook] ✅ Magic Token Generated: ${magicToken.slice(0, 8)}...`);

                                const success = await sendWhatsAppBookingLink({
                                    communicationPhone: from,
                                    patientName: patientName || 'Patient',
                                    clinicName: clinicData?.name || 'Clinic',
                                    clinicCode: clinicCode,
                                    clinicId: session.clinicId,
                                    magicToken,
                                    redirectPath: `/book-appointment?clinicId=${session.clinicId}`,
                                    firestore: db
                                });

                                console.log(`[WhatsApp Webhook] 📤 SendBookingLink Result: ${success}`);

                                // Reset wizard state if any
                                await WhatsAppSessionService.updateBookingState(from, 'idle');
                                return new NextResponse('EVENT_RECEIVED', { status: 200 });
                            } catch (e) {
                                console.error('[WhatsApp Webhook] ❌ Booking link error:', e);
                                await sendWhatsAppText({ to: from, text: "ക്ഷമിക്കണം, ബുക്കിംഗ് ലിങ്ക് ലഭ്യമാക്കുന്നതിൽ ഒരു പിശക് സംഭവിച്ചു." });
                            }
                        } else {
                            console.log(`[WhatsApp Webhook] ⚠️ No clinic in session for 'book' command`);
                            await sendWhatsAppText({
                                to: from,
                                text: "അപ്പോയിന്റ്മെന്റ് ബുക്ക് ചെയ്യാൻ ഈ ലിങ്ക് ഉപയോഗിക്കുക: https://app.kloqo.com/clinics\n(ക്ലിനിക്കിന്റെ കോഡ് (ഉദാ: KQ-1234) ആദ്യം നൽകിയാൽ നേരിട്ടുള്ള ലിങ്ക് ലഭിക്കുന്നതാണ്)"
                            });
                            return new NextResponse('EVENT_RECEIVED', { status: 200 });
                        }
                    }

                    // 2c. Booking Wizard State Handling (Only for active handled states)
                    if (session?.bookingState === 'confirm_booking') {
                        await handleBookingWizard(from, messageBody, session, patientName);
                        return new NextResponse('EVENT_RECEIVED', { status: 200 });
                    }

                    // 3. AI Processing or Prompt for Code
                    if (session?.clinicId) {
                        try {
                            // Fetch Clinic Data
                            const clinicDoc = await getDoc(doc(db, 'clinics', session.clinicId));
                            const clinicData = clinicDoc.data();

                            if (clinicData) {
                                // Fetch Doctors to get real-time status
                                const doctorsRef = collection(db, 'doctors');
                                const dQuery = query(doctorsRef, where('clinicId', '==', session.clinicId));
                                const dSnap = await getDocs(dQuery);

                                let doctorName = "the doctor";
                                let doctorStatus = "Unknown";
                                let queueLength = 0;

                                if (!dSnap.empty) {
                                    // For simplicity, take the first doctor or summarize
                                    const doctorDoc = dSnap.docs[0];
                                    const dData = doctorDoc.data();
                                    doctorName = dData.name;
                                    doctorStatus = dData.consultationStatus || 'Out';

                                    // Fetch Appointments for queue info
                                    const now = getClinicNow();
                                    const today = getClinicDateString(now);
                                    const appointmentsRef = collection(db, 'appointments');
                                    const aQuery = query(
                                        appointmentsRef,
                                        where('clinicId', '==', session.clinicId),
                                        where('doctor', '==', doctorName),
                                        where('date', '==', today)
                                    );
                                    const aSnap = await getDocs(aQuery);
                                    const allApts = aSnap.docs.map(d => ({ id: d.id, ...d.data() } as any));

                                    const queueState = await computeQueues(
                                        allApts,
                                        doctorName,
                                        doctorDoc.id,
                                        session.clinicId,
                                        today,
                                        0, // Default session
                                        dData.consultationStatus
                                    );

                                    queueLength = queueState.arrivedQueue.length;
                                }

                                const operatingHours = clinicData.operatingHours || "ക്ലിനിക്കുമായി ബന്ധപ്പെടുക.";

                                const aiResponse = await AIService.generatePatientResponse(
                                    clinicData.name,
                                    doctorName,
                                    doctorStatus,
                                    queueLength,
                                    operatingHours,
                                    messageBody,
                                    patientName
                                );

                                if (aiResponse === AI_ERROR_BUSY) {
                                    const magicToken = await MagicLinkAdminService.generateTokenAdmin(adminDb, from, '/home');
                                    await sendWhatsAppAIFallback({
                                        communicationPhone: from,
                                        patientName: patientName,
                                        magicToken: magicToken,
                                        clinicId: session.clinicId,
                                        firestore: db
                                    });
                                } else {
                                    await sendWhatsAppText({
                                        to: from,
                                        text: aiResponse
                                    });
                                }
                                return new NextResponse('EVENT_RECEIVED', { status: 200 });
                            }
                        } catch (error) {
                            console.error('Error in AI processing:', error);
                        }
                    }

                    // 4. General AI response (No clinic selected yet)
                    try {
                        console.log(`[WhatsApp Webhook] No clinic session for ${from}, using general AI response with global context.`);

                        // Fetch global context for specialties/symptoms
                        const globalData = await GlobalSearchService.getGlobalHealthcareContext();

                        const aiResponse = await AIService.generatePatientResponse(
                            "Kloqo", // General name
                            "",      // No doctor
                            "",      // No status
                            0,       // No queue
                            "",      // No hours
                            messageBody,
                            patientName,
                            globalData // Pass global context
                        );

                        if (aiResponse === AI_ERROR_BUSY) {
                            const magicToken = await MagicLinkAdminService.generateTokenAdmin(adminDb, from, '/home');
                            await sendWhatsAppAIFallback({
                                communicationPhone: from,
                                patientName: patientName,
                                magicToken: magicToken,
                                firestore: db
                            });
                        } else {
                            // Append the prompt for clinic code if it's not already helpful
                            let finalResponse = aiResponse;
                            if (!aiResponse.toLowerCase().includes("kq-")) {
                                const promptExtra = "\n\nഒരു ക്ലിനിക്കുമായോ ഡോക്ടറുമായോ ബന്ധപ്പെടാൻ ആ ക്ലിനിക്കിന്റെ കോഡ് (ഉദാ: KQ-1234) ടൈപ്പ് ചെയ്യുക.";
                                finalResponse += promptExtra;
                            }

                            await sendWhatsAppText({
                                to: from,
                                text: finalResponse
                            });
                        }
                        return new NextResponse('EVENT_RECEIVED', { status: 200 });
                    } catch (error) {
                        console.error('Error in General AI processing:', error);
                    }

                    // Final Fallback (only if AI fails)
                    await sendWhatsAppText({
                        to: from,
                        text: `${greetingBase}Kloqo-ലേക്ക് സ്വാഗതം! ഏത് ക്ലിനിക്കുമായാണ് നിങ്ങൾക്ക് ബന്ധപ്പെടേണ്ടത്? ക്ലിനിക് കോഡ് (ഉദാ: KQ-1234) നൽകുക.`
                    });
                }
            }
            return new NextResponse('EVENT_RECEIVED', { status: 200 });
        }
        return new NextResponse('Not Found', { status: 404 });
    } catch (error) {
        console.error('[WhatsApp Webhook] Error:', error);
        return new NextResponse('Internal Server Error', { status: 500 });
    }
}

/**
 * Handles the multi-step booking wizard for WhatsApp.
 */
async function handleBookingWizard(from: string, message: string, session: any, patientName?: string) {
    const db = getFirestore();
    const state = session.bookingState;

    try {
        // Streamlined: States 1-4 are now handled by Magic Links leading to the App UI.
        // Direct users to the app for scheduling, slot selection, and patient info.

        // STATE 5: FINAL CONFIRMATION (Fallback/Manual)
        if (state === 'confirm_booking') {
            if (message.toLowerCase().includes('yes') || message === '1' || message.toLowerCase().includes('confirm')) {
                // EXECUTE ADVANCE BOOKING (A-TOKEN)
                const targetDate = parseClinicDate(session.bookingData.date);
                if (!targetDate || isNaN(targetDate.getTime())) {
                    console.error('[BookingWizard] Invalid date in confirm_booking:', session.bookingData.date);
                    await sendWhatsAppText({ to: from, text: "ക്ഷമിക്കണം, തീയതി വിവരങ്ങളിൽ ഒരു പിശക് സംഭവിച്ചു. ദയവായി ആദ്യം മുതൽ ഒന്ന് കൂടി ശ്രമിക്കുക." });
                    await WhatsAppSessionService.updateBookingState(from, 'idle');
                    return;
                }

                // 1. Reserve Slot & Generate Token
                const result = await generateNextTokenAndReserveSlot(
                    db,
                    session.clinicId,
                    session.bookingData.doctorName,
                    targetDate,
                    'A',
                    {
                        slotIndex: session.bookingData.slotIndex,
                        doctorId: session.bookingData.doctorId,
                        patientName: session.bookingData.patientName,
                        age: session.bookingData.patientAge,
                        sex: session.bookingData.patientSex,
                        phone: from
                    }
                );

                // 2. Ensure Patient Record Exists
                let patientId = session.bookingData.patientId;
                if (!patientId) {
                    patientId = await managePatient({
                        name: session.bookingData.patientName,
                        age: session.bookingData.patientAge,
                        sex: session.bookingData.patientSex,
                        place: 'WhatsApp',
                        phone: from.replace(/\D/g, '').slice(-10), // 10-digit
                        communicationPhone: from,
                        clinicId: session.clinicId,
                        bookingFor: 'self'
                    });
                } else {
                    // Update existing patient's clinic list
                    await managePatient({
                        id: patientId,
                        name: session.bookingData.patientName,
                        place: 'WhatsApp',
                        phone: from.replace(/\D/g, '').slice(-10),
                        communicationPhone: from,
                        clinicId: session.clinicId,
                        bookingFor: 'update'
                    });
                }

                // 3. Create Appointment Document
                const apptRef = doc(collection(db, 'appointments'));
                const newAppointment = {
                    id: apptRef.id,
                    patientId,
                    patientName: session.bookingData.patientName,
                    communicationPhone: from,
                    age: session.bookingData.patientAge,
                    sex: session.bookingData.patientSex,
                    doctor: session.bookingData.doctorName,
                    doctorId: session.bookingData.doctorId,
                    clinicId: session.clinicId,
                    date: session.bookingData.date,
                    time: result.time,
                    arriveByTime: result.arriveByTime,
                    tokenNumber: result.tokenNumber,
                    numericToken: result.numericToken,
                    slotIndex: result.slotIndex,
                    sessionIndex: result.sessionIndex,
                    status: 'Pending',
                    bookedVia: 'Advanced Booking',
                    createdAt: serverTimestamp(),
                    updatedAt: serverTimestamp(),
                    cutOffTime: Timestamp.fromDate(subMinutes(parseClinicDate(session.bookingData.date + ' ' + result.time), 15)),
                    noShowTime: Timestamp.fromDate(addMinutes(parseClinicDate(session.bookingData.date + ' ' + result.arriveByTime), 15))
                };

                await setDoc(apptRef, newAppointment);

                // 3.5 Fetch Clinic data for notification rules
                const clinicDoc = await getDoc(doc(db, 'clinics', session.clinicId));
                const clinicData = clinicDoc.data();
                const tokenDistribution = clinicData?.tokenDistribution;

                // 4. Generate Magic Link for the App (Silent Login)
                let magicToken = '';
                try {
                    const adminApp = getFirebaseAdmin();
                    const adminDb = adminApp.firestore();
                    // Use Admin SDK to bypass client permissions
                    magicToken = await MagicLinkAdminService.generateTokenAdmin(adminDb, from, `/live-token/${apptRef.id}`);
                    console.log(`[MagicLink] Generated token(Admin) for ${from}: ${magicToken}`);
                } catch (e) {
                    console.error('[MagicLink] Failed to generate token:', e);
                }

                // 5. Send Confirmation & Notification
                try {
                    // For Classic mode, we don't show the 'A' token until they arrive
                    const showToken = tokenDistribution === 'advanced';
                    const displayToken = showToken ? result.tokenNumber : '--';

                    await sendWhatsAppAppointmentConfirmed({
                        communicationPhone: from,
                        patientName: session.bookingData.patientName,
                        doctorName: session.bookingData.doctorName,
                        clinicName: session.clinicName || 'The Clinic',
                        date: session.bookingData.date,
                        time: result.time,
                        arriveByTime: result.arriveByTime,
                        tokenNumber: displayToken,
                        appointmentId: apptRef.id,
                        magicToken: magicToken, // NEW: Pass the magic token for the button
                        showToken: showToken,
                        clinicId: session.clinicId
                    } as any);
                } catch (e) {
                    console.error('[BookingWizard] WhatsApp Confirm error:', e);
                    // Fallback to text if template fails
                    await sendWhatsAppText({
                        to: from,
                        text: `✅ ബുക്കിംഗ് പൂർത്തിയായി!\n\nഡോക്ടർ: ${session.bookingData.doctorName}\nതീയതി: ${session.bookingData.date}\nസമയം: ${result.time}\nടോക്കൺ: *${result.tokenNumber}*`
                    });
                }

                try {
                    await sendAppointmentBookedByStaffNotification({
                        firestore: db,
                        patientId,
                        appointmentId: apptRef.id,
                        doctorName: session.bookingData.doctorName,
                        clinicName: session.clinicName || 'Clinic',
                        date: session.bookingData.date,
                        time: result.time,
                        arriveByTime: result.arriveByTime,
                        tokenNumber: result.tokenNumber,
                        bookedBy: 'nurse',
                        communicationPhone: from,
                        patientName: session.bookingData.patientName,
                        tokenDistribution: tokenDistribution,
                        clinicId: session.clinicId,
                        // classicTokenNumber is not available for advance booking in Classic mode
                    });
                } catch (e) {
                    console.error('[BookingWizard] Notification error:', e);
                }

                await WhatsAppSessionService.updateBookingState(from, 'idle');
            } else if (message.toLowerCase().includes('no')) {
                await sendWhatsAppText({ to: from, text: "ബുക്കിംഗ് റദ്ദാക്കിയിരിക്കുന്നു. നിങ്ങൾക്ക് മറ്റു സഹായങ്ങൾ ആവശ്യമുണ്ടോ?" });
                await WhatsAppSessionService.updateBookingState(from, 'idle');
            } else {
                await sendWhatsAppText({
                    to: from,
                    text: `ഈ വിവരങ്ങൾ ശരിയാണോ?\n\nഡോക്ടർ: ${session.bookingData.doctorName}\nതീയതി: ${session.bookingData.date}\nസമയം: ${session.bookingData.slotTime}\nരോഗി: ${session.bookingData.patientName} (${session.bookingData.patientAge})\n\nഉറപ്പിക്കാൻ "Yes" എന്ന് ടൈപ്പ് ചെയ്യുക.`
                });
            }
        }
    } catch (error: any) {
        console.error('[BookingWizard] Error:', error);
        await sendWhatsAppText({ to: from, text: "ക്ഷമിക്കണം, ബുക്കിംഗ് പ്രക്രിയയിൽ ഒരു പിശക് സംഭവിച്ചു. ദയവായി അല്പം കഴിഞ്ഞ് ശ്രമിക്കുക." });
        await WhatsAppSessionService.updateBookingState(from, 'idle');
    }
}
