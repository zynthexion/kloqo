import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs } from 'firebase/firestore';

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

console.log('Firebase Project ID:', firebaseConfig.projectId);

if (!firebaseConfig.apiKey) {
    console.error('Error: Firebase configurations not found in apps/nurse-app/.env.local');
    process.exit(1);
}

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

async function fetchAppointments() {
    console.log('Fetching appointments from database...');
    try {
        const appointmentsRef = collection(db, 'appointments');
        const snapshot = await getDocs(appointmentsRef);
        const appointments = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));

        const outputPath = path.resolve(process.cwd(), 'appointments.json');
        fs.writeFileSync(outputPath, JSON.stringify(appointments, null, 2));
        console.log(`Successfully saved ${appointments.length} appointments to ${outputPath}`);
    } catch (error) {
        console.error('Error fetching appointments:', error);
        process.exit(1);
    }
}

fetchAppointments();
