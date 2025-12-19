'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { format, parse, subMinutes, addMinutes, isBefore, isAfter } from 'date-fns';
import { Loader2, Plus, CheckCircle2, X, Clock, Calendar, Users, Radio, Hourglass } from 'lucide-react';
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogClose, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { CardTitle, CardDescription } from '@/components/ui/card';
import { useUser } from '@/firebase/auth/use-user';
import { useFirestore } from '@/firebase';
import { getPatientListFromCache, savePatientListToCache } from '@/lib/patient-cache';
import { useLanguage } from '@/contexts/language-context';
import { collection, query, where, getDocs, doc, updateDoc, addDoc, serverTimestamp, setDoc, arrayUnion, DocumentReference, writeBatch, getDoc, Firestore, increment, deleteDoc, runTransaction } from 'firebase/firestore';
import type { Doctor, Patient, Appointment } from '@/lib/types';
import { errorEmitter } from '@/firebase/error-emitter';
import { FirestorePermissionError } from '@/firebase/errors';
import { isWithinBookingWindow, buildBreakIntervals, applyBreakOffsets, parseTime as parseTimeUtil } from '@/lib/utils';
import { getSessionEnd, getSessionBreakIntervals, calculateWalkInDetails } from '@kloqo/shared-core';


const createFormSchema = (t: any) => z.object({
    selectedPatient: z.string().optional(),
    name: z.string()
        .min(3, { message: t.patientForm.nameMinLength })
        .regex(/^[a-zA-Z\s]+$/, { message: t.patientForm.nameAlphabetsOnly })
        .refine(name => !name.startsWith(' ') && !name.endsWith(' ') && !name.includes('  '), {
            message: t.patientForm.nameSpaces
        }),
    age: z.preprocess(
        (val) => {
            if (val === "" || val === undefined || val === null) return undefined;
            const num = parseInt(val.toString(), 10);
            if (isNaN(num)) return undefined;
            return num;
        },
        z.number({
            required_error: t.patientForm.ageRequired,
            invalid_type_error: t.patientForm.ageRequired
        })
            .min(1, { message: t.patientForm.agePositive })
            .max(120, { message: t.patientForm.ageMax })
    ),
    sex: z.enum(['Male', 'Female', 'Other'], { required_error: t.patientForm.genderRequired }),
    place: z.string().min(2, { message: t.patientForm.placeRequired }),
    phone: z.string()
        .optional()
        .refine((val) => {
            if (!val || val.length === 0) return true;
            // Strip +91 prefix if present, then check for exactly 10 digits
            const cleaned = val.replace(/^\+91/, '');
            return /^\d{10}$/.test(cleaned);
        }, {
            message: t.patientForm.phoneFormat
        }),
});

interface PatientFormProps {
    selectedDoctor: Doctor;
    appointmentType: 'Walk-in' | 'Online';
}

