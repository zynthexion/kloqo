

import { db } from '@kloqo/shared-firebase';

import { collection, query, where, getDocs, updateDoc, doc, getDoc } from 'firebase/firestore';

export class CodeService {
    private static readonly CODE_PREFIX = 'KQ-';

    /**
     * Generates a deterministic 4-digit code based on the clinic ID.
     * Format: KQ-XXXX (e.g., KQ-A1B2)
     */
    static generateClinicCode(clinicId: string): string {
        // Take the last 4 characters of the ID, or a specific slice if needed
        // Using last 4 chars of the ID is simple and likely unique enough for this scale
        const suffix = clinicId.slice(-4).toUpperCase();
        return `${this.CODE_PREFIX}${suffix}`;
    }

    /**
     * Assigns a short code to a clinic if it doesn't have one.
     */
    static async ensureClinicCode(clinicId: string): Promise<string> {
        const clinicRef = doc(db, 'clinics', clinicId);
        const clinicSnap = await getDoc(clinicRef);

        if (!clinicSnap.exists()) {
            throw new Error(`Clinic ${clinicId} not found`);
        }

        const data = clinicSnap.data();
        if (data.shortCode) {
            return data.shortCode;
        }

        const newCode = this.generateClinicCode(clinicId);

        // Check for collision (unlikely with this method but good practice)
        const existing = await this.getClinicByCode(newCode);
        if (existing && existing.id !== clinicId) {
            // Fallback: Generate a random 4-digit hex if collision
            const randomSuffix = Math.floor(Math.random() * 0xFFFF).toString(16).toUpperCase().padStart(4, '0');
            const randomCode = `${this.CODE_PREFIX}${randomSuffix}`;
            await updateDoc(clinicRef, { shortCode: randomCode });
            return randomCode;
        }

        await updateDoc(clinicRef, { shortCode: newCode });
        return newCode;
    }

    /**
     * Finds a clinic by its short code (case-insensitive).
     */
    static async getClinicByCode(code: string): Promise<{ id: string; name: string } | null> {
        // Normalize code: remove spaces, uppercase
        const normalizedCode = code.replace(/\s+/g, '').toUpperCase();

        // Ensure prefix
        let searchCode = normalizedCode;
        if (!searchCode.startsWith(this.CODE_PREFIX)) {
            // If user just sent "1234", assume KQ-1234
            searchCode = `${this.CODE_PREFIX}${searchCode}`;
        }

        const q = query(collection(db, 'clinics'), where('shortCode', '==', searchCode));
        const querySnapshot = await getDocs(q);

        if (querySnapshot.empty) {
            return null;
        }

        const doc = querySnapshot.docs[0];
        return {
            id: doc.id,
            name: doc.data().name as string
        };
    }
}
