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
