
import { NextRequest, NextResponse } from 'next/server';
import { getFirebaseAdmin, MagicLinkService, getServerFirebaseApp } from '@kloqo/shared-core';
import { getFirestore, collection, query, where, getDocs, doc, setDoc, serverTimestamp, updateDoc } from 'firebase/firestore';

export async function POST(request: NextRequest) {
    try {
        const { magicToken } = await request.json();

        if (!magicToken) {
            return NextResponse.json({ error: 'Magic token is required' }, { status: 400 });
        }

        const firestore = getFirestore(getServerFirebaseApp());

        // 1. Verify the magic token
        const magicData = await MagicLinkService.verifyToken(firestore, magicToken);
        if (!magicData) {
            return NextResponse.json({ error: 'Invalid or expired magic token' }, { status: 401 });
        }

        const { phone, redirectPath } = magicData;
        const admin = getFirebaseAdmin();
        const auth = admin.auth();

        // 2. Lookup user by phone
        const usersRef = collection(firestore, 'users');
        const q = query(usersRef, where('phone', '==', `+91${phone}`), where('role', '==', 'patient'));
        const querySnapshot = await getDocs(q);

        let uid: string;

        if (!querySnapshot.empty) {
            // User exists
            uid = querySnapshot.docs[0].id;
            console.log(`[MagicLogin] Found existing user: ${uid} for phone: ${phone}`);
        } else {
            // 3. User does not exist - CREATE PLACEHOLDER (Scenario from User Request)
            console.log(`[MagicLogin] Phone ${phone} not found. Creating placeholder user/patient.`);

            // Create Firebase Auth User
            const authUser = await auth.createUser({
                phoneNumber: `+91${phone}`,
                disabled: false,
            });
            uid = authUser.uid;

            // Create Firestore User Document
            const userRef = doc(firestore, 'users', uid);
            const patientRef = doc(collection(firestore, 'patients'));

            const newUserData = {
                uid,
                phone: `+91${phone}`,
                role: 'patient',
                patientId: patientRef.id,
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp()
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
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp()
            };

            await Promise.all([
                setDoc(userRef, newUserData),
                setDoc(patientRef, newPatientData)
            ]);
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
