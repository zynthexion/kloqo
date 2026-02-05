
'use client';

import { useState, useEffect } from 'react';
import { Phone, UserPlus, Coffee, ChevronRight, User, Loader2, ChevronDown, Radio, Settings, CalendarX, BarChart3 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { format, isWithinInterval, addMinutes, subMinutes, isPast, parseISO, isSameDay, differenceInMinutes } from 'date-fns';
import Image from 'next/image';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import type { Appointment, Doctor } from '@/lib/types';
import { useToast } from '@/hooks/use-toast';
import { collection, addDoc, query, where, orderBy, limit, doc, updateDoc, onSnapshot, getDoc, getDocs, writeBatch, serverTimestamp } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
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
import { cn } from '@/lib/utils';
import { parseTime } from '@/lib/utils';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import ClinicHeader from './header';
import { errorEmitter } from '@kloqo/shared-core';
import { FirestorePermissionError } from '@kloqo/shared-core';
import { notifySessionPatientsOfConsultationStart, compareAppointments, logPunctualityEvent } from '@kloqo/shared-core';


export default function HomePage() {
  const router = useRouter();
  const [allDoctors, setAllDoctors] = useState<Doctor[]>([]);
  const [selectedDoctor, setSelectedDoctor] = useState<string>('');
  const [isProcessingBreak, setIsProcessingBreak] = useState(false);
  const [currentTime, setCurrentTime] = useState(new Date());
  const { toast } = useToast();
  const [clinicId, setClinicId] = useState<string | null>(null);
  const [isWalkInAvailable, setIsWalkInAvailable] = useState(false);
  const [isNearClosing, setIsNearClosing] = useState(false);
  const [hasActiveAppointmentsToday, setHasActiveAppointmentsToday] = useState(false);
  const [pendingStatusChange, setPendingStatusChange] = useState<'In' | 'Out' | null>(null);


  useEffect(() => {
    const id = localStorage.getItem('clinicId');
    if (!id) {
      router.push('/login');
      return;
    }
    setClinicId(id);

    const timer = setInterval(() => setCurrentTime(new Date()), 60000); // Update every minute
    return () => clearInterval(timer);
  }, [toast, router]);

  useEffect(() => {
    if (!clinicId) return;
    try {
      const doctorsQuery = query(collection(db, 'doctors'), where('clinicId', '==', clinicId));

      const unsubscribe = onSnapshot(doctorsQuery, (snapshot) => {
        const fetchedDoctors = snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        })) as Doctor[];
        setAllDoctors(fetchedDoctors);

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
        toast({
          variant: 'destructive',
          title: 'Error',
          description: 'Could not fetch doctors list.',
        });
      });

      return () => unsubscribe();
    } catch (error: any) {
      if (error.name !== 'FirestorePermissionError') {
        console.error('Error setting up doctor listener:', error);
      }
    }
  }, [clinicId, toast]);

  useEffect(() => {
    if (!clinicId || !selectedDoctor) return;

    const currentDoctorName = allDoctors.find(d => d.id === selectedDoctor)?.name;
    if (!currentDoctorName) return;

    const todayStr = format(new Date(), 'd MMMM yyyy');
    const q = query(
      collection(db, 'appointments'),
      where('clinicId', '==', clinicId),
      where('doctor', '==', currentDoctorName),
      where('date', '==', todayStr),
      where('status', 'in', ['Pending', 'Confirmed', 'Skipped'])
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      setHasActiveAppointmentsToday(!snapshot.empty);
    });

    return () => unsubscribe();
  }, [clinicId, selectedDoctor, allDoctors]);

  const currentDoctor = allDoctors.find(d => d.id === selectedDoctor);
  const consultationStatus = currentDoctor?.consultationStatus || 'Out';

  const handleDoctorSelect = (doctorId: string) => {
    setSelectedDoctor(doctorId);
    localStorage.setItem('selectedDoctorId', doctorId);
  }

  const getCurrentSessionIndex = (): number | undefined => {
    if (!currentDoctor) return undefined;
    const todayDay = format(new Date(), 'EEEE');
    const todaysAvailability = currentDoctor.availabilitySlots?.find(s => s.day === todayDay);
    if (!todaysAvailability?.timeSlots?.length) return undefined;

    const now = new Date();
    for (let i = 0; i < todaysAvailability.timeSlots.length; i++) {
      const session = todaysAvailability.timeSlots[i];
      const sessionStart = parseTime(session.from, now);
      const sessionEnd = parseTime(session.to, now);

      // Leniency:
      // Start window: 30 mins before
      // End window: 120 mins (2 hours) after session formally ends (to handle significant delays)
      const windowStart = subMinutes(sessionStart, 30);
      const windowEnd = addMinutes(sessionEnd, 120);

      if (now >= windowStart && now <= windowEnd) {
        return i;
      }
    }

    return undefined;
  };

  const handleStatusChange = (newStatus: 'In' | 'Out') => {
    setPendingStatusChange(newStatus);
  };

  const confirmStatusChange = async () => {
    if (!currentDoctor || !clinicId || !pendingStatusChange) return;

    const newStatus = pendingStatusChange;
    setPendingStatusChange(null);

    if (newStatus === 'Out') {
      try {
        await updateDoc(doc(db, 'doctors', currentDoctor.id), {
          consultationStatus: 'Out',
          updatedAt: serverTimestamp()
        });

        // Try to find the session that just ended or is active
        let sessionIndex = getCurrentSessionIndex();
        if (sessionIndex === undefined) {
          const now = new Date();
          const todayDay = format(now, 'EEEE');
          const todaysAvailability = currentDoctor.availabilitySlots?.find(s => s.day === todayDay);
          const foundIndex = todaysAvailability?.timeSlots.findIndex(s => {
            const start = parseTime(s.from, now);
            const end = parseTime(s.to, now);
            return now >= start && now <= addMinutes(end, 180); // within 3 hours of end
          });
          if (foundIndex !== undefined && foundIndex !== -1) sessionIndex = foundIndex;
        }
        await logPunctualityEvent(db, clinicId, currentDoctor, 'OUT', sessionIndex);

        toast({ title: 'Doctor marked Out' });
      } catch (error) {
        console.error('Error marking doctor out:', error);
        toast({ variant: 'destructive', title: 'Update Failed' });
      }
      return;
    }

    // Handing turn 'In'
    const sessionIndex = getCurrentSessionIndex();

    // Allow going 'In' IF we are in a session OR we have active appointments for today
    if (sessionIndex === undefined && !hasActiveAppointmentsToday) {
      toast({
        variant: 'destructive',
        title: 'Outside Session Window',
        description: 'Consultation can be started only during an active session or if there are pending appointments.',
      });
      return;
    }

    const doctorRef = doc(db, 'doctors', currentDoctor.id);
    try {
      console.log('[BUFFER-DEBUG] handleStatusChange: Setting status to In for doctor', currentDoctor.name);
      await updateDoc(doctorRef, {
        consultationStatus: 'In',
        updatedAt: serverTimestamp()
      });
      console.log('[BUFFER-DEBUG] handleStatusChange: Firestore updated successfully');

      // Log IN event
      await logPunctualityEvent(db, clinicId, currentDoctor, 'IN', sessionIndex);
    } catch (error) {
      console.error('Error updating doctor status:', error);
      toast({ variant: 'destructive', title: 'Update Failed' });
      return;
    }

    // Auto-fill buffer with 2 appointments when doctor goes "In"
    try {
      const today = format(new Date(), 'd MMMM yyyy');
      const appointmentsRef = collection(db, 'appointments');
      const q = query(
        appointmentsRef,
        where('doctor', '==', currentDoctor.name),
        where('date', '==', today),
        where('status', '==', 'Confirmed'),
        where('clinicId', '==', clinicId)
      );

      const snapshot = await getDocs(q);
      const confirmed = snapshot.docs
        .map(doc => ({ id: doc.id, ...doc.data() } as Appointment))
        .filter(a => !a.isInBuffer)
        .sort(compareAppointments)
        .slice(0, 2); // Take first 2

      if (confirmed.length > 0) {
        const batch = writeBatch(db);
        confirmed.forEach(apt => {
          const aptRef = doc(db, 'appointments', apt.id);
          batch.update(aptRef, {
            isInBuffer: true,
            bufferedAt: serverTimestamp(),
            updatedAt: serverTimestamp()
          });
        });
        await batch.commit();
        console.log(`[BUFFER-DEBUG] Auto-filled buffer with ${confirmed.length} appointment(s)`);
      } else {
        console.log('[BUFFER-DEBUG] No confirmed appointments available to fill buffer');
      }
    } catch (bufferError) {
      console.error('Error filling buffer:', bufferError);
      // Don't fail the status update if buffer fill fails
    }

    if (sessionIndex !== undefined) {
      try {
        const clinicDocRef = doc(db, 'clinics', clinicId);
        const clinicDoc = await getDoc(clinicDocRef).catch(() => null);
        const clinicName = clinicDoc?.data()?.name || 'The clinic';
        const todayStr = format(new Date(), 'd MMMM yyyy');

        await notifySessionPatientsOfConsultationStart({
          firestore: db,
          clinicId,
          clinicName,
          doctorName: currentDoctor.name,
          date: todayStr,
          sessionIndex,
          tokenDistribution: clinicDoc?.data()?.tokenDistribution,
          averageConsultingTime: currentDoctor.averageConsultingTime,
        });
      } catch (notificationError) {
        console.error('Failed to send consultation started notifications:', notificationError);
      }
    }

    toast({
      title: 'Doctor marked In',
      description: sessionIndex !== undefined
        ? 'Patients in the current session have been notified.'
        : 'Status set to In. No active session found for automated notifications.',
    });
  };

  useEffect(() => {
    if (!currentDoctor) {
      setIsWalkInAvailable(false);
      setIsNearClosing(false);
      return;
    };

    const todayDay = format(currentTime, 'EEEE');
    const todaysAvailability = currentDoctor.availabilitySlots?.find(s => s.day === todayDay);

    if (!todaysAvailability || todaysAvailability.timeSlots.length === 0) {
      setIsWalkInAvailable(false);
      setIsNearClosing(false);
      return;
    }

    // Get first session start time
    const firstSession = todaysAvailability.timeSlots[0];
    const lastSession = todaysAvailability.timeSlots[todaysAvailability.timeSlots.length - 1];
    const firstSessionStart = parseTime(firstSession.from, currentTime);
    const lastSessionStart = parseTime(lastSession.from, currentTime);
    const lastSessionEnd = parseTime(lastSession.to, currentTime);

    // Walk-in opens 30 minutes before the first session starts
    const walkInStart = subMinutes(firstSessionStart, 30);

    // Walk-in closes 15 minutes before consultation end,
    // plus any break duration that falls within the last session window
    let breakMinutesInLastSession = 0;
    const consultationTime = currentDoctor.averageConsultingTime || 15;
    if (currentDoctor.breakPeriods) {
      const dateKey = format(currentTime, 'd MMMM yyyy');
      const todaysBreaks = currentDoctor.breakPeriods[dateKey] || [];

      for (const bp of todaysBreaks) {
        const bpStart = parseISO(bp.startTime);
        const bpEnd = parseISO(bp.endTime);

        const overlapStart = bpStart > lastSessionStart ? bpStart : lastSessionStart;
        const overlapEnd = bpEnd < lastSessionEnd ? bpEnd : lastSessionEnd;

        if (overlapEnd > overlapStart) {
          breakMinutesInLastSession += differenceInMinutes(overlapEnd, overlapStart);
        }
      }
    }

    const walkInEnd = addMinutes(subMinutes(lastSessionEnd, 15), breakMinutesInLastSession);

    // Check if we're within the normal walk-in window
    const available = isWithinInterval(currentTime, { start: walkInStart, end: walkInEnd });

    // Check if we're in the last 15 minutes (between walkInEnd and actual session end)
    const actualEnd = addMinutes(lastSessionEnd, breakMinutesInLastSession);
    const nearClosing = currentTime > walkInEnd && currentTime <= actualEnd;

    setIsWalkInAvailable(available);
    setIsNearClosing(nearClosing);
  }, [currentDoctor, currentTime]);

  const handleScheduleBreak = () => {
    if (!selectedDoctor) {
      toast({
        variant: "destructive",
        title: "No Doctor Selected",
        description: "Please select a doctor before scheduling a break.",
      });
      return;
    }
    router.push(`/schedule-break?doctor=${selectedDoctor}`);
  };

  const getWalkInSubtitle = () => {
    if (!selectedDoctor) return 'Select a doctor first';
    if (isNearClosing) return 'Closing soon - Force booking available';
    if (!isWalkInAvailable) return 'Registration is currently closed';
    return 'Register a new walk-in patient';
  }

  const mainMenuItems = [
    {
      icon: Phone,
      title: 'Phone Booking',
      subtitle: 'Manage phone appointments',
      action: () => selectedDoctor && router.push(`/phone-booking/details?doctor=${selectedDoctor}`),
      disabled: !selectedDoctor,
      colors: "bg-gradient-to-br from-[#429EBD] to-[#52b1d3] text-white",
      iconContainer: "bg-white/20"
    },
    {
      icon: UserPlus,
      title: 'Walk-in',
      subtitle: getWalkInSubtitle(),
      action: () => selectedDoctor && router.push(`/walk-in?doctor=${selectedDoctor}`),
      disabled: !selectedDoctor,
      colors: isNearClosing
        ? "bg-gradient-to-br from-red-500 to-red-600 text-white"
        : "bg-gradient-to-br from-[#FFBA08] to-[#ffd46a] text-black",
      iconContainer: "bg-white/20"
    },
  ];





  return (
    <>
      <div className="relative flex flex-col h-full bg-muted/20">
        <ClinicHeader
          doctors={allDoctors}
          selectedDoctor={selectedDoctor}
          onDoctorChange={handleDoctorSelect}
          showLogo={true}
          consultationStatus={currentDoctor?.consultationStatus}
          onStatusChange={handleStatusChange}
          onScheduleBreakClick={handleScheduleBreak}
          hasActiveAppointments={hasActiveAppointmentsToday}
        />

        <main className="relative flex-1 flex flex-col p-6 bg-gradient-to-b from-transparent to-[rgba(37,108,173,0.3)] -mt-12 z-10">

          <div className="flex flex-col flex-1 justify-center">

            <div className="relative flex-1 flex flex-col justify-center items-center gap-6">
              {mainMenuItems.map((item, index) => (
                <div
                  key={index}
                  onClick={item.disabled ? undefined : item.action}
                  className={cn(
                    "w-48 h-48 rounded-2xl transition-all duration-300 ease-in-out flex flex-col items-center justify-center text-center p-6 shadow-lg",
                    item.disabled
                      ? 'opacity-60 cursor-not-allowed bg-gray-200 border border-gray-300'
                      : 'cursor-pointer hover:shadow-xl hover:-translate-y-1',
                    item.colors
                  )}
                >
                  <div className={cn("rounded-full p-3 mb-3", item.iconContainer)}>
                    <item.icon className="h-8 w-8 text-white" />
                  </div>
                  <div className="flex-1 flex flex-col items-center justify-center">
                    <h2 className="font-bold text-lg leading-tight">{item.title}</h2>
                    <p className="text-xs opacity-80 mt-1">{item.subtitle}</p>
                  </div>
                </div>
              ))}

              {/* Modern Circular Coffee Icon - Positioned between cards */}
              {selectedDoctor && (
                <>
                  {/* Left Side: Day Snapshot Icon */}
                  <button
                    onClick={() => router.push('/day-snapshot')}
                    className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-1/2 z-50 group"
                    aria-label="Day Snapshot"
                  >
                    <div className="relative w-24 h-24 bg-gradient-to-br from-blue-400 to-blue-600 rounded-full shadow-2xl transition-all duration-300 hover:scale-110 hover:shadow-blue-500/50 hover:-translate-x-2">
                      {/* Glow effect */}
                      <div className="absolute inset-0 rounded-full bg-blue-300 opacity-0 group-hover:opacity-30 blur-xl transition-opacity duration-300"></div>

                      <div className="absolute inset-0 flex items-center justify-center">
                        <BarChart3 className="h-10 w-10 text-white drop-shadow-lg" strokeWidth={2.5} />
                      </div>

                      {/* Ripple effect on hover */}
                      <div className="absolute inset-0 rounded-full border-2 border-white/30 group-hover:scale-110 transition-transform duration-300"></div>
                    </div>
                  </button>

                  {/* Right Side: Coffee Icon */}
                  <button
                    onClick={handleScheduleBreak}
                    className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-1/2 z-50 group"
                    aria-label="Schedule Break"
                  >
                    <div className="relative w-24 h-24 bg-gradient-to-br from-amber-400 to-amber-600 rounded-full shadow-2xl transition-all duration-300 hover:scale-110 hover:shadow-amber-500/50 hover:translate-x-2">
                      {/* Glow effect */}
                      <div className="absolute inset-0 rounded-full bg-amber-300 opacity-0 group-hover:opacity-30 blur-xl transition-opacity duration-300"></div>

                      {/* Coffee Icon - Flipped so handle points left */}
                      <div className="absolute inset-0 flex items-center justify-center scale-x-[-1]">
                        <Coffee className="h-10 w-10 text-white drop-shadow-lg" strokeWidth={2.5} />
                      </div>

                      {/* Ripple effect on hover */}
                      <div className="absolute inset-0 rounded-full border-2 border-white/30 group-hover:scale-110 transition-transform duration-300"></div>
                    </div>
                  </button>
                </>
              )}
            </div>
          </div>
        </main>

        <AlertDialog open={!!pendingStatusChange} onOpenChange={(open: boolean) => !open && setPendingStatusChange(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Change Doctor Status?</AlertDialogTitle>
              <AlertDialogDescription>
                Are you sure you want to mark the doctor as <strong>{pendingStatusChange}</strong>?
                {pendingStatusChange === 'In' && " This will notify patients that consultation has started."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel onClick={() => setPendingStatusChange(null)}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className={pendingStatusChange === 'In' ? "bg-green-600 hover:bg-green-700" : "bg-red-600 hover:bg-red-700"}
                onClick={confirmStatusChange}
              >
                Yes, Mark {pendingStatusChange}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </>
  );
}
