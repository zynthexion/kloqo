'use client';

import Link from 'next/link';
import { useEffect, useState, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Home, Calendar, Radio, User, Loader2, Ticket, Users, Clock, Star } from 'lucide-react';
import { cn, getArriveByTime, getArriveByTimeFromAppointment, getDisplayTimeFromAppointment } from '@/lib/utils';
import { useDoctors } from '@/firebase/firestore/use-doctors';
import { usePathname } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useUser } from '@/firebase/auth/use-user';
import { useAppointments } from '@/firebase/firestore/use-appointments';
import { mutate } from 'swr';
import { format, parse, isToday, isPast, addMinutes, isAfter, differenceInMilliseconds } from 'date-fns';
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useLanguage } from '@/contexts/language-context';
import { useMasterDepartments } from '@/hooks/use-master-departments';
import { getLocalizedDepartmentName } from '@/lib/department-utils';
import { formatDayOfWeek, formatDate } from '@/lib/date-utils';
import { Skeleton } from '@/components/ui/skeleton';
import { AppointmentCardSkeleton } from '@/components/ui/skeletons';
import { AuthGuard } from '@/components/auth-guard';
import { LottieAnimation } from '@/components/lottie-animation';
import emptyStateAnimation from '@/lib/animations/empty-state.json';
import { useFirestore } from '@/firebase';
import { doc, updateDoc, getDoc } from 'firebase/firestore';

// Prevent static generation - this page requires Firebase context
export const dynamic = 'force-dynamic';
import { useToast } from '@/hooks/use-toast';
import { errorEmitter } from '@/firebase/error-emitter';
import { FirestorePermissionError } from '@/firebase/errors';
import type { Appointment, Doctor } from '@/lib/types';
import { sendAppointmentCancelledNotification } from '@/lib/notification-service';
import nextDynamic from 'next/dynamic';
import { previewWalkInPlacement, compareAppointments, getClinicNow, getClinicDateString } from '@kloqo/shared-core';
import { isSameDay } from 'date-fns';

const ReviewPrompt = nextDynamic(
    () => import('@/components/review-prompt').then(mod => mod.ReviewPrompt),
    {
        ssr: false,
        loading: () => (
            <div className="fixed inset-0 bg-black/30 backdrop-blur-sm z-50 flex items-center justify-center">
                <div className="bg-white rounded-2xl shadow-lg p-8 text-center space-y-3">
                    <Skeleton className="h-10 w-10 rounded-full mx-auto" />
                    <Skeleton className="h-4 w-32 mx-auto" />
                </div>
            </div>
        ),
    }
);

const BottomNav = nextDynamic(
    () => import('@/components/bottom-nav').then(mod => mod.BottomNav),
    {
        ssr: false,
        loading: () => <div className="h-16" aria-hidden="true" />,
    }
);



