import { getFirestore } from 'firebase/firestore';
import { getServerFirebaseApp } from '@kloqo/shared-firebase';
import { completePatientWalkInBooking, PatientBookingPayload } from './booking.service';
import type { Doctor } from '@kloqo/shared-types';

export class WalkInBookingError extends Error {
    status: number;
    code?: string;
    constructor(message: string, status = 400, code?: string) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

interface WalkInPayload {
    patientId: string;
    doctor: Doctor;
    clinicId: string;
    appointmentType: 'Walk-in' | 'Online';
    patientProfile?: any;
    formData: {
        name: string;
        age?: number;
        sex?: string;
        place?: string;
        phone?: string;
    };
}

export async function handleWalkInBooking(payload: WalkInPayload) {
    const firestore = getFirestore(getServerFirebaseApp());
    try {
        return await completePatientWalkInBooking(firestore, payload as PatientBookingPayload);
    } catch (error: any) {
        if (error.message.includes('already have an appointment')) {
            throw new WalkInBookingError(error.message, 409, 'DUPLICATE_APPOINTMENT');
        }
        if (error.message.includes('No walk-in slots')) {
            throw new WalkInBookingError(error.message, 409, 'NO_SLOT_AVAILABLE');
        }
        throw new WalkInBookingError(error.message || 'Failed to process walk-in booking', 500);
    }
}
