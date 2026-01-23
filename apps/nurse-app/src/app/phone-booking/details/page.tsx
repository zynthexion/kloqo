

'use client';

import { useState, useEffect, useCallback, Suspense } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, ArrowLeft, UserPlus, Search, Link as LinkIcon, Clock, Phone } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { collection, getDocs, doc, getDoc, query, where, updateDoc, serverTimestamp, arrayUnion } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import type { Doctor, Patient, User } from '@/lib/types';
import AppFrameLayout from '@/components/layout/app-frame';
import { errorEmitter } from '@kloqo/shared-core';
import { FirestorePermissionError } from '@kloqo/shared-core';
import { managePatient } from '@kloqo/shared-core';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import PatientSearchResults from '@/components/clinic/patient-search-results';
import { AddRelativeDialog } from '@/components/patients/add-relative-dialog';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { format, addDays, isBefore, isAfter, startOfDay, addMinutes, subMinutes, isSameDay } from 'date-fns';
import { parseTime, parseAppointmentDateTime } from '@/lib/utils';
import { isSlotBlockedByLeave } from '@kloqo/shared-core';


const formSchema = z.object({
    patientName: z.string()
        .min(3, { message: "Name must be at least 3 characters." })
        .regex(/^[a-zA-Z\s]+$/, { message: "Name must contain only alphabets and spaces." })
        .refine(name => !name.startsWith(' ') && !name.endsWith(' ') && !name.includes('  '), {
            message: "Spaces are only allowed between letters, not at the start, end, or multiple consecutive spaces."
        }),
    age: z.preprocess(
        (val) => (val === "" || val === undefined || val === null ? undefined : Number(val)),
        z.number({ required_error: "Age is required.", invalid_type_error: "Age is required." })
            .min(1, { message: "Age must be a positive number above zero." })
            .max(120, { message: "Age must be less than 120." })
    ),
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
            message: "Phone number must be exactly 10 digits."
        }),
    place: z.string().min(2, { message: "Location is required." }),
    sex: z.enum(["Male", "Female", "Other"], { required_error: "Please select a gender." }),
});

