import { collection, doc, getDoc, setDoc, updateDoc, increment, serverTimestamp, query, where, getDocs } from 'firebase/firestore';
import { db } from '@kloqo/shared-firebase';
import { parse, format, addMinutes } from 'date-fns';
import type { Appointment } from '@kloqo/shared-types';
import { parseTime } from '../utils/break-helpers';
import { compareAppointments, compareAppointmentsClassic } from './appointment-service';

/**
 * Queue State Interface
 */
export interface QueueState {
    arrivedQueue: Appointment[];      // Confirmed appointments sorted by appointment time
    bufferQueue: Appointment[];        // Top 2 from arrived queue (max 2)
    priorityQueue?: Appointment[];     // Priority appointments (Top of everything)
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

    const allArrived = relevantAppointments
        .filter(apt => apt.status === 'Confirmed');

    // Separate Priority Queue
    const priorityQueue = allArrived
        .filter(apt => apt.isPriority)
        .sort((a, b) => {
            // Sort by priorityAt (FIFO)
            const pA = a.priorityAt?.seconds || 0;
            const pB = b.priorityAt?.seconds || 0;
            return pA - pB;
        });

    // Standard Arrived Queue (excludes priority)
    const arrivedQueue = allArrived
        .filter(apt => !apt.isPriority)
        .sort(tokenDistribution === 'advanced' ? compareAppointments : compareAppointmentsClassic);

    // Buffer Queue: Appointments explicitly marked as being in the buffer (excludes priority)
    // Note: Priority patients effectively "skip" the buffer queue visually, but if they were in buffer before,
    // they are now in priorityQueue. We only show non-priority in buffer queue.
    const bufferQueue = arrivedQueue.filter(apt => apt.isInBuffer);

    // Skipped Queue: Skipped appointments sorted by shared logic
    const skippedQueue = relevantAppointments
        .filter(apt => apt.status === 'Skipped')
        .sort(compareAppointments);

    // Current Consultation:
    // 1. Priority Queue Top
    // 2. Buffer Queue Top
    // 3. Arrived Queue Top (fallback if buffer specific logic isn't used)
    let currentConsultation: Appointment | null = null;
    if (priorityQueue.length > 0) {
        currentConsultation = priorityQueue[0];
    } else if (bufferQueue.length > 0) {
        currentConsultation = bufferQueue[0];
    }

    // Next Break Duration: Calculate duration of the active break block (if any)
    // that appears in this session AND is currently active (current time is within break period)
    // IMPORTANT: If doctor status is 'In', active break is ignored
    const breakAppointments = relevantAppointments
        .filter(apt => apt.status === 'Completed' && apt.patientId === 'dummy-break-patient')
        .sort((a, b) => (a.slotIndex ?? 0) - (b.slotIndex ?? 0));

    let nextBreakDuration: number | null = null;

    if (doctorConsultationStatus !== 'In' && breakAppointments.length > 0) {
        const now = new Date();
        const slotDuration = 15; // Standard dummy slot duration

        // Group break appointments into contiguous blocks
        const blocks: Array<{ start: Date; end: Date }> = [];
        let currentBlock: { start: Date; end: Date } | null = null;
        let lastSlotIndex: number | null = null;

        for (const apt of breakAppointments) {
            try {
                const aptStart = parseAppointmentTime(apt);
                const aptEnd = addMinutes(aptStart, slotDuration);

                if (currentBlock && typeof apt.slotIndex === 'number' && lastSlotIndex !== null && apt.slotIndex === lastSlotIndex + 1) {
                    currentBlock.end = aptEnd;
                } else {
                    currentBlock = { start: aptStart, end: aptEnd };
                    blocks.push(currentBlock);
                }
                lastSlotIndex = apt.slotIndex ?? null;
            } catch (e) {
                console.error('Error parsing break appointment time:', e);
            }
        }

        // Find the active block
        const activeBlock = blocks.find(b => now >= b.start && now < b.end);
        if (activeBlock) {
            const remainingMinutes = Math.ceil((activeBlock.end.getTime() - now.getTime()) / (1000 * 60));
            nextBreakDuration = Math.max(0, remainingMinutes);
        }
    }

    return {
        arrivedQueue,
        bufferQueue,
        priorityQueue,
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
