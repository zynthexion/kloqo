import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import { set, parse, isWithinInterval, isAfter, isBefore, format, subMinutes, addMinutes, differenceInMinutes, parseISO, isSameDay } from "date-fns";
import type { Doctor } from "@/firebase/firestore/use-doctors";
import type { Appointment } from "@/lib/types";

// Redundant break logic removed. Shared-core handles breaks.
import {
  getClinicNow,
  getClinicDayOfWeek,
  getClinicTimeString,
  buildBreakIntervalsFromPeriods,
  applyBreakOffsets as applySharedBreakOffsets,
  getSessionEnd
} from "@kloqo/shared-core";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export const parseTime = (timeStr: string, date: Date): Date => {
  const [time, modifier] = timeStr.split(' ');
  let [hours, minutes] = time.split(':').map(Number);
  if (modifier === 'PM' && hours < 12) {
    hours += 12;
  }
  if (modifier === 'AM' && hours === 12) {
    hours = 0;
  }
  return set(date, { hours, minutes, seconds: 0, milliseconds: 0 });
};

/**
 * Get the actual appointment time accounting for delay
 * @param appointmentTime - The original appointment time string (e.g., "09:20 AM")
 * @param appointmentDate - The appointment date
 * @param delay - Delay in minutes (optional)
 * @returns Date object with the actual appointment time (original + delay)
 */
export const getActualAppointmentTime = (appointmentTime: string, appointmentDate: Date, delay?: number): Date => {
  const appointmentDateTime = parseTime(appointmentTime, appointmentDate);
  if (delay && delay > 0) {
    return addMinutes(appointmentDateTime, delay);
  }
  return appointmentDateTime;
};

/**
 * Get the actual appointment time as a formatted string
 * @param appointmentTime - The original appointment time string (e.g., "09:20 AM")
 * @param appointmentDate - The appointment date
 * @param delay - Delay in minutes (optional)
 * @returns Formatted actual appointment time string (e.g., "09:30 AM" if delay is 10 minutes)
 */
export const getActualAppointmentTimeString = (appointmentTime: string, appointmentDate: Date, delay?: number): string => {
  const actualTime = getActualAppointmentTime(appointmentTime, appointmentDate, delay);
  return getClinicTimeString(actualTime);
};

/**
 * Calculate and format the "arrive by" time (actual appointment time - 15 minutes)
 * @param appointmentTime - The appointment time string (e.g., "09:20 AM")
 * @param appointmentDate - The appointment date
 * @param delay - Delay in minutes (optional)
 * @returns Formatted "arrive by" time string (e.g., "09:05 AM" or "09:15 AM" if delayed)
 */
export const getArriveByTime = (appointmentTime: string, appointmentDate: Date, delay?: number): string => {
  const actualAppointmentDateTime = getActualAppointmentTime(appointmentTime, appointmentDate, delay);
  const arriveByDateTime = subMinutes(actualAppointmentDateTime, 15);
  return getClinicTimeString(arriveByDateTime);
};

/**
 * Calculate and format the "arrive by" time from an Appointment object
 * @param appointment - The appointment object
 * @param doctor - Optional doctor object to calculate break offsets
 * @returns Formatted "arrive by" time string
 */
export const getArriveByTimeFromAppointment = (appointment: Appointment, doctor?: Doctor | null): string => {
  try {
    const appointmentDate = parse(appointment.date, "d MMMM yyyy", new Date());
    const isWalkIn = appointment.tokenNumber?.startsWith('W');

    if (appointment.arriveByTime) {
      const arriveTime = parse(appointment.arriveByTime, "hh:mm a", appointmentDate);
      // arriveByTime is stored as RAW slot time in the backend. 
      // Advance appointments ('A') show reporting time (Slot - 15m).
      // Walk-in appointments ('W') show the actual predicted time (no deduction).
      const displayTime = isWalkIn ? arriveTime : subMinutes(arriveTime, 15);
      return getClinicTimeString(displayTime);
    }

    const appointmentTime = parseTime(appointment.time, appointmentDate);
    // Fallback: Use 'time' field if arriveByTime is missing.
    // Advance appointments ('A') show reporting time (Slot - 15m).
    // Walk-in appointments ('W') show the actual predicted time (no deduction).
    const displayTime = isWalkIn ? appointmentTime : subMinutes(appointmentTime, 15);
    return getClinicTimeString(displayTime);
  } catch {
    if (appointment.arriveByTime) {
      return appointment.arriveByTime;
    }
    return appointment.time;
  }
};

