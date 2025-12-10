
'use client';

import { useState, useEffect, useCallback } from 'react';
import { Suspense } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, CheckCircle, ArrowLeft, User, Calendar, Clock } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { format, parse, addMinutes, isBefore, subMinutes, differenceInMinutes, parseISO } from 'date-fns';
import { collection, getDocs, addDoc, doc, getDoc, query, where, updateDoc, arrayUnion, increment, serverTimestamp, setDoc, deleteDoc, runTransaction } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import type { Doctor, Appointment, Patient } from '@/lib/types';
import AppFrameLayout from '@/components/layout/app-frame';
import { errorEmitter, FirestorePermissionError } from '@kloqo/shared-core';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { generateNextToken, generateNextTokenAndReserveSlot } from '@kloqo/shared-core';

import { parseTime, getArriveByTime } from '@/lib/utils';
import { sendAppointmentBookedByStaffNotification } from '@kloqo/shared-core';

type BreakInterval = {
    start: Date;
    end: Date;
};

function buildBreakIntervals(doctor: Doctor | null, referenceDate: Date | null): BreakInterval[] {
    if (!doctor?.leaveSlots || !referenceDate) {
        return [];
    }

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
        .filter((date): date is Date => !!date && !isNaN(date.getTime()) && format(date, 'yyyy-MM-dd') === format(referenceDate, 'yyyy-MM-dd'))
        .sort((a, b) => a.getTime() - b.getTime());

    if (slotsForDay.length === 0) {
        return [];
    }

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

    if (currentInterval) {
        intervals.push(currentInterval);
    }

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

const formSchema = z.object({
    patientName: z.string().min(2, { message: "Name must be at least 2 characters." }),
    age: z.coerce.number().int().positive({ message: "Age must be a positive number." }).min(1, { message: "Please enter a valid age." }),
    phone: z.string()
        .refine((val) => {
            if (!val || val.length === 0) return false; // Phone is required
            // Strip +91 prefix if present, then check for exactly 10 digits
            const cleaned = val.replace(/^\+91/, '').replace(/\D/g, ''); // Remove +91 and non-digits
            if (cleaned.length === 0) return false; // If all digits removed, invalid
            if (cleaned.length < 10) return false; // Less than 10 digits is invalid
            if (cleaned.length > 10) return false; // More than 10 digits is invalid
            return /^\d{10}$/.test(cleaned);
        }, {
            message: "Please enter exactly 10 digits for the phone number."
        }),
    place: z.string().min(2, { message: "Place is required." }),
    sex: z.string().min(1, { message: "Sex is required." }),
    department: z.string().optional(),
    doctor: z.string().optional(),
    slot: z.string().min(1, { message: "A time slot is required." }),
});

function AppointmentDetailsFormContent() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const { toast } = useToast();
    const slotParam = searchParams.get('slot');
    const doctorId = searchParams.get('doctor');
    const patientId = searchParams.get('patientId'); // This is the ID of the patient to book for
    const bookingUserId = searchParams.get('bookingUserId'); // This is the primary user account
    const source = searchParams.get('source');
    const isPhoneBooking = source === 'phone';

    const [isSubmitting, setIsSubmitting] = useState(false);
    const [isSubmitted, setIsSubmitted] = useState(false);
    const [doctor, setDoctor] = useState<Doctor | null>(null);
    const [patient, setPatient] = useState<Patient | null>(null);
    const [clinicId, setClinicId] = useState<string | null>(null);


    const form = useForm<z.infer<typeof formSchema>>({
        resolver: zodResolver(formSchema),
        defaultValues: {
            patientName: '',
            age: undefined,
            phone: '',
            place: '',
            sex: undefined,
            slot: slotParam || '',
        },
    });

    useEffect(() => {
        const id = localStorage.getItem('clinicId');
        if (!id) {
            router.push('/login');
            return;
        }
        setClinicId(id);
        if (slotParam) {
            form.setValue('slot', slotParam);
        }
    }, [slotParam, router, form]);


    const createAppointment = useCallback(async (values?: z.infer<typeof formSchema>) => {
        setIsSubmitting(true);

        const finalValues = values || form.getValues();
        console.log('🔵 [NURSE APP] createAppointment called');
        console.log('🔵 [NURSE APP] Form values:', {
            patientName: finalValues.patientName,
            age: finalValues.age,
            place: finalValues.place,
            sex: finalValues.sex,
            phone: finalValues.phone,
        });
        console.log('🔵 [NURSE APP] patientId from URL:', patientId);

        const selectedSlot = new Date(finalValues.slot);

        if (isNaN(selectedSlot.getTime()) || !clinicId || !doctor || !patientId) {
            setIsSubmitting(false);
            toast({ variant: 'destructive', title: 'Error', description: 'Missing required information to book.' });
            return;
        }

        try {
            // Check for duplicate booking - same patient, same doctor, same day
            const appointmentDateStr = format(selectedSlot, "d MMMM yyyy");
            const duplicateCheckQuery = query(
                collection(db, "appointments"),
                where("patientId", "==", patientId),
                where("doctor", "==", doctor.name),
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

            const appointmentsCollection = collection(db, "appointments");

            // Clean phone: remove +91 if user entered it, remove any non-digits, then ensure exactly 10 digits
            let cleanedPhone = "";
            if (finalValues.phone) {
                const cleaned = finalValues.phone.replace(/^\+91/, '').replace(/\D/g, ''); // Remove +91 prefix and non-digits
                if (cleaned.length === 10) {
                    cleanedPhone = cleaned;
                }
            }
            if (!cleanedPhone) {
                toast({ variant: 'destructive', title: 'Error', description: 'Please enter a valid 10-digit phone number.' });
                setIsSubmitting(false);
                return;
            }

            // Always use form values for appointment creation (in case user edited the selected patient's info)
            const appointmentPatientData = {
                name: finalValues.patientName,
                age: finalValues.age,
                communicationPhone: `+91${cleanedPhone}`, // Add +91 prefix when saving
                place: finalValues.place,
                sex: finalValues.sex,
            };

            const dayOfWeek = format(selectedSlot, 'EEEE');
            const doctorAvailabilityForDay = doctor.availabilitySlots?.find(slot => slot.day === dayOfWeek);

            let slotIndex = 0;
            let sessionIndex = 0;
            let absoluteSlotIndex = 0;
            let found = false;

            if (doctorAvailabilityForDay) {
                for (let i = 0; i < doctorAvailabilityForDay.timeSlots.length; i++) {
                    const session = doctorAvailabilityForDay.timeSlots[i];
                    const sessionStart = parseTime(session.from, selectedSlot);
                    const sessionEnd = parseTime(session.to, selectedSlot);

                    if (selectedSlot >= sessionStart && selectedSlot < sessionEnd) {
                        const diffMinutes = (selectedSlot.getTime() - sessionStart.getTime()) / 60000;
                        slotIndex = Math.floor(diffMinutes / (doctor.averageConsultingTime || 15));
                        sessionIndex = i;
                        found = true;
                        break;
                    }
                    const sessionDuration = (sessionEnd.getTime() - sessionStart.getTime()) / 60000;
                    absoluteSlotIndex += Math.floor(sessionDuration / (doctor.averageConsultingTime || 15));
                }
            }

            const finalSlotIndex = absoluteSlotIndex + slotIndex;
            const appointmentTimeStr = format(selectedSlot, "hh:mm a");

            const releaseReservation = async (reservationId?: string | null, delayMs: number = 0) => {
                if (!reservationId) return;
                if (delayMs > 0) {
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                }
                try {
                    await deleteDoc(doc(db, 'slot-reservations', reservationId));
                    console.log('🧹 [NURSE APP] Released slot reservation:', reservationId);
                } catch (error) {
                    console.warn('⚠️ [NURSE APP] Failed to release reservation:', { reservationId, error });
                }
            };

            // Use transaction-based slot reservation to prevent A token collisions
            let tokenData: { tokenNumber: string; numericToken: number; slotIndex: number; reservationId?: string };
            try {
                tokenData = await generateNextTokenAndReserveSlot(
                    db, // CRITICAL: First parameter must be firestore instance
                    clinicId,
                    doctor.name,
                    selectedSlot,
                    'A',
                    {
                        time: appointmentTimeStr,
                        slotIndex: finalSlotIndex,
                        doctorId: doctor.id,
                    }
                );
            } catch (error: any) {
                if (error.code === 'SLOT_OCCUPIED' || error.message === 'SLOT_ALREADY_BOOKED') {
                    toast({
                        variant: "destructive",
                        title: "Slot Already Booked",
                        description: "This time slot is already booked. Please select another time."
                    });
                    setIsSubmitting(false);
                    return;
                } else if (error.code === 'A_CAPACITY_REACHED') {
                    toast({
                        variant: "destructive",
                        title: "No Slots Available",
                        description: "Advance booking capacity has been reached for this doctor today. Please choose another day.",
                    });
                    setIsSubmitting(false);
                    return;
                }
                throw error;
            }

            const newAppointmentRef = doc(appointmentsCollection);

            // Use the slotIndex returned from generateNextTokenAndReserveSlot (may have been auto-adjusted)
            const actualSlotIndex = tokenData.slotIndex;
            const reservationId = tokenData.reservationId;

            // Recalculate the time from the actual slotIndex to ensure consistency
            let actualAppointmentTimeStr = appointmentTimeStr;
            let actualAppointmentTime = parseTime(appointmentTimeStr, selectedSlot);
            try {
                // Generate all time slots for the day to find the correct time for the actual slotIndex
                const dayOfWeek = format(selectedSlot, 'EEEE');
                const availabilityForDay = doctor.availabilitySlots?.find(s => s.day === dayOfWeek);
                if (availabilityForDay) {
                    const slotDuration = doctor.averageConsultingTime || 15;
                    let globalSlotIndex = 0;
                    let foundSlot = false;
                    for (let i = 0; i < availabilityForDay.timeSlots.length && !foundSlot; i++) {
                        const session = availabilityForDay.timeSlots[i];
                        let currentTime = parseTime(session.from, selectedSlot);
                        const endTime = parseTime(session.to, selectedSlot);

                        while (isBefore(currentTime, endTime) && !foundSlot) {
                            if (globalSlotIndex === actualSlotIndex) {
                                actualAppointmentTime = currentTime;
                                actualAppointmentTimeStr = format(currentTime, "hh:mm a");
                                foundSlot = true;
                                break;
                            }
                            currentTime = addMinutes(currentTime, slotDuration);
                            globalSlotIndex++;
                        }
                    }
                }
            } catch (error) {
                console.error('Error recalculating time from slotIndex:', error);
                // Fall back to original time if recalculation fails
            }

            const breakIntervals = buildBreakIntervals(doctor, selectedSlot);
            const adjustedAppointmentTime =
                breakIntervals.length > 0
                    ? applyBreakOffsets(actualAppointmentTime, breakIntervals)
                    : actualAppointmentTime;
            const adjustedAppointmentTimeStr = format(adjustedAppointmentTime, "hh:mm a");

            // Calculate cut-off time and no-show time
            let cutOffTime: Date | undefined;
            let noShowTime: Date | undefined;
            let inheritedDelay = 0;
            try {
                const appointmentDate = parse(format(selectedSlot, "d MMMM yyyy"), "d MMMM yyyy", new Date());
                const appointmentTime = adjustedAppointmentTime;
                cutOffTime = subMinutes(appointmentTime, 15);

                // Inherit delay from previous appointment (if any)
                // Find the appointment with the highest slotIndex that is less than actualSlotIndex
                const appointmentsRef = collection(db, 'appointments');
                const appointmentsQuery = query(
                    appointmentsRef,
                    where('clinicId', '==', clinicId),
                    where('doctor', '==', doctor?.name),
                    where('date', '==', format(selectedSlot, "d MMMM yyyy"))
                );
                const appointmentsSnapshot = await getDocs(appointmentsQuery);
                const allAppointments = appointmentsSnapshot.docs.map(doc => ({
                    id: doc.id,
                    ...doc.data()
                })) as Array<Appointment & { id: string }>;

                // Find the previous appointment (highest slotIndex < actualSlotIndex)
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

                // Apply delay to noShowTime only (not to cutOffTime or time)
                // cutOffTime remains: appointment time - 15 minutes (no delay)
                // noShowTime becomes: appointment time + 15 minutes + delay
                noShowTime = addMinutes(appointmentTime, 15 + inheritedDelay);
            } catch (error) {
                console.error('Error calculating cut-off and no-show times:', error);
            }

            // Validate that arriveByTime is within availability (original or extended)
            const dayOfWeekForValidation = format(selectedSlot, 'EEEE');
            const availabilityForDayForValidation = doctor?.availabilitySlots?.find(s => s.day === dayOfWeekForValidation);
            if (availabilityForDayForValidation && availabilityForDayForValidation.timeSlots.length > 0) {
                const dateStr = format(selectedSlot, 'd MMMM yyyy');
                const extension = doctor?.availabilityExtensions?.[dateStr];

                // Get the last session's end time (original or extended)
                const lastSession = availabilityForDayForValidation.timeSlots[availabilityForDayForValidation.timeSlots.length - 1];
                const originalEndTime = parseTime(lastSession.to, selectedSlot);
                let availabilityEndTime = originalEndTime;

                if (extension) {
                    const lastSessionIndex = availabilityForDayForValidation.timeSlots.length - 1;
                    const extensionSession = extension.sessions.find(s => s.sessionIndex === lastSessionIndex);
                    if (extensionSession) {
                        availabilityEndTime = parseTime(extensionSession.newEndTime, selectedSlot);
                    }
                }

                // Check if arriveByTime is outside availability
                if (adjustedAppointmentTime > availabilityEndTime) {
                    toast({
                        variant: 'destructive',
                        title: 'Booking Not Allowed',
                        description: `The appointment time (${adjustedAppointmentTimeStr}) is outside the doctor's availability. Please select an earlier time slot.`,
                    });
                    return;
                }
            }

            const newAppointment: Appointment = {
                id: newAppointmentRef.id,
                patientName: appointmentPatientData.name,
                age: appointmentPatientData.age,
                communicationPhone: appointmentPatientData.communicationPhone,
                place: appointmentPatientData.place,
                sex: appointmentPatientData.sex as any,
                patientId: patientId, // Use patientId from URL
                doctorId: doctor?.id, // Add doctorId
                doctor: doctor?.name,
                department: doctor?.department,
                bookedVia: 'Advanced Booking',
                date: appointmentDateStr,
                // Keep original slot time in `time`; use break-adjusted time only for arriveBy/cutoff/noshow
                time: actualAppointmentTimeStr,
                arriveByTime: adjustedAppointmentTimeStr,
                status: "Pending",
                tokenNumber: tokenData.tokenNumber,
                numericToken: tokenData.numericToken,
                clinicId,
                slotIndex: actualSlotIndex, // Use the actual slotIndex returned from the function
                sessionIndex: sessionIndex,
                createdAt: serverTimestamp(),
                cutOffTime: cutOffTime,
                noShowTime: noShowTime,
                ...(inheritedDelay > 0 && { delay: inheritedDelay }), // Only include delay if > 0
            };

            // CRITICAL: Check for existing appointments at this slot before creating
            // This prevents duplicate bookings from concurrent requests
            const existingAppointmentsQuery = query(
                collection(db, 'appointments'),
                where('clinicId', '==', clinicId),
                where('doctor', '==', doctor?.name),
                where('date', '==', appointmentDateStr),
                where('slotIndex', '==', actualSlotIndex)
            );
            const existingAppointmentsSnapshot = await getDocs(existingAppointmentsQuery);
            const existingActiveAppointments = existingAppointmentsSnapshot.docs.filter(docSnap => {
                const data = docSnap.data();
                return (data.status === 'Pending' || data.status === 'Confirmed');
            });

            if (existingActiveAppointments.length > 0) {
                console.error(`[NURSE APPOINTMENT DEBUG] ⚠️ DUPLICATE DETECTED - Appointment already exists at slotIndex ${actualSlotIndex}`, {
                    existingAppointmentIds: existingActiveAppointments.map(docSnap => docSnap.id),
                    timestamp: new Date().toISOString()
                });
                await releaseReservation(reservationId);
                toast({
                    variant: "destructive",
                    title: "Slot Already Booked",
                    description: "This time slot was just booked by someone else. Please select another time.",
                });
                setIsSubmitting(false);
                return;
            }

            // Get references to existing appointments to verify in transaction
            const existingAppointmentRefs = existingActiveAppointments.map(docSnap =>
                doc(db, 'appointments', docSnap.id)
            );

            // CRITICAL: Use transaction to atomically claim reservation and create appointment
            // The reservation document acts as a lock - only one transaction can delete it
            // This prevents race conditions across different browsers/devices
            try {
                await runTransaction(db, async (transaction) => {
                    console.log(`[NURSE APPOINTMENT DEBUG] Transaction STARTED`, {
                        reservationId,
                        appointmentId: newAppointmentRef.id,
                        slotIndex: actualSlotIndex,
                        timestamp: new Date().toISOString()
                    });

                    const reservationRef = doc(db, 'slot-reservations', reservationId!);
                    const reservationDoc = await transaction.get(reservationRef);

                    console.log(`[NURSE APPOINTMENT DEBUG] Reservation check result`, {
                        reservationId,
                        exists: reservationDoc.exists(),
                        data: reservationDoc.exists() ? reservationDoc.data() : null,
                        timestamp: new Date().toISOString()
                    });

                    if (!reservationDoc.exists()) {
                        // Reservation was already claimed by another request - slot is taken
                        console.error(`[NURSE APPOINTMENT DEBUG] Reservation does NOT exist - already claimed`, {
                            reservationId,
                            timestamp: new Date().toISOString()
                        });
                        const conflictError = new Error('Reservation already claimed by another booking');
                        (conflictError as { code?: string }).code = 'SLOT_ALREADY_BOOKED';
                        throw conflictError;
                    }

                    // Verify the reservation matches our slot
                    const reservationData = reservationDoc.data();
                    console.log(`[NURSE APPOINTMENT DEBUG] Verifying reservation match`, {
                        reservationSlotIndex: reservationData?.slotIndex,
                        expectedSlotIndex: actualSlotIndex,
                        reservationClinicId: reservationData?.clinicId,
                        expectedClinicId: clinicId,
                        reservationDoctor: reservationData?.doctorName,
                        expectedDoctor: doctor?.name,
                        timestamp: new Date().toISOString()
                    });

                    if (reservationData?.slotIndex !== actualSlotIndex ||
                        reservationData?.clinicId !== clinicId ||
                        reservationData?.doctorName !== doctor?.name) {
                        console.error(`[NURSE APPOINTMENT DEBUG] Reservation mismatch`, {
                            reservationData,
                            expected: { slotIndex: actualSlotIndex, clinicId, doctorName: doctor?.name }
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
                            console.error(`[NURSE APPOINTMENT DEBUG] ⚠️ DUPLICATE DETECTED IN TRANSACTION - Appointment exists at slotIndex ${actualSlotIndex}`, {
                                existingAppointmentIds: stillActive.map(snap => snap.id),
                                timestamp: new Date().toISOString()
                            });
                            const conflictError = new Error('An appointment already exists at this slot');
                            (conflictError as { code?: string }).code = 'SLOT_ALREADY_BOOKED';
                            throw conflictError;
                        }
                    }

                    console.log(`[NURSE APPOINTMENT DEBUG] No existing appointment found - deleting reservation and creating appointment`, {
                        reservationId,
                        appointmentId: newAppointmentRef.id,
                        slotIndex: actualSlotIndex,
                        timestamp: new Date().toISOString()
                    });

                    // ⚠️⚠️⚠️ RESERVATION UPDATE DEBUG ⚠️⚠️⚠️
                    console.error(`[RESERVATION DELETION TRACKER] ✅ NURSE APP - UPDATING slot-reservation (NOT deleting)`, {
                        app: 'kloqo-nurse',
                        page: 'book-appointment/details/details-form.tsx',
                        action: 'transaction.update(reservationRef, {status: "booked"})',
                        reservationId: reservationId,
                        reservationPath: reservationRef.path,
                        appointmentId: newAppointmentRef.id,
                        appointmentToken: newAppointment.tokenNumber,
                        slotIndex: actualSlotIndex,
                        timestamp: new Date().toISOString(),
                        stackTrace: new Error().stack
                    });

                    // CRITICAL: Mark reservation as booked instead of deleting it
                    // This acts as a persistent lock to prevent race conditions where other clients
                    // might miss the new appointment and try to claim the "free" slot
                    transaction.update(reservationRef, {
                        status: 'booked',
                        appointmentId: newAppointmentRef.id,
                        bookedAt: serverTimestamp()
                    });

                    // Create appointment atomically in the same transaction
                    transaction.set(newAppointmentRef, newAppointment);

                    console.log(`[NURSE APPOINTMENT DEBUG] Transaction operations queued - about to commit`, {
                        reservationUpdated: true,
                        appointmentCreated: true,
                        timestamp: new Date().toISOString()
                    });
                });

                // ⚠️⚠️⚠️ RESERVATION UPDATE DEBUG ⚠️⚠️⚠️
                console.error(`[RESERVATION DELETION TRACKER] ✅ NURSE APP - Transaction COMMITTED (reservation was updated to booked)`, {
                    app: 'kloqo-nurse',
                    page: 'book-appointment/details/details-form.tsx',
                    reservationId: reservationId,
                    appointmentId: newAppointmentRef.id,
                    appointmentToken: newAppointment.tokenNumber,
                    slotIndex: actualSlotIndex,
                    timestamp: new Date().toISOString()
                });

                console.log(`[NURSE APPOINTMENT DEBUG] Transaction COMMITTED successfully`, {
                    appointmentId: newAppointmentRef.id,
                    slotIndex: actualSlotIndex,
                    timestamp: new Date().toISOString()
                });
            } catch (error: any) {
                console.error(`[NURSE APPOINTMENT DEBUG] Transaction FAILED`, {
                    errorMessage: error.message,
                    errorCode: error.code,
                    errorName: error.name,
                    reservationId,
                    timestamp: new Date().toISOString()
                });

                // Try to release reservation if transaction failed
                try {
                    await releaseReservation(reservationId);
                } catch (releaseError) {
                    // Reservation might have been deleted by transaction, ignore
                }

                if (error.code === 'SLOT_ALREADY_BOOKED' || error.code === 'RESERVATION_MISMATCH') {
                    toast({
                        variant: "destructive",
                        title: "Slot Already Booked",
                        description: "This time slot was just booked by someone else. Please select another time.",
                    });
                    setIsSubmitting(false);
                    return;
                }

                const permissionError = new FirestorePermissionError({
                    path: 'appointments',
                    operation: 'create',
                    requestResourceData: newAppointment,
                });
                errorEmitter.emit('permission-error', permissionError);
                throw error;
            }

            // After creating the appointment, update the patient's visit history and patient details
            console.log('🟢 [NURSE APP] About to update patient document');
            console.log('🟢 [NURSE APP] Patient ID:', patientId);
            console.log('🟢 [NURSE APP] Update data:', {
                name: finalValues.patientName,
                age: finalValues.age,
                place: finalValues.place,
                sex: finalValues.sex,
                clinicId: clinicId,
                appointmentId: newAppointmentRef.id,
            });

            const patientRef = doc(db, 'patients', patientId);
            console.log('🟢 [NURSE APP] Patient ref path:', patientRef.path);

            try {
                await updateDoc(patientRef, {
                    name: finalValues.patientName,
                    age: finalValues.age,
                    place: finalValues.place,
                    sex: finalValues.sex,
                    clinicIds: arrayUnion(clinicId),
                    visitHistory: arrayUnion(newAppointmentRef.id),
                    totalAppointments: increment(1),
                    updatedAt: serverTimestamp(),
                });
                console.log('✅ [NURSE APP] Patient document updated successfully');

                // Verify the update by reading the document
                const verifyRef = doc(db, 'patients', patientId);
                const verifySnap = await getDoc(verifyRef);
                if (verifySnap.exists()) {
                    const updatedData = verifySnap.data();
                    console.log('✅ [NURSE APP] Verified patient document after update:', {
                        name: updatedData.name,
                        age: updatedData.age,
                        place: updatedData.place,
                        sex: updatedData.sex,
                        clinicIds: updatedData.clinicIds,
                        totalAppointments: updatedData.totalAppointments,
                    });
                } else {
                    console.error('❌ [NURSE APP] Patient document does not exist after update!');
                }
            } catch (serverError: any) {
                console.error('❌ [NURSE APP] Error updating patient document:', serverError);
                console.error('❌ [NURSE APP] Error code:', serverError.code);
                console.error('❌ [NURSE APP] Error message:', serverError.message);

                const permissionError = new FirestorePermissionError({
                    path: patientRef.path,
                    operation: 'update',
                    requestResourceData: { visitHistory: 'add', totalAppointments: 'increment' }
                });
                errorEmitter.emit('permission-error', permissionError);
                throw serverError;
            }

            // Send notification for new appointments (match clinic app behavior)
            try {
                const clinicName = 'The clinic'; // You can fetch actual clinic name if needed

                await sendAppointmentBookedByStaffNotification({
                    firestore: db,
                    patientId,
                    appointmentId: newAppointmentRef.id,
                    doctorName: newAppointment.doctor ?? '',
                    clinicName,
                    date: newAppointment.date,
                    time: newAppointment.time,
                    arriveByTime: newAppointment.arriveByTime,
                    tokenNumber: newAppointment.tokenNumber,
                    bookedBy: 'nurse',
                });
            } catch (notifError) {
                console.error('Failed to send appointment booked notification from nurse app:', notifError);
            }

            setIsSubmitted(true);
            toast({ title: 'Success', description: 'Appointment booked successfully!' });
            setTimeout(() => {
                router.push('/dashboard');
            }, 2000);

        } catch (error: any) {
            if (error.name !== 'FirestorePermissionError') {
                console.error('Error booking appointment:', error);
                toast({ variant: 'destructive', title: 'Booking Failed', description: error.message || 'An unexpected error occurred.' });
            }
        } finally {
            setIsSubmitting(false);
        }
    }, [clinicId, doctor, toast, router, patient, form, patientId]);

    useEffect(() => {
        const fetchData = async () => {
            if (!clinicId) return;
            try {
                if (doctorId) {
                    const docRef = doc(db, "doctors", doctorId);
                    const docSnap = await getDoc(docRef).catch(async (serverError) => {
                        const permissionError = new FirestorePermissionError({ path: docRef.path, operation: 'get' });
                        errorEmitter.emit('permission-error', permissionError);
                        throw serverError;
                    });
                    if (docSnap.exists() && docSnap.data().clinicId === clinicId) {
                        const fetchedDoctor = { id: docSnap.id, ...docSnap.data() } as Doctor;
                        setDoctor(fetchedDoctor);
                        form.setValue('doctor', fetchedDoctor.name);
                        form.setValue('department', fetchedDoctor.department);
                    } else {
                        toast({ variant: 'destructive', title: 'Error', description: 'Doctor not found or does not belong to this clinic.' });
                    }
                }
                if (patientId) {
                    console.log('🔵 [NURSE APP] Fetching patient from database, patientId:', patientId);
                    const patientRef = doc(db, 'patients', patientId);
                    const patientSnap = await getDoc(patientRef);
                    if (patientSnap.exists()) {
                        const fetchedPatient = { id: patientId, ...patientSnap.data() } as Patient;
                        console.log('🔵 [NURSE APP] Patient fetched from database:', {
                            id: fetchedPatient.id,
                            name: fetchedPatient.name,
                            age: fetchedPatient.age,
                            place: fetchedPatient.place,
                            sex: fetchedPatient.sex,
                            phone: fetchedPatient.phone,
                            communicationPhone: fetchedPatient.communicationPhone,
                        });
                        setPatient(fetchedPatient);

                        const formValues = {
                            ...form.getValues(),
                            patientName: fetchedPatient.name || '',
                            age: fetchedPatient.age ?? undefined,
                            phone: (fetchedPatient.communicationPhone || fetchedPatient.phone || '').replace('+91', ''),
                            place: fetchedPatient.place || '',
                            sex: fetchedPatient.sex || undefined,
                        };
                        console.log('🔵 [NURSE APP] Setting form values:', formValues);
                        form.reset(formValues);
                    } else {
                        console.error('❌ [NURSE APP] Patient document not found in database');
                        toast({ variant: 'destructive', title: 'Error', description: 'Patient details could not be found.' });
                    }
                }
            } catch (error: any) {
                if (error.name !== 'FirestorePermissionError') {
                    console.error("Error fetching data:", error);
                }
            }
        };
        fetchData();
    }, [doctorId, form, clinicId, patientId, toast]);

    async function onSubmit(values: z.infer<typeof formSchema>) {
        await createAppointment(values);
    }

    const getHeaderDate = () => {
        const slotValue = form.getValues('slot');
        if (!slotValue) return "Enter Patient Details";

        const date = new Date(slotValue);
        if (isNaN(date.getTime())) {
            return "Invalid Date";
        }
        const appointmentTimeStr = format(date, "hh:mm a");
        const arriveByTime = getArriveByTime(appointmentTimeStr, date);
        return `Booking for ${format(date, "EEEE, MMMM d")} - Arrive by: ${arriveByTime}`;
    };

    const getBackButtonLink = () => {
        if (isPhoneBooking) return `/phone-booking/details?doctor=${doctorId}&patientId=${patientId}&source=phone`;
        return slotParam ? `/book-appointment?doctor=${doctorId}&slot=${slotParam}` : `/book-appointment?doctor=${doctorId}`;
    };


    if (!doctorId) {
        return (
            <div className="w-full h-full flex flex-col items-center justify-center text-center p-8">
                <h2 className="text-xl font-semibold">Doctor Not Selected</h2>
                <p className="text-muted-foreground mt-2">Please go back and select a doctor to continue.</p>
                <Link href="/dashboard" passHref className="mt-6">
                    <Button>
                        <ArrowLeft className="mr-2" />
                        Go Back to Dashboard
                    </Button>
                </Link>
            </div>
        );
    }

    if (isSubmitted) {
        return (
            <div className="flex flex-col h-full items-center justify-center text-center gap-4 py-8">
                <CheckCircle className="h-16 w-16 text-green-500" />
                <h2 className="text-xl font-semibold">Appointment Booked!</h2>
                <p className="text-muted-foreground">
                    The appointment has been successfully scheduled. Redirecting...
                </p>
            </div>
        )
    }

    if (isPhoneBooking) {
        if (!patient || !doctor || !slotParam) {
            return (
                <div className="flex flex-col h-full items-center justify-center">
                    <Loader2 className="h-8 w-8 animate-spin" />
                    <p className="mt-2 text-muted-foreground">Loading booking summary...</p>
                </div>
            )
        }

        const bookingDate = new Date(slotParam);

        return (
            <div className="flex flex-col h-full">
                <header className="flex items-center gap-4 p-4 border-b">
                    <Link href={getBackButtonLink()}>
                        <Button variant="ghost" size="icon">
                            <ArrowLeft />
                        </Button>
                    </Link>
                    <div className="flex-1">
                        <h1 className="text-xl font-bold">Confirm Booking</h1>
                        <p className="text-sm text-muted-foreground">
                            Step 3: Review and confirm
                        </p>
                    </div>
                </header>
                <div className="p-6 overflow-y-auto flex-1">
                    <Card>
                        <CardHeader>
                            <CardTitle>Appointment Summary</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <div className="flex items-center gap-4">
                                <User className="h-5 w-5 text-muted-foreground" />
                                <div>
                                    <p className="text-sm text-muted-foreground">Patient</p>
                                    <p className="font-semibold">{patient.name}</p>
                                </div>
                            </div>
                            <div className="flex items-center gap-4">
                                <User className="h-5 w-5 text-muted-foreground" />
                                <div>
                                    <p className="text-sm text-muted-foreground">Doctor</p>
                                    <p className="font-semibold">Dr. {doctor.name} <span className="text-xs text-muted-foreground">({doctor.department})</span></p>
                                </div>
                            </div>
                            <div className="flex items-center gap-4">
                                <Calendar className="h-5 w-5 text-muted-foreground" />
                                <div>
                                    <p className="text-sm text-muted-foreground">Date</p>
                                    <p className="font-semibold">{format(bookingDate, "EEEE, d MMMM yyyy")}</p>
                                </div>
                            </div>
                            <div className="flex items-center gap-4">
                                <Clock className="h-5 w-5 text-muted-foreground" />
                                <div>
                                    <p className="text-sm text-muted-foreground">Arrive by</p>
                                    <p className="font-semibold">{getArriveByTime(format(bookingDate, "hh:mm a"), bookingDate)}</p>
                                </div>
                            </div>
                        </CardContent>
                    </Card>
                </div>
                <footer className="p-4 mt-auto bg-card sticky bottom-0">
                    <Button onClick={() => createAppointment()} className="w-full" disabled={isSubmitting}>
                        {isSubmitting ? (
                            <>
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                Booking Appointment...
                            </>
                        ) : (
                            'Confirm & Book Appointment'
                        )}
                    </Button>
                </footer>
            </div>
        )
    }

    return (
        <div className="flex flex-col h-full">
            <header className="flex items-center gap-4 p-4 border-b">
                <Link href={getBackButtonLink()}>
                    <Button variant="ghost" size="icon">
                        <ArrowLeft />
                    </Button>
                </Link>
                <div className="flex-1">
                    <h1 className="text-xl font-bold">Patient Details</h1>
                    <p className="text-sm text-muted-foreground">
                        {getHeaderDate()}
                    </p>
                </div>
            </header>
            <div className="p-6 overflow-y-auto flex-1">
                <Form {...form}>
                    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                        <FormField
                            control={form.control}
                            name="patientName"
                            render={({ field }) => (
                                <FormItem>
                                    <FormLabel>Full Name</FormLabel>
                                    <FormControl>
                                        <Input placeholder="Enter patient name" {...field} />
                                    </FormControl>
                                    <FormMessage />
                                </FormItem>
                            )}
                        />
                        <FormField
                            control={form.control}
                            name="age"
                            render={({ field }) => (
                                <FormItem>
                                    <FormLabel>Age</FormLabel>
                                    <FormControl>
                                        <Input
                                            type="number"
                                            placeholder="Enter the age"
                                            {...field}
                                            value={field.value === 0 ? '' : (field.value ?? '')}
                                            onChange={(e) => {
                                                const value = e.target.value === '' ? undefined : Number(e.target.value);
                                                field.onChange(value);
                                            }}
                                            className="[&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none [-moz-appearance:textfield]"
                                        />
                                    </FormControl>
                                    <FormMessage />
                                </FormItem>
                            )}
                        />
                        <FormField
                            control={form.control}
                            name="phone"
                            render={({ field }) => (
                                <FormItem>
                                    <FormLabel>Phone Number</FormLabel>
                                    <FormControl>
                                        <div className="relative">
                                            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">+91</span>
                                            <Input
                                                type="tel"
                                                {...field}
                                                value={field.value || ''}
                                                className="pl-12"
                                                placeholder="Enter 10-digit number"
                                                onChange={(e) => {
                                                    // Only allow digits, max 10 digits
                                                    let value = e.target.value.replace(/\D/g, ''); // Remove all non-digits
                                                    // Remove +91 if user tries to enter it manually
                                                    value = value.replace(/^91/, '');
                                                    // Limit to 10 digits
                                                    if (value.length > 10) {
                                                        value = value.slice(0, 10);
                                                    }
                                                    field.onChange(value);
                                                }}
                                            />
                                        </div>
                                    </FormControl>
                                    <FormMessage />
                                </FormItem>
                            )}
                        />
                        <FormField
                            control={form.control}
                            name="place"
                            render={({ field }) => (
                                <FormItem>
                                    <FormLabel>Place</FormLabel>
                                    <FormControl>
                                        <Input placeholder="Enter place" {...field} />
                                    </FormControl>
                                    <FormMessage />
                                </FormItem>
                            )}
                        />
                        <FormField
                            control={form.control}
                            name="sex"
                            render={({ field }) => (
                                <FormItem>
                                    <FormLabel>Sex</FormLabel>
                                    <Select onValueChange={field.onChange} value={field.value || ""}>
                                        <FormControl>
                                            <SelectTrigger>
                                                <SelectValue placeholder="Select gender" />
                                            </SelectTrigger>
                                        </FormControl>
                                        <SelectContent>
                                            <SelectItem value="Male">Male</SelectItem>
                                            <SelectItem value="Female">Female</SelectItem>
                                            <SelectItem value="Other">Other</SelectItem>
                                        </SelectContent>
                                    </Select>
                                    <FormMessage />
                                </FormItem>
                            )}
                        />

                        <Button type="submit" className="w-full mt-6" disabled={isSubmitting}>
                            {isSubmitting ? (
                                <>
                                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                    Booking Appointment...
                                </>
                            ) : (
                                'Confirm Appointment'
                            )}
                        </Button>
                    </form>
                </Form>
            </div>
        </div>
    );
}

export default function AppointmentDetailsForm() {
    return (
        <Suspense fallback={<div>Loading...</div>}>
            <AppointmentDetailsFormContent />
        </Suspense>
    );
}
