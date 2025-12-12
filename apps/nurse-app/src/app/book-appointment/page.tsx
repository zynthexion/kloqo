
'use client';

import { useState, useMemo, useEffect, useCallback } from 'react';
import { Suspense } from 'react';
import { Button } from '@/components/ui/button';
import { Calendar as CalendarIcon, ArrowLeft, Loader2 } from 'lucide-react';
import { format, addMinutes, set, parse, isSameDay, startOfDay, addDays, isBefore, isAfter, subMinutes, differenceInMinutes, parseISO } from 'date-fns';
import { cn } from '@/lib/utils';
import Link from 'next/link';
import type { Appointment, Doctor } from '@/lib/types';
import { useRouter, useSearchParams } from 'next/navigation';
import { collection, onSnapshot, query, where, doc, getDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import AppFrameLayout from '@/components/layout/app-frame';
import { parseAppointmentDateTime, parseTime } from '@/lib/utils';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { errorEmitter, FirestorePermissionError } from '@kloqo/shared-core';
import { useToast } from '@/hooks/use-toast';
import {
    Carousel,
    CarouselContent,
    CarouselItem,
    type CarouselApi,
} from "@/components/ui/carousel";
import { Skeleton } from '@/components/ui/skeleton';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Card, CardContent } from '@/components/ui/card';


type Slot = {
    time: Date;
    status: 'available' | 'booked' | 'leave' | 'reserved';
    tokenNumber?: string;
};

type SessionSlots = {
    title: string;
    slots: Slot[];
}

type BreakInterval = {
    start: Date;
    end: Date;
};