/**
 * Get display time for appointment (time + break offsets, for display only)
 * @param appointment - The appointment object
 * @param doctor - Optional doctor object to calculate break offsets
 * @returns Formatted time string with break offsets applied
 */
export const getDisplayTimeFromAppointment = (appointment: Appointment, doctor?: Doctor | null): string => {
  try {
    const appointmentDate = parse(appointment.date, "d MMMM yyyy", new Date());
    const appointmentTime = parseTime(appointment.time, appointmentDate);
    // time is already shifted by shared-core.
    return appointment.time;
  } catch {
    return appointment.time;
  }
};

export const parseAppointmentDateTime = (dateStr: string, timeStr: string): Date => {
  // Assuming dateStr is "d MMMM yyyy" and timeStr is "hh:mm a"
  try {
    const date = parse(dateStr, "d MMMM yyyy", new Date());
    const [time, modifier] = timeStr.split(' ');
    let [hours, minutes] = time.split(':').map(Number);
    if (modifier && modifier.toUpperCase() === 'PM' && hours < 12) {
      hours += 12;
    }
    if (modifier && modifier.toUpperCase() === 'AM' && hours === 12) {
      hours = 0;
    }
    return set(date, { hours, minutes, seconds: 0, milliseconds: 0 });

  } catch (e) {
    console.error("Failed to parse date/time", { dateStr, timeStr, e });
    // Fallback to a clearly invalid date to avoid silent errors
    return new Date(0);
  }
};


export const isWithinBookingWindow = (doctor: Doctor, tokenDistribution: 'classic' | 'advanced' = 'advanced'): boolean => {
  const now = getClinicNow();
  const todayStr = getClinicDayOfWeek(now);
  const todaysAvailability = doctor.availabilitySlots?.find(slot => slot.day === todayStr);

  if (!todaysAvailability || !todaysAvailability.timeSlots.length) {
    return false;
  }

  const isClassic = tokenDistribution === 'classic';

  // Get session ranges
  const sessions = todaysAvailability.timeSlots.map((session, index) => {
    const start = parseTime(session.from, now);
    const end = getSessionEnd(doctor, now, index) || parseTime(session.to, now);
    return { start, end };
  });

  const firstSession = sessions[0];
  const lastSession = sessions[sessions.length - 1];

  // 1. RULE: Session 0 is always open if Classic.
  if (isClassic && isBefore(now, firstSession.end)) {
    return true;
  }

  // 2. STICKY / LIBERATED RULE
  // If Classic, we allow booking as long as we are within the unified active session logic.
  // Since this utility is a simple boolean guard, we check if ANY session is active.
  const anySessionActive = sessions.some((session, index) => {
    const isS0 = index === 0;

    // Start Window
    const startWindow = (isClassic && isS0) ? set(now, { hours: 0, minutes: 0 }) : subMinutes(session.start, 30);

    // End Window (with sticky logic)
    let endWindow = subMinutes(session.end, 15);
    if (isClassic) {
      // If Classic, we allow "Force Book" past the end if doctor is IN or appts exist.
      // But for this simple utility, we'll just check if it's before the next session's fail-safe.
      const nextSession = sessions[index + 1];
      if (nextSession) {
        endWindow = subMinutes(nextSession.start, 30); // Fail-safe window
      } else {
        endWindow = addMinutes(session.end, 240); // 4 hours past end for last session
      }
    }

    return !isBefore(now, startWindow) && !isAfter(now, endWindow);
  });

  if (anySessionActive) return true;

  // Fallback to strict interval for Advanced
  if (!isClassic) {
    const walkInWindowStart = subMinutes(firstSession.start, 30);
    const walkInWindowEnd = subMinutes(lastSession.end, 15);
    return isWithinInterval(now, { start: walkInWindowStart, end: walkInWindowEnd });
  }

  return false;
};

// Re-export shared-core break helpers for compatibility with PatientForm in shared-ui
export const buildBreakIntervals = (doctor: Doctor | null, referenceDate: Date | null) => {
  if (!doctor || !referenceDate) return [];
  // Standardize on the shared-core implementation
  return buildBreakIntervalsFromPeriods(doctor, referenceDate);
};


/**
 * Calculate distance between two points in meters using Haversine formula
 */
export const calculateDistance = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
  const R = 6371e3; // Earth radius in meters
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;

  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) *
    Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
};
