import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import { parse, isBefore as isBeforeFns, set, format, subMinutes } from 'date-fns';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function parseTime(timeStr: string, baseDate: Date): Date {
  if (!timeStr) {
    console.warn(`Invalid time string provided to parseTime: "${timeStr}". Using midnight.`);
    return set(baseDate, { hours: 0, minutes: 0, seconds: 0, milliseconds: 0 });
  }

  let hours = 0;
  let minutes = 0;

  const twelveHourMatch = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (twelveHourMatch) {
    hours = parseInt(twelveHourMatch[1], 10);
    minutes = parseInt(twelveHourMatch[2], 10);
    const ampm = twelveHourMatch[3].toUpperCase();
    if (ampm === 'PM' && hours < 12) hours += 12;
    if (ampm === 'AM' && hours === 12) hours = 0; // Midnight case
  } else {
    const twentyFourHourMatch = timeStr.match(/(\d{1,2}):(\d{2})/);
    if (twentyFourHourMatch) {
      hours = parseInt(twentyFourHourMatch[1], 10);
      minutes = parseInt(twentyFourHourMatch[2], 10);
    } else {
      // Try date-fns parse as fallback for other formats
      try {
        const parsed = parse(timeStr, 'hh:mm a', baseDate);
        if (!isNaN(parsed.getTime())) return parsed;
      } catch (e) { }

      console.warn(`Invalid time format provided to parseTime: "${timeStr}". Using midnight.`);
      return set(baseDate, { hours: 0, minutes: 0, seconds: 0, milliseconds: 0 });
    }
  }

  return set(baseDate, { hours, minutes, seconds: 0, milliseconds: 0 });
}

export function isTimeBefore(time1: Date, time2: Date): boolean {
  return isBeforeFns(time1, time2);
}

/**
 * Get display time for appointment - "Arrive by" (-15m) for 'A' tokens, actual time for 'W' tokens
 */
export function getDisplayTime(appt: { time?: string; tokenNumber?: string; bookedVia?: string }): string {
  if (!appt.time) return '';
  try {
    const isWalkIn = appt.tokenNumber?.startsWith('W') || appt.bookedVia === 'Walk-in';
    const date = parse(appt.time, 'hh:mm a', new Date());
    const adjustedTime = isWalkIn ? date : subMinutes(date, 15);
    return format(adjustedTime, 'hh:mm a');
  } catch (error) {
    return appt.time || '';
  }
}
