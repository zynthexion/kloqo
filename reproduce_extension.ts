
import { parse, addMinutes, differenceInMinutes, parseISO } from 'date-fns';

// ============================================================================
// INLINED LOGIC FROM break-helpers.ts
// ============================================================================

function getClinicDateString(date: Date): string {
    const dayFormatter = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
    });
    return dayFormatter.format(date);
}

function getClinicDayOfWeek(date: Date): string {
    const dayFormatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Kolkata',
        weekday: 'long',
    });
    return dayFormatter.format(date);
}

function getClinicTimeString(date: Date): string {
    const timeFormatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Kolkata',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
    });
    return timeFormatter.format(date);
}

function parseTime(timeStr: string, referenceDate: Date): Date {
    const localParsed = parse(timeStr, 'hh:mm a', referenceDate);
    try {
        const hours = localParsed.getHours();
        const minutes = localParsed.getMinutes();
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
        const isoStr = `${y}-${m}-${d}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00+05:30`;
        const finalDate = new Date(isoStr);
        return isNaN(finalDate.getTime()) ? localParsed : finalDate;
    } catch (err) {
        return localParsed;
    }
}

// THE FUNCTION WE ARE TESTING
function calculateSessionExtension(
    sessionIndex: number,
    breaks: any[],
    originalSessionEnd: Date,
    appointments: any[] | undefined,
    doctor: any | null,
    referenceDate: Date | undefined
): any {
    const totalBreakMinutes = breaks.reduce((sum, bp) => sum + bp.duration, 0);

    if (!appointments || !doctor || !referenceDate) {
        const newEnd = addMinutes(originalSessionEnd, totalBreakMinutes);
        return {
            totalBreakMinutes,
            actualExtensionNeeded: totalBreakMinutes,
            newSessionEnd: newEnd,
            formattedNewEnd: getClinicTimeString(newEnd)
        };
    }

    const slotDuration = doctor.averageConsultingTime || 15;
    const dateStr = getClinicDateString(referenceDate);

    const sessionAppointments = appointments.filter(apt =>
        apt.date === dateStr &&
        apt.sessionIndex === sessionIndex &&
        apt.status !== 'Cancelled' &&
        !apt.cancelledByBreak
    );

    const occupiedSlots = new Set<number>();
    sessionAppointments.forEach(apt => {
        if (typeof apt.slotIndex === 'number') {
            occupiedSlots.add(apt.slotIndex);
        }
    });

    let actualShiftCount = 0;
    const breakSlotIndices = new Set<number>();
    const dayOfWeek = getClinicDayOfWeek(referenceDate);
    const availabilityForDay = doctor.availabilitySlots?.find((slot: any) => slot.day === dayOfWeek);

    if (availabilityForDay?.timeSlots?.[sessionIndex]) {
        const session = availabilityForDay.timeSlots[sessionIndex];
        const sessionStart = parseTime(session.from, referenceDate);

        // HERE IS THE POTENTIAL BUG: 
        // It iterates ALL breaks provided without filtering for sessionIndex again?
        // The calling code handles filtering, but we passed bad data.
        breaks.forEach(bp => {
            const breakStart = parseISO(bp.startTime);
            const breakEnd = parseISO(bp.endTime);
            const breakDuration = differenceInMinutes(breakEnd, breakStart);
            const slotsInBreak = breakDuration / slotDuration;

            // DIFFERENCE CALCULATION
            // Session Start: 3:00 PM (15:00)
            // Break Start: 12:30 PM (12:30)
            // Diff: -150 minutes
            // Slot Index: -150 / 5 = -30

            const sessionStartMin = differenceInMinutes(breakStart, sessionStart);

            console.log(`Debug - Break: ${bp.startTimeFormatted} to ${bp.endTimeFormatted}`);
            console.log(`Debug - Session Start: ${session.from} (${sessionStart.toISOString()})`);
            console.log(`Debug - Break Start: ${bp.startTime} (${breakStart.toISOString()})`);
            console.log(`Debug - Diff (mins): ${sessionStartMin}`);

            const breakStartSlotIndex = Math.floor(
                sessionStartMin / slotDuration
            );

            console.log(`Debug - Start Slot Index: ${breakStartSlotIndex}`);

            for (let i = 0; i < slotsInBreak; i++) {
                breakSlotIndices.add(breakStartSlotIndex + i);
            }
        });

        // IF negative indices are added, what happens?
        console.log(`Debug - Break Slot Indices:`, Array.from(breakSlotIndices));

        breakSlotIndices.forEach(slotIndex => {
            if (occupiedSlots.has(slotIndex)) {
                actualShiftCount++;
            }
        });
    }

    // IF NO APPOINTMENTS (appointments array empty in our test)
    // occupiedSlots is empty.
    // actualShiftCount is 0.
    // actualExtensionNeeded = 0.

    // WAIT. The function returns early if appointments are missing!
    // In the real app, appointments ARE passed.
    // And the user said "manually opened the first 4 slots".
    // This means appointments existed or slots were marked 'Completed' (blocked).

    // The user said: "manually opened the first 4 slots".
    // This implies they deleted the 'BreakBlock' appointments or similar?
    // Let's assume we simulate having appointments or empty slots.

    // If we simulate with appointments=[] passed to function...
    // The first block executes:
    // if (!appointments || !doctor || !referenceDate) -> Returns full duration extension.
    // 30 mins.

    // WE NEED TO PASS EMPTY ARRAY for appointments to trigger the complex logic?
    // No, if appointments is [], sessionAppointments is []. occupiedSlots is empty.
    // actualShiftCount is 0.
    // Extension = 0.

    // BUT the user sees 165 minutes.
    // This implies actualShiftCount was around 33 (33 * 5 = 165).
    // Why 33? 
    // Maybe it counts slots from 12:30 to 3:00?
    // 12:30 to 3:00 is 2.5 hours = 150 mins = 30 slots.
    // Plus break duration 30 mins = 6 slots.
    // Total 36 slots?

    // If the logic iterates through ALL slots between BreakStart and BreakEnd,
    // knowing BreakStart is -150 mins away...
    // breakSlotIndices adds indices -30, -29, ... -25.

    // If 'occupiedSlots' has these indices...
    // Why would Session 1 appointments have negative slot indices? They wouldn't.

    // WAIT.
    // What if the break was somehow interpreted as starting at 12:30 PM but RELATIVE to something else?

    const actualExtensionNeeded = actualShiftCount * slotDuration;
    const newEnd = addMinutes(originalSessionEnd, actualExtensionNeeded);

    return {
        totalBreakMinutes,
        actualExtensionNeeded,
        newSessionEnd: newEnd,
        formattedNewEnd: getClinicTimeString(newEnd)
    };
}

