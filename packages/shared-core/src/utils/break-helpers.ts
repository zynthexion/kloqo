/**
 * Session-Based Break Management Helpers
 * 
 * This module provides utilities for managing multiple breaks per session,
 * calculating session extensions, and handling break-related appointment adjustments.
 */

import { format, parse, addMinutes, subMinutes, differenceInMinutes, isAfter, isBefore, parseISO, isSameDay, isSameMinute } from 'date-fns';
import type { Doctor, BreakPeriod, AvailabilitySlot, Appointment } from '@kloqo/shared-types';
import { getClinicDateString, getClinicDayOfWeek, getClinicTimeString, getClinicISOString, getClinicNow, getClinicShortDateString } from './date-utils';

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

export interface SessionInfo {
  sessionIndex: number;
  session: { from: string; to: string };
  sessionStart: Date;
  sessionEnd: Date;
  breaks: BreakPeriod[];
  totalBreakMinutes: number;
  effectiveEnd: Date;  // including breaks
  originalEnd: Date;
}

export interface SlotInfo {
  time: Date;
  timeFormatted: string;
  isoString: string;
  isAvailable: boolean;
  isTaken: boolean;
  isBlocked?: boolean; // True if slot is blocked by an appointment but not in a breakPeriod
  sessionIndex: number;
}

export interface BreakValidationResult {
  valid: boolean;
  error?: string;
}

// ============================================================================
// HELPER: Parse Time Utility
// ============================================================================

export function parseTime(timeStr: string, referenceDate: Date): Date {
  const localParsed = parse(timeStr, 'hh:mm a', referenceDate);

  try {
    // Extract components from the local interpretation
    const hours = localParsed.getHours();
    const minutes = localParsed.getMinutes();

    // Get the year, month, day in IST for the reference date
    const dayFormatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const parts = dayFormatter.formatToParts(referenceDate);
    const y = parts.find(p => p.type === 'year')?.value;
    const m = parts.find(p => p.type === 'month')?.value;
    const d = parts.find(p => p.type === 'day')?.value;

    // Construct a standard IST ISO string and parse it
    // This ensures the resulting Date object represents the CORRECT absolute UTC moment
    const isoStr = `${y}-${m}-${d}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00+05:30`;
    const finalDate = new Date(isoStr);

    return isNaN(finalDate.getTime()) ? localParsed : finalDate;
  } catch (err) {
    return localParsed;
  }
}

// ============================================================================
// 1. GET SESSION BREAKS
// ============================================================================

/**
 * Retrieves all breaks for a specific session on a given date
 */
export function getSessionBreaks(
  doctor: Doctor | null,
  date: Date,
  sessionIndex: number
): BreakPeriod[] {
  if (!doctor?.breakPeriods) return [];

  const dateKey = getClinicDateString(date);
  const allBreaks = doctor.breakPeriods[dateKey] || [];

  return allBreaks.filter(bp => bp.sessionIndex === sessionIndex);
}

// ============================================================================
// 2. MERGE ADJACENT BREAKS
// ============================================================================

/**
 * Merges adjacent break slots into continuous periods
 * @example [9:15-9:30, 9:30-9:45] → [9:15-9:45]
 */
export function mergeAdjacentBreaks(breaks: BreakPeriod[]): BreakPeriod[] {
  if (breaks.length <= 1) return breaks;

  // Sort by start time
  const sorted = [...breaks].sort((a, b) =>
    new Date(a.startTime).getTime() - new Date(b.startTime).getTime()
  );

  const merged: BreakPeriod[] = [];
  let current = { ...sorted[0] };

  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i];
    const currentEnd = new Date(current.endTime);
    const nextStart = new Date(next.startTime);

    // Check if adjacent (current end === next start)
    if (currentEnd.getTime() === nextStart.getTime()) {
      // Merge: extend current to include next
      current = {
        ...current,
        endTime: next.endTime,
        endTimeFormatted: next.endTimeFormatted,
        duration: current.duration + next.duration,
        slots: [...current.slots, ...next.slots],
        id: `${current.id}_merged_${next.id}`, // New merged ID
      };
    } else {
      // Not adjacent, push current and start new
      merged.push(current);
      current = { ...next };
    }
  }

  // Push the last one
  merged.push(current);

  return merged;
}

