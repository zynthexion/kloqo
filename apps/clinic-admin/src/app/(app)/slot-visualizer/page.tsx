"use client";

import { useEffect, useMemo, useState } from "react";
import {
  addMinutes,
  differenceInMinutes,
  format,
  getDay,
  isAfter,
  isBefore,
  isSameDay,
  startOfDay,
} from "date-fns";
import { Calendar } from "@/components/ui/calendar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/firebase";
import { db } from "@/lib/firebase";
import { collection, doc, getDoc, getDocs, onSnapshot, orderBy, query, where } from "firebase/firestore";
import type { Appointment, Doctor } from '@kloqo/shared-types';
import { Loader2, Calendar as CalendarIcon } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn, parseTime } from "@/lib/utils";
import { Progress } from "@/components/ui/progress";
import { computeWalkInSchedule } from '@kloqo/shared-core';

const daysOfWeek = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ACTIVE_STATUSES = new Set(["Pending", "Confirmed"]);

function coerceDate(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value === "number") {
    return new Date(value);
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed);
    }
    const fromString = new Date(value);
    if (!Number.isNaN(fromString.valueOf())) {
      return fromString;
    }
  }
  if (typeof value === "object" && value !== null) {
    if ("toDate" in value && typeof (value as { toDate?: () => Date }).toDate === "function") {
      try {
        return (value as { toDate: () => Date }).toDate();
      } catch {
        return null;
      }
    }
    if ("seconds" in value && typeof (value as { seconds?: number }).seconds === "number") {
      const seconds = (value as { seconds: number }).seconds;
      const nanos = Number((value as { nanoseconds?: number }).nanoseconds ?? 0);
      return new Date(seconds * 1000 + Math.floor(nanos / 1_000_000));
    }
  }
  return null;
}

function formatTimeDisplay(value: unknown): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  const date = coerceDate(value);
  if (!date) return "—";
  return format(date, "hh:mm a");
}

type SessionOption = {
  index: number;
  label: string;
  from: string;
  to: string;
};

type SessionSlot = {
  slotIndex: number;
  time: Date;
  appointment?: Appointment;
};

type DaySlot = {
  slotIndex: number;
  time: Date;
  sessionIndex: number;
};

