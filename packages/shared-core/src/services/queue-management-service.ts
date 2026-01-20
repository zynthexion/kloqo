import { collection, doc, getDoc, setDoc, updateDoc, increment, serverTimestamp, query, where, getDocs } from 'firebase/firestore';
import { db } from '@kloqo/shared-firebase';
import { parse, format } from 'date-fns';
import type { Appointment } from '@kloqo/shared-types';
import { parseTime } from '../utils/break-helpers';
import { compareAppointments, compareAppointmentsClassic } from './appointment-service';

/**
 * Queue State Interface
 */
export interface QueueState {
    arrivedQueue: Appointment[];      // Confirmed appointments sorted by appointment time
    bufferQueue: Appointment[];        // Top 2 from arrived queue (max 2)
    skippedQueue: Appointment[];       // Skipped appointments
    currentConsultation: Appointment | null; // Currently consulting (if any)
    consultationCount: number;         // Count of completed consultations for this doctor/session
    nextBreakDuration: number | null;  // Duration of the next break in minutes
}

/**
 * Consultation Counter Document ID
 */
export function getConsultationCounterId(
    clinicId: string,
    doctorId: string,
    date: string,
    sessionIndex: number
): string {
    return `${clinicId}_${doctorId}_${date}_${sessionIndex}`.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '');
}

/**
 * Get or Initialize Consultation Counter
 */
export async function getConsultationCount(
    clinicId: string,
    doctorId: string,
    date: string,
    sessionIndex: number
): Promise<number> {
    try {
        const counterId = getConsultationCounterId(clinicId, doctorId, date, sessionIndex);
        const counterRef = doc(db, 'consultation-counters', counterId);
        const counterDoc = await getDoc(counterRef);

        if (counterDoc.exists()) {
            return counterDoc.data()?.count || 0;
        }

        // Initialize counter if doesn't exist
        await setDoc(counterRef, {
            clinicId,
            doctorId,
            date,
            sessionIndex,
            count: 0,
            lastUpdated: serverTimestamp(),
        });

        return 0;
    } catch (error) {
        console.error('Error getting consultation count:', error);
        return 0;
    }
}

/**
 * Increment Consultation Counter
 */
export async function incrementConsultationCounter(
    clinicId: string,
    doctorId: string,
    date: string,
    sessionIndex: number
): Promise<void> {
    const counterId = getConsultationCounterId(clinicId, doctorId, date, sessionIndex);
    const counterRef = doc(db, 'consultation-counters', counterId);

    try {
        await updateDoc(counterRef, {
            count: increment(1),
            lastUpdated: serverTimestamp(),
        });
    } catch (error) {
        console.error('Error incrementing consultation counter:', error);
        // If document doesn't exist, create it
        try {
            await setDoc(counterRef, {
                clinicId,
                doctorId,
                date,
                sessionIndex,
                count: 1,
                lastUpdated: serverTimestamp(),
            });
        } catch (createError) {
            console.error('Error creating consultation counter:', createError);
        }
    }
}

/**
 * Compute Queues from Appointments
 */
export async function computeQueues(
    appointments: Appointment[],
    doctorName: string,
    doctorId: string,
    clinicId: string,
    date: string,
    sessionIndex: number,
    doctorConsultationStatus?: 'In' | 'Out',
    tokenDistribution?: 'classic' | 'advanced'
): Promise<QueueState> {
    // Get consultation count
    const consultationCount = await getConsultationCount(clinicId, doctorId, date, sessionIndex);

    // Filter appointments for this doctor, date, and session
    const relevantAppointments = appointments.filter(apt =>
        apt.doctor === doctorName &&
        apt.date === date &&
        (apt.sessionIndex === undefined || apt.sessionIndex === sessionIndex)
    );

    // Parse appointment time helper
    const parseAppointmentTime = (apt: Appointment): Date => {
        try {
            const appointmentDate = parse(apt.date, 'd MMMM yyyy', new Date());
            return parseTime(apt.time, appointmentDate);
        } catch {
            return new Date(0); // Fallback for invalid dates
        }
    };

    const arrivedQueue = relevantAppointments
        .filter(apt => apt.status === 'Confirmed')
        .sort(tokenDistribution === 'advanced' ? compareAppointments : compareAppointmentsClassic);

    // Buffer Queue: Appointments explicitly marked as being in the buffer
    const bufferQueue = arrivedQueue.filter(apt => apt.isInBuffer);

    // Skipped Queue: Skipped appointments sorted by shared logic
    const skippedQueue = relevantAppointments
        .filter(apt => apt.status === 'Skipped')
        .sort(compareAppointments);

    // Current Consultation: First appointment in Buffer Queue (if any)
    const currentConsultation = bufferQueue.length > 0 ? bufferQueue[0] : null;

    // Next Break Duration: Calculate duration of the first block of dummy break appointments 
    // that appear in this session AND are currently active (current time is within break period)
    // IMPORTANT: If doctor status is 'In', break is considered over regardless of scheduled time
    const breakAppointments = relevantAppointments
        .filter(apt => apt.status === 'Completed' && apt.patientId === 'dummy-break-patient')
        .sort((a, b) => (a.slotIndex ?? 0) - (b.slotIndex ?? 0));

    let nextBreakDuration: number | null = null;

    // If doctor is 'In', they're actively consulting, so no break should be shown
    if (doctorConsultationStatus !== 'In' && breakAppointments.length > 0) {
        // Check if we're currently within the break period
        const now = new Date();
        const firstBreak = breakAppointments[0];
        const lastBreak = breakAppointments[breakAppointments.length - 1];

        try {
            const breakStartTime = parseAppointmentTime(firstBreak);
            const breakEndTime = parseAppointmentTime(lastBreak);
            // Add slot duration (5 mins) to get actual end time
            breakEndTime.setMinutes(breakEndTime.getMinutes() + 5);

            // Only show break duration if current time is within the break period
            if (now >= breakStartTime && now < breakEndTime) {
                // Calculate remaining minutes until break ends
                const remainingMinutes = Math.ceil((breakEndTime.getTime() - now.getTime()) / (1000 * 60));
                nextBreakDuration = Math.max(0, remainingMinutes);
            }
        } catch (error) {
            console.error('Error calculating break duration:', error);
        }
    }

    return {
        arrivedQueue,
        bufferQueue,
        skippedQueue,
        currentConsultation,
        consultationCount,
        nextBreakDuration,
    };
}

/**
 * Calculate Walk-in Position in Arrived Queue
 */
export function calculateWalkInPosition(
    arrivedQueue: Appointment[],
    consultationCount: number,
    walkInTokenAllotment: number
): number {
    // If consultation hasn't started, reference is first person
    if (consultationCount === 0) {
        return walkInTokenAllotment; // After walkInTokenAllotment people
    }

    // If consultation started, reference is next person
    // Position = consultationCount + walkInTokenAllotment
    return consultationCount + walkInTokenAllotment;
}


/**
 * Get Next Token from Buffer Queue or Arrived Queue
 * If buffer queue is empty, return top token from arrived queue
 */
export function getNextTokenFromBuffer(bufferQueue: Appointment[], arrivedQueue: Appointment[]): Appointment | null {
    // If buffer queue has tokens, return top one
    if (bufferQueue.length > 0) {
        return bufferQueue[0];
    }
    // If buffer queue is empty, return top token from arrived queue
    if (arrivedQueue.length > 0) {
        return arrivedQueue[0];
    }
    return null;
}

/**
 * Check if A token takes precedence over W token at same time
 */
export function compareTokens(a: Appointment, b: Appointment): number {
    return compareAppointments(a, b);
}
