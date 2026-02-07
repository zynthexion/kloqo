import { NextRequest, NextResponse } from 'next/server';
import twilio from 'twilio';
import { WhatsAppService, WhatsAppTemplateComponent } from '@kloqo/shared-core';

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { to, message, channel = 'sms' } = body;

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const whatsappPhoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const whatsappToken = process.env.WHATSAPP_ACCESS_TOKEN;

  // Handle direct WhatsApp API (Meta)
  if (channel === 'whatsapp' && whatsappPhoneId && whatsappToken) {
    try {
      console.log(`[WhatsApp API] 🎯 Attempting Meta API for ${to} using template ${body.contentSid}`);
      const whatsappService = new WhatsAppService(whatsappPhoneId, whatsappToken);

      let components: WhatsAppTemplateComponent[] = [];
      const templateName = body.contentSid;
      const vars = body.contentVariables || {};

      // Mapping logic for Malayalam templates with buttons
      if (templateName === 'appointment_confirmed_ml') {
        // Body: 1-6, Button: 7
        const bodyParams = ["1", "2", "3", "4", "5", "6"].map(k => ({ type: 'text' as const, text: String(vars[k] || '') }));
        const buttonParams = [{ type: 'text' as const, text: String(vars["7"] || '') }];

        components = [
          { type: 'body', parameters: bodyParams },
          { type: 'button', sub_type: 'url', index: '0', parameters: buttonParams }
        ];
      } else if (templateName === 'appointment_confirmed_no_token_ml') {
        // Body: 1-5, Button: 6
        const bodyParams = ["1", "2", "3", "4", "5"].map(k => ({ type: 'text' as const, text: String(vars[k] || '') }));
        const buttonParams = [{ type: 'text' as const, text: String(vars["6"] || '') }];

        components = [
          { type: 'body', parameters: bodyParams },
          { type: 'button', sub_type: 'url', index: '0', parameters: buttonParams }
        ];
      } else if (templateName === 'appointment_request_ml') {
        // Body: 1-3, Button: 4
        const bodyParams = ["1", "2", "3"].map(k => ({ type: 'text' as const, text: String(vars[k] || '') }));
        const buttonParams = [{ type: 'text' as const, text: String(vars["4"] || '') }];

        components = [
          { type: 'body', parameters: bodyParams },
          { type: 'button', sub_type: 'url', index: '0', parameters: buttonParams }
        ];
      } else if (templateName === 'text_message') {
        // Free-text message
        const textContent = vars.text || '';
        components = [
          { type: 'body', parameters: [{ type: 'text', text: String(textContent) }] }
        ];
      }

      await whatsappService.sendTemplateMessage(to, templateName, 'ml', components);

      return NextResponse.json({
        success: true,
        message: "WhatsApp message sent successfully via Meta API"
      });
    } catch (error: any) {
      console.error('[WhatsApp API] Error:', error);
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
  }

  // Fallback to Twilio for SMS or if Meta config is missing
  let from: string | undefined;
  let toFormatted: string;

  if (channel === 'whatsapp') {
    // If it's a Meta template, DO NOT fall back to Twilio as it will fail (Cross-provider template mismatch)
    const metaTemplates = ['appointment_confirmed_ml', 'appointment_confirmed_no_token_ml', 'appointment_request_ml'];
    if (metaTemplates.includes(body.contentSid)) {
      return NextResponse.json({
        success: false,
        error: 'Meta WhatsApp credentials missing or invalid. Template cannot be sent via Twilio.'
      }, { status: 400 });
    }

    from = process.env.TWILIO_WHATSAPP_NUMBER;
    toFormatted = `whatsapp:${to}`;
    if (from) from = `whatsapp:${from}`;
  } else {
    from = process.env.TWILIO_PHONE_NUMBER;
    toFormatted = to;
  }

  if (!accountSid || !authToken || !from) {
    return NextResponse.json(
      { success: false, error: 'Messaging service is not configured.' },
      { status: 500 }
    );
  }

  const client = twilio(accountSid, authToken);

  try {
    const messageOptions: any = { from, to: toFormatted };

    if (channel === 'whatsapp' && body.contentSid) {
      messageOptions.contentSid = body.contentSid;
      if (body.contentVariables) {
        messageOptions.contentVariables = typeof body.contentVariables === 'string'
          ? body.contentVariables
          : JSON.stringify(body.contentVariables);
      }
    } else {
      messageOptions.body = message;
    }

    const result = await client.messages.create(messageOptions);
    return NextResponse.json({ success: true, messageId: result.sid });

  } catch (error: any) {
    console.error('Twilio Error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}



