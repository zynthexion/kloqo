
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load environment variables from .env.local
dotenv.config({ path: path.resolve(__dirname, '../apps/nurse-app/.env.local') });

const serviceAccount = JSON.parse(process.env.FIREBASE_PRIVATE_KEY || '{}');

// Initialize Firebase Admin
if (!getApps().length) {
    initializeApp({
        credential: cert(serviceAccount),
        projectId: process.env.FIREBASE_PROJECT_ID,
    });
}

const db = getFirestore();

async function setClinicShortCode() {
    const clinicId = 'Bf9sjSwugEO5C4ImNZYx'; // Kloqo Test Clinic
    const shortCode = 'KQ-TEST';

    console.log(`Assigning short code ${shortCode} to clinic ${clinicId}...`);

    try {
        await db.collection('clinics').doc(clinicId).update({
            shortCode: shortCode,
            shortCodeUpdatedAt: new Date().toISOString()
        });
        console.log('✅ Successfully updated clinic document!');
        console.log(`Try sending "${shortCode}" to your WhatsApp bot now.`);
    } catch (error) {
        console.error('❌ Error updating clinic:', error);
    }
}

setClinicShortCode();
