
'use client';

import { useState, useMemo, useEffect, useCallback, useRef, useTransition } from 'react';
import type { Appointment, Doctor } from '@/lib/types';
import { useToast } from '@/hooks/use-toast';
import { format, isWithinInterval, addMinutes, parse, isAfter, isBefore } from 'date-fns';
import { collection, getDocs, query, onSnapshot, doc, updateDoc, where, writeBatch, getDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Search, WifiOff, Repeat, Coffee } from 'lucide-react';
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
import ClinicHeader from './header';
import AppointmentList from './appointment-list';
import { useRouter } from 'next/navigation';
import { errorEmitter } from '@kloqo/shared-core';
import { FirestorePermissionError } from '@kloqo/shared-core';
import { parseTime } from '@/lib/utils';
import { computeQueues, type QueueState, compareAppointments, compareAppointmentsClassic, calculateEstimatedTimes, getCurrentActiveSession } from '@kloqo/shared-core';
import { CheckCircle2, Clock } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

export default function LiveDashboard() {
  const router = useRouter();
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [selectedDoctor, setSelectedDoctor] = useState<string>('');
  const [isOnline, setIsOnline] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [activeTab, setActiveTab] = useState('arrived');
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [clinicId, setClinicId] = useState<string | null>(null);
  const [clinicDetails, setClinicDetails] = useState<any>(null);
  const { toast } = useToast();
  const [currentTime, setCurrentTime] = useState(new Date());
  const [isPending, startTransition] = useTransition();
  const [appointmentToAddToQueue, setAppointmentToAddToQueue] = useState<Appointment | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 60000); // Update every minute
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const id = localStorage.getItem('clinicId');
    if (!id) {
      router.push('/login');
      return;
    }
    setClinicId(id);

    const fetchInitialData = async () => {
      if (!id) return;
      try {
        // Fetch clinic details
        const clinicDoc = await getDoc(doc(db, 'clinics', id));
        if (clinicDoc.exists()) {
          setClinicDetails(clinicDoc.data());
        }

        const doctorsQuery = query(collection(db, 'doctors'), where('clinicId', '==', id));

        const unsubscribe = onSnapshot(doctorsQuery, (snapshot) => {
          const fetchedDoctors = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })) as Doctor[];
          setDoctors(fetchedDoctors);

          const storedDoctorId = localStorage.getItem('selectedDoctorId');
          if (fetchedDoctors.length > 0) {
            if (storedDoctorId && fetchedDoctors.some(d => d.id === storedDoctorId)) {
              setSelectedDoctor(storedDoctorId);
            } else {
              const firstDoctorId = fetchedDoctors[0].id;
              setSelectedDoctor(firstDoctorId);
              localStorage.setItem('selectedDoctorId', firstDoctorId);
            }
          }
        }, (error) => {
          console.error('Error fetching doctors in real-time:', error);
        });

        return () => unsubscribe();
      } catch (error: any) {
        if (error.name !== 'FirestorePermissionError') {
          console.error('Error setting up doctor listener:', error);
        }
      }
    };
    fetchInitialData();
  }, [toast, router]);

  const handleDoctorChange = (doctorId: string) => {
    setSelectedDoctor(doctorId);
    localStorage.setItem('selectedDoctorId', doctorId);
  }

  const currentDoctor = useMemo(() => doctors.find(d => d.id === selectedDoctor), [doctors, selectedDoctor]);

  const consultationStatus = currentDoctor?.consultationStatus || 'Out';

  useEffect(() => {
    if (!isOnline || !selectedDoctor || !clinicId) {
      setAppointments([]);
      return;
    }

    const doctor = doctors.find(d => d.id === selectedDoctor);
    if (!doctor) return;

    const today = format(new Date(), 'd MMMM yyyy');

    const q = query(
      collection(db, "appointments"),
      where("doctor", "==", doctor.name),
      where("date", "==", today),
      where("clinicId", "==", clinicId)
    );

    const unsubscribe = onSnapshot(q, async (querySnapshot) => {
      const fetchedAppointments: Appointment[] = [];
      querySnapshot.forEach((docSnap: any) => {
        const data = docSnap.data() as Appointment;
        if (data.cancelledByBreak) return;
        fetchedAppointments.push({
          ...data,
          id: docSnap.id,
        });
      });

      const sorted = fetchedAppointments.sort(clinicDetails?.tokenDistribution === 'advanced' ? compareAppointments : compareAppointmentsClassic);
      setAppointments(sorted);

    }, async (serverError) => {
      const permissionError = new FirestorePermissionError({
        path: 'appointments',
        operation: 'list'
      });
      errorEmitter.emit('permission-error', permissionError);
    });

    return () => unsubscribe();
  }, [selectedDate, toast, isOnline, selectedDoctor, doctors, clinicId]);


  const filteredAppointments = useMemo(() => {
    if (!searchTerm.trim()) {
      return appointments;
    }
    return appointments.filter((appointment) =>
      appointment.patientName?.toLowerCase().includes(searchTerm.toLowerCase())
    );
  }, [appointments, searchTerm]);

  const confirmedAppointments = useMemo(() => {
    const confirmed = filteredAppointments.filter(a => a.status === 'Confirmed');
    return confirmed.sort(clinicDetails?.tokenDistribution === 'advanced' ? compareAppointments : compareAppointmentsClassic);
  }, [filteredAppointments, clinicDetails]);

  const arrivedEstimates = useMemo(() => {
    if (!currentDoctor) return [];
    return calculateEstimatedTimes(
      confirmedAppointments,
      currentDoctor,
      currentTime,
      currentDoctor.averageConsultingTime || 15
    );
  }, [confirmedAppointments, currentDoctor, currentTime]);

  const handleStatusChange = useCallback(async (newStatus: 'In' | 'Out') => {
    if (!selectedDoctor) return;

    try {
      await updateDoc(doc(db, 'doctors', selectedDoctor), {
        consultationStatus: newStatus,
        updatedAt: serverTimestamp(),
      });

      // When doctor starts consultation, initialize the persistent buffer
      if (newStatus === 'In') {
        const top2 = confirmedAppointments.slice(0, 2);
        for (const apt of top2) {
          if (!apt.isInBuffer) {
            await updateDoc(doc(db, 'appointments', apt.id), {
              isInBuffer: true,
              updatedAt: serverTimestamp()
            });
          }
        }
      }

      toast({
        title: "Status Updated",
        description: `Doctor status manually set to ${newStatus}.`
      });
    } catch (error) {
      console.error("Error updating doctor status:", error);
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to update doctor status."
      });
    }
  }, [selectedDoctor, toast, confirmedAppointments]);

  // Centralized Buffer Refill Logic
  const checkAndRefillBuffer = useCallback(async (currentAppointments: Appointment[]) => {
    // Only proceed if doctor is 'In'
    if (consultationStatus !== 'In') return;

    // Filter for Confirmed appointments
    // Note: We trust the passed 'currentAppointments' to be up-to-date locally
    // We sort them by the shared comparison function (Time -> Skipped -> Token)
    // IMPORTANT: compareAppointments puts isInBuffer=true at top (sorted by bufferedAt), then others.
    const confirmedList = currentAppointments
      .filter(a => a.status === 'Confirmed')
      .sort(compareAppointments);

    const currentBuffered = confirmedList.filter(a => a.isInBuffer);
    console.log('[BUFFER-DEBUG] Refill Check. Buffered:', currentBuffered.length,
      currentBuffered.map(a => `${a.tokenNumber}`));

    if (currentBuffered.length < 2) {
      // Find best candidate: Confirmed, !isInBuffer
      // Since 'confirmedList' is already sorted by compareAppointments, 
      // the first one that is NOT in buffer is the highest priority candidate waiting in queue.
      const nextCandidate = confirmedList.find(a => !a.isInBuffer);

      if (nextCandidate) {
        console.log('[BUFFER-DEBUG] Valid candidate found for refill via Priority Sort:', {
          token: nextCandidate.tokenNumber,
          time: nextCandidate.time,
          id: nextCandidate.id
        });

        await updateDoc(doc(db, 'appointments', nextCandidate.id), {
          isInBuffer: true,
          bufferedAt: serverTimestamp(), // FIFO STABILITY: Stamp time of entry
          updatedAt: serverTimestamp()
        });
        console.log('[BUFFER-DEBUG] Promoted candidate to buffer.');

        return nextCandidate.id;
      } else {
        console.log('[BUFFER-DEBUG] No candidates available to refill.');
      }
    } else {
      console.log('[BUFFER-DEBUG] Buffer full. No refill needed.');
    }
    return null;
  }, [consultationStatus]);

  const handleUpdateStatus = useCallback((id: string, status: 'completed' | 'Cancelled' | 'No-show' | 'Skipped') => {
    startTransition(async () => {
      try {
        console.log('[BUFFER-DEBUG] handleUpdateStatus called for:', id, 'New Status:', status);
        const appointmentRef = doc(db, 'appointments', id);
        const appointment = appointments.find(a => a.id === id);

        let updateData: any = {
          status: status.charAt(0).toUpperCase() + status.slice(1),
          isInBuffer: false, // Always clear buffer flag when moving out
          bufferedAt: null   // Clear buffer timestamp
        };
        if (status === 'completed') {
          updateData.completedAt = serverTimestamp();
          // Increment consultation counter logic
          if (appointment && selectedDoctor && appointment.sessionIndex !== undefined) {
            try {
              const { incrementConsultationCounter } = await import('@kloqo/shared-core');
              await incrementConsultationCounter(
                appointment.clinicId,
                selectedDoctor,
                appointment.date,
                appointment.sessionIndex
              );
            } catch (e) { console.error("Counter Error", e); }
          }
        }
        if (status === 'Skipped') {
          updateData.skippedAt = serverTimestamp();
        }

        await updateDoc(appointmentRef, updateData);

        // Notifications
        if (status === 'completed' && appointment) {
          try {
            const { notifyNextPatientsWhenCompleted } = await import('@kloqo/shared-core');
            const clinicDoc = await getDoc(doc(db, 'clinics', appointment.clinicId));
            await notifyNextPatientsWhenCompleted({
              firestore: db,
              completedAppointmentId: appointment.id,
              completedAppointment: appointment,
              clinicName: clinicDoc?.data()?.name || '',
            });
          } catch (e) { console.error("Notify Error", e); }
        }
        if (status === 'Cancelled' && appointment?.patientId) {
          try {
            const { sendAppointmentCancelledNotification } = await import('@kloqo/shared-core');
            const clinicDoc = await getDoc(doc(db, 'clinics', appointment.clinicId));
            await sendAppointmentCancelledNotification({
              firestore: db,
              patientId: appointment.patientId,
              appointmentId: id,
              doctorName: appointment.doctor || '',
              clinicName: clinicDoc?.data()?.name || '',
              date: appointment.date || '',
              time: appointment.time || '',
              arriveByTime: appointment.arriveByTime,
              cancelledBy: 'clinic',
              cancelledByBreak: appointment.cancelledByBreak,
            });
          } catch (e) { console.error("Cancel Notify Error", e); }
        }

        // Local Optimistic Update
        let updatedAppointments = appointments.map(a =>
          a.id === id
            ? { ...a, status: status.charAt(0).toUpperCase() + status.slice(1) as any, isInBuffer: false, bufferedAt: null }
            : a
        ); // Note: skipped logic for reordering is handled by sort in render, but state update needs to happen

        setAppointments(updatedAppointments);
        toast({ title: "Status Updated", description: `Appointment marked as ${status}.` });

        // --- CHECK REFILL ---
        await checkAndRefillBuffer(updatedAppointments);

      } catch (error) {
        console.error("Error updating status:", error);
        // Error handling omitted for brevity but should be here
      }
    });
  }, [selectedDoctor, appointments, toast, consultationStatus, checkAndRefillBuffer]);

  const handleAddToQueue = (appointment: Appointment) => {
    setAppointmentToAddToQueue(appointment);
  };

  const confirmAddToQueue = () => {
    if (!appointmentToAddToQueue || !clinicId) return;
    if (appointmentToAddToQueue.status !== 'Pending') {
      toast({ variant: "destructive", title: "Cannot Add", description: "Not Pending." });
      setAppointmentToAddToQueue(null);
      return;
    }

    startTransition(async () => {
      try {
        // Just update status to Confirmed. Do NOT touch isInBuffer here.
        // Let the refill logic decide who gets buffered based on PRIORITY.
        const updateData: any = { status: 'Confirmed', updatedAt: serverTimestamp() };
        if (clinicDetails?.tokenDistribution !== 'advanced') {
          updateData.confirmedAt = serverTimestamp();
        }
        await updateDoc(doc(db, 'appointments', appointmentToAddToQueue.id), updateData);

        toast({
          title: "Result",
          description: `${appointmentToAddToQueue.patientName} added to queue.`
        });
        setAppointmentToAddToQueue(null);

        // Optimistic Update
        const updatedAppointments = appointments.map(a =>
          a.id === appointmentToAddToQueue.id ? { ...a, status: 'Confirmed' as const } : a
        );
        setAppointments(updatedAppointments);

        // --- CHECK REFILL ---
        // This will only buffer the new guy if he is actually the highest priority among non-buffered
        await checkAndRefillBuffer(updatedAppointments);

      } catch (error) {
        console.error("Error adding to queue:", error);
        toast({ variant: "destructive", title: "Error" });
      }
    });
  };

  const handleRejoinQueue = (appointment: Appointment) => {
    startTransition(async () => {
      if (!clinicId) return;
      try {
        const now = new Date();
        let newTimeStr: string;
        if (appointment.status === 'No-show') {
          newTimeStr = format(addMinutes(now, 30), 'hh:mm a');
        } else {
          const scheduledTime = parseTime(appointment.time, parse(appointment.date, 'd MMMM yyyy', now));
          const noShowTime = (appointment.noShowTime as any)?.toDate ? (appointment.noShowTime as any).toDate() : parseTime(appointment.noShowTime!, parse(appointment.date, 'd MMMM yyyy', now));
          newTimeStr = isAfter(now, scheduledTime) ? format(addMinutes(noShowTime, 15), 'hh:mm a') : format(noShowTime, 'hh:mm a');
        }

        const updateData: any = {
          status: 'Confirmed',
          time: newTimeStr,
          updatedAt: serverTimestamp(),
          ...(clinicDetails?.tokenDistribution !== 'advanced' ? { confirmedAt: serverTimestamp() } : {})
        };
        await updateDoc(doc(db, 'appointments', appointment.id), updateData);

        // Optimistic Update
        const updatedAppointments = appointments.map(a =>
          a.id === appointment.id ? { ...a, status: 'Confirmed' as const, time: newTimeStr } : a
        );
        setAppointments(updatedAppointments);
        toast({ title: "Patient Rejoined", description: `${appointment.patientName} rejoined.` });

        // --- CHECK REFILL ---
        await checkAndRefillBuffer(updatedAppointments);

      } catch (error) {
        console.error("Error re-joining:", error);
        toast({ variant: "destructive", title: "Error" });
      }
    });
  };


  // Compute queues for each doctor/session combination
  const [queuesByDoctor, setQueuesByDoctor] = useState<Record<string, QueueState>>({});

  useEffect(() => {
    const computeAllQueues = async () => {
      if (!clinicId || !doctors.length || !currentDoctor) return;

      const today = format(new Date(), 'd MMMM yyyy');
      const filteredForToday = filteredAppointments.filter(apt => apt.date === today);
      const doctorAppointments = filteredForToday.filter(apt => apt.doctor === currentDoctor.name);

      if (doctorAppointments.length === 0) {
        setQueuesByDoctor({});
        return;
      }

      // Get current/next session using shared utility
      const sessionInfo = getCurrentActiveSession(currentDoctor, new Date(), new Date());
      const sessionIndex = sessionInfo?.sessionIndex ?? 0;

      try {
        const queueState = await computeQueues(
          doctorAppointments,
          currentDoctor.name,
          currentDoctor.id,
          clinicId,
          today,
          sessionIndex,
          consultationStatus,
          clinicDetails?.tokenDistribution || 'classic'
        );

        setQueuesByDoctor({ [currentDoctor.name]: queueState });
      } catch (error) {
        console.error(`Error computing queues for ${currentDoctor.name}:`, error);
        setQueuesByDoctor({});
      }
    };

    computeAllQueues();
  }, [filteredAppointments, clinicId, doctors, currentDoctor]);

  // Get buffer queue for current doctor (first 2 from arrived queue)
  const getBufferQueue = (): Appointment[] => {
    if (!currentDoctor) return [];
    const queueState = queuesByDoctor[currentDoctor.name];
    if (!queueState) return [];
    return queueState.bufferQueue;
  };

  // Check if appointment is in buffer queue
  const isInBufferQueue = (appointment: Appointment): boolean => {
    const bufferQueue = getBufferQueue();
    return bufferQueue.some(apt => apt.id === appointment.id);
  };


  // Calculate next sessionIndex for current doctor
  const nextSessionIndex = useMemo(() => {
    if (!currentDoctor?.availabilitySlots) return undefined;

    const sessionInfo = getCurrentActiveSession(currentDoctor, currentTime, currentTime);
    return sessionInfo?.sessionIndex;
  }, [currentDoctor, currentTime]);

  const pendingAppointments = useMemo(() => {
    let pending = filteredAppointments.filter(a => a.status === 'Pending');

    // Filter to only show appointments from the next sessionIndex for current doctor
    if (nextSessionIndex !== undefined && currentDoctor) {
      pending = pending.filter(apt => {
        // If appointment doesn't have sessionIndex, include it (for backward compatibility)
        if (apt.sessionIndex === undefined) return true;

        // Only include if appointment's sessionIndex matches the next sessionIndex
        // and appointment is for the current doctor
        return apt.sessionIndex === nextSessionIndex && apt.doctor === currentDoctor.name;
      });
    }

    return pending.sort(clinicDetails?.tokenDistribution === 'classic' ? compareAppointmentsClassic : compareAppointments);
  }, [filteredAppointments, nextSessionIndex, currentDoctor, clinicDetails]);

  const skippedAppointments = useMemo(() => {
    const skipped = filteredAppointments.filter(a => a.status === 'Skipped' || a.status === 'No-show');
    return skipped.sort(compareAppointments);
  }, [filteredAppointments]);


  const todayBreaks = useMemo(() => {
    if (!currentDoctor?.breakPeriods) return [];
    const todayKey = format(new Date(), 'd MMMM yyyy');
    const periods = currentDoctor.breakPeriods[todayKey] || [];
    return periods.map((b: any, index: number) => ({
      id: `break-${index}`,
      startTime: b.startTime,
      endTime: b.endTime,
      note: b.reason // Assuming reason or note property exists
    }));
  }, [currentDoctor]);

  return (
    <div className="flex flex-col h-full bg-muted/20">
      <ClinicHeader
        doctors={doctors}
        selectedDoctor={selectedDoctor}
        onDoctorChange={handleDoctorChange}
        showLogo={false}
        showSettings={false}
        pageTitle="Live Queue"
        consultationStatus={consultationStatus}
        onStatusChange={handleStatusChange}
        currentTime={currentTime}
        isBreakMode={true}
        className="text-white"
        style={{ backgroundColor: '#61896D' }}
      />
      {isOnline ? (
        <main className="flex-1 flex flex-col min-h-0 bg-slate-50 rounded-t-3xl -mt-4 z-10 relative overflow-hidden">
          <div className="p-4 border-b space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search patient..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-10 h-10 w-full focus-visible:ring-red-500"
                />
              </div>
              <Button
                variant="outline"
                size="icon"
                onClick={() => router.push(`/schedule-break?doctor=${selectedDoctor}`)}
                className="h-10 w-10 shrink-0 border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100 hover:text-amber-800"
                title="Schedule Break"
              >
                <Coffee className="h-5 w-5" />
              </Button>
            </div>

            <Tabs value={activeTab} onValueChange={setActiveTab}>
              <TabsList className="w-full grid grid-cols-2">
                <TabsTrigger value="arrived">Arrived ({confirmedAppointments.length})</TabsTrigger>
                <TabsTrigger value="pending" data-state-active-yellow>Pending ({pendingAppointments.length + skippedAppointments.length})</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
          <div className="flex-1 overflow-y-auto">
            <Tabs value={activeTab} onValueChange={setActiveTab} className="h-full flex flex-col">
              <TabsContent value="arrived" className="flex-1 overflow-y-auto m-0 p-4 space-y-6">
                <div>

                  <AppointmentList
                    appointments={confirmedAppointments}
                    onUpdateStatus={handleUpdateStatus}
                    onRejoinQueue={handleRejoinQueue}
                    onAddToQueue={handleAddToQueue}
                    showTopRightActions={false}
                    clinicStatus={consultationStatus}
                    currentTime={currentTime}
                    isInBufferQueue={isInBufferQueue}
                    showStatusBadge={false}
                    showPositionNumber={true}
                    showEstimatedTime={clinicDetails?.tokenDistribution !== 'advanced'}
                    averageConsultingTime={currentDoctor?.averageConsultingTime}
                    estimatedTimes={arrivedEstimates}
                    breaks={todayBreaks}
                  />
                </div>
              </TabsContent>

              <TabsContent value="pending" className="flex-1 overflow-y-auto m-0 p-4 space-y-6">
                <AppointmentList
                  appointments={[...pendingAppointments, ...skippedAppointments]}
                  onUpdateStatus={handleUpdateStatus}
                  onRejoinQueue={handleRejoinQueue}
                  onAddToQueue={handleAddToQueue}
                  showTopRightActions={false}
                  clinicStatus={consultationStatus}
                  currentTime={currentTime}
                  showStatusBadge={false}
                  enableSwipeCompletion={false}
                />
              </TabsContent>
            </Tabs>
          </div>
        </main>
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center text-center p-8 text-muted-foreground bg-muted/20">
          <WifiOff className="h-16 w-16 mb-4" />
          <h2 className="text-xl font-semibold text-foreground">You are Offline</h2>
          <p>Please switch the toggle to 'Online' to view today's appointments.</p>
        </div>
      )}
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
              onClick={confirmAddToQueue}
            >
              Yes, Confirm Arrival
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// Local helpers removed in favor of shared-core utilities
