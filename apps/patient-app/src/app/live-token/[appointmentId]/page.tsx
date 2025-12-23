'use client';

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import Link from 'next/link';
import { Home, Calendar, User, Users, Radio, Clock, ArrowLeft, Loader2, Info, UserCheck, Forward, Hourglass, AlertCircle, CheckCircle2, Phone } from 'lucide-react';
import { usePathname, useRouter, useParams } from 'next/navigation';
import { useUser } from '@/firebase/auth/use-user';
import { useAppointments } from '@/firebase/firestore/use-appointments';
import { format, isToday, parse, differenceInMinutes, isPast, differenceInDays, differenceInHours, startOfDay, parseISO, isWithinInterval, addMinutes, subMinutes, isBefore, isAfter } from 'date-fns';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
} from '@/components/ui/alert-dialog';
import { useDoctors } from '@/firebase/firestore/use-doctors';
import { parseAppointmentDateTime, parseTime, getArriveByTime, getArriveByTimeFromAppointment, getActualAppointmentTime, buildBreakIntervals } from '@/lib/utils';
import { formatDate } from '@/lib/date-utils';
import type { Appointment, Doctor } from '@/lib/types';
import { collection, query, where, onSnapshot, DocumentData, QuerySnapshot, doc, updateDoc, getDoc, getDocs, serverTimestamp } from 'firebase/firestore';
import { useFirestore } from '@/firebase';
import { BottomNav } from '@/components/bottom-nav';
import { AuthGuard } from '@/components/auth-guard';

// Prevent static generation - this page requires Firebase context
export const dynamic = 'force-dynamic';
import { useLanguage } from '@/contexts/language-context';
import { useMasterDepartments } from '@/hooks/use-master-departments';
import { getLocalizedDepartmentName } from '@/lib/department-utils';
import { Skeleton } from '@/components/ui/skeleton';
import { computeQueues, type QueueState, compareAppointments } from '@kloqo/shared-core';
import { useToast } from '@/hooks/use-toast';

