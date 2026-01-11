
import { format, addMinutes, differenceInMinutes, parse, parseISO } from 'date-fns';

// MOCK DATA derived from appointments.json and user context
const SESSION_START_STR = "05:30 PM"; // Session 1 Start
const SESSION_END_STR = "08:30 PM";   // Session 1 End
const SLOT_DURATION = 15;
const CONSULTATION_TIME = 15;
const SELECTED_DATE = new Date('2026-01-11'); // Today

// Appointments in Session 1 (FILTERED manually or mocked)
// Based on user description: "Session 1 out of 12 slots 10 are filled"
// Let's create a dense schedule to test "gaps absorbed".
// If 10/12 are filled, there ARE 2 gaps.

// Real Data from appointments.json
// Session 1: 5:30 PM to 8:30 PM (17:30 - 20:30)
// Fetching more from previous view...
// I need to ensure I get ALL session 1 appointments.
// The previous view only showed a few.
// I should filter the JSON properly in the script instead of hardcoding.
// Let's modify the script to READ the JSON file.
import * as fs from 'fs';
import * as path from 'path';
const appointments = loadAppointments();

function loadAppointments() {
    const jsonPath = '/Users/jinodevasia/Desktop/Kloqo-Production/appointments.json';
    const data = fs.readFileSync(jsonPath, 'utf-8');
    const allApps = JSON.parse(data);
    return allApps.filter((a: any) => a.sessionIndex === 1 && a.status !== 'Cancelled');
}


// Proposed Break: 6:45 PM to 7:15 PM (30 mins)
const BREAK_START_STR = "06:45 PM";
const BREAK_END_STR = "07:15 PM";

function parseTime(timeStr: string, baseDate: Date): Date {
    return parse(timeStr, 'hh:mm a', baseDate);
}

function runSimulation() {
    console.log("--- STARTING SIMULATION ---");

    const sessionEndOriginal = parseTime(SESSION_END_STR, SELECTED_DATE);
    const breakStart = parseTime(BREAK_START_STR, SELECTED_DATE);
    const breakEnd = parseTime(BREAK_END_STR, SELECTED_DATE);

    const breakStartMs = breakStart.getTime();
    const breakEndMs = breakEnd.getTime();
    const breakDurationMs = breakEndMs - breakStartMs;

    console.log(`Session End: ${format(sessionEndOriginal, 'HH:mm')}`);
    console.log(`Break: ${format(breakStart, 'HH:mm')} - ${format(breakEnd, 'HH:mm')} (${breakDurationMs / 60000} mins)`);

    const sortedApps = appointments.sort((a: any, b: any) => {
        return parseTime(a.time, SELECTED_DATE).getTime() - parseTime(b.time, SELECTED_DATE).getTime();
    });

    let currentVirtualTime = 0;
    let simulatedLastApptEndMs = 0;

    sortedApps.forEach((app: any) => {
        const appStart = parseTime(app.time, SELECTED_DATE).getTime();
        const originalTimeStr = format(new Date(appStart), 'HH:mm');

        // Initialization
        if (currentVirtualTime === 0) currentVirtualTime = appStart;

        // Respect Original Time (don't move earlier)
        let targetStart = Math.max(currentVirtualTime, appStart);

        // Check Break Collision
        if (targetStart >= breakStartMs && targetStart < breakEndMs) {
            // Push to after break
            console.log(`   [Collision] App ${app.patientName} at ${format(new Date(targetStart), 'HH:mm')} collides with break. Moving to ${format(breakEnd, 'HH:mm')}`);
            targetStart = Math.max(targetStart, breakEndMs);
        } else {
            // Not in break, but checking if pushed into break by previous?
            // targetStart is already >= currentVirtualTime.
            // If targetStart jumps over break, we are good.
        }

        const finalStart = new Date(targetStart);
        currentVirtualTime = targetStart + (CONSULTATION_TIME * 60000);
        simulatedLastApptEndMs = currentVirtualTime;

        console.log(`App ${app.patientName} (${originalTimeStr}) -> ${format(finalStart, 'HH:mm')} (End: ${format(new Date(currentVirtualTime), 'HH:mm')})`);
    });

    const lastAppointmentEnd = new Date(simulatedLastApptEndMs);
    const overrunMinutes = Math.max(0, differenceInMinutes(lastAppointmentEnd, sessionEndOriginal));

    console.log("--- RESULT ---");
    console.log(`Last Appointment End: ${format(lastAppointmentEnd, 'HH:mm')}`);
    console.log(`Original Session End: ${format(sessionEndOriginal, 'HH:mm')}`);
    console.log(`Overrun: ${overrunMinutes} minutes`);
}

runSimulation();
