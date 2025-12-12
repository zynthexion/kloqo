
'use client';

import { useState, useEffect } from 'react';
import { Phone, UserPlus, Coffee, ChevronRight, User, Loader2, ChevronDown, Radio, Settings, CalendarX } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { format, isWithinInterval, addMinutes, subMinutes, isPast, parseISO, isSameDay, differenceInMinutes } from 'date-fns';
import Image from 'next/image';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import type { Appointment, Doctor } from '@/lib/types';
import { useToast } from '@/hooks/use-toast';
import { collection, addDoc, query, where, orderBy, limit, doc, updateDoc, onSnapshot, getDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from '@/lib/utils';
import { parseTime } from '@/lib/utils';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import ClinicHeader from './header';
import { errorEmitter } from '@kloqo/shared-core';
import { FirestorePermissionError } from '@kloqo/shared-core';
import { notifySessionPatientsOfConsultationStart, isWithin15MinutesOfClosing } from '@kloqo/shared-core';


export default function HomePage() {
  const router = useRouter();
  const [allDoctors, setAllDoctors] = useState<Doctor[]>([]);
  const [selectedDoctor, setSelectedDoctor] = useState<string>('');
  const [isProcessingBreak, setIsProcessingBreak] = useState(false);
  const [currentTime, setCurrentTime] = useState(new Date());
  const { toast } = useToast();
  const [clinicId, setClinicId] = useState<string | null>(null);
  const [isWalkInAvailable, setIsWalkInAvailable] = useState(false);
  const [isForceBookWindow, setIsForceBookWindow] = useState(false);


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
      const windowStart = subMinutes(sessionStart, 30);
      if (now >= windowStart && now <= sessionEnd) {
        return i;
      }
    }

    return undefined;
  };

  const handleGoOnline = async () => {
    if (!currentDoctor || currentDoctor.consultationStatus === 'In' || !clinicId) {
      return;
    }

    const sessionIndex = getCurrentSessionIndex();
    if (sessionIndex === undefined) {
      toast({
        variant: 'destructive',
        title: 'Outside Session Window',
        description: 'Consultation can be started only during an active session.',
      });
      return;
    }

    const doctorRef = doc(db, 'doctors', currentDoctor.id);
    try {
      await updateDoc(doctorRef, { consultationStatus: 'In' });
    } catch (error) {
      console.error('Error updating doctor status:', error);
      toast({ variant: 'destructive', title: 'Update Failed' });
      return;
    }

    try {
      const clinicDocRef = doc(db, 'clinics', clinicId);
      const clinicDoc = await getDoc(clinicDocRef).catch(() => null);
      const clinicName = clinicDoc?.data()?.name || 'The clinic';
      const today = format(new Date(), 'd MMMM yyyy');

      await notifySessionPatientsOfConsultationStart({
        firestore: db,
        clinicId,
        clinicName,
        doctorName: currentDoctor.name,
        date: today,
        sessionIndex,
      });
    } catch (notificationError) {
      console.error('Failed to send consultation started notifications:', notificationError);
    }

    toast({
      title: 'Doctor marked In',
      description: 'Patients in the current session have been notified.',
    });
  };

  useEffect(() => {
    if (!currentDoctor) {
      setIsWalkInAvailable(false);
      return;
    };

    const todayDay = format(currentTime, 'EEEE');
    const todaysAvailability = currentDoctor.availabilitySlots?.find(s => s.day === todayDay);

    if (!todaysAvailability || todaysAvailability.timeSlots.length === 0) {
      setIsWalkInAvailable(false);
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
    if (currentDoctor.leaveSlots && currentDoctor.leaveSlots.length > 0) {
      const slotsForToday = currentDoctor.leaveSlots
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
        .filter((date): date is Date => !!date && isSameDay(date, currentTime))
        .sort((a, b) => a.getTime() - b.getTime());

      if (slotsForToday.length > 0) {
        // Build contiguous intervals
        let currentStart = new Date(slotsForToday[0]);
        let currentEnd = addMinutes(currentStart, consultationTime);
        const intervals: { start: Date; end: Date }[] = [];
        for (let i = 1; i < slotsForToday.length; i++) {
          const slot = slotsForToday[i];
          if (slot.getTime() === currentEnd.getTime()) {
            currentEnd = addMinutes(currentEnd, consultationTime);
          } else {
            intervals.push({ start: currentStart, end: currentEnd });
            currentStart = new Date(slot);
            currentEnd = addMinutes(currentStart, consultationTime);
          }
        }
        intervals.push({ start: currentStart, end: currentEnd });

        for (const interval of intervals) {
          const overlapStart = interval.start > lastSessionStart ? interval.start : lastSessionStart;
          const overlapEnd = interval.end < lastSessionEnd ? interval.end : lastSessionEnd;
          if (overlapEnd > overlapStart) {
            breakMinutesInLastSession += differenceInMinutes(overlapEnd, overlapStart);
          }
        }
      }
    }

    const walkInEnd = addMinutes(subMinutes(lastSessionEnd, 15), breakMinutesInLastSession);

    const available = isWithinInterval(currentTime, { start: walkInStart, end: walkInEnd });
    setIsWalkInAvailable(available);
    
    // Check if we're in force booking window (within 15 min of closing but doctor still working)
    const isInForceWindow = !available && currentDoctor && isWithin15MinutesOfClosing(currentDoctor, currentTime);
    setIsForceBookWindow(isInForceWindow);
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
    if (isForceBookWindow) return 'Force Walk-in Booking';
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
      disabled: !selectedDoctor || (!isWalkInAvailable && !isForceBookWindow),
      colors: isForceBookWindow 
        ? "bg-gradient-to-br from-[#DC2626] to-[#EF4444] text-white" // Red for force booking
        : "bg-gradient-to-br from-[#FFBA08] to-[#ffd46a] text-black", // Yellow for normal
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
          onStatusChange={handleGoOnline}
          onScheduleBreakClick={handleScheduleBreak}
        />

        <main className="relative flex-1 flex flex-col p-6 bg-gradient-to-b from-transparent to-[rgba(37,108,173,0.3)] -mt-12 z-10">

          <div className="flex flex-col flex-1 justify-center">

            <div className="flex-1 flex flex-col justify-center items-center gap-6">
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
            </div>
          </div>
        </main>
      </div>
    </>
  );
}
