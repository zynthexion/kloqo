'use client';

import { Suspense } from 'react';
import { AuthGuard } from '@/components/auth-guard';
import { useSearchParams, useRouter } from 'next/navigation';
import { format, subMinutes } from 'date-fns';
import { ArrowLeft, Calendar, Clock, Loader2 } from 'lucide-react';

import { useFirestore } from '@/firebase';
import { doc, getDoc, query, collection, where, getDocs } from 'firebase/firestore';
import type { Doctor } from '@/lib/types';
import { useUser } from '@/firebase/auth/use-user';
import { useLanguage } from '@/contexts/language-context';
import { useMasterDepartments } from '@/hooks/use-master-departments';
import { getLocalizedDepartmentName } from '@/lib/department-utils';
import { formatDate, formatDayOfWeek } from '@/lib/date-utils';
import { Skeleton } from '@/components/ui/skeleton';

import { Card, CardContent } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { PatientForm } from '@kloqo/shared-ui';

import { useEffect, useState } from 'react';
import { getDoctorFromCache, saveDoctorToCache } from '@/lib/doctor-cache';

// Prevent static generation - this page requires Firebase context
export const dynamic = 'force-dynamic';

function AppointmentDetailsContent() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const firestore = useFirestore();
    const { toast } = useToast();
    const { t, language } = useLanguage();
    const { departments } = useMasterDepartments();

    const doctorId = searchParams.get('doctorId');
    const slotISO = searchParams.get('slot');

    // Progressive loading: Try cache first for instant display
    const cachedDoctor = doctorId ? getDoctorFromCache(doctorId) : null;
    const [doctor, setDoctor] = useState<Doctor | null>(cachedDoctor);
    const [loading, setLoading] = useState(!cachedDoctor); // Don't show loading if we have cache
    const [slotAvailable, setSlotAvailable] = useState<boolean | null>(null);

    const selectedSlot = slotISO ? new Date(slotISO) : null;

    // Progressive loading: Fetch doctor with cache support + start slot check in parallel
    useEffect(() => {
        if (!doctorId || !firestore) {
            setLoading(false);
            return;
        }

        const fetchDoctor = async () => {
            // Show loading only if we don't have cached data
            if (!cachedDoctor) {
                setLoading(true);
            }

            try {
                const doctorDocRef = doc(firestore, 'doctors', doctorId);
                const doctorDoc = await getDoc(doctorDocRef);
                if (doctorDoc.exists()) {
                    const currentDoctor = { id: doctorDoc.id, ...doctorDoc.data() } as Doctor;
                    setDoctor(currentDoctor);
                    // Cache doctor data for faster next visit
                    saveDoctorToCache(doctorId, currentDoctor);
                } else {
                    toast({ variant: 'destructive', title: t.bookAppointment.error, description: t.bookAppointment.doctorNotFound });
                }
            } catch (error) {
                console.error('Error fetching doctor details:', error);
                toast({ variant: 'destructive', title: t.bookAppointment.error, description: t.bookAppointment.couldNotLoadDoctor });
            } finally {
                setLoading(false);
            }
        };

        fetchDoctor();
    }, [doctorId, firestore, toast, t, cachedDoctor]);

    // Optimized: Start slot availability check earlier - use cached doctor or wait for fresh
    useEffect(() => {
        const checkSlotAvailability = async () => {
            const effectiveDoctor = doctor || cachedDoctor;
            if (!effectiveDoctor || !selectedSlot || !firestore) {
                return;
            }

            try {
                // Check for active appointments (Pending/Confirmed) - No-show slots are available
                const slotBookedQuery = query(
                    collection(firestore, 'appointments'),
                    where('clinicId', '==', effectiveDoctor.clinicId),
                    where('doctor', '==', effectiveDoctor.name),
                    where('date', '==', format(selectedSlot, 'd MMMM yyyy')),
                    where('time', '==', format(selectedSlot, 'hh:mm a')),
                    where('status', 'in', ['Pending', 'Confirmed'])
                );

                const slotSnapshot = await getDocs(slotBookedQuery);
                // Slot is available if no active appointment (No-show slots are considered available)
                setSlotAvailable(slotSnapshot.empty);
            } catch (error) {
                console.error('Error checking slot availability:', error);
            }
        };

        checkSlotAvailability();
    }, [doctor, cachedDoctor, selectedSlot, firestore]);

    const handleBack = () => {
        router.back();
    };

    // Show page structure immediately, even while loading
    // This prevents the empty screen flash during navigation
    if (!selectedSlot) {
        return <p className="text-center text-muted-foreground">{t.bookAppointment.incompleteDetails}</p>;
    }

    return (
        <div className="space-y-6">
            <Card>
                <CardContent className="p-4 space-y-4">
                    {loading || (!doctor && !cachedDoctor) ? (
                        // Show skeleton while doctor loads
                        <>
                            <div className="flex items-center gap-4">
                                <Skeleton className="h-16 w-16 rounded-full" />
                                <div className="flex-grow space-y-2">
                                    <Skeleton className="h-6 w-40" />
                                    <Skeleton className="h-5 w-32" />
                                    <Skeleton className="h-4 w-24" />
                                </div>
                            </div>
                            <div className="border-t pt-4 space-y-2">
                                <Skeleton className="h-5 w-48" />
                                <Skeleton className="h-5 w-32" />
                            </div>
                        </>
                    ) : (
                        // Show doctor info when loaded (use cached or fresh)
                        <>
                            {(doctor || cachedDoctor) && (
                                <>
                                    <div className="flex items-center gap-4">
                                        <Avatar className="h-16 w-16">
                                            {(doctor || cachedDoctor)?.avatar && <AvatarImage src={(doctor || cachedDoctor)!.avatar} alt={(doctor || cachedDoctor)!.name} />}
                                            <AvatarFallback>{(doctor || cachedDoctor)!.name.split(' ').map(n => n[0]).join('')}</AvatarFallback>
                                        </Avatar>
                                        <div className="flex-grow">
                                            <h3 className="font-bold text-lg">{(doctor || cachedDoctor)!.name}</h3>
                                            <p className="text-muted-foreground">{getLocalizedDepartmentName((doctor || cachedDoctor)!.department, language, departments)}</p>
                                            {(doctor || cachedDoctor)!.specialty && (
                                                <p className="text-sm text-muted-foreground">{(doctor || cachedDoctor)!.specialty}</p>
                                            )}
                                        </div>
                                    </div>
                                </>
                            )}
                            <div className="border-t pt-4 space-y-2">
                                {selectedSlot && (
                                    <>
                                        <div className="flex items-center gap-3">
                                            <Calendar className="w-5 h-5 text-primary" />
                                            <span className="font-semibold">{formatDayOfWeek(selectedSlot, language)}, {format(selectedSlot, 'dd')}{language === 'ml' ? ' ' : ', '}{formatDate(selectedSlot, 'MMMM', language)}, {format(selectedSlot, 'yyyy')}</span>
                                        </div>
                                        <div className="flex items-center gap-3">
                                            <Clock className="w-5 h-5 text-primary" />
                                            <div>
                                                <span className="text-xs text-muted-foreground block">Arrive by</span>
                                                <span className="font-semibold">{format(subMinutes(selectedSlot, 15), 'hh:mm a')}</span>
                                            </div>
                                        </div>
                                    </>
                                )}
                            </div>
                        </>
                    )}
                </CardContent>
            </Card>
            {/* Progressive loading: Show PatientForm with cached doctor if available, otherwise show skeleton */}
            {doctor || cachedDoctor ? (
                <PatientForm selectedDoctor={doctor || cachedDoctor!} appointmentType="Online" />
            ) : (
                // Show form skeleton while waiting for doctor
                <Card>
                    <CardContent className="p-6 space-y-6">
                        <Skeleton className="h-6 w-48" />
                        <div className="space-y-4">
                            <Skeleton className="h-10 w-full" />
                            <div className="grid grid-cols-2 gap-4">
                                <Skeleton className="h-10 w-full" />
                                <Skeleton className="h-10 w-full" />
                            </div>
                            <Skeleton className="h-10 w-full" />
                            <Skeleton className="h-10 w-full" />
                        </div>
                    </CardContent>
                </Card>
            )}
        </div>
    );
}

function BookingDetailsPage() {
    const router = useRouter();
    const { t } = useLanguage();

    const handleBack = () => {
        router.back();
    };

    return (
        <div className="flex min-h-screen w-full flex-col bg-background font-body">
            <header className="flex items-center p-4 border-b">
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleBack}>
                    <ArrowLeft className="h-5 w-5" />
                    <span className="sr-only">Back</span>
                </Button>
                <h1 className="text-xl font-bold text-center flex-grow">{t.bookAppointment.patientDetails}</h1>
                <div className="w-8"></div>
            </header>
            <main className="flex-grow overflow-y-auto p-4 md:p-6 space-y-6">
                <Suspense fallback={<Loader2 className="animate-spin" />}>
                    <AppointmentDetailsContent />
                </Suspense>
            </main>
        </div>
    );
}

function BookingDetailsPageWithAuth() {
    return (
        <AuthGuard>
            <BookingDetailsPage />
        </AuthGuard>
    );
}

export default BookingDetailsPageWithAuth;
