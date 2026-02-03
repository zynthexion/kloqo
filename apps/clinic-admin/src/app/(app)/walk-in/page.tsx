
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
import { doc, getDoc, collection, addDoc, query, where, getDocs, serverTimestamp, setDoc, deleteDoc, onSnapshot } from 'firebase/firestore';
import type { Appointment, Doctor, Patient } from '@/lib/types';
import { useToast } from '@/hooks/use-toast';
import { format, isWithinInterval, parse, subMinutes, addMinutes, differenceInMinutes, parseISO, isAfter } from 'date-fns';
import { parseTime } from '@/lib/utils';
import { cn } from '@/lib/utils';
import { errorEmitter } from '@/firebase/error-emitter';
import { FirestorePermissionError } from '@/firebase/errors';
import { managePatient } from '@kloqo/shared-core';
import { calculateWalkInDetails, generateNextTokenAndReserveSlot, sendAppointmentBookedByStaffNotification, completeStaffWalkInBooking, getClinicTimeString, generateWalkInTokenNumber, calculateEstimatedTimes, getClinicDateString, getClinicNow } from '@kloqo/shared-core';

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

// Redundant break logic removed. Scheduled breaks are pre-shifted in the slot system.

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
  const [arrivedAppointments, setArrivedAppointments] = useState<Appointment[]>([]);

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

      // PRIORITY 1: Check 'users' collection first to ensure we find the registered account
      const usersRef = collection(db, 'users');
      const userQuery = query(usersRef, where('phone', '==', fullPhoneNumber), where('role', '==', 'patient'));
      const userSnapshot = await getDocs(userQuery);

      let primaryPatient: Patient | null = null;

      if (!userSnapshot.empty) {
        // User exists! Use their linked patient record.
        const userDoc = userSnapshot.docs[0].data();
        if (userDoc.patientId) {
          const patientDocSnap = await getDoc(doc(db, 'patients', userDoc.patientId));
          if (patientDocSnap.exists()) {
            primaryPatient = { id: patientDocSnap.id, ...patientDocSnap.data() } as Patient;
          }
        }
      }

      // PRIORITY 2: If no user found (or user has no patient), search 'patients' collection
      if (!primaryPatient) {
        const patientsRef = collection(db, 'patients');
        const primaryQuery = query(patientsRef, where('phone', '==', fullPhoneNumber));
        const primarySnapshot = await getDocs(primaryQuery);

        if (!primarySnapshot.empty) {
          const primaryDoc = primarySnapshot.docs[0];
          primaryPatient = { id: primaryDoc.id, ...primaryDoc.data() } as Patient;
        }
      }

      if (!primaryPatient) {
        setSearchedPatients([]);
        setShowForm(true); // No user or patient found, show form
        form.setValue('phone', phone);
        return;
      }

      primaryPatient.clinicIds = primaryPatient.clinicIds || [];
      const patientsRef = collection(db, 'patients');
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


  const [activeAppointmentsCount, setActiveAppointmentsCount] = useState<Record<number, number>>({});

  // Listen to active appointments to handle overtime logic
  useEffect(() => {
    if (!doctor || !clinicId) return;

    const todayDateStr = format(currentTime, "d MMMM yyyy");
    const q = query(
      collection(db, 'appointments'),
      where('clinicId', '==', clinicId),
      where('doctor', '==', doctor.name), // Ideally use doctorId, but system uses name often. Using doctor ID is safer if available in schema.
      where('date', '==', todayDateStr),
      where('status', 'in', ['Pending', 'Confirmed', 'Skipped', 'No-show'])
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const counts: Record<number, number> = {};
      snapshot.docs.forEach(doc => {
        const data = doc.data();
        // Assuming sessionIndex is stored. If not, this logic requires sessionIndex.
        if (typeof data.slotIndex === 'number') {
          // We need sessionIndex. Most appointments have it.
          // If strictly relying on slotIndex is hard, we rely on data.sessionIndex if available.
          const sIndex = data.sessionIndex;
          if (typeof sIndex === 'number') {
            counts[sIndex] = (counts[sIndex] || 0) + 1;
          }
        }
      });
      setActiveAppointmentsCount(counts);
    }, (err) => {
      console.error("Error listening to appointments:", err);
    });

    return () => unsubscribe();
  }, [doctor, clinicId, currentTime]); // Re-subscribe if date changes (midnight)

  const isDoctorConsultingNow = useMemo(() => {
    if (!doctor?.availabilitySlots) return false;

    const todayDay = format(currentTime, 'EEEE');
    const todaysAvailability = doctor.availabilitySlots.find(s => s.day === todayDay);
    if (!todaysAvailability || !todaysAvailability.timeSlots) return false;

    return todaysAvailability.timeSlots.some((slot, index) => {
      const startTime = parseTime(slot.from, currentTime);

      // Open 30 mins before session start
      const openTime = subMinutes(startTime, 30);
      if (isBefore(currentTime, openTime)) return false;

      // Calculate logic end time
      // 15 minutes buffer NOT applicable for clinic/nurse apps
      const effectiveEnd = getSessionEnd(doctor, currentTime, index) || parseTime(slot.to, currentTime);

      // If within normal hours (incl extension) -> Available
      if (!isAfter(currentTime, effectiveEnd)) return true;

      // If Overtime: Only available if there are active appointments in this session
      const activeCount = activeAppointmentsCount[index] || 0;
      if (activeCount > 0) {
        return true; // Keep open for queue
      }

      return false; // Ended and empty
    });
  }, [doctor, currentTime, activeAppointmentsCount]);

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

  // Listen for arrived appointments to show correct people ahead for Classic distribution
  useEffect(() => {
    if (!doctor || !clinicId) return;

    const todayStr = getClinicDateString(getClinicNow());
    const q = query(
      collection(db, 'appointments'),
      where('clinicId', '==', clinicId),
      where('doctor', '==', doctor.name),
      where('date', '==', todayStr),
      where('status', 'in', ['Arrived', 'Confirmed'])
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const apps = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Appointment));
      setArrivedAppointments(apps);
    }, (err) => {
      console.error("Error listening to arrived appointments:", err);
    });

    return () => unsubscribe();
  }, [doctor, clinicId]);

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
        // If we selected a patient, update that specific record (safest)
        // If new, create/find (self)
        id: selectedPatientId || undefined,
        bookingUserId: undefined,
        bookingFor: selectedPatientId ? 'update' : 'self',
      });


      // Check for duplicate booking - same patient, same doctor, same day
      const appointmentDateStr = format(new Date(), "d MMMM yyyy");
      const duplicateCheckQuery = query(
        collection(db, "appointments"),
        where("patientId", "==", patientId),
        where("doctor", "==", doctor.name),
        where("date", "==", appointmentDateStr),
        where("status", "in", ["Pending", "Confirmed", "Skipped"])
      );

      const duplicateSnapshot = await getDocs(duplicateCheckQuery);
      if (!duplicateSnapshot.empty) {
        toast({
          variant: "destructive",
          title: "Duplicate Booking",
          description: "This patient already has an appointment with this doctor today.",
        });
        setIsSubmitting(false);
        return;
      }

      const previewTokenNumber = `${numericToken}W`;
      const appointmentDate = parse(appointmentDateStr, "d MMMM yyyy", new Date());

      // Visual Estimate Override for Classic Distribution
      let visualEstimatedTime = details.perceivedEstimatedTime ?? estimatedTime;
      let visualPatientsAhead = (details.perceivedPatientsAhead !== undefined) ? details.perceivedPatientsAhead : patientsAhead;

      console.log('[WALK-IN:ESTIMATE] Using walk-in details:', {
        original: getClinicTimeString(estimatedTime),
        perceived: details.perceivedEstimatedTime ? getClinicTimeString(details.perceivedEstimatedTime) : 'N/A',
        perceivedAhead: details.perceivedPatientsAhead,
        finalVisual: getClinicTimeString(visualEstimatedTime),
        finalAhead: visualPatientsAhead
      });

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
        date: appointmentDateStr,
        time: getClinicTimeString(visualEstimatedTime),
        arriveByTime: getClinicTimeString(visualEstimatedTime),
        status: 'Confirmed', // Walk-ins are physically present at clinic
        tokenNumber: previewTokenNumber,
        numericToken: numericToken,
        clinicId,
        createdAt: serverTimestamp(),
        slotIndex,
        cutOffTime: subMinutes(visualEstimatedTime, 15),
        noShowTime: addMinutes(visualEstimatedTime, 15),
      };

      setAppointmentToSave(newAppointmentData);
      setEstimatedConsultationTime(visualEstimatedTime);
      setPatientsAhead(visualPatientsAhead);
      setGeneratedToken(previewTokenNumber);
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

      const previewTokenNumber = generateWalkInTokenNumber(numericToken, details.sessionIndex);
      const appointmentDate = parse(format(new Date(), "d MMMM yyyy"), "d MMMM yyyy", new Date());
      const appointmentDateStr = format(new Date(), "d MMMM yyyy");

      // Visual Estimate Override for Classic Distribution (Force Book)
      let visualEstimatedTime = details.perceivedEstimatedTime ?? estimatedTime;
      let visualPatientsAhead = (details.perceivedPatientsAhead !== undefined) ? details.perceivedPatientsAhead : patientsAhead;

      console.log('[WALK-IN:ESTIMATE] Using walk-in details (Force):', {
        original: getClinicTimeString(estimatedTime),
        perceived: details.perceivedEstimatedTime ? getClinicTimeString(details.perceivedEstimatedTime) : 'N/A',
        perceivedAhead: details.perceivedPatientsAhead,
        finalVisual: getClinicTimeString(visualEstimatedTime),
        finalAhead: visualPatientsAhead
      });

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
        date: appointmentDateStr,
        time: getClinicTimeString(visualEstimatedTime),
        arriveByTime: getClinicTimeString(visualEstimatedTime),
        status: 'Confirmed',
        tokenNumber: previewTokenNumber,
        numericToken: numericToken,
        clinicId,
        createdAt: serverTimestamp(),
        slotIndex,
        cutOffTime: subMinutes(visualEstimatedTime, 15),
        noShowTime: addMinutes(visualEstimatedTime, 15),
        isForceBooked, // Mark as force booked
      };

      setAppointmentToSave(newAppointmentData);
      setEstimatedConsultationTime(visualEstimatedTime);
      setPatientsAhead(visualPatientsAhead);
      setGeneratedToken(previewTokenNumber);
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
          const clinicDoc = await getDoc(doc(db, 'clinics', clinicId!));
          const clinicName = clinicDoc.exists() ? clinicDoc.data().name : 'The Clinic';

          sendAppointmentBookedByStaffNotification({
            firestore: db,
            patientId: appointmentToSave.patientId!,
            appointmentId: result.appointmentId,
            doctorName: doctor.name,
            clinicName: clinicName,
            date: appointmentToSave.date,
            time: result.estimatedTime, // Service returns ISO, but notification helper expects formatted
            arriveByTime: result.estimatedTime,
            tokenNumber: result.tokenNumber,
            bookedBy: 'admin',
            tokenDistribution: clinicDoc.exists() ? clinicDoc.data().tokenDistribution : undefined,
            classicTokenNumber: result.tokenNumber, // Walk-ins have direct tokens
          }).catch(err => console.error('Failed to send walk-in notification:', err));
        } catch (err) {
          console.error('Error preparing notification:', err);
        }

        setTimeout(() => {
          setIsTokenModalOpen(false);
          router.push('/dashboard');
        }, 5000);
      }
    } catch (error: any) {
      console.error('Failed to confirm walk-in registration:', error);
      if (error.name !== 'FirestorePermissionError') {
        toast({
          variant: 'destructive',
          title: 'Error',
          description: error.message || 'Could not confirm the registration.',
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