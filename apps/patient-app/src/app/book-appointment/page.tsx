'use client';

import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { Suspense } from 'react';
import { Button } from '@/components/ui/button';
import { Calendar as CalendarIcon, ArrowLeft, Loader2 } from 'lucide-react';
import { format, addMinutes, set, parse, isSameDay, startOfDay, addDays, isBefore, isAfter, subMinutes, differenceInMinutes, differenceInHours, parseISO } from 'date-fns';
import type { Doctor } from '@/lib/types';
import { cn } from '@/lib/utils';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { collection, onSnapshot, query, where, doc, getDoc, Firestore, getDocs } from 'firebase/firestore';
import { useFirestore } from '@/firebase';
import { useLanguage } from '@/contexts/language-context';
import { parseAppointmentDateTime, parseTime } from '@/lib/utils';
import { updateAppointmentAndDoctorStatuses, isSlotBlockedByLeave } from '@kloqo/shared-core';
import { useMasterDepartments } from '@/hooks/use-master-departments';
import { getLocalizedDepartmentName } from '@/lib/department-utils';
import { formatMonthYear, formatDate, formatDayOfWeek } from '@/lib/date-utils';
import { useToast } from '@/hooks/use-toast';
import type { Appointment } from '@/lib/types';
import {
    Carousel,
    CarouselContent,
    CarouselItem,
    type CarouselApi,
} from "@/components/ui/carousel";
import { Skeleton } from '@/components/ui/skeleton';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Card, CardContent } from '@/components/ui/card';
import { getDoctorFromCache, saveDoctorToCache } from '@/lib/doctor-cache';
import { useDebouncedTime } from '@/hooks/use-debounced-time';

// Prevent static generation - this page requires Firebase context
export const dynamic = 'force-dynamic';

type Slot = {
    time: Date;
    status: 'available' | 'booked' | 'leave' | 'reserved';
};

type BreakInterval = {
    start: Date;
    end: Date;
};

function buildBreakIntervals(doctor: Doctor | null, referenceDate: Date | null): BreakInterval[] {
    if (!doctor?.breakPeriods || !referenceDate) return [];

    const dateKey = format(referenceDate, 'd MMMM yyyy');
    const isoDateKey = format(referenceDate, 'yyyy-MM-dd');
    const shortDateKey = format(referenceDate, 'd MMM yyyy');

    const breaksForDay = doctor.breakPeriods[dateKey] || doctor.breakPeriods[isoDateKey] || doctor.breakPeriods[shortDateKey];

    if (!breaksForDay || !Array.isArray(breaksForDay)) {
        return [];
    }

    const intervals: BreakInterval[] = [];

    for (const breakPeriod of breaksForDay) {
        try {
            const breakStart = typeof breakPeriod.startTime === 'string'
                ? parseISO(breakPeriod.startTime)
                : new Date(breakPeriod.startTime);
            const breakEnd = typeof breakPeriod.endTime === 'string'
                ? parseISO(breakPeriod.endTime)
                : new Date(breakPeriod.endTime);

            if (!isNaN(breakStart.getTime()) && !isNaN(breakEnd.getTime())) {
                intervals.push({ start: breakStart, end: breakEnd });
            }
        } catch (error) {
            console.warn('Error parsing break period:', error);
        }
    }

    return intervals;
}

function applyBreakOffsets(originalTime: Date, intervals: BreakInterval[]): Date {
    return intervals.reduce((acc, interval) => {
        if (acc.getTime() >= interval.start.getTime()) {
            return addMinutes(acc, differenceInMinutes(interval.end, interval.start));
        }
        return acc;
    }, new Date(originalTime));
}

type SubsessionSlots = {
    title: string;
    slots: Slot[];
};

type SessionSlots = {
    title: string;
    subsessions: SubsessionSlots[];
}

const MAX_VISIBLE_SLOTS = 6;


function DoctorProfileSkeleton() {
    return (
        <Card>
            <CardContent className="flex items-center gap-4 pt-6">
                <Skeleton className="h-20 w-20 rounded-full" />
                <div className="space-y-2">
                    <Skeleton className="h-6 w-40" />
                    <Skeleton className="h-5 w-32" />
                    <Skeleton className="h-4 w-24" />
                </div>
            </CardContent>
        </Card>
    );
}

