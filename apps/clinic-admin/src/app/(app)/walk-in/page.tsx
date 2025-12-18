
'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import Image from 'next/image';
import Link from 'next/link';
import { ArrowLeft, Loader2, CheckCircle2, Clock, Users, Calendar, X, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import AppFrameLayout from '@/components/layout/app-frame';
import { db } from '@/lib/firebase';
import { doc, getDoc, collection, addDoc, query, where, getDocs, serverTimestamp, setDoc, deleteDoc } from 'firebase/firestore';
import type { Appointment, Doctor, Patient } from '@/lib/types';
import { useToast } from '@/hooks/use-toast';
import { format, isWithinInterval, parse, subMinutes, addMinutes, differenceInMinutes, parseISO, isAfter } from 'date-fns';
import { parseTime } from '@/lib/utils';
import { cn } from '@/lib/utils';
import { errorEmitter } from '@/firebase/error-emitter';
import { FirestorePermissionError } from '@/firebase/errors';
import { managePatient } from '@kloqo/shared-core';
import { calculateWalkInDetails, generateNextTokenAndReserveSlot, sendAppointmentBookedByStaffNotification } from '@kloqo/shared-core';

import { getSessionEnd, getSessionBreakIntervals, isWithin15MinutesOfClosing } from '@kloqo/shared-core';
import PatientSearchResults from '@/components/clinic/patient-search-results';
import { Suspense } from 'react';

const formSchema = z.object({
  patientName: z.string().min(2, { message: 'Name must be at least 2 characters.' }),
  age: z.preprocess(
    (val) => (val === "" || val === undefined || val === null ? undefined : Number(val)),
    z.number({ required_error: "Age is required.", invalid_type_error: "Age is required." })
      .int()
      .positive({ message: 'Age must be a positive number.' })
  ),
  place: z.string().min(2, { message: 'Place is required.' }),
  sex: z.string().min(1, { message: 'Sex is required.' }),
  phone: z.string()
    .refine((val) => {
      if (!val || val.length === 0) return false; // Phone is required
      // Strip +91 prefix if present, then check for exactly 10 digits
      const cleaned = val.replace(/^\+91/, '').replace(/\D/g, ''); // Remove +91 and non-digits
      if (cleaned.length === 0) return false; // If all digits removed, invalid
      if (cleaned.length < 10) return false; // Less than 10 digits is invalid
      if (cleaned.length > 10) return false; // More than 10 digits is invalid
      return /^\d{10}$/.test(cleaned);
    }, {
      message: "Please enter exactly 10 digits for the phone number."
    }),
});

// Define a type for the unsaved appointment data
type UnsavedAppointment = Omit<Appointment, 'id'> & { createdAt: any };

type BreakInterval = {
  start: Date;
  end: Date;
};

function buildBreakIntervals(doctor: Doctor | null, referenceDate: Date | null): BreakInterval[] {
  return [];
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

  // Force booking states
  const [showForceBookDialog, setShowForceBookDialog] = useState(false);
  const [pendingForceBookData, setPendingForceBookData] = useState<z.infer<typeof formSchema> | null>(null);

  // States for patient search
  const [phoneNumber, setPhoneNumber] = useState('');
  const [isSearchingPatient, setIsSearchingPatient] = useState(false);
  const [searchedPatients, setSearchedPatients] = useState<Patient[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [selectedPatientId, setSelectedPatientId] = useState<string | null>(null);


  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: { patientName: '', age: undefined, place: '', sex: '', phone: '' },
  });

  const releaseReservation = async (reservationId?: string | null, delayMs: number = 0) => {
    if (!reservationId) return;
    if (delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    try {
      await deleteDoc(doc(db, 'slot-reservations', reservationId));
    } catch (error) {
      console.warn('[Walk-in] Failed to release reservation', { reservationId, error });
    }
  };

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
      return;
    };
    setIsSearchingPatient(true);
    setShowForm(false);
    setSelectedPatientId(null);
    form.reset();

    try {
      const fullPhoneNumber = `+91${phone}`;
      const patientsRef = collection(db, 'patients');

      // Find the primary user record first based on the phone number
      const primaryQuery = query(patientsRef, where('phone', '==', fullPhoneNumber));
      const primarySnapshot = await getDocs(primaryQuery);

      if (primarySnapshot.empty) {
        setSearchedPatients([]);
        setShowForm(true); // No user found, show form to create one
        form.setValue('phone', phone);
        return;
      }

      const primaryDoc = primarySnapshot.docs[0];
      const primaryPatient = { id: primaryDoc.id, ...primaryDoc.data() } as Patient;
      primaryPatient.clinicIds = primaryPatient.clinicIds || [];

      let allRelatedPatients: Patient[] = [primaryPatient];

      if (primaryPatient.relatedPatientIds && primaryPatient.relatedPatientIds.length > 0) {
        const relatedPatientsQuery = query(patientsRef, where('__name__', 'in', primaryPatient.relatedPatientIds));
        const relatedSnapshot = await getDocs(relatedPatientsQuery);
        const relatedPatients = relatedSnapshot.docs.map(doc => {
          const data = { id: doc.id, ...doc.data() } as Patient;
          data.clinicIds = data.clinicIds || [];
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
    const debounceTimer = setTimeout(() => {
      if (phoneNumber && phoneNumber.length === 10) {
        handlePatientSearch(phoneNumber);
      } else {
        setSearchedPatients([]);
        setShowForm(false);
        setSelectedPatientId(null);
      }
    }, 500);

    return () => clearTimeout(debounceTimer);
  }, [phoneNumber, handlePatientSearch]);

  const selectPatient = (patient: Patient) => {
    setSelectedPatientId(patient.id);
    form.reset({
      patientName: patient.name,
      age: patient.age,
      place: patient.place,
      sex: patient.sex,
      phone: patient.phone.replace('+91', ''),
    });
    setShowForm(true);
  };


  const isDoctorConsultingNow = useMemo(() => {
    if (!doctor?.availabilitySlots) return false;

    const todayDay = format(currentTime, 'EEEE');
    const todaysAvailability = doctor.availabilitySlots.find(s => s.day === todayDay);
    if (!todaysAvailability) return false;

    return todaysAvailability.timeSlots.some(slot => {
      const startTime = parseTime(slot.from, currentTime);
      const endTime = parseTime(slot.to, currentTime);
      return isWithinInterval(currentTime, { start: startTime, end: endTime });
    });
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
    if (!doctor || !clinicId) {
      toast({ variant: 'destructive', title: 'Error', description: 'Doctor or clinic not identified.' });
      return;
    }
    setIsSubmitting(true);

    try {
      const clinicDocRef = doc(db, 'clinics', clinicId);
      const clinicSnap = await getDoc(clinicDocRef);
      const clinicData = clinicSnap.data();
      const walkInTokenAllotment = clinicData?.walkInTokenAllotment || 5;

      let estimatedTime: Date;
      let patientsAhead: number;
      let numericToken: number;
      let slotIndex: number;
      let details: any;

      try {
        details = await calculateWalkInDetails(
          db,
          doctor,
          walkInTokenAllotment,
          0,
          false // Initially try without force booking
        );
        estimatedTime = details.estimatedTime;
        patientsAhead = details.patientsAhead;
        numericToken = details.numericToken;
        slotIndex = details.slotIndex;
      } catch (err: any) {
        console.error("Error calculating walk-in details:", err);
        const errorMessage = err.message || "";
        const isSlotUnavailable = errorMessage.includes("Unable to allocate walk-in slot") ||
          errorMessage.includes("No walk-in slots are available");

        // Check if within 15 minutes of closing
        const isNearClosing = isWithin15MinutesOfClosing(doctor, new Date());

        // If slots unavailable OR near closing, offer force booking
        if (isSlotUnavailable || isNearClosing) {
          console.log('[FORCE BOOK] Triggering force book dialog:', { isSlotUnavailable, isNearClosing });
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

      // Clean phone: remove +91 if user entered it, remove any non-digits, then ensure exactly 10 digits
      let fullPhoneNumber = "";
      if (values.phone) {
        const cleaned = values.phone.replace(/^\+91/, '').replace(/\D/g, ''); // Remove +91 prefix and non-digits
        if (cleaned.length === 10) {
          fullPhoneNumber = `+91${cleaned}`; // Add +91 prefix when saving
        }
      }
      if (!fullPhoneNumber) {
        toast({ variant: 'destructive', title: 'Error', description: 'Please enter a valid 10-digit phone number.' });
        setIsSubmitting(false);
        return;
      }
      const patientId = await managePatient({
        phone: fullPhoneNumber,
        name: values.patientName,
        age: values.age,
        place: values.place,
        sex: values.sex,
        clinicId,
        // For walk-ins, we can either use the existing patient's primary ID or create a new mock one.
        bookingUserId: selectedPatientId || `user_walkin_${fullPhoneNumber}`,
        bookingFor: selectedPatientId ? 'self' : 'new_related',
      });

      const numericTokenFromService = numericToken;
      const tokenNumber = `${numericTokenFromService}W`;

      // Calculate cut-off time and no-show time
      const appointmentDate = parse(format(new Date(), "d MMMM yyyy"), "d MMMM yyyy", new Date());

      // Use session-aware break intervals and validation
      const sessionIndex = details.sessionIndex ?? 0;
      const sessionBreakIntervals = getSessionBreakIntervals(doctor, appointmentDate, sessionIndex);
      const adjustedEstimatedTime = sessionBreakIntervals.length > 0
        ? applyBreakOffsets(estimatedTime, sessionBreakIntervals)
        : estimatedTime;

      // Validate that appointment end time (adjustedEstimatedTime + consultationTime) doesn't exceed session end
      const sessionEffectiveEnd = getSessionEnd(doctor, appointmentDate, sessionIndex);
      if (sessionEffectiveEnd) {
        const consultationTime = doctor.averageConsultingTime || 15;
        const appointmentEndTime = addMinutes(adjustedEstimatedTime, consultationTime);
        if (isAfter(appointmentEndTime, sessionEffectiveEnd)) {
          toast({
            variant: 'destructive',
            title: 'Walk-in Not Available',
            description: `Next estimated time ~${format(adjustedEstimatedTime, 'hh:mm a')} is outside availability (ends at ${format(sessionEffectiveEnd, 'hh:mm a')}).`,
          });
          setIsSubmitting(false);
          return;
        }
      }

      const adjustedEstimatedTimeStr = format(adjustedEstimatedTime, "hh:mm a");
      const cutOffTime = subMinutes(adjustedEstimatedTime, 15);
      const noShowTime = addMinutes(adjustedEstimatedTime, 15);

      const newAppointmentData: UnsavedAppointment = {
        patientName: values.patientName,
        age: values.age,
        place: values.place,
        sex: values.sex as "Male" | "Female" | "Other",
        communicationPhone: fullPhoneNumber,
        patientId,
        doctorId: doctor.id, // Add doctorId
        doctor: doctor.name,
        department: doctor.department,
        bookedVia: 'Walk-in',
        date: format(new Date(), "d MMMM yyyy"),
        time: adjustedEstimatedTimeStr,
        arriveByTime: adjustedEstimatedTimeStr,
        status: 'Confirmed', // Walk-ins are physically present at clinic
        tokenNumber,
        numericToken: numericTokenFromService,
        clinicId,
        createdAt: serverTimestamp(),
        slotIndex,
        cutOffTime: cutOffTime,
        noShowTime: noShowTime,
      };

      setAppointmentToSave(newAppointmentData);
      setEstimatedConsultationTime(estimatedTime);
      setPatientsAhead(patientsAhead);
      setGeneratedToken(tokenNumber);
      setIsEstimateModalOpen(true);

    } catch (error: any) {
      if (error.name !== 'FirestorePermissionError') {
        console.error('Failed to prepare walk-in:', error);
        toast({ variant: 'destructive', title: 'Error', description: (error as Error).message || "Could not complete registration." });
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  // Handle force booking confirmation
  const handleForceBook = async () => {
    if (!pendingForceBookData || !doctor || !clinicId) {
      console.error('[FORCE BOOK] Missing data for force booking');
      setShowForceBookDialog(false);
      return;
    }

    setShowForceBookDialog(false);
    setIsSubmitting(true);

    const values = pendingForceBookData;

    try {
      const clinicDocRef = doc(db, 'clinics', clinicId);
      const clinicSnap = await getDoc(clinicDocRef);
      const clinicData = clinicSnap.data();
      const walkInTokenAllotment = clinicData?.walkInTokenAllotment || 5;

      let estimatedTime: Date;
      let patientsAhead: number;
      let numericToken: number;
      let slotIndex: number;
      let details: any;
      let isForceBooked = false;

      // Retry with force booking enabled
      try {
        details = await calculateWalkInDetails(
          db,
          doctor,
          walkInTokenAllotment,
          0,
          true // Force booking enabled
        );
        estimatedTime = details.estimatedTime;
        patientsAhead = details.patientsAhead;
        numericToken = details.numericToken;
        slotIndex = details.slotIndex;
        isForceBooked = details.isForceBooked || false;

        console.log('[FORCE BOOK] Successfully created overflow slot:', {
          slotIndex,
          time: format(estimatedTime, 'hh:mm a'),
          isForceBooked
        });
      } catch (err: any) {
        console.error('[FORCE BOOK] Failed even with force booking:', err);
        toast({
          variant: "destructive",
          title: "Force Booking Failed",
          description: err.message || "Could not create overflow slot.",
        });
        setIsSubmitting(false);
        return;
      }

      // Continue with normal booking flow...
      // Clean phone
      let fullPhoneNumber = "";
      if (values.phone) {
        const cleaned = values.phone.replace(/^\+91/, '').replace(/\D/g, '');
        if (cleaned.length === 10) {
          fullPhoneNumber = `+91${cleaned}`;
        }
      }
      if (!fullPhoneNumber) {
        toast({ variant: 'destructive', title: 'Error', description: 'Please enter a valid 10-digit phone number.' });
        setIsSubmitting(false);
        return;
      }

      const patientId = await managePatient({
        phone: fullPhoneNumber,
        communicationPhone: fullPhoneNumber,
        name: values.patientName,
        age: values.age,
        place: values.place,
        sex: values.sex as 'Male' | 'Female' | 'Other',
        clinicId,
        bookingFor: 'self',
      });

      const tokenNumber = `W${String(numericToken).padStart(3, '0')}`;
      const appointmentDate = parse(format(new Date(), "d MMMM yyyy"), "d MMMM yyyy", new Date());
      const breakIntervals = getSessionBreakIntervals(doctor, appointmentDate, details.sessionIndex);
      const adjustedEstimatedTime = breakIntervals.length > 0
        ? breakIntervals.reduce((acc, interval) => {
          if (acc.getTime() >= interval.start.getTime()) {
            return addMinutes(acc, differenceInMinutes(interval.end, interval.start));
          }
          return acc;
        }, new Date(estimatedTime))
        : estimatedTime;

      const adjustedEstimatedTimeStr = format(adjustedEstimatedTime, "hh:mm a");
      const cutOffTime = subMinutes(adjustedEstimatedTime, 15);
      const noShowTime = addMinutes(adjustedEstimatedTime, 15);

      const newAppointmentData: UnsavedAppointment = {
        patientId,
        patientName: values.patientName,
        age: values.age,
        communicationPhone: fullPhoneNumber,
        place: values.place,
        sex: values.sex as any,
        doctorId: doctor.id,
        doctor: doctor.name,
        department: doctor.department,
        bookedVia: 'Walk-in',
        date: format(new Date(), "d MMMM yyyy"),
        time: adjustedEstimatedTimeStr,
        arriveByTime: adjustedEstimatedTimeStr,
        status: 'Confirmed',
        tokenNumber,
        numericToken: numericToken,
        clinicId,
        createdAt: serverTimestamp(),
        slotIndex,
        cutOffTime: cutOffTime,
        noShowTime: noShowTime,
        isForceBooked, // Mark as force booked
      };

      setAppointmentToSave(newAppointmentData);
      setEstimatedConsultationTime(estimatedTime);
      setPatientsAhead(patientsAhead);
      setGeneratedToken(tokenNumber);
      setIsEstimateModalOpen(true);

    } catch (error: any) {
      if (error.name !== 'FirestorePermissionError') {
        console.error('[FORCE BOOK] Failed to prepare force booking:', error);
        toast({ variant: 'destructive', title: 'Error', description: (error as Error).message || "Could not complete force booking." });
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleProceedToToken = async () => {
    console.log('🎯 DEBUG: handleProceedToToken called');
    console.log('🎯 DEBUG: appointmentToSave:', appointmentToSave);

    if (!appointmentToSave || !doctor) {
      console.error('🎯 DEBUG: No appointment data to save or doctor not available');
      toast({ variant: 'destructive', title: 'Error', description: 'No appointment data to save.' });
      return;
    }

    try {
      // IMPORTANT: Recalculate token from current database state to avoid duplicates
      const clinicDocRef = doc(db, 'clinics', clinicId!);
      const clinicSnap = await getDoc(clinicDocRef);
      const clinicData = clinicSnap.data();
      const walkInTokenAllotment = clinicData?.walkInTokenAllotment || 5;
      let recalculatedDetails;
      const isAlreadyForceBooked = appointmentToSave?.isForceBooked || false;

      try {
        recalculatedDetails = await calculateWalkInDetails(
          db,
          doctor,
          walkInTokenAllotment,
          0,
          isAlreadyForceBooked // Use same force book status as initial calculation
        );
      } catch (err: any) {
        console.error("Error calculating walk-in details:", err);
        const errorMessage = err.message || "";
        const isSlotUnavailable = errorMessage.includes("Unable to allocate walk-in slot") ||
          errorMessage.includes("No walk-in slots are available");
        toast({
          variant: "destructive",
          title: "Walk-in Unavailable",
          description: isSlotUnavailable ? "Walk-in slot not available." : (err.message || "Could not calculate walk-in details."),
        });
        setIsSubmitting(false);
        return;
      }

      // Use generateNextTokenAndReserveSlot to ensure sequential numbering and shift subsequent appointments
      const { tokenNumber: walkInTokenNumber, numericToken: walkInNumericToken, slotIndex: actualSlotIndex, reservationId } = await generateNextTokenAndReserveSlot(
        db, // CRITICAL: First parameter must be firestore instance
        clinicId!,
        doctor.name,
        new Date(),
        'W',
        {
          time: format(recalculatedDetails.estimatedTime, "hh:mm a"),
          slotIndex: recalculatedDetails.slotIndex,
          doctorId: doctor.id,
          isForceBooked: appointmentToSave?.isForceBooked,
        }
      );

      // W tokens don't have a fixed time - use the time from the appointment before this slot
      // Calculate cut-off time and no-show time based on the actual slot time
      const appointmentDate = parse(format(new Date(), "d MMMM yyyy"), "d MMMM yyyy", new Date());

      // Use session-aware break intervals and validation
      const sessionIndex = recalculatedDetails.sessionIndex ?? 0;
      const sessionBreakIntervals = getSessionBreakIntervals(doctor, appointmentDate, sessionIndex);
      const adjustedAppointmentTime = sessionBreakIntervals.length > 0
        ? applyBreakOffsets(recalculatedDetails.estimatedTime, sessionBreakIntervals)
        : recalculatedDetails.estimatedTime;

      // Validate that appointment end time (adjustedAppointmentTime + consultationTime) doesn't exceed session end
      const sessionEffectiveEnd = getSessionEnd(doctor, appointmentDate, sessionIndex);
      // Only check availability end if NOT force booked
      if (sessionEffectiveEnd && !appointmentToSave?.isForceBooked) {
        const consultationTime = doctor.averageConsultingTime || 15;
        const appointmentEndTime = addMinutes(adjustedAppointmentTime, consultationTime);
        if (isAfter(appointmentEndTime, sessionEffectiveEnd)) {
          if (reservationId) {
            await releaseReservation(reservationId);
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

      const adjustedTimeStr = format(adjustedAppointmentTime, "hh:mm a");
      const cutOffTime = subMinutes(adjustedAppointmentTime, 15);
      const noShowTime = addMinutes(adjustedAppointmentTime, 15);

      // Update appointment data with recalculated values
      const finalAppointmentTime = adjustedTimeStr;
      const updatedAppointmentData = {
        ...appointmentToSave,
        time: finalAppointmentTime,
        arriveByTime: finalAppointmentTime,
        tokenNumber: walkInTokenNumber,
        numericToken: walkInNumericToken,
        slotIndex: actualSlotIndex, // Use the actual slotIndex returned from the function
        sessionIndex: recalculatedDetails.sessionIndex,
        cutOffTime: cutOffTime,
        noShowTime: noShowTime,
      };

      console.log('🎯 DEBUG: Creating appointment document');
      const appointmentsCollection = collection(db, 'appointments');
      const newDocRef = doc(appointmentsCollection);

      try {
        await setDoc(newDocRef, { ...updatedAppointmentData, id: newDocRef.id });
      } catch (serverError) {
        if (reservationId) {
          await releaseReservation(reservationId);
        }
        console.error('🎯 DEBUG: Failed to save appointment');
        const permissionError = new FirestorePermissionError({
          path: 'appointments',
          operation: 'create',
          requestResourceData: appointmentToSave,
        });
        errorEmitter.emit('permission-error', permissionError);
        throw serverError;
      }
      if (reservationId) {
        await releaseReservation(reservationId, 2000);
      }
      console.log('🎯 DEBUG: Appointment saved successfully:', newDocRef.id);

      // Send notification to patient
      console.log('🎯 DEBUG: Starting notification process');
      try {
        // Get patientId from appointmentToSave
        const patientId = appointmentToSave.patientId;
        console.log('🎯 DEBUG: Patient ID:', patientId);

        // Get clinic name
        const clinicDoc = await getDoc(doc(db, 'clinics', clinicId!));
        const clinicData = clinicDoc.data();
        const clinicName = clinicData?.name || 'The clinic';
        console.log('🎯 DEBUG: Clinic name:', clinicName);

        await sendAppointmentBookedByStaffNotification({
          firestore: db,
          patientId,
          appointmentId: newDocRef.id,
          doctorName: updatedAppointmentData.doctor,
          clinicName: clinicName,
          date: updatedAppointmentData.date,
          time: updatedAppointmentData.time,
          arriveByTime: updatedAppointmentData.arriveByTime,
          tokenNumber: updatedAppointmentData.tokenNumber,
          bookedBy: 'admin',
        });
        console.log('🎯 DEBUG: Notification sent to patient');
      } catch (notifError) {
        console.error('🎯 DEBUG: Failed to send notification:', notifError);
        if (notifError instanceof Error) {
          console.error('🎯 DEBUG: Error message:', notifError.message);
          console.error('🎯 DEBUG: Error stack:', notifError.stack);
        }
        // Don't fail the appointment creation if notification fails
      }

      setIsEstimateModalOpen(false);
      setIsTokenModalOpen(true);

      setTimeout(() => {
        setIsTokenModalOpen(false);
        router.push('/dashboard');
      }, 5000);

    } catch (error) {
      if ((error as any).name !== 'FirestorePermissionError') {
        // reservationId is not accessible here easily without refactoring, but we can try to release if we had it.
        // For now, we rely on the fact that if we failed before reservation, we don't need to release.
        // If we failed after reservation but before setDoc, we might have a dangling reservation.
        // Ideally we should lift reservationId scope.
      }
      if ((error as any).name !== 'FirestorePermissionError') {
        console.error('Failed to save walk-in appointment:', error);
        toast({ variant: 'destructive', title: 'Error', description: "Could not save the appointment." });
      }
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
                            <FormField control={form.control} name="patientName" render={({ field }) => (
                              <FormItem><FormLabel>Full Name</FormLabel><FormControl><Input placeholder="e.g. Jane Smith" {...field} /></FormControl><FormMessage /></FormItem>
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
                              <FormItem><FormLabel>Place</FormLabel><FormControl><Input placeholder="e.g. Cityville" {...field} /></FormControl><FormMessage /></FormItem>
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
          </DialogContent>
        </Dialog>

        <Dialog open={isTokenModalOpen} onOpenChange={setIsTokenModalOpen}>
          <DialogContent className="sm:max-w-xs w-[90%] text-center p-6 sm:p-8">
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
export default function WalkInRegistrationPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <WalkInRegistrationContent />
    </Suspense>
  );
}