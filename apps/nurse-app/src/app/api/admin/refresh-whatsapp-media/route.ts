import { NextRequest, NextResponse } from 'next/server';
import { getFirebaseAdmin } from '@kloqo/shared-core/src/utils/firebase-admin';

const STORAGE_VIDEO_URL = 'https://firebasestorage.googleapis.com/v0/b/kloqo-clinic-multi-33968-4c50b.firebasestorage.app/o/wattsapp.mp4?alt=media&token=07d8e777-3ae2-43c5-a30b-19f2c0f35cc4';

/**
 * WhatsApp Media Refresh Endpoint
 * Called by cron-job.org every 28 days to re-upload the tutorial video to Meta.
 * Meta media IDs expire after 30 days - this keeps it fresh automatically.
 *
 * Auth: Authorization: Bearer <CRON_SECRET>
 * cron-job.org: Set custom header x-cron-secret (or use Authorization Bearer)
 */
export async function POST(req: NextRequest) {
    try {
        // Verify cron secret
        const authHeader = req.headers.get('authorization');
        if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
            console.error('[MediaRefresh] Unauthorized request');
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
        const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;

        if (!phoneNumberId || !accessToken) {
            return NextResponse.json({ error: 'Missing WhatsApp credentials' }, { status: 500 });
        }

        console.log('[MediaRefresh] 📥 Downloading video from Firebase Storage...');

        // 1. Download video from Firebase Storage into memory
        const videoResponse = await fetch(STORAGE_VIDEO_URL);
        if (!videoResponse.ok) {
            throw new Error(`Failed to download video: ${videoResponse.statusText}`);
        }
        const videoBuffer = await videoResponse.arrayBuffer();
        const videoBlob = new Blob([videoBuffer], { type: 'video/mp4' });

        console.log(`[MediaRefresh] ✅ Downloaded video: ${(videoBuffer.byteLength / 1024 / 1024).toFixed(2)} MB`);

        // 2. Upload to Meta Media API
        console.log('[MediaRefresh] 📤 Uploading to Meta Media API...');
        const formData = new FormData();
        formData.append('file', videoBlob, 'kloqo_tutorial.mp4');
        formData.append('messaging_product', 'whatsapp');

        const metaResponse = await fetch(
            `https://graph.facebook.com/v21.0/${phoneNumberId}/media`,
            {
                method: 'POST',
                headers: { Authorization: `Bearer ${accessToken}` },
                body: formData,
            }
        );

        if (!metaResponse.ok) {
            const errorText = await metaResponse.text();
            throw new Error(`Meta API upload failed: ${errorText}`);
        }

        const metaData = await metaResponse.json();
        const newMediaId = metaData.id;

        if (!newMediaId) {
            throw new Error('Meta API did not return a media ID');
        }

        console.log(`[MediaRefresh] ✅ Got new media_id from Meta: ${newMediaId}`);

        // 3. Save media_id to system-config/whatsapp_media
        const adminApp = getFirebaseAdmin();
        const firestore = adminApp.firestore();

        await firestore.collection('system-config').doc('whatsapp_media').set({
            tutorialVideoMediaId: newMediaId,
            lastRefreshedAt: new Date().toISOString(),
            videoStorageUrl: STORAGE_VIDEO_URL,
        }, { merge: true });

        console.log(`[MediaRefresh] 💾 Saved new media_id to system-config/whatsapp_media`);

        return NextResponse.json({
            success: true,
            mediaId: newMediaId,
            refreshedAt: new Date().toISOString(),
        });

    } catch (error: any) {
        console.error('[MediaRefresh] ❌ Error:', error);
        return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
    }
}

// Also support GET for easy manual trigger from browser (with secret in query param)
export async function GET(req: NextRequest) {
    const secret = req.nextUrl.searchParams.get('secret');
    if (secret !== process.env.CRON_SECRET) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    // Delegate to POST logic by re-calling with auth header
    const modifiedReq = new NextRequest(req.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}` },
    });
    return POST(modifiedReq);
}
