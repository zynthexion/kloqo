"use client";

import { useEffect, useState, useMemo, useRef, useCallback, useTransition } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { Appointment, Doctor, Patient, User } from "@/lib/types";
import { collection, getDocs, setDoc, doc, query, where, getDoc as getFirestoreDoc, updateDoc, increment, arrayUnion, deleteDoc, writeBatch, serverTimestamp, addDoc, orderBy, onSnapshot, runTransaction } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useToast } from "@/hooks/use-toast";
import { parse, isSameDay, parse as parseDateFns, format, getDay, isPast, isFuture, isToday, startOfYear, endOfYear, addMinutes, isBefore, subMinutes, isAfter, startOfDay, addHours, differenceInMinutes, parseISO, addDays, isSameMinute } from "date-fns";
import { updateAppointmentAndDoctorStatuses, isSlotBlockedByLeave } from '@kloqo/shared-core';
import { cn, parseTime as parseTimeUtil } from "@/lib/utils";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Calendar } from "@/components/ui/calendar";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ChevronLeft, FileDown, Printer, Search, MoreHorizontal, Eye, Edit, Trash2, ChevronRight, Stethoscope, Phone, Footprints, Loader2, Link as LinkIcon, Crown, UserCheck, UserPlus, Users, Plus, X, Clock, Calendar as CalendarLucide, CheckCircle2, Info, Send, MessageSquare, Smartphone, Hourglass, Repeat, SkipForward, AlertTriangle } from "lucide-react";
import { DateRange } from "react-day-picker";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList } from "@/components/ui/command";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/firebase";
import { useSearchParams } from 'next/navigation';
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { AddRelativeDialog } from "@/components/patients/add-relative-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogClose } from "@/components/ui/dialog";
import { FirestorePermissionError } from "@/firebase/errors";
import { errorEmitter } from "@/firebase/error-emitter";
import Link from "next/link";
import { Label } from "@/components/ui/label";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  calculateWalkInDetails,
  generateNextTokenAndReserveSlot,
  previewWalkInPlacement,
} from '@kloqo/shared-core';

import { sendAppointmentCancelledNotification, sendTokenCalledNotification, sendAppointmentBookedByStaffNotification, sendBreakUpdateNotification } from '@kloqo/shared-core';
import { computeQueues, type QueueState } from '@kloqo/shared-core';
import {
  getSessionBreaks,
  getSessionEnd,
  buildBreakIntervalsFromPeriods,
  getSessionBreakIntervals,
  getCurrentActiveSession,
  applyBreakOffsets as applySessionBreakOffsets,
  isWithin15MinutesOfClosing,
  type BreakInterval as SessionBreakInterval
} from '@kloqo/shared-core';

const formSchema = z.object({
  id: z.string().optional(),
  patientName: z.string()
    .min(3, { message: "Name must be at least 3 characters." })
    .regex(/^[a-zA-Z\s]+$/, { message: "Name must contain only alphabets and spaces." })
    .refine(name => !name.startsWith(' ') && !name.endsWith(' ') && !name.includes('  '), {
      message: "Spaces are only allowed between letters, not at the start, end, or multiple consecutive spaces."
    }),
  sex: z.enum(["Male", "Female", "Other"], { required_error: "Please select a gender." }),
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
      message: "Phone number must be exactly 10 digits."
    }),
  age: z.preprocess(
    (val) => (val === "" || val === undefined || val === null ? undefined : Number(val)),
    z.number({ required_error: "Age is required.", invalid_type_error: "Age is required." })
      .min(1, { message: "Age must be a positive number above zero." })
      .max(120, { message: "Age must be less than 120." })
  ),
  doctor: z.string().min(1, { message: "Please select a doctor." }),
  department: z.string().min(1, { message: "Department is required." }),
  date: z.date().optional(),
  time: z.string().optional(),
  place: z.string().min(2, { message: "Location is required." }),
  bookedVia: z.enum(["Advanced Booking", "Walk-in"]),
  tokenNumber: z.string().optional(),
  patientId: z.string().optional(),
}).refine(data => {
  if (data.bookedVia === 'Advanced Booking') {
    return !!data.date && !!data.time;
  }
  return true;
}, {
  message: "Date and time are required for advanced bookings.",
  path: ["time"],
});

type AppointmentFormValues = z.infer<typeof formSchema>;

const daysOfWeek = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MAX_VISIBLE_SLOTS = 6;

type WalkInEstimate = {
  estimatedTime: Date;
  patientsAhead: number;
  numericToken: number;
  slotIndex: number;
  sessionIndex: number;
  delayMinutes?: number;
  isForceBooked?: boolean;
} | null;

/**
 * Helper function to parse time strings like "09:00 AM" relative to a given date.
 */
function parseTime(timeString: string, referenceDate: Date): Date {
  return parse(timeString, 'hh:mm a', referenceDate);
}

function parseAppointmentDateTime(dateStr: string, timeStr: string): Date {
  return parse(`${dateStr} ${timeStr}`, 'd MMMM yyyy hh:mm a', new Date());
}

type BreakInterval = {
  start: Date;
  end: Date;
};

