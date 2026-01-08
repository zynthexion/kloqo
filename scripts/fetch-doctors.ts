import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs } from 'firebase/firestore';

dotenv.config({ path: path.resolve(process.cwd(), 'apps/nurse-app/.env.local') });

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

async function fetchDoctors() {
    try {
        const doctorsRef = collection(db, 'doctors');
        const snapshot = await getDocs(doctorsRef);
        const doctors = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));

        const outputPath = path.resolve(process.cwd(), 'doctors.json');
        fs.writeFileSync(outputPath, JSON.stringify(doctors, null, 2));
        console.log(`Successfully saved ${doctors.length} doctors to ${outputPath}`);
    } catch (error) {
        console.error('Error fetching doctors:', error);
        process.exit(1);
    }
}

fetchDoctors();
