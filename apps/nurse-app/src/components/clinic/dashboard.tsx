
'use client';

import { useState, useMemo, useEffect, useCallback, useTransition } from 'react';
import type { Appointment, Doctor } from '@/lib/types';
import { useToast } from '@/hooks/use-toast';
import { format, isPast, addMinutes, parse } from 'date-fns';
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
import { errorEmitter, compareAppointments, FirestorePermissionError } from '@kloqo/shared-core';


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
  const { toast } = useToast();

  const isAppointmentsPage = pathname === '/appointments';

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
      if (data.status === 'Cancelled' && data.cancelledByBreak) {
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
      } as Appointment);
    });


    fetchedAppointments.sort(compareAppointments);

    setAppointments(fetchedAppointments);
  }, []);

  useEffect(() => {
    if (!selectedDoctor || !clinicId) return;

    const doctor = doctors.find(d => d.id === selectedDoctor);
    if (!doctor) return;

    let q: Query;

    const today = format(new Date(), 'd MMMM yyyy');

    if (isAppointmentsPage) {
      q = query(
        collection(db, "appointments"),
        where('doctor', '==', doctor.name),
        where('clinicId', '==', clinicId)
      );
    } else {
      q = query(
        collection(db, "appointments"),
        where('doctor', '==', doctor.name),
        where('clinicId', '==', clinicId),
        where('date', '==', today)
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
  }, [processAppointments, toast, selectedDoctor, doctors, isAppointmentsPage, clinicId]);

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
        await updateDoc(appointmentRef, {
          status: 'Confirmed'
        });

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
      if (!clinicId || !appointment.time || !appointment.noShowTime) return;

      const now = new Date();

      try {
        const appointmentDate = parse(appointment.date, 'd MMMM yyyy', new Date());
        const scheduledTime = parseTime(appointment.time, appointmentDate);

        // Handle noShowTime as Firestore Timestamp or Date
        let noShowDate: Date;
        if ((appointment.noShowTime as any)?.toDate) {
          noShowDate = (appointment.noShowTime as any).toDate();
        } else {
          noShowDate = new Date(appointment.noShowTime as any);
        }

        let newTimeDate: Date;
        if (isPast(scheduledTime)) {
          // Current time past the 'time' -> noShowTime + 15 minutes
          newTimeDate = addMinutes(noShowDate, 15);
        } else {
          // Current time didn't pass 'time' -> noShowTime
          newTimeDate = noShowDate;
        }

        const newTimeString = format(newTimeDate, 'hh:mm a');

        const appointmentRef = doc(db, 'appointments', appointment.id);
        await updateDoc(appointmentRef, {
          status: 'Confirmed',
          time: newTimeString,
          updatedAt: serverTimestamp()
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

  const filteredAppointments = useMemo(() => {
    if (!searchTerm.trim()) {
      return appointments;
    }
    return appointments.filter(appointment =>
      appointment.patientName.toLowerCase().includes(searchTerm.toLowerCase())
    );
  }, [appointments, searchTerm]);

  const pendingAppointments = useMemo(() => {
    const pending = filteredAppointments.filter(a => (a.status === 'Pending' || a.status === 'Confirmed'));

    // Sort by unified logic
    return pending.sort(compareAppointments);
  }, [filteredAppointments]);

  const skippedAppointments = useMemo(() => {
    const skipped = filteredAppointments.filter(a => a.status === 'Skipped');

    // Sort by unified logic
    return skipped.sort(compareAppointments);
  }, [filteredAppointments]);

  const pastAppointments = useMemo(() => filteredAppointments.filter(a => a.status === 'Completed' || a.status === 'Cancelled' || a.status === 'No-show'), [filteredAppointments]);


  return (
    <div className="flex flex-col h-full bg-muted/20">
      <ClinicHeader
        doctors={doctors}
        selectedDoctor={selectedDoctor}
        onDoctorChange={handleDoctorChange}
        showLogo={false}
        showSettings={false}
        pageTitle="All Appointments"
      />

      <main className="flex-1 flex flex-col min-h-0 bg-card rounded-t-3xl -mt-4 z-10">
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
              <TabsTrigger value="pending">Pending ({pendingAppointments.length})</TabsTrigger>
              <TabsTrigger value="completed" data-state-active-green>Completed ({pastAppointments.length})</TabsTrigger>
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
                showTopRightActions={isAppointmentsPage}
                clinicStatus={isAppointmentsPage ? 'In' : (clinicStatus === 'in' ? 'In' : 'Out')}
                currentTime={currentTime}
                enableSwipeCompletion={!isAppointmentsPage}
              />
            </TabsContent>
            <TabsContent value="completed" className="flex-1 overflow-y-auto m-0">
              <AppointmentList
                appointments={pastAppointments}
                onUpdateStatus={handleUpdateStatus}
                onRejoinQueue={handleRejoinQueue}
                onAddToQueue={setAppointmentToAddToQueue}
                showTopRightActions={isAppointmentsPage}
                clinicStatus={isAppointmentsPage ? 'In' : (clinicStatus === 'in' ? 'In' : 'Out')}
                currentTime={currentTime}
                enableSwipeCompletion={!isAppointmentsPage}
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
    </div>
  );
}
