import {
    getFirestore,
    doc,
    serverTimestamp,
    runTransaction,
    collection,
    query,
    where,
    getDocs,
    getDoc,
    updateDoc,
    arrayUnion,
    increment,
    Timestamp,
} from 'firebase/firestore';
import { format, parse, addMinutes, subMinutes, differenceInMinutes, isSameDay, parseISO, isAfter } from 'date-fns';
import { getServerFirebaseApp } from '@kloqo/shared-firebase';
import { calculateWalkInDetails, generateNextTokenAndReserveSlot } from './walk-in.service';

import type { Doctor } from '@kloqo/shared-types';

const ACTIVE_STATUSES = ['Pending', 'Confirmed', 'Skipped', 'Completed'];
const MAX_RETRY_ATTEMPTS = 3;

type BreakInterval = { start: Date; end: Date };

// Build break intervals from session breakPeriods for a given date/session
function buildSessionBreakIntervalsFromPeriods(
    doctor: Doctor | null,
    referenceDate: Date | null,
    sessionIndex: number | null | undefined
): BreakInterval[] {
    if (!doctor?.breakPeriods || !referenceDate || sessionIndex == null) return [];
    const dateKey = format(referenceDate, 'd MMMM yyyy');
    const breaksForDate = doctor.breakPeriods[dateKey] || [];
    return breaksForDate
        .filter((bp: any) => bp.sessionIndex === sessionIndex)
        .map((bp: any) => {
            return {
                start: parseISO(bp.startTime),
                end: parseISO(bp.endTime),
            };
        })
        .filter((interval: BreakInterval) => !isNaN(interval.start.getTime()) && !isNaN(interval.end.getTime()))
        .sort((a, b) => a.start.getTime() - b.start.getTime());
}

// Legacy leaveSlots-based intervals (kept as fallback)
function buildBreakIntervals(doctor: Doctor | null, referenceDate: Date | null): BreakInterval[] {
    if (!doctor?.leaveSlots || !referenceDate) return [];

    const consultationTime = doctor.averageConsultingTime || 15;

    const slotsForDay = (doctor.leaveSlots || [])
        .map((leave) => {
            if (typeof leave === 'string') {
                try {
                    return parseISO(leave);
                } catch {
                    return null;
                }
            }
            if (leave && typeof (leave as any).toDate === 'function') {
                try {
                    return (leave as any).toDate();
                } catch {
                    return null;
                }
            }
            if (leave instanceof Date) {
                return leave;
            }
            return null;
        })
        .filter((date): date is Date => !!date && !isNaN(date.getTime()) && isSameDay(date, referenceDate))
        .sort((a, b) => a.getTime() - b.getTime());

    if (slotsForDay.length === 0) return [];

    const intervals: BreakInterval[] = [];
    let currentInterval: BreakInterval | null = null;

    for (const slot of slotsForDay) {
        if (!currentInterval) {
            currentInterval = { start: slot, end: addMinutes(slot, consultationTime) };
            continue;
        }

        if (slot.getTime() === currentInterval.end.getTime()) {
            currentInterval.end = addMinutes(slot, consultationTime);
        } else {
            intervals.push(currentInterval);
            currentInterval = { start: slot, end: addMinutes(slot, consultationTime) };
        }
    }

    if (currentInterval) intervals.push(currentInterval);
    return intervals;
}

function applyBreakOffsets(originalTime: Date, intervals: BreakInterval[]): Date {
    return intervals.reduce((acc, interval) => {
        if (acc.getTime() >= interval.start.getTime()) {
            const offset = differenceInMinutes(interval.end, interval.start);
            return addMinutes(acc, offset);
        }
        return acc;
    }, new Date(originalTime));
}

