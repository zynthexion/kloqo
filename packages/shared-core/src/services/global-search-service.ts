
import { db } from '@kloqo/shared-firebase';
import { collection, getDocs, query, where } from 'firebase/firestore';

export class GlobalSearchService {
    /**
     * Fetches all clinics and their doctors' specialties to provide context for the AI.
     * This allows the AI to recommend clinics based on specialty or symptoms.
     */
    static async getGlobalHealthcareContext(): Promise<string> {
        try {
            console.log('[GlobalSearchService] Fetching global healthcare context...');

            // 1. Fetch all clinics
            const clinicsRef = collection(db, 'clinics');
            const clinicsSnap = await getDocs(clinicsRef);

            if (clinicsSnap.empty) {
                return "No clinics found in the system.";
            }

            let contextLines: string[] = ["Available Clinics and Specialties:"];

            for (const clinicDoc of clinicsSnap.docs) {
                const clinicData = clinicDoc.data();
                const clinicId = clinicDoc.id;
                const clinicName = clinicData.name || 'Unknown Clinic';
                const shortCode = clinicData.shortCode || 'No Code';

                // 2. Fetch doctors for this clinic to get specialties
                const doctorsRef = collection(db, 'doctors');
                const dQuery = query(doctorsRef, where('clinicId', '==', clinicId));
                const dSnap = await getDocs(dQuery);

                const specialties = new Set<string>();
                dSnap.docs.forEach(d => {
                    const dData = d.data();
                    if (dData.specialty) {
                        specialties.add(dData.specialty);
                    }
                });

                const specialtyList = specialties.size > 0
                    ? Array.from(specialties).join(', ')
                    : 'General Healthcare';

                contextLines.push(`- ${clinicName} (Code: ${shortCode}): Specialties: ${specialtyList}`);
            }

            return contextLines.join('\n');
        } catch (error) {
            console.error('[GlobalSearchService] Error fetching context:', error);
            return "Error retrieving clinic information.";
        }
    }
}
