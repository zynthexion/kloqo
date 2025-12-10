
'use client';

import { useState, useMemo, useEffect, useCallback } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { format, isPast } from 'date-fns';
import type { Appointment, Doctor } from '@/lib/types';
import { useToast } from '@/hooks/use-toast';
import { collection, getDocs, query, onSnapshot, doc, updateDoc, where, serverTimestamp, getDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { ArrowLeft, Loader2, User, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import NowServingItem from './now-serving-item';
import { errorEmitter } from '@kloqo/shared-core';
import { FirestorePermissionError } from '@kloqo/shared-core';
import { notifyNextPatientsWhenCompleted } from '@kloqo/shared-core';

export default function NowServing() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();

  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [selectedDoctorId, setSelectedDoctorId] = useState<string | null>(searchParams.get('doctor'));
  const [loading, setLoading] = useState(true);
  const [clinicId, setClinicId] = useState<string | null>(null);

  useEffect(() => {
    // This is a public page, so we don't strictly need a clinicId,
    // but if we had one (e.g. from a deeplink), we could use it.
    const id = localStorage.getItem('clinicId');
    setClinicId(id);

    const fetchDoctors = async () => {
      try {
        // If we have a clinicId, we can filter doctors. Otherwise, fetch all.
        const doctorsQuery = id ? query(collection(db, 'doctors'), where('clinicId', '==', id)) : collection(db, 'doctors');

        const doctorsSnapshot = await getDocs(doctorsQuery).catch(async (serverError) => {
          const permissionError = new FirestorePermissionError({
            path: 'doctors',
            operation: 'list',
          });
          errorEmitter.emit('permission-error', permissionError);
          throw serverError;
        });
        const fetchedDoctors = doctorsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })) as Doctor[];
        setDoctors(fetchedDoctors);
        if (!selectedDoctorId && fetchedDoctors.length > 0) {
          setSelectedDoctorId(fetchedDoctors[0].id);
        }
      } catch (error: any) {
        if (error.name !== 'FirestorePermissionError') {
          console.error('Error fetching doctors:', error);
          toast({ variant: 'destructive', title: 'Error', description: 'Could not fetch doctors list.' });
        }
      }
    };
    fetchDoctors();
  }, [toast, selectedDoctorId]);

  useEffect(() => {
    if (!selectedDoctorId) {
      setLoading(false);
      return;
    }
    setLoading(true);

    const doctor = doctors.find(d => d.id === selectedDoctorId);
    if (!doctor || !doctor.clinicId) return;

    const dateStr = format(new Date(), 'd MMMM yyyy');
    const q = query(
      collection(db, "appointments"),
      where("date", "==", dateStr),
      where("doctor", "==", doctor.name),
      where("clinicId", "==", doctor.clinicId)
    );

    const unsubscribe = onSnapshot(q, async (querySnapshot) => {
      const fetchedAppointments: Appointment[] = [];
      querySnapshot.forEach((docSnap: any) => {
        const data = docSnap.data() as Appointment;
        fetchedAppointments.push({
          ...(data as Appointment),
          id: docSnap.id,
        });
      });

      setAppointments(fetchedAppointments.sort((a, b) => (a.numericToken || 0) - (b.numericToken || 0)));
      setLoading(false);
    }, async (serverError) => {
      const permissionError = new FirestorePermissionError({
        path: 'appointments',
        operation: 'list',
      });
      errorEmitter.emit('permission-error', permissionError);
      setLoading(false);
    });

    return () => unsubscribe();
  }, [selectedDoctorId, toast, doctors]);

  const handleUpdateStatus = (id: string, status: 'completed' | 'Cancelled' | 'No-show') => {
    const appointmentRef = doc(db, 'appointments', id);
    const appointment = appointments.find(a => a.id === id);
    const updateData: any = { status: status.charAt(0).toUpperCase() + status.slice(1) };
    if (status === 'completed') {
      updateData.completedAt = serverTimestamp();
    }

    updateDoc(appointmentRef, updateData).then(async () => {

      // Send notifications to next patients when appointment is completed
      if (status === 'completed' && appointment) {
        try {
          if (!clinicId) {
            throw new Error('Clinic ID not available');
          }
          const clinicDocRef = doc(db, 'clinics', clinicId);
          const clinicDoc = await getDoc(clinicDocRef).catch(() => null);
          const clinicName = clinicDoc?.data()?.name || 'The clinic';

          // Notify next patients in queue
          await notifyNextPatientsWhenCompleted({
            firestore: db,
            completedAppointmentId: appointment.id,
            completedAppointment: appointment,
            clinicName,
          });
          console.log('Notifications sent to next patients in queue');
        } catch (notifError) {
          console.error('Failed to send notifications to next patients:', notifError);
          // Don't fail the status update if notification fails
        }
      }

      // Send cancellation notification when appointment is cancelled
      if (status === 'Cancelled' && appointment) {
        try {
          if (!clinicId) {
            throw new Error('Clinic ID not available');
          }
          const { sendAppointmentCancelledNotification } = await import('@kloqo/shared-core');
          const clinicDocRef = doc(db, 'clinics', clinicId);
          const clinicDoc = await getDoc(clinicDocRef).catch(() => null);
          const clinicName = clinicDoc?.data()?.name || 'The clinic';

          await sendAppointmentCancelledNotification({
            firestore: db,
            patientId: appointment.patientId,
            appointmentId: appointment.id,
            doctorName: appointment.doctor,
            clinicName,
            date: appointment.date,
            time: appointment.time,
            arriveByTime: appointment.arriveByTime,
            cancelledBy: 'clinic',
          });
          console.log('Cancellation notification sent to patient');
        } catch (notifError) {
          console.error('Failed to send cancellation notification:', notifError);
          // Don't fail the status update if notification fails
        }
      }

      toast({
        title: 'Status Updated',
        description: `Appointment marked as ${status}.`,
      });
    }).catch(async (serverError) => {
      const permissionError = new FirestorePermissionError({
        path: appointmentRef.path,
        operation: 'update',
        requestResourceData: updateData,
      });
      errorEmitter.emit('permission-error', permissionError);
    });
  };

  const handleDoctorChange = (doctorId: string) => {
    setSelectedDoctorId(doctorId);
    router.replace(`/now-serving?doctor=${doctorId}`);
  };

  const currentDoctor = doctors.find(d => d.id === selectedDoctorId);

  const pendingAppointments = useMemo(() => appointments.filter(a => a.status === 'Pending' || a.status === 'Confirmed'), [appointments]);
  const pastAppointments = useMemo(() => appointments.filter(a => ['Completed', 'Cancelled', 'No-show'].includes(a.status)), [appointments]);
  const combinedList = [...pendingAppointments, ...pastAppointments];

  return (
    <div className="flex flex-col h-full bg-card">
      <header className="flex items-center gap-4 p-4 border-b">
        <Link href="/">
          <Button variant="ghost" size="icon">
            <ArrowLeft />
          </Button>
        </Link>
        <div className="flex-1">
          <h1 className="text-xl font-bold">Now Serving</h1>
          {currentDoctor && <p className="text-sm text-muted-foreground">Dr. {currentDoctor.name}</p>}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon">
              <User className="h-6 w-6" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {doctors.map(doctor => (
              <DropdownMenuItem key={doctor.id} onSelect={() => handleDoctorChange(doctor.id)}>
                Dr. {doctor.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin" />
          </div>
        ) : combinedList.length > 0 ? (
          <div className="divide-y">
            {combinedList.map(appt => (
              <NowServingItem key={appt.id} appointment={appt} onUpdateStatus={handleUpdateStatus} />
            ))}
          </div>
        ) : (
          <div className="h-full flex items-center justify-center text-center text-muted-foreground p-8">
            <p>No appointments found for Dr. {currentDoctor?.name} today.</p>
          </div>
        )}
      </div>
    </div>
  );
}