function PhoneBookingDetailsContent() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const { toast } = useToast();
    const doctorId = searchParams.get('doctor');

    const [isSubmitting, setIsSubmitting] = useState(false);
    const [doctor, setDoctor] = useState<Doctor | null>(null);
    const [clinicId, setClinicId] = useState<string | null>(null);
    const [clinicDetails, setClinicDetails] = useState<any | null>(null);

    const [phoneNumber, setPhoneNumber] = useState('');
    const [isSearchingPatient, setIsSearchingPatient] = useState(false);
    const [isSendingLink, setIsSendingLink] = useState(false);
    const [searchedPatients, setSearchedPatients] = useState<Patient[]>([]);
    const [showForm, setShowForm] = useState(false);
    const [selectedPatient, setSelectedPatient] = useState<Patient | null>(null);
    const [primaryPatient, setPrimaryPatient] = useState<Patient | null>(null);
    const [relatives, setRelatives] = useState<Patient[]>([]);
    const [isAddRelativeDialogOpen, setIsAddRelativeDialogOpen] = useState(false);
    const [nextSlotHint, setNextSlotHint] = useState<{ date: string, time: string, reportingTime: string } | null>(null);
    const [linkPendingPatients, setLinkPendingPatients] = useState<Patient[]>([]);


    const form = useForm<z.infer<typeof formSchema>>({
        resolver: zodResolver(formSchema),
        mode: 'onBlur',
        reValidateMode: 'onChange',
        defaultValues: {
            patientName: '',
            age: undefined,
            phone: '',
            place: '',
            sex: undefined,
        },
    });

    useEffect(() => {
        const id = localStorage.getItem('clinicId');
        if (!id) {
            router.push('/login');
            return;
        }
        setClinicId(id);

        const fetchClinic = async () => {
            try {
                const clinicRef = doc(db, 'clinics', id);
                const clinicSnap = await getDoc(clinicRef);
                if (clinicSnap.exists()) {
                    setClinicDetails(clinicSnap.id ? { id: clinicSnap.id, ...clinicSnap.data() } : clinicSnap.data());
                }
            } catch (error) {
                console.error("Error fetching clinic:", error);
            }
        };
        fetchClinic();

        // Fetch link-pending patients for this clinic
        const fetchLinkPendingPatients = async () => {
            try {
                const patientsRef = collection(db, 'patients');
                const q = query(
                    patientsRef,
                    where('clinicIds', 'array-contains', id),
                    where('isLinkPending', '==', true)
                );
                const snapshot = await getDocs(q);
                const pending = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Patient));
                setLinkPendingPatients(pending);
            } catch (error) {
                console.error("Error fetching link-pending patients:", error);
            }
        };
        fetchLinkPendingPatients();
    }, [router]);



    useEffect(() => {
        const fetchDoctor = async () => {
            if (!clinicId || !doctorId) return;
            try {
                const docRef = doc(db, "doctors", doctorId);
                const docSnap = await getDoc(docRef);
                if (docSnap.exists() && docSnap.data().clinicId === clinicId) {
                    const fetchedDoctor = { id: docSnap.id, ...docSnap.data() } as Doctor;
                    setDoctor(fetchedDoctor);
                }
            } catch (error) {
                console.error("Error fetching doctor:", error);
            }
        };
        fetchDoctor();
    }, [doctorId, clinicId]);

    useEffect(() => {
        const findNextAvailableSlot = async () => {
            if (!doctor || !clinicId) return;

            setNextSlotHint(null);
            const now = new Date();
            const daysCheckLimit = (doctor as any).advanceBookingDays || 15;

            for (let i = 0; i < daysCheckLimit; i++) {
                const checkDate = addDays(now, i);
                const dayOfWeek = format(checkDate, 'EEEE');
                const availabilityForDay = (doctor.availabilitySlots || []).find(slot => slot.day === dayOfWeek);

                if (!availabilityForDay || !availabilityForDay.timeSlots.length) continue;

                // 1. Fetch appointments for this day to check booking status
                const dateStr = format(checkDate, 'd MMMM yyyy');
                const q = query(
                    collection(db, 'appointments'),
                    where('doctor', '==', doctor.name),
                    where('clinicId', '==', clinicId),
                    where('date', '==', dateStr)
                );

                const snapshot = await getDocs(q);
                const appointments = snapshot.docs.map(doc => doc.data() as any);

                // Booked times: Pending, Confirmed, Completed (excluding walk-ins)
                const bookedTimes = new Set(
                    appointments
                        .filter((apt: any) =>
                            !apt.tokenNumber?.startsWith('W') &&
                            (apt.status === 'Pending' || apt.status === 'Confirmed' || apt.status === 'Completed')
                        )
                        .map((apt: any) => {
                            try {
                                return parseAppointmentDateTime(apt.date, apt.time).getTime();
                            } catch (e) { return 0; }
                        })
                );

                // Break blocked times: cancelledByBreakPlaceholder appointments
                const breakBlockedTimes = new Set(
                    appointments
                        .filter(a => a.cancelledByBreak && a.status === 'Completed')
                        .map(a => {
                            try {
                                return parseAppointmentDateTime(a.date, a.time).getTime();
                            } catch (e) { return 0; }
                        })
                );

                const slotDuration = doctor.averageConsultingTime || 15;
                const extensions = doctor.availabilityExtensions?.[dateStr];
                const bookingBuffer = addMinutes(now, 30);
                const isCheckToday = isSameDay(checkDate, now);

                let foundSlot: Date | null = null;
                let globalSlotIndex = 0;

                // Sort sessions basically as defined in doctor profile
                for (let sessionIndex = 0; sessionIndex < availabilityForDay.timeSlots.length; sessionIndex++) {
                    const session = availabilityForDay.timeSlots[sessionIndex];
                    let currentTime = parseTime(session.from, checkDate);
                    let endTime = parseTime(session.to, checkDate);

                    // A. Determine actual session end (check for extensions)
                    if (extensions) {
                        const sessionExtension = extensions.sessions?.find((s: any) => Number(s.sessionIndex) === sessionIndex);
                        if (sessionExtension && sessionExtension.newEndTime && sessionExtension.totalExtendedBy > 0) {
                            try {
                                const extendedEndTime = parseTime(sessionExtension.newEndTime, checkDate);
                                if (isAfter(extendedEndTime, endTime)) {
                                    endTime = extendedEndTime;
                                }
                            } catch (e) { }
                        }
                    }

                    // B. Identify FUTURE slots in this session for capacity calculation (same-day logic)
                    const sessionSlots: { time: Date; globalIdx: number }[] = [];
                    const futureValidCapacitySlots: number[] = [];

                    let tempTime = new Date(currentTime);

                    while (isBefore(tempTime, endTime)) {
                        const slotTime = new Date(tempTime);
                        sessionSlots.push({ time: slotTime, globalIdx: globalSlotIndex });

                        const isBlocked = isSlotBlockedByLeave(doctor, slotTime);
                        const isBlockedByBreak = breakBlockedTimes.has(slotTime.getTime());

                        // Slots that contribute to quota: in the future and not blocked
                        if (!isBlocked && !isBlockedByBreak && (isAfter(slotTime, now) || slotTime.getTime() >= now.getTime())) {
                            futureValidCapacitySlots.push(globalSlotIndex);
                        }

                        globalSlotIndex++;
                        tempTime = addMinutes(tempTime, slotDuration);
                    }

                    // C. Calculate Reserved (Walk-in) slots for this session (last 15% of future capacity)
                    const reservedGlobalIndices = new Set<number>();
                    if (futureValidCapacitySlots.length > 0) {
                        const futureCount = futureValidCapacitySlots.length;
                        const reserveCount = Math.ceil(futureCount * 0.15);
                        const reservedStartIdx = futureCount - reserveCount;
                        for (let j = reservedStartIdx; j < futureCount; j++) {
                            reservedGlobalIndices.add(futureValidCapacitySlots[j]);
                        }
                    }

                    // D. Find the first available slot in this session
                    for (const { time: slotTime, globalIdx } of sessionSlots) {
                        // 1. Must be in future (and >1 hour if today)
                        const timingValid = isCheckToday ? isAfter(slotTime, bookingBuffer) : isAfter(slotTime, now);
                        if (!timingValid) continue;

                        // 2. Not blocked by leave or break placeholder
                        if (isSlotBlockedByLeave(doctor, slotTime) || breakBlockedTimes.has(slotTime.getTime())) continue;

                        // 3. Not already booked
                        if (bookedTimes.has(slotTime.getTime())) continue;

                        // 4. Not reserved for walk-ins (85/15 rule)
                        if (reservedGlobalIndices.has(globalIdx)) continue;

                        // If all checks pass, this is the next available slot
                        foundSlot = slotTime;
                        break;
                    }

                    if (foundSlot) break;
                }

                if (foundSlot) {
                    const reportingTime = subMinutes(foundSlot, 15);
                    setNextSlotHint({
                        date: isSameDay(foundSlot, now) ? 'Today' : format(foundSlot, 'd MMM'),
                        time: format(foundSlot, 'hh:mm a'),
                        reportingTime: format(reportingTime, 'hh:mm a')
                    });
                    return;
                }
            }
        };

        findNextAvailableSlot();
    }, [doctor, clinicId]);

    const handlePatientSearch = useCallback(async (phone: string) => {
        if (phone.length < 10 || !clinicId) {
            setSearchedPatients([]);
            setShowForm(false);
            return;
        };
        setIsSearchingPatient(true);
        setShowForm(false);
        setSelectedPatient(null);
        form.reset();

        try {
            const fullPhoneNumber = `+91${phone}`;
            const patientsRef = collection(db, 'patients');

            const q = query(
                patientsRef,
                where('clinicIds', 'array-contains', clinicId),
                where('phone', '==', fullPhoneNumber)
            );
            const querySnapshot = await getDocs(q);

            if (querySnapshot.empty) {
                setSearchedPatients([]);
                setShowForm(true);
                form.setValue('phone', phone);

                // Default gender based on clinic preference
                if (clinicDetails?.genderPreference === 'Men') {
                    form.setValue('sex', 'Male');
                } else if (clinicDetails?.genderPreference === 'Women') {
                    form.setValue('sex', 'Female');
                }
                return;
            }

            const primaryDoc = querySnapshot.docs[0];
            const primaryPatientData = { id: primaryDoc.id, ...primaryDoc.data() } as Patient;
            primaryPatientData.isKloqoMember = true;

            setSearchedPatients([primaryPatientData]);

        } catch (error) {
            console.error("Error searching patient:", error);
            toast({ variant: 'destructive', title: 'Search Error', description: 'Could not perform patient search.' });
        } finally {
            setIsSearchingPatient(false);
        }
    }, [clinicId, toast, form, clinicDetails]);

    useEffect(() => {
        const debounceTimer = setTimeout(() => {
            if (phoneNumber && phoneNumber.length === 10) {
                handlePatientSearch(phoneNumber);
            } else {
                setSearchedPatients([]);
                setShowForm(false);
                setSelectedPatient(null);
                setPrimaryPatient(null);
                setRelatives([]);
            }
        }, 500);

        return () => clearTimeout(debounceTimer);
    }, [phoneNumber, handlePatientSearch]);

    // Sync search phoneNumber with form phone field
    useEffect(() => {
        if (phoneNumber.length === 10) {
            form.setValue('phone', phoneNumber);
        }
    }, [phoneNumber, form]);


    const selectPrimaryPatient = async (patient: Patient) => {
        setPrimaryPatient(patient);
        setSelectedPatient(patient);
        const normalizeSex = (val: any): "Male" | "Female" | "Other" | undefined => {
            if (!val) {
                if (clinicDetails?.genderPreference === 'Men') return 'Male';
                if (clinicDetails?.genderPreference === 'Women') return 'Female';
                return undefined;
            }
            const s = val.toString().toLowerCase();
            if (s === 'male' || s === 'm') return 'Male';
            if (s === 'female' || s === 'f') return 'Female';
            if (s === 'other' || s === 'o') return 'Other';

            // Fallback to clinic preference if normalized value is still unclear
            if (clinicDetails?.genderPreference === 'Men') return 'Male';
            if (clinicDetails?.genderPreference === 'Women') return 'Female';
            return undefined;
        };
        form.reset({
            patientName: patient.name || '',
            age: patient.age === 0 ? undefined : (patient.age ?? undefined),
            place: patient.place || '',
            sex: normalizeSex(patient.sex || (patient as any).gender),
            phone: patient.phone.replace('+91', ''),
        });
        setShowForm(true);

        if (patient.relatedPatientIds && patient.relatedPatientIds.length > 0) {
            const relativesQuery = query(collection(db, 'patients'), where('__name__', 'in', patient.relatedPatientIds));
            const relativesSnapshot = await getDocs(relativesQuery);
            const fetchedRelatives = relativesSnapshot.docs.map(d => ({ id: d.id, ...d.data() } as Patient));
            setRelatives(fetchedRelatives);
        } else {
            setRelatives([]);
        }
    };

    async function onSubmit(values: z.infer<typeof formSchema>) {
        setIsSubmitting(true);

        if (!clinicId || !doctor) {
            setIsSubmitting(false);
            toast({ variant: 'destructive', title: 'Error', description: 'Missing clinic or doctor information.' });
            return;
        }

        try {
            let patientToBookId: string;
            let bookingUserIdForAppointment: string | undefined;

            if (selectedPatient) {
                patientToBookId = selectedPatient.id;
                bookingUserIdForAppointment = primaryPatient?.primaryUserId || selectedPatient.primaryUserId;

                // Update patient document with form values if patient was edited
                const patientRef = doc(db, 'patients', selectedPatient.id);
                await updateDoc(patientRef, {
                    name: values.patientName,
                    age: values.age,
                    place: values.place,
                    sex: values.sex,
                    clinicIds: arrayUnion(clinicId!),
                    updatedAt: serverTimestamp(),
                }).catch(async (serverError: any) => {
                    console.error('❌ [NURSE APP - PHONE BOOKING] Error updating patient document:', serverError);
                    // Don't throw - patient update failure shouldn't prevent booking
                    toast({
                        variant: 'destructive',
                        title: 'Warning',
                        description: 'Patient information could not be updated, but appointment can still proceed.'
                    });
                });
            } else {
                // This is a new patient
                // Clean phone: remove +91 if user entered it, remove any non-digits, then ensure exactly 10 digits
                let fullPhoneNumber = "";
                if (values.phone) {
                    const cleaned = values.phone.replace(/^\+91/, '').replace(/\D/g, ''); // Remove +91 prefix and non-digits
                    if (cleaned.length === 10) {
                        fullPhoneNumber = `+91${cleaned}`; // Add +91 prefix when saving
                    }
                }
                if (!fullPhoneNumber) {
                    toast({ variant: 'destructive', title: 'Error', description: 'Please enter a valid 10-digit phone number.' });
                    setIsSubmitting(false);
                    return;
                }

                patientToBookId = await managePatient({
                    phone: fullPhoneNumber,
                    name: values.patientName,
                    age: values.age,
                    place: values.place,
                    sex: values.sex,
                    clinicId,
                    bookingFor: 'self',
                    // For a new patient, the booking user context is their own phone number initially
                    bookingUserId: `+91${values.phone}`
                });
                // The patientId is also the booking user context for a new user
                bookingUserIdForAppointment = patientToBookId;
            }

            if (patientToBookId) {
                router.push(`/book-appointment?doctor=${doctor.id}&patientId=${patientToBookId}&bookingUserId=${bookingUserIdForAppointment}&source=phone`);
            } else {
                throw new Error("Could not determine a patient ID to proceed with booking.");
            }

        } catch (error: any) {
            if (error.name !== 'FirestorePermissionError') {
                console.error('Error in patient processing:', error);
                toast({ variant: 'destructive', title: 'Error', description: error.message || 'An unexpected error occurred.' });
            }
        } finally {
            setIsSubmitting(false);
        }
    }

    const handleSelectRelative = (relative: Patient) => {
        setSelectedPatient(relative);
        const normalizeSex = (val: any): "Male" | "Female" | "Other" | undefined => {
            if (!val) {
                if (clinicDetails?.genderPreference === 'Men') return 'Male';
                if (clinicDetails?.genderPreference === 'Women') return 'Female';
                return undefined;
            }
            const s = val.toString().toLowerCase();
            if (s === 'male' || s === 'm') return 'Male';
            if (s === 'female' || s === 'f') return 'Female';
            if (s === 'other' || s === 'o') return 'Other';

            if (clinicDetails?.genderPreference === 'Men') return 'Male';
            if (clinicDetails?.genderPreference === 'Women') return 'Female';
            return undefined;
        };
        form.reset({
            patientName: relative.name || '',
            age: relative.age === 0 ? undefined : (relative.age ?? undefined),
            place: relative.place || '',
            sex: normalizeSex(relative.sex || (relative as any).gender),
            phone: (relative.phone || primaryPatient?.phone || '').replace('+91', ''),
        });
        setShowForm(true);
    }

    const handleNewRelativeAdded = (newRelative: Patient) => {
        setRelatives(prev => [...prev, newRelative]);
        handleSelectRelative(newRelative);
    }

    const handleSendLink = async () => {
        const fullPhoneNumber = `+91${phoneNumber}`;
        if (!phoneNumber || !clinicId || phoneNumber.length !== 10) {
            toast({ variant: "destructive", title: "Invalid Phone Number", description: "Please enter a 10-digit phone number to send a link." });
            return;
        }

        setIsSendingLink(true);
        try {
            // Check if user already exists
            const usersRef = collection(db, 'users');
            const userQuery = query(usersRef, where('phone', '==', fullPhoneNumber), where('role', '==', 'patient'));
            const userSnapshot = await getDocs(userQuery);

            let isNewUser = userSnapshot.empty;

            if (isNewUser) {
                // User doesn't exist, create patient record
                await managePatient({
                    phone: fullPhoneNumber,
                    name: '', age: undefined, place: '', sex: undefined, // placeholder data
                    clinicId,
                    bookingFor: 'self', // This will create a placeholder user and patient
                });
            } else {
                // User exists, check if patient exists and add clinicId to clinicIds array
                const existingUser = userSnapshot.docs[0].data() as User;
                const patientId = existingUser.patientId;

                if (patientId) {
                    const patientRef = doc(db, 'patients', patientId);
                    const patientDoc = await getDoc(patientRef);

                    if (patientDoc.exists()) {
                        const patientData = patientDoc.data() as Patient;
                        const clinicIds = patientData.clinicIds || [];

                        // Only update if clinicId is not already in the array
                        if (!clinicIds.includes(clinicId)) {
                            await updateDoc(patientRef, {
                                clinicIds: arrayUnion(clinicId),
                                updatedAt: serverTimestamp(),
                            }).catch(async (serverError) => {
                                console.error("Error updating patient clinicIds:", serverError);
                                // Continue with sending link even if update fails
                            });
                        }
                    }
                }
            }

            // Fetch clinic details for the message
            const clinicDoc = await getDoc(doc(db, 'clinics', clinicId));
            const clinicDetails = clinicDoc.exists() ? clinicDoc.data() : null;

            // Send WhatsApp message with booking link
            const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'https://app.kloqo.com';
            const clinicName = clinicDetails?.name || 'the clinic';
            const bookingLink = `${baseUrl}/clinics/${clinicId}`;
            const message = `Your request for appointment is received in '${clinicName}'. Use this link to complete the booking: ${bookingLink}`;

            const response = await fetch('/api/send-sms', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    to: fullPhoneNumber,
                    channel: 'whatsapp',
                    contentSid: 'HX8a0b3ef6c58c59d6af56aa45103552b9',
                    contentVariables: {
                        "1": clinicName,
                        "2": bookingLink
                    }
                }),
            });

            const result = await response.json();

            if (result.success) {
                toast({
                    title: "Link Sent Successfully",
                    description: `A booking link has been sent to ${fullPhoneNumber}.${isNewUser ? ' New user and patient records created.' : ''}`
                });
            } else {
                toast({
                    variant: "destructive",
                    title: "Failed to Send Link",
                    description: result.error || "Could not send the booking link."
                });
            }

        } catch (error: any) {
            if (error.name !== 'FirestorePermissionError') {
                console.error("Error sending link:", error);
                toast({ variant: 'destructive', title: 'Error', description: 'Could not send link.' });
            }
        } finally {
            setIsSendingLink(false);
        }
    };

    if (!doctorId) {
        return (
            <AppFrameLayout>
                <div className="w-full h-full flex flex-col items-center justify-center text-center p-8">
                    <h2 className="text-xl font-semibold">Doctor Not Selected</h2>
                    <p className="text-muted-foreground mt-2">Please go back and select a doctor to continue.</p>
                    <Link href="/" passHref className="mt-6">
                        <Button>
                            <ArrowLeft className="mr-2" />
                            Go Back to Home
                        </Button>
                    </Link>
                </div>
            </AppFrameLayout>
        )
    }

    return (
        <AppFrameLayout>
            <div className="flex flex-col h-full">
                <header className="flex items-center gap-4 p-4 border-b">
                    <Link href="/">
                        <Button variant="ghost" size="icon">
                            <ArrowLeft />
                        </Button>
                    </Link>
                    <div className="flex-1">
                        <h1 className="text-xl font-bold">Phone Booking</h1>
                        <p className="text-sm text-muted-foreground">
                            Step 1: Find or Create Patient
                        </p>
                    </div>
                </header>
                <div className="p-6 overflow-y-auto flex-1">
                    <div className="space-y-4 mb-6">
                        <h3 className="font-semibold text-lg">Find or Add Patient</h3>
                        <div className="flex items-center gap-2">
                            <div className="relative flex-1 flex items-center">
                                <span className="inline-flex items-center px-3 rounded-l-md border border-r-0 border-gray-300 bg-gray-50 text-gray-500 text-sm h-10">
                                    +91
                                </span>
                                <Input
                                    type="tel"
                                    placeholder="Enter 10-digit phone number"
                                    value={phoneNumber}
                                    onChange={(e) => setPhoneNumber(e.target.value.replace(/\D/g, '').slice(0, 10))}
                                    className="flex-1 rounded-l-none bg-[#CADEED] pr-10"
                                    maxLength={10}
                                />
                                {isSearchingPatient ?
                                    <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin h-4 w-4 text-muted-foreground" />
                                    : <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                                }
                            </div>
                            <Button onClick={handleSendLink} variant="outline" disabled={isSendingLink}>
                                {isSendingLink ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <LinkIcon className="mr-2 h-4 w-4" />}
                                Send Link
                            </Button>
                        </div>
                        {!phoneNumber && nextSlotHint && (
                            <div className="bg-emerald-50 border border-emerald-100 rounded-lg p-3 flex items-center gap-3 animate-in fade-in slide-in-from-top-1 mt-2">
                                <div className="bg-emerald-100 p-2 rounded-full shrink-0">
                                    <Clock className="h-4 w-4 text-emerald-600" />
                                </div>
                                <div>
                                    <p className="text-[10px] text-emerald-600 font-semibold uppercase tracking-wider">Next Available Slot</p>
                                    <p className="text-sm font-semibold text-emerald-900 leading-tight">
                                        {nextSlotHint.date} <span className="text-emerald-400 font-light mx-1">|</span> <span className="font-normal text-emerald-800">Report by {nextSlotHint.reportingTime}</span>
                                    </p>
                                </div>
                            </div>
                        )}

                        {searchedPatients.length > 0 && (
                            <PatientSearchResults
                                patients={searchedPatients}
                                onSelectPatient={selectPrimaryPatient}
                                selectedPatientId={selectedPatient?.id || null}
                            />
                        )}
                        {phoneNumber.length === 10 && searchedPatients.length === 0 && !showForm && !isSearchingPatient && (
                            <p className="text-sm text-center text-muted-foreground py-2">
                                No patient found. <Button variant="link" className="px-1" onClick={() => {
                                    setShowForm(true);
                                    form.setValue('phone', phoneNumber);
                                    // Default gender based on clinic preference
                                    if (clinicDetails?.genderPreference === 'Men') {
                                        form.setValue('sex', 'Male');
                                    } else if (clinicDetails?.genderPreference === 'Women') {
                                        form.setValue('sex', 'Female');
                                    }
                                }}>Add manually</Button>.
                            </p>
                        )}
                    </div>

                    {/* Link-Pending Patients List - Only show when form is not visible */}
                    {!showForm && linkPendingPatients.length > 0 && (
                        <Card className="mt-4 bg-blue-50 border-blue-200">
                            <CardHeader className="pb-3">
                                <CardTitle className="text-sm font-semibold text-blue-900">
                                    Patients Awaiting Booking ({linkPendingPatients.length})
                                </CardTitle>
                                <p className="text-xs text-blue-700">Links sent but booking not completed</p>
                            </CardHeader>
                            <CardContent className="space-y-2">
                                {linkPendingPatients.map((patient) => (
                                    <div key={patient.id} className="flex items-center justify-between p-3 bg-white rounded-lg border border-blue-100">
                                        <div className="flex-1">
                                            <p className="text-sm font-medium text-gray-900">{patient.phone}</p>
                                            <p className="text-xs text-gray-500">Link sent - awaiting booking</p>
                                        </div>
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            className="gap-2 bg-green-50 text-green-700 hover:bg-green-100 border-green-200"
                                            onClick={() => {
                                                if (patient.phone) {
                                                    window.location.href = `tel:${patient.phone}`;
                                                }
                                            }}
                                        >
                                            <Phone className="h-4 w-4" />
                                            Call
                                        </Button>
                                    </div>
                                ))}
                            </CardContent>
                        </Card>
                    )}

                    {showForm && (
                        <>
                            {primaryPatient && (
                                <Card className="mb-4">
                                    <CardHeader>
                                        <CardTitle className="text-lg">Booking For Family</CardTitle>
                                    </CardHeader>
                                    <CardContent className="space-y-3">
                                        <p className="text-sm text-muted-foreground">You are booking for the family of <strong>{primaryPatient.name}</strong>.</p>
                                        {relatives.length > 0 && (
                                            <div className="space-y-2">
                                                <h4 className="font-medium text-sm">Existing Relatives:</h4>
                                                <div className="max-h-40 overflow-y-auto space-y-2 rounded-md border p-2">
                                                    {relatives.map(relative => (
                                                        <div key={relative.id} className="flex items-center justify-between p-2 rounded hover:bg-muted">
                                                            <div className="flex items-center gap-3">
                                                                <Avatar className="h-8 w-8">
                                                                    <AvatarFallback>{relative.name.charAt(0)}</AvatarFallback>
                                                                </Avatar>
                                                                <div>
                                                                    <p className="text-sm font-medium">{relative.name}</p>
                                                                    <p className="text-xs text-muted-foreground">{relative.sex}, {relative.age} years</p>
                                                                </div>
                                                            </div>
                                                            <Button size="sm" variant="outline" onClick={() => handleSelectRelative(relative)}>Select</Button>
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        )}
                                        <Button type="button" className="w-full" variant="secondary" onClick={() => setIsAddRelativeDialogOpen(true)}>
                                            <UserPlus className="mr-2 h-4 w-4" />
                                            Add & Book for New Relative
                                        </Button>
                                    </CardContent>
                                </Card>
                            )}

                            <Form {...form}>
                                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 border-t pt-4">
                                    <h3 className="font-semibold text-lg">{selectedPatient ? `Confirm details for ${selectedPatient.name}` : 'Add New Patient'}</h3>
                                    <FormField
                                        control={form.control}
                                        name="patientName"
                                        render={({ field }) => (
                                            <FormItem>
                                                <FormLabel>Full Name</FormLabel>
                                                <FormControl>
                                                    <Input
                                                        placeholder="Enter patient name"
                                                        {...field}
                                                        value={field.value || ''}
                                                        onBlur={field.onBlur}
                                                        onChange={(e) => {
                                                            field.onChange(e);
                                                            form.trigger('patientName');
                                                        }}
                                                    />
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
                                                        type="text"
                                                        inputMode="numeric"
                                                        placeholder="Enter the age"
                                                        {...field}
                                                        value={field.value?.toString() ?? ''}
                                                        onBlur={field.onBlur}
                                                        onChange={(e) => {
                                                            const val = e.target.value;
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
                                        )}
                                    />
                                    <FormField
                                        control={form.control}
                                        name="sex"
                                        render={({ field }) => (
                                            <FormItem>
                                                <FormLabel>Sex</FormLabel>
                                                <Select onValueChange={field.onChange} value={field.value || ''}>
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
                                    <FormField
                                        control={form.control}
                                        name="place"
                                        render={({ field }) => (
                                            <FormItem>
                                                <FormLabel>Place</FormLabel>
                                                <FormControl>
                                                    <Input
                                                        placeholder="Enter place"
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
                                                            value={(field.value || '').replace(/^\+91/, '')}
                                                            className="pl-12 rounded-l-none bg-gray-100 text-muted-foreground cursor-not-allowed pointer-events-none"
                                                            placeholder="Enter 10-digit number"
                                                            readOnly
                                                            tabIndex={-1}
                                                        />
                                                    </div>
                                                </FormControl>
                                                <FormMessage />
                                            </FormItem>
                                        )}
                                    />

                                    <Button type="submit" className="w-full mt-6" disabled={isSubmitting || !form.formState.isValid}>
                                        {isSubmitting ? (
                                            <>
                                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                                Processing...
                                            </>
                                        ) : (
                                            `Next: Book for ${selectedPatient ? selectedPatient.name.split(' ')[0] : 'New Patient'}`
                                        )}
                                    </Button>
                                </form>
                            </Form>
                        </>
                    )}
                </div>
            </div>
            {primaryPatient && (
                <AddRelativeDialog
                    isOpen={isAddRelativeDialogOpen}
                    setIsOpen={setIsAddRelativeDialogOpen}
                    primaryPatientPhone={phoneNumber}
                    clinicId={clinicId}
                    onRelativeAdded={handleNewRelativeAdded}
                    genderPreference={clinicDetails?.genderPreference}
                />
            )}
        </AppFrameLayout>
    );
}


export default function PhoneBookingDetailsPage() {
    return (
        <Suspense fallback={<div className="h-full w-full flex items-center justify-center"><Loader2 className="animate-spin" /></div>}>
            <PhoneBookingDetailsContent />
        </Suspense>
    );
}
