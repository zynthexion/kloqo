import * as dotenv from 'dotenv';
import * as path from 'path';
import { initializeApp } from 'firebase/app';
import { getFirestore, doc, getDoc, collection, query, where, getDocs, Timestamp } from 'firebase/firestore';
import { format } from 'date-fns';

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

const DOCTOR_ID = 'doc-1766066333627-yjug38zsr';
const CLINIC_ID = 'LhfG8x4SZZg1BLmCkpYF'; // Derived from previous logs (or should be fetched)

async function fetchAndAnalyze() {
    console.log('--- STEP 1: Fetching Doctor Details ---');
    const doctorRef = doc(db, 'doctors', DOCTOR_ID);
    const doctorSnap = await getDoc(doctorRef);

    if (!doctorSnap.exists()) {
        console.error('Doctor not found!');
        process.exit(1);
    }

    const doctorData = doctorSnap.data();
    console.log('Doctor Name:', doctorData.name);
    console.log('Consultation Time:', doctorData.averageConsultingTime);
    // console.log('Availability Extension:', JSON.stringify(doctorData.availabilityExtensions, null, 2));

    const todayStr = format(new Date(), 'd MMMM yyyy');
    console.log('Today:', todayStr);

    console.log('--- STEP 2: Fetching Appointments ---');
    const appointmentsRef = collection(db, 'appointments');
    // Fetch Pending, Confirmed, Skipped, No-show, Completed
    const q = query(
        appointmentsRef,
        where('clinicId', '==', doctorData.clinicId),
        where('doctor', '==', doctorData.name),
        where('date', '==', todayStr)
    );

    const snapshot = await getDocs(q);
    console.log(`Found ${snapshot.size} appointments for today.`);

    const appointments = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));

    // Sort by slotIndex
    // @ts-ignore
    appointments.sort((a, b) => (a.slotIndex || 0) - (b.slotIndex || 0));

    console.log('--- APPOINTMENTS ---');
    appointments.forEach((appt: any) => {
        console.log(`[${appt.status}] Slot: ${appt.slotIndex} | Time: ${appt.time} | Session: ${appt.sessionIndex} | ID: ${appt.id} | BookedVia: ${appt.bookedVia}`);
    });

    console.log('--- DOCTOR AVAILABILITY SLOTS (Today) ---');
    const todayDay = format(new Date(), 'EEEE');
    const availability = doctorData.availabilitySlots?.find((s: any) => s.day === todayDay);
    if (availability) {
        console.log(JSON.stringify(availability.timeSlots, null, 2));
    } else {
        console.log('No availability for today.');
    }

    // Check extensions
    // @ts-ignore
    const dateKey = format(new Date(), 'yyyy-MM-dd'); // Assuming key format
    // OR 
    // @ts-ignore
    const dateKey2 = format(new Date(), 'd MMMM yyyy');

    // @ts-ignore
    const ext = doctorData.availabilityExtensions?.[dateKey] || doctorData.availabilityExtensions?.[dateKey2];
    console.log('--- EXTENSIONS ---', ext);

    process.exit(0);
}

fetchAndAnalyze();