const AppointmentCard = ({ appointment, isHistory = false, user, t, departments, language, onAppointmentCancelled, appointmentsCacheKey, doctor }: { appointment: Appointment, isHistory?: boolean, user: any, t: any, departments: any[], language: 'en' | 'ml', onAppointmentCancelled?: (appointmentId: string) => void, appointmentsCacheKey?: string | null, doctor?: Doctor | null }) => {
    const firestore = useFirestore();
    const { toast } = useToast();
    const router = useRouter();
    const [isCancelling, setIsCancelling] = useState(false);
    const [showReview, setShowReview] = useState(false);

    let day, month, dayOfMonth;
    let dateObj: Date;
    try {
        dateObj = parse(appointment.date, "d MMMM yyyy", new Date());
        day = formatDayOfWeek(dateObj, language);
        month = formatDate(dateObj, 'MMM', language);
        dayOfMonth = format(dateObj, 'dd');
    } catch (e) {
        // fallback for different date formats
        try {
            dateObj = new Date(appointment.date);
            day = formatDayOfWeek(dateObj, language);
            month = formatDate(dateObj, 'MMM', language);
            dayOfMonth = format(dateObj, 'dd');
        } catch {
            dateObj = new Date(appointment.date);
            const parts = appointment.date.split(' ');
            month = parts[0];
            dayOfMonth = parts[1];
            day = formatDayOfWeek(dateObj, language);
        }
    }


    const isUpcoming = !isPast(dateObj) || isToday(dateObj);
    const cardColor = isUpcoming ? 'bg-blue-50' : 'bg-gray-50';

    const handleCancelAppointment = async () => {
        if (!firestore) {
            toast({
                variant: 'destructive',
                title: t.appointments.error,
                description: t.appointments.databaseError,
            });
            return;
        }
        setIsCancelling(true);
        const appointmentRef = doc(firestore, 'appointments', appointment.id);
        const updateData = { status: 'Cancelled' };

        // 1. Optimistic UI Update: Update localStorage cache immediately
        if (appointmentsCacheKey && typeof window !== 'undefined') {
            try {
                const cached = localStorage.getItem(appointmentsCacheKey);
                if (cached) {
                    const parsed = JSON.parse(cached) as { data?: Appointment[] };
                    if (Array.isArray(parsed.data)) {
                        const updatedAppointments = parsed.data.map((apt: Appointment) =>
                            apt.id === appointment.id ? { ...apt, status: 'Cancelled' as const } : apt
                        );
                        localStorage.setItem(
                            appointmentsCacheKey,
                            JSON.stringify({
                                data: updatedAppointments,
                                timestamp: new Date().toISOString(),
                            })
                        );
                        // Notify parent component to update cached appointments state
                        if (onAppointmentCancelled) {
                            onAppointmentCancelled(appointment.id);
                        }
                    }
                }
            } catch (error) {
                console.warn('Failed to optimistically update cache:', error);
            }
        }

        // 2. Optimistically update SWR cache immediately for instant UI update
        if (user?.patientId) {
            const swrKey = `/api/appointments?patientId=${encodeURIComponent(user.patientId)}`;
            // Optimistically update SWR cache with cancelled status (synchronous for instant update)
            mutate(swrKey, (current: { appointments: Appointment[] } | undefined) => {
                if (!current || !current.appointments) return current;
                return {
                    appointments: current.appointments.map((apt: Appointment) =>
                        apt.id === appointment.id ? { ...apt, status: 'Cancelled' as const } : apt
                    ),
                };
            }, { revalidate: false }); // Update cache immediately without revalidation
        }

        try {
            // 3. Update Firestore
            await updateDoc(appointmentRef, updateData).catch(
                async (serverError) => {
                    const permissionError = new FirestorePermissionError({
                        path: appointmentRef.path,
                        operation: 'update',
                        requestResourceData: updateData,
                    });
                    errorEmitter.emit('permission-error', permissionError);
                    throw permissionError;
                }
            );

            // 4. Send cancellation notification
            if (user?.dbUserId && firestore) {
                try {
                    await sendAppointmentCancelledNotification({
                        firestore,
                        userId: user.dbUserId,
                        appointmentId: appointment.id,
                        doctorName: appointment.doctor,
                        date: appointment.date,
                        time: appointment.time,
                    });
                    console.log('Appointment cancelled notification sent');
                } catch (notifError) {
                    console.error('Failed to send cancellation notification:', notifError);
                    // Don't fail the cancellation if notification fails
                }
            }

            // 5. Revalidate SWR cache after successful Firestore update to sync with server
            if (user?.patientId) {
                const swrKey = `/api/appointments?patientId=${encodeURIComponent(user.patientId)}`;
                mutate(swrKey, undefined, { revalidate: true });
            }

            toast({
                title: t.appointments.appointmentCancelled,
                description: t.appointments.appointmentCancelledDesc,
            });
        } catch (error) {
            console.error('Error cancelling appointment:', error);

            // Rollback optimistic updates on error
            if (user?.patientId) {
                const swrKey = `/api/appointments?patientId=${encodeURIComponent(user.patientId)}`;
                // Revalidate to restore original data from server
                mutate(swrKey, undefined, { revalidate: true });
            }

            if (appointmentsCacheKey && typeof window !== 'undefined' && onAppointmentCancelled) {
                try {
                    const cached = localStorage.getItem(appointmentsCacheKey);
                    if (cached) {
                        const parsed = JSON.parse(cached) as { data?: Appointment[] };
                        if (Array.isArray(parsed.data)) {
                            // Restore original appointment (revert cancelled status)
                            const restoredAppointments = parsed.data.map((apt: Appointment) =>
                                apt.id === appointment.id ? appointment : apt
                            );
                            localStorage.setItem(
                                appointmentsCacheKey,
                                JSON.stringify({
                                    data: restoredAppointments,
                                    timestamp: new Date().toISOString(),
                                })
                            );
                            onAppointmentCancelled(appointment.id);
                        }
                    }
                } catch (rollbackError) {
                    console.warn('Failed to rollback optimistic update:', rollbackError);
                }
            }

            if (!(error instanceof FirestorePermissionError)) {
                toast({
                    variant: 'destructive',
                    title: t.appointments.cancellationFailed,
                    description: t.appointments.cancellationFailedDesc,
                });
            }
        } finally {
            setIsCancelling(false);
        }
    };

    const handleRescheduleAppointment = () => {
        // Navigate to book appointment page in edit mode
        console.log('Reschedule appointment data:', appointment);

        if (appointment.doctorId && appointment.clinicId && appointment.patientId) {
            // Navigate to book appointment with edit mode enabled, including patientId
            router.push(`/book-appointment?doctorId=${appointment.doctorId}&clinicId=${appointment.clinicId}&patientId=${appointment.patientId}&edit=true&appointmentId=${appointment.id}`);
        } else if (appointment.doctorId && appointment.patientId) {
            router.push(`/book-appointment?doctorId=${appointment.doctorId}&patientId=${appointment.patientId}&edit=true&appointmentId=${appointment.id}`);
        } else if (appointment.clinicId) {
            // If no doctorId, navigate to select doctor at clinic
            router.push(`/clinics?clinicId=${appointment.clinicId}`);
        } else {
            toast({
                variant: 'destructive',
                title: t.appointments.error,
                description: t.appointments.rescheduleError,
            });
        }
    };

    return (
        <Card className={cn("shadow-md", cardColor)}>
            <CardContent className="p-4">
                <div className="flex justify-between items-start">
                    <div className="flex gap-4">
                        <div className="text-center w-12 shrink-0">
                            <p className="text-sm">{month}</p>
                            <p className="text-2xl font-bold">{dayOfMonth}</p>
                            <p className="text-sm">{day}</p>
                        </div>
                        <div className="border-l pl-4">
                            {(() => {
                                const isWalkIn = appointment.tokenNumber?.startsWith('W') || appointment.bookedVia === 'Walk-in';
                                return (
                                    <>
                                        {!isHistory && !isWalkIn && <p className="text-xs text-muted-foreground">{t.home.arriveBy}</p>}
                                        <p className="font-semibold">
                                            {getArriveByTimeFromAppointment(appointment, doctor)}
                                        </p>
                                    </>
                                );
                            })()}
                            {appointment.delay && appointment.delay > 0 && (
                                <p className="text-xs text-orange-600 dark:text-orange-400 mt-1">
                                    ⏱️ Delayed by {appointment.delay} min
                                </p>
                            )}
                            <p className="font-bold text-lg mt-2">{appointment.doctor}</p>
                            <p className="text-sm text-muted-foreground">{getLocalizedDepartmentName(appointment.department, language, departments)}</p>
                            <p className="text-sm text-muted-foreground mt-1">{t.appointments.token}: <span className="font-semibold">{appointment.tokenNumber}</span></p>
                        </div>
                    </div>
                    <div className="flex flex-col items-end gap-2">
                        <p className="text-sm font-semibold">{appointment.patientName}</p>
                        <span className={cn(
                            "px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider",
                            appointment.status === 'Confirmed' ? "bg-green-100 text-green-800" :
                                appointment.status === 'Pending' ? "bg-yellow-100 text-yellow-800" :
                                    appointment.status === 'Completed' ? "bg-blue-100 text-blue-800" :
                                        appointment.status === 'Cancelled' ? (appointment.isRescheduled ? "bg-orange-100 text-orange-800" : "bg-red-100 text-red-800") :
                                            "bg-gray-100 text-gray-800"
                        )}>
                            {appointment.status === 'Confirmed' ? t.appointments.confirmed :
                                appointment.status === 'Pending' ? t.appointments.pending :
                                    appointment.status === 'Completed' ? t.appointments.completed :
                                        appointment.status === 'Cancelled' ? (appointment.isRescheduled ? t.appointments.rescheduled : t.appointments.cancelled) :
                                            appointment.status}
                        </span>
                    </div>
                </div>
                {!isHistory && appointment.status !== 'Cancelled' && (
                    <div className="flex justify-end gap-2 mt-4">
                        <AlertDialog>
                            <AlertDialogTrigger asChild>
                                <Button variant="ghost" className="rounded-full text-blue-600" disabled={isCancelling}>
                                    {isCancelling ? <Loader2 className="h-4 w-4 animate-spin" /> : t.appointments.cancel}
                                </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                                <AlertDialogHeader>
                                    <AlertDialogTitle>{t.appointments.areYouSure}</AlertDialogTitle>
                                    <AlertDialogDescription>
                                        {t.appointments.cancelConfirmDesc}
                                    </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                    <AlertDialogCancel>{t.appointments.back}</AlertDialogCancel>
                                    <AlertDialogAction onClick={handleCancelAppointment} className="bg-destructive hover:bg-destructive/90">
                                        {t.appointments.yesCancel}
                                    </AlertDialogAction>
                                </AlertDialogFooter>
                            </AlertDialogContent>
                        </AlertDialog>
                        {!appointment.tokenNumber?.startsWith('W') && appointment.status !== 'Confirmed' && (
                            <Button
                                variant="ghost"
                                className="rounded-full text-green-600"
                                onClick={handleRescheduleAppointment}
                            >
                                {t.appointments.reschedule}
                            </Button>
                        )}
                    </div>
                )}
                {appointment.status === 'Completed' && !appointment.reviewed && (
                    <div className="flex justify-end gap-2 mt-4">
                        <Button
                            variant="outline"
                            className="rounded-full text-yellow-600 border-yellow-600 hover:bg-yellow-50"
                            onClick={() => setShowReview(true)}
                        >
                            <Star className="h-4 w-4 mr-2" />
                            {t.appointments.reviewDoctor || 'Review Doctor'}
                        </Button>
                    </div>
                )}
                {showReview && (
                    <ReviewPrompt
                        appointment={appointment}
                        onClose={() => setShowReview(false)}
                    />
                )}
            </CardContent>
        </Card>
    )
}


