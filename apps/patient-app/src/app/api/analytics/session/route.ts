import { NextRequest, NextResponse } from 'next/server';
import { getFirebaseAdmin } from '@kloqo/shared-core/src/utils/firebase-admin';

/**
 * Analytics Session Endpoint
 * Receives beacon data from client-side marketing analytics tracker
 * Writes session data to Firestore (single write per session)
 */
export async function POST(req: NextRequest) {
    try {
        const data = await req.json();

        // Validate required fields
        if (!data.sessionId || !data.ref || !data.campaign) {
            return NextResponse.json(
                { error: 'Missing required fields' },
                { status: 400 }
            );
        }

        // Use Firebase Admin SDK for server-side writes
        const adminApp = getFirebaseAdmin();
        const firestore = adminApp.firestore();

        // Write to Firestore (SINGLE WRITE per session)
        await firestore.collection('marketing_analytics').add({
            ...data,
            sessionEnd: require('firebase-admin').firestore.FieldValue.serverTimestamp(),
            createdAt: require('firebase-admin').firestore.FieldValue.serverTimestamp(),
        });

        console.log('[Analytics API] Session data saved:', data.sessionId);

        return NextResponse.json({ success: true }, { status: 200 });
    } catch (error) {
        console.error('[Analytics API] Error saving session data:', error);
        return NextResponse.json(
            { error: 'Failed to save session data' },
            { status: 500 }
        );
    }
}

// Allow OPTIONS for CORS preflight
export async function OPTIONS() {
    return NextResponse.json({}, { status: 200 });
}
