import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import { initializeApp } from 'firebase/app';
import { getFirestore, doc, setDoc, getDocs, deleteDoc, collection, Timestamp, writeBatch } from 'firebase/firestore';

// Load env vars from nurse-app
dotenv.config({ path: path.resolve(process.cwd(), 'apps/nurse-app/.env.local') });

const firebaseConfig = {
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID
};

if (!firebaseConfig.apiKey) {
    console.error('Error: Firebase configurations not found in apps/nurse-app/.env.local');
    process.exit(1);
}

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// Helper to recursively convert serialized timestamps back to Firestore Timestamps
function restoreTimestamps(obj: any): any {
    if (obj === null || typeof obj !== 'object') {
        return obj;
    }

    if (obj.type === 'firestore/timestamp/1.0' && typeof obj.seconds === 'number' && typeof obj.nanoseconds === 'number') {
        return new Timestamp(obj.seconds, obj.nanoseconds);
    }

    if (Array.isArray(obj)) {
        return obj.map(restoreTimestamps);
    }

    const restored: any = {};
    for (const key in obj) {
        restored[key] = restoreTimestamps(obj[key]);
    }
    return restored;
}

async function clearAndRewriteDatabase() {
    const inputPath = path.resolve(process.cwd(), 'appointments.json');
    if (!fs.existsSync(inputPath)) {
        console.error(`Error: ${inputPath} not found.`);
        process.exit(1);
    }

    const rawData = fs.readFileSync(inputPath, 'utf-8');
    const appointments = JSON.parse(rawData);

    console.log('--- STEP 1: Clearing existing appointments ---');
    const appointmentsRef = collection(db, 'appointments');
    const snapshot = await getDocs(appointmentsRef);

    console.log(`Found ${snapshot.size} appointments to delete.`);

    // Delete in batches of 500 (Firestore limit)
    let count = 0;
    while (count < snapshot.docs.length) {
        const batch = writeBatch(db);
        const currentBatch = snapshot.docs.slice(count, count + 500);
        currentBatch.forEach(docSnap => {
            batch.delete(docSnap.ref);
        });
        await batch.commit();
        count += currentBatch.length;
        console.log(`Deleted ${count}/${snapshot.size} appointments...`);
    }
    console.log('Successfully cleared all appointments.');

    console.log('--- STEP 2: Rewriting appointments from JSON ---');
    console.log(`Starting rewrite for ${appointments.length} appointments...`);

    // Write in batches for efficiency
    let writeCount = 0;
    while (writeCount < appointments.length) {
        const batch = writeBatch(db);
        const currentBatch = appointments.slice(writeCount, writeCount + 500);
        currentBatch.forEach((appt: any) => {
            const { id, ...data } = appt;
            const restoredData = restoreTimestamps(data);
            const docRef = doc(db, 'appointments', id);
            batch.set(docRef, restoredData);
        });
        await batch.commit();
        writeCount += currentBatch.length;
        console.log(`Rewritten ${writeCount}/${appointments.length} appointments...`);
    }

    console.log('Finished clearing and rewriting database.');
}

clearAndRewriteDatabase();
