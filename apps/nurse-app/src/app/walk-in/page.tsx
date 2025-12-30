
'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import Link from 'next/link';
import { ArrowLeft, Loader2, CheckCircle2, Clock, Users, Calendar, X, AlertTriangle, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
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
import { calculateWalkInDetails, generateNextTokenAndReserveSlot, sendAppointmentBookedByStaffNotification, completeStaffWalkInBooking, getClinicTimeString, getClinicDayOfWeek, getClinicDateString, getClinicNow } from '@kloqo/shared-core';

import PatientSearchResults from '@/components/clinic/patient-search-results';
import { getCurrentActiveSession, getSessionEnd, getSessionBreakIntervals, isWithin15MinutesOfClosing, type BreakInterval } from '@kloqo/shared-core';
import { AddRelativeDialog } from '@/components/patients/add-relative-dialog';

const formSchema = z
  .object({
    patientName: z.string().min(2, { message: 'Name must be at least 2 characters.' }),
    age: z.preprocess(
      (val) => (val === "" || val === undefined || val === null ? undefined : Number(val)),
      z.number({ required_error: "Age is required.", invalid_type_error: "Age is required." })
        .int()
        .positive({ message: 'Age must be a positive number.' })
    ),
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

// Redundant break logic removed. Scheduled breaks are pre-shifted in the slot system.

function getAvailabilityEndForDate(doctor: Doctor | null, referenceDate: Date | null): Date | null {
  if (!doctor || !referenceDate || !doctor.availabilitySlots?.length) return null;

  const dayOfWeek = getClinicDayOfWeek(referenceDate);
  const availabilityForDay = doctor.availabilitySlots.find((slot) => slot.day === dayOfWeek);
  if (!availabilityForDay || !availabilityForDay.timeSlots?.length) return null;

  const lastSession = availabilityForDay.timeSlots[availabilityForDay.timeSlots.length - 1];
  let availabilityEnd = parseTime(lastSession.to, referenceDate);

  const dateKey = getClinicDateString(referenceDate);
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
  const [currentTime, setCurrentTime] = useState(new Date());
  const [clinicId, setClinicId] = useState<string | null>(null);

  const [isEstimateModalOpen, setIsEstimateModalOpen] = useState(false);
  const [isTokenModalOpen, setIsTokenModalOpen] = useState(false);
  const [generatedToken, setGeneratedToken] = useState<string | null>(null);
  const [estimatedConsultationTime, setEstimatedConsultationTime] = useState<Date | null>(null);
  const [patientsAhead, setPatientsAhead] = useState(0);
  const [loading, setLoading] = useState(true);
  const [appointmentToSave, setAppointmentToSave] = useState<UnsavedAppointment | null>(null);

  // Force booking states
  const [showForceBookDialog, setShowForceBookDialog] = useState(false);
  const [pendingForceBookData, setPendingForceBookData] = useState<z.infer<typeof formSchema> | null>(null);

  // States for patient search
  const [phoneNumber, setPhoneNumber] = useState('');
  const [isSearchingPatient, setIsSearchingPatient] = useState(false);
  const [searchedPatients, setSearchedPatients] = useState<Patient[]>([]);
  const [primaryPatient, setPrimaryPatient] = useState<Patient | null>(null);
  const [isAddRelativeDialogOpen, setIsAddRelativeDialogOpen] = useState(false);
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
    setClinicId(id);

    const timer = setInterval(() => setCurrentTime(new Date()), 60000);
    return () => clearInterval(timer);
  }, [router]);

  const handlePatientSearch = useCallback(async (phone: string) => {
    if (phone.length < 10 || !clinicId) {
      setSearchedPatients([]);
      setShowForm(false);
      setSelectedPatientId(null);
      setSelectedPatient(null);
      setPrimaryPatient(null);
      setIsPhoneDisabled(false);
      form.reset({ patientName: '', age: undefined, place: '', sex: '', phone: '', phoneDisabled: false });
      return;
    };
    setIsSearchingPatient(true);
    setShowForm(false);
    setSelectedPatientId(null);
    setSelectedPatient(null);
    setPrimaryPatient(null);
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
        setPrimaryPatient(null);
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

      setPrimaryPatient(primaryPatient);
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

  const onRelativeAdded = (newRelative: Patient) => {
    setSearchedPatients(prev => [...prev, newRelative]);
    selectPatient(newRelative);
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

    // Allow access during normal walk-in window OR during the 15-minute force booking window
    // Force booking window: between walkInCloseTime and effectiveEnd
    return (currentTime >= walkInOpenTime && currentTime <= walkInCloseTime) ||
      (currentTime > walkInCloseTime && currentTime <= activeSession.effectiveEnd);
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
      let estimatedTime: Date;
      let patientsAhead: number;
      let slotIndex: number;
      let sessionIndex: number;
      let numericToken: number;
      let isForceBooked = false;

      try {
        const details = await calculateWalkInDetails(
          db,
          doctor,
          walkInTokenAllotment,
          0,
          false // Initially try without force booking
        );
        estimatedTime = details.estimatedTime;
        patientsAhead = details.patientsAhead;
        slotIndex = details.slotIndex;
        sessionIndex = details.sessionIndex;
        numericToken = details.numericToken;
        isForceBooked = details.isForceBooked || false;

        console.log('[NURSE:GET-TOKEN] Walk-in details calculated:', {
          estimatedTime: estimatedTime?.toISOString(),
          estimatedTimeFormatted: estimatedTime ? getClinicTimeString(estimatedTime) : 'N/A',
          patientsAhead,
          slotIndex,
          sessionIndex,
          numericToken,
          isForceBooked,
        });
      } catch (err: any) {
        console.error('[NURSE:GET-TOKEN] Error calculating walk-in details:', err);
        const errorMessage = err.message || "";
        const isSlotUnavailable = errorMessage.includes("Unable to allocate walk-in slot") ||
          errorMessage.includes("No walk-in slots are available");

        // Check if within 15 minutes of closing
        const isNearClosing = isWithin15MinutesOfClosing(doctor, new Date());

        // If slots unavailable OR near closing, offer force booking
        if (isSlotUnavailable || isNearClosing) {
          console.log('[NURSE:FORCE-BOOK] Triggering force book dialog:', { isSlotUnavailable, isNearClosing });
          setPendingForceBookData(values);
          setShowForceBookDialog(true);
          setIsSubmitting(false);
          return;
        }

        toast({
          variant: "destructive",
          title: "Walk-in Unavailable",
          description: err.message || "Could not calculate walk-in details.",
        });
        setIsSubmitting(false);
        return;
      }

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
      const appointmentDateStr = getClinicDateString(getClinicNow());
      const duplicateCheckQuery = query(
        collection(db, "appointments"),
        where("patientId", "==", patientId),
        where("doctor", "==", doctor.name),
        where("date", "==", appointmentDateStr),
        where("status", "in", ["Pending", "Confirmed", "Skipped", "Completed"])
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

      const previewTokenNumber = `W${String(numericToken).padStart(3, '0')}`;
      const now = getClinicNow();
      const appointmentDate = now;
      const cutOffTime = subMinutes(estimatedTime, 15);
      const noShowTime = addMinutes(estimatedTime, 15);

      // Use the pre-calculated times from calculateWalkInDetails
      // No need to manually adjust for breaks as the slot index already accounts for them
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
        date: appointmentDateStr,
        // Trust the times returned by shared-core
        time: getClinicTimeString(estimatedTime),
        arriveByTime: getClinicTimeString(estimatedTime),
        status: 'Confirmed',
        tokenNumber: previewTokenNumber,
        numericToken: numericToken,
        clinicId,
        slotIndex,
        sessionIndex,
        createdAt: serverTimestamp(),
        cutOffTime,
        noShowTime,
        ...(isForceBooked && { isForceBooked: true }), // Mark as force booked
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
      setEstimatedConsultationTime(estimatedTime);
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

  // Handle force booking confirmation
  const handleForceBook = async () => {
    if (!pendingForceBookData || !doctor || !clinicId) {
      console.error('[NURSE:FORCE-BOOK] Missing data for force booking');
      setShowForceBookDialog(false);
      return;
    }

    setShowForceBookDialog(false);
    setIsSubmitting(true);

    const values = pendingForceBookData;

    try {
      console.log('[NURSE:FORCE-BOOK] Starting force booking flow');
      const clinicDocRef = doc(db, 'clinics', clinicId);
      const clinicSnap = await getDoc(clinicDocRef);
      const clinicData = clinicSnap.data();
      const walkInTokenAllotment = clinicData?.walkInTokenAllotment || 5;

      // Retry with force booking enabled
      const details = await calculateWalkInDetails(
        db,
        doctor,
        walkInTokenAllotment,
        0,
        true // Force booking enabled
      );

      const { estimatedTime, patientsAhead, slotIndex, sessionIndex, numericToken } = details;
      const isForceBooked = details.isForceBooked || false;

      console.log('[NURSE:FORCE-BOOK] Overflow slot created:', {
        slotIndex,
        time: getClinicTimeString(estimatedTime),
        isForceBooked,
      });

      // Continue with normal booking flow (same as regular onSubmit)
      const phoneDisabled = values.phoneDisabled ?? false;
      let fullPhoneNumber = '';

      if (!phoneDisabled && values.phone) {
        const cleaned = values.phone.replace(/^\+91/, '').replace(/\D/g, '');
        if (cleaned.length === 10) {
          fullPhoneNumber = `+91${cleaned}`;
        }
      }

      if (!phoneDisabled && !fullPhoneNumber) {
        toast({ variant: 'destructive', title: 'Error', description: 'Please enter a valid 10-digit phone number.' });
        setIsSubmitting(false);
        return;
      }

      const contactPhone = fullPhoneNumber || selectedPatient?.communicationPhone || selectedPatient?.phone || '';

      const patientId = selectedPatientId || await managePatient({
        phone: contactPhone,
        name: values.patientName,
        age: values.age,
        place: values.place,
        sex: values.sex as 'Male' | 'Female' | 'Other',
        clinicId,
        bookingFor: 'self',
      });

      const previewTokenNumber = `W${String(numericToken).padStart(3, '0')}`;
      const now = getClinicNow();
      const appointmentDateStr = getClinicDateString(now);
      const appointmentDate = now;
      const cutOffTime = subMinutes(estimatedTime, 15);
      const noShowTime = addMinutes(estimatedTime, 15);

      const previewAppointment: UnsavedAppointment = {
        patientId,
        patientName: values.patientName,
        age: values.age,
        communicationPhone: contactPhone,
        place: values.place,
        sex: values.sex as any,
        doctorId: doctor.id,
        doctor: doctor.name,
        department: doctor.department,
        bookedVia: 'Walk-in',
        date: appointmentDateStr,
        time: getClinicTimeString(estimatedTime),
        arriveByTime: getClinicTimeString(estimatedTime),
        status: 'Confirmed',
        tokenNumber: previewTokenNumber,
        numericToken: numericToken,
        clinicId,
        slotIndex,
        sessionIndex,
        createdAt: serverTimestamp(),
        cutOffTime,
        noShowTime,
        isForceBooked: true, // Mark as force booked
      };

      console.log('[NURSE:FORCE-BOOK] Preview appointment created:', {
        tokenNumber: previewTokenNumber,
        time: previewAppointment.time,
        isForceBooked: true,
      });

      setAppointmentToSave(previewAppointment);
      setEstimatedConsultationTime(estimatedTime);
      setPatientsAhead(patientsAhead);
      setGeneratedToken(previewTokenNumber);
      setIsEstimateModalOpen(true);

    } catch (error: any) {
      console.error('[NURSE:FORCE-BOOK] Failed to prepare force booking:', error);
      if (error.name !== 'FirestorePermissionError') {
        toast({ variant: 'destructive', title: 'Error', description: (error as Error).message || "Could not complete force booking." });
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const resolveSlotDetails = useCallback(
    (slotIndex: number, referenceDate: Date) => {
      if (!doctor?.availabilitySlots?.length) return null;
      const dayOfWeek = getClinicDayOfWeek(referenceDate);
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
    if (isSubmitting) return;

    if (!appointmentToSave || !doctor || !clinicId) {
      toast({ variant: 'destructive', title: 'Error', description: 'No appointment data to save.' });
      return;
    }

    setIsSubmitting(true);

    try {
      const result = await completeStaffWalkInBooking(db, {
        clinicId,
        doctor,
        patientId: appointmentToSave.patientId!,
        patientName: appointmentToSave.patientName,
        age: appointmentToSave.age,
        sex: appointmentToSave.sex,
        place: appointmentToSave.place,
        phone: appointmentToSave.communicationPhone,
        isForceBooked: appointmentToSave.isForceBooked,
      });

      if (result.success) {
        setGeneratedToken(result.tokenNumber);
        setIsEstimateModalOpen(false);
        setIsTokenModalOpen(true);

        // Send notification (fire and forget)
        try {
          const clinicDoc = await getDoc(doc(db, 'clinics', clinicId));
          const clinicName = clinicDoc.exists() ? clinicDoc.data().name : 'The Clinic';

          const appointmentDateObj = new Date();
          const appointmentDateStr = getClinicDateString(appointmentDateObj);

          sendAppointmentBookedByStaffNotification({
            firestore: db,
            patientId: appointmentToSave.patientId!,
            appointmentId: result.appointmentId,
            doctorName: doctor.name,
            clinicName: clinicName,
            date: appointmentDateStr,
            time: getClinicTimeString(new Date(result.estimatedTime)),
            tokenNumber: result.tokenNumber,
            bookedBy: 'nurse',
            arriveByTime: getClinicTimeString(new Date(result.estimatedTime)),
          }).catch(err => console.error('Failed to send walk-in notification:', err));
        } catch (err) {
          console.error('Error preparing notification:', err);
        }

        setTimeout(() => {
          setIsTokenModalOpen(false);
          router.push('/appointments');
        }, 5000);
      }
    } catch (error: any) {
      console.error('Failed to confirm walk-in registration:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message || 'Could not confirm the registration.',
      });
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
          <Card className="w-full shadow-lg">
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
                    patients={primaryPatient ? [primaryPatient] : searchedPatients}
                    onSelectPatient={selectPatient}
                    selectedPatientId={selectedPatientId}
                  />
                )}

                {primaryPatient && (
                  <Card className="mb-4">
                    <CardHeader className="py-4">
                      <CardTitle className="text-lg">Booking For Family</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4 pt-0">
                      <p className="text-sm text-muted-foreground">
                        You are booking for the family of <strong>{primaryPatient.name}</strong>.
                      </p>

                      {searchedPatients.filter(p => p.id !== primaryPatient?.id).length > 0 && (
                        <div className="space-y-2 border-t pt-4">
                          <p className="text-xs text-muted-foreground">Select a family member:</p>
                          {searchedPatients
                            .filter(p => p.id !== primaryPatient?.id)
                            .map(p => (
                              <div
                                key={p.id}
                                className={cn(
                                  "w-full text-left p-2 rounded-md hover:bg-muted/80 flex justify-between items-center transition-colors",
                                  selectedPatientId === p.id && "bg-muted"
                                )}
                              >
                                <div>
                                  <p className="font-semibold">{p.name || 'Unnamed Patient'}</p>
                                  <p className="text-sm text-muted-foreground">
                                    {p.age ? `${p.age} yrs, ` : ''}
                                    {p.place}
                                  </p>
                                </div>
                                <Button size="sm" variant="outline" onClick={() => selectPatient(p)}>
                                  Select
                                </Button>
                              </div>
                            ))}
                        </div>
                      )}

                      <Button
                        type="button"
                        variant="secondary"
                        className="w-full active:translate-y-0.5"
                        onClick={() => setIsAddRelativeDialogOpen(true)}
                      >
                        <UserPlus className="mr-2 h-4 w-4" />
                        Add & Book for New Relative
                      </Button>
                    </CardContent>
                  </Card>
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
                            <FormItem><FormLabel>Age</FormLabel><FormControl>
                              <Input
                                type="text"
                                inputMode="numeric"
                                placeholder="Enter the age"
                                {...field}
                                value={field.value?.toString() ?? ''}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  if (val === '' || /^\d+$/.test(val)) {
                                    field.onChange(val);
                                    form.trigger('age');
                                  }
                                }}
                                className="[&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none [-moz-appearance:textfield]"
                              /></FormControl><FormMessage /></FormItem>
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
        </div>

        <Dialog open={isEstimateModalOpen} onOpenChange={setIsEstimateModalOpen}>
          <DialogContent className="sm:max-w-sm w-[90%]">
            <DialogHeader>
              <DialogTitle className="text-center">Estimated Wait Time</DialogTitle>
              <DialogDescription className="text-center">The clinic is busy at the moment. Here's the current wait status.</DialogDescription>
            </DialogHeader>
            {(() => {
              try {
                const appointmentDate = getClinicNow();
                const sessionIdx = appointmentToSave?.sessionIndex ?? null;
                const adjustedTime = estimatedConsultationTime;
                const sessionEnd = sessionIdx !== null ? getSessionEnd(doctor, appointmentDate, sessionIdx) : null;
                const consultationTime = doctor?.averageConsultingTime || 15;
                const apptEnd = adjustedTime ? addMinutes(adjustedTime, consultationTime) : null;
                const availabilityEndLabel = sessionEnd ? getClinicTimeString(sessionEnd) : '';
                const isForceBooked = appointmentToSave?.isForceBooked ?? false;
                // Only check for outside availability if NOT force booked
                const isOutside = !isForceBooked && apptEnd && sessionEnd ? isAfter(apptEnd, sessionEnd) : false;

                console.log('[NURSE:MODAL] Modal rendering:', {
                  estimatedConsultationTime: estimatedConsultationTime ? getClinicTimeString(estimatedConsultationTime) : 'N/A',
                  adjustedTime: adjustedTime ? getClinicTimeString(adjustedTime) : 'N/A',
                  sessionIdx,
                  sessionEnd: sessionEnd ? getClinicTimeString(sessionEnd) : 'N/A',
                  consultationTime,
                  apptEnd: apptEnd ? getClinicTimeString(apptEnd) : 'N/A',
                  isOutside,
                  isForceBooked
                });

                if (isOutside) {
                  return (
                    <>
                      <div className="text-center py-4">
                        <DialogTitle className="text-base text-red-700">Walk-in Not Available</DialogTitle>
                        <DialogDescription className="text-xs text-red-800">
                          Next estimated time ~{adjustedTime ? getClinicTimeString(adjustedTime) : 'N/A'} is outside availability (ends at {availabilityEndLabel || 'N/A'}).
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
                        <span className="text-xl font-bold">{adjustedTime ? `~ ${getClinicTimeString(adjustedTime)}` : 'Calculating...'}</span>
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
                        <span className="text-xl font-bold">{estimatedConsultationTime ? `~ ${getClinicTimeString(estimatedConsultationTime)}` : 'Calculating...'}</span>
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

        {primaryPatient && (
          <AddRelativeDialog
            isOpen={isAddRelativeDialogOpen}
            setIsOpen={setIsAddRelativeDialogOpen}
            primaryPatientPhone={primaryPatient.phone?.replace('+91', '') || ''}
            clinicId={clinicId}
            onRelativeAdded={onRelativeAdded}
          />
        )}

        {/* Force Book Confirmation Dialog */}
        <AlertDialog open={showForceBookDialog} onOpenChange={setShowForceBookDialog}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle className="flex items-center gap-2">
                <AlertTriangle className="h-5 w-5 text-amber-500" />
                Force Book Walk-in?
              </AlertDialogTitle>
              <AlertDialogDescription className="space-y-2">
                <p>
                  {isWithin15MinutesOfClosing(doctor, new Date())
                    ? "Walk-in booking is closing soon (within 15 minutes)."
                    : "All available slots are fully booked."}
                </p>
                <p className="font-semibold text-foreground">
                  This booking will go outside the doctor's normal availability time.
                  Do you want to accommodate this patient?
                </p>
                <p className="text-sm text-muted-foreground">
                  The patient will be assigned a token after all currently scheduled appointments.
                </p>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel onClick={() => {
                setPendingForceBookData(null);
                setShowForceBookDialog(false);
              }}>
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction onClick={handleForceBook} className="bg-amber-600 hover:bg-amber-700">
                Force Book Patient
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
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
