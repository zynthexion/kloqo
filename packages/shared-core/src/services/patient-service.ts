import { collection, query, where, getDocs, doc, updateDoc, serverTimestamp, arrayUnion, writeBatch, getDoc, getFirestore } from 'firebase/firestore';
import { getServerFirebaseApp } from '@kloqo/shared-firebase';
import type { Patient, User } from '@kloqo/shared-types';
import { errorEmitter } from '../utils/error-emitter';
import { FirestorePermissionError } from '../utils/errors';

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
