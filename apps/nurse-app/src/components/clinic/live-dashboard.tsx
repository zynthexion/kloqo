
'use client';

import { useState, useMemo, useEffect, useCallback, useRef, useTransition } from 'react';
import type { Appointment, Doctor } from '@/lib/types';
import { useToast } from '@/hooks/use-toast';
import { format, isWithinInterval, addMinutes, parse, isAfter, isBefore } from 'date-fns';
import { collection, getDocs, query, onSnapshot, doc, updateDoc, where, writeBatch, getDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Search, WifiOff, Repeat } from 'lucide-react';
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
import { computeQueues, type QueueState, compareAppointments } from '@kloqo/shared-core';
import { CheckCircle2, Clock } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

export default function LiveDashboard() {
  const router = useRouter();
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [selectedDoctor, setSelectedDoctor] = useState<string>('');
  const [isOnline, setIsOnline] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [activeTab, setActiveTab] = useState('pending');
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
        fetchedAppointments.push({
          id: docSnap.id,
          ...docSnap.data(),
        } as Appointment);
      });

      const sorted = fetchedAppointments.sort(compareAppointments);
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

  const previousConsultationStatusRef = useRef<'In' | 'Out'>();

  useEffect(() => {
    if (previousConsultationStatusRef.current === 'Out' && consultationStatus === 'In') {
      // Doctor just came back online or a new session started.
      const batch = writeBatch(db);
      const skippedToNoShow = appointments.filter(apt => apt.status === 'Skipped');

      if (skippedToNoShow.length > 0) {
        skippedToNoShow.forEach(apt => {
          const appointmentRef = doc(db, 'appointments', apt.id);
          batch.update(appointmentRef, { status: 'No-show' });
        });

        batch.commit().then(() => {
          toast({
            title: "Queue Cleaned",
            description: `${skippedToNoShow.length} skipped appointment(s) from the previous session marked as 'No-show'.`
          });
        }).catch(e => console.error("Failed to update skipped to no-show", e));
      }
    }
    previousConsultationStatusRef.current = consultationStatus;
  }, [consultationStatus, appointments, toast]);

  const handleStatusChange = useCallback(async (newStatus: 'In' | 'Out') => {
    if (!selectedDoctor) return;

    try {
      await updateDoc(doc(db, 'doctors', selectedDoctor), {
        consultationStatus: newStatus,
        updatedAt: serverTimestamp(),
      });
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
  }, [selectedDoctor, toast]);

  const handleUpdateStatus = useCallback((id: string, status: 'completed' | 'Cancelled' | 'No-show' | 'Skipped') => {
    startTransition(async () => {
      try {
        const appointmentRef = doc(db, 'appointments', id);
        const appointment = appointments.find(a => a.id === id);
        const now = new Date();

        let updateData: any = { status: status.charAt(0).toUpperCase() + status.slice(1) };
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
            const appointmentDoc = await getDoc(appointmentRef);
            const fullAppointmentData = appointmentDoc.exists() ? appointmentDoc.data() : null;
            const appointmentToUse = fullAppointmentData || appointment;


            if (appointmentToUse && appointmentToUse.patientId) {
              const { sendAppointmentCancelledNotification } = await import('@kloqo/shared-core');

              // Get clinic name
              let clinicName = 'The clinic';
              if (appointmentToUse.clinicId) {
                const clinicDocRef = doc(db, 'clinics', appointmentToUse.clinicId);
                const clinicDoc = await getDoc(clinicDocRef).catch(() => null);
                clinicName = clinicDoc?.data()?.name || clinicName;
              }

              await sendAppointmentCancelledNotification({
                firestore: db,
                patientId: appointmentToUse.patientId,
                appointmentId: id,
                doctorName: appointmentToUse.doctor || '',
                clinicName,
                date: appointmentToUse.date || '',
                time: appointmentToUse.time || '',
                arriveByTime: appointmentToUse.arriveByTime,
                cancelledBy: 'clinic',
                cancelledByBreak: appointmentToUse.cancelledByBreak,
              });
            }
          } catch (notifError) {
            console.error('Failed to send cancellation notification:', notifError);
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
  }, [selectedDoctor, appointments, toast]);

  const handleAddToQueue = (appointment: Appointment) => {
    setAppointmentToAddToQueue(appointment);
  };

  const confirmAddToQueue = () => {
    if (!appointmentToAddToQueue || !clinicId) return;

    // Only process if status is still 'Pending'
    if (appointmentToAddToQueue.status !== 'Pending') {
      toast({
        variant: "destructive",
        title: "Cannot Add to Queue",
        description: "This appointment is no longer in Pending status."
      });
      setAppointmentToAddToQueue(null);
      return;
    }

    startTransition(async () => {
      try {
        await updateDoc(doc(db, 'appointments', appointmentToAddToQueue.id), {
          status: 'Confirmed',
        });

        toast({
          title: "Patient Added to Queue",
          description: `${appointmentToAddToQueue.patientName} has been confirmed and added to the queue.`
        });
        setAppointmentToAddToQueue(null);
      } catch (error: any) {
        console.error("Error adding to queue:", error);
        toast({
          variant: "destructive",
          title: "Error",
          description: "Could not add patient to queue."
        });
        setAppointmentToAddToQueue(null);
      }
    });
  };

  const handleRejoinQueue = (appointment: Appointment) => {
    startTransition(async () => {
      if (!clinicId) return;

      try {
        const now = new Date();
        const scheduledTimeStr = appointment.time;
        const appointmentDate = parse(appointment.date, 'd MMMM yyyy', new Date());
        const scheduledTime = parseTime(scheduledTimeStr, appointmentDate);

        let newTimeStr: string;

        const noShowTime = (appointment.noShowTime as any)?.toDate
          ? (appointment.noShowTime as any).toDate()
          : parseTime(appointment.noShowTime!, appointmentDate);

        if (isAfter(now, scheduledTime)) {
          // If rejoined after scheduled time, give noShowTime + 15 mins
          newTimeStr = format(addMinutes(noShowTime, 15), 'hh:mm a');
        } else {
          // If rejoined before scheduled time, give noShowTime
          newTimeStr = format(noShowTime, 'hh:mm a');
        }

        const appointmentRef = doc(db, 'appointments', appointment.id);
        await updateDoc(appointmentRef, {
          status: 'Confirmed',
          time: newTimeStr,
          updatedAt: serverTimestamp()
        });

        // Update local state
        setAppointments(prev => prev.map(a =>
          a.id === appointment.id ? { ...a, status: 'Confirmed' as const, time: newTimeStr } : a
        ));

        toast({
          title: "Patient Re-joined Queue",
          description: `${appointment.patientName} has been added back to the queue.`
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

  const filteredAppointments = useMemo(() => {
    if (!searchTerm.trim()) {
      return appointments;
    }
    return appointments.filter((appointment) =>
      appointment.patientName?.toLowerCase().includes(searchTerm.toLowerCase())
    );
  }, [appointments, searchTerm]);

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

      // For queue computation, we'll use sessionIndex 0 for now (or compute per session)
      const sessionIndex = 0; // Default to first session

      try {
        const queueState = await computeQueues(
          doctorAppointments,
          currentDoctor.name,
          currentDoctor.id,
          clinicId,
          today,
          sessionIndex
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

  const confirmedAppointments = useMemo(() => {
    const confirmed = filteredAppointments.filter(a => a.status === 'Confirmed');
    return confirmed.sort(compareAppointments);
  }, [filteredAppointments]);

  // Calculate next sessionIndex for current doctor
  const nextSessionIndex = useMemo(() => {
    if (!currentDoctor?.availabilitySlots) return undefined;

    const now = currentTime;
    const todayDay = format(now, 'EEEE');
    const todayAvailability = currentDoctor.availabilitySlots.find(slot => slot.day === todayDay);

    if (!todayAvailability?.timeSlots) return undefined;

    // Find the next session (first session that hasn't ended yet)
    for (let i = 0; i < todayAvailability.timeSlots.length; i++) {
      const session = todayAvailability.timeSlots[i];
      try {
        const sessionStart = parseTime(session.from, now);
        const sessionEnd = parseTime(session.to, now);

        // If current time is before session end, this is the next session
        if (isBefore(now, sessionEnd) || now.getTime() === sessionEnd.getTime()) {
          return i;
        }
      } catch {
        // Skip if parsing fails
        continue;
      }
    }

    return undefined;
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

    return pending.sort(compareAppointments);
  }, [filteredAppointments, nextSessionIndex, currentDoctor]);

  const skippedAppointments = useMemo(() => {
    const skipped = filteredAppointments.filter(a => a.status === 'Skipped');
    return skipped.sort(compareAppointments);
  }, [filteredAppointments]);


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
      />
      {isOnline ? (
        <main className="flex-1 flex flex-col min-h-0 bg-card rounded-t-3xl -mt-4 z-10">
          <div className="p-4 border-b space-y-4">
            <div className="relative w-full">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search patient..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-10 h-10 w-full focus-visible:ring-red-500"
              />
            </div>

            <Tabs value={activeTab} onValueChange={setActiveTab}>
              <TabsList className="w-full grid grid-cols-2">
                <TabsTrigger value="pending">Pending ({pendingAppointments.length})</TabsTrigger>
                <TabsTrigger value="skipped" data-state-active-yellow>Skipped ({skippedAppointments.length})</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
          <div className="flex-1 overflow-y-auto">
            <Tabs value={activeTab} onValueChange={setActiveTab} className="h-full flex flex-col">
              <TabsContent value="pending" className="flex-1 overflow-y-auto m-0 p-4 space-y-6">
                {/* Arrived Section (Confirmed) */}
                <div>
                  <div className="mb-3 flex items-center gap-2 px-2">
                    <CheckCircle2 className="h-4 w-4 text-green-600" />
                    <h3 className="font-semibold text-sm">Arrived ({confirmedAppointments.length})</h3>
                  </div>
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
                  />
                </div>

                {/* Pending Section */}
                <div>
                  <div className="mb-3 flex items-center gap-2 px-2">
                    <Clock className="h-4 w-4 text-orange-600" />
                    <h3 className="font-semibold text-sm">Pending ({pendingAppointments.length})</h3>
                  </div>
                  <AppointmentList
                    appointments={pendingAppointments}
                    onUpdateStatus={handleUpdateStatus}
                    onRejoinQueue={handleRejoinQueue}
                    onAddToQueue={handleAddToQueue}
                    showTopRightActions={false}
                    clinicStatus={consultationStatus}
                    currentTime={currentTime}
                    showStatusBadge={false}
                  />
                </div>
              </TabsContent>
              <TabsContent value="skipped" className="flex-1 overflow-y-auto m-0">
                <AppointmentList
                  appointments={skippedAppointments}
                  onUpdateStatus={handleUpdateStatus}
                  onRejoinQueue={handleRejoinQueue}
                  onAddToQueue={handleAddToQueue}
                  showTopRightActions={false}
                  clinicStatus={consultationStatus}
                  showStatusBadge={false}
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