// ============================================================================
// 3. VALIDATE BREAK SLOTS
// ============================================================================

/**
 * Validates new break doesn't overlap with existing breaks
 * Returns validation result and error message if invalid
 */
export function validateBreakSlots(
  newBreakSlots: string[],  // ISO timestamps
  existingBreaks: BreakPeriod[],
  sessionIndex: number,
  sessionStart: Date,
  sessionEnd: Date
): BreakValidationResult {
  if (newBreakSlots.length === 0) {
    return { valid: false, error: 'No slots selected for break' };
  }

  // Check: max 3 breaks per session
  if (existingBreaks.length >= 3) {
    return { valid: false, error: 'Maximum 3 breaks per session allowed' };
  }

  // Sort new slots
  const sortedNewSlots = newBreakSlots.map(s => parseISO(s)).sort((a, b) => a.getTime() - b.getTime());
  const newStart = sortedNewSlots[0];
  const newEnd = sortedNewSlots[sortedNewSlots.length - 1];

  // Check: slots are within session bounds
  if (isBefore(newStart, sessionStart) || isAfter(newEnd, sessionEnd)) {
    return { valid: false, error: 'Break slots must be within session time' };
  }

  // Check: no overlap with existing breaks
  for (const existingBreak of existingBreaks) {
    const existingStart = parseISO(existingBreak.startTime);
    const existingEnd = parseISO(existingBreak.endTime);

    // Check if new break overlaps with existing
    const overlaps = (
      (newStart >= existingStart && newStart < existingEnd) ||
      (newEnd > existingStart && newEnd <= existingEnd) ||
      (newStart <= existingStart && newEnd >= existingEnd)
    );

    if (overlaps) {
      return {
        valid: false,
        error: `Break overlaps with existing break (${existingBreak.startTimeFormatted} - ${existingBreak.endTimeFormatted})`
      };
    }
  }

  return { valid: true };
}

// ============================================================================
// 4. CALCULATE SESSION EXTENSION
// ============================================================================

/**
 * Calculates total extension needed for session breaks
 */
export function calculateSessionExtension(
  sessionIndex: number,
  breaks: BreakPeriod[],
  originalSessionEnd: Date,
  appointments?: Appointment[],
  doctor?: Doctor | null,
  referenceDate?: Date
): {
  totalBreakMinutes: number;
  actualExtensionNeeded: number;
  newSessionEnd: Date;
  formattedNewEnd: string;
} {
  const totalBreakMinutes = breaks.reduce((sum, bp) => sum + bp.duration, 0);

  // Default behavior if appointments not provided: extend by full break duration
  if (!appointments || !doctor || !referenceDate) {
    const newEnd = addMinutes(originalSessionEnd, totalBreakMinutes);
    return {
      totalBreakMinutes,
      actualExtensionNeeded: totalBreakMinutes,
      newSessionEnd: newEnd,
      formattedNewEnd: getClinicTimeString(newEnd)
    };
  }

  // Calculate actual extension needed based on gap absorption
  const slotDuration = doctor.averageConsultingTime || 15;
  const dateStr = getClinicDateString(referenceDate);

  // Filter appointments for this session and date
  const sessionAppointments = appointments.filter(apt =>
    apt.date === dateStr &&
    apt.sessionIndex === sessionIndex &&
    apt.status !== 'Cancelled' &&
    !apt.cancelledByBreak
  );

  // Build a map of which slot indices have appointments
  const occupiedSlots = new Set<number>();
  sessionAppointments.forEach(apt => {
    if (typeof apt.slotIndex === 'number') {
      occupiedSlots.add(apt.slotIndex);
    }
  });

  // Calculate which break slots actually need shifting
  let actualShiftCount = 0;

  // Get all slot indices covered by breaks
  const breakSlotIndices = new Set<number>();
  const dayOfWeek = getClinicDayOfWeek(referenceDate);
  const availabilityForDay = doctor.availabilitySlots?.find(slot => slot.day === dayOfWeek);

  if (availabilityForDay?.timeSlots?.[sessionIndex]) {
    const session = availabilityForDay.timeSlots[sessionIndex];
    const sessionStart = parseTime(session.from, referenceDate);

    breaks.forEach(bp => {
      const breakStart = parseISO(bp.startTime);
      const breakEnd = parseISO(bp.endTime);
      const breakDuration = differenceInMinutes(breakEnd, breakStart);
      const slotsInBreak = breakDuration / slotDuration;

      const breakStartSlotIndex = Math.floor(
        differenceInMinutes(breakStart, sessionStart) / slotDuration
      );

      for (let i = 0; i < slotsInBreak; i++) {
        breakSlotIndices.add(breakStartSlotIndex + i);
      }
    });

    // Count how many break slots have active appointments
    breakSlotIndices.forEach(slotIndex => {
      if (occupiedSlots.has(slotIndex)) {
        actualShiftCount++;
      }
    });
  }

  const actualExtensionNeeded = actualShiftCount * slotDuration;
  const newEnd = addMinutes(originalSessionEnd, actualExtensionNeeded);

  return {
    totalBreakMinutes,
    actualExtensionNeeded,
    newSessionEnd: newEnd,
    formattedNewEnd: getClinicTimeString(newEnd)
  };
}


// ============================================================================
// 5. GET CURRENT ACTIVE SESSION
// ============================================================================

/**
 * Determines which session is currently active or upcoming
 * @returns Session info with index, times, and break details, or null if none
 */
export function getCurrentActiveSession(
  doctor: Doctor | null,
  now: Date,
  referenceDate: Date
): SessionInfo | null {
  if (!doctor?.availabilitySlots?.length) return null;

  const dayOfWeek = getClinicDayOfWeek(referenceDate);
  const availabilityForDay = doctor.availabilitySlots.find(slot => slot.day === dayOfWeek);

  if (!availabilityForDay || !availabilityForDay.timeSlots?.length) {
    console.log('[BreakHelpers] getCurrentActiveSession: No availability for day', dayOfWeek);
    return null;
  }

  const sessions = availabilityForDay.timeSlots;
  console.log('[BreakHelpers] getCurrentActiveSession: Checking sessions', sessions.length);

  // Check each session to find active or next upcoming
  for (let i = 0; i < sessions.length; i++) {
    const session = sessions[i];
    const sessionStart = parseTime(session.from, referenceDate);
    const sessionEnd = parseTime(session.to, referenceDate);

    // Get breaks for this session
    const breaks = getSessionBreaks(doctor, referenceDate, i);

    // Check for stored extension (respects user's choice to extend or not)
    const dateKey = getClinicDateString(referenceDate);
    const storedExtension = doctor.availabilityExtensions?.[dateKey]?.sessions?.find(
      (s: any) => s.sessionIndex === i
    );

    let effectiveEnd: Date;
    let totalBreakMinutes: number;
    if (storedExtension) {
      totalBreakMinutes = breaks.reduce((sum, bp) => sum + bp.duration, 0);
      // Only extend if user explicitly chose to extend (totalExtendedBy > 0)
      effectiveEnd = storedExtension.totalExtendedBy > 0
        ? addMinutes(sessionEnd, storedExtension.totalExtendedBy)
        : sessionEnd;
    } else {
      // No stored extension - don't auto-extend
      totalBreakMinutes = breaks.reduce((sum, bp) => sum + bp.duration, 0);
      effectiveEnd = sessionEnd;
    }

    // Walk-in window: 30 min before start to 15 min before effective end
    const walkInStart = subMinutes(sessionStart, 30);
    const walkInEnd = subMinutes(effectiveEnd, 15);

    // Check if now is within walk-in window OR force booking window (last 15 minutes)
    // Force booking window: between walkInEnd and effectiveEnd
    if ((now >= walkInStart && now <= walkInEnd) || (now > walkInEnd && now <= effectiveEnd)) {
      return {
        sessionIndex: i,
        session,
        sessionStart,
        sessionEnd,
        breaks,
        totalBreakMinutes,
        effectiveEnd,
        originalEnd: sessionEnd
      };
    }
  }

  // If no active session, return next upcoming session
  for (let i = 0; i < sessions.length; i++) {
    const session = sessions[i];
    const sessionStart = parseTime(session.from, referenceDate);
    const sessionEnd = parseTime(session.to, referenceDate);

    if (isAfter(sessionStart, now)) {
      const breaks = getSessionBreaks(doctor, referenceDate, i);

      // Check for stored extension (respects user's choice to extend or not)
      const dateKey = getClinicDateString(referenceDate);
      const storedExtension = doctor.availabilityExtensions?.[dateKey]?.sessions?.find(
        (s: any) => Number(s.sessionIndex) === i
      );

      let effectiveEnd: Date;
      let totalBreakMinutes: number;
      if (storedExtension) {
        totalBreakMinutes = breaks.reduce((sum, bp) => sum + bp.duration, 0);
        // Only extend if user explicitly chose to extend (totalExtendedBy > 0)
        effectiveEnd = storedExtension.totalExtendedBy > 0
          ? addMinutes(sessionEnd, storedExtension.totalExtendedBy)
          : sessionEnd;
      } else {
        // No stored extension - don't auto-extend
        totalBreakMinutes = breaks.reduce((sum, bp) => sum + bp.duration, 0);
        effectiveEnd = sessionEnd;
      }

      return {
        sessionIndex: i,
        session,
        sessionStart,
        sessionEnd,
        breaks,
        totalBreakMinutes,
        effectiveEnd,
        originalEnd: sessionEnd
      };
    }
  }

  return null;
}

// ============================================================================
// 6. GET AVAILABLE BREAK SLOTS
// ============================================================================

/**
 * Returns slots available for break selection
 * Shows: remaining current session + all upcoming sessions
 * @param currentSessionOverride - Optional session to use instead of getting active session
 */
export function getAvailableBreakSlots(
  doctor: Doctor | null,
  now: Date,
  referenceDate: Date,
  currentSessionOverride?: SessionInfo | null,
  appointments?: Appointment[],
  doctorStatus: 'In' | 'Out' = 'Out'
): {
  currentSessionSlots: SlotInfo[];
  upcomingSessionSlots: Map<number, SlotInfo[]>;
} {
  const result = {
    currentSessionSlots: [] as SlotInfo[],
    upcomingSessionSlots: new Map<number, SlotInfo[]>()
  };

  if (!doctor?.availabilitySlots?.length) return result;

  const currentSession = currentSessionOverride ?? getCurrentActiveSession(doctor, now, referenceDate);
  console.log('[BreakHelpers] getAvailableBreakSlots: currentSession detection', {
    index: currentSession?.sessionIndex,
    isOverride: !!currentSessionOverride
  });
  if (!currentSession) return result;

  const dayOfWeek = getClinicDayOfWeek(referenceDate);
  const availabilityForDay = doctor.availabilitySlots.find(slot => slot.day === dayOfWeek);
  if (!availabilityForDay) return result;

  const slotDuration = doctor.averageConsultingTime || 15;

  // Check if we are generating slots for today
  const isTodayDate = isSameDay(referenceDate, now);

  // Generate slots for current session (from session start, showing all slots)
  const currentBreaks = currentSession.breaks;
  const takenSlots = new Set(currentBreaks.flatMap(b => b.slots));

  // Start from session start, not current time, to show all slot times in slot format
  let currentTime = new Date(currentSession.sessionStart);
  // FIX: Use effectiveEnd (which includes extensions) instead of original sessionEnd
  const currentEndTime = currentSession.effectiveEnd;

  while (currentTime < currentEndTime) {
    // If it's today, only add slots that start in the future (or now)
    if (!isTodayDate || isAfter(currentTime, now) || Math.abs(differenceInMinutes(currentTime, now)) < 1) {
      const isoString = currentTime.toISOString();
      let isTaken = takenSlots.has(isoString);

      let isBlocked = false;
      if (!isTaken && appointments) {
        const referenceDateStr = getClinicDateString(referenceDate);
        const appointmentAtSlot = appointments.find(apt =>
          (apt.status === 'Completed') &&
          (apt.date === referenceDateStr) &&
          apt.time === getClinicTimeString(currentTime)
        );

        if (appointmentAtSlot) {
          // If doctor is 'In', we ignore blocked dummy appointments for the ACTIVE break only
          const isDummy = appointmentAtSlot.patientId === 'dummy-break-patient' || (appointmentAtSlot as any).cancelledByBreak;

          if (isDummy && doctorStatus === 'In') {
            // Find if this slot falls within an active break period
            const breakForSlot = doctor?.breakPeriods?.[referenceDateStr]?.find(bp => {
              const start = new Date(bp.startTime);
              const end = new Date(bp.endTime);
              return currentTime.getTime() >= start.getTime() && currentTime.getTime() < end.getTime();
            });

            // Is THIS specific break active right now?
            const isBreakCurrentlyActive = breakForSlot &&
              now.getTime() >= new Date(breakForSlot.startTime).getTime() &&
              now.getTime() < new Date(breakForSlot.endTime).getTime();

            if (isBreakCurrentlyActive) {
              isBlocked = false;
            } else {
              isBlocked = true;
            }
          } else {
            isBlocked = true;
          }
        }
      }

      result.currentSessionSlots.push({
        time: new Date(currentTime),
        timeFormatted: getClinicTimeString(currentTime),
        isoString,
        isAvailable: !isTaken && !isBlocked,
        isTaken,
        isBlocked,
        sessionIndex: currentSession.sessionIndex
      });
    }

    currentTime = addMinutes(currentTime, slotDuration);
  }

  // Generate slots for upcoming sessions
  for (let i = currentSession.sessionIndex + 1; i < availabilityForDay.timeSlots.length; i++) {
    const session = availabilityForDay.timeSlots[i];
    const sessionStart = parseTime(session.from, referenceDate);
    // FIX: Use getSessionEnd to account for extensions in upcoming sessions
    const sessionEnd = getSessionEnd(doctor, referenceDate, i) || parseTime(session.to, referenceDate);
    const sessionBreaks = getSessionBreaks(doctor, referenceDate, i);
    const takenSlotsForSession = new Set(sessionBreaks.flatMap(b => b.slots));

    const sessionSlots: SlotInfo[] = [];
    let slotTime = new Date(sessionStart);

    while (slotTime < sessionEnd) {
      // If it's today, only add slots that start in the future
      if (!isTodayDate || isAfter(slotTime, now)) {
        const isoString = slotTime.toISOString();
        let isTaken = takenSlotsForSession.has(isoString);

        let isBlocked = false;
        // Also check against appointments if provided
        if (!isTaken && appointments) {
          const referenceDateStr = getClinicDateString(referenceDate);
          const appointmentAtSlot = appointments.find(apt =>
            (apt.status === 'Completed') &&
            (apt.date === referenceDateStr) &&
            apt.time === getClinicTimeString(slotTime)
          );

          if (appointmentAtSlot) {
            const isDummy = appointmentAtSlot.patientId === 'dummy-break-patient' || (appointmentAtSlot as any).cancelledByBreak;
            if (isDummy && doctorStatus === 'In') {
              const breakForSlot = doctor?.breakPeriods?.[referenceDateStr]?.find(bp => {
                const start = new Date(bp.startTime);
                const end = new Date(bp.endTime);
                return slotTime.getTime() >= start.getTime() && slotTime.getTime() < end.getTime();
              });

              const isBreakCurrentlyActive = breakForSlot &&
                now.getTime() >= new Date(breakForSlot.startTime).getTime() &&
                now.getTime() < new Date(breakForSlot.endTime).getTime();

              if (isBreakCurrentlyActive) {
                isBlocked = false;
              } else {
                isBlocked = true;
              }
            } else {
              isBlocked = true;
            }
          }
        }

        sessionSlots.push({
          time: new Date(slotTime),
          timeFormatted: getClinicTimeString(slotTime),
          isoString,
          isAvailable: !isTaken && !isBlocked,
          isTaken,
          isBlocked,
          sessionIndex: i
        });
      }

      slotTime = addMinutes(slotTime, slotDuration);
    }

    if (sessionSlots.length > 0) {
      result.upcomingSessionSlots.set(i, sessionSlots);
    }
  }

  return result;
}