export function PatientForm({ selectedDoctor, appointmentType }: PatientFormProps) {
    const router = useRouter();
    const searchParams = useSearchParams();
    const slotISO = searchParams.get('slot');
    const selectedSlot = slotISO ? new Date(slotISO) : null;

    const [isEstimateModalOpen, setIsEstimateModalOpen] = useState(false);
    const [isTokenModalOpen, setIsTokenModalOpen] = useState(false);
    const [generatedToken, setGeneratedToken] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false); // Start with false for optimistic rendering
    const [isSubmitting, setIsSubmitting] = useState(false); // For form submission
    const [addNewPatient, setAddNewPatient] = useState(false);
    const [estimatedConsultationTime, setEstimatedConsultationTime] = useState<Date | null>(null);
    const [estimatedDelay, setEstimatedDelay] = useState(0);
    const [patientsAhead, setPatientsAhead] = useState(0);
    const [primaryPatient, setPrimaryPatient] = useState<Patient | null>(null);
    const [relatedPatients, setRelatedPatients] = useState<Patient[]>([]);
    const [walkInData, setWalkInData] = useState<any>(null); // To store data before confirmation
    const [hasRecalculated, setHasRecalculated] = useState(false); // Track if we've recalculated before confirmation
    const lastResetIdRef = useRef<string | null>(null);

    const { user } = useUser();
    const firestore = useFirestore();
    const { toast } = useToast();
    const { t } = useLanguage();

    const resolveSlotDetails = useCallback(
        (targetSlotIndex: number, appointmentDate: Date) => {
            if (!selectedDoctor?.availabilitySlots?.length) {
                return null;
            }

            const dayOfWeek = format(appointmentDate, 'EEEE');
            const availabilityForDay = selectedDoctor.availabilitySlots.find(session => session.day === dayOfWeek);
            if (!availabilityForDay || !availabilityForDay.timeSlots?.length) {
                return null;
            }

            const slotDuration = selectedDoctor.averageConsultingTime || 15;
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
        [selectedDoctor]
    );

    const ensureDoctorAvailabilityForToday = useCallback(() => {
        if (!selectedDoctor?.availabilitySlots?.length) {
            return { hasSlots: false as const };
        }

        const todayDay = format(new Date(), 'EEEE');
        const todaysAvailability = selectedDoctor.availabilitySlots.find(slot => slot.day === todayDay);

        if (!todaysAvailability || !todaysAvailability.timeSlots?.length) {
            return { hasSlots: false as const };
        }

        return { hasSlots: true as const };
    }, [selectedDoctor]);

    const formSchema = useMemo(() => createFormSchema(t), [t]);
    type FormData = z.infer<typeof formSchema>;

    const form = useForm<FormData>({
        resolver: zodResolver(formSchema),
        mode: 'onBlur',
        defaultValues: {
            name: '',
            age: undefined,
            sex: undefined,
            place: '',
            phone: user?.phoneNumber || '',
            selectedPatient: ''
        },
    });

    const fetchPatientData = useCallback(async () => {
        if (!user?.phoneNumber) {
            setIsLoading(false);
            return;
        }

        // Try to load from cache first for instant display
        const cachedData = getPatientListFromCache(user.phoneNumber);
        if (cachedData) {
            if (!cachedData.primary) {
                setPrimaryPatient(null);
                setRelatedPatients([]);
                setAddNewPatient(true);
                form.reset({
                    selectedPatient: 'new',
                    name: '',
                    age: undefined,
                    sex: undefined,
                    place: '',
                    phone: user.phoneNumber,
                });
            } else {
                const primaryData = { ...cachedData.primary, isPrimary: true } as Patient;
                setPrimaryPatient(primaryData);
                setRelatedPatients(Array.isArray(cachedData.relatives) ? cachedData.relatives : []);

                // Auto-select primary patient if no selection exists
                if (!form.getValues('selectedPatient')) {
                    form.reset({
                        name: primaryData.name || '',
                        age: primaryData.age === 0 ? undefined : (primaryData.age ?? undefined),
                        sex: primaryData.sex || undefined,
                        place: primaryData.place || '',
                        phone: primaryData.communicationPhone || primaryData.phone || user.phoneNumber || '',
                        selectedPatient: primaryData.id,
                    });
                    setAddNewPatient(false); // Ensure form shows
                }
            }
            // Continue in background to fetch fresh data
        }

        // Fetch fresh data in background (don't block UI)
        setIsLoading(true);
        try {
            const response = await fetch(`/api/patients?phone=${encodeURIComponent(user.phoneNumber)}`, {
                cache: 'no-store',
            });

            if (!response.ok) {
                throw new Error(await response.text());
            }

            const { primary, relatives }: { primary: (Patient & { id: string }) | null; relatives: (Patient & { id: string })[] } = await response.json();

            // Cache the response
            savePatientListToCache(user.phoneNumber, primary, relatives);

            if (!primary) {
                setPrimaryPatient(null);
                setRelatedPatients([]);
                setAddNewPatient(true);
                form.reset({
                    selectedPatient: 'new',
                    name: '',
                    age: undefined,
                    sex: undefined,
                    place: '',
                    phone: user.phoneNumber,
                });
                setIsLoading(false);
                return;
            }

            const primaryData = { ...primary, isPrimary: true } as Patient;
            setPrimaryPatient(primaryData);
            setRelatedPatients(Array.isArray(relatives) ? relatives : []);

            if (!form.getValues('selectedPatient')) {
                form.reset({
                    name: primaryData.name || '',
                    age: primaryData.age === 0 ? undefined : (primaryData.age ?? undefined),
                    sex: primaryData.sex || undefined,
                    place: primaryData.place || '',
                    phone: primaryData.communicationPhone || primaryData.phone || user.phoneNumber || '',
                    selectedPatient: primaryData.id,
                });
            }
        } catch (error) {
            console.error("Error fetching patient profile:", error);
            if (!(error instanceof FirestorePermissionError)) {
                toast({ variant: "destructive", title: t.common.error, description: t.patientForm.patientCreationFailed });
            }
        } finally {
            setIsLoading(false);
        }
    }, [user?.phoneNumber, form, t, toast]);

    // Start fetching patient data immediately when component mounts or user changes
    // Don't wait for doctor - patient data is independent
    useEffect(() => {
        if (user?.phoneNumber) {
            fetchPatientData();
        }
    }, [user?.phoneNumber, fetchPatientData]);

    const displayedPatients: Patient[] = useMemo(() => (primaryPatient ? [primaryPatient, ...relatedPatients] : []), [primaryPatient, relatedPatients]);
    const selectedPatientId = form.watch('selectedPatient');
    const showDetailsForm = addNewPatient || !!selectedPatientId;

    useEffect(() => {
        const currentId = addNewPatient ? 'new' : selectedPatientId;
        if (!currentId || currentId === lastResetIdRef.current) return;

        if (currentId === 'new') {
            form.reset({
                selectedPatient: 'new',
                name: '',
                age: undefined,
                sex: undefined,
                place: '',
                phone: primaryPatient ? '' : user?.phoneNumber || '', // If adding relative, clear phone. If new primary, use their phone.
            }, {
                keepDefaultValues: false,
                keepValues: false,
            });
            lastResetIdRef.current = 'new';
        } else {
            const patient = displayedPatients.find(p => p.id === currentId);
            if (patient) {
                // Extract only the 10 digits from phone (remove +91 prefix if present)
                let displayPhone = '';
                const patientPhone = patient.phone || '';
                if (patientPhone) {
                    const digitsOnly = patientPhone.replace(/^\+91/, '');
                    displayPhone = digitsOnly;
                }

                form.reset({
                    name: patient.name || '',
                    age: patient.age === 0 ? undefined : (patient.age ?? undefined),
                    sex: patient.sex || undefined,
                    place: patient.place || '',
                    phone: displayPhone || (patient.isPrimary ? (user?.phoneNumber?.replace(/^\+91/, '') || '') : ''),
                    selectedPatient: patient.id,
                });
                lastResetIdRef.current = currentId;
            }
        }
    }, [addNewPatient, selectedPatientId, displayedPatients, form, user?.phoneNumber, primaryPatient]);

    const releaseReservation = async (reservationId?: string | null, delayMs: number = 0) => {
        if (!reservationId) return;
        if (delayMs > 0) {
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
        try {
            await deleteDoc(doc(firestore!, 'slot-reservations', reservationId));
        } catch (error) {
            console.warn('⚠️ [PF] Failed to release reservation:', { reservationId, error });
        }
    };

    const handleConfirmWalkIn = async () => {
        // console.log(`[WALK-IN DEBUG] 🔵 handleConfirmWalkIn CALLED`, {
        //     hasFirestore: !!firestore,
        //     hasWalkInData: !!walkInData,
        //     hasUserPhone: !!user?.phoneNumber,
        //     walkInData: walkInData ? {
        //         patientId: walkInData.patientId,
        //         hasEstimatedDetails: !!walkInData.estimatedDetails
        //     } : null,
        //     timestamp: new Date().toISOString()
        // });

        if (!walkInData || !user?.phoneNumber) {
            console.warn(`[WALK-IN DEBUG] ⚠️ handleConfirmWalkIn aborted - missing required data`, {
                walkInData: !!walkInData,
                userPhone: !!user?.phoneNumber
            });
            return;
        }

        if (!firestore) {
            console.warn('[WALK-IN DEBUG] ⚠️ handleConfirmWalkIn aborted - firestore not available');
            toast({
                variant: 'destructive',
                title: t.bookAppointment.error,
                description: t.bookAppointment.couldNotLoadDoctor,
            });
            setIsSubmitting(false);
            return;
        }

        const bookingRequestId = `walkin-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        // console.log(`[WALK-IN DEBUG] ====== NEW WALK-IN BOOKING REQUEST ======`, {
        //     requestId: bookingRequestId,
        //     patientId: walkInData.patientId,
        //     doctor: selectedDoctor.name,
        //     clinicId: selectedDoctor.clinicId,
        //     timestamp: new Date().toISOString()
        // });

        setIsSubmitting(true);
        setIsEstimateModalOpen(false);

        // ============================================================================
        // PRE-CONFIRMATION RECALCULATION (matches clinic/nurse app logic)
        // ============================================================================
        // Recalculate once before final booking to ensure user sees latest queue status
        if (!hasRecalculated) {
            // console.log(`[WALK-IN DEBUG] ${bookingRequestId}: Pre-confirmation recalculation starting...`);

            try {
                const freshDetails = await calculateWalkInDetails(
                    firestore,
                    selectedDoctor
                );

                // Compare with original estimate
                const originalEstimate = walkInData.estimatedDetails;
                const queueDiff = Math.abs(freshDetails.patientsAhead - originalEstimate.patientsAhead);
                const timeDiffMs = Math.abs(
                    freshDetails.estimatedTime.getTime() - originalEstimate.estimatedTime.getTime()
                );
                const timeDiffMinutes = timeDiffMs / (60 * 1000);

                // console.log(`[WALK-IN DEBUG] ${bookingRequestId}: Estimate comparison:`, {
                //     original: {
                //         patientsAhead: originalEstimate.patientsAhead,
                //         time: format(originalEstimate.estimatedTime, 'hh:mm a')
                //     },
                //     fresh: {
                //         patientsAhead: freshDetails.patientsAhead,
                //         time: format(freshDetails.estimatedTime, 'hh:mm a')
                //     },
                //     differences: {
                //         queueDiff,
                //         timeDiffMinutes: Math.round(timeDiffMinutes)
                //     }
                // });

                // Thresholds for significant changes (matches clinic/nurse app logic)
                const QUEUE_THRESHOLD = 2; // More than 2 patients difference
                const TIME_THRESHOLD = 15; // More than 15 minutes difference

                if (queueDiff > QUEUE_THRESHOLD || timeDiffMinutes > TIME_THRESHOLD) {
                    console.log(`[WALK-IN DEBUG] ${bookingRequestId}: Significant change detected - updating estimate and requiring re-confirmation`);

                    // Update the displayed estimate (apply session break offsets)
                    const appointmentDate = parse(format(new Date(), 'd MMMM yyyy'), 'd MMMM yyyy', new Date());
                    const sessionBreaks = freshDetails.sessionIndex !== undefined && freshDetails.sessionIndex !== null
                        ? getSessionBreakIntervals(selectedDoctor, appointmentDate, freshDetails.sessionIndex)
                        : [];
                    const breakIntervals = buildBreakIntervals(selectedDoctor, appointmentDate);
                    const chosenBreaks = sessionBreaks.length > 0 ? sessionBreaks : breakIntervals;
                    const adjustedFreshTime = chosenBreaks.length > 0
                        ? applyBreakOffsets(freshDetails.estimatedTime, chosenBreaks)
                        : freshDetails.estimatedTime;
                    console.log('[PF:ESTIMATE-RECALC] Fresh estimate', {
                        estimated: freshDetails.estimatedTime?.toISOString?.() || freshDetails.estimatedTime,
                        sessionIndex: freshDetails.sessionIndex,
                        sessionBreaks: sessionBreaks.map(b => ({
                            start: b.start.toISOString(),
                            end: b.end.toISOString(),
                            sessionIndex: b.sessionIndex
                        })),
                        fallbackBreaks: breakIntervals.map(b => ({
                            start: b.start.toISOString(),
                            end: b.end.toISOString()
                        })),
                        chosenBreaks: chosenBreaks.map(b => ({
                            start: b.start.toISOString(),
                            end: b.end.toISOString(),
                            sessionIndex: (b as any).sessionIndex
                        })),
                        adjusted: adjustedFreshTime?.toISOString?.() || adjustedFreshTime,
                    });

                    setPatientsAhead(freshDetails.patientsAhead);
                    setEstimatedConsultationTime(adjustedFreshTime);

                    // Update walkInData with fresh details
                    setWalkInData({
                        ...walkInData,
                        estimatedDetails: freshDetails
                    });

                    // Mark that we've recalculated
                    setHasRecalculated(true);

                    // Show toast notification to user
                    toast({
                        title: "Queue Updated",
                        description: `The queue has changed. Now ${freshDetails.patientsAhead} patient${freshDetails.patientsAhead !== 1 ? 's' : ''} ahead, estimated time ${format(freshDetails.estimatedTime, 'hh:mm a')}.`,
                        duration: 6000,
                    });

                    // Reopen the estimate modal with updated info
                    setIsEstimateModalOpen(true);
                    setIsSubmitting(false);
                    return; // User must click "Confirm Walk-In" again with updated info
                }

                // console.log(`[WALK-IN DEBUG] ${bookingRequestId}: Estimate still accurate - proceeding with booking`);
                setHasRecalculated(true);
            } catch (recalcError: any) {
                console.error(`[WALK-IN DEBUG] ${bookingRequestId}: Error during pre-confirmation recalculation:`, recalcError);
                // If recalculation fails, proceed with original estimate (fallback to existing behavior)
                // This ensures booking doesn't fail completely due to recalculation issues
                toast({
                    title: "Notice",
                    description: "Could not verify latest queue status. Proceeding with original estimate.",
                    duration: 6000,
                });
                setHasRecalculated(true); // Mark as recalculated to prevent retry
            }
        }

        const { patientId, formData } = walkInData;

        try {
            const response = await fetch('/api/bookings/walk-in', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    patientId,
                    doctor: selectedDoctor,
                    clinicId: selectedDoctor.clinicId,
                    appointmentType,
                    patientProfile: walkInData?.patientProfile ?? null,
                    formData,
                }),
            });

            if (!response.ok) {
                const errorBody = await response.json().catch(() => null);
                throw new Error(errorBody?.error || t.bookAppointment.bookingFailed);
            }

            const result = await response.json();

            if (result?.tokenNumber) {
                setGeneratedToken(result.tokenNumber);
            }
            if (result?.estimatedTime) {
                const appointmentDate = parse(format(new Date(), 'd MMMM yyyy'), 'd MMMM yyyy', new Date());
                const sessionBreaks = result?.estimatedDetails?.sessionIndex !== undefined && result?.estimatedDetails?.sessionIndex !== null
                    ? getSessionBreakIntervals(selectedDoctor, appointmentDate, result.estimatedDetails.sessionIndex)
                    : [];
                const breakIntervals = buildBreakIntervals(selectedDoctor, appointmentDate);
                const chosenBreaks = sessionBreaks.length > 0 ? sessionBreaks : breakIntervals;
                const estimated = new Date(result.estimatedTime);
                const adjusted = chosenBreaks.length > 0 ? applyBreakOffsets(estimated, chosenBreaks) : estimated;
                console.log('[PF:ESTIMATE-POSTBOOK]', {
                    estimated: estimated.toISOString(),
                    adjusted: adjusted.toISOString(),
                    sessionIndex: result?.estimatedDetails?.sessionIndex,
                    sessionBreaks: sessionBreaks.map(b => ({
                        start: b.start.toISOString(),
                        end: b.end.toISOString(),
                        sessionIndex: b.sessionIndex
                    })),
                    fallbackBreaks: breakIntervals.map(b => ({
                        start: b.start.toISOString(),
                        end: b.end.toISOString()
                    })),
                    chosenBreaks: chosenBreaks.map(b => ({
                        start: b.start.toISOString(),
                        end: b.end.toISOString(),
                        sessionIndex: (b as any).sessionIndex
                    })),
                });
                setEstimatedConsultationTime(adjusted);
            }
            if (typeof result?.patientsAhead === 'number') {
                setPatientsAhead(result.patientsAhead);
            }
            if (result?.estimatedDetails) {
                setWalkInData((prev: typeof walkInData) =>
                    prev ? { ...prev, estimatedDetails: result.estimatedDetails } : prev
                );
            }

            setIsTokenModalOpen(true);
        } catch (error) {
            console.error('[WALK-IN DEBUG] API booking failed', error);
            const err = error as Error;
            toast({
                variant: 'destructive',
                title: t.bookAppointment.error,
                description: err?.message || t.bookAppointment.bookingFailed,
            });
        } finally {
            setIsSubmitting(false);
        }
    };

    async function onSubmit(data: FormData) {
        setIsSubmitting(true);
        console.log('[PF:SUBMIT] START', data);
        if (!firestore || !user?.phoneNumber) {
            console.log('[PF:SUBMIT] Missing firestore or user.phoneNumber', { firestore, phone: user?.phoneNumber });
            toast({ variant: "destructive", title: t.common.error, description: t.bookAppointment.incompleteDetails });
            setIsSubmitting(false);
            return;
        }

        const { name, age, sex, place, phone } = data;

        try {
            if (appointmentType === 'Walk-in') {
                const todaysAvailability = ensureDoctorAvailabilityForToday();
                if (!todaysAvailability.hasSlots) {
                    toast({
                        variant: "destructive",
                        title: t.consultToday.bookingFailed,
                        description: t.consultToday.noWalkInSlotsAvailableToday,
                    });
                    setIsSubmitting(false);
                    return;
                }

                if (!isWithinBookingWindow(selectedDoctor)) {
                    console.log('[PF:SUBMIT] Not within booking window', { selectedDoctor });
                    toast({
                        variant: "destructive",
                        title: t.consultToday.bookingFailed,
                        description: `Dr. ${selectedDoctor.name} ${t.consultToday.doctorNotAvailableWalkIn}`,
                    });
                    setIsSubmitting(false);
                    return;
                }

                console.log(`[WALK-IN DEBUG] [onSubmit] Starting walk-in form submission`, {
                    hasPrimaryPatient: !!primaryPatient,
                    addNewPatient,
                    selectedPatient: data.selectedPatient,
                    timestamp: new Date().toISOString()
                });

                // Step 1: Create patient first
                let patientForAppointmentId: string;
                const batch = writeBatch(firestore);

                if (!primaryPatient) { // This is a brand new user creating a primary profile.
                    console.log(`[WALK-IN DEBUG] [onSubmit] Creating new primary patient`);
                    const newPatientRef = doc(collection(firestore, 'patients'));
                    const newPatientData = {
                        id: newPatientRef.id,
                        name, age, sex, place,
                        phone: user.phoneNumber,
                        communicationPhone: user.phoneNumber,
                        clinicIds: [selectedDoctor.clinicId],
                        isPrimary: true,
                        isKloqoMember: false,
                        relatedPatientIds: [],
                        totalAppointments: 0,
                        visitHistory: [],
                        createdAt: serverTimestamp(),
                        updatedAt: serverTimestamp(),
                    };
                    batch.set(newPatientRef, newPatientData);

                    const newUserRef = doc(collection(firestore, 'users'));
                    const newUserData = {
                        phone: user.phoneNumber,
                        role: 'patient',
                        patientId: newPatientRef.id
                    };
                    batch.set(newUserRef, newUserData);

                    patientForAppointmentId = newPatientRef.id;
                    console.log(`[WALK-IN DEBUG] [onSubmit] New primary patient created: ${patientForAppointmentId}`);

                } else {
                    if (addNewPatient) {
                        const newRelatedPatientRef = doc(collection(firestore, 'patients'));
                        let newRelatedPatientData: any = {
                            id: newRelatedPatientRef.id,
                            name, age, sex, place,
                            clinicIds: [selectedDoctor.clinicId],
                            isPrimary: false,
                            totalAppointments: 0,
                            visitHistory: [],
                            createdAt: serverTimestamp(),
                            updatedAt: serverTimestamp(),
                        };

                        // Check if the phone number matches primary patient's phone
                        const primaryPhone = primaryPatient?.phone || primaryPatient?.communicationPhone;
                        const isDuplicatePhone = phone && phone.trim().length > 0 && primaryPhone && phone === primaryPhone.replace('+91', '');

                        if (phone && phone.trim().length > 0 && !isDuplicatePhone) {
                            const fullPhoneNumber = phone.startsWith('+91') ? phone : `+91${phone}`;
                            // Check if phone is unique across all patients and users
                            const patientsRef = collection(firestore, 'patients');
                            const patientQuery = query(patientsRef, where('phone', '==', fullPhoneNumber));
                            const patientSnapshot = await getDocs(patientQuery);

                            const usersRef = collection(firestore, 'users');
                            const userQuery = query(usersRef, where('phone', '==', fullPhoneNumber));
                            const userSnapshot = await getDocs(userQuery);

                            if (!patientSnapshot.empty || !userSnapshot.empty) {
                                toast({
                                    variant: 'destructive',
                                    title: 'Phone Number Already Exists',
                                    description: 'This phone number is already registered to another patient.'
                                });
                                setIsSubmitting(false);
                                return;
                            }

                            const newUserRef = doc(collection(firestore, 'users'));
                            batch.set(newUserRef, { phone: fullPhoneNumber, role: 'patient', patientId: newRelatedPatientRef.id });

                            // If relative has unique phone, they become PRIMARY patient themselves
                            newRelatedPatientData.phone = fullPhoneNumber;
                            newRelatedPatientData.communicationPhone = fullPhoneNumber;
                            newRelatedPatientData.isPrimary = true;
                            newRelatedPatientData.primaryUserId = newUserRef.id;
                            newRelatedPatientData.relatedPatientIds = [];
                        } else {
                            // If duplicate or no phone provided, use primary patient's communication phone
                            newRelatedPatientData.phone = '';
                            newRelatedPatientData.communicationPhone = user.phoneNumber;
                            newRelatedPatientData.isPrimary = false;
                        }
                        batch.set(newRelatedPatientRef, newRelatedPatientData);
                        const primaryPatientRef = doc(firestore, 'patients', primaryPatient.id);
                        // Always add to primary's relatedPatientIds, regardless of whether relative has a phone
                        // Even if relative has a unique phone and becomes isPrimary: true, they are still a relative of the primary patient
                        batch.update(primaryPatientRef, {
                            relatedPatientIds: arrayUnion(newRelatedPatientRef.id),
                            updatedAt: serverTimestamp()
                        });
                        patientForAppointmentId = newRelatedPatientRef.id;
                    } else if (selectedPatientId) {
                        const patientToUpdate = displayedPatients.find(p => p.id === selectedPatientId);
                        if (!patientToUpdate) throw new Error("Patient not found");
                        const updatedData: any = { name, age, sex, place, updatedAt: serverTimestamp() };
                        if (!patientToUpdate.isPrimary && phone && phone.trim().length > 0) {
                            // Check if the phone number matches primary patient's phone
                            const primaryPhone = primaryPatient?.phone || primaryPatient?.communicationPhone;
                            const isDuplicatePhone = primaryPhone && phone === primaryPhone.replace(/^\+91/, '');

                            if (isDuplicatePhone) {
                                // If duplicate or no phone provided, use primary patient's communication phone
                                updatedData.phone = '';
                                updatedData.communicationPhone = user.phoneNumber;
                            } else {
                                // Check if phone number already exists in database (excluding current patient)
                                const fullPhoneNumber = phone.startsWith('+91') ? phone : `+91${phone}`;
                                const existingPatientQuery = query(
                                    collection(firestore, 'patients'),
                                    where('phone', '==', fullPhoneNumber)
                                );
                                const existingSnapshot = await getDocs(existingPatientQuery);

                                const existingPatient = existingSnapshot.docs.find(doc => doc.id !== selectedPatientId);
                                if (existingPatient) {
                                    toast({
                                        variant: "destructive",
                                        title: t.common.error,
                                        description: t.patientForm.phoneAlreadyExists,
                                    });
                                    setIsSubmitting(false);
                                    return;
                                }

                                updatedData.phone = fullPhoneNumber;
                                updatedData.communicationPhone = fullPhoneNumber;
                            }
                        }
                        const patientRef = doc(firestore, 'patients', selectedPatientId);
                        batch.update(patientRef, updatedData);
                        patientForAppointmentId = selectedPatientId;
                    } else {
                        throw new Error("No patient selected")
                    }
                }

                await batch.commit();
                console.log(`[WALK-IN DEBUG] [onSubmit] Patient batch committed, patientId: ${patientForAppointmentId}`);

                // Check for duplicate booking
                const appointmentDateStr = format(new Date(), "d MMMM yyyy");
                console.log(`[WALK-IN DEBUG] [onSubmit] Checking for duplicate appointments...`, {
                    patientId: patientForAppointmentId,
                    doctor: selectedDoctor.name,
                    date: appointmentDateStr,
                    timestamp: new Date().toISOString()
                });

                const duplicateCheckQuery = query(
                    collection(firestore, "appointments"),
                    where("patientId", "==", patientForAppointmentId),
                    where("doctor", "==", selectedDoctor.name),
                    where("date", "==", appointmentDateStr),
                    where("status", "in", ["Pending", "Confirmed", "Completed", "Skipped"])
                );

                const duplicateSnapshot = await getDocs(duplicateCheckQuery);
                console.log(`[WALK-IN DEBUG] [onSubmit] Duplicate check result:`, {
                    foundDuplicates: !duplicateSnapshot.empty,
                    duplicateCount: duplicateSnapshot.docs.length,
                    duplicates: duplicateSnapshot.docs.map(doc => ({
                        id: doc.id,
                        status: doc.data().status,
                        tokenNumber: doc.data().tokenNumber,
                        time: doc.data().time,
                        slotIndex: doc.data().slotIndex,
                        bookedVia: doc.data().bookedVia
                    }))
                });

                if (!duplicateSnapshot.empty) {
                    const existingAppointment = duplicateSnapshot.docs[0].data();
                    const existingToken = existingAppointment.tokenNumber || 'N/A';
                    const existingTime = existingAppointment.time || 'N/A';

                    console.warn(`[WALK-IN DEBUG] [onSubmit] ❌ DUPLICATE APPOINTMENT DETECTED - Blocking walk-in booking`, {
                        patientId: patientForAppointmentId,
                        doctor: selectedDoctor.name,
                        date: appointmentDateStr,
                        existingAppointments: duplicateSnapshot.docs.map(doc => ({
                            id: doc.id,
                            status: doc.data().status,
                            tokenNumber: doc.data().tokenNumber,
                            time: doc.data().time,
                            slotIndex: doc.data().slotIndex,
                            bookedVia: doc.data().bookedVia
                        }))
                    });
                    toast({
                        variant: "destructive",
                        title: "Duplicate Appointment",
                        description: `You already have an appointment with ${selectedDoctor.name} today (Token: ${existingToken}, Time: ${existingTime}). Please cancel the existing appointment first or book for another day.`,
                    });
                    setIsSubmitting(false);
                    return;
                }

                console.log(`[WALK-IN DEBUG] [onSubmit] ✅ No duplicate appointments found, proceeding with walk-in booking`);

                // Step 2: Calculate walk-in details and show modal
                const clinicDocRef = doc(firestore, 'clinics', selectedDoctor.clinicId);
                const clinicSnap = await getDoc(clinicDocRef);
                const clinicData = clinicSnap.data();
                const walkInCapacityThreshold = clinicData?.walkInCapacityThreshold || 0.75;
                const walkInTokenAllotment = clinicData?.walkInTokenAllotment || 5; // Get from clinic data, same as nurse app

                console.log(`[WALK-IN DEBUG] Calculating walk-in details for estimate modal...`, {
                    patientId: patientForAppointmentId,
                    doctor: selectedDoctor.name,
                    clinicId: selectedDoctor.clinicId,
                    walkInTokenAllotment,
                    walkInCapacityThreshold,
                    timestamp: new Date().toISOString()
                });

                try {
                    const estimatedDetails = await calculateWalkInDetails(firestore, selectedDoctor, walkInTokenAllotment, walkInCapacityThreshold);
                    const appointmentDate = parse(format(new Date(), "d MMMM yyyy"), "d MMMM yyyy", new Date());
                    const breakIntervals = buildBreakIntervals(selectedDoctor, appointmentDate);
                    const sessionBreaks = estimatedDetails.sessionIndex !== undefined && estimatedDetails.sessionIndex !== null
                        ? getSessionBreakIntervals(selectedDoctor, appointmentDate, estimatedDetails.sessionIndex)
                        : [];
                    const chosenBreaks = sessionBreaks.length > 0 ? sessionBreaks : breakIntervals;
                    const adjustedEstimatedTime = chosenBreaks.length > 0
                        ? applyBreakOffsets(estimatedDetails.estimatedTime, chosenBreaks)
                        : estimatedDetails.estimatedTime;
                    console.log('[PF:ESTIMATE] Raw estimate', {
                        estimated: estimatedDetails.estimatedTime?.toISOString?.() || estimatedDetails.estimatedTime,
                        sessionIndex: estimatedDetails.sessionIndex,
                        sessionBreaks: sessionBreaks.map(b => ({
                            start: b.start.toISOString(),
                            end: b.end.toISOString(),
                            sessionIndex: b.sessionIndex
                        })),
                        fallbackBreaks: breakIntervals.map(b => ({
                            start: b.start.toISOString(),
                            end: b.end.toISOString()
                        })),
                        chosenBreaks: chosenBreaks.map(b => ({
                            start: b.start.toISOString(),
                            end: b.end.toISOString(),
                            sessionIndex: (b as any).sessionIndex
                        })),
                        adjusted: adjustedEstimatedTime?.toISOString?.() || adjustedEstimatedTime,
                    });

                    // Availability guard: block opening modal if estimate is outside availability (incl. extensions)
                    let availabilityEnd: Date | null = estimatedDetails.sessionIndex !== undefined && estimatedDetails.sessionIndex !== null
                        ? getSessionEnd(selectedDoctor, appointmentDate, estimatedDetails.sessionIndex)
                        : null;
                    let availabilityEndLabel = availabilityEnd ? format(availabilityEnd, 'hh:mm a') : '';
                    if (!availabilityEnd && selectedDoctor.availabilitySlots?.length) {
                        const dayStr = format(appointmentDate, 'EEEE');
                        const availabilityForDay = selectedDoctor.availabilitySlots.find(s => s.day === dayStr);
                        if (availabilityForDay && availabilityForDay.timeSlots.length > 0) {
                            const lastSessionIndex = availabilityForDay.timeSlots.length - 1;
                            const lastSession = availabilityForDay.timeSlots[lastSessionIndex];
                            const originalEnd = parseTimeUtil(lastSession.to, appointmentDate);
                            availabilityEnd = originalEnd;
                            availabilityEndLabel = format(originalEnd, 'hh:mm a');

                            const dateKey = format(appointmentDate, 'd MMMM yyyy');
                            const ext = (selectedDoctor as any).availabilityExtensions?.[dateKey];
                            const sessionExt = ext?.sessions?.find((s: any) => s.sessionIndex === lastSessionIndex);
                            if (sessionExt?.newEndTime) {
                                try {
                                    const extendedEnd = parseTimeUtil(sessionExt.newEndTime, appointmentDate);
                                    if (isAfter(extendedEnd, availabilityEnd)) {
                                        availabilityEnd = extendedEnd;
                                        availabilityEndLabel = format(extendedEnd, 'hh:mm a');
                                    }
                                } catch {
                                    // ignore
                                }
                            }
                        }
                    }

                    const consultationTime = selectedDoctor?.averageConsultingTime || 15;
                    const apptEnd = addMinutes(adjustedEstimatedTime, consultationTime);
                    const isOutside = availabilityEnd ? isAfter(apptEnd, availabilityEnd) : false;

                    if (isOutside) {
                        toast({
                            variant: "destructive",
                            title: "Walk-in Not Available",
                            description: `Next estimated time ~${format(adjustedEstimatedTime, 'hh:mm a')} is outside availability (ends at ${availabilityEndLabel || 'N/A'}).`,
                        });
                        setIsSubmitting(false);
                        return;
                    }

                    setWalkInData({ patientId: patientForAppointmentId, formData: data, estimatedDetails });
                    setPatientsAhead(estimatedDetails.patientsAhead);
                    setEstimatedConsultationTime(adjustedEstimatedTime);
                    setEstimatedDelay(0);
                    setHasRecalculated(false); // Reset recalculation flag for new booking
                    setIsEstimateModalOpen(true);
                    console.log(`[WALK-IN DEBUG] Estimate modal opened - waiting for user confirmation`);
                    setIsSubmitting(false);
                } catch (walkInError: any) {
                    console.error(`[WALK-IN DEBUG] Error calculating walk-in details:`, walkInError);
                    const errorMessage = walkInError?.message || "";
                    const isNoSlotsAvailable = errorMessage.includes("No walk-in slots are available") ||
                        errorMessage.includes("No available slots match");
                    toast({
                        variant: "destructive",
                        title: t.consultToday.bookingFailed,
                        description: isNoSlotsAvailable ? t.consultToday.noWalkInSlotsAvailableToday : (walkInError?.message || t.consultToday.bookingFailed)
                    });
                    setIsSubmitting(false);
                    return;
                }

            } else { // Online appointment
                let patientForAppointmentId: string;
                const batch = writeBatch(firestore);
                let isNewPatient = false; // Track if we're creating a new patient

                if (!primaryPatient) { // This is a brand new user creating a primary profile.
                    isNewPatient = true;
                    const newPatientRef = doc(collection(firestore, 'patients'));
                    const newPatientData = {
                        id: newPatientRef.id,
                        name, age, sex, place,
                        phone: user.phoneNumber,
                        communicationPhone: user.phoneNumber,
                        clinicIds: [selectedDoctor.clinicId],
                        isPrimary: true,
                        isKloqoMember: false,
                        relatedPatientIds: [],
                        totalAppointments: 0,
                        visitHistory: [],
                        createdAt: serverTimestamp(),
                        updatedAt: serverTimestamp(),
                    };
                    batch.set(newPatientRef, newPatientData);

                    const newUserRef = doc(collection(firestore, 'users'));
                    const newUserData = {
                        phone: user.phoneNumber,
                        role: 'patient',
                        patientId: newPatientRef.id
                    };
                    batch.set(newUserRef, newUserData);

                    patientForAppointmentId = newPatientRef.id;

                } else { // Primary patient exists
                    if (addNewPatient) { // Adding a new relative
                        isNewPatient = true;
                        const newRelatedPatientRef = doc(collection(firestore, 'patients'));
                        let newRelatedPatientData: any = {
                            id: newRelatedPatientRef.id,
                            name, age, sex, place,
                            clinicIds: [selectedDoctor.clinicId],
                            isPrimary: false,
                            totalAppointments: 0,
                            visitHistory: [],
                            createdAt: serverTimestamp(),
                            updatedAt: serverTimestamp(),
                        };

                        // Check if the phone number matches primary patient's phone
                        const primaryPhone = primaryPatient?.phone || primaryPatient?.communicationPhone;
                        const isDuplicatePhone = phone && phone.trim().length > 0 && primaryPhone && phone === primaryPhone.replace('+91', '');

                        if (phone && phone.trim().length > 0 && !isDuplicatePhone) {
                            const fullPhoneNumber = phone.startsWith('+91') ? phone : `+91${phone}`;
                            // Check if phone is unique across all patients and users
                            const patientsRef = collection(firestore, 'patients');
                            const patientQuery = query(patientsRef, where('phone', '==', fullPhoneNumber));
                            const patientSnapshot = await getDocs(patientQuery);

                            const usersRef = collection(firestore, 'users');
                            const userQuery = query(usersRef, where('phone', '==', fullPhoneNumber));
                            const userSnapshot = await getDocs(userQuery);

                            if (!patientSnapshot.empty || !userSnapshot.empty) {
                                toast({
                                    variant: 'destructive',
                                    title: 'Phone Number Already Exists',
                                    description: 'This phone number is already registered to another patient.'
                                });
                                setIsSubmitting(false);
                                return;
                            }

                            const newUserRef = doc(collection(firestore, 'users'));
                            batch.set(newUserRef, { phone: fullPhoneNumber, role: 'patient', patientId: newRelatedPatientRef.id });

                            // If relative has unique phone, they become PRIMARY patient themselves
                            newRelatedPatientData.phone = fullPhoneNumber;
                            newRelatedPatientData.communicationPhone = fullPhoneNumber;
                            newRelatedPatientData.isPrimary = true;
                            newRelatedPatientData.primaryUserId = newUserRef.id;
                            newRelatedPatientData.relatedPatientIds = [];
                        } else {
                            // If duplicate or no phone provided, use primary patient's communication phone
                            newRelatedPatientData.phone = '';
                            newRelatedPatientData.communicationPhone = user.phoneNumber;
                            newRelatedPatientData.isPrimary = false;
                        }

                        batch.set(newRelatedPatientRef, newRelatedPatientData);

                        console.log('[DEBUG] About to update primary patient', {
                            primaryPatientId: primaryPatient.id,
                            firestoreInstance: firestore,
                            firestoreConstructor: firestore?.constructor?.name
                        });

                        const primaryPatientRef = doc(firestore, 'patients', primaryPatient.id);

                        console.log('[DEBUG] Created primaryPatientRef', {
                            refPath: primaryPatientRef.path,
                            refFirestore: primaryPatientRef.firestore,
                            refFirestoreConstructor: primaryPatientRef.firestore?.constructor?.name,
                            batchFirestore: (batch as any)._firestore,
                            batchFirestoreConstructor: (batch as any)._firestore?.constructor?.name
                        });

                        // Always add to primary's relatedPatientIds, regardless of whether relative has a phone
                        // Even if relative has a unique phone and becomes isPrimary: true, they are still a relative of the primary patient
                        batch.update(primaryPatientRef, {
                            relatedPatientIds: arrayUnion(newRelatedPatientRef.id),
                            updatedAt: serverTimestamp()
                        });

                        console.log('[DEBUG] batch.update called successfully');

                        patientForAppointmentId = newRelatedPatientRef.id;
                    }
                    else if (selectedPatientId) { // Updating an existing patient
                        // For existing patients, navigate immediately (patient already exists)
                        const patientToUpdate = displayedPatients.find(p => p.id === selectedPatientId);
                        if (!patientToUpdate) throw new Error("Patient not found");

                        const updatedData: any = { name, age, sex, place, updatedAt: serverTimestamp() };
                        if (!patientToUpdate.isPrimary) {
                            // Check if the phone number matches primary patient's phone
                            const primaryPhone = primaryPatient?.phone || primaryPatient?.communicationPhone;
                            const isDuplicatePhone = phone && phone.trim().length > 0 && primaryPhone && phone === primaryPhone.replace('+91', '');

                            if (phone && phone.trim().length > 0 && !isDuplicatePhone) {
                                const fullPhoneNumber = phone.startsWith('+91') ? phone : `+91${phone}`;
                                updatedData.phone = fullPhoneNumber;
                                updatedData.communicationPhone = fullPhoneNumber;
                            } else {
                                // If duplicate or no phone provided, use primary patient's communication phone
                                updatedData.phone = '';
                                updatedData.communicationPhone = user.phoneNumber;
                            }
                        }

                        const patientRef = doc(firestore, 'patients', selectedPatientId);
                        batch.update(patientRef, updatedData);
                        patientForAppointmentId = selectedPatientId;

                        if (!selectedSlot) {
                            toast({ variant: 'destructive', title: 'Error', description: 'No time slot selected.' });
                            setIsSubmitting(false);
                            return;
                        }

                        // For existing patients: Navigate immediately (optimistic navigation)
                        const params = new URLSearchParams();
                        params.set('doctorId', selectedDoctor.id);
                        params.set('slot', selectedSlot.toISOString());
                        params.set('patientId', patientForAppointmentId);
                        router.push(`/book-appointment/summary?${params.toString()}`);

                        // Commit update in background (patient already exists, so safe)
                        batch.commit().catch((error) => {
                            console.error("Error committing patient update:", error);
                        });
                        return; // Exit early - navigation already happened
                    } else {
                        throw new Error("No patient selected")
                    }
                }

                if (!selectedSlot) {
                    toast({ variant: 'destructive', title: 'Error', description: 'No time slot selected.' });
                    setIsSubmitting(false);
                    return;
                }

                // For new patients: Commit first to ensure patient exists, then navigate
                // This is necessary because the summary page needs the patient document to exist
                await batch.commit();

                const params = new URLSearchParams();
                params.set('doctorId', selectedDoctor.id);
                params.set('slot', selectedSlot.toISOString());
                params.set('patientId', patientForAppointmentId);
                router.push(`/book-appointment/summary?${params.toString()}`);
            }
        } catch (error) {
            console.error("Error submitting form:", error);
            if (!(error instanceof FirestorePermissionError)) {
                toast({ variant: "destructive", title: t.common.error, description: (error as Error).message || t.bookAppointment.bookingFailed });
            }
        } finally {
            setIsSubmitting(false);
        }
    }


    const handlePatientSelect = (patientId: string) => {
        setAddNewPatient(false);
        form.setValue('selectedPatient', patientId);
    }

    const handleAddNewClick = () => {
        // First clear the age field directly
        // Then reset all fields
        form.reset({
            selectedPatient: 'new',
            name: '',
            age: undefined,
            sex: undefined,
            place: '',
            phone: primaryPatient ? '' : user?.phoneNumber || '', // If adding relative, clear phone. If new primary, use their phone.
        }, {
            keepDefaultValues: false, // Don't keep any default values
            keepValues: false, // Don't keep existing values
        });
        // Ensure addNewPatient is set after reset
        setAddNewPatient(true);
    }

    const isEditingPrimary = selectedPatientId === primaryPatient?.id && !addNewPatient;

    return (
        <>
            <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
                    <div>
                        <h2 className="text-lg font-semibold mb-4">{t.patientForm.whoIsThisAppointmentFor}</h2>
                        {isLoading && displayedPatients.length === 0 ? (
                            // Show patient selector skeleton only if we don't have any cached data
                            <div className="flex items-center gap-4 overflow-x-auto pb-2">
                                <Skeleton className="w-16 h-20 flex-shrink-0" />
                                <Skeleton className="w-16 h-20 flex-shrink-0" />
                                <Skeleton className="w-16 h-20 flex-shrink-0" />
                            </div>
                        ) : (
                            <div className="flex items-center gap-4 overflow-x-auto pb-2">
                                {displayedPatients.map(p => {
                                    // Show "myself" only if patient's phone matches logged-in user's phone
                                    const isLoggedInUser = p.phone === user?.phoneNumber;
                                    return (
                                        <div key={p.id} className="flex flex-col items-center gap-2 text-center flex-shrink-0 cursor-pointer" onClick={() => handlePatientSelect(p.id)}>
                                            <Avatar className={cn("w-16 h-16 border-2 rounded-lg", selectedPatientId === p.id && !addNewPatient ? "border-primary" : "border-transparent")}>
                                                <AvatarFallback className="text-lg rounded-lg">{p.name ? p.name.split(' ').map(n => n[0]).join('') : 'Me'}</AvatarFallback>
                                            </Avatar>
                                            <span className="text-sm font-medium">{isLoggedInUser ? t.patientForm.myself : (p.name ? p.name.split(' ')[0] : 'New')}</span>
                                        </div>
                                    );
                                })}
                                <div className="flex flex-col items-center gap-2 text-center flex-shrink-0">
                                    <button type="button" onClick={handleAddNewClick} className={cn("w-16 h-16 rounded-lg border-2 border-dashed flex items-center justify-center cursor-pointer", addNewPatient ? "border-primary bg-primary/10" : "border-border")}>
                                        <Plus className="w-6 h-6 text-muted-foreground" />
                                    </button>
                                    <span className="text-sm font-medium">{t.patientForm.addNew}</span>
                                </div>
                            </div>
                        )}
                    </div>

                    {showDetailsForm && (
                        <div key={selectedPatientId || (addNewPatient ? 'new' : 'none')} className="space-y-6 animate-in fade-in-50">
                            <h2 className="text-lg font-semibold">{addNewPatient && !primaryPatient ? t.patientForm.yourDetails : (addNewPatient ? t.patientForm.newPatientDetails : t.bookAppointment.patientDetails)}</h2>
                            <FormField control={form.control} name="name" render={({ field }) => (
                                <FormItem>
                                    <FormLabel>{t.patientForm.name}</FormLabel>
                                    <FormControl>
                                        <Input
                                            placeholder={t.patientForm.enterPatientName}
                                            {...field}
                                            value={field.value || ''}
                                            onBlur={field.onBlur}
                                            onChange={(e) => {
                                                field.onChange(e);
                                                form.trigger('name');
                                            }}
                                        />
                                    </FormControl>
                                    <FormMessage />
                                </FormItem>
                            )} />
                            <div className="grid grid-cols-2 gap-4">
                                <FormField control={form.control} name="age" render={({ field }) => (
                                    <FormItem>
                                        <FormLabel>{t.patientForm.age}</FormLabel>
                                        <FormControl>
                                            <Input
                                                type="text"
                                                inputMode="numeric"
                                                pattern="[0-9]*"
                                                placeholder={t.patientForm.enterAge}
                                                {...field}
                                                value={field.value?.toString() ?? ''}
                                                onBlur={field.onBlur}
                                                onChange={(e) => {
                                                    const val = e.target.value;
                                                    // Only allow digits and handle empty string
                                                    if (val === '' || /^\d+$/.test(val)) {
                                                        field.onChange(val);
                                                        form.trigger('age');
                                                    }
                                                }}
                                                className="[&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none [-moz-appearance:textfield]"
                                            />
                                        </FormControl>
                                        <FormMessage />
                                    </FormItem>
                                )} />
                                <FormField
                                    control={form.control}
                                    name="sex"
                                    render={({ field }) => (
                                        <FormItem>
                                            <FormLabel>{t.patientForm.gender}</FormLabel>
                                            <Select onValueChange={field.onChange} value={field.value}>
                                                <FormControl>
                                                    <SelectTrigger>
                                                        <SelectValue placeholder={t.common.select} />
                                                    </SelectTrigger>
                                                </FormControl>
                                                <SelectContent>
                                                    <SelectItem value="Male">{t.patientForm.male}</SelectItem>
                                                    <SelectItem value="Female">{t.patientForm.female}</SelectItem>
                                                    <SelectItem value="Other">{t.patientForm.other}</SelectItem>
                                                </SelectContent>
                                            </Select>
                                            <FormMessage />
                                        </FormItem>
                                    )}
                                />
                            </div>
                            <FormField control={form.control} name="place" render={({ field }) => (
                                <FormItem>
                                    <FormLabel>{t.patientForm.place}</FormLabel>
                                    <FormControl>
                                        <Input
                                            placeholder={t.patientForm.enterPlace}
                                            {...field}
                                            value={field.value || ''}
                                            onBlur={field.onBlur}
                                            onChange={(e) => {
                                                field.onChange(e);
                                                form.trigger('place');
                                            }}
                                        />
                                    </FormControl>
                                    <FormMessage />
                                </FormItem>
                            )} />
                            <FormField control={form.control} name="phone" render={({ field }) => (
                                <FormItem>
                                    <FormLabel>{t.common.phone} ({t.patientForm.phoneOptional})</FormLabel>
                                    <FormControl>
                                        <div className="flex items-center gap-2">
                                            <span className="text-sm font-medium text-foreground">+91</span>
                                            <Input
                                                type="tel"
                                                {...field}
                                                disabled={isEditingPrimary || (addNewPatient && !primaryPatient)}
                                                value={field.value || ''}
                                                placeholder={t.patientForm.phonePlaceholder}
                                            />
                                        </div>
                                    </FormControl>
                                    <FormMessage />
                                </FormItem>
                            )} />
                        </div>
                    )}

                    <div className="pt-4 sticky bottom-4 bg-background">
                        <Button
                            type="submit"
                            className="w-full h-12 text-base font-semibold bg-primary text-primary-foreground hover:bg-primary/90"
                            disabled={isSubmitting || !showDetailsForm || !form.formState.isValid}
                        >
                            {isSubmitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> :
                                appointmentType === 'Online' ? t.patientForm.proceedToSummary : t.patientForm.getToken
                            }
                        </Button>
                    </div>
                </form>
            </Form>

            <Dialog open={isEstimateModalOpen} onOpenChange={setIsEstimateModalOpen}>
                <DialogContent className="sm:max-w-md w-[90%]" hideCloseButton>
                    <DialogHeader>
                        <DialogTitle className="text-center">{t.patientForm.estimatedWaitTime}</DialogTitle>
                        <DialogDescription className="text-center">
                            {t.patientForm.walkInEstimate}
                            {hasRecalculated && (
                                <p className="text-green-600 text-xs mt-2 font-medium">
                                    ✓ Updated estimate (as of {format(new Date(), 'hh:mm a')})
                                </p>
                            )}
                        </DialogDescription>
                    </DialogHeader>
                    {(() => {
                        try {
                            if (!estimatedConsultationTime) {
                                return (
                                    <div className="text-center py-4 text-sm text-muted-foreground">
                                        Calculating estimate...
                                    </div>
                                );
                            }

                            const appointmentDate = parse(format(new Date(), 'd MMMM yyyy'), 'd MMMM yyyy', new Date());
                            const sessionIndex = walkInData?.estimatedDetails?.sessionIndex ?? null;
                            const sessionBreaks = sessionIndex !== null
                                ? getSessionBreakIntervals(selectedDoctor, appointmentDate, sessionIndex)
                                : [];
                            const breakIntervals = buildBreakIntervals(selectedDoctor, appointmentDate);
                            const chosenBreaks = sessionBreaks.length > 0 ? sessionBreaks : breakIntervals;

                            // estimatedConsultationTime is already adjusted when set; avoid double-applying.
                            const adjustedTime = estimatedConsultationTime;

                            console.log('[PF:ESTIMATE-RENDER]', {
                                sessionIndex,
                                estimatedConsultationTime: adjustedTime?.toISOString?.(),
                                sessionBreaks: sessionBreaks.map(b => ({
                                    start: b.start.toISOString(),
                                    end: b.end.toISOString(),
                                    sessionIndex: b.sessionIndex,
                                })),
                                fallbackBreaks: breakIntervals.map(b => ({
                                    start: b.start.toISOString(),
                                    end: b.end.toISOString(),
                                })),
                                chosenBreaks: chosenBreaks.map(b => ({
                                    start: b.start.toISOString(),
                                    end: b.end.toISOString(),
                                    sessionIndex: (b as any).sessionIndex,
                                })),
                            });

                            // Resolve effective availability end
                            let availabilityEnd: Date | null = sessionIndex !== null ? getSessionEnd(selectedDoctor, appointmentDate, sessionIndex) : null;
                            let availabilityEndLabel = availabilityEnd ? format(availabilityEnd, 'hh:mm a') : '';

                            if (!availabilityEnd && selectedDoctor.availabilitySlots?.length) {
                                const dayStr = format(appointmentDate, 'EEEE');
                                const availabilityForDay = selectedDoctor.availabilitySlots.find(s => s.day === dayStr);
                                if (availabilityForDay && availabilityForDay.timeSlots.length > 0) {
                                    const lastSessionIndex = availabilityForDay.timeSlots.length - 1;
                                    const lastSession = availabilityForDay.timeSlots[lastSessionIndex];
                                    const originalEnd = parseTimeUtil(lastSession.to, appointmentDate);
                                    availabilityEnd = originalEnd;
                                    availabilityEndLabel = format(originalEnd, 'hh:mm a');

                                    const dateKey = format(appointmentDate, 'd MMMM yyyy');
                                    const ext = (selectedDoctor as any).availabilityExtensions?.[dateKey];
                                    const sessionExt = ext?.sessions?.find((s: any) => s.sessionIndex === lastSessionIndex);
                                    if (sessionExt?.newEndTime) {
                                        try {
                                            const extendedEnd = parseTimeUtil(sessionExt.newEndTime, appointmentDate);
                                            if (isAfter(extendedEnd, availabilityEnd)) {
                                                availabilityEnd = extendedEnd;
                                                availabilityEndLabel = format(extendedEnd, 'hh:mm a');
                                            }
                                        } catch {
                                            // ignore malformed extension
                                        }
                                    }
                                }
                            }

                            const consultationTime = selectedDoctor?.averageConsultingTime || 15;
                            const apptEnd = adjustedTime ? addMinutes(adjustedTime, consultationTime) : null;
                            const isOutside = apptEnd && availabilityEnd ? isAfter(apptEnd, availabilityEnd) : false;

                            if (isOutside) {
                                return (
                                    <div className="text-center py-4">
                                        <CardTitle className="text-base text-red-700">Walk-in Not Available</CardTitle>
                                        <CardDescription className="text-xs text-red-800">
                                            Next estimated time ~{adjustedTime ? format(adjustedTime, 'hh:mm a') : 'N/A'} is outside availability (ends at {availabilityEndLabel || 'N/A'}).
                                        </CardDescription>
                                    </div>
                                );
                            }

                            return (
                                <div className="grid grid-cols-2 gap-8 text-center py-4">
                                    <div className="flex flex-col items-center">
                                        <Clock className="w-8 h-8 text-primary mb-2" />
                                        <span className="text-xl font-bold">{adjustedTime ? `~ ${format(adjustedTime, 'hh:mm a')}` : 'N/A'}</span>
                                        <span className="text-xs text-muted-foreground">{t.patientForm.estimatedDelay}</span>
                                    </div>
                                    <div className="flex flex-col items-center">
                                        <Users className="w-8 h-8 text-primary mb-2" />
                                        <span className="text-2xl font-bold">{patientsAhead}</span>
                                        <span className="text-xs text-muted-foreground">{t.patientForm.patientsAhead}</span>
                                    </div>
                                </div>
                            );
                        } catch {
                            return (
                                <div className="grid grid-cols-2 gap-8 text-center py-4">
                                    <div className="flex flex-col items-center">
                                        <Clock className="w-8 h-8 text-primary mb-2" />
                                        <span className="text-xl font-bold">{estimatedConsultationTime ? `~ ${format(estimatedConsultationTime, 'hh:mm a')}` : 'N/A'}</span>
                                        <span className="text-xs text-muted-foreground">{t.patientForm.estimatedDelay}</span>
                                    </div>
                                    <div className="flex flex-col items-center">
                                        <Users className="w-8 h-8 text-primary mb-2" />
                                        <span className="text-2xl font-bold">{patientsAhead}</span>
                                        <span className="text-xs text-muted-foreground">{t.patientForm.patientsAhead}</span>
                                    </div>
                                </div>
                            );
                        }
                    })()}
                    <DialogFooter className="flex-col space-y-2">
                        <Button onClick={handleConfirmWalkIn} className="w-full bg-accent text-accent-foreground hover:bg-accent/90" disabled={isSubmitting}>
                            {isSubmitting ? (
                                <>
                                    <Loader2 className="animate-spin mr-2 h-4 w-4" />
                                    {t.patientForm.bookingInProgress}
                                </>
                            ) : t.patientForm.confirmWalkIn}
                        </Button>
                        <Button variant="outline" className="w-full flex items-center justify-center" asChild>
                            <Link href={`/book-appointment?doctorId=${selectedDoctor.id}`} className="flex items-center justify-center">
                                <Calendar className="mr-2 h-4 w-4" />
                                {t.patientForm.bookForAnotherDay}
                            </Link>
                        </Button>
                        <DialogClose asChild>
                            <Button variant="ghost" className="w-full">{t.common.cancel}</Button>
                        </DialogClose>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={isTokenModalOpen} onOpenChange={setIsTokenModalOpen}>
                <DialogContent className="sm:max-w-xs w-[90%] text-center p-6 sm:p-8" hideCloseButton>
                    <DialogHeader>
                        <DialogTitle className="text-center text-xl font-bold">{t.patientForm.tokenGenerated}</DialogTitle>
                        <DialogDescription className="text-center text-sm text-muted-foreground">{t.patientForm.pleaseArriveOnTime}</DialogDescription>
                    </DialogHeader>
                    <DialogClose asChild>
                        <Button variant="ghost" size="icon" className="absolute top-4 right-4 h-6 w-6 text-muted-foreground" onClick={() => router.push('/home')}>
                            <X className="h-4 w-4" />
                            <span className="sr-only">Close</span>
                        </Button>
                    </DialogClose>
                    <div className="flex flex-col items-center space-y-4 pt-4">
                        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-green-100">
                            <CheckCircle2 className="h-8 w-8 text-green-600" />
                        </div>
                        <div>
                            <p className="text-sm text-muted-foreground">{t.patientForm.yourTokenNumber}</p>
                            <p className="text-5xl font-bold text-primary">{generatedToken}</p>
                        </div>
                        <Button asChild className="mt-4">
                            <Link href="/live-token"><Radio className="mr-2 h-4 w-4" />{t.liveToken.title}</Link>
                        </Button>
                    </div>
                </DialogContent>
            </Dialog>
        </>
    );
}
