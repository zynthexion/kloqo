'use client';

import { useState, useMemo, useEffect, useCallback } from 'react';
import { Suspense } from 'react';
import { Button } from '@/components/ui/button';
import { ArrowLeft, Loader2, CalendarIcon, Clock, X } from 'lucide-react';
import { format, addMinutes, subMinutes, differenceInMinutes, startOfDay, parseISO, isBefore, isPast, parse, isAfter, isSameDay } from 'date-fns';
import { cn } from '@/lib/utils';
import Link from 'next/link';
import type { Appointment, Doctor } from '@/lib/types';
import { useRouter, useSearchParams } from 'next/navigation';
import { collection, getDocs, query, where, doc, getDoc, writeBatch, Timestamp, updateDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import AppFrameLayout from '@/components/layout/app-frame';
import { parseTime } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import { FirestorePermissionError } from '@kloqo/shared-core';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import {
    getCurrentActiveSession,
    getAvailableBreakSlots,
    getSessionBreaks,
    calculateSessionExtension,
    createBreakPeriod,
    mergeAdjacentBreaks,
    validateBreakSlots,
    type SessionInfo,
    type SlotInfo,
    shiftAppointmentsForNewBreak,
    validateBreakOverlapWithNextSession
} from '@kloqo/shared-core';
import type { BreakPeriod } from '@kloqo/shared-types';
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';

function ScheduleBreakContent() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const { toast } = useToast();

    const doctorIdFromParams = searchParams.get('doctor');

    const [selectedDate, setSelectedDate] = useState<Date>(new Date());
    const [breakStartSlot, setBreakStartSlot] = useState<SlotInfo | null>(null);
    const [breakEndSlot, setBreakEndSlot] = useState<SlotInfo | null>(null);
    const [appointments, setAppointments] = useState<Appointment[]>([]);
    const [doctor, setDoctor] = useState<Doctor | null>(null);
    const [loading, setLoading] = useState(true);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [clinicId, setClinicId] = useState<string | null>(null);
    const [showExtensionDialog, setShowExtensionDialog] = useState(false);
    const [pendingBreakData, setPendingBreakData] = useState<{
        startSlot: SlotInfo;
        endSlot: SlotInfo;
        sessionIndex: number;
        sessionStart: Date;
        sessionEnd: Date;
        sessionEffectiveEnd: Date;
    } | null>(null);
    const [extensionOptions, setExtensionOptions] = useState<{ hasOverrun: boolean; minimalExtension: number; fullExtension: number; lastTokenBefore: string; lastTokenAfter: string; originalEnd: string; breakDuration: number } | null>(null);
    const [currentSession, setCurrentSession] = useState<SessionInfo | null>(null);
    const [existingBreaks, setExistingBreaks] = useState<BreakPeriod[]>([]);
    const [availableSlots, setAvailableSlots] = useState<{ currentSessionSlots: SlotInfo[]; upcomingSessionSlots: Map<number, SlotInfo[]> } | null>(null);

    useEffect(() => {
        const id = localStorage.getItem('clinicId');
        if (!id) {
            router.push('/login');
            return;
        }
        setClinicId(id);
    }, [router]);

    // Legacy leave slots for cancel button visibility; derived from breakPeriods when present
    const dailyLeaveSlots = useMemo(() => {
        if (doctor?.breakPeriods) {
            const dateKey = format(selectedDate, 'd MMMM yyyy');
            const breaks = doctor.breakPeriods[dateKey] || [];
            const slots = breaks.flatMap(bp => bp.slots || []);
            return slots
                .map(slot => {
                    try {
                        return parseISO(slot).getTime();
                    } catch {
                        return NaN;
                    }
                })
                .filter(ts => !isNaN(ts));
        }

        if (!doctor?.leaveSlots) return [];
        return doctor.leaveSlots
            .map(leave => {
                if (typeof leave === 'string') {
                    return parseISO(leave);
                }
                if (leave && typeof (leave as any).toDate === 'function') {
                    return (leave as any).toDate();
                }
                if (leave instanceof Date) {
                    return leave;
                }
                return new Date(NaN); // Return invalid date for unknown types
            })
            .filter(date => !isNaN(date.getTime()) && format(date, 'yyyy-MM-dd') === format(selectedDate, 'yyyy-MM-dd'))
            .map(date => date.getTime());
    }, [doctor, selectedDate]);

    // Compute current session, breaks, and available slots
    useEffect(() => {
        if (!doctor) {
            setCurrentSession(null);
            setExistingBreaks([]);
            setAvailableSlots(null);
            setBreakStartSlot(null);
            setBreakEndSlot(null);
            return;
        }

        const now = new Date();
        let session = getCurrentActiveSession(doctor, now, selectedDate);

        if (!session) {
            const dayOfWeek = format(selectedDate, 'EEEE');
            const availabilityForDay = doctor.availabilitySlots?.find(s => s.day === dayOfWeek);
            if (availabilityForDay?.timeSlots?.length) {
                for (let i = 0; i < availabilityForDay.timeSlots.length; i++) {
                    const timeSlot = availabilityForDay.timeSlots[i];
                    const sessionStart = parse(timeSlot.from, 'hh:mm a', selectedDate);
                    const sessionEnd = parse(timeSlot.to, 'hh:mm a', selectedDate);

                    if (isAfter(sessionEnd, now) || i === availabilityForDay.timeSlots.length - 1) {
                        const breaks = getSessionBreaks(doctor, selectedDate, i);
                        const dateKey = format(selectedDate, 'd MMMM yyyy');
                        const storedExtension = doctor.availabilityExtensions?.[dateKey]?.sessions?.find(
                            s => s.sessionIndex === i
                        );

                        let effectiveEnd: Date;
                        let totalBreakMinutes: number;
                        if (storedExtension) {
                            totalBreakMinutes = breaks.reduce((sum: number, bp: BreakPeriod) => sum + bp.duration, 0);
                            // Only extend if user explicitly chose to extend (totalExtendedBy > 0)
                            effectiveEnd = storedExtension.totalExtendedBy > 0
                                ? addMinutes(sessionEnd, storedExtension.totalExtendedBy)
                                : sessionEnd;
                        } else {
                            // No stored extension - don't auto-extend, use original session end
                            totalBreakMinutes = breaks.reduce((sum: number, bp: BreakPeriod) => sum + bp.duration, 0);
                            effectiveEnd = sessionEnd;
                        }

                        session = {
                            sessionIndex: i,
                            session: timeSlot,
                            sessionStart,
                            sessionEnd,
                            breaks,
                            totalBreakMinutes,
                            effectiveEnd,
                            originalEnd: sessionEnd
                        };
                        break;
                    }
                }
            }
        }

        if (session) {
            setCurrentSession(session);
            const breaks = getSessionBreaks(doctor, selectedDate, session.sessionIndex);
            setExistingBreaks(breaks);
            const slots = getAvailableBreakSlots(doctor, now, selectedDate, session);
            setAvailableSlots(slots);
        } else {
            setCurrentSession(null);
            setExistingBreaks([]);
            setAvailableSlots(null);
        }

        setBreakStartSlot(null);
        setBreakEndSlot(null);
    }, [doctor, selectedDate]);

    const canCancelBreak = useMemo(() => {
        return true;
    }, []);

    const [cancelPrompt, setCancelPrompt] = useState<{ slots: number[]; breakPeriod: BreakPeriod } | null>(null);

    const performBreakCancellation = useCallback((breakSlotsToCancel: number[], breakToRemove?: BreakPeriod) => {
        if (!doctor || !clinicId || breakSlotsToCancel.length === 0 || !breakToRemove) {
            return;
        }

        // Safety guard: do not allow manual cancellation once break has started
        const breakStart = new Date(Math.min(...breakSlotsToCancel));
        // ... (existing date checks are fine, but ensure breakToRemove is used)
        const now = new Date();
        if (now >= breakStart) {
            toast({
                variant: 'destructive',
                title: 'Cannot Cancel Break',
                description: 'Break cannot be cancelled after it has started.',
            });
            return;
        }

        setCancelPrompt({ slots: breakSlotsToCancel, breakPeriod: breakToRemove });
    }, [doctor, clinicId, toast]);

    const handleConfirmCancel = async (shouldConsult: boolean) => {
        if (!cancelPrompt || !doctor || !clinicId) return;

        const { slots, breakPeriod } = cancelPrompt;
        setIsSubmitting(true);
        setCancelPrompt(null); // Close dialog

        try {
            const breakStart = parseISO(breakPeriod.startTime);
            const breakEnd = parseISO(breakPeriod.endTime);

            // Logic 1: If User says NO (Do NOT Consult), we must KEEP the slots BLOCKED.
            // The appointments are already 'Completed' (blocked), so we don't need to do anything.
            // Just remove the break and leave the appointments as 'Completed'.
            if (!shouldConsult) {
                console.log('[BREAK] User chose to keep slots blocked. Appointments will remain as Completed.');
            } else {
                // Logic 2: If User says YES (Consult), we must FREE the slots.
                // Change appointments from 'Completed' to 'Cancelled' to make them bookable.
                // Also delete slot-reservations for the cancelled appointments.
                const dateStr = format(selectedDate, 'd MMMM yyyy');
                const q = query(
                    collection(db, 'appointments'),
                    where('doctor', '==', doctor.name),
                    where('clinicId', '==', clinicId),
                    where('date', '==', dateStr),
                    where('sessionIndex', '==', breakPeriod.sessionIndex),
                    where('cancelledByBreak', '==', true)
                );

                const snap = await getDocs(q);
                const batch = writeBatch(db);
                let updateCount = 0;
                const cancelledAppointmentIds: string[] = [];

                snap.docs.forEach(d => {
                    const data = d.data();
                    const apptTime = parseTime(data.arriveByTime || data.time, selectedDate);

                    if (apptTime >= breakStart && apptTime < breakEnd) {
                        // Change status from 'Completed' to 'Cancelled' to make bookable
                        batch.update(d.ref, { status: 'Cancelled' });
                        updateCount++;

                        // Delete the slot-reservation document
                        const slotIndex = data.slotIndex;
                        if (typeof slotIndex === 'number') {
                            const reservationId = `${clinicId}_${doctor.name}_${dateStr}_slot_${slotIndex}`;
                            const reservationRef = doc(db, 'slot-reservations', reservationId);
                            batch.delete(reservationRef);
                        }
                        cancelledAppointmentIds.push(d.id);
                    }
                });

                if (updateCount > 0) {
                    await batch.commit();
                    console.log(`[BREAK] Freed ${updateCount} slots by changing to Cancelled and deleting reservations.`);
                }
            }

            // Logic 3: Remove the break (Standard flow)
            // fullBreakDuration isn't strictly needed for removal logic, just removing from array

            // Remove break logic (copied from original performBreakCancellation but verified)
            const doctorRef = doc(db, 'doctors', doctor.id);
            const dateKey = format(selectedDate, 'd MMMM yyyy');

            // We need to fetch fresh doctor data to ensure atomic update? 
            // Or just use local doctor state? Best to fetch fresh to avoid concurrency issues if possible, 
            // but for this app local state + write is typical pattern.
            // However, existingBreaks state might be stale?
            // Let's use arrayRemove logic or filter from fresh clone.

            // Simpler: Fetch fresh doc as in the original code? 
            // Original code didn't show the updateDoc part for removal in the snippet provided!
            // I need to implement the removal logic here. The original 'performBreakCancellation' snippet ended with toast success?
            // Wait, looking at lines 200-248 of original file, it DID NOT have the actual updateDoc call!
            // It just logged and refreshed doctor?
            // Ah, line 225 said "// NOTE: We do NOT revert appointments..."
            // But where is the break removed?
            // The user said "performBreakCancellation was found to correctly delete the break document".
            // I must have missed the 'updateDoc' lines in the 'view_file' output or they were further down?
            // Let me re-read the code snippet I saw.
            // Step 316, lines 198-248. It ENDS at `setIsSubmitting(false)`. 
            // It has `toast success`... but NO updateDoc to remove the break?!
            // Wait, maybe I missed it.
            // Line 233 refreshes the doctor.
            // It seems I missed the actual deletion logic in the previous view! 
            // Or the user code was incomplete/mocked?
            // User says "Logic Verified: performBreakCancellation was found to correctly delete the break document".
            // I will assume the deletion logic was present but I missed it or it was in a helper?
            // Actually, looking at the code I viewed in step 316... lines 220-223 just calc duration.
            // Then line 227 Toast.
            // It seems the code I viewed DOES NOT DELETE THE BREAK. 
            // This is strange. Maybe it calls a helper function I missed?
            // Or the user code I saw is incomplete.
            // I MUST implement the deletion now.

            const freshDoctorSnap = await getDoc(doctorRef);
            if (freshDoctorSnap.exists()) {
                const freshData = freshDoctorSnap.data() as Doctor;
                const breaks = freshData.breakPeriods?.[dateKey] || [];
                // Remove the break with matching ID matches
                const updatedBreaks = breaks.filter(b => b.id !== breakPeriod.id);

                // Also remove/update extensions if needed?
                // Break removal might affect extensions. 
                // Ensuring we update 'breakPeriods' map.

                const updates: any = {
                    [`breakPeriods.${dateKey}`]: updatedBreaks
                };

                // Recalculate availabilityExtensions for this session
                const availabilityExtensions = { ...(freshData.availabilityExtensions || {}) };
                if (!availabilityExtensions[dateKey]) {
                    availabilityExtensions[dateKey] = { sessions: [] };
                }

                const totalBreakMinutes = updatedBreaks.reduce((sum, bp) => sum + bp.duration, 0);
                const sessionIndex = breakPeriod.sessionIndex;

                // We need session info to calculate original end.
                // Since we are inside the cancellation logic, we might not have 'currentSession' readily available if we are just cancelling based on ID.
                // However, we can try to find the session from availabilitySlots.

                const dayOfWeek = format(selectedDate, 'EEEE');
                const availabilityForDay = freshData.availabilitySlots?.find(s => s.day === dayOfWeek);
                let originalEndStr = '';

                if (availabilityForDay && availabilityForDay.timeSlots[sessionIndex]) {
                    originalEndStr = availabilityForDay.timeSlots[sessionIndex].to;
                }

                const existingSessionExtIndex = availabilityExtensions[dateKey].sessions.findIndex((s: any) => s.sessionIndex === sessionIndex);

                const newSessionExtension = {
                    sessionIndex: sessionIndex,
                    breaks: updatedBreaks,
                    totalExtendedBy: totalBreakMinutes,
                    originalEndTime: originalEndStr ? format(parseTime(originalEndStr, selectedDate), 'hh:mm a') : '',
                    newEndTime: originalEndStr
                        ? format(addMinutes(parseTime(originalEndStr, selectedDate), totalBreakMinutes), 'hh:mm a')
                        : ''
                };

                if (existingSessionExtIndex >= 0) {
                    if (updatedBreaks.length === 0) {
                        availabilityExtensions[dateKey].sessions.splice(existingSessionExtIndex, 1);
                    } else {
                        availabilityExtensions[dateKey].sessions[existingSessionExtIndex] = newSessionExtension;
                    }
                }

                if (availabilityExtensions[dateKey].sessions.length === 0) {
                    delete availabilityExtensions[dateKey];
                }

                updates['availabilityExtensions'] = availabilityExtensions;

                await updateDoc(doctorRef, updates);

                toast({
                    title: 'Break Canceled',
                    description: shouldConsult
                        ? 'Break removed. Slots are open for booking.'
                        : 'Break removed. Slots are marked as completed (not bookable).',
                });

                // Refresh UI
                const finalSnap = await getDoc(doctorRef);
                if (finalSnap.exists()) {
                    setDoctor({ id: finalSnap.id, ...finalSnap.data() } as Doctor);
                }
                setBreakStartSlot(null);
                setBreakEndSlot(null);
            }

        } catch (error: any) {
            console.error('Error canceling break:', error);
            toast({ variant: 'destructive', title: 'Error', description: 'Failed to cancel break.' });
        } finally {
            setIsSubmitting(false);
        }
    };

    // ... inside return (JSX)
    // Add AlertDialog
    /*
      <AlertDialog open={!!cancelPrompt} onOpenChange={(open) => !open && setCancelPrompt(null)}>
        <AlertDialogContent>
             <AlertDialogHeader>
                <AlertDialogTitle>Cancel Break</AlertDialogTitle>
                <AlertDialogDescription>
                    Do you want to consult patients during the confirmed break time?
                </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter className="flex-col gap-2 sm:gap-0">
                 <Button onClick={() => handleConfirmCancel(true)}>Yes, Open Slots</Button>
                 <Button variant="outline" onClick={() => handleConfirmCancel(false)}>No, Keep Blocked</Button>
                 <Button variant="ghost" onClick={() => setCancelPrompt(null)}>Cancel</Button>
            </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    */


    useEffect(() => {
        if (!doctor || !selectedDate || dailyLeaveSlots.length === 0) return;

        const consultationTime = doctor.averageConsultingTime || 15;
        const breakEnd = new Date(Math.max(...dailyLeaveSlots));
        const effectiveBreakEnd = addMinutes(breakEnd, consultationTime);

        if (isPast(effectiveBreakEnd)) {
            console.log(`Break for Dr. ${doctor.name} on ${format(selectedDate, 'yyyy-MM-dd')} has passed. Keeping history (no auto-cancel).`);
        }
    }, [doctor, selectedDate, dailyLeaveSlots]);


    useEffect(() => {
        if (!clinicId) return;
        const fetchDoctorAndAppointments = async () => {
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

                    const dateStr = format(selectedDate, 'd MMMM yyyy');
                    const appointmentsQuery = query(collection(db, "appointments"),
                        where("doctor", "==", currentDoctor.name),
                        where("clinicId", "==", clinicId),
                        where("date", "==", dateStr)
                    );
                    const snapshot = await getDocs(appointmentsQuery);
                    const fetchedAppointments = snapshot.docs.map(d => ({ id: d.id, ...d.data() } as Appointment));
                    setAppointments(fetchedAppointments);

                } else {
                    setDoctor(null);
                    toast({ variant: 'destructive', title: 'Error', description: 'Doctor not found.' });
                }
            } catch (error) {
                console.error("Error fetching data:", error);
                toast({ variant: 'destructive', title: 'Error', description: 'Could not fetch required data.' });
            } finally {
                setLoading(false);
            }
        };
        fetchDoctorAndAppointments();
    }, [doctorIdFromParams, clinicId, selectedDate, toast]);


    const handleSlotClick = (slotInfo: SlotInfo) => {
        if (slotInfo.isTaken) return;

        const slotDate = parseISO(slotInfo.isoString);

        if (!breakStartSlot || !breakEndSlot) {
            if (!breakStartSlot) {
                setBreakStartSlot(slotInfo);
                setBreakEndSlot(null);
            } else {
                const startDate = parseISO(breakStartSlot.isoString);
                if (slotDate < startDate) {
                    setBreakStartSlot(slotInfo);
                    setBreakEndSlot(null);
                } else {
                    setBreakEndSlot(slotInfo);
                }
            }
        } else {
            setBreakStartSlot(slotInfo);
            setBreakEndSlot(null);
        }
    };

    const handleProceed = async () => {
        if (!doctor || !clinicId || !breakStartSlot || !breakEndSlot) {
            toast({ variant: 'destructive', title: 'Invalid Selection', description: 'Please select a valid start and end time for the break.' });
            return;
        }

        const breakSessionIndex = breakStartSlot.sessionIndex;
        const dayOfWeek = format(selectedDate, 'EEEE');
        const availabilityForDay = (doctor.availabilitySlots || []).find(slot => slot.day === dayOfWeek);

        if (!availabilityForDay || !availabilityForDay.timeSlots[breakSessionIndex]) {
            toast({ variant: 'destructive', title: 'Invalid Session', description: 'Could not find session for selected break slots.' });
            return;
        }

        const breakSession = availabilityForDay.timeSlots[breakSessionIndex];
        const breakSessionStart = parseTime(breakSession.from, selectedDate);
        const breakSessionEnd = parseTime(breakSession.to, selectedDate);

        const breaksForSession = getSessionBreaks(doctor, selectedDate, breakSessionIndex);
        const dateKey = format(selectedDate, 'd MMMM yyyy');
        const storedExtension = doctor.availabilityExtensions?.[dateKey]?.sessions?.find(
            s => s.sessionIndex === breakSessionIndex
        );

        const slotDuration = doctor.averageConsultingTime || 15;
        const startDate = parseISO(breakStartSlot.isoString);
        const endDate = parseISO(breakEndSlot.isoString);
        const breakDuration = differenceInMinutes(endDate, startDate) + slotDuration;

        let breakSessionEffectiveEnd: Date;
        // CRITICAL FIX: Validate that the stored extension actually belongs to THIS session time.
        // If the doctor changed their schedule, the sessionIndex might be the same but the times different.
        const currentSessionEndStr = format(breakSessionEnd, 'hh:mm a');
        const isExtensionValid = storedExtension && storedExtension.originalEndTime === currentSessionEndStr;

        if (isExtensionValid && storedExtension) {
            breakSessionEffectiveEnd = storedExtension.totalExtendedBy > 0
                ? addMinutes(breakSessionEnd, storedExtension.totalExtendedBy)
                : breakSessionEnd;
        } else {
            // No stored extension - default to original end to correctly detect overruns
            breakSessionEffectiveEnd = breakSessionEnd;
        }


        const selectedBreakSlots: string[] = [];
        let currentTime = new Date(startDate);
        while (currentTime <= endDate) {
            selectedBreakSlots.push(currentTime.toISOString());
            currentTime = addMinutes(currentTime, slotDuration);
        }

        const validation = validateBreakSlots(
            selectedBreakSlots,
            breaksForSession,
            breakSessionIndex,
            breakSessionStart,
            breakSessionEnd
        );

        if (!validation.valid) {
            toast({
                variant: 'destructive',
                title: 'Invalid Break',
                description: validation.error
            });
            return;
        }

        let hasOverrun = false;
        let minimalExtension = 0;
        let lastTokenBefore = '';
        let lastTokenAfter = '';
        const originalEnd = format(breakSessionEnd, 'hh:mm a');

        const dateStr = format(selectedDate, 'd MMMM yyyy');
        const appointmentsOnDate = appointments.filter(
            (apt) => apt.doctor === doctor.name &&
                apt.date === dateStr &&
                apt.sessionIndex === breakSessionIndex
        );

        if (appointmentsOnDate.length > 0) {
            const sortedByArriveByTime = [...appointmentsOnDate].sort((a, b) => {
                const timeA = parseTime(a.arriveByTime || a.time || '', selectedDate).getTime();
                const timeB = parseTime(b.arriveByTime || b.time || '', selectedDate).getTime();
                return timeA - timeB;
            });

            const lastAppointment = sortedByArriveByTime[sortedByArriveByTime.length - 1];
            const consultationTime = doctor.averageConsultingTime || 15;

            const lastArriveByTime = parseTime(lastAppointment.arriveByTime || lastAppointment.time, selectedDate);
            lastTokenBefore = format(lastArriveByTime, 'hh:mm a');

            const lastTimeAfterBreak = addMinutes(lastArriveByTime, breakDuration);
            const lastAppointmentEnd = addMinutes(lastTimeAfterBreak, consultationTime);
            lastTokenAfter = format(lastTimeAfterBreak, 'hh:mm a');

            const overrunMinutes = Math.max(0, differenceInMinutes(lastAppointmentEnd, breakSessionEffectiveEnd));
            hasOverrun = overrunMinutes > 0;
            minimalExtension = overrunMinutes;
        }

        setExtensionOptions({
            hasOverrun,
            minimalExtension,
            fullExtension: breakDuration,
            lastTokenBefore,
            lastTokenAfter,
            originalEnd,
            breakDuration
        });

        setPendingBreakData({
            startSlot: breakStartSlot,
            endSlot: breakEndSlot,
            sessionIndex: breakSessionIndex,
            sessionStart: breakSessionStart,
            sessionEnd: breakSessionEnd,
            sessionEffectiveEnd: breakSessionEffectiveEnd
        });
        setShowExtensionDialog(true);
    };



    const confirmBreakWithExtension = async (extensionMinutes: number | null) => {
        if (!pendingBreakData || !doctor || !clinicId) {
            setShowExtensionDialog(false);
            setPendingBreakData(null);
            setExtensionOptions(null);
            return;
        }

        const { startSlot, endSlot, sessionIndex, sessionStart, sessionEnd } = pendingBreakData;

        if (sessionIndex === undefined || !sessionStart || !sessionEnd) {
            toast({
                variant: 'destructive',
                title: 'Error',
                description: 'Session information is missing. Please try again.'
            });
            setShowExtensionDialog(false);
            setPendingBreakData(null);
            setExtensionOptions(null);
            return;
        }

        setIsSubmitting(true);
        setShowExtensionDialog(false);
        setPendingBreakData(null);
        setExtensionOptions(null);

        try {
            const startDate = parseISO(startSlot.isoString);
            const endDate = parseISO(endSlot.isoString);
            const slotDuration = doctor.averageConsultingTime || 15;

            const selectedBreakSlots: string[] = [];
            let currentTime = new Date(startDate);
            while (currentTime <= endDate) {
                selectedBreakSlots.push(currentTime.toISOString());
                currentTime = addMinutes(currentTime, slotDuration);
            }

            const breaksForThisSession = getSessionBreaks(doctor, selectedDate, sessionIndex);

            // Validate session overlap if extending
            const newSessionEnd = pendingBreakData.sessionEffectiveEnd;
            if (extensionMinutes && extensionMinutes > 0 && newSessionEnd) {
                const overlapValidation = validateBreakOverlapWithNextSession(
                    doctor,
                    selectedDate,
                    pendingBreakData.sessionIndex,
                    newSessionEnd
                );

                if (!overlapValidation.valid) {
                    toast({
                        variant: 'destructive',
                        title: 'Cannot Extend Session',
                        description: overlapValidation.error
                    });
                    return;
                }
            }

            const newBreak = createBreakPeriod(selectedBreakSlots, sessionIndex, slotDuration);
            const allBreaks = [...breaksForThisSession, newBreak];
            const mergedBreaks = mergeAdjacentBreaks(allBreaks);

            const dateStr = format(selectedDate, 'd MMMM yyyy');
            const breakDuration = differenceInMinutes(endDate, startDate) + slotDuration;

            const doctorRef = doc(db, 'doctors', doctor.id);
            const breakPeriods = { ...(doctor.breakPeriods || {}) };
            const allBreaksForDate = (breakPeriods[dateStr] || []).filter((bp: BreakPeriod) => bp.sessionIndex !== sessionIndex);
            breakPeriods[dateStr] = [...allBreaksForDate, ...mergedBreaks];

            const availabilityExtensions = doctor.availabilityExtensions || {};
            if (!availabilityExtensions[dateStr]) {
                availabilityExtensions[dateStr] = { sessions: [] as any };
            }

            const sessionExtIndex = availabilityExtensions[dateStr].sessions.findIndex((s: any) => s.sessionIndex === sessionIndex);

            if (extensionMinutes !== null && extensionMinutes > 0) {
                const newEndTimeDate = addMinutes(sessionEnd, extensionMinutes);
                const newEndTime = format(newEndTimeDate, 'hh:mm a');
                const sessionExtension = {
                    sessionIndex,
                    breaks: mergedBreaks,
                    totalExtendedBy: extensionMinutes,
                    originalEndTime: format(sessionEnd, 'hh:mm a'),
                    newEndTime
                };

                if (sessionExtIndex >= 0) {
                    availabilityExtensions[dateStr].sessions[sessionExtIndex] = sessionExtension;
                } else {
                    availabilityExtensions[dateStr].sessions.push(sessionExtension);
                }
            } else {
                const sessionExtension = {
                    sessionIndex,
                    breaks: mergedBreaks,
                    totalExtendedBy: 0,
                    originalEndTime: format(sessionEnd, 'hh:mm a'),
                    newEndTime: format(sessionEnd, 'hh:mm a')
                };

                if (sessionExtIndex >= 0) {
                    availabilityExtensions[dateStr].sessions[sessionExtIndex] = sessionExtension;
                } else {
                    availabilityExtensions[dateStr].sessions.push(sessionExtension);
                }
            }

            const allBreakSlots = mergedBreaks.flatMap((b: BreakPeriod) => b.slots);
            const updatedLeaveSlots = [...(doctor.leaveSlots || []).filter(slot => {
                try {
                    const d = typeof slot === 'string' ? parseISO(slot) : (slot as any).toDate ? (slot as any).toDate() : slot;
                    return !isSameDay(d, selectedDate);
                } catch {
                    return true;
                }
            }), ...allBreakSlots];

            await updateDoc(doctorRef, {
                breakPeriods,
                availabilityExtensions,
                leaveSlots: updatedLeaveSlots
            });

            try {
                await shiftAppointmentsForNewBreak(
                    db,
                    newBreak,
                    sessionIndex,
                    selectedDate,
                    doctor.name,
                    clinicId,
                    doctor.averageConsultingTime
                );
            } catch (error) {
                toast({
                    variant: 'destructive',
                    title: 'Break Added',
                    description: 'Break saved, but adjusting appointments failed. Please check logs.'
                });
                throw error;
            }

            toast({
                title: 'Break Scheduled Successfully',
                description: 'Appointments have been rescheduled.',
            });
            router.push('/');

        } catch (error: any) {
            if (error.name !== 'FirestorePermissionError') {
                console.error("Error scheduling break:", error);
                toast({ variant: 'destructive', title: 'Error', description: 'Failed to schedule break.' });
            }
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleCancelBreak = async (breakId?: string) => {
        if (!doctor || !selectedDate || !currentSession) {
            toast({ variant: 'destructive', title: 'Error', description: 'Cannot cancel break.' });
            return;
        }

        setIsSubmitting(true);

        try {
            // If breakId provided, cancel specific break; otherwise cancel all (legacy)
            if (breakId) {
                const breakToRemove = existingBreaks.find(b => b.id === breakId);
                if (!breakToRemove) {
                    toast({ variant: 'destructive', title: 'Error', description: 'Break not found.' });
                    setIsSubmitting(false);
                    return;
                }

                // Convert break slots to timestamps for performBreakCancellation
                const breakSlots = breakToRemove.slots.map((slot: string) => parseISO(slot).getTime());
                await performBreakCancellation(breakSlots, breakToRemove);

                // Refresh doctor data to update UI
                if (clinicId) {
                    const doctorId = doctor.id;
                    const docRef = doc(db, 'doctors', doctorId);
                    const docSnap = await getDoc(docRef);
                    if (docSnap.exists() && docSnap.data().clinicId === clinicId) {
                        const updatedDoctor = { id: docSnap.id, ...docSnap.data() } as Doctor;
                        setDoctor(updatedDoctor);
                    }
                }
            } else {
                // Legacy: cancel all breaks
                if (dailyLeaveSlots.length > 0) {
                    await performBreakCancellation(dailyLeaveSlots);
                } else {
                    toast({ variant: 'destructive', title: 'Error', description: 'No break found to cancel.' });
                }
            }

            // Reset selection
            setBreakStartSlot(null);
            setBreakEndSlot(null);
        } catch (error: any) {
            console.error('Error canceling break:', error);
            toast({ variant: 'destructive', title: 'Error', description: 'Failed to cancel break.' });
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleDateSelect = (date: Date | undefined) => {
        if (date) {
            setSelectedDate(date);
            setBreakStartSlot(null);
            setBreakEndSlot(null);
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
                    <Link href="/" passHref className="mt-6">
                        <Button>
                            <ArrowLeft className="mr-2" />
                            Back to Home
                        </Button>
                    </Link>
                </div>
            </AppFrameLayout>
        );
    }

    const breakStart = dailyLeaveSlots.length > 0 ? new Date(Math.min(...dailyLeaveSlots)) : null;
    const breakEnd = dailyLeaveSlots.length > 0 ? new Date(Math.max(...dailyLeaveSlots)) : null;

    return (
        <AppFrameLayout>
            <div className="flex flex-col h-full">
                <header className="flex items-center gap-4 p-4 border-b">
                    <Link href="/">
                        <Button variant="ghost" size="icon">
                            <ArrowLeft />
                        </Button>
                    </Link>
                    <div>
                        <h1 className="text-xl font-bold">Schedule Break</h1>
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
                        <h2 className="text-lg font-semibold mb-4">Select Break Range for {format(selectedDate, 'MMMM d')}</h2>

                        {/* Display existing breaks for current session */}
                        {currentSession && existingBreaks.length > 0 && (
                            <div className="mb-4 p-4 border rounded-md bg-muted/50">
                                <h4 className="font-semibold mb-2 flex items-center gap-2">
                                    <Clock className="w-4 h-4" />
                                    Current Breaks in Session {currentSession.sessionIndex + 1}
                                    ({format(currentSession.sessionStart, 'hh:mm a')} - {format(currentSession.originalEnd, 'hh:mm a')})
                                </h4>

                                <div className="space-y-2">
                                    {existingBreaks.map((breakPeriod, index) => (
                                        <div
                                            key={breakPeriod.id}
                                            className="flex items-center justify-between p-2 bg-background border rounded"
                                        >
                                            <div className="flex items-center gap-2">
                                                <span className="font-medium">Break {index + 1}:</span>
                                                <span className="text-sm">
                                                    {breakPeriod.startTimeFormatted} - {breakPeriod.endTimeFormatted}
                                                </span>
                                                <span className="text-xs text-muted-foreground">
                                                    ({breakPeriod.duration} min)
                                                </span>
                                            </div>
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                onClick={() => handleCancelBreak(breakPeriod.id)}
                                                disabled={isSubmitting}
                                            >
                                                <X className="w-4 h-4 mr-1" />
                                                Cancel
                                            </Button>
                                        </div>
                                    ))}
                                </div>

                                {/* Extension summary */}
                                <div className="mt-3 pt-3 border-t text-sm">
                                    <div className="flex justify-between">
                                        <span className="text-muted-foreground">Total break time:</span>
                                        <span className="font-medium">{currentSession.totalBreakMinutes} minutes</span>
                                    </div>
                                    <div className="flex justify-between">
                                        <span className="text-muted-foreground">
                                            {currentSession.effectiveEnd.getTime() === currentSession.originalEnd.getTime()
                                                ? 'Session ends at:'
                                                : 'Session extended to:'}
                                        </span>
                                        <span className="font-medium">{format(currentSession.effectiveEnd, 'hh:mm a')}</span>
                                    </div>
                                </div>

                                {existingBreaks.length >= 3 && (
                                    <div className="mt-2 p-2 bg-yellow-50 border border-yellow-200 rounded text-sm text-yellow-800">
                                        Maximum 3 breaks per session reached. Cancel a break to add a new one.
                                    </div>
                                )}
                            </div>
                        )}

                        {availableSlots ? (
                            Array.from([
                                { label: 'Current Session', slots: availableSlots.currentSessionSlots },
                                ...Array.from(availableSlots.upcomingSessionSlots.entries()).map(([idx, slots]) => ({
                                    label: `Session ${idx + 1}`,
                                    slots,
                                })),
                            ]).map((group, groupIdx) => (
                                <div key={`${group.label}-${groupIdx}`} className="mb-4">
                                    <p className="text-sm font-semibold mb-2">{group.label}</p>
                                    <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                                        {group.slots.map((slot) => {
                                            const isSelected =
                                                (breakStartSlot && breakEndSlot &&
                                                    parseISO(slot.isoString) >= parseISO(breakStartSlot.isoString) &&
                                                    parseISO(slot.isoString) <= parseISO(breakEndSlot.isoString)) ||
                                                (breakStartSlot?.isoString === slot.isoString && !breakEndSlot);

                                            return (
                                                <Button
                                                    key={slot.isoString}
                                                    variant={isSelected ? 'default' : 'outline'}
                                                    className={cn(
                                                        "h-auto py-2 flex-col",
                                                        isSelected && 'bg-destructive/80 hover:bg-destructive text-white',
                                                        slot.isTaken && 'bg-red-200 text-red-800 border-red-300 cursor-not-allowed',
                                                        !isSelected && !slot.isTaken && 'hover:bg-accent'
                                                    )}
                                                    onClick={() => handleSlotClick(slot)}
                                                    disabled={slot.isTaken}
                                                >
                                                    <span className="font-semibold">{slot.timeFormatted}</span>
                                                    {slot.isTaken && <span className="text-xs">Break</span>}
                                                </Button>
                                            );
                                        })}
                                    </div>
                                </div>
                            ))
                        ) : (
                            <p className="text-center text-muted-foreground mt-4">No available sessions for this date.</p>
                        )}
                    </section>
                </div>
                <footer className="p-4 border-t mt-auto bg-card sticky bottom-0">
                    <div className="text-center mb-2 text-sm text-muted-foreground">
                        {dailyLeaveSlots.length > 0 && breakStart && breakEnd ? (
                            `Break from ${format(breakStart, 'hh:mm a')} to ${format(addMinutes(breakEnd, (doctor.averageConsultingTime || 15) - 1), 'hh:mm a')}`
                        ) : breakStartSlot && !breakEndSlot ? (
                            "Select an end time for the break."
                        ) : breakStartSlot && breakEndSlot ? (
                            `New break: ${breakStartSlot.timeFormatted} to ${breakEndSlot.timeFormatted}`
                        ) : (
                            "Select a start and end time for the break."
                        )}
                    </div>

                    {existingBreaks.length >= 3 ? (
                        <Button className="w-full" variant="outline" disabled>
                            Maximum 3 breaks per session
                        </Button>
                    ) : (
                        <Button
                            className="w-full"
                            variant="destructive"
                            disabled={!breakStartSlot || !breakEndSlot || isSubmitting}
                            onClick={handleProceed}
                        >
                            {isSubmitting ? <Loader2 className="animate-spin" /> : existingBreaks.length > 0 ? 'Add Another Break' : 'Add Break'}
                        </Button>
                    )}

                </footer>

                <AlertDialog open={!!cancelPrompt} onOpenChange={(open) => !open && setCancelPrompt(null)}>
                    <AlertDialogContent>
                        <AlertDialogHeader>
                            <AlertDialogTitle>Consult During Break?</AlertDialogTitle>
                            <AlertDialogDescription>
                                Do you want to enable consultation during this break time?
                                <br /><br />
                                <strong>Yes:</strong> Slots become open for booking.
                                <br />
                                <strong>No:</strong> Slots remain blocked (marked as Completed).
                            </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter className="flex-col space-y-2 sm:space-y-0 sm:flex-row sm:space-x-2">
                            <Button variant="outline" onClick={() => setCancelPrompt(null)}>
                                Cancel
                            </Button>
                            <Button variant="secondary" onClick={() => handleConfirmCancel(false)}>
                                No, Keep Blocked
                            </Button>
                            <Button onClick={() => handleConfirmCancel(true)}>
                                Yes, Open Slots
                            </Button>
                        </AlertDialogFooter>
                    </AlertDialogContent>
                </AlertDialog>
                <AlertDialog open={showExtensionDialog} onOpenChange={(open) => {
                    if (!open) {
                        setShowExtensionDialog(false);
                        setPendingBreakData(null);
                        setExtensionOptions(null);
                    }
                }}>
                    <AlertDialogContent>
                        <AlertDialogHeader>
                            <AlertDialogTitle>Extend Availability Time?</AlertDialogTitle>
                            <AlertDialogDescription className="space-y-2">
                                {extensionOptions ? (
                                    extensionOptions.hasOverrun ? (
                                        // Bad scenario: tokens outside availability
                                        <div className="space-y-3">
                                            <p>Some booked appointments will extend beyond the original availability after applying this break:</p>
                                            <ul className="list-disc list-inside space-y-1 text-sm">
                                                <li><strong>Last booked token before break:</strong> {extensionOptions.lastTokenBefore}</li>
                                                <li><strong>Last token after break:</strong> {extensionOptions.lastTokenAfter}</li>
                                                <li><strong>Original availability ends at:</strong> {extensionOptions.originalEnd}</li>
                                                <li><strong>Break taken:</strong> {extensionOptions.breakDuration} minutes</li>
                                            </ul>
                                            <p className="text-sm font-medium">Choose how to extend availability:</p>
                                        </div>
                                    ) : (
                                        // Safe scenario: all tokens within availability
                                        <div className="space-y-2">
                                            <p>Last booked token for this day is at {extensionOptions.lastTokenBefore || 'N/A'}. After applying this break, it will still finish within the original availability (ending at {extensionOptions.originalEnd}).</p>
                                            <p>Break duration is {extensionOptions.breakDuration} minutes. Do you want to extend the availability to fully compensate the break?</p>
                                        </div>
                                    )
                                ) : (
                                    <p>Do you want to extend the availability time to compensate for the break duration?</p>
                                )}
                            </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter className="mt-4 flex flex-col space-y-2">
                            {extensionOptions?.hasOverrun ? (
                                // Bad scenario: 2 buttons (minimal vs full extension)
                                <>
                                    <AlertDialogCancel className="w-full justify-start">Cancel</AlertDialogCancel>
                                    <AlertDialogAction className="w-full justify-start" onClick={() => {
                                        confirmBreakWithExtension(extensionOptions.minimalExtension);
                                    }}>
                                        <div className="flex flex-col items-start text-left">
                                            <span className="font-semibold flex flex-col items-start text-left">
                                                <span>
                                                    Extend to {(() => {
                                                        const originalEndDate = parseTime(extensionOptions.originalEnd, selectedDate);
                                                        const minimalEndDate = addMinutes(originalEndDate, extensionOptions.minimalExtension);
                                                        return format(minimalEndDate, 'hh:mm a');
                                                    })()}
                                                </span>
                                                <span>(+{extensionOptions.minimalExtension} min)</span>
                                            </span>
                                            <span className="text-xs font-normal text-muted-foreground">
                                                finish booked patients
                                            </span>
                                        </div>
                                    </AlertDialogAction>
                                    <AlertDialogAction className="w-full justify-start" onClick={() => {
                                        confirmBreakWithExtension(extensionOptions.fullExtension);
                                    }}>
                                        <div className="flex flex-col items-start text-left">
                                            <span className="font-semibold flex flex-col items-start text-left">
                                                <span>
                                                    Extend to {(() => {
                                                        const originalEndDate = parseTime(extensionOptions.originalEnd, selectedDate);
                                                        const fullEndDate = addMinutes(originalEndDate, extensionOptions.fullExtension);
                                                        return format(fullEndDate, 'hh:mm a');
                                                    })()}
                                                </span>
                                                <span>(+{extensionOptions.fullExtension} min)</span>
                                            </span>
                                            <span className="text-xs font-normal text-muted-foreground">
                                                fully compensate break
                                            </span>
                                        </div>
                                    </AlertDialogAction>
                                </>
                            ) : (
                                // Safe scenario: 3 buttons (Cancel, No Keep Same, Yes Extend)
                                <>
                                    <AlertDialogCancel className="w-full justify-start">Cancel</AlertDialogCancel>
                                    <AlertDialogAction className="w-full justify-start" onClick={() => confirmBreakWithExtension(null)}>No, Keep Same</AlertDialogAction>
                                    <AlertDialogAction className="w-full justify-start" onClick={() => {
                                        if (extensionOptions) {
                                            confirmBreakWithExtension(extensionOptions.fullExtension);
                                        } else {
                                            confirmBreakWithExtension(null);
                                        }
                                    }}>Yes, Extend</AlertDialogAction>
                                </>
                            )}
                        </AlertDialogFooter>
                    </AlertDialogContent>
                </AlertDialog>
            </div>
        </AppFrameLayout>
    );
}

export default function ScheduleBreakPage() {
    return (
        <Suspense fallback={<div className="flex h-full w-full items-center justify-center"><Loader2 className="animate-spin h-8 w-8" /></div>}>
            <ScheduleBreakContent />
        </Suspense>
    );
}