// ============================================================================
// 7. GET SESSION END (replaces getAvailabilityEndForDate)
// ============================================================================

/**
 * Gets effective end time for a specific session
 * Accounts for session-specific extensions
 */
export function getSessionEnd(
  doctor: Doctor | null,
  date: Date,
  sessionIndex: number
): Date | null {
  if (!doctor?.availabilitySlots?.length) return null;

  const dayOfWeek = getClinicDayOfWeek(date);
  const availabilityForDay = doctor.availabilitySlots.find(slot => slot.day === dayOfWeek);

  if (!availabilityForDay || !availabilityForDay.timeSlots?.length) return null;
  if (sessionIndex >= availabilityForDay.timeSlots.length) return null;

  const session = availabilityForDay.timeSlots[sessionIndex];
  let sessionEnd = parseTime(session.to, date);

  // Check for extensions
  const dateKey = getClinicDateString(date);
  const extensions = doctor.availabilityExtensions?.[dateKey];

  if (extensions?.sessions) {
    const sessionExtension = extensions.sessions.find((s: any) => Number(s.sessionIndex) === sessionIndex);
    // Only extend if totalExtendedBy > 0 (user explicitly chose to extend)
    if (sessionExtension && sessionExtension.totalExtendedBy > 0 && sessionExtension.newEndTime) {
      try {
        const extendedEnd = parseTime(sessionExtension.newEndTime, date);
        if (extendedEnd.getTime() > sessionEnd.getTime()) {
          sessionEnd = extendedEnd;
        }
      } catch {
        // Ignore malformed extension
      }
    }
  }

  return sessionEnd;
}

// ============================================================================
// 8. CREATE BREAK PERIOD
// ============================================================================

/**
 * Creates a BreakPeriod object from selected slots
 */
export function createBreakPeriod(
  slots: string[],  // ISO timestamps
  sessionIndex: number,
  slotDuration: number
): BreakPeriod {
  const sortedSlots = slots.map(s => parseISO(s)).sort((a, b) => a.getTime() - b.getTime());
  const start = sortedSlots[0];
  const lastSlot = sortedSlots[sortedSlots.length - 1];
  const end = addMinutes(lastSlot, slotDuration);

  const duration = differenceInMinutes(end, start);

  return {
    id: `break-${start.getTime()}`,
    startTime: start.toISOString(),
    endTime: end.toISOString(),
    startTimeFormatted: getClinicTimeString(start),
    endTimeFormatted: getClinicTimeString(end),
    duration,
    sessionIndex,
    slots
  };
}

// ============================================================================
// 9. BUILD BREAK INTERVALS (for offset calculations)
// ============================================================================

export type BreakInterval = {
  start: Date;
  end: Date;
  sessionIndex: number;
};

/**
 * Builds break intervals from doctor's break periods for a specific date
 * Used for appointment time offset calculations
 */
export function buildBreakIntervalsFromPeriods(
  doctor: Doctor | null,
  referenceDate: Date
): BreakInterval[] {
  if (!doctor?.breakPeriods) return [];

  const dateKey = getClinicDateString(referenceDate);
  const breaks = doctor.breakPeriods[dateKey] || [];

  return breaks.map((bp: BreakPeriod) => ({
    start: parseISO(bp.startTime),
    end: parseISO(bp.endTime),
    sessionIndex: bp.sessionIndex
  })).sort((a: BreakInterval, b: BreakInterval) => a.start.getTime() - b.start.getTime());
}

/**
 * Gets break intervals for a specific session only
 * Used for session-based appointment time offset calculations
 */
