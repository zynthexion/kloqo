

import { NextRequest, NextResponse } from 'next/server';
import { CodeService } from '@kloqo/shared-core';
import { sendWhatsAppText } from '@kloqo/shared-core';

const VERIFY_TOKEN = 'kloqo-whatsapp-webhook-verify-token'; // Define a secure token

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
                const from = message.from; // Sender phone number
                const messageBody = message.text?.body; // Text message content

                if (messageBody) {
                    console.log(`[WhatsApp Webhook] Message from ${from}: ${messageBody}`);

                    // 1. Check for Clinic Code (KQ-XXXX)
                    const codeMatch = messageBody.match(/^KQ-?[A-Z0-9]{4}$/i);
                    if (codeMatch) {
                        try {
                            const code = codeMatch[0];
                            const clinic = await CodeService.getClinicByCode(code);

                            if (clinic) {
                                // In a real app, store this session in Firestore 'whatsapp_sessions'
                                await sendWhatsAppText({
                                    to: from,
                                    text: `Welcome to ${clinic.name}! 👋\n\nYou can ask about:\n- Doctor availability\n- Opening hours\n- Queue status\n\nOr type "Book" to schedule an appointment.`
                                });
                            } else {
                                await sendWhatsAppText({
                                    to: from,
                                    text: "I couldn't find a clinic with that code. Please check the code and try again."
                                });
                            }
                        } catch (error) {
                            console.error('Error handling clinic code:', error);
                        }
                        return new NextResponse('EVENT_RECEIVED', { status: 200 });
                    }

                    // 2. Check for "Book" command
                    if (messageBody.toLowerCase().includes('book')) {
                        // Ideally, retrieve clinicId from session. For now, prompt generic or specific if known.
                        await sendWhatsAppText({
                            to: from,
                            text: "To book an appointment, please visit: https://app.kloqo.com/clinics\n(Tip: Enter a clinic code first like KQ-1234 to get a direct link!)"
                        });
                        return new NextResponse('EVENT_RECEIVED', { status: 200 });
                    }

                    // 3. AI Processing (Default)
                    // In a real implementation:
                    // 1. Fetch 'whatsapp_sessions' to get clinicId
                    // 2. Fetch clinic/doctor data
                    // 3. Call AIService.generatePatientResponse(...)

                    // For now, simple echo/fallback until session logic is wired up
                    await sendWhatsAppText({
                        to: from,
                        text: "Welcome to Kloqo! Please enter a 4-digit Clinic Code (e.g., KQ-1234) to start chatting with a specific clinic."
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
