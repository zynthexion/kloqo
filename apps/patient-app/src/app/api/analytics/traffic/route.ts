import { NextRequest, NextResponse } from 'next/server';
import { getFirebaseAdmin } from '@kloqo/shared-core/src/utils/firebase-admin';

/**
 * Traffic Analytics API
 * Persists general app traffic data to the standalone 'app_traffic' collection.
 */
export async function POST(req: NextRequest) {
    try {
        const data = await req.json();

        if (!data.sessionId) {
            return NextResponse.json({ error: 'Missing sessionId' }, { status: 400 });
        }

        const adminApp = getFirebaseAdmin();
        const firestore = adminApp.firestore();

        // Write to STANDALONE traffic collection
        await firestore.collection('app_traffic').add({
            ...data,
            createdAt: require('firebase-admin').firestore.FieldValue.serverTimestamp(),
            timestamp: require('firebase-admin').firestore.FieldValue.serverTimestamp(),
        });

        return NextResponse.json({ success: true }, { status: 200 });
    } catch (error) {
        console.error('[Traffic API] Error:', error);
        return NextResponse.json({ error: 'Internal Error' }, { status: 500 });
    }
}

export async function OPTIONS() {
    return NextResponse.json({}, { status: 200 });
}