function getSessionEndForDate(
    doctor: Doctor | null,
    referenceDate: Date | null,
    sessionIndex: number | null | undefined
): Date | null {
    if (!doctor?.availabilitySlots || !referenceDate || sessionIndex == null) return null;

    const dayOfWeek = format(referenceDate, 'EEEE');
    const availabilityForDay = doctor.availabilitySlots.find((slot: any) => slot.day === dayOfWeek);
    if (!availabilityForDay?.timeSlots?.length) return null;
    if (sessionIndex < 0 || sessionIndex >= availabilityForDay.timeSlots.length) return null;

    const session = availabilityForDay.timeSlots[sessionIndex];
    let sessionEnd = parse(session.to, 'hh:mm a', referenceDate);

    const dateKey = format(referenceDate, 'd MMMM yyyy');
    const extensions = (doctor as any).availabilityExtensions as
        | { [date: string]: { sessions: Array<{ sessionIndex: number; newEndTime?: string; totalExtendedBy?: number }> } }
        | undefined;
    const sessionExtension = extensions?.[dateKey]?.sessions?.find((s) => s.sessionIndex === sessionIndex);

    if (sessionExtension?.newEndTime && (sessionExtension.totalExtendedBy ?? 0) > 0) {
        try {
            const extendedEnd = parse(sessionExtension.newEndTime, 'hh:mm a', referenceDate);
            if (extendedEnd.getTime() > sessionEnd.getTime()) {
                sessionEnd = extendedEnd;
            }
        } catch {
            // ignore malformed extension
        }
    }

    return sessionEnd;
}

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
    const { patientId, doctor, clinicId, appointmentType, patientProfile, formData } = payload;

    if (!patientId || !doctor?.name || !clinicId) {
        throw new WalkInBookingError('Missing required fields', 400, 'MISSING_FIELDS');
    }

    const appointmentDate = new Date();
    const appointmentDateStr = format(appointmentDate, 'd MMMM yyyy');

    const duplicateCheckQuery = query(
        collection(firestore, 'appointments'),
        where('patientId', '==', patientId),
        where('doctor', '==', doctor.name),
        where('date', '==', appointmentDateStr),
        where('status', 'in', ACTIVE_STATUSES)
    );
    const duplicateSnapshot = await getDocs(duplicateCheckQuery);
    if (!duplicateSnapshot.empty) {
        throw new WalkInBookingError('You already have an appointment today with this doctor.', 409, 'DUPLICATE_APPOINTMENT');
    }

    const patientRef = doc(firestore, 'patients', patientId);
    const patientDoc = await getDoc(patientRef);
    const patientData = patientDoc.data();
    const communicationPhone = patientData?.communicationPhone || patientData?.phone || formData.phone || '';

    let lastError: WalkInBookingError | Error | null = null;

    for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
        try {
            const walkInDetails = await calculateWalkInDetails(firestore, doctor);

            if (
                !walkInDetails ||
                walkInDetails.slotIndex == null ||
                walkInDetails.sessionIndex == null ||
                !walkInDetails.estimatedTime
            ) {
                throw new WalkInBookingError('Unable to find a valid slot for walk-in booking.', 409, 'NO_SLOT_AVAILABLE');
            }

            const tokenResult = await generateNextTokenAndReserveSlot(
                firestore,
                clinicId,
                doctor.name,
                appointmentDate,
                'W',
                {
                    time: format(walkInDetails.estimatedTime, 'hh:mm a'),
                    slotIndex: walkInDetails.slotIndex,
                    doctorId: doctor.id,
                }
            );

            const {
                tokenNumber,
                numericToken,
                slotIndex: actualSlotIndex,
                sessionIndex: actualSessionIndex,
                time: adjustedTime,
                reservationId,
            } = tokenResult;

            if (!tokenNumber || actualSlotIndex == null || !reservationId) {
                throw new WalkInBookingError('Failed to reserve a token for walk-in booking.', 409, 'TOKEN_RESERVATION_FAILED');
            }

            const slotTimeString =
                adjustedTime ||
                (() => {
                    const fallbackDate = walkInDetails.actualSlotTime ?? walkInDetails.estimatedTime;
                    return format(fallbackDate, 'hh:mm a');
                })();

            const appointmentDateOnly = parse(appointmentDateStr, 'd MMMM yyyy', appointmentDate);
            const slotDateTime = parse(slotTimeString, 'hh:mm a', appointmentDateOnly);

            // Apply break time offsets (prefer session breakPeriods, fallback to leaveSlots)
            const sessionIndex =
                actualSessionIndex ??
                (() => {
                    if (walkInDetails.sessionIndex != null) return walkInDetails.sessionIndex;
                    return 0;
                })();
            const sessionIntervals = buildSessionBreakIntervalsFromPeriods(doctor, appointmentDate, sessionIndex);
            const leaveIntervals = buildBreakIntervals(doctor, appointmentDate);
            const breakIntervals = sessionIntervals.length > 0 ? sessionIntervals : leaveIntervals;
            const adjustedSlotDateTime = applyBreakOffsets(slotDateTime, breakIntervals);
            const adjustedSlotTimeString = format(adjustedSlotDateTime, 'hh:mm a');

            // Validate that appointment end time (adjustedSlotDateTime + consultationTime) doesn't exceed session end
            const availabilityEnd = getSessionEndForDate(doctor, appointmentDate, sessionIndex);
            if (availabilityEnd) {
                const consultationTime = doctor.averageConsultingTime || 15;
                const appointmentEndTime = addMinutes(adjustedSlotDateTime, consultationTime);
                if (isAfter(appointmentEndTime, availabilityEnd)) {
                    throw new WalkInBookingError(
                        `This walk-in time (~${adjustedSlotTimeString}) is outside the doctor's availability (ends at ${format(availabilityEnd, 'hh:mm a')}).`,
                        400,
                        'OUTSIDE_AVAILABILITY'
                    );
                }
            }

            const cutOffTime = subMinutes(adjustedSlotDateTime, 15);
            const noShowTime = addMinutes(adjustedSlotDateTime, 15);

            const appointmentRef = doc(collection(firestore, 'appointments'));

            const appointmentData = {
                bookedVia: 'Walk-in',
                clinicId,
                doctorId: doctor.id,
                date: appointmentDateStr,
                department: doctor.department,
                doctor: doctor.name,
                sex: formData.sex,
                age: formData.age,
                patientId,
                patientName: formData.name,
                communicationPhone,
                place: formData.place,
                status: 'Confirmed',
                // Keep original slot time string in `time`, use adjusted for arriveBy/cutoff/noshow
                time: slotTimeString,
                arriveByTime: adjustedSlotTimeString,
                tokenNumber,
                numericToken,
                slotIndex: actualSlotIndex,
                sessionIndex,
                treatment: 'General Consultation',
                createdAt: serverTimestamp(),
                cutOffTime: Timestamp.fromDate(cutOffTime),
                noShowTime: Timestamp.fromDate(noShowTime),
                patientProfile: patientProfile ?? null,
                walkInPatientsAhead: walkInDetails.patientsAhead,
                walkInMetadata: {
                    estimatedDetails: walkInDetails,
                    attemptNumber: attempt + 1,
                },
            };

            await runTransaction(firestore, async (transaction) => {
                const reservationRef = doc(firestore, 'slot-reservations', reservationId);
                const reservationDoc = await transaction.get(reservationRef);

                if (!reservationDoc.exists()) {
                    throw new WalkInBookingError('This slot has already been booked.', 409, 'SLOT_ALREADY_BOOKED');
                }

                const reservationData = reservationDoc.data();
                if (
                    reservationData?.slotIndex !== actualSlotIndex ||
                    reservationData?.clinicId !== clinicId ||
                    reservationData?.doctorName !== doctor.name
                ) {
                    throw new WalkInBookingError('Slot reservation mismatch detected.', 409, 'RESERVATION_MISMATCH');
                }

                // Re-validate availability inside transaction to prevent race conditions
                // This ensures that even if two requests pass initial validation, only valid ones are created
                const sessionEnd = getSessionEndForDate(doctor, appointmentDate, sessionIndex);
                if (sessionEnd) {
                    const consultationTime = doctor.averageConsultingTime || 15;
                    const appointmentEndTime = addMinutes(adjustedSlotDateTime, consultationTime);
                    if (isAfter(appointmentEndTime, sessionEnd)) {
                        throw new WalkInBookingError(
                            `This walk-in time (~${adjustedSlotTimeString}) is outside the doctor's availability (ends at ${format(sessionEnd, 'hh:mm a')}).`,
                            400,
                            'OUTSIDE_AVAILABILITY'
                        );
                    }
                }

                transaction.update(reservationRef, {
                    status: 'booked',
                    appointmentId: appointmentRef.id,
                    bookedAt: serverTimestamp(),
                });

                transaction.set(appointmentRef, {
                    ...appointmentData,
                    id: appointmentRef.id,
                });
            });

            await updateDoc(patientRef, {
                clinicIds: arrayUnion(clinicId),
                totalAppointments: increment(1),
                visitHistory: arrayUnion(appointmentRef.id),
                updatedAt: serverTimestamp(),
            });

            return {
                success: true,
                appointmentId: appointmentRef.id,
                tokenNumber,
                numericToken,
                estimatedTime: walkInDetails.estimatedTime.toISOString(),
                patientsAhead: walkInDetails.patientsAhead,
                estimatedDetails: {
                    slotIndex: actualSlotIndex,
                    sessionIndex,
                    estimatedTime: walkInDetails.estimatedTime.toISOString(),
                    patientsAhead: walkInDetails.patientsAhead,
                    numericToken,
                    actualSlotTime: walkInDetails.actualSlotTime?.toISOString() ?? null,
                },
            };
        } catch (error) {
            const err = error instanceof WalkInBookingError ? error : new WalkInBookingError(String(error || 'Unknown error'), 500);

            if (
                (err.code === 'SLOT_ALREADY_BOOKED' || err.code === 'RESERVATION_MISMATCH' || err.code === 'TOKEN_RESERVATION_FAILED') &&
                attempt < MAX_RETRY_ATTEMPTS - 1
            ) {
                lastError = err;
                await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
                continue;
            }

            throw err;
        }
    }

    throw (lastError as WalkInBookingError) ?? new WalkInBookingError('Unable to complete walk-in booking.', 500);
}