export default function SlotVisualizerPage() {
  const { currentUser } = useAuth();
  const { toast } = useToast();

  const [clinicName, setClinicName] = useState<string | null>(null);
  const [walkInSpacing, setWalkInSpacing] = useState<number | null>(null);
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());
  const [selectedDoctorId, setSelectedDoctorId] = useState<string>("");
  const [selectedSessionIndex, setSelectedSessionIndex] = useState<number>(0);
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!currentUser) {
      setLoading(false);
      return;
    }

    let isCancelled = false;

    const loadInitialData = async () => {
      try {
        const userSnap = await getDoc(doc(db, "users", currentUser.uid));
        if (!userSnap.exists()) {
          return;
        }

        const clinicId = userSnap.data()?.clinicId;
        if (!clinicId) {
          return;
        }

        const clinicSnap = await getDoc(doc(db, "clinics", clinicId));
        if (clinicSnap.exists()) {
          const clinicData = clinicSnap.data();
          setClinicName(clinicData?.name ?? null);
          const spacingValue = Number(clinicData?.walkInTokenAllotment ?? 0);
          setWalkInSpacing(Number.isFinite(spacingValue) && spacingValue > 0 ? spacingValue : null);
        } else {
          setWalkInSpacing(null);
        }

        const doctorsQuery = query(
          collection(db, "doctors"),
          where("clinicId", "==", clinicId),
        );

        const doctorsSnap = await getDocs(doctorsQuery);
        if (isCancelled) return;

        const doctorsList = doctorsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() } as Doctor));
        setDoctors(doctorsList);

        if (doctorsList.length > 0) {
          setSelectedDoctorId(prev => prev || doctorsList[0].id);
        }
      } catch (error) {
        console.error("Failed to load slot visualizer data:", error);
        toast({
          variant: "destructive",
          title: "Unable to load data",
          description: "We couldn't load the information needed for the slot visualizer.",
        });
      } finally {
        if (!isCancelled) {
          setLoading(false);
        }
      }
    };

    loadInitialData();

    return () => {
      isCancelled = true;
    };
  }, [currentUser, toast]);

  useEffect(() => {
    if (!selectedDoctorId) {
      setAppointments([]);
      return;
    }

    const doctor = doctors.find(d => d.id === selectedDoctorId);
    if (!doctor) {
      setAppointments([]);
      return;
    }

    const formattedDate = format(selectedDate, "d MMMM yyyy");
    const appointmentsQuery = query(
      collection(db, "appointments"),
      where("doctor", "==", doctor.name),
      where("date", "==", formattedDate),
      orderBy("slotIndex", "asc"),
    );

    const unsubscribe = onSnapshot(appointmentsQuery, snapshot => {
      const docs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Appointment));
      setAppointments(docs);
    });

    return () => unsubscribe();
  }, [selectedDoctorId, selectedDate, doctors]);

  useEffect(() => {
    if (selectedDoctorId) return;
    if (doctors.length === 0) return;
    setSelectedDoctorId(doctors[0].id);
  }, [doctors, selectedDoctorId]);

  const selectedDoctor = useMemo(
    () => doctors.find(d => d.id === selectedDoctorId) ?? null,
    [doctors, selectedDoctorId],
  );

  const availableSessions: SessionOption[] = useMemo(() => {
    if (!selectedDoctor) return [];
    const dayOfWeek = daysOfWeek[getDay(selectedDate)];
    const availabilityForDay = selectedDoctor.availabilitySlots?.find(slot => slot.day === dayOfWeek);
    if (!availabilityForDay?.timeSlots) return [];

    return availabilityForDay.timeSlots.map((slot, index) => ({
      index,
      label: `Session ${index + 1} (${slot.from} – ${slot.to})`,
      from: slot.from,
      to: slot.to,
    }));
  }, [selectedDoctor, selectedDate]);

  useEffect(() => {
    if (availableSessions.length === 0) {
      setSelectedSessionIndex(0);
      return;
    }

    if (selectedSessionIndex >= availableSessions.length) {
      setSelectedSessionIndex(0);
    }
  }, [availableSessions, selectedSessionIndex]);

  const fullDaySlots: DaySlot[] = useMemo(() => {
    if (!selectedDoctor) return [];
    const dayOfWeek = daysOfWeek[getDay(selectedDate)];
    const availabilityForDay = selectedDoctor.availabilitySlots?.find(slot => slot.day === dayOfWeek);
    if (!availabilityForDay?.timeSlots) return [];

    const slotDuration = selectedDoctor.averageConsultingTime || 15;
    const slots: DaySlot[] = [];
    let slotIndex = 0;

    availabilityForDay.timeSlots.forEach((session, sessionIndex) => {
      let currentTime = parseTime(session.from, selectedDate);
      const sessionEnd = parseTime(session.to, selectedDate);

      while (isBefore(currentTime, sessionEnd)) {
        slots.push({
          slotIndex,
          time: new Date(currentTime),
          sessionIndex,
        });
        currentTime = addMinutes(currentTime, slotDuration);
        slotIndex += 1;
      }
    });

    return slots;
  }, [selectedDoctor, selectedDate]);

  const appointmentsBySlot = useMemo(() => {
    const map = new Map<number, Appointment>();
    const now = new Date();
    const oneHourAhead = addMinutes(now, 60);
    const slotTimeMap = new Map<number, Date>();
    fullDaySlots.forEach(slot => {
      slotTimeMap.set(slot.slotIndex, slot.time);
    });

    // Process appointments: first active ones, then blocked ones
    const activeAppointments: Appointment[] = [];
    const blockedAppointments: Appointment[] = [];
    const otherAppointments: Appointment[] = [];

    appointments.forEach(appointment => {
      if (typeof appointment.slotIndex !== "number") {
        return;
      }

      const slotTime = slotTimeMap.get(appointment.slotIndex);

      // Include cancelled appointments within the one-hour window as blocked (they're in the bucket)
      // Include all no-show appointments as blocked (they're in the bucket)
      const isBlockedCancelled =
        appointment.status === "Cancelled" &&
        slotTime &&
        !isAfter(slotTime, oneHourAhead);

      const isBlockedNoShow = appointment.status === "No-show";

      // Skip cancellations outside the one-hour window so the slot appears available
      if (
        appointment.status === "Cancelled" &&
        slotTime &&
        isAfter(slotTime, oneHourAhead) &&
        !isBlockedCancelled
      ) {
        return;
      }

      if (ACTIVE_STATUSES.has(appointment.status ?? "")) {
        activeAppointments.push(appointment);
      } else if (isBlockedCancelled || isBlockedNoShow) {
        blockedAppointments.push(appointment);
      } else {
        otherAppointments.push(appointment);
      }
    });

    // Process active appointments first (they take priority)
    activeAppointments.forEach(appointment => {
      if (typeof appointment.slotIndex !== 'number') return;
      const existing = map.get(appointment.slotIndex);
      if (!existing) {
        map.set(appointment.slotIndex, appointment);
        return;
      }
      // Always prioritize active appointments
      if (ACTIVE_STATUSES.has(appointment.status ?? "")) {
        map.set(appointment.slotIndex, appointment);
      }
    });

    // Then process blocked appointments (only if no active appointment exists)
    blockedAppointments.forEach(appointment => {
      if (typeof appointment.slotIndex !== 'number') return;
      const existing = map.get(appointment.slotIndex);
      // Skip if there's already an active appointment
      if (existing && ACTIVE_STATUSES.has(existing.status ?? "")) {
        return;
      }
      // If no appointment exists, or existing is also blocked, add/update
      if (!existing) {
        map.set(appointment.slotIndex, appointment);
        return;
      }
      // If existing is also blocked, keep the most recent
      const existingCreatedAt = coerceDate(existing.createdAt)?.getTime() ?? 0;
      const currentCreatedAt = coerceDate(appointment.createdAt)?.getTime() ?? 0;
      if (currentCreatedAt >= existingCreatedAt) {
        map.set(appointment.slotIndex, appointment);
      }
    });

    // Finally process other appointments (if any)
    otherAppointments.forEach(appointment => {
      if (typeof appointment.slotIndex !== 'number') return;
      const existing = map.get(appointment.slotIndex);
      if (!existing) {
        map.set(appointment.slotIndex, appointment);
        return;
      }
      // Don't overwrite active or blocked appointments
      if (ACTIVE_STATUSES.has(existing.status ?? "")) {
        return;
      }
      const isExistingBlocked =
        existing.status === "Cancelled" || existing.status === "No-show";
      if (isExistingBlocked) {
        return;
      }
      // Update if more recent
      const existingCreatedAt = coerceDate(existing.createdAt)?.getTime() ?? 0;
      const currentCreatedAt = coerceDate(appointment.createdAt)?.getTime() ?? 0;
      if (currentCreatedAt >= existingCreatedAt) {
        map.set(appointment.slotIndex, appointment);
      }
    });

    return map;
  }, [appointments, fullDaySlots]);

  // Calculate bucket count: cancelled slots in 1-hour window that have walk-ins AFTER them
  // Subtract walk-ins placed outside availability (they're "using" bucket slots)
  const bucketCount = useMemo(() => {
    const now = new Date();
    const oneHourAhead = addMinutes(now, 60);
    let count = 0;

    // Get active walk-ins with their slot times
    const activeWalkIns = appointments.filter(appointment => {
      return (
        appointment.bookedVia === "Walk-in" &&
        typeof appointment.slotIndex === "number" &&
        ACTIVE_STATUSES.has(appointment.status ?? "")
      );
    });

    // Count walk-ins placed outside availability (slotIndex beyond fullDaySlots.length)
    // These are "using" bucket slots, so we'll subtract them from the bucket count
    const walkInsOutsideAvailability = activeWalkIns.filter(appt => {
      if (typeof appt.slotIndex !== "number") return false;
      // Walk-in is outside availability if slotIndex >= fullDaySlots.length
      // (fullDaySlots contains slots with slotIndex 0 to fullDaySlots.length - 1)
      return appt.slotIndex >= fullDaySlots.length;
    });
    const usedBucketSlots = walkInsOutsideAvailability.length;

    const activeWalkInsWithTimes = activeWalkIns
      .filter(appt => typeof appt.slotIndex === "number")
      .map(appt => {
        // Check if this walk-in is outside availability (slotIndex beyond fullDaySlots)
        const slotMeta = fullDaySlots.find(s => s.slotIndex === appt.slotIndex);
        if (slotMeta) {
          return {
            appointment: appt,
            slotIndex: appt.slotIndex!,
            slotTime: slotMeta.time,
          };
        } else {
          // Walk-in is outside availability - need to calculate time
          const appointmentTime = coerceDate(appt.time);
          if (appointmentTime) {
            return {
              appointment: appt,
              slotIndex: appt.slotIndex!,
              slotTime: appointmentTime,
            };
          }
          return null;
        }
      })
      .filter((item): item is { appointment: Appointment; slotIndex: number; slotTime: Date } =>
        item !== null && item.slotTime !== undefined
      );

    const hasExistingWalkIns = activeWalkIns.length > 0;

    // Build set of slots with active appointments
    const slotsWithActiveAppointments = new Set<number>();
    appointments.forEach(appt => {
      if (
        typeof appt.slotIndex === "number" &&
        ACTIVE_STATUSES.has(appt.status ?? "")
      ) {
        slotsWithActiveAppointments.add(appt.slotIndex);
      }
    });

    // Count cancelled slots in bucket
    appointments.forEach(appointment => {
      if (
        (appointment.status === "Cancelled" || appointment.status === "No-show") &&
        typeof appointment.slotIndex === "number"
      ) {
        const slot = fullDaySlots.find(s => s.slotIndex === appointment.slotIndex);
        if (slot) {
          // For bucket count: Include past slots (within 1 hour window)
          // Only check upper bound (1 hour ahead), don't filter out past slots
          const isInBucketWindow = !isAfter(slot.time, oneHourAhead);
          const hasActiveAppt = slotsWithActiveAppointments.has(appointment.slotIndex);

          if (isInBucketWindow && !hasActiveAppt) {
            if (appointment.status === "Cancelled") {
              // Check if there are walk-ins scheduled AFTER this cancelled slot's time
              const hasWalkInsAfter = activeWalkInsWithTimes.some(
                walkIn => walkIn.slotTime && isAfter(walkIn.slotTime, slot.time)
              );

              if (hasWalkInsAfter && hasExistingWalkIns) {
                // This cancelled slot has walk-ins after it - it's in the bucket
                count += 1;
              }
            } else if (appointment.status === "No-show") {
              // All no-shows in 1-hour window go to bucket (if walk-ins exist)
              if (hasExistingWalkIns) {
                count += 1;
              }
            }
          } else if (appointment.status === "No-show" && !hasActiveAppt) {
            // No-shows outside 1-hour window also go to bucket (if walk-ins exist)
            if (hasExistingWalkIns) {
              count += 1;
            }
          }
        }
      }
    });

    // Subtract walk-ins placed outside availability (they're "using" bucket slots)
    // The effective bucket count is: cancelled slots in bucket - walk-ins using bucket slots
    const effectiveBucketCount = Math.max(0, count - usedBucketSlots);

    return effectiveBucketCount;
  }, [appointments, fullDaySlots]);

  const cancelledAndNoShowSlotIndices = useMemo(() => {
    const now = new Date();
    const oneHourAhead = addMinutes(now, 60);
    const slotIndices = new Set<number>();

    appointments.forEach(appointment => {
      if (typeof appointment.slotIndex !== "number") {
        return;
      }

      // Check if this slot has any active appointments
      const hasActiveAppointment = appointments.some(apt =>
        apt.slotIndex === appointment.slotIndex &&
        ACTIVE_STATUSES.has(apt.status ?? "")
      );

      // Only add to bucket if there's no active appointment for this slot
      if (!hasActiveAppointment) {
        if (appointment.status === "Cancelled") {
          const slot = fullDaySlots.find(s => s.slotIndex === appointment.slotIndex);
          if (slot && !isAfter(slot.time, oneHourAhead)) {
            // Cancelled within one-hour window - check if it has walk-ins after
            const activeWalkIns = appointments.filter(appt => {
              return (
                appt.bookedVia === "Walk-in" &&
                typeof appt.slotIndex === "number" &&
                ACTIVE_STATUSES.has(appt.status ?? "")
              );
            });

            const activeWalkInsWithTimes = activeWalkIns
              .filter(appt => typeof appt.slotIndex === "number")
              .map(appt => {
                // Check if this walk-in is outside availability (slotIndex beyond fullDaySlots)
                const slotMeta = fullDaySlots.find(s => s.slotIndex === appt.slotIndex);
                if (slotMeta) {
                  return {
                    slotIndex: appt.slotIndex!,
                    slotTime: slotMeta.time,
                  };
                } else {
                  // Walk-in is outside availability - use appointment time
                  const appointmentTime = coerceDate(appt.time);
                  if (appointmentTime) {
                    return {
                      slotIndex: appt.slotIndex!,
                      slotTime: appointmentTime,
                    };
                  }
                  return null;
                }
              })
              .filter((item): item is { slotIndex: number; slotTime: Date } =>
                item !== null && item.slotTime !== undefined
              );

            const hasWalkInsAfter = activeWalkInsWithTimes.some(
              walkIn => walkIn.slotTime && isAfter(walkIn.slotTime, slot.time)
            );

            if (hasWalkInsAfter && activeWalkIns.length > 0) {
              // Cancelled within one-hour window with walk-ins after - goes to bucket
              slotIndices.add(appointment.slotIndex);
            }
          }
        } else if (appointment.status === "No-show") {
          // All no-shows go to bucket (if no active appointment and walk-ins exist)
          const hasExistingWalkIns = appointments.some(appt =>
            appt.bookedVia === "Walk-in" &&
            typeof appt.slotIndex === "number" &&
            ACTIVE_STATUSES.has(appt.status ?? "")
          );
          if (hasExistingWalkIns) {
            slotIndices.add(appointment.slotIndex);
          }
        }
      }
    });

    return slotIndices;
  }, [appointments, fullDaySlots]);

  const blockedSlots = useMemo(() => {
    const now = new Date();
    const oneHourAhead = addMinutes(now, 60);
    const blocked = new Set<number>();

    appointments.forEach(appointment => {
      if (typeof appointment.slotIndex !== "number") {
        return;
      }

      const slot = fullDaySlots.find(s => s.slotIndex === appointment.slotIndex);
      if (!slot) return;

      // Check if this slot is blocked (cancelled within one-hour window or no-show)
      const isBlockedCancelled =
        appointment.status === "Cancelled" &&
        !isAfter(slot.time, oneHourAhead);
      const isBlockedNoShow = appointment.status === "No-show";

      // Only mark as blocked if there's no active appointment at this slot
      if ((isBlockedCancelled || isBlockedNoShow)) {
        const hasActiveAppointment = appointments.some(apt =>
          apt.slotIndex === appointment.slotIndex &&
          ACTIVE_STATUSES.has(apt.status ?? "") &&
          apt.id !== appointment.id
        );

        if (!hasActiveAppointment) {
          blocked.add(appointment.slotIndex);
        }
      }
    });

    return blocked;
  }, [appointments, fullDaySlots]);

  // Find appointments that are outside availability time (slotIndex beyond fullDaySlots)
  // Grouped by session so we can display them correctly
  const outsideAvailabilitySlotsBySession = useMemo(() => {
    if (!selectedDoctor) return new Map<number, Array<{ slotIndex: number; appointment: Appointment; time: Date }>>();

    const slotDuration = selectedDoctor.averageConsultingTime || 15;
    const dayOfWeek = daysOfWeek[getDay(selectedDate)];
    const availabilityForDay = selectedDoctor.availabilitySlots?.find(slot => slot.day === dayOfWeek);
    if (!availabilityForDay?.timeSlots) return new Map();

    const result = new Map<number, Array<{ slotIndex: number; appointment: Appointment; time: Date }>>();

    // Initialize result map for all sessions
    availabilityForDay.timeSlots.forEach((_, sessionIndex) => {
      result.set(sessionIndex, []);
    });

    appointments.forEach(appointment => {
      if (typeof appointment.slotIndex !== 'number') {
        return;
      }

      // Check if this slotIndex is not in fullDaySlots (outside availability)
      const slotInFullDay = fullDaySlots.find(s => s.slotIndex === appointment.slotIndex);
      if (!slotInFullDay) {
        // This appointment is outside availability
        // Try to determine which session it belongs to by finding the closest session end
        let assignedSessionIndex = -1;
        let minDistance = Infinity;
        let calculatedTime: Date | null = null;

        // Try to use appointment time if available
        const appointmentTime = coerceDate(appointment.time);

        // Check each session to find the best match
        availabilityForDay.timeSlots.forEach((session, sessionIndex) => {
          const sessionSlotsInFullDay = fullDaySlots.filter(s => s.sessionIndex === sessionIndex);
          if (sessionSlotsInFullDay.length > 0) {
            const lastSlotInSession = sessionSlotsInFullDay[sessionSlotsInFullDay.length - 1];

            // If slotIndex is after last slot in this session, it could belong here
            if ((appointment.slotIndex as number) > lastSlotInSession.slotIndex) {
              const slotsBeyondAvailability = (appointment.slotIndex as number) - lastSlotInSession.slotIndex;
              const outsideTime = addMinutes(lastSlotInSession.time, slotDuration * slotsBeyondAvailability);

              // Use appointment time if available, otherwise use calculated time
              const timeToUse = appointmentTime || outsideTime;

              // Check if this time falls after the session end
              const sessionEnd = parseTime(session.to, selectedDate);
              if (isAfter(timeToUse, sessionEnd) || timeToUse.getTime() === sessionEnd.getTime()) {
                // Calculate distance from session end
                const distance = Math.abs(timeToUse.getTime() - sessionEnd.getTime());
                if (distance < minDistance) {
                  minDistance = distance;
                  assignedSessionIndex = sessionIndex;
                  calculatedTime = timeToUse;
                }
              } else if (assignedSessionIndex === -1) {
                // Fallback: if no better match, use the first session that fits
                assignedSessionIndex = sessionIndex;
                calculatedTime = timeToUse;
              }
            }
          }
        });

        // If we couldn't determine the session, try to infer from appointment time
        if (assignedSessionIndex === -1 && appointmentTime) {
          availabilityForDay.timeSlots.forEach((session, sessionIndex) => {
            const sessionStart = parseTime(session.from, selectedDate);
            const sessionEnd = parseTime(session.to, selectedDate);

            // If appointment time is after this session end but before next session start
            // (or it's the last session), assign it here
            if (isAfter(appointmentTime, sessionEnd) || appointmentTime.getTime() === sessionEnd.getTime()) {
              const nextSessionIndex = sessionIndex + 1;
              if (nextSessionIndex >= availabilityForDay.timeSlots.length) {
                // This is the last session, assign it here
                if (assignedSessionIndex === -1) {
                  assignedSessionIndex = sessionIndex;
                  calculatedTime = appointmentTime;
                }
              } else {
                const nextSession = availabilityForDay.timeSlots[nextSessionIndex];
                const nextSessionStart = parseTime(nextSession.from, selectedDate);
                if (isBefore(appointmentTime, nextSessionStart)) {
                  // Appointment is between this session end and next session start
                  if (assignedSessionIndex === -1) {
                    assignedSessionIndex = sessionIndex;
                    calculatedTime = appointmentTime;
                  }
                }
              }
            }
          });
        }

        // Fallback: if still no match, use appointment time and assign to last session
        if (assignedSessionIndex === -1) {
          assignedSessionIndex = availabilityForDay.timeSlots.length - 1;
          calculatedTime = appointmentTime || new Date();
        }

        // Add to result
        if (calculatedTime && assignedSessionIndex >= 0) {
          const sessionSlots = result.get(assignedSessionIndex) || [];
          sessionSlots.push({
            slotIndex: appointment.slotIndex as number,
            appointment,
            time: calculatedTime,
          });
          result.set(assignedSessionIndex, sessionSlots);
        }
      }
    });

    // Sort each session's outside slots by slotIndex
    result.forEach((slots, sessionIndex) => {
      result.set(sessionIndex, slots.sort((a, b) => a.slotIndex - b.slotIndex));
    });

    return result;
  }, [appointments, fullDaySlots, availableSessions, selectedDate, selectedDoctor]);

  // Get outside availability slots for the currently selected session
  const outsideAvailabilitySlots = useMemo(() => {
    const session = availableSessions[selectedSessionIndex];
    if (!session) return [];

    return outsideAvailabilitySlotsBySession.get(session.index) || [];
  }, [outsideAvailabilitySlotsBySession, availableSessions, selectedSessionIndex]);

  const sessionSlots: SessionSlot[] = useMemo(() => {
    if (!selectedDoctor) return [];
    const session = availableSessions[selectedSessionIndex];
    if (!session) return [];

    // Get slots within availability
    const slotsInAvailability = fullDaySlots
      .filter(slot => slot.sessionIndex === session.index)
      .map(slot => ({
        slotIndex: slot.slotIndex,
        time: slot.time,
        appointment: appointmentsBySlot.get(slot.slotIndex),
      }));

    // Get slots outside availability for this session
    const slotsOutsideAvailability = outsideAvailabilitySlots.map((item: { slotIndex: number; appointment: Appointment; time: Date }) => ({
      slotIndex: item.slotIndex,
      time: item.time,
      appointment: item.appointment,
    }));

    // Combine and sort by slotIndex
    return [...slotsInAvailability, ...slotsOutsideAvailability].sort((a, b) => a.slotIndex - b.slotIndex);
  }, [availableSessions, appointmentsBySlot, fullDaySlots, selectedDoctor, selectedSessionIndex, outsideAvailabilitySlots]);

  // Keep futureSessionSlots for summary calculations, but show all slots in the grid
  const futureSessionSlots = useMemo(() => {
    const current = new Date();
    return sessionSlots.filter(slot => !isBefore(slot.time, current));
  }, [sessionSlots]);

  const scheduleReferenceTime = useMemo(() => {
    const todayStart = startOfDay(new Date());
    const selectedStart = startOfDay(selectedDate);
    if (selectedStart.getTime() === todayStart.getTime()) {
      return new Date();
    }
    if (selectedStart.getTime() > todayStart.getTime()) {
      return selectedStart;
    }
    return new Date();
  }, [selectedDate]);

  const sessionSummary = useMemo(() => {
    let walkIn = 0;
    let advanced = 0;
    futureSessionSlots.forEach(slot => {
      if (!slot.appointment) return;
      if (!ACTIVE_STATUSES.has(slot.appointment.status ?? "")) {
        return;
      }
      if (slot.appointment.bookedVia === "Walk-in") {
        walkIn += 1;
      } else {
        advanced += 1;
      }
    });

    const total = futureSessionSlots.length;
    const booked = walkIn + advanced;
    const available = Math.max(total - booked, 0);

    return { total, booked, available, walkIn, advanced };
  }, [futureSessionSlots]);

  const capacityInfo = useMemo(() => {
    const total = sessionSummary.total;
    const reservedMinimum = total > 0 ? Math.ceil(total * 0.15) : 0;
    const maxAdvance = Math.max(total - reservedMinimum, 0);
    const advance = sessionSummary.advanced;
    const walkIn = sessionSummary.walkIn;
    const advancePercent = total > 0 ? (advance / total) * 100 : 0;
    const walkInPercent = total > 0 ? (walkIn / total) * 100 : 0;
    const remainingAdvance = Math.max(maxAdvance - advance, 0);
    const limitReached = maxAdvance > 0 && advance >= maxAdvance;

    return {
      total,
      reservedMinimum,
      maxAdvance,
      advancePercent,
      walkInPercent,
      remainingAdvance,
      limitReached,
    };
  }, [sessionSummary]);

  const walkInSchedule = useMemo(() => {
    const result = {
      assignmentById: new Map<string, { slotIndex: number; slotTime: Date; sessionIndex: number }>(),
      placeholderAssignment: null as { slotIndex: number; slotTime: Date; sessionIndex: number } | null,
    };

    if (!selectedDoctor || fullDaySlots.length === 0) {
      return result;
    }

    const spacingValue =
      walkInSpacing && Number.isFinite(walkInSpacing) && walkInSpacing > 0
        ? Math.floor(walkInSpacing)
        : 0;

    const schedulerSlots = fullDaySlots.map(slot => ({
      index: slot.slotIndex,
      time: slot.time,
      sessionIndex: slot.sessionIndex,
    }));

    const activeAdvanceAppointments = appointments.filter(appointment => {
      return (
        appointment.bookedVia !== "Walk-in" &&
        typeof appointment.slotIndex === "number" &&
        ACTIVE_STATUSES.has(appointment.status ?? "")
      );
    });

    const activeWalkIns = appointments.filter(appointment => {
      return (
        appointment.bookedVia === "Walk-in" &&
        typeof appointment.slotIndex === "number" &&
        ACTIVE_STATUSES.has(appointment.status ?? "")
      );
    });

    const walkInCandidates = activeWalkIns.map(appointment => ({
      id: appointment.id,
      numericToken:
        typeof appointment.numericToken === "number"
          ? appointment.numericToken
          : Number(appointment.numericToken ?? 0) || 0,
      createdAt: coerceDate(appointment.createdAt) ?? undefined,
      currentSlotIndex: typeof appointment.slotIndex === "number" ? appointment.slotIndex : undefined,
    }));

    const placeholderId = "__next_walk_in__";
    const existingNumericTokens = walkInCandidates
      .map(candidate => candidate.numericToken)
      .filter(token => Number.isFinite(token) && token > 0);
    const placeholderNumericToken =
      (existingNumericTokens.length > 0 ? Math.max(...existingNumericTokens) : fullDaySlots.length) + 1;

    const candidates = [
      ...walkInCandidates,
      {
        id: placeholderId,
        numericToken: placeholderNumericToken,
        createdAt: new Date(),
      },
    ];

    try {
      const schedule = computeWalkInSchedule({
        slots: schedulerSlots,
        now: scheduleReferenceTime,
        walkInTokenAllotment: spacingValue,
        advanceAppointments: activeAdvanceAppointments.map(entry => ({
          id: entry.id,
          slotIndex: typeof entry.slotIndex === "number" ? entry.slotIndex : -1,
        })),
        walkInCandidates: candidates,
      });

      schedule.assignments.forEach(assignment => {
        result.assignmentById.set(assignment.id, {
          slotIndex: assignment.slotIndex ?? -1,
          sessionIndex: assignment.sessionIndex ?? -1,
          slotTime: assignment.slotTime,
        });
      });

      const placeholderAssignment = result.assignmentById.get(placeholderId);
      if (placeholderAssignment) {
        result.placeholderAssignment = placeholderAssignment;
      }
    } catch (error) {
      console.error("Failed to compute walk-in assignments:", error);
    }

    return result;
  }, [appointments, fullDaySlots, scheduleReferenceTime, selectedDoctor, walkInSpacing]);

  const nextWalkInPreview = walkInSchedule.placeholderAssignment
    ? {
      slotIndex: walkInSchedule.placeholderAssignment.slotIndex,
      time: walkInSchedule.placeholderAssignment.slotTime,
    }
    : null;

  const nextAdvancePreview = useMemo(() => {
    if (!selectedDoctor) return null;
    if (fullDaySlots.length === 0) return null;

    const occupiedSlots = new Set<number>();
    appointments.forEach(appointment => {
      if (
        typeof appointment.slotIndex === "number" &&
        ACTIVE_STATUSES.has(appointment.status ?? "")
      ) {
        occupiedSlots.add(appointment.slotIndex);
      }
    });

    const selectedDayStart = startOfDay(selectedDate);
    const todayStart = startOfDay(new Date());
    const isSelectedToday = isSameDay(selectedDayStart, todayStart);
    const minimumTime = isSelectedToday ? addMinutes(scheduleReferenceTime, 60) : scheduleReferenceTime;

    for (const slot of fullDaySlots) {
      if (isBefore(slot.time, scheduleReferenceTime)) {
        continue;
      }
      if (isSelectedToday && isBefore(slot.time, minimumTime)) {
        continue;
      }
      if (occupiedSlots.has(slot.slotIndex)) {
        continue;
      }
      return {
        slotIndex: slot.slotIndex,
        time: slot.time,
      };
    }

    return null;
  }, [appointments, fullDaySlots, scheduleReferenceTime, selectedDate, selectedDoctor]);

  const cancelledAndNoShowSlots = useMemo(() => {
    const now = new Date();
    const oneHourAhead = addMinutes(now, 60);

    // Filter cancelled/no-show appointments
    const relevantAppointments = appointments.filter(appointment => {
      if (typeof appointment.slotIndex !== "number") {
        return false;
      }

      if (appointment.status === "Cancelled") {
        const slot = fullDaySlots.find(s => s.slotIndex === appointment.slotIndex);
        if (!slot) return false;
        return !isAfter(slot.time, oneHourAhead);
      }

      return appointment.status === "No-show";
    });

    // Map to slots, but exclude slots that now have active appointments
    return relevantAppointments
      .map(appointment => {
        const slot = fullDaySlots.find(s => s.slotIndex === appointment.slotIndex);
        if (!slot) return null;

        // Check if this slot now has an active appointment (was reused)
        const hasActiveAppointment = appointments.some(apt =>
          apt.slotIndex === appointment.slotIndex &&
          ACTIVE_STATUSES.has(apt.status ?? "") &&
          apt.id !== appointment.id // Don't count the cancelled/no-show appointment itself
        );

        // Only include if there's no active appointment for this slot
        if (hasActiveAppointment) {
          return null;
        }

        return {
          slotIndex: appointment.slotIndex,
          time: slot.time,
          appointment,
          sessionIndex: slot.sessionIndex,
        };
      })
      .filter((slot): slot is { slotIndex: number; time: Date; appointment: Appointment; sessionIndex: number } => slot !== null)
      .sort((a, b) => a.slotIndex - b.slotIndex);
  }, [appointments, fullDaySlots]);

  const sessionProgress = useMemo(() => {
    if (!selectedDoctor) return null;
    if (sessionSlots.length === 0) return null;

    const slotDuration = selectedDoctor.averageConsultingTime || 15;
    const totalSlots = sessionSlots.length;
    const sessionStart = sessionSlots[0]?.time ?? null;
    const sessionEnd = sessionSlots[sessionSlots.length - 1]?.time ?? null;

    if (!sessionStart || !sessionEnd) {
      return null;
    }

    const sessionEndPlus = addMinutes(sessionEnd, slotDuration);
    const totalMinutes = Math.max(differenceInMinutes(sessionEndPlus, sessionStart), 0);

    const completedCount = sessionSlots.filter(slot => slot.appointment?.status === "Completed").length;
    const expectedMinutes = completedCount * slotDuration;

    const now = new Date();
    const actualElapsedRaw = differenceInMinutes(now, sessionStart);
    const actualElapsed = Math.min(Math.max(actualElapsedRaw, 0), totalMinutes);

    const progressValue = totalMinutes > 0 ? Math.min((expectedMinutes / totalMinutes) * 100, 100) : 0;
    const actualProgressValue = totalMinutes > 0 ? Math.min((actualElapsed / totalMinutes) * 100, 100) : 0;
    const delayMinutes = actualElapsed - expectedMinutes;

    return {
      totalMinutes,
      expectedMinutes,
      actualElapsed,
      delayMinutes,
      progressValue,
      actualProgressValue,
      completedCount,
      remainingCount: Math.max(totalSlots - completedCount, 0),
    };
  }, [selectedDoctor, sessionSlots]);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto p-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-col gap-1">
            <span>Slot Visualizer</span>
            {clinicName && <span className="text-sm font-normal text-muted-foreground">{clinicName}</span>}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <div className="space-y-2">
              <label className="text-sm font-medium">Select Doctor</label>
              <Select value={selectedDoctorId} onValueChange={setSelectedDoctorId} disabled={doctors.length === 0}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a doctor" />
                </SelectTrigger>
                <SelectContent>
                  {doctors.map(doctor => (
                    <SelectItem key={doctor.id} value={doctor.id}>
                      {doctor.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Select Date</label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className={cn(
                      "w-full justify-start text-left font-normal",
                      !selectedDate && "text-muted-foreground",
                    )}
                  >
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {selectedDate ? format(selectedDate, "PPP") : "Pick a date"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={selectedDate}
                    onSelect={date => date && setSelectedDate(date)}
                    disabled={date => isBefore(date, startOfDay(new Date()))}
                    initialFocus
                  />
                </PopoverContent>
              </Popover>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Select Session</label>
              <Select
                value={selectedSessionIndex.toString()}
                onValueChange={value => setSelectedSessionIndex(Number.parseInt(value, 10))}
                disabled={availableSessions.length === 0}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a session" />
                </SelectTrigger>
                <SelectContent>
                  {availableSessions.length === 0 ? (
                    <SelectItem value="0" disabled>
                      No sessions
                    </SelectItem>
                  ) : (
                    availableSessions.map(session => (
                      <SelectItem key={session.index} value={session.index.toString()}>
                        {session.label}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-4">
            {!selectedDoctor && (
              <p className="text-sm text-muted-foreground">Add a doctor to view slots for this clinic.</p>
            )}

            {selectedDoctor && availableSessions.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No availability configured for {format(selectedDate, "PPP")}. Update the doctor’s schedule to see slots.
              </p>
            )}

            {selectedDoctor && availableSessions.length > 0 && (
              <div className="overflow-hidden rounded-md border">
                <div className="grid gap-3 border-b bg-muted/30 p-4 text-sm md:grid-cols-5">
                  <div>
                    <p className="text-xs uppercase text-muted-foreground">Upcoming slots</p>
                    <p className="text-xl font-semibold">{sessionSummary.total}</p>
                  </div>
                  <div>
                    <p className="text-xs uppercase text-muted-foreground">Advance bookings</p>
                    <p className="text-xl font-semibold">{sessionSummary.advanced}</p>
                    <span className="text-xs text-muted-foreground">
                      {capacityInfo.maxAdvance > 0
                        ? `${sessionSummary.advanced} / ${capacityInfo.maxAdvance} capacity`
                        : "Advance quota unavailable"}
                    </span>
                  </div>
                  <div>
                    <p className="text-xs uppercase text-muted-foreground">Walk-in bookings</p>
                    <p className="text-xl font-semibold">{sessionSummary.walkIn}</p>
                    <span className="text-xs text-muted-foreground">
                      Minimum reserve: {capacityInfo.reservedMinimum} slot{capacityInfo.reservedMinimum === 1 ? "" : "s"}
                    </span>
                  </div>
                  <div>
                    <p className="text-xs uppercase text-muted-foreground">Available</p>
                    <p className="text-xl font-semibold">{sessionSummary.available}</p>
                    <span className="text-xs text-muted-foreground">{sessionSummary.booked} booked so far</span>
                  </div>
                  <div>
                    <p className="text-xs uppercase text-muted-foreground">Bucket Count</p>
                    <p className="text-xl font-semibold">{bucketCount}</p>
                    <span className="text-xs text-muted-foreground">
                      Cancelled & No-show slots
                    </span>
                  </div>
                </div>
                <div className="grid gap-4 border-b bg-muted/20 px-4 py-3 text-xs text-muted-foreground md:grid-cols-2">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-xs font-medium text-foreground">
                      <span className="flex items-center gap-2">
                        <span className="h-2.5 w-2.5 rounded-full bg-sky-500" />
                        Advanced (max 85%)
                      </span>
                      <span>
                        {sessionSummary.advanced}
                        {capacityInfo.maxAdvance > 0 ? ` / ${capacityInfo.maxAdvance}` : ""}
                        {capacityInfo.total > 0 ? ` · ${Math.round(capacityInfo.advancePercent)}%` : ""}
                      </span>
                    </div>
                    <Progress value={Math.min(capacityInfo.advancePercent, 100)} className="h-2" />
                    {capacityInfo.maxAdvance === 0 ? (
                      <p className="text-[11px] text-muted-foreground">
                        No advance capacity configured for this session.
                      </p>
                    ) : capacityInfo.limitReached ? (
                      <p className="text-[11px] text-destructive">
                        Advance booking limit reached. Convert new tokens to walk-ins.
                      </p>
                    ) : (
                      <p className="text-[11px] text-muted-foreground">
                        {capacityInfo.remainingAdvance} advance slot(s) remaining before reaching the limit.
                      </p>
                    )}
                  </div>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-xs font-medium text-foreground">
                      <span className="flex items-center gap-2">
                        <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
                        Walk-ins
                      </span>
                      <span>
                        {sessionSummary.walkIn}
                        {capacityInfo.total > 0 ? ` · ${Math.round(capacityInfo.walkInPercent)}%` : ""}
                      </span>
                    </div>
                    <Progress value={Math.min(capacityInfo.walkInPercent, 100)} className="h-2" />
                    <p className="text-[11px] text-muted-foreground">
                      Walk-ins have a minimum reserve of {capacityInfo.reservedMinimum} slot
                      {capacityInfo.reservedMinimum === 1 ? "" : "s"} but can use any additional capacity.
                    </p>
                  </div>
                </div>
                {nextWalkInPreview ? (
                  <div className="border-b bg-emerald-50/60 px-4 py-3 text-sm text-emerald-900">
                    Next walk-in token will target{" "}
                    <span className="font-semibold">
                      slot #{nextWalkInPreview.slotIndex + 1} · {format(nextWalkInPreview.time, "hh:mm a")}
                    </span>
                  </div>
                ) : (
                  <div className="border-b bg-muted/15 px-4 py-3 text-sm text-muted-foreground">
                    Unable to determine the next walk-in slot based on the current data.
                  </div>
                )}
                {nextAdvancePreview ? (
                  <div className="border-b bg-sky-50/60 px-4 py-3 text-sm text-sky-900">
                    Next advance booking will target{" "}
                    <span className="font-semibold">
                      slot #{nextAdvancePreview.slotIndex + 1} · {format(nextAdvancePreview.time, "hh:mm a")}
                    </span>
                  </div>
                ) : (
                  <div className="border-b bg-muted/15 px-4 py-3 text-sm text-muted-foreground">
                    Unable to determine the next advance slot based on the current data.
                  </div>
                )}
                {sessionSlots.length === 0 ? (
                  <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                    No slots found for this session.
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
                    {sessionSlots.map((slot: SessionSlot, index) => {
                      const current = new Date();
                      const isPastSlot = isBefore(slot.time, current);
                      const appointment = slot.appointment;
                      const isBlocked = blockedSlots.has(slot.slotIndex);
                      const isCancelled = appointment?.status === "Cancelled";
                      const isNoShow = appointment?.status === "No-show";
                      const hasActiveAppointment =
                        Boolean(appointment) && ACTIVE_STATUSES.has(appointment?.status ?? "");
                      const isWalkIn = appointment?.bookedVia === "Walk-in" && hasActiveAppointment;
                      const isNextWalkInTarget = nextWalkInPreview?.slotIndex === slot.slotIndex;
                      const isNextAdvanceTarget = nextAdvancePreview?.slotIndex === slot.slotIndex;
                      // Check if this slot is outside availability time
                      const isOutsideAvailability = !fullDaySlots.some(s => s.slotIndex === slot.slotIndex);
                      const cardStyles = cn(
                        "relative flex flex-col gap-2 rounded-lg border p-3 text-xs shadow-sm transition md:text-sm",
                        isBlocked
                          ? "border-gray-400 bg-gray-100 hover:border-gray-500 hover:bg-gray-100/80 opacity-75"
                          : isCancelled
                            ? "border-destructive bg-red-50 hover:border-destructive/80 hover:bg-red-50/80"
                            : hasActiveAppointment
                              ? isWalkIn
                                ? "border-emerald-300 bg-emerald-50 hover:border-emerald-400 hover:bg-emerald-50/80"
                                : "border-sky-300 bg-sky-50 hover:border-sky-400 hover:bg-sky-50/80"
                              : "border-muted bg-background hover:border-muted-foreground/40",
                        {
                          "ring-2 ring-emerald-500 ring-offset-2": isNextWalkInTarget && !isBlocked,
                          "ring-2 ring-sky-500 ring-offset-2": !isCancelled && !isBlocked && isNextAdvanceTarget,
                          "border-dashed": isOutsideAvailability && !isBlocked && !hasActiveAppointment,
                          "bg-amber-50/50 border-amber-300": isOutsideAvailability && !isBlocked && !hasActiveAppointment,
                          "opacity-60": isPastSlot,
                        }
                      );

                      return (
                        <div key={slot.slotIndex} className={cardStyles}>
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex flex-col">
                              <span className="text-xs uppercase text-muted-foreground">Slot</span>
                              <span className="text-lg font-semibold">#{slot.slotIndex + 1}</span>
                            </div>
                            <Badge variant="outline">{format(slot.time, "hh:mm a")}</Badge>
                          </div>
                          {isPastSlot && (
                            <div className="flex items-center gap-2 rounded-full bg-muted/50 px-2 py-1 text-[11px] font-medium text-muted-foreground">
                              Past Slot
                            </div>
                          )}
                          {isOutsideAvailability && !isBlocked && (
                            <div className="flex items-center gap-2 rounded-full bg-amber-500/10 px-2 py-1 text-[11px] font-medium text-amber-700">
                              Outside Availability Time
                            </div>
                          )}
                          {isBlocked && (
                            <div className="flex items-center gap-2 rounded-full bg-gray-500/10 px-2 py-1 text-[11px] font-medium text-gray-700">
                              Blocked (Cancelled & No-Show Bucket)
                            </div>
                          )}
                          {isNextWalkInTarget && !isBlocked && (
                            <div className="flex items-center gap-2 rounded-full bg-emerald-500/10 px-2 py-1 text-[11px] font-medium text-emerald-700">
                              Next walk-in target
                            </div>
                          )}
                          {isNextAdvanceTarget && !isCancelled && !isBlocked && (
                            <div className="flex items-center gap-2 rounded-full bg-sky-500/10 px-2 py-1 text-[11px] font-medium text-sky-700">
                              Next advance target
                            </div>
                          )}
                          {isCancelled && isNextAdvanceTarget && !isBlocked && (
                            <div className="flex items-center gap-2 rounded-full bg-destructive/10 px-2 py-1 text-[11px] font-medium text-destructive">
                              Cancelled – reserved for next advance booking
                            </div>
                          )}

                          <div className="flex items-center justify-between text-xs">
                            <span
                              className={cn(
                                "font-medium",
                                isBlocked
                                  ? "text-gray-600"
                                  : hasActiveAppointment
                                    ? "text-foreground"
                                    : isCancelled
                                      ? "text-destructive"
                                      : "text-muted-foreground",
                              )}
                            >
                              {isBlocked
                                ? "Blocked"
                                : isCancelled
                                  ? "Cancelled"
                                  : hasActiveAppointment
                                    ? "Booked"
                                    : "Available"}
                            </span>
                            {appointment?.tokenNumber && (
                              <span className="rounded-full bg-foreground/10 px-2 py-0.5 font-medium text-foreground">
                                {appointment.tokenNumber}
                              </span>
                            )}
                          </div>

                          <div className="min-h-[2.5rem] text-sm">
                            {appointment ? (
                              <div className="flex flex-col gap-2">
                                <p className="font-medium leading-tight">
                                  {appointment.patientName ?? "Unknown patient"}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                  {appointment.communicationPhone ?? "—"}
                                </p>
                                <div className="space-y-1 text-[11px] text-muted-foreground">
                                  <p>
                                    <span className="font-semibold text-foreground/80">Status:</span>{" "}
                                    <span className="font-medium">{appointment.status ?? "—"}</span>
                                  </p>
                                  <p>
                                    <span className="font-semibold text-foreground/80">Appointment:</span>{" "}
                                    {formatTimeDisplay(appointment.time)}
                                  </p>
                                  <p>
                                    <span className="font-semibold text-foreground/80">Cut-off:</span>{" "}
                                    {formatTimeDisplay(appointment.cutOffTime)}
                                  </p>
                                  <p>
                                    <span className="font-semibold text-foreground/80">No-show:</span>{" "}
                                    {formatTimeDisplay(appointment.noShowTime)}
                                  </p>
                                </div>
                              </div>
                            ) : (
                              <p className="text-xs text-muted-foreground">No patient assigned</p>
                            )}
                          </div>


                          <div>
                            <div className="flex flex-wrap items-center gap-2">
                              {appointment?.status && (
                                <Badge
                                  variant={
                                    appointment.status === "Pending" ? "secondary" :
                                      appointment.status === "Confirmed" ? "default" :
                                        appointment.status === "Completed" ? "default" :
                                          appointment.status === "Skipped" ? "outline" :
                                            appointment.status === "No-show" ? "destructive" :
                                              appointment.status === "Cancelled" ? "destructive" :
                                                "outline"
                                  }
                                  className={
                                    appointment.status === "Completed" ? "bg-green-500 text-white" :
                                      appointment.status === "Skipped" ? "border-orange-400 text-orange-700" :
                                        ""
                                  }
                                >
                                  {appointment.status}
                                </Badge>
                              )}
                              {isBlocked ? (
                                <Badge variant="outline" className="border-gray-400 text-gray-700 bg-gray-100">
                                  Blocked (Cancelled & No-Show Bucket)
                                </Badge>
                              ) : appointment ? (
                                isCancelled ? (
                                  <Badge variant="destructive">Cancelled</Badge>
                                ) : (
                                  <Badge variant={isWalkIn ? "default" : "secondary"}>
                                    {isWalkIn ? "Walk-in booking" : "Advanced booking"}
                                  </Badge>
                                )
                              ) : (
                                <Badge variant="outline">Available</Badge>
                              )}
                              {isNextAdvanceTarget && !isCancelled && !isBlocked && (
                                <Badge variant="secondary">Next advance target</Badge>
                              )}
                              {isCancelled && isNextAdvanceTarget && !isBlocked && (
                                <Badge variant="outline" className="border-destructive text-destructive">
                                  Next advance target
                                </Badge>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-4 border-t bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
                  <div className="flex items-center gap-2">
                    <span className="h-3 w-3 rounded border border-sky-400 bg-sky-100" />
                    <span>Advanced booking</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="h-3 w-3 rounded border border-emerald-400 bg-emerald-100" />
                    <span>Walk-in booking</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="h-3 w-3 rounded border border-gray-400 bg-gray-100 opacity-75" />
                    <span>Blocked (Cancelled & No-Show Bucket)</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="h-3 w-3 rounded border border-amber-300 bg-amber-50/50 border-dashed" />
                    <span>Outside Availability Time</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="h-3 w-3 rounded border border-muted bg-background" />
                    <span>Available slot</span>
                  </div>
                </div>
              </div>
            )}

            {cancelledAndNoShowSlots.length > 0 && (
              <div className="mt-6 overflow-hidden rounded-md border border-destructive/20">
                <div className="border-b bg-destructive/10 px-4 py-3">
                  <h3 className="text-sm font-semibold text-destructive">
                    Cancelled & No-Show Slots ({cancelledAndNoShowSlots.length})
                  </h3>
                  <p className="text-xs text-muted-foreground mt-1">
                    These slots were cancelled or marked as no-show
                  </p>
                </div>
                <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
                  {cancelledAndNoShowSlots.map(slot => {
                    const isCancelled = slot.appointment.status === "Cancelled";
                    const isNoShow = slot.appointment.status === "No-show";
                    const cardStyles = cn(
                      "relative flex flex-col gap-2 rounded-lg border p-3 text-xs shadow-sm transition md:text-sm",
                      isCancelled
                        ? "border-destructive bg-red-50 hover:border-destructive/80 hover:bg-red-50/80"
                        : "border-orange-300 bg-orange-50 hover:border-orange-400 hover:bg-orange-50/80"
                    );

                    return (
                      <div key={slot.slotIndex} className={cardStyles}>
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex flex-col">
                            <span className="text-xs uppercase text-muted-foreground">Slot</span>
                            <span className="text-lg font-semibold">#{slot.slotIndex + 1}</span>
                          </div>
                          <Badge variant="outline">{format(slot.time, "hh:mm a")}</Badge>
                        </div>

                        <div className="flex items-center justify-between text-xs">
                          <span className="font-medium text-destructive">
                            {isCancelled ? "Cancelled" : "No-show"}
                          </span>
                          {slot.appointment.tokenNumber && (
                            <span className="rounded-full bg-foreground/10 px-2 py-0.5 font-medium text-foreground">
                              {slot.appointment.tokenNumber}
                            </span>
                          )}
                        </div>

                        <div className="min-h-[2.5rem] text-sm">
                          <div className="flex flex-col gap-2">
                            <p className="font-medium leading-tight">
                              {slot.appointment.patientName ?? "Unknown patient"}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {slot.appointment.communicationPhone ?? "—"}
                            </p>
                            <div className="space-y-1 text-[11px] text-muted-foreground">
                              <p>
                                <span className="font-semibold text-foreground/80">Booked via:</span>{" "}
                                {slot.appointment.bookedVia ?? "—"}
                              </p>
                              <p>
                                <span className="font-semibold text-foreground/80">Original time:</span>{" "}
                                {formatTimeDisplay(slot.appointment.time)}
                              </p>
                            </div>
                          </div>
                        </div>

                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge variant={isCancelled ? "destructive" : "secondary"}>
                              {isCancelled ? "Cancelled" : "No-show"}
                            </Badge>
                            {slot.appointment.bookedVia && (
                              <Badge variant="outline">
                                {slot.appointment.bookedVia === "Walk-in" ? "Walk-in" : "Advanced"}
                              </Badge>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {sessionProgress && (
              <div className="mt-6 space-y-3 rounded-md border border-muted px-4 py-4">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-semibold text-foreground">Session Progress</h3>
                    <p className="text-xs text-muted-foreground">
                      Completed {sessionProgress.completedCount} patient
                      {sessionProgress.completedCount === 1 ? "" : "s"} · Remaining {sessionProgress.remainingCount}
                    </p>
                  </div>
                  <div className="text-right text-xs text-muted-foreground">
                    <p>Total availability: {sessionProgress.totalMinutes} min</p>
                    <p>
                      Expected time used: {sessionProgress.expectedMinutes} min
                    </p>
                  </div>
                </div>
                <div className="relative">
                  <Progress value={sessionProgress.progressValue} className="h-3" />
                  <div
                    className="absolute inset-y-0 w-[2px] rounded-full bg-foreground/70"
                    style={{ left: `${sessionProgress.actualProgressValue}%` }}
                  />
                </div>
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>
                    Actual elapsed: {sessionProgress.actualElapsed} min
                  </span>
                  <span className={sessionProgress.delayMinutes > 0 ? "text-destructive" : "text-emerald-600"}>
                    {sessionProgress.delayMinutes === 0
                      ? "On schedule"
                      : sessionProgress.delayMinutes > 0
                        ? `Delayed by ${sessionProgress.delayMinutes} min`
                        : `Ahead by ${Math.abs(sessionProgress.delayMinutes)} min`}
                  </span>
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div >
  );
}

