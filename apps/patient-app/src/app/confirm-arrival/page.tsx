'use client';

import { useState, useEffect, useMemo } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { collection, query, where, onSnapshot, doc, getDoc, updateDoc, getDocs, serverTimestamp, Timestamp, limit, runTransaction } from 'firebase/firestore';
import { compareAppointments, getClinicNow, getClinicDayOfWeek, getClinicDateString, getClassicTokenCounterId, prepareNextClassicTokenNumber, commitNextClassicTokenNumber } from '@kloqo/shared-core';
import { format, parse, subMinutes, addMinutes, isBefore, isAfter, differenceInMinutes } from 'date-fns';
import { getArriveByTime, getArriveByTimeFromAppointment, getActualAppointmentTime, parseTime } from '@/lib/utils';
import { Loader2, MapPin, CheckCircle2, Clock, AlertCircle, UserPlus, ChevronDown, ChevronUp } from 'lucide-react';
import { useFirestore } from '@/firebase';

// Prevent static generation - this page requires Firebase context
export const dynamic = 'force-dynamic';
import { useUser } from '@/firebase/auth/use-user';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { useToast } from '@/hooks/use-toast';
import type { Appointment, Clinic, Doctor } from '@/lib/types';
import { BottomNav } from '@/components/bottom-nav';
import { Skeleton } from '@/components/ui/skeleton';
import { AuthGuard } from '@/components/auth-guard';
import { useLanguage } from '@/contexts/language-context';

// Calculate distance between two coordinates in meters
function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371e3; // Earth radius in meters
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;

  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) *
    Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

// Generate time slots for a day
function generateTimeSlotsWithSession(
  timeSlots: { from: string; to: string }[],
  referenceDate: Date,
  slotDuration: number
): { time: Date; sessionIndex: number }[] {
  const slots: { time: Date; sessionIndex: number }[] = [];

  timeSlots.forEach((slot, sessionIndex) => {
    const startTime = parseTime(slot.from, referenceDate);
    const endTime = parseTime(slot.to, referenceDate);
    let current = new Date(startTime);

    while (isBefore(current, endTime) || current.getTime() === endTime.getTime()) {
      slots.push({ time: new Date(current), sessionIndex });
      current = addMinutes(current, slotDuration);
    }
  });

  return slots;
}

// Find next immediate slot
function findNextImmediateSlot(
  allSlots: { time: Date; sessionIndex: number }[],
  currentTime: Date
): number {
  for (let i = 0; i < allSlots.length; i++) {
    if (isAfter(allSlots[i].time, currentTime) || allSlots[i].time.getTime() === currentTime.getTime()) {
      return i;
    }
  }
  return allSlots.length;
}

// Calculate rejoin slot for skipped appointments
async function calculateSkippedTokenRejoinSlot(
  skippedAppointment: Appointment,
  activeAppointments: Appointment[],
  doctor: Doctor,
  recurrence: number,
  date: Date,
  firestore: any
): Promise<{
  slotIndex: number;
  time: string;
  sessionIndex: number;
}> {
  const dateStr = getClinicDateString(date);
  const dayOfWeek = getClinicDayOfWeek(date);
  const slotDuration = doctor.averageConsultingTime || 15;

  // Get confirmed appointments (Pending or Confirmed) sorted by slotIndex
  const confirmedAppointments = activeAppointments
    .filter(a => a.doctor === skippedAppointment.doctor && a.date === dateStr)
    .filter(a => (a.status === 'Pending' || a.status === 'Confirmed'))
    .sort((a, b) => (a.slotIndex ?? Infinity) - (b.slotIndex ?? Infinity));

  // Get doctor's availability
  const todaysAvailability = doctor.availabilitySlots?.find(s => s.day === dayOfWeek);
  if (!todaysAvailability || !todaysAvailability.timeSlots?.length) {
    throw new Error('Doctor not available on this date');
  }

  // Generate all time slots
  const allSlots = generateTimeSlotsWithSession(todaysAvailability.timeSlots, date, slotDuration);
  if (allSlots.length === 0) {
    throw new Error('No consultation slots available for this date');
  }

  // Calculate target position based on confirmed appointments
  let targetSlotIndex: number;
  const now = getClinicNow();

  if (confirmedAppointments.length === 0) {
    // No confirmed appointments - place at next immediate slot
    const nextImmediateSlotIndex = findNextImmediateSlot(allSlots, now);
    if (nextImmediateSlotIndex >= allSlots.length) {
      const lastSlot = allSlots[allSlots.length - 1];
      return {
        slotIndex: allSlots.length - 1,
        time: format(lastSlot.time, 'hh:mm a'),
        sessionIndex: lastSlot.sessionIndex,
      };
    }
    targetSlotIndex = nextImmediateSlotIndex;
  } else if (confirmedAppointments.length >= recurrence) {
    // If there are >= recurrence confirmed appointments, place after the recurrence-th one
    const targetAppointment = confirmedAppointments[recurrence - 1];
    targetSlotIndex = (targetAppointment.slotIndex ?? 0) + 1;
  } else {
    // If there are < recurrence confirmed appointments, place after the last one
    const lastAppointment = confirmedAppointments[confirmedAppointments.length - 1];
    targetSlotIndex = (lastAppointment.slotIndex ?? 0) + 1;
  }

  if (targetSlotIndex >= allSlots.length) {
    const lastSlot = allSlots[allSlots.length - 1];
    return {
      slotIndex: allSlots.length - 1,
      time: format(lastSlot.time, 'hh:mm a'),
      sessionIndex: lastSlot.sessionIndex,
    };
  }

  // Check for conflicts
  const appointmentsRef = collection(firestore, 'appointments');
  const allActiveQuery = query(
    appointmentsRef,
    where('doctor', '==', skippedAppointment.doctor),
    where('date', '==', dateStr),
    where('slotIndex', '==', targetSlotIndex),
    where('status', 'in', ['Pending', 'Confirmed'])
  );
  const allActiveSnapshot = await getDocs(allActiveQuery);
  const slotOccupied = allActiveSnapshot.docs.some(doc => {
    const apt = doc.data() as Appointment;
    return apt.id !== skippedAppointment.id;
  });

  if (slotOccupied) {
    throw new Error(`Slot ${targetSlotIndex} is already occupied. Cannot rejoin at this position.`);
  }

  const targetSlot = allSlots[targetSlotIndex];
  if (!targetSlot) {
    throw new Error(`Invalid slot index: ${targetSlotIndex}`);
  }

  return {
    slotIndex: targetSlotIndex,
    time: format(targetSlot.time, 'hh:mm a'),
    sessionIndex: targetSlot.sessionIndex,
  };
}

function ConfirmArrivalPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const firestore = useFirestore();
  const { user, loading: userLoading } = useUser();
  const { toast } = useToast();
  const { t, language } = useLanguage();

  // Accept both 'clinic' and 'clinicId' parameters for flexibility
  const clinicId = searchParams.get('clinic') || searchParams.get('clinicId');

  const [clinic, setClinic] = useState<Clinic | null>(null);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [appointmentsLoaded, setAppointmentsLoaded] = useState(false);
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [location, setLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [isCheckingLocation, setIsCheckingLocation] = useState(false);
  const [isConfirming, setIsConfirming] = useState<string | null>(null);
  const [lateMinutes, setLateMinutes] = useState<{ [appointmentId: string]: number }>({});
  const [isUpdatingLate, setIsUpdatingLate] = useState<string | null>(null);
  const [expandedAppointments, setExpandedAppointments] = useState<Set<string>>(new Set());

  // Redirect to login if user is not authenticated
  useEffect(() => {
    if (!userLoading && !user && clinicId) {
      const loginParams = new URLSearchParams();
      loginParams.set('clinicId', clinicId);
      const redirectUrl = `/confirm-arrival?clinic=${clinicId}`;
      loginParams.set('redirect', redirectUrl);
      router.push(`/login?${loginParams.toString()}`);
    }
  }, [user, userLoading, router, clinicId]);

  // Fetch clinic
  useEffect(() => {
    if (!firestore || !clinicId) return;

    const clinicRef = doc(firestore, 'clinics', clinicId);
    const unsubscribe = onSnapshot(clinicRef, (snapshot) => {
      if (snapshot.exists()) {
        setClinic({ id: snapshot.id, ...snapshot.data() } as Clinic);
      }
    });

    return () => unsubscribe();
  }, [firestore, clinicId]);

  // Fetch doctors
  useEffect(() => {
    if (!firestore || !clinicId) return;

    const doctorsQuery = query(
      collection(firestore, 'doctors'),
      where('clinicId', '==', clinicId)
    );

    const unsubscribe = onSnapshot(doctorsQuery, (snapshot) => {
      const doctorsData = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      } as Doctor));
      setDoctors(doctorsData);
    });

    return () => unsubscribe();
  }, [firestore, clinicId]);

  // Fetch all appointments for today to check cutOffTime and confirmed status
  // Include appointments for the logged-in patient and all related patients
  useEffect(() => {
    if (!firestore || !user?.patientId || !clinicId) return;

    const today = getClinicDateString(getClinicNow());

    const fetchFamilyAppointments = async () => {
      try {
        // First, get the patient document to find related patients
        if (!user.patientId) return; // Guard against null patientId
        const patientDocRef = doc(firestore, 'patients', user.patientId);
        const patientDocSnap = await getDoc(patientDocRef);

        let allPatientIds = [user.patientId];

        if (patientDocSnap.exists()) {
          const patientData = patientDocSnap.data();
          if (patientData.relatedPatientIds && Array.isArray(patientData.relatedPatientIds)) {
            allPatientIds = [user.patientId, ...patientData.relatedPatientIds].filter(id => id);
          }
        }

        // Firestore 'in' query is limited to 30 elements
        const chunk = (arr: string[], size: number) =>
          Array.from({ length: Math.ceil(arr.length / size) }, (v, i) =>
            arr.slice(i * size, i * size + size)
          );

        const idChunks = chunk(allPatientIds.filter((id): id is string => id !== null), 30);

        // Set up listeners for each chunk and merge results
        // Use a Map to track appointments by chunk, then merge all
        const chunkData = new Map<number, Appointment[]>();

        const updateMergedAppointments = () => {
          const merged = new Map<string, Appointment>();
          chunkData.forEach(appointments => {
            appointments.forEach(apt => {
              merged.set(apt.id, apt);
            });
          });

          const allMergedAppointments = Array.from(merged.values()).filter(apt =>
            allPatientIds.includes(apt.patientId) &&
            apt.clinicId === clinicId &&
            apt.date === today
          );

          setAppointments(allMergedAppointments);
          setAppointmentsLoaded(true);
        };

        const unsubscribers = idChunks.map((chunkOfIds, chunkIndex) => {
          const appointmentsQuery = query(
            collection(firestore, 'appointments'),
            where('patientId', 'in', chunkOfIds),
            where('clinicId', '==', clinicId),
            where('date', '==', today),
            limit(1000)
          );

          return onSnapshot(appointmentsQuery, (snapshot) => {
            // Update this chunk's appointments
            const appointmentsData = snapshot.docs.map(doc => ({
              id: doc.id,
              ...doc.data()
            } as Appointment));

            chunkData.set(chunkIndex, appointmentsData);
            updateMergedAppointments();
          });
        });

        return () => {
          unsubscribers.forEach(unsub => unsub());
        };
      } catch (error) {
        console.error('Error fetching family appointments:', error);
        // Fallback to single patient query
        const appointmentsQuery = query(
          collection(firestore, 'appointments'),
          where('patientId', '==', user.patientId),
          where('clinicId', '==', clinicId),
          where('date', '==', today)
        );

        return onSnapshot(appointmentsQuery, (snapshot) => {
          const appointmentsData = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
          } as Appointment));
          setAppointments(appointmentsData);
          setAppointmentsLoaded(true);
        });
      }
    };

    let unsubscribe: (() => void) | null = null;

    fetchFamilyAppointments().then(unsub => {
      if (unsub) unsubscribe = unsub;
    });

    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, [firestore, user?.patientId, clinicId]);

  // Check location
  const checkLocation = () => {
    if (!clinic?.latitude || !clinic?.longitude) {
      setLocationError('Clinic location not available');
      return;
    }

    setIsCheckingLocation(true);
    setLocationError(null);

    if (!navigator.geolocation) {
      setLocationError('Geolocation is not supported by your browser');
      setIsCheckingLocation(false);
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude } = position.coords;
        setLocation({ lat: latitude, lng: longitude });

        const distance = calculateDistance(
          latitude,
          longitude,
          clinic.latitude!,
          clinic.longitude!
        );

        if (distance > 200) {
          setLocationError(`You are ${Math.round(distance)}m away from the clinic. Please be within 200m to confirm arrival.`);
        } else {
          setLocationError(null);
        }
        setIsCheckingLocation(false);
      },
      (error) => {
        let errorMsg = 'Could not access your location';
        if (error.code === 1) {
          errorMsg = 'Location access denied';
        } else if (error.code === 2) {
          errorMsg = 'Location unavailable';
        } else if (error.code === 3) {
          errorMsg = 'Location request timeout';
        }
        setLocationError(errorMsg);
        setIsCheckingLocation(false);
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0
      }
    );
  };

  // Check location on mount
  useEffect(() => {
    if (clinic?.latitude && clinic?.longitude) {
      checkLocation();
    }
  }, [clinic]);

  // Get pending appointments with cutOffTime in next 2 hours (from database only)
  const pendingAppointments = useMemo(() => {
    const now = getClinicNow();
    return appointments
      .filter(apt => {
        if (apt.status !== 'Pending') return false;
        // Only use cutOffTime from database, don't calculate fallback
        if (!apt.cutOffTime) return false;

        let cutOffDate: Date;
        try {
          // Convert Firestore Timestamp to Date
          if (apt.cutOffTime instanceof Timestamp) {
            cutOffDate = apt.cutOffTime.toDate();
          } else if (apt.cutOffTime?.toDate) {
            cutOffDate = apt.cutOffTime.toDate();
          } else if (apt.cutOffTime instanceof Date) {
            cutOffDate = apt.cutOffTime;
          } else {
            return false;
          }

          // Check if cutOffTime is within the next 2 hours (0 to 120 minutes from now)
          const minutesUntilCutOff = differenceInMinutes(cutOffDate, now);
          // Allow cutOffTime that is up to 2 hours in the future (0 to 120 minutes)
          // Also allow slightly in the past (up to 5 minutes) in case status update hasn't run yet
          return minutesUntilCutOff >= -5 && minutesUntilCutOff <= 120;
        } catch {
          return false;
        }
      })
      .sort((a, b) => {
        const timeA = parseTime(a.time, new Date()).getTime();
        const timeB = parseTime(b.time, new Date()).getTime();
        return timeA - timeB;
      });
  }, [appointments]);

  // Get skipped appointments
  const skippedAppointments = useMemo(() => {
    return appointments.filter(apt => apt.status === 'Skipped' || apt.status === 'No-show')
      .sort(compareAppointments);
  }, [appointments]);

  // Get confirmed appointments
  const confirmedAppointments = useMemo(() => {
    return appointments.filter(apt => apt.status === 'Confirmed');
  }, [appointments]);

  // Toggle expand/collapse
  const toggleExpand = (appointmentId: string) => {
    setExpandedAppointments(prev => {
      const newSet = new Set(prev);
      if (newSet.has(appointmentId)) {
        newSet.delete(appointmentId);
      } else {
        newSet.add(appointmentId);
      }
      return newSet;
    });
  };

  // Check if patient has Pending or Skipped appointments
  // For Pending: check cutOffTime within next 2 hours
  // For Skipped: always allow (no time restriction)
  const hasAppointmentInNext2Hours = useMemo(() => {
    // Filter to only Pending, Skipped and No-show appointments
    const pendingOrSkipped = appointments.filter(apt =>
      apt.status === 'Pending' || apt.status === 'Skipped' || apt.status === 'No-show'
    );

    if (!pendingOrSkipped.length) return false;

    const now = getClinicNow();

    return pendingOrSkipped.some(apt => {
      // Skipped appointments can always rejoin - no time restriction
      if (apt.status === 'Skipped') {
        return true;
      }

      // For Pending appointments, check cutOffTime within next 2 hours
      if (apt.status === 'Pending') {
        if (!apt.cutOffTime) return false;

        // Convert Firestore Timestamp to Date
        let cutOffDate: Date;
        if (apt.cutOffTime instanceof Timestamp) {
          cutOffDate = apt.cutOffTime.toDate();
        } else if (apt.cutOffTime?.toDate) {
          cutOffDate = apt.cutOffTime.toDate();
        } else if (apt.cutOffTime instanceof Date) {
          cutOffDate = apt.cutOffTime;
        } else {
          return false;
        }

        // Check if cutOffTime is within the next 2 hours (0 to 120 minutes from now)
        const minutesUntilCutOff = differenceInMinutes(cutOffDate, now);
        // Allow cutOffTime that is up to 2 hours in the future (0 to 120 minutes)
        // Also allow slightly in the past (up to 5 minutes) in case status update hasn't run yet
        return minutesUntilCutOff >= -5 && minutesUntilCutOff <= 120;
      }

      return false;
    });
  }, [appointments]);

  // Redirect to consult-today if no valid Pending/Skipped appointments
  // For Pending: must have cutOffTime in next 2 hours
  // For Skipped: always allowed (no time restriction)
  // BUT stay on page if there are any Confirmed appointments
  useEffect(() => {
    // Only redirect if we have clinicId, user is loaded, and appointments have been checked
    if (!clinicId || !user?.patientId || !firestore) return;

    // If there are confirmed appointments, redirect to live token page
    if (confirmedAppointments.length > 0) {
      // Find the most relevant confirmed appointment (e.g., the soonest one)
      // Since confirmedAppointments list is already filtered by clinic and sorted, we can take the first one?
      // Actually confirmedAppointments definition above doesn't have sort. Let's sort it here to be safe.
      const sortedConfirmed = [...confirmedAppointments].sort((a, b) => {
        const timeA = parseTime(a.time, new Date()).getTime();
        const timeB = parseTime(b.time, new Date()).getTime();
        return timeA - timeB;
      });

      const targetAppointment = sortedConfirmed[0];
      if (targetAppointment) {
        router.push(`/live-token/${targetAppointment.id}`);
        return;
      }
    }

    // Wait for appointments to load before checking
    // onSnapshot fires immediately, so we need to check after appointments are loaded
    const pendingOrSkipped = appointments.filter(apt =>
      apt.status === 'Pending' || apt.status === 'Skipped' || apt.status === 'No-show'
    );

    // If we have appointments loaded but no Pending/Skipped appointments at all, redirect
    if (appointments.length > 0 && pendingOrSkipped.length === 0) {
      // No Pending or Skipped appointments at all, redirect
      router.push(`/consult-today?clinicId=${clinicId}`);
    } else if (appointments.length > 0 && !hasAppointmentInNext2Hours) {
      // Have Pending/Skipped but none valid:
      // - Pending: cutOffTime must be in next 2 hours
      // - Skipped: always valid (but hasAppointmentInNext2Hours handles this now)
      // This should only redirect if there are no skipped appointments AND no valid pending appointments
      const hasSkippedAppointments = skippedAppointments.length > 0;
      if (!hasSkippedAppointments) {
        // No skipped appointments and no valid pending appointments, redirect
        router.push(`/consult-today?clinicId=${clinicId}`);
      }
    }
  }, [appointments, confirmedAppointments, hasAppointmentInNext2Hours, skippedAppointments.length, clinicId, router, user?.patientId, firestore]);

  useEffect(() => {
    if (!clinicId || !appointmentsLoaded) return;
    if (
      pendingAppointments.length === 0 &&
      skippedAppointments.length === 0 &&
      confirmedAppointments.length === 0
    ) {
      router.push(`/consult-today?clinicId=${clinicId}`);
    }
  }, [
    clinicId,
    appointmentsLoaded,
    pendingAppointments.length,
    skippedAppointments.length,
    confirmedAppointments.length,
    router,
  ]);

  // Check if location is valid
  const isLocationValid = useMemo(() => {
    if (!location || !clinic?.latitude || !clinic?.longitude) return false;
    const distance = calculateDistance(
      location.lat,
      location.lng,
      clinic.latitude,
      clinic.longitude
    );
    return distance <= 200;
  }, [location, clinic]);

  // Confirm arrival
  const handleConfirmArrival = async (appointment: Appointment) => {
    if (!firestore || !isLocationValid) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Please ensure you are within 200m of the clinic to confirm arrival.',
      });
      return;
    }

    setIsConfirming(appointment.id);

    try {
      const appointmentRef = doc(firestore, 'appointments', appointment.id);
      const appointmentDate = parse(appointment.date, 'd MMMM yyyy', new Date());
      const appointmentTime = parseTime(appointment.time, appointmentDate);
      const reportingTime = subMinutes(appointmentTime, 15);
      const now = getClinicNow();

      if (appointment.status === 'Pending') {
        // For Pending appointments, only allow confirmation before 15-minute mark
        if (isBefore(now, reportingTime)) {
          await runTransaction(firestore, async (transaction) => {
            const apptSnap = await transaction.get(appointmentRef);
            if (!apptSnap.exists() || apptSnap.data()?.status !== 'Pending') {
              throw new Error('Appointment status changed or not found.');
            }

            const updateData: any = { status: 'Confirmed', updatedAt: serverTimestamp() };

            if (clinic?.tokenDistribution === 'classic') {
              updateData.confirmedAt = serverTimestamp();
              const classicCounterId = getClassicTokenCounterId(clinic.id, appointment.doctor, appointment.date, appointment.sessionIndex || 0);
              const classicCounterRef = doc(firestore, 'token-counters', classicCounterId);
              const counterState = await prepareNextClassicTokenNumber(transaction, classicCounterRef);
              updateData.classicTokenNumber = counterState.nextNumber.toString().padStart(3, '0');
              commitNextClassicTokenNumber(transaction, classicCounterRef, counterState);
            }

            transaction.update(appointmentRef, updateData);
          });

          toast({
            title: 'Arrival Confirmed',
            description: 'Your arrival has been confirmed. Please wait for your turn.',
          });
        } else {
          // Too late - should have been skipped by status update service
          toast({
            variant: 'destructive',
            title: 'Too Late',
            description: 'You must confirm before 15 minutes of your appointment time. Your appointment has been skipped.',
          });
        }
      } else if (appointment.status === 'Skipped' || appointment.status === 'No-show') {
        // For Skipped/No-show appointments, rejoin queue using deterministic logic
        if (!appointment.noShowTime) {
          throw new Error('Appointment missing noShowTime. Cannot rejoin automatically.');
        }

        const now = getClinicNow();
        const scheduledTime = parseTime(appointment.time, appointmentDate);

        // Convert noShowTime to Date
        const noShowDate = (appointment.noShowTime as any)?.toDate
          ? (appointment.noShowTime as any).toDate()
          : parseTime(appointment.noShowTime!, appointmentDate);

        let newTime: Date;
        if (isAfter(now, scheduledTime)) {
          // Current time past the 'time' -> noShowTime + 15 minutes
          newTime = addMinutes(noShowDate, 15);
        } else {
          // Current time didn't pass 'time' -> noShowTime
          newTime = noShowDate;
        }

        const newTimeString = format(newTime, 'hh:mm a');

        await runTransaction(firestore, async (transaction) => {
          const apptSnap = await transaction.get(appointmentRef);
          if (!apptSnap.exists()) throw new Error('Appointment not found.');

          const updateData: any = {
            status: 'Confirmed',
            time: newTimeString,
            skippedAt: serverTimestamp(), // Mark AS rejoined
            updatedAt: serverTimestamp(),
          };

          if (clinic?.tokenDistribution === 'classic') {
            updateData.confirmedAt = serverTimestamp();
            const classicCounterId = getClassicTokenCounterId(clinic.id, appointment.doctor, appointment.date, appointment.sessionIndex || 0);
            const classicCounterRef = doc(firestore, 'token-counters', classicCounterId);
            const counterState = await prepareNextClassicTokenNumber(transaction, classicCounterRef);
            updateData.classicTokenNumber = counterState.nextNumber.toString().padStart(3, '0');
            commitNextClassicTokenNumber(transaction, classicCounterRef, counterState);
          }

          transaction.update(appointmentRef, updateData);
        });

        toast({
          title: 'Arrival Confirmed',
          description: `You have been added back to the queue. Your new appointment time is ${newTimeString}.`,
        });
      }
    } catch (error: any) {
      console.error('Error confirming arrival:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message || 'Could not confirm arrival. Please try again.',
      });
    } finally {
      setIsConfirming(null);
    }
  };

  // Update late minutes
  const handleUpdateLateMinutes = async (appointment: Appointment, minutes: number) => {
    if (!firestore) return;

    setIsUpdatingLate(appointment.id);

    try {
      const appointmentDate = parse(appointment.date, 'd MMMM yyyy', new Date());
      const appointmentTime = parseTime(appointment.time, appointmentDate);
      const now = getClinicNow();

      // Check if it's before appointment time
      if (isAfter(now, appointmentTime)) {
        toast({
          variant: 'destructive',
          title: 'Error',
          description: 'Cannot update late minutes after appointment time.',
        });
        setIsUpdatingLate(null);
        return;
      }

      // Update appointment with late minutes
      const appointmentRef = doc(firestore, 'appointments', appointment.id);
      await updateDoc(appointmentRef, {
        lateMinutes: minutes
      });

      setLateMinutes(prev => ({ ...prev, [appointment.id]: minutes }));

      toast({
        title: 'Late Minutes Updated',
        description: `Late minutes set to ${minutes} minutes.`,
      });
    } catch (error: any) {
      console.error('Error updating late minutes:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message || 'Could not update late minutes. Please try again.',
      });
    } finally {
      setIsUpdatingLate(null);
    }
  };

  if (!clinic) {
    return (
      <div className="flex min-h-screen w-full flex-col items-center justify-center bg-background p-6">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
        <p className="mt-4 text-muted-foreground">Loading clinic details...</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen w-full flex-col font-body">
      <div className="flex-grow bg-card">
        <div className="bg-primary text-primary-foreground p-6 rounded-b-[2rem] pb-24">
          <h1 className="text-2xl font-bold mb-2">Confirm Arrival</h1>
          <p className="text-sm opacity-90">{clinic.name}</p>
        </div>

        <main className="p-6 space-y-6 bg-background rounded-t-[2rem] -mt-16 pt-8 pb-24">
          {/* Location Status */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <MapPin className="h-5 w-5" />
                Location Status
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {isCheckingLocation ? (
                <div className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span className="text-sm text-muted-foreground">Checking location...</span>
                </div>
              ) : locationError ? (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertTitle>Location Error</AlertTitle>
                  <AlertDescription>{locationError}</AlertDescription>
                </Alert>
              ) : isLocationValid ? (
                <Alert className="bg-green-50 border-green-200">
                  <CheckCircle2 className="h-4 w-4 text-green-600" />
                  <AlertTitle className="text-green-800">Location Verified</AlertTitle>
                  <AlertDescription className="text-green-700">
                    You are within 200m of the clinic.
                  </AlertDescription>
                </Alert>
              ) : (
                <Alert>
                  <AlertCircle className="h-4 w-4" />
                  <AlertTitle>Location Not Verified</AlertTitle>
                  <AlertDescription>
                    Please allow location access to confirm arrival.
                  </AlertDescription>
                </Alert>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={checkLocation}
                disabled={isCheckingLocation}
              >
                {isCheckingLocation ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Checking...
                  </>
                ) : (
                  'Check Location'
                )}
              </Button>
            </CardContent>
          </Card>

          {/* Pending Appointments */}
          {pendingAppointments.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Pending Appointments</CardTitle>
                <CardDescription>
                  Confirm your arrival at least 15 minutes before your appointment time.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {pendingAppointments.map((appointment) => {
                  const appointmentDate = parse(appointment.date, 'd MMMM yyyy', new Date());
                  const appointmentTime = parseTime(appointment.time, appointmentDate);
                  const reportingTime = subMinutes(appointmentTime, 15);
                  const now = new Date();
                  const canConfirm = isBefore(now, reportingTime);
                  const isExpanded = expandedAppointments.has(appointment.id);
                  const isConfirmed = confirmedAppointments.some(apt => apt.patientName === appointment.patientName);

                  // Get cutOffTime from database
                  let cutOffTimeDisplay = '--';
                  if (appointment.cutOffTime) {
                    try {
                      let cutOffDate: Date;
                      if (appointment.cutOffTime instanceof Timestamp) {
                        cutOffDate = appointment.cutOffTime.toDate();
                      } else if (appointment.cutOffTime?.toDate) {
                        cutOffDate = appointment.cutOffTime.toDate();
                      } else if (appointment.cutOffTime instanceof Date) {
                        cutOffDate = appointment.cutOffTime;
                      } else {
                        cutOffDate = new Date(appointment.cutOffTime);
                      }
                      cutOffTimeDisplay = format(cutOffDate, 'hh:mm a');
                    } catch {
                      cutOffTimeDisplay = '--';
                    }
                  }

                  return (
                    <Card key={appointment.id} className="border-2">
                      <CardContent className="p-4 space-y-3">
                        <div
                          className="flex items-start justify-between cursor-pointer"
                          onClick={() => toggleExpand(appointment.id)}
                        >
                          <div className="flex-1">
                            <div className="flex items-center gap-2">
                              <h3 className="font-semibold text-lg">{appointment.patientName}</h3>
                              {isConfirmed && (
                                <CheckCircle2 className="h-5 w-5 text-green-600" />
                              )}
                            </div>
                            <p className="text-sm text-muted-foreground">
                              Age: {appointment.age} {appointment.place && `• ${appointment.place}`}
                            </p>
                            {isExpanded && (
                              <div className="mt-2 space-y-1">
                                <p className="text-sm text-muted-foreground">
                                  Doctor: {appointment.doctor}
                                </p>
                                <p className="text-sm text-muted-foreground">
                                  Department: {appointment.department}
                                </p>
                                <p className="text-sm">
                                  <Clock className="inline h-4 w-4 mr-1" />
                                  {t.home.arriveBy}: {(() => {
                                    const appointmentDoctor = doctors.find(d => d.name === appointment.doctor);
                                    return getArriveByTimeFromAppointment(appointment, appointmentDoctor);
                                  })()}
                                </p>
                                {appointment.delay && appointment.delay > 0 && (
                                  <p className="text-xs text-orange-600 dark:text-orange-400 mt-1">
                                    ⏱️ Delayed by {appointment.delay} min
                                  </p>
                                )}
                                <p className="text-sm text-muted-foreground">
                                  Token: {appointment.tokenNumber}
                                </p>
                              </div>
                            )}
                          </div>
                          <div className="flex items-center gap-2">
                            {!isExpanded && (
                              <p className="text-sm text-muted-foreground">
                                Report by: {cutOffTimeDisplay}
                              </p>
                            )}
                            {isExpanded ? (
                              <ChevronUp className="h-5 w-5 text-muted-foreground" />
                            ) : (
                              <ChevronDown className="h-5 w-5 text-muted-foreground" />
                            )}
                          </div>
                        </div>
                        {isExpanded && (
                          <>
                            <div className="flex items-center justify-end">
                              <p className="text-sm text-muted-foreground">
                                Report by: {cutOffTimeDisplay}
                              </p>
                            </div>
                            <Button
                              className="w-full"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleConfirmArrival(appointment);
                              }}
                              disabled={!isLocationValid || isConfirming === appointment.id || !canConfirm}
                            >
                              {isConfirming === appointment.id ? (
                                <>
                                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                  Confirming...
                                </>
                              ) : !canConfirm ? (
                                <>
                                  <AlertCircle className="mr-2 h-4 w-4" />
                                  Too Late - Appointment Skipped
                                </>
                              ) : (
                                <>
                                  <CheckCircle2 className="mr-2 h-4 w-4" />
                                  Confirm Arrival
                                </>
                              )}
                            </Button>
                            {!canConfirm && (
                              <p className="text-sm text-destructive text-center mt-2">
                                You must confirm before the cut-off time. Please use the "Rejoin Queue" option below once your appointment is skipped.
                              </p>
                            )}
                          </>
                        )}
                      </CardContent>
                    </Card>
                  );
                })}
              </CardContent>
            </Card>
          )}

          {/* Confirmed Appointments - Show "See Live Queue" button if any confirmed */}
          {confirmedAppointments.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Confirmed Appointments</CardTitle>
                <CardDescription>
                  Your arrival has been confirmed. You can view your live queue status.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button
                  className="w-full"
                  onClick={() => router.push(`/live-token?clinicId=${clinicId}`)}
                >
                  <Clock className="mr-2 h-4 w-4" />
                  See the Live Queue
                </Button>
              </CardContent>
            </Card>
          )}

          {/* Skipped Appointments */}
          {skippedAppointments.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Skipped Appointments</CardTitle>
                <CardDescription>
                  Update late minutes and confirm arrival to rejoin the queue.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {skippedAppointments.map((appointment) => {
                  const appointmentDate = parse(appointment.date, 'd MMMM yyyy', new Date());
                  const appointmentTime = parseTime(appointment.time, appointmentDate);
                  const reportingTime = subMinutes(appointmentTime, 15);
                  const now = new Date();
                  const lateMinutesForAppointment = appointment.lateMinutes || lateMinutes[appointment.id] || 0;
                  const canUpdateLate = isBefore(now, appointmentTime);
                  const maxLateTime = lateMinutesForAppointment > 0
                    ? addMinutes(reportingTime, lateMinutesForAppointment)
                    : reportingTime;
                  const isExpanded = expandedAppointments.has(appointment.id);
                  const isConfirmed = confirmedAppointments.some(apt => apt.patientName === appointment.patientName);

                  return (
                    <Card key={appointment.id} className="border-2 border-orange-200">
                      <CardContent className="p-4 space-y-3">
                        <div
                          className="flex items-start justify-between cursor-pointer"
                          onClick={() => toggleExpand(appointment.id)}
                        >
                          <div className="flex-1">
                            <div className="flex items-center gap-2">
                              <h3 className="font-semibold text-lg">{appointment.patientName}</h3>
                              {isConfirmed && (
                                <CheckCircle2 className="h-5 w-5 text-green-600" />
                              )}
                            </div>
                            <p className="text-sm text-muted-foreground">
                              Age: {appointment.age} {appointment.place && `• ${appointment.place}`}
                            </p>
                            {isExpanded && (
                              <div className="mt-2 space-y-1">
                                <p className="text-sm text-muted-foreground">
                                  Doctor: {appointment.doctor}
                                </p>
                                <p className="text-sm text-muted-foreground">
                                  Department: {appointment.department}
                                </p>
                                <p className="text-sm">
                                  <Clock className="inline h-4 w-4 mr-1" />
                                  {t.home.arriveBy}: {(() => {
                                    const appointmentDoctor = doctors.find(d => d.name === appointment.doctor);
                                    return getArriveByTimeFromAppointment(appointment, appointmentDoctor);
                                  })()}
                                </p>
                                {appointment.delay && appointment.delay > 0 && (
                                  <p className="text-xs text-orange-600 dark:text-orange-400 mt-1">
                                    ⏱️ Delayed by {appointment.delay} min
                                  </p>
                                )}
                                <p className="text-sm text-muted-foreground">
                                  Token: {appointment.tokenNumber}
                                </p>
                                {lateMinutesForAppointment > 0 && (
                                  <p className="text-sm text-orange-600">
                                    Late minutes: {lateMinutesForAppointment} min (No-show after: {format(maxLateTime, 'hh:mm a')})
                                  </p>
                                )}
                              </div>
                            )}
                          </div>
                          <div className="flex items-center gap-2">
                            {!isExpanded && (
                              <Badge variant="destructive">{appointment.status}</Badge>
                            )}
                            {isExpanded ? (
                              <ChevronUp className="h-5 w-5 text-muted-foreground" />
                            ) : (
                              <ChevronDown className="h-5 w-5 text-muted-foreground" />
                            )}
                          </div>
                        </div>
                        {isExpanded && (
                          <>
                            <div className="flex items-center justify-end">
                              <Badge variant="destructive">{appointment.status}</Badge>
                            </div>
                            {canUpdateLate && (
                              <div className="space-y-2">
                                <label className="text-sm font-medium">Update Late Minutes</label>
                                <Select
                                  value={lateMinutesForAppointment.toString()}
                                  onValueChange={(value) => handleUpdateLateMinutes(appointment, parseInt(value))}
                                  disabled={isUpdatingLate === appointment.id}
                                >
                                  <SelectTrigger>
                                    <SelectValue placeholder="Select late minutes" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="0">0 minutes</SelectItem>
                                    <SelectItem value="10">10 minutes</SelectItem>
                                    <SelectItem value="15">15 minutes</SelectItem>
                                    <SelectItem value="20">20 minutes</SelectItem>
                                    <SelectItem value="25">25 minutes</SelectItem>
                                    <SelectItem value="30">30 minutes</SelectItem>
                                  </SelectContent>
                                </Select>
                              </div>
                            )}
                            <Button
                              className="w-full"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleConfirmArrival(appointment);
                              }}
                              disabled={!isLocationValid || isConfirming === appointment.id}
                            >
                              {isConfirming === appointment.id ? (
                                <>
                                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                  Rejoining Queue...
                                </>
                              ) : (
                                <>
                                  <UserPlus className="mr-2 h-4 w-4" />
                                  Rejoin Queue
                                </>
                              )}
                            </Button>
                          </>
                        )}
                      </CardContent>
                    </Card>
                  );
                })}
              </CardContent>
            </Card>
          )}

          {pendingAppointments.length === 0 && skippedAppointments.length === 0 && (
            <Card>
              <CardContent className="p-6 text-center">
                <p className="text-muted-foreground">No pending or skipped appointments found for today.</p>
              </CardContent>
            </Card>
          )}

        </main>
      </div>
      <BottomNav />
    </div>
  );
}

function ConfirmArrivalPageWithAuth() {
  return (
    <AuthGuard>
      <ConfirmArrivalPage />
    </AuthGuard>
  );
}

export default ConfirmArrivalPageWithAuth;

