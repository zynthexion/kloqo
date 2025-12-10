

'use client';

import { useState, useEffect, useCallback } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, ArrowLeft } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { collection, getDocs, doc, getDoc, query, where, addDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import type { Doctor, Patient } from '@/lib/types';
import AppFrameLayout from '@/components/layout/app-frame';
import { errorEmitter } from '@kloqo/shared-core';
import { FirestorePermissionError } from '@kloqo/shared-core';
import { managePatient } from '@kloqo/shared-core';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent } from '@/components/ui/card';

const formSchema = z.object({
    patientName: z.string().min(2, { message: "Name must be at least 2 characters." }),
    age: z.coerce.number().int().positive({ message: "Age must be a positive number." }),
    phone: z.string().min(10, { message: "Please enter a valid 10-digit phone number." }).max(10, { message: "Please enter a valid 10-digit phone number." }),
    place: z.string().min(2, { message: "Location is required." }),
    gender: z.string().min(1, { message: "Gender is required." }),
});

function PhoneBookingDetailsContent() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const { toast } = useToast();
    const doctorId = searchParams.get('doctor');

    const [isSubmitting, setIsSubmitting] = useState(false);
    const [doctor, setDoctor] = useState<Doctor | null>(null);
    const [clinicId, setClinicId] = useState<string | null>(null);

    const [phoneNumber, setPhoneNumber] = useState('');
    const [isSearchingPatient, setIsSearchingPatient] = useState(false);
    const [isSendingLink, setIsSendingLink] = useState(false);
    const [suggestedPatients, setSuggestedPatients] = useState<Patient[]>([]);
    const [showForm, setShowForm] = useState(false);


    const form = useForm<z.infer<typeof formSchema>>({
        resolver: zodResolver(formSchema),
        defaultValues: {
            patientName: '',
            age: '' as any,
            phone: '',
            place: '',
            gender: '',
        },
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

    const handlePatientSearch = useCallback(async (phone: string) => {
        if (phone.length < 5 || !clinicId) {
            setSuggestedPatients([]);
            setShowForm(false);
            return;
        };
        setIsSearchingPatient(true);
        try {
            const fullPhoneNumber = `+91${phone}`;
            const patientsRef = collection(db, 'patients');
            const q = query(patientsRef, where('phone', '>=', fullPhoneNumber), where('phone', '<=', fullPhoneNumber + '\uf8ff'), where('clinicIds', 'array-contains', clinicId));
            const querySnapshot = await getDocs(q).catch(e => {
                toast({
                    variant: 'destructive',
                    title: 'Index Required',
                    description: 'A composite index is needed for this query. Please check the console for the creation link.',
                });
                const firestoreError = e as any;
                const regex = /(https?:\/\/[^\s]+)/;
                const match = firestoreError.message.match(regex);
                if (match) {
                    console.error(`Firestore index required. Please create it here: ${match[0]}`);
                }
                throw e;
            });

            if (!querySnapshot.empty) {
                const patients = querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Patient));
                setSuggestedPatients(patients);
            } else {
                setSuggestedPatients([]);
                // Don't automatically show form. Wait for user action.
                setShowForm(false);
                form.reset({ patientName: '', age: '' as any, place: '', gender: '' });
                form.setValue('phone', phone);
            }

        } catch (error) {
            console.error("Error searching patient:", error);
        } finally {
            setIsSearchingPatient(false);
        }
    }, [clinicId, toast, form]);

    useEffect(() => {
        const debounceTimer = setTimeout(() => {
            if (phoneNumber) {
                handlePatientSearch(phoneNumber);
            } else {
                setSuggestedPatients([]);
                setShowForm(false);
            }
        }, 500); // Debounce search by 500ms

        return () => clearTimeout(debounceTimer);
    }, [phoneNumber, handlePatientSearch]);


    const selectPatient = (patient: Patient) => {
        // When an existing patient is selected, we assume this is the 'self' booking context
        // and we can pass their ID to the next page.
        if (!doctor) return;
        router.push(`/book-appointment?doctor=${doctor.id}&patientId=${patient.id}&bookingUserId=${patient.primaryUserId}&source=phone`);
    }

    const handleSendLink = async () => {
        const fullPhoneNumber = `+91${phoneNumber}`;
        if (!phoneNumber || !clinicId) {
            toast({ variant: "destructive", title: "Missing Phone Number", description: "Please enter a phone number to send a link." });
            return;
        }

        if (suggestedPatients.length > 0 || showForm) {
            toast({ title: "Patient Exists", description: "This patient is already in the system. Proceed to select a time slot." });
            return;
        }

        setIsSendingLink(true);
        try {
            // This part of the logic remains largely conceptual for a clinic app.
            // In a real patient app, you'd send a link. Here, we just create a placeholder.
            const newPatientData = {
                phone: fullPhoneNumber,
                clinicIds: [clinicId],
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
                name: '',
                age: null,
                location: '',
                gender: '',
            };
            await addDoc(collection(db, 'patients'), newPatientData);

            toast({
                title: "Link Sent (Simulated)",
                description: `A registration link has been sent to ${fullPhoneNumber}.`
            });
            setPhoneNumber('');

        } catch (error) {
            console.error("Error in send link flow:", error);
            toast({ variant: 'destructive', title: 'Error', description: 'Could not complete the action.' });
        } finally {
            setIsSendingLink(false);
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
            const fullPhoneNumber = `+91${values.phone}`;
            // For a new manual entry by clinic staff, we assume it's a new primary user context for simplicity.
            const mockBookingUserId = `user_${fullPhoneNumber}`;
            const patientId = await managePatient({
                phone: fullPhoneNumber,
                name: values.patientName,
                age: values.age,
                place: values.place,
                sex: values.gender,
                clinicId,
                bookingUserId: mockBookingUserId,
                bookingFor: 'self' // A new manual entry is treated as a new 'self'
            });

            router.push(`/book-appointment?doctor=${doctor.id}&patientId=${patientId}&bookingUserId=${mockBookingUserId}&source=phone`);

        } catch (error: any) {
            if (error.name !== 'FirestorePermissionError') {
                console.error('Error in patient processing:', error);
                toast({ variant: 'destructive', title: 'Error', description: error.message || 'An unexpected error occurred.' });
            }
        } finally {
            setIsSubmitting(false);
        }
    }


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
                                    placeholder="Start typing phone number..."
                                    value={phoneNumber}
                                    onChange={(e) => setPhoneNumber(e.target.value)}
                                    className="flex-1 rounded-l-none"
                                />
                                {isSearchingPatient && <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin h-4 w-4 text-muted-foreground" />}
                            </div>
                            <Button onClick={handleSendLink} variant="outline" disabled={isSendingLink || showForm}>
                                {isSendingLink ? <Loader2 className="animate-spin" /> : 'Send Link'}
                            </Button>
                        </div>

                        {suggestedPatients.length > 0 && (
                            <Card>
                                <CardContent className="p-2 space-y-1">
                                    <p className="text-xs text-muted-foreground px-2">Select an existing patient:</p>
                                    {suggestedPatients.map(p => (
                                        <button key={p.id} onClick={() => selectPatient(p)} className="w-full text-left p-2 rounded-md hover:bg-muted">
                                            <p className="font-semibold">{p.name || 'Unnamed Patient'}</p>
                                            <p className="text-sm text-muted-foreground">{p.phone} - {p.place}</p>
                                        </button>
                                    ))}
                                </CardContent>
                            </Card>
                        )}
                        {phoneNumber.length > 5 && suggestedPatients.length === 0 && !showForm && !isSearchingPatient && (
                            <p className="text-sm text-center text-muted-foreground py-2">
                                No patient found. Click 'Send Link' or <Button variant="link" className="px-1" onClick={() => { setShowForm(true); form.setValue('phone', phoneNumber) }}>add manually</Button>.
                            </p>
                        )}
                    </div>

                    {showForm && (
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
                                                <div className="flex items-center">
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
                                            <FormLabel>City / Location</FormLabel>
                                            <FormControl>
                                                <Input placeholder="e.g. Springfield" {...field} />
                                            </FormControl>
                                            <FormMessage />
                                        </FormItem>
                                    )}
                                />
                                <FormField
                                    control={form.control}
                                    name="gender"
                                    render={({ field }) => (
                                        <FormItem>
                                            <FormLabel>Gender</FormLabel>
                                            <Select onValueChange={field.onChange} value={field.value}>
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
                                            Processing...
                                        </>
                                    ) : (
                                        'Next: Select Time Slot'
                                    )}
                                </Button>
                            </form>
                        </Form>
                    )}
                </div>
            </div>
        </AppFrameLayout>
    );
}

import { Suspense } from 'react';

export default function PhoneBookingDetailsPage() {
    return (
        <Suspense fallback={<div>Loading...</div>}>
            <PhoneBookingDetailsContent />
        </Suspense>
    );
}