function AppointmentsPage() {
    const pathname = usePathname();
    const { user, loading: userLoading } = useUser();
    const { t, language } = useLanguage();
    const { departments } = useMasterDepartments();
    const router = useRouter();
    const firestore = useFirestore();
    const { toast } = useToast();
    const [isPreviewingWalkIn, setIsPreviewingWalkIn] = useState(false);
    const [cachedAppointments, setCachedAppointments] = useState<Appointment[]>([]);
    const isWalkInDebugEnabled = process.env.NEXT_PUBLIC_DEBUG_WALK_IN === 'true';

    const { appointments, loading: appointmentsLoading } = useAppointments(user?.patientId);
    const { doctors, loading: doctorsLoading } = useDoctors();
    const appointmentsCacheKey = user?.patientId ? `appointments-cache-${user.patientId}` : null;

    // Create a map of doctors by name for quick lookup
    const doctorsByName = useMemo(() => {
        const map = new Map<string, Doctor>();
        doctors.forEach(doctor => {
            map.set(doctor.name, doctor);
        });
        return map;
    }, [doctors]);

    useEffect(() => {
        if (!appointmentsCacheKey || typeof window === 'undefined') return;
        try {
            const cached = localStorage.getItem(appointmentsCacheKey);
            if (cached) {
                const parsed = JSON.parse(cached) as { data?: Appointment[] };
                if (Array.isArray(parsed.data)) {
                    setCachedAppointments(parsed.data);
                }
            }
        } catch (error) {
            console.warn('Failed to read cached appointments', error);
            localStorage.removeItem(appointmentsCacheKey);
        }
    }, [appointmentsCacheKey]);

    useEffect(() => {
        if (!appointmentsCacheKey || typeof window === 'undefined' || appointments.length === 0) return;
        try {
            localStorage.setItem(
                appointmentsCacheKey,
                JSON.stringify({
                    data: appointments,
                    timestamp: new Date().toISOString(),
                })
            );
            setCachedAppointments(appointments);
        } catch (error) {
            console.warn('Failed to cache appointments', error);
        }
    }, [appointmentsCacheKey, appointments]);

    // Callback to optimistically update cached appointments when cancelled
    // This ensures the appointment disappears immediately from the UI
    const handleAppointmentCancelled = useCallback((appointmentId: string) => {
        // Update cached appointments state optimistically
        setCachedAppointments(prev =>
            prev.map(apt =>
                apt.id === appointmentId
                    ? { ...apt, status: 'Cancelled' as const }
                    : apt
            )
        );
    }, []);

    const effectiveAppointments = useMemo(() => {
        const source = appointments.length > 0 ? appointments : cachedAppointments;
        // Hide break-affected appointments (field present as true or false)
        return source.filter(a => a.cancelledByBreak === undefined);
    }, [appointments, cachedAppointments]);

    const isAppointmentForToday = (dateStr: string) => {
        const now = getClinicNow();
        try {
            const appointmentDate = parse(dateStr, "d MMMM yyyy", new Date());
            return isSameDay(appointmentDate, now);
        } catch {
            return isSameDay(new Date(dateStr), now);
        }
    };

    const walkInAppointment = effectiveAppointments.find(
        a => a.tokenNumber?.startsWith('W') &&
            isAppointmentForToday(a.date) &&
            a.status !== 'Cancelled' &&
            a.status !== 'Completed'
    );

    const parseAppointmentDateTime = (appointment: Appointment) => {
        try {
            if (appointment.time) {
                return parse(`${appointment.date} ${appointment.time}`, "d MMMM yyyy hh:mm a", new Date());
            }
            return parse(appointment.date, "d MMMM yyyy", new Date());
        } catch {
            try {
                return appointment.time ? new Date(`${appointment.date} ${appointment.time}`) : new Date(appointment.date);
            } catch {
                return new Date(0);
            }
        }
    };

    const upcomingAppointments = effectiveAppointments
        .filter(a => a.status === 'Pending' || a.status === 'Skipped' || a.status === 'Confirmed')
        .slice()
        .sort(compareAppointments);


    const pastAppointments = effectiveAppointments.filter(a => {
        if (a.status === 'Completed' || a.status === 'Cancelled' || a.status === 'No-show') {
            return true;
        }
        let date;
        try {
            date = parse(a.date, "d MMMM yyyy", new Date());
        } catch {
            date = new Date(a.date);
        }
        const now = getClinicNow();
        return isPast(date) && !isSameDay(date, now);
    });

    // AuthGuard handles authentication redirects

    // Progressive loading: Show page structure immediately, hydrate with data
    // Only block if we have no user AND no cached appointments
    const shouldBlockRender = userLoading && !user && effectiveAppointments.length === 0;
    const isLoadingData = appointmentsLoading && effectiveAppointments.length === 0;

    const handlePreviewWalkIn = useCallback(async () => {
        if (!isWalkInDebugEnabled) {
            return;
        }

        if (!firestore) {
            toast({
                variant: 'destructive',
                title: t.appointments.error,
                description: 'Firestore is not available for preview.',
            });
            return;
        }

        if (!walkInAppointment) {
            toast({
                variant: 'destructive',
                title: t.appointments.error,
                description: 'No active walk-in token found for preview.',
            });
            return;
        }

        if (!walkInAppointment.clinicId) {
            toast({
                variant: 'destructive',
                title: t.appointments.error,
                description: 'Walk-in appointment is missing clinic information.',
            });
            return;
        }

        try {
            setIsPreviewingWalkIn(true);
            const clinicSnap = await getDoc(doc(firestore, 'clinics', walkInAppointment.clinicId));
            const rawSpacing = clinicSnap.exists() ? Number(clinicSnap.data()?.walkInTokenAllotment ?? 0) : 0;
            const walkInSpacingValue = Number.isFinite(rawSpacing) ? Math.max(0, Math.floor(rawSpacing)) : 0;
            const appointmentDate = parse(walkInAppointment.date, 'd MMMM yyyy', new Date());

            const preview = await previewWalkInPlacement(
                firestore,
                walkInAppointment.clinicId,
                walkInAppointment.doctor,
                appointmentDate,
                walkInSpacingValue,
                walkInAppointment.doctorId
            );

            console.group(`[walk-in preview] ${walkInAppointment.tokenNumber ?? walkInAppointment.id}`);
            if (preview.placeholderAssignment) {
                console.info('Next walk-in target', {
                    slotIndex: preview.placeholderAssignment.slotIndex,
                    time: format(preview.placeholderAssignment.slotTime, 'hh:mm a'),
                });
            } else {
                console.warn('No placement available for the next walk-in token.');
            }

            if (preview.advanceShifts.length === 0) {
                console.info('No advance appointments need to move.');
            } else {
                preview.advanceShifts.forEach(shift => {
                    console.info('Advance shift', {
                        appointmentId: shift.id,
                        tokenNumber: shift.tokenNumber,
                        fromSlot: shift.fromSlot,
                        toSlot: shift.toSlot,
                        fromTime: shift.fromTime ? format(shift.fromTime, 'hh:mm a') : null,
                        toTime: format(shift.toTime, 'hh:mm a'),
                    });
                });
            }

            preview.walkInAssignments.forEach(assignment => {
                console.info('Walk-in assignment', {
                    id: assignment.id,
                    slotIndex: assignment.slotIndex,
                    time: format(assignment.slotTime, 'hh:mm a'),
                });
            });
            console.groupEnd();

            toast({
                title: 'Walk-in preview ready',
                description: 'Check the browser console for placement details.',
            });
        } catch (error) {
            console.error('[walk-in preview] failed', error);
            toast({
                variant: 'destructive',
                title: 'Unable to preview walk-in placement.',
                description: (error as Error)?.message ?? 'See console for details.',
            });
        } finally {
            setIsPreviewingWalkIn(false);
        }
    }, [firestore, isWalkInDebugEnabled, toast, t.appointments, walkInAppointment]);

    // Only block if we have absolutely no data to show (no user AND no cache)
    if (shouldBlockRender) {
        return (
            <div className="flex h-screen w-full flex-col items-center justify-center bg-background">
                <div className="flex flex-col items-center gap-4">
                    <Skeleton className="h-12 w-12 rounded-full" />
                    <Skeleton className="h-4 w-32" />
                </div>
            </div>
        );
    }

    // Render page structure immediately - hydrate with data progressively
    return (
        <div className="flex min-h-screen w-full flex-col bg-green-50/50 font-body">
            <header className="flex items-center p-4">
                <Link href="/home" className="p-2">
                    <ArrowLeft className="h-6 w-6" />
                </Link>
                <h1 className="text-xl font-bold text-center flex-grow">{t.appointments.myAppointments}</h1>
                <div className="w-8"></div>
            </header>

            {isWalkInDebugEnabled && (
                <div className="px-4">
                    <Button
                        variant="outline"
                        size="sm"
                        className="rounded-full"
                        onClick={handlePreviewWalkIn}
                        disabled={isPreviewingWalkIn}
                    >
                        {isPreviewingWalkIn ? (
                            <span className="flex items-center gap-2">
                                <Loader2 className="h-4 w-4 animate-spin" />
                                Previewing...
                            </span>
                        ) : (
                            'Preview Walk-in Placement'
                        )}
                    </Button>
                </div>
            )}

            <main className="flex-grow p-4 pb-32 space-y-6">
                <Tabs defaultValue="upcoming">
                    <TabsList className="grid w-full grid-cols-2 bg-transparent p-0">
                        <TabsTrigger value="upcoming" className="data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:text-primary rounded-none">{t.appointments.upcoming}</TabsTrigger>
                        <TabsTrigger value="history" className="data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:text-primary rounded-none">{t.appointments.history}</TabsTrigger>
                    </TabsList>
                    <TabsContent value="upcoming" className="space-y-4 pt-4">
                        {isLoadingData && effectiveAppointments.length === 0 ? (
                            // Show skeleton cards while loading (only if no cached data)
                            <div className="space-y-4">
                                {[1, 2, 3].map((i) => (
                                    <AppointmentCardSkeleton key={i} />
                                ))}
                            </div>
                        ) : upcomingAppointments.length > 0 ? (
                            upcomingAppointments.map((appt) => {
                                const appointmentDoctor = doctorsByName.get(appt.doctor);
                                return <AppointmentCard key={appt.id} appointment={appt} user={user!} t={t} departments={departments} language={language} onAppointmentCancelled={handleAppointmentCancelled} appointmentsCacheKey={appointmentsCacheKey} doctor={appointmentDoctor} />;
                            })
                        ) : (
                            <div className="flex flex-col items-center justify-center py-12">
                                <LottieAnimation
                                    animationData={emptyStateAnimation}
                                    size={250}
                                    autoplay={true}
                                    loop={true}
                                    className="mb-4"
                                />
                                <p className="text-center text-muted-foreground pt-4 text-lg font-semibold">{t.appointments.noUpcoming}</p>
                            </div>
                        )}
                    </TabsContent>
                    <TabsContent value="history" className="space-y-4 pt-4">
                        {isLoadingData && effectiveAppointments.length === 0 ? (
                            // Show skeleton cards while loading (only if no cached data)
                            <div className="space-y-4">
                                {[1, 2, 3].map((i) => (
                                    <AppointmentCardSkeleton key={i} />
                                ))}
                            </div>
                        ) : pastAppointments.length > 0 ? (
                            pastAppointments.map((appt) => {
                                const appointmentDoctor = doctorsByName.get(appt.doctor);
                                return <AppointmentCard key={appt.id} appointment={appt} isHistory={true} user={user!} t={t} departments={departments} language={language} onAppointmentCancelled={handleAppointmentCancelled} appointmentsCacheKey={appointmentsCacheKey} doctor={appointmentDoctor} />;
                            })
                        ) : (
                            <div className="flex flex-col items-center justify-center py-12">
                                <LottieAnimation
                                    animationData={emptyStateAnimation}
                                    size={250}
                                    autoplay={true}
                                    loop={true}
                                    className="mb-4"
                                />
                                <p className="text-center text-muted-foreground pt-4 text-lg font-semibold">{t.appointments.noPast}</p>
                            </div>
                        )}
                    </TabsContent>
                </Tabs>
            </main>

            <div className="sticky bottom-24 w-full max-w-md mx-auto p-4 bg-transparent">
                <Button className="w-full h-12 text-base font-bold bg-primary text-primary-foreground hover:bg-primary/90" asChild>
                    <Link href="/clinics">{t.appointments.bookNew}</Link>
                </Button>
            </div>

            <BottomNav />
        </div>
    )
}

function AppointmentsPageWithAuth() {
    return (
        <AuthGuard>
            <AppointmentsPage />
        </AuthGuard>
    );
}

export default AppointmentsPageWithAuth;
