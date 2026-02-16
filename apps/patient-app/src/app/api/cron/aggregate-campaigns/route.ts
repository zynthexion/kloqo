import { NextRequest, NextResponse } from 'next/server';
import { getFirebaseAdmin } from '@kloqo/shared-core/src/utils/firebase-admin';

/**
 * Campaign Aggregation Cron Job
 * Runs every 15 minutes to aggregate marketing analytics data
 * Updates campaign_summaries collection with latest metrics
 * 
 * Prevents Firestore hot-spotting by batch updating instead of real-time
 */
export async function GET(req: NextRequest) {
    try {
        // Verify cron secret
        const authHeader = req.headers.get('authorization');

        // DEBUG: Log first/last chars of header to verify format without exposing secret
        if (authHeader) {
            console.log(`[Cron Auth] Header received: ${authHeader.substring(0, 15)}...${authHeader.slice(-3)}`);
        } else {
            console.log('[Cron Auth] No authorization header found');
        }

        if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
            console.error('[Cron Auth] Authentication mismatch');
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const adminApp = getFirebaseAdmin();
        const firestore = adminApp.firestore();

        // Get all sessions from last 24 hours
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const sessionsSnap = await firestore
            .collection('marketing_analytics')
            .where('sessionStart', '>=', oneDayAgo.toISOString())
            .get();

        console.log(`[Cron] Processing ${sessionsSnap.size} sessions`);

        // 1. Get all refs that have been SENT in last 24h
        const sendsSnap = await firestore
            .collection('campaign_sends')
            .where('sentAt', '>=', oneDayAgo) // Note: using Date object for admin SDK
            .get();

        const allRefs = new Set<string>();
        sendsSnap.forEach(doc => allRefs.add(doc.data().ref));


        // Group sessions by ref
        const sessionsByRef = new Map<string, any[]>();
        sessionsSnap.forEach(doc => {
            const data = doc.data();
            if (!sessionsByRef.has(data.ref)) {
                sessionsByRef.set(data.ref, []);
            }
            sessionsByRef.get(data.ref)!.push(data);
        });

        // Update summaries for each campaign
        const batch = firestore.batch();
        let updateCount = 0;

        for (const ref of allRefs) {
            const sessions = sessionsByRef.get(ref) || [];

            // Get total sends for this ref (from our already fetched snap)
            const sendsForThisRef = sendsSnap.docs.filter(d => d.data().ref === ref);
            const totalSent = sendsForThisRef.length;

            // Filter out bots
            const nonBotSessions = sessions.filter(s => !s.isBot);
            const totalClicks = nonBotSessions.length;

            // Count valid sessions (duration > 5s)
            const validSessions = nonBotSessions.filter(s => s.sessionDuration > 5);
            const totalSessions = validSessions.length;

            // Count sessions with actions
            const sessionsWithActions = nonBotSessions.filter(s => s.actions && s.actions.length > 0);
            const totalActions = sessionsWithActions.length;

            // Calculate metrics
            const ctr = totalSent > 0 ? (totalClicks / totalSent) * 100 : 0;
            const conversionRate = totalClicks > 0 ? (totalActions / totalClicks) * 100 : 0;

            const avgSessionDuration = validSessions.length > 0
                ? validSessions.reduce((sum, s) => sum + s.sessionDuration, 0) / validSessions.length
                : 0;

            const avgPagesPerSession = validSessions.length > 0
                ? validSessions.reduce((sum, s) => sum + (s.pageCount || 0), 0) / validSessions.length
                : 0;

            const bouncedSessions = nonBotSessions.filter(s => s.sessionDuration < 10).length;
            const bounceRate = nonBotSessions.length > 0 ? (bouncedSessions / nonBotSessions.length) * 100 : 0;

            // Get campaign details
            // Try sessions first, then sends
            const sourceDoc = sessions.length > 0 ? sessions[0] : sendsForThisRef[0].data();

            // Update summary document
            const summaryRef = firestore.collection('campaign_summaries').doc(ref);
            batch.set(summaryRef, {
                ref,
                campaign: sourceDoc.campaign || ref,
                medium: sourceDoc.medium || 'whatsapp',

                totalLinksSent: totalSent,
                totalClicks,
                totalSessions,
                totalActions,

                ctr,
                conversionRate,
                avgSessionDuration,
                avgPagesPerSession,
                bounceRate,

                lastUpdated: require('firebase-admin').firestore.FieldValue.serverTimestamp(),
                dateRange: {
                    start: oneDayAgo.toISOString(),
                    end: new Date().toISOString(),
                },
            }, { merge: true });

            updateCount++;
        }

        // Commit batch
        await batch.commit();

        console.log(`[Cron] Updated ${updateCount} campaign summaries`);

        return NextResponse.json({
            success: true,
            sessionsProcessed: sessionsSnap.size,
            campaignsUpdated: updateCount,
        });

    } catch (error: any) {
        console.error('[Cron] Error aggregating campaigns:', error);
        return NextResponse.json(
            { error: error.message || 'Internal server error' },
            { status: 500 }
        );
    }
}