// TEST EXECUTION
const mockDoctor = {
    averageConsultingTime: 5,
    availabilitySlots: [
        {
            day: 'Friday',
            timeSlots: [
                { from: '12:00 PM', to: '01:00 PM' }, // Session 0
                { from: '03:00 PM', to: '04:00 PM' }  // Session 1
            ]
        }
    ]
};

const referenceDate = new Date('2026-01-16T12:00:00.000Z');
const sessionIndex = 1;
const originalSessionEnd = new Date('2026-01-16T10:30:00.000Z'); // 4:00 PM

// WRONG BREAK (Session 0 break passed to Session 1)
const corruptedBreaks = [
    {
        id: "break-1768546800000",
        startTime: "2026-01-16T07:00:00.000Z", // 12:30 PM
        endTime: "2026-01-16T07:30:00.000Z",   // 01:00 PM
        startTimeFormatted: "12:30 PM",
        endTimeFormatted: "01:00 PM",
        duration: 30,
        sessionIndex: 0,
        slots: []
    }
];

// Let's simulate that 'appointments' argument is NOT undefined, but empty array array
// This triggers the complex logic path.
console.log("--- Test Case 1: Empty Appointments Array (Complex Logic) ---");
const result1 = calculateSessionExtension(
    sessionIndex,
    corruptedBreaks,
    originalSessionEnd,
    [],
    mockDoctor,
    referenceDate
);
console.log("Result 1:", JSON.stringify(result1, null, 2));


// LIMITATION: 'actualShimftCount' relies on 'occupiedSlots'.
// If occupiedSlots is empty, count is 0.
// We need to explain 165.
// 165 / 5 = 33 slots.
// Maybe the user has ACTUAL appointments in slots 0, 1, 2, 3? 
// User said "manually opened the first 4 slots".
// This implies they probably have valid appointments or available slots there.

// What if the logic assumes slots are sequential?

// Let's verify what happens if we pass NULL appointments (Simple Logic)
console.log("--- Test Case 2: Null Appointments (Simple Logic) ---");
const result2 = calculateSessionExtension(
    sessionIndex,
    corruptedBreaks,
    originalSessionEnd,
    undefined,
    mockDoctor,
    referenceDate
);
console.log("Result 2:", JSON.stringify(result2, null, 2));
// Simple logic just adds break duration (30). 
// 30 != 165.

// So it MUST be the complex logic.
// But complex logic yields 0 if passed breaks don't overlap with occupied slots.
// UNLESS 'occupiedSlots' somehow got populated with -30 range? No.

// What if 'slotDuration' is wrong? No, 5 is confirmed.
// What if 'differenceInMinutes' behaves weirdly?

console.log("--- End Test ---");
