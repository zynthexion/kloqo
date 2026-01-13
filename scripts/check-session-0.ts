import * as dotenv from 'dotenv';
import * as path from 'path';
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, query, where, getDocs } from 'firebase/firestore';
import { format } from 'date-fns';

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

const DOCTOR_ID = 'doc-1766066333627-yjug38zsr';
// Clinic ID from previous script output check is better, but I'll query directly by doctor name/date to be safe or just fetch doctor first.
// Just duplicate fetch for safety.
import { doc, getDoc } from 'firebase/firestore';

async function checkSession0() {
    const doctorRef = doc(db, 'doctors', DOCTOR_ID);
    const doctorSnap = await getDoc(doctorRef);
    const doctorData = doctorSnap.data();

    const todayStr = format(new Date(), 'd MMMM yyyy');
    const appointmentsRef = collection(db, 'appointments');
    const q = query(
        appointmentsRef,
        where('clinicId', '==', doctorData?.clinicId),
        where('doctor', '==', doctorData?.name),
        where('date', '==', todayStr),
        where('status', 'in', ['Pending', 'Confirmed', 'Skipped', 'No-show'])
    );

    const snapshot = await getDocs(q);
    const validApps = snapshot.docs.map(d => d.data());

    // Check Session 0 (Index 0)
    // Sometimes sessionIndex is not saved? Rely on slotIndex?
    // Session 0: 12:00 - 1:00. Slot Indices usually 0-12 (approx). 
    // Wait, DB stores SEGMENTED indices? 
    // Session 0: 0-999?
    // Session 1: 1000-1999?
    // Session 2: 2000-2999?
    // Let's count based on this heuristic.

    const session0Apps = validApps.filter(a => {
        if (typeof a.sessionIndex === 'number') return a.sessionIndex === 0;
        if (typeof a.slotIndex === 'number') return a.slotIndex < 1000;
        return false;
    });

    console.log(`Active Appointments in Session 0: ${session0Apps.length}`);
    session0Apps.forEach(a => console.log(` - [${a.status}] ${a.patientName} (${a.time})`));

    process.exit(0);
}

checkSession0();
