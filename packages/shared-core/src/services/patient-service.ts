import { collection, query, where, getDocs, doc, updateDoc, serverTimestamp, arrayUnion, writeBatch, getDoc, getFirestore } from 'firebase/firestore';
import { getServerFirebaseApp } from '@kloqo/shared-firebase';
import type { Patient, User } from '@kloqo/shared-types';
import { errorEmitter } from '../utils/error-emitter';
import { FirestorePermissionError } from '../utils/errors';

/**
 * Finds a patient by their phone number.
 * Handles various formats: 9074297611, 919074297611, +919074297611
 */
export async function getPatientByPhone(phone: string): Promise<Patient | null> {
    try {
        const db = getFirestore(getServerFirebaseApp());
        const patientsRef = collection(db, 'patients');

        // Clean phone: remove all non-digits
        const digitsOnly = phone.replace(/\D/g, '');

        // Get the last 10 digits (common local format)
        const local10 = digitsOnly.slice(-10);

        console.log(`[getPatientByPhone] Searching for: ${phone} (local10: ${local10})`);

        // Search for EXACT match first
        const qExact = query(patientsRef, where('phone', '==', phone));
        const snapExact = await getDocs(qExact);
        if (!snapExact.empty) {
            console.log(`[getPatientByPhone] Found patient by exact match: ${snapExact.docs[0].id}`);
            return { id: snapExact.docs[0].id, ...snapExact.docs[0].data() } as Patient;
        }

        // Search for 10-digit version
        const q10 = query(patientsRef, where('phone', '==', local10));
        const snap10 = await getDocs(q10);
        if (!snap10.empty) {
            console.log(`[getPatientByPhone] Found patient by 10-digit match: ${snap10.docs[0].id}`);
            return { id: snap10.docs[0].id, ...snap10.docs[0].data() } as Patient;
        }

        // Search for 91-prefix version
        const q91 = query(patientsRef, where('phone', '==', `91${local10}`));
        const snap91 = await getDocs(q91);
        if (!snap91.empty) {
            console.log(`[getPatientByPhone] Found patient by 91-prefix match: ${snap91.docs[0].id}`);
            return { id: snap91.docs[0].id, ...snap91.docs[0].data() } as Patient;
        }

        // Search for +91-prefix version
        const qPlus91 = query(patientsRef, where('phone', '==', `+91${local10}`));
        const snapPlus91 = await getDocs(qPlus91);
        if (!snapPlus91.empty) {
            console.log(`[getPatientByPhone] Found patient by +91-prefix match: ${snapPlus91.docs[0].id}`);
            return { id: snapPlus91.docs[0].id, ...snapPlus91.docs[0].data() } as Patient;
        }

        console.log(`[getPatientByPhone] No patient found for ${phone}`);
        return null;
    } catch (error: any) {
        console.error('[getPatientByPhone] Error:', error);
        if (error.code === 'permission-denied') {
            console.error('[getPatientByPhone] Security rules blocked access to patients collection.');
        }
        return null;
    }
}

type PatientInput = {
    id?: string; // ID for updating an existing patient
    name: string;
    age?: number;
    place: string;
    sex?: string;
    phone: string; // The user's own phone number, may be empty for relatives
    communicationPhone?: string; // The phone number to use for contact (usually the primary member's)
    clinicId: string;
    bookingFor: 'self' | 'new_related' | 'update';
    bookingUserId?: string; // The primary user's ID, required for 'new_related'
};


/**
 * Manages patient records. This is the authoritative function for creating and updating patients.
 * - Finds or creates users and patients.
 * - Establishes a two-way link between a user and their primary patient record.
 * - Handles adding new relatives to a primary user.
 * @returns The Firestore document ID of the patient record that was created or updated.
 */
