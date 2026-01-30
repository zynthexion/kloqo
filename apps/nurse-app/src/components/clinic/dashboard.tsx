
'use client';

import { useState, useMemo, useEffect, useCallback, useTransition } from 'react';
import type { Appointment, Doctor } from '@/lib/types';
import { useToast } from '@/hooks/use-toast';
import { format, isPast, addMinutes, parse, isAfter, isSameDay, addDays, subDays } from 'date-fns';
import { Carousel, CarouselContent, CarouselItem } from '@/components/ui/carousel';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { cn } from '@/lib/utils';
import { collection, getDocs, query, onSnapshot, doc, updateDoc, Query, where, writeBatch, getDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Search } from 'lucide-react';
import { parseAppointmentDateTime, parseTime } from '@/lib/utils';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

import ClinicHeader from './header';
import AppointmentList from './appointment-list';
import { useRouter, usePathname } from 'next/navigation';
import { errorEmitter, compareAppointments, compareAppointmentsClassic, FirestorePermissionError } from '@kloqo/shared-core';


export default function ClinicDashboard() {
  const router = useRouter();
  const pathname = usePathname();
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [selectedDoctor, setSelectedDoctor] = useState<string>('');
  const [searchTerm, setSearchTerm] = useState('');
  const [activeTab, setActiveTab] = useState('pending');
  const [clinicStatus, setClinicStatus] = useState<'in' | 'out'>('in');
  const [clinicId, setClinicId] = useState<string | null>(null);
  const [clinicDetails, setClinicDetails] = useState<any>(null);
  const [isPending, startTransition] = useTransition();
  const [currentTime, setCurrentTime] = useState(new Date());
  const [appointmentToAddToQueue, setAppointmentToAddToQueue] = useState<Appointment | null>(null);
  const [isPhoneMode, setIsPhoneMode] = useState(false);

  const isAppointmentsPage = pathname === '/appointments';
  const [selectedDate, setSelectedDate] = useState<Date | null>(isAppointmentsPage ? null : new Date());
  const [api, setApi] = useState<any>();
  const [currentMonth, setCurrentMonth] = useState(format(selectedDate || new Date(), 'MMMM yyyy'));
  const { toast } = useToast();

  // Generate a range of dates (90 days before and 275 days after today)
  const dates = useMemo(() => {
    const today = new Date();
    return Array.from({ length: 365 }, (_, i) => addDays(subDays(today, 90), i));
  }, []);

  // Scroll to selected date whenever it changes, or today if none selected
  useEffect(() => {
    if (!api) return;
    const targetDate = selectedDate || new Date();
    const dateIndex = dates.findIndex(d => isSameDay(d, targetDate));
    if (dateIndex !== -1) {
      api.scrollTo(dateIndex, true);
    }
  }, [api, dates, selectedDate]);

  // Update current month display when selected date changes
  useEffect(() => {
    setCurrentMonth(format(selectedDate || new Date(), 'MMMM yyyy'));
  }, [selectedDate]);

  // Update current time every minute
  useEffect(() => {
    const timerId = setInterval(() => setCurrentTime(new Date()), 60000);
    return () => clearInterval(timerId);
  }, []);

  useEffect(() => {
    const status = (localStorage.getItem('clinicStatus') as 'in' | 'out') || 'in';
    setClinicStatus(status);
    const id = localStorage.getItem('clinicId');
    if (!id) {
      router.push('/login');
      return;
    }
    setClinicId(id);

    // Fetch clinic details
    const fetchClinicDetails = async () => {
      try {
        const clinicDoc = await getDoc(doc(db, 'clinics', id));
        if (clinicDoc.exists()) {
          setClinicDetails(clinicDoc.data());
        }
      } catch (error) {
        console.error('Error fetching clinic details:', error);
      }
    };
    fetchClinicDetails();


    const handleStorageChange = () => {
      const newStatus = (localStorage.getItem('clinicStatus') as 'in' | 'out') || 'in';
      setClinicStatus(newStatus);
    };

    window.addEventListener('storage', handleStorageChange);


    const fetchInitialData = async () => {
      if (!id) return;
      try {
        const doctorsQuery = query(collection(db, 'doctors'), where('clinicId', '==', id));
        const doctorsSnapshot = await getDocs(doctorsQuery).catch(async (serverError) => {
          const permissionError = new FirestorePermissionError({
            path: 'doctors',
            operation: 'list',
          });
          errorEmitter.emit('permission-error', permissionError);
          throw serverError;
        });

        if (!doctorsSnapshot.empty) {
          const fetchedDoctors = doctorsSnapshot.docs.map((doc) => ({
            id: doc.id,
            ...doc.data(),
          })) as Doctor[];
          setDoctors(fetchedDoctors);

          const storedDoctorId = localStorage.getItem('selectedDoctorId');
          if (storedDoctorId && fetchedDoctors.some(d => d.id === storedDoctorId)) {
            setSelectedDoctor(storedDoctorId);
          } else if (fetchedDoctors.length > 0) {
            setSelectedDoctor(fetchedDoctors[0].id);
          }
        }

      } catch (error: any) {
        if (error.name !== 'FirestorePermissionError') {
          console.error('Error fetching initial data:', error);
          toast({
            variant: 'destructive',
            title: 'Error',
            description: 'Could not fetch doctors list.',
          });
        }
      }
    };
    fetchInitialData();

    return () => {
      window.removeEventListener('storage', handleStorageChange);
    };
  }, [toast, router]);

  const handleDoctorChange = (doctorId: string) => {
    setSelectedDoctor(doctorId);
    localStorage.setItem('selectedDoctorId', doctorId);
  }

  const processAppointments = useCallback(async (querySnapshot: any) => {
    const fetchedAppointments: Appointment[] = [];
    querySnapshot.forEach((docSnap: any) => {
      const data = docSnap.data();

      // Filter out appointments cancelled by break
      if (data.cancelledByBreak) {
        return;
      }

      fetchedAppointments.push({
        id: docSnap.id,
        docId: docSnap.id,
        tokenNumber: data.tokenNumber || '',
        numericToken: data.numericToken || 0,
        patientName: data.patientName,
        patientId: data.patientId, // Include patientId for notifications
        clinicId: data.clinicId, // Include clinicId for notifications
        bookedVia: data.bookedVia,
        status: data.status,
        department: data.department,
        doctor: data.doctor,
        treatment: data.treatment,
        age: data.age,
        place: data.place,
        gender: data.gender,
        phone: data.phone,
        date: data.date,
        time: data.time,
        arriveByTime: data.arriveByTime, // Include arriveByTime for notifications
        cancellationReason: data.cancellationReason,
        skippedAt: data.skippedAt,
        noShowTime: data.noShowTime,
        sex: data.sex || 'Male',
        communicationPhone: data.communicationPhone || data.phone,
        isRescheduled: data.isRescheduled,
        sessionIndex: data.sessionIndex, // CRITICAL: Include sessionIndex for session-based logic
      } as Appointment);
    });


    fetchedAppointments.sort(clinicDetails?.tokenDistribution !== 'advanced' ? compareAppointmentsClassic : compareAppointments);

    setAppointments(fetchedAppointments);
  }, [clinicDetails]);

  useEffect(() => {
    if (!selectedDoctor || !clinicId) return;

    const doctor = doctors.find(d => d.id === selectedDoctor);
    if (!doctor) return;

    let q: Query;

    const todayStr = format(new Date(), 'd MMMM yyyy');
    const selectedDateStr = selectedDate ? format(selectedDate, 'd MMMM yyyy') : null;

    if (isAppointmentsPage) {
      const constraints = [
        where('doctor', '==', doctor.name),
        where('clinicId', '==', clinicId)
      ];
      if (selectedDateStr) {
        constraints.push(where('date', '==', selectedDateStr));
      }
      q = query(collection(db, "appointments"), ...constraints);
    } else {
      q = query(
        collection(db, "appointments"),
        where('doctor', '==', doctor.name),
        where('clinicId', '==', clinicId),
        where('date', '==', todayStr)
      );
    }

    const unsubscribe = onSnapshot(q, processAppointments, async (serverError) => {
      const permissionError = new FirestorePermissionError({
        path: 'appointments',
        operation: 'list'
      });
      errorEmitter.emit('permission-error', permissionError);
    });

    return () => unsubscribe();
  }, [processAppointments, toast, selectedDoctor, doctors, isAppointmentsPage, clinicId, selectedDate]);

  const handleUpdateStatus = (id: string, status: 'completed' | 'Cancelled' | 'No-show' | 'Skipped') => {
    startTransition(async () => {
      try {
        const appointmentRef = doc(db, 'appointments', id);
        const appointment = appointments.find(a => a.id === id);
        const now = new Date();

        const updateData: any = { status: status.charAt(0).toUpperCase() + status.slice(1) };
        if (status === 'completed') {
          updateData.completedAt = serverTimestamp();

          // Increment consultation counter
          if (appointment && selectedDoctor && appointment.sessionIndex !== undefined) {
            try {
              const { incrementConsultationCounter } = await import('@kloqo/shared-core');
              await incrementConsultationCounter(
                appointment.clinicId,
                selectedDoctor,
                appointment.date,
                appointment.sessionIndex
              );
            } catch (counterError) {
              console.error('Error incrementing consultation counter:', counterError);
              // Don't fail the status update if counter update fails
            }
          }
        }
        if (status === 'Skipped') {
          updateData.skippedAt = serverTimestamp();
        }

        await updateDoc(appointmentRef, updateData);

        // Send notifications to next patients when appointment is completed
        if (status === 'completed' && appointment) {
          try {
            const { notifyNextPatientsWhenCompleted } = await import('@kloqo/shared-core');
            const clinicDocRef = doc(db, 'clinics', appointment.clinicId);
            const clinicDoc = await getDoc(clinicDocRef).catch(() => null);
            const clinicName = clinicDoc?.data()?.name || 'The clinic';

            await notifyNextPatientsWhenCompleted({
              firestore: db,
              completedAppointmentId: appointment.id,
              completedAppointment: appointment,
              clinicName,
            });
            console.log('Notifications sent to next patients in queue');
          } catch (notifError) {
            console.error('Failed to send notifications to next patients:', notifError);
          }
        }

        // Send cancellation notification when appointment is cancelled
        if (status === 'Cancelled') {
          try {
            // Fetch full appointment document from Firestore to ensure we have all fields
            // (some appointments in local state may be missing patientId/clinicId)
            const appointmentDoc = await getDoc(appointmentRef);
            const fullAppointmentData = appointmentDoc.exists() ? appointmentDoc.data() : null;

            // Use full appointment data if available, otherwise fall back to local state
            const appointmentToUse = fullAppointmentData || appointment;

            if (!appointmentToUse) {
              console.warn('[NURSE CANCEL DEBUG] No appointment data found, skipping notification');
              return;
            }

            const patientId = appointmentToUse.patientId;
            if (!patientId) {
              console.warn('[NURSE CANCEL DEBUG] Appointment has no patientId, cannot send notification', {
                appointmentId: id,
                appointmentData: appointmentToUse,
              });
              return;
            }

            console.log('[NURSE CANCEL DEBUG] Preparing to send cancellation notification', {
              appointmentId: id,
              patientId: patientId,
              clinicId: appointmentToUse.clinicId,
            });

            const { sendAppointmentCancelledNotification } = await import('@kloqo/shared-core');

            // Some legacy appointments may not have clinicId populated – fall back gracefully
            let clinicName = 'The clinic';
            if (appointmentToUse.clinicId) {
              try {
                const clinicDocRef = doc(db, 'clinics', appointmentToUse.clinicId);
                const clinicDoc = await getDoc(clinicDocRef).catch(() => null);
                clinicName = clinicDoc?.data()?.name || clinicName;
              } catch (clinicError) {
                console.warn('[NURSE CANCEL DEBUG] Failed to load clinic doc, using default clinic name', clinicError);
              }
            } else {
              console.warn('[NURSE CANCEL DEBUG] Appointment has no clinicId; using default clinic name');
            }

            await sendAppointmentCancelledNotification({
              firestore: db,
              patientId: patientId,
              appointmentId: id,
              doctorName: appointmentToUse.doctor || '',
              clinicName,
              date: appointmentToUse.date || '',
              time: appointmentToUse.time || '',
              arriveByTime: appointmentToUse.arriveByTime,
              cancelledBy: 'clinic',
              cancelledByBreak: appointmentToUse.cancelledByBreak,
            });
            console.log('[NURSE CANCEL DEBUG] Cancellation notification sent to patient');
          } catch (notifError) {
            console.error('[NURSE CANCEL DEBUG] Failed to send cancellation notification:', notifError);
            // Don't fail the status update if notification fails
          }
        }

        // Update local state for skipped appointments
        if (status === 'Skipped') {
          setAppointments(prev => {
            const updated = prev.map(a => a.id === id ? { ...a, status: 'Skipped' as const } : a);
            return [
              ...updated.filter(a => a.status !== 'Skipped'),
              ...updated.filter(a => a.status === 'Skipped'),
            ] as Appointment[];
          });
        }

        toast({
          title: "Status Updated",
          description: `Appointment marked as ${status}.`
        });
      } catch (error) {
        console.error("Error updating appointment status:", error);
        const permissionError = new FirestorePermissionError({
          path: doc(db, 'appointments', id).path,
          operation: 'update',
          requestResourceData: { status: status.charAt(0).toUpperCase() + status.slice(1) }
        });
        errorEmitter.emit('permission-error', permissionError);
      }
    });
  };

  const handleAddToQueue = async (appointment: Appointment) => {
    // Only process if status is still 'Pending'
    if (appointment.status !== 'Pending') {
      toast({
        variant: "destructive",
        title: "Cannot Add to Queue",
        description: "This appointment is no longer in Pending status."
      });
      return;
    }

    startTransition(async () => {
      try {
        const appointmentRef = doc(db, "appointments", appointment.id);
        const updateData: any = {
          status: 'Confirmed',
          updatedAt: serverTimestamp(),
          ...(clinicDetails?.tokenDistribution !== 'advanced' ? { confirmedAt: serverTimestamp() } : {})
        };
        await updateDoc(appointmentRef, updateData);

        setAppointments(prev => prev.map(a =>
          a.id === appointment.id ? { ...a, status: 'Confirmed' as const } : a
        ));

        toast({
          title: "Patient Added to Queue",
          description: `${appointment.patientName} has been confirmed and added to the queue.`
        });
      } catch (error) {
        console.error("Error adding to queue:", error);
        toast({
          variant: "destructive",
          title: "Error",
          description: "Failed to add patient to queue."
        });
      }
    });
  };

  const handleRejoinQueue = (appointment: Appointment) => {
    startTransition(async () => {
      if (!clinicId) return;

      const now = new Date();

      try {
        const appointmentRef = doc(db, 'appointments', appointment.id);
        let newTimeString: string;

        // Different logic for No-show vs Skipped
        if (appointment.status === 'No-show') {
          // No-show: always set to current time + 30 minutes
          newTimeString = format(addMinutes(now, 30), 'hh:mm a');
        } else {
          // Skipped: use existing penalty logic
          const appointmentDate = parse(appointment.date, 'd MMMM yyyy', new Date());
          const scheduledTime = parseTime(appointment.time, appointmentDate);

          // Handle noShowTime as Firestore Timestamp or string
          const noShowDate = (appointment.noShowTime as any)?.toDate
            ? (appointment.noShowTime as any).toDate()
            : parseTime(appointment.noShowTime!, appointmentDate);

          let newTimeDate: Date;
          if (isAfter(now, scheduledTime)) {
            // Current time past the original slot time -> penalty (noShowTime + 15 mins)
            newTimeDate = addMinutes(noShowDate, 15);
          } else {
            // Current time before original slot time -> use noShowTime (no penalty)
            newTimeDate = noShowDate;
          }

          newTimeString = format(newTimeDate, 'hh:mm a');
        }

        await updateDoc(appointmentRef, {
          status: 'Confirmed',
          time: newTimeString,
          updatedAt: serverTimestamp(),
          ...(clinicDetails?.tokenDistribution !== 'advanced' ? { confirmedAt: serverTimestamp() } : {})
        });

        // Update local state
        setAppointments(prev => {
          return prev.map(a => {
            if (a.id === appointment.id) {
              return {
                ...a,
                status: 'Confirmed' as const,
                time: newTimeString
              };
            }
            return a;
          });
        });

        toast({
          title: "Patient Re-joined Queue",
          description: `${appointment.patientName} has been added back to the queue at ${newTimeString}.`
        });
      } catch (error: any) {
        console.error("Error re-joining queue:", error);
        toast({
          variant: "destructive",
          title: "Error",
          description: "Could not re-join the patient to the queue."
        });
      }
    });
  };

  const [appointmentToPrioritize, setAppointmentToPrioritize] = useState<Appointment | null>(null);

  /* eslint-disable react-hooks/exhaustive-deps */
  const onTogglePriorityHandler = useCallback(async (appointment: Appointment) => {
    console.log('[DEBUG] onTogglePriorityHandler called for', appointment.id);
    if (appointment.isPriority) {
      // Remove priority immediately
      try {
        await updateDoc(doc(db, 'appointments', appointment.id), {
          isPriority: false,
          priorityAt: null
        });
        toast({ title: "Priority Removed", description: `${appointment.patientName} is no longer priority.` });
      } catch (error) {
        toast({ variant: "destructive", title: "Error", description: "Failed to remove priority." });
      }
    } else {
      // Check limit
      const currentPriorityCount = appointments.filter(a => a.isPriority && a.status === 'Confirmed').length;
      if (currentPriorityCount >= 3) {
        toast({
          variant: "destructive",
          title: "Priority Queue Full",
          description: "Maximum 3 priority patients allowed. Please remove one before adding another."
        });
        return;
      }
      // Open confirmation
      setAppointmentToPrioritize(appointment);
    }
  }, [appointments]); // Dependencies
  /* eslint-enable react-hooks/exhaustive-deps */

  const confirmPrioritize = async () => {
    if (!appointmentToPrioritize) return;
    try {
      await updateDoc(doc(db, 'appointments', appointmentToPrioritize.id), {
        isPriority: true,
        priorityAt: serverTimestamp()
      });
      toast({ title: "Priority Added", description: `${appointmentToPrioritize.patientName} marked as priority.` });
    } catch (e) {
      toast({ variant: "destructive", title: "Error", description: "Failed to set priority." });
    }
    setAppointmentToPrioritize(null);
  };

  const filteredAppointments = useMemo(() => {
    let filtered = appointments;
    if (searchTerm.trim()) {
      filtered = filtered.filter(appointment =>
        appointment.patientName.toLowerCase().includes(searchTerm.toLowerCase())
      );
    }

    // Filter out appointments cancelled or completed by break
    return filtered.filter(a => !((a.status === 'Completed' || a.status === 'Cancelled') && a.cancelledByBreak !== undefined));
  }, [appointments, searchTerm]);

  // Helper to check if an appointment's session has ended
  const isSessionEnded = useCallback((appointment: Appointment): boolean => {
    if (appointment.sessionIndex === undefined) {
      return false;
    }

    const doctor = doctors.find(d => d.name === appointment.doctor);
    if (!doctor?.availabilitySlots) {
      return false;
    }

    try {
      const appointmentDate = parse(appointment.date, 'd MMMM yyyy', new Date());

      // Quick check: if appointment is from a past date, session has definitely ended
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const apptDay = new Date(appointmentDate);
      apptDay.setHours(0, 0, 0, 0);

      if (apptDay < today) {
        return true; // Past date = session ended
      }

      const dayOfWeek = format(appointmentDate, 'EEEE');
      const availabilityForDay = doctor.availabilitySlots.find(slot => slot.day === dayOfWeek);

      if (!availabilityForDay?.timeSlots?.[appointment.sessionIndex]) {
        console.log(`[DEBUG_SESSION] No slot found for session ${appointment.sessionIndex}`);
        return false;
      }

      const sessionSlot = availabilityForDay.timeSlots[appointment.sessionIndex];
      const endTime = parseTime(sessionSlot.to, appointmentDate);

      // Check for session extension (this part was not in the original code, but included in the instruction snippet)
      // if (doctor.availabilityExtensions) {
      //   // ... (existing extension logic checks)
      // }

      const isEnded = currentTime > endTime; // Use currentTime as per original logic
      if (appointment.status === 'No-show') {
        console.log(`[DEBUG_SESSION] Appt ${appointment.tokenNumber} (Session ${appointment.sessionIndex}): EndTime=${format(endTime, 'HH:mm')}, Now=${format(currentTime, 'HH:mm')}, IsEnded=${isEnded}`);
      }
      return isEnded;
    } catch {
      return false;
    }
  }, [doctors, currentTime]);

  const pendingAppointments = useMemo(() => {
    const pending = filteredAppointments.filter(a => {
      // Include Pending, Confirmed, Skipped
      if (a.status === 'Pending' || a.status === 'Confirmed' || a.status === 'Skipped') return true;

      // Include No-show only if their session is still active/upcoming
      if (a.status === 'No-show') {
        return !isSessionEnded(a);
      }

      return false;
    });

    // Sort by unified logic
    return pending.sort(clinicDetails?.tokenDistribution !== 'advanced' ? compareAppointmentsClassic : compareAppointments);
  }, [filteredAppointments, clinicDetails, isSessionEnded]);

  const skippedAppointments = useMemo(() => {
    const skipped = filteredAppointments.filter(a => a.status === 'Skipped');

    // Sort by unified logic
    return skipped.sort(clinicDetails?.tokenDistribution !== 'advanced' ? compareAppointmentsClassic : compareAppointments);
  }, [filteredAppointments, clinicDetails]);

  const pastAppointments = useMemo(() => {
    return filteredAppointments.filter(a => {
      // Always include Completed and Cancelled
      if (a.status === 'Completed' || a.status === 'Cancelled') return true;

      // Include No-show only if their session has ended
      if (a.status === 'No-show') {
        return isSessionEnded(a);
      }

      return false;
    });
  }, [filteredAppointments, isSessionEnded]);


  return (
    <div className="flex flex-col h-full bg-muted/20">
      <ClinicHeader
        doctors={doctors}
        selectedDoctor={selectedDoctor}
        onDoctorChange={handleDoctorChange}
        showLogo={false}
        showSettings={false}
        pageTitle="All Appointments"
        showPhoneModeToggle={isAppointmentsPage}
        isPhoneMode={isPhoneMode}
        onPhoneModeToggle={() => setIsPhoneMode(!isPhoneMode)}
      />

      <main className="flex-1 flex flex-col min-h-0 bg-card rounded-t-3xl -mt-4 z-10">
        {isAppointmentsPage && (
          <div className="p-4 border-b">
            <div className="flex justify-between items-center mb-4 px-2">
              <h2 className="font-black text-sm text-slate-800 uppercase tracking-tight">Select Date</h2>

              <Popover>
                <PopoverTrigger asChild>
                  <button className="text-[10px] font-black text-blue-600 bg-blue-50 px-3 py-1.5 rounded-full uppercase tracking-wider hover:bg-blue-100 transition-colors flex items-center gap-1.5">
                    {currentMonth}
                    <div className="w-1 h-1 rounded-full bg-blue-400" />
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="end">
                  <Calendar
                    mode="single"
                    selected={selectedDate || undefined}
                    onSelect={(date) => setSelectedDate(prev => prev && date && isSameDay(prev, date) ? null : (date || null))}
                    initialFocus
                  />
                </PopoverContent>
              </Popover>
            </div>

            <Carousel
              setApi={setApi}
              opts={{ align: "center", dragFree: true }}
              className="w-full"
            >
              <CarouselContent className="-ml-2">
                {dates.map((d, index) => {
                  const isSelected = selectedDate ? isSameDay(d, selectedDate) : false;
                  const isToday = isSameDay(d, new Date());
                  return (
                    <CarouselItem key={index} className="basis-1/5 pl-2">
                      <div className="p-1">
                        <button
                          onClick={() => setSelectedDate(prev => prev && isSameDay(prev, d) ? null : d)}
                          className={cn(
                            "w-full h-auto flex flex-col items-center justify-center p-3 rounded-2xl gap-1 transition-all duration-300 border-2",
                            isSelected
                              ? "bg-blue-600 text-white border-blue-600 shadow-lg shadow-blue-200 scale-105"
                              : "bg-slate-50 border-slate-100 text-slate-600 hover:bg-slate-100 hover:border-slate-200",
                            isToday && !isSelected && "border-blue-400 border-dashed"
                          )}
                        >
                          <span className={cn("text-[10px] font-bold uppercase", isSelected ? "text-blue-100" : "text-slate-400")}>
                            {format(d, 'EEE')}
                          </span>
                          <span className="text-lg font-black tracking-tighter">
                            {format(d, 'dd')}
                          </span>
                          {isToday && (
                            <div className={cn("w-1 h-1 rounded-full translate-y-1", isSelected ? "bg-white" : "bg-blue-600")} />
                          )}
                        </button>
                      </div>
                    </CarouselItem>
                  )
                })}
              </CarouselContent>
            </Carousel>
          </div>
        )}
        <div className="p-4 border-b space-y-4">
          <div className="flex gap-2">
            <div className="relative flex-grow">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search patient..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-10 h-10 w-full"
              />
            </div>
          </div>

          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className="w-full grid grid-cols-2">
              <TabsTrigger value="pending">Upcoming ({pendingAppointments.length})</TabsTrigger>
              <TabsTrigger value="completed" data-state-active-green>History ({pastAppointments.length})</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        <div className="flex-1 overflow-y-auto">
          <Tabs value={activeTab} onValueChange={setActiveTab} className="h-full flex flex-col">
            <TabsContent value="pending" className="flex-1 overflow-y-auto m-0">
              <AppointmentList
                appointments={pendingAppointments}
                onUpdateStatus={handleUpdateStatus}
                onRejoinQueue={handleRejoinQueue}
                onAddToQueue={setAppointmentToAddToQueue}
                onTogglePriority={onTogglePriorityHandler}
                showTopRightActions={isAppointmentsPage}
                clinicStatus={isAppointmentsPage ? 'In' : (clinicStatus === 'in' ? 'In' : 'Out')}
                currentTime={currentTime}
                enableSwipeCompletion={!isAppointmentsPage}
                isPhoneMode={isPhoneMode}
                tokenDistribution={clinicDetails?.tokenDistribution}
              />
            </TabsContent>
            <TabsContent value="completed" className="flex-1 overflow-y-auto m-0">
              <AppointmentList
                appointments={pastAppointments}
                onUpdateStatus={handleUpdateStatus}
                onRejoinQueue={handleRejoinQueue}
                onAddToQueue={setAppointmentToAddToQueue}
                onTogglePriority={onTogglePriorityHandler}
                showTopRightActions={isAppointmentsPage}
                clinicStatus={isAppointmentsPage ? 'In' : (clinicStatus === 'in' ? 'In' : 'Out')}
                currentTime={currentTime}
                enableSwipeCompletion={!isAppointmentsPage}
                isPhoneMode={isPhoneMode}
                tokenDistribution={clinicDetails?.tokenDistribution}
              />
            </TabsContent>
          </Tabs>
        </div>
      </main>
      <AlertDialog open={!!appointmentToAddToQueue && appointmentToAddToQueue.status === 'Pending'} onOpenChange={(open) => !open && setAppointmentToAddToQueue(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Patient Arrived at Clinic?</AlertDialogTitle>
            <AlertDialogDescription>
              Confirm that "{appointmentToAddToQueue?.patientName}" has arrived at the clinic. This will change their status to "Confirmed" and add them to the queue.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setAppointmentToAddToQueue(null)}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-blue-500 hover:bg-blue-600"
              onClick={() => {
                if (appointmentToAddToQueue && appointmentToAddToQueue.status === 'Pending') {
                  handleAddToQueue(appointmentToAddToQueue);
                }
                setAppointmentToAddToQueue(null);
              }}
            >
              Yes, Confirm Arrival
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={!!appointmentToPrioritize} onOpenChange={(open) => !open && setAppointmentToPrioritize(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Mark as Priority?</AlertDialogTitle>
            <AlertDialogDescription>
              This will move {appointmentToPrioritize?.patientName} to the TOP of the queue, above all other patients.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-amber-500 hover:bg-amber-600 text-white" onClick={confirmPrioritize}>
              Yes, Mark as Priority
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
