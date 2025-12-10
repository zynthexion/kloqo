
'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import Image from 'next/image';
import Link from 'next/link';
import { ArrowLeft, Loader2, CheckCircle2, Clock, Users, Calendar, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import AppFrameLayout from '@/components/layout/app-frame';
import { db } from '@/lib/firebase';
import { doc, getDoc, collection, addDoc, query, where, getDocs, serverTimestamp, updateDoc, arrayUnion, increment, setDoc, deleteDoc, runTransaction } from 'firebase/firestore';
import type { Appointment, Doctor, Patient } from '@/lib/types';
import { useToast } from '@/hooks/use-toast';
import { format, isWithinInterval, subMinutes, parse, addMinutes, isBefore, differenceInMinutes, parseISO, isAfter } from 'date-fns';
import { parseTime } from '@/lib/utils';
import { cn } from '@/lib/utils';
import { errorEmitter } from '@kloqo/shared-core';
import { FirestorePermissionError } from '@kloqo/shared-core';
import { managePatient } from '@kloqo/shared-core';
import { calculateWalkInDetails, generateNextTokenAndReserveSlot } from '@kloqo/shared-core';

import PatientSearchResults from '@/components/clinic/patient-search-results';
import { getCurrentActiveSession, getSessionEnd, getSessionBreakIntervals, type BreakInterval } from '@kloqo/shared-core';

const formSchema = z
  .object({
    patientName: z.string().min(2, { message: 'Name must be at least 2 characters.' }),
    age: z.coerce.number().int().positive({ message: 'Age must be a positive number.' }),
    place: z.string().min(2, { message: 'Place is required.' }),
    sex: z.string().min(1, { message: 'Sex is required.' }),
    phone: z.string().optional(),
    phoneDisabled: z.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.phoneDisabled) {
      return;
    }

    const value = data.phone ?? '';
    const cleaned = value.replace(/^\+91/, '').replace(/\D/g, '');

    if (!cleaned || cleaned.length !== 10 || !/^\d{10}$/.test(cleaned)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['phone'],
        message: 'Please enter exactly 10 digits for the phone number.',
      });
    }
  });

// Define a type for the unsaved appointment data
type UnsavedAppointment = Omit<Appointment, 'id'> & { createdAt: any };



