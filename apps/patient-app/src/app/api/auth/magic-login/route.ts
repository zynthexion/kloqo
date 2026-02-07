
import { NextRequest, NextResponse } from 'next/server';
import { MagicLinkService } from '@kloqo/shared-core';
import { getFirebaseAdmin } from '../../../../../../../packages/shared-core/src/utils/firebase-admin';
import * as admin from 'firebase-admin';

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { magicToken } = body;

        console.log('[MagicLogin] Body:', body);

        if (!magicToken) {
            return NextResponse.json({ error: 'Magic token is required' }, { status: 400 });
        }

        const adminApp = getFirebaseAdmin();
        const firestore = adminApp.firestore();
        const auth = adminApp.auth();

        // 1. Verify the magic token
        // Use verifyToken from MagicLinkService (which is compatible with admin Firestore if we cast it or use it carefully)
        // Actually MagicLinkService.verifyToken expects Client Firestore.
        // We need to implement a verification using Admin Firestore here or add a verifyTokenAdmin to MagicLinkAdminService.

        // Let's implement verification logic here directly using Admin SDK to avoid more shared-core changes for now
        const docId = `ml_${magicToken}`;
        const mlRef = firestore.collection('magic_links').doc(docId);
        const mlSnap = await mlRef.get();

        if (!mlSnap.exists) {
            return NextResponse.json({ error: 'Invalid or expired magic token' }, { status: 401 });
        }

        const data = mlSnap.data();
        const expiresAt = data?.expiresAt.toDate();

        if (!data || new Date() > expiresAt) {
            await mlRef.delete();
            return NextResponse.json({ error: 'Invalid or expired magic token' }, { status: 401 });
        }

        // Cleanup after use
        await mlRef.delete();

        const { phone, redirectPath } = data;

        // 2. Lookup user by phone
        const usersRef = firestore.collection('users');
        const q = usersRef.where('phone', '==', `+91${phone}`).where('role', '==', 'patient');
        const querySnapshot = await q.get();

        let uid: string;

        if (!querySnapshot.empty) {
            // User exists
            uid = querySnapshot.docs[0].id;
            console.log(`[MagicLogin] Found existing user: ${uid} for phone: ${phone}`);
        } else {
            // 3. User does not exist - CREATE PLACEHOLDER
            console.log(`[MagicLogin] Phone ${phone} not found. Creating placeholder user/patient.`);

            // Create Firebase Auth User
            try {
                const authUser = await auth.getUserByPhoneNumber(`+91${phone}`);
                uid = authUser.uid;
            } catch (error: any) {
                if (error.code === 'auth/user-not-found') {
                    const authUser = await auth.createUser({
                        phoneNumber: `+91${phone}`,
                        disabled: false,
                    });
                    uid = authUser.uid;
                } else {
                    throw error;
                }
            }

            // Create Firestore User Document
            const userRef = firestore.collection('users').doc(uid);
            const patientRef = firestore.collection('patients').doc();

            const newUserData = {
                uid,
                phone: `+91${phone}`,
                role: 'patient',
                patientId: patientRef.id,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            };

            const newPatientData = {
                id: patientRef.id,
                primaryUserId: uid,
                name: '', // Placeholder
                age: 0,
                sex: '',
                phone: `+91${phone}`,
                communicationPhone: `+91${phone}`,
                place: 'WhatsApp Magic Link',
                clinicIds: [],
                totalAppointments: 0,
                visitHistory: [],
                relatedPatientIds: [],
                isPrimary: true,
                isKloqoMember: false,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            };

            await firestore.runTransaction(async (t) => {
                t.set(userRef, newUserData);
                t.set(patientRef, newPatientData);
            });
        }

        // 4. Generate Custom Token
        const customToken = await auth.createCustomToken(uid);

        return NextResponse.json({
            customToken,
            redirectPath
        });

    } catch (error: any) {
        console.error('[MagicLogin] Error:', error);
        return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
    }
}
