import { format } from 'date-fns';

/**
 * Returns the current time as if it were in the Asia/Kolkata timezone,
 * regardless of the server's local timezone.
 * Useful for consistent scheduling logic on server-side (Next.js API routes).
 */
export function getClinicNow(): Date {
    const now = new Date();
    const istString = now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
    return new Date(istString);
}

/**
 * Returns the day of the week (e.g., "Monday") for a given date in the Asia/Kolkata timezone.
 */
export function getClinicDayOfWeek(date: Date = new Date()): string {
    return new Intl.DateTimeFormat('en-US', {
        weekday: 'long',
        timeZone: 'Asia/Kolkata'
    }).format(date);
}

/**
 * Returns the date string (e.g., "d MMMM yyyy") in the Asia/Kolkata timezone.
 */
export function getClinicDateString(date: Date = new Date()): string {
    const options: Intl.DateTimeFormatOptions = {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'Asia/Kolkata'
    };

    // Intl format "22 December 2025" or similar depending on locale
    // To match "d MMMM yyyy" exactly:
    const parts = new Intl.DateTimeFormat('en-GB', options).formatToParts(date);
    const day = parts.find(p => p.type === 'day')?.value;
    const month = parts.find(p => p.type === 'month')?.value;
    const year = parts.find(p => p.type === 'year')?.value;

    return `${day} ${month} ${year}`;
}

/**
 * Returns the time string (e.g., "02:30 PM") in the Asia/Kolkata timezone.
 */
export function getClinicTimeString(date: Date = new Date()): string {
    const options: Intl.DateTimeFormatOptions = {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
        timeZone: 'Asia/Kolkata'
    };

    const parts = new Intl.DateTimeFormat('en-US', options).formatToParts(date);
    const hour = parts.find(p => p.type === 'hour')?.value;
    const minute = parts.find(p => p.type === 'minute')?.value;
    const dayPeriod = parts.find(p => p.type === 'dayPeriod')?.value;

    return `${hour}:${minute} ${dayPeriod}`;
}

/**
 * Returns the ISO date string (e.g., "2025-12-30") in the Asia/Kolkata timezone.
 */
export function getClinicISOString(date: Date = new Date()): string {
    const options: Intl.DateTimeFormatOptions = {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        timeZone: 'Asia/Kolkata'
    };

    const parts = new Intl.DateTimeFormat('en-GB', options).formatToParts(date);
    const day = parts.find(p => p.type === 'day')?.value;
    const month = parts.find(p => p.type === 'month')?.value;
    const year = parts.find(p => p.type === 'year')?.value;

    return `${year}-${month}-${day}`;
}

/**
 * Returns the 24-hour time string (e.g., "14:30") in the Asia/Kolkata timezone.
 */
export function getClinic24hTimeString(date: Date = new Date()): string {
    const options: Intl.DateTimeFormatOptions = {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: 'Asia/Kolkata'
    };

    const parts = new Intl.DateTimeFormat('en-GB', options).formatToParts(date);
    const hour = parts.find(p => p.type === 'hour')?.value;
    const minute = parts.find(p => p.type === 'minute')?.value;

    return `${hour}:${minute}`;
}

/**
 * Returns the short date string (e.g., "12 Dec 2025") in the Asia/Kolkata timezone.
 */
export function getClinicShortDateString(date: Date = new Date()): string {
    const options: Intl.DateTimeFormatOptions = {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: 'Asia/Kolkata'
    };

    const parts = new Intl.DateTimeFormat('en-GB', options).formatToParts(date);
    const day = parts.find(p => p.type === 'day')?.value;
    const month = parts.find(p => p.type === 'month')?.value;
    const year = parts.find(p => p.type === 'year')?.value;

    return `${day} ${month} ${year}`;
}



