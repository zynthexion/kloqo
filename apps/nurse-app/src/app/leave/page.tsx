'use client';

import { useState, useMemo, useEffect, useCallback } from 'react';
import { Suspense } from 'react';
import { Button } from '@/components/ui/button';
import { ArrowLeft, Loader2, CalendarIcon, Check, Trash2, AlertTriangle } from 'lucide-react';
import { format, addMinutes, differenceInMinutes, startOfDay, parseISO, eachMinuteOfInterval, isWithinInterval } from 'date-fns';
import { cn } from '@/lib/utils';
import Link from 'next/link';
import type { Appointment, Doctor } from '@/lib/types';
import { useRouter, useSearchParams } from 'next/navigation';
import { collection, getDocs, query, where, doc, writeBatch, updateDoc, arrayUnion, arrayRemove, onSnapshot, getDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import AppFrameLayout from '@/components/layout/app-frame';
import { parseTime, formatTime12Hour, parseAppointmentDateTime } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import { errorEmitter, FirestorePermissionError } from '@kloqo/shared-core';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { Card, CardContent } from '@/components/ui/card';

type TimeSession = { from: string; to: string; };

function MarkLeaveContent() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const { toast } = useToast();

    const doctorIdFromParams = searchParams.get('doctor');

    const [selectedDate, setSelectedDate] = useState<Date>(new Date());
    const [selectedSessions, setSelectedSessions] = useState<TimeSession[]>([]);
    const [doctor, setDoctor] = useState<Doctor | null>(null);
    const [appointments, setAppointments] = useState<Appointment[]>([]);
    const [loading, setLoading] = useState(true);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [clinicId, setClinicId] = useState<string | null>(null);

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
        const fetchDoctor = async () => {
            const doctorId = doctorIdFromParams || localStorage.getItem('selectedDoctorId');

            if (!doctorId) {
                setLoading(false);
                toast({ variant: 'destructive', title: 'Error', description: 'No doctor selected.' });
                return;
            }
            setLoading(true);
            try {
                const docRef = doc(db, "doctors", doctorId);
                const docSnap = await getDoc(docRef);

                if (docSnap.exists() && docSnap.data().clinicId === clinicId) {
                    const currentDoctor = { id: docSnap.id, ...docSnap.data() } as Doctor;
                    setDoctor(currentDoctor);

                } else {
                    setDoctor(null);
                    toast({ variant: 'destructive', title: 'Error', description: 'Doctor not found.' });
                }
            } catch (error) {
                console.error("Error fetching doctor:", error);
                toast({ variant: 'destructive', title: 'Error', description: 'Could not fetch doctor data.' });
            } finally {
                setLoading(false);
            }
        };
        fetchDoctor();
    }, [doctorIdFromParams, clinicId, toast]);

    useEffect(() => {
        if (!doctor) return;

        const dateStr = format(selectedDate, 'd MMMM yyyy');
        const appointmentsQuery = query(collection(db, "appointments"),
            where("doctor", "==", doctor.name),
            where("clinicId", "==", clinicId),
            where("date", "==", dateStr)
        );

        const unsubscribe = onSnapshot(appointmentsQuery, (snapshot) => {
            const fetchedAppointments = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() as Omit<Appointment, 'id'> }));
            setAppointments(fetchedAppointments);
        }, (error) => {
            console.error("Error fetching appointments:", error);
            toast({ variant: 'destructive', title: 'Error', description: 'Could not fetch appointments.' });
        });

        return () => unsubscribe();
    }, [doctor, selectedDate, clinicId, toast]);


    const dailyLeaveSlots = useMemo(() => {
        if (!doctor?.leaveSlots) return [];
        return doctor.leaveSlots
            .map(isoString => parseISO(isoString))
            .filter(date => format(date, 'yyyy-MM-dd') === format(selectedDate, 'yyyy-MM-dd'))
            .map(date => date.getTime());
    }, [doctor, selectedDate]);

    const workSessionsForDay = useMemo((): TimeSession[] => {
        if (!doctor) return [];
        const dayOfWeek = format(selectedDate, 'EEEE');
        const doctorAvailabilityForDay = (doctor.availabilitySlots || []).find(slot => slot.day === dayOfWeek);
        return doctorAvailabilityForDay?.timeSlots || [];
    }, [doctor, selectedDate]);

    const getAppointmentsInSession = (session: TimeSession) => {
        const start = parseTime(session.from, selectedDate);
        const end = parseTime(session.to, selectedDate);
        return appointments.filter(appt => {
            const apptTime = parseAppointmentDateTime(appt.date, appt.time);
            return isWithinInterval(apptTime, { start, end }) && appt.status === 'Pending';
        });
    };

    const isSessionOnLeave = useCallback((session: TimeSession) => {
        if (!doctor || dailyLeaveSlots.length === 0) return false;

        const start = parseTime(session.from, selectedDate);
        const end = parseTime(session.to, selectedDate);
        const intervalSlots = eachMinuteOfInterval({ start, end }, { step: doctor.averageConsultingTime || 15 });

        return intervalSlots.every(slot => dailyLeaveSlots.includes(slot.getTime()));
    }, [dailyLeaveSlots, doctor, selectedDate]);


    const handleSessionClick = (session: TimeSession) => {
        setSelectedSessions(prev => {
            const alreadySelected = prev.some(s => s.from === session.from && s.to === session.to);
            if (alreadySelected) {
                return prev.filter(s => s.from !== session.from || s.to !== session.to);
            }
            return [...prev, session];
        });
    };

    const getSlotsFromSessions = (sessions: TimeSession[]): string[] => {
        if (!doctor) return [];
        const allSlots: string[] = [];
        sessions.forEach(session => {
            const start = parseTime(session.from, selectedDate);
            const end = parseTime(session.to, selectedDate);
            const intervalSlots = eachMinuteOfInterval({ start, end }, { step: doctor.averageConsultingTime || 15 });
            allSlots.push(...intervalSlots.map(s => s.toISOString()));
        });
        return allSlots;
    }

    const handleConfirmLeave = async () => {
        if (selectedSessions.length === 0 || !doctor || !clinicId) {
            toast({ variant: 'destructive', title: 'No Sessions Selected', description: 'Please select one or more sessions to mark as leave.' });
            return;
        }
        setIsSubmitting(true);
        try {
            const batch = writeBatch(db);
            const doctorRef = doc(db, 'doctors', doctor.id);

            const sessionsToMark = selectedSessions.filter(s => !isSessionOnLeave(s));
            const slotsToMark = getSlotsFromSessions(sessionsToMark);

            sessionsToMark.forEach(session => {
                const appointmentsToCancel = getAppointmentsInSession(session);
                appointmentsToCancel.forEach(appt => {
                    const apptRef = doc(db, 'appointments', appt.id);
                    batch.update(apptRef, { status: 'Cancelled', cancellationReason: 'DOCTOR_LEAVE' });
                });
            });

            if (slotsToMark.length > 0) {
                batch.update(doctorRef, {
                    leaveSlots: arrayUnion(...slotsToMark)
                });
            }

            await batch.commit();

            toast({
                title: 'Leave Marked Successfully',
                description: `${sessionsToMark.length} session(s) have been marked as leave and appointments cancelled.`,
            });

            setDoctor(prev => prev ? ({ ...prev, leaveSlots: [...(prev.leaveSlots || []), ...slotsToMark] }) : null);
            setSelectedSessions([]);

        } catch (error) {
            console.error("Error marking leave:", error);
            toast({ variant: 'destructive', title: 'Error', description: 'Failed to mark leave.' });
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleCancelLeave = async () => {
        if (selectedSessions.length === 0 || !doctor || !clinicId) {
            toast({ variant: 'destructive', title: 'No Sessions Selected', description: 'Please select one or more leave sessions to cancel.' });
            return;
        }

        setIsSubmitting(true);
        try {
            const batch = writeBatch(db);
            const doctorRef = doc(db, 'doctors', doctor.id);

            const sessionsToCancel = selectedSessions.filter(s => isSessionOnLeave(s));
            const slotsToCancel = getSlotsFromSessions(sessionsToCancel);

            const allCancelledAppointmentsQuery = query(collection(db, "appointments"),
                where('doctor', '==', doctor.name),
                where('clinicId', '==', clinicId),
                where('date', '==', format(selectedDate, 'd MMMM yyyy')),
                where('status', '==', 'Cancelled'),
                where('cancellationReason', '==', 'DOCTOR_LEAVE')
            );

            const cancelledSnapshot = await getDocs(allCancelledAppointmentsQuery);
            const appointmentsToRestore = cancelledSnapshot.docs.filter(docSnap => {
                const appt = docSnap.data();
                const apptTime = parseAppointmentDateTime(appt.date, appt.time).getTime();
                return slotsToCancel.some(slotISO => parseISO(slotISO).getTime() === apptTime);
            });

            appointmentsToRestore.forEach(docSnap => {
                batch.update(docSnap.ref, { status: 'Pending', cancellationReason: null });
            });

            if (slotsToCancel.length > 0) {
                batch.update(doctorRef, {
                    leaveSlots: arrayRemove(...slotsToCancel)
                });
            }

            await batch.commit();

            toast({
                title: 'Leave Canceled',
                description: `${sessionsToCancel.length} leave session(s) have been canceled and appointments restored.`,
            });

            const newLeaveSlots = (doctor.leaveSlots || []).filter(iso => !slotsToCancel.includes(iso));
            setDoctor(prev => prev ? ({ ...prev, leaveSlots: newLeaveSlots }) : null);
            setSelectedSessions([]);
        } catch (error) {
            console.error("Error canceling leave:", error);
            toast({ variant: 'destructive', title: 'Error', description: 'Failed to cancel leave.' });
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleDateSelect = (date: Date | undefined) => {
        if (date) {
            setSelectedDate(date);
            setSelectedSessions([]);
        }
    };

    const isDayAvailable = useCallback((date: Date): boolean => {
        if (!doctor) return false;
        const dayOfWeek = format(date, 'EEEE');
        const availableWorkDays = (doctor.availabilitySlots || []).map(s => s.day);
        return availableWorkDays.includes(dayOfWeek);
    }, [doctor]);


    if (loading) {
        return (
            <AppFrameLayout>
                <div className="w-full h-full flex flex-col items-center justify-center">
                    <Loader2 className="h-12 w-12 animate-spin text-primary" />
                    <p className="mt-4 text-muted-foreground">Loading Schedule...</p>
                </div>
            </AppFrameLayout>
        );
    }

    if (!doctor) {
        return (
            <AppFrameLayout>
                <div className="w-full h-full flex flex-col items-center justify-center text-center p-8">
                    <h2 className="text-xl font-semibold">Doctor not found</h2>
                    <Link href="/settings" passHref className="mt-6">
                        <Button>
                            <ArrowLeft className="mr-2" />
                            Back to Settings
                        </Button>
                    </Link>
                </div>
            </AppFrameLayout>
        );
    }

    const sessionsToCancel = selectedSessions.filter(s => isSessionOnLeave(s)).length;
    const sessionsToMark = selectedSessions.filter(s => !isSessionOnLeave(s)).length;

    return (
        <AppFrameLayout>
            <div className="flex flex-col h-full">
                <header className="flex items-center gap-4 p-4 border-b">
                    <Link href="/settings">
                        <Button variant="ghost" size="icon">
                            <ArrowLeft />
                        </Button>
                    </Link>
                    <div>
                        <h1 className="text-xl font-bold">Mark Leave</h1>
                        <p className="text-sm text-muted-foreground">For Dr. {doctor.name}</p>
                    </div>
                </header>
                <div className="p-6 overflow-y-auto flex-1">
                    <section className="mb-6">
                        <h2 className="text-lg font-semibold mb-2">Select Date</h2>
                        <Popover>
                            <PopoverTrigger asChild>
                                <button className={cn("w-full text-left p-4 rounded-xl bg-muted/50 border", !selectedDate && "text-muted-foreground")}>
                                    <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-4">
                                            <div className="text-center">
                                                <p className="text-4xl font-bold text-destructive/80">{format(selectedDate, 'dd')}</p>
                                                <p className="text-sm font-semibold">{format(selectedDate, 'MMM')}</p>
                                            </div>
                                            <div>
                                                <p className="font-semibold">{format(selectedDate, 'EEEE, yyyy')}</p>
                                                <p className="text-sm text-muted-foreground">
                                                    Select a date to see the schedule
                                                </p>
                                            </div>
                                        </div>
                                        <CalendarIcon className="h-6 w-6 opacity-50 text-destructive" />
                                    </div>
                                </button>
                            </PopoverTrigger>
                            <PopoverContent className="w-auto p-0" align="start">
                                <Calendar
                                    mode="single"
                                    selected={selectedDate}
                                    onSelect={handleDateSelect}
                                    modifiers={{
                                        available: (date) => isDayAvailable(date)
                                    }}
                                    modifiersClassNames={{
                                        available: 'day-available'
                                    }}
                                    classNames={{
                                        day_selected: 'bg-destructive/80 text-white hover:bg-destructive/90 focus:bg-destructive/90',
                                        day_today: 'bg-transparent text-destructive border border-destructive',
                                    }}
                                    disabled={(date) => {
                                        if (date < startOfDay(new Date())) return true;
                                        return !isDayAvailable(date);
                                    }}
                                    initialFocus
                                />
                            </PopoverContent>
                        </Popover>
                    </section>
                    <section>
                        <h2 className="text-lg font-semibold mb-4">Select Sessions for {format(selectedDate, 'MMMM d')}</h2>
                        <div className="space-y-3">
                            {workSessionsForDay.map((session, index) => {
                                const isSelected = selectedSessions.some(s => s.from === session.from && s.to === session.to);
                                const isOnLeave = isSessionOnLeave(session);
                                const appointmentsInSession = getAppointmentsInSession(session);

                                return (
                                    <Card
                                        key={index}
                                        onClick={() => handleSessionClick(session)}
                                        className={cn("cursor-pointer transition-all",
                                            isSelected && 'ring-2 ring-destructive ring-offset-2',
                                            isOnLeave && !isSelected && 'bg-red-100 border-red-200',
                                            !isSelected && !isOnLeave && 'hover:bg-muted/80'
                                        )}
                                    >
                                        <CardContent className="p-4 flex justify-between items-center">
                                            <div className='flex-1'>
                                                <p className={cn("font-semibold text-lg", isOnLeave && "line-through")}>
                                                    {formatTime12Hour(session.from)} - {formatTime12Hour(session.to)}
                                                </p>
                                                <p className="text-sm text-muted-foreground">
                                                    {isOnLeave ? 'On Leave' : `${appointmentsInSession.length} appointments booked`}
                                                </p>
                                            </div>
                                            {isSelected ? <Check className="h-5 w-5 text-destructive" /> : null}
                                        </CardContent>
                                    </Card>
                                );
                            })}
                        </div>
                        {workSessionsForDay.length === 0 && !loading && (
                            <p className="text-center text-muted-foreground mt-4">No working hours scheduled for this day.</p>
                        )}
                    </section>
                </div>
                <footer className="p-4 border-t mt-auto bg-card sticky bottom-0 space-y-2">
                    <div className="text-center text-xs text-muted-foreground">
                        {selectedSessions.length > 0
                            ? `${selectedSessions.length} session(s) selected.`
                            : 'Select sessions to mark/unmark as leave.'
                        }
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                        <Button variant="outline" className="text-destructive" disabled={isSubmitting || sessionsToCancel === 0} onClick={handleCancelLeave}>
                            {isSubmitting ? <Loader2 className="animate-spin" /> : <> <Trash2 className="mr-2 h-4 w-4" /> Unmark Leave ({sessionsToCancel}) </>}
                        </Button>
                        <Button variant="destructive" disabled={isSubmitting || sessionsToMark === 0} onClick={handleConfirmLeave}>
                            {isSubmitting ? <Loader2 className="animate-spin" /> : <> <AlertTriangle className="mr-2 h-4 w-4" /> Mark Leave ({sessionsToMark}) </>}
                        </Button>
                    </div>
                </footer>
            </div>
        </AppFrameLayout>
    );
}

export default function MarkLeavePage() {
    return (
        <Suspense fallback={<div className="flex h-full w-full items-center justify-center"><Loader2 className="animate-spin h-8 w-8" /></div>}>
            <MarkLeaveContent />
        </Suspense>
    );
}