function buildBreakIntervals(doctor: Doctor | null | undefined, referenceDate: Date | null | undefined): BreakInterval[] {
  if (!doctor?.breakPeriods || !referenceDate) {
    return [];
  }

  const dateKey = format(referenceDate, 'd MMMM yyyy');
  const breaks = doctor.breakPeriods[dateKey] || [];

  return breaks.map(bp => ({
    start: parseDateFns(bp.startTime, 'hh:mm a', referenceDate),
    end: parseDateFns(bp.endTime, 'hh:mm a', referenceDate)
  }));
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

function isDoctorAdvanceCapacityReachedOnDate(
  doctor: Doctor,
  date: Date,
  appointments: Appointment[],
  options: { isEditing?: boolean; editingAppointment?: Appointment | null } = {}
): boolean {
  const dayOfWeekName = daysOfWeek[getDay(date)];
  const availabilityForDay = doctor.availabilitySlots?.find(slot => slot.day === dayOfWeekName);
  if (!availabilityForDay?.timeSlots?.length) {
    return false;
  }

  const slotDuration = doctor.averageConsultingTime || 15;
  const now = new Date();
  const dateKey = format(date, 'd MMMM yyyy');
  const slotsBySession: Array<{ sessionIndex: number; slotCount: number }> = [];

  availabilityForDay.timeSlots.forEach((session, sessionIndex) => {
    let currentTime = parseDateFns(session.from, 'hh:mm a', date);

    // Check for availability extension (session-specific)
    const originalSessionEnd = parseDateFns(session.to, 'hh:mm a', date);
    let sessionEnd = originalSessionEnd;
    const extensions = doctor.availabilityExtensions?.[dateKey];

    console.log(`[ClinicAdmin] Capacity Check for ${dateKey}, Session ${sessionIndex}:`, {
      hasExtension: !!extensions
    });

    if (extensions?.sessions && Array.isArray(extensions.sessions)) {
      const sessionExtension = extensions.sessions.find((s: any) => s.sessionIndex === sessionIndex);
      if (sessionExtension?.newEndTime) {
        sessionEnd = parseDateFns(sessionExtension.newEndTime, 'hh:mm a', date);
        console.log(`[ClinicAdmin] Extended Session End to: ${format(sessionEnd, 'hh:mm a')}`);
      }
    }

    let futureSlotCount = 0;

    while (isBefore(currentTime, sessionEnd)) {
      const slotTime = new Date(currentTime);
      const isBlocked = isSlotBlockedByLeave(doctor, slotTime);

      if (!isBlocked && (isAfter(slotTime, now) || slotTime.getTime() >= now.getTime())) {
        futureSlotCount += 1;
      }
      currentTime = addMinutes(currentTime, slotDuration);
    }

    if (futureSlotCount > 0) {
      slotsBySession.push({ sessionIndex, slotCount: futureSlotCount });
    }
  });

  if (slotsBySession.length === 0) {
    return false;
  }

  let maximumAdvanceTokens = 0;
  slotsBySession.forEach(({ slotCount }) => {
    const sessionMinimumWalkInReserve = slotCount > 0 ? Math.ceil(slotCount * 0.15) : 0;
    const sessionAdvanceCapacity = Math.max(slotCount - sessionMinimumWalkInReserve, 0);
    maximumAdvanceTokens += sessionAdvanceCapacity;
  });

  if (maximumAdvanceTokens === 0) {
    return true;
  }

  const formattedDate = format(date, 'd MMMM yyyy');
  let activeAdvanceCount = appointments.filter(appointment => {
    return (
      appointment.doctor === doctor.name &&
      appointment.bookedVia !== 'Walk-in' &&
      appointment.date === formattedDate &&
      (appointment.status === 'Pending' || appointment.status === 'Confirmed' || appointment.status === 'Completed' || appointment.status === 'Attended') &&
      !appointment.cancelledByBreak // Exclude appointments cancelled by break scheduling
    );
  }).length;

  const { isEditing, editingAppointment } = options;
  if (
    isEditing &&
    editingAppointment &&
    editingAppointment.bookedVia !== 'Walk-in' &&
    (editingAppointment.status === 'Pending' || editingAppointment.status === 'Confirmed') &&
    editingAppointment.date === formattedDate &&
    editingAppointment.doctor === doctor.name
  ) {
    activeAdvanceCount = Math.max(0, activeAdvanceCount - 1);
  }

  return activeAdvanceCount >= maximumAdvanceTokens;
}

function getNextAvailableDate(
  doctor?: Doctor | null,
  opts: {
    startDate?: Date;
    appointments?: Appointment[];
    isEditing?: boolean;
    editingAppointment?: Appointment | null;
  } = {}
): Date {
  const { startDate = new Date(), appointments = [], isEditing = false, editingAppointment = null } = opts;

  if (!doctor?.availabilitySlots || doctor.availabilitySlots.length === 0) {
    return startOfDay(startDate);
  }

  const searchStart = startOfDay(startDate);

  for (let offset = 0; offset < 60; offset++) {
    const candidate = addDays(searchStart, offset);
    const dayName = format(candidate, 'EEEE');
    const availability = doctor.availabilitySlots.find(
      slot => slot.day?.toLowerCase() === dayName.toLowerCase() && slot.timeSlots?.length
    );

    if (!availability) {
      continue;
    }

    if (!isDoctorAdvanceCapacityReachedOnDate(doctor, candidate, appointments, { isEditing, editingAppointment })) {
      return candidate;
    }
  }

  return searchStart;
}


export default function AppointmentsPage() {
  const auth = useAuth();
  const searchParams = useSearchParams();

  const [isDrawerExpanded, setIsDrawerExpanded] = useState(false);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [clinicDetails, setClinicDetails] = useState<any>(null);
  const [clinicId, setClinicId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editingAppointment, setEditingAppointment] = useState<Appointment | null>(null);
  const [patientSearchTerm, setPatientSearchTerm] = useState("");
  const [patientSearchResults, setPatientSearchResults] = useState<Patient[]>([]);
  const [isPatientPopoverOpen, setIsPatientPopoverOpen] = useState(false);
  const [selectedPatient, setSelectedPatient] = useState<Patient | null>(null);
  const [primaryPatient, setPrimaryPatient] = useState<Patient | null>(null);
  const [hasSelectedOption, setHasSelectedOption] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [isSendingLink, setIsSendingLink] = useState(false);
  const [drawerSearchTerm, setDrawerSearchTerm] = useState("");
  const [selectedDrawerDoctor, setSelectedDrawerDoctor] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("upcoming");
  const currentYearStart = startOfYear(new Date());
  const currentYearEnd = endOfYear(new Date());
  const [drawerDateRange, setDrawerDateRange] = useState<DateRange | undefined>({ from: currentYearStart, to: currentYearEnd });
  const [bookingFor, setBookingFor] = useState('member');
  const [relatives, setRelatives] = useState<Patient[]>([]);
  const [isAddRelativeDialogOpen, setIsAddRelativeDialogOpen] = useState(false);
  const [isTokenModalOpen, setIsTokenModalOpen] = useState(false);
  const [generatedToken, setGeneratedToken] = useState<string | null>(null);
  const [walkInEstimate, setWalkInEstimate] = useState<WalkInEstimate>(null);
  const [isCalculatingEstimate, setIsCalculatingEstimate] = useState(false);
  const [appointmentToCancel, setAppointmentToCancel] = useState<Appointment | null>(null);
  const [appointmentToAddToQueue, setAppointmentToAddToQueue] = useState<Appointment | null>(null);
  const [appointmentToComplete, setAppointmentToComplete] = useState<Appointment | null>(null);
  const [currentTime, setCurrentTime] = useState(new Date());
  const [showVisualView, setShowVisualView] = useState(false);

  const [linkChannel, setLinkChannel] = useState<'sms' | 'whatsapp'>('whatsapp');
  const [isPreviewingWalkIn, setIsPreviewingWalkIn] = useState(false);
  const isWalkInDebugEnabled = process.env.NEXT_PUBLIC_DEBUG_WALK_IN === 'true';

  // Force booking states
  const [showForceBookDialog, setShowForceBookDialog] = useState(false);
  const [walkInEstimateUnavailable, setWalkInEstimateUnavailable] = useState(false);
  const [isForceBookedState, setIsForceBookedState] = useState(false);

  // Update current time every minute
  useEffect(() => {
    const timerId = setInterval(() => setCurrentTime(new Date()), 60000);
    return () => clearInterval(timerId);
  }, []);

  // Check if Confirm Arrival button should be shown (show for all pending appointments)
  const shouldShowConfirmArrival = useCallback((appointment: Appointment): boolean => {
    // Show confirm arrival icon for all pending appointments
    return appointment.status === 'Pending';
  }, []);

  const { toast } = useToast();
  const isEditing = !!editingAppointment;

  const form = useForm<AppointmentFormValues>({
    resolver: zodResolver(formSchema),
    mode: 'onBlur',
    reValidateMode: 'onChange',
    defaultValues: {
      patientName: "",
      phone: "",
      age: undefined,
      sex: undefined,
      doctor: "",
      department: "",
      date: undefined,
      time: undefined,
      place: "",
      bookedVia: "Advanced Booking",
    },
  });

  const patientInputRef = useRef<HTMLInputElement>(null);
  const watchedPatientName = form.watch('patientName');

  const handlePatientSearch = useCallback(async (phone: string) => {
    if (phone.length < 10 || !clinicId) {
      setPatientSearchResults([]);
      setIsPatientPopoverOpen(false);
      return;
    }

    startTransition(async () => {
      try {
        const { getDocs, query, collection, where, limit } = await import('firebase/firestore');
        const patientsRef = collection(db, 'patients');
        const fullPhoneNumber = `+91${phone}`;

        const primaryQuery = query(patientsRef, where('phone', '==', fullPhoneNumber), limit(1));
        const primarySnapshot = await getDocs(primaryQuery);

        if (primarySnapshot.empty) {
          setPatientSearchResults([]);
          setIsPatientPopoverOpen(false);
          form.setValue('phone', phone);
          return;
        }

        const primaryDoc = primarySnapshot.docs[0];
        const primaryPatientData = { id: primaryDoc.id, ...primaryDoc.data() } as Patient;
        primaryPatientData.isKloqoMember = primaryPatientData.clinicIds?.includes(clinicId);

        setPatientSearchResults([primaryPatientData]);
        setIsPatientPopoverOpen(true);

      } catch (error) {
        console.error("Error searching patient:", error);
        toast({ variant: 'destructive', title: 'Search Error', description: 'Could not perform patient search.' });
      }
    });
  }, [clinicId, toast, form]);


  useEffect(() => {
    // When editing an existing appointment, don't run phone search or show suggestions
    if (editingAppointment) {
      setPatientSearchResults([]);
      setIsPatientPopoverOpen(false);
      return;
    }

    const handler = setTimeout(() => {
      if (patientSearchTerm.length >= 5) {
        handlePatientSearch(patientSearchTerm);
      } else {
        setPatientSearchResults([]);
        setIsPatientPopoverOpen(false);
      }
    }, 500); // 500ms debounce

    return () => {
      clearTimeout(handler);
    };
  }, [patientSearchTerm, handlePatientSearch, editingAppointment]);


  useEffect(() => {
    if (!auth.currentUser) {
      setLoading(false);
      return;
    }

    const fetchClinicInfo = async () => {
      try {
        const userDoc = await getFirestoreDoc(doc(db, "users", auth.currentUser!.uid));
        const userClinicId = userDoc.data()?.clinicId;

        if (!userClinicId) {
          toast({ variant: "destructive", title: "Error", description: "No clinic associated with this user." });
          setLoading(false);
          return null;
        }

        setClinicId(userClinicId);

        const clinicDoc = await getFirestoreDoc(doc(db, 'clinics', userClinicId));
        if (clinicDoc.exists()) {
          setClinicDetails(clinicDoc.data());
        }
        return userClinicId;
      } catch (error) {
        console.error("Error fetching clinic info:", error);
        toast({ variant: "destructive", title: "Error", description: "Failed to load clinic details." });
        setLoading(false);
        return null;
      }
    };

    fetchClinicInfo().then(async (fetchedClinicId) => {
      if (!fetchedClinicId) return;

      // Update appointment and doctor statuses on page refresh
      try {
        await updateAppointmentAndDoctorStatuses(fetchedClinicId);
      } catch (error) {
        console.error('Error updating statuses on page refresh:', error);
        // Don't show error toast as this is a background operation
      }

      setLoading(true);

      const appointmentsQuery = query(collection(db, "appointments"), where("clinicId", "==", fetchedClinicId));
      const appointmentsUnsubscribe = onSnapshot(appointmentsQuery, (snapshot) => {
        const appointmentsList = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Appointment));

        // Deduplicate appointments by id
        const uniqueAppointments = appointmentsList.reduce((acc, current) => {
          const existingIndex = acc.findIndex(item => item.id === current.id);
          if (existingIndex === -1) {
            acc.push(current);
          } else {
            // If duplicate found, keep the latest one
            acc[existingIndex] = current;
          }
          return acc;
        }, [] as Appointment[]);

        // Filter out appointments cancelled by break
        const filteredAppointments = uniqueAppointments.filter(apt => !(apt.status === 'Cancelled' && apt.cancelledByBreak));

        setAppointments(filteredAppointments);
        setLoading(false);
      }, (error) => {
        console.error("Error fetching appointments:", error);
        if (!(error instanceof FirestorePermissionError)) {
          toast({ variant: "destructive", title: "Error", description: "Failed to load appointments." });
        }
        setLoading(false);
      });

      const doctorsQuery = query(collection(db, "doctors"), where("clinicId", "==", fetchedClinicId));
      const doctorsUnsubscribe = onSnapshot(doctorsQuery, (snapshot) => {
        const doctorsList = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Doctor));
        setDoctors(doctorsList);

        const currentDoctorId = form.getValues('doctor');
        const currentDoctorStillExists = doctorsList.some(doc => doc.id === currentDoctorId);

        if (doctorsList.length > 0 && (!currentDoctorId || !currentDoctorStillExists)) {
          const firstDoctor = doctorsList[0];
          form.setValue("doctor", firstDoctor.id, { shouldValidate: true, shouldDirty: true });
          form.setValue("department", firstDoctor.department || "", { shouldValidate: true, shouldDirty: true });
          const upcomingDate = getNextAvailableDate(firstDoctor);
          form.setValue("date", upcomingDate, { shouldValidate: true, shouldDirty: true });
          form.clearErrors(['doctor', 'department']);
          form.trigger(['doctor', 'department']);
        } else if (currentDoctorId) {
          const currentDoctor = doctorsList.find(doc => doc.id === currentDoctorId);
          if (currentDoctor) {
            form.setValue("department", currentDoctor.department || "", { shouldValidate: true, shouldDirty: true });
            const upcomingDate = getNextAvailableDate(currentDoctor);
            form.setValue("date", upcomingDate, { shouldValidate: true, shouldDirty: true });
            form.clearErrors(['doctor', 'department']);
            form.trigger(['doctor', 'department']);
          }
        } else {
          form.setValue("department", "", { shouldValidate: true, shouldDirty: true });
        }
      }, (error) => {
        console.error("Error fetching doctors:", error);
        if (!(error instanceof FirestorePermissionError)) {
          toast({ variant: "destructive", title: "Error", description: "Failed to load doctors." });
        }
      });

      // Cleanup function
      return () => {
        appointmentsUnsubscribe();
        doctorsUnsubscribe();
      };
    });

  }, [auth.currentUser, toast, form]);


  const resetForm = useCallback(() => {
    setEditingAppointment(null);
    setPatientSearchTerm("");
    setSelectedPatient(null);
    setPrimaryPatient(null);
    setRelatives([]);
    setBookingFor('member');
    setHasSelectedOption(false);

    const firstDoctor = doctors.length === 1 ? doctors[0] : null;

    form.reset({
      patientName: "",
      phone: "",
      age: undefined,
      sex: undefined,
      doctor: firstDoctor ? firstDoctor.id : "",
      department: firstDoctor ? (firstDoctor.department || "") : "",
      date: undefined,
      time: undefined,
      place: "",
      bookedVia: "Advanced Booking",
    });

    if (firstDoctor) {
      const upcomingDate = getNextAvailableDate(firstDoctor);
      form.setValue("date", upcomingDate);
    }
  }, [form, doctors]);

  // Ensure doctor is auto-selected if only one exists
  useEffect(() => {
    if (doctors.length === 1 && !form.getValues('doctor')) {
      const doc = doctors[0];
      form.setValue("doctor", doc.id, { shouldValidate: true });
      form.setValue("department", doc.department || "", { shouldValidate: true });
      const upcomingDate = getNextAvailableDate(doc);
      form.setValue("date", upcomingDate, { shouldValidate: true });
    }
  }, [doctors, form]);

  const watchedDoctorId = useWatch({
    control: form.control,
    name: "doctor"
  });

  // When rescheduling, derive the doctor ID from the existing appointment + doctors list
  const editingDoctorId = useMemo(() => {
    if (!editingAppointment) return undefined;
    if (editingAppointment.doctorId) return editingAppointment.doctorId;
    if (!editingAppointment.doctor) return undefined;
    const targetName = editingAppointment.doctor.trim().toLowerCase();
    const match = doctors.find(d => (d.name || "").trim().toLowerCase() === targetName);
    return match?.id;
  }, [editingAppointment, doctors]);

  // Ensure the form state gets the resolved doctor ID when rescheduling
  useEffect(() => {
    if (editingDoctorId) {
      form.setValue("doctor", editingDoctorId, { shouldValidate: true, shouldDirty: false });
    }
  }, [editingDoctorId, form]);

  const selectedDoctor = useMemo(() => {
    const effectiveDoctorId = watchedDoctorId || editingDoctorId;
    if (!effectiveDoctorId) {
      return doctors.length > 0 ? doctors[0] : null;
    }
    return doctors.find(d => d.id === effectiveDoctorId) || null;
  }, [doctors, watchedDoctorId, editingDoctorId]);

  const selectedDate = form.watch("date");
  const appointmentType = form.watch("bookedVia");

  const handlePreviewWalkIn = useCallback(async () => {
    if (!isWalkInDebugEnabled) {
      return;
    }

    if (!clinicId || !selectedDoctor) {
      toast({
        variant: 'destructive',
        title: 'Walk-in preview unavailable',
        description: 'Select a doctor and clinic before previewing.',
      });
      return;
    }

    if (!selectedDate) {
      toast({
        variant: 'destructive',
        title: 'Walk-in preview unavailable',
        description: 'Pick a date to preview walk-in placement.',
      });
      return;
    }

    try {
      setIsPreviewingWalkIn(true);
      const spacingRaw = clinicDetails?.walkInTokenAllotment ?? 0;
      const walkInSpacingValue = Number.isFinite(Number(spacingRaw)) ? Math.max(0, Math.floor(Number(spacingRaw))) : 0;

      const preview = await previewWalkInPlacement(
        db,
        clinicId,
        selectedDoctor.name,
        selectedDate,
        walkInSpacingValue,
        selectedDoctor.id
      );

      const placeholderDescription = preview.placeholderAssignment
        ? `Placeholder slot #${preview.placeholderAssignment.slotIndex + 1} at ${format(preview.placeholderAssignment.slotTime, 'hh:mm a')}`
        : 'No placeholder assignment available.';
      const advanceShiftCount = preview.advanceShifts.length;
      const assignmentCount = preview.walkInAssignments.length;

      toast({
        title: 'Walk-in preview complete',
        description: `${placeholderDescription} • Advance shifts: ${advanceShiftCount} • Assignments: ${assignmentCount}`,
      });
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Unable to preview walk-in placement.',
        description: (error as Error)?.message ?? 'See console for details.',
      });
    } finally {
      setIsPreviewingWalkIn(false);
    }
  }, [clinicDetails?.walkInTokenAllotment, clinicId, isWalkInDebugEnabled, selectedDate, selectedDoctor, toast]);

  useEffect(() => {
    if (editingAppointment) {
      // Wait until doctors list is loaded before trying to resolve the doctor
      if (!doctors || doctors.length === 0) {
        return;
      }
      // Try to find doctor by ID first, then by matching name/label (robust, case-insensitive)
      let doctor: Doctor | undefined;

      if (editingAppointment.doctorId) {
        doctor = doctors.find(d => d.id === editingAppointment.doctorId);
      }

      if (!doctor && editingAppointment.doctor) {
        const target = editingAppointment.doctor.trim().toLowerCase();
        doctor = doctors.find(d => {
          const name = (d.name || "").trim().toLowerCase();
          const label = `${d.name || ""} - ${(d as any).specialty || ""}`.trim().toLowerCase();
          return (
            target === name ||
            target === label ||
            name === target ||
            label === target ||
            label.startsWith(target) ||
            target.startsWith(name)
          );
        });
      }

      const appointmentDate = parse(editingAppointment.date, "d MMMM yyyy", new Date());

      // Ensure sex is a valid enum value - use the value from appointment if it exists
      let validSex: 'Male' | 'Female' | 'Other' | undefined = undefined;
      if (editingAppointment.sex) {
        const sexValue = String(editingAppointment.sex).trim();
        if (sexValue && ['Male', 'Female', 'Other'].includes(sexValue)) {
          validSex = sexValue as 'Male' | 'Female' | 'Other';
        } else {
          const lowerSex = sexValue.toLowerCase();
          if (lowerSex === 'male') validSex = 'Male';
          else if (lowerSex === 'female') validSex = 'Female';
          else if (lowerSex === 'other') validSex = 'Other';
        }
      }

      // Load patient details for editing (phone + fallback sex)
      const loadPatientForEditing = async () => {
        if (editingAppointment.patientId) {
          const patientDoc = await getFirestoreDoc(doc(db, "patients", editingAppointment.patientId));
          if (patientDoc.exists()) {
            const patientData = patientDoc.data() as Patient;
            setSelectedPatient(patientData);
            // Prefill search input visually, but search effect is disabled while editing
            setPatientSearchTerm(patientData.communicationPhone?.replace('+91', '') || '');
            form.setValue('phone', patientData.communicationPhone?.replace('+91', '') || '');

            // If we still don't have a valid sex from the appointment, try from patient
            if (!validSex && patientData.sex) {
              const sexValue = String(patientData.sex).trim();
              const lowerSex = sexValue.toLowerCase();
              if (lowerSex === 'male') validSex = 'Male';
              else if (lowerSex === 'female') validSex = 'Female';
              else if (lowerSex === 'other') validSex = 'Other';

              if (validSex) {
                form.setValue('sex', validSex, { shouldValidate: true, shouldDirty: false });
              }
            } else if (validSex) {
              // Ensure form field reflects validSex even if it came from appointment
              form.setValue('sex', validSex, { shouldValidate: true, shouldDirty: false });
            }
          }
        } else if (validSex) {
          // No patient record, but appointment has valid sex
          form.setValue('sex', validSex, { shouldValidate: true, shouldDirty: false });
        }
      };
      loadPatientForEditing();

      if (doctor) {
        form.reset({
          ...editingAppointment,
          phone: editingAppointment.communicationPhone?.replace('+91', '') || '',
          date: isNaN(appointmentDate.getTime()) ? undefined : appointmentDate,
          doctor: doctor.id,
          sex: validSex,
          time: format(parseDateFns(editingAppointment.time, "hh:mm a", new Date()), 'HH:mm'),
          bookedVia: (editingAppointment.bookedVia === "Advanced Booking" || editingAppointment.bookedVia === "Walk-in") ? editingAppointment.bookedVia : "Advanced Booking",
        });
        // Ensure the controlled select sees the correct doctor ID
        form.setValue("doctor", doctor.id, { shouldValidate: true, shouldDirty: false });
      } else {
        // If doctor not found, still reset form but show error
        console.error('Doctor not found for appointment:', editingAppointment.doctor);
        toast({
          variant: "destructive",
          title: "Error",
          description: `Doctor "${editingAppointment.doctor}" not found. Please select a doctor.`,
        });
        form.reset({
          ...editingAppointment,
          phone: editingAppointment.communicationPhone?.replace("+91", "") || "",
          date: isNaN(appointmentDate.getTime()) ? undefined : appointmentDate,
          doctor: "",
          sex: validSex,
          time: format(parseDateFns(editingAppointment.time, "hh:mm a", new Date()), "HH:mm"),
          bookedVia:
            editingAppointment.bookedVia === "Advanced Booking" ||
              editingAppointment.bookedVia === "Walk-in"
              ? editingAppointment.bookedVia
              : "Advanced Booking",
        });
      }
    } else {
      resetForm();
    }
  }, [editingAppointment, form, doctors, resetForm, toast]);

  const isWithinBookingWindow = (doctor: Doctor | null): boolean => {
    if (!doctor || !doctor.availabilitySlots) return false;
    const now = new Date();
    const todayStr = format(now, 'EEEE');
    const todaySlots = doctor.availabilitySlots.find(s => s.day === todayStr);
    if (!todaySlots) return false;

    const getTimeOnDate = (timeStr: string, date: Date) => {
      const newDate = new Date(date);
      const [time, modifier] = timeStr.split(' ');
      let [hours, minutes] = time.split(':').map(Number);
      if (modifier === 'PM' && hours < 12) hours += 12;
      if (modifier === 'AM' && hours === 12) hours = 0;
      newDate.setHours(hours, minutes, 0, 0);
      return newDate;
    };

    // Check for availability extension (session-specific)
    const dateKey = format(now, 'd MMMM yyyy');
    const extensionForDate = doctor.availabilityExtensions?.[dateKey];

    return todaySlots.timeSlots.some((session, sessionIndex) => {
      const sessionStart = getTimeOnDate(session.from, now);
      let sessionEnd = getTimeOnDate(session.to, now);

      // Apply extension if exists
      if (extensionForDate) {
        const sessionExtension = extensionForDate.sessions?.find((s: any) => s.sessionIndex === sessionIndex);
        if (sessionExtension && sessionExtension.newEndTime && sessionExtension.totalExtendedBy > 0) {
          try {
            const extendedEndTime = getTimeOnDate(sessionExtension.newEndTime, now);
            // Only use extended time if it's actually later than the original end time
            if (isAfter(extendedEndTime, sessionEnd)) {
              sessionEnd = extendedEndTime;
            }
          } catch (error) {
            console.error('Error parsing extended end time:', error);
          }
        }
      }

      const bookingWindowStart = subMinutes(sessionStart, 30);
      const bookingWindowEnd = subMinutes(sessionEnd, 30);

      return now >= bookingWindowStart && now <= bookingWindowEnd;
    });
  };

  const isWalkInAvailable = useMemo(() => {
    if (appointmentType !== 'Walk-in' || !selectedDoctor || !selectedDoctor.availabilitySlots) return false;

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    // Get current active session (session-aware walk-in)
    const activeSession = getCurrentActiveSession(selectedDoctor, now, today);

    if (!activeSession) return false;

    // Walk-in window: 30 minutes before session start to 15 minutes before effective end
    // Effective end already includes break duration in getCurrentActiveSession
    const walkInOpenTime = subMinutes(activeSession.sessionStart, 30);
    const walkInCloseTime = subMinutes(activeSession.effectiveEnd, 15);

    // Check if current time is within walk-in window for this session
    return now >= walkInOpenTime && now <= walkInCloseTime;
  }, [appointmentType, selectedDoctor]);

  // Check if force booking window is active (within 15 min of closing)
  const isForceBookWindow = useMemo(() => {
    if (appointmentType !== 'Walk-in' || !selectedDoctor) return false;
    return isWithin15MinutesOfClosing(selectedDoctor, new Date());
  }, [appointmentType, selectedDoctor, currentTime]);

  useEffect(() => {
    // Run if normal walk-in is available OR if we're in force booking window
    // CRITICAL: process.env check prevents double invocation if strict mode
    if (appointmentType === 'Walk-in' && selectedDoctor && (isWalkInAvailable || isForceBookWindow)) {

      // If we already have a force booked estimate, DO NOT overwrite it with a normal check
      // The normal check will fail (because slots are full) and wipe out the force booking
      if (isForceBookedState) {
        console.log('[WALK-IN DEBUG] Skipping normal calculation because active estimate is force-booked');
        return;
      }

      setIsCalculatingEstimate(true);
      const allotment = clinicDetails?.walkInTokenAllotment || 3;
      console.log('[WALK-IN DEBUG] Starting walk-in details calculation', {
        doctor: selectedDoctor.name,
        clinicId: clinicId ?? selectedDoctor.clinicId,
        walkInTokenAllotment: allotment,
        isWalkInAvailable,
        isForceBookWindow,
        timestamp: new Date().toISOString()
      });
      calculateWalkInDetails(db, selectedDoctor, allotment, 0, false).then(details => {
        console.log('[WALK-IN DEBUG] Walk-in details calculated', {
          slotIndex: details.slotIndex,
          patientsAhead: details.patientsAhead,
          estimatedTime: details.estimatedTime.toISOString(),
          numericToken: details.numericToken,
          sessionIndex: details.sessionIndex,
          actualSlotTime: details.actualSlotTime.toISOString(),
          timestamp: new Date().toISOString()
        });
        setWalkInEstimate(details);
        setIsForceBookedState(false); // Normal booking succeeded

        // ✅ FIX: Check if within 15 min of closing even if slots available
        const isNearClosing = isWithin15MinutesOfClosing(selectedDoctor, new Date());

        if (isNearClosing) {
          // Within closing window - show Force Book option alongside normal estimate
          setWalkInEstimateUnavailable(true);
          console.log('[WALK-IN DEBUG] Within 15 minutes of closing - force book option enabled');
        } else {
          // Normal slots available, not near closing
          setWalkInEstimateUnavailable(false);
        }

        setIsCalculatingEstimate(false);
      }).catch(err => {
        console.error('[WALK-IN DEBUG] Error calculating walk-in details:', err);
        // Only clear estimate if we don't have a force booking
        if (!isForceBookedState) {
          setWalkInEstimate(null);
        }
        setIsCalculatingEstimate(false);
        const errorMessage = err.message || "";
        const isSlotUnavailable = errorMessage.includes("Unable to allocate walk-in slot") ||
          errorMessage.includes("No walk-in slots are available");

        // Check if within 15 minutes of closing
        const isNearClosing = isWithin15MinutesOfClosing(selectedDoctor, new Date());

        if (isSlotUnavailable || isNearClosing) {
          // Mark estimate as unavailable to show Force Book option
          setWalkInEstimateUnavailable(true);
          console.log('[WALK-IN DEBUG] Walk-in unavailable - force book option available:', { isSlotUnavailable, isNearClosing });
        } else {
          toast({
            variant: "destructive",
            title: "Walk-in Unavailable",
            description: err.message || "Could not calculate walk-in estimate.",
          });
        }
      });
    } else {
      // Only clear if doctor changed or type changed, not just because availablity flipped momentarily
      // But here we want to reset if user switches away from Walk-in
      if (appointmentType !== 'Walk-in' || !selectedDoctor) {
        setWalkInEstimate(null);
        setIsForceBookedState(false);
        setWalkInEstimateUnavailable(false);
      }
    }
  }, [appointmentType, selectedDoctor, isWalkInAvailable, isForceBookWindow, clinicDetails, toast, isForceBookedState]);

  // Handle force booking for walk-in estimate
  const handleForceBookEstimate = useCallback(async () => {
    if (!selectedDoctor || !clinicId) return;

    setIsCalculatingEstimate(true);
    // Don't hide the unavailable card yet - we want to show loading state on the button
    // setWalkInEstimateUnavailable(false); 

    try {
      const allotment = clinicDetails?.walkInTokenAllotment || 3;
      console.log('[FORCE BOOK] Calculating with force booking enabled');

      const details = await calculateWalkInDetails(
        db,
        selectedDoctor,
        allotment,
        0,
        true // Force booking enabled
      );

      console.log('[FORCE BOOK] Overflow slot calculated:', {
        slotIndex: details.slotIndex,
        time: details.estimatedTime.toISOString(),
        isForceBooked: details.isForceBooked,
      });

      setWalkInEstimate({ ...details, isForceBooked: true });
      setIsForceBookedState(true); // Mark as force booked to prevent overwrite
      setWalkInEstimateUnavailable(false); // Hide the unavailable card now that we have a valid estimate

      toast({
        title: "Force Book Enabled",
        description: `Walk-in will be scheduled outside normal hours at ${format(details.estimatedTime, 'hh:mm a')}`,
      });
    } catch (err: any) {
      console.error('[FORCE BOOK] Failed even with force booking:', err);
      toast({
        variant: "destructive",
        title: "Force Booking Failed",
        description: err.message || "Could not create overflow slot.",
      });
      setWalkInEstimate(null);
      setIsForceBookedState(false);
      // Keep unavailable card shown so user can try again if it was a transient error
    } finally {
      setIsCalculatingEstimate(false);
    }
  }, [selectedDoctor, clinicId, clinicDetails, toast]);

  async function onSubmit(values: AppointmentFormValues) {
    if (!auth.currentUser || !clinicId || !selectedDoctor) {
      toast({ variant: "destructive", title: "Error", description: "You must be logged in and select a doctor to book an appointment." });
      return;
    }

    if (appointmentType === 'Walk-in' && !walkInEstimate) {
      toast({ variant: "destructive", title: "Booking Not Available", description: "Walk-in tokens are not available for this doctor at this time." });
      return;
    }

    startTransition(async () => {
      try {
        const batch = writeBatch(db);
        let patientForAppointmentId: string;
        let patientForAppointmentName: string;

        const communicationPhone = `+91${form.getValues('phone')}`;

        const patientDataToUpdate: any = {
          name: values.patientName,
          place: values.place,
          phone: values.phone ? `+91${values.phone}` : "",
          communicationPhone: communicationPhone,
        };

        // Only add age and sex if they have values (Firestore doesn't allow undefined)
        if (values.age !== undefined && values.age !== null) {
          patientDataToUpdate.age = values.age;
        }
        if (values.sex) {
          patientDataToUpdate.sex = values.sex;
        }

        if (isEditing && editingAppointment) {
          patientForAppointmentId = editingAppointment.patientId;
          const patientRef = doc(db, 'patients', patientForAppointmentId);
          // Get the existing patient to check if they have a phone
          const existingPatientSnap = await getFirestoreDoc(patientRef);
          const existingPatient = existingPatientSnap.exists() ? existingPatientSnap.data() as Patient : null;

          const updateData: any = {
            name: patientDataToUpdate.name,
            place: patientDataToUpdate.place,
            communicationPhone: patientDataToUpdate.communicationPhone,
            updatedAt: serverTimestamp()
          };

          // Only add age and sex if they have values (Firestore doesn't allow undefined)
          if (patientDataToUpdate.age !== undefined && patientDataToUpdate.age !== null) {
            updateData.age = patientDataToUpdate.age;
          }
          if (patientDataToUpdate.sex) {
            updateData.sex = patientDataToUpdate.sex;
          }

          // Only update phone field if patient already has a phone (not a relative without phone)
          // Preserve empty phone field for relatives
          if (existingPatient && existingPatient.phone && existingPatient.phone.trim().length > 0) {
            updateData.phone = patientDataToUpdate.phone;
          } else {
            // Relative without phone - keep phone field empty
            updateData.phone = '';
          }
          batch.update(patientRef, updateData);
          patientForAppointmentName = values.patientName;
        } else if (selectedPatient && !isEditing) {
          patientForAppointmentId = selectedPatient.id;
          const patientRef = doc(db, 'patients', patientForAppointmentId);
          const clinicIds = selectedPatient.clinicIds || [];
          const updateData: any = {
            name: patientDataToUpdate.name,
            age: patientDataToUpdate.age,
            sex: patientDataToUpdate.sex,
            place: patientDataToUpdate.place,
            communicationPhone: patientDataToUpdate.communicationPhone,
            updatedAt: serverTimestamp()
          };
          // Only update phone field if patient already has a phone (not a relative without phone)
          // Preserve empty phone field for relatives
          if (selectedPatient.phone && selectedPatient.phone.trim().length > 0) {
            updateData.phone = patientDataToUpdate.phone;
          } else {
            // Relative without phone - keep phone field empty
            updateData.phone = '';
          }
          if (!clinicIds.includes(clinicId)) {
            updateData.clinicIds = arrayUnion(clinicId);
          }
          batch.update(patientRef, updateData);
          patientForAppointmentName = values.patientName;
        } else {
          // Creating a new user and patient
          const usersRef = collection(db, 'users');

          // Clean phone: remove +91 if user entered it, remove any non-digits, then ensure exactly 10 digits
          let patientPhoneNumber = "";
          if (values.phone) {
            const cleaned = values.phone.replace(/^\+91/, '').replace(/\D/g, ''); // Remove +91 prefix and non-digits
            if (cleaned.length === 10) {
              patientPhoneNumber = `+91${cleaned}`; // Add +91 prefix when saving
            }
          }
          if (!patientPhoneNumber) {
            toast({ variant: 'destructive', title: 'Error', description: 'Please enter a valid 10-digit phone number.' });
            return;
          }
          const userQuery = query(
            usersRef,
            where('phone', '==', patientPhoneNumber),
            where('role', '==', 'patient')
          );
          const userSnapshot = await getDocs(userQuery);

          let userId: string;
          let patientId: string;
          const patientRef = doc(collection(db, 'patients'));
          patientId = patientRef.id;

          if (userSnapshot.empty) {
            // User does not exist, create new user and patient
            const newUserRef = doc(collection(db, 'users'));
            userId = newUserRef.id;

            const newUserData: User = {
              uid: userId,
              phone: patientPhoneNumber,
              role: 'patient',
              patientId: patientId,
            };
            batch.set(newUserRef, newUserData);

            const newPatientData: any = {
              id: patientId,
              primaryUserId: userId,
              ...patientDataToUpdate,
              clinicIds: [clinicId],
              visitHistory: [],
              totalAppointments: 0,
              relatedPatientIds: [],
              isPrimary: true,
              isKloqoMember: false,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            };
            // Remove undefined values - Firestore doesn't allow undefined
            const cleanedPatientData = Object.fromEntries(
              Object.entries(newPatientData).filter(([_, v]) => v !== undefined)
            );
            batch.set(patientRef, cleanedPatientData);

          } else {
            // User exists, just create/update patient
            const existingUser = userSnapshot.docs[0].data() as User;
            userId = existingUser.uid;

            const existingPatientRef = doc(db, 'patients', existingUser.patientId!);
            const existingPatientSnap = await getFirestoreDoc(existingPatientRef);

            if (existingPatientSnap.exists()) {
              // Patient record exists, update it and ensure clinicId is present
              patientId = existingPatientSnap.id;
              const updateData: any = {
                name: patientDataToUpdate.name,
                place: patientDataToUpdate.place,
                phone: patientDataToUpdate.phone,
                communicationPhone: patientDataToUpdate.communicationPhone,
                updatedAt: serverTimestamp()
              };

              // Only add age and sex if they have values (Firestore doesn't allow undefined)
              if (patientDataToUpdate.age !== undefined && patientDataToUpdate.age !== null) {
                updateData.age = patientDataToUpdate.age;
              }
              if (patientDataToUpdate.sex) {
                updateData.sex = patientDataToUpdate.sex;
              }

              if (!existingPatientSnap.data().clinicIds?.includes(clinicId)) {
                updateData.clinicIds = arrayUnion(clinicId);
              }
              batch.update(existingPatientRef, updateData);
            } else {
              // This case is unlikely if DB is consistent, but handles it.
              // User exists but patient record is missing. Create it.
              const newPatientData: any = {
                id: patientId,
                primaryUserId: userId,
                ...patientDataToUpdate,
                clinicIds: [clinicId],
                visitHistory: [],
                totalAppointments: 0,
                relatedPatientIds: [],
                isPrimary: true,
                isKloqoMember: false,
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
              };
              // Remove undefined values - Firestore doesn't allow undefined
              const cleanedPatientData = Object.fromEntries(
                Object.entries(newPatientData).filter(([_, v]) => v !== undefined)
              );
              batch.set(patientRef, cleanedPatientData);
            }
          }

          patientForAppointmentId = patientId;
          patientForAppointmentName = values.patientName;
        }

        if (!isEditing) {
          const appointmentDateStr = appointmentType === 'Walk-in'
            ? format(new Date(), "d MMMM yyyy")
            : format(values.date!, "d MMMM yyyy");

          const duplicateCheckQuery = query(
            collection(db, "appointments"),
            where("patientId", "==", patientForAppointmentId),
            where("doctor", "==", selectedDoctor.name),
            where("date", "==", appointmentDateStr),
            where("status", "in", ["Pending", "Confirmed", "Completed", "Skipped"])
          );

          const duplicateSnapshot = await getDocs(duplicateCheckQuery);
          if (!duplicateSnapshot.empty) {
            toast({
              variant: "destructive",
              title: "Duplicate Booking",
              description: "This patient already has an appointment with this doctor today.",
            });
            return;
          }
        }


        await batch.commit().catch(e => {
          const permissionError = new FirestorePermissionError({
            path: 'batch write', operation: 'create', requestResourceData: values
          });
          errorEmitter.emit('permission-error', permissionError);
          throw permissionError;
        });

        if (appointmentType === 'Walk-in') {
          if (!walkInEstimate) {
            toast({ variant: "destructive", title: "Error", description: "Could not calculate walk-in time. Please try again." });
            return;
          }
          const date = new Date();

          // Create appointment directly (no pool needed)
          const {
            tokenNumber,
            numericToken,
            slotIndex: actualSlotIndex,
            sessionIndex: actualSessionIndex,
            time: actualTimeString,
            reservationId,
          } = await generateNextTokenAndReserveSlot(
            db, // CRITICAL: First parameter must be firestore instance
            clinicId,
            selectedDoctor.name,
            date,
            'W',
            {
              time: format(walkInEstimate.estimatedTime, "hh:mm a"),
              slotIndex: walkInEstimate.slotIndex,
              doctorId: selectedDoctor.id,
              isForceBooked: (walkInEstimate as any)?.isForceBooked,
            }
          );

          // Calculate cut-off time and no-show time
          const appointmentDate = parse(format(date, "d MMMM yyyy"), "d MMMM yyyy", new Date());
          const reservationTime = parse(actualTimeString, "hh:mm a", appointmentDate);
          const appointmentDateStr = format(date, "d MMMM yyyy");

          // Get session-specific breaks for this walk-in's session
          const walkInSessionIndex = walkInEstimate.sessionIndex ?? actualSessionIndex;
          const walkInBreakIntervals = getSessionBreakIntervals(selectedDoctor, appointmentDate, walkInSessionIndex);
          const adjustedWalkInTime = walkInBreakIntervals.length > 0
            ? applySessionBreakOffsets(reservationTime, walkInBreakIntervals)
            : reservationTime;

          // Validate adjusted walk-in time against session-specific availability
          // Account for consultation time - appointment must finish before session ends
          try {
            const sessionEffectiveEnd = getSessionEnd(selectedDoctor, appointmentDate, walkInSessionIndex);

            // Only check availability if NOT force booked
            const isForceBooked = (walkInEstimate as any)?.isForceBooked;
            if (sessionEffectiveEnd && !isForceBooked) {
              const appointmentEndTime = addMinutes(adjustedWalkInTime, selectedDoctor.averageConsultingTime || 15);
              console.log('[WALK-IN DEBUG] Availability validation', {
                doctor: selectedDoctor.name,
                appointmentDate: appointmentDateStr,
                sessionIndex: walkInSessionIndex,
                sessionEffectiveEnd: format(sessionEffectiveEnd, 'hh:mm a'),
                adjustedWalkInTime: format(adjustedWalkInTime, 'hh:mm a'),
                appointmentEndTime: format(appointmentEndTime, 'hh:mm a'),
              });

              if (appointmentEndTime > sessionEffectiveEnd) {
                toast({
                  variant: "destructive",
                  title: "Booking Not Allowed",
                  description: "This walk-in time is outside the doctor's availability for this session.",
                });
                return;
              }
            }
          } catch (e) {
            console.error('[WALK-IN DEBUG] Error validating walk-in time against availability', e);
          }
          const adjustedWalkInTimeStr = format(adjustedWalkInTime, "hh:mm a");
          const cutOffTime = subMinutes(adjustedWalkInTime, 15);
          const noShowTime = addMinutes(adjustedWalkInTime, 15);

          const appointmentRef = doc(collection(db, 'appointments'));

          const appointmentData: Appointment = {
            id: appointmentRef.id,
            bookedVia: appointmentType,
            clinicId: selectedDoctor.clinicId,
            doctorId: selectedDoctor.id, // Add doctorId
            date: appointmentDateStr,
            department: selectedDoctor.department,
            doctor: selectedDoctor.name,
            sex: values.sex,
            patientId: patientForAppointmentId,
            patientName: values.patientName,
            age: values.age ?? undefined,
            communicationPhone: communicationPhone,
            place: values.place,
            status: 'Confirmed', // Walk-ins are physically present at clinic
            // Keep original slot time in `time`, use adjusted time only for arriveBy/cutoff/noshow
            time: actualTimeString,
            arriveByTime: adjustedWalkInTimeStr,
            tokenNumber: tokenNumber,
            numericToken: numericToken,
            slotIndex: actualSlotIndex, // Use the actual slotIndex returned from the function
            sessionIndex: actualSessionIndex,
            createdAt: serverTimestamp(),
            cutOffTime: cutOffTime,
            noShowTime: noShowTime,
            ...((walkInEstimate as any)?.isForceBooked && { isForceBooked: true }), // Mark as force booked
          };

          // CRITICAL: Check for existing appointments at this slot before creating
          // This prevents duplicate bookings from concurrent requests
          const existingAppointmentsQuery = query(
            collection(db, 'appointments'),
            where('clinicId', '==', clinicId),
            where('doctor', '==', selectedDoctor.name),
            where('date', '==', appointmentDateStr),
            where('slotIndex', '==', actualSlotIndex)
          );
          const existingAppointmentsSnapshot = await getDocs(existingAppointmentsQuery);
          const existingActiveAppointments = existingAppointmentsSnapshot.docs.filter(docSnap => {
            const data = docSnap.data();
            return (data.status === 'Pending' || data.status === 'Confirmed');
          });

          if (existingActiveAppointments.length > 0) {
            console.error(`[CLINIC WALK-IN DEBUG] ⚠️ DUPLICATE DETECTED - Appointment already exists at slotIndex ${actualSlotIndex}`, {
              existingAppointmentIds: existingActiveAppointments.map(docSnap => docSnap.id),
              timestamp: new Date().toISOString()
            });
            toast({
              variant: "destructive",
              title: "Slot Already Booked",
              description: "This time slot was just booked by someone else. Please try again.",
            });
            return;
          }

          // Get references to existing appointments to verify in transaction
          const existingAppointmentRefs = existingActiveAppointments.map(docSnap =>
            doc(db, 'appointments', docSnap.id)
          );

          // CRITICAL: Use transaction to atomically claim reservation and create appointment
          // The reservation document acts as a lock - only one transaction can delete it
          // This prevents race conditions across different browsers/devices
          try {
            await runTransaction(db, async (transaction) => {
              console.log(`[CLINIC WALK-IN DEBUG] Transaction STARTED`, {
                reservationId,
                appointmentId: appointmentRef.id,
                slotIndex: actualSlotIndex,
                timestamp: new Date().toISOString()
              });

              const reservationRef = doc(db, 'slot-reservations', reservationId);
              const reservationDoc = await transaction.get(reservationRef);

              console.log(`[CLINIC WALK-IN DEBUG] Reservation check result`, {
                reservationId,
                exists: reservationDoc.exists(),
                data: reservationDoc.exists() ? reservationDoc.data() : null,
                timestamp: new Date().toISOString()
              });

              if (!reservationDoc.exists()) {
                // Reservation was already claimed by another request - slot is taken
                console.error(`[CLINIC WALK-IN DEBUG] Reservation does NOT exist - already claimed`, {
                  reservationId,
                  timestamp: new Date().toISOString()
                });
                const conflictError = new Error('Reservation already claimed by another booking');
                (conflictError as { code?: string }).code = 'SLOT_ALREADY_BOOKED';
                throw conflictError;
              }

              // Verify the reservation matches our slot
              const reservationData = reservationDoc.data();
              console.log(`[CLINIC WALK-IN DEBUG] Verifying reservation match`, {
                reservationSlotIndex: reservationData?.slotIndex,
                expectedSlotIndex: actualSlotIndex,
                reservationClinicId: reservationData?.clinicId,
                expectedClinicId: clinicId,
                reservationDoctor: reservationData?.doctorName,
                expectedDoctor: selectedDoctor.name,
                timestamp: new Date().toISOString()
              });

              if (reservationData?.slotIndex !== actualSlotIndex ||
                reservationData?.clinicId !== clinicId ||
                reservationData?.doctorName !== selectedDoctor.name) {
                console.error(`[CLINIC WALK-IN DEBUG] Reservation mismatch`, {
                  reservationData,
                  expected: { slotIndex: actualSlotIndex, clinicId, doctorName: selectedDoctor.name }
                });
                const conflictError = new Error('Reservation does not match booking details');
                (conflictError as { code?: string }).code = 'RESERVATION_MISMATCH';
                throw conflictError;
              }

              // CRITICAL: Verify no appointment exists at this slotIndex by reading the documents we found
              // This ensures we see the latest state even if appointments were created between our query and transaction
              if (existingAppointmentRefs.length > 0) {
                const existingAppointmentSnapshots = await Promise.all(
                  existingAppointmentRefs.map(ref => transaction.get(ref))
                );
                const stillActive = existingAppointmentSnapshots.filter(snap => {
                  if (!snap.exists()) return false;
                  const data = snap.data() as Appointment;
                  return (data.status === 'Pending' || data.status === 'Confirmed');
                });

                if (stillActive.length > 0) {
                  console.error(`[CLINIC WALK-IN DEBUG] ⚠️ DUPLICATE DETECTED IN TRANSACTION - Appointment exists at slotIndex ${actualSlotIndex}`, {
                    existingAppointmentIds: stillActive.map(snap => snap.id),
                    timestamp: new Date().toISOString()
                  });
                  const conflictError = new Error('An appointment already exists at this slot');
                  (conflictError as { code?: string }).code = 'SLOT_ALREADY_BOOKED';
                  throw conflictError;
                }
              }

              console.log(`[CLINIC WALK-IN DEBUG] No existing appointment found - deleting reservation and creating appointment`, {
                reservationId,
                appointmentId: appointmentRef.id,
                slotIndex: actualSlotIndex,
                timestamp: new Date().toISOString()
              });



              // CRITICAL: Mark reservation as booked instead of deleting it
              // This acts as a persistent lock to prevent race conditions where other clients
              // might miss the new appointment and try to claim the "free" slot
              transaction.update(reservationRef, {
                status: 'booked',
                appointmentId: appointmentRef.id,
                bookedAt: serverTimestamp()
              });

              // Create appointment atomically in the same transaction
              transaction.set(appointmentRef, appointmentData);


            });





          } catch (error: any) {


            if (error.code === 'SLOT_ALREADY_BOOKED' || error.code === 'RESERVATION_MISMATCH') {
              toast({
                variant: "destructive",
                title: "Slot Already Booked",
                description: "This time slot was just booked by someone else. Please try again.",
              });
              return;
            }
            throw error;
          }

          // Ensure clinicId is added to patient's clinicIds array if it doesn't exist
          if (!isEditing) {
            try {
              const patientRef = doc(db, 'patients', patientForAppointmentId);
              const patientDoc = await getFirestoreDoc(patientRef);
              if (patientDoc.exists()) {
                const patientData = patientDoc.data();
                const clinicIds = patientData?.clinicIds || [];
                if (!clinicIds.includes(clinicId)) {
                  await updateDoc(patientRef, {
                    clinicIds: arrayUnion(clinicId),
                    updatedAt: serverTimestamp(),
                  });
                }
              }
            } catch (error) {
              console.error("Error updating patient clinicIds:", error);
              // Don't fail the appointment creation if this update fails
            }
          }

          setGeneratedToken(appointmentData.tokenNumber);
          setIsTokenModalOpen(true);

        } else {
          if (!values.date || !values.time) {
            toast({ variant: "destructive", title: "Missing Information", description: "Please select a date and time for the appointment." });
            return;
          }
          const appointmentId = isEditing && editingAppointment ? editingAppointment.id : doc(collection(db, "appointments")).id;
          const appointmentDateStr = format(values.date, "d MMMM yyyy");
          const appointmentTimeStr = format(parseDateFns(values.time, "HH:mm", new Date()), "hh:mm a");

          let slotIndex = -1;
          let sessionIndex = -1;
          const dayOfWeek = daysOfWeek[getDay(values.date)];
          const availabilityForDay = selectedDoctor.availabilitySlots?.find(s => s.day === dayOfWeek);

          // Calculate global slotIndex across all sessions (matching patient app logic)
          // Calculate global slotIndex across all sessions (matching patient app logic)
          if (availabilityForDay) {
            let globalSlotIndex = 0;
            // Check for availability extension (session-specific)
            const dateKey = format(values.date, 'd MMMM yyyy');
            const extensionForDate = selectedDoctor.availabilityExtensions?.[dateKey];

            for (let i = 0; i < availabilityForDay.timeSlots.length; i++) {
              const session = availabilityForDay.timeSlots[i];
              let currentTime = parseDateFns(session.from, 'hh:mm a', values.date);
              let endTime = parseDateFns(session.to, 'hh:mm a', values.date);
              const slotDuration = selectedDoctor.averageConsultingTime || 15;

              // Apply extension for this specific session
              if (extensionForDate) {
                const sessionExtension = extensionForDate.sessions?.find((s: any) => s.sessionIndex === i);
                if (sessionExtension && sessionExtension.newEndTime && sessionExtension.totalExtendedBy > 0) {
                  try {
                    const extendedEndTime = parseDateFns(sessionExtension.newEndTime, 'hh:mm a', values.date);
                    if (isAfter(extendedEndTime, endTime)) {
                      endTime = extendedEndTime;
                    }
                  } catch (e) {
                    console.error('Error parsing extension time for slot index calculation', e);
                  }
                }
              }

              while (isBefore(currentTime, endTime)) {
                if (format(currentTime, "hh:mm a") === appointmentTimeStr) {
                  slotIndex = globalSlotIndex;
                  sessionIndex = i;
                  break;
                }
                currentTime = addMinutes(currentTime, slotDuration);
                globalSlotIndex++;
              }
              if (slotIndex !== -1) break;
            }
          }

          // Generate token and reserve slot atomically (for both new and rescheduled appointments)
          // For rescheduling, regenerate token using same logic as new appointment
          let tokenData: {
            tokenNumber: string;
            numericToken: number;
            slotIndex: number;
            sessionIndex: number;
            time: string;
            reservationId: string;
          };
          try {
            tokenData = await generateNextTokenAndReserveSlot(
              db, // CRITICAL: First parameter must be firestore instance
              clinicId,
              selectedDoctor.name,
              values.date,
              'A',
              {
                time: appointmentTimeStr,
                slotIndex,
                doctorId: selectedDoctor.id,
                existingAppointmentId: isEditing && editingAppointment ? editingAppointment.id : undefined,
              }
            );
          } catch (error: any) {
            if (error.code === 'SLOT_OCCUPIED' || error.message === 'SLOT_ALREADY_BOOKED') {
              toast({
                variant: "destructive",
                title: "Time Slot Already Booked",
                description: "This time slot was just booked by someone else. Please select another time.",
              });
              return;
            } else if (error.code === 'A_CAPACITY_REACHED') {
              toast({
                variant: "destructive",
                title: "No Slots Available",
                description: "Advance booking capacity has been reached for this doctor today. Please choose another day.",
              });
              return;
            }
            throw error;
          }

          // Use the slotIndex returned from generateNextTokenAndReserveSlot (may have been auto-adjusted)
          const actualSlotIndex = tokenData.slotIndex;

          // Recalculate the time from the actual slotIndex to ensure consistency
          let actualAppointmentTimeStr = appointmentTimeStr;
          let actualAppointmentTime = parseDateFns(appointmentTimeStr, "hh:mm a", values.date);
          try {
            // Generate all time slots for the day to find the correct time for the actual slotIndex
            const dayOfWeek = daysOfWeek[getDay(values.date)];
            const availabilityForDay = selectedDoctor.availabilitySlots?.find(s => s.day === dayOfWeek);
            if (availabilityForDay) {
              const slotDuration = selectedDoctor.averageConsultingTime || 15;
              let globalSlotIndex = 0;
              let foundSlot = false;

              // Check for availability extension (session-specific)
              const dateKey = format(values.date, 'd MMMM yyyy');
              const extensionForDate = selectedDoctor.availabilityExtensions?.[dateKey];

              for (let i = 0; i < availabilityForDay.timeSlots.length && !foundSlot; i++) {
                const session = availabilityForDay.timeSlots[i];
                let currentTime = parseDateFns(session.from, 'hh:mm a', values.date);
                let endTime = parseDateFns(session.to, 'hh:mm a', values.date);

                // Apply extension for this specific session
                if (extensionForDate) {
                  const sessionExtension = extensionForDate.sessions?.find((s: any) => s.sessionIndex === i);
                  if (sessionExtension && sessionExtension.newEndTime && sessionExtension.totalExtendedBy > 0) {
                    try {
                      const extendedEndTime = parseDateFns(sessionExtension.newEndTime, 'hh:mm a', values.date);
                      if (isAfter(extendedEndTime, endTime)) {
                        endTime = extendedEndTime;
                      }
                    } catch (e) {
                      console.error('Error parsing extension time for recalculation', e);
                    }
                  }
                }

                while (isBefore(currentTime, endTime) && !foundSlot) {
                  if (globalSlotIndex === actualSlotIndex) {
                    actualAppointmentTime = currentTime;
                    actualAppointmentTimeStr = format(currentTime, "hh:mm a");
                    sessionIndex = i; // Update sessionIndex to match the actual slot
                    foundSlot = true;
                    break;
                  }
                  currentTime = addMinutes(currentTime, slotDuration);
                  globalSlotIndex++;
                }
              }
            }
          } catch (error) {
            console.error('Error recalculating time from slotIndex:', error);
            // Fall back to original time if recalculation fails
          }

          // Get session-specific breaks for this appointment's session
          const appointmentDate = values.date ? parse(appointmentDateStr, "d MMMM yyyy", new Date()) : null;
          const sessionBreakIntervals = appointmentDate && sessionIndex >= 0
            ? getSessionBreakIntervals(selectedDoctor, appointmentDate, sessionIndex)
            : [];

          // Apply only session-specific breaks to calculate adjusted time
          // The 'time' field stores original slot time (never changes)
          // Only arriveByTime, cutOffTime, noShowTime are adjusted
          const adjustedAppointmentTime = actualAppointmentTime;

          // Calculate cut-off time and no-show time
          let cutOffTime: Date | undefined;
          let noShowTime: Date | undefined;
          let inheritedDelay = 0;
          try {
            const appointmentDate = parse(appointmentDateStr, "d MMMM yyyy", new Date());
            const appointmentTime = adjustedAppointmentTime;
            cutOffTime = subMinutes(appointmentTime, 15);

            // Inherit delay from previous appointment (if any)
            // Find the appointment with the highest slotIndex that is less than actualSlotIndex
            const appointmentsRef = collection(db, 'appointments');
            const appointmentsQuery = query(
              appointmentsRef,
              where('clinicId', '==', clinicId),
              where('doctor', '==', selectedDoctor.name),
              where('date', '==', appointmentDateStr)
            );
            const appointmentsSnapshot = await getDocs(appointmentsQuery);
            const allAppointments = appointmentsSnapshot.docs.map(doc => ({
              id: doc.id,
              ...doc.data()
            })) as Array<Appointment & { id: string }>;

            // Find the previous appointment (highest slotIndex < actualSlotIndex)
            const previousAppointments = allAppointments
              .filter(a => {
                const aptSlotIndex = a.slotIndex ?? -1;
                return aptSlotIndex >= 0 && aptSlotIndex < actualSlotIndex;
              })
              .sort((a, b) => (b.slotIndex ?? 0) - (a.slotIndex ?? 0));

            if (previousAppointments.length > 0) {
              const previousAppointment = previousAppointments[0];
              inheritedDelay = previousAppointment.delay || 0;
            }

            // Apply delay to noShowTime only (not to cutOffTime or time)
            // cutOffTime remains: appointment time - 15 minutes (no delay)
            // noShowTime becomes: appointment time + 15 minutes + delay
            noShowTime = addMinutes(appointmentTime, 15 + inheritedDelay);
          } catch (error) {
            console.error('Error calculating cut-off and no-show times:', error);
          }

          // Always align arriveByTime with the actual appointment time (new slot),
          // both for new bookings and reschedules
          const arriveByTimeValue = format(adjustedAppointmentTime, "hh:mm a");
          const slotDuration = selectedDoctor.averageConsultingTime || 15;

          // Validate that the adjusted appointment time is within session availability
          // We check adjustedAppointmentTime (after break offsets) + consultation time against session-specific end time
          if (appointmentDate && sessionIndex >= 0) {
            const sessionEffectiveEnd = getSessionEnd(selectedDoctor, appointmentDate, sessionIndex);

            if (sessionEffectiveEnd) {
              // Check if the adjusted time + consultation time would exceed session end
              const appointmentEndTime = addMinutes(adjustedAppointmentTime, slotDuration);
              if (appointmentEndTime > sessionEffectiveEnd) {
                toast({
                  variant: 'destructive',
                  title: 'Booking Not Allowed',
                  description: `The appointment time (${actualAppointmentTimeStr}) with break adjustments would exceed the session's availability. Please select an earlier time slot.`,
                });
                return;
              }
            }
          }

          const appointmentData: Appointment = {
            id: appointmentId,
            clinicId: clinicId,
            patientId: patientForAppointmentId,
            patientName: patientForAppointmentName,
            sex: values.sex,
            communicationPhone: communicationPhone,
            age: values.age ?? undefined,
            doctorId: selectedDoctor.id, // Add doctorId
            doctor: selectedDoctor.name,
            date: appointmentDateStr,
            // Keep original slot time (before break adjustments)
            time: actualAppointmentTimeStr,
            arriveByTime: arriveByTimeValue,
            department: values.department,
            status: isEditing ? editingAppointment!.status : "Pending",
            tokenNumber: tokenData.tokenNumber,
            numericToken: tokenData.numericToken,
            bookedVia: values.bookedVia,
            place: values.place,
            slotIndex: actualSlotIndex, // Use the actual slotIndex returned from the function
            sessionIndex: sessionIndex,
            createdAt: isEditing ? editingAppointment.createdAt : serverTimestamp(),
            cutOffTime: cutOffTime,
            noShowTime: noShowTime,
            ...(inheritedDelay > 0 && { delay: inheritedDelay }), // Only include delay if > 0
          };

          const appointmentRef = doc(db, 'appointments', appointmentId);
          const reservationId = tokenData.reservationId;

          // CRITICAL: Check for existing appointments at this slot before creating
          // This prevents duplicate bookings from concurrent requests
          const existingAppointmentsQuery = query(
            collection(db, 'appointments'),
            where('clinicId', '==', clinicId),
            where('doctor', '==', selectedDoctor.name),
            where('date', '==', appointmentDateStr),
            where('slotIndex', '==', actualSlotIndex)
          );
          const existingAppointmentsSnapshot = await getDocs(existingAppointmentsQuery);
          const existingActiveAppointments = existingAppointmentsSnapshot.docs.filter(docSnap => {
            const data = docSnap.data();
            return (data.status === 'Pending' || data.status === 'Confirmed') && docSnap.id !== appointmentId;
          });

          if (existingActiveAppointments.length > 0) {

            toast({
              variant: "destructive",
              title: "Slot Already Booked",
              description: "This time slot was just booked by someone else. Please select another time.",
            });
            return;
          }

          // Get references to existing appointments to verify in transaction
          const existingAppointmentRefs = existingActiveAppointments.map(docSnap =>
            doc(db, 'appointments', docSnap.id)
          );

          // CRITICAL: Use transaction to atomically claim reservation and create appointment
          // The reservation document acts as a lock - only one transaction can delete it
          // This prevents race conditions across different browsers/devices
          try {
            await runTransaction(db, async (transaction) => {


              const reservationRef = doc(db, 'slot-reservations', reservationId);
              const reservationDoc = await transaction.get(reservationRef);



              if (!reservationDoc.exists()) {
                // Reservation was already claimed by another request - slot is taken

                const conflictError = new Error('Reservation already claimed by another booking');
                (conflictError as { code?: string }).code = 'SLOT_ALREADY_BOOKED';
                throw conflictError;
              }

              // Verify the reservation matches our slot
              const reservationData = reservationDoc.data();


              if (reservationData?.slotIndex !== actualSlotIndex ||
                reservationData?.clinicId !== clinicId ||
                reservationData?.doctorName !== selectedDoctor.name) {

                const conflictError = new Error('Reservation does not match booking details');
                (conflictError as { code?: string }).code = 'RESERVATION_MISMATCH';
                throw conflictError;
              }

              // CRITICAL: Verify no appointment exists at this slotIndex by reading the documents we found
              // This ensures we see the latest state even if appointments were created between our query and transaction
              if (existingAppointmentRefs.length > 0) {
                const existingAppointmentSnapshots = await Promise.all(
                  existingAppointmentRefs.map(ref => transaction.get(ref))
                );
                const stillActive = existingAppointmentSnapshots.filter(snap => {
                  if (!snap.exists()) return false;
                  const data = snap.data() as Appointment;
                  return (data.status === 'Pending' || data.status === 'Confirmed');
                });

                if (stillActive.length > 0) {

                  const conflictError = new Error('An appointment already exists at this slot');
                  (conflictError as { code?: string }).code = 'SLOT_ALREADY_BOOKED';
                  throw conflictError;
                }
              }





              // CRITICAL: Mark reservation as booked instead of deleting it
              // This acts as a persistent lock to prevent race conditions where other clients
              // might miss the new appointment and try to claim the "free" slot
              transaction.update(reservationRef, {
                status: 'booked',
                appointmentId: appointmentId,
                bookedAt: serverTimestamp()
              });

              // Create appointment atomically in the same transaction
              transaction.set(appointmentRef, appointmentData);


            });




          } catch (error: any) {



            if (error.code === 'SLOT_ALREADY_BOOKED' || error.code === 'RESERVATION_MISMATCH') {
              toast({
                variant: "destructive",
                title: "Slot Already Booked",
                description: "This time slot was just booked by someone else. Please select another time.",
              });
              return;
            }
            throw error;
          }

          if (!isEditing) {
            const patientRef = doc(db, 'patients', patientForAppointmentId);
            const patientDoc = await getFirestoreDoc(patientRef);
            const updateData: any = {
              visitHistory: arrayUnion(appointmentId),
              totalAppointments: increment(1),
              updatedAt: serverTimestamp(),
            };

            // Ensure clinicId is added to patient's clinicIds array if it doesn't exist
            if (patientDoc.exists()) {
              const patientData = patientDoc.data();
              const clinicIds = patientData?.clinicIds || [];
              if (!clinicIds.includes(clinicId)) {
                updateData.clinicIds = arrayUnion(clinicId);
              }
            }

            await updateDoc(patientRef, updateData);
          }

          // Send notification for new appointments
          if (!isEditing) {
            try {
              const clinicName = `The clinic`; // You can fetch from clinic doc if needed

              await sendAppointmentBookedByStaffNotification({
                firestore: db,
                patientId: patientForAppointmentId,
                appointmentId: appointmentId,
                doctorName: appointmentData.doctor,
                clinicName: clinicName,
                date: appointmentData.date,
                time: appointmentData.time,
                arriveByTime: appointmentData.arriveByTime,
                tokenNumber: appointmentData.tokenNumber,
                bookedBy: 'admin',
              });
            } catch (notifError) {
              console.error('Failed to send notification:', notifError);
            }
          }

          // When editing (rescheduling), also send a reschedule notification
          if (isEditing) {
            toast({ title: "Appointment Rescheduled", description: `Appointment for ${appointmentData.patientName} has been updated.` });

            try {
              const clinicName = `The clinic`; // You can fetch from clinic doc if needed

              await sendBreakUpdateNotification({
                firestore: db,
                patientId: patientForAppointmentId,
                appointmentId,
                doctorName: appointmentData.doctor,
                clinicName,
                oldTime: editingAppointment?.time || appointmentData.time,
                newTime: appointmentData.time,
                oldDate: editingAppointment?.date,
                newDate: appointmentData.date,
                reason: 'Appointment rescheduled by clinic',
                oldArriveByTime: editingAppointment?.arriveByTime,
                newArriveByTime: appointmentData.arriveByTime,
              });
            } catch (notifError) {
              console.error('Failed to send reschedule notification:', notifError);
            }
          } else {
            toast({ title: "Appointment Booked", description: `Appointment for ${appointmentData.patientName} has been successfully booked.` });
          }
        }
        resetForm();
      } catch (error) {
        console.error("Error saving appointment: ", error);
        if (!(error instanceof FirestorePermissionError)) {
          toast({ variant: "destructive", title: "Error", description: "Failed to save appointment. Please try again." });
        }
      }
    });
  }

  const handleSendLink = async () => {
    if (!patientSearchTerm || !clinicId || patientSearchTerm.length !== 10) {
      toast({ variant: "destructive", title: "Invalid Phone Number", description: "Please enter a 10-digit phone number to send a link." });
      return;
    }
    const fullPhoneNumber = `+91${patientSearchTerm}`;

    setIsSendingLink(true);
    try {
      const usersRef = collection(db, 'users');
      const userQuery = query(
        usersRef,
        where('phone', '==', fullPhoneNumber),
        where('role', '==', 'patient')
      );

      const userSnapshot = await getDocs(userQuery).catch(async (serverError) => {
        const permissionError = new FirestorePermissionError({
          path: 'users',
          operation: 'list',
        });
        errorEmitter.emit('permission-error', permissionError);
        throw serverError;
      });

      // Check if user already exists
      if (!userSnapshot.empty) {
        // User exists, check if patient exists and add clinicId to clinicIds array
        const existingUser = userSnapshot.docs[0].data() as User;
        const patientId = existingUser.patientId;

        if (patientId) {
          const patientRef = doc(db, 'patients', patientId);
          const patientDoc = await getFirestoreDoc(patientRef);

          if (patientDoc.exists()) {
            const patientData = patientDoc.data() as Patient;
            const clinicIds = patientData.clinicIds || [];

            // Only update if clinicId is not already in the array
            if (!clinicIds.includes(clinicId)) {
              await updateDoc(patientRef, {
                clinicIds: arrayUnion(clinicId),
                updatedAt: serverTimestamp(),
              }).catch(async (serverError) => {
                console.error("Error updating patient clinicIds:", serverError);
                // Continue with sending link even if update fails
              });
            }
          }
        }
      } else {
        // User doesn't exist, create new user and patient records
        const batch = writeBatch(db);
        const newUserRef = doc(collection(db, 'users'));
        const newPatientRef = doc(collection(db, 'patients'));

        const newUserData: Pick<User, 'uid' | 'phone' | 'role' | 'patientId'> = {
          uid: newUserRef.id,
          phone: fullPhoneNumber,
          role: 'patient',
          patientId: newPatientRef.id,
        };
        batch.set(newUserRef, newUserData);

        const newPatientData: Partial<Patient> = {
          id: newPatientRef.id,
          primaryUserId: newUserRef.id,
          phone: fullPhoneNumber,
          communicationPhone: fullPhoneNumber,
          name: "",
          place: "",
          email: "",
          clinicIds: [clinicId],
          totalAppointments: 0,
          visitHistory: [],
          relatedPatientIds: [],
          isPrimary: true,
          isKloqoMember: false,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        };
        // Remove undefined values - Firestore doesn't allow undefined
        const cleanedPatientData = Object.fromEntries(
          Object.entries(newPatientData).filter(([_, v]) => v !== undefined)
        ) as Partial<Patient>;
        batch.set(newPatientRef, cleanedPatientData);

        await batch.commit().catch(async (serverError) => {
          const permissionError = new FirestorePermissionError({
            path: 'users or patients',
            operation: 'create',
            requestResourceData: { user: newUserData, patient: newPatientData }
          });
          errorEmitter.emit('permission-error', permissionError);
          throw serverError;
        });
      }

      // Send WhatsApp message with booking link
      const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'https://app.kloqo.com';
      const clinicName = clinicDetails?.name || 'the clinic';
      const bookingLink = `${baseUrl}/clinics/${clinicId}`;
      const message = `Your request for appointment is received in '${clinicName}'. Use this link to complete the booking: ${bookingLink}`;

      try {
        const response = await fetch('/api/send-sms', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            to: fullPhoneNumber,
            message: message,
            channel: linkChannel
          }),
        });

        const result = await response.json();

        if (result.success) {
          const isNewUser = userSnapshot.empty;
          toast({
            title: "Link Sent Successfully",
            description: `A booking link has been sent to ${fullPhoneNumber}.${isNewUser ? ' New user and patient records created.' : ''}`
          });
        } else {
          toast({
            variant: "destructive",
            title: "Failed to Send Link",
            description: result.error || "Could not send the booking link."
          });
        }
      } catch (smsError) {
        console.error("Error sending WhatsApp message:", smsError);
        const isNewUser = userSnapshot.empty;
        toast({
          title: isNewUser ? "Records Created" : "WhatsApp Failed",
          description: isNewUser
            ? `User and patient records created, but failed to send WhatsApp message to ${fullPhoneNumber}.`
            : `Failed to send WhatsApp message to ${fullPhoneNumber}.`
        });
      }

      setPatientSearchTerm('');

    } catch (error: any) {
      if (error.name !== 'FirestorePermissionError') {
        console.error("Error in send link flow:", error);
        toast({ variant: 'destructive', title: 'Error', description: 'Could not complete the action.' });
      }
    } finally {
      setIsSendingLink(false);
    }
  };

  const handleCancel = (appointment: Appointment) => {
    startTransition(async () => {
      try {
        const appointmentRef = doc(db, "appointments", appointment.id);
        await updateDoc(appointmentRef, { status: 'Cancelled' });

        // Note: Bucket count is now calculated on-the-fly from appointments
        // No need to update Firestore - the bucket count will be automatically recalculated
        // when the next walk-in booking happens

        // Send cancellation notification
        try {
          const clinicDoc = await getFirestoreDoc(doc(db, 'clinics', appointment.clinicId));
          const clinicName = clinicDoc.data()?.name || 'The clinic';

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
        } catch (notifError) {
          console.error('Failed to send cancellation notification:', notifError);
          // Don't fail the cancellation if notification fails
        }

        toast({ title: "Appointment Cancelled" });
      } catch (error) {
        console.error("Error cancelling appointment:", error);
        toast({ variant: "destructive", title: "Error", description: "Failed to cancel appointment." });
      }
    });
  };

  const handleComplete = async (appointment: Appointment) => {
    startTransition(async () => {
      try {
        const appointmentRef = doc(db, "appointments", appointment.id);
        const appointmentDoctor = doctors.find(d => d.name === appointment.doctor);
        const now = new Date();

        // Calculate delay if consultation took longer than average time
        let delayMinutes = 0;
        if (appointmentDoctor) {
          try {
            const { parseTime } = await import('@/lib/utils');
            const appointmentDate = parse(appointment.date, 'd MMMM yyyy', new Date());
            const appointmentTime = parseTime(appointment.time, appointmentDate);
            const averageConsultingTime = appointmentDoctor.averageConsultingTime || 15;

            // Calculate actual consultation duration (from appointment time to now)
            const actualDuration = differenceInMinutes(now, appointmentTime);

            // If actual duration exceeds average time, calculate delay
            if (actualDuration > averageConsultingTime) {
              delayMinutes = actualDuration - averageConsultingTime;
            }
          } catch (delayCalcError) {
            console.error('Error calculating delay:', delayCalcError);
            // Don't fail the completion if delay calculation fails
          }
        }

        await updateDoc(appointmentRef, {
          status: 'Completed',
          completedAt: serverTimestamp()
        });

        // Increment consultation counter
        try {
          if (appointmentDoctor && appointment.sessionIndex !== undefined) {
            const { incrementConsultationCounter } = await import('@kloqo/shared-core');
            await incrementConsultationCounter(
              appointment.clinicId,
              appointmentDoctor.id,
              appointment.date,
              appointment.sessionIndex
            );
          }
        } catch (counterError) {
          console.error('Error incrementing consultation counter:', counterError);
          // Don't fail the completion if counter update fails
        }

        // Send notifications to next patients when appointment is completed
        try {
          const { notifyNextPatientsWhenCompleted } = await import('@kloqo/shared-core');
          const clinicDoc = await getFirestoreDoc(doc(db, 'clinics', appointment.clinicId));
          const clinicName = clinicDoc.data()?.name || 'The clinic';

          await notifyNextPatientsWhenCompleted({
            firestore: db,
            completedAppointmentId: appointment.id,
            completedAppointment: appointment,
            clinicName,
          });
          console.log('Notifications sent to next patients in queue');
        } catch (notifError) {
          console.error('Failed to send notifications to next patients:', notifError);
          // Don't fail the completion if notification fails
        }

        toast({
          title: "Appointment Marked as Completed",
          description: delayMinutes > 0 ? `Consultation exceeded the average by ${delayMinutes} minute${delayMinutes === 1 ? "" : "s"}.` : undefined
        });
      } catch (error) {
        console.error("Error completing appointment:", error);
        toast({ variant: "destructive", title: "Error", description: "Failed to mark as completed." });
      }
    });
  };

  const handleSkip = async (appointment: Appointment) => {
    startTransition(async () => {
      try {
        const skippedSlotIndex = appointment.slotIndex ?? -1;
        if (skippedSlotIndex < 0) {
          throw new Error('Invalid appointment slot index');
        }

        const appointmentRef = doc(db, "appointments", appointment.id);
        const todayStr = format(new Date(), 'd MMMM yyyy');

        // Find all appointments with slotIndex > skippedSlotIndex that need to be shifted backwards
        const appointmentsToShift = appointments.filter(a => {
          const slotIdx = a.slotIndex ?? -1;
          return slotIdx > skippedSlotIndex &&
            a.doctor === appointment.doctor &&
            a.date === todayStr &&
            (a.status === 'Pending' || a.status === 'Confirmed');
        });

        // Step 1: Mark as skipped with timestamp
        await updateDoc(appointmentRef, {
          status: 'Skipped',
          skippedAt: serverTimestamp()
        });

        // Step 2: Shift subsequent appointments backwards (slotIndex - 1) using batch
        if (appointmentsToShift.length > 0) {
          const batch = writeBatch(db);
          for (const apt of appointmentsToShift) {
            const aptRef = doc(db, 'appointments', apt.id);
            batch.update(aptRef, {
              slotIndex: (apt.slotIndex ?? 0) - 1,
              updatedAt: serverTimestamp()
            });
          }
          await batch.commit();
        }

        toast({ title: "Appointment Skipped", description: "Subsequent appointments have been shifted backwards to fill the gap." });
      } catch (error) {
        console.error("Error skipping appointment:", error);
        toast({ variant: "destructive", title: "Error", description: "Failed to skip appointment." });
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
        const appointmentRef = doc(db, 'appointments', appointment.id);
        await updateDoc(appointmentRef, {
          status: 'Confirmed'
        });

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

      const recurrence = clinicDetails?.skippedTokenRecurrence || 3;
      const today = new Date();
      const todayStr = format(today, 'd MMMM yyyy');

      try {
        // Helper function to parse appointment time
        const parseAppointmentTime = (apt: Appointment): Date => {
          try {
            const appointmentDate = parse(apt.date, 'd MMMM yyyy', new Date());
            return parseTime(apt.time, appointmentDate);
          } catch {
            return new Date(0); // Fallback for invalid dates
          }
        };

        // Get skipped appointment's original time
        const skippedOriginalTime = parseAppointmentTime(appointment);

        // Get arrived queue: Confirmed appointments for same doctor and date, sorted by time
        const arrivedQueue = appointments
          .filter(a =>
            a.doctor === appointment.doctor &&
            a.date === todayStr &&
            a.status === 'Confirmed' &&
            a.id !== appointment.id // Exclude the skipped appointment itself
          )
          .sort((a, b) => {
            const timeA = parseAppointmentTime(a);
            const timeB = parseAppointmentTime(b);
            return timeA.getTime() - timeB.getTime();
          });

        // Filter confirmed appointments to only those that come AFTER skipped appointment's original time
        const appointmentsAfterSkipped = arrivedQueue.filter(a => {
          const appointmentTime = parseAppointmentTime(a);
          return appointmentTime.getTime() > skippedOriginalTime.getTime();
        });

        // Calculate base time based on skippedTokenRecurrence using filtered list
        let baseTime: Date;
        if (appointmentsAfterSkipped.length >= recurrence) {
          // Use the time of the appointment at position 'recurrence' (0-indexed: recurrence - 1) in filtered list
          const referenceAppointment = appointmentsAfterSkipped[recurrence - 1];
          baseTime = parseAppointmentTime(referenceAppointment);
        } else if (appointmentsAfterSkipped.length > 0) {
          // Use the time of the last appointment in filtered list
          const lastAppointment = appointmentsAfterSkipped[appointmentsAfterSkipped.length - 1];
          baseTime = parseAppointmentTime(lastAppointment);
        } else if (arrivedQueue.length > 0) {
          // No appointments after skipped time, use the last appointment in arrived queue
          const lastAppointment = arrivedQueue[arrivedQueue.length - 1];
          baseTime = parseAppointmentTime(lastAppointment);
        } else {
          // Arrived queue is empty, use current time + 1 minute
          baseTime = addMinutes(today, 1);
        }

        // Add 1 minute to base time
        let newTime = addMinutes(baseTime, 1);

        // Check for existing rejoined appointments (status='Confirmed' AND has skippedAt field)
        const rejoinedAppointments = appointments
          .filter(a =>
            a.doctor === appointment.doctor &&
            a.date === todayStr &&
            a.status === 'Confirmed' &&
            a.skippedAt && // Only appointments that were previously skipped
            a.id !== appointment.id
          )
          .sort((a, b) => {
            // Sort by time (descending) to get the latest
            const timeA = parseAppointmentTime(a);
            const timeB = parseAppointmentTime(b);
            return timeB.getTime() - timeA.getTime();
          });

        // If there are existing rejoined appointments, use the latest one's time + 1 minute
        if (rejoinedAppointments.length > 0) {
          const latestRejoined = rejoinedAppointments[0];
          const latestRejoinedTime = parseAppointmentTime(latestRejoined);
          newTime = addMinutes(latestRejoinedTime, 1);
        }

        // Format the new time
        const newTimeString = format(newTime, 'hh:mm a');

        // Update the skipped appointment: only change status and time, keep everything else
        const appointmentRef = doc(db, 'appointments', appointment.id);
        await updateDoc(appointmentRef, {
          status: 'Confirmed',
          time: newTimeString,
          updatedAt: serverTimestamp()
        });

        toast({
          title: "Patient Re-joined Queue",
          description: `${appointment.patientName} has been added back to the queue at position after ${recurrence} patient(s).`
        });
      } catch (error: any) {
        console.error("Error re-joining queue:", error);
        const errorMessage = error?.message || "Could not re-join the patient to the queue.";
        toast({
          variant: "destructive",
          title: "Error",
          description: errorMessage
        });
      }
    });
  };

  const handleDelete = async (appointmentId: string) => {
    startTransition(async () => {
      try {
        await deleteDoc(doc(db, "appointments", appointmentId));
        toast({ title: "Success", description: "Appointment deleted successfully." });
      } catch (error) {
        console.error("Error deleting appointment: ", error);
        if (!(error instanceof FirestorePermissionError)) {
          toast({ variant: "destructive", title: "Error", description: "Failed to delete appointment." });
        }
      }
    });
  };

  const onDoctorChange = (doctorId: string) => {
    form.setValue("doctor", doctorId, { shouldValidate: true, shouldDirty: true });
    const doctor = doctors.find(d => d.id === doctorId);
    if (doctor) {
      form.setValue("department", doctor.department || "", { shouldValidate: true, shouldDirty: true });
      const upcomingDate = getNextAvailableDate(doctor);
      form.setValue("date", upcomingDate, { shouldValidate: true, shouldDirty: true });
      form.setValue("time", "", { shouldValidate: true });
      form.clearErrors(['doctor', 'department']);
      form.trigger(['doctor', 'department']);
    }
  };

  const handlePatientSelect = async (patient: Patient) => {
    setSelectedPatient(patient);
    setPrimaryPatient(patient);
    setBookingFor('member');
    setRelatives([]);
    setHasSelectedOption(true);

    const capitalizedSex = patient.sex ? (patient.sex.charAt(0).toUpperCase() + patient.sex.slice(1).toLowerCase()) : undefined;

    form.reset({
      ...form.getValues(),
      patientId: patient.id,
      patientName: patient.name,
      age: patient.age ?? undefined,
      sex: capitalizedSex as "Male" | "Female" | "Other" | undefined,
      phone: patient.communicationPhone?.replace('+91', ''),
      place: patient.place || "",
    });

    if (patient.relatedPatientIds && patient.relatedPatientIds.length > 0) {
      const relativePromises = patient.relatedPatientIds.map(id => getFirestoreDoc(doc(db, 'patients', id)));
      const relativeDocs = await Promise.all(relativePromises);
      const fetchedRelatives = relativeDocs
        .filter(doc => doc.exists())
        .map(doc => ({ id: doc.id, ...doc.data() } as Patient));
      setRelatives(fetchedRelatives);
    }

    setPatientSearchTerm(patient.phone.replace('+91', ''));
    setIsPatientPopoverOpen(false);
  };

  const handleRelativeSelect = (relative: Patient) => {
    setBookingFor('relative');
    setSelectedPatient(relative);
    setHasSelectedOption(true);
    const capitalizedSex = relative.sex ? (relative.sex.charAt(0).toUpperCase() + relative.sex.slice(1).toLowerCase()) : undefined;
    form.reset({
      ...form.getValues(),
      patientId: relative.id,
      patientName: relative.name,
      age: relative.age ?? undefined,
      sex: capitalizedSex as "Male" | "Female" | "Other" | undefined,
      phone: (relative.communicationPhone || primaryPatient?.communicationPhone)?.replace('+91', ''),
      place: relative.place || "",
    });
    toast({ title: `Selected Relative: ${relative.name}`, description: "You are now booking an appointment for the selected relative." });
  };

  const handleNewRelativeAdded = (newRelative: Patient) => {
    setRelatives(prev => [...prev, newRelative]);
    handleRelativeSelect(newRelative);
  };

  const handlePatientSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value.replace(/\D/g, '');
    if (selectedPatient && value !== selectedPatient.phone.replace('+91', '')) {
      resetForm();
    }
    setPatientSearchTerm(value);
  };

  const availableDaysOfWeek = useMemo(() => {
    if (!selectedDoctor?.availabilitySlots) return [];
    const dayNames = selectedDoctor.availabilitySlots.map(s => s.day);
    return daysOfWeek.reduce((acc, day, index) => {
      if (dayNames.includes(day)) {
        acc.push(index);
      }
      return acc;
    }, [] as number[]);
  }, [selectedDoctor]);

  const leaveDates = useMemo(() => {
    return [] as Date[];
  }, []);

  const isAdvanceCapacityReached = useMemo(() => {
    if (!selectedDoctor || appointmentType !== 'Advanced Booking' || !selectedDate) {
      return false;
    }
    return isDoctorAdvanceCapacityReachedOnDate(selectedDoctor, selectedDate, appointments, { isEditing, editingAppointment });
  }, [selectedDoctor, selectedDate, appointments, appointmentType, isEditing, editingAppointment]);

  useEffect(() => {
    if (appointmentType !== 'Advanced Booking') {
      return;
    }
    if (isAdvanceCapacityReached) {
      form.setValue('time', '', { shouldValidate: true });
    }
    if (
      isAdvanceCapacityReached &&
      selectedDoctor &&
      selectedDate
    ) {
      const maxLookAheadDays = 90;
      for (let offset = 1; offset <= maxLookAheadDays; offset++) {
        const candidate = addDays(selectedDate, offset);
        const dayName = format(candidate, 'EEEE');
        const availability = selectedDoctor.availabilitySlots?.find(
          slot => slot.day === dayName && slot.timeSlots?.length
        );
        if (!availability) {
          continue;
        }
        const capacityReached = isDoctorAdvanceCapacityReachedOnDate(
          selectedDoctor,
          candidate,
          appointments,
          { isEditing, editingAppointment }
        );
        if (!capacityReached) {
          form.setValue('date', candidate, { shouldValidate: true });
          break;
        }
      }
    }
  }, [
    appointmentType,
    isAdvanceCapacityReached,
    selectedDoctor,
    selectedDate,
    appointments,
    isEditing,
    editingAppointment,
    form,
  ]);

  // Helper function to get display time with break offsets
  const getDisplayTimeForAppointment = useCallback((appointment: Appointment): string => {
    try {
      const appointmentDate = parse(appointment.date, "d MMMM yyyy", new Date());
      const appointmentTime = parseDateFns(appointment.time, "hh:mm a", appointmentDate);
      const appointmentDoctor = doctors.find(d => d.name === appointment.doctor);

      const isWalkIn = appointment.tokenNumber?.startsWith('W') || appointment.bookedVia === 'Walk-in';

      if (appointmentDoctor && appointment.sessionIndex !== undefined) {
        // Use session-specific breaks for this appointment's session
        const sessionBreakIntervals = getSessionBreakIntervals(
          appointmentDoctor,
          appointmentDate,
          appointment.sessionIndex
        );
        const adjustedTime = sessionBreakIntervals.length > 0
          ? applySessionBreakOffsets(appointmentTime, sessionBreakIntervals)
          : appointmentTime;

        // Subtract 15 minutes for 'A' tokens, keep raw for 'W' tokens
        const finalTime = isWalkIn ? adjustedTime : subMinutes(adjustedTime, 15);
        return format(finalTime, 'hh:mm a');
      }

      // Fallback to old logic if sessionIndex is not available
      if (appointmentDoctor) {
        const breakIntervals = buildBreakIntervals(appointmentDoctor, appointmentDate);
        const adjustedTime = breakIntervals.length > 0
          ? applyBreakOffsets(appointmentTime, breakIntervals)
          : appointmentTime;

        // Subtract 15 minutes for 'A' tokens, keep raw for 'W' tokens
        const finalTime = isWalkIn ? adjustedTime : subMinutes(adjustedTime, 15);
        return format(finalTime, 'hh:mm a');
      }

      // Default fallback
      const finalTime = isWalkIn ? appointmentTime : subMinutes(appointmentTime, 15);
      return format(finalTime, 'hh:mm a');
    } catch (error) {
      console.error("Error formatting time:", error);
      return appointment.time;
    }
  }, [doctors]);

  const sessionSlots = useMemo(() => {
    if (appointmentType === 'Advanced Booking' && isAdvanceCapacityReached) {
      return [];
    }
    if (!selectedDate || !selectedDoctor || !selectedDoctor.averageConsultingTime) {
      return [];
    }

    const dayOfWeek = daysOfWeek[getDay(selectedDate)];
    const availabilityForDay = selectedDoctor.availabilitySlots?.find(s => s.day === dayOfWeek);
    if (!availabilityForDay) return [];

    const formattedDate = format(selectedDate, "d MMMM yyyy");
    const otherAppointments = appointments.filter(apt => !(isEditing && apt.id === editingAppointment?.id));

    // Only consider Pending and Confirmed appointments as "booked"
    // No-show, Skipped, Completed, and Cancelled slots are available for reuse
    const bookedSlotsForDay = otherAppointments
      .filter(apt =>
        apt.doctor === selectedDoctor.name &&
        apt.date === formattedDate &&
        (apt.status === 'Pending' || apt.status === 'Confirmed' || apt.status === 'Completed')
      )
      .reduce((acc, apt) => {
        acc[apt.time] = apt.tokenNumber || apt.time; // Map time to token number
        return acc;
      }, {} as Record<string, string>);


    // Calculate per-session reserved slots (15% of FUTURE slots only in each session)
    // This dynamically adjusts as time passes - reserved slots are recalculated based on remaining future slots
    const reservedSlotsBySession = new Map<number, Set<number>>();
    const slotDuration = selectedDoctor.averageConsultingTime || 15;
    const now = currentTime; // Use current time to filter past slots
    let globalSlotIndex = 0;
    const bookedGlobalIndices = new Set<number>(
      otherAppointments
        .filter(apt =>
          apt.doctor === selectedDoctor.name &&
          apt.date === formattedDate &&
          (apt.status === 'Pending' || apt.status === 'Confirmed' || apt.status === 'Completed') &&
          typeof apt.slotIndex === 'number'
        )
        .map(apt => apt.slotIndex as number)
    );

    availabilityForDay.timeSlots.forEach((session, sessionIndex) => {
      let currentTime = parseDateFns(session.from, 'hh:mm a', selectedDate);
      const sessionEnd = parseDateFns(session.to, 'hh:mm a', selectedDate);
      const allSessionSlots: Array<{ time: Date; globalIndex: number }> = [];

      // Get session-specific breaks and effective end time for filtering
      const sessionBreakIntervals = getSessionBreakIntervals(selectedDoctor, selectedDate, sessionIndex);
      const sessionEffectiveEnd = getSessionEnd(selectedDoctor, selectedDate, sessionIndex) || parseDateFns(session.to, 'hh:mm a', selectedDate);

      // First, collect all slots with their times
      // Use sessionEffectiveEnd to include extended slots in the base calculation
      while (isBefore(currentTime, sessionEffectiveEnd)) {
        const slotTime = new Date(currentTime);
        allSessionSlots.push({ time: slotTime, globalIndex: globalSlotIndex });
        globalSlotIndex++;
        currentTime = addMinutes(currentTime, slotDuration);
      }

      // Future free slots (not booked) for reserve calculation
      let futureFreeSlots = allSessionSlots.filter(slot => {
        const isFuture = isAfter(slot.time, now) || slot.time.getTime() >= now.getTime();
        const isBooked = bookedGlobalIndices.has(slot.globalIndex);
        return isFuture && !isBooked;
      });

      // Filter out slots that would exceed session end after break adjustments
      // This ensures reserved slots are calculated only from slots that would actually be available for A-token booking
      futureFreeSlots = futureFreeSlots.filter(slot => {
        const adjustedTime = sessionBreakIntervals.length > 0
          ? applySessionBreakOffsets(slot.time, sessionBreakIntervals)
          : slot.time;
        const appointmentEndTime = addMinutes(adjustedTime, slotDuration);
        return appointmentEndTime <= sessionEffectiveEnd;
      });



      if (futureFreeSlots.length > 0) {
        const futureSlotCount = futureFreeSlots.length;
        const sessionMinimumWalkInReserve = Math.ceil(futureSlotCount * 0.15);
        const reservedWSlotsStart = futureSlotCount - sessionMinimumWalkInReserve;
        const reservedSlots = new Set<number>();

        // Mark the last 15% of FUTURE FREE slots as reserved
        for (let i = reservedWSlotsStart; i < futureSlotCount; i++) {
          reservedSlots.add(futureFreeSlots[i].globalIndex);
        }



        reservedSlotsBySession.set(sessionIndex, reservedSlots);
      } else {
        // No future free slots, no reserved slots

        reservedSlotsBySession.set(sessionIndex, new Set<number>());
      }
    });

    // Session-based break handling: each session has its own breaks and extensions

    const sessions = availabilityForDay.timeSlots.map((session, sessionIndex) => {
      const slots = [];

      let slotTimeIterator = parseDateFns(session.from, 'hh:mm a', selectedDate);
      const sessionOriginalEnd = parseDateFns(session.to, 'hh:mm a', selectedDate);

      // Get session-specific breaks and effective end time
      const sessionBreaks = getSessionBreaks(selectedDoctor, selectedDate, sessionIndex);
      const sessionBreakIntervals = getSessionBreakIntervals(selectedDoctor, selectedDate, sessionIndex);
      const sessionEffectiveEnd = getSessionEnd(selectedDoctor, selectedDate, sessionIndex) || sessionOriginalEnd;



      // Use currentTime state which updates every minute, not a static new Date()
      const now = currentTime;

      let totalSlotsGenerated = 0;
      let pastSlotsSkipped = 0;
      let oneHourWindowSlotsSkipped = 0;
      let bookedSlotsCount = 0;
      let availableSlotsCount = 0;
      let reservedSlotsSkipped = 0;

      // Get reserved slots for this session (these are global slot indices)
      const sessionReservedSlots = reservedSlotsBySession.get(sessionIndex) || new Set<number>();
      let currentSlotIndexInSession = 0;

      // Calculate the starting global slot index for this session
      let sessionStartGlobalIndex = 0;
      for (let i = 0; i < sessionIndex; i++) {
        let sessionTime = parseDateFns(availabilityForDay.timeSlots[i].from, 'hh:mm a', selectedDate);
        const sessionEnd = parseDateFns(availabilityForDay.timeSlots[i].to, 'hh:mm a', selectedDate);
        while (isBefore(sessionTime, sessionEnd)) {
          sessionStartGlobalIndex++;
          sessionTime = addMinutes(sessionTime, slotDuration);
        }
      }

      while (slotTimeIterator < sessionEffectiveEnd) {
        totalSlotsGenerated++;
        const slotTime = format(slotTimeIterator, "hh:mm a");

        let status: 'available' | 'booked' | 'leave' = 'available';

        // Debug all slots
        console.log(`[SLOT DEBUG] Checking slot ${slotTime}`, {
          sessionIndex,
          slotTime,
          status,
          isBeforeNow: isBefore(slotTimeIterator, now),
          isOneHourSkipped: isToday(selectedDate) && appointmentType === 'Advanced Booking' && !isAfter(slotTimeIterator, addMinutes(now, 60)),
          isWinReserved: sessionReservedSlots.has(sessionStartGlobalIndex + currentSlotIndexInSession),
          globalIndex: sessionStartGlobalIndex + currentSlotIndexInSession,
          isLeave: isSlotBlockedByLeave(selectedDoctor, slotTimeIterator)
        });


        // Skip past slots - don't show slots that are in the past
        if (isBefore(slotTimeIterator, now)) {
          pastSlotsSkipped++;
          currentSlotIndexInSession++;
          slotTimeIterator = new Date(slotTimeIterator.getTime() + selectedDoctor.averageConsultingTime! * 60000);
          continue;
        }

        // For advance bookings, skip slots reserved for walk-ins (last 15% of each session)
        // Note: We don't filter out walk-in reserved slots here for Advanced Booking display
        // The reservation is enforced during the actual booking transaction
        // This matches the behavior of Patient and Nurse apps

        // Note: We don't check for leave here because:
        // 1. Breaks are handled separately through break offset logic
        // 2. Actual leave days would make the entire session unavailable
        // 3. The isSlotBlockedByLeave function was incorrectly treating breaks as leave

        // For same-day bookings, skip slots within 1-hour window from current time
        // Slots within 1 hour are reserved for W tokens only - don't show them for A tokens
        if (isToday(selectedDate) && appointmentType === 'Advanced Booking') {
          const slotDateTime = slotTimeIterator; // Current slot time
          const oneHourFromNow = addMinutes(now, 60);

          // Skip slot if it's within 1 hour from now (reserved for walk-in tokens)
          // Check: slot time must be AFTER oneHourFromNow (not equal or before)
          if (!isAfter(slotDateTime, oneHourFromNow)) {
            oneHourWindowSlotsSkipped++;
            slotTimeIterator = new Date(slotTimeIterator.getTime() + selectedDoctor.averageConsultingTime! * 60000);
            continue; // Skip this slot entirely
          }
        }

        // Check if slot is blocked by leave/break
        if (isSlotBlockedByLeave(selectedDoctor, slotTimeIterator)) {
          // console.log(`[SLOT DEBUG] Slot ${slotTime} is BLOCKED by leave/break, skipping`);
          currentSlotIndexInSession++;
          slotTimeIterator = new Date(slotTimeIterator.getTime() + selectedDoctor.averageConsultingTime! * 60000);
          continue;
        }

        // Note: Break offsets are NOT used for slot display filtering
        // They are only used for calculating arriveByTime, cutOffTime, noShowTime in the booking logic
        // Slots are displayed based on their original time, not adjusted time

        if (slotTime in bookedSlotsForDay) {
          status = 'booked';
          bookedSlotsCount++;
          console.log(`[SLOT DEBUG] Slot ${slotTime} is BOOKED, skipping`);
        } else {
          availableSlotsCount++;
        }

        if (status === 'available') {
          console.log(`[SLOT DEBUG] Pushing available slot ${format(slotTimeIterator, 'hh:mm a')}`);
          const slotTimeString = format(slotTimeIterator, 'hh:mm a');
          const slotIndex = otherAppointments.find(appointment => appointment.time === slotTimeString)?.slotIndex;
          const isCancelledSlot =
            typeof slotIndex === 'number' &&
            otherAppointments.some(appointment => appointment.slotIndex === slotIndex && appointment.status === 'Cancelled');

          slots.push({
            time: slotTime,
            status,
            slotIndex,
            isCancelled: isCancelledSlot,
          });

          // For Clinic Admin, only show the first available slot per session
          break;
        }

        currentSlotIndexInSession++;
        slotTimeIterator = new Date(slotTimeIterator.getTime() + selectedDoctor.averageConsultingTime! * 60000);
      }

      // Display session-specific breaks in title (only show breaks that haven't ended yet)
      const displaySessionStart = format(subMinutes(parseDateFns(session.from, 'hh:mm a', selectedDate), 15), 'hh:mm a');
      const displaySessionEnd = format(subMinutes(parseDateFns(session.to, 'hh:mm a', selectedDate), 15), 'hh:mm a');
      let sessionTitle = `Session ${sessionIndex + 1} (${displaySessionStart} - ${displaySessionEnd})`;
      if (sessionBreaks.length > 0) {
        // Filter out breaks that have already ended
        const activeBreaks = sessionBreaks.filter(bp => {
          try {
            const breakEnd = parseDateFns(bp.endTimeFormatted, 'hh:mm a', selectedDate);
            return isAfter(breakEnd, now) || breakEnd.getTime() >= now.getTime();
          } catch {
            return true; // If parsing fails, show the break
          }
        });

        if (activeBreaks.length > 0) {
          const breakTexts = activeBreaks.map(bp => {
            return `${bp.startTimeFormatted} - ${bp.endTimeFormatted}`;
          });
          sessionTitle += ` [Break: ${breakTexts.join(', ')}]`;
        }
      }

      // Show extension info if session was extended
      if (sessionEffectiveEnd.getTime() > sessionOriginalEnd.getTime()) {
        const extensionMinutes = differenceInMinutes(sessionEffectiveEnd, sessionOriginalEnd);
        sessionTitle += ` [Extended by ${extensionMinutes} min]`;
      }

      return { title: sessionTitle, slots };
    });

    const res = sessions.filter(s => s.slots.length > 0);
    console.log('[DEBUG] Session Slots computed:', {
      isAdvanceCapacityReached,
      sessionsCount: sessions.length,
      slotsCount: res.length,
      firstSessionSlots: sessions[0]?.slots.length
    });
    return res;
  }, [selectedDate, selectedDoctor, appointments, isEditing, editingAppointment, appointmentType, currentTime, isAdvanceCapacityReached]);

  const isAppointmentOnLeave = (appointment: Appointment): boolean => {
    if (!doctors.length || !appointment) return false;
    const doctorForApt = doctors.find(d => d.name === appointment.doctor);
    if (!doctorForApt?.breakPeriods) return false;

    const dateKey = appointment.date; // Already in 'd MMMM yyyy' format
    const breaks = doctorForApt.breakPeriods[dateKey] || [];

    if (breaks.length === 0) return false;

    try {
      const aptDate = parse(appointment.date, "d MMMM yyyy", new Date());
      const aptTime = parseDateFns(appointment.time, "hh:mm a", aptDate);

      return breaks.some((bp: any) => {
        const breakStart = parseDateFns(bp.startTime, "hh:mm a", aptDate);
        const breakEnd = parseDateFns(bp.endTime, "hh:mm a", aptDate);
        return aptTime >= breakStart && aptTime < breakEnd;
      });
    } catch {
      return false;
    }
  };

  const filteredAppointments = useMemo(() => {
    const searchTermLower = drawerSearchTerm.toLowerCase();
    let filtered = appointments;

    if (drawerDateRange && (drawerDateRange.from || drawerDateRange.to)) {
      filtered = filtered.filter(apt => {
        try {
          const aptDate = parse(apt.date, 'd MMMM yyyy', new Date());
          const from = drawerDateRange.from ? new Date(drawerDateRange.from.setHours(0, 0, 0, 0)) : null;
          const to = drawerDateRange.to ? new Date(drawerDateRange.to.setHours(23, 59, 59, 999)) : null;
          if (from && to) return aptDate >= from && aptDate <= to;
          if (from) return aptDate >= from;
          if (to) return aptDate <= to;
          return true;
        } catch {
          return true;
        }
      });
    }

    if (selectedDrawerDoctor && selectedDrawerDoctor !== 'all') {
      filtered = filtered.filter(apt => apt.doctor === selectedDrawerDoctor);
    }

    if (searchTermLower) {
      filtered = filtered.filter(apt =>
        apt.patientName.toLowerCase().includes(searchTermLower) ||
        apt.doctor.toLowerCase().includes(searchTermLower) ||
        apt.department.toLowerCase().includes(searchTermLower)
      );
    }

    if (activeTab === 'upcoming') {
      filtered = filtered.filter(apt => {
        try {
          const aptDate = parse(apt.date, 'd MMMM yyyy', new Date());
          // Show Pending, Skipped, and Confirmed appointments for today and future dates
          return (apt.status === 'Pending' || apt.status === 'Skipped' || apt.status === 'Confirmed') && (isFuture(aptDate) || isToday(aptDate));
        } catch (e) {
          return false;
        }
      });
    } else if (activeTab === 'completed') {
      filtered = filtered.filter(apt => apt.status === 'Completed' || apt.status === 'Cancelled');
    } else if (activeTab === 'no-show') {
      filtered = filtered.filter(apt => apt.status === 'No-show');
    } else if (activeTab !== 'all') {
      filtered = filtered.filter(apt => apt.status.toLowerCase() === activeTab);
    }

    return filtered.sort((a, b) => {
      try {
        const dateA = new Date(`${a.date} ${a.time}`).getTime();
        const dateB = new Date(`${b.date} ${b.time}`).getTime();
        return dateA - dateB;
      } catch (e) {
        return 0;
      }
    });
  }, [appointments, drawerSearchTerm, activeTab, drawerDateRange, selectedDrawerDoctor]);

  const today = format(new Date(), "d MMMM yyyy");

  // Compute queues for each doctor/session combination
  const [queuesByDoctor, setQueuesByDoctor] = useState<Record<string, QueueState>>({});

  useEffect(() => {
    const computeAllQueues = async () => {
      if (!clinicId || !doctors.length) return;

      const filteredForToday = filteredAppointments.filter(apt => apt.date === today);
      const queues: Record<string, QueueState> = {};

      // Group appointments by doctor
      const appointmentsByDoctor = filteredForToday.reduce((acc, apt) => {
        if (!acc[apt.doctor]) {
          acc[apt.doctor] = [];
        }
        acc[apt.doctor].push(apt);
        return acc;
      }, {} as Record<string, Appointment[]>);

      // Compute queues for each doctor (using first session for now, or we can compute per session)
      for (const [doctorName, doctorAppointments] of Object.entries(appointmentsByDoctor)) {
        const doctor = doctors.find(d => d.name === doctorName);
        if (!doctor) continue;

        // For queue computation, we'll use sessionIndex 0 for now (or compute per session)
        // In a real scenario, we'd compute queues per session
        const sessionIndex = 0; // Default to first session

        try {
          const queueState = await computeQueues(
            doctorAppointments,
            doctorName,
            doctor.id,
            clinicId,
            today,
            sessionIndex
          );

          // Store queue state keyed by doctor name
          queues[doctorName] = queueState;
        } catch (error) {
          console.error(`Error computing queues for ${doctorName}:`, error);
        }
      }

      setQueuesByDoctor(queues);
    };

    computeAllQueues();
  }, [filteredAppointments, today, clinicId, doctors]);

  // Calculate next sessionIndex for each doctor
  const nextSessionIndexByDoctor = useMemo(() => {
    const result = new Map<string, number>();
    const now = currentTime;
    const todayDay = format(now, 'EEEE');

    doctors.forEach(doctor => {
      if (!doctor.availabilitySlots) return;

      const todayAvailability = doctor.availabilitySlots.find(slot => slot.day === todayDay);
      if (!todayAvailability?.timeSlots) return;

      // Find the next session (first session that hasn't ended yet)
      for (let i = 0; i < todayAvailability.timeSlots.length; i++) {
        const session = todayAvailability.timeSlots[i];
        try {
          const sessionStart = parseTime(session.from, now);
          const sessionEnd = parseTime(session.to, now);

          // If current time is before session end, this is the next session
          if (isBefore(now, sessionEnd) || now.getTime() === sessionEnd.getTime()) {
            result.set(doctor.name, i);
            break;
          }
        } catch {
          // Skip if parsing fails
          continue;
        }
      }
    });

    return result;
  }, [doctors, currentTime]);

  const todaysAppointments = useMemo(() => {
    const filteredForToday = filteredAppointments.filter(apt => apt.date === today);
    const skipped = filteredForToday.filter(apt => apt.status === 'Skipped');
    const confirmed = filteredForToday.filter(apt => apt.status === 'Confirmed');

    // Filter Pending to only show appointments from the next sessionIndex for each doctor
    const pending = filteredForToday.filter(apt => {
      if (apt.status !== 'Pending') return false;

      // If appointment doesn't have sessionIndex, include it (for backward compatibility)
      if (apt.sessionIndex === undefined) return true;

      // Get the next sessionIndex for this doctor
      const nextSessionIndex = nextSessionIndexByDoctor.get(apt.doctor);

      // If we couldn't determine next session for this doctor, include the appointment
      if (nextSessionIndex === undefined) return true;

      // Only include if appointment's sessionIndex matches the next sessionIndex
      return apt.sessionIndex === nextSessionIndex;
    });

    const parseTimeForSort = (timeStr: string) => parse(timeStr, "hh:mm a", new Date()).getTime();

    // Sort Confirmed by appointment time
    confirmed.sort((a, b) => {
      const timeA = parseTimeForSort(a.time);
      const timeB = parseTimeForSort(b.time);
      return timeA - timeB;
    });

    // Sort Pending by appointment time
    pending.sort((a, b) => {
      const timeA = parseTimeForSort(a.time);
      const timeB = parseTimeForSort(b.time);
      return timeA - timeB;
    });

    // Return Confirmed at top, then Pending, then Skipped
    return [...confirmed, ...pending, ...skipped];
  }, [filteredAppointments, today, nextSessionIndexByDoctor]);

  // Calculate tab counts separately to ensure they're always available regardless of active tab
  // Count ALL pending and skipped appointments for today from base appointments array
  // Respect selectedDrawerDoctor filter but NOT activeTab filter
  const pendingCount = useMemo(() => {
    let filtered = appointments.filter(apt => apt.date === today && apt.status === 'Pending');

    // Apply doctor filter if selected (but not activeTab filter)
    if (selectedDrawerDoctor && selectedDrawerDoctor !== 'all') {
      filtered = filtered.filter(apt => apt.doctor === selectedDrawerDoctor);
    }

    return filtered.length;
  }, [appointments, today, selectedDrawerDoctor]);

  const skippedCount = useMemo(() => {
    let filtered = appointments.filter(apt => apt.date === today && apt.status === 'Skipped');

    // Apply doctor filter if selected (but not activeTab filter)
    if (selectedDrawerDoctor && selectedDrawerDoctor !== 'all') {
      filtered = filtered.filter(apt => apt.doctor === selectedDrawerDoctor);
    }

    return filtered.length;
  }, [appointments, today, selectedDrawerDoctor]);

  // Get buffer queue for a specific doctor (first 2 from arrived queue)
  const getBufferQueue = (doctorName: string): Appointment[] => {
    const queueState = queuesByDoctor[doctorName];
    if (!queueState) return [];
    return queueState.bufferQueue;
  };

  // Check if appointment is in buffer queue
  const isInBufferQueue = (appointment: Appointment): boolean => {
    const bufferQueue = getBufferQueue(appointment.doctor);
    return bufferQueue.some(apt => apt.id === appointment.id);
  };

  const isNewPatient = patientSearchTerm.length >= 10 && !selectedPatient;
  const isKloqoMember = primaryPatient && !primaryPatient.clinicIds?.includes(clinicId!);

  const isDateDisabled = (date: Date) => {
    if (!selectedDoctor) return true;

    // Walk-ins are only available for today (same day)
    if (appointmentType === 'Walk-in') {
      return !isToday(date);
    }

    const isPastDate = isBefore(date, startOfDay(new Date()));
    const isNotAvailableDay = !availableDaysOfWeek.includes(getDay(date));
    const isOnLeave = leaveDates.some(leaveDate => isSameDay(date, leaveDate));

    // Check for advance booking limit
    const bookingLimit = (selectedDoctor as any).advanceBookingDays || 15;
    // We want to verify if the date is beyond the allowed range (today + limit)
    // Example: limit=15. Today=Dec 1. Max allowed=Dec 16 (Dec 1 + 15 days).
    // Any date AFTER Max allowed should be disabled.
    const maxDate = addDays(startOfDay(new Date()), bookingLimit);
    const isBeyondLimit = isAfter(date, maxDate);

    if (isPastDate || isNotAvailableDay || isOnLeave || isBeyondLimit) {
      return true;
    }

    // Don't disable the date based on 1-hour cutoff - only individual slots within 1 hour will be hidden
    // Booking remains open throughout the day, only slots within 1 hour are hidden

    return false;
  };

  const firstUpcomingDoctor = useMemo(() => {
    if (todaysAppointments.length === 0) return null;
    const firstUpcomingAppointment = todaysAppointments.find(apt => apt.status !== 'Skipped' && (apt.status === 'Confirmed' || apt.status === 'Pending'));
    if (!firstUpcomingAppointment) return null;
    return doctors.find(d => d.name === firstUpcomingAppointment.doctor) || null;
  }, [todaysAppointments, doctors]);

  const isDoctorInConsultation = firstUpcomingDoctor?.consultationStatus === 'In';

  const isBookingButtonDisabled = useMemo(() => {
    if (isPending) return true;
    if (appointmentType === 'Walk-in') {
      return !watchedPatientName || !walkInEstimate || isCalculatingEstimate;
    }
    return !form.formState.isValid || isAdvanceCapacityReached;
  }, [isPending, appointmentType, watchedPatientName, walkInEstimate, isCalculatingEstimate, form.formState.isValid, isAdvanceCapacityReached]);

  return (
    <>
      <div className="flex-1 overflow-auto">
        <main className="p-6">
          <div className={cn("grid gap-6 transition-all duration-300 ease-in-out", isDrawerExpanded ? "grid-cols-1 md:grid-cols-[2fr_auto_10fr]" : "grid-cols-1 md:grid-cols-[8fr_auto_4fr]")}>
            <main>
              <Card>
                <CardHeader>
                  <CardTitle>{isEditing ? "Reschedule Appointment" : "Book New Appointment"}</CardTitle>
                  <CardDescription>
                    {isEditing ? "Update the details for this appointment." : "Fill in the details below to book a new appointment."}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {/* When the right drawer is expanded (isDrawerExpanded === true),
                      the booking card shrinks; hide the full form and show only a CTA button. */}
                  {isDrawerExpanded ? (
                    <div className="p-4 bg-muted/50 rounded-lg text-center">
                      <button
                        type="button"
                        className="inline-flex items-center justify-center gap-2 rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-medium hover:bg-primary/90"
                        onClick={() => setIsDrawerExpanded(false)}
                      >
                        {selectedPatient || hasSelectedOption || isEditing
                          ? "Continue booking"
                          : "Start booking"}
                      </button>
                    </div>
                  ) : (
                    <Form {...form}>
                      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                        <div className="space-y-4">
                          <Popover open={isPatientPopoverOpen} onOpenChange={setIsPatientPopoverOpen}>
                            <PopoverTrigger asChild>
                              <FormItem>
                                <FormLabel>Search Patient by Phone</FormLabel>
                                <div className="relative">
                                  <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                                  <FormControl>
                                    <Input
                                      ref={patientInputRef}
                                      placeholder="Start typing 10-digit phone number..."
                                      value={patientSearchTerm}
                                      onChange={handlePatientSearchChange}
                                      onFocus={() => setIsDrawerExpanded(false)}
                                      className="pl-8"
                                      maxLength={10}
                                    />
                                  </FormControl>
                                </div>
                                <FormMessage />
                              </FormItem>
                            </PopoverTrigger>

                            <PopoverContent onOpenAutoFocus={(e) => e.preventDefault()} className="w-[--radix-popover-trigger-width] p-0" align="start">
                              <Command>
                                <CommandList>
                                  {(isPending ? (
                                    <div className="p-4 text-center text-sm text-muted-foreground">Searching...</div>
                                  ) : patientSearchTerm.length >= 5 ? (
                                    <CommandGroup>
                                      {/* Show existing patients if found */}
                                      {patientSearchResults.map((patient) => {
                                        const isClinicPatient = patient.clinicIds?.includes(clinicId!);
                                        return (
                                          <CommandItem
                                            key={patient.id}
                                            value={patient.phone}
                                            onSelect={() => {
                                              handlePatientSelect(patient);
                                              setHasSelectedOption(true);
                                              setIsPatientPopoverOpen(false);
                                            }}
                                            className="flex justify-between items-center"
                                          >
                                            <div>
                                              {patient.name || "Unnamed Patient"}
                                              <span className="text-xs text-muted-foreground ml-2">{patient.phone}</span>
                                            </div>
                                            <Badge variant={isClinicPatient ? "secondary" : "outline"} className={cn(
                                              isClinicPatient ? "text-blue-600 border-blue-500" : "text-amber-600 border-amber-500"
                                            )}>
                                              {isClinicPatient ? (
                                                <UserCheck className="mr-1.5 h-3 w-3" />
                                              ) : (
                                                <Crown className="mr-1.5 h-3 w-3" />
                                              )}
                                              {isClinicPatient ? "Existing Patient" : "Kloqo Member"}
                                            </Badge>
                                          </CommandItem>
                                        )
                                      })}

                                      {/* Always show "Add as new patient" option */}
                                      <CommandItem
                                        value="add-new-patient"
                                        onSelect={() => {
                                          setSelectedPatient(null);
                                          setPrimaryPatient(null);
                                          setHasSelectedOption(true);
                                          setIsPatientPopoverOpen(false);
                                          form.reset({
                                            ...form.getValues(),
                                            patientName: "",
                                            age: undefined,
                                            sex: undefined,
                                            phone: patientSearchTerm,
                                            place: "",
                                            doctor: doctors.length > 0 ? doctors[0].id : "",
                                            department: doctors.length > 0 ? doctors[0].department || "" : "",
                                            date: undefined,
                                            time: undefined,
                                            bookedVia: "Advanced Booking",
                                          });
                                        }}
                                        className="flex items-center space-x-2 py-2 text-blue-600 hover:text-blue-700 border-t"
                                      >
                                        <Plus className="h-4 w-4" />
                                        <span>Add as new patient</span>
                                      </CommandItem>
                                    </CommandGroup>
                                  ) : (
                                    patientSearchTerm.length >= 5 && <CommandEmpty>No patient found.</CommandEmpty>
                                  ))}
                                </CommandList>
                              </Command>
                            </PopoverContent>
                          </Popover>
                          {!isDrawerExpanded && (
                            <div className="border p-4 rounded-lg">
                              <div className="flex justify-between items-center">
                                <Label>Send Patient Booking Link</Label>
                                <Button type="button" onClick={handleSendLink} disabled={isSendingLink || patientSearchTerm.length < 10}>
                                  {isSendingLink ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <LinkIcon className="mr-2 h-4 w-4" />}
                                  Send WhatsApp Link
                                </Button>
                              </div>
                            </div>
                          )}
                        </div>

                        {(selectedPatient || hasSelectedOption || isEditing) && (
                          <>
                            <div className="pt-4 border-t">
                              {primaryPatient && !isEditing && (
                                <div className="mb-4">
                                  <Tabs value={bookingFor} onValueChange={(value) => {
                                    setBookingFor(value);
                                    if (value === 'member' && primaryPatient) {
                                      setSelectedPatient(primaryPatient);
                                      const capitalizedSex = primaryPatient.sex ? (primaryPatient.sex.charAt(0).toUpperCase() + primaryPatient.sex.slice(1).toLowerCase()) : undefined;
                                      form.reset({
                                        ...form.getValues(),
                                        patientId: primaryPatient.id,
                                        patientName: primaryPatient.name,
                                        age: primaryPatient.age ?? undefined,
                                        sex: capitalizedSex as "Male" | "Female" | "Other" | undefined,
                                        phone: primaryPatient.communicationPhone?.replace('+91', '') || '',
                                        place: primaryPatient.place || "",
                                      });
                                    }
                                  }}>
                                    <TabsList className="grid w-full grid-cols-2 bg-muted/30">
                                      <TabsTrigger
                                        value="member"
                                        className="data-[state=active]:bg-primary/20 data-[state=active]:text-primary data-[state=active]:border-primary/30 data-[state=inactive]:text-muted-foreground data-[state=inactive]:hover:bg-primary/10 transition-all duration-200"
                                      >
                                        For Member
                                      </TabsTrigger>
                                      <TabsTrigger
                                        value="relative"
                                        className="data-[state=active]:bg-primary/20 data-[state=active]:text-primary data-[state=active]:border-primary/30 data-[state=inactive]:text-muted-foreground data-[state=inactive]:hover:bg-primary/10 transition-all duration-200"
                                      >
                                        For a Relative
                                      </TabsTrigger>
                                    </TabsList>
                                    <TabsContent value="member" className="mt-4">
                                      <div className="text-sm p-4 bg-muted/50 rounded-lg">
                                        <p><strong>Name:</strong> {primaryPatient.name}</p>
                                        <p><strong>Place:</strong> {primaryPatient.place}</p>
                                      </div>
                                    </TabsContent>
                                    <TabsContent value="relative">
                                      <Card>
                                        <CardHeader>
                                          <CardTitle className="text-base">Relatives</CardTitle>
                                          <CardDescription className="text-xs">Book for an existing relative or add a new one.</CardDescription>
                                        </CardHeader>
                                        <CardContent className="space-y-3">
                                          {relatives.length > 0 ? (
                                            <ScrollArea className="h-40">
                                              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
                                                {relatives.map((relative) => (
                                                  <div
                                                    key={relative.id}
                                                    className="flex flex-col items-center justify-center p-3 rounded-lg border bg-card hover:bg-muted/50 cursor-pointer text-center"
                                                    onClick={() => handleRelativeSelect(relative)}
                                                  >
                                                    <Avatar className="h-10 w-10 mb-2">
                                                      <AvatarFallback>{relative.name.charAt(0)}</AvatarFallback>
                                                    </Avatar>
                                                    <div>
                                                      <p className="text-sm font-medium">{relative.name}</p>
                                                      <p className="text-xs text-muted-foreground">{relative.sex}, {relative.age} years</p>
                                                    </div>
                                                  </div>
                                                ))}
                                              </div>
                                            </ScrollArea>
                                          ) : (
                                            <div className="text-center py-4 space-y-2">
                                              <p className="text-xs text-muted-foreground">No relatives found for this patient.</p>
                                              <Button type="button" size="sm" variant="outline" onClick={() => setIsAddRelativeDialogOpen(true)}>
                                                <UserPlus className="mr-2 h-4 w-4" />
                                                Add New Relative
                                              </Button>
                                            </div>
                                          )}
                                          {relatives.length > 0 && (
                                            <Button type="button" className="w-full" variant="outline" onClick={() => setIsAddRelativeDialogOpen(true)}>
                                              <UserPlus className="mr-2 h-4 w-4" />
                                              Add New Relative
                                            </Button>
                                          )}
                                        </CardContent>
                                      </Card>
                                    </TabsContent>
                                  </Tabs>
                                </div>
                              )}
                              <div className="grid grid-cols-1 md:grid-cols-3 gap-x-8 gap-y-4 mt-4">
                                <div className="space-y-4 md:col-span-1">
                                  <h3 className="text-lg font-medium border-b pb-2 flex items-center justify-between">
                                    Patient Details
                                  </h3>
                                  <div className="grid grid-cols-2 gap-4">
                                    <FormField control={form.control} name="patientName" render={({ field }) => (
                                      <FormItem>
                                        <FormLabel>Name</FormLabel>
                                        <FormControl>
                                          <Input
                                            placeholder="Enter patient name"
                                            {...field}
                                            value={field.value || ''}
                                            onBlur={field.onBlur}
                                            onChange={(e) => {
                                              field.onChange(e);
                                              form.trigger('patientName');
                                            }}
                                          />
                                        </FormControl>
                                        <FormMessage />
                                      </FormItem>
                                    )} />
                                    <FormField control={form.control} name="age" render={({ field }) => (
                                      <FormItem>
                                        <FormLabel>Age</FormLabel>
                                        <FormControl>
                                          <Input
                                            type="text"
                                            inputMode="numeric"
                                            placeholder="Enter the age"
                                            {...field}
                                            value={field.value?.toString() ?? ''}
                                            onBlur={field.onBlur}
                                            onChange={(e) => {
                                              const val = e.target.value;
                                              if (val === '' || /^\d+$/.test(val)) {
                                                field.onChange(val);
                                                form.trigger('age');
                                              }
                                            }}
                                            className="[&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none [-moz-appearance:textfield]"
                                          />
                                        </FormControl>
                                        <FormMessage />
                                      </FormItem>
                                    )} />
                                    <FormField control={form.control} name="sex" render={({ field }) => (
                                      <FormItem>
                                        <FormLabel>Gender</FormLabel>
                                        <Select
                                          onValueChange={(value) => {
                                            field.onChange(value);
                                            form.trigger('sex');
                                          }}
                                          value={field.value || ""}
                                        >
                                          <FormControl>
                                            <SelectTrigger>
                                              <SelectValue placeholder="Select gender" />
                                            </SelectTrigger>
                                          </FormControl>
                                          <SelectContent>
                                            <SelectItem value="Male">Male</SelectItem>
                                            <SelectItem value="Female">Female</SelectItem>
                                            <SelectItem value="Other">Other</SelectItem>
                                          </SelectContent>
                                        </Select>
                                        <FormMessage />
                                      </FormItem>
                                    )} />
                                    <FormField control={form.control} name="place" render={({ field }) => (
                                      <FormItem>
                                        <FormLabel>Place</FormLabel>
                                        <FormControl>
                                          <Input
                                            placeholder="Enter place"
                                            {...field}
                                            value={field.value || ''}
                                            onBlur={field.onBlur}
                                            onChange={(e) => {
                                              field.onChange(e);
                                              form.trigger('place');
                                            }}
                                          />
                                        </FormControl>
                                        <FormMessage />
                                      </FormItem>
                                    )} />
                                  </div>

                                  <FormField
                                    control={form.control}
                                    name="phone"
                                    render={({ field }) => (
                                      <FormItem>
                                        <FormLabel>Communication Phone</FormLabel>
                                        <FormControl>
                                          <div className="relative">
                                            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">+91</span>
                                            <Input
                                              type="tel"
                                              {...field}
                                              value={(field.value || '').replace(/^\+91/, '')}
                                              className="pl-12"
                                              placeholder="Enter 10-digit number"
                                              disabled
                                            />
                                          </div>
                                        </FormControl>
                                        <FormDescription className="text-xs">This number will be used for appointment communication.</FormDescription>
                                        <FormMessage />
                                      </FormItem>
                                    )}
                                  />
                                </div>
                                <div className="space-y-4 md:col-span-1">
                                  <h3 className="text-lg font-medium border-b pb-2">Appointment Details</h3>
                                  {appointmentType === 'Advanced Booking' ? (
                                    <FormField control={form.control} name="date" render={({ field }) => (
                                      <FormItem className="flex flex-col">
                                        <FormLabel>Select Date</FormLabel>
                                        <Calendar
                                          className="bg-primary text-primary-foreground rounded-md [&_button:hover]:bg-primary/80 [&_.rdp-day_today]:bg-primary-foreground/20 [&_button]:text-primary-foreground"
                                          mode="single"
                                          selected={field.value}
                                          onSelect={(date) => {
                                            if (date) field.onChange(date);
                                            form.clearErrors("date");
                                          }}
                                          disabled={isDateDisabled}
                                          initialFocus
                                          modifiers={selectedDoctor ? { available: { dayOfWeek: availableDaysOfWeek }, leave: leaveDates } : { leave: leaveDates }}
                                          modifiersStyles={{
                                            available: { backgroundColor: 'hsl(var(--accent))', color: 'hsl(var(--accent-foreground))' },
                                            leave: { backgroundColor: 'hsl(var(--destructive))', color: 'hsl(var(--destructive-foreground))' },
                                          }}
                                        />
                                        <FormMessage />
                                      </FormItem>
                                    )} />
                                  ) : (
                                    <Card className={cn("mt-4", walkInEstimate ? "bg-green-50 border-green-200" : walkInEstimateUnavailable ? "bg-amber-50 border-amber-200" : "bg-red-50 border-red-200")}>
                                      <CardHeader className="flex-row items-start gap-3 space-y-0 p-4">
                                        <Info className={cn("w-6 h-6 mt-1", walkInEstimate ? "text-green-600" : walkInEstimateUnavailable ? "text-amber-600" : "text-red-600")} />
                                        <div>
                                          {(() => {
                                            // Show force book option if unavailable flag is set, regardless of estimate
                                            if (walkInEstimateUnavailable && selectedDoctor) {
                                              const isNearClosing = isWithin15MinutesOfClosing(selectedDoctor, new Date());
                                              return (
                                                <div className="space-y-3">
                                                  <div>
                                                    <CardTitle className="text-base text-amber-700">
                                                      {walkInEstimate ? "Walk-in Closing Soon" : "Walk-in Booking Closed"}
                                                    </CardTitle>
                                                    <CardDescription className="text-xs text-amber-800">
                                                      {isNearClosing
                                                        ? "Within 15 minutes of closing time."
                                                        : "All available slots are fully booked."}
                                                    </CardDescription>
                                                  </div>
                                                  {walkInEstimate && (
                                                    <div className="text-sm text-amber-900 py-2 px-3 bg-amber-100 rounded-md">
                                                      <p className="font-medium">Current Estimate:</p>
                                                      <p>Token: {walkInEstimate.numericToken}</p>
                                                      <p>Time: {format(walkInEstimate.estimatedTime, 'hh:mm a')}</p>
                                                    </div>
                                                  )}
                                                  <Button
                                                    onClick={handleForceBookEstimate}
                                                    variant="outline"
                                                    size="sm"
                                                    className="w-full border-amber-500 text-amber-700 hover:bg-amber-50"
                                                    disabled={isCalculatingEstimate}
                                                  >
                                                    {isCalculatingEstimate ? (
                                                      <>
                                                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                                        Processing...
                                                      </>
                                                    ) : (
                                                      <>
                                                        <AlertTriangle className="mr-2 h-4 w-4" />
                                                        Force Book
                                                      </>
                                                    )}
                                                  </Button>
                                                  <p className="text-xs text-muted-foreground">
                                                    Patient will be scheduled outside normal hours
                                                  </p>
                                                </div>
                                              );
                                            }

                                            if (!walkInEstimate || !selectedDoctor) {

                                              return (
                                                <>
                                                  <CardTitle className="text-base">Walk-in Unavailable</CardTitle>
                                                  <CardDescription className="text-xs text-red-800">
                                                    This doctor is not available for walk-ins at this time.
                                                  </CardDescription>
                                                </>
                                              );
                                            }
                                            try {
                                              const today = new Date();
                                              const appointmentDate = parse(format(today, 'd MMMM yyyy'), 'd MMMM yyyy', today);
                                              const dayOfWeekStr = format(appointmentDate, 'EEEE');
                                              const availabilityForDay = selectedDoctor.availabilitySlots?.find(s => s.day === dayOfWeekStr);

                                              // Prefer session-aware end time using the estimated sessionIndex
                                              let availabilityEnd: Date | null = null;
                                              let availabilityEndLabel = '';

                                              if (walkInEstimate?.sessionIndex !== undefined && walkInEstimate.sessionIndex !== null) {
                                                const sessionEffectiveEnd = getSessionEnd(selectedDoctor, appointmentDate, walkInEstimate.sessionIndex);
                                                if (sessionEffectiveEnd) {
                                                  availabilityEnd = sessionEffectiveEnd;
                                                  availabilityEndLabel = format(sessionEffectiveEnd, 'hh:mm a');
                                                }
                                              }

                                              // Fallback to last session's end if session-specific lookup failed
                                              if (!availabilityEnd && availabilityForDay && availabilityForDay.timeSlots.length > 0) {
                                                const lastSession = availabilityForDay.timeSlots[availabilityForDay.timeSlots.length - 1];
                                                const originalEnd = parseTimeUtil(lastSession.to, appointmentDate);
                                                availabilityEnd = originalEnd;
                                                availabilityEndLabel = format(originalEnd, 'hh:mm a');
                                              }

                                              // Apply session-specific break offsets to the estimated time (only once)
                                              const sessionBreaks = walkInEstimate?.sessionIndex !== undefined && walkInEstimate.sessionIndex !== null
                                                ? getSessionBreakIntervals(selectedDoctor, appointmentDate, walkInEstimate.sessionIndex)
                                                : [];
                                              // Use estimated time directly
                                              const adjustedWithBreaks = walkInEstimate.estimatedTime;

                                              const consultationTime = selectedDoctor?.averageConsultingTime || 15;
                                              const appointmentEndTime = addMinutes(adjustedWithBreaks, consultationTime);
                                              const isOutsideFrame = availabilityEnd ? isAfter(appointmentEndTime, availabilityEnd) : false;

                                              if (isOutsideFrame && !(walkInEstimate as any)?.isForceBooked) {
                                                return (
                                                  <>
                                                    <CardTitle className="text-base text-red-700">Walk-in Not Available</CardTitle>
                                                    <CardDescription className="text-xs text-red-800">
                                                      Next estimated time ~{format(adjustedWithBreaks, 'hh:mm a')} is outside availability (ends at {availabilityEndLabel}).
                                                    </CardDescription>
                                                  </>
                                                );
                                              }
                                              return (
                                                <>
                                                  <CardTitle className="text-base">Walk-in Available</CardTitle>
                                                  <CardDescription className="text-xs text-green-800">
                                                    Estimated waiting time is shown below.
                                                  </CardDescription>
                                                </>
                                              );
                                            } catch {
                                              return (
                                                <>
                                                  <CardTitle className="text-base">{walkInEstimate ? "Walk-in Available" : "Walk-in Unavailable"}</CardTitle>
                                                  <CardDescription className={cn("text-xs", walkInEstimate ? "text-green-800" : "text-red-800")}>
                                                    {walkInEstimate ? "Estimated waiting time is shown below." : "This doctor is not available for walk-ins at this time."}
                                                  </CardDescription>
                                                </>
                                              );
                                            }
                                          })()}
                                        </div>
                                      </CardHeader>
                                      {walkInEstimate && (
                                        <CardContent className="p-4 pt-0">
                                          {isCalculatingEstimate ? (
                                            <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                                              <Loader2 className="h-4 w-4 animate-spin" />
                                              Calculating wait time...
                                            </div>
                                          ) : (
                                            (() => {
                                              try {
                                                const today = new Date();
                                                const appointmentDate = parse(format(today, 'd MMMM yyyy'), 'd MMMM yyyy', today);
                                                const dayOfWeekStr = format(appointmentDate, 'EEEE');
                                                const availabilityForDay = selectedDoctor?.availabilitySlots?.find(s => s.day === dayOfWeekStr);
                                                let availabilityEnd: Date | null = null;
                                                let availabilityEndLabel = '';

                                                // Use session-specific end if available
                                                if (walkInEstimate?.sessionIndex !== undefined && walkInEstimate.sessionIndex !== null) {
                                                  const sessionEffectiveEnd = selectedDoctor ? getSessionEnd(selectedDoctor, appointmentDate, walkInEstimate.sessionIndex) : null;
                                                  if (sessionEffectiveEnd) {
                                                    availabilityEnd = sessionEffectiveEnd;
                                                    availabilityEndLabel = format(sessionEffectiveEnd, 'hh:mm a');
                                                  }
                                                }

                                                // Fallback to last session's end if session-specific lookup failed
                                                if (!availabilityEnd && availabilityForDay && availabilityForDay.timeSlots.length > 0) {
                                                  const lastSession = availabilityForDay.timeSlots[availabilityForDay.timeSlots.length - 1];
                                                  const originalEnd = parseTimeUtil(lastSession.to, appointmentDate);
                                                  availabilityEnd = originalEnd;
                                                  availabilityEndLabel = format(originalEnd, 'hh:mm a');
                                                  const dateKey = format(appointmentDate, 'd MMMM yyyy');
                                                  const extension = (selectedDoctor as any).availabilityExtensions?.[dateKey];
                                                  if (extension?.sessions) {
                                                    const sessionExtension = extension.sessions.find((s: any) => s.sessionIndex === lastSession);
                                                    if (sessionExtension?.newEndTime) {
                                                      try {
                                                        const extendedEnd = parseTimeUtil(sessionExtension.newEndTime, appointmentDate);
                                                        if (extendedEnd > availabilityEnd) {
                                                          availabilityEnd = extendedEnd;
                                                          availabilityEndLabel = format(extendedEnd, 'hh:mm a');
                                                        }
                                                      } catch {
                                                        // ignore malformed extension
                                                      }
                                                    }
                                                  }
                                                }

                                                // Apply session break offsets once (only session-specific breaks)
                                                const sessionBreaks = walkInEstimate?.sessionIndex !== undefined && walkInEstimate.sessionIndex !== null
                                                  ? getSessionBreakIntervals(selectedDoctor, appointmentDate, walkInEstimate.sessionIndex)
                                                  : [];
                                                // Use estimated time directly
                                                const adjustedWithBreaks = walkInEstimate.estimatedTime;
                                                const consultationTime = selectedDoctor?.averageConsultingTime || 15;
                                                const appointmentEndTime = addMinutes(adjustedWithBreaks, consultationTime);
                                                const isOutsideFrame = availabilityEnd ? isAfter(appointmentEndTime, availabilityEnd) : false;

                                                if (isOutsideFrame && !(walkInEstimate as any)?.isForceBooked) {
                                                  return null; // Already shown in header; avoid duplicate message
                                                }

                                                return (
                                                  <div className="space-y-2">
                                                    <div className="grid grid-cols-2 gap-2 text-center">
                                                      <div>
                                                        <p className="text-xs text-muted-foreground">Est. Time</p>
                                                        <p className="font-bold text-lg">
                                                          {`~${format(adjustedWithBreaks, 'hh:mm a')}`}
                                                        </p>
                                                      </div>
                                                      <div>
                                                        <p className="text-xs text-muted-foreground">Queue</p>
                                                        <p className="font-bold text-lg">{walkInEstimate.patientsAhead} ahead</p>
                                                      </div>
                                                    </div>
                                                    {!!(walkInEstimate as any).isForceBooked && (
                                                      <div className="px-3 py-2 bg-amber-50 border border-amber-200 rounded-md">
                                                        <p className="text-xs font-semibold text-amber-800 flex items-center gap-1">
                                                          <AlertTriangle className="h-3 w-3" />
                                                          Outside normal availability
                                                        </p>
                                                      </div>
                                                    )}
                                                  </div>
                                                );
                                              } catch {
                                                return (
                                                  <div className="space-y-2">
                                                    <div className="grid grid-cols-2 gap-2 text-center">
                                                      <div>
                                                        <p className="text-xs text-muted-foreground">Est. Time</p>
                                                        <p className="font-bold text-lg">
                                                          {`~${format(walkInEstimate.estimatedTime, 'hh:mm a')}`}
                                                        </p>
                                                      </div>
                                                      <div>
                                                        <p className="text-xs text-muted-foreground">Queue</p>
                                                        <p className="font-bold text-lg">{walkInEstimate.patientsAhead} ahead</p>
                                                      </div>
                                                    </div>
                                                    {!!(walkInEstimate as any).isForceBooked && (
                                                      <div className="px-3 py-2 bg-amber-50 border border-amber-200 rounded-md">
                                                        <p className="text-xs font-semibold text-amber-800 flex items-center gap-1">
                                                          <AlertTriangle className="h-3 w-3" />
                                                          Outside normal availability
                                                        </p>
                                                      </div>
                                                    )}
                                                  </div>
                                                );
                                              }
                                            })()
                                          )}
                                        </CardContent>
                                      )}
                                    </Card>
                                  )}
                                </div>
                                <div className="space-y-4 md:col-span-1">
                                  <h3 className="text-lg font-medium border-b pb-2">Doctor & Time</h3>

                                  {/* Appointment Type Selection */}
                                  <div className="space-y-2">
                                    <Label className="text-sm font-medium">Appointment Type</Label>
                                    <RadioGroup onValueChange={(value) => {
                                      form.setValue('bookedVia', value as any);
                                      // When switching to Walk-in, set date to today (walk-ins are same-day only)
                                      if (value === 'Walk-in') {
                                        form.setValue('date', new Date());
                                      }
                                    }} value={form.watch('bookedVia')} className="flex items-center space-x-2">
                                      <Label htmlFor="advanced-booking" className={cn(
                                        "flex-1 px-4 py-3 rounded-md cursor-pointer transition-all duration-200 border-2 text-center font-medium flex items-center justify-center min-h-[4rem]",
                                        form.watch('bookedVia') === 'Advanced Booking'
                                          ? "border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950/20 dark:text-blue-300"
                                          : "border-gray-200 bg-gray-50 text-gray-700 hover:border-gray-300 hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:border-gray-600 dark:hover:bg-gray-700"
                                      )}>
                                        <RadioGroupItem value="Advanced Booking" id="advanced-booking" className="sr-only" />
                                        Advanced Booking
                                      </Label>
                                      <Label htmlFor="walk-in" className={cn(
                                        "flex-1 px-4 py-3 rounded-md cursor-pointer transition-all duration-200 border-2 text-center font-medium flex items-center justify-center min-h-[4rem]",
                                        form.watch('bookedVia') === 'Walk-in'
                                          ? "border-green-500 bg-green-50 text-green-700 dark:bg-green-950/20 dark:text-green-300"
                                          : "border-gray-200 bg-gray-50 text-gray-700 hover:border-gray-300 hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:border-gray-600 dark:hover:bg-gray-700"
                                      )}>
                                        <RadioGroupItem value="Walk-in" id="walk-in" className="sr-only" />
                                        Walk-in
                                      </Label>
                                    </RadioGroup>
                                  </div>
                                  {doctors.length > 1 ? (
                                    <FormField control={form.control} name="doctor" render={({ field }) => (
                                      <FormItem>
                                        <FormLabel>Doctor</FormLabel>
                                        <Select
                                          onValueChange={onDoctorChange}
                                          value={(field.value as string | undefined) || editingDoctorId || undefined}
                                        >
                                          <FormControl>
                                            <SelectTrigger>
                                              <SelectValue placeholder="Select a doctor" />
                                            </SelectTrigger>
                                          </FormControl>
                                          <SelectContent>
                                            {doctors.map(doc => (
                                              <SelectItem key={doc.id} value={doc.id}>{doc.name} - {doc.specialty}</SelectItem>
                                            ))}
                                          </SelectContent>
                                        </Select>
                                        <FormMessage />
                                      </FormItem>
                                    )} />
                                  ) : (
                                    <div className="space-y-2">
                                      <Label className="text-sm text-muted-foreground">Doctor</Label>
                                      <p className="text-lg font-semibold">
                                        {selectedDoctor ? `${selectedDoctor.name} — ${selectedDoctor.specialty}` : 'No doctors available'}
                                      </p>
                                      <input type="hidden" {...form.register('doctor')} />
                                    </div>
                                  )}
                                  <div className="space-y-2">
                                    <Label className="text-sm text-muted-foreground">Department</Label>
                                    <p className="text-base">
                                      {selectedDoctor?.department || 'Not assigned'}
                                    </p>
                                    <input type="hidden" {...form.register('department')} />
                                  </div>
                                  {appointmentType === 'Advanced Booking' && selectedDoctor && selectedDate && (
                                    <div className="space-y-4 max-h-60 overflow-y-auto pr-2">
                                      {isAdvanceCapacityReached && (
                                        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                                          Advance booking capacity has been reached for this doctor today. No slots are available.
                                        </div>
                                      )}
                                      {sessionSlots.length > 0 ? (
                                        (() => {
                                          // Calculate break intervals for display
                                          const displayBreakIntervals = buildBreakIntervals(selectedDoctor, selectedDate);
                                          return sessionSlots.map((session, index) => (
                                            <div key={index}>
                                              <h4 className="text-sm font-semibold mb-2">{session.title}</h4>
                                              <div className="grid grid-cols-2 gap-2">
                                                {session.slots.map(slot => {
                                                  const slotMeta = slot as { status?: string; tokenNumber?: string };
                                                  const slotStatus = slotMeta.status ?? 'available';
                                                  return (
                                                    <Button
                                                      key={slot.time}
                                                      type="button"
                                                      variant={form.getValues("time") === format(parseDateFns(slot.time, "hh:mm a", new Date()), 'HH:mm') ? "default" : "outline"}
                                                      onClick={() => {
                                                        const val = format(parseDateFns(slot.time, "hh:mm a", new Date()), 'HH:mm');
                                                        form.setValue("time", val, { shouldValidate: true, shouldDirty: true });
                                                        if (val) form.clearErrors("time");
                                                        form.trigger();
                                                      }}
                                                      disabled={slotStatus !== 'available'}
                                                      className={cn("text-xs", {
                                                        "line-through bg-muted text-muted-foreground": slotStatus === 'booked',
                                                        "line-through bg-destructive/20 text-destructive-foreground": slotStatus === 'leave',
                                                      })}
                                                    >
                                                      {slotStatus === 'booked' && slotMeta.tokenNumber ? slotMeta.tokenNumber : (() => {
                                                        try {
                                                          const slotTime = parseDateFns(slot.time, "hh:mm a", selectedDate || new Date());
                                                          // Display slot time directly
                                                          const displayTime = subMinutes(slotTime, 15);
                                                          return format(displayTime, 'hh:mm a');
                                                        } catch {
                                                          return slot.time;
                                                        }
                                                      })()}
                                                    </Button>
                                                  );
                                                })}
                                              </div>
                                            </div>
                                          ));
                                        })()
                                      ) : (
                                        <p className="text-sm text-muted-foreground col-span-2">
                                          {isAdvanceCapacityReached
                                            ? 'Advance booking capacity has been reached for this doctor today.'
                                            : 'No available slots for this day.'}
                                        </p>
                                      )}
                                    </div>
                                  )}
                                </div>
                              </div>
                            </div>
                            <div className="flex justify-end items-center pt-4">
                              <div className="flex justify-end gap-2">
                                {isEditing && <Button type="button" variant="outline" onClick={resetForm}>Cancel</Button>}
                                <Button
                                  type="submit"
                                  disabled={isBookingButtonDisabled}
                                >
                                  {isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                                  {isEditing ? "Save Changes" : "Book Appointment"}
                                </Button>
                              </div>
                            </div>
                          </>
                        )}
                      </form>
                    </Form>
                  )}
                </CardContent>
              </Card>
            </main>
            <div className="flex items-center justify-center">
              <Button
                variant="outline"
                size="icon"
                className="rounded-full bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground z-10"
                onClick={(e) => {
                  e.stopPropagation();
                  setIsDrawerExpanded(!isDrawerExpanded);
                }}
              >
                {isDrawerExpanded ? <ChevronRight className="h-5 w-5" /> : <ChevronLeft className="h-5 w-5" />}
              </Button>
            </div>
            <div className={cn("h-full", isDrawerExpanded ? "w-full" : "w-auto")}>
              <div className={cn("h-full w-full", isDrawerExpanded ? "p-0" : "")}>
                <Card className="h-full rounded-2xl">
                  <CardHeader className={cn("border-b", isDrawerExpanded ? "p-4" : "p-4 space-y-3")}>
                    {isDrawerExpanded ? (
                      <>
                        <div className="flex items-center justify-between">
                          <CardTitle>Appointment Details</CardTitle>
                          <Tabs value={activeTab} onValueChange={setActiveTab}>
                            <TabsList>
                              <TabsTrigger value="all">All</TabsTrigger>
                              <TabsTrigger value="upcoming">Upcoming</TabsTrigger>
                              <TabsTrigger value="completed">Completed</TabsTrigger>
                              <TabsTrigger value="no-show">No-show</TabsTrigger>
                            </TabsList>
                          </Tabs>
                        </div>
                        <div className="flex items-center gap-2 mt-2 w-full">
                          <div className="relative flex-1">
                            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                            <Input
                              type="search"
                              placeholder="Search by patient, doctor, department..."
                              className="w-full rounded-lg bg-background pl-8 h-9"
                              value={drawerSearchTerm}
                              onChange={(e) => setDrawerSearchTerm(e.target.value)}
                            />
                          </div>
                          <DateRangePicker
                            initialDateRange={drawerDateRange}
                            onDateChange={setDrawerDateRange}
                            className="mx-2"
                          />
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="outline" size="icon">
                                <Stethoscope className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start">
                              <DropdownMenuItem onClick={() => setSelectedDrawerDoctor('all')}>All Doctors</DropdownMenuItem>
                              {doctors.map(doc => (
                                <DropdownMenuItem key={doc.id} onClick={() => setSelectedDrawerDoctor(doc.name)}>{doc.name}</DropdownMenuItem>
                              ))}
                            </DropdownMenuContent>
                          </DropdownMenu>
                          <span className="ml-2 text-xs text-muted-foreground">
                            {selectedDrawerDoctor && selectedDrawerDoctor !== 'all' ? `Doctor: ${selectedDrawerDoctor}` : 'All Doctors'}
                          </span>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={async () => {
                              if (clinicId) {
                                try {
                                  await updateAppointmentAndDoctorStatuses(clinicId);
                                } catch (error) {
                                  console.error('Manual status update failed:', error);
                                }
                              }
                            }}
                            className="ml-2"
                          >
                            Update Status
                          </Button>
                          <Button variant="outline" size="icon">
                            <Printer className="h-4 w-4" />
                          </Button>
                          <Button variant="outline" size="icon">
                            <FileDown className="h-4 w-4" />
                          </Button>
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 w-full">
                          <div className="flex items-center gap-2">
                            <CardTitle>Today's Appointments</CardTitle>
                            {doctors.length > 1 && (
                              <>
                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    <Button variant="outline" size="icon" className="h-8 w-8">
                                      <Stethoscope className="h-4 w-4" />
                                    </Button>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent align="start">
                                    <DropdownMenuItem onClick={() => setSelectedDrawerDoctor('all')}>
                                      All Doctors
                                    </DropdownMenuItem>
                                    {doctors.map(doc => (
                                      <DropdownMenuItem key={doc.id} onClick={() => setSelectedDrawerDoctor(doc.name)}>
                                        {doc.name}
                                      </DropdownMenuItem>
                                    ))}
                                  </DropdownMenuContent>
                                </DropdownMenu>
                                <span className="text-xs text-muted-foreground">
                                  {selectedDrawerDoctor && selectedDrawerDoctor !== 'all'
                                    ? `Doctor: ${selectedDrawerDoctor}`
                                    : 'All Doctors'}
                                </span>
                              </>
                            )}
                          </div>
                          <div className="relative w-full sm:w-64">
                            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                            <Input
                              type="search"
                              placeholder="Search by patient, doctor..."
                              className="w-full rounded-lg bg-background pl-8 h-9"
                              value={drawerSearchTerm}
                              onChange={(e) => setDrawerSearchTerm(e.target.value)}
                            />
                          </div>
                        </div>
                        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
                          <TabsList className="grid w-full grid-cols-2">
                            <TabsTrigger value="upcoming">
                              Pending ({pendingCount})
                            </TabsTrigger>
                            <TabsTrigger value="skipped">
                              Skipped ({skippedCount})
                            </TabsTrigger>
                          </TabsList>
                        </Tabs>
                      </>
                    )}
                  </CardHeader>
                  <CardContent className="p-0">
                    <ScrollArea className="h-[calc(100vh-15rem)]">
                      {loading ? (
                        <div className="p-6">
                          {Array.from({ length: 10 }).map((_, i) => (
                            <div key={i} className="p-3 rounded-lg border bg-muted animate-pulse h-20 mb-3"></div>
                          ))}
                        </div>
                      ) : isDrawerExpanded ? (
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Patient</TableHead>
                              <TableHead>Age</TableHead>
                              <TableHead>Gender</TableHead>
                              <TableHead>Phone</TableHead>
                              <TableHead>Place</TableHead>
                              <TableHead>Doctor</TableHead>
                              <TableHead>Department</TableHead>
                              <TableHead>Date</TableHead>
                              <TableHead>Time</TableHead>
                              <TableHead>Booked Via</TableHead>
                              <TableHead>Token</TableHead>
                              <TableHead className="text-right">Actions</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {filteredAppointments.map((appointment, index) => (
                              <TableRow key={`${appointment.id}-${index}`} className={cn(
                                isAppointmentOnLeave(appointment) && "bg-red-100 dark:bg-red-900/30",
                                appointment.status === 'Skipped' && "bg-orange-100 dark:bg-orange-900/30"
                              )}>
                                <TableCell className="font-medium">{appointment.patientName}</TableCell>
                                <TableCell>{appointment.age}</TableCell>
                                <TableCell>{appointment.sex}</TableCell>
                                <TableCell>{appointment.communicationPhone}</TableCell>
                                <TableCell>{appointment.place}</TableCell>
                                <TableCell>{appointment.doctor}</TableCell>
                                <TableCell>{appointment.department}</TableCell>
                                <TableCell>{format(parse(appointment.date, "d MMMM yyyy", new Date()), "MMM d, yy")}</TableCell>
                                <TableCell>{getDisplayTimeForAppointment(appointment)}</TableCell>
                                <TableCell>{appointment.bookedVia}</TableCell>
                                <TableCell>{appointment.tokenNumber}</TableCell>
                                <TableCell className="text-right">
                                  {appointment.status === 'Pending' || appointment.status === 'Skipped' ? (
                                    <DropdownMenu>
                                      <DropdownMenuTrigger asChild>
                                        <Button variant="ghost" className="h-8 w-8 p-0">
                                          <span className="sr-only">Open menu</span>
                                          <MoreHorizontal className="h-4 w-4" />
                                        </Button>
                                      </DropdownMenuTrigger>
                                      <DropdownMenuContent align="end">
                                        <DropdownMenuItem onClick={() => {
                                          setIsDrawerExpanded(false);
                                          setEditingAppointment(appointment);
                                        }}>
                                          <Edit className="mr-2 h-4 w-4" />
                                          Reschedule
                                        </DropdownMenuItem>
                                        <DropdownMenuItem onClick={() => setAppointmentToCancel(appointment)} className="text-red-600">
                                          <X className="mr-2 h-4 w-4" />
                                          Cancel
                                        </DropdownMenuItem>
                                      </DropdownMenuContent>
                                    </DropdownMenu>
                                  ) : (
                                    <Badge
                                      variant={
                                        appointment.status === 'Completed' ? 'default' :
                                          appointment.status === 'Cancelled' ? 'destructive' :
                                            appointment.status === 'No-show' ? 'secondary' :
                                              appointment.status === 'Confirmed' ? 'default' :
                                                'secondary'
                                      }
                                    >
                                      {appointment.status}
                                    </Badge>
                                  )}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      ) : (
                        <>
                          {activeTab === 'skipped' ? (
                            <Table>
                              <TableHeader>
                                <TableRow>
                                  <TableHead>Patient</TableHead>
                                  <TableHead>Token</TableHead>
                                  <TableHead>Time</TableHead>
                                  <TableHead className="text-right">Status</TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {todaysAppointments
                                  .filter(apt => apt.status === 'Skipped')
                                  .map((appointment, index) => (
                                    <TableRow
                                      key={`${appointment.id}-${index}`}
                                      className={cn(
                                        appointment.status === 'Skipped' && "bg-red-200/50 dark:bg-red-900/60"
                                      )}
                                    >
                                      <TableCell className="font-medium">{appointment.patientName}</TableCell>
                                      <TableCell>{appointment.tokenNumber}</TableCell>
                                      <TableCell>{getDisplayTimeForAppointment(appointment)}</TableCell>
                                      <TableCell className="text-right">
                                        <div className="flex justify-end gap-2">
                                          <Badge variant="destructive">Skipped</Badge>
                                          <TooltipProvider>
                                            <Tooltip>
                                              <TooltipTrigger asChild>
                                                <Button
                                                  variant="ghost"
                                                  size="icon"
                                                  className="p-0 h-auto text-blue-600 hover:text-blue-700"
                                                  onClick={() => handleRejoinQueue(appointment)}
                                                >
                                                  <Repeat className="h-5 w-5" />
                                                </Button>
                                              </TooltipTrigger>
                                              <TooltipContent>
                                                <p>Re-Join Queue</p>
                                              </TooltipContent>
                                            </Tooltip>
                                          </TooltipProvider>
                                        </div>
                                      </TableCell>
                                    </TableRow>
                                  ))}
                              </TableBody>
                            </Table>
                          ) : (
                            <div className="space-y-6 p-4">
                              {/* Arrived Section (Confirmed) */}
                              <div>
                                <div className="mb-3 flex items-center gap-2">
                                  <CheckCircle2 className="h-4 w-4 text-green-600" />
                                  <h3 className="font-semibold text-sm">Arrived ({todaysAppointments.filter(apt => apt.status === 'Confirmed').length})</h3>
                                </div>
                                <Table>
                                  <TableHeader>
                                    <TableRow>
                                      <TableHead>Patient</TableHead>
                                      <TableHead>Token</TableHead>
                                      <TableHead>Time</TableHead>
                                      <TableHead className="text-right">Actions</TableHead>
                                    </TableRow>
                                  </TableHeader>
                                  <TableBody>
                                    {todaysAppointments
                                      .filter(apt => apt.status === 'Confirmed')
                                      .map((appointment, index) => {
                                        const isBuffer = isInBufferQueue(appointment);
                                        return (
                                          <TableRow
                                            key={`${appointment.id}-${index}`}
                                            className={cn(
                                              isBuffer && "bg-yellow-100 dark:bg-yellow-900/30"
                                            )}
                                          >
                                            <TableCell className="font-medium">
                                              <div className="flex items-center gap-2">
                                                {appointment.patientName}
                                                {isBuffer && (
                                                  <Badge variant="outline" className="text-xs bg-yellow-200 border-yellow-400">
                                                    Buffer
                                                  </Badge>
                                                )}
                                              </div>
                                            </TableCell>
                                            <TableCell>{appointment.tokenNumber}</TableCell>
                                            <TableCell>{getDisplayTimeForAppointment(appointment)}</TableCell>
                                            <TableCell className="text-right">
                                              <div className="flex justify-end gap-2">
                                                {index === 0 && (
                                                  <TooltipProvider>
                                                    <Tooltip>
                                                      <TooltipTrigger asChild>
                                                        <div>
                                                          <Button
                                                            variant="ghost"
                                                            size="icon"
                                                            className="p-0 h-auto text-amber-600 hover:text-amber-700 disabled:opacity-50 disabled:cursor-not-allowed"
                                                            onClick={() => handleSkip(appointment)}
                                                            disabled={!isDoctorInConsultation}
                                                          >
                                                            <SkipForward className="h-5 w-5" />
                                                          </Button>
                                                        </div>
                                                      </TooltipTrigger>
                                                      {!isDoctorInConsultation && (
                                                        <TooltipContent>
                                                          <p>Doctor is not in consultation.</p>
                                                        </TooltipContent>
                                                      )}
                                                    </Tooltip>
                                                  </TooltipProvider>
                                                )}
                                                <TooltipProvider>
                                                  <Tooltip>
                                                    <TooltipTrigger asChild>
                                                      <div>
                                                        <Button
                                                          variant="ghost"
                                                          size="icon"
                                                          className="p-0 h-auto text-green-600 hover:text-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
                                                          onClick={() => setAppointmentToComplete(appointment)}
                                                          disabled={!isDoctorInConsultation}
                                                        >
                                                          <CheckCircle2 className="h-5 w-5" />
                                                        </Button>
                                                      </div>
                                                    </TooltipTrigger>
                                                    {!isDoctorInConsultation && (
                                                      <TooltipContent>
                                                        <p>Doctor is not in consultation.</p>
                                                      </TooltipContent>
                                                    )}
                                                  </Tooltip>
                                                </TooltipProvider>
                                              </div>
                                            </TableCell>
                                          </TableRow>
                                        );
                                      })}
                                  </TableBody>
                                </Table>
                              </div>

                              {/* Pending Section */}
                              <div>
                                <div className="mb-3 flex items-center gap-2">
                                  <Clock className="h-4 w-4 text-orange-600" />
                                  <h3 className="font-semibold text-sm">Pending ({todaysAppointments.filter(apt => apt.status === 'Pending').length})</h3>
                                </div>
                                <Table>
                                  <TableHeader>
                                    <TableRow>
                                      <TableHead>Patient</TableHead>
                                      <TableHead>Token</TableHead>
                                      <TableHead>Time</TableHead>
                                      <TableHead className="text-right">Actions</TableHead>
                                    </TableRow>
                                  </TableHeader>
                                  <TableBody>
                                    {todaysAppointments
                                      .filter(apt => apt.status === 'Pending')
                                      .map((appointment, index) => (
                                        <TableRow
                                          key={`${appointment.id}-${index}`}
                                        >
                                          <TableCell className="font-medium">{appointment.patientName}</TableCell>
                                          <TableCell>{appointment.tokenNumber}</TableCell>
                                          <TableCell>{getDisplayTimeForAppointment(appointment)}</TableCell>
                                          <TableCell className="text-right">
                                            <div className="flex justify-end gap-2">
                                              {shouldShowConfirmArrival(appointment) && (
                                                <TooltipProvider>
                                                  <Tooltip>
                                                    <TooltipTrigger asChild>
                                                      <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        className="p-0 h-auto text-blue-600 hover:text-blue-700"
                                                        onClick={() => setAppointmentToAddToQueue(appointment)}
                                                      >
                                                        <CheckCircle2 className="h-5 w-5" />
                                                      </Button>
                                                    </TooltipTrigger>
                                                    <TooltipContent>
                                                      <p>Confirm Arrival</p>
                                                    </TooltipContent>
                                                  </Tooltip>
                                                </TooltipProvider>
                                              )}
                                            </div>
                                          </TableCell>
                                        </TableRow>
                                      ))}
                                  </TableBody>
                                </Table>
                              </div>
                            </div>
                          )}
                        </>
                      )}
                    </ScrollArea>
                  </CardContent>
                </Card>
              </div>
            </div>
          </div>
        </main>
      </div>
      {primaryPatient && (
        <AddRelativeDialog
          isOpen={isAddRelativeDialogOpen}
          setIsOpen={setIsAddRelativeDialogOpen}
          primaryMemberId={primaryPatient.id}
          onRelativeAdded={handleNewRelativeAdded}
        />
      )}
      <Dialog open={isTokenModalOpen} onOpenChange={setIsTokenModalOpen}>
        <DialogContent className="sm:max-w-xs w-[90%]">
          <DialogHeader>
            <DialogTitle className="text-xl font-bold text-center">Walk-in Token Generated!</DialogTitle>
            <DialogDescription className="text-center">
              Please wait for your turn. You can monitor the live queue.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4 text-center">
            <p className="text-sm text-muted-foreground">Your Token Number</p>
            <p className="text-5xl font-bold text-primary">{generatedToken}</p>
          </div>
          <DialogClose asChild>
            <Button variant="ghost" size="icon" className="absolute top-4 right-4 h-6 w-6 text-muted-foreground">
              <X className="h-4 w-4" />
              <span className="sr-only">Close</span>
            </Button>
          </DialogClose>
        </DialogContent>
      </Dialog>
      <AlertDialog open={!!appointmentToCancel} onOpenChange={(open) => {
        if (!open) {
          // Defer state clearing until after dialog animation completes
          setTimeout(() => setAppointmentToCancel(null), 300);
        }
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you sure you want to cancel this appointment?</AlertDialogTitle>
            <AlertDialogDescription>
              This will cancel the appointment for "{appointmentToCancel?.patientName}" on {appointmentToCancel?.date} at {appointmentToCancel?.time}. The patient will be notified.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>No, Keep Appointment</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-500 hover:bg-red-600"
              onClick={() => {
                const appointment = appointmentToCancel;
                setAppointmentToCancel(null);
                if (appointment) {
                  handleCancel(appointment);
                }
              }}
            >
              Yes, Cancel Appointment
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={!!appointmentToAddToQueue && appointmentToAddToQueue.status === 'Pending'} onOpenChange={(open) => {
        if (!open) {
          // Defer state clearing until after dialog animation completes
          setTimeout(() => setAppointmentToAddToQueue(null), 200);
        }
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Patient Arrived at Clinic?</AlertDialogTitle>
            <AlertDialogDescription>
              Confirm that "{appointmentToAddToQueue?.patientName}" has arrived at the clinic. This will change their status to "Confirmed" and add them to the queue.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-blue-500 hover:bg-blue-600"
              onClick={() => {
                const appointment = appointmentToAddToQueue;
                setAppointmentToAddToQueue(null);
                if (appointment && appointment.status === 'Pending') {
                  handleAddToQueue(appointment);
                }
              }}
            >
              Yes, Confirm Arrival
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={!!appointmentToComplete} onOpenChange={(open) => {
        if (!open) {
          // Defer state clearing until after dialog animation completes
          setTimeout(() => setAppointmentToComplete(null), 200);
        }
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Mark Appointment as Completed?</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to mark the appointment for "{appointmentToComplete?.patientName}" as completed? This will update the appointment status and notify the patient.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-green-500 hover:bg-green-600"
              onClick={() => {
                const appointment = appointmentToComplete;
                setAppointmentToComplete(null);
                if (appointment) {
                  handleComplete(appointment);
                }
              }}
            >
              Yes, Mark as Completed
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Force Book Confirmation Dialog */}
      <AlertDialog open={showForceBookDialog} onOpenChange={setShowForceBookDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              Confirm Force Booking
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-2">
              <p>
                {isWithin15MinutesOfClosing(selectedDoctor, new Date())
                  ? "Walk-in booking is closing soon (within 15 minutes of closing time)."
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
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setShowForceBookDialog(false);
                handleForceBookEstimate();
              }}
              className="bg-amber-600 hover:bg-amber-700"
            >
              Force Book Patient
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}