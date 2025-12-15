
import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import { format, parse, set, isBefore, subMinutes } from 'date-fns';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatTime12Hour(timeString24: string): string {
  if (!timeString24) return '';
  if (timeString24.includes('AM') || timeString24.includes('PM')) {
    return timeString24;
  }
  try {
    const [hours, minutes] = timeString24.split(':');
    const date = set(new Date(), { hours: parseInt(hours), minutes: parseInt(minutes) });
    return format(date, 'hh:mm a');
  } catch (e) {
    return '';
  }
}


export function parseAppointmentDateTime(dateStr?: string, timeStr?: string): Date {
  if (!dateStr || !timeStr) return new Date(NaN);

  try {
    const combinedStr = `${dateStr} ${timeStr}`;
    const parsedDate = parse(combinedStr, "d MMMM yyyy hh:mm a", new Date());
    if (!isNaN(parsedDate.getTime())) {
      return parsedDate;
    }
  } catch (e) {
    console.error(`Failed to parse date-time: ${dateStr} ${timeStr}`, e);
    return new Date(NaN);
  }

  return new Date(NaN);
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
      console.warn(`Invalid time format provided to parseTime: "${timeStr}". Using midnight.`);
      return set(baseDate, { hours: 0, minutes: 0, seconds: 0, milliseconds: 0 });
    }
  }

  return set(baseDate, { hours, minutes, seconds: 0, milliseconds: 0 });
}

export function isTimeBefore(date1: Date, date2: Date): boolean {
  return isBefore(date1, date2);
}

/**
 * Get arrive-by time (cutoff time) - appointment time minus 15 minutes
 */
export function getArriveByTime(timeStr: string, date: Date): string {
  try {
    const appointmentTime = parseTime(timeStr, date);
    const arriveByTime = subMinutes(appointmentTime, 15);
    return format(arriveByTime, 'hh:mm a');
  } catch (error) {
    console.error('Error calculating arrive-by time:', error);
    return timeStr; // Fallback to original time
  }
}