function BookAppointmentContent() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const firestore = useFirestore();
    const { toast } = useToast();
    const { t, language } = useLanguage();
    const { departments } = useMasterDepartments();

    const doctorId = searchParams.get('doctorId');
    const patientIdFromParams = searchParams.get('patientId');
    const clinicIdFromParams = searchParams.get('clinicId');
    const isEditMode = searchParams.get('edit') === 'true';
    const appointmentId = searchParams.get('appointmentId');
    const source = searchParams.get('source');
    const isPhoneBooking = source === 'phone';


    // Progressive loading: Try cache first, then fetch fresh
    const cachedDoctor = doctorId ? getDoctorFromCache(doctorId) : null;
    const [doctor, setDoctor] = useState<Doctor | null>(cachedDoctor);
    const [loading, setLoading] = useState(!cachedDoctor); // Don't show loading if we have cache

    const [selectedDate, setSelectedDate] = useState<Date>(new Date());
    const [selectedSlot, setSelectedSlot] = useState<Date | null>(null);
    const [allBookedSlots, setAllBookedSlots] = useState<number[]>([]);
    const [allAppointments, setAllAppointments] = useState<Appointment[]>([]);
    const [slotsLoading, setSlotsLoading] = useState(true);
    const [clinicId, setClinicId] = useState<string | null>(cachedDoctor?.clinicId || null);

    const [dateCarouselApi, setDateCarouselApi] = useState<CarouselApi>()
    const [currentMonth, setCurrentMonth] = useState(formatMonthYear(new Date(), language));
    const [dates, setDates] = useState<Date[]>([]);
    const [isBioExpanded, setIsBioExpanded] = useState(false);

    // Track if we've initialized dates from cached doctor
    const datesInitializedRef = useRef(false);
    // Track if user has manually selected a date (prevent auto-resetting)
    const userSelectedDateRef = useRef(false);

    // Initialize dates from cached doctor immediately
    useEffect(() => {
        if (cachedDoctor && !datesInitializedRef.current) {
            const availableDaysOfWeek = (cachedDoctor.availabilitySlots || []).map(s => s.day);
            const futureDates = Array.from({ length: 30 }, (_, i) => addDays(new Date(), i));
            const availableDates = futureDates.filter(d => {
                const dayOfWeek = format(d, 'EEEE');
                return availableDaysOfWeek.includes(dayOfWeek);
            });
            setDates(availableDates);
            // Only set first available date if user hasn't manually selected one
            if (!userSelectedDateRef.current) {
                const firstAvailable = availableDates.find(d => d >= startOfDay(new Date()));
                if (firstAvailable) {
                    setSelectedDate(firstAvailable);
                    setCurrentMonth(formatMonthYear(firstAvailable, language));
                }
            }
            datesInitializedRef.current = true;
        }
    }, [cachedDoctor, language]);

    // Progressive loading: Fetch doctor with cache support + start appointments fetch early
    useEffect(() => {
        if (!doctorId || !firestore) {
            if (!doctorId) {
                toast({ variant: 'destructive', title: t.bookAppointment.error, description: t.bookAppointment.noDoctorId });
            }
            setLoading(false);
            return;
        }

        const fetchDoctorDetails = async () => {
            // Show loading only if we don't have cached data
            if (!cachedDoctor) {
                setLoading(true);
            }

            try {
                const docRef = doc(firestore, 'doctors', doctorId);
                const docSnap = await getDoc(docRef);
                if (docSnap.exists()) {
                    const currentDoctor = { id: docSnap.id, ...docSnap.data() } as Doctor;
                    setDoctor(currentDoctor);
                    setClinicId(currentDoctor.clinicId || null);

                    // Cache doctor data for faster next visit
                    saveDoctorToCache(doctorId, currentDoctor);

                    const availableDaysOfWeek = (currentDoctor.availabilitySlots || []).map(s => s.day);
                    const futureDates = Array.from({ length: 30 }, (_, i) => addDays(new Date(), i));
                    const availableDates = futureDates.filter(d => {
                        const dayOfWeek = format(d, 'EEEE');
                        return availableDaysOfWeek.includes(dayOfWeek);
                    });

                    setDates(availableDates);
                    datesInitializedRef.current = true;

                    // Only set first available date if user hasn't manually selected one
                    if (!userSelectedDateRef.current) {
                        const firstAvailable = availableDates.find(d => d >= startOfDay(new Date()));
                        if (firstAvailable) {
                            setSelectedDate(firstAvailable);
                            setCurrentMonth(formatMonthYear(firstAvailable, language));
                        }
                    }

                } else {
                    toast({ variant: 'destructive', title: t.bookAppointment.error, description: t.bookAppointment.doctorNotFound });
                }
            } catch (error: any) {
                console.error('Error fetching doctor details:', error);
                if (error.name !== 'FirestorePermissionError') {
                    toast({ variant: 'destructive', title: t.bookAppointment.error, description: t.bookAppointment.couldNotLoadDoctor });
                }
            } finally {
                setLoading(false);
            }
        };

        // Only fetch if we don't have cached doctor or want fresh data
        fetchDoctorDetails();
    }, [doctorId, firestore, toast, t, language, cachedDoctor]);

    // Optimized: Start fetching appointments earlier - don't wait for full doctor load
    // If we have clinicId from cache or params, start fetching immediately
    useEffect(() => {
        const effectiveClinicId = clinicId || clinicIdFromParams;
        const effectiveDoctorName = doctor?.name || (cachedDoctor?.name);

        if (!selectedDate || !effectiveClinicId || !firestore) {
            setSlotsLoading(false);
            return;
        }

        // Need doctor name for query - wait if we don't have it yet
        if (!effectiveDoctorName) {
            setSlotsLoading(true);
            return;
        }

        setSlotsLoading(true);
        const dateStr = formatDate(selectedDate, "d MMMM yyyy", language);

        const appointmentsQuery = query(
            collection(firestore, 'appointments'),
            where('doctor', '==', effectiveDoctorName),
            where('clinicId', '==', effectiveClinicId),
            where('date', '==', dateStr)
        );

        const unsubscribe = onSnapshot(
            appointmentsQuery,
            (snapshot) => {
                const appointments = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Appointment));

                setAllAppointments(appointments);

                const fetchedBookedSlots = appointments
                    .filter(data => {
                        if (data.tokenNumber?.startsWith('W')) return false;
                        if (data.status !== 'Pending' && data.status !== 'Confirmed') return false;
                        return true;
                    })
                    .map(data => parseAppointmentDateTime(data.date, data.time).getTime());

                setAllBookedSlots(fetchedBookedSlots);
                setSlotsLoading(false);
            },
            (error) => {
                console.error('Error fetching appointments:', error);
                setSlotsLoading(false);
            }
        );
        return () => unsubscribe();
    }, [doctor?.name, cachedDoctor?.name, selectedDate, clinicId, clinicIdFromParams, firestore, language]);


    const isSlotBooked = useCallback((slot: Date): boolean => {
        return allBookedSlots.includes(slot.getTime());
    }, [allBookedSlots]);

    // Optimized: Use debounced time to reduce recalculations
    // Updates every 2 minutes instead of every minute to reduce slot calculation overhead
    const currentTime = useDebouncedTime(120000); // 2 minutes

    const isAdvanceCapacityReached = useMemo(() => {
        if (!doctor) return false;

        const dayOfWeek = format(selectedDate, 'EEEE');
        const availabilityForDay = doctor.availabilitySlots?.find(slot => slot.day === dayOfWeek);
        if (!availabilityForDay?.timeSlots?.length) return false;

        const slotDuration = doctor.averageConsultingTime || 15;
        const now = currentTime; // Use current time to calculate capacity based on future slots only


        // Calculate total FUTURE slots per session and maximum advance tokens per session (85% of future slots in each session)
        // This dynamically adjusts as time passes - capacity is recalculated based on remaining future slots
        const dateKey = format(selectedDate, 'd MMMM yyyy');
        const slotsBySession: Array<{ sessionIndex: number; slotCount: number }> = [];

        availabilityForDay.timeSlots.forEach((session, sessionIndex) => {
            let currentTime = parseTime(session.from, selectedDate);

            // Check if there's an availability extension for this session
            const originalSessionEnd = parseTime(session.to, selectedDate);
            let sessionEnd = originalSessionEnd;
            const extensions = doctor.availabilityExtensions?.[dateKey];
            if (extensions?.sessions && Array.isArray(extensions.sessions)) {
                const sessionExtension = extensions.sessions.find((s: any) => s.sessionIndex === sessionIndex);
                if (sessionExtension?.newEndTime) {
                    sessionEnd = parseTime(sessionExtension.newEndTime, selectedDate);
                }
            }

            let futureSlotCount = 0;

            // Only count future slots (including current time)
            while (isBefore(currentTime, sessionEnd)) {
                const slotTime = new Date(currentTime);
                // Check if slot is blocked by leave/break
                const isBlocked = isSlotBlockedByLeave(doctor, slotTime);

                if (!isBlocked && (isAfter(slotTime, now) || slotTime.getTime() >= now.getTime())) {
                    futureSlotCount += 1;
                }
                currentTime = addMinutes(currentTime, slotDuration);
            }

            if (futureSlotCount > 0) {
                slotsBySession.push({ sessionIndex, slotCount: futureSlotCount });
            }

        });

        if (slotsBySession.length === 0) {
            return false;
        }

        // Calculate maximum advance tokens as sum of 85% capacity from FUTURE slots in each session
        let maximumAdvanceTokens = 0;
        slotsBySession.forEach(({ slotCount }) => {
            const sessionMinimumWalkInReserve = slotCount > 0 ? Math.ceil(slotCount * 0.15) : 0;
            const sessionAdvanceCapacity = Math.max(slotCount - sessionMinimumWalkInReserve, 0);
            maximumAdvanceTokens += sessionAdvanceCapacity;
        });


        if (maximumAdvanceTokens === 0) {
            return true;
        }

        const formattedDate = format(selectedDate, 'd MMMM yyyy');
        const activeAdvanceAppointments = allAppointments.filter(appointment => {
            return (
                appointment.bookedVia !== 'Walk-in' &&
                appointment.date === formattedDate &&
                (appointment.status === 'Pending' || appointment.status === 'Confirmed') &&
                !appointment.cancelledByBreak // Exclude appointments cancelled by break scheduling
            );
        });

        const activeAdvanceCount = activeAdvanceAppointments.length;


        const capacityReached = activeAdvanceCount >= maximumAdvanceTokens;


        return capacityReached;
    }, [doctor, selectedDate, allAppointments, currentTime]);

    useEffect(() => {
        if (isAdvanceCapacityReached) {
            setSelectedSlot(null);
        }
    }, [isAdvanceCapacityReached]);

    const sessionSlots = useMemo((): SessionSlots[] => {
        if (!doctor || isAdvanceCapacityReached) return [];

        const dayOfWeek = format(selectedDate, 'EEEE');
        const doctorAvailabilityForDay = (doctor.availabilitySlots || []).find(slot => slot.day === dayOfWeek);
        if (!doctorAvailabilityForDay) return [];

        const getSlotWithStatus = (time: Date, slotIndex: number): Slot => {
            return {
                time,
                status: isSlotBooked(time) ? 'booked' : 'available',
            };
        };

        // Calculate total slots across all sessions for the day
        const consultationTime = doctor.averageConsultingTime || 15;
        const now = currentTime; // Use current time to filter past slots
        let globalSlotIndex = 0;
        const allSlotsForDay: { time: Date; sessionIndex: number; globalSlotIndex: number }[] = [];

        // Calculate per-session reserved slots (15% of FUTURE slots only in each session)
        // This dynamically adjusts as time passes - reserved slots are recalculated based on remaining future slots
        const reservedSlotsBySession = new Map<number, Set<number>>();

        doctorAvailabilityForDay.timeSlots.forEach((session, sessionIndex) => {
            let slotCurrentTime = parseTime(session.from, selectedDate);
            let endTime = parseTime(session.to, selectedDate);

            // Check for availability extension (session-specific)
            const dateKey = format(selectedDate, 'd MMMM yyyy');
            const extensionForDate = doctor.availabilityExtensions?.[dateKey];

            if (extensionForDate) {
                const sessionExtension = extensionForDate.sessions?.find((s: any) => s.sessionIndex === sessionIndex);

                if (sessionExtension && sessionExtension.newEndTime && sessionExtension.totalExtendedBy > 0) {
                    try {
                        const extendedEndTime = parseTime(sessionExtension.newEndTime, selectedDate);
                        // Only use extended time if it's actually later than the original end time
                        if (isAfter(extendedEndTime, endTime)) {
                            endTime = extendedEndTime;
                        }
                    } catch (error) {
                        console.error('Error parsing extended end time, using original:', error);
                    }
                }
            }

            const allSessionSlots: Array<{ time: Date; globalIndex: number }> = [];
            const futureSessionSlots: number[] = [];

            // First, collect all slots with their times
            while (isBefore(slotCurrentTime, endTime)) {
                const slotTime = new Date(slotCurrentTime);
                allSessionSlots.push({ time: slotTime, globalIndex: globalSlotIndex });
                allSlotsForDay.push({
                    time: slotTime,
                    sessionIndex,
                    globalSlotIndex
                });

                // Only include future slots (including current time) in the reserve calculation
                if (isAfter(slotTime, now) || slotTime.getTime() >= now.getTime()) {
                    futureSessionSlots.push(globalSlotIndex);
                }

                slotCurrentTime = addMinutes(slotCurrentTime, consultationTime);
                globalSlotIndex++;
            }

            // Calculate reserved slots based on FUTURE slots only (last 15% of future slots)
            if (futureSessionSlots.length > 0) {
                const futureSlotCount = futureSessionSlots.length;
                const sessionMinimumWalkInReserve = Math.ceil(futureSlotCount * 0.15);
                const reservedWSlotsStart = futureSlotCount - sessionMinimumWalkInReserve;
                const reservedSlots = new Set<number>();

                // Mark the last 15% of FUTURE slots as reserved
                for (let i = reservedWSlotsStart; i < futureSlotCount; i++) {
                    reservedSlots.add(futureSessionSlots[i]);
                }
                reservedSlotsBySession.set(sessionIndex, reservedSlots);
            } else {
                // No future slots, no reserved slots
                reservedSlotsBySession.set(sessionIndex, new Set<number>());
            }
        });

        const totalSlots = allSlotsForDay.length;

        return doctorAvailabilityForDay.timeSlots.map((session, sessionIndex) => {
            const allPossibleSlots: Date[] = [];
            let slotCurrentTime = parseTime(session.from, selectedDate);
            let endTime = parseTime(session.to, selectedDate);

            // Check for extension for this specific session
            const dateKey = format(selectedDate, 'd MMMM yyyy');
            const extensionForDate = doctor.availabilityExtensions?.[dateKey];

            if (extensionForDate) {
                const sessionExtension = extensionForDate.sessions?.find((s: any) => s.sessionIndex === sessionIndex);
                if (sessionExtension && sessionExtension.newEndTime && sessionExtension.totalExtendedBy > 0) {
                    try {
                        const extendedEndTime = parseTime(sessionExtension.newEndTime, selectedDate);
                        if (isAfter(extendedEndTime, endTime)) {
                            endTime = extendedEndTime;
                        }
                    } catch (e) {
                        console.error('Error parsing extension time', e);
                    }
                }
            }

            while (isBefore(slotCurrentTime, endTime)) {
                allPossibleSlots.push(new Date(slotCurrentTime));
                slotCurrentTime = addMinutes(slotCurrentTime, consultationTime);
            }


            // CRITICAL: Filter out slots blocked by leave/break
            const visibleSlots = allPossibleSlots.filter(slot => !isSlotBlockedByLeave(doctor, slot));


            // Map slots with its status (matching clinic/nurse app logic)
            // CRITICAL: Filter out reserved W slots (last 15% of each session) from UI for advance bookings
            // Only show slots that are actually available for advance bookings
            const sessionReservedSlots = reservedSlotsBySession.get(sessionIndex) || new Set<number>();
            let allSlotsWithStatus = visibleSlots.map(slot => {
                // Find the global slot index for this slot
                const slotInfo = allSlotsForDay.find(s =>
                    s.time.getTime() === slot.getTime() && s.sessionIndex === sessionIndex
                );
                const globalIdx = slotInfo?.globalSlotIndex ?? -1;

                // Check if this slot is reserved for walk-ins in this session (last 15% of session)
                const isReservedForWalkIn = sessionReservedSlots.has(globalIdx);

                // Get slot status (booked, leave, or available)
                const slotWithStatus = getSlotWithStatus(slot, globalIdx);

                // Mark reserved walk-in slots as 'reserved' status
                if (isReservedForWalkIn && slotWithStatus.status === 'available') {
                    return {
                        ...slotWithStatus,
                        status: 'reserved' as const
                    };
                }

                return slotWithStatus;
            });

            // Filter out past slots - don't show slots that are in the past
            const now = currentTime; // Use the reactive currentTime state
            allSlotsWithStatus = allSlotsWithStatus.filter(slot => {
                // Skip past slots
                return !isBefore(slot.time, now);
            });

            // For same-day bookings, filter out slots within 1-hour window
            if (isSameDay(selectedDate, currentTime)) {
                const oneHourFromNow = addMinutes(now, 60);
                // Filter out slots that are within 1 hour from now
                // Never show any slots (regular or cancelled) inside the 1-hour window
                allSlotsWithStatus = allSlotsWithStatus.filter(slot => {
                    // Hide slot if it's within 1 hour from now (slot.time < oneHourFromNow)
                    // Show slots that are at or after 1 hour from now (slot.time >= oneHourFromNow)
                    return !isBefore(slot.time, oneHourFromNow);
                });
            }

            // CRITICAL: Filter out reserved W slots from display for advance bookings (per session)
            // Only show slots that are actually available for advance bookings (not reserved for walk-ins)
            // sessionReservedSlots is already defined above at line 386
            allSlotsWithStatus = allSlotsWithStatus.filter(slot => {
                const slotInfo = allSlotsForDay.find(s =>
                    s.time.getTime() === slot.time.getTime() && s.sessionIndex === sessionIndex
                );
                const globalIdx = slotInfo?.globalSlotIndex ?? -1;
                // Hide slots that are reserved for walk-ins in this session (last 15% of session)
                return !sessionReservedSlots.has(globalIdx);
            });


            // Filter out slots where slot time + break duration would be outside availability
            // REMOVED: This filter conflicts with availability extensions.
            /*
            const breakIntervals = buildBreakIntervals(doctor, selectedDate);
            const dateStr = format(selectedDate, 'd MMMM yyyy');
            const extension = doctor?.availabilityExtensions?.[dateStr];

            // Get the last session's end time (original or extended)
            const lastSession = doctorAvailabilityForDay.timeSlots[doctorAvailabilityForDay.timeSlots.length - 1];
            const originalEndTime = parseTime(lastSession.to, selectedDate);
            let availabilityEndTime = originalEndTime;

            if (extension) {
                try {
                    const extensionOriginalEndTime = parseTime(extension.originalEndTime, selectedDate);
                    const extendedEndTime = parseTime(extension.newEndTime, selectedDate);
                    // Validate extension: originalEndTime should match actual session end time, and newEndTime should be later
                    if (extensionOriginalEndTime.getTime() === originalEndTime.getTime() && isAfter(extendedEndTime, originalEndTime)) {
                        availabilityEndTime = extendedEndTime;
                    }
                } catch (error) {
                    console.error('Error parsing extension, using original end time:', error);
                }
            }

            allSlotsWithStatus = allSlotsWithStatus.filter(slot => {
                // Calculate what the adjusted time would be (slot + break offsets)
                const adjustedTime = breakIntervals.length > 0
                    ? applyBreakOffsets(slot.time, breakIntervals)
                    : slot.time;

                // Hide slot if adjusted time would be outside availability
                return adjustedTime <= availabilityEndTime;
            });
            */
            // Instead, define breakIntervals for use in subsessions
            const breakIntervals = buildBreakIntervals(doctor, selectedDate);

            // Show all slots (not just the first available)
            const allVisibleSlots = allSlotsWithStatus;

            // Group slots into 2-hour subsessions
            const subsessions: SubsessionSlots[] = [];
            const twoHoursInMinutes = 120;
            const sessionStartTime = parseTime(session.from, selectedDate);

            let sessionEndTime = parseTime(session.to, selectedDate);

            // Check for extension for this specific session to update sessionEndTime for grouping
            if (extensionForDate) {
                const sessionExtension = extensionForDate.sessions?.find((s: any) => s.sessionIndex === sessionIndex);
                if (sessionExtension && sessionExtension.newEndTime && sessionExtension.totalExtendedBy > 0) {
                    try {
                        const extendedEndTime = parseTime(sessionExtension.newEndTime, selectedDate);
                        if (isAfter(extendedEndTime, sessionEndTime)) {
                            sessionEndTime = extendedEndTime;
                        }
                    } catch (e) {
                        console.error('Error parsing extension time for grouping', e);
                    }
                }
            }
            const sessionDurationInMinutes = differenceInMinutes(sessionEndTime, sessionStartTime);

            let subsessionStart = sessionStartTime;
            let subsessionIndex = 1;

            while (isBefore(subsessionStart, sessionEndTime)) {
                const subsessionEnd = isBefore(addMinutes(subsessionStart, twoHoursInMinutes), sessionEndTime)
                    ? addMinutes(subsessionStart, twoHoursInMinutes)
                    : sessionEndTime;

                const subsessionSlots = allVisibleSlots.filter(slot => {
                    const slotTime = slot.time;
                    return (slotTime.getTime() >= subsessionStart.getTime()) &&
                        (slotTime.getTime() < subsessionEnd.getTime());
                });

                if (subsessionSlots.length > 0) {
                    const subsessionDurationInHours = differenceInHours(subsessionEnd, subsessionStart);
                    // Add break offsets to start and end times, then subtract 15 minutes for display
                    const adjustedStart = breakIntervals.length > 0
                        ? applyBreakOffsets(subsessionStart, breakIntervals)
                        : subsessionStart;
                    const adjustedEnd = breakIntervals.length > 0
                        ? applyBreakOffsets(subsessionEnd, breakIntervals)
                        : subsessionEnd;
                    const displayStart = subMinutes(adjustedStart, 15);
                    const displayEnd = subMinutes(adjustedEnd, 15);
                    const subsessionTitle = subsessionDurationInHours >= 2
                        ? `${format(displayStart, 'hh:mm a')} - ${format(displayEnd, 'hh:mm a')}`
                        : `${format(displayStart, 'hh:mm a')} - ${format(displayEnd, 'hh:mm a')}`;

                    subsessions.push({
                        title: subsessionTitle,
                        slots: subsessionSlots
                    });
                }

                subsessionStart = subsessionEnd;
                subsessionIndex++;
            }

            // Subtract 15 minutes from session start and end times for display
            const sessionDisplayStart = subMinutes(parseTime(session.from, selectedDate), 15);
            const sessionDisplayEnd = subMinutes(parseTime(session.to, selectedDate), 15);

            // Find breaks that overlap with this session
            const sessionStart = parseTime(session.from, selectedDate);
            const sessionEnd = parseTime(session.to, selectedDate);
            const sessionBreaks = breakIntervals.filter(interval => {
                // Check if break overlaps with session
                return (interval.start < sessionEnd && interval.end > sessionStart);
            });

            let sessionTitle = `${t.bookAppointment.session} ${sessionIndex + 1} (${format(sessionDisplayStart, 'hh:mm a')} - ${format(sessionDisplayEnd, 'hh:mm a')})`;
            if (sessionBreaks.length > 0) {
                const breakTexts = sessionBreaks.map(interval => {
                    const breakStart = format(interval.start, 'hh:mm a');
                    const breakEnd = format(interval.end, 'hh:mm a');
                    return `${breakStart} - ${breakEnd}`;
                });
                sessionTitle += ` [Break: ${breakTexts.join(', ')}]`;
            }

            return {
                title: sessionTitle,
                subsessions: subsessions
            };
        }).filter(session => session.subsessions.length > 0);

    }, [doctor, selectedDate, isSlotBooked, t, language, allAppointments, currentTime, isAdvanceCapacityReached]);


    const handleProceed = () => {
        if (isAdvanceCapacityReached) {
            toast({
                variant: "destructive",
                title: "No Slots Available",
                description: "Advance booking capacity has been reached for this doctor today. Please choose another day.",
            });
            return;
        }
        if (!selectedSlot || !doctor) return;

        // Validate that the selected slot is outside the 1-hour window for A bookings
        const now = currentTime;
        if (isSameDay(selectedDate, now)) {
            const oneHourFromNow = addMinutes(now, 60);
            // If slot is within 1 hour from now, don't allow proceeding
            if (isBefore(selectedSlot, oneHourFromNow)) {
                toast({
                    variant: "destructive",
                    title: t.bookAppointment.error || "Invalid Slot",
                    description: "Advanced booking slots must be at least 1 hour from now. Please select a different time slot.",
                });
                setSelectedSlot(null); // Clear invalid selection
                return;
            }
        }

        const params = new URLSearchParams();
        params.set('doctorId', doctor.id);
        params.set('slot', selectedSlot.toISOString());

        // If rescheduling, skip patient details and go directly to summary
        if (isEditMode && appointmentId && patientIdFromParams && clinicIdFromParams) {
            params.set('edit', 'true');
            params.set('appointmentId', appointmentId);
            params.set('patientId', patientIdFromParams);
            router.push(`/book-appointment/summary?${params.toString()}`);
            return;
        }

        // Add edit mode parameters if rescheduling (fallback)
        if (isEditMode && appointmentId) {
            params.set('edit', 'true');
            params.set('appointmentId', appointmentId);
        }

        if (isPhoneBooking && patientIdFromParams) {
            params.set('patientId', patientIdFromParams);
            params.set('source', 'phone');
            const bookingUserId = searchParams.get('bookingUserId');
            if (bookingUserId) params.set('bookingUserId', bookingUserId);
        } else {
            params.set('source', 'online');
        }

        router.push(`/book-appointment/details?${params.toString()}`);
    };

    const handleDateSelect = (date: Date | undefined) => {
        if (date) {
            userSelectedDateRef.current = true; // Mark as user-selected
            setSelectedDate(date);
            setSelectedSlot(null);
            setCurrentMonth(formatMonthYear(date, language));

            // Scroll carousel to show the selected date
            if (dateCarouselApi && dates.length > 0) {
                const index = dates.findIndex(d => isSameDay(d, date));
                if (index !== -1) {
                    dateCarouselApi.scrollTo(index);
                }
            }
        }
    };

    // Sync carousel position when selectedDate changes (scrolls to show selected date)
    useEffect(() => {
        if (!dateCarouselApi || !dates.length || !selectedDate) return;

        const currentIndex = dateCarouselApi.selectedScrollSnap();
        const expectedIndex = dates.findIndex(d => isSameDay(d, selectedDate));

        // Scroll to show the selected date if it's not already visible
        if (expectedIndex !== -1 && currentIndex !== expectedIndex) {
            // Small delay to ensure carousel is ready
            setTimeout(() => {
                dateCarouselApi.scrollTo(expectedIndex, false);
            }, 100);
        }
    }, [selectedDate, dateCarouselApi, dates]);

    useEffect(() => {
        if (!dateCarouselApi) {
            return;
        }

        const handleSelect = () => {
            if (!dateCarouselApi) return;
            const selectedIndex = dateCarouselApi.selectedScrollSnap();
            const newDate = dates[selectedIndex];
            if (newDate && !isSameDay(newDate, selectedDate)) {
                // Update selected date when carousel is scrolled
                userSelectedDateRef.current = true;
                setSelectedDate(newDate);
                setSelectedSlot(null);
                setCurrentMonth(formatMonthYear(newDate, language));
            } else if (newDate) {
                // Just update month if date is already selected
                setCurrentMonth(formatMonthYear(newDate, language));
            }
        }

        dateCarouselApi.on("select", handleSelect);
        return () => {
            dateCarouselApi.off("select", handleSelect);
        };
    }, [dateCarouselApi, dates, selectedDate, language]);

    const handleSlotSelect = (slot: Date) => {
        // Validate that the selected slot is outside the 1-hour window
        const now = currentTime;
        if (isSameDay(selectedDate, now)) {
            const oneHourFromNow = addMinutes(now, 60);
            // If slot is within 1 hour from now, don't allow selection
            if (isBefore(slot, oneHourFromNow)) {
                toast({
                    variant: "destructive",
                    title: t.bookAppointment.error || "Invalid Slot",
                    description: "Advanced booking slots must be at least 1 hour from now.",
                });
                return;
            }
        }
        setSelectedSlot(prev => prev?.getTime() === slot.getTime() ? null : slot);
    };

    const isDateAvailable = (date: Date) => {
        if (!doctor) return false;
        const dayOfWeek = format(date, 'EEEE');
        // Booking remains open throughout the day - only individual slots within 1 hour are hidden
        // Don't disable dates based on 1-hour cutoff - only check if doctor is available on this day
        return (doctor.availabilitySlots || []).some(slot => slot.day === dayOfWeek);
    }

    const backLink = isPhoneBooking && patientIdFromParams ? `/phone-booking/details?doctor=${doctorId}&patientId=${patientIdFromParams}` : '/home';

    const totalAvailableSlots = useMemo(() => {
        if (!doctor || !selectedDate || isAdvanceCapacityReached) return 0;
        const dayOfWeek = format(selectedDate, 'EEEE');
        const doctorAvailabilityForDay = (doctor.availabilitySlots || []).find(slot => slot.day === dayOfWeek);
        if (!doctorAvailabilityForDay) return 0;

        const consultationTime = doctor.averageConsultingTime || 15;
        const now = currentTime; // Use reactive currentTime state

        // Calculate per-session reserved slots (15% of FUTURE slots only in each session)
        // This dynamically adjusts as time passes - reserved slots are recalculated based on remaining future slots
        const reservedSlotsBySession = new Map<number, Set<number>>();
        let currentGlobalIndex = 0;

        doctorAvailabilityForDay.timeSlots.forEach((session, sessionIndex) => {
            let slotCurrentTime = parseTime(session.from, selectedDate);
            const endTime = parseTime(session.to, selectedDate);
            const allSessionSlots: Array<{ time: Date; globalIndex: number }> = [];
            const futureSessionSlots: number[] = [];

            // First, collect all slots with their times
            while (isBefore(slotCurrentTime, endTime)) {
                const slotTime = new Date(slotCurrentTime);
                allSessionSlots.push({ time: slotTime, globalIndex: currentGlobalIndex });

                // Only include future slots (including current time) in the reserve calculation
                if (isAfter(slotTime, now) || slotTime.getTime() >= now.getTime()) {
                    futureSessionSlots.push(currentGlobalIndex);
                }

                currentGlobalIndex++;
                slotCurrentTime = addMinutes(slotCurrentTime, consultationTime);
            }

            // Calculate reserved slots based on FUTURE slots only (last 15% of future slots)
            if (futureSessionSlots.length > 0) {
                const futureSlotCount = futureSessionSlots.length;
                const sessionMinimumWalkInReserve = Math.ceil(futureSlotCount * 0.15);
                const reservedWSlotsStart = futureSlotCount - sessionMinimumWalkInReserve;
                const reservedSlots = new Set<number>();

                // Mark the last 15% of FUTURE slots as reserved
                for (let i = reservedWSlotsStart; i < futureSlotCount; i++) {
                    reservedSlots.add(futureSessionSlots[i]);
                }
                reservedSlotsBySession.set(sessionIndex, reservedSlots);
            } else {
                // No future slots, no reserved slots
                reservedSlotsBySession.set(sessionIndex, new Set<number>());
            }
        });

        let total = 0;
        currentGlobalIndex = 0;

        doctorAvailabilityForDay.timeSlots.forEach((session, sessionIndex) => {
            const allPossibleSlots: Date[] = [];
            let slotCurrentTime = parseTime(session.from, selectedDate);
            const endTime = parseTime(session.to, selectedDate);

            while (isBefore(slotCurrentTime, endTime)) {
                allPossibleSlots.push(new Date(slotCurrentTime));
                slotCurrentTime = addMinutes(slotCurrentTime, consultationTime);
            }

            const sessionReservedSlots = reservedSlotsBySession.get(sessionIndex) || new Set<number>();

            allPossibleSlots.forEach((slot) => {
                // Skip if booked or on leave
                if (isSlotBooked(slot)) {
                    currentGlobalIndex++;
                    return;
                }

                // Skip if this slot is reserved for walk-ins in this session (last 15% of session)
                if (sessionReservedSlots.has(currentGlobalIndex)) {
                    currentGlobalIndex++;
                    return;
                }

                // Check same-day booking cutoff
                // Never show any slots (regular or cancelled) inside the 1-hour window
                if (isSameDay(selectedDate, now)) {
                    if (!isAfter(slot, now)) {
                        currentGlobalIndex++;
                        return; // Skip past slots
                    }
                    const oneHourFromNow = addMinutes(now, 60);

                    // Hide slot if it's within 1 hour from now (slot < oneHourFromNow)
                    // Show slots that are at or after 1 hour from now (slot >= oneHourFromNow)
                    if (isBefore(slot, oneHourFromNow)) {
                        currentGlobalIndex++;
                        return;
                    }
                }

                total++;
                currentGlobalIndex++;
            });
        });
        return total;
    }, [selectedDate, doctor, isSlotBooked, allAppointments, currentTime, isAdvanceCapacityReached]);

    return (
        <div className="flex min-h-screen w-full flex-col bg-background font-body">
            <div className="flex flex-col h-full">
                <header className="flex items-center p-4 border-b">
                    <Link href={backLink} className="p-2 -ml-2">
                        <ArrowLeft className="h-6 w-6" />
                    </Link>
                    <h1 className="text-xl font-bold mx-auto pr-8">{t.buttons.bookAppointment}</h1>
                </header>

                <div className="flex-grow overflow-y-auto p-4 space-y-6">
                    {/* Progressive loading: Show doctor card skeleton while loading */}
                    {loading || !doctor ? (
                        <DoctorProfileSkeleton />
                    ) : (
                        <Card>
                            <CardContent className="flex items-start gap-4 pt-6">
                                <Avatar className="h-20 w-20">
                                    {doctor.avatar && (
                                        <AvatarImage src={doctor.avatar} alt={doctor.name} />
                                    )}
                                    <AvatarFallback>{doctor.name.split(' ').map(n => n[0]).join('')}</AvatarFallback>
                                </Avatar>
                                <div className="space-y-1 flex-grow">
                                    <h2 className="text-xl font-bold">{doctor.name}</h2>
                                    <p className="text-md text-muted-foreground">{getLocalizedDepartmentName(doctor.department, language, departments)}</p>
                                    {doctor.consultationFee && (
                                        <p className="text-md font-semibold text-primary font-mono">&#8377;{doctor.consultationFee}</p>
                                    )}
                                </div>
                            </CardContent>
                            {doctor.bio && (
                                <CardContent>
                                    <p className={cn("text-sm text-muted-foreground transition-all", !isBioExpanded && "line-clamp-2")}>
                                        {doctor.bio}
                                    </p>
                                    <Button variant="link" size="sm" onClick={() => setIsBioExpanded(!isBioExpanded)} className="p-0 h-auto text-primary">
                                        {isBioExpanded ? t.buttons.readLess : t.buttons.readMore}
                                    </Button>
                                </CardContent>
                            )}
                        </Card>
                    )}

                    {/* Progressive loading: Show date selector immediately (can use cached dates) */}
                    <div className="space-y-6">
                        <div>
                            <div className="flex justify-between items-center mb-4 px-2">
                                <h2 className="font-bold text-lg">{t.bookAppointment.selectDate}</h2>
                                <span className="text-sm font-medium">{currentMonth}</span>
                            </div>
                            {dates.length === 0 ? (
                                // Show skeleton while dates are loading
                                <div className="flex gap-3 overflow-x-auto pb-2">
                                    {[1, 2, 3, 4, 5, 6, 7].map((i) => (
                                        <div key={i} className="flex flex-col items-center gap-2 min-w-[60px]">
                                            <Skeleton className="h-8 w-8 rounded-full" />
                                            <Skeleton className="h-4 w-12" />
                                            <Skeleton className="h-3 w-16" />
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                <Carousel setApi={setDateCarouselApi} opts={{ align: "start", dragFree: true }} className="w-full">
                                    <CarouselContent className="-ml-2">
                                        {dates.map((d, index) => {
                                            const isSelected = isSameDay(d, selectedDate);
                                            const isDisabled = !isDateAvailable(d);
                                            return (
                                                <CarouselItem key={index} className="basis-1/5 pl-2">
                                                    <div className="p-1">
                                                        <Button
                                                            onClick={() => !isDisabled && handleDateSelect(d)}
                                                            disabled={isDisabled}
                                                            variant="outline"
                                                            className={cn(
                                                                "w-full h-auto flex flex-col items-center justify-center p-3 rounded-xl gap-1 transition-colors",
                                                                isSelected ? "bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground" : "bg-muted hover:bg-muted/80",
                                                                isDisabled && "bg-muted/50 text-muted-foreground opacity-50 cursor-not-allowed"
                                                            )}
                                                        >
                                                            <span className="text-xs font-medium">{formatDayOfWeek(d, language)}</span>
                                                            <span className="text-xl font-bold">{format(d, 'dd')}</span>
                                                        </Button>
                                                    </div>
                                                </CarouselItem>
                                            )
                                        })}
                                    </CarouselContent>
                                </Carousel>
                            )}
                        </div>

                        {/* Progressive loading: Show slots section with skeleton while loading */}
                        <div className="space-y-4">
                            <div className="flex justify-between items-center">
                                <h2 className="font-bold text-lg">{t.bookAppointment.selectTime}</h2>
                                {slotsLoading ? <Loader2 className="animate-spin h-5 w-5 text-primary" /> : <span className="text-sm font-semibold text-primary">{totalAvailableSlots} {t.bookAppointment.slotsAvailable}</span>}
                            </div>

                            {isAdvanceCapacityReached && !slotsLoading && (
                                <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                                    Advance booking capacity has been reached for this doctor today. No slots are available.
                                </div>
                            )}

                            {slotsLoading && sessionSlots.length === 0 ? (
                                // Show skeleton slots while loading
                                <div className="space-y-3">
                                    {[1, 2, 3].map((i) => (
                                        <Skeleton key={i} className="h-16 w-full rounded-lg" />
                                    ))}
                                </div>
                            ) : sessionSlots.map((session, sessionIndex) => {
                                // Find which subsession should be active (first one with available slots)
                                let activeSubsessionIndex = -1;
                                for (let i = 0; i < session.subsessions.length; i++) {
                                    const hasAvailableSlots = session.subsessions[i].slots.some(slot => slot.status === 'available');
                                    if (hasAvailableSlots) {
                                        activeSubsessionIndex = i;
                                        break;
                                    }
                                }

                                return (
                                    <div key={sessionIndex} className="space-y-3">
                                        {session.subsessions.map((subsession, subsessionIndex) => {
                                            // Check if subsession has any available slots
                                            const hasAvailableSlots = subsession.slots.some(slot => slot.status === 'available');
                                            const hasBookedSlots = subsession.slots.some(slot => slot.status === 'booked');
                                            const hasLeaveSlots = subsession.slots.some(slot => slot.status === 'leave');
                                            const isActiveSubsession = subsessionIndex === activeSubsessionIndex;
                                            const isDisabled = !isActiveSubsession || !hasAvailableSlots || slotsLoading;

                                            // Get the first available slot from this subsession
                                            const firstAvailableSlot = subsession.slots.find(slot => slot.status === 'available');

                                            // Check if selected slot is from this subsession
                                            const isSelected = firstAvailableSlot && selectedSlot?.getTime() === firstAvailableSlot.time.getTime();

                                            // Determine subsession status
                                            const isFullyBooked = !hasAvailableSlots && hasBookedSlots && !hasLeaveSlots;
                                            const isOnLeave = hasLeaveSlots && !hasAvailableSlots;
                                            const isPartiallyBooked = hasAvailableSlots && hasBookedSlots;

                                            return (
                                                <button
                                                    key={subsessionIndex}
                                                    type="button"
                                                    onClick={() => !isDisabled && firstAvailableSlot && handleSlotSelect(firstAvailableSlot.time)}
                                                    disabled={isDisabled}
                                                    className={cn(
                                                        "w-full p-4 rounded-lg text-left transition-all duration-200",
                                                        "flex items-center justify-between",
                                                        // Available and active
                                                        hasAvailableSlots && isActiveSubsession && "bg-[#ffc98b] hover:bg-[#ffb870] border-2 border-[#ffc98b] cursor-pointer opacity-75",
                                                        // Available but not active
                                                        hasAvailableSlots && !isActiveSubsession && "bg-[#ffc98b] border-2 border-[#ffc98b] cursor-not-allowed opacity-50",
                                                        // Fully booked
                                                        isFullyBooked && "bg-red-100 border-2 border-red-300 cursor-not-allowed",
                                                        // On leave
                                                        isOnLeave && "bg-yellow-100 border-2 border-yellow-300 cursor-not-allowed",
                                                        // Selected
                                                        isSelected && "ring-4 ring-primary ring-offset-2"
                                                    )}
                                                >
                                                    <div className="flex flex-col">
                                                        <span className={cn(
                                                            "font-semibold text-base",
                                                            hasAvailableSlots && isActiveSubsession && "text-gray-800",
                                                            hasAvailableSlots && !isActiveSubsession && "text-gray-700",
                                                            isFullyBooked && "text-red-800 line-through",
                                                            isOnLeave && "text-yellow-800"
                                                        )}>
                                                            {subsession.title}
                                                        </span>
                                                        {isPartiallyBooked && isActiveSubsession && (
                                                            <span className="text-xs text-gray-700 mt-1">
                                                                {subsession.slots.filter(s => s.status === 'available').length} slots available
                                                            </span>
                                                        )}
                                                        {isFullyBooked && (
                                                            <span className="text-xs text-red-600 mt-1">Fully booked</span>
                                                        )}
                                                        {isOnLeave && (
                                                            <span className="text-xs text-yellow-600 mt-1">On leave</span>
                                                        )}
                                                        {hasAvailableSlots && !isActiveSubsession && (
                                                            <span className="text-xs text-gray-600 mt-1">Not available now</span>
                                                        )}
                                                    </div>
                                                    {isSelected && (
                                                        <span className="text-primary font-bold text-lg">✓</span>
                                                    )}
                                                </button>
                                            );
                                        })}
                                    </div>
                                )
                            })}
                            {sessionSlots.length === 0 && !slotsLoading && !loading && doctor && (
                                <p className="text-muted-foreground text-center text-sm py-8">
                                    {isAdvanceCapacityReached
                                        ? 'Advance booking capacity has been reached for this doctor today.'
                                        : t.bookAppointment.noSessionsAvailable}
                                </p>
                            )}
                        </div>
                    </div>

                    {!loading && !doctor && (
                        <div className="text-center py-10">
                            <p className="text-muted-foreground">Doctor details could not be loaded.</p>
                            <Button variant="link" asChild><Link href="/home">Go back home</Link></Button>
                        </div>
                    )}
                </div>

                <footer className="sticky bottom-0 w-full p-4 bg-background border-t">
                    <Button
                        className="w-full h-12 text-base font-bold"
                        disabled={loading || !doctor || !selectedSlot || isAdvanceCapacityReached}
                        onClick={handleProceed}
                    >
                        {t.bookAppointment.proceedToBook}
                    </Button>
                </footer>
            </div>
        </div>
    );
}

import { AuthGuard } from '@/components/auth-guard';

function BookAppointmentPage() {
    return (
        <Suspense fallback={
            <div className="min-h-screen flex items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
            </div>
        }>
            <BookAppointmentContent />
        </Suspense>
    );
}

function BookAppointmentPageWithAuth() {
    return (
        <AuthGuard>
            <BookAppointmentPage />
        </AuthGuard>
    );
}

export default BookAppointmentPageWithAuth;

