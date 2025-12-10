import { NextRequest, NextResponse } from 'next/server';
import twilio from 'twilio';

export async function POST(request: NextRequest) {
  const { to, message, channel = 'sms' } = await request.json(); // Default to 'sms'

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  
  let from: string | undefined;
  let toFormatted: string;

  if (channel === 'whatsapp') {
    from = process.env.TWILIO_WHATSAPP_NUMBER;
    toFormatted = `whatsapp:${to}`;
    if (from) {
      from = `whatsapp:${from}`;
    }
  } else {
    from = process.env.TWILIO_PHONE_NUMBER;
    toFormatted = to;
  }

  // Check if Twilio credentials are configured in .env
  if (!accountSid || !authToken || !from) {
    console.error("Twilio credentials are not configured in .env file for the selected channel.");
    return NextResponse.json(
      { success: false, error: 'SMS/WhatsApp service is not configured. Please contact support.' },
      { status: 500 }
    );
  }
  
  // Check for placeholder credentials
  if (accountSid === 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' || authToken === 'your_auth_token') {
    console.warn("Using placeholder Twilio credentials. Message will not be sent.");
    // Simulate a successful response for development/testing without real credentials
    return NextResponse.json({ success: true, message: "Message sending is in simulation mode." });
  }

  const client = twilio(accountSid, authToken);

  try {
    const result = await client.messages.create({
      body: message,
      from: from,
      to: toFormatted
    });

    console.log(`Message sent successfully: ${result.sid}`);
    return NextResponse.json({ 
      success: true, 
      messageId: result.sid,
      message: "Message sent successfully" 
    });

  } catch (error: any) {
    console.error('Error sending message:', error);
    return NextResponse.json(
      { 
        success: false, 
        error: error.message || 'Failed to send message',
        code: error.code 
      },
      { status: 500 }
    );
  }
}