function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number) {
    const R = 6371e3;
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(Δφ / 2) ** 2 +
        Math.cos(φ1) * Math.cos(φ2) *
        Math.sin(Δλ / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function calculateDelayForAppointments(
    appointments: Appointment[],
    currentTokenAppointment: Appointment,
    avgConsultingTime: number,
    currentTime: Date
): Map<string, number> {
    const delayMap = new Map<string, number>();

    if (!currentTokenAppointment || appointments.length === 0) {
        return delayMap;
    }

    const currentIndex = appointments.findIndex(apt => apt.id === currentTokenAppointment.id);
    if (currentIndex === -1) return delayMap;

    try {
        const scheduledTime = parseAppointmentDateTime(currentTokenAppointment.date, currentTokenAppointment.time);
        const currentDelay = Math.max(0, differenceInMinutes(currentTime, scheduledTime));

        delayMap.set(currentTokenAppointment.id, 0);
        let accumulatedDelay = currentDelay;

        for (let i = currentIndex + 1; i < appointments.length; i++) {
            const appointment = appointments[i];
            const prevAppointment = appointments[i - 1];

            const currentScheduledTime = parseAppointmentDateTime(appointment.date, appointment.time);
            const prevScheduledTime = parseAppointmentDateTime(prevAppointment.date, prevAppointment.time);
            const gapBetweenSlots = differenceInMinutes(currentScheduledTime, prevScheduledTime);

            if (gapBetweenSlots > avgConsultingTime) {
                const absorbedDelay = gapBetweenSlots - avgConsultingTime;
                accumulatedDelay = Math.max(0, accumulatedDelay - absorbedDelay);
            }

            delayMap.set(appointment.id, Math.round(accumulatedDelay));
        }
    } catch (error) {
        console.error('Error calculating delays:', error);
    }

    return delayMap;
}

function getReportByTimeLabel(appointment: Appointment | null, doctor?: Doctor | null): string {
    if (!appointment) return '--';
    try {
        return getArriveByTimeFromAppointment(appointment, doctor);
    } catch {
        return appointment.arriveByTime || appointment.time || '--';
    }
}

const AppointmentStatusCard = ({ yourAppointment, allTodaysAppointments, doctors, currentTime, t, departments, language, onAppointmentConfirmed }: { yourAppointment: Appointment, allTodaysAppointments: Appointment[], doctors: Doctor[], currentTime: Date, t: any, departments: any[], language: 'en' | 'ml', onAppointmentConfirmed?: (appointmentId: string) => void }) => {
    const firestore = useFirestore();
    const router = useRouter();
    const { toast } = useToast();

    const reportingLabel = language === 'ml'
        ? 'ക്ലിനിക്കിൽ റിപ്പോർട്ട് ചെയ്യേണ്ട സമയം'
        : 'Estimated reporting time';
    const inLabel = t.liveToken?.in ?? (language === 'ml' ? 'ഇനി' : 'In');
    const daySingular = t.liveToken?.day ?? (language === 'ml' ? 'ദിവസം' : 'day');
    const dayPlural = t.liveToken?.days ?? (language === 'ml' ? 'ദിവസങ്ങൾ' : 'days');
    const hourSingular = t.liveToken?.hour ?? (language === 'ml' ? 'മണിക്കൂർ' : 'hour');
    const hourPlural = t.liveToken?.hours ?? (language === 'ml' ? 'മണിക്കൂർ' : 'hours');
    const minuteSingular = t.liveToken?.minute ?? (language === 'ml' ? 'മിനിറ്റ്' : 'minute');
    const minutePlural = t.liveToken?.minutes ?? (language === 'ml' ? 'മിനിറ്റുകൾ' : 'minutes');

    // Get doctor details
    const doctor = useMemo(() => {
        return doctors.find(d => d.name === yourAppointment?.doctor);
    }, [doctors, yourAppointment]);

    // Get clinic ID from doctor or appointment
    const clinicId = useMemo(() => {
        return doctor?.clinicId || yourAppointment?.clinicId || '';
    }, [doctor, yourAppointment]);

    // Get doctor ID
    const doctorId = useMemo(() => {
        return doctor?.id || yourAppointment?.doctorId || '';
    }, [doctor, yourAppointment]);

    // Get session index from appointment (default to 0 if not set)
    const sessionIndex = useMemo(() => {
        return yourAppointment?.sessionIndex ?? 0;
    }, [yourAppointment]);

    // Queue state using standardized queue management service
    const [queueState, setQueueState] = useState<QueueState | null>(null);

    useEffect(() => {
        if (!yourAppointment || !doctorId || !clinicId || !doctor || !firestore) return;

        const computeQueueState = async () => {
            try {
                const state = await computeQueues(
                    allTodaysAppointments,
                    yourAppointment.doctor,
                    doctorId,
                    clinicId,
                    yourAppointment.date,
                    sessionIndex
                );
                setQueueState(state);
            } catch (error) {
                console.error('Error computing queues:', error);
                // Fallback to empty state
                setQueueState({
                    arrivedQueue: [],
                    bufferQueue: [],
                    skippedQueue: [],
                    currentConsultation: null,
                    consultationCount: 0,
                });
            }
        };

        computeQueueState();
    }, [allTodaysAppointments, yourAppointment, doctorId, clinicId, sessionIndex, firestore]);

    // Helper function to parse appointment time
    const parseAppointmentTime = useCallback((apt: Appointment): Date => {
        try {
            const appointmentDate = parse(apt.date, 'd MMMM yyyy', new Date());
            return parseTime(apt.time, appointmentDate);
        } catch {
            return new Date(0); // Fallback for invalid dates
        }
    }, []);

    // Get clinic data
    const [clinicData, setClinicData] = useState<any | null>(null);
    useEffect(() => {
        if (!clinicId || !firestore) return;

        const fetchClinicData = async () => {
            try {
                const clinicRef = doc(firestore, 'clinics', clinicId);
                const clinicDoc = await getDoc(clinicRef);
                if (clinicDoc.exists()) {
                    setClinicData(clinicDoc.data());
                }
            } catch (error) {
                console.error('Error fetching clinic data:', error);
            }
        };

        fetchClinicData();
    }, [clinicId, firestore]);

    // Simulate where a skipped appointment would be placed if it rejoined now
    // Simulate where a skipped appointment would be placed if it rejoined now
    const simulateSkippedRejoinTime = useCallback((skippedAppointment: Appointment): Date | null => {
        try {
            if (!skippedAppointment.time || !skippedAppointment.noShowTime) return null;

            const now = new Date(); // In actual use, this would be when they rejoin
            const appointmentDate = parse(skippedAppointment.date, 'd MMMM yyyy', new Date());
            const scheduledTime = parseTime(skippedAppointment.time, appointmentDate);

            // Handle noShowTime as Firestore Timestamp or Date
            let noShowDate: Date;
            if ((skippedAppointment.noShowTime as any)?.toDate) {
                noShowDate = (skippedAppointment.noShowTime as any).toDate();
            } else {
                noShowDate = new Date(skippedAppointment.noShowTime as any);
            }

            if (isAfter(now, scheduledTime)) {
                // Current time past the 'time' -> noShowTime + 15 minutes
                return addMinutes(noShowDate, 15);
            } else {
                // Current time didn't pass 'time' -> noShowTime
                return noShowDate;
            }
        } catch (error) {
            console.error('Error simulating skipped rejoin time:', error);
            return null;
        }
    }, []);

    // Build simulated queue that includes Pending, Confirmed, and Skipped (if they would rejoin before you)
    const simulatedQueue = useMemo(() => {
        if (!yourAppointment || !allTodaysAppointments || !clinicData) {
            // Fallback to current masterQueue if data not ready
            return queueState?.arrivedQueue || [];
        }


        // Get all appointments for this doctor and date (including your appointment)
        const relevantAppointments = allTodaysAppointments.filter(apt =>
            apt.doctor === yourAppointment.doctor &&
            apt.date === yourAppointment.date &&
            apt.status !== 'Cancelled' &&
            apt.status !== 'No-show'
            // Include your appointment so we can find its position in the queue
        );

        // Get Pending and Confirmed appointments (these are at their current positions)
        const pendingAndConfirmed = relevantAppointments.filter(apt =>
            apt.status === 'Pending' || apt.status === 'Confirmed'
        );

        // Get Skipped appointments (excluding your appointment if you're skipped, since we handle you separately)
        const skippedAppointments = relevantAppointments.filter(apt =>
            apt.status === 'Skipped' && apt.id !== yourAppointment.id
        );

        // For each skipped appointment, simulate where it would be placed if it rejoined now
        const simulatedSkippedAppointments: Array<{ appointment: Appointment; simulatedTime: Date }> = [];
        for (const skipped of skippedAppointments) {
            const simulatedTime = simulateSkippedRejoinTime(skipped);
            if (simulatedTime) {
                // Create a temporary appointment object with the simulated time for sorting
                const simulatedApt = {
                    ...skipped,
                    time: format(simulatedTime, 'hh:mm a')
                };
                simulatedSkippedAppointments.push({ appointment: simulatedApt, simulatedTime });
            }
        }

        // Get your appointment's time for comparison
        const yourAppointmentTime = parseAppointmentTime(yourAppointment);

        const yourNaturalIndex = pendingAndConfirmed.findIndex(a => a.id === yourAppointment.id);
        const isTopPosition = yourNaturalIndex !== -1 && yourNaturalIndex <= 1; // 1st or 2nd position (0 or 1)

        // Build the complete queue: pending/confirmed + skipped (only if they would be before you)
        const queue: Array<{ appointment: Appointment; queueTime: Date }> = [];

        // Add Pending and Confirmed appointments at their current time
        for (const apt of pendingAndConfirmed) {
            // If in top 2 positions, exclude other Pending tokens from the count
            // This ensures stability once you are "Next" or "Current"
            if (isTopPosition && apt.status === 'Pending' && apt.id !== yourAppointment.id) {
                continue;
            }
            const aptTime = parseAppointmentTime(apt);
            queue.push({ appointment: apt, queueTime: aptTime });
        }

        // Add Skipped appointments only if they would be placed before your appointment
        // AND we are NOT in the top 2 positions
        if (!isTopPosition) {
            for (const { appointment, simulatedTime } of simulatedSkippedAppointments) {
                if (simulatedTime.getTime() < yourAppointmentTime.getTime()) {
                    queue.push({ appointment, queueTime: simulatedTime });
                }
            }
        }

        // Sort using shared logic
        queue.sort((a, b) => compareAppointments(a.appointment, b.appointment));

        // Return just the appointments in order
        return queue.map(item => item.appointment);
    }, [yourAppointment, allTodaysAppointments, clinicData, parseAppointmentTime, simulateSkippedRejoinTime, queueState]);

    // 1. Master queue is the simulated queue (includes Pending, Confirmed, and Skipped if they would rejoin before you)
    const masterQueue = useMemo(() => {
        // Use simulated queue if we have all necessary data, otherwise fallback to arrivedQueue
        if (simulatedQueue.length > 0 || (clinicData && yourAppointment)) {
            return simulatedQueue;
        }
        // Fallback to current behavior if data not ready
        if (queueState) {
            return queueState.arrivedQueue;
        }
        return [];
    }, [simulatedQueue, queueState, clinicData, yourAppointment]);

    // All tokens for this doctor today (sorted by time)
    const doctorAppointmentsToday = useMemo(() => {
        if (!yourAppointment) return [];
        return allTodaysAppointments
            .filter(apt =>
                apt.doctor === yourAppointment.doctor &&
                apt.date === yourAppointment.date &&
                apt.status !== 'Cancelled' &&
                apt.status !== 'No-show'
            )
            .sort(compareAppointments);
    }, [allTodaysAppointments, yourAppointment]);

    // Check if your appointment is in buffer queue
    const isInBufferQueue = useMemo(() => {
        if (!queueState || !yourAppointment) return false;
        return queueState.bufferQueue.some(apt => apt.id === yourAppointment.id);
    }, [queueState, yourAppointment]);

    // Calculate cutoff time for display: use original cutOffTime + doctorDelayMinutes
    // Status transitions use original cutOffTime (never delayed), but we show delayed time to user
    const cutoffTime = useMemo(() => {
        if (!yourAppointment) return null;
        try {
            const appointmentDate = parse(yourAppointment.date, "d MMMM yyyy", new Date());
            const appointmentTime = parseTime(yourAppointment.time, appointmentDate);

            // Get original cutoff time (appointment time - 15 minutes)
            let originalCutOffTime: Date;
            if (yourAppointment.cutOffTime) {
                // Use stored cutOffTime from Firestore (original, never delayed)
                const cutOffDate = yourAppointment.cutOffTime instanceof Date
                    ? yourAppointment.cutOffTime
                    : yourAppointment.cutOffTime?.toDate
                        ? yourAppointment.cutOffTime.toDate()
                        : new Date(yourAppointment.cutOffTime);
                if (cutOffDate instanceof Date && !isNaN(cutOffDate.getTime())) {
                    originalCutOffTime = cutOffDate;
                } else {
                    originalCutOffTime = subMinutes(appointmentTime, 15);
                }
            } else {
                // Calculate from appointment time
                originalCutOffTime = subMinutes(appointmentTime, 15);
            }

            // Add doctor delay for display purposes (status transitions use original time)
            const doctorDelay = yourAppointment.doctorDelayMinutes || 0;
            return addMinutes(originalCutOffTime, doctorDelay);
        } catch {
            return null;
        }
    }, [yourAppointment]);

    // Track position changes for message display
    const previousPositionRef = useRef<number | null>(null);
    const previousStatusRef = useRef<string | null>(null);
    const previousIsInBufferRef = useRef<boolean>(false);
    const [positionChangeMessage, setPositionChangeMessage] = useState<{
        type: 'improved' | 'worsened' | 'buffer' | 'next' | 'status' | null;
        text: string;
    } | null>(null);

    // 2. The current token is always the first in the master queue
    const currentTokenAppointment = useMemo(() => masterQueue[0] || null, [masterQueue]);

    // 3. Patients ahead is your index in the master queue (simulated queue that includes Pending, Confirmed, and Skipped)
    const patientsAhead = useMemo(() => {
        if (!yourAppointment) return 0;
        const yourIndex = masterQueue.findIndex(a => a.id === yourAppointment.id);
        // If you are not in the queue, show 0 (shouldn't happen if you're Pending or Confirmed)
        if (yourIndex === -1) return 0;
        return yourIndex;
    }, [yourAppointment, masterQueue]);


    const estimatedDelay = useMemo(() => {
        if (!currentTokenAppointment) return 0;
        try {
            const appointmentTime = parseAppointmentDateTime(currentTokenAppointment.date, currentTokenAppointment.time);
            const diff = differenceInMinutes(currentTime, appointmentTime);
            return Math.max(0, diff);
        } catch {
            return 0;
        }
    }, [currentTokenAppointment, currentTime]);

    const isYourTurn = yourAppointment?.id === currentTokenAppointment?.id;

    // Calculate days until appointment
    const daysUntilAppointment = useMemo(() => {
        if (!yourAppointment) return null;
        try {
            const appointmentDate = parse(yourAppointment.date, "d MMMM yyyy", new Date());
            const today = startOfDay(new Date());
            const apptDay = startOfDay(appointmentDate);
            return differenceInDays(apptDay, today);
        } catch {
            return null;
        }
    }, [yourAppointment]);

    // Check if appointment is today
    const isAppointmentToday = useMemo(() => {
        if (!yourAppointment) return false;
        try {
            const appointmentDate = parse(yourAppointment.date, "d MMMM yyyy", new Date());
            return isToday(appointmentDate);
        } catch {
            return false;
        }
    }, [yourAppointment]);

    // Find doctor for yourAppointment
    const yourAppointmentDoctor = useMemo(() => {
        if (!yourAppointment) return null;
        return doctors.find(d => d.name === yourAppointment.doctor) || null;
    }, [yourAppointment, doctors]);

    const arrivalReminderDateTime = useMemo(() => {
        if (!yourAppointment) return null;
        try {
            const appointmentDate = parse(yourAppointment.date, "d MMMM yyyy", new Date());
            const arriveByString = getArriveByTimeFromAppointment(yourAppointment, yourAppointmentDoctor);
            return parse(arriveByString, "hh:mm a", appointmentDate);
        } catch {
            try {
                const scheduledDateTime = parseAppointmentDateTime(yourAppointment.date, yourAppointment.time);
                // For direct fallback, we still subtract 15 for non-walk-ins if getArriveByTimeFromAppointment failed
                const isWalkIn = yourAppointment.tokenNumber?.startsWith('W');
                return isWalkIn ? scheduledDateTime : subMinutes(scheduledDateTime, 15);
            } catch {
                return null;
            }
        }
    }, [yourAppointment, yourAppointmentDoctor]);

    const hoursUntilArrivalReminder = useMemo(() => {
        if (!arrivalReminderDateTime || !isAppointmentToday) return null;
        try {
            const diff = differenceInHours(arrivalReminderDateTime, currentTime);
            return Math.max(0, diff);
        } catch {
            return null;
        }
    }, [arrivalReminderDateTime, currentTime, isAppointmentToday]);

    const formatReportByTime = useCallback((appointment: Appointment | null, doctor?: Doctor | null) => {
        if (!appointment) return '--';
        try {
            return getArriveByTimeFromAppointment(appointment, doctor);
        } catch {
            return appointment.arriveByTime || appointment.time || '--';
        }
    }, []);

    const reportByTimeDisplay = useMemo(() => getReportByTimeLabel(yourAppointment, yourAppointmentDoctor), [yourAppointment, yourAppointmentDoctor]);

    const reportByDiffMinutes = useMemo(() => {
        if (!arrivalReminderDateTime) return null;
        try {
            return differenceInMinutes(arrivalReminderDateTime, currentTime);
        } catch {
            return null;
        }
    }, [arrivalReminderDateTime, currentTime]);

    const minutesUntilArrivalReminder = useMemo(() => {
        if (!arrivalReminderDateTime || !isAppointmentToday || hoursUntilArrivalReminder === null) return null;
        // if (hoursUntilArrivalReminder > 0) return null; // Removed to allow precision for hours > 0
        try {
            const diff = differenceInMinutes(arrivalReminderDateTime, currentTime);
            return Math.max(0, diff);
        } catch {
            return null;
        }
    }, [arrivalReminderDateTime, currentTime, isAppointmentToday, hoursUntilArrivalReminder]);

    const reportingCountdownLabel = useMemo(() => {
        if (reportByDiffMinutes === null) return null;

        const minutesValue = Math.abs(reportByDiffMinutes);
        const minutesPerDay = 24 * 60;

        const formatLabel = (value: number, singular: string, plural: string) => {
            const absValue = Math.max(1, value);
            const unitLabel = absValue === 1 ? singular : plural;
            if (reportByDiffMinutes < 0) {
                return `-${absValue} ${unitLabel}`;
            }
            return `${inLabel} ${absValue} ${unitLabel}`;
        };

        if (minutesValue >= minutesPerDay) {
            const days = Math.floor(minutesValue / minutesPerDay);
            return formatLabel(days, daySingular, dayPlural);
        }

        if (minutesValue >= 60) {
            const hours = Math.floor(minutesValue / 60);
            const remainingMinutes = Math.floor(minutesValue % 60);
            const hoursPart = formatLabel(hours, hourSingular, hourPlural);

            if (remainingMinutes > 0) {
                const minutesPart = formatLabel(remainingMinutes, minuteSingular, minutePlural);
                // Remove prefix from minutes part to avoid "In 4 hours In 50 minutes"
                // The formatLabel adds the prefix, so we handle basic concatenation here carefully
                // But formatLabel adds "In " or "-" based on sign. 
                // Let's refactor to clean this up or just use string manipulation.
                // Simpler approach: Reconstruct the string manually for combined units or adjust formatLabel usage.

                // Let's rewrite the block to be cleaner
                const absHours = Math.max(1, hours);
                const absMinutes = remainingMinutes;

                const hoursLabel = absHours === 1 ? hourSingular : hourPlural;
                const minutesLabel = absMinutes === 1 ? minuteSingular : minutePlural;

                const timeString = `${absHours} ${hoursLabel} ${absMinutes} ${minutesLabel}`;

                if (reportByDiffMinutes < 0) {
                    return `-${timeString}`;
                }
                return `${inLabel} ${timeString}`;
            }

            return formatLabel(hours, hourSingular, hourPlural);
        }

        const mins = Math.max(1, Math.round(minutesValue));
        return formatLabel(mins, minuteSingular, minutePlural);
    }, [reportByDiffMinutes, inLabel, daySingular, dayPlural, hourSingular, hourPlural, minuteSingular, minutePlural]);

    const isReportingPastDue = reportByDiffMinutes !== null && reportByDiffMinutes < 0;

    const isReportingLate = useMemo(() => (reportByDiffMinutes ?? 0) < 0, [reportByDiffMinutes]);

    // Calculate appointment date for reuse
    const appointmentDate = useMemo(() => {
        if (!yourAppointment) return new Date();
        try {
            return parse(yourAppointment.date, "d MMMM yyyy", new Date());
        } catch {
            return new Date();
        }
    }, [yourAppointment]);

    // Format date with Malayalam month support
    const formattedDate = useMemo(() => {
        if (!yourAppointment) return '';
        try {
            if (language === 'ml') {
                const day = format(appointmentDate, 'd');
                const month = formatDate(appointmentDate, 'MMMM', language);
                const year = format(appointmentDate, 'yyyy');
                return `${day} ${month} ${year}`;
            }
            return yourAppointment.date;
        } catch {
            return yourAppointment.date;
        }
    }, [yourAppointment, language, appointmentDate]);

    // Check if consultation time has arrived
    const isConsultationTime = useMemo(() => {
        if (!yourAppointment) return false;
        try {
            const appointmentDateTime = parseAppointmentDateTime(yourAppointment.date, yourAppointment.time);
            return currentTime >= appointmentDateTime;
        } catch {
            return false;
        }
    }, [yourAppointment, currentTime]);

    // Doctor is already defined above

    // Calculate delays for all appointments (after doctor is defined)
    const delayMap = useMemo(() => {
        if (!doctor || !currentTokenAppointment) return new Map<string, number>();

        const avgTime = doctor.averageConsultingTime || 5;
        return calculateDelayForAppointments(
            masterQueue,
            currentTokenAppointment,
            avgTime,
            currentTime
        );
    }, [masterQueue, currentTokenAppointment, doctor, currentTime]);

    // Get delay for your appointment
    const yourDelay = useMemo(() => {
        if (!yourAppointment) return 0;
        return delayMap.get(yourAppointment.id) || 0;
    }, [delayMap, yourAppointment]);

    // Calculate estimated wait time (after doctor and yourDelay are defined)
    // Note: patientsAhead includes the current token (index 0), but current token is already being processed
    // So we subtract 1 from patientsAhead to get only the people who need full consultation slots
    const estimatedWaitTime = useMemo(() => {
        if (!yourAppointment || !doctor) return 0;
        const avgTime = doctor.averageConsultingTime || 5;
        // Subtract 1 because the current token (patientsAhead = 0) is already being processed
        const actualPatientsAhead = Math.max(0, patientsAhead - 1);
        return actualPatientsAhead * avgTime + yourDelay;
    }, [patientsAhead, doctor, yourAppointment, yourDelay]);

    // Calculate estimated consultation time based on scheduled time and total delay
    const totalDelayMinutes = useMemo(() => {
        if (!yourAppointment) return yourDelay;
        const doctorDelay = yourAppointment.doctorDelayMinutes || 0;
        return Math.max(0, yourDelay + doctorDelay);
    }, [yourAppointment, yourDelay]);

    const estimatedConsultationTime = useMemo(() => {
        if (!yourAppointment) return null;
        try {
            const appointmentDateTime = parseAppointmentDateTime(yourAppointment.date, yourAppointment.time);
            return addMinutes(appointmentDateTime, totalDelayMinutes);
        } catch {
            return null;
        }
    }, [yourAppointment, totalDelayMinutes]);

    const isDoctorIn = doctor?.consultationStatus === 'In';

    const doctorStatusInfo = useMemo(() => {
        if (!yourAppointment || !doctor?.availabilitySlots) {
            return { isLate: false, isBreak: false, isAffected: false };
        }

        try {
            const appointmentDateTime = parseAppointmentDateTime(yourAppointment.date, yourAppointment.time);
            const dateKey = format(appointmentDateTime, 'd MMMM yyyy');
            const breaks = doctor.breakPeriods?.[dateKey] || [];

            if (breaks.length === 0) return { isLate: false, isBreak: false, isAffected: false };

            const dayOfWeek = format(appointmentDateTime, 'EEEE');
            const dayAvailability = doctor.availabilitySlots.find(slot => slot.day === dayOfWeek);
            if (!dayAvailability || !dayAvailability.timeSlots.length) return { isLate: false, isBreak: false, isAffected: false };

            const firstSession = dayAvailability.timeSlots[0];
            const firstSlotTime = parseTime(firstSession.from, appointmentDateTime);

            const affectingBreak = breaks.find((bp: any) => {
                const start = parseISO(bp.startTime);
                const end = parseISO(bp.endTime);
                return isWithinInterval(appointmentDateTime, { start, end });
            });

            const isAffected = !!affectingBreak;
            let isLate = false;
            let isBreak = false;

            if (isAffected && affectingBreak) {
                const bpStart = parseISO(affectingBreak.startTime);
                if (differenceInMinutes(bpStart, firstSlotTime) <= 30) {
                    isLate = true;
                } else {
                    isBreak = true;
                }
            }

            return { isLate, isBreak, isAffected };
        } catch {
            return { isLate: false, isBreak: false, isAffected: false };
        }
    }, [yourAppointment, doctor]);

    const breakMinutes = useMemo(() => {
        if (!yourAppointment || !doctor?.breakPeriods) return 0;
        try {
            const appointmentDateTime = parseAppointmentDateTime(yourAppointment.date, yourAppointment.time);
            const dateKey = format(appointmentDateTime, 'd MMMM yyyy');
            const breaks = doctor.breakPeriods[dateKey] || [];

            if (breaks.length === 0) return 0;

            const now = new Date();

            for (const bp of breaks) {
                const end = parseISO(bp.endTime);
                const start = parseISO(bp.startTime);
                if (isAfter(end, now) && isBefore(start, now)) {
                    return Math.max(0, differenceInMinutes(end, now));
                }
            }

            return 0;
        } catch {
            return 0;
        }
    }, [yourAppointment, doctor, currentTime]);

    const confirmedStatusBanner = useMemo(() => {
        if (yourAppointment?.status !== 'Confirmed') return null;

        const { isBreak, isLate, isAffected } = doctorStatusInfo;

        // Check if there are active (ongoing) break minutes remaining
        const hasActiveBreak = breakMinutes > 0;

        // If doctor has active break AND is 'Out', OR if late/affected, show "Doctor is late today"
        if ((hasActiveBreak && !isDoctorIn) || isLate || isAffected) {
            return {
                text: t.liveToken?.doctorIsLate || (language === 'ml' ? 'ഡോക്ടർ ഇന്ന് വൈകി' : 'Doctor is late today'),
                className: 'text-red-600',
            };
        }

        // If doctor is 'In' (consultation has started), show appropriate message
        if (isDoctorIn) {
            if (patientsAhead === 0) {
                return {
                    text: language === 'ml' ? 'ദയവായി കൺസൾട്ടേഷൻ റൂമിലേക്ക് പോകുക' : 'Please go to the consultation room',
                    className: 'text-green-600',
                };
            }
            return {
                text: language === 'ml' ? 'കൺസൾട്ടേഷൻ നടന്നുകൊണ്ടിരിക്കുന്നു' : 'Consultation in progress',
                className: 'text-green-600',
            };
        }

        // Doctor is 'Out' - consultation hasn't started yet
        return {
            text: language === 'ml' ? 'പരിശോധന ഉടൻ ആരംഭിക്കും' : 'Consultation starting soon',
            className: 'text-green-600',
        };
    }, [
        yourAppointment?.status,
        breakMinutes,
        doctorStatusInfo.isBreak,
        doctorStatusInfo.isLate,
        doctorStatusInfo.isAffected,
        isDoctorIn,
        patientsAhead,
        t.liveToken,
        language,
    ]);

    const isConfirmedAppointment = yourAppointment?.status === 'Confirmed';
    const isPendingAppointment = yourAppointment?.status === 'Pending';
    const shouldHideArriveByDetails = isPendingAppointment && isReportingPastDue;

    // Show queue info only for confirmed appointments once the doctor is "In"
    const shouldShowQueueInfo = isDoctorIn && isAppointmentToday && isConfirmedAppointment;
    const shouldShowQueueVisualization = isDoctorIn && isAppointmentToday && (isConfirmedAppointment || isPendingAppointment);

    // scheduledPatientsAhead: Use the same simulated queue logic as patientsAhead
    // This ensures consistent counting for both queue visualization and queue info display
    const scheduledPatientsAhead = useMemo(() => {
        // Use the same logic as patientsAhead - the simulated queue already includes:
        // - Pending appointments (at their current position)
        // - Confirmed appointments (at their current position)
        // - Skipped appointments (only if they would rejoin before you)
        return patientsAhead;
    }, [patientsAhead]);

    const displayedPatientsAhead = shouldShowQueueVisualization ? scheduledPatientsAhead : patientsAhead;

    const isCutoffWithinTwoHours = useMemo(() => {
        if (!cutoffTime) return false;
        const minutes = differenceInMinutes(cutoffTime, currentTime);
        return minutes >= -5 && minutes <= 120;
    }, [cutoffTime, currentTime]);

    const shouldShowConfirmArrival = useMemo(() => {
        if (!yourAppointment) return false;
        if (yourAppointment.status !== 'Pending' && yourAppointment.status !== 'Skipped') return false;
        if (!isAppointmentToday) return false;

        // Skipped: always allow on the same day
        if (yourAppointment.status === 'Skipped') return true;

        // Pending: always allow on the same day, regardless of doctor status or cutoff window
        if (yourAppointment.status === 'Pending') {
            return true;
        }

        // Fallback (should not hit due to status guard)
        return isCutoffWithinTwoHours;
    }, [yourAppointment, isAppointmentToday, isCutoffWithinTwoHours]);

    const [isConfirmingInline, setIsConfirmingInline] = useState(false);
    const [clinicLocation, setClinicLocation] = useState<{ lat: number; lng: number } | null>(null);
    const [clinicLocationLoaded, setClinicLocationLoaded] = useState(false);
    const [locationStatus, setLocationStatus] = useState<'idle' | 'checking' | 'success' | 'error'>('idle');
    const [locationError, setLocationError] = useState<string | null>(null);
    const [locationDenied, setLocationDenied] = useState(false);
    const [inlineError, setInlineError] = useState<string | null>(null);
    const [locationCheckAttempted, setLocationCheckAttempted] = useState(false);

    const locationComplete = locationStatus === 'success';

    // Determine no-show deadline (arrival cutoff) for allowing "Confirm Arrival"
    const noShowDeadline = useMemo(() => {
        if (!yourAppointment) return null;
        try {
            const appointmentDate = parse(yourAppointment.date, "d MMMM yyyy", new Date());

            // Prefer stored noShowTime if available
            if (yourAppointment.noShowTime) {
                if (yourAppointment.noShowTime instanceof Date && !isNaN(yourAppointment.noShowTime.getTime())) {
                    return yourAppointment.noShowTime;
                }
                if (typeof (yourAppointment.noShowTime as any)?.toDate === 'function') {
                    return (yourAppointment.noShowTime as any).toDate();
                }
                if (typeof yourAppointment.noShowTime === 'string') {
                    try {
                        return parse(yourAppointment.noShowTime, "hh:mm a", appointmentDate);
                    } catch {
                        return new Date(yourAppointment.noShowTime);
                    }
                }
                if (typeof yourAppointment.noShowTime === 'number') {
                    return new Date(yourAppointment.noShowTime);
                }
            }

            // Fallback: appointment time + 15 minutes
            const apptTime = parse(yourAppointment.time, "hh:mm a", appointmentDate);
            return addMinutes(apptTime, 15);
        } catch {
            return null;
        }
    }, [yourAppointment]);

    useEffect(() => {
        if (!shouldShowConfirmArrival) return;
        if (!clinicId || !firestore) return;
        if (clinicLocationLoaded) return;

        const fetchClinicLocation = async () => {
            try {
                const clinicSnap = await getDoc(doc(firestore, 'clinics', clinicId));
                if (clinicSnap.exists()) {
                    const clinicData = clinicSnap.data();
                    if (typeof clinicData.latitude === 'number' && typeof clinicData.longitude === 'number') {
                        setClinicLocation({ lat: clinicData.latitude, lng: clinicData.longitude });
                    } else {
                        setClinicLocation(null);
                        setLocationError(language === 'ml' ? 'ക്ലിനിക് ലൊക്കേഷൻ ലഭ്യമല്ല.' : 'Clinic location not available.');
                    }
                } else {
                    setLocationError(language === 'ml' ? 'ക്ലിനിക് കണ്ടെത്തിയിട്ടില്ല.' : 'Clinic not found.');
                }
            } catch (err) {
                console.error('Error fetching clinic details', err);
                setLocationError(language === 'ml' ? 'ക്ലിനിക് വിവരങ്ങൾ ലഭ്യമാക്കാൻ കഴിയില്ല.' : 'Unable to load clinic details.');
            } finally {
                setClinicLocationLoaded(true);
            }
        };

        fetchClinicLocation();
    }, [shouldShowConfirmArrival, clinicId, firestore, language, clinicLocationLoaded]);

    useEffect(() => {
        if (!shouldShowConfirmArrival) {
            setLocationStatus('idle');
            setLocationError(null);
            setLocationDenied(false);
            setLocationCheckAttempted(false);
        }
    }, [shouldShowConfirmArrival]);

    const handleLocationCheck = () => {
        setLocationCheckAttempted(true);
        setLocationDenied(false);

        if (locationStatus === 'success') {
            return Promise.resolve(true);
        }

        return new Promise<boolean>((resolve) => {
            if (!clinicLocation) {
                setLocationError(language === 'ml' ? 'ക്ലിനിക് ലൊക്കേഷൻ ലഭ്യമല്ല.' : 'Clinic location is not available.');
                setLocationStatus('error');
                return resolve(false);
            }
            if (!navigator.geolocation) {
                setLocationError(language === 'ml' ? 'ഈ ഉപകരണത്തിൽ ലൊക്കേഷൻ ലഭ്യമല്ല.' : 'Geolocation is not supported on this device.');
                setLocationStatus('error');
                return resolve(false);
            }

            setLocationStatus('checking');
            setLocationError(null);
            navigator.geolocation.getCurrentPosition(
                (position) => {
                    const { latitude, longitude } = position.coords;
                    const distance = calculateDistance(latitude, longitude, clinicLocation.lat, clinicLocation.lng);
                    if (distance <= 200) {
                        setLocationStatus('success');
                        resolve(true);
                    } else {
                        setLocationStatus('error');
                        setLocationError(language === 'ml'
                            ? `നിങ്ങൾ ഇപ്പോൾ ക്ലിനികിൽ നിന്ന് ${Math.round(distance)} മീറ്റർ അകലെ ആണ്. ദയവായി 200 മീറ്റർ പരിധിക്കുള്ളിൽ ഇരിക്കുക.`
                            : `You are ${Math.round(distance)} meters away. Please be within 200 meters of the clinic.`);
                        resolve(false);
                    }
                },
                (error) => {
                    setLocationStatus('error');
                    if (error.code === error.PERMISSION_DENIED) {
                        setLocationDenied(true);
                        setLocationError(language === 'ml'
                            ? 'ലൊക്കേഷൻ അനുമതി നിഷേധിച്ചിട്ടുണ്ട്. നിങ്ങളുടെ ബ്രൗസറിൽ നിന്ന് അനുമതി അനുവദിക്കുക.'
                            : 'Location permission denied. Please allow access from your browser settings.');
                    } else if (error.code === error.POSITION_UNAVAILABLE) {
                        setLocationError(language === 'ml'
                            ? 'ലൊക്കേഷൻ ലഭ്യമല്ല. വീണ്ടും ശ്രമിക്കുക.'
                            : 'Location unavailable. Please try again.');
                    } else if (error.code === error.TIMEOUT) {
                        setLocationError(language === 'ml'
                            ? 'ലൊക്കേഷൻ പരിശോഥിക്കാൻ സമയം കഴിഞ്ഞു. വീണ്ടും ശ്രമിക്കുക.'
                            : 'Location check timed out. Please try again.');
                    } else {
                        setLocationError(error.message);
                    }
                    resolve(false);
                },
                {
                    enableHighAccuracy: true,
                    timeout: 10000,
                    maximumAge: 0,
                }
            );
        });
    };

    const handleConfirmArrivalInline = async () => {
        if (!firestore || !yourAppointment) return;
        setIsConfirmingInline(true);
        setInlineError(null);

        // For skipped appointments, skip time window check - they can always rejoin
        // For pending appointments, allow until no-show deadline
        if (yourAppointment.status === 'Pending') {
            const deadline = noShowDeadline;
            if (deadline && isAfter(currentTime, deadline)) {
                setInlineError(language === 'ml'
                    ? 'റിപ്പോർട്ട് സമയം കഴിഞ്ഞിരിക്കുന്നു.'
                    : 'Reporting window has closed.');
                setIsConfirmingInline(false);
                return;
            }
        }

        let locationOk = locationComplete;
        if (!locationOk) {
            locationOk = await handleLocationCheck();
        }
        if (!locationOk) {
            setIsConfirmingInline(false);
            return;
        }

        try {
            const appointmentRef = doc(firestore, 'appointments', yourAppointment.id);

            // Helper function to parse appointment time
            const parseAppointmentTime = (apt: Appointment): Date => {
                try {
                    const appointmentDate = parse(apt.date, 'd MMMM yyyy', new Date());
                    return parseTime(apt.time, appointmentDate);
                } catch {
                    return new Date(0); // Fallback for invalid dates
                }
            };

            let newTimeString: string | null = null; // Track new time for skipped and pending appointments

            if (yourAppointment.status === 'Pending') {
                // For Pending appointments, simple status update
                await updateDoc(appointmentRef, {
                    status: 'Confirmed',
                    updatedAt: serverTimestamp()
                });
                // Get the appointment time to display in toast message
                const arriveByString = yourAppointment.arriveByTime || getArriveByTimeFromAppointment(yourAppointment, yourAppointmentDoctor);
                newTimeString = arriveByString;
            } else if (yourAppointment.status === 'Skipped') {
                // For Skipped appointments, rejoin queue using deterministic logic
                const now = new Date();
                const appointmentDate = parse(yourAppointment.date, 'd MMMM yyyy', new Date());
                const scheduledTime = parseTime(yourAppointment.time, appointmentDate);

                const noShowTime = (yourAppointment.noShowTime as any)?.toDate
                    ? (yourAppointment.noShowTime as any).toDate()
                    : parseTime(yourAppointment.noShowTime!, appointmentDate);

                if (isAfter(now, scheduledTime)) {
                    // If rejoined after scheduled time, give noShowTime + 15 mins
                    newTimeString = format(addMinutes(noShowTime, 15), 'hh:mm a');
                } else {
                    // If rejoined before scheduled time, give noShowTime
                    newTimeString = format(noShowTime, 'hh:mm a');
                }

                // Update the skipped appointment: only change status and time, keep everything else
                await updateDoc(appointmentRef, {
                    status: 'Confirmed',
                    time: newTimeString,
                    updatedAt: serverTimestamp()
                });
            } else {
                // For other statuses, just update status
                await updateDoc(appointmentRef, {
                    status: 'Confirmed',
                    updatedAt: serverTimestamp()
                });
            }

            setLocationStatus('success');

            // Prepare toast message based on status
            let toastTitle: string;
            let toastDescription: string;

            if (newTimeString) {
                // For both skipped and pending appointments, use the same message format with time
                toastTitle = language === 'ml' ? 'ചെക്ക്-ഇൻ വിജയകരം' : 'Check-in Successful';
                toastDescription = language === 'ml'
                    ? `നിങ്ങളെ ക്യൂവിൽ ചേർത്തിട്ടുണ്ട്. ഡോക്ടറെ കാണാനുള്ള സമയം: ${newTimeString}`
                    : `You have been added to the queue. Time to see the doctor: ${newTimeString}`;
            } else {
                // Fallback for other statuses (shouldn't normally happen)
                toastTitle = language === 'ml' ? 'ഉപസ്ഥിതി സ്ഥിരീകരിച്ചു' : 'Arrival confirmed';
                toastDescription = language === 'ml' ? 'ദയവായി നിങ്ങളുടെ വാരം കാത്തിരിക്കൂ.' : 'Please wait for your turn.';
            }

            toast({
                title: toastTitle,
                description: toastDescription,
            });
            onAppointmentConfirmed?.(yourAppointment.id);
        } catch (err: any) {
            console.error('Error confirming arrival', err);
            setInlineError(err?.message || (language === 'ml' ? 'സ്ഥിരീകരിക്കാനായില്ല. വീണ്ടും ശ്രമിക്കുക.' : 'Could not confirm arrival. Please try again.'));
        } finally {
            setIsConfirmingInline(false);
        }
    };

    // Detect position changes and update messages
    useEffect(() => {
        if (!yourAppointment || !shouldShowQueueInfo) {
            previousPositionRef.current = null;
            previousStatusRef.current = null;
            previousIsInBufferRef.current = false;
            setPositionChangeMessage(null);
            return;
        }

        const currentStatus = yourAppointment.status;
        const currentPosition = patientsAhead;
        const currentIsInBuffer = isInBufferQueue;

        // Initialize refs on first render
        if (previousPositionRef.current === null) {
            previousPositionRef.current = currentPosition;
            previousStatusRef.current = currentStatus;
            previousIsInBufferRef.current = currentIsInBuffer;
            return;
        }

        const prevPosition = previousPositionRef.current;
        const prevStatus = previousStatusRef.current;
        const prevIsInBuffer = previousIsInBufferRef.current;

        // Check for status change (Pending -> Confirmed)
        if (prevStatus === 'Pending' && currentStatus === 'Confirmed') {
            setPositionChangeMessage({
                type: 'status',
                text: language === 'ml'
                    ? 'നിങ്ങൾ എത്തിയതായി സ്ഥിരീകരിച്ചു! ക്യൂവിൽ ചേർന്നു.'
                    : 'Arrival confirmed! You\'re in the queue.'
            });
        }
        // Check for position changes (only after arrival)
        else if (currentStatus === 'Confirmed' && prevStatus === 'Confirmed') {
            // Check if moved to buffer (top 2)
            if (!prevIsInBuffer && currentIsInBuffer) {
                if (currentPosition === 0 || (currentPosition === 1 && queueState?.bufferQueue[0]?.id === yourAppointment.id)) {
                    setPositionChangeMessage({
                        type: 'next',
                        text: language === 'ml'
                            ? 'ദയവായി കൺസൾട്ടേഷൻ റൂമിലേക്ക് പോകുക.'
                            : 'Please go to the consultation room.'
                    });
                } else {
                    // Only show "Almost Your Turn" if doctor's consultation status is "In"
                    if (isDoctorIn) {
                        setPositionChangeMessage({
                            type: 'buffer',
                            text: language === 'ml'
                                ? 'നിങ്ങളുടെ വഴിയാണ്! ഉടൻ ഡോക്ടറെ കാണാം.'
                                : 'Almost Your Turn! You\'ll see the doctor soon.'
                        });
                    } else {
                        setPositionChangeMessage({
                            type: 'buffer',
                            text: language === 'ml'
                                ? 'കൺസൾട്ടേഷൻ ഉടൻ ആരംഭിക്കും'
                                : 'Consultation starting soon'
                        });
                    }
                }
            }
            // Check if position improved
            else if (currentPosition < prevPosition) {
                setPositionChangeMessage({
                    type: 'improved',
                    text: language === 'ml'
                        ? `നിങ്ങൾ മുന്നോട്ട് നീങ്ങി! ${currentPosition} ${currentPosition === 1 ? 'വ്യക്തി' : 'വ്യക്തികൾ'} മുന്നിൽ.`
                        : `You moved forward! ${currentPosition} ${currentPosition === 1 ? 'patient' : 'patients'} ahead.`
                });
            }
            // Check if position worsened
            else if (currentPosition > prevPosition) {
                setPositionChangeMessage({
                    type: 'worsened',
                    text: language === 'ml'
                        ? `മുമ്പ് വന്നവർ സ്ഥിരീകരിച്ചു. ${currentPosition} ${currentPosition === 1 ? 'വ്യക്തി' : 'വ്യക്തികൾ'} മുന്നിൽ.`
                        : `Earlier patients confirmed. ${currentPosition} ${currentPosition === 1 ? 'patient' : 'patients'} ahead now.`
                });
            }
        }

        // Update refs
        previousPositionRef.current = currentPosition;
        previousStatusRef.current = currentStatus;
        previousIsInBufferRef.current = currentIsInBuffer;
    }, [patientsAhead, yourAppointment?.status, isInBufferQueue, shouldShowQueueInfo, queueState, yourAppointment, language, isDoctorIn]);

    // Unified bottom message container
    const tokensAheadForConfirmed = useMemo(() => {
        if (!yourAppointment) return 0;
        const statuses = new Set(['Pending', 'Confirmed', 'Skipped']);
        const index = doctorAppointmentsToday.findIndex(appt => appt.id === yourAppointment.id);
        if (index <= 0) return 0;
        return doctorAppointmentsToday.slice(0, index).filter(appt => statuses.has(appt.status || '')).length;
    }, [doctorAppointmentsToday, yourAppointment]);

    const doctorDelayMinutes = yourAppointment?.doctorDelayMinutes || 0;

    const confirmedEstimatedWaitMinutes = useMemo(() => {
        if (!yourAppointment || yourAppointment.status !== 'Confirmed' || !doctor) return 0;
        const avgTime = doctor.averageConsultingTime || 5;
        const queueWait = tokensAheadForConfirmed * avgTime;

        if (isDoctorIn) {
            if (breakMinutes > 0) {
                return Math.max(0, breakMinutes + queueWait);
            }
            return Math.max(0, queueWait);
        }

        const appointmentDate = parse(yourAppointment.date, "d MMMM yyyy", new Date());
        const todaysSlots = doctor.availabilitySlots?.find(slot => slot.day === format(appointmentDate, 'EEEE'))?.timeSlots ?? [];
        const breakIntervalsForDay = buildBreakIntervals(doctor, appointmentDate);

        const nextSessionStart = todaysSlots.reduce<Date | null>((next, timeSlot) => {
            try {
                let sessionStart = parse(timeSlot.from, "hh:mm a", appointmentDate);

                // If a break overlaps the session start (including breaks that begin at availability start),
                // shift the effective start to the break end.
                const overlappingBreak = breakIntervalsForDay.find(interval =>
                    sessionStart.getTime() >= interval.start.getTime() &&
                    sessionStart.getTime() < interval.end.getTime()
                );
                if (overlappingBreak) {
                    sessionStart = overlappingBreak.end;
                }

                if (sessionStart.getTime() <= currentTime.getTime()) {
                    return next;
                }
                if (!next || sessionStart < next) {
                    return sessionStart;
                }
                return next;
            } catch {
                return next;
            }
        }, null);

        // Avoid double-counting break and next-session gap. Use the longer of the two waits.
        let minutesUntilNextSession = 0;
        if (nextSessionStart) {
            try {
                minutesUntilNextSession = Math.max(0, differenceInMinutes(nextSessionStart, currentTime));
            } catch {
                minutesUntilNextSession = 0;
            }
        }

        const minutesUntilBreakEnds = Math.max(0, breakMinutes);
        const additionalWait = Math.max(minutesUntilNextSession, minutesUntilBreakEnds);

        return queueWait + additionalWait;
    }, [yourAppointment, doctor, tokensAheadForConfirmed, breakMinutes, isDoctorIn, currentTime]);

    const BottomMessage = () => {
        const reportingLabel = language === 'ml'
            ? 'ക്ലിനിക്കിൽ റിപ്പോർട്ട് ചെയ്യേണ്ട സമയം'
            : 'Estimated reporting time';
        const daySingular = t.liveToken.day ?? (language === 'ml' ? 'ദിവസം' : 'day');
        const dayPlural = t.liveToken.days ?? (language === 'ml' ? 'ദിവസങ്ങൾ' : 'days');

        // Handle Skipped status - show "You are late" message
        if (!shouldShowQueueInfo && yourAppointment?.status === 'Confirmed') {
            const waitMinutes = confirmedEstimatedWaitMinutes;
            if (waitMinutes > 0) {
                const mins = Math.max(1, Math.round(waitMinutes));
                const hours = Math.floor(mins / 60);
                const remainingMinutes = mins % 60;
                let waitLabel: string;

                if (mins >= 60) {
                    const hourPart = language === 'ml'
                        ? `${hours} ${t.liveToken.hours}`
                        : `${hours} ${t.liveToken.hours}`;
                    const minutePart = remainingMinutes > 0
                        ? language === 'ml'
                            ? ` ${remainingMinutes} ${t.liveToken.minutes}`
                            : ` ${remainingMinutes} ${t.liveToken.minutes}`
                        : '';
                    waitLabel = `${hourPart}${minutePart}`;
                } else {
                    waitLabel = language === 'ml'
                        ? `${mins} ${t.liveToken.minutes}`
                        : `${mins} ${t.liveToken.minutes}`;
                }

                const waitTitle = language === 'ml'
                    ? 'ഏകദേശ കാത്തിരിപ്പ് സമയം'
                    : 'Estimated waiting time';

                const bgClass = (doctorStatusInfo.isAffected || breakMinutes > 0) ? 'bg-red-100 text-red-800' : 'bg-green-100 text-green-800';

                return (
                    <div className="w-full text-center py-4">
                        <div className={`${bgClass} rounded-full px-4 py-3 flex flex-col items-center justify-center gap-1`}>
                            <Hourglass className="w-6 h-6" />
                            <div className="flex flex-col items-center justify-center">
                                <span className="text-sm font-medium">{waitTitle}</span>
                                <span className="font-bold text-lg">{waitLabel}</span>
                            </div>
                        </div>
                    </div>
                );
            }
        }

        // Priority 1: If it's your turn during consultation
        if (shouldShowQueueInfo && isYourTurn) {
            return (
                <div className="w-full text-center py-4">
                    <div className="bg-green-100 text-green-800 rounded-full px-4 py-3 flex items-center justify-center gap-2">
                        <UserCheck className="w-6 h-6" />
                        <span className="font-bold text-lg">{t.liveToken.itsYourTurn}</span>
                    </div>
                </div>
            );
        }

        // Priority 2: If consultation started and exactly 1 person ahead
        if (shouldShowQueueInfo && patientsAhead === 1) {
            return (
                <div className="w-full text-center py-4">
                    <div className="bg-green-100 text-green-800 rounded-full px-4 py-3 flex items-center justify-center gap-2">
                        <Forward className="w-6 h-6" />
                        <span className="font-bold text-lg">
                            {language === 'ml' ? 'അടുത്തത് നിങ്ങളാണ്' : (t.liveToken.youAreNext || 'You are next')}
                        </span>
                    </div>
                </div>
            );
        }

        // Priority 3: If consultation started and multiple people ahead, show estimated waiting time in minutes
        if (shouldShowQueueInfo && patientsAhead > 1) {
            const avgConsultTime = doctor?.averageConsultingTime || 5;
            const waitMinutes = Math.max(1, Math.round(Math.max(0, patientsAhead) * avgConsultTime));
            const waitTitle = language === 'ml'
                ? 'ഏകദേശ കാത്തിരിപ്പ് സമയം'
                : 'Estimated waiting time';
            const waitLabel = language === 'ml'
                ? `${waitMinutes} ${t.liveToken.minutes || 'min'}`
                : `${waitMinutes} ${t.liveToken.minutes || 'min'}`;
            return (
                <div className="w-full text-center py-4">
                    <div className="bg-green-100 text-green-800 animate-pulse rounded-full px-4 py-3 flex flex-col items-center justify-center gap-1">
                        <Hourglass className="w-6 h-6" />
                        <div className="flex flex-col items-center justify-center">
                            <span className="text-sm font-medium">{waitTitle}</span>
                            <span className="font-bold text-lg">{waitLabel}</span>
                        </div>
                    </div>
                </div>
            );
        }

        // Priority 4: If doctor is 'In' (consultation started), show estimated reporting time for pending
        if (isDoctorIn && isAppointmentToday && daysUntilAppointment === 0 && !shouldShowQueueInfo && yourAppointment?.status !== 'Confirmed') {
            if (yourAppointment?.status === 'Pending') {
                if (isReportingPastDue) {
                    return null;
                }
                // Show red if there's an active break/affected status or if reporting time passed
                const bgClass = (breakMinutes > 0 || doctorStatusInfo.isAffected || isReportingPastDue)
                    ? 'bg-red-100 text-red-800'
                    : 'bg-green-100 text-green-800';
                const lateLabel = language === 'ml' ? 'നിങ്ങൾ വൈകി' : 'You are late';
                return (
                    <div className="w-full text-center py-4">
                        <div className={`${bgClass} rounded-full px-4 py-3 flex flex-col items-center justify-center gap-1`}>
                            <Hourglass className="w-6 h-6" />
                            <div className="flex flex-col items-center justify-center">
                                <span className="text-sm font-medium">{reportingLabel}</span>
                                <span className="font-bold text-lg">
                                    {isReportingPastDue ? lateLabel : (reportingCountdownLabel || '--')}
                                </span>
                            </div>
                        </div>
                    </div>
                );
            }
        }

        // Priority 5: If it's the day of appointment but doctor is 'Out' (consultation hasn't started yet)
        if (isAppointmentToday && daysUntilAppointment === 0 && !shouldShowQueueInfo && !isDoctorIn) {
            // Show red if there's an active break or if appointment is affected
            const bgClass = (breakMinutes > 0 || doctorStatusInfo.isAffected) ? 'bg-red-100 text-red-800' : 'bg-green-100 text-green-800';
            // If less than 1 hour, show "In X minutes"
            if (hoursUntilArrivalReminder === 0 && minutesUntilArrivalReminder !== null && minutesUntilArrivalReminder > 0) {
                return (
                    <div className="w-full text-center py-4">
                        <div className={`${bgClass} rounded-full px-4 py-3 flex flex-col items-center justify-center gap-1`}>
                            <Hourglass className="w-6 h-6" />
                            <div className="flex flex-col items-center justify-center">
                                <span className="text-sm font-medium">{reportingLabel}</span>
                                <span className="font-bold text-lg">
                                    {language === 'ml' ?
                                        `ഇനി ${minutesUntilArrivalReminder} ${t.liveToken.minutes}` :
                                        `${t.liveToken.in} ${minutesUntilArrivalReminder} ${t.liveToken.minutes}`
                                    }
                                </span>
                            </div>
                        </div>
                    </div>
                );
            }
            // If 1+ hours, show "In X hours" or "In 1 hour"
            if (hoursUntilArrivalReminder !== null && hoursUntilArrivalReminder > 0) {
                return (
                    <div className="w-full text-center py-4">
                        <div className={`${bgClass} rounded-full px-4 py-3 flex flex-col items-center justify-center gap-1`}>
                            <Hourglass className="w-6 h-6" />
                            <div className="flex flex-col items-center justify-center">
                                <span className="text-sm font-medium">{reportingLabel}</span>
                                <span className="font-bold text-lg">
                                    {(() => {
                                        // Calculate hours and remaining minutes from the total minutes
                                        // We use minutesUntilArrivalReminder which we enabled above for > 0 hours
                                        const totalMinutes = minutesUntilArrivalReminder || (hoursUntilArrivalReminder * 60);
                                        const hoursVal = Math.floor(totalMinutes / 60);
                                        const minsVal = totalMinutes % 60;

                                        const hoursLabel = hoursVal === 1 ? (t.liveToken.hour || (language === 'ml' ? 'മണിക്കൂർ' : 'hour')) : (t.liveToken.hours || (language === 'ml' ? 'മണിക്കൂർ' : 'hours'));
                                        const minutesLabel = minsVal === 1 ? (t.liveToken.minute || (language === 'ml' ? 'മിനിറ്റ്' : 'minute')) : (t.liveToken.minutes || (language === 'ml' ? 'മിനിറ്റുകൾ' : 'minutes'));

                                        const hoursPart = `${hoursVal} ${hoursLabel}`;
                                        const minutesPart = minsVal > 0 ? ` ${minsVal} ${minutesLabel}` : '';

                                        if (language === 'ml') {
                                            return `ഇനി ${hoursPart}${minutesPart}`;
                                        }
                                        return `${t.liveToken.in} ${hoursPart}${minutesPart}`;
                                    })()}
                                </span>
                            </div>
                        </div>
                    </div>
                );
            }
        }

        // Priority 6: If future appointment, show "Estimated consultation time: In X days" or "tomorrow"
        if (daysUntilAppointment !== null && daysUntilAppointment > 0) {
            // Show red if there's an active break or if appointment is affected
            const bgClass = (breakMinutes > 0 || doctorStatusInfo.isAffected) ? 'bg-red-100 text-red-800' : 'bg-green-100 text-green-800';

            let countdownLabel: string;
            let minutesUntilArrival: number | null = null;
            try {
                const arrivalString = getArriveByTimeFromAppointment(yourAppointment, yourAppointmentDoctor);
                const appointmentDate = parse(yourAppointment.date, "d MMMM yyyy", new Date());
                const arriveByDateTime = parse(arrivalString, "hh:mm a", appointmentDate);
                const reminderDateTime = subMinutes(arriveByDateTime, 15);
                minutesUntilArrival = differenceInMinutes(reminderDateTime, currentTime);
            } catch {
                minutesUntilArrival = null;
            }

            const hasValidCountdown = minutesUntilArrival !== null && minutesUntilArrival > 0;
            if (hasValidCountdown) {
                const minutesValue = minutesUntilArrival!;
                const minutesPerDay = 24 * 60;

                if (minutesValue >= minutesPerDay) {
                    const days = Math.max(1, Math.floor(minutesValue / minutesPerDay));
                    const dayLabel = days === 1 ? daySingular : dayPlural;
                    countdownLabel = language === 'ml'
                        ? `ഇനി ${days} ${dayLabel}`
                        : `${t.liveToken.in} ${days} ${dayLabel}`;
                } else if (minutesValue >= 60) {
                    const hoursValue = Math.max(1, Math.floor(minutesValue / 60));
                    const remainingMinutes = minutesValue % 60;

                    const hourLabel = hoursValue === 1 ? t.liveToken.hour : t.liveToken.hours;
                    const minuteLabel = remainingMinutes === 1 ? t.liveToken.minute : t.liveToken.minutes;

                    const hoursPart = `${hoursValue} ${hourLabel}`;
                    const minutesPart = remainingMinutes > 0 ? ` ${remainingMinutes} ${minuteLabel}` : '';

                    countdownLabel = language === 'ml'
                        ? `ഇനി ${hoursPart}${minutesPart}`
                        : `${t.liveToken.in} ${hoursPart}${minutesPart}`;
                } else {
                    const mins = Math.max(1, minutesValue);
                    countdownLabel = language === 'ml'
                        ? `ഇനി ${mins} ${t.liveToken.minutes}`
                        : `${t.liveToken.in} ${mins} ${t.liveToken.minutes}`;
                }
            } else {
                const dayLabel = daysUntilAppointment === 1 ? daySingular : dayPlural;
                countdownLabel = language === 'ml'
                    ? `ഇനി ${daysUntilAppointment} ${dayLabel}`
                    : `${t.liveToken.in} ${daysUntilAppointment} ${dayLabel}`;
            }

            return (
                <div className="w-full text-center py-4">
                    <div className={`${bgClass} rounded-full px-4 py-3 flex flex-col items-center justify-center gap-1`}>
                        <Hourglass className="w-6 h-6" />
                        <div className="flex flex-col items-center justify-center">
                            <span className="text-sm font-medium">{reportingLabel}</span>
                            <span className="font-bold text-lg">{countdownLabel}</span>
                        </div>
                    </div>
                </div>
            );
        }

        // Default: return null if no conditions match
        return null;
    };

    const formatTokenTime = (appointment: Appointment) => {
        try {
            const dateObj = parse(appointment.date, "d MMMM yyyy", new Date());
            const dateTime = parseTime(appointment.time, dateObj);
            return format(dateTime, 'hh:mm a');
        } catch {
            return appointment.time || '--';
        }
    };

    const getLiveQueueBadge = (appointment: Appointment, index: number) => {
        const defaultBadge = { label: appointment.status || 'Status', className: 'bg-gray-100 text-gray-800' };
        if (!yourAppointment) return defaultBadge;

        if (queueState?.currentConsultation && queueState.currentConsultation.id === appointment.id) {
            return { label: t.liveToken?.inConsultation || 'In Consultation', className: 'bg-green-100 text-green-800' };
        }

        if (appointment.id === yourAppointment.id) {
            return { label: t.liveToken?.yourTokenLabel || 'Your Token', className: 'bg-blue-100 text-blue-800' };
        }

        const masterIndex = masterQueue.findIndex(a => a.id === appointment.id);
        if (masterIndex === 0) {
            return { label: t.liveToken?.currentToken || 'Current Token', className: 'bg-emerald-100 text-emerald-800' };
        }
        if (masterIndex > 0) {
            const aheadLabel = language === 'ml'
                ? `മുന്നിൽ ${masterIndex}`
                : `${masterIndex} ahead`;
            return { label: aheadLabel, className: 'bg-sky-100 text-sky-800' };
        }

        if (queueState?.bufferQueue?.some(a => a.id === appointment.id)) {
            return { label: t.liveToken?.bufferQueueLabel || 'Ready Next', className: 'bg-amber-100 text-amber-800' };
        }

        switch (appointment.status) {
            case 'Pending':
                return { label: t.liveToken?.pending || 'Pending', className: 'bg-yellow-100 text-yellow-800' };
            case 'Confirmed':
                return { label: t.liveToken?.confirmed || 'Confirmed', className: 'bg-blue-100 text-blue-800' };
            case 'Skipped':
                return { label: t.liveToken?.skipped || 'Skipped', className: 'bg-red-100 text-red-800' };
            case 'Completed':
                return { label: t.liveToken?.completed || 'Completed', className: 'bg-green-100 text-green-800' };
            case 'Cancelled':
                return { label: t.liveToken?.cancelled || 'Cancelled', className: 'bg-gray-200 text-gray-800' };
            default:
                return defaultBadge;
        }
    };

    // Calculate no-show timestamp and check if within 2 hours
    const noShowTimestamp = useMemo(() => {
        if (!yourAppointment || yourAppointment.status !== 'No-show') return null;
        try {
            // Try to get noShowTime from appointment
            if (yourAppointment.noShowTime) {
                let noShowDate: Date;
                if (yourAppointment.noShowTime instanceof Date && !isNaN(yourAppointment.noShowTime.getTime())) {
                    noShowDate = yourAppointment.noShowTime;
                } else if (typeof (yourAppointment.noShowTime as any)?.toDate === 'function') {
                    noShowDate = (yourAppointment.noShowTime as any).toDate();
                } else if (typeof yourAppointment.noShowTime === 'string') {
                    noShowDate = new Date(yourAppointment.noShowTime);
                } else if (typeof yourAppointment.noShowTime === 'number') {
                    noShowDate = new Date(yourAppointment.noShowTime);
                } else {
                    // Fallback: calculate from appointment time + 15 minutes
                    const appointmentDateTime = parseAppointmentDateTime(yourAppointment.date, yourAppointment.time);
                    noShowDate = addMinutes(appointmentDateTime, 15);
                }
                if (noShowDate instanceof Date && !isNaN(noShowDate.getTime())) {
                    return noShowDate;
                }
            }
            // Fallback: calculate from appointment time + 15 minutes
            const appointmentDateTime = parseAppointmentDateTime(yourAppointment.date, yourAppointment.time);
            return addMinutes(appointmentDateTime, 15);
        } catch {
            return null;
        }
    }, [yourAppointment]);

    const isNoShowWithin2Hours = useMemo(() => {
        if (!noShowTimestamp) return false;
        const hoursSinceNoShow = differenceInHours(currentTime, noShowTimestamp);
        return hoursSinceNoShow >= 0 && hoursSinceNoShow <= 2;
    }, [noShowTimestamp, currentTime]);

    // Calculate display time for No-show: arriveByTime - 15 minutes
    const noShowDisplayTime = useMemo(() => {
        if (!yourAppointment || yourAppointment.status !== 'No-show') return null;
        try {
            const appointmentDate = parse(yourAppointment.date, "d MMMM yyyy", new Date());
            const arriveByString = yourAppointment.arriveByTime || getArriveByTimeFromAppointment(yourAppointment, yourAppointmentDoctor);
            const arriveByDateTime = parse(arriveByString, "hh:mm a", appointmentDate);
            const displayDateTime = subMinutes(arriveByDateTime, 15);
            return format(displayDateTime, 'hh:mm a');
        } catch {
            return yourAppointment.time || '--';
        }
    }, [yourAppointment, yourAppointmentDoctor]);

    const hiddenStatuses = useMemo(() => {
        const statuses = new Set(['Cancelled', 'Completed']);
        // Only hide No-show if it's been more than 2 hours since no-show time
        if (yourAppointment?.status === 'No-show' && !isNoShowWithin2Hours) {
            statuses.add('No-show');
        }
        return statuses;
    }, [yourAppointment?.status, isNoShowWithin2Hours]);
    const isHiddenStatus = !!yourAppointment && hiddenStatuses.has(yourAppointment.status || '');

    // Fetch clinic phone number for No-show status
    const [clinicPhone, setClinicPhone] = useState<string | null>(null);
    useEffect(() => {
        if (!yourAppointment || yourAppointment.status !== 'No-show' || !isNoShowWithin2Hours || !firestore || !clinicId) return;

        const fetchClinicPhone = async () => {
            try {
                const clinicRef = doc(firestore, 'clinics', clinicId);
                const clinicDoc = await getDoc(clinicRef);
                if (clinicDoc.exists()) {
                    const clinicData = clinicDoc.data();
                    // Try to get phone from clinic data, fallback to appointment communicationPhone
                    const phone = clinicData?.phone || yourAppointment.communicationPhone || null;
                    setClinicPhone(phone);
                } else {
                    // Fallback to appointment communicationPhone
                    setClinicPhone(yourAppointment.communicationPhone || null);
                }
            } catch (error) {
                console.error('Error fetching clinic phone:', error);
                // Fallback to appointment communicationPhone
                setClinicPhone(yourAppointment.communicationPhone || null);
            }
        };

        fetchClinicPhone();
    }, [yourAppointment, isNoShowWithin2Hours, firestore, clinicId]);

    // Special rendering for No-show status within 2 hours
    if (yourAppointment?.status === 'No-show' && isNoShowWithin2Hours) {

        return (
            <div className="w-full max-w-sm rounded-2xl bg-card text-card-foreground shadow-xl p-6 sm:p-8 space-y-6 text-center">
                <div className="text-center">
                    <p className="text-muted-foreground">Dr. {yourAppointment.doctor}</p>
                    <p className="text-lg font-semibold">{getLocalizedDepartmentName(yourAppointment.department, language, departments)}</p>
                </div>

                {/* Date, Time, Token Number Card */}
                <Card className="w-full">
                    <CardContent className="p-4 flex flex-col items-center justify-center gap-3">
                        <div className="flex flex-col items-center gap-1">
                            <Calendar className="w-5 h-5 text-primary" />
                            <span className="font-semibold text-lg text-center">{formattedDate}</span>
                        </div>
                        <div className="flex flex-col items-center gap-1">
                            <Clock className="w-5 h-5 text-primary" />
                            <span className="font-semibold text-lg">{noShowDisplayTime || '--'}</span>
                        </div>
                        <div className="text-center">
                            <p className="text-sm text-muted-foreground">{t.liveToken.yourToken} ({yourAppointment.patientName})</p>
                            <p className="text-4xl font-bold" style={{ color: 'hsl(var(--token-your))' }}>{yourAppointment.tokenNumber}</p>
                        </div>
                    </CardContent>
                </Card>

                {/* Red countdown message */}
                <div className="w-full text-center py-4">
                    <div className="bg-red-100 text-red-800 rounded-full px-4 py-3 flex flex-col items-center justify-center gap-2">
                        <AlertCircle className="w-6 h-6" />
                        <div className="flex flex-col items-center justify-center">
                            <span className="font-bold text-lg">{t.liveToken.noShowLateMessage}</span>
                        </div>
                    </div>
                </div>

                {/* Call Clinic Button */}
                {clinicPhone && (
                    <Button
                        asChild
                        className="w-full bg-green-600 hover:bg-green-700 text-white"
                        size="lg"
                    >
                        <a href={`tel:${clinicPhone}`}>
                            <Phone className="w-5 h-5 mr-2" />
                            {t.liveToken.noShowCallClinic}
                        </a>
                    </Button>
                )}

                <BottomNav />
            </div>
        );
    }

    if (isHiddenStatus) {
        return (
            <div className="flex h-screen w-full flex-col items-center justify-center bg-[hsl(var(--app-background))] font-body text-foreground p-6 text-center space-y-4">
                <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
                    <Info className="h-8 w-8 text-primary" />
                </div>
                <h2 className="text-xl font-bold">
                    {language === 'ml' ? 'ഈ ടോക്കൺ ഇനി ലഭ്യമല്ല' : 'This token is no longer available'}
                </h2>
                <p className="text-muted-foreground">
                    {language === 'ml'
                        ? 'സ്ഥിതി No-show, Cancelled, Completed അല്ലാത്ത ടോക്കണുകൾ മാത്രമെ ലൈവ് കണക്ഷൻ കാണൂ.'
                        : 'Only active tokens (Pending/Confirmed/Skipped) have a live queue view.'}
                </p>
                <Button asChild>
                    <Link href="/appointments">
                        {t.appointments?.myAppointments || (language === 'ml' ? 'എന്റെ അപ്പോയിന്റ്മെന്റുകൾ' : 'My Appointments')}
                    </Link>
                </Button>
                <BottomNav />
            </div>
        );
    }

    return (
        <div className="w-full max-w-sm rounded-2xl bg-card text-card-foreground shadow-xl p-6 sm:p-8 space-y-6 text-center">
            <div className="text-center">
                <p className="text-muted-foreground">Dr. {yourAppointment.doctor}</p>
                <p className="text-lg font-semibold">{getLocalizedDepartmentName(yourAppointment.department, language, departments)}</p>
                {/* Show doctor status indicator - but not for Confirmed status */}
                {yourAppointment.status !== 'Confirmed' && (() => {
                    // If there's an active break (remaining break minutes > 0), show "Doctor is late"
                    if (breakMinutes > 0 && !isDoctorIn) {
                        return (
                            <div className="mt-2 inline-flex items-center gap-1 px-3 py-1 rounded-full bg-red-100 text-red-800 text-xs font-medium">
                                <AlertCircle className="w-3 h-3" />
                                <span>{t.liveToken?.doctorIsLate || (language === 'ml' ? 'ഡോക്ടർ ഇന്ന് വൈകി' : 'Doctor is late')}</span>
                            </div>
                        );
                    }
                    // If leave slots are at the start of availability slots, show "Doctor is late"
                    if (doctorStatusInfo.isLate) {
                        return (
                            <div className="mt-2 inline-flex items-center gap-1 px-3 py-1 rounded-full bg-red-100 text-red-800 text-xs font-medium">
                                <AlertCircle className="w-3 h-3" />
                                <span>{t.liveToken.doctorIsLate}</span>
                            </div>
                        );
                    }
                    // If leave slots are in between availability slots, show "Doctor on break"
                    if (doctorStatusInfo.isBreak) {
                        return (
                            <div className="mt-2 inline-flex items-center gap-1 px-3 py-1 rounded-full bg-amber-100 text-amber-800 text-xs font-medium">
                                <AlertCircle className="w-3 h-3" />
                                <span>{t.liveToken.doctorOnBreak}</span>
                            </div>
                        );
                    }
                    return null;
                })()}
            </div>

            {/* Separate card for date and arrive by time - Hide when doctor is 'In' and there are patients ahead in queue */}
            {(!shouldShowQueueInfo || (shouldShowQueueInfo && patientsAhead === 0)) && (
                <Card className="w-full">
                    <CardContent className="p-4 flex flex-col items-center justify-center gap-3">
                        <div className="flex flex-col items-center gap-1">
                            <Calendar className="w-5 h-5 text-primary" />
                            <span className="font-semibold text-lg text-center">{formattedDate}</span>
                        </div>
                        <div className="flex flex-col items-center w-full">
                            {yourAppointment.status === 'Confirmed' && confirmedStatusBanner ? (
                                <div className="flex flex-col items-center">
                                    {(doctorStatusInfo.isBreak || doctorStatusInfo.isLate || doctorStatusInfo.isAffected) ? (
                                        <div className={`px-3 py-1.5 rounded-full ${doctorStatusInfo.isBreak
                                            ? 'bg-amber-100 text-amber-800'
                                            : 'bg-red-100 text-red-800'
                                            }`}>
                                            <span className="text-sm font-semibold">
                                                {confirmedStatusBanner.text}
                                            </span>
                                        </div>
                                    ) : (
                                        <span className={`text-lg font-semibold ${confirmedStatusBanner.className}`}>
                                            {confirmedStatusBanner.text}
                                        </span>
                                    )}
                                </div>
                            ) : (
                                <>
                                    {!shouldHideArriveByDetails ? (
                                        <div className="flex flex-col items-center gap-1">
                                            <Clock className="w-5 h-5 text-primary" />
                                            <div className="text-center">
                                                {yourAppointment.status !== 'Skipped' && (
                                                    <span className="text-xs text-muted-foreground block">
                                                        {t.home.arriveBy}
                                                    </span>
                                                )}
                                                <span className={`font-semibold text-lg ${(breakMinutes > 0 || doctorStatusInfo.isAffected) ? 'text-red-600' : ''}`}>
                                                    {reportByTimeDisplay}
                                                </span>
                                            </div>
                                        </div>
                                    ) : (
                                        <div className="flex flex-col items-center gap-1">
                                            <Clock className="w-5 h-5 text-primary" />
                                            <div className="text-center">
                                                <span className={`font-semibold text-lg ${(breakMinutes > 0 || doctorStatusInfo.isAffected) ? 'text-red-600' : ''}`}>
                                                    {reportByTimeDisplay}
                                                </span>
                                                <span className="text-base font-semibold text-red-600 block mt-1">
                                                    {language === 'ml' ? 'നിങ്ങൾ വൈകി' : 'You are late'}
                                                </span>
                                            </div>
                                        </div>
                                    )}
                                    {yourAppointment.status === 'Skipped' && !shouldHideArriveByDetails && (
                                        <span className="text-base font-semibold text-red-600 block mt-2">
                                            {language === 'ml' ? 'നിങ്ങൾ വൈകി' : 'You are late'}
                                        </span>
                                    )}
                                    {yourAppointment.delay && yourAppointment.delay > 0 && (
                                        <p className="text-xs text-orange-600 dark:text-orange-400 mt-1">
                                            ⏱️ Delayed by {yourAppointment.delay} min
                                        </p>
                                    )}
                                </>
                            )}
                        </div>
                    </CardContent>
                </Card>
            )}

            {/* Show arrive by time and estimated time when doctor is IN - HIDDEN when consultationStatus is 'In' */}
            {shouldShowQueueInfo && !isDoctorIn && (
                <Card className="w-full">
                    <CardContent className="p-4 flex flex-col items-center justify-center gap-3">
                        <div className="flex items-center gap-2">
                            <Clock className="w-5 h-5 text-primary" />
                            <div className="text-left">
                                {yourAppointment.status === 'Confirmed' && confirmedStatusBanner ? (
                                    <div className="flex flex-col">
                                        {(doctorStatusInfo.isBreak || doctorStatusInfo.isLate || doctorStatusInfo.isAffected) ? (
                                            <div className={`px-3 py-1.5 rounded-full ${doctorStatusInfo.isBreak
                                                ? 'bg-amber-100 text-amber-800'
                                                : 'bg-red-100 text-red-800'
                                                }`}>
                                                <span className="text-sm font-semibold">
                                                    {confirmedStatusBanner.text}
                                                </span>
                                            </div>
                                        ) : (
                                            <span className={`text-sm font-semibold ${confirmedStatusBanner.className}`}>
                                                {confirmedStatusBanner.text}
                                            </span>
                                        )}
                                    </div>
                                ) : (
                                    <>
                                        <span className="text-xs text-muted-foreground">
                                            {t.home.arriveBy}
                                        </span>
                                        <p className="font-semibold text-lg">{getReportByTimeLabel(yourAppointment, yourAppointmentDoctor)}</p>
                                        {yourAppointment.delay && yourAppointment.delay > 0 && (
                                            <p className="text-xs text-orange-600 dark:text-orange-400 mt-1">
                                                ⏱️ Delayed by {yourAppointment.delay} min
                                            </p>
                                        )}
                                    </>
                                )}
                            </div>
                        </div>

                        {/* Always show delay if present (no threshold) */}
                        {totalDelayMinutes > 0 && (
                            <>
                                <div className="text-yellow-600 flex items-center gap-1 text-sm">
                                    <AlertCircle className="w-4 h-4" />
                                    <span>{t.liveToken.delayedBy || 'Delayed by'} ~{totalDelayMinutes} {t.liveToken.minutes || 'min'}</span>
                                </div>
                                <div className="flex items-center gap-2">
                                    <Clock className="w-5 h-5 text-green-600" />
                                    <div className="text-left">
                                        <span className="text-xs text-muted-foreground">{t.liveToken.estimatedTime || 'Estimated Time'}</span>
                                        <p className="font-bold text-lg text-green-600">
                                            {estimatedConsultationTime ? format(estimatedConsultationTime, 'hh:mm a') : '--'}
                                        </p>
                                    </div>
                                </div>
                            </>
                        )}
                    </CardContent>
                </Card>
            )}

            <div className="relative flex flex-col items-center justify-center space-y-4">
                {shouldShowQueueVisualization && !isYourTurn && displayedPatientsAhead > 0 && masterQueue.length > 0 && (
                    <>
                        <div className="text-center">
                            <p className="text-sm text-muted-foreground">{t.liveToken.currentToken}</p>
                            <p className="text-6xl font-bold" style={{ color: 'hsl(var(--token-current))' }}>{currentTokenAppointment?.tokenNumber || 'N/A'}</p>
                        </div>

                        <div className="relative h-24 w-4 flex items-end justify-center">
                            <div className="absolute h-full w-2 rounded-full bg-gray-200"></div>
                            <div className="absolute bottom-0 w-2 rounded-full" style={{
                                height: `${Math.min(100, (displayedPatientsAhead / 5) * 100)}%`, // Example visualization
                                backgroundColor: 'hsl(var(--token-current))'
                            }}></div>
                        </div>

                        <div className="absolute right-0 top-1/2 -translate-y-1/2 transform flex flex-col items-center justify-center bg-gray-100 rounded-lg p-3 shadow-md w-20 h-20">
                            <p className="text-sm font-semibold">{t.liveToken.patientsAhead}</p>
                            <p className="text-3xl font-bold">{displayedPatientsAhead}</p>
                            <Users className="w-5 h-5 text-muted-foreground" />
                        </div>
                    </>
                )}

                <div className="text-center">
                    <p className="text-sm text-muted-foreground">{t.liveToken.yourToken} ({yourAppointment.patientName})</p>
                    <div className="flex items-center justify-center">
                        <p className="text-6xl font-bold" style={{ color: 'hsl(var(--token-your))' }}>{yourAppointment.tokenNumber}</p>
                    </div>
                </div>
            </div>

            {/* Unified bottom message container */}
            <BottomMessage />

            {shouldShowConfirmArrival && (
                <div className="w-full mt-4 space-y-3">
                    {locationCheckAttempted && locationStatus === 'error' && locationError && (
                        <div className="rounded-lg bg-destructive/10 text-destructive text-sm px-3 py-2">
                            {locationError}
                        </div>
                    )}
                    {locationCheckAttempted && locationDenied && (
                        <p className="text-xs text-amber-600">
                            {language === 'ml'
                                ? 'ലൊക്കേഷൻ അനുമതി അനുവദിക്കാൻ, 브ൗസർ സറ്റിങ്സിൽ നിന്ന് അനുവദിക്കുക.'
                                : 'Please enable location permission from your browser settings.'}
                        </p>
                    )}
                    {inlineError && (
                        <div className="rounded-lg bg-destructive/10 text-destructive text-sm px-3 py-2">
                            {inlineError}
                        </div>
                    )}
                    <div className="flex flex-col gap-3">
                        <Button
                            onClick={handleConfirmArrivalInline}
                            className="w-full bg-green-600 hover:bg-green-700 text-white"
                            size="lg"
                            disabled={isConfirmingInline || locationStatus === 'checking'}
                        >
                            {isConfirmingInline ? (
                                <>
                                    <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                                    {language === 'ml' ? 'സ്ഥിരീകരിക്കുന്നു...' : 'Confirming...'}
                                </>
                            ) : (
                                <>
                                    <CheckCircle2 className="w-5 h-5 mr-2" />
                                    {t.liveToken.confirmArrival || (language === 'ml' ? 'ക്ലിനിക്കിലെത്തി എന്ന് ഉറപ്പാക്കുക' : 'Confirm Arrival at Clinic')}
                                </>
                            )}
                        </Button>
                        {yourAppointment?.status === 'Skipped' && (
                            <AlertDialog>
                                <AlertDialogTrigger asChild>
                                    <Button
                                        variant="destructive"
                                        size="lg"
                                        className="w-full"
                                        disabled={isConfirmingInline}
                                    >
                                        {language === 'ml' ? 'അപ്പോയിന്റ്മെന്റ് റദ്ദാക്കുക' : 'Cancel the appointment'}
                                    </Button>
                                </AlertDialogTrigger>
                                <AlertDialogContent>
                                    <AlertDialogHeader>
                                        <AlertDialogTitle>
                                            {language === 'ml' ? 'അപ്പോയിന്റ്മെന്റ് റദ്ദാക്കണോ?' : 'Cancel Appointment?'}
                                        </AlertDialogTitle>
                                        <AlertDialogDescription>
                                            {language === 'ml'
                                                ? 'ഈ അപ്പോയിന്റ്മെന്റ് റദ്ദാക്കാൻ നിങ്ങൾക്ക് ഉറപ്പാണോ? ഈ പ്രവർത്തനം പഴയപടിയാക്കാൻ കഴിയില്ല.'
                                                : 'Are you sure you want to cancel this appointment? This action cannot be undone.'}
                                        </AlertDialogDescription>
                                    </AlertDialogHeader>
                                    <AlertDialogFooter>
                                        <AlertDialogCancel>
                                            {language === 'ml' ? 'ഇല്ല' : 'No'}
                                        </AlertDialogCancel>
                                        <AlertDialogAction
                                            onClick={async () => {
                                                if (!firestore || !yourAppointment) return;
                                                try {
                                                    const appointmentRef = doc(firestore, 'appointments', yourAppointment.id);
                                                    await updateDoc(appointmentRef, {
                                                        status: 'Cancelled',
                                                        updatedAt: new Date()
                                                    });
                                                } catch (error) {
                                                    console.error('Error cancelling appointment:', error);
                                                }
                                            }}
                                        >
                                            {language === 'ml' ? 'അതെ, റദ്ദാക്കുക' : 'Yes, Cancel'}
                                        </AlertDialogAction>
                                    </AlertDialogFooter>
                                </AlertDialogContent>
                            </AlertDialog>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};

function LiveTokenPage() {
    const pathname = usePathname();
    const params = useParams();
    const selectedAppointmentId = params?.appointmentId as string | undefined;
    const { user, loading: userLoading } = useUser();
    const firestore = useFirestore();
    const { t, language } = useLanguage();
    const router = useRouter();
    const { departments } = useMasterDepartments();
    const [allClinicAppointments, setAllClinicAppointments] = useState<Appointment[]>([]);

    const { appointments: familyAppointments, loading: familyAppointmentsLoading } = useAppointments(user?.patientId);
    const clinicIds = useMemo(() => user?.clinicIds || [], [user?.clinicIds]);
    const { doctors, loading: doctorsLoading } = useDoctors(clinicIds);
    const [currentTime, setCurrentTime] = useState(new Date());

    useEffect(() => {
        const timerId = setInterval(() => setCurrentTime(new Date()), 60000);
        return () => clearInterval(timerId);
    }, []);



    // Also fetch appointments for the appointment date if it's different from today
    const [appointmentDateAppointments, setAppointmentDateAppointments] = useState<Appointment[]>([]);

    const familyUpcomingAppointments = useMemo(() => {
        if (familyAppointments.length === 0) return [];

        const upcoming = familyAppointments.filter(a => {
            if (a.status === 'Cancelled' || a.status === 'Completed') {
                return false;
            }

            let appointmentDate;
            try {
                appointmentDate = parse(a.date, "d MMMM yyyy", new Date());
            } catch {
                appointmentDate = new Date(a.date);
            }

            return isToday(appointmentDate) || !isPast(appointmentDate);
        });

        upcoming.sort((a, b) => {
            try {
                const dateA = parse(a.date, "d MMMM yyyy", new Date());
                const dateB = parse(b.date, "d MMMM yyyy", new Date());
                const dateDiff = dateA.getTime() - dateB.getTime();

                if (dateDiff !== 0) {
                    return dateDiff;
                }

                const timeA = parseTime(a.time, dateA).getTime();
                const timeB = parseTime(b.time, dateB).getTime();

                if (timeA !== timeB) {
                    return timeA - timeB;
                }

                if (a.tokenNumber?.startsWith('A') && b.tokenNumber?.startsWith('W')) {
                    return -1;
                }
                if (a.tokenNumber?.startsWith('W') && b.tokenNumber?.startsWith('A')) {
                    return 1;
                }

                const tokenNumA = parseInt(a.tokenNumber?.replace(/[A-W]/g, '') || '0', 10);
                const tokenNumB = parseInt(b.tokenNumber?.replace(/[A-W]/g, '') || '0', 10);
                return tokenNumA - tokenNumB;
            } catch {
                return 0;
            }
        });

        return upcoming;
    }, [familyAppointments]);

    const getAppointmentCutoffDate = useCallback((appointment: Appointment) => {
        try {
            if (appointment.cutOffTime) {
                if (appointment.cutOffTime instanceof Date && !isNaN(appointment.cutOffTime.getTime())) {
                    return appointment.cutOffTime;
                }
                if (typeof (appointment.cutOffTime as any)?.toDate === 'function') {
                    const converted = (appointment.cutOffTime as any).toDate();
                    if (converted instanceof Date && !isNaN(converted.getTime())) {
                        return converted;
                    }
                }
                if (typeof appointment.cutOffTime === 'string') {
                    const appointmentDateTime = parseAppointmentDateTime(appointment.date, appointment.time);
                    return subMinutes(appointmentDateTime, 15);
                }
                if (typeof appointment.cutOffTime === 'number') {
                    const numericDate = new Date(appointment.cutOffTime);
                    if (!isNaN(numericDate.getTime())) {
                        return numericDate;
                    }
                }
            }
            const appointmentDateTime = parseAppointmentDateTime(appointment.date, appointment.time);
            return subMinutes(appointmentDateTime, 15);
        } catch (error) {
            console.error('Error computing cutoff date', error);
            return null;
        }
    }, []);

    const findNextAppointmentNeedingConfirmation = useCallback((excludeId?: string) => {
        const now = new Date();
        return familyUpcomingAppointments.find(appt => {
            if (appt.id === excludeId) return false;
            if (appt.status !== 'Pending' && appt.status !== 'Skipped') return false;
            const cutoffDate = getAppointmentCutoffDate(appt);
            if (!cutoffDate) return false;
            const minutes = differenceInMinutes(cutoffDate, now);
            return minutes >= -5 && minutes <= 120;
        });
    }, [familyUpcomingAppointments, getAppointmentCutoffDate]);

    const handleAppointmentConfirmed = useCallback((confirmedAppointmentId: string) => {
        const nextAppointment = findNextAppointmentNeedingConfirmation(confirmedAppointmentId);
        if (nextAppointment) {
            router.replace(`/live-token/${nextAppointment.id}`);
        }
    }, [findNextAppointmentNeedingConfirmation, router]);

    // Helper function to calculate no-show timestamp for an appointment
    const getNoShowTimestamp = useCallback((appointment: Appointment): Date | null => {
        if (appointment.status !== 'No-show') return null;
        try {
            if (appointment.noShowTime) {
                let noShowDate: Date;
                if (appointment.noShowTime instanceof Date && !isNaN(appointment.noShowTime.getTime())) {
                    noShowDate = appointment.noShowTime;
                } else if (typeof (appointment.noShowTime as any)?.toDate === 'function') {
                    noShowDate = (appointment.noShowTime as any).toDate();
                } else if (typeof appointment.noShowTime === 'string') {
                    noShowDate = new Date(appointment.noShowTime);
                } else if (typeof appointment.noShowTime === 'number') {
                    noShowDate = new Date(appointment.noShowTime);
                } else {
                    const appointmentDateTime = parseAppointmentDateTime(appointment.date, appointment.time);
                    noShowDate = addMinutes(appointmentDateTime, 15);
                }
                if (noShowDate instanceof Date && !isNaN(noShowDate.getTime())) {
                    return noShowDate;
                }
            }
            const appointmentDateTime = parseAppointmentDateTime(appointment.date, appointment.time);
            return addMinutes(appointmentDateTime, 15);
        } catch {
            return null;
        }
    }, []);

    const hiddenStatuses = useMemo(() => {
        const statuses = new Set(['Cancelled', 'Completed']);
        // Check each No-show appointment individually
        return statuses;
    }, []);

    const visibleFamilyAppointments = useMemo(() => {
        return familyUpcomingAppointments.filter(appt => {
            if (hiddenStatuses.has(appt.status || '')) return false;
            // For No-show appointments, only show if within 2 hours
            if (appt.status === 'No-show') {
                const noShowTime = getNoShowTimestamp(appt);
                if (!noShowTime) return false;
                const hoursSinceNoShow = differenceInHours(currentTime, noShowTime);
                return hoursSinceNoShow >= 0 && hoursSinceNoShow <= 2;
            }
            return true;
        });
    }, [familyUpcomingAppointments, hiddenStatuses, getNoShowTimestamp, currentTime]);

    const uniquePatientAppointments = useMemo(() => {
        const patientMap = new Map<string, Appointment>();
        visibleFamilyAppointments.forEach(appt => {
            if (!appt.patientId) return;
            if (!patientMap.has(appt.patientId)) {
                patientMap.set(appt.patientId, appt);
            }
        });
        return Array.from(patientMap.values());
    }, [visibleFamilyAppointments]);

    useEffect(() => {
        if (visibleFamilyAppointments.length === 0) return;
        if (!selectedAppointmentId || !visibleFamilyAppointments.some(appt => appt.id === selectedAppointmentId)) {
            router.replace(`/live-token/${visibleFamilyAppointments[0].id}`);
        }
    }, [visibleFamilyAppointments, selectedAppointmentId, router]);

    const yourAppointments = useMemo(() => {
        if (visibleFamilyAppointments.length === 0) return [];
        if (selectedAppointmentId) {
            const match = visibleFamilyAppointments.find(appt => appt.id === selectedAppointmentId);
            if (match) {
                return [match];
            }
        }
        return [visibleFamilyAppointments[0]];
    }, [visibleFamilyAppointments, selectedAppointmentId]);

    const activeAppointment = useMemo(() => yourAppointments[0] || null, [yourAppointments]);

    // Fetch appointments for today
    useEffect(() => {
        const targetClinicIds = activeAppointment?.clinicId
            ? [activeAppointment.clinicId]
            : clinicIds;

        if (!firestore || targetClinicIds.length === 0) return;

        const todayStr = format(new Date(), "d MMMM yyyy");
        const appointmentsQuery = query(
            collection(firestore, 'appointments'),
            where("clinicId", "in", targetClinicIds),
            where("date", "==", todayStr)
        );

        const unsubscribe = onSnapshot(appointmentsQuery,
            (snapshot: QuerySnapshot<DocumentData>) => {
                const appointmentsData: Appointment[] = snapshot.docs.map(doc => ({
                    id: doc.id,
                    ...doc.data()
                } as Appointment));
                setAllClinicAppointments(appointmentsData);
            },
            (error) => {
                console.error("Error fetching all clinic appointments: ", error);
            }
        );

        return () => unsubscribe();
    }, [firestore, clinicIds, activeAppointment?.clinicId]);

    useEffect(() => {
        if (!firestore || !activeAppointment || clinicIds.length === 0) {
            setAppointmentDateAppointments([]);
            return;
        }

        const todayStr = format(new Date(), "d MMMM yyyy");
        const appointmentDateStr = activeAppointment.date;

        if (appointmentDateStr === todayStr) {
            setAppointmentDateAppointments([]);
            return;
        }

        const targetClinicIds = activeAppointment?.clinicId
            ? [activeAppointment.clinicId]
            : clinicIds;

        if (targetClinicIds.length === 0) {
            setAppointmentDateAppointments([]);
            return;
        }

        const appointmentsQuery = query(
            collection(firestore, 'appointments'),
            where("clinicId", "in", targetClinicIds),
            where("date", "==", appointmentDateStr)
        );

        const unsubscribe = onSnapshot(appointmentsQuery,
            (snapshot: QuerySnapshot<DocumentData>) => {
                const appointmentsData: Appointment[] = snapshot.docs.map(doc => ({
                    id: doc.id,
                    ...doc.data()
                } as Appointment));
                setAppointmentDateAppointments(appointmentsData);
            },
            (error) => {
                console.error("Error fetching appointments for appointment date: ", error);
                setAppointmentDateAppointments([]);
            }
        );

        return () => unsubscribe();
    }, [firestore, clinicIds, activeAppointment?.date, activeAppointment?.id, activeAppointment?.clinicId]);

    const allRelevantAppointments = useMemo(() => {
        if (!activeAppointment) return allClinicAppointments;

        const todayStr = format(new Date(), "d MMMM yyyy");
        if (activeAppointment.date === todayStr) {
            return allClinicAppointments;
        }

        const merged = [...allClinicAppointments, ...appointmentDateAppointments];
        const uniqueMap = new Map();
        merged.forEach(apt => {
            if (!uniqueMap.has(apt.id)) {
                uniqueMap.set(apt.id, apt);
            }
        });
        return Array.from(uniqueMap.values());
    }, [allClinicAppointments, appointmentDateAppointments, activeAppointment]);

    const realTimeActiveAppointment = useMemo(() => {
        if (!activeAppointment) return null;
        return allRelevantAppointments.find(a => a.id === activeAppointment.id) || activeAppointment;
    }, [activeAppointment, allRelevantAppointments]);

    const isLoading = userLoading || familyAppointmentsLoading || doctorsLoading;

    const patientMenuLabel = language === 'ml' ? 'രോഗിയെ തിരഞ്ഞെടുക്കുക' : 'Choose patient';

    if (isLoading) {
        return (
            <div className="flex h-screen w-full flex-col items-center justify-center bg-background">
                <div className="flex flex-col items-center gap-4">
                    <Skeleton className="h-12 w-12 rounded-full" />
                    <Skeleton className="h-4 w-32" />
                </div>
            </div>
        );
    }

    return (
        <div className="flex min-h-screen w-full flex-col bg-[hsl(var(--app-background))] font-body text-foreground">
            <header className="flex items-center p-4 gap-2">
                <Link href="/home" className="p-2">
                    <ArrowLeft className="h-6 w-6" />
                </Link>
                <h1 className="text-xl font-bold text-center flex-grow">{t.liveToken.title}</h1>
            </header>
            <main className="flex-grow flex flex-col items-center justify-start p-4 pb-24 space-y-6">
                {uniquePatientAppointments.length > 1 && (
                    <div className="w-full max-w-sm">
                        <div className="flex items-center justify-between mb-2">
                            <p className="text-sm font-semibold">{patientMenuLabel}</p>
                            <p className="text-xs text-muted-foreground">
                                {uniquePatientAppointments.length} {language === 'ml' ? 'രോഗികൾ' : 'patients'}
                            </p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            {uniquePatientAppointments.map(appt => {
                                const isSelected = activeAppointment?.id === appt.id;
                                const ageText = appt.age ? `${appt.age}` : '';
                                const placeText = appt.place ? appt.place : '';
                                return (
                                    <button
                                        key={appt.id}
                                        onClick={() => router.push(`/live-token/${appt.id}`)}
                                        className={`flex-1 min-w-[120px] rounded-xl border px-3 py-2 text-left transition-colors ${isSelected
                                            ? 'border-green-400 bg-green-50'
                                            : 'border-border bg-background hover:border-primary/70'
                                            }`}
                                    >
                                        <p className="text-sm font-semibold truncate">{appt.patientName}</p>
                                        <p className="text-xs text-muted-foreground">
                                            {appt.tokenNumber} • {(() => {
                                                const apptDoctor = doctors.find(d => d.name === appt.doctor);
                                                return getReportByTimeLabel(appt, apptDoctor);
                                            })()}
                                        </p>
                                        {(ageText || placeText) && (
                                            <p className="text-xs text-muted-foreground truncate">
                                                {ageText && `${ageText} ${language === 'ml' ? 'വയസ്സ്' : 'yrs'}`} {placeText && `• ${placeText}`}
                                            </p>
                                        )}
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                )}

                {realTimeActiveAppointment ? (
                    <AppointmentStatusCard
                        yourAppointment={realTimeActiveAppointment}
                        allTodaysAppointments={allRelevantAppointments}
                        doctors={doctors}
                        currentTime={currentTime}
                        t={t}
                        departments={departments}
                        language={language}
                        onAppointmentConfirmed={handleAppointmentConfirmed}
                    />
                ) : (
                    <Card className="w-full max-w-sm text-center mt-10">
                        <CardContent className="p-6 space-y-4">
                            <div className="flex justify-center">
                                <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
                                    <Info className="h-8 w-8 text-primary" />
                                </div>
                            </div>
                            <h2 className="text-xl font-bold">{t.liveToken.noAppointments}</h2>
                            <p className="text-muted-foreground">{t.liveToken.noAppointmentsDescription}</p>
                            <Button asChild>
                                <Link href="/appointments">{t.appointments.myAppointments}</Link>
                            </Button>
                        </CardContent>
                    </Card>
                )}
            </main>

            <BottomNav />
        </div>
    );
}

function LiveTokenPageWithAuth() {
    return (
        <AuthGuard>
            <LiveTokenPage />
        </AuthGuard>
    );
}

export default LiveTokenPageWithAuth;
