import { NextRequest, NextResponse } from 'next/server';
import { handleWalkInBooking, WalkInBookingError } from '@kloqo/shared-core';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 200,
    headers: corsHeaders,
  });
}

export async function POST(request: NextRequest) {
  try {
    const payload = await request.json();
    const result = await handleWalkInBooking(payload);
    return NextResponse.json(result, { headers: corsHeaders });
  } catch (error) {
    const status =
      error instanceof WalkInBookingError
        ? error.status
        : 500;
    const message =
      error instanceof WalkInBookingError
        ? error.message
        : 'Failed to process walk-in booking';

    console.error('[walk-in booking] Failed to book appointment', error);
    return NextResponse.json(
      { error: message, code: error instanceof WalkInBookingError ? error.code : undefined },
      { status, headers: corsHeaders }
    );
  }
}

