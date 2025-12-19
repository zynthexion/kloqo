import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import { set, parse, isWithinInterval, isAfter, isBefore, format, subMinutes, addMinutes, differenceInMinutes, parseISO, isSameDay } from "date-fns";
import type { Doctor } from "@/firebase/firestore/use-doctors";
import type { Appointment } from "@/lib/types";

export type BreakInterval = {
  start: Date;
  end: Date;
};

export function buildBreakIntervals(doctor: Doctor | null | undefined, referenceDate: Date | null | undefined): BreakInterval[] {
  if (!doctor?.breakPeriods || !referenceDate) return [];

  const dateKey = format(referenceDate, 'd MMMM yyyy');
  const isoDateKey = format(referenceDate, 'yyyy-MM-dd');
  const shortDateKey = format(referenceDate, 'd MMM yyyy');

  // Try multiple key formats
  const breaksForDay = doctor.breakPeriods[dateKey] || doctor.breakPeriods[isoDateKey] || doctor.breakPeriods[shortDateKey];

  if (!breaksForDay || !Array.isArray(breaksForDay)) {
    return [];
  }

  const intervals: BreakInterval[] = [];

  for (const breakPeriod of breaksForDay) {
    try {
      const breakStart = typeof breakPeriod.startTime === 'string'
        ? parseISO(breakPeriod.startTime)
        : new Date(breakPeriod.startTime);
      const breakEnd = typeof breakPeriod.endTime === 'string'
        ? parseISO(breakPeriod.endTime)
        : new Date(breakPeriod.endTime);

      if (!isNaN(breakStart.getTime()) && !isNaN(breakEnd.getTime())) {
        intervals.push({ start: breakStart, end: breakEnd });
      }
    } catch (error) {
      console.warn('Error parsing break period:', error);
    }
  }

  return intervals;
}

export function applyBreakOffsets(originalTime: Date, intervals: BreakInterval[]): Date {
  return intervals.reduce((acc, interval) => {
    if (acc.getTime() >= interval.start.getTime()) {
      return addMinutes(acc, differenceInMinutes(interval.end, interval.start));
    }
    return acc;
  }, new Date(originalTime));
}

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
  return format(actualTime, 'hh:mm a');
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
  return format(arriveByDateTime, 'hh:mm a');
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
      const arriveDateTime = parse(appointment.arriveByTime, "hh:mm a", appointmentDate);
      // Add break offsets if doctor info is available
      const breakIntervals = doctor ? buildBreakIntervals(doctor, appointmentDate) : [];
      const adjustedArriveDateTime = breakIntervals.length > 0
        ? applyBreakOffsets(arriveDateTime, breakIntervals)
        : arriveDateTime;
      // Don't subtract 15 minutes for walk-in appointments
      const displayTime = isWalkIn ? adjustedArriveDateTime : subMinutes(adjustedArriveDateTime, 15);
      return format(displayTime, 'hh:mm a');
    }
    // For time field, add break offsets if doctor info is available
    const appointmentTime = parseTime(appointment.time, appointmentDate);
    const breakIntervals = doctor ? buildBreakIntervals(doctor, appointmentDate) : [];
    const adjustedAppointmentTime = breakIntervals.length > 0
      ? applyBreakOffsets(appointmentTime, breakIntervals)
      : appointmentTime;
    const actualTime = appointment.delay && appointment.delay > 0
      ? addMinutes(adjustedAppointmentTime, appointment.delay)
      : adjustedAppointmentTime;
    // Don't subtract 15 minutes for walk-in appointments
    const arriveByDateTime = isWalkIn ? actualTime : subMinutes(actualTime, 15);
    return format(arriveByDateTime, 'hh:mm a');
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
    // Add break offsets if doctor info is available
    const breakIntervals = doctor ? buildBreakIntervals(doctor, appointmentDate) : [];
    const adjustedTime = breakIntervals.length > 0
      ? applyBreakOffsets(appointmentTime, breakIntervals)
      : appointmentTime;
    return format(adjustedTime, 'hh:mm a');
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

export const isWithinBookingWindow = (doctor: Doctor): boolean => {
  const now = new Date();
  const todayStr = format(now, 'EEEE');
  const todaysAvailability = doctor.availabilitySlots?.find(slot => slot.day === todayStr);

  if (!todaysAvailability || !todaysAvailability.timeSlots.length) {
    return false;
  }

  // Get first session start time
  const firstSession = todaysAvailability.timeSlots[0];
  const lastSession = todaysAvailability.timeSlots[todaysAvailability.timeSlots.length - 1];
  const firstSessionStart = parseTime(firstSession.from, now);
  const lastSessionStart = parseTime(lastSession.from, now);
  const lastSessionEnd = parseTime(lastSession.to, now);

  // Walk-in opens 30 minutes before the first session starts
  const walkInWindowStart = subMinutes(firstSessionStart, 30);

  // Walk-in closes 15 minutes before consultation end,
  // plus any break duration that falls within the last session window
  const breakIntervals = buildBreakIntervals(doctor, now);
  let breakMinutesInLastSession = 0;
  if (breakIntervals.length > 0) {
    for (const interval of breakIntervals) {
      const overlapStart = interval.start > lastSessionStart ? interval.start : lastSessionStart;
      const overlapEnd = interval.end < lastSessionEnd ? interval.end : lastSessionEnd;
      if (overlapEnd > overlapStart) {
        breakMinutesInLastSession += differenceInMinutes(overlapEnd, overlapStart);
      }
    }
  }
  const walkInWindowEnd = addMinutes(subMinutes(lastSessionEnd, 15), breakMinutesInLastSession);

  return isWithinInterval(now, { start: walkInWindowStart, end: walkInWindowEnd });
};
