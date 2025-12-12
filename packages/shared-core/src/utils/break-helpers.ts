/**
 * Session-Based Break Management Helpers
 * 
 * This module provides utilities for managing multiple breaks per session,
 * calculating session extensions, and handling break-related appointment adjustments.
 */

import { format, parse, addMinutes, subMinutes, differenceInMinutes, isAfter, isBefore, parseISO, isSameDay } from 'date-fns';
import type { Doctor, BreakPeriod, AvailabilitySlot } from '@kloqo/shared-types';

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
  if (!timeStr || typeof timeStr !== 'string' || timeStr.trim() === '') {
    throw new Error(`Invalid time string: "${timeStr}"`);
  }
  try {
    return parse(timeStr, 'hh:mm a', referenceDate);
  } catch (error) {
    throw new Error(`Failed to parse time "${timeStr}": ${error}`);
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

  const dateKey = format(date, 'd MMMM yyyy');
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
  originalSessionEnd: Date
): {
  totalBreakMinutes: number;
  newSessionEnd: Date;
  formattedNewEnd: string;
} {
  const totalMinutes = breaks.reduce((sum, bp) => sum + bp.duration, 0);
  const newEnd = addMinutes(originalSessionEnd, totalMinutes);

  return {
    totalBreakMinutes: totalMinutes,
    newSessionEnd: newEnd,
    formattedNewEnd: format(newEnd, 'hh:mm a')
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

  const dayOfWeek = format(referenceDate, 'EEEE');
  const availabilityForDay = doctor.availabilitySlots.find(slot => slot.day === dayOfWeek);

  if (!availabilityForDay || !availabilityForDay.timeSlots?.length) return null;

  const sessions = availabilityForDay.timeSlots;

  // Check each session to find active or next upcoming
  for (let i = 0; i < sessions.length; i++) {
    const session = sessions[i];
    const sessionStart = parseTime(session.from, referenceDate);
    const sessionEnd = parseTime(session.to, referenceDate);

    // Get breaks for this session
    const breaks = getSessionBreaks(doctor, referenceDate, i);

    // Check for stored extension (respects user's choice to extend or not)
    const dateKey = format(referenceDate, 'd MMMM yyyy');
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

    // Check if now is within walk-in window
    if (now >= walkInStart && now <= walkInEnd) {
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
      const dateKey = format(referenceDate, 'd MMMM yyyy');
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
  currentSessionOverride?: SessionInfo | null
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
  if (!currentSession) return result;

  const dayOfWeek = format(referenceDate, 'EEEE');
  const availabilityForDay = doctor.availabilitySlots.find(slot => slot.day === dayOfWeek);
  if (!availabilityForDay) return result;

  const slotDuration = doctor.averageConsultingTime || 15;

  // Generate slots for current session (from session start, showing all slots)
  const currentBreaks = currentSession.breaks;
  const takenSlots = new Set(currentBreaks.flatMap(b => b.slots));

  // Start from session start, not current time, to show all slot times in slot format
  let currentTime = new Date(currentSession.sessionStart);
  const currentEndTime = currentSession.sessionEnd;

  while (currentTime < currentEndTime) {
    const isoString = currentTime.toISOString();
    const isTaken = takenSlots.has(isoString);

    result.currentSessionSlots.push({
      time: new Date(currentTime),
      timeFormatted: format(currentTime, 'hh:mm a'),
      isoString,
      isAvailable: !isTaken,
      isTaken,
      sessionIndex: currentSession.sessionIndex
    });

    currentTime = addMinutes(currentTime, slotDuration);
  }

  // Generate slots for upcoming sessions
  for (let i = currentSession.sessionIndex + 1; i < availabilityForDay.timeSlots.length; i++) {
    const session = availabilityForDay.timeSlots[i];
    const sessionStart = parseTime(session.from, referenceDate);
    const sessionEnd = parseTime(session.to, referenceDate);
    const sessionBreaks = getSessionBreaks(doctor, referenceDate, i);
    const takenSlotsForSession = new Set(sessionBreaks.flatMap(b => b.slots));

    const sessionSlots: SlotInfo[] = [];
    let slotTime = new Date(sessionStart);

    while (slotTime < sessionEnd) {
      const isoString = slotTime.toISOString();
      const isTaken = takenSlotsForSession.has(isoString);

      sessionSlots.push({
        time: new Date(slotTime),
        timeFormatted: format(slotTime, 'hh:mm a'),
        isoString,
        isAvailable: !isTaken,
        isTaken,
        sessionIndex: i
      });

      slotTime = addMinutes(slotTime, slotDuration);
    }

    result.upcomingSessionSlots.set(i, sessionSlots);
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

  const dayOfWeek = format(date, 'EEEE');
  const availabilityForDay = doctor.availabilitySlots.find(slot => slot.day === dayOfWeek);

  if (!availabilityForDay || !availabilityForDay.timeSlots?.length) return null;
  if (sessionIndex >= availabilityForDay.timeSlots.length) return null;

  const session = availabilityForDay.timeSlots[sessionIndex];
  let sessionEnd = parseTime(session.to, date);

  // Check for extensions
  const dateKey = format(date, 'd MMMM yyyy');
  const extensions = doctor.availabilityExtensions?.[dateKey];

  if (extensions?.sessions) {
    const sessionExtension = extensions.sessions.find((s: any) => s.sessionIndex === sessionIndex);
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
    startTimeFormatted: format(start, 'hh:mm a'),
    endTimeFormatted: format(end, 'hh:mm a'),
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

  const dateKey = format(referenceDate, 'd MMMM yyyy');
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
  if (!doctor?.availabilitySlots?.length) {
    return false;
  }

  const now = new Date();
  const dateStr = format(date, 'yyyy-MM-dd');
  const todayStr = format(now, 'yyyy-MM-dd');

  // Only check for today - future dates don't have closing time restrictions
  if (dateStr !== todayStr) {
    return false;
  }

  // Get day of week
  const dayOfWeek = format(date, 'EEEE');
  const availabilityForDay = doctor.availabilitySlots.find(slot => slot.day === dayOfWeek);

  if (!availabilityForDay?.timeSlots?.length) {
    return false;
  }

  // Get last session end time
  const lastSession = availabilityForDay.timeSlots[availabilityForDay.timeSlots.length - 1];
  const lastSessionEndTime = parseTime(lastSession.to, date);

  // Check if we're within 15 minutes of closing
  const fifteenMinutesBeforeClosing = subMinutes(lastSessionEndTime, 15);

  const result = isAfter(now, fifteenMinutesBeforeClosing) && isBefore(now, lastSessionEndTime);

  return result;
}
