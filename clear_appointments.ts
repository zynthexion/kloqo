
import { db } from './packages/shared-firebase/src/index.ts';
import { collection, getDocs, deleteDoc, doc, writeBatch } from 'firebase/firestore';

async function clearAppointments() {
    console.log('Starting clearing of appointments collection for today...');
    try {
        const appointmentsRef = collection(db, 'appointments');
        const snapshot = await getDocs(appointmentsRef);
        console.log(`Found ${snapshot.docs.length} appointments total.`);

        const batch = writeBatch(db);
        let count = 0;

        snapshot.docs.forEach(docSnap => {
            batch.delete(docSnap.ref);
            count++;
        });

        if (count > 0) {
            await batch.commit();
            console.log(`Successfully deleted ${count} appointments.`);
        } else {
            console.log('No appointments to delete.');
        }
    } catch (error) {
        console.error('Error during clear:', error);
    }
}

clearAppointments();
