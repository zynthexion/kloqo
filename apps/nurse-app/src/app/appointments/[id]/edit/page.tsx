
'use client';

import { useState, useEffect, use } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, ArrowLeft, Calendar } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import AppFrameLayout from '@/components/layout/app-frame';
import { useToast } from '@/hooks/use-toast';
import { collection, getDocs, doc, getDoc, updateDoc, query, where, deleteDoc } from 'firebase/firestore';
import type { Appointment } from '@/lib/types';
import { db } from '@/lib/firebase';
import type { Doctor, Patient } from '@/lib/types';
import { errorEmitter } from '@kloqo/shared-core';
import { FirestorePermissionError } from '@kloqo/shared-core';
import { managePatient } from '@kloqo/shared-core';
import { Card, CardContent } from '@/components/ui/card';
import { format, parseISO, getDay, isBefore, addMinutes, subMinutes, parse } from 'date-fns';
import { generateNextTokenAndReserveSlot } from '@kloqo/shared-core';

import { parseTime } from '@/lib/utils';
import { sendBreakUpdateNotification } from '@kloqo/shared-core';

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
});

type EditAppointmentPageProps = {
    params: Promise<{
        id: string;
    }>
}

export default function EditAppointmentPage({ params }: EditAppointmentPageProps) {
    const router = useRouter();
    const searchParams = useSearchParams();
    const { toast } = useToast();
    const { id: appointmentId } = use(params);
    const newSlotParam = searchParams.get('newSlot');

    const [isProcessing, setIsProcessing] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [doctors, setDoctors] = useState<Doctor[]>([]);
    const [appointment, setAppointment] = useState<Appointment | null>(null);
    const [clinicId, setClinicId] = useState<string | null>(null);
    const [displayDate, setDisplayDate] = useState<string | null>(null);
    const [displayTime, setDisplayTime] = useState<string | null>(null);


    const form = useForm<z.infer<typeof formSchema>>({
        resolver: zodResolver(formSchema),
        defaultValues: {},
    });

    useEffect(() => {
        const id = localStorage.getItem('clinicId');
        if (!id) {
            router.push('/login');
            return;
        }
        setClinicId(id);
    }, [router]);

    useEffect(() => {
        if (!clinicId) return;

        const fetchInitialData = async () => {
            setIsLoading(true);
            try {
                const appointmentRef = doc(db, 'appointments', appointmentId);
                const appointmentSnap = await getDoc(appointmentRef).catch(async (serverError) => {
                    const permissionError = new FirestorePermissionError({
                        path: appointmentRef.path,
                        operation: 'get',
                    });
                    errorEmitter.emit('permission-error', permissionError);
                    throw serverError;
                });

                if (!appointmentSnap.exists() || appointmentSnap.data().clinicId !== clinicId) {
                    toast({ variant: 'destructive', title: 'Not Found', description: 'Appointment not found.' });
                    router.push('/appointments');
                    return;
                }

                const appointmentData = { id: appointmentSnap.id, ...appointmentSnap.data() } as Appointment;
                setAppointment(appointmentData);

                if (newSlotParam) {
                    const newDate = parseISO(newSlotParam);
                    setDisplayDate(format(newDate, "d MMMM yyyy"));
                    setDisplayTime(format(newDate, "hh:mm a"));
                } else {
                    setDisplayDate(appointmentData.date || null);
                    setDisplayTime(appointmentData.time || null);
                }

                let patientData: Patient | null = null;
                if (appointmentData.patientId) {
                    const patientRef = doc(db, 'patients', appointmentData.patientId);
                    const patientSnap = await getDoc(patientRef);
                    if (patientSnap.exists()) {
                        patientData = patientSnap.data() as Patient;
                    }
                }

                const phone = patientData?.communicationPhone ?? appointmentData.communicationPhone ?? '';
                form.reset({
                    patientName: appointmentData.patientName,
                    age: patientData?.age ?? appointmentData.age,
                    phone: phone.replace('+91', ''),
                    place: patientData?.place ?? appointmentData.place,
                    sex: patientData?.sex ?? appointmentData.sex,
                });

                const doctorsQuery = query(collection(db, 'doctors'), where('clinicId', '==', clinicId));
                const doctorsSnapshot = await getDocs(doctorsQuery).catch(async (serverError) => {
                    const permissionError = new FirestorePermissionError({
                        path: 'doctors',
                        operation: 'list',
                    });
                    errorEmitter.emit('permission-error', permissionError);
                    throw serverError;
                });
                const fetchedDoctors = doctorsSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })) as Doctor[];
                setDoctors(fetchedDoctors);

            } catch (error: any) {
                if (error.name !== 'FirestorePermissionError') {
                    console.error('Error fetching initial data:', error);
                    toast({
                        variant: 'destructive',
                        title: 'Error',
                        description: 'Could not fetch required data. Please try again.',
                    });
                }
            } finally {
                setIsLoading(false);
            }
        };
        fetchInitialData();
    }, [appointmentId, toast, router, form, clinicId, newSlotParam]);


    async function onSubmit(values: z.infer<typeof formSchema>) {
        if (!clinicId || !appointment) {
            toast({ variant: "destructive", title: "Error", description: "Clinic or appointment data is missing." });
            return;
        }
        setIsProcessing(true);

        try {
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
                setIsProcessing(false);
                return;
            }
            const patientId = await managePatient({
                phone: fullPhoneNumber,
                communicationPhone: fullPhoneNumber,
                name: values.patientName,
                age: values.age,
                place: values.place,
                sex: values.sex,
                clinicId,
                bookingUserId: appointment.patientId || `user_${fullPhoneNumber}`,
                bookingFor: 'self',
            });

            const appointmentRef = doc(db, 'appointments', appointmentId);

            const updatedAppointment: any = {
                patientName: values.patientName,
                age: values.age,
                communicationPhone: fullPhoneNumber,
                place: values.place,
                sex: values.sex,
                patientId,
                clinicId
            };

            // Reservation ID for any newly reserved slot during reschedule so we can clean it up later
            let reservationId: string | undefined;

            // If rescheduling (newSlotParam exists), regenerate token using same logic as new appointment
            if (newSlotParam && appointment) {
                const newDate = parseISO(newSlotParam);
                const appointmentDateStr = format(newDate, "d MMMM yyyy");
                const appointmentTimeStr = format(newDate, "hh:mm a");

                // Find the doctor
                const doctor = doctors.find(d => d.name === appointment.doctor);
                if (!doctor) {
                    toast({ variant: 'destructive', title: 'Error', description: 'Doctor not found.' });
                    return;
                }

                // Calculate slotIndex and sessionIndex for the new date/time
                let slotIndex = -1;
                let sessionIndex = -1;
                const daysOfWeek = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
                const dayOfWeek = daysOfWeek[getDay(newDate)];
                const availabilityForDay = doctor.availabilitySlots?.find(s => s.day === dayOfWeek);

                if (availabilityForDay) {
                    let globalSlotIndex = 0;
                    for (let i = 0; i < availabilityForDay.timeSlots.length; i++) {
                        const session = availabilityForDay.timeSlots[i];
                        let currentTime = parseTime(session.from, newDate);
                        const endTime = parseTime(session.to, newDate);
                        const slotDuration = doctor.averageConsultingTime || 15;

                        while (isBefore(currentTime, endTime)) {
                            if (format(currentTime, "hh:mm a") === appointmentTimeStr) {
                                slotIndex = globalSlotIndex;
                                sessionIndex = i;
                                break;
                            }
                            currentTime = addMinutes(currentTime, slotDuration);
                            globalSlotIndex++;
                        }
                        if (slotIndex !== -1) break;
                    }
                }

                // Generate new token and reserve slot using same logic as new appointment
                if (slotIndex !== -1) {
                    try {
                        const tokenData = await generateNextTokenAndReserveSlot(
                            clinicId,
                            doctor.name,
                            newDate,
                            'A',
                            {
                                time: appointmentTimeStr,
                                slotIndex: slotIndex,
                                doctorId: doctor.id,
                                existingAppointmentId: appointment.id,
                            }
                        );
                        reservationId = tokenData.reservationId;
                        const actualSlotIndex = tokenData.slotIndex;
                        const actualTime = tokenData.time ?? appointmentTimeStr;

                        updatedAppointment.date = appointmentDateStr;
                        updatedAppointment.time = actualTime;
                        updatedAppointment.arriveByTime = actualTime; // Set arriveByTime to match the new appointment time
                        updatedAppointment.tokenNumber = tokenData.tokenNumber;
                        updatedAppointment.numericToken = tokenData.numericToken;
                        updatedAppointment.slotIndex = actualSlotIndex;
                        updatedAppointment.sessionIndex = sessionIndex;

                        // Calculate cut-off time and no-show time (same logic as clinic admin)
                        let cutOffTime: Date | undefined;
                        let noShowTime: Date | undefined;
                        let inheritedDelay = 0;
                        try {
                            const appointmentDate = parse(appointmentDateStr, "d MMMM yyyy", new Date());
                            const appointmentTime = parseTime(actualTime, appointmentDate);
                            cutOffTime = subMinutes(appointmentTime, 15);

                            // Inherit delay from previous appointment (if any)
                            // Find the appointment with the highest slotIndex that is less than actualSlotIndex
                            const appointmentsRef = collection(db, 'appointments');
                            const appointmentsQuery = query(
                                appointmentsRef,
                                where('clinicId', '==', clinicId),
                                where('doctor', '==', doctor.name),
                                where('date', '==', appointmentDateStr)
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
                                    return aptSlotIndex >= 0 && aptSlotIndex < actualSlotIndex && a.id !== appointment.id;
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

                        updatedAppointment.cutOffTime = cutOffTime;
                        updatedAppointment.noShowTime = noShowTime;
                        if (inheritedDelay > 0) {
                            updatedAppointment.delay = inheritedDelay;
                        }
                    } catch (error: any) {
                        if (error.code === 'SLOT_OCCUPIED' || error.message === 'SLOT_ALREADY_BOOKED') {
                            toast({
                                variant: "destructive",
                                title: "Time Slot Already Booked",
                                description: "This time slot was just booked by someone else. Please select another time.",
                            });
                            setIsProcessing(false);
                            return;
                        } else if (error.code === 'A_CAPACITY_REACHED') {
                            toast({
                                variant: "destructive",
                                title: "No Slots Available",
                                description: "Advance booking capacity has been reached for this doctor today. Please choose another day.",
                            });
                            setIsProcessing(false);
                            return;
                        }
                        throw error;
                    }
                } else {
                    // If slotIndex calculation failed, just update date/time without token regeneration
                    const fallbackTime = format(newDate, "hh:mm a");
                    updatedAppointment.date = format(newDate, "d MMMM yyyy");
                    updatedAppointment.time = fallbackTime;
                    updatedAppointment.arriveByTime = fallbackTime; // Set arriveByTime to match the new appointment time

                    // Calculate cut-off time and no-show time even when slotIndex calculation failed
                    let cutOffTime: Date | undefined;
                    let noShowTime: Date | undefined;
                    try {
                        const appointmentDate = parse(format(newDate, "d MMMM yyyy"), "d MMMM yyyy", new Date());
                        const appointmentTime = parseTime(fallbackTime, appointmentDate);
                        cutOffTime = subMinutes(appointmentTime, 15);
                        noShowTime = addMinutes(appointmentTime, 15);
                    } catch (error) {
                        console.error('Error calculating cut-off and no-show times (fallback):', error);
                    }

                    updatedAppointment.cutOffTime = cutOffTime;
                    updatedAppointment.noShowTime = noShowTime;
                }
            }

            const releaseReservation = async (delayMs: number = 0) => {
                if (!reservationId) return;
                if (delayMs > 0) {
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                }
                try {
                    await deleteDoc(doc(db, 'slot-reservations', reservationId));
                } catch (cleanupError) {
                    console.warn('⚠️ [NURSE EDIT] Failed to release reservation:', cleanupError);
                }
            }

            try {
                await updateDoc(appointmentRef, updatedAppointment);
            } catch (serverError) {
                await releaseReservation();
                const permissionError = new FirestorePermissionError({
                    path: appointmentRef.path,
                    operation: 'update',
                    requestResourceData: updatedAppointment,
                });
                errorEmitter.emit('permission-error', permissionError);
                throw serverError;
            }

            await releaseReservation(2000);

            // Send reschedule notification if appointment was rescheduled (newSlotParam exists)
            if (newSlotParam && appointment) {
                try {
                    const clinicName = 'The clinic'; // You can fetch actual clinic name if needed
                    // Use the patientId from the updated appointment (which may have changed) or fallback to original
                    const notificationPatientId = updatedAppointment.patientId || appointment.patientId;

                    if (!notificationPatientId) {
                        console.warn('Cannot send reschedule notification: patientId is missing');
                    } else {
                        await sendBreakUpdateNotification({
                            firestore: db,
                            patientId: notificationPatientId,
                            appointmentId: appointment.id,
                            doctorName: updatedAppointment.doctor || appointment.doctor,
                            clinicName,
                            oldTime: appointment.time,
                            newTime: updatedAppointment.time || appointment.time,
                            oldDate: appointment.date,
                            newDate: updatedAppointment.date || appointment.date,
                            reason: 'Appointment rescheduled by nurse',
                            oldArriveByTime: appointment.arriveByTime,
                            newArriveByTime: updatedAppointment.arriveByTime || updatedAppointment.time || appointment.arriveByTime,
                        });
                    }
                } catch (notifError) {
                    console.error('Failed to send reschedule notification from nurse app:', notifError);
                }
            }

            toast({
                title: 'Success',
                description: `Appointment details updated successfully.`,
            });
            router.push('/appointments');

        } catch (error: any) {
            if (error.name !== 'FirestorePermissionError') {
                console.error('Error updating appointment:', error);
                toast({
                    variant: 'destructive',
                    title: 'Error',
                    description: 'Could not update appointment. Please try again.',
                });
            }
        } finally {
            setIsProcessing(false);
        }
    }

    const handleReschedule = () => {
        if (!appointment || !doctors.length) return;
        const doctor = doctors.find(d => d.name === appointment.doctor);
        if (!doctor) {
            toast({ variant: 'destructive', title: 'Error', description: 'Could not find the doctor associated with this appointment.' });
            return;
        }
        router.push(`/book-appointment?doctor=${doctor.id}&appointmentId=${appointment.id}&edit=true`);
    };

    if (isLoading) {
        return (
            <AppFrameLayout>
                <div className="w-full h-full flex items-center justify-center">
                    <Loader2 className="h-8 w-8 animate-spin" />
                </div>
            </AppFrameLayout>
        )
    }

    return (
        <AppFrameLayout>
            <div className="flex flex-col h-full">
                <header className="flex items-center gap-4 p-4 border-b">
                    <Link href="/appointments">
                        <Button variant="ghost" size="icon">
                            <ArrowLeft />
                        </Button>
                    </Link>
                    <div className="flex-1">
                        <h1 className="text-xl font-bold">Edit Appointment</h1>
                        <p className="text-sm text-muted-foreground">
                            Modify details for #{appointment?.tokenNumber} - {appointment?.patientName}
                        </p>
                    </div>
                </header>
                <div className="p-6 overflow-y-auto flex-1">
                    <Card className="mb-6">
                        <CardContent className="p-4 space-y-3">
                            <h3 className="font-semibold">Current Appointment Time</h3>
                            <div className="flex items-center justify-between text-sm">
                                <div className="flex items-center gap-2">
                                    <Calendar className="h-4 w-4 text-muted-foreground" />
                                    <span>{displayDate} at {displayTime}</span>
                                </div>
                                <Button variant="outline" size="sm" onClick={handleReschedule}>
                                    Change
                                </Button>
                            </div>
                        </CardContent>
                    </Card>

                    <Form {...form}>
                        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                            <FormField
                                control={form.control}
                                name="patientName"
                                render={({ field }) => (
                                    <FormItem>
                                        <FormLabel>Full Name</FormLabel>
                                        <FormControl>
                                            <Input placeholder="e.g. John Doe" {...field} />
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
                                            <Input type="number" placeholder="e.g. 42" {...field} />
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
                                            <div className="flex items-center gap-2">
                                                <span className="inline-flex items-center px-3 rounded-l-md border border-r-0 border-gray-300 bg-gray-50 text-gray-500 text-sm h-10">
                                                    +91
                                                </span>
                                                <Input type="tel" placeholder="98765 43210" {...field} className="rounded-l-none" />
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
                                            <Input placeholder="e.g. Springfield" {...field} />
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
                                        <Select onValueChange={field.onChange} value={field.value}>
                                            <FormControl>
                                                <SelectTrigger>
                                                    <SelectValue placeholder="Select sex" />
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

                            <Button type="submit" className="w-full mt-6" disabled={isProcessing}>
                                {isProcessing ? (
                                    <>
                                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                        Saving Patient Details...
                                    </>
                                ) : (
                                    'Save Patient Details'
                                )}
                            </Button>
                        </form>
                    </Form>
                </div>
            </div>
        </AppFrameLayout>
    );
}
