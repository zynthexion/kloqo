import * as dotenv from 'dotenv';
import * as path from 'path';
import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { generateNextTokenAndReserveSlot } from './packages/shared-core/src/services/appointment-service';
import { getClinicNow } from './packages/shared-core/src/utils/date-utils';

dotenv.config({ path: path.resolve(process.cwd(), 'apps/patient-app/.env.local') });

const firebaseConfig = {
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

async function testCapacity() {
    console.log('--- Testing Capacity Calculation ---');
    const clinicId = '1gGmk8OjegX8iyEUW254'; // Neha Wilson's clinic
    const doctorName = 'Jino Devasia';

    // Test for Jan 9, 2026 (Tomorrow relative to current context Jan 8)
    const testDate = new Date('2026-01-09T10:00:00Z');

    console.log(`Testing booking for ${doctorName} on ${testDate.toDateString()}`);

    try {
        const result = await generateNextTokenAndReserveSlot(
            db,
            clinicId,
            doctorName,
            testDate,
            'A',
            {
                time: '10:00 PM',
                slotIndex: 1, // Assume slot 1 is usually in session 2 or similar
                doctorId: 'doc-1766066333627-yjug38zsr'
            }
        );
        console.log('✅ Success! Token generated:', result.tokenNumber);
        console.log('Reservation ID:', result.reservationId);
    } catch (error: any) {
        console.error('❌ Failed:', error.message);
        if (error.code) console.error('Error Code:', error.code);
    }
}

testCapacity();
