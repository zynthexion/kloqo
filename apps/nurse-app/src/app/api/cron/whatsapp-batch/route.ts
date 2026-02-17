import { NextResponse } from 'next/server';
import { db } from '@/lib/firebase';
import { collection, getDocs } from 'firebase/firestore';
import { checkAndSendDailyReminders } from '@kloqo/shared-core';

/**
 * GET /api/cron/whatsapp-batch
 * This endpoint is triggered by cron-job.org or similar external schedulers.
 * It iterates through all active clinics and triggers the split-batch reminder logic.
 */
export async function GET(request: Request) {
    // 1. Security Check
    const authHeader = request.headers.get('authorization');
    const secret = process.env.CRON_SECRET;

    // DEBUG: Log first/last chars of header to verify format without exposing secret
    if (authHeader) {
        console.log(`[WhatsApp Batch] Header received: ${authHeader.substring(0, 15)}...${authHeader.slice(-3)}`);
    } else {
        console.log('[WhatsApp Batch] No authorization header found');
    }

    // Use a default for development if needed, but enforce in production
    if (!secret) {
        console.warn('[WhatsApp Batch] Warning: CRON_SECRET is not set in environment variables.');
        return NextResponse.json({ error: 'Cron secret not configured' }, { status: 500 });
    }

    if (authHeader !== `Bearer ${secret}`) {
        console.error('[WhatsApp Batch] Authentication mismatch');
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        console.log('[CRON] 🚀 Starting Global WhatsApp Batch Reminder Process...');

        // 2. Fetch all clinics
        // In a very large system, you might want to filter for active clinics or paginate.
        const clinicsSnapshot = await getDocs(collection(db, 'clinics'));

        if (clinicsSnapshot.empty) {
            console.log('[CRON] No clinics found to process.');
            return NextResponse.json({ message: 'No clinics found' });
        }

        const results = [];
        for (const clinicDoc of clinicsSnapshot.docs) {
            const clinicId = clinicDoc.id;
            const clinicData = clinicDoc.data();

            console.log(`[CRON] 🏥 Processing Clinic: ${clinicData.name || clinicId}`);

            try {
                // checkAndSendDailyReminders handles its own window checking and Firestore persistence
                await checkAndSendDailyReminders({
                    firestore: db,
                    clinicId
                });
                results.push({ clinicId, status: 'success' });
            } catch (e) {
                console.error(`[CRON] ❌ Failed for clinic ${clinicId}:`, e);
                results.push({ clinicId, status: 'failed', error: String(e) });
            }
        }

        console.log(`[CRON] ✅ Process complete. Handled ${results.length} clinics.`);

        return NextResponse.json({
            message: 'WhatsApp Batch Processed',
            count: results.length,
            details: results
        });
    } catch (error) {
        console.error('[CRON] 🔥 Critical Error in Cron Route:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