const releaseReservation = async (reservationId?: string | null, delayMs: number = 0) => {
  if (!reservationId) return;
  if (delayMs > 0) {
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  try {
    await deleteDoc(doc(db, 'slot-reservations', reservationId));
    console.log('🧹 [NURSE APP] Released slot reservation:', reservationId);
  } catch (error) {
    console.warn('⚠️ [NURSE APP] Failed to release reservation:', { reservationId, error });
  }
};

function buildBreakIntervals(doctor: Doctor | null, referenceDate: Date | null): BreakInterval[] {
  if (!doctor?.leaveSlots || !referenceDate) {
    return [];
  }

  const consultationTime = doctor.averageConsultingTime || 15;

  const slotsForDay = (doctor.leaveSlots || [])
    .map((leave) => {
      if (typeof leave === 'string') {
        try {
          return parseISO(leave);
        } catch {
          return null;
        }
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
    .filter((date): date is Date => !!date && !isNaN(date.getTime()) && format(date, 'yyyy-MM-dd') === format(referenceDate, 'yyyy-MM-dd'))
    .sort((a, b) => a.getTime() - b.getTime());

  if (slotsForDay.length === 0) {
    return [];
  }

  const intervals: BreakInterval[] = [];
  let currentInterval: BreakInterval | null = null;

  for (const slot of slotsForDay) {
    if (!currentInterval) {
      currentInterval = { start: slot, end: addMinutes(slot, consultationTime), sessionIndex: 0 };
      continue;
    }

    if (slot.getTime() === currentInterval.end.getTime()) {
      currentInterval.end = addMinutes(slot, consultationTime);
    } else {
      intervals.push(currentInterval);
      currentInterval = { start: slot, end: addMinutes(slot, consultationTime), sessionIndex: 0 };
    }
  }

  if (currentInterval) {
    intervals.push(currentInterval);
  }

  return intervals;
}

function applyBreakOffsets(originalTime: Date, intervals: BreakInterval[]): Date {
  return intervals.reduce((acc, interval) => {
    if (acc.getTime() >= interval.start.getTime()) {
      const offset = differenceInMinutes(interval.end, interval.start);
      return addMinutes(acc, offset);
    }
    return acc;
  }, new Date(originalTime));
}

function getAvailabilityEndForDate(doctor: Doctor | null, referenceDate: Date | null): Date | null {
  if (!doctor || !referenceDate || !doctor.availabilitySlots?.length) return null;

  const dayOfWeek = format(referenceDate, 'EEEE');
  const availabilityForDay = doctor.availabilitySlots.find((slot) => slot.day === dayOfWeek);
  if (!availabilityForDay || !availabilityForDay.timeSlots?.length) return null;

  const lastSession = availabilityForDay.timeSlots[availabilityForDay.timeSlots.length - 1];
  let availabilityEnd = parseTime(lastSession.to, referenceDate);

  const dateKey = format(referenceDate, 'd MMMM yyyy');
  const extensions = (doctor as any).availabilityExtensions as
    | { [date: string]: { extendedBy: number; originalEndTime: string; newEndTime: string } }
    | undefined;
  const extension = extensions?.[dateKey];

  if (extension?.newEndTime) {
    try {
      const extendedEnd = parseTime(extension.newEndTime, referenceDate);
      if (extendedEnd.getTime() > availabilityEnd.getTime()) {
        availabilityEnd = extendedEnd;
      }
    } catch {
      // ignore malformed extension
    }
  }

  return availabilityEnd;
}

function WalkInRegistrationContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const doctorIdFromParams = searchParams.get('doctor');

  const [doctor, setDoctor] = useState<Doctor | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [activeTab, setActiveTab] = useState('manual');
  const [currentTime, setCurrentTime] = useState(new Date());
  const [clinicId, setClinicId] = useState<string | null>(null);
  const [qrCodeUrl, setQrCodeUrl] = useState('');

  const [isEstimateModalOpen, setIsEstimateModalOpen] = useState(false);
  const [isTokenModalOpen, setIsTokenModalOpen] = useState(false);
  const [generatedToken, setGeneratedToken] = useState<string | null>(null);
  const [estimatedConsultationTime, setEstimatedConsultationTime] = useState<Date | null>(null);
  const [patientsAhead, setPatientsAhead] = useState(0);
  const [loading, setLoading] = useState(true);
  const [appointmentToSave, setAppointmentToSave] = useState<UnsavedAppointment | null>(null);


  // States for patient search
  const [phoneNumber, setPhoneNumber] = useState('');
  const [isSearchingPatient, setIsSearchingPatient] = useState(false);
  const [searchedPatients, setSearchedPatients] = useState<Patient[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [selectedPatientId, setSelectedPatientId] = useState<string | null>(null);
  const [selectedPatient, setSelectedPatient] = useState<Patient | null>(null);
  const [isPhoneDisabled, setIsPhoneDisabled] = useState(false);


  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: { patientName: '', age: undefined, place: '', sex: '', phone: '', phoneDisabled: false },
  });

  useEffect(() => {
    const id = localStorage.getItem('clinicId');
    if (!id) {
      router.push('/login');
      return;
    }
    setClinicId(id);
    const baseUrl = window.location.origin;
    const url = `${baseUrl}/patient-form?clinicId=${id}`;
    setQrCodeUrl(`https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(url)}`);

    const timer = setInterval(() => setCurrentTime(new Date()), 60000);
    return () => clearInterval(timer);
  }, [router]);

  const handlePatientSearch = useCallback(async (phone: string) => {
    if (phone.length < 10 || !clinicId) {
      setSearchedPatients([]);
      setShowForm(false);
      setSelectedPatientId(null);
      setSelectedPatient(null);
      setIsPhoneDisabled(false);
      form.reset({ patientName: '', age: undefined, place: '', sex: '', phone: '', phoneDisabled: false });
      return;
    };
    setIsSearchingPatient(true);
    setShowForm(false);
    setSelectedPatientId(null);
    setSelectedPatient(null);
    setIsPhoneDisabled(false);
    form.reset({ patientName: '', age: undefined, place: '', sex: '', phone: '', phoneDisabled: false });
    form.clearErrors();

    try {
      const fullPhoneNumber = `+91${phone}`;
      const patientsRef = collection(db, 'patients');

      // Find the primary user record first based on the phone number
      const primaryQuery = query(patientsRef, where('phone', '==', fullPhoneNumber));
      const primarySnapshot = await getDocs(primaryQuery);

      if (primarySnapshot.empty) {
        setSearchedPatients([]);
        setShowForm(true); // No user found, show form to create one
        setSelectedPatientId(null);
        setSelectedPatient(null);
        setIsPhoneDisabled(false);
        form.setValue('phoneDisabled', false);
        form.setValue('phone', phone);
        setPhoneNumber(phone);
        return;
      }

      const primaryDoc = primarySnapshot.docs[0];
      const primaryPatient = { id: primaryDoc.id, ...primaryDoc.data() } as Patient;
      primaryPatient.isKloqoMember = primaryPatient.clinicIds?.includes(clinicId);

      let allRelatedPatients: Patient[] = [primaryPatient];

      if (primaryPatient.relatedPatientIds && primaryPatient.relatedPatientIds.length > 0) {
        const relatedPatientsQuery = query(patientsRef, where('__name__', 'in', primaryPatient.relatedPatientIds));
        const relatedSnapshot = await getDocs(relatedPatientsQuery);
        const relatedPatients = relatedSnapshot.docs.map(doc => {
          const data = { id: doc.id, ...doc.data() } as Patient;
          data.isKloqoMember = data.clinicIds?.includes(clinicId);
          return data;
        });
        allRelatedPatients = [...allRelatedPatients, ...relatedPatients];
      }

      setSearchedPatients(allRelatedPatients);

    } catch (error) {
      console.error("Error searching patient:", error);
      toast({ variant: 'destructive', title: 'Search Error', description: 'Could not perform patient search.' });
    } finally {
      setIsSearchingPatient(false);
    }
  }, [clinicId, toast, form]);


  useEffect(() => {
    // Don't trigger search if a patient is already selected (to prevent form from disappearing)
    if (selectedPatientId) {
      return;
    }

    const debounceTimer = setTimeout(() => {
      if (phoneNumber && phoneNumber.length === 10) {
        handlePatientSearch(phoneNumber);
      } else {
        setSearchedPatients([]);
        setShowForm(false);
        setSelectedPatientId(null);
        setSelectedPatient(null);
        setIsPhoneDisabled(false);
        form.setValue('phoneDisabled', false);
        form.clearErrors('phone');
      }
    }, 500);

    return () => clearTimeout(debounceTimer);
  }, [phoneNumber, handlePatientSearch, selectedPatientId, form]);

  const selectPatient = (patient: Patient) => {
    setSelectedPatientId(patient.id);
    setSelectedPatient(patient);

    const rawPhone = typeof patient.phone === 'string' ? patient.phone : '';
    const cleanedPhone = rawPhone.replace(/^\+91/, '').replace(/\D/g, '').slice(-10);
    const hasValidPhone = cleanedPhone.length === 10;

    setIsPhoneDisabled(!hasValidPhone);

    form.reset({
      patientName: patient.name ?? '',
      age: (patient.age as number | undefined) ?? undefined,
      place: patient.place ?? '',
      sex: patient.sex ?? '',
      phone: hasValidPhone ? cleanedPhone : '',
      phoneDisabled: !hasValidPhone,
    });

    if (hasValidPhone) {
      setPhoneNumber(cleanedPhone);
    } else {
      setPhoneNumber('');
      form.clearErrors('phone');
    }

    setShowForm(true);
  };


  // Session-aware walk-in availability check
  const isDoctorConsultingNow = useMemo(() => {
    if (!doctor?.availabilitySlots) return false;

    const today = new Date(currentTime.getFullYear(), currentTime.getMonth(), currentTime.getDate());

    // Get current active session (session-aware walk-in)
    const activeSession = getCurrentActiveSession(doctor, currentTime, today);

    if (!activeSession) return false;

    // Walk-in window: 30 minutes before session start to 15 minutes before effective end
    // Effective end already includes break duration in getCurrentActiveSession
    const walkInOpenTime = subMinutes(activeSession.sessionStart, 30);
    const walkInCloseTime = subMinutes(activeSession.effectiveEnd, 15);

    // Check if current time is within walk-in window for this session
    return currentTime >= walkInOpenTime && currentTime <= walkInCloseTime;
  }, [doctor, currentTime]);

  useEffect(() => {
    if (!clinicId) return;
    const fetchDoctor = async () => {
      const doctorId = doctorIdFromParams || localStorage.getItem('selectedDoctorId');
      if (!doctorId) {
        setLoading(false);
        toast({ variant: 'destructive', title: 'Error', description: 'No doctor selected.' });
        return;
      }
      try {
        const docRef = doc(db, 'doctors', doctorId);
        const docSnap = await getDoc(docRef).catch(async (serverError) => {
          const permissionError = new FirestorePermissionError({ path: docRef.path, operation: 'get' });
          errorEmitter.emit('permission-error', permissionError);
          throw serverError;
        });

        if (docSnap.exists() && docSnap.data().clinicId === clinicId) {
          setDoctor({ id: docSnap.id, ...docSnap.data() } as Doctor);
        } else {
          toast({ variant: 'destructive', title: 'Error', description: 'Doctor not found.' });
        }
      } catch (error: any) {
        if (error.name !== 'FirestorePermissionError') {
          console.error('Error fetching doctor:', error);
          toast({ variant: 'destructive', title: 'Error', description: 'Could not fetch doctor details.' });
        }
      } finally {
        setLoading(false);
      }
    };
    fetchDoctor();
  }, [doctorIdFromParams, toast, clinicId]);

  async function onSubmit(values: z.infer<typeof formSchema>) {
    console.log('[NURSE:GET-TOKEN] ====== GET TOKEN BUTTON CLICKED ======');
    console.log('[NURSE:GET-TOKEN] Initial state:', {
      hasDoctor: !!doctor,
      doctorName: doctor?.name,
      hasClinicId: !!clinicId,
      clinicId,
      formValues: {
        patientName: values.patientName,
        age: values.age,
        place: values.place,
        sex: values.sex,
        phone: values.phone,
        phoneDisabled: values.phoneDisabled,
      },
      selectedPatientId,
      hasSelectedPatient: !!selectedPatient,
      timestamp: new Date().toISOString(),
    });

    if (!doctor || !clinicId) {
      console.error('[NURSE:GET-TOKEN] ❌ Missing required data:', { hasDoctor: !!doctor, hasClinicId: !!clinicId });
      toast({ variant: 'destructive', title: 'Error', description: 'Doctor or clinic not identified.' });
      return;
    }
    setIsSubmitting(true);

    try {
      console.log('[NURSE:GET-TOKEN] Step 1: Fetching clinic data...');
      const clinicDocRef = doc(db, 'clinics', clinicId);
      const clinicSnap = await getDoc(clinicDocRef);
      const clinicData = clinicSnap.data();
      const walkInTokenAllotment = clinicData?.walkInTokenAllotment || 5;
      console.log('[NURSE:GET-TOKEN] Clinic data:', { walkInTokenAllotment, clinicId });

      console.log('[NURSE:GET-TOKEN] Step 2: Calculating walk-in details...');
      const { estimatedTime, patientsAhead, slotIndex, sessionIndex, numericToken } = await calculateWalkInDetails(doctor, walkInTokenAllotment);
      console.log('[NURSE:GET-TOKEN] Walk-in details calculated:', {
        estimatedTime: estimatedTime?.toISOString(),
        estimatedTimeFormatted: estimatedTime ? format(estimatedTime, 'hh:mm a') : 'N/A',
        patientsAhead,
        slotIndex,
        sessionIndex,
        numericToken,
      });

      console.log('[NURSE:GET-TOKEN] Step 3: Processing patient data...');
      const phoneDisabled = values.phoneDisabled ?? false;
      let fullPhoneNumber = '';

      if (!phoneDisabled && values.phone) {
        const cleaned = values.phone.replace(/^\+91/, '').replace(/\D/g, '');
        if (cleaned.length === 10) {
          fullPhoneNumber = `+91${cleaned}`;
        }
      }

      console.log('[NURSE:GET-TOKEN] Phone processing:', {
        phoneDisabled,
        rawPhone: values.phone,
        fullPhoneNumber,
        selectedPatientPhone: selectedPatient?.phone,
        selectedPatientCommPhone: selectedPatient?.communicationPhone,
      });

      if (!phoneDisabled && !fullPhoneNumber) {
        console.error('[NURSE:GET-TOKEN] ❌ Phone validation failed');
        toast({ variant: 'destructive', title: 'Error', description: 'Please enter a valid 10-digit phone number.' });
        setIsSubmitting(false);
        return;
      }

      const contactPhone = fullPhoneNumber || selectedPatient?.communicationPhone || selectedPatient?.phone || '';
      console.log('[NURSE:GET-TOKEN] Contact phone determined:', contactPhone);

      let patientId: string;
      if (selectedPatientId) {
        console.log('[NURSE:GET-TOKEN] Step 4a: Updating existing patient...', { selectedPatientId });
        patientId = await managePatient({
          id: selectedPatientId,
          phone: fullPhoneNumber || selectedPatient?.phone || '',
          communicationPhone: contactPhone,
          name: values.patientName,
          age: values.age,
          place: values.place,
          sex: values.sex,
          clinicId,
          bookingFor: 'update',
        });
        console.log('[NURSE:GET-TOKEN] Patient updated:', { patientId });
      } else {
        if (!fullPhoneNumber) {
          console.error('[NURSE:GET-TOKEN] ❌ New patient requires phone number');
          toast({ variant: 'destructive', title: 'Error', description: 'Please enter a valid 10-digit phone number.' });
          setIsSubmitting(false);
          return;
        }

        console.log('[NURSE:GET-TOKEN] Step 4b: Creating new patient...');
        patientId = await managePatient({
          phone: fullPhoneNumber,
          communicationPhone: contactPhone || fullPhoneNumber,
          name: values.patientName,
          age: values.age,
          place: values.place,
          sex: values.sex,
          clinicId,
          bookingFor: 'self',
        });
        console.log('[NURSE:GET-TOKEN] New patient created:', { patientId });
      }

      // Check for duplicate booking - same patient, same doctor, same day
      console.log('[NURSE:GET-TOKEN] Step 5: Checking for duplicate appointments...');
      const appointmentDateStr = format(new Date(), "d MMMM yyyy");
      const duplicateCheckQuery = query(
        collection(db, "appointments"),
        where("patientId", "==", patientId),
        where("doctor", "==", doctor.name),
        where("date", "==", appointmentDateStr),
        where("status", "in", ["Pending", "Confirmed", "Completed", "Skipped"])
      );

      const duplicateSnapshot = await getDocs(duplicateCheckQuery);
      console.log('[NURSE:GET-TOKEN] Duplicate check result:', {
        foundDuplicates: !duplicateSnapshot.empty,
        duplicateCount: duplicateSnapshot.docs.length,
        duplicates: duplicateSnapshot.docs.map(doc => ({
          id: doc.id,
          status: doc.data().status,
          tokenNumber: doc.data().tokenNumber,
          time: doc.data().time,
        })),
      });
      if (!duplicateSnapshot.empty) {
        console.error('[NURSE:GET-TOKEN] ❌ Duplicate appointment found');
        toast({
          variant: "destructive",
          title: "Duplicate Booking",
          description: "This patient already has an appointment with this doctor today.",
        });
        setIsSubmitting(false);
        return;
      }

      console.log('[NURSE:GET-TOKEN] Step 6: Calculating break offsets and validating...');
      const previewTokenNumber = `W${String(numericToken).padStart(3, '0')}`;
      const appointmentDate = parse(format(new Date(), "d MMMM yyyy"), "d MMMM yyyy", new Date());

      // Use session-aware break intervals and validation
      const sessionBreakIntervals = getSessionBreakIntervals(doctor, appointmentDate, sessionIndex);
      console.log('[NURSE:GET-TOKEN] Break intervals:', {
        sessionIndex,
        breakIntervalsCount: sessionBreakIntervals.length,
        breakIntervals: sessionBreakIntervals.map((b: BreakInterval) => ({
          start: format(b.start, 'hh:mm a'),
          end: format(b.end, 'hh:mm a'),
          sessionIndex: b.sessionIndex,
        })),
      });

      const adjustedEstimatedTime = sessionBreakIntervals.length > 0
        ? applyBreakOffsets(estimatedTime, sessionBreakIntervals)
        : estimatedTime;
      console.log('[NURSE:GET-TOKEN] Time adjustment:', {
        originalEstimatedTime: format(estimatedTime, 'hh:mm a'),
        adjustedEstimatedTime: format(adjustedEstimatedTime, 'hh:mm a'),
        adjustmentApplied: sessionBreakIntervals.length > 0,
      });

      // Validate against session-specific effective end (not day-level)
      const sessionEffectiveEnd = getSessionEnd(doctor, appointmentDate, sessionIndex);
      console.log('[NURSE:GET-TOKEN] Session validation:', {
        sessionIndex,
        sessionEffectiveEnd: sessionEffectiveEnd ? format(sessionEffectiveEnd, 'hh:mm a') : 'N/A',
        consultationTime: doctor.averageConsultingTime || 15,
      });

      if (sessionEffectiveEnd) {
        const consultationTime = doctor.averageConsultingTime || 15;
        const appointmentEndTime = addMinutes(adjustedEstimatedTime, consultationTime);
        console.log('[NURSE:GET-TOKEN] Appointment end calculation:', {
          adjustedEstimatedTime: format(adjustedEstimatedTime, 'hh:mm a'),
          consultationTime,
          appointmentEndTime: format(appointmentEndTime, 'hh:mm a'),
          sessionEffectiveEnd: format(sessionEffectiveEnd, 'hh:mm a'),
          isAfter: isAfter(appointmentEndTime, sessionEffectiveEnd),
        });

        if (isAfter(appointmentEndTime, sessionEffectiveEnd)) {
          console.error('[NURSE:GET-TOKEN] ❌ Appointment end time exceeds session end');
          toast({
            variant: 'destructive',
            title: 'Walk-in Not Available',
            description: `Next estimated time ~${format(adjustedEstimatedTime, 'hh:mm a')} is outside availability (ends at ${format(sessionEffectiveEnd, 'hh:mm a')}).`,
          });
          setIsSubmitting(false);
          return;
        }
      }
      console.log('[NURSE:GET-TOKEN] Step 7: Creating preview appointment...');
      const adjustedEstimatedTimeStr = format(adjustedEstimatedTime, "hh:mm a");
      const cutOffTime = subMinutes(adjustedEstimatedTime, 15);
      const noShowTime = addMinutes(adjustedEstimatedTime, 15);
      console.log('[NURSE:GET-TOKEN] Time fields:', {
        originalTime: format(estimatedTime, "hh:mm a"),
        adjustedArriveByTime: adjustedEstimatedTimeStr,
        cutOffTime: format(cutOffTime, "hh:mm a"),
        noShowTime: format(noShowTime, "hh:mm a"),
      });

      const previewAppointment: UnsavedAppointment = {
        patientName: values.patientName,
        age: values.age,
        place: values.place,
        sex: values.sex as Appointment['sex'],
        communicationPhone: contactPhone,
        patientId,
        doctorId: doctor.id,
        doctor: doctor.name,
        department: doctor.department,
        bookedVia: 'Walk-in',
        date: format(appointmentDate, "d MMMM yyyy"),
        // Keep original estimated slot time in `time`, adjusted only for arriveBy/cutoff/noshow
        time: format(estimatedTime, "hh:mm a"),
        arriveByTime: adjustedEstimatedTimeStr,
        status: 'Confirmed',
        tokenNumber: previewTokenNumber,
        numericToken: numericToken,
        clinicId,
        slotIndex,
        sessionIndex,
        createdAt: serverTimestamp(),
        cutOffTime,
        noShowTime,
      };

      console.log('[NURSE:GET-TOKEN] Preview appointment created:', {
        patientName: previewAppointment.patientName,
        tokenNumber: previewTokenNumber,
        time: previewAppointment.time,
        arriveByTime: previewAppointment.arriveByTime,
        slotIndex: previewAppointment.slotIndex,
        sessionIndex: previewAppointment.sessionIndex,
      });

      console.log('[NURSE:GET-TOKEN] Step 8: Opening estimate modal...');
      setAppointmentToSave(previewAppointment);
      // Display adjusted time (with break offsets) in modal
      setEstimatedConsultationTime(adjustedEstimatedTime);
      setPatientsAhead(patientsAhead);
      setGeneratedToken(previewTokenNumber);
      setIsEstimateModalOpen(true);
      console.log('[NURSE:GET-TOKEN] ✅ Modal opened successfully');
      console.log('[NURSE:GET-TOKEN] ====== GET TOKEN FLOW COMPLETED ======');

    } catch (error: any) {
      console.error('[NURSE:GET-TOKEN] ❌❌❌ ERROR IN GET TOKEN FLOW ❌❌❌');
      console.error('[NURSE:GET-TOKEN] Error details:', {
        name: error?.name,
        message: error?.message,
        stack: error?.stack,
        error: error,
      });
      if (error.name !== 'FirestorePermissionError') {
        console.error('Failed to prepare walk-in:', error);
        toast({ variant: 'destructive', title: 'Error', description: (error as Error).message || "Could not complete registration." });
      }
    } finally {
      console.log('[NURSE:GET-TOKEN] Final step: Resetting submission state');
      setIsSubmitting(false);
    }
  }

  const resolveSlotDetails = useCallback(
    (slotIndex: number, referenceDate: Date) => {
      if (!doctor?.availabilitySlots?.length) return null;
      const dayOfWeek = format(referenceDate, 'EEEE');
      const availabilityForDay = doctor.availabilitySlots.find(slot => slot.day === dayOfWeek);
      if (!availabilityForDay || !availabilityForDay.timeSlots?.length) return null;

      const slotDuration = doctor.averageConsultingTime || 15;
      let currentIndex = 0;

      for (let sessionIndex = 0; sessionIndex < availabilityForDay.timeSlots.length; sessionIndex++) {
        const session = availabilityForDay.timeSlots[sessionIndex];
        let currentTime = parseTime(session.from, referenceDate);
        const endTime = parseTime(session.to, referenceDate);

        while (isBefore(currentTime, endTime)) {
          if (currentIndex === slotIndex) {
            return { sessionIndex, time: new Date(currentTime) };
          }

          currentTime = addMinutes(currentTime, slotDuration);
          currentIndex += 1;
        }
      }

      return null;
    },
    [doctor]
  );

  const handleProceedToToken = async () => {
    if (isSubmitting) {
      return;
    }

    if (!appointmentToSave || !doctor || !clinicId) {
      toast({ variant: 'destructive', title: 'Error', description: 'No appointment data to save.' });
      return;
    }

    setIsSubmitting(true);

    try {
      const bookingDate = new Date();
      const reservation = await generateNextTokenAndReserveSlot(
        db, // CRITICAL: First parameter must be firestore instance
        clinicId,
        doctor.name,
        bookingDate,
        'W',
        { slotIndex: appointmentToSave.slotIndex, doctorId: doctor.id }
      );

      // Use the time directly from the reservation (already calculated, including for bucket slots)
      // For bucket compensation slots (outside availability), resolveSlotDetails would fail
      // but generateNextTokenAndReserveSlot already calculates the correct time
      let appointmentTimeDate: Date;
      let sessionIndexForAppointment: number;

      if (reservation.time) {
        // Time is provided - use it directly (this handles bucket slots outside availability)
        const appointmentDateObj = parse(format(bookingDate, 'd MMMM yyyy'), 'd MMMM yyyy', bookingDate);
        appointmentTimeDate = parseTime(reservation.time, appointmentDateObj);
        sessionIndexForAppointment = reservation.sessionIndex;
      } else {
        // Fallback: try to resolve from slotIndex if time not provided
        const slotDetails = resolveSlotDetails(reservation.slotIndex, bookingDate);
        if (!slotDetails) {
          throw new Error('Unable to resolve doctor availability for the selected slot.');
        }
        appointmentTimeDate = slotDetails.time;
        sessionIndexForAppointment = slotDetails.sessionIndex;
      }

      // Use session-aware break intervals and validation
      const appointmentDateOnly = parse(format(bookingDate, 'd MMMM yyyy'), 'd MMMM yyyy', bookingDate);
      const sessionBreakIntervals = getSessionBreakIntervals(doctor, appointmentDateOnly, sessionIndexForAppointment);
      const adjustedAppointmentTime = sessionBreakIntervals.length > 0
        ? applyBreakOffsets(appointmentTimeDate, sessionBreakIntervals)
        : appointmentTimeDate;

      // Validate that appointment end time (adjustedAppointmentTime + consultationTime) doesn't exceed session end
      const sessionEffectiveEnd = getSessionEnd(doctor, appointmentDateOnly, sessionIndexForAppointment);
      if (sessionEffectiveEnd) {
        const consultationTime = doctor.averageConsultingTime || 15;
        const appointmentEndTime = addMinutes(adjustedAppointmentTime, consultationTime);
        if (isAfter(appointmentEndTime, sessionEffectiveEnd)) {
          if (reservation.reservationId) {
            await releaseReservation(reservation.reservationId);
          }
          toast({
            variant: 'destructive',
            title: 'Booking Not Allowed',
            description: `This walk-in time (~${format(adjustedAppointmentTime, 'hh:mm a')}) is outside the doctor's availability (ends at ${format(sessionEffectiveEnd, 'hh:mm a')}).`,
          });
          setIsSubmitting(false);
          return;
        }
      }
      const adjustedTimeStr = format(adjustedAppointmentTime, 'hh:mm a');
      const cutOffTime = subMinutes(adjustedAppointmentTime, 15);
      const noShowTime = addMinutes(adjustedAppointmentTime, 15);

      const appointmentDateStr = format(bookingDate, 'd MMMM yyyy');
      const appointmentsCollection = collection(db, 'appointments');
      const newDocRef = doc(appointmentsCollection);
      const reservationId = reservation.reservationId;

      const appointmentData: Appointment = {
        id: newDocRef.id,
        patientName: appointmentToSave.patientName,
        age: appointmentToSave.age,
        place: appointmentToSave.place,
        sex: appointmentToSave.sex,
        communicationPhone: appointmentToSave.communicationPhone,
        patientId: appointmentToSave.patientId,
        doctorId: doctor.id,
        doctor: doctor.name,
        department: doctor.department,
        bookedVia: 'Walk-in',
        date: appointmentDateStr,
        time: adjustedTimeStr,
        arriveByTime: adjustedTimeStr,
        status: 'Confirmed',
        tokenNumber: reservation.tokenNumber,
        numericToken: reservation.numericToken,
        clinicId,
        slotIndex: reservation.slotIndex,
        sessionIndex: sessionIndexForAppointment,
        createdAt: serverTimestamp(),
        cutOffTime,
        noShowTime,
      };

      // CRITICAL: Check for existing appointments at this slot before creating
      // This prevents duplicate bookings from concurrent requests
      const existingAppointmentsQuery = query(
        collection(db, 'appointments'),
        where('clinicId', '==', clinicId),
        where('doctor', '==', doctor.name),
        where('date', '==', appointmentDateStr),
        where('slotIndex', '==', reservation.slotIndex)
      );
      const existingAppointmentsSnapshot = await getDocs(existingAppointmentsQuery);
      const existingActiveAppointments = existingAppointmentsSnapshot.docs.filter(docSnap => {
        const data = docSnap.data();
        return (data.status === 'Pending' || data.status === 'Confirmed');
      });

      if (existingActiveAppointments.length > 0) {
        console.error(`[NURSE WALK-IN DEBUG] ⚠️ DUPLICATE DETECTED - Appointment already exists at slotIndex ${reservation.slotIndex}`, {
          existingAppointmentIds: existingActiveAppointments.map(docSnap => docSnap.id),
          timestamp: new Date().toISOString()
        });
        toast({
          variant: "destructive",
          title: "Slot Already Booked",
          description: "This time slot was just booked by someone else. Please try again.",
        });
        setIsSubmitting(false);
        return;
      }

      // Get references to existing appointments to verify in transaction
      const existingAppointmentRefs = existingActiveAppointments.map(docSnap =>
        doc(db, 'appointments', docSnap.id)
      );

      // CRITICAL: Use transaction to atomically claim reservation and create appointment
      // The reservation document acts as a lock - only one transaction can delete it
      // This prevents race conditions across different browsers/devices
      try {
        await runTransaction(db, async (transaction) => {
          console.log(`[NURSE WALK-IN DEBUG] Transaction STARTED`, {
            reservationId,
            appointmentId: newDocRef.id,
            slotIndex: reservation.slotIndex,
            timestamp: new Date().toISOString()
          });

          const reservationRef = doc(db, 'slot-reservations', reservationId);
          const reservationDoc = await transaction.get(reservationRef);

          console.log(`[NURSE WALK-IN DEBUG] Reservation check result`, {
            reservationId,
            exists: reservationDoc.exists(),
            data: reservationDoc.exists() ? reservationDoc.data() : null,
            timestamp: new Date().toISOString()
          });

          if (!reservationDoc.exists()) {
            // Reservation was already claimed by another request - slot is taken
            console.error(`[NURSE WALK-IN DEBUG] Reservation does NOT exist - already claimed`, {
              reservationId,
              timestamp: new Date().toISOString()
            });
            const conflictError = new Error('Reservation already claimed by another booking');
            (conflictError as { code?: string }).code = 'SLOT_ALREADY_BOOKED';
            throw conflictError;
          }

          // Verify the reservation matches our slot
          const reservationData = reservationDoc.data();
          console.log(`[NURSE WALK-IN DEBUG] Verifying reservation match`, {
            reservationSlotIndex: reservationData?.slotIndex,
            expectedSlotIndex: reservation.slotIndex,
            reservationClinicId: reservationData?.clinicId,
            expectedClinicId: clinicId,
            reservationDoctor: reservationData?.doctorName,
            expectedDoctor: doctor.name,
            timestamp: new Date().toISOString()
          });

          if (reservationData?.slotIndex !== reservation.slotIndex ||
            reservationData?.clinicId !== clinicId ||
            reservationData?.doctorName !== doctor.name) {
            console.error(`[NURSE WALK-IN DEBUG] Reservation mismatch`, {
              reservationData,
              expected: { slotIndex: reservation.slotIndex, clinicId, doctorName: doctor.name }
            });
            const conflictError = new Error('Reservation does not match booking details');
            (conflictError as { code?: string }).code = 'RESERVATION_MISMATCH';
            throw conflictError;
          }

          // CRITICAL: Verify no appointment exists at this slotIndex by reading the documents we found
          // This ensures we see the latest state even if appointments were created between our query and transaction
          if (existingAppointmentRefs.length > 0) {
            const existingAppointmentSnapshots = await Promise.all(
              existingAppointmentRefs.map(ref => transaction.get(ref))
            );
            const stillActive = existingAppointmentSnapshots.filter(snap => {
              if (!snap.exists()) return false;
              const data = snap.data() as Appointment;
              return (data.status === 'Pending' || data.status === 'Confirmed');
            });

            if (stillActive.length > 0) {
              console.error(`[NURSE WALK-IN DEBUG] ⚠️ DUPLICATE DETECTED IN TRANSACTION - Appointment exists at slotIndex ${reservation.slotIndex}`, {
                existingAppointmentIds: stillActive.map(snap => snap.id),
                timestamp: new Date().toISOString()
              });
              const conflictError = new Error('An appointment already exists at this slot');
              (conflictError as { code?: string }).code = 'SLOT_ALREADY_BOOKED';
              throw conflictError;
            }
          }

          console.log(`[NURSE WALK-IN DEBUG] No existing appointment found - deleting reservation and creating appointment`, {
            reservationId,
            appointmentId: newDocRef.id,
            slotIndex: reservation.slotIndex,
            timestamp: new Date().toISOString()
          });

          // ⚠️⚠️⚠️ RESERVATION UPDATE DEBUG ⚠️⚠️⚠️
          console.error(`[RESERVATION DELETION TRACKER] ✅ NURSE APP - UPDATING slot-reservation (NOT deleting)`, {
            app: 'kloqo-nurse',
            page: 'walk-in/page.tsx',
            action: 'transaction.update(reservationRef, {status: "booked"})',
            reservationId: reservationId,
            reservationPath: reservationRef.path,
            reservationData: reservation,
            appointmentId: newDocRef.id,
            appointmentToken: appointmentData.tokenNumber,
            slotIndex: reservation.slotIndex,
            timestamp: new Date().toISOString(),
            stackTrace: new Error().stack
          });

          // CRITICAL: Mark reservation as booked instead of deleting it
          // This acts as a persistent lock to prevent race conditions where other clients
          // might miss the new appointment and try to claim the "free" slot
          transaction.update(reservationRef, {
            status: 'booked',
            appointmentId: newDocRef.id,
            bookedAt: serverTimestamp()
          });

          // Create appointment atomically in the same transaction
          transaction.set(newDocRef, appointmentData);

          console.log(`[NURSE WALK-IN DEBUG] Transaction operations queued - about to commit`, {
            reservationUpdated: true,
            appointmentCreated: true,
            timestamp: new Date().toISOString()
          });
        });

        // ⚠️⚠️⚠️ RESERVATION UPDATE DEBUG ⚠️⚠️⚠️
        console.error(`[RESERVATION DELETION TRACKER] ✅ NURSE APP - Transaction COMMITTED (reservation was updated to booked)`, {
          app: 'kloqo-nurse',
          page: 'walk-in/page.tsx',
          reservationId: reservationId,
          appointmentId: newDocRef.id,
          appointmentToken: appointmentData.tokenNumber,
          slotIndex: reservation.slotIndex,
          timestamp: new Date().toISOString()
        });

        console.log(`[NURSE WALK-IN DEBUG] Transaction COMMITTED successfully`, {
          appointmentId: newDocRef.id,
          slotIndex: reservation.slotIndex,
          timestamp: new Date().toISOString()
        });
      } catch (error: any) {
        console.error(`[NURSE WALK-IN DEBUG] Transaction FAILED`, {
          errorMessage: error.message,
          errorCode: error.code,
          errorName: error.name,
          reservationId,
          timestamp: new Date().toISOString()
        });

        if (error.code === 'SLOT_ALREADY_BOOKED' || error.code === 'RESERVATION_MISMATCH') {
          toast({
            variant: "destructive",
            title: "Slot Already Booked",
            description: "This time slot was just booked by someone else. Please try again.",
          });
          setIsSubmitting(false);
          return;
        }

        const permissionError = new FirestorePermissionError({
          path: 'appointments',
          operation: 'create',
          requestResourceData: appointmentData,
        });
        errorEmitter.emit('permission-error', permissionError);
        throw error;
      }

      if (appointmentToSave.patientId) {
        const patientRef = doc(db, 'patients', appointmentToSave.patientId);
        await updateDoc(patientRef, {
          visitHistory: arrayUnion(newDocRef.id),
          totalAppointments: increment(1),
          updatedAt: serverTimestamp(),
        });
      }

      // Reservation is already deleted inside the transaction, no need to delete again

      setGeneratedToken(reservation.tokenNumber);
      setIsEstimateModalOpen(false);
      setIsTokenModalOpen(true);

      setTimeout(() => {
        setIsTokenModalOpen(false);
        router.push('/appointments');
      }, 5000);
    } catch (error: any) {
      if (error.name !== 'FirestorePermissionError') {
        console.error('Failed to confirm walk-in registration:', error);
        toast({
          variant: 'destructive',
          title: 'Error',
          description: (error as Error).message || 'Could not confirm the registration.',
        });
      }
    } finally {
      setIsSubmitting(false);
    }
  };


  if (loading) {
    return (
      <AppFrameLayout>
        <div className="flex flex-col h-full items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin" />
        </div>
      </AppFrameLayout>
    )
  }

  if (!isDoctorConsultingNow && !loading) {
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
              <h1 className="text-xl font-bold">Walk-in Registration</h1>
            </div>
          </header>
          <div className="flex-1 flex flex-col items-center justify-center text-center p-8">
            <h2 className="text-xl font-semibold">Doctor Not Available</h2>
            <p className="text-muted-foreground mt-2">Walk-in registration is only available during the doctor's consultation hours.</p>
          </div>
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
          <div>
            <h1 className="text-xl font-bold">Walk-in Registration</h1>
            {loading ? (
              <div className="h-4 bg-muted rounded w-48 animate-pulse mt-1"></div>
            ) : doctor ? (
              <p className="text-sm text-muted-foreground">For Dr. {doctor.name}</p>
            ) : (
              <p className="text-sm text-destructive">Doctor not found</p>
            )}
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-6 bg-muted/20">
          <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="qr">Scan QR Code</TabsTrigger>
              <TabsTrigger value="manual">Enter Manually</TabsTrigger>
            </TabsList>
            <TabsContent value="qr">
              <Card className="w-full text-center shadow-lg mt-4">
                <CardHeader>
                  <CardTitle className="text-2xl">Scan to Register</CardTitle>
                  <CardDescription>Scan the QR code with a phone to register.</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col items-center justify-center">
                  {qrCodeUrl ? (
                    <div className="p-4 bg-white rounded-lg border">
                      <Image
                        src={qrCodeUrl}
                        alt="QR Code for appointment booking"
                        width={250}
                        height={250}
                      />
                    </div>
                  ) : (
                    <div className="w-[250px] h-[250px] bg-gray-200 flex items-center justify-center rounded-lg">
                      <p className="text-muted-foreground">QR Code not available</p>
                    </div>
                  )}
                  <p className="text-sm text-muted-foreground mt-4">Follow the instructions on your phone.</p>
                </CardContent>
              </Card>
            </TabsContent>
            <TabsContent value="manual">
              <Card className="w-full shadow-lg mt-4">
                <CardHeader>
                  <CardTitle className="text-2xl">Manual Registration</CardTitle>
                  <CardDescription>Enter patient's phone number to begin.</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-4">
                    <div className="relative flex-1 flex items-center">
                      <span className="inline-flex items-center px-3 rounded-l-md border border-r-0 border-gray-300 bg-gray-50 text-gray-500 text-sm h-10">
                        +91
                      </span>
                      <Input
                        type="tel"
                        placeholder="Enter 10-digit phone number"
                        value={phoneNumber}
                        onChange={(e) => setPhoneNumber(e.target.value.replace(/\D/g, '').slice(0, 10))}
                        className="flex-1 rounded-l-none"
                        maxLength={10}
                      />
                      {isSearchingPatient && <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin h-4 w-4 text-muted-foreground" />}
                    </div>

                    {searchedPatients.length > 0 && (
                      <PatientSearchResults
                        patients={searchedPatients}
                        onSelectPatient={selectPatient}
                        selectedPatientId={selectedPatientId}
                      />
                    )}

                    {showForm && (
                      <div className="pt-4 border-t">
                        <h3 className="mb-4 font-semibold text-lg">{selectedPatientId ? 'Confirm Details' : 'New Patient Form'}</h3>
                        <Form {...form}>
                          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                            <FormField control={form.control} name="phone" render={({ field }) => (
                              <FormItem>
                                <FormLabel>Phone Number</FormLabel>
                                <FormControl>
                                  <div className="relative flex items-center">
                                    <span className="inline-flex items-center px-3 rounded-l-md border border-r-0 border-gray-300 bg-gray-50 text-gray-500 text-sm h-10">
                                      +91
                                    </span>
                                    <Input
                                      type="tel"
                                      placeholder={isPhoneDisabled ? 'Phone not available' : 'Enter 10-digit phone number'}
                                      {...field}
                                      value={field.value ?? ''}
                                      onChange={(e) => {
                                        if (isPhoneDisabled) {
                                          return;
                                        }
                                        const cleaned = e.target.value.replace(/\D/g, '').slice(0, 10);
                                        field.onChange(cleaned);
                                        setPhoneNumber(cleaned);
                                      }}
                                      className="flex-1 rounded-l-none"
                                      maxLength={10}
                                      disabled={isPhoneDisabled}
                                    />
                                  </div>
                                </FormControl>
                                {!isPhoneDisabled && <FormMessage />}
                              </FormItem>
                            )} />
                            <FormField control={form.control} name="patientName" render={({ field }) => (
                              <FormItem><FormLabel>Full Name</FormLabel><FormControl><Input placeholder="Enter patient name" {...field} /></FormControl><FormMessage /></FormItem>
                            )} />
                            <div className="grid grid-cols-2 gap-4">
                              <FormField control={form.control} name="age" render={({ field }) => (
                                <FormItem><FormLabel>Age</FormLabel><FormControl><Input type="number" placeholder="Enter the age" {...field} value={field.value === 0 ? '' : (field.value ?? '')} className="[&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none [-moz-appearance:textfield]" /></FormControl><FormMessage /></FormItem>
                              )} />
                              <FormField control={form.control} name="sex" render={({ field }) => (
                                <FormItem><FormLabel>Sex</FormLabel>
                                  <Select onValueChange={field.onChange} value={field.value || ""}><FormControl><SelectTrigger><SelectValue placeholder="Select gender" /></SelectTrigger></FormControl>
                                    <SelectContent>
                                      <SelectItem value="Male">Male</SelectItem>
                                      <SelectItem value="Female">Female</SelectItem>
                                      <SelectItem value="Other">Other</SelectItem>
                                    </SelectContent>
                                  </Select><FormMessage />
                                </FormItem>
                              )} />
                            </div>
                            <FormField control={form.control} name="place" render={({ field }) => (
                              <FormItem><FormLabel>Place</FormLabel><FormControl><Input placeholder="Enter place" {...field} /></FormControl><FormMessage /></FormItem>
                            )} />
                            <Button type="submit" className="w-full mt-6 bg-[#f38d17] hover:bg-[#f38d17]/90" disabled={isSubmitting || !doctor}>
                              {isSubmitting ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Checking Queue...</> : 'Get Token'}
                            </Button>
                          </form>
                        </Form>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </div>

        <Dialog open={isEstimateModalOpen} onOpenChange={setIsEstimateModalOpen}>
          <DialogContent className="sm:max-w-sm w-[90%]">
            <DialogHeader>
              <DialogTitle className="text-center">Estimated Wait Time</DialogTitle>
              <DialogDescription className="text-center">The clinic is busy at the moment. Here's the current wait status.</DialogDescription>
            </DialogHeader>
            {(() => {
              try {
                const appointmentDate = parse(format(new Date(), 'd MMMM yyyy'), 'd MMMM yyyy', new Date());
                const sessionIdx = appointmentToSave?.sessionIndex ?? null;
                // estimatedConsultationTime is already adjusted with break offsets in onSubmit
                // So we use it directly without applying breaks again
                const adjustedTime = estimatedConsultationTime;
                const sessionEnd = sessionIdx !== null ? getSessionEnd(doctor, appointmentDate, sessionIdx) : null;
                const consultationTime = doctor?.averageConsultingTime || 15;
                const apptEnd = adjustedTime ? addMinutes(adjustedTime, consultationTime) : null;
                const availabilityEndLabel = sessionEnd ? format(sessionEnd, 'hh:mm a') : '';
                const isOutside = apptEnd && sessionEnd ? isAfter(apptEnd, sessionEnd) : false;

                console.log('[NURSE:MODAL] Modal rendering:', {
                  estimatedConsultationTime: estimatedConsultationTime ? format(estimatedConsultationTime, 'hh:mm a') : 'N/A',
                  adjustedTime: adjustedTime ? format(adjustedTime, 'hh:mm a') : 'N/A',
                  sessionIdx,
                  sessionEnd: sessionEnd ? format(sessionEnd, 'hh:mm a') : 'N/A',
                  consultationTime,
                  apptEnd: apptEnd ? format(apptEnd, 'hh:mm a') : 'N/A',
                  isOutside,
                });

                if (isOutside) {
                  return (
                    <>
                      <div className="text-center py-4">
                        <DialogTitle className="text-base text-red-700">Walk-in Not Available</DialogTitle>
                        <DialogDescription className="text-xs text-red-800">
                          Next estimated time ~{adjustedTime ? format(adjustedTime, 'hh:mm a') : 'N/A'} is outside availability (ends at {availabilityEndLabel || 'N/A'}).
                        </DialogDescription>
                      </div>
                      <DialogFooter>
                        <DialogClose asChild>
                          <Button variant="ghost" className="w-full">Cancel</Button>
                        </DialogClose>
                      </DialogFooter>
                    </>
                  );
                }

                return (
                  <>
                    <div className="flex items-center justify-center gap-6 text-center py-4">
                      <div className="flex flex-col items-center">
                        <Clock className="w-8 h-8 text-primary mb-2" />
                        <span className="text-xl font-bold">{adjustedTime ? `~ ${format(adjustedTime, 'hh:mm a')}` : 'Calculating...'}</span>
                        <span className="text-xs text-muted-foreground">Est. Time</span>
                      </div>
                      <div className="flex flex-col items-center">
                        <Users className="w-8 h-8 text-primary mb-2" />
                        <span className="text-2xl font-bold">{patientsAhead}</span>
                        <span className="text-xs text-muted-foreground">People Ahead</span>
                      </div>
                    </div>
                    <DialogFooter className="flex-col space-y-2">
                      <Button onClick={handleProceedToToken} className="w-full bg-accent text-accent-foreground hover:bg-accent/90" disabled={isSubmitting}>
                        {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : "I'm OK to wait, Proceed"}
                      </Button>
                      <Button variant="outline" className="w-full" asChild>
                        <Link href="/book-appointment"><Calendar className="mr-2 h-4 w-4" />Book for Another Day</Link>
                      </Button>
                      <DialogClose asChild>
                        <Button variant="ghost" className="w-full">Cancel</Button>
                      </DialogClose>
                    </DialogFooter>
                  </>
                );
              } catch {
                return (
                  <>
                    <div className="flex items-center justify-center gap-6 text-center py-4">
                      <div className="flex flex-col items-center">
                        <Clock className="w-8 h-8 text-primary mb-2" />
                        <span className="text-xl font-bold">{estimatedConsultationTime ? `~ ${format(estimatedConsultationTime, 'hh:mm a')}` : 'Calculating...'}</span>
                        <span className="text-xs text-muted-foreground">Est. Time</span>
                      </div>
                      <div className="flex flex-col items-center">
                        <Users className="w-8 h-8 text-primary mb-2" />
                        <span className="text-2xl font-bold">{patientsAhead}</span>
                        <span className="text-xs text-muted-foreground">People Ahead</span>
                      </div>
                    </div>
                    <DialogFooter className="flex-col space-y-2">
                      <Button onClick={handleProceedToToken} className="w-full bg-accent text-accent-foreground hover:bg-accent/90" disabled={isSubmitting}>
                        {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : "I'm OK to wait, Proceed"}
                      </Button>
                      <Button variant="outline" className="w-full" asChild>
                        <Link href="/book-appointment"><Calendar className="mr-2 h-4 w-4" />Book for Another Day</Link>
                      </Button>
                      <DialogClose asChild>
                        <Button variant="ghost" className="w-full">Cancel</Button>
                      </DialogClose>
                    </DialogFooter>
                  </>
                );
              }
            })()}
          </DialogContent>
        </Dialog>

        <Dialog open={isTokenModalOpen} onOpenChange={setIsTokenModalOpen}>
          <DialogContent className="sm:max-w-xs w-[90%] text-center p-6 sm:p-8">
            <DialogHeader className="sr-only">
              <DialogTitle>Token Generated</DialogTitle>
            </DialogHeader>
            <DialogClose asChild>
              <Button variant="ghost" size="icon" className="absolute top-4 right-4 h-6 w-6 text-muted-foreground">
                <X className="h-4 w-4" />
                <span className="sr-only">Close</span>
              </Button>
            </DialogClose>
            <div className="flex flex-col items-center space-y-4">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-green-100">
                <CheckCircle2 className="h-8 w-8 text-green-600" />
              </div>
              <div className="space-y-1">
                <h2 className="text-xl font-bold">Walk-in Token Generated!</h2>
                <p className="text-muted-foreground text-sm">Please wait for your turn. You'll be redirected to the live queue.</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Your Token Number</p>
                <p className="text-5xl font-bold text-primary">{generatedToken}</p>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </AppFrameLayout>
  );
}
import { Suspense } from 'react';

export default function WalkInRegistrationPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <WalkInRegistrationContent />
    </Suspense>
  );
}
