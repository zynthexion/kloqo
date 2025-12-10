import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import { parse, isBefore as isBeforeFns } from 'date-fns';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function parseTime(timeString: string, referenceDate: Date): Date {
    return parse(timeString, 'hh:mm a', referenceDate);
}

export function isTimeBefore(time1: Date, time2: Date): boolean {
    return isBeforeFns(time1, time2);
}
