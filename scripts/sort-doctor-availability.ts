import * as dotenv from 'dotenv';
import * as path from 'path';
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, doc, updateDoc } from 'firebase/firestore';
import { format, parse } from 'date-fns';

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

const daysOfWeek = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

async function sortDoctorAvailability() {
    console.log('Fetching doctors from database...');
    try {
        const doctorsRef = collection(db, 'doctors');
        const snapshot = await getDocs(doctorsRef);
        console.log(`Found ${snapshot.size} doctors.`);

        for (const doctorDoc of snapshot.docs) {
            const doctorData = doctorDoc.data();
            const doctorId = doctorDoc.id;
            const doctorName = doctorData.name;

            if (!doctorData.availabilitySlots || !Array.isArray(doctorData.availabilitySlots)) {
                console.log(`Skipping Dr. ${doctorName} (No availability slots)`);
                continue;
            }

            console.log(`Processing Dr. ${doctorName}...`);

            // Sort timeSlots within each availabilitySlot
            const updatedAvailabilitySlots = doctorData.availabilitySlots.map((slot: any) => {
                const sortedTimeSlots = [...slot.timeSlots].sort((a: any, b: any) => {
                    const timeA = parse(a.from, 'hh:mm a', new Date());
                    const timeB = parse(b.from, 'hh:mm a', new Date());
                    return timeA.getTime() - timeB.getTime();
                });
                return { ...slot, timeSlots: sortedTimeSlots };
            });

            // Re-generate schedule string
            const scheduleString = updatedAvailabilitySlots
                .sort((a: any, b: any) => daysOfWeek.indexOf(a.day) - daysOfWeek.indexOf(b.day))
                .map((slot: any) => `${slot.day}: ${slot.timeSlots.map((ts: any) => `${ts.from}-${ts.to}`).join(', ')}`)
                .join('; ');

            // Update doctor document
            await updateDoc(doc(db, 'doctors', doctorId), {
                availabilitySlots: updatedAvailabilitySlots,
                schedule: scheduleString
            });

            console.log(`Successfully fixed availability for Dr. ${doctorName}`);
        }

        console.log('Finished fixing all doctors.');
    } catch (error) {
        console.error('Error fixing doctor availability:', error);
        process.exit(1);
    }
}

sortDoctorAvailability();