export function getSessionBreakIntervals(
  doctor: Doctor | null,
  referenceDate: Date,
  sessionIndex: number
): BreakInterval[] {
  const allIntervals = buildBreakIntervalsFromPeriods(doctor, referenceDate);
  return allIntervals.filter(interval => interval.sessionIndex === sessionIndex);
}

// ============================================================================
// 10. APPLY BREAK OFFSETS
// ============================================================================

/**
 * Applies break time offsets to an appointment time
 * Adds break duration if appointment time >= break start
 */
export function applyBreakOffsets(originalTime: Date, intervals: BreakInterval[]): Date {
  return intervals.reduce((acc, interval) => {
    if (acc.getTime() >= interval.start.getTime()) {
      const offset = differenceInMinutes(interval.end, interval.start);
      return addMinutes(acc, offset);
    }
    return acc;
  }, new Date(originalTime));
}

// ============================================================================
// CHECK IF WITHIN 15 MINUTES OF CLOSING
// ============================================================================

/**
 * Checks if current time is within 15 minutes of doctor's last session end time
 * @param doctor Doctor profile with availability slots
 * @param date Date to check (uses current time if today, otherwise returns false)
 * @returns true if within 15 minutes of closing time
 */
export function isWithin15MinutesOfClosing(
  doctor: Doctor | null,
  date: Date
): boolean {
  if (!doctor?.availabilitySlots?.length) return false;

  const now = getClinicNow();
  const dateStr = getClinicISOString(date);
  const todayStr = getClinicISOString(now);

  // Only check for today - future dates don't have closing time restrictions
  if (dateStr !== todayStr) return false;

  // Get day of week
  const dayOfWeek = getClinicDayOfWeek(date);
  const availabilityForDay = doctor.availabilitySlots.find(slot => slot.day === dayOfWeek);

  if (!availabilityForDay?.timeSlots?.length) return false;

  // Get last session end time
  const lastSession = availabilityForDay.timeSlots[availabilityForDay.timeSlots.length - 1];
  const lastSessionEndTime = parseTime(lastSession.to, date);

  // Check if we're within 15 minutes of closing
  const fifteenMinutesBeforeClosing = subMinutes(lastSessionEndTime, 15);

  return isAfter(now, fifteenMinutesBeforeClosing) && isBefore(now, lastSessionEndTime);
}


/**
 * Checks if a specific slot time is blocked by a scheduled break or leave
 */
export function isSlotBlockedByLeave(doctor: Doctor, slotTime: Date): boolean {
  if (!doctor) return false;

  const dateStr = getClinicDateString(slotTime);
  const isoDateStr = getClinicISOString(slotTime);
  const shortDateStr = getClinicShortDateString(slotTime);

  // Only check breakPeriods (Primary Source of Truth)
  if (doctor.breakPeriods) {
    let breaks = doctor.breakPeriods[dateStr] || doctor.breakPeriods[isoDateStr] || doctor.breakPeriods[shortDateStr];

    if (breaks) {
      return breaks.some(breakPeriod => {
        try {
          // Method 1: Explicit slots list
          if (breakPeriod.slots && Array.isArray(breakPeriod.slots)) {
            const isExplicitlyListed = breakPeriod.slots.some(s => {
              const sDate = typeof s === 'string' ? parseISO(s) : new Date(s);
              return isSameMinute(sDate, slotTime);
            });
            if (isExplicitlyListed) return true;
          }

          // Method 2: Range check
          const breakStart = typeof breakPeriod.startTime === 'string' ? parseISO(breakPeriod.startTime) : new Date(breakPeriod.startTime);
          const breakEnd = typeof breakPeriod.endTime === 'string' ? parseISO(breakPeriod.endTime) : new Date(breakPeriod.endTime);

          const slotDuration = doctor.averageConsultingTime || 15;
          const slotEnd = addMinutes(slotTime, slotDuration);

          // Check overlap
          const isBlocked = isBefore(slotTime, breakEnd) && isAfter(slotEnd, breakStart);
          return isBlocked;
        } catch (error) {
          return false;
        }
      });
    }
  }

  return false;
}


