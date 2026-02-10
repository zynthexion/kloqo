import { NextRequest, NextResponse } from 'next/server';
import { getFirebaseAdmin } from '../../../../../../../packages/shared-core/src/utils/firebase-admin';

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
        if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
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

        // Group sessions by ref
        const refGroups = new Map<string, any[]>();
        sessionsSnap.forEach(doc => {
            const data = doc.data();
            if (!refGroups.has(data.ref)) {
                refGroups.set(data.ref, []);
            }
            refGroups.get(data.ref)!.push(data);
        });

        // Update summaries for each campaign
        const batch = firestore.batch();
        let updateCount = 0;

        for (const [ref, sessions] of refGroups) {
            // Get total sends for this ref
            const sendsSnap = await firestore
                .collection('campaign_sends')
                .where('ref', '==', ref)
                .get();
            const totalSent = sendsSnap.size;

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

            // Get campaign details from first session
            const firstSession = sessions[0];

            // Update summary document
            const summaryRef = firestore.collection('campaign_summaries').doc(ref);
            batch.set(summaryRef, {
                ref,
                campaign: firstSession.campaign || ref,
                medium: firstSession.medium || 'unknown',

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
