import { Appointment, Doctor, BreakPeriod } from '@kloqo/shared-types';
import { addMinutes, isAfter, isBefore, parse, format, differenceInMinutes } from 'date-fns';
import { getClinicDayOfWeek, parseClinicTime } from './date-utils';
import { getCurrentActiveSession } from './break-helpers';

export interface EstimatedTimeResult {
    appointmentId: string;
    estimatedTime: string; // "hh:mm a"
    isFirst: boolean;
    sessionIndex?: number;
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

    // Check if we have a "Backlog" -> Appointments from a past/active session that are still pending
    // This handles the "Overtime" case where Doctor might be 'Out' or between sessions, 
    // but we want estimates to start from NOW, not jump to the next session.
    const firstActiveAppt = appointments.find(a => a.status === 'Pending' || a.status === 'Confirmed' || a.status === 'Skipped');
    let hasBacklog = false;

    if (firstActiveAppt && availabilityForDay?.timeSlots && typeof firstActiveAppt.sessionIndex === 'number') {
        const session = availabilityForDay.timeSlots[firstActiveAppt.sessionIndex];
        if (session) {
            const sessionStart = parseClinicTime(session.from, currentTime);
            // If the appointment's session has already started (is in the past), 
            // we treat it as backlog/overtime and start estimates from NOW.
            hasBacklog = isBefore(sessionStart, currentTime);
        }
    }

    if (doctor.consultationStatus === 'In' || hasBacklog) {
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

        // Session Jump Logic:
        // Ensure runningTime is within a valid session. If it exceeds the current session,
        // jump to the start of the next session.
        let detectedSessionIndex = 0; // Default to 0 or derive from reference check

        if (availabilityForDay && availabilityForDay.timeSlots) {
            let inSession = false;
            // sort sessions by start time just in case
            const sortedSessions = [...availabilityForDay.timeSlots].map((s, idx) => ({ ...s, originalIdx: idx })).sort((a, b) => {
                const aStart = parseClinicTime(a.from, currentTime);
                const bStart = parseClinicTime(b.from, currentTime);
                return aStart.getTime() - bStart.getTime();
            });

            for (let i = 0; i < sortedSessions.length; i++) {
                const session = sortedSessions[i];
                const sessionStart = parseClinicTime(session.from, currentTime);
                const sessionEnd = parseClinicTime(session.to, currentTime);

                // If runningTime is within this session
                if (runningTime.getTime() >= sessionStart.getTime() && runningTime.getTime() < sessionEnd.getTime()) {
                    inSession = true;
                    detectedSessionIndex = session.originalIdx;
                    break;
                }

                // If runningTime is BEFORE this session (meaning we jumped or started late in prev session)
                if (runningTime.getTime() < sessionStart.getTime()) {
                    // Check gap from previous session end (if applicable)
                    // If we are at session 'i', the previous session is 'i-1'.
                    if (i > 0) {
                        const prevSession = sortedSessions[i - 1];
                        const prevSessionEnd = parseClinicTime(prevSession.to, currentTime);

                        // Gap between prev session end and this session start
                        const totalGap = differenceInMinutes(sessionStart, prevSessionEnd);
                        const remainingGap = differenceInMinutes(sessionStart, runningTime);

                        // LOGIC:
                        // 1. If the Total Gap is small (< 60m), it's a "Spillover" -> Jump immediately.
                        // 2. If the Total Gap is large (>= 60m), it's "Overtime" -> Don't jump yet.
                        // 3. BUT, if we naturally burn through the Overtime and get close to the next session (<= 15m), Jump then.

                        if (totalGap <= 60 || remainingGap <= 15) {
                            // SPILL: Jump to start of this session (or preserve overtime if > start)
                            // If runningTime (overtime) has NOT yet reached the next session start, 
                            // we jump ahead to the start time.
                            // If runningTime is AFTER the start time (because overtime spilled way over), 
                            // we keep runningTime as is.
                            if (runningTime.getTime() < sessionStart.getTime()) {
                                runningTime = new Date(sessionStart);
                                runningTime.setSeconds(0, 0);
                            }
                            // Otherwise, spillover continues naturally
                            inSession = true;
                            detectedSessionIndex = session.originalIdx;
                            break;
                        } else {
                            // LARGE GAP LOGIC (>60m total, >15m remaining):
                            // 1. ABSORPTION: If we are simply running late in the previous session,
                            // AND that session's overtime fits into this gap,
                            // we do NOT jump yet. We let the doctor finish the backlog in the gap.

                            // 2. RESET: If this specific appointment belongs to the NEXT session (i),
                            // and the gap was big enough to finish the backlog,
                            // we should START this appointment at sessionStart, not earlier.
                            // (Controlled by the Critical Fix below)

                            // For now, we behave as "Overtime in Gap"
                            inSession = true;
                            detectedSessionIndex = sortedSessions[i - 1].originalIdx;
                            break;
                        }
                    } else {
                        // First session of the day: always jump to start if early
                        runningTime = new Date(sessionStart);
                        runningTime.setSeconds(0, 0);
                        inSession = true;
                        detectedSessionIndex = session.originalIdx;
                        break;
                    }
                }

                // Overtime in the last session
                if (i === sortedSessions.length - 1 && runningTime.getTime() >= sessionEnd.getTime()) {
                    detectedSessionIndex = session.originalIdx;
                }
            }

            // --- CRITICAL FIX: Session Boundary Enforcement ---
            // If the appointment explicitly belongs to a specific session (e.g. Session 1 starting at 9:30 PM),
            // we MUST ensure the estimated time is at least that session's start time.
            // This prevents "Session 2" appointments from appearing at 8:30 PM just because the backlog ended there.
            if (typeof appt.sessionIndex === 'number' && availabilityForDay?.timeSlots) {
                const targetSession = availabilityForDay.timeSlots[appt.sessionIndex];
                if (targetSession) {
                    const targetStart = parseClinicTime(targetSession.from, currentTime);
                    // If runningTime (e.g. 8:33 PM) is BEFORE the session start (e.g. 9:30 PM),
                    // we jump forward to the session start.
                    if (isBefore(runningTime, targetStart)) {
                        runningTime = new Date(targetStart);
                        runningTime.setSeconds(0, 0);
                        detectedSessionIndex = appt.sessionIndex;
                    }
                }
            }

            // Logic to CLAMP runningTime to NOW if we are "in session" (or overtime) but lagging behind.
            // This ensures that if we are processing a queue in real-time (e.g. walk-ins), the estimates start from NOW, not in the past.
            // We only do this if we are NOT waiting for a future session start (handled by the jump logic above).
            if (inSession && isBefore(runningTime, currentTime)) {
                runningTime = currentTime;
            }
        }

        results.push({
            appointmentId: appt.id,
            estimatedTime: format(runningTime, 'hh:mm a'),
            isFirst: index === 0,
            sessionIndex: detectedSessionIndex
        });

        // Increment for the next person
        runningTime = addMinutes(runningTime, averageConsultingTime);
    });

    return results;
}