function buildBreakIntervals(doctor: Doctor | null, referenceDate: Date | null): BreakInterval[] {
    if (!doctor?.leaveSlots || !referenceDate) return [];

    const slotDuration = doctor.averageConsultingTime || 15;
    const slotsForDay = doctor.leaveSlots
        .map((leave) => {
            if (typeof leave === 'string') {
                return parseISO(leave);
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
        .filter((date): date is Date => !!date && !isNaN(date.getTime()) && isSameDay(date, referenceDate))
        .sort((a, b) => a.getTime() - b.getTime());

    if (slotsForDay.length === 0) {
        return [];
    }

    const intervals: BreakInterval[] = [];
    let currentStart = new Date(slotsForDay[0]);
    let currentEnd = addMinutes(currentStart, slotDuration);

    for (let i = 1; i < slotsForDay.length; i++) {
        const slot = slotsForDay[i];
        if (slot.getTime() === currentEnd.getTime()) {
            currentEnd = addMinutes(currentEnd, slotDuration);
        } else {
            intervals.push({ start: currentStart, end: currentEnd });
            currentStart = new Date(slot);
            currentEnd = addMinutes(currentStart, slotDuration);
        }
    }

    intervals.push({ start: currentStart, end: currentEnd });
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
    const { toast } = useToast();
    const doctorId = searchParams.get('doctor');
    const patientIdFromParams = searchParams.get('patientId');
    const isEditMode = searchParams.get('edit') === 'true';
    const appointmentId = searchParams.get('appointmentId');
    const source = searchParams.get('source');
    const isPhoneBooking = source === 'phone';


    const [doctor, setDoctor] = useState<Doctor | null>(null);
    const [loading, setLoading] = useState(true);

    const [selectedDate, setSelectedDate] = useState<Date>(new Date());
    const [selectedSlot, setSelectedSlot] = useState<Date | null>(null);
    const [allBookedSlots, setAllBookedSlots] = useState<number[]>([]);
    const [allAppointments, setAllAppointments] = useState<Appointment[]>([]);
    const [bookedSlotsWithTokens, setBookedSlotsWithTokens] = useState<Map<number, string>>(new Map());
    const [slotsLoading, setSlotsLoading] = useState(true);
    const [clinicId, setClinicId] = useState<string | null>(null);

    const [dateCarouselApi, setDateCarouselApi] = useState<CarouselApi>()
    const [currentMonth, setCurrentMonth] = useState(format(new Date(), 'MMMM yyyy'));
    const [dates, setDates] = useState<Date[]>([]);


    useEffect(() => {
        if (!doctorId) {
            toast({ variant: 'destructive', title: 'Error', description: 'No doctor ID provided.' });
            setLoading(false);
            return;
        }

        const fetchDoctorDetails = async () => {
            setLoading(true);
            try {
                const docRef = doc(db, 'doctors', doctorId);
                const docSnap = await getDoc(docRef);
                if (docSnap.exists()) {
                    const currentDoctor = { id: docSnap.id, ...docSnap.data() } as Doctor;
                    setDoctor(currentDoctor);
                    setClinicId(currentDoctor.clinicId || null);

                    const availableDaysOfWeek = (currentDoctor.availabilitySlots || []).map(s => s.day);

                    const futureDates = Array.from({ length: 30 }, (_, i) => addDays(new Date(), i));

                    let availableDates = futureDates.filter(d => {
                        const dayOfWeek = format(d, 'EEEE');
                        const isAvailableDay = availableDaysOfWeek.includes(dayOfWeek);
                        if (!isAvailableDay) return false;

                        // Don't filter out today's date based on 1-hour cutoff
                        // The date should always be shown if the doctor is available on that day
                        // Individual slots within 1 hour will be filtered out in the slot display logic
                        return true;
                    });

                    setDates(availableDates);

                    const firstAvailable = availableDates.find(d => d >= startOfDay(new Date()));

                    if (firstAvailable) {
                        setSelectedDate(firstAvailable);
                        setCurrentMonth(format(firstAvailable, 'MMMM yyyy'));
                    }

                } else {
                    toast({ variant: 'destructive', title: 'Error', description: 'Doctor not found.' });
                }
            } catch (error: any) {
                console.error('Error fetching doctor details:', error);
                if (error.name !== 'FirestorePermissionError') {
                    toast({ variant: 'destructive', title: 'Error', description: 'Could not load doctor details.' });
                }
            } finally {
                setLoading(false);
            }
        };
        fetchDoctorDetails();
    }, [doctorId, toast]);

    useEffect(() => {
        if (!doctor || !selectedDate || !clinicId) {
            setSlotsLoading(false);
            return;
        }
        setSlotsLoading(true);
        const dateStr = format(selectedDate, 'd MMMM yyyy');

        const appointmentsQuery = query(
            collection(db, 'appointments'),
            where('doctor', '==', doctor.name),
            where('clinicId', '==', clinicId),
            where('date', '==', dateStr)
        );

        const unsubscribe = onSnapshot(
            appointmentsQuery,
            (snapshot) => {
                const appointments = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Appointment));
                setAllAppointments(appointments);

                const tokenMap = new Map<number, string>();
                const fetchedBookedSlots = appointments
                    .filter(data => {
                        // Exclude walk-in tokens (W)
                        if (data.tokenNumber?.startsWith('W')) return false;
                        // Only consider Pending and Confirmed appointments as "booked"
                        // No-show, Skipped, Completed, and Cancelled slots are available for reuse
                        if (data.status !== 'Pending' && data.status !== 'Confirmed') return false;
                        return true;
                    })
                    .map(data => {
                        const slotTime = parseAppointmentDateTime(data.date, data.time).getTime();
                        // Store token number for booked slots (excluding walk-ins)
                        if (data.tokenNumber) {
                            tokenMap.set(slotTime, data.tokenNumber);
                        }
                        return slotTime;
                    });

                setAllBookedSlots(fetchedBookedSlots);
                setBookedSlotsWithTokens(tokenMap);
                setSlotsLoading(false);
            },
            (error) => {
                console.error('Error fetching appointments:', error);
                setSlotsLoading(false);
            }
        );
        return () => unsubscribe();
    }, [doctor, selectedDate, clinicId]);


    const isSlotBooked = useCallback((slot: Date): boolean => {
        return allBookedSlots.includes(slot.getTime());
    }, [allBookedSlots]);

    const isAdvanceCapacityReached = useMemo(() => {
        if (!doctor) return false;

        const dayOfWeek = format(selectedDate, 'EEEE');
        const availabilityForDay = doctor.availabilitySlots?.find(slot => slot.day === dayOfWeek);
        if (!availabilityForDay?.timeSlots?.length) return false;

        const slotDuration = doctor.averageConsultingTime || 15;
        const now = new Date(); // Use current time to calculate capacity based on future slots only

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
                if (isAfter(slotTime, now) || slotTime.getTime() >= now.getTime()) {
                    futureSlotCount += 1;
                }
                currentTime = addMinutes(currentTime, slotDuration);
            }

            if (futureSlotCount > 0) {
                slotsBySession.push({ sessionIndex, slotCount: futureSlotCount });
            }
        });

        if (slotsBySession.length === 0) return false;

        // Calculate maximum advance tokens as sum of 85% capacity from FUTURE slots in each session
        let maximumAdvanceTokens = 0;
        slotsBySession.forEach(({ slotCount }) => {
            const sessionMinimumWalkInReserve = slotCount > 0 ? Math.ceil(slotCount * 0.15) : 0;
            const sessionAdvanceCapacity = Math.max(slotCount - sessionMinimumWalkInReserve, 0);
            maximumAdvanceTokens += sessionAdvanceCapacity;
        });

        if (maximumAdvanceTokens === 0) return true;

        const formattedDate = format(selectedDate, 'd MMMM yyyy');
        const activeAdvanceCount = allAppointments.filter(appointment => {
            return (
                appointment.bookedVia !== 'Walk-in' &&
                appointment.date === formattedDate &&
                (appointment.status === 'Pending' || appointment.status === 'Confirmed')
            );
        }).length;

        return activeAdvanceCount >= maximumAdvanceTokens;
    }, [doctor, selectedDate, allAppointments]);

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

        const getSlotWithStatus = (time: Date): Slot => {
            const slot: Slot = {
                time,
                status: isSlotBooked(time) ? 'booked' : 'available',
            };
            // Add token number if slot is booked
            if (slot.status === 'booked') {
                const tokenNumber = bookedSlotsWithTokens.get(time.getTime());
                if (tokenNumber) {
                    slot.tokenNumber = tokenNumber;
                }
            }
            return slot;
        };

        // Calculate break intervals and availability end time once (outside the session loop)
        const breakIntervals = buildBreakIntervals(doctor, selectedDate);
        const dateStr = format(selectedDate, 'd MMMM yyyy');
        const extension = doctor?.availabilityExtensions?.[dateStr];

        // Get the last session's end time (original or extended)
        const lastSession = doctorAvailabilityForDay.timeSlots[doctorAvailabilityForDay.timeSlots.length - 1];
        const originalEndTime = parseTime(lastSession.to, selectedDate);
        let availabilityEndTime = originalEndTime;

        if (extension) {
            try {
                const lastSessionIndex = doctorAvailabilityForDay.timeSlots.length - 1;
                const extensionSession = extension.sessions.find(s => s.sessionIndex === lastSessionIndex);

                if (extensionSession) {
                    const extensionOriginalEndTime = parseTime(extensionSession.originalEndTime, selectedDate);
                    const extendedEndTime = parseTime(extensionSession.newEndTime, selectedDate);
                    // Validate extension: originalEndTime should match actual session end time, and newEndTime should be later
                    if (extensionOriginalEndTime.getTime() === originalEndTime.getTime() && isAfter(extendedEndTime, originalEndTime)) {
                        availabilityEndTime = extendedEndTime;
                    }
                }
            } catch (error) {
                console.error('Error parsing extension, using original end time:', error);
            }
        }

        // Calculate per-session reserved slots (15% of FUTURE slots only in each session)
        // This dynamically adjusts as time passes - reserved slots are recalculated based on remaining future slots
        const reservedSlotsBySession = new Map<number, Set<number>>();
        const consultationTime = doctor.averageConsultingTime || 15;
        const now = new Date(); // Use current time to filter past slots
        let globalSlotIndex = 0;

        doctorAvailabilityForDay.timeSlots.forEach((session, sessionIndex) => {
            let currentTime = parseTime(session.from, selectedDate);
            const endTime = parseTime(session.to, selectedDate);
            const allSessionSlots: Array<{ time: Date; globalIndex: number }> = [];
            const futureSessionSlots: number[] = [];

            // First, collect all slots with their times
            while (isBefore(currentTime, endTime)) {
                const slotTime = new Date(currentTime);
                allSessionSlots.push({ time: slotTime, globalIndex: globalSlotIndex });

                // Only include future slots (including current time) in the reserve calculation
                if (isAfter(slotTime, now) || slotTime.getTime() >= now.getTime()) {
                    futureSessionSlots.push(globalSlotIndex);
                }

                globalSlotIndex++;
                currentTime = addMinutes(currentTime, consultationTime);
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

        return doctorAvailabilityForDay.timeSlots.map((session, sessionIndex) => {
            const allPossibleSlots: Date[] = [];
            let currentTime = parseTime(session.from, selectedDate);
            const endTime = parseTime(session.to, selectedDate);

            while (isBefore(currentTime, endTime)) {
                allPossibleSlots.push(new Date(currentTime));
                currentTime = addMinutes(currentTime, consultationTime);
            }

            // Get reserved slots for this session
            const sessionReservedSlots = reservedSlotsBySession.get(sessionIndex) || new Set<number>();

            // Calculate the starting global slot index for this session
            let sessionStartGlobalIndex = 0;
            for (let i = 0; i < sessionIndex; i++) {
                let sessionTime = parseTime(doctorAvailabilityForDay.timeSlots[i].from, selectedDate);
                const sessionEnd = parseTime(doctorAvailabilityForDay.timeSlots[i].to, selectedDate);
                while (isBefore(sessionTime, sessionEnd)) {
                    sessionStartGlobalIndex++;
                    sessionTime = addMinutes(sessionTime, consultationTime);
                }
            }

            let allSlotsWithStatus = allPossibleSlots.map((slot, slotIndexInSession) => {
                const globalSlotIndexForThisSlot = sessionStartGlobalIndex + slotIndexInSession;
                const slotWithStatus = getSlotWithStatus(slot);

                // For advance bookings, mark reserved slots as 'reserved' status
                if (sessionReservedSlots.has(globalSlotIndexForThisSlot) && slotWithStatus.status === 'available') {
                    return {
                        ...slotWithStatus,
                        status: 'reserved' as const
                    };
                }

                return slotWithStatus;
            });
            const initialSlotCount = allSlotsWithStatus.length;

            // Filter out past slots - don't show slots that are in the past
            const now = new Date();
            const beforePastFilter = allSlotsWithStatus.length;
            allSlotsWithStatus = allSlotsWithStatus.filter(slot => {
                // Skip past slots
                if (isBefore(slot.time, now)) {
                    return false;
                }
                return true;
            });
            const afterPastFilter = allSlotsWithStatus.length;

            // For same-day bookings, filter out slots within 1-hour window
            if (isSameDay(selectedDate, new Date())) {
                const oneHourFromNow = addMinutes(now, 60);
                const beforeOneHourFilter = allSlotsWithStatus.length;
                // Filter out slots that are within 1 hour from now
                // Never show any slots (regular or cancelled) inside the 1-hour window
                allSlotsWithStatus = allSlotsWithStatus.filter(slot => {
                    // Hide slot if it's within 1 hour from now
                    return isBefore(oneHourFromNow, slot.time);
                });
                const afterOneHourFilter = allSlotsWithStatus.length;
                console.log(`🔍 [NURSE APP] Session ${sessionIndex + 1} slot filtering:`, {
                    initialSlotCount,
                    beforePastFilter,
                    afterPastFilter,
                    beforeOneHourFilter,
                    afterOneHourFilter,
                    currentTime: format(now, 'hh:mm a'),
                    oneHourFromNow: format(oneHourFromNow, 'hh:mm a'),
                    isSameDay: isSameDay(selectedDate, new Date())
                });
            } else {
                console.log(`🔍 [NURSE APP] Session ${sessionIndex + 1} slot filtering (future date):`, {
                    initialSlotCount,
                    beforePastFilter,
                    afterPastFilter,
                    selectedDate: format(selectedDate, 'd MMMM yyyy'),
                    currentTime: format(now, 'hh:mm a')
                });
            }

            // Count slots by status before filtering to visible
            const availableCount = allSlotsWithStatus.filter(s => s.status === 'available').length;
            const bookedCount = allSlotsWithStatus.filter(s => s.status === 'booked').length;
            const leaveCount = allSlotsWithStatus.filter(s => s.status === 'leave').length;

            // Filter out reserved slots for advance bookings (nurse app only does advance bookings)
            allSlotsWithStatus = allSlotsWithStatus.filter(slot => slot.status !== 'reserved');

            // Filter out slots where slot time + break duration would be outside availability
            allSlotsWithStatus = allSlotsWithStatus.filter(slot => {
                // Calculate what the adjusted time would be (slot + break offsets)
                const adjustedTime = breakIntervals.length > 0
                    ? applyBreakOffsets(slot.time, breakIntervals)
                    : slot.time;

                // Hide slot if adjusted time would be outside availability
                return adjustedTime <= availabilityEndTime;
            });

            let visibleSlots: Slot[] = [];
            let foundFirstAvailable = false;
            for (const slot of allSlotsWithStatus) {
                if (slot.status === 'available') {
                    // Show only the first (earliest) available slot per session
                    if (!foundFirstAvailable) {
                        visibleSlots.push(slot);
                        foundFirstAvailable = true;
                    }
                } else {
                    // Always show booked/leave slots for visibility
                    visibleSlots.push(slot);
                }
            }

            console.log(`🔍 [NURSE APP] Session ${sessionIndex + 1} final slot counts:`, {
                totalSlotsAfterFilters: allSlotsWithStatus.length,
                availableSlots: availableCount,
                bookedSlots: bookedCount,
                leaveSlots: leaveCount,
                visibleSlotsCount: visibleSlots.length,
                firstAvailableSlot: foundFirstAvailable ? format(visibleSlots.find(s => s.status === 'available')?.time || new Date(), 'hh:mm a') : 'none'
            });

            // Find breaks that overlap with this session
            const sessionStart = parseTime(session.from, selectedDate);
            const sessionEnd = parseTime(session.to, selectedDate);
            const sessionBreaks = breakIntervals.filter(interval => {
                // Check if break overlaps with session
                return (interval.start < sessionEnd && interval.end > sessionStart);
            });

            let sessionTitle = `Session ${sessionIndex + 1} (${format(parseTime(session.from, selectedDate), 'hh:mm a')} - ${format(parseTime(session.to, selectedDate), 'hh:mm a')})`;
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
                slots: visibleSlots
            };
        }).filter(session => session.slots.length > 0);

    }, [doctor, selectedDate, isSlotBooked, bookedSlotsWithTokens, allAppointments, isAdvanceCapacityReached]);


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

        if (isEditMode && appointmentId) {
            router.push(`/appointments/${appointmentId}/edit?newSlot=${selectedSlot.toISOString()}`);
            return;
        }

        const params = new URLSearchParams();
        params.set('doctor', doctor.id);
        params.set('slot', selectedSlot.toISOString());

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
            setSelectedDate(date);
            setSelectedSlot(null);
            setCurrentMonth(format(date, 'MMMM yyyy'));
        }
    };

    useEffect(() => {
        if (!dateCarouselApi) {
            return;
        }

        const handleSelect = () => {
            if (!dateCarouselApi) return;
            const selectedIndex = dateCarouselApi.selectedScrollSnap();
            const newDate = dates[selectedIndex];
            if (newDate) {
                setCurrentMonth(format(newDate, 'MMMM yyyy'));
            }
        }

        dateCarouselApi.on("select", handleSelect);
        return () => {
            dateCarouselApi.off("select", handleSelect);
        };
    }, [dateCarouselApi, dates]);

    const handleSlotSelect = (slot: Date) => {
        setSelectedSlot(prev => prev?.getTime() === slot.getTime() ? null : slot);
    };

    const isDateAvailable = (date: Date) => {
        if (!doctor) return false;
        const dayOfWeek = format(date, 'EEEE');
        // Booking remains open throughout the day - only individual slots within 1 hour are hidden
        // Don't disable dates based on 1-hour cutoff - only check if doctor is available on this day
        return (doctor.availabilitySlots || []).some(slot => slot.day === dayOfWeek);
    }

    const backLink = isPhoneBooking && patientIdFromParams ? `/phone-booking/details?doctor=${doctorId}&patientId=${patientIdFromParams}` : '/';

    const totalAvailableSlots = useMemo(() => {
        // Use the same logic as sessionSlots to count available slots
        // This ensures the count matches what's actually displayed
        if (!doctor || isAdvanceCapacityReached) return 0;

        const dayOfWeek = format(selectedDate, 'EEEE');
        const doctorAvailabilityForDay = (doctor.availabilitySlots || []).find(slot => slot.day === dayOfWeek);
        if (!doctorAvailabilityForDay) return 0;

        // Calculate break intervals and availability end time (same as sessionSlots)
        const breakIntervals = buildBreakIntervals(doctor, selectedDate);
        const dateStr = format(selectedDate, 'd MMMM yyyy');
        const extension = doctor?.availabilityExtensions?.[dateStr];

        // Get the last session's end time (original or extended)
        const lastSession = doctorAvailabilityForDay.timeSlots[doctorAvailabilityForDay.timeSlots.length - 1];
        const originalEndTime = parseTime(lastSession.to, selectedDate);
        let availabilityEndTime = originalEndTime;

        if (extension) {
            try {
                const lastSessionIndex = doctorAvailabilityForDay.timeSlots.length - 1;
                const extensionSession = extension.sessions.find(s => s.sessionIndex === lastSessionIndex);

                if (extensionSession) {
                    const extensionOriginalEndTime = parseTime(extensionSession.originalEndTime, selectedDate);
                    const extendedEndTime = parseTime(extensionSession.newEndTime, selectedDate);
                    // Validate extension: originalEndTime should match actual session end time, and newEndTime should be later
                    if (extensionOriginalEndTime.getTime() === originalEndTime.getTime() && isAfter(extendedEndTime, originalEndTime)) {
                        availabilityEndTime = extendedEndTime;
                    }
                }
            } catch (error) {
                console.error('Error parsing extension, using original end time:', error);
            }
        }

        const consultationTime = doctor.averageConsultingTime || 15;
        const now = new Date();
        let globalSlotIndex = 0;

        // Calculate reserved slots (same logic as sessionSlots)
        const reservedSlotsBySession = new Map<number, Set<number>>();
        doctorAvailabilityForDay.timeSlots.forEach((session, sessionIndex) => {
            let currentTime = parseTime(session.from, selectedDate);
            const endTime = parseTime(session.to, selectedDate);
            const futureSessionSlots: number[] = [];

            while (isBefore(currentTime, endTime)) {
                const slotTime = new Date(currentTime);
                if (isAfter(slotTime, now) || slotTime.getTime() >= now.getTime()) {
                    futureSessionSlots.push(globalSlotIndex);
                }
                globalSlotIndex++;
                currentTime = addMinutes(currentTime, consultationTime);
            }

            if (futureSessionSlots.length > 0) {
                const futureSlotCount = futureSessionSlots.length;
                const sessionMinimumWalkInReserve = Math.ceil(futureSlotCount * 0.15);
                const reservedWSlotsStart = futureSlotCount - sessionMinimumWalkInReserve;
                const reservedSlots = new Set<number>();

                for (let i = reservedWSlotsStart; i < futureSlotCount; i++) {
                    reservedSlots.add(futureSessionSlots[i]);
                }
                reservedSlotsBySession.set(sessionIndex, reservedSlots);
            } else {
                reservedSlotsBySession.set(sessionIndex, new Set<number>());
            }
        });

        let total = 0;
        globalSlotIndex = 0;

        doctorAvailabilityForDay.timeSlots.forEach((session, sessionIndex) => {
            const allPossibleSlots: Date[] = [];
            let currentTime = parseTime(session.from, selectedDate);
            const endTime = parseTime(session.to, selectedDate);

            // Calculate session start global index
            let sessionStartGlobalIndex = 0;
            for (let i = 0; i < sessionIndex; i++) {
                let sessionTime = parseTime(doctorAvailabilityForDay.timeSlots[i].from, selectedDate);
                const sessionEnd = parseTime(doctorAvailabilityForDay.timeSlots[i].to, selectedDate);
                while (isBefore(sessionTime, sessionEnd)) {
                    sessionStartGlobalIndex++;
                    sessionTime = addMinutes(sessionTime, consultationTime);
                }
            }

            while (isBefore(currentTime, endTime)) {
                allPossibleSlots.push(new Date(currentTime));
                currentTime = addMinutes(currentTime, consultationTime);
            }

            const sessionReservedSlots = reservedSlotsBySession.get(sessionIndex) || new Set<number>();

            allPossibleSlots.forEach((slot, slotIndexInSession) => {
                const globalSlotIndexForThisSlot = sessionStartGlobalIndex + slotIndexInSession;

                // Skip if booked
                if (isSlotBooked(slot)) return;

                // Skip past slots
                if (isBefore(slot, now)) return;

                // Check same-day booking cutoff
                if (isSameDay(selectedDate, now)) {
                    const oneHourFromNow = addMinutes(now, 60);
                    if (!isBefore(oneHourFromNow, slot)) return;
                }

                // Skip reserved slots (same as sessionSlots)
                if (sessionReservedSlots.has(globalSlotIndexForThisSlot)) return;

                // Filter out slots where slot time + break duration would be outside availability
                const adjustedTime = breakIntervals.length > 0
                    ? applyBreakOffsets(slot, breakIntervals)
                    : slot;

                if (adjustedTime > availabilityEndTime) return;

                total++;
            });
        });

        return total;
    }, [selectedDate, doctor, isSlotBooked, allAppointments, isAdvanceCapacityReached]);

    return (
        <AppFrameLayout>
            <div className="flex flex-col h-full">
                <header className="flex items-center p-4 border-b">
                    <Link href={backLink} className="p-2 -ml-2">
                        <ArrowLeft className="h-6 w-6" />
                    </Link>
                    <h1 className="text-xl font-bold mx-auto pr-8">Book Appointment</h1>
                </header>

                <div className="flex-grow overflow-y-auto p-4 space-y-6">
                    {(loading || !doctor) ? <DoctorProfileSkeleton /> :
                        <>
                            <Card>
                                <CardContent className="flex items-center gap-4 pt-6">
                                    <Avatar className="h-20 w-20">
                                        {doctor.avatar && (
                                            <AvatarImage src={doctor.avatar} alt={doctor.name} />
                                        )}
                                        <AvatarFallback>{doctor.name.split(' ').map(n => n[0]).join('')}</AvatarFallback>
                                    </Avatar>
                                    <div className="space-y-1">
                                        <h2 className="text-xl font-bold">{doctor.name}</h2>
                                        <p className="text-md text-muted-foreground">{doctor.department}</p>
                                    </div>
                                </CardContent>
                            </Card>

                            <div className="space-y-6">

                                <div>
                                    <div className="flex justify-between items-center mb-4 px-2">
                                        <h2 className="font-bold text-lg">Select Date</h2>
                                        <span className="text-sm font-medium">{currentMonth}</span>
                                    </div>
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
                                                                <span className="text-xs font-medium">{format(d, 'EEE')}</span>
                                                                <span className="text-xl font-bold">{format(d, 'dd')}</span>
                                                            </Button>
                                                        </div>
                                                    </CarouselItem>
                                                )
                                            })}
                                        </CarouselContent>
                                    </Carousel>
                                </div>


                                <div className="space-y-4">
                                    <div className="flex justify-between items-center">
                                        <h2 className="font-bold text-lg">Select Time</h2>
                                        {slotsLoading ? <Loader2 className="animate-spin h-5 w-5 text-primary" /> : <span className="text-sm font-semibold text-primary">{totalAvailableSlots} slots available</span>}
                                    </div>

                                    {isAdvanceCapacityReached && (
                                        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                                            Advance booking capacity has been reached for this doctor today. No slots are available.
                                        </div>
                                    )}

                                    {(() => {
                                        // Calculate break intervals for display
                                        const displayBreakIntervals = buildBreakIntervals(doctor, selectedDate);
                                        return sessionSlots.map((session, index) => (
                                            <div key={index}>
                                                <h3 className="font-semibold text-md text-muted-foreground mb-3">{session.title}</h3>
                                                <div className="grid grid-cols-[repeat(auto-fit,minmax(80px,1fr))] gap-3">
                                                    {session.slots.map(slot => {
                                                        const isSelected = selectedSlot?.getTime() === slot.time.getTime();
                                                        const isDisabled = slot.status !== 'available';
                                                        return (
                                                            <Button
                                                                key={slot.time.toISOString()}
                                                                variant={isSelected ? 'default' : (isDisabled ? 'destructive' : 'outline')}
                                                                disabled={slotsLoading || isDisabled}
                                                                onClick={() => !isDisabled && handleSlotSelect(slot.time)}
                                                                className={cn(
                                                                    { 'line-through': slot.status === 'booked' || slot.status === 'leave' }
                                                                )}>
                                                                {slot.status === 'booked' && slot.tokenNumber ? slot.tokenNumber : (() => {
                                                                    // Add break offsets for display only
                                                                    const displayTime = displayBreakIntervals.length > 0
                                                                        ? applyBreakOffsets(slot.time, displayBreakIntervals)
                                                                        : slot.time;
                                                                    return format(subMinutes(displayTime, 15), 'hh:mm a');
                                                                })()}
                                                            </Button>
                                                        )
                                                    })}
                                                </div>
                                            </div>
                                        ));
                                    })()}
                                    {sessionSlots.length === 0 && !slotsLoading && (
                                        <p className="text-muted-foreground text-center text-sm py-8">
                                            {isAdvanceCapacityReached
                                                ? 'Advance booking capacity has been reached for this doctor today.'
                                                : 'No sessions available on this day.'}
                                        </p>
                                    )}
                                </div>
                            </div>
                        </>
                    }
                    {!loading && !doctor && (
                        <div className="text-center py-10">
                            <p className="text-muted-foreground">Doctor details could not be loaded.</p>
                            <Button variant="link" asChild><Link href="/home">Go back home</Link></Button>
                        </div>
                    )}
                </div>

                <footer className="sticky bottom-0 w-full p-4 border-t">
                    <Button
                        className="w-full h-12 text-base font-bold"
                        disabled={loading || !doctor || !selectedSlot || isAdvanceCapacityReached}
                        onClick={handleProceed}
                    >
                        {'Proceed to Book'}
                    </Button>
                </footer>
            </div>
        </AppFrameLayout>
    );
}

export default function BookAppointmentPage() {
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






