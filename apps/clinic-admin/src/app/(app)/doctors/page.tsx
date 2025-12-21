

"use client";

import React, { useState, useEffect, useMemo, useTransition, useCallback } from "react";
import Image from "next/image";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  CardFooter,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Calendar } from "@/components/ui/calendar";
import { Button } from "@/components/ui/button";
import { doc, updateDoc, collection, getDocs, setDoc, getDoc, query, where, writeBatch, arrayRemove, Timestamp, serverTimestamp } from "firebase/firestore";
import { db, storage } from "@/lib/firebase";
import { getDownloadURL, ref, uploadBytes } from "firebase/storage";
import type { Doctor, Appointment, Department, TimeSlot, BreakPeriod } from "@kloqo/shared-types";
import {
  getCurrentActiveSession,
  getAvailableBreakSlots,
  validateBreakSlots,
  mergeAdjacentBreaks,
  createBreakPeriod,
  calculateSessionExtension,
  getSessionBreaks,
  getSessionEnd,
  type SessionInfo,
  type SlotInfo,
  type BreakInterval,
  shiftAppointmentsForNewBreak,
  validateBreakOverlapWithNextSession
} from '@kloqo/shared-core';
import { format, parse, isSameDay, getDay, addMinutes, subMinutes, isWithinInterval, differenceInMinutes, isPast, parseISO, startOfDay, isToday, isBefore, isAfter } from "date-fns";
import { Clock, User, BriefcaseMedical, Calendar as CalendarIcon, Info, Edit, Save, X, Trash, Copy, Loader2, ChevronLeft, ChevronRight, Search, Star, Users, CalendarDays, Link as LinkIcon, PlusCircle, DollarSign, Printer, FileDown, ChevronUp, ChevronDown, Minus, Trophy, Repeat, CalendarCheck, Upload, Trash2 } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Input } from "@/components/ui/input";
import { useForm, useFieldArray } from "react-hook-form";
import { Form, FormControl, FormField, FormItem, FormLabel, FormDescription, FormMessage } from "@/components/ui/form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn, parseTime as parseTimeUtil, getDisplayTime } from "@/lib/utils";
import { useSearchParams } from "next/navigation";
import PatientsVsAppointmentsChart from "@/components/dashboard/patients-vs-appointments-chart";
import { DateRange } from "react-day-picker";
import { subDays } from 'date-fns';
import { AddDoctorForm } from "@/components/doctors/add-doctor-form";
import OverviewStats from "@/components/dashboard/overview-stats";
import AppointmentStatusChart from "@/components/dashboard/appointment-status-chart";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Separator } from "@/components/ui/separator";
import { useAuth } from "@/firebase";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import imageCompression from 'browser-image-compression';
import { errorEmitter } from "@/firebase/error-emitter";
import { FirestorePermissionError } from "@/firebase/errors";
import { ReviewsSection } from "@/components/reviews-section";
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


const daysOfWeek = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const dayAbbreviations = ["S", "M", "T", "W", "T", "F", "S"];

const timeSlotSchema = z.object({
  from: z.string().min(1, "Required"),
  to: z.string().min(1, "Required"),
}).refine(data => {
  if (!data.from || !data.to) return true; // Let the min(1) handle empty fields
  return data.from < data.to;
}, {
  message: "End time must be after start time.",
  path: ["to"],
});

const availabilitySlotSchema = z.object({
  day: z.string(),
  timeSlots: z.array(timeSlotSchema).min(1, "At least one time slot is required."),
}).refine(data => {
  const sortedSlots = [...data.timeSlots].sort((a, b) => a.from.localeCompare(b.from));
  for (let i = 0; i < sortedSlots.length - 1; i++) {
    if (sortedSlots[i].to > sortedSlots[i + 1].from) {
      return false; // Overlap detected
    }
  }
  return true;
}, {
  message: "Time slots cannot overlap.",
  path: ["timeSlots"],
});


const weeklyAvailabilityFormSchema = z.object({
  availableDays: z.array(z.string()).default([]),
  availabilitySlots: z.array(availabilitySlotSchema).min(1, "At least one availability slot is required."),
});

type WeeklyAvailabilityFormValues = z.infer<typeof weeklyAvailabilityFormSchema>;

const StarRating = ({ rating }: { rating: number }) => (
  <div className="flex items-center">
    {[...Array(5)].map((_, i) => (
      <Star
        key={i}
        className={cn("h-4 w-4", i < rating ? "text-yellow-400 fill-yellow-400" : "text-gray-300")}
      />
    ))}
  </div>
);

const DoctorListItem = ({ doctor, onSelect, isSelected }: { doctor: Doctor, onSelect: () => void, isSelected: boolean }) => (
  <Card
    className={cn(
      "p-3 flex items-center gap-3 cursor-pointer transition-all duration-200 border-2",
      isSelected ? "border-primary bg-primary/10" : "border-transparent hover:bg-muted/50"
    )}
    onClick={onSelect}
  >
    <div className="relative flex-shrink-0">
      <Image
        src={doctor.avatar}
        alt={doctor.name}
        width={40}
        height={40}
        className="rounded-full object-cover"
        data-ai-hint="doctor portrait"
      />
      <span className={cn(
        "absolute bottom-0 right-0 block h-2.5 w-2.5 rounded-full border-2 border-white",
        doctor.consultationStatus === "In" ? "bg-green-500" : "bg-red-500"
      )} />
    </div>
    <div>
      <p className="font-semibold text-sm">{doctor.name}</p>
      <p className="text-xs text-muted-foreground">{doctor.department}</p>
    </div>
  </Card>
);

const generateTimeOptions = (startTime: string, endTime: string, interval: number): string[] => {
  const options = [];
  let currentTime = parse(startTime, "HH:mm", new Date());
  const end = parse(endTime, "HH:mm", new Date());

  while (isBefore(currentTime, end)) {
    options.push(format(currentTime, "HH:mm"));
    currentTime = addMinutes(currentTime, interval);
  }
  options.push(format(end, "HH:mm")); // Include the end time
  return options;
};