export async function managePatient(patientData: PatientInput): Promise<string> {
    const db = getFirestore(getServerFirebaseApp());
    const { id, phone, clinicId, name, age, place, sex, communicationPhone, bookingFor, bookingUserId } = patientData;
    const patientsRef = collection(db, 'patients');
    const usersRef = collection(db, 'users');
    const batch = writeBatch(db);

    try {
        if (bookingFor === 'update' && id) {
            // --- SCENARIO 1: UPDATE EXISTING PATIENT ---
            const patientRef = doc(db, 'patients', id);
            const updateData: any = {
                name: name || '',
                place: place || '',
                phone: phone || '', // Ensure not undefined
                communicationPhone: communicationPhone || phone || '',
                clinicIds: arrayUnion(clinicId),
                updatedAt: serverTimestamp()
            };

            // Only add age and sex if they have values (Firestore doesn't allow undefined)
            if (age !== undefined && age !== null) {
                updateData.age = age;
            }
            if (sex !== undefined && sex !== null && sex !== '') {
                updateData.sex = sex;
            }

            // Clear isLinkPending flag when patient provides their name
            if (name && name.trim().length > 0) {
                updateData.isLinkPending = false;
            }

            // Remove undefined values - Firestore doesn't allow undefined
            const cleanedUpdateData = Object.fromEntries(
                Object.entries(updateData).filter(([_, v]) => v !== undefined)
            );

            batch.update(patientRef, cleanedUpdateData);
            await batch.commit();
            return id;

        } else if (bookingFor === 'new_related' && bookingUserId) {
            // --- SCENARIO 2: ADD A NEW RELATIVE ---
            const primaryPatientRef = doc(patientsRef, bookingUserId);
            const primaryPatientSnap = await getDoc(primaryPatientRef);
            if (!primaryPatientSnap.exists()) {
                throw new Error("Primary patient not found for adding a relative.");
            }
            const primaryPatient = primaryPatientSnap.data() as Patient;

            const newRelativeRef = doc(patientsRef);

            // Check if the phone number matches primary patient's phone (duplicate check)
            const primaryPhone = primaryPatient.phone || primaryPatient.communicationPhone;
            const isDuplicatePhone = phone && phone.trim().length > 0 && primaryPhone &&
                phone.replace(/^\+91/, '') === primaryPhone.replace(/^\+91/, '');

            let newRelativeData: Omit<Patient, 'clinicIds' | 'totalAppointments' | 'visitHistory'>;

            if (phone && phone.trim().length > 0 && !isDuplicatePhone) {
                // If relative has unique phone number, check if phone is unique across ALL patients
                const patientsRef = collection(db, 'patients');
                const patientPhoneQuery = query(patientsRef, where("phone", "==", phone));
                const patientPhoneSnapshot = await getDocs(patientPhoneQuery);

                if (!patientPhoneSnapshot.empty) {
                    throw new Error("This phone number is already registered to another patient.");
                }

                // Check users collection as well
                const userQuery = query(usersRef, where("phone", "==", phone));
                const userSnapshot = await getDocs(userQuery);

                if (!userSnapshot.empty) {
                    throw new Error("This phone number is already registered to another user.");
                }

                // Create user document
                const newUserRef = doc(usersRef);
                const newUserData: User = {
                    uid: newUserRef.id,
                    phone: phone,
                    role: 'patient',
                    patientId: newRelativeRef.id,
                };
                batch.set(newUserRef, newUserData);

                // If relative has phone, they become PRIMARY patient themselves
                newRelativeData = {
                    id: newRelativeRef.id,
                    primaryUserId: newUserRef.id, // Their own user ID since they're primary
                    name: name || '',
                    place: place || '',
                    phone: phone,
                    communicationPhone: communicationPhone || phone,
                    isPrimary: true, // They become primary since they have a phone
                    relatedPatientIds: [], // Empty array - they're primary, relatives will be added later
                    createdAt: serverTimestamp(),
                    updatedAt: serverTimestamp(),
                } as any;

                // Only add age and sex if they have values (Firestore doesn't allow undefined)
                if (age !== undefined && age !== null) {
                    (newRelativeData as any).age = age;
                }
                if (sex !== undefined && sex !== null && sex !== '') {
                    (newRelativeData as any).sex = sex;
                }

                // Relatives created via this flow (with name) are never link-pending
                (newRelativeData as any).isLinkPending = false;
            } else {
                // If duplicate phone or no phone provided, use primary patient's communication phone
                newRelativeData = {
                    id: newRelativeRef.id,
                    name: name || '',
                    place: place || '',
                    phone: '', // Explicitly set to empty string
                    communicationPhone: communicationPhone || primaryPatient.communicationPhone || primaryPatient.phone, // Fallback to primary's phone
                    isPrimary: false,
                    createdAt: serverTimestamp(),
                    updatedAt: serverTimestamp(),
                } as any;

                // Only add age and sex if they have values (Firestore doesn't allow undefined)
                if (age !== undefined && age !== null) {
                    (newRelativeData as any).age = age;
                }
                if (sex !== undefined && sex !== null && sex !== '') {
                    (newRelativeData as any).sex = sex;
                }
                // NO user document created for duplicate phone
            }

            batch.set(newRelativeRef, newRelativeData);

            // Always add to primary's relatedPatientIds, regardless of whether relative has a phone
            // Even if relative has a unique phone and becomes isPrimary: true, they are still a relative of the primary patient
            batch.update(primaryPatientRef, {
                relatedPatientIds: arrayUnion(newRelativeRef.id)
            });
            await batch.commit();
            return newRelativeRef.id;

        } else if (bookingFor === 'self') {
            // --- SCENARIO 3: CREATE A NEW PRIMARY PATIENT ---
            if (!phone) throw new Error("A phone number is required to create a new primary patient.");

            const userQuery = query(usersRef, where('phone', '==', phone));
            const userSnapshot = await getDocs(userQuery);

            if (!userSnapshot.empty) {
                // A user with this phone number already exists.
                const userDoc = userSnapshot.docs[0];
                const existingPatientId = userDoc.data().patientId;
                if (!existingPatientId) {
                    // User exists (e.g. Admin) but has no patient record.
                    // Create a new patient record for them and link it.
                    const newPatientRef = doc(patientsRef);

                    const newPatientData: any = {
                        id: newPatientRef.id,
                        primaryUserId: userDoc.id,
                        name: name || '',
                        place: place || '',
                        phone: phone,
                        communicationPhone: communicationPhone || phone,
                        email: userDoc.data().email || '',
                        clinicIds: [clinicId],
                        totalAppointments: 0,
                        visitHistory: [],
                        relatedPatientIds: [],
                        isPrimary: true,
                        isKloqoMember: false,
                        createdAt: serverTimestamp(),
                        updatedAt: serverTimestamp(),
                    };

                    if (age !== undefined && age !== null) {
                        newPatientData.age = age;
                    }
                    if (sex !== undefined && sex !== null && sex !== '') {
                        newPatientData.sex = sex;
                    }

                    const cleanedPatientData = Object.fromEntries(
                        Object.entries(newPatientData).filter(([_, v]) => v !== undefined)
                    );

                    batch.set(newPatientRef, cleanedPatientData);
                    batch.update(userDoc.ref, { patientId: newPatientRef.id });

                    await batch.commit();
                    return newPatientRef.id;
                }
                const patientRef = doc(db, 'patients', existingPatientId);
                const updateData: any = {
                    name: name || '',
                    place: place || '',
                    communicationPhone: communicationPhone || phone,
                    clinicIds: arrayUnion(clinicId),
                    updatedAt: serverTimestamp()
                };

                // Only add age and sex if they have values (Firestore doesn't allow undefined)
                if (age !== undefined && age !== null) {
                    updateData.age = age;
                }
                if (sex !== undefined && sex !== null && sex !== '') {
                    updateData.sex = sex;
                }

                // Clear isLinkPending flag when patient provides their name
                if (name && name.trim().length > 0) {
                    updateData.isLinkPending = false;
                }

                // Remove undefined values - Firestore doesn't allow undefined
                const cleanedUpdateData = Object.fromEntries(
                    Object.entries(updateData).filter(([_, v]) => v !== undefined)
                );

                await updateDoc(patientRef, cleanedUpdateData);
                return existingPatientId;
            }

            // No user found, so create both a new User and a new Patient.
            const newUserRef = doc(usersRef);
            const newPatientRef = doc(patientsRef);

            const newUserData: User = {
                uid: newUserRef.id,
                phone: phone,
                role: 'patient',
                patientId: newPatientRef.id,
            };

            const newPatientData: any = {
                id: newPatientRef.id,
                primaryUserId: newUserRef.id,
                name: name || '',
                place: place || '',
                phone: phone,
                communicationPhone: communicationPhone || phone,
                email: '',
                clinicIds: [clinicId],
                totalAppointments: 0,
                visitHistory: [],
                relatedPatientIds: [],
                isPrimary: true,
                isKloqoMember: false,
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
            };

            // Only add age and sex if they have values (Firestore doesn't allow undefined)
            if (age !== undefined && age !== null) {
                newPatientData.age = age;
            }
            if (sex !== undefined && sex !== null && sex !== '') {
                newPatientData.sex = sex;
            }

            // Set isLinkPending flag if this is a placeholder patient (no name provided)
            if (!name || name.trim().length === 0) {
                newPatientData.isLinkPending = true;
            }

            // Remove undefined values - Firestore doesn't allow undefined
            const cleanedPatientData = Object.fromEntries(
                Object.entries(newPatientData).filter(([_, v]) => v !== undefined)
            );

            batch.set(newUserRef, newUserData);
            batch.set(newPatientRef, cleanedPatientData);

            await batch.commit();
            return newPatientRef.id;
        } else {
            throw new Error("Invalid parameters provided to managePatient.");
        }

    } catch (error) {
        console.error("Error in managePatient: ", error);
        // Ensure that a specific FirestorePermissionError is not wrapped again
        if (error instanceof FirestorePermissionError) {
            throw error;
        }
        // Wrap other errors
        const permissionError = new FirestorePermissionError({
            path: 'patients or users',
            operation: 'write',
            requestResourceData: patientData
        });
        errorEmitter.emit('permission-error', permissionError);
        throw permissionError;
    }
}

/**
 * Unlinks a relative patient from a primary patient's account.
 * This removes the relative's ID from the primary patient's relatedPatientIds array.
 * The relative's patient document is NOT deleted to preserve historical data.
 */
export async function unlinkRelative(
    primaryPatientId: string,
    relativeId: string
): Promise<void> {
    const db = getFirestore(getServerFirebaseApp());
    const primaryRef = doc(db, 'patients', primaryPatientId);
    const batch = writeBatch(db);

    try {
        // We use a batch just in case we want to add more operations later 
        // (like marking the relative as unlinked in their own doc)
        const { arrayRemove } = await import('firebase/firestore');
        batch.update(primaryRef, {
            relatedPatientIds: arrayRemove(relativeId),
            updatedAt: serverTimestamp()
        });

        await batch.commit();
    } catch (error) {
        console.error("Error in unlinkRelative: ", error);
        const permissionError = new FirestorePermissionError({
            path: `patients/${primaryPatientId}`,
            operation: 'write',
            requestResourceData: { relativeId }
        });
        errorEmitter.emit('permission-error', permissionError);
        throw permissionError;
    }
}
/**
 * Fetches all related patient documents for a given primary patient ID.
 */
export async function getRelativesByPatientId(primaryPatientId: string): Promise<Patient[]> {
    try {
        const db = getFirestore(getServerFirebaseApp());
        const primaryRef = doc(db, 'patients', primaryPatientId);
        const primarySnap = await getDoc(primaryRef);

        if (!primarySnap.exists()) return [];

        const primaryData = primarySnap.data() as Patient;
        const relativeIds = primaryData.relatedPatientIds || [];

        if (relativeIds.length === 0) return [];

        const relatives: Patient[] = [];
        // Firestore 'in' query has a limit of 10, which fits our "relative" use case well
        const chunks = [];
        for (let i = 0; i < relativeIds.length; i += 10) {
            chunks.push(relativeIds.slice(i, i + 10));
        }

        const patientsRef = collection(db, 'patients');
        for (const chunk of chunks) {
            const q = query(patientsRef, where('id', 'in', chunk));
            const snap = await getDocs(q);
            snap.docs.forEach(d => relatives.push({ id: d.id, ...d.data() } as Patient));
        }

        return relatives;
    } catch (error) {
        console.error('[getRelativesByPatientId] Error:', error);
        return [];
    }
}
