import { Appointment, Doctor, BreakPeriod } from '@kloqo/shared-types';
import { addMinutes, isAfter, isBefore, parse, format } from 'date-fns';
import { getClinicDayOfWeek, parseClinicTime } from './date-utils';
import { getCurrentActiveSession } from './break-helpers';

export interface EstimatedTimeResult {
    appointmentId: string;
    estimatedTime: string; // "hh:mm a"
    isFirst: boolean;
}

/**
 * Calculates estimated consultation times for a list of arrived (confirmed) appointments.
 * Accounts for doctor status (In/Out), availability start, and scheduled breaks.
 */
export function calculateEstimatedTimes(
    appointments: Appointment[],
    doctor: Doctor,
    currentTime: Date,
    averageConsultingTime: number = 15
): EstimatedTimeResult[] {
    if (!appointments.length) return [];

    const dateStr = appointments[0].date;
    const dayOfWeek = getClinicDayOfWeek(currentTime);
    const availabilityForDay = doctor.availabilitySlots?.find(slot => slot.day === dayOfWeek);
    const breaksForDay = doctor.breakPeriods?.[dateStr] || [];

    // 1. Determine the reference start time
    let referenceTime: Date;

    if (doctor.consultationStatus === 'In') {
        referenceTime = new Date(currentTime);
    } else {
        // Doctor is "Out", use the start of the current/upcoming session
        const sessionInfo = getCurrentActiveSession(doctor, currentTime, currentTime);
        if (sessionInfo) {
            referenceTime = sessionInfo.sessionStart;
        } else {
            // Fallback if no active/upcoming session found
            referenceTime = new Date(currentTime);
        }
    }

    // 2. Iterate through appointments and calculate stepping
    const results: EstimatedTimeResult[] = [];
    let runningTime = new Date(referenceTime);

    // Normalize runningTime to minutes (ignore seconds/ms)
    runningTime.setSeconds(0, 0);

    appointments.forEach((appt, index) => {
        // Break Hopping Logic:
        // Before assigning a time to this appointment, check if the current runningTime 
        // falls within any scheduled break.
        let inBreak = true;
        while (inBreak) {
            inBreak = false;
            for (const breakPeriod of breaksForDay) {
                const breakStart = parseClinicTime(breakPeriod.startTimeFormatted, currentTime);
                const breakEnd = parseClinicTime(breakPeriod.endTimeFormatted, currentTime);

                // Sync Break Cancellation: If doctor is 'In' during an active break, skip the jump
                const isActiveBreak = currentTime.getTime() >= breakStart.getTime() && currentTime.getTime() < breakEnd.getTime();
                if (doctor.consultationStatus === 'In' && isActiveBreak) {
                    continue;
                }

                // If runningTime is within [breakStart, breakEnd)
                if (
                    (runningTime.getTime() >= breakStart.getTime() && runningTime.getTime() < breakEnd.getTime()) ||
                    // Also handle the edge case where the appointment *starts* at breakStart
                    (runningTime.getTime() === breakStart.getTime())
                ) {
                    // Push runningTime to the end of the break
                    runningTime = new Date(breakEnd);
                    runningTime.setSeconds(0, 0);
                    inBreak = true; // Re-check if this end matches another break
                    break;
                }
            }
        }

        results.push({
            appointmentId: appt.id,
            estimatedTime: format(runningTime, 'hh:mm a'),
            isFirst: index === 0
        });

        // Increment for the next person
        runningTime = addMinutes(runningTime, averageConsultingTime);
    });

    return results;
}