export default function DoctorsPage() {
  const auth = useAuth();
  const [isPending, startTransition] = useTransition();
  const [dateRange, setDateRange] = useState<DateRange | undefined>({
    from: subDays(new Date(), 29),
    to: new Date(),
  });
  const [activeTab, setActiveTab] = useState("details");

  const searchParams = useSearchParams();
  const doctorIdFromUrl = searchParams.get('doctorId');

  const form = useForm<WeeklyAvailabilityFormValues>({
    resolver: zodResolver(weeklyAvailabilityFormSchema),
    defaultValues: {
      availableDays: [],
      availabilitySlots: [],
    },
    mode: "onBlur",
  });

  const { toast } = useToast();

  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [selectedDoctor, setSelectedDoctor] = useState<Doctor | null>(null);
  const [clinicDepartments, setClinicDepartments] = useState<Department[]>([]);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [leaveCalDate, setLeaveCalDate] = useState<Date>(new Date());
  const [clinicDetails, setClinicDetails] = useState<any | null>(null);

  const [isEditingTime, setIsEditingTime] = useState(false);
  const [newAvgTime, setNewAvgTime] = useState<number | string>("");
  const [isEditingFee, setIsEditingFee] = useState(false);
  const [newFee, setNewFee] = useState<number | string>("");

  const [isEditingDetails, setIsEditingDetails] = useState(false);
  const [activeBreakTab, setActiveBreakTab] = useState<'schedule' | 'blocked'>('schedule');
  const [isEditingBio, setIsEditingBio] = useState(false);
  const [newName, setNewName] = useState("");
  const [newBio, setNewBio] = useState("");
  const [newSpecialty, setNewSpecialty] = useState("");
  const [newDepartment, setNewDepartment] = useState("");
  const [newExperience, setNewExperience] = useState<number | string>("");
  const [newRegistrationNumber, setNewRegistrationNumber] = useState("");
  const [newPhoto, setNewPhoto] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);


  const [isEditingAvailability, setIsEditingAvailability] = useState(false);

  const [selectedDays, setSelectedDays] = useState<string[]>([]);
  const [sharedTimeSlots, setSharedTimeSlots] = useState<Array<{ from: string; to: string }>>([{ from: "09:00", to: "17:00" }]);

  const [searchTerm, setSearchTerm] = useState("");
  const [departmentFilter, setDepartmentFilter] = useState("All");
  const [currentPage, setCurrentPage] = useState(1);
  const [doctorsPerPage, setDoctorsPerPage] = useState(10);
  const [isAddDoctorOpen, setIsAddDoctorOpen] = useState(false);
  const [editingDoctor, setEditingDoctor] = useState<Doctor | null>(null);

  const [isEditingFollowUp, setIsEditingFollowUp] = useState(false);
  const [newFollowUp, setNewFollowUp] = useState<number | string>(0);
  const [isEditingBooking, setIsEditingBooking] = useState(false);
  const [newBooking, setNewBooking] = useState<number | string>(0);
  const [isUpdatingConsultationStatus, setIsUpdatingConsultationStatus] = useState(false);

  // State for break scheduling (multi-break support)
  const [breakStartSlot, setBreakStartSlot] = useState<SlotInfo | null>(null);
  const [breakEndSlot, setBreakEndSlot] = useState<SlotInfo | null>(null);
  const [currentSession, setCurrentSession] = useState<SessionInfo | null>(null);
  const [existingBreaks, setExistingBreaks] = useState<BreakPeriod[]>([]);
  const [availableSlots, setAvailableSlots] = useState<{
    currentSessionSlots: SlotInfo[];
    upcomingSessionSlots: Map<number, SlotInfo[]>;
  } | null>(null);
  const [allBookedSlots, setAllBookedSlots] = useState<number[]>([]);
  const [isSubmittingBreak, setIsSubmittingBreak] = useState(false);
  const [showExtensionDialog, setShowExtensionDialog] = useState(false);
  const [pendingBreakData, setPendingBreakData] = useState<{
    startSlot: SlotInfo;
    endSlot: SlotInfo;
    sessionIndex?: number;
    sessionStart?: Date;
    sessionEnd?: Date;
    sessionEffectiveEnd?: Date;
  } | null>(null);
  const [extensionOptions, setExtensionOptions] = useState<{
    hasOverrun: boolean;
    minimalExtension: number;
    fullExtension: number;
    actualExtensionNeeded?: number; // Gap-aware extension amount
    lastTokenBefore: string;
    lastTokenAfter: string;
    originalEnd: string;
    breakDuration: number;
    estimatedFinishTime: string;
  } | null>(null);

  useEffect(() => {
    if (!auth.currentUser) return;

    const fetchAllData = async () => {
      try {
        const userDocRef = doc(db, "users", auth.currentUser!.uid);
        const userDocSnap = await getDoc(userDocRef);
        const clinicId = userDocSnap.data()?.clinicId;

        if (!clinicId) {
          toast({ variant: "destructive", title: "Error", description: "Clinic not found for this user." });
          return;
        }

        const doctorsQuery = query(collection(db, "doctors"), where("clinicId", "==", clinicId));
        const appointmentsQuery = query(collection(db, "appointments"), where("clinicId", "==", clinicId));

        const [doctorsSnapshot, appointmentsSnapshot, masterDepartmentsSnapshot, clinicDocSnap] = await Promise.all([
          getDocs(doctorsQuery),
          getDocs(appointmentsQuery),
          getDocs(collection(db, "master-departments")),
          getDoc(doc(db, "clinics", clinicId))
        ]);

        if (clinicDocSnap.exists()) {
          setClinicDetails(clinicDocSnap.data());
        }

        const masterDepartmentsList = masterDepartmentsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Department));

        if (clinicDocSnap.exists()) {
          const clinicData = clinicDocSnap.data();
          const departmentIds: string[] = clinicData.departments || [];
          const deptsForClinic = masterDepartmentsList.filter(masterDept => departmentIds.includes(masterDept.id));
          setClinicDepartments(deptsForClinic);
        }

        const doctorsList = doctorsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data(), clinicId } as Doctor));
        setDoctors(doctorsList);
        if (doctorsList.length > 0 && !selectedDoctor) {
          setSelectedDoctor(doctorsList[0]);
        }

        const appointmentsList = appointmentsSnapshot.docs.map(doc => doc.data() as Appointment);
        setAppointments(appointmentsList);

      } catch (error) {
        console.error("Error fetching data:", error);
        toast({
          variant: "destructive",
          title: "Error",
          description: "Failed to load data. Please try again.",
        });
      }
    };

    fetchAllData();
  }, [auth.currentUser, toast, selectedDoctor]);

  // Auto-select doctor from URL parameter
  useEffect(() => {
    if (doctorIdFromUrl && doctors.length > 0) {
      const doctorFromUrl = doctors.find(doctor => doctor.id === doctorIdFromUrl);
      if (doctorFromUrl && (!selectedDoctor || selectedDoctor.id !== doctorIdFromUrl)) {
        setSelectedDoctor(doctorFromUrl);
      }
    }
  }, [doctorIdFromUrl, doctors, selectedDoctor]);


  useEffect(() => {
    if (selectedDoctor) {
      setNewAvgTime(selectedDoctor.averageConsultingTime || "");
      setNewFee(selectedDoctor.consultationFee || "");
      setNewFollowUp(selectedDoctor.freeFollowUpDays || 0);
      setNewBooking(selectedDoctor.advanceBookingDays || 0);
      setNewName(selectedDoctor.name);
      setNewBio(selectedDoctor.bio || "");
      setNewSpecialty(selectedDoctor.specialty);
      setNewDepartment(selectedDoctor.department || "");
      setNewExperience(selectedDoctor.experience || 0);
      setNewRegistrationNumber(selectedDoctor.registrationNumber || "");
      setPhotoPreview(selectedDoctor.avatar);
      setNewPhoto(null);
      form.reset({
        availabilitySlots: selectedDoctor.availabilitySlots || [],
      });
      setIsEditingDetails(false);
      setIsEditingBio(false);
      setIsEditingAvailability(false);
      setIsEditingTime(false);
      setIsEditingFee(false);
      setIsEditingFollowUp(false);
      setIsEditingBooking(false);
    }
  }, [selectedDoctor, appointments, form]);

  useEffect(() => {
    if (selectedDoctor && leaveCalDate) {
      const dateStr = format(leaveCalDate, "d MMMM yyyy");
      const appointmentsOnDate = appointments.filter(apt => apt.doctor === selectedDoctor.name && apt.date === dateStr);
      const fetchedBookedSlots = appointmentsOnDate.map(d => parseTimeUtil(d.time, leaveCalDate).getTime());
      setAllBookedSlots(fetchedBookedSlots);
    }
  }, [selectedDoctor, leaveCalDate, appointments]);

  const handlePhotoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setNewPhoto(file);
      const reader = new FileReader();
      reader.onloadend = () => {
        setPhotoPreview(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };


  const handleEditAvailability = () => {
    if (!selectedDoctor) return;

    const availabilitySlotsForForm = selectedDoctor.availabilitySlots?.map(s => {
      return {
        ...s,
        timeSlots: s.timeSlots.map(ts => {
          try {
            // If already in HH:mm, this will work. If in hh:mm a, it will convert.
            const parsedFrom = parse(ts.from, 'hh:mm a', new Date());
            const parsedTo = parse(ts.to, 'hh:mm a', new Date());

            return {
              from: !isNaN(parsedFrom.valueOf()) ? format(parsedFrom, 'HH:mm') : ts.from,
              to: !isNaN(parsedTo.valueOf()) ? format(parsedTo, 'HH:mm') : ts.to
            }
          } catch {
            return { from: ts.from, to: ts.to };
          }
        })
      };
    }) || [];

    form.reset({
      availabilitySlots: availabilitySlotsForForm,
    });

    setIsEditingAvailability(true);
  };

  const handleDoctorSaved = (savedDoctor: Doctor) => {
    setDoctors(prev => {
      const index = prev.findIndex(d => d.id === savedDoctor.id);
      if (index > -1) {
        // Update existing doctor
        const newDoctors = [...prev];
        newDoctors[index] = savedDoctor;
        return newDoctors;
      } else {
        // Add new doctor
        return [...prev, savedDoctor];
      }
    });
    setSelectedDoctor(savedDoctor);
  };

  const handleTimeSave = async () => {
    if (!selectedDoctor || newAvgTime === "") return;
    const timeValue = Number(newAvgTime);
    if (isNaN(timeValue) || timeValue <= 0) {
      toast({ variant: "destructive", title: "Invalid Time", description: "Please enter a valid number." });
      return;
    }

    startTransition(async () => {
      const doctorRef = doc(db, "doctors", selectedDoctor.id);
      try {
        await updateDoc(doctorRef, { averageConsultingTime: timeValue });
        const updatedDoctor = { ...selectedDoctor, averageConsultingTime: timeValue };
        setSelectedDoctor(updatedDoctor);
        setDoctors(prev => prev.map(d => d.id === selectedDoctor.id ? updatedDoctor : d));
        setIsEditingTime(false);
        toast({
          title: "Consulting Time Updated",
          description: `Average consulting time set to ${timeValue} minutes.`,
        });
      } catch (error) {
        console.error("Error updating time:", error);
        toast({
          variant: "destructive",
          title: "Update Failed",
          description: "Could not update the consulting time.",
        });
      }
    });
  }

  const handleFeeSave = async () => {
    if (!selectedDoctor || newFee === "") return;
    const feeValue = Number(newFee);
    if (isNaN(feeValue) || feeValue < 0) {
      toast({ variant: "destructive", title: "Invalid Fee", description: "Please enter a valid non-negative number." });
      return;
    }

    startTransition(async () => {
      const doctorRef = doc(db, "doctors", selectedDoctor.id);
      try {
        await updateDoc(doctorRef, { consultationFee: feeValue });
        const updatedDoctor = { ...selectedDoctor, consultationFee: feeValue };
        setSelectedDoctor(updatedDoctor);
        setDoctors(prev => prev.map(d => d.id === selectedDoctor.id ? updatedDoctor : d));
        setIsEditingFee(false);
        toast({
          title: "Consultation Fee Updated",
          description: `Consultation fee set to ₹${feeValue}.`,
        });
      } catch (error) {
        console.error("Error updating fee:", error);
        toast({
          variant: "destructive",
          title: "Update Failed",
          description: "Could not update the consultation fee.",
        });
      }
    });
  };

  const handleFollowUpSave = async () => {
    if (!selectedDoctor || newFollowUp === "") return;
    const value = Number(newFollowUp);
    if (isNaN(value) || value < 0) {
      toast({ variant: "destructive", title: "Invalid Value", description: "Please enter a valid non-negative number of days." });
      return;
    }
    startTransition(async () => {
      try {
        const doctorRef = doc(db, "doctors", selectedDoctor.id);
        await updateDoc(doctorRef, { freeFollowUpDays: value });
        const updatedDoctor = { ...selectedDoctor, freeFollowUpDays: value };
        setSelectedDoctor(updatedDoctor);
        setDoctors(prev => prev.map(d => d.id === updatedDoctor.id ? updatedDoctor : d));
        setIsEditingFollowUp(false);
        toast({ title: "Success", description: "Free follow-up period updated." });
      } catch (error) {
        console.error("Error updating follow-up days:", error);
        toast({ variant: "destructive", title: "Error", description: "Failed to update follow-up period." });
      }
    });
  };

  const handleBookingSave = async () => {
    if (!selectedDoctor || newBooking === "") return;
    const value = Number(newBooking);
    if (isNaN(value) || value < 0) {
      toast({ variant: "destructive", title: "Invalid Value", description: "Please enter a valid non-negative number of days." });
      return;
    }
    startTransition(async () => {
      try {
        const doctorRef = doc(db, "doctors", selectedDoctor.id);
        await updateDoc(doctorRef, { advanceBookingDays: value });
        const updatedDoctor = { ...selectedDoctor, advanceBookingDays: value };
        setSelectedDoctor(updatedDoctor);
        setDoctors(prev => prev.map(d => d.id === updatedDoctor.id ? updatedDoctor : d));
        setIsEditingBooking(false);
        toast({ title: "Success", description: "Advance booking period updated." });
      } catch (error) {
        console.error("Error updating booking days:", error);
        toast({ variant: "destructive", title: "Error", description: "Failed to update booking period." });
      }
    });
  };

  const handleDetailsSave = async () => {
    if (!selectedDoctor || !auth.currentUser) return;
    if (newName.trim() === "" || newSpecialty.trim() === "" || newDepartment.trim() === "") {
      toast({ variant: "destructive", title: "Invalid Details", description: "Name, specialty, and department cannot be empty." });
      return;
    }

    startTransition(async () => {
      try {
        let photoUrl = selectedDoctor.avatar;
        if (newPhoto) {
          const options = { maxSizeMB: 0.5, maxWidthOrHeight: 800, useWebWorker: true };
          const compressedFile = await imageCompression(newPhoto, options);
          const formData = new FormData();
          formData.append('file', compressedFile);
          formData.append('clinicId', selectedDoctor.clinicId);
          formData.append('userId', auth.currentUser!.uid);

          const response = await fetch('/api/upload-avatar', {
            method: 'POST',
            body: formData,
          });

          if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || 'Upload failed');
          }
          const data = await response.json();
          photoUrl = data.url;
        }

        const updatedData = {
          name: newName,
          specialty: newSpecialty,
          department: newDepartment,
          experience: Number(newExperience),
          registrationNumber: newRegistrationNumber,
          avatar: photoUrl,
        };

        const doctorRef = doc(db, "doctors", selectedDoctor.id);
        await updateDoc(doctorRef, updatedData);
        const updatedDoctor = { ...selectedDoctor, ...updatedData };

        setSelectedDoctor(updatedDoctor);
        setDoctors(prev => prev.map(d => d.id === selectedDoctor.id ? updatedDoctor : d));
        setNewPhoto(null);
        setIsEditingDetails(false);

        toast({
          title: "Doctor Details Updated",
          description: `Dr. ${newName}'s details have been updated.`,
        });
      } catch (error) {
        console.error("Error updating details:", error);
        toast({ variant: "destructive", title: "Update Failed", description: "Could not update doctor details." });
      }
    });
  };

  const handleBioSave = async () => {
    if (!selectedDoctor) return;

    startTransition(async () => {
      const doctorRef = doc(db, "doctors", selectedDoctor.id);
      try {
        await updateDoc(doctorRef, { bio: newBio });
        const updatedDoctor = { ...selectedDoctor, bio: newBio };
        setSelectedDoctor(updatedDoctor);
        setDoctors(prev => prev.map(d => d.id === selectedDoctor.id ? updatedDoctor : d));
        setIsEditingBio(false);
        toast({
          title: "Bio Updated",
          description: `Dr. ${selectedDoctor.name}'s bio has been updated.`,
        });
      } catch (error) {
        console.error("Error updating bio:", error);
        toast({ variant: "destructive", title: "Update Failed", description: "Could not update doctor's bio." });
      }
    });
  };

  const handleAvailabilitySave = (values: WeeklyAvailabilityFormValues) => {
    if (!selectedDoctor) return;

    const validSlots = values.availabilitySlots
      .map(slot => {
        const filteredTimeSlots = slot.timeSlots.filter(ts => ts.from && ts.to);
        return { ...slot, timeSlots: filteredTimeSlots };
      })
      .filter(slot => slot.timeSlots.length > 0);

    const newAvailabilitySlots = validSlots.map(s => ({
      ...s,
      timeSlots: s.timeSlots.map(ts => ({
        from: format(parse(ts.from, "HH:mm", new Date()), "hh:mm a"),
        to: format(parse(ts.to, "HH:mm", new Date()), "hh:mm a")
      }))
    }));

    const scheduleString = newAvailabilitySlots
      ?.sort((a, b) => daysOfWeek.indexOf(a.day) - daysOfWeek.indexOf(b.day))
      .map(slot => `${slot.day}: ${slot.timeSlots.map(ts => `${ts.from}-${ts.to}`).join(', ')}`)
      .join('; ');

    startTransition(async () => {
      const doctorRef = doc(db, "doctors", selectedDoctor.id);
      try {
        await updateDoc(doctorRef, {
          availabilitySlots: newAvailabilitySlots,
          schedule: scheduleString,
        });

        const updatedDoctor = { ...selectedDoctor, availabilitySlots: newAvailabilitySlots, schedule: scheduleString, breakPeriods: selectedDoctor.breakPeriods };

        setSelectedDoctor(updatedDoctor);
        setDoctors(prev => prev.map(d => d.id === selectedDoctor.id ? updatedDoctor : d));
        setIsEditingAvailability(false);
        toast({
          title: "Availability Updated",
          description: "Weekly availability has been successfully updated.",
        });
      } catch (error) {
        console.error("Error updating availability:", error);
        toast({
          variant: "destructive",
          title: "Update Failed",
          description: "Could not update weekly availability.",
        });
      }
    });
  }

  const handleDeleteTimeSlot = async (day: string, timeSlot: TimeSlot) => {
    if (!selectedDoctor) return;

    const updatedAvailabilitySlots = selectedDoctor.availabilitySlots?.map(slot => {
      if (slot.day === day) {
        const updatedTimeSlots = slot.timeSlots.filter(ts => ts.from !== timeSlot.from || ts.to !== timeSlot.to);
        return { ...slot, timeSlots: updatedTimeSlots };
      }
      return slot;
    }).filter(slot => slot.timeSlots.length > 0);

    startTransition(async () => {
      const doctorRef = doc(db, "doctors", selectedDoctor.id);
      try {
        await updateDoc(doctorRef, {
          availabilitySlots: updatedAvailabilitySlots,
          // leaveSlots: cleanedLeaveSlots  <-- Removed
        });
        const updatedDoctor = { ...selectedDoctor, availabilitySlots: updatedAvailabilitySlots, breakPeriods: selectedDoctor.breakPeriods };
        setSelectedDoctor(updatedDoctor);
        setDoctors(prev => prev.map(d => d.id === selectedDoctor.id ? updatedDoctor : d));
        toast({
          title: "Time Slot Deleted",
          description: `The time slot has been removed from ${day}.`,
        });
      } catch (error) {
        console.error("Error deleting time slot:", error);
        toast({
          variant: "destructive",
          title: "Update Failed",
          description: "Could not delete the time slot.",
        });
      }
    });
  };

  const applySharedSlotsToSelectedDays = () => {
    if (selectedDays.length === 0) {
      toast({
        variant: "destructive",
        title: "No days selected",
        description: "Please select one or more days to apply the time slots.",
      });
      return;
    }

    const validSharedTimeSlots = sharedTimeSlots.filter(ts => ts.from && ts.to);

    if (validSharedTimeSlots.length === 0) {
      toast({
        variant: "destructive",
        title: "No time slots defined",
        description: "Please define at least one valid time slot.",
      });
      return;
    }

    for (const day of selectedDays) {
      const clinicDay = clinicDetails?.operatingHours?.find((h: any) => h.day === day);
      if (!clinicDay || clinicDay.isClosed) {
        toast({ variant: "destructive", title: "Invalid Day", description: `Clinic is closed on ${day}.` });
        return;
      }

      for (const slot of validSharedTimeSlots) {
        let withinHours = false;
        for (const clinicSlot of clinicDay.timeSlots) {
          if (slot.from >= clinicSlot.open && slot.to <= clinicSlot.close) {
            withinHours = true;
            break;
          }
        }
        if (!withinHours) {
          toast({ variant: "destructive", title: "Invalid Time Slot", description: `Slot for ${day} is outside clinic operating hours.` });
          return;
        }
      }
    }

    const currentFormSlots = form.getValues('availabilitySlots') || [];
    const newSlotsMap = new Map<string, { day: string; timeSlots: { from: string; to: string }[] }>();

    currentFormSlots.forEach(slot => newSlotsMap.set(slot.day, slot));

    selectedDays.forEach(day => {
      newSlotsMap.set(day, { day, timeSlots: validSharedTimeSlots });
    });

    const updatedSlots = Array.from(newSlotsMap.values());
    form.setValue('availabilitySlots', updatedSlots, { shouldDirty: true, shouldValidate: true });

    toast({
      title: "Time Slots Applied",
      description: `The defined time slots have been applied to the selected days.`,
    });

    setSelectedDays([]);
  };

  const filteredDoctors = useMemo(() => {
    return doctors.filter(doctor => {
      const searchTermLower = searchTerm.toLowerCase();

      const matchesSearchTerm = (
        doctor.name.toLowerCase().includes(searchTermLower) ||
        doctor.specialty.toLowerCase().includes(searchTermLower)
      );

      const matchesDepartment = departmentFilter === 'All' || doctor.department === departmentFilter;

      return matchesSearchTerm && matchesDepartment;
    });
  }, [doctors, searchTerm, departmentFilter]);

  const totalPages = Math.ceil(filteredDoctors.length / doctorsPerPage);
  const currentDoctors = filteredDoctors.slice(
    (currentPage - 1) * doctorsPerPage,
    currentPage * doctorsPerPage
  );

  const isDoctorLimitReached = clinicDetails ? doctors.length >= clinicDetails.numDoctors : false;

  const openAddDoctorDialog = () => {
    setEditingDoctor(null);
    setIsAddDoctorOpen(true);
  };

  // Load existing breaks and available slots when date or doctor changes
  useEffect(() => {
    if (!selectedDoctor || !leaveCalDate) {
      setCurrentSession(null);
      setExistingBreaks([]);
      setAvailableSlots(null);
      return;
    }

    const now = new Date();
    let session = getCurrentActiveSession(selectedDoctor, now, leaveCalDate);

    // If no active session found, try to get the first available session for the date
    // This allows scheduling breaks even when no session is currently active
    if (!session) {
      const dayOfWeek = format(leaveCalDate, 'EEEE');
      const availabilityForDay = selectedDoctor.availabilitySlots?.find(s => s.day === dayOfWeek);

      if (availabilityForDay?.timeSlots?.length) {
        // Get the first session that hasn't ended yet, or the first session if all have ended
        for (let i = 0; i < availabilityForDay.timeSlots.length; i++) {
          const timeSlot = availabilityForDay.timeSlots[i];
          const sessionStart = parse(timeSlot.from, 'hh:mm a', leaveCalDate);
          const sessionEnd = parse(timeSlot.to, 'hh:mm a', leaveCalDate);

          // Use this session if it hasn't ended yet, or if it's the last session
          if (isAfter(sessionEnd, now) || i === availabilityForDay.timeSlots.length - 1) {
            const breaks = getSessionBreaks(selectedDoctor, leaveCalDate, i);
            const dateKey = format(leaveCalDate, 'd MMMM yyyy');
            const storedExtension = selectedDoctor.availabilityExtensions?.[dateKey]?.sessions?.find(
              s => s.sessionIndex === i
            );

            let effectiveEnd: Date;
            let totalBreakMinutes: number;
            if (storedExtension) {
              totalBreakMinutes = breaks.reduce((sum, bp) => sum + bp.duration, 0);
              effectiveEnd = storedExtension.totalExtendedBy > 0
                ? addMinutes(sessionEnd, storedExtension.totalExtendedBy)
                : sessionEnd;
            } else {
              const extension = calculateSessionExtension(i, breaks, sessionEnd, appointments, selectedDoctor, leaveCalDate);
              effectiveEnd = extension.newSessionEnd;
              totalBreakMinutes = extension.totalBreakMinutes;
            }

            session = {
              sessionIndex: i,
              session: timeSlot,
              sessionStart,
              sessionEnd,
              breaks,
              totalBreakMinutes,
              effectiveEnd,
              originalEnd: sessionEnd
            };
            break;
          }
        }
      }
    }

    if (session) {
      setCurrentSession(session);

      // Get all breaks for the current session
      const breaks = getSessionBreaks(selectedDoctor, leaveCalDate, session.sessionIndex);
      setExistingBreaks(breaks);

      // Get available slots (current + upcoming sessions)
      // Pass the session we found/created so it works even when no active session exists
      const slots = getAvailableBreakSlots(selectedDoctor, now, leaveCalDate, session, appointments);
      setAvailableSlots(slots);
    } else {
      setCurrentSession(null);
      setExistingBreaks([]);
      setAvailableSlots(null);
    }

    // Reset selection
    setBreakStartSlot(null);
    setBreakEndSlot(null);
  }, [selectedDoctor, leaveCalDate]);

  const dailyLeaveSlots: any[] = [];

  const canCancelBreak = useMemo(() => {
    return true;
  }, []);

  const allTimeSlotsForDay = useMemo((): Date[] => {
    if (!selectedDoctor || !leaveCalDate) return [];
    const dayOfWeek = format(leaveCalDate, 'EEEE');
    const doctorAvailabilityForDay = selectedDoctor.availabilitySlots?.find(slot => slot.day === dayOfWeek);
    if (!doctorAvailabilityForDay) return [];

    const slots: Date[] = [];
    const consultationTime = selectedDoctor.averageConsultingTime || 15;

    doctorAvailabilityForDay.timeSlots.forEach(timeSlot => {
      let currentTime = parseTimeUtil(timeSlot.from, leaveCalDate);
      const endTime = parseTimeUtil(timeSlot.to, leaveCalDate);
      while (currentTime < endTime) {
        slots.push(new Date(currentTime));
        currentTime = addMinutes(currentTime, consultationTime);
      }
    });
    return slots;
  }, [selectedDoctor, leaveCalDate]);


  const handleSlotClick = (slotInfo: SlotInfo) => {
    if (slotInfo.isTaken) return; // Can't select taken slots

    const slotDate = parseISO(slotInfo.isoString);

    if (!breakStartSlot || !breakEndSlot) {
      // Start new selection or set end slot
      if (!breakStartSlot) {
        // No start slot yet - set as start
        setBreakStartSlot(slotInfo);
        setBreakEndSlot(null);
      } else {
        // Have start slot, set end slot
        const startDate = parseISO(breakStartSlot.isoString);
        if (slotDate < startDate) {
          // If clicked slot is before start, make it the new start
          setBreakStartSlot(slotInfo);
          setBreakEndSlot(null);
        } else {
          // Set as end slot
          setBreakEndSlot(slotInfo);
        }
      }
    } else {
      // Both slots selected - start new selection
      setBreakStartSlot(slotInfo);
      setBreakEndSlot(null);
    }
  };

  const handleConfirmBreak = async () => {
    console.log("[BREAK DEBUG] Confirm clicked", {
      doctor: selectedDoctor?.name,
      date: leaveCalDate ? format(leaveCalDate, "d MMMM yyyy") : null,
      currentSession,
      breakStartSlot,
      breakEndSlot,
    });
    if (!selectedDoctor || !leaveCalDate || !breakStartSlot || !breakEndSlot) {
      toast({
        variant: 'destructive',
        title: 'Invalid Selection',
        description: 'Please select a start and end time for the break.'
      });
      return;
    }

    // Detect which session the selected break slots belong to
    const breakSessionIndex = breakStartSlot.sessionIndex;
    console.log("[BREAK DEBUG] Break session index", {
      breakStartSlotSessionIndex: breakStartSlot.sessionIndex,
      breakEndSlotSessionIndex: breakEndSlot.sessionIndex,
      currentSessionIndex: currentSession?.sessionIndex,
    });

    // Get the session info for the break's session
    const dayOfWeek = format(leaveCalDate, 'EEEE');
    const availabilityForDay = (selectedDoctor.availabilitySlots || []).find(slot => slot.day === dayOfWeek);

    if (!availabilityForDay || !availabilityForDay.timeSlots[breakSessionIndex]) {
      toast({
        variant: 'destructive',
        title: 'Invalid Session',
        description: 'Could not find session for selected break slots.'
      });
      return;
    }

    const breakSession = availabilityForDay.timeSlots[breakSessionIndex];
    const breakSessionStart = parseTimeUtil(breakSession.from, leaveCalDate);
    const breakSessionEnd = parseTimeUtil(breakSession.to, leaveCalDate);

    // Get breaks for this session
    const breaksForSession = getSessionBreaks(selectedDoctor, leaveCalDate, breakSessionIndex);

    // Get session extension info
    const dateKey = format(leaveCalDate, 'd MMMM yyyy');
    const storedExtension = selectedDoctor.availabilityExtensions?.[dateKey]?.sessions?.find(
      s => s.sessionIndex === breakSessionIndex
    );



    let breakSessionEffectiveEnd: Date;
    // CRITICAL FIX: Validate that the stored extension actually belongs to THIS session time.
    // If the doctor changed their schedule, the sessionIndex might be the same but the times different.
    const currentSessionEndStr = format(breakSessionEnd, 'hh:mm a');
    const isExtensionValid = storedExtension && storedExtension.originalEndTime === currentSessionEndStr;

    if (isExtensionValid && storedExtension) {
      breakSessionEffectiveEnd = storedExtension.totalExtendedBy > 0
        ? addMinutes(breakSessionEnd, storedExtension.totalExtendedBy)
        : breakSessionEnd;
    } else {
      if (storedExtension) {
      }
      // No stored extension - default to original end to correctly detect overruns
      breakSessionEffectiveEnd = breakSessionEnd;
    }


    // Convert range to array of slot ISO strings
    const slotDuration = selectedDoctor.averageConsultingTime || 15;
    const startDate = parseISO(breakStartSlot.isoString);
    const endDate = parseISO(breakEndSlot.isoString);
    const breakDuration = differenceInMinutes(endDate, startDate) + slotDuration;

    const selectedBreakSlots: string[] = [];
    let currentTime = new Date(startDate);
    while (currentTime <= endDate) {
      selectedBreakSlots.push(currentTime.toISOString());
      currentTime = addMinutes(currentTime, slotDuration);
    }

    console.log("[BREAK DEBUG] Break details", {
      breakSessionIndex,
      breakSessionStart: format(breakSessionStart, 'hh:mm a'),
      breakSessionEnd: format(breakSessionEnd, 'hh:mm a'),
      breakSessionEffectiveEnd: format(breakSessionEffectiveEnd, 'hh:mm a'),
      selectedBreakSlots: selectedBreakSlots.length,
      breakDuration,
    });

    // Validate break slots using the correct session
    const validation = validateBreakSlots(
      selectedBreakSlots,
      breaksForSession,
      breakSessionIndex,
      breakSessionStart,
      breakSessionEnd
    );

    if (!validation.valid) {
      toast({
        variant: 'destructive',
        title: 'Invalid Break',
        description: validation.error
      });
      return;
    }


    // Calculate extension options before showing dialog
    let hasOverrun = false;
    let minimalExtension = 0;
    let lastTokenBefore = '';
    let lastTokenAfter = '';
    let originalEnd = format(breakSessionEnd, 'hh:mm a');

    // Get appointments for this specific session
    const dateStr = format(leaveCalDate, 'd MMMM yyyy');
    const appointmentsOnDate = appointments.filter(
      (apt) => apt.doctor === selectedDoctor.name &&
        apt.date === dateStr &&
        apt.sessionIndex === breakSessionIndex
    );

    // Calculate the ACTUAL shift amount using gap absorption logic
    let actualShiftAmount = 0;

    if (appointmentsOnDate.length > 0) {
      // Build a map of occupied slots
      const occupiedSlots = new Set<number>();
      appointmentsOnDate.forEach(apt => {
        if (typeof apt.slotIndex === 'number' && apt.status !== 'Cancelled' && !apt.cancelledByBreak) {
          occupiedSlots.add(apt.slotIndex);
        }
      });

      // Calculate which break slots have appointments
      const startDate = parseISO(breakStartSlot.isoString);
      const endDate = parseISO(breakEndSlot.isoString);
      const breakDuration = differenceInMinutes(endDate, startDate) + slotDuration;

      const breakStartSlotIndex = Math.floor(
        differenceInMinutes(startDate, breakSessionStart) / slotDuration
      );
      const slotsInBreak = breakDuration / slotDuration;

      // Count how many break slots have appointments (these need to be shifted)
      for (let i = 0; i < slotsInBreak; i++) {
        const slotIndex = breakStartSlotIndex + i;
        if (occupiedSlots.has(slotIndex)) {
          actualShiftAmount++;
        }
      }

      // Sort by arriveByTime (which already includes break offsets) to get the actual last appointment
      const sortedByArriveByTime = [...appointmentsOnDate].sort((a, b) => {
        const timeA = parseTimeUtil(a.arriveByTime || a.time, leaveCalDate).getTime();
        const timeB = parseTimeUtil(b.arriveByTime || b.time, leaveCalDate).getTime();
        return timeA - timeB;
      });

      const lastAppointment = sortedByArriveByTime[sortedByArriveByTime.length - 1];
      const consultationTime = selectedDoctor.averageConsultingTime || 15;

      // Use arriveByTime (already includes existing break offsets) as the base
      const lastArriveByTime = lastAppointment.arriveByTime
        ? parseTimeUtil(lastAppointment.arriveByTime, leaveCalDate)
        : parseTimeUtil(lastAppointment.time, leaveCalDate);

      lastTokenBefore = format(lastArriveByTime, 'hh:mm a');

      // After applying the NEW break, the last appointment shifts by ACTUAL shift amount (not full break duration)
      const actualShiftMinutes = actualShiftAmount * slotDuration;
      const lastTimeAfterBreak = addMinutes(lastArriveByTime, actualShiftMinutes);
      // The appointment still needs consultationTime to finish
      const lastAppointmentEnd = addMinutes(lastTimeAfterBreak, consultationTime);
      lastTokenAfter = format(lastTimeAfterBreak, 'hh:mm a');

      const overrunMinutes = Math.max(0, differenceInMinutes(lastAppointmentEnd, breakSessionEffectiveEnd));
      hasOverrun = overrunMinutes > 0;
      minimalExtension = overrunMinutes;
    }

    const estimatedFinishTime = hasOverrun || lastTokenAfter ? format(addMinutes(parseTimeUtil(lastTokenAfter, leaveCalDate), selectedDoctor.averageConsultingTime || 15), 'hh:mm a') : '';
    const breakDurationForDisplay = differenceInMinutes(parseISO(breakEndSlot.isoString), parseISO(breakStartSlot.isoString)) + slotDuration;
    const actualExtensionNeeded = actualShiftAmount * slotDuration; // Gap-aware extension

    setExtensionOptions({
      hasOverrun,
      minimalExtension,
      fullExtension: breakDurationForDisplay,
      actualExtensionNeeded, // NEW: Gap-aware extension to display
      lastTokenBefore,
      lastTokenAfter,
      originalEnd,
      breakDuration: breakDurationForDisplay,
      estimatedFinishTime
    });


    // Show dialog to ask about extending availability
    setPendingBreakData({
      startSlot: breakStartSlot,
      endSlot: breakEndSlot,
      sessionIndex: breakSessionIndex,
      sessionStart: breakSessionStart,
      sessionEnd: breakSessionEnd,
      sessionEffectiveEnd: breakSessionEffectiveEnd
    });
    setShowExtensionDialog(true);
  };

  const confirmBreakWithExtension = async (extensionMinutes: number | null) => {
    if (!pendingBreakData || !selectedDoctor || !leaveCalDate) {
      setShowExtensionDialog(false);
      setPendingBreakData(null);
      setExtensionOptions(null);
      return;
    }

    const { startSlot, endSlot, sessionIndex, sessionStart, sessionEnd, sessionEffectiveEnd } = pendingBreakData;

    if (sessionIndex === undefined || !sessionStart || !sessionEnd) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Session information is missing. Please try again.'
      });
      setShowExtensionDialog(false);
      setPendingBreakData(null);
      setExtensionOptions(null);
      return;
    }

    // Validate session overlap if extending
    if (extensionMinutes && extensionMinutes > 0) {
      const proposedEndTime = addMinutes(sessionEnd, extensionMinutes);
      const overlapValidation = validateBreakOverlapWithNextSession(
        selectedDoctor,
        leaveCalDate,
        sessionIndex,
        proposedEndTime
      );

      if (!overlapValidation.valid) {
        toast({
          variant: 'destructive',
          title: 'Cannot Extend Session',
          description: overlapValidation.error
        });
        setShowExtensionDialog(false);
        // Do NOT clear pending data immediately if we want them to correct it? 
        // But the current UI flow is modal-based. Fail safe:
        setPendingBreakData(null);
        setExtensionOptions(null);
        return;
      }
    }

    setIsSubmittingBreak(true);
    setShowExtensionDialog(false);
    setPendingBreakData(null);
    setExtensionOptions(null);

    try {
      // Convert range to array of slot ISO strings
      const startDate = parseISO(startSlot.isoString);
      const endDate = parseISO(endSlot.isoString);
      const slotDuration = selectedDoctor.averageConsultingTime || 15;

      const selectedBreakSlots: string[] = [];
      let currentTime = new Date(startDate);
      while (currentTime <= endDate) {
        selectedBreakSlots.push(currentTime.toISOString());
        currentTime = addMinutes(currentTime, slotDuration);
      }

      // Get existing breaks for this session
      const breaksForThisSession = getSessionBreaks(selectedDoctor, leaveCalDate, sessionIndex);

      // Create new break period
      const newBreak = createBreakPeriod(
        selectedBreakSlots,
        sessionIndex,
        slotDuration
      );

      // Merge with existing breaks if adjacent
      const allBreaks = [...breaksForThisSession, newBreak];
      const mergedBreaks = mergeAdjacentBreaks(allBreaks);

      // Handle availability extension if user chose to extend
      const doctorRef = doc(db, 'doctors', selectedDoctor.id);
      const dateKey = format(leaveCalDate, 'd MMMM yyyy');

      // Update breakPeriods - merge with breaks from other sessions
      const breakPeriods = { ...(selectedDoctor.breakPeriods || {}) };
      const allBreaksForDate = (breakPeriods[dateKey] || []).filter(
        (bp: BreakPeriod) => bp.sessionIndex !== sessionIndex
      );
      breakPeriods[dateKey] = [...allBreaksForDate, ...mergedBreaks];

      // Update availabilityExtensions (session-based)
      const availabilityExtensions = selectedDoctor.availabilityExtensions || {};
      if (!availabilityExtensions[dateKey]) {
        availabilityExtensions[dateKey] = { sessions: [] };
      }

      const sessionExtIndex = availabilityExtensions[dateKey].sessions.findIndex(
        s => s.sessionIndex === sessionIndex
      );

      if (extensionMinutes !== null && extensionMinutes > 0) {
        // User chose to extend - calculate new end time
        const originalEndTimeDate = sessionEnd;
        const newEndTimeDate = addMinutes(originalEndTimeDate, extensionMinutes);
        const newEndTime = format(newEndTimeDate, 'hh:mm a');

        const sessionExtension = {
          sessionIndex: sessionIndex,
          breaks: mergedBreaks,
          totalExtendedBy: extensionMinutes,
          originalEndTime: format(sessionEnd, 'hh:mm a'),
          newEndTime
        };

        if (sessionExtIndex >= 0) {
          availabilityExtensions[dateKey].sessions[sessionExtIndex] = sessionExtension;
        } else {
          availabilityExtensions[dateKey].sessions.push(sessionExtension);
        }
      } else {
        // User chose not to extend - just store breaks without extension
        // But we still need to track the break duration for session calculations
        const breakDuration = mergedBreaks.reduce((sum, b) => sum + b.duration, 0);
        const sessionExtension = {
          sessionIndex: sessionIndex,
          breaks: mergedBreaks,
          totalExtendedBy: 0, // No extension
          originalEndTime: format(sessionEnd, 'hh:mm a'),
          newEndTime: format(sessionEnd, 'hh:mm a') // Same as original
        };

        if (sessionExtIndex >= 0) {
          availabilityExtensions[dateKey].sessions[sessionExtIndex] = sessionExtension;
        } else {
          availabilityExtensions[dateKey].sessions.push(sessionExtension);
        }
      }

      const allBreakSlots = mergedBreaks.flatMap(b => b.slots);

      await updateDoc(doctorRef, {
        breakPeriods,
        availabilityExtensions
      });

      // Update affected appointments: add break duration to arriveByTime, cutOffTime, noShowTime
      try {
        console.log(`[BREAK CONFIRM] About to call shiftAppointmentsForNewBreak`, {
          newBreak,
          sessionIndex,
          leaveCalDate: format(leaveCalDate, 'd MMMM yyyy'),
          doctorName: selectedDoctor.name,
          clinicId: selectedDoctor.clinicId
        });
        await shiftAppointmentsForNewBreak(
          db,
          newBreak,
          sessionIndex,
          leaveCalDate,
          selectedDoctor.name,
          selectedDoctor.clinicId,
          selectedDoctor.averageConsultingTime
        );
        console.log(`[BREAK CONFIRM] shiftAppointmentsForNewBreak completed successfully`);
      } catch (error) {
        console.error(`[BREAK CONFIRM] Error in shiftAppointmentsForNewBreak:`, error);
        // Don't throw - break was already saved, just log the error
        toast({
          variant: 'destructive',
          title: 'Break Added',
          description: 'Break was added, but there was an error adjusting appointment times. Please check the console for details.'
        });
      }

      const extensionMessage = extensionMinutes !== null && extensionMinutes > 0
        ? `Break added. Session extended by ${extensionMinutes} minutes.`
        : 'Break added.';

      toast({
        title: 'Break Scheduled',
        description: extensionMessage
      });

      // Update local state
      const updatedDoctor = {
        ...selectedDoctor,
        breakPeriods,
        availabilityExtensions,

      };
      setSelectedDoctor(updatedDoctor);
      setDoctors(prev => prev.map(d => d.id === updatedDoctor.id ? updatedDoctor : d));

      // Manually recalculate session to reflect stored extension
      // Try to get the session we just updated, or fall back to active session
      const now = new Date();
      let recalculatedSession = getCurrentActiveSession(updatedDoctor, now, leaveCalDate);
      if (!recalculatedSession || recalculatedSession.sessionIndex !== sessionIndex) {
        // If active session is different, manually construct session info for the one we updated
        const dayOfWeek = format(leaveCalDate, 'EEEE');
        const availabilityForDay = updatedDoctor.availabilitySlots?.find(s => s.day === dayOfWeek);
        if (availabilityForDay?.timeSlots[sessionIndex]) {
          const timeSlot = availabilityForDay.timeSlots[sessionIndex];
          const sessionStart = parse(timeSlot.from, 'hh:mm a', leaveCalDate);
          const sessionEnd = parse(timeSlot.to, 'hh:mm a', leaveCalDate);
          const breaks = getSessionBreaks(updatedDoctor, leaveCalDate, sessionIndex);
          const dateKey = format(leaveCalDate, 'd MMMM yyyy');
          const storedExtension = updatedDoctor.availabilityExtensions?.[dateKey]?.sessions?.find(
            s => s.sessionIndex === sessionIndex
          );
          let effectiveEnd: Date;
          let totalBreakMinutes: number;
          if (storedExtension) {
            totalBreakMinutes = breaks.reduce((sum, bp) => sum + bp.duration, 0);
            effectiveEnd = storedExtension.totalExtendedBy > 0
              ? addMinutes(sessionEnd, storedExtension.totalExtendedBy)
              : sessionEnd;
          } else {
            const extension = calculateSessionExtension(sessionIndex, breaks, sessionEnd);
            effectiveEnd = extension.newSessionEnd;
            totalBreakMinutes = extension.totalBreakMinutes;
          }
          recalculatedSession = {
            sessionIndex,
            session: timeSlot,
            sessionStart,
            sessionEnd,
            breaks,
            totalBreakMinutes,
            effectiveEnd,
            originalEnd: sessionEnd
          };
        }
      }
      if (recalculatedSession) {
        setCurrentSession(recalculatedSession);
        setExistingBreaks(getSessionBreaks(updatedDoctor, leaveCalDate, recalculatedSession.sessionIndex));
        setAvailableSlots(getAvailableBreakSlots(updatedDoctor, now, leaveCalDate, recalculatedSession, appointments));
      }

      setBreakStartSlot(null);
      setBreakEndSlot(null);

    } catch (error) {
      console.error("Error scheduling break:", error);
      toast({ variant: 'destructive', title: 'Error', description: 'Failed to schedule break.' });
    } finally {
      setIsSubmittingBreak(false);
    }
  };

  const [cancelBreakPrompt, setCancelBreakPrompt] = useState<{ breakId: string } | null>(null);
  const [shouldCancelExtension, setShouldCancelExtension] = useState(true);
  const [shouldOpenSlots, setShouldOpenSlots] = useState(true);
  const [selectedBlockedSlots, setSelectedBlockedSlots] = useState<string[]>([]);
  const [isOpeningSlots, setIsOpeningSlots] = useState(false);

  const handleCancelBreak = async (breakId: string) => {
    if (!selectedDoctor || !leaveCalDate || !currentSession) {
      toast({ variant: 'destructive', title: 'Error', description: 'Cannot cancel break.' });
      return;
    }

    // Logic for default state moved to useEffect below to depend on calculated utilization
    setShouldOpenSlots(true);
    setCancelBreakPrompt({ breakId });
  };

  useEffect(() => {
    setBreakStartSlot(null);
    setBreakEndSlot(null);
    setSelectedBlockedSlots([]);
  }, [activeBreakTab]);

  // Calculate if and how much extension is needed by appointments
  const extensionUtilization = useMemo(() => {
    if (!currentSession?.originalEnd || !leaveCalDate || !selectedDoctor) {
      return { needed: false, maxExtensionNeeded: 0, currentExtensionDuration: 0 };
    }

    // If originalEnd and effectiveEnd are the same, there is no extension
    if (!currentSession.effectiveEnd || currentSession.effectiveEnd.getTime() === currentSession.originalEnd.getTime()) {
      return { needed: false, maxExtensionNeeded: 0, currentExtensionDuration: 0 };
    }

    const originalEnd = currentSession.originalEnd;
    const currentExtensionDuration = differenceInMinutes(currentSession.effectiveEnd, originalEnd);
    const dateStr = format(leaveCalDate, 'd MMMM yyyy');

    let maxExtensionNeeded = 0;
    let needed = false;

    appointments.forEach(appt => {
      // Filter for current session active appointments
      if (appt.doctor !== selectedDoctor.name ||
        appt.date !== dateStr ||
        appt.sessionIndex !== currentSession.sessionIndex) return;

      if (['Cancelled', 'No-show'].includes(appt.status)) return;

      // Check if appointment ends after the ORIGINAL session end
      const apptTimeStr = appt.arriveByTime || appt.time;
      const apptStart = parseTimeUtil(apptTimeStr, leaveCalDate);
      const apptEnd = addMinutes(apptStart, selectedDoctor.averageConsultingTime || 15);

      if (isAfter(apptEnd, originalEnd)) {
        needed = true;
        const extensionNeeded = differenceInMinutes(apptEnd, originalEnd);
        if (extensionNeeded > maxExtensionNeeded) {
          maxExtensionNeeded = extensionNeeded;
        }
      }
    });

    return { needed, maxExtensionNeeded, currentExtensionDuration };
  }, [currentSession, appointments, leaveCalDate, selectedDoctor]);

  // Update effect to handle default toggle state based on utilization
  useEffect(() => {
    if (extensionUtilization.maxExtensionNeeded >= extensionUtilization.currentExtensionDuration && extensionUtilization.currentExtensionDuration > 0) {
      // Fully needed: Must keep extension (so Cancel = false)
      setShouldCancelExtension(false);
    } else {
      // Partial or None: Default to Cancel (true)
      setShouldCancelExtension(true);
    }
  }, [extensionUtilization, cancelBreakPrompt]); // Re-run when prompt opens or util changes


  const handleConfirmCancelBreak = async () => {
    if (!cancelBreakPrompt || !selectedDoctor || !leaveCalDate || !currentSession) return;
    const { breakId } = cancelBreakPrompt;

    setCancelBreakPrompt(null);
    setIsSubmittingBreak(true);

    try {
      const breakToRemove = existingBreaks.find(b => b.id === breakId);
      if (!breakToRemove) {
        toast({ variant: 'destructive', title: 'Error', description: 'Break not found.' });
        setIsSubmittingBreak(false);
        return;
      }

      // Logic: If User wants to Open Slots, we must FREE them.
      if (shouldOpenSlots) {
        // Also delete slot-reservations for the cancelled appointments.
        const dateStr = format(leaveCalDate, 'd MMMM yyyy');
        const breakStart = parseISO(breakToRemove.startTime);
        const breakEnd = parseISO(breakToRemove.endTime);

        const q = query(
          collection(db, 'appointments'),
          where('doctor', '==', selectedDoctor.name),
          where('clinicId', '==', selectedDoctor.clinicId),
          where('date', '==', dateStr),
          where('sessionIndex', '==', currentSession.sessionIndex),
          where('cancelledByBreak', '==', true)
        );

        const snap = await getDocs(q);
        const batch = writeBatch(db);
        let updateCount = 0;
        const cancelledAppointmentIds: string[] = [];

        snap.docs.forEach((d: any) => {
          const data = d.data();
          const apptTime = parseTimeUtil(data.arriveByTime || data.time, leaveCalDate);

          if (apptTime >= breakStart && apptTime < breakEnd) {
            // Change status from 'Completed' to 'Cancelled' to make bookable
            // CRITICAL: Also remove cancelledByBreak flag so slot becomes available
            batch.update(d.ref, {
              status: 'Cancelled',
              cancelledByBreak: false  // Remove the flag to make slot available
            });
            updateCount++;

            // Delete the slot-reservation document
            const slotIndex = data.slotIndex;
            if (typeof slotIndex === 'number') {
              const reservationId = `${selectedDoctor.clinicId}_${selectedDoctor.name}_${dateStr}_slot_${slotIndex}`;
              const reservationRef = doc(db, 'slot-reservations', reservationId);
              batch.delete(reservationRef);
            }
            cancelledAppointmentIds.push(d.id);
          }
        });

        if (updateCount > 0) {
          await batch.commit();
          console.log(`[BREAK] Freed ${updateCount} slots by changing to Cancelled and deleting reservations.`);
        }
      }

      // Remove the break
      const remainingBreaks = existingBreaks.filter(b => b.id !== breakId);

      // Update Firestore
      const doctorRef = doc(db, 'doctors', selectedDoctor.id);
      const dateKey = format(leaveCalDate, 'd MMMM yyyy');

      // Update breakPeriods
      const breakPeriods = { ...(selectedDoctor.breakPeriods || {}) };

      if (remainingBreaks.length === 0) {
        if (breakPeriods[dateKey]) {
          delete breakPeriods[dateKey];
        }
      } else {
        breakPeriods[dateKey] = remainingBreaks;
      }

      // Recalculate availabilityExtensions for this session
      const dateStr = format(leaveCalDate, 'd MMMM yyyy');
      const availabilityExtensions = { ...(selectedDoctor.availabilityExtensions || {}) };

      if (!availabilityExtensions[dateStr]) {
        availabilityExtensions[dateStr] = { sessions: [] };
      }

      // Calculate new total duration from remaining breaks
      const totalBreakMinutes = remainingBreaks.reduce((sum, bp) => sum + bp.duration, 0);

      // Update the session extension entry
      const existingSessionExtIndex = availabilityExtensions[dateStr].sessions.findIndex((s: any) => s.sessionIndex === currentSession.sessionIndex);
      const currentExt = existingSessionExtIndex >= 0 ? availabilityExtensions[dateStr].sessions[existingSessionExtIndex] : null;
      const currentTotalExtendedBy = currentExt ? currentExt.totalExtendedBy : 0;

      const newTotalExtendedBy = shouldCancelExtension
        ? (() => {
          // SMART CANCELLATION LOGIC:
          // If user wants to cancel extension, check if we need to keep SOME of it
          // for existing appointments that are in the extended zone.

          if (!currentSession.originalEnd || !leaveCalDate) return 0;

          const originalSessionEnd = currentSession.originalEnd;
          const appointmentsInSession = appointments.filter(a =>
            a.doctor === selectedDoctor.name &&
            a.date === dateStr &&
            a.sessionIndex === currentSession.sessionIndex &&
            !['Cancelled', 'No-show'].includes(a.status)
          );

          let maxExtensionNeeded = 0;

          appointmentsInSession.forEach(appt => {
            const apptTimeStr = appt.arriveByTime || appt.time;
            const apptStart = parseTimeUtil(apptTimeStr, leaveCalDate);
            const apptEnd = addMinutes(apptStart, selectedDoctor.averageConsultingTime || 15);

            if (isAfter(apptEnd, originalSessionEnd)) {
              const extensionNeeded = differenceInMinutes(apptEnd, originalSessionEnd);
              if (extensionNeeded > maxExtensionNeeded) {
                maxExtensionNeeded = extensionNeeded;
              }
            }
          });

          return maxExtensionNeeded;
        })()
        : currentTotalExtendedBy;

      const newSessionExtension = {
        sessionIndex: currentSession.sessionIndex,
        breaks: remainingBreaks,
        totalExtendedBy: newTotalExtendedBy,
        originalEndTime: currentSession.originalEnd ? format(currentSession.originalEnd, 'hh:mm a') : '',
        newEndTime: currentSession.originalEnd
          ? format(addMinutes(currentSession.originalEnd, newTotalExtendedBy), 'hh:mm a')
          : ''
      };

      if (existingSessionExtIndex >= 0) {
        if (remainingBreaks.length === 0 && newTotalExtendedBy === 0) {
          // Remove the extension entry if no breaks and no extension
          availabilityExtensions[dateStr].sessions.splice(existingSessionExtIndex, 1);
        } else {
          availabilityExtensions[dateStr].sessions[existingSessionExtIndex] = newSessionExtension;
        }
      } else if (newTotalExtendedBy > 0 || remainingBreaks.length > 0) {
        availabilityExtensions[dateStr].sessions.push(newSessionExtension);
      }

      // Cleanup if date entry empty
      if (availabilityExtensions[dateStr].sessions.length === 0) {
        delete availabilityExtensions[dateStr];
      }

      await updateDoc(doctorRef, {
        breakPeriods: Object.keys(breakPeriods).length > 0 ? breakPeriods : {},
        availabilityExtensions: Object.keys(availabilityExtensions).length > 0 ? availabilityExtensions : {}
      });

      toast({
        title: 'Break Cancelled',
        description: 'The break has been successfully removed.'
      });

      // Update local state
      const updatedDoctor = {
        ...selectedDoctor,
        breakPeriods,

      };
      setSelectedDoctor(updatedDoctor);
      setDoctors(prev => prev.map(d => d.id === updatedDoctor.id ? updatedDoctor : d));
      setExistingBreaks(remainingBreaks);

    } catch (error) {
      console.error("Error cancelling break:", error);
      toast({ variant: 'destructive', title: 'Error', description: 'Failed to cancel break.' });
    } finally {
      setIsSubmittingBreak(false);
    }
  };

  const handleOpenBlockedSlots = async () => {
    if (!selectedDoctor || !selectedDoctor.clinicId || selectedBlockedSlots.length === 0) return;

    setIsOpeningSlots(true);
    try {
      const batch = writeBatch(db);
      const dateStr = format(leaveCalDate, 'd MMMM yyyy');

      selectedBlockedSlots.forEach(apptId => {
        const appt = appointments.find(a => a.id === apptId);
        if (appt) {
          // Update appointment status to Cancelled
          const apptRef = doc(db, 'appointments', apptId);
          batch.update(apptRef, { status: 'Cancelled' });

          // Delete slot reservation
          if (typeof appt.slotIndex === 'number') {
            const reservationId = `${selectedDoctor.clinicId}_${selectedDoctor.name}_${dateStr}_slot_${appt.slotIndex}`;
            const reservationRef = doc(db, 'slot-reservations', reservationId);
            batch.delete(reservationRef);
          }
        }
      });

      await batch.commit();
      setSelectedBlockedSlots([]);
      toast({
        title: 'Slots Opened',
        description: `Successfully opened ${selectedBlockedSlots.length} slots.`,
      });

      // Refresh data
      const dateQueryStr = format(leaveCalDate, 'd MMMM yyyy');
      const appointmentsQuery = query(collection(db, "appointments"),
        where("doctor", "==", selectedDoctor.name),
        where("clinicId", "==", selectedDoctor.clinicId),
        where("date", "==", dateQueryStr)
      );
      const snapshot = await getDocs(appointmentsQuery);
      const fetchedAppointments = snapshot.docs.map(d => ({ id: d.id, ...d.data() } as Appointment));
      setAppointments(fetchedAppointments);

    } catch (error) {
      console.error("Error opening slots:", error);
      toast({ variant: 'destructive', title: 'Error', description: 'Failed to open slots.' });
    } finally {
      setIsOpeningSlots(false);
    }
  };

  const todaysAppointmentsCount = useMemo(() => {
    if (!selectedDoctor) return 0;
    const todayStr = format(new Date(), 'd MMMM yyyy');
    return appointments.filter(apt => apt.doctor === selectedDoctor.name && apt.date === todayStr).length;
  }, [appointments, selectedDoctor]);

  const getCurrentSessionIndex = () => {
    if (!selectedDoctor?.availabilitySlots) return undefined;
    const todayDay = format(new Date(), 'EEEE');
    const todaysAvailability = selectedDoctor.availabilitySlots.find(s => s.day === todayDay);
    if (!todaysAvailability?.timeSlots?.length) return undefined;

    const now = new Date();
    for (let i = 0; i < todaysAvailability.timeSlots.length; i++) {
      const session = todaysAvailability.timeSlots[i];
      const sessionStart = parseTimeUtil(session.from, now);
      const sessionEnd = parseTimeUtil(session.to, now);
      const windowStart = subMinutes(sessionStart, 30);
      if (now >= windowStart && now <= sessionEnd) {
        return i;
      }
    }
    return undefined;
  };

  const handleConsultationStatusToggle = useCallback(async () => {
    if (!selectedDoctor || selectedDoctor.consultationStatus === 'In') {
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

    setIsUpdatingConsultationStatus(true);
    try {
      await updateDoc(doc(db, 'doctors', selectedDoctor.id), {
        consultationStatus: 'In',
        updatedAt: new Date(),
      });
      setSelectedDoctor(prev => {
        if (!prev || prev.id !== selectedDoctor.id) return prev;
        return { ...prev, consultationStatus: 'In' };
      });
      setDoctors(prev =>
        prev.map(docItem =>
          docItem.id === selectedDoctor.id ? { ...docItem, consultationStatus: 'In' } : docItem
        )
      );

      if (selectedDoctor.clinicId) {
        const clinicDocRef = doc(db, 'clinics', selectedDoctor.clinicId);
        const clinicDoc = await getDoc(clinicDocRef).catch(() => null);
        const clinicName = clinicDoc?.data()?.name || 'The clinic';
        const { notifySessionPatientsOfConsultationStart } = await import('@kloqo/shared-core');
        const today = format(new Date(), 'd MMMM yyyy');
        await notifySessionPatientsOfConsultationStart({ db, doctor: selectedDoctor, clinicName, today, sessionIndex });
      }

      toast({ title: 'Consultation Started', description: 'Your consultation session has begun.' });
    } catch (error) {
      console.error('Error updating consultation status:', error);
      toast({ variant: 'destructive', title: 'Error', description: 'Failed to update consultation status.' });
    } finally {
      setIsUpdatingConsultationStatus(false);
    }
  }, [selectedDoctor, setDoctors, setSelectedDoctor, toast]);


  return (
    <>
      <main className="flex-1 overflow-hidden bg-background">
        <div className="h-full grid grid-cols-1 md:grid-cols-12 gap-6 p-6">
          {/* Left Column: Doctor List */}
          <div className="h-full md:col-span-3">
            <Card className="h-full flex flex-col">
              <CardHeader>
                <div className="flex justify-between items-center">
                  <CardTitle>Doctors</CardTitle>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div className={cn(isDoctorLimitReached && "cursor-not-allowed")}>
                          <Button onClick={openAddDoctorDialog} disabled={isDoctorLimitReached}>
                            <PlusCircle className="mr-2 h-4 w-4" />
                            Add Doctor
                          </Button>
                        </div>
                      </TooltipTrigger>
                      {isDoctorLimitReached && (
                        <TooltipContent>
                          <p>Doctor limit reached. Go to Profile &gt; Clinic Details to increase the limit.</p>
                        </TooltipContent>
                      )}
                    </Tooltip>
                  </TooltipProvider>
                </div>
                <div className="relative mt-2">
                  <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    type="search"
                    placeholder="Search name or specialty"
                    className="w-full rounded-lg bg-background pl-8"
                    value={searchTerm}
                    onChange={(e) => { setSearchTerm(e.target.value); setCurrentPage(1); }}
                  />
                </div>
                <Select value={departmentFilter} onValueChange={(value) => { setDepartmentFilter(value); setCurrentPage(1); }}>
                  <SelectTrigger className="w-full mt-2">
                    <SelectValue placeholder="Department" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="All">All Departments</SelectItem>
                    {clinicDepartments.map(dept => (
                      <SelectItem key={dept.id} value={dept.name}>{dept.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </CardHeader>
              <CardContent className="flex-grow overflow-y-auto space-y-2 px-4 pt-0">
                {currentDoctors.map(doctor => (
                  <DoctorListItem
                    key={doctor.id}
                    doctor={doctor}
                    onSelect={() => setSelectedDoctor(doctor)}
                    isSelected={selectedDoctor?.id === doctor.id}
                  />
                ))}
              </CardContent>
              <CardFooter className="pt-4 flex items-center justify-between">
                <div className="text-sm text-muted-foreground">
                  Page {currentPage} of {totalPages}
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="icon" onClick={() => setCurrentPage(prev => Math.max(prev - 1, 1))} disabled={currentPage === 1}>
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <Button variant="outline" size="icon" onClick={() => setCurrentPage(prev => Math.min(prev + 1, totalPages))} disabled={currentPage === totalPages}>
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </CardFooter>
            </Card>
          </div>

          {/* Right Column: Doctor Details */}
          <div className="h-full overflow-y-auto pr-2 md:col-span-9">
            {selectedDoctor ? (
              <>
                <div className="bg-primary text-primary-foreground rounded-lg p-4 grid grid-cols-[auto,1fr,1fr,auto] items-start gap-6 mb-6">
                  {/* Column 1: Image and Basic Info */}
                  <div className="flex items-center gap-4">
                    <div className="relative group">
                      <Image
                        src={photoPreview || selectedDoctor.avatar}
                        alt={selectedDoctor.name}
                        width={112}
                        height={112}
                        className="rounded-md object-cover"
                        data-ai-hint="doctor portrait"
                      />
                      {isEditingDetails && (
                        <label htmlFor="photo-upload" className="absolute inset-0 bg-black/50 flex items-center justify-center text-white rounded-md cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity">
                          <Upload className="h-6 w-6" />
                        </label>
                      )}
                      <input type="file" id="photo-upload" accept="image/*" className="hidden" onChange={handlePhotoChange} />
                    </div>
                    <div className="space-y-1">
                      {isEditingDetails ? (
                        <>
                          <Input
                            value={newName}
                            onChange={(e) => setNewName(e.target.value)}
                            className="text-2xl font-bold h-10 bg-transparent border-white/50 placeholder:text-primary-foreground/70"
                            disabled={isPending}
                            placeholder="Doctor Name"
                          />
                          <Input
                            value={newRegistrationNumber}
                            onChange={(e) => setNewRegistrationNumber(e.target.value)}
                            className="text-sm h-8 bg-transparent border-white/50 placeholder:text-primary-foreground/70"
                            placeholder="Registration No."
                            disabled={isPending}
                          />
                          <Input
                            value={newSpecialty}
                            onChange={(e) => setNewSpecialty(e.target.value)}
                            className="text-md h-9 bg-transparent border-white/50 placeholder:text-primary-foreground/70"
                            disabled={isPending}
                            placeholder="Specialty"
                          />
                          <Select onValueChange={setNewDepartment} value={newDepartment}>
                            <SelectTrigger className="w-[200px] h-9 bg-transparent border-white/50">
                              <SelectValue placeholder="Select department" />
                            </SelectTrigger>
                            <SelectContent>
                              {clinicDepartments.map(dept => (
                                <SelectItem key={dept.id} value={dept.name}>{dept.name}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </>
                      ) : (
                        <>
                          <p className="font-bold text-2xl">{selectedDoctor.name}</p>
                          {selectedDoctor.registrationNumber && <p className="text-xs opacity-80">{selectedDoctor.registrationNumber}</p>}
                          <p className="text-md opacity-90">{selectedDoctor.specialty}</p>
                          <p className="text-sm opacity-90">{(selectedDoctor.degrees || []).join(', ')}{selectedDoctor.degrees && selectedDoctor.department ? ' - ' : ''}{selectedDoctor.department}</p>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Column 2: Experience */}
                  <div className="flex flex-col items-center pt-6">
                    <div className="mb-2">
                      <Trophy className="w-4 h-4 text-yellow-400" />
                    </div>
                    {isEditingDetails ? (
                      <div className="flex items-center gap-2">
                        <span className="opacity-90">Years:</span>
                        <div className="flex items-center">
                          <Button size="icon" variant="ghost" className="h-8 w-8 text-white hover:bg-white/20" onClick={() => setNewExperience(prev => Math.max(0, Number(prev) - 1))} disabled={isPending}>
                            <Minus className="h-4 w-4" />
                          </Button>
                          <Input
                            type="number"
                            value={newExperience}
                            onChange={(e) => setNewExperience(e.target.value)}
                            className="w-16 h-9 bg-transparent border-white/50 placeholder:text-primary-foreground/70 text-center"
                            placeholder="Years"
                            disabled={isPending}
                          />
                          <Button size="icon" variant="ghost" className="h-8 w-8 text-white hover:bg-white/20" onClick={() => setNewExperience(prev => Number(prev) + 1)} disabled={isPending}>
                            <PlusCircle className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="text-center">
                        <p className="text-2xl font-bold">{selectedDoctor.experience}</p>
                        <p className="text-sm opacity-90">Years of experience</p>
                      </div>
                    )}
                  </div>

                  {/* Column 3: Reviews */}
                  <div className="flex flex-col items-center pt-6">
                    <div className="mb-2">
                      <Star className="w-4 h-4 text-yellow-400" />
                    </div>
                    <div className="flex items-center gap-2">
                      <StarRating rating={selectedDoctor.rating || 0} />
                    </div>
                    <span className="text-md opacity-90 mt-2">({selectedDoctor.reviews}+ Reviews)</span>
                  </div>

                  {/* Column 4: Actions */}
                  <div className="flex flex-col items-end justify-between self-stretch">
                    {!isEditingDetails && (
                      <Button variant="ghost" size="icon" className="text-white hover:bg-white/20" onClick={() => setIsEditingDetails(true)}>
                        <Edit className="h-5 w-5" />
                      </Button>
                    )}
                    {isEditingDetails && (
                      <div className="flex items-center gap-2">
                        <Button size="sm" variant="ghost" className="text-white hover:bg-white/20" onClick={() => { setIsEditingDetails(false); setPhotoPreview(selectedDoctor.avatar); setNewPhoto(null); }} disabled={isPending}>Cancel</Button>
                        <Button size="sm" className="bg-white text-primary hover:bg-white/90" onClick={handleDetailsSave} disabled={isPending}>
                          {isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                          Save
                        </Button>
                      </div>
                    )}
                    <div className="flex-grow"></div>
                    <div className="flex flex-col items-end gap-2">
                      <Button
                        variant="secondary"
                        disabled={isUpdatingConsultationStatus || selectedDoctor.consultationStatus === 'In'}
                        onClick={handleConsultationStatusToggle}
                        className={cn(
                          'flex items-center gap-3 rounded-full px-4 py-2 text-white border-none shadow-md transition-colors',
                          selectedDoctor.consultationStatus === 'In'
                            ? 'bg-green-500'
                            : 'bg-red-500 hover:bg-red-600',
                          isUpdatingConsultationStatus && 'opacity-70 cursor-not-allowed'
                        )}
                      >
                        <div className="relative flex h-3 w-3">
                          {selectedDoctor.consultationStatus === 'In' && (
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-75"></span>
                          )}
                          <span className="relative inline-flex rounded-full h-3 w-3 bg-white" />
                        </div>
                        <span className="font-semibold">
                          {isUpdatingConsultationStatus
                            ? 'Updating...'
                            : selectedDoctor.consultationStatus === 'In'
                              ? 'Doctor Online'
                              : 'Mark as In'}
                        </span>
                      </Button>
                      <span className="text-xs uppercase tracking-wide text-white/80">
                        Current: {selectedDoctor.consultationStatus || 'Out'}
                      </span>
                    </div>
                  </div>
                </div>

                {activeTab !== 'analytics' && (
                  <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-3 gap-6">
                    <div className="grid grid-cols-2 gap-6">
                      <Card>
                        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                          <CardTitle className="text-sm font-medium">Avg. Consulting Time</CardTitle>
                          <Clock className="h-4 w-4 text-muted-foreground" />
                        </CardHeader>
                        <CardContent>
                          {isEditingTime ? (
                            <div className="flex items-center gap-2 mt-1">
                              <Input
                                type="number"
                                value={newAvgTime}
                                onChange={(e) => setNewAvgTime(e.target.value)}
                                className="w-20 h-8"
                                placeholder="min"
                                disabled={isPending}
                              />
                              <Button size="icon" className="h-8 w-8" onClick={handleTimeSave} disabled={isPending}><Save className="h-4 w-4" /></Button>
                              <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => { setIsEditingTime(false); setNewAvgTime(selectedDoctor.averageConsultingTime || "") }} disabled={isPending}><X className="h-4 w-4" /></Button>
                            </div>
                          ) : (
                            <div className="flex items-center gap-2">
                              <p className="text-2xl font-bold">{selectedDoctor.averageConsultingTime || 0} min</p>
                              <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => setIsEditingTime(true)}><Edit className="h-3 w-3" /></Button>
                            </div>
                          )}
                        </CardContent>
                      </Card>
                      <Card>
                        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                          <CardTitle className="text-sm font-medium">Consultation Fee</CardTitle>
                          <span className="text-muted-foreground font-bold">₹</span>
                        </CardHeader>
                        <CardContent>
                          {isEditingFee ? (
                            <div className="flex items-center gap-2 mt-1">
                              <Input
                                type="number"
                                value={newFee}
                                onChange={(e) => setNewFee(e.target.value)}
                                className="w-20 h-8"
                                placeholder="₹"
                                disabled={isPending}
                                min="0"
                              />
                              <Button size="icon" className="h-8 w-8" onClick={handleFeeSave} disabled={isPending}><Save className="h-4 w-4" /></Button>
                              <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => { setIsEditingFee(false); setNewFee(selectedDoctor.consultationFee || "") }} disabled={isPending}><X className="h-4 w-4" /></Button>
                            </div>
                          ) : (
                            <div className="flex items-center gap-2">
                              <p className="text-2xl font-bold">₹{selectedDoctor.consultationFee || 0}</p>
                              <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => setIsEditingFee(true)}><Edit className="h-3 w-3" /></Button>
                            </div>
                          )}
                        </CardContent>
                      </Card>
                    </div>
                    <div className="grid grid-cols-2 gap-6">
                      <Card>
                        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                          <CardTitle className="text-sm font-medium">Free Follow-up</CardTitle>
                          <Repeat className="h-4 w-4 text-muted-foreground" />
                        </CardHeader>
                        <CardContent>
                          {isEditingFollowUp ? (
                            <div className="flex items-center gap-2 mt-1">
                              <Input type="number" min="0" value={newFollowUp} onChange={(e) => setNewFollowUp(e.target.value)} className="w-20 h-8" placeholder="days" disabled={isPending} />
                              <Button size="icon" className="h-8 w-8" onClick={handleFollowUpSave} disabled={isPending}><Save className="h-4 w-4" /></Button>
                              <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => { setIsEditingFollowUp(false); setNewFollowUp(selectedDoctor.freeFollowUpDays || 0) }} disabled={isPending}><X className="h-4 w-4" /></Button>
                            </div>
                          ) : (
                            <div className="flex items-center gap-2">
                              <p className="text-2xl font-bold">{selectedDoctor.freeFollowUpDays || 0} {(selectedDoctor.freeFollowUpDays || 0) === 1 ? 'day' : 'days'}</p>
                              <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => setIsEditingFollowUp(true)}><Edit className="h-3 w-3" /></Button>
                            </div>
                          )}
                        </CardContent>
                      </Card>
                      <Card>
                        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                          <CardTitle className="text-sm font-medium">Advance Booking</CardTitle>
                          <CalendarCheck className="h-4 w-4 text-muted-foreground" />
                        </CardHeader>
                        <CardContent>
                          {isEditingBooking ? (
                            <div className="flex items-center gap-2 mt-1">
                              <Input type="number" min="0" value={newBooking} onChange={(e) => setNewBooking(e.target.value)} className="w-20 h-8" placeholder="days" disabled={isPending} />
                              <Button size="icon" className="h-8 w-8" onClick={handleBookingSave} disabled={isPending}><Save className="h-4 w-4" /></Button>
                              <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => { setIsEditingBooking(false); setNewBooking(selectedDoctor.advanceBookingDays || 0) }} disabled={isPending}><X className="h-4 w-4" /></Button>
                            </div>
                          ) : (
                            <div className="flex items-center gap-2">
                              <div className="text-2xl font-bold">{selectedDoctor.advanceBookingDays || 0} {(selectedDoctor.advanceBookingDays || 0) === 1 ? 'day' : 'days'}</div>
                              <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => setIsEditingBooking(true)}><Edit className="h-3 w-3" /></Button>
                            </div>
                          )}
                        </CardContent>
                      </Card>
                    </div>
                    <div className="grid grid-cols-2 gap-6">
                      <Card>
                        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                          <CardTitle className="text-sm font-medium">Total Patients</CardTitle>
                          <Users className="h-4 w-4 text-muted-foreground" />
                        </CardHeader>
                        <CardContent>
                          <div className="text-2xl font-bold">{selectedDoctor.totalPatients || 0}</div>
                        </CardContent>
                      </Card>
                      <Card>
                        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                          <CardTitle className="text-sm font-medium">Today's Appointments</CardTitle>
                          <CalendarDays className="h-4 w-4 text-muted-foreground" />
                        </CardHeader>
                        <CardContent className="flex items-center justify-center">
                          <div className="text-2xl font-bold">{todaysAppointmentsCount}</div>
                        </CardContent>
                      </Card>
                    </div>
                  </div>
                )}

                <hr className="my-6" />

                <Tabs defaultValue="details" onValueChange={setActiveTab}>
                  <TabsList>
                    <TabsTrigger value="details">Doctor Details</TabsTrigger>
                    <TabsTrigger value="analytics">Analytics</TabsTrigger>
                    <TabsTrigger value="reviews">Reviews</TabsTrigger>
                  </TabsList>
                  <TabsContent value="details" className="mt-4">
                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                      <div className="lg:col-span-2 space-y-6">
                        <Card>
                          <CardHeader className="flex flex-row items-center justify-between">
                            <div className="space-y-1.5">
                              <CardTitle className="flex items-center gap-2"><Info className="w-5 h-5" /> Bio</CardTitle>
                            </div>
                            {!isEditingBio && (
                              <Button variant="outline" size="sm" onClick={() => setIsEditingBio(true)}>
                                <Edit className="mr-2 h-4 w-4" /> Edit
                              </Button>
                            )}
                          </CardHeader>
                          <CardContent>
                            {isEditingBio ? (
                              <div className="space-y-2">
                                <Textarea
                                  value={newBio}
                                  onChange={(e) => setNewBio(e.target.value)}
                                  className="min-h-[120px]"
                                  placeholder="Enter a short bio for the doctor..."
                                  disabled={isPending}
                                />
                              </div>
                            ) : (
                              <p className="text-muted-foreground">{selectedDoctor.bio || "No biography available."}</p>
                            )}
                          </CardContent>
                          {isEditingBio && (
                            <CardFooter className="flex justify-end gap-2">
                              <Button variant="ghost" onClick={() => { setIsEditingBio(false); setNewBio(selectedDoctor.bio || ""); }} disabled={isPending}>Cancel</Button>
                              <Button onClick={handleBioSave} disabled={isPending}>
                                {isPending ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Saving...</> : <><Save className="mr-2 h-4 w-4" /> Save Bio</>}
                              </Button>
                            </CardFooter>
                          )}
                        </Card>
                        <Card>
                          <Tabs value={activeBreakTab} onValueChange={(v) => setActiveBreakTab(v as any)}>
                            <CardHeader className="pb-4">
                              <div className="flex items-center justify-between mb-2">
                                <CardTitle className="flex items-center gap-2">
                                  <CalendarIcon className="w-5 h-5" />
                                  Break Management
                                </CardTitle>
                              </div>
                              <TabsList className="grid w-full grid-cols-2">
                                <TabsTrigger value="schedule">Schedule Break</TabsTrigger>
                                <TabsTrigger value="blocked">Open Blocked Slots</TabsTrigger>
                              </TabsList>
                            </CardHeader>

                            <TabsContent value="schedule" className="mt-0">
                              <CardHeader className="pt-0">
                                <CardDescription>Select a date and time range to schedule a break. This will reschedule existing appointments.</CardDescription>
                              </CardHeader>
                              <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <Calendar
                                  mode="single"
                                  selected={leaveCalDate}
                                  onSelect={(d) => {
                                    if (d) {
                                      setLeaveCalDate(d);
                                      setBreakStartSlot(null);
                                      setBreakEndSlot(null);
                                    }
                                  }}
                                  disabled={(date) => (isPast(date) && !isSameDay(date, new Date())) || !selectedDoctor.availabilitySlots?.some(s => s.day === format(date, 'EEEE'))}
                                  initialFocus
                                />
                                <div className="p-4 border rounded-md h-[500px] flex flex-col">
                                  <h3 className="font-semibold mb-2">
                                    Slots for {format(leaveCalDate, "MMM d")}
                                  </h3>

                                  {/* Display existing breaks for current session */}
                                  {currentSession && existingBreaks.length > 0 && (
                                    <div className="mb-4 p-4 border rounded-md bg-muted/50">
                                      <h4 className="font-semibold mb-2 flex items-center gap-2">
                                        <Clock className="w-4 h-4" />
                                        Current Breaks in Session {currentSession.sessionIndex + 1}
                                        ({format(currentSession.sessionStart, 'hh:mm a')} - {format(currentSession.originalEnd, 'hh:mm a')})
                                      </h4>

                                      <div className="space-y-2">
                                        {existingBreaks
                                          .filter(bp => {
                                            if (!isToday(leaveCalDate)) return true;
                                            const breakEndTimes = bp.slots.map(s => parseISO(s).getTime());
                                            const lastSlotEnd = addMinutes(new Date(Math.max(...breakEndTimes)), selectedDoctor?.averageConsultingTime || 15);
                                            return isAfter(lastSlotEnd, new Date());
                                          })
                                          .map((breakPeriod, index) => (
                                            <div
                                              key={breakPeriod.id}
                                              className="flex items-center justify-between p-2 bg-background border rounded"
                                            >
                                              <div className="flex items-center gap-2">
                                                <span className="font-medium">Break {index + 1}:</span>
                                                <span className="text-sm">
                                                  {breakPeriod.startTimeFormatted} - {breakPeriod.endTimeFormatted}
                                                </span>
                                                <span className="text-xs text-muted-foreground">
                                                  ({breakPeriod.duration} min)
                                                </span>
                                              </div>
                                              <Button
                                                variant="ghost"
                                                size="sm"
                                                onClick={() => handleCancelBreak(breakPeriod.id)}
                                                disabled={isSubmittingBreak}
                                              >
                                                <X className="w-4 h-4 mr-1" />
                                                Cancel
                                              </Button>
                                            </div>
                                          ))}
                                      </div>

                                      {/* Extension summary */}
                                      <div className="mt-3 pt-3 border-t text-sm">
                                        <div className="flex justify-between">
                                          <span className="text-muted-foreground">Total break time:</span>
                                          <span className="font-medium">{currentSession.totalBreakMinutes} minutes</span>
                                        </div>
                                        <div className="flex justify-between">
                                          <span className="text-muted-foreground">
                                            {currentSession.effectiveEnd?.getTime() === currentSession.originalEnd?.getTime()
                                              ? 'Session ends at:'
                                              : 'Session extended to:'}
                                          </span>
                                          <span className="font-medium">{format(currentSession.effectiveEnd, 'hh:mm a')}</span>
                                        </div>
                                      </div>

                                      {existingBreaks.length >= 3 && (
                                        <div className="mt-2 p-2 bg-yellow-50 border border-yellow-200 rounded text-sm text-yellow-800">
                                          Maximum 3 breaks per session reached. Cancel a break to add a new one.
                                        </div>
                                      )}
                                    </div>
                                  )}

                                  {/* Slot grid */}
                                  <div className="space-y-4 flex-grow overflow-y-auto pr-1">
                                    {currentSession && availableSlots ? (
                                      <>
                                        {/* Current Session Slots */}
                                        <div>
                                          <h4 className="text-sm font-medium mb-2">
                                            Session {currentSession.sessionIndex + 1}: {format(currentSession.sessionStart, 'hh:mm a')} - {format(currentSession.originalEnd, 'hh:mm a')}
                                          </h4>
                                          <div className="grid grid-cols-2 gap-2">
                                            {availableSlots.currentSessionSlots.map((slot) => {
                                              const slotDate = parseISO(slot.isoString);
                                              const isSelected = breakStartSlot && breakEndSlot
                                                ? slotDate >= parseISO(breakStartSlot.isoString) && slotDate <= parseISO(breakEndSlot.isoString)
                                                : breakStartSlot && slotDate.getTime() === parseISO(breakStartSlot.isoString).getTime();

                                              return (
                                                <Button
                                                  key={slot.isoString}
                                                  variant={isSelected ? 'default' : 'outline'}
                                                  className={cn("h-auto py-3 flex-col gap-0.5", {
                                                    'bg-destructive/80 hover:bg-destructive text-white': isSelected,
                                                    'bg-gray-200 text-gray-600 border-gray-300 cursor-not-allowed opacity-60': slot.isTaken,
                                                    'hover:bg-accent': !isSelected && !slot.isTaken,
                                                  })}
                                                  onClick={() => handleSlotClick(slot)}
                                                  disabled={slot.isTaken}
                                                >
                                                  <span className="font-semibold text-xs">{slot.timeFormatted}</span>
                                                  <span className="text-[10px] opacity-70">to</span>
                                                  <span className="font-semibold text-xs">{format(addMinutes(parseISO(slot.isoString), selectedDoctor?.averageConsultingTime || 15), 'hh:mm a')}</span>
                                                  {slot.isTaken && <span className="text-xs mt-1">Taken</span>}
                                                </Button>
                                              );
                                            })}
                                          </div>
                                        </div>

                                        {/* Upcoming Sessions */}
                                        {Array.from(availableSlots.upcomingSessionSlots.entries()).map(([sessionIndex, slots]) => (
                                          <div key={sessionIndex}>
                                            <h4 className="text-sm font-medium mb-2 text-muted-foreground">
                                              Session {sessionIndex + 1} (Upcoming)
                                            </h4>
                                            <div className="grid grid-cols-2 gap-2">
                                              {slots.map((slot) => {
                                                const slotDate = parseISO(slot.isoString);
                                                const isSelected = breakStartSlot && breakEndSlot
                                                  ? slotDate >= parseISO(breakStartSlot.isoString) && slotDate <= parseISO(breakEndSlot.isoString)
                                                  : breakStartSlot && slotDate.getTime() === parseISO(breakStartSlot.isoString).getTime();

                                                return (
                                                  <Button
                                                    key={slot.isoString}
                                                    variant={isSelected ? 'default' : 'outline'}
                                                    className={cn("h-auto py-3 flex-col gap-0.5", {
                                                      'bg-destructive/80 hover:bg-destructive text-white': isSelected,
                                                      'bg-gray-200 text-gray-600 border-gray-300 cursor-not-allowed opacity-60': slot.isTaken,
                                                      'hover:bg-accent': !isSelected && !slot.isTaken,
                                                    })}
                                                    onClick={() => handleSlotClick(slot)}
                                                    disabled={slot.isTaken}
                                                  >
                                                    <span className="font-semibold text-xs">{slot.timeFormatted}</span>
                                                    <span className="text-[10px] opacity-70">to</span>
                                                    <span className="font-semibold text-xs">{format(addMinutes(parseISO(slot.isoString), selectedDoctor?.averageConsultingTime || 15), 'hh:mm a')}</span>
                                                    {slot.isTaken && <span className="text-xs mt-1">Taken</span>}
                                                  </Button>
                                                );
                                              })}
                                            </div>
                                          </div>
                                        ))}
                                      </>
                                    ) : (
                                      <p className="text-sm text-muted-foreground text-center pt-4">
                                        {leaveCalDate ? 'No active session for this date.' : 'Select a date to view slots.'}
                                      </p>
                                    )}
                                  </div>

                                  {/* Status text */}
                                  <div className="text-center mt-4 mb-2 text-sm text-muted-foreground">
                                    {breakStartSlot && breakEndSlot ? (
                                      <div>
                                        {(() => {
                                          try {
                                            const start = parseISO(breakStartSlot.isoString);
                                            const end = parseISO(breakEndSlot.isoString);
                                            const slotDuration = selectedDoctor?.averageConsultingTime || 15;
                                            const endTime = addMinutes(end, slotDuration);
                                            const duration = differenceInMinutes(endTime, start);

                                            return (
                                              <>
                                                <p className="font-medium text-foreground">
                                                  New break: {format(start, 'hh:mm a')} to {format(endTime, 'hh:mm a')}
                                                </p>
                                                <p className="text-xs text-muted-foreground">
                                                  {duration} min
                                                </p>
                                              </>
                                            );
                                          } catch {
                                            return null;
                                          }
                                        })()}
                                      </div>
                                    ) : breakStartSlot ? (
                                      `Start: ${format(parseISO(breakStartSlot.isoString), 'hh:mm a')} - Select end time`
                                    ) : existingBreaks.length > 0 ? (
                                      'Select start and end slots to add another break'
                                    ) : (
                                      'Select start and end slots for the break'
                                    )}
                                  </div>

                                  {/* Confirm button */}
                                  <Button
                                    className="w-full"
                                    variant="destructive"
                                    disabled={!breakStartSlot || !breakEndSlot || isSubmittingBreak || existingBreaks.length >= 3}
                                    onClick={handleConfirmBreak}
                                  >
                                    {isSubmittingBreak ? (
                                      <>
                                        <Loader2 className="animate-spin mr-2" />
                                        Adding...
                                      </>
                                    ) : (
                                      'Add Break'
                                    )}
                                  </Button>
                                </div>
                              </CardContent>
                            </TabsContent>

                            <TabsContent value="blocked" className="mt-0">
                              <CardHeader className="pt-0">
                                <CardDescription>Select a range of blocked slots (Completed status) to make them available for booking again.</CardDescription>
                              </CardHeader>
                              <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <Calendar
                                  mode="single"
                                  selected={leaveCalDate}
                                  onSelect={(d) => {
                                    if (d) {
                                      setLeaveCalDate(d);
                                      setSelectedBlockedSlots([]);
                                    }
                                  }}
                                  disabled={(date) => (isPast(date) && !isSameDay(date, new Date())) || !selectedDoctor.availabilitySlots?.some(s => s.day === format(date, 'EEEE'))}
                                  initialFocus
                                />
                                <div className="p-4 border rounded-md h-[500px] flex flex-col">
                                  <div className="flex items-center justify-between mb-2">
                                    <h3 className="font-semibold text-sm">Blocked Slots for {format(leaveCalDate, "MMM d")}</h3>
                                    <Button
                                      variant="destructive"
                                      size="sm"
                                      onClick={handleOpenBlockedSlots}
                                      disabled={selectedBlockedSlots.length === 0 || isOpeningSlots}
                                    >
                                      {isOpeningSlots ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                                      Open {selectedBlockedSlots.length} Slots
                                    </Button>
                                  </div>
                                  <p className="text-xs text-muted-foreground mb-4">
                                    Select a start and end slot to define a range.
                                  </p>

                                  <div className="space-y-4 flex-grow overflow-y-auto pr-1">
                                    <div className="grid grid-cols-2 gap-2">
                                      {(() => {
                                        const filteredAppointments = appointments
                                          .filter(a => a.status === 'Completed' && a.doctor === selectedDoctor?.name)
                                          .filter(a => {
                                            const apptTime = parseTimeUtil(a.time, leaveCalDate);
                                            // Filter out past slots if today
                                            if (isToday(leaveCalDate) && apptTime < new Date()) {
                                              return false;
                                            }
                                            const coveredByBreak = existingBreaks.some(breakPeriod => {
                                              const start = parseISO(breakPeriod.startTime);
                                              const end = parseISO(breakPeriod.endTime);
                                              return apptTime >= start && apptTime < end;
                                            });
                                            return !coveredByBreak;
                                          })
                                          .sort((a, b) => {
                                            const timeA = parseTimeUtil(a.time, leaveCalDate).getTime();
                                            const timeB = parseTimeUtil(b.time, leaveCalDate).getTime();
                                            return timeA - timeB;
                                          });

                                        if (filteredAppointments.length === 0) {
                                          return (
                                            <div className="col-span-full text-center py-8 text-muted-foreground text-sm">
                                              No blocked slots found for this date.
                                            </div>
                                          );
                                        }

                                        return filteredAppointments.map(appt => {
                                          const isSelected = selectedBlockedSlots.includes(appt.id);

                                          return (
                                            <Button
                                              key={appt.id}
                                              variant={isSelected ? 'default' : 'outline'}
                                              className={cn(
                                                "h-auto py-3 flex-col gap-0.5",
                                                {
                                                  'bg-destructive/80 hover:bg-destructive text-white': isSelected,
                                                  'hover:bg-accent': !isSelected,
                                                }
                                              )}
                                              onClick={() => {
                                                const sortedBlocked = filteredAppointments;
                                                let newSelection: string[] = [];

                                                if (selectedBlockedSlots.length === 0 || (selectedBlockedSlots.length > 1 && !selectedBlockedSlots.includes(appt.id))) {
                                                  newSelection = [appt.id];
                                                } else if (selectedBlockedSlots.length === 1) {
                                                  const startId = selectedBlockedSlots[0];
                                                  if (startId === appt.id) {
                                                    newSelection = [];
                                                  } else {
                                                    const startIndex = sortedBlocked.findIndex(a => a.id === startId);
                                                    const endIndex = sortedBlocked.findIndex(a => a.id === appt.id);
                                                    const rangeStart = Math.min(startIndex, endIndex);
                                                    const rangeEnd = Math.max(startIndex, endIndex);
                                                    newSelection = sortedBlocked.slice(rangeStart, rangeEnd + 1).map(a => a.id);
                                                  }
                                                } else {
                                                  newSelection = [appt.id];
                                                }
                                                setSelectedBlockedSlots(newSelection);
                                              }}
                                            >
                                              <span className="font-semibold text-xs">{appt.time}</span>
                                              <span className="text-[10px] opacity-70">to</span>
                                              <span className="font-semibold text-xs">
                                                {format(addMinutes(parseTimeUtil(appt.time, leaveCalDate), selectedDoctor?.averageConsultingTime || 15), 'hh:mm a')}
                                              </span>
                                              {appt.cancelledByBreak && (
                                                <span className="text-[10px] bg-yellow-100 text-yellow-800 px-1 rounded mt-1">Break Block</span>
                                              )}
                                              {!appt.cancelledByBreak && (
                                                <span className="text-[10px] opacity-70 mt-1">Blocked</span>
                                              )}
                                            </Button>
                                          );
                                        });
                                      })()}
                                    </div>
                                  </div>
                                </div>
                              </CardContent>
                            </TabsContent>
                          </Tabs>
                        </Card>
                      </div>
                      <div className="space-y-6">
                        <Card>
                          <CardHeader className="flex flex-row items-center justify-between">
                            <div className="space-y-1.5">
                              <CardTitle className="flex items-center gap-2"><CalendarIcon className="w-5 h-5" /> Schedule</CardTitle>
                              <CardDescription>Recurring weekly schedule.</CardDescription>
                            </div>
                            {!isEditingAvailability && (
                              <Button variant="outline" size="sm" onClick={handleEditAvailability}>
                                <Edit className="mr-2 h-4 w-4" /> Edit
                              </Button>
                            )}
                          </CardHeader>
                          <CardContent>
                            {isEditingAvailability ? (
                              <Form {...form}>
                                <form onSubmit={form.handleSubmit(handleAvailabilitySave)} className="space-y-4">
                                  <div className="space-y-2">
                                    <Label>1. Select days to apply time slots to</Label>
                                    <ToggleGroup type="multiple" value={selectedDays} onValueChange={setSelectedDays} variant="outline" className="flex-wrap justify-start">
                                      {daysOfWeek.map((day, index) => {
                                        const clinicDay = clinicDetails?.operatingHours?.find((h: any) => h.day === day);
                                        const isDisabled = !clinicDay || clinicDay.isClosed;
                                        return (
                                          <ToggleGroupItem key={daysOfWeek[index]} value={daysOfWeek[index]} aria-label={`Toggle ${daysOfWeek[index]}`} className="h-9 w-9" disabled={isDisabled}>
                                            {dayAbbreviations[index]}
                                          </ToggleGroupItem>
                                        )
                                      })}
                                    </ToggleGroup>
                                  </div>

                                  <div className="space-y-2">
                                    <Label>2. Define time slots</Label>
                                    {sharedTimeSlots.map((ts, index) => {
                                      const dayForSlot = selectedDays[0] || daysOfWeek.find(day => !clinicDetails?.operatingHours?.find((h: any) => h.day === day)?.isClosed);
                                      const clinicDay = clinicDetails?.operatingHours?.find((h: any) => h.day === dayForSlot);
                                      if (!clinicDay) return null;

                                      const clinicOpeningTime = clinicDay.timeSlots[0]?.open || "00:00";
                                      const clinicClosingTime = clinicDay.timeSlots[clinicDay.timeSlots.length - 1]?.close || "23:45";
                                      const allTimeOptions = generateTimeOptions(clinicOpeningTime, clinicClosingTime, 15);

                                      const fromTimeOptions = allTimeOptions.filter(time =>
                                        !sharedTimeSlots.filter((_, i) => i !== index).some(slot => time >= slot.from && time < slot.to)
                                      ).slice(0, -1);

                                      const nextSlotStart = [...sharedTimeSlots]
                                        .filter(slot => slot.from > ts.from)
                                        .sort((a, b) => a.from.localeCompare(b.from))[0]?.from || clinicClosingTime;

                                      const toTimeOptions = ts.from
                                        ? allTimeOptions.filter(t => t > ts.from && t <= nextSlotStart)
                                        : [];

                                      return (
                                        <div key={index} className="flex items-end gap-2">
                                          <div className="flex-grow space-y-1">
                                            <Label className="text-xs font-normal">From</Label>
                                            <Select
                                              value={ts.from}
                                              onValueChange={(value) => {
                                                const newShared = [...sharedTimeSlots];
                                                newShared[index].from = value;
                                                if (newShared[index].to <= value) {
                                                  newShared[index].to = '';
                                                }
                                                setSharedTimeSlots(newShared);
                                              }}
                                            >
                                              <SelectTrigger><SelectValue placeholder="Start" /></SelectTrigger>
                                              <SelectContent>
                                                {fromTimeOptions.map(time => (
                                                  <SelectItem key={`from-${time}`} value={time}>{format(parse(time, "HH:mm", new Date()), 'p')}</SelectItem>
                                                ))}
                                              </SelectContent>
                                            </Select>
                                          </div>
                                          <div className="flex-grow space-y-1">
                                            <Label className="text-xs font-normal">To</Label>
                                            <Select
                                              value={ts.to}
                                              onValueChange={(value) => {
                                                const newShared = [...sharedTimeSlots];
                                                newShared[index].to = value;
                                                setSharedTimeSlots(newShared);
                                              }}
                                              disabled={!ts.from}
                                            >
                                              <SelectTrigger><SelectValue placeholder="End" /></SelectTrigger>
                                              <SelectContent>
                                                {toTimeOptions.map(time => (
                                                  <SelectItem key={`to-${time}`} value={time}>{format(parse(time, "HH:mm", new Date()), 'p')}</SelectItem>
                                                ))}
                                              </SelectContent>
                                            </Select>
                                          </div>
                                          <Button type="button" variant="ghost" size="icon" onClick={() => setSharedTimeSlots(prev => prev.filter((_, i) => i !== index))} disabled={sharedTimeSlots.length <= 1}>
                                            <Trash className="h-4 w-4 text-red-500" />
                                          </Button>
                                        </div>
                                      )
                                    })}
                                    <Button type="button" size="sm" variant="outline" onClick={() => setSharedTimeSlots(prev => [...prev, { from: "", to: "" }])}>
                                      Add Another Slot
                                    </Button>
                                  </div>

                                  <Button type="button" className="w-full" onClick={applySharedSlotsToSelectedDays}>
                                    3. Apply to Selected Days
                                  </Button>

                                  <div className="space-y-2 pt-4">
                                    <Label>Review and save</Label>
                                    <div className="space-y-3 rounded-md border p-3 max-h-48 overflow-y-auto">
                                      {form.watch('availabilitySlots') && form.watch('availabilitySlots').length > 0 ? (
                                        [...form.watch('availabilitySlots')]
                                          .sort((a, b) => daysOfWeek.indexOf(a.day) - daysOfWeek.indexOf(b.day))
                                          .map((fieldItem, index) => (
                                            <div key={index} className="text-sm">
                                              <p className="font-semibold">{fieldItem.day}</p>
                                              <div className="flex flex-wrap gap-1 mt-1">
                                                {fieldItem.timeSlots.map((ts, i) => {
                                                  if (!ts.from || !ts.to) return null;
                                                  return (
                                                    <Badge key={i} variant="secondary" className="font-normal">
                                                      {format(parse(ts.from, "HH:mm", new Date()), 'p')} - {format(parse(ts.to, "HH:mm", new Date()), 'p')}
                                                    </Badge>
                                                  );
                                                })}
                                              </div>
                                            </div>
                                          ))
                                      ) : <p className="text-xs text-muted-foreground text-center pt-6">No availability applied yet.</p>
                                      }
                                    </div>
                                  </div>


                                  <div className="flex justify-end gap-2 mt-4">
                                    <Button type="button" variant="ghost" onClick={() => setIsEditingAvailability(false)} disabled={isPending}>Cancel</Button>
                                    <Button type="submit" disabled={isPending || !form.formState.isValid}>
                                      {isPending ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Saving...</> : 'Save Schedule'}
                                    </Button>
                                  </div>
                                </form>
                              </Form>
                            ) : (
                              <div className="space-y-4">
                                {selectedDoctor.availabilitySlots && selectedDoctor.availabilitySlots.length > 0 ? (
                                  selectedDoctor.availabilitySlots
                                    .slice()
                                    .sort((a, b) => daysOfWeek.indexOf(a.day) - daysOfWeek.indexOf(b.day))
                                    .map((slot, index) => (
                                      <React.Fragment key={index}>
                                        <div>
                                          <p className="font-semibold text-sm">{slot.day}</p>
                                          <div className="flex flex-wrap gap-2 items-center mt-2">
                                            {slot.timeSlots.map((ts, i) => {
                                              if (!ts.from || !ts.to) return null;
                                              const fromTime = parse(ts.from, 'hh:mm a', new Date());
                                              const toTime = parse(ts.to, 'hh:mm a', new Date());

                                              return (
                                                <Badge key={i} variant="outline" className="text-sm group relative pr-7">
                                                  {!isNaN(fromTime.valueOf()) ? format(fromTime, 'p') : ts.from} - {!isNaN(toTime.valueOf()) ? format(toTime, 'p') : ts.to}
                                                  <button
                                                    onClick={() => handleDeleteTimeSlot(slot.day, ts)}
                                                    className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity"
                                                  >
                                                    <X className="h-3 w-3 text-red-500" />
                                                  </button>
                                                </Badge>
                                              );
                                            })}
                                          </div>
                                        </div>
                                        {index < selectedDoctor.availabilitySlots!.length - 1 && <Separator className="my-3" />}
                                      </React.Fragment>
                                    ))
                                ) : (
                                  <p className="text-sm text-muted-foreground">No availability slots defined.</p>
                                )}
                              </div>
                            )}
                          </CardContent>
                        </Card>
                      </div>
                    </div>
                  </TabsContent>
                  <TabsContent value="analytics" className="mt-4 space-y-6">
                    <div className="flex justify-between items-center">
                      <p className="text-sm text-muted-foreground">
                        {dateRange?.from ?
                          dateRange.to ? `${format(dateRange.from, "LLL dd, y")} - ${format(dateRange.to, "LLL dd, y")}`
                            : format(dateRange.from, "LLL dd, y")
                          : "Select a date range"
                        }
                      </p>
                      <div className="flex items-center gap-2">
                        <DateRangePicker
                          onDateChange={setDateRange}
                          initialDateRange={dateRange}
                        />
                        <Button variant="outline" size="icon">
                          <Printer className="h-4 w-4" />
                          <span className="sr-only">Print</span>
                        </Button>
                        <Button variant="outline" size="icon">
                          <FileDown className="h-4 w-4" />
                          <span className="sr-only">Download PDF</span>
                        </Button>
                      </div>
                    </div>
                    <OverviewStats dateRange={dateRange} doctorId={selectedDoctor.id} />
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                      <AppointmentStatusChart dateRange={dateRange} doctorId={selectedDoctor.id} />
                      <PatientsVsAppointmentsChart dateRange={dateRange} />
                    </div>
                  </TabsContent>
                  <TabsContent value="reviews" className="mt-4">
                    <ReviewsSection reviews={selectedDoctor.reviewList || []} />
                  </TabsContent>
                </Tabs>
              </>
            ) : (
              <Card className="h-full flex items-center justify-center">
                <p className="text-muted-foreground">Select a doctor to view details</p>
              </Card>
            )}
          </div>
        </div>
      </main >

      <AddDoctorForm
        onSave={handleDoctorSaved}
        isOpen={isAddDoctorOpen}
        setIsOpen={setIsAddDoctorOpen}
        doctor={editingDoctor}
        departments={clinicDepartments}
        updateDepartments={(newDepartment) => setClinicDepartments(prev => [...prev, newDepartment])}
      />

      <AlertDialog open={showExtensionDialog} onOpenChange={(open) => {
        if (!open) {
          setShowExtensionDialog(false);
          setPendingBreakData(null);
          setExtensionOptions(null);
        }
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Extend availability due to break?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                {extensionOptions ? (
                  extensionOptions.hasOverrun ? (
                    // Bad scenario: tokens outside availability
                    <div className="space-y-3">
                      <ul className="list-disc list-inside space-y-1 text-sm">
                        <li><strong>Original availability ends at:</strong> {extensionOptions.originalEnd}</li>
                        <li><strong>Break taken:</strong> {extensionOptions.breakDuration} minutes</li>
                        <li><strong>Actual extension needed:</strong> {extensionOptions.actualExtensionNeeded || extensionOptions.minimalExtension} minutes (gaps absorbed)</li>
                      </ul>
                      <p className="text-sm font-medium">Choose how to extend availability:</p>
                    </div>
                  ) : (
                    // Safe scenario: all tokens within availability
                    <div className="space-y-2">
                      <p>A {extensionOptions.breakDuration}-minute break only needs {extensionOptions.actualExtensionNeeded || 0}-minute extension (gaps absorbed{extensionOptions.actualExtensionNeeded === 0 ? ' - no extension needed' : ''}). Do you still want to extend availability?</p>
                    </div>
                  )
                ) : (
                  <p>Do you want to extend the availability time to compensate for the break duration?</p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="mt-4 flex flex-col space-y-2 sm:flex-col sm:space-x-0">
            {extensionOptions?.hasOverrun ? (
              // Bad scenario: 2 buttons (minimal vs full extension)
              <>
                <AlertDialogCancel className="w-full justify-start h-auto py-3 whitespace-normal">Cancel</AlertDialogCancel>
                <AlertDialogAction className="w-full justify-start h-auto py-3 whitespace-normal" onClick={() => {
                  if (!leaveCalDate || !extensionOptions) return;
                  const originalEndDate = parseTimeUtil(extensionOptions.originalEnd, leaveCalDate);
                  const minimalEndDate = addMinutes(originalEndDate, extensionOptions.minimalExtension);
                  confirmBreakWithExtension(extensionOptions.minimalExtension);
                }}>
                  <div className="flex flex-col items-start text-left">
                    <span className="font-semibold">
                      Finish booked patients → Till {(() => {
                        if (!leaveCalDate || !extensionOptions) return '';
                        const originalEndDate = parseTimeUtil(extensionOptions.originalEnd, leaveCalDate);
                        const minimalEndDate = addMinutes(originalEndDate, extensionOptions.minimalExtension);
                        return format(minimalEndDate, 'hh:mm a');
                      })()}
                    </span>
                  </div>
                </AlertDialogAction>
                <AlertDialogAction className="w-full justify-start h-auto py-3 whitespace-normal" onClick={() => {
                  if (extensionOptions) {
                    confirmBreakWithExtension(extensionOptions.fullExtension);
                  }
                }}>
                  <div className="flex flex-col items-start text-left">
                    <span className="font-semibold">
                      Fully compensate break → Till {(() => {
                        if (!leaveCalDate || !extensionOptions) return '';
                        const originalEndDate = parseTimeUtil(extensionOptions.originalEnd, leaveCalDate);
                        const fullEndDate = addMinutes(originalEndDate, extensionOptions.fullExtension);
                        return format(fullEndDate, 'hh:mm a');
                      })()}
                    </span>
                  </div>
                </AlertDialogAction>
              </>
            ) : (
              // Safe scenario: 3 buttons (Cancel, No Keep Same, Yes Extend)
              <>
                <AlertDialogCancel className="w-full justify-start">Cancel</AlertDialogCancel>
                <AlertDialogAction className="w-full justify-start" onClick={() => confirmBreakWithExtension(null)}>No, Keep Same</AlertDialogAction>
                <AlertDialogAction className="w-full justify-start" onClick={() => {
                  if (extensionOptions) {
                    confirmBreakWithExtension(extensionOptions.fullExtension);
                  } else {
                    confirmBreakWithExtension(null);
                  }
                }}>Yes, Extend {extensionOptions ? `(${extensionOptions.breakDuration} min)` : ''}</AlertDialogAction>
              </>
            )}
          </div>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!cancelBreakPrompt} onOpenChange={(open) => !open && setCancelBreakPrompt(null)}>
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel Break</AlertDialogTitle>
            <AlertDialogDescription>
              Please choose how to handle the canceled break time.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="space-y-6 py-4">
            {currentSession && currentSession.effectiveEnd?.getTime() !== currentSession.originalEnd?.getTime() && (
              extensionUtilization.maxExtensionNeeded >= extensionUtilization.currentExtensionDuration ? (
                // Case 1: Fully utilized. Hide toggle. show message.
                <div className="p-3 rounded-lg border bg-blue-50 text-blue-900 text-sm">
                  <div className="flex justify-between items-center">
                    <span className="font-semibold">Session extension active</span>
                    <span className="text-xs bg-blue-200 px-2 py-0.5 rounded text-blue-800">Required</span>
                  </div>
                  <p className="mt-1">
                    The session extension ({extensionUtilization.currentExtensionDuration} min) is fully required by existing appointments and cannot be removed.
                  </p>
                </div>
              ) : (
                // Case 2: Partial or None. Show Toggle.
                <div className="flex items-start justify-between space-x-4 p-3 rounded-lg border bg-muted/30">
                  <div className="space-y-0.5">
                    <Label className="text-base font-semibold">Cancel session extension</Label>
                    <p className="text-sm text-muted-foreground">
                      Remove the extra time added to the session's end for this break.
                      {extensionUtilization.needed && (
                        <span className="block text-yellow-600 font-medium mt-1">
                          Note: Appointments use {extensionUtilization.maxExtensionNeeded} min of the extension. It will be trimmed to fit them.
                        </span>
                      )}
                    </p>
                  </div>
                  <Switch
                    checked={shouldCancelExtension}
                    onCheckedChange={setShouldCancelExtension}
                  />
                </div>
              )
            )}

            <div className="flex items-start justify-between space-x-4 p-3 rounded-lg border bg-muted/30">
              <div className="space-y-0.5">
                <Label className="text-base font-semibold">Open slots for booking</Label>
                <p className="text-sm text-muted-foreground">
                  Make the break time available for new patient appointments.
                </p>
              </div>
              <Switch
                checked={shouldOpenSlots}
                onCheckedChange={setShouldOpenSlots}
              />
            </div>
          </div>

          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setCancelBreakPrompt(null)}>
              Close
            </Button>
            <Button
              variant="destructive"
              onClick={() => handleConfirmCancelBreak()}
              disabled={isSubmittingBreak}
            >
              {isSubmittingBreak ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              Confirm Cancellation
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
