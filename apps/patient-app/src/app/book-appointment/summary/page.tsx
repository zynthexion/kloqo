'use client';

import { useState, useEffect, useCallback, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { format, getDay, isBefore, addMinutes, isSameDay, subMinutes, parse, differenceInMinutes, parseISO, isAfter } from 'date-fns';
import { ArrowLeft, Calendar, Clock, Loader2, User, Phone, MapPin } from 'lucide-react';
import Link from 'next/link';

import { useFirestore } from '@/firebase';
import { doc, getDoc, addDoc, collection, serverTimestamp, getDocs, query, where, setDoc, updateDoc, deleteDoc, DocumentReference, arrayUnion, increment, runTransaction } from 'firebase/firestore';
import type { Doctor, Patient, Appointment } from '@/lib/types';
import { generateNextToken, generateNextTokenAndReserveSlot } from '@kloqo/shared-core';


import { Card, CardContent } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { useUser } from '@/firebase/auth/use-user';
import { errorEmitter } from '@/firebase/error-emitter';
import { FirestorePermissionError } from '@/firebase/errors';
import { parseTime, getArriveByTime } from '@/lib/utils';
import { sendAppointmentConfirmedNotification, sendAppointmentRescheduledNotification } from '@/lib/notification-service';
import { useLanguage } from '@/contexts/language-context';
import { useMasterDepartments } from '@/hooks/use-master-departments';
import { getLocalizedDepartmentName } from '@/lib/department-utils';
import { formatDate, formatDayOfWeek } from '@/lib/date-utils';
import { Skeleton } from '@/components/ui/skeleton';
import { LottieAnimation } from '@/components/lottie-animation';
import successAnimation from '@/lib/animations/success.json';
import { getDoctorFromCache, saveDoctorToCache } from '@/lib/doctor-cache';
import { getPatientFromCache, savePatientToCache } from '@/lib/patient-cache';
import { AuthGuard } from '@/components/auth-guard';
import { FullScreenLoader } from '@/components/full-screen-loader';


const daysOfWeek = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

type BookingStatus = 'summary' | 'success';

type BreakInterval = {
    start: Date;
    end: Date;
};

function buildBreakIntervals(doctor: Doctor | null, targetDate: Date | null): BreakInterval[] {
    return [];
}

function applyBreakOffsets(baseTime: Date, intervals: BreakInterval[]): Date {
    return intervals.reduce((acc, interval) => {
        if (acc.getTime() >= interval.start.getTime()) {
            return addMinutes(acc, differenceInMinutes(interval.end, interval.start));
        }
        return acc;
    }, new Date(baseTime));
}

// Prevent static generation - this page requires Firebase context
export const dynamic = 'force-dynamic';

// Helper function to find session end time for a given slot (returns arrive-by time)
function findSessionEndTime(doctor: Doctor | null, selectedSlot: Date | null): string | null {
    if (!doctor || !selectedSlot) return null;

    const dayOfWeek = format(selectedSlot, 'EEEE');
    const availabilitySlot = doctor.availabilitySlots?.find((slot: any) => slot.day === dayOfWeek);

    if (!availabilitySlot?.timeSlots) return null;

    // Find which session the slot belongs to
    for (const session of availabilitySlot.timeSlots) {
        try {
            const sessionStart = parse(session.from, 'hh:mm a', selectedSlot);
            const sessionEnd = parse(session.to, 'hh:mm a', selectedSlot);

            // Check if selected slot falls within this session
            if (selectedSlot >= sessionStart && selectedSlot <= sessionEnd) {
                // Return session end minus 15 minutes (arrive-by time)
                return format(subMinutes(sessionEnd, 15), 'hh:mm a');
            }
        } catch (e) {
            continue;
        }
    }

    return null;
}

function BookingSummaryPage() {


    const router = useRouter();
    const searchParams = useSearchParams();
    const firestore = useFirestore();
    const { user } = useUser();
    const { toast } = useToast();
    const { t, language } = useLanguage();
    const { departments } = useMasterDepartments();

    const doctorId = searchParams.get('doctorId');
    const slotISO = searchParams.get('slot');
    const patientId = searchParams.get('patientId');
    const isEditMode = searchParams.get('edit') === 'true';
    const appointmentId = searchParams.get('appointmentId');

    // Progressive loading: Try cache first for instant display
    const cachedDoctor = doctorId ? getDoctorFromCache(doctorId) : null;
    const cachedPatient = patientId ? getPatientFromCache(patientId) : null;
    const [doctor, setDoctor] = useState<Doctor | null>(cachedDoctor);
    const [patient, setPatient] = useState<Patient | null>(cachedPatient);
    const [loading, setLoading] = useState(!cachedDoctor || !cachedPatient); // Don't show loading if we have both cached
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [status, setStatus] = useState<BookingStatus>('summary');
    const [generatedToken, setGeneratedToken] = useState<string>('');
    const [appointmentDate, setAppointmentDate] = useState<string>('');
    const [appointmentTime, setAppointmentTime] = useState<string>('');
    const [bookedAppointmentId, setBookedAppointmentId] = useState<string>('');
    const [appointmentArriveByTime, setAppointmentArriveByTime] = useState<string>('');
    const [noShowTime, setNoShowTime] = useState<Date | null>(null);

    const [hasBookingFailed, setHasBookingFailed] = useState(false);


    const selectedSlot = slotISO ? new Date(slotISO) : null;

    const resolveSlotDetails = useCallback(
        (targetSlotIndex: number, appointmentDate: Date) => {
            const effectiveDoctor = doctor || cachedDoctor;
            if (!effectiveDoctor?.availabilitySlots?.length) {
                return null;
            }

            const dayOfWeek = format(appointmentDate, 'EEEE');
            const availabilityForDay = effectiveDoctor.availabilitySlots.find(session => session.day === dayOfWeek);
            if (!availabilityForDay || !availabilityForDay.timeSlots?.length) {
                return null;
            }

            const slotDuration = effectiveDoctor.averageConsultingTime || 15;
            let globalSlotIndex = 0;

            for (let sessionIdx = 0; sessionIdx < availabilityForDay.timeSlots.length; sessionIdx++) {
                const session = availabilityForDay.timeSlots[sessionIdx];
                let currentTime = parse(session.from, 'hh:mm a', appointmentDate);
                const sessionEnd = parse(session.to, 'hh:mm a', appointmentDate);

                while (isBefore(currentTime, sessionEnd)) {
                    if (globalSlotIndex === targetSlotIndex) {
                        return {
                            sessionIndex: sessionIdx,
                            slotDate: currentTime,
                        };
                    }

                    currentTime = addMinutes(currentTime, slotDuration);
                    globalSlotIndex++;
                }
            }

            return null;
        },
        [doctor, cachedDoctor]
    );

    const fetchData = useCallback(async () => {
        if (!doctorId || !patientId || !firestore) {
            setLoading(false);
            return;
        }

        // Show loading only if we don't have both cached
        if (!cachedDoctor || !cachedPatient) {
            setLoading(true);
        }

        try {
            const doctorDocRef = doc(firestore, 'doctors', doctorId);
            const patientDocRef = doc(firestore, 'patients', patientId);

            const [doctorDoc, patientDoc] = await Promise.all([
                getDoc(doctorDocRef),
                getDoc(patientDocRef),
            ]);

            if (doctorDoc.exists()) {
                const currentDoctor = { id: doctorDoc.id, ...doctorDoc.data() } as Doctor;
                setDoctor(currentDoctor);
                // Cache doctor data for faster next visit
                saveDoctorToCache(doctorId, currentDoctor);
            } else {
                toast({ variant: 'destructive', title: t.bookAppointment.error, description: t.bookAppointment.doctorNotFound });
            }

            if (patientDoc.exists()) {
                const currentPatient = { id: patientDoc.id, ...patientDoc.data() } as Patient;
                setPatient(currentPatient);
                // Cache patient data for faster next visit
                savePatientToCache(patientId, currentPatient);
            } else {
                toast({ variant: 'destructive', title: t.bookAppointment.error, description: t.patientForm.formValidationError });
            }
        } catch (error) {
            console.error('Error fetching details:', error);
            toast({ variant: 'destructive', title: t.bookAppointment.error, description: t.bookAppointment.incompleteDetails });
        } finally {
            setLoading(false);
        }
    }, [doctorId, patientId, firestore, toast, t, cachedDoctor, cachedPatient]);

    useEffect(() => {
        fetchData();
    }, [fetchData]);



    const handleConfirmBooking = async () => {
        setHasBookingFailed(false);
        const effectiveDoctor = doctor || cachedDoctor;
        const effectivePatient = patient || cachedPatient;
        if (!effectiveDoctor || !effectivePatient || !selectedSlot || !user || !firestore) {
            toast({ variant: "destructive", title: t.bookAppointment.error, description: t.bookAppointment.incompleteDetails });
            return;
        }

        // Use effective doctor/patient for the rest of the function
        const finalDoctor = effectiveDoctor;
        const finalPatient = effectivePatient;
        setIsSubmitting(true);

        const releaseReservation = async (reservationId?: string | null, delayMs: number = 0) => {
            if (!reservationId) return;
            if (delayMs > 0) {
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
            try {
                await deleteDoc(doc(firestore, 'slot-reservations', reservationId));
                console.log('🧹 [RESERVATION] Released slot reservation:', reservationId);
            } catch (error) {
                console.warn('⚠️ [RESERVATION] Failed to release reservation:', { reservationId, error });
            }
        };

        try {
            // If editing, update existing appointment with new token logic
            if (isEditMode && appointmentId) {
                // Edit existing appointment - regenerate token using same logic as new appointment
                const appointmentRef = doc(firestore, "appointments", appointmentId);

                // Get existing appointment data
                const existingAppointmentSnap = await getDoc(appointmentRef);
                if (!existingAppointmentSnap.exists()) {
                    toast({
                        variant: "destructive",
                        title: t.bookAppointment.error,
                        description: t.appointments.appointmentHistory
                    });
                    setIsSubmitting(false);
                    return;
                }

                const existingData = existingAppointmentSnap.data();
                const oldDate = existingData.date;
                const oldTime = existingData.time;
                const appointmentDateStr = format(selectedSlot, "d MMMM yyyy");
                // Auto-assign the lowest available slotIndex for rescheduled appointment (ignores selectedSlot time)
                let slotIndex = -1;
                let sessionIndex = -1;
                let finalSlotTime: Date | null = null;
                const dayOfWeek = daysOfWeek[getDay(selectedSlot)];
                const availabilityForDay = finalDoctor.availabilitySlots?.find(s => s.day === dayOfWeek);
                const slotDuration = finalDoctor.averageConsultingTime || 15;

                // Fetch all existing appointments for this doctor/date to find occupied slotIndices (excluding current appointment)
                const allAppointmentsQuery = query(
                    collection(firestore, "appointments"),
                    where("doctor", "==", finalDoctor.name),
                    where("clinicId", "==", finalDoctor.clinicId),
                    where("date", "==", appointmentDateStr),
                    where("status", "in", ["Pending", "Confirmed"])
                );

                const allAppointmentsSnapshot = await getDocs(allAppointmentsQuery);
                const occupiedSlotIndices = new Set(
                    allAppointmentsSnapshot.docs
                        .filter(doc => doc.id !== appointmentId) // Exclude current appointment
                        .map(doc => {
                            const data = doc.data();
                            // Both A and W tokens block slots (exclusive slots)
                            return data.slotIndex;
                        })
                        .filter(index => index !== null && index !== undefined && typeof index === 'number')
                );

                // Find the lowest available slotIndex
                // CRITICAL: A tokens must follow these rules when rescheduling:
                // 1. Cannot book slots in the past (always skip past slots)
                // 2. Cannot book slots within 1 hour from now (reserved for W tokens)
                if (availabilityForDay) {
                    let globalSlotIndex = 0;
                    const now = new Date();
                    const isToday = isSameDay(selectedSlot, now);
                    // Calculate 1-hour window: A tokens can only book slots at least 1 hour in the future
                    const oneHourFromNow = addMinutes(now, 60);

                    for (let i = 0; i < availabilityForDay.timeSlots.length; i++) {
                        const session = availabilityForDay.timeSlots[i];
                        let currentTime = parseTime(session.from, 'hh:mm a', appointmentDate);
                        const endTime = parseTime(session.to, 'hh:mm a', appointmentDate);

                        while (isBefore(currentTime, endTime)) {
                            // CRITICAL RULE 1: Skip ALL past slots (not just for today)
                            // A tokens cannot book slots that have already passed
                            if (isBefore(currentTime, now)) {
                                console.log('🚫 [A TOKEN RESCHEDULE] Skipping past slot:', {
                                    slotIndex: globalSlotIndex,
                                    slotTime: format(currentTime, 'hh:mm a'),
                                    currentTime: format(now, 'hh:mm a'),
                                    reason: 'Slot is in the past'
                                });
                                currentTime = addMinutes(currentTime, slotDuration);
                                globalSlotIndex++;
                                continue;
                            }

                            // CRITICAL RULE 2: Skip slots within 1-hour window (reserved for W tokens)
                            // A tokens can only book slots that are at least 1 hour in the future
                            if (isBefore(currentTime, oneHourFromNow)) {
                                console.log('🚫 [A TOKEN RESCHEDULE] Skipping slot within 1-hour window:', {
                                    slotIndex: globalSlotIndex,
                                    slotTime: format(currentTime, 'hh:mm a'),
                                    oneHourFromNow: format(oneHourFromNow, 'hh:mm a'),
                                    reason: 'Slots within 1 hour are reserved for walk-in tokens'
                                });
                                currentTime = addMinutes(currentTime, slotDuration);
                                globalSlotIndex++;
                                continue;
                            }

                            // Check if this slotIndex is available
                            if (!occupiedSlotIndices.has(globalSlotIndex)) {
                                // Final validation: Ensure slot is not in the past and is outside 1-hour window
                                if (!isBefore(currentTime, now) && !isBefore(currentTime, oneHourFromNow)) {
                                    slotIndex = globalSlotIndex;
                                    sessionIndex = i;
                                    finalSlotTime = currentTime;
                                    console.log('✅ [A TOKEN RESCHEDULE] Selected available slot:', {
                                        slotIndex: globalSlotIndex,
                                        slotTime: format(currentTime, 'hh:mm a'),
                                        isPast: false,
                                        isWithinOneHour: false
                                    });
                                    break;
                                }
                            }

                            currentTime = addMinutes(currentTime, slotDuration);
                            globalSlotIndex++;
                        }

                        if (slotIndex !== -1) break;
                    }
                }

                if (slotIndex === -1 || !finalSlotTime) {
                    toast({
                        variant: "destructive",
                        title: t.bookAppointment.error,
                        description: "No available slots found for this date. Please select another date.",
                    });
                    setIsSubmitting(false);
                    return;
                }

                // Generate new token and reserve slot using same logic as new appointment
                let tokenNumber: string;
                let numericToken: number;
                let actualSlotIndex = slotIndex;
                let resolvedSessionIndex = sessionIndex;
                let resolvedTimeString = format(finalSlotTime, "hh:mm a");
                let reservationId: string | undefined;
                let tokenData: Awaited<ReturnType<typeof generateNextTokenAndReserveSlot>> | null = null;
                const bookingPayload = {
                    time: format(finalSlotTime, "hh:mm a"),
                    slotIndex,
                    doctorId: finalDoctor.id,
                } as const;
                try {
                    tokenData = await generateNextTokenAndReserveSlot(
                        firestore,
                        finalDoctor.clinicId,
                        finalDoctor.name,
                        finalSlotTime,
                        'A',
                        bookingPayload
                    );
                } catch (error: any) {
                    if (error.code === 'SLOT_OCCUPIED' || error.message === 'SLOT_ALREADY_BOOKED') {
                        console.warn('[BOOKING FLOW DEBUG] Reschedule slot conflict detected. Auto-selecting next slot.', {
                            requestedSlotIndex: slotIndex,
                            appointmentDate: appointmentDateStr,
                        });
                        try {
                            tokenData = await generateNextTokenAndReserveSlot(
                                firestore,
                                finalDoctor.clinicId,
                                finalDoctor.name,
                                finalSlotTime,
                                'A',
                                {
                                    ...bookingPayload,
                                    slotIndex: -1,
                                }
                            );
                            toast({
                                variant: "default",
                                title: "Time Slot Updated",
                                description: "The selected slot was just booked, so we assigned the next available slot automatically.",
                            });
                        } catch (retryError: any) {
                            toast({
                                variant: "destructive",
                                title: "Slot Already Booked",
                                description: "This time slot was just booked. Please select another time.",
                            });
                            setIsSubmitting(false);
                            return;
                        }
                    } else if (error.code === 'A_CAPACITY_REACHED') {
                        toast({
                            variant: "destructive",
                            title: "No Slots Available",
                            description: "Advance booking capacity has been reached for this doctor today. Please choose another day.",
                        });
                        setIsSubmitting(false);
                        return;
                    } else {
                        throw error;
                    }
                }

                if (!tokenData) {
                    throw new Error('Failed to generate token for reschedule.');
                }

                tokenNumber = tokenData.tokenNumber;
                numericToken = tokenData.numericToken;
                actualSlotIndex = tokenData.slotIndex;
                resolvedSessionIndex = tokenData.sessionIndex ?? resolvedSessionIndex;
                resolvedTimeString = tokenData.time ?? resolvedTimeString;
                reservationId = tokenData.reservationId;

                const appointmentDateObj = parse(appointmentDateStr, "d MMMM yyyy", new Date());
                const resolvedDetails = resolveSlotDetails(actualSlotIndex, appointmentDateObj);

                if (!tokenData.time && resolvedDetails) {
                    resolvedTimeString = format(resolvedDetails.slotDate, "hh:mm a");
                }

                if (!tokenData.sessionIndex && resolvedDetails) {
                    resolvedSessionIndex = resolvedDetails.sessionIndex;
                }

                const appointmentData = {
                    date: appointmentDateStr,
                    time: resolvedTimeString,
                    clinicId: finalDoctor.clinicId,
                    doctorId: finalDoctor.id,
                    doctor: finalDoctor.name,
                    department: finalDoctor.department,
                    tokenNumber: tokenNumber,
                    numericToken: numericToken,
                    slotIndex: actualSlotIndex,
                    sessionIndex: resolvedSessionIndex,
                };

                try {
                    await updateDoc(appointmentRef, appointmentData);
                } catch (serverError: any) {
                    await releaseReservation(reservationId);
                    const permissionError = new FirestorePermissionError({
                        path: appointmentRef.path,
                        operation: 'update',
                        requestResourceData: appointmentData,
                    });
                    errorEmitter.emit('permission-error', permissionError);
                    throw permissionError;
                }

                await releaseReservation(reservationId, 2000);

                // Send rescheduled notification if date or time changed
                if ((oldDate !== appointmentData.date || oldTime !== appointmentData.time) && user?.uid && firestore) {
                    try {
                        await sendAppointmentRescheduledNotification({
                            firestore,
                            userId: user.uid,
                            appointmentId: appointmentId,
                            doctorName: finalDoctor.name,
                            oldDate: oldDate,
                            newDate: appointmentData.date,
                            time: appointmentData.time,
                            tokenNumber: appointmentData.tokenNumber,
                        });
                        console.log('Appointment rescheduled notification sent');
                    } catch (notifError) {
                        console.error('Failed to send rescheduled notification:', notifError);
                    }
                }

                toast({
                    title: t.messages.appointmentRescheduled,
                    description: t.messages.appointmentRescheduledSuccess,
                });

                // Store appointment date and time for success page
                setAppointmentDate(appointmentData.date);
                setAppointmentTime(appointmentData.time);
                setGeneratedToken(appointmentData.tokenNumber);
                setBookedAppointmentId(appointmentId);

                // Fetch the appointment to get the noShowTime from database
                try {
                    const appointmentDoc = await getDoc(appointmentRef);
                    if (appointmentDoc.exists()) {
                        const updatedAppointmentData = appointmentDoc.data();
                        if (updatedAppointmentData.noShowTime) {
                            // Convert Firestore Timestamp to Date
                            const noShowTimeValue = updatedAppointmentData.noShowTime;
                            const noShowDate = noShowTimeValue?.toDate ? noShowTimeValue.toDate() : new Date(noShowTimeValue);
                            setNoShowTime(noShowDate);
                        }
                    }
                } catch (error) {
                    console.error('Error fetching noShowTime:', error);
                }

                setStatus('success');
                return;
            }

            // New appointment - Auto-assign the lowest available slotIndex (ignores selectedSlot time)
            const appointmentDateStr = format(selectedSlot, "d MMMM yyyy");
            let slotIndex = -1;
            let sessionIndex = -1;
            let finalSlotTime: Date | null = null;
            const dayOfWeek = daysOfWeek[getDay(selectedSlot)];
            const availabilityForDay = finalDoctor.availabilitySlots?.find(s => s.day === dayOfWeek);

            // Check for duplicates
            const duplicateCheckQuery = query(
                collection(firestore, "appointments"),
                where("patientId", "==", finalPatient.id),
                where("doctor", "==", finalDoctor.name),
                where("date", "==", appointmentDateStr),
                where("status", "in", ["Pending", "Confirmed", "Completed", "Skipped"])
            );

            const duplicateSnapshot = await getDocs(duplicateCheckQuery);
            if (!duplicateSnapshot.empty) {
                toast({
                    variant: "destructive",
                    title: "Duplicate Booking",
                    description: "This patient already has an appointment with this doctor on this date.",
                });
                setIsSubmitting(false);
                return;
            }

            const appointmentRef = doc(collection(firestore, "appointments"));
            const slotDuration = finalDoctor.averageConsultingTime || 15;

            // Fetch all existing appointments for this doctor/date to find occupied slotIndices
            // Include No-show appointments so A tokens can reuse those slots
            const allAppointmentsQuery = query(
                collection(firestore, "appointments"),
                where("doctor", "==", finalDoctor.name),
                where("clinicId", "==", finalDoctor.clinicId),
                where("date", "==", appointmentDateStr)
            );

            const allAppointmentsSnapshot = await getDocs(allAppointmentsQuery);

            // Create a map of slotIndex to appointment for checking vacancy
            const appointmentsBySlotIndex = new Map<number, Appointment>();
            allAppointmentsSnapshot.docs.forEach(doc => {
                const data = doc.data() as Appointment;
                const slotIdx = data.slotIndex;
                if (slotIdx !== null && slotIdx !== undefined && typeof slotIdx === 'number') {
                    appointmentsBySlotIndex.set(slotIdx, data);
                }
            });

            // Only consider Pending and Confirmed as occupied (No-show, Skipped, Cancelled, Completed are vacant)
            const occupiedSlotIndices = new Set(
                Array.from(appointmentsBySlotIndex.entries())
                    .filter(([_, apt]) => apt.status === 'Pending' || apt.status === 'Confirmed')
                    .map(([slotIdx, _]) => slotIdx)
            );

            // Calculate total slots for the day to determine reserved W slots
            let totalSlotsForDay = 0;
            if (availabilityForDay) {
                for (let i = 0; i < availabilityForDay.timeSlots.length; i++) {
                    const session = availabilityForDay.timeSlots[i];
                    let currentTime = parseTime(session.from, selectedSlot);
                    const endTime = parseTime(session.to, selectedSlot);
                    while (isBefore(currentTime, endTime)) {
                        totalSlotsForDay++;
                        currentTime = addMinutes(currentTime, slotDuration);
                    }
                }
            }
            const reservedWSlotsCount = Math.ceil(totalSlotsForDay * 0.15); // Last 15% reserved for W
            const reservedWSlotsStart = totalSlotsForDay - reservedWSlotsCount; // e.g., slot 22 out of 24

            // Find the lowest available slotIndex (excluding reserved W slots for A tokens)
            // CRITICAL: A tokens must follow these rules:
            // 1. Cannot book slots in the past (always skip past slots)
            // 2. Cannot book slots within 1 hour from now (reserved for W tokens)
            // 3. Cannot book reserved W slots (last 15% of slots)
            if (availabilityForDay) {
                let globalSlotIndex = 0;
                const now = new Date();
                const isToday = isSameDay(selectedSlot, now);
                // Calculate 1-hour window: A tokens can only book slots at least 1 hour in the future
                const oneHourFromNow = addMinutes(now, 60);

                for (let i = 0; i < availabilityForDay.timeSlots.length; i++) {
                    const session = availabilityForDay.timeSlots[i];
                    let currentTime = parseTime(session.from, selectedSlot);
                    const endTime = parseTime(session.to, selectedSlot);

                    while (isBefore(currentTime, endTime)) {
                        // CRITICAL RULE 1: Skip ALL past slots (not just for today)
                        // A tokens cannot book slots that have already passed
                        if (isBefore(currentTime, now)) {
                            console.log('🚫 [A TOKEN] Skipping past slot:', {
                                slotIndex: globalSlotIndex,
                                slotTime: format(currentTime, 'hh:mm a'),
                                currentTime: format(now, 'hh:mm a'),
                                reason: 'Slot is in the past'
                            });
                            currentTime = addMinutes(currentTime, slotDuration);
                            globalSlotIndex++;
                            continue;
                        }

                        // CRITICAL RULE 2: Skip slots within 1-hour window (reserved for W tokens)
                        // A tokens can only book slots that are at least 1 hour in the future
                        if (isBefore(currentTime, oneHourFromNow)) {
                            console.log('🚫 [A TOKEN] Skipping slot within 1-hour window:', {
                                slotIndex: globalSlotIndex,
                                slotTime: format(currentTime, 'hh:mm a'),
                                oneHourFromNow: format(oneHourFromNow, 'hh:mm a'),
                                reason: 'Slots within 1 hour are reserved for walk-in tokens'
                            });
                            currentTime = addMinutes(currentTime, slotDuration);
                            globalSlotIndex++;
                            continue;
                        }

                        // CRITICAL RULE 3: For A tokens, skip reserved W slots (last 15% of slots)
                        const isReservedW = globalSlotIndex >= reservedWSlotsStart;
                        if (isReservedW) {
                            console.log('🚫 [A TOKEN] Skipping reserved W slot:', {
                                slotIndex: globalSlotIndex,
                                reservedWSlotsStart,
                                reason: 'Reserved for walk-in tokens'
                            });
                            currentTime = addMinutes(currentTime, slotDuration);
                            globalSlotIndex++;
                            continue;
                        }

                        // Check if this slotIndex is available
                        // A slot is available if:
                        // 1. Not occupied by Pending/Confirmed appointment
                        // 2. OR has a No-show appointment (can be reused)
                        const appointment = appointmentsBySlotIndex.get(globalSlotIndex);
                        const isOccupied = occupiedSlotIndices.has(globalSlotIndex);
                        const isNoShow = appointment?.status === 'No-show';

                        if (!isOccupied || isNoShow) {
                            // Final validation: Ensure slot is not in the past and is outside 1-hour window
                            if (!isBefore(currentTime, now) && !isBefore(currentTime, oneHourFromNow)) {
                                slotIndex = globalSlotIndex;
                                sessionIndex = i;
                                finalSlotTime = currentTime;
                                console.log('✅ [A TOKEN] Selected available slot:', {
                                    slotIndex: globalSlotIndex,
                                    slotTime: format(currentTime, 'hh:mm a'),
                                    isPast: false,
                                    isWithinOneHour: false,
                                    isReservedW: false
                                });
                                break;
                            }
                        }

                        currentTime = addMinutes(currentTime, slotDuration);
                        globalSlotIndex++;
                    }

                    if (slotIndex !== -1) break;
                }
            }

            if (slotIndex === -1 || !finalSlotTime) {
                toast({
                    variant: "destructive",
                    title: t.bookAppointment.error,
                    description: "No available slots found for this date. Please select another date.",
                });
                setIsSubmitting(false);
                return;
            }

            const baseAppointmentData: Omit<
                Appointment,
                | 'time'
                | 'arriveByTime'
                | 'slotIndex'
                | 'sessionIndex'
                | 'tokenNumber'
                | 'numericToken'
                | 'treatment'
                | 'createdAt'
                | 'cutOffTime'
                | 'noShowTime'
                | 'delay'
            > = {
                id: appointmentRef.id,
                bookedVia: 'Online',
                clinicId: finalDoctor.clinicId,
                doctorId: finalDoctor.id,
                date: appointmentDateStr,
                department: finalDoctor.department,
                doctor: finalDoctor.name,
                sex: (finalPatient.sex && (finalPatient.sex === 'Male' || finalPatient.sex === 'Female' || finalPatient.sex === 'Other')) ? finalPatient.sex : 'Other',
                age: finalPatient.age,
                patientId: finalPatient.id,
                patientName: finalPatient.name,
                communicationPhone: finalPatient.communicationPhone || finalPatient.phone || user?.phoneNumber || '',
                place: finalPatient.place || '',
                status: "Pending",
            };

            // Generate token and reserve slot in one atomic transaction
            // This prevents A token collisions and ensures sequential token numbering
            let tokenNumber: string;
            let numericToken: number;
            let actualSlotIndex: number = slotIndex;
            let resolvedSessionIndex = sessionIndex;
            let resolvedTimeString = format(finalSlotTime, "hh:mm a");
            let reservationId: string | undefined;
            let tokenData: Awaited<ReturnType<typeof generateNextTokenAndReserveSlot>> | null = null;
            const bookingRequestId = `booking-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            const tokenRequestPayload = {
                time: format(finalSlotTime, "hh:mm a"),
                slotIndex,
                doctorId: finalDoctor.id,
            } as const;

            try {
                console.log(`[BOOKING FLOW DEBUG] ${bookingRequestId}: About to call generateNextTokenAndReserveSlot`, {
                    slotIndex,
                    time: tokenRequestPayload.time,
                    timestamp: new Date().toISOString()
                });

                tokenData = await generateNextTokenAndReserveSlot(
                    firestore,
                    finalDoctor.clinicId,
                    finalDoctor.name,
                    finalSlotTime,
                    'A',
                    tokenRequestPayload
                );
            } catch (error: any) {
                console.error(`[BOOKING FLOW DEBUG] ${bookingRequestId}: Error in generateNextTokenAndReserveSlot`, {
                    error,
                    errorMessage: error?.message,
                    errorCode: error?.code,
                    isSafari: typeof navigator !== 'undefined' && /^((?!chrome|android).)*safari/i.test(navigator.userAgent),
                    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown'
                });

                // Check for timeout errors (Safari-specific)
                if (error?.message?.includes('timeout')) {
                    toast({
                        variant: "destructive",
                        title: "Booking Timeout",
                        description: "The booking request timed out. This may be a Safari browser issue. Please try again or use a different browser.",
                    });
                    setIsSubmitting(false);
                    return;
                }

                if (error.code === 'SLOT_OCCUPIED' || error.message === 'SLOT_ALREADY_BOOKED' || error.code === 'SLOT_ALREADY_BOOKED' || error.message === 'No available slots match the booking rules.') {
                    console.warn(`[BOOKING FLOW DEBUG] ${bookingRequestId}: Requested slot taken.`);

                    // Show specific toast for conflict
                    toast({
                        variant: "destructive",
                        title: "Slot Already Booked",
                        description: "Whoops! Someone else booked this slot, try again to get the next slot.",
                        duration: 5000,
                    });

                    // Calculate next slot time (add consultation duration or default 15 mins)
                    const slotDuration = finalDoctor.averageConsultingTime || 15;
                    const nextSlotTime = addMinutes(finalSlotTime, slotDuration);
                    const nextSlotISO = nextSlotTime.toISOString();

                    // Update URL to trigger re-render with new slot
                    // This will update 'selectedSlot' and the 'Arrive by' display automatically
                    const params = new URLSearchParams(searchParams.toString());
                    params.set('slot', nextSlotISO);
                    router.replace(`?${params.toString()}`);

                    // Stop submission loading state so user can click "Confirm Booking" again
                    setIsSubmitting(false);
                    setHasBookingFailed(true);
                    return;
                } else if (error.code === 'A_CAPACITY_REACHED') {
                    toast({
                        variant: "destructive",
                        title: "No Slots Available",
                        description: "Advance booking capacity has been reached for this doctor today. Please choose another day.",
                    });
                    setIsSubmitting(false);
                    return;
                } else {
                    throw error;
                }
            }

            if (!tokenData) {
                throw new Error('Failed to reserve slot for appointment.');
            }

            console.log(`[BOOKING FLOW DEBUG] ${bookingRequestId}: generateNextTokenAndReserveSlot SUCCESS`, {
                tokenNumber: tokenData.tokenNumber,
                numericToken: tokenData.numericToken,
                slotIndex: tokenData.slotIndex,
                reservationId: tokenData.reservationId,
                timestamp: new Date().toISOString(),
                autoSelected: slotIndex !== tokenData.slotIndex,
            });

            actualSlotIndex = tokenData.slotIndex; // Use the actual slotIndex returned from the function

            // CRITICAL: Verify and correct token to match slotIndex
            // Token should be slotIndex + 1 (slotIndex is 0-based, tokens are 1-based)
            const expectedNumericToken = actualSlotIndex + 1;
            const expectedTokenNumber = `A${String(expectedNumericToken).padStart(3, '0')}`;

            if (tokenData.numericToken !== expectedNumericToken || tokenData.tokenNumber !== expectedTokenNumber) {
                console.error(`[BOOKING FLOW DEBUG] ${bookingRequestId}: ⚠️ TOKEN MISMATCH - Correcting token to match slotIndex`, {
                    slotIndex: actualSlotIndex,
                    receivedNumericToken: tokenData.numericToken,
                    expectedNumericToken,
                    receivedTokenNumber: tokenData.tokenNumber,
                    expectedTokenNumber,
                    timestamp: new Date().toISOString()
                });
                // Override with correct token based on slotIndex
                numericToken = expectedNumericToken;
                tokenNumber = expectedTokenNumber;
            } else {
                // Token is correct, use as-is
                tokenNumber = tokenData.tokenNumber;
                numericToken = tokenData.numericToken;
            }

            console.log(`[BOOKING FLOW DEBUG] ${bookingRequestId}: Final token assignment`, {
                slotIndex: actualSlotIndex,
                numericToken,
                tokenNumber,
                tokenMatchesSlot: numericToken === actualSlotIndex + 1,
                timestamp: new Date().toISOString()
            });

            resolvedSessionIndex = tokenData.sessionIndex ?? resolvedSessionIndex;
            resolvedTimeString = tokenData.time ?? resolvedTimeString;
            reservationId = tokenData.reservationId;

            const appointmentDateObj = parse(baseAppointmentData.date, "d MMMM yyyy", new Date());
            const resolvedDetails = resolveSlotDetails(actualSlotIndex, appointmentDateObj);

            if (!tokenData.time && resolvedDetails) {
                resolvedTimeString = format(resolvedDetails.slotDate, "hh:mm a");
            }

            if (!tokenData.sessionIndex && resolvedDetails) {
                resolvedSessionIndex = resolvedDetails.sessionIndex;
            }

            // Update appointment data with token
            const appointmentTimeDate = parse(baseAppointmentData.date, "d MMMM yyyy", new Date());
            const resolvedAppointmentDateTime = parseTime(resolvedTimeString, appointmentTimeDate);
            const breakIntervals = buildBreakIntervals(finalDoctor, selectedSlot ?? appointmentDateObj);
            const adjustedAppointmentDateTime =
                breakIntervals.length > 0
                    ? applyBreakOffsets(resolvedAppointmentDateTime, breakIntervals)
                    : resolvedAppointmentDateTime;
            const adjustedTimeString = format(adjustedAppointmentDateTime, "hh:mm a");

            // Validate that the original slot time is within availability (original or extended)
            // Note: We check resolvedAppointmentDateTime (original slot) not adjustedAppointmentDateTime (after break offsets)
            const appointmentDateForValidation = parse(baseAppointmentData.date, "d MMMM yyyy", new Date());
            const dayOfWeekForValidation = format(appointmentDateForValidation, 'EEEE');
            const availabilityForDayForValidation = finalDoctor.availabilitySlots?.find(s => s.day === dayOfWeekForValidation);
            if (availabilityForDayForValidation && availabilityForDayForValidation.timeSlots.length > 0) {
                const dateStr = format(appointmentDateForValidation, 'd MMMM yyyy');
                const extension = finalDoctor.availabilityExtensions?.[dateStr];

                // Get the last session's end time (original or extended)
                const lastSession = availabilityForDayForValidation.timeSlots[availabilityForDayForValidation.timeSlots.length - 1];
                const actualOriginalEndTime = parseTime(lastSession.to, appointmentDateForValidation);
                let availabilityEndTime = actualOriginalEndTime;

                // Only use extension if it's valid
                if (extension && extension.sessions && Array.isArray(extension.sessions)) {
                    try {
                        // Find extension for the last session
                        const lastSessionIndex = availabilityForDayForValidation.timeSlots.length - 1;
                        const sessionExtension = extension.sessions.find((s: any) => s.sessionIndex === lastSessionIndex);

                        if (sessionExtension && sessionExtension.originalEndTime && sessionExtension.newEndTime) {
                            const extensionOriginalEndTime = parseTime(sessionExtension.originalEndTime, appointmentDateForValidation);
                            const extendedEndTime = parseTime(sessionExtension.newEndTime, appointmentDateForValidation);

                            // Validate extension: originalEndTime should match actual session end time, and newEndTime should be later
                            if (extensionOriginalEndTime.getTime() === actualOriginalEndTime.getTime() && isAfter(extendedEndTime, actualOriginalEndTime)) {
                                availabilityEndTime = extendedEndTime;
                            } else {
                                console.warn('Invalid extension data - originalEndTime mismatch or newEndTime is not after original, ignoring extension', {
                                    extensionOriginalEndTime: sessionExtension.originalEndTime,
                                    actualOriginalEndTime: lastSession.to,
                                    newEndTime: sessionExtension.newEndTime
                                });
                            }
                        }
                    } catch (error) {
                        console.error('Error parsing extension, using original end time:', error);
                    }
                }

                // Check if the original slot time is outside availability
                if (resolvedAppointmentDateTime > availabilityEndTime) {
                    toast({
                        variant: 'destructive',
                        title: 'Booking Not Allowed',
                        description: `The appointment time (${resolvedTimeString}) is outside the doctor's availability. Please select an earlier time slot.`,
                    });
                    return;
                }
            }

            let inheritedDelay = 0;
            try {
                const appointmentsRef = collection(firestore, 'appointments');
                const appointmentsQuery = query(
                    appointmentsRef,
                    where('clinicId', '==', finalDoctor.clinicId),
                    where('doctor', '==', finalDoctor.name),
                    where('date', '==', baseAppointmentData.date)
                );
                const appointmentsSnapshot = await getDocs(appointmentsQuery);
                const allAppointments = appointmentsSnapshot.docs.map(doc => ({
                    id: doc.id,
                    ...doc.data()
                })) as Array<Appointment & { id: string }>;

                const previousAppointments = allAppointments
                    .filter(a => {
                        const aptSlotIndex = a.slotIndex ?? -1;
                        return aptSlotIndex >= 0 && aptSlotIndex < actualSlotIndex;
                    })
                    .sort((a, b) => (b.slotIndex ?? 0) - (a.slotIndex ?? 0));

                if (previousAppointments.length > 0) {
                    const previousAppointment = previousAppointments[0];
                    inheritedDelay = previousAppointment.delay || 0;
                }
            } catch (error) {
                console.error('Error calculating inherited delay:', error);
            }

            const cutOffTime = subMinutes(resolvedAppointmentDateTime, 15);
            const noShowTime = addMinutes(resolvedAppointmentDateTime, 15 + inheritedDelay);

            const finalAppointmentData: Appointment = {
                ...baseAppointmentData,
                // Keep original slot time in `time`, adjusted time only for arriveBy/cutoff/noshow
                time: resolvedTimeString,
                arriveByTime: resolvedTimeString,
                slotIndex: actualSlotIndex,
                sessionIndex: resolvedSessionIndex,
                tokenNumber,
                numericToken,
                createdAt: serverTimestamp(),
                cutOffTime,
                noShowTime,
                ...(inheritedDelay > 0 ? { delay: inheritedDelay } : {}),
            };

            setGeneratedToken(tokenNumber);
            setAppointmentDate(finalAppointmentData.date);
            setAppointmentTime(finalAppointmentData.time);
            setAppointmentArriveByTime(finalAppointmentData.arriveByTime ?? finalAppointmentData.time);
            setBookedAppointmentId(appointmentRef.id);

            const appointmentRequestId = `appt-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            console.log(`[APPOINTMENT DEBUG] ====== CREATING APPOINTMENT ======`, {
                appointmentRequestId,
                reservationId,
                slotIndex: actualSlotIndex,
                appointmentId: appointmentRef.id,
                timestamp: new Date().toISOString()
            });

            // CRITICAL: Check for existing appointments at this slotIndex BEFORE starting transaction
            // This is a quick check to fail fast if duplicates already exist
            const appointmentsQuery = query(
                collection(firestore, 'appointments'),
                where('clinicId', '==', finalDoctor.clinicId),
                where('doctor', '==', finalDoctor.name),
                where('date', '==', finalAppointmentData.date),
                where('slotIndex', '==', actualSlotIndex)
            );
            const existingAppointmentsSnapshot = await getDocs(appointmentsQuery);
            const existingActiveAppointments = existingAppointmentsSnapshot.docs
                .filter(docSnap => {
                    const data = docSnap.data() as Appointment;
                    return (data.status === 'Pending' || data.status === 'Confirmed') && docSnap.id !== appointmentRef.id;
                });

            if (existingActiveAppointments.length > 0) {
                console.error(`[APPOINTMENT DEBUG] ${appointmentRequestId}: ⚠️ DUPLICATE DETECTED - Appointment already exists at slotIndex ${actualSlotIndex}`, {
                    existingAppointmentIds: existingActiveAppointments.map(docSnap => docSnap.id),
                    existingAppointmentData: existingActiveAppointments.map(docSnap => ({
                        id: docSnap.id,
                        ...docSnap.data()
                    })),
                    timestamp: new Date().toISOString()
                });
                toast({
                    variant: "destructive",
                    title: "Slot Already Booked",
                    description: "This time slot was just booked by someone else. Please select another time.",
                });
                setIsSubmitting(false);
                return;
            }

            // Get references to the existing appointments to verify in transaction
            const existingAppointmentRefs = existingActiveAppointments.map(docSnap =>
                doc(firestore, 'appointments', docSnap.id)
            );

            // CRITICAL: Use transaction to atomically claim reservation and create appointment
            // The reservation document acts as a lock - only one transaction can delete it
            // This prevents race conditions across different browsers/devices
            try {
                await runTransaction(firestore, async (transaction) => {
                    console.log(`[APPOINTMENT DEBUG] ${appointmentRequestId}: Transaction STARTED`, {
                        reservationId,
                        timestamp: new Date().toISOString()
                    });

                    const reservationRef = doc(firestore, 'slot-reservations', reservationId);
                    const reservationDoc = await transaction.get(reservationRef);

                    console.log(`[APPOINTMENT DEBUG] ${appointmentRequestId}: Reservation check result`, {
                        reservationId,
                        exists: reservationDoc.exists(),
                        data: reservationDoc.exists() ? reservationDoc.data() : null,
                        timestamp: new Date().toISOString()
                    });

                    if (!reservationDoc.exists()) {
                        // Reservation was already claimed by another request - slot is taken
                        console.error(`[APPOINTMENT DEBUG] ${appointmentRequestId}: Reservation does NOT exist - already claimed`, {
                            reservationId,
                            timestamp: new Date().toISOString()
                        });
                        const conflictError = new Error('Reservation already claimed by another booking');
                        (conflictError as { code?: string }).code = 'SLOT_ALREADY_BOOKED';
                        throw conflictError;
                    }

                    // Verify the reservation matches our slot
                    const reservationData = reservationDoc.data();
                    console.log(`[APPOINTMENT DEBUG] ${appointmentRequestId}: Verifying reservation match`, {
                        reservationSlotIndex: reservationData?.slotIndex,
                        expectedSlotIndex: actualSlotIndex,
                        reservationClinicId: reservationData?.clinicId,
                        expectedClinicId: finalDoctor.clinicId,
                        reservationDoctor: reservationData?.doctorName,
                        expectedDoctor: finalDoctor.name,
                        timestamp: new Date().toISOString()
                    });

                    if (reservationData?.slotIndex !== actualSlotIndex ||
                        reservationData?.clinicId !== finalDoctor.clinicId ||
                        reservationData?.doctorName !== finalDoctor.name) {
                        console.error(`[APPOINTMENT DEBUG] ${appointmentRequestId}: Reservation mismatch`, {
                            reservationData,
                            expected: { slotIndex: actualSlotIndex, clinicId: finalDoctor.clinicId, doctorName: finalDoctor.name }
                        });
                        const conflictError = new Error('Reservation does not match booking details');
                        (conflictError as { code?: string }).code = 'RESERVATION_MISMATCH';
                        throw conflictError;
                    }

                    // CRITICAL: Verify no appointment exists at this slotIndex by reading the documents we found
                    // This ensures we see the latest state even if appointments were created between our query and transaction
                    if (existingAppointmentRefs.length > 0) {
                        const existingAppointmentSnapshots = await Promise.all(
                            existingAppointmentRefs.map(ref => transaction.get(ref))
                        );
                        const stillActive = existingAppointmentSnapshots.filter(snap => {
                            if (!snap.exists()) return false;
                            const data = snap.data() as Appointment;
                            return (data.status === 'Pending' || data.status === 'Confirmed');
                        });

                        if (stillActive.length > 0) {
                            console.error(`[APPOINTMENT DEBUG] ${appointmentRequestId}: ⚠️ DUPLICATE DETECTED IN TRANSACTION - Appointment exists at slotIndex ${actualSlotIndex}`, {
                                existingAppointmentIds: stillActive.map(snap => snap.id),
                                timestamp: new Date().toISOString()
                            });
                            const conflictError = new Error('An appointment already exists at this slot');
                            (conflictError as { code?: string }).code = 'SLOT_ALREADY_BOOKED';
                            throw conflictError;
                        }
                    }

                    console.log(`[APPOINTMENT DEBUG] ${appointmentRequestId}: No existing appointment found - deleting reservation and creating appointment`, {
                        reservationId,
                        appointmentId: appointmentRef.id,
                        slotIndex: actualSlotIndex,
                        timestamp: new Date().toISOString()
                    });

                    // ⚠️⚠️⚠️ RESERVATION DELETION DEBUG ⚠️⚠️⚠️
                    console.error(`[RESERVATION DELETION TRACKER] 🗑️ PATIENT APP - DELETING slot-reservation BEFORE appointment creation`, {
                        app: 'kloqo-app',
                        page: 'book-appointment/summary/page.tsx (advance booking)',
                        action: 'transaction.delete(reservationRef)',
                        reservationId: reservationRef.id,
                        reservationPath: reservationRef.path,
                        appointmentId: appointmentRef.id,
                        appointmentToken: finalAppointmentData.tokenNumber,
                        slotIndex: actualSlotIndex,
                        reservationSlotIndex: reservationData?.slotIndex,
                        timestamp: new Date().toISOString(),
                        stackTrace: new Error().stack
                    });

                    // CRITICAL: Delete the reservation as part of the transaction
                    // This ensures only ONE request can successfully claim it
                    // If multiple requests try simultaneously, only one can delete the reservation
                    transaction.delete(reservationRef);

                    // Create appointment atomically in the same transaction
                    transaction.set(appointmentRef, finalAppointmentData);

                    console.log(`[APPOINTMENT DEBUG] ${appointmentRequestId}: Transaction operations queued - about to commit`, {
                        reservationDeleted: true,
                        appointmentCreated: true,
                        timestamp: new Date().toISOString()
                    });
                });

                console.log(`[APPOINTMENT DEBUG] ${appointmentRequestId}: Transaction COMMITTED successfully`, {
                    appointmentId: appointmentRef.id,
                    slotIndex: actualSlotIndex,
                    timestamp: new Date().toISOString()
                });
            } catch (error: any) {
                console.error(`[APPOINTMENT DEBUG] ${appointmentRequestId}: Transaction FAILED`, {
                    errorMessage: error.message,
                    errorCode: error.code,
                    errorName: error.name,
                    reservationId,
                    timestamp: new Date().toISOString()
                });

                // Don't try to release reservation - it was either deleted by us or doesn't exist
                if (error.code === 'SLOT_ALREADY_BOOKED' || error.code === 'RESERVATION_MISMATCH') {
                    toast({
                        variant: "destructive",
                        title: "Slot Already Booked",
                        description: "This time slot was just booked by someone else. Please select another time.",
                    });
                    setIsSubmitting(false);
                    return;
                }
                // For other errors, try to release reservation if it still exists
                try {
                    await releaseReservation(reservationId);
                } catch (releaseError) {
                    // Reservation might have been deleted by transaction, ignore
                }
                throw error;
            }

            // Ensure arriveByTime is persisted even if older clients skip this field
            try {
                await updateDoc(appointmentRef, {
                    arriveByTime: finalAppointmentData.arriveByTime ?? finalAppointmentData.time,
                });
            } catch (error) {
                console.error('Error backfilling arriveByTime:', error);
            }

            // Fetch the appointment to get the noShowTime from database
            try {
                const appointmentDoc = await getDoc(appointmentRef);
                if (appointmentDoc.exists()) {
                    const appointmentData = appointmentDoc.data();
                    if (appointmentData.noShowTime) {
                        // Convert Firestore Timestamp to Date
                        const noShowTimeValue = appointmentData.noShowTime;
                        const noShowDate = noShowTimeValue?.toDate ? noShowTimeValue.toDate() : new Date(noShowTimeValue);
                        setNoShowTime(noShowDate);
                    }
                }
            } catch (error) {
                console.error('Error fetching noShowTime:', error);
            }

            // Update patient document: add clinicId to clinicIds, increment totalAppointments, add appointment ID to visitHistory
            const patientRef = doc(firestore, 'patients', finalPatient.id);
            await updateDoc(patientRef, {
                clinicIds: arrayUnion(finalDoctor.clinicId),
                totalAppointments: increment(1),
                visitHistory: arrayUnion(appointmentRef.id),
                updatedAt: serverTimestamp(),
            });

            // Send notification after successful booking
            if (user?.uid && firestore) {
                try {
                    await sendAppointmentConfirmedNotification({
                        firestore,
                        userId: user.uid,
                        appointmentId: appointmentRef.id,
                        doctorName: finalDoctor.name,
                        date: finalAppointmentData.date,
                        time: finalAppointmentData.time,
                        tokenNumber: finalAppointmentData.tokenNumber,
                    });
                    console.log('Appointment confirmed notification sent');
                } catch (notifError) {
                    console.error('Failed to send notification:', notifError);
                }
            }

            setStatus('success');

        } catch (error) {
            console.error("Error booking appointment:", error);
            if (!(error instanceof FirestorePermissionError)) {
                toast({ variant: "destructive", title: t.bookAppointment.error, description: t.bookAppointment.bookingFailed });
            }
        } finally {
            setIsSubmitting(false);
        }
    };


    const handleBack = () => {
        router.back();
    };

    // Progressive loading: Show page structure immediately, skeletons for missing data
    // No longer blocking the entire page

    if (status === 'success') {
        return (
            <div className="flex min-h-screen w-full flex-col items-center justify-center bg-background font-body p-4 text-center">
                <div className="flex flex-col items-center space-y-4">
                    <LottieAnimation
                        animationData={successAnimation}
                        size={200}
                        autoplay={true}
                        loop={false}
                        className="mb-2"
                    />
                    <div className="space-y-2">
                        <h1 className="text-3xl font-bold">{t.bookAppointment.bookingSuccessful}</h1>
                        <p className="text-muted-foreground">{t.messages.appointmentBooked}</p>
                    </div>
                    <Card className="bg-muted/50 p-6 w-full max-w-xs mt-4">
                        <CardContent className="p-0 flex flex-col items-center space-y-4">
                            <div className="flex flex-col items-center">
                                <p className="text-sm text-muted-foreground">{t.liveToken.yourToken}</p>
                                <p className="text-4xl font-bold text-primary">{generatedToken}</p>
                            </div>
                            {appointmentDate && appointmentTime && (
                                <div className="flex flex-col items-center space-y-2 w-full pt-4 border-t">
                                    <div className="flex items-center gap-2">
                                        <Calendar className="w-4 h-4 text-muted-foreground" />
                                        <p className="text-sm font-medium">{appointmentDate}</p>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <Clock className="w-4 h-4 text-muted-foreground" />
                                        <div className="text-center">
                                            <span className="text-sm text-muted-foreground block">Arrive by</span>
                                            <p className="text-xl font-bold">
                                                {(() => {
                                                    try {
                                                        const timeStr = appointmentArriveByTime || appointmentTime;
                                                        const dateObj = parse(appointmentDate, "d MMMM yyyy", new Date());
                                                        const baseTime = parse(timeStr, "hh:mm a", dateObj);
                                                        // Add break offsets if doctor info is available
                                                        const effectiveDoctor = doctor || cachedDoctor;
                                                        const breakIntervals = effectiveDoctor ? buildBreakIntervals(effectiveDoctor, dateObj) : [];
                                                        const adjustedBaseTime = breakIntervals.length > 0
                                                            ? applyBreakOffsets(baseTime, breakIntervals)
                                                            : baseTime;
                                                        const adjusted = subMinutes(adjustedBaseTime, 15);
                                                        return format(adjusted, "hh:mm a");
                                                    } catch {
                                                        return appointmentArriveByTime || appointmentTime;
                                                    }
                                                })()}
                                            </p>
                                        </div>
                                    </div>
                                    <div className="mt-2 p-2 bg-red-50 border border-red-200 rounded-lg w-full">
                                        <p className="text-sm font-bold text-red-600 text-center">
                                            ⚠️ {t.bookAppointment.autoCancelWarning.replace('{time}', (() => {
                                                try {
                                                    if (noShowTime) {
                                                        return format(noShowTime, 'hh:mm a');
                                                    }
                                                    // Fallback to calculated time if noShowTime not available
                                                    const aptDate = parse(appointmentDate, "d MMMM yyyy", new Date());
                                                    const aptTime = parse(appointmentTime, "hh:mm a", aptDate);
                                                    const noShowFallback = addMinutes(aptTime, 30);
                                                    return format(noShowFallback, 'hh:mm a');
                                                } catch {
                                                    return '30 minutes';
                                                }
                                            })())}
                                        </p>
                                    </div>

                                </div>
                            )}
                        </CardContent>
                    </Card>
                    <Button className="w-full mt-6" asChild>
                        <Link href="/appointments">{t.appointments.myAppointments}</Link>
                    </Button>
                </div>
            </div>
        )
    }

    // Progressive loading: Show error only if we've finished loading and still don't have required data (check cache too)
    if (!loading && ((!doctor && !cachedDoctor) || !selectedSlot || (!patient && !cachedPatient))) {
        return (
            <div className="flex h-screen w-full flex-col items-center justify-center bg-background p-4 text-center">
                <p className="text-muted-foreground">{t.bookAppointment.incompleteDetails}</p>
                <Button variant="link" asChild><Link href="/home">{t.common.back}</Link></Button>
            </div>
        )
    }





    return (
        <>
            <FullScreenLoader isOpen={isSubmitting} />
            <Suspense fallback={
                <div className="min-h-screen flex items-center justify-center bg-background">
                    <div className="flex flex-col items-center gap-4">
                        <Skeleton className="h-12 w-12 rounded-full" />
                        <Skeleton className="h-4 w-32" />
                    </div>
                </div>
            }>
                <div className="flex min-h-screen w-full flex-col bg-background font-body">
                    <header className="flex items-center p-4 border-b">
                        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleBack}>
                            <ArrowLeft className="h-5 w-5" />
                            <span className="sr-only">Back</span>
                        </Button>
                        <h1 className="text-xl font-bold text-center flex-grow">{t.bookAppointment.bookingSummary}</h1>
                        <div className="w-8"></div>
                    </header>
                    <main className="flex-grow overflow-y-auto p-4 md:p-6 space-y-6">
                        {/* Progressive loading: Show doctor card with skeleton if loading */}
                        <Card>
                            <CardContent className="p-4 space-y-4">
                                {loading && !doctor && !cachedDoctor ? (
                                    // Show skeleton while doctor loads
                                    <>
                                        <div className="flex items-center gap-4">
                                            <Skeleton className="h-16 w-16 rounded-full" />
                                            <div className="flex-grow space-y-2">
                                                <Skeleton className="h-6 w-40" />
                                                <Skeleton className="h-4 w-32" />
                                            </div>
                                        </div>
                                        <div className="border-t pt-4 space-y-2">
                                            <Skeleton className="h-5 w-48" />
                                            <Skeleton className="h-5 w-32" />
                                            <Skeleton className="h-12 w-full" />
                                        </div>
                                    </>
                                ) : (doctor || cachedDoctor) ? (
                                    // Show doctor info when loaded (use cached or fresh)
                                    <>
                                        <div className="flex items-center gap-4">
                                            <Avatar className="h-16 w-16">
                                                {(doctor || cachedDoctor)?.avatar && <AvatarImage src={(doctor || cachedDoctor)!.avatar} alt={(doctor || cachedDoctor)!.name} />}
                                                <AvatarFallback>{(doctor || cachedDoctor)!.name.split(' ').map(n => n[0]).join('')}</AvatarFallback>
                                            </Avatar>
                                            <div className="flex-grow">
                                                <h3 className="font-bold text-lg">{(doctor || cachedDoctor)!.name}</h3>
                                                <p className="text-muted-foreground">{getLocalizedDepartmentName((doctor || cachedDoctor)!.department, language, departments)}</p>
                                            </div>
                                        </div>
                                        {selectedSlot && (
                                            <div className="border-t pt-4 space-y-2">
                                                <div className="flex items-center gap-3">
                                                    <Calendar className="w-5 h-5 text-primary" />
                                                    <span className="font-semibold">{formatDayOfWeek(selectedSlot, language)}, {format(selectedSlot, 'dd')}{language === 'ml' ? ' ' : ', '}{formatDate(selectedSlot, 'MMMM', language)}, {format(selectedSlot, 'yyyy')}</span>
                                                </div>
                                                <div className="flex items-center gap-3">
                                                    <Clock className="w-5 h-5 text-primary" />
                                                    <div>
                                                        <span className="text-xs text-muted-foreground block">Session Time</span>
                                                        <span className="font-semibold">{(() => {
                                                            try {
                                                                // Add break offsets if doctor info is available
                                                                const effectiveDoctor = doctor || cachedDoctor;
                                                                const breakIntervals = effectiveDoctor && selectedSlot ? buildBreakIntervals(effectiveDoctor, selectedSlot) : [];
                                                                const adjustedSlot = breakIntervals.length > 0
                                                                    ? applyBreakOffsets(selectedSlot, breakIntervals)
                                                                    : selectedSlot;
                                                                const arriveBy = format(subMinutes(adjustedSlot, 15), 'hh:mm a');
                                                                const sessionEnd = findSessionEndTime(effectiveDoctor, selectedSlot);
                                                                return sessionEnd ? `${arriveBy} - ${sessionEnd}` : arriveBy;
                                                            } catch {
                                                                return format(subMinutes(selectedSlot, 15), 'hh:mm a');
                                                            }
                                                        })()}</span>
                                                    </div>
                                                </div>
                                                {(doctor || cachedDoctor)!.consultationFee && (
                                                    <div className="flex items-center gap-3">
                                                        <span className="font-bold text-lg text-primary ml-1 font-mono">&#8377;</span>
                                                        <span className="font-semibold">{(doctor || cachedDoctor)!.consultationFee} {t.bookAppointment.consultationFee}</span>
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                    </>
                                ) : null}
                            </CardContent>
                        </Card >

                        {/* Progressive loading: Show patient card with skeleton if loading */}
                        < Card >
                            <CardContent className="p-4 space-y-3">
                                <h3 className="font-bold text-lg mb-2">{t.patientForm.personalDetails}</h3>
                                {loading && !patient && !cachedPatient ? (
                                    // Show skeleton while patient loads
                                    <>
                                        <Skeleton className="h-5 w-full" />
                                        <Skeleton className="h-5 w-full" />
                                        <Skeleton className="h-5 w-full" />
                                        <Skeleton className="h-5 w-full" />
                                    </>
                                ) : (patient || cachedPatient) ? (
                                    // Show patient info when loaded (use cached or fresh)
                                    <>
                                        <div className="flex items-center gap-3">
                                            <User className="w-5 h-5 text-primary" />
                                            <span className="text-muted-foreground">{t.common.name}:</span>
                                            <span className="font-semibold ml-auto">{(patient || cachedPatient)!.name}</span>
                                        </div>
                                        <div className="flex items-center gap-3">
                                            <User className="w-5 h-5 text-primary" />
                                            <span className="text-muted-foreground">{t.common.age}/{t.common.gender}:</span>
                                            <span className="font-semibold ml-auto">{(patient || cachedPatient)!.age} / {(patient || cachedPatient)!.sex}</span>
                                        </div>
                                        <div className="flex items-center gap-3">
                                            <Phone className="w-5 h-5 text-primary" />
                                            <span className="text-muted-foreground">{t.common.phone}:</span>
                                            <span className="font-semibold ml-auto">{(patient || cachedPatient)!.communicationPhone || (patient || cachedPatient)!.phone || user?.phoneNumber}</span>
                                        </div>
                                        <div className="flex items-center gap-3">
                                            <MapPin className="w-5 h-5 text-primary" />
                                            <span className="text-muted-foreground">{t.common.location}:</span>
                                            <span className="font-semibold ml-auto">{(patient || cachedPatient)!.place}</span>
                                        </div>
                                    </>
                                ) : null}
                            </CardContent>
                        </Card >

                    </main >
                    <footer className="p-4 border-t sticky bottom-0 bg-background">
                        <Button
                            className="w-full h-12 text-base font-semibold"
                            onClick={handleConfirmBooking}
                            disabled={isSubmitting || loading || (!doctor && !cachedDoctor) || (!patient && !cachedPatient) || !selectedSlot}
                        >
                            {isSubmitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : (hasBookingFailed ? t.bookAppointment.tryAgain : t.bookAppointment.confirmBooking)}
                        </Button>
                    </footer>
                </div >
            </Suspense>
        </>
    );
}

function BookingSummaryPageWithAuth() {
    return (
        <AuthGuard>
            <BookingSummaryPage />
        </AuthGuard>
    );
}

export default BookingSummaryPageWithAuth;
