
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { serviceAccount } from './service-account'; // Assuming this exists or I'll use default creds if environment is set up
import { format, parse, differenceInMinutes, addMinutes, isBefore, isAfter, parseISO } from 'date-fns';

// Initialize Firebase Admin
if (!getApps().length) {
    initializeApp({
        credential: cert(serviceAccount)
    });
}

const db = getFirestore();

// --- Copied Helpers ---

function parseTime(timeStr: string, referenceDate: Date): Date {
    try {
        return parse(timeStr, 'hh:mm a', referenceDate);
    } catch {
        const [hours, minutes] = timeStr.split(':').map(Number);
        const date = new Date(referenceDate);
        date.setHours(hours, minutes, 0, 0);
        return date;
    }
}

type BreakInterval = {
    start: Date;
    end: Date;
};

function buildBreakIntervals(doctor: any, referenceDate: Date): BreakInterval[] {
    if (!doctor?.breakPeriods || !referenceDate) return [];

    const dateKey = format(referenceDate, 'd MMMM yyyy');
    const isoDateKey = format(referenceDate, 'yyyy-MM-dd');
    const shortDateKey = format(referenceDate, 'd MMM yyyy');

    const breaksForDay = doctor.breakPeriods[dateKey] || doctor.breakPeriods[isoDateKey] || doctor.breakPeriods[shortDateKey];

    if (!breaksForDay || !Array.isArray(breaksForDay)) return [];

    const intervals: BreakInterval[] = [];

    for (const breakPeriod of breaksForDay) {
        try {
            const breakStart = typeof breakPeriod.startTime === 'string'
                ? parseISO(breakPeriod.startTime)
                : new Date(breakPeriod.startTime);
            const breakEnd = typeof breakPeriod.endTime === 'string'
                ? parseISO(breakPeriod.endTime)
                : new Date(breakPeriod.endTime);

            if (!isNaN(breakStart.getTime()) && !isNaN(breakEnd.getTime())) {
                intervals.push({ start: breakStart, end: breakEnd });
            }
        } catch (error) {
            console.warn('Error parsing break period:', error);
        }
    }
    return intervals;
}

function calculateDoctorDelay(
    doctor: any,
    now: Date,
    sessionIndex: number,
    completedCount: number
) {
    const currentDay = format(now, 'EEEE');
    // Check availability slots structure
    let todaysAvailability;
    if (Array.isArray(doctor.availabilitySlots)) {
        todaysAvailability = doctor.availabilitySlots.find(
            (slot: any) => slot.day.toLowerCase() === currentDay.toLowerCase()
        );
    } else if (doctor.availability && doctor.availability[currentDay]) {
        // Fallback/Legacy structure support if needed
        todaysAvailability = { timeSlots: doctor.availability[currentDay] };
    }

    if (!todaysAvailability || !todaysAvailability.timeSlots?.length) {
        console.log("No availability for today");
        return { delayMinutes: 0 };
    }

    const currentSession = todaysAvailability.timeSlots[sessionIndex];
    if (!currentSession) {
        console.log("No session found at index", sessionIndex);
        return { delayMinutes: 0 };
    }

    console.log(`Session: ${JSON.stringify(currentSession)}`);

    let baseAvailabilityStartTime;
    try {
        baseAvailabilityStartTime = parseTime(currentSession.from, now);
    } catch (error) {
        return { delayMinutes: 0 };
    }

    console.log(`Base Start Time: ${format(baseAvailabilityStartTime, 'hh:mm a')}`);

    const breakIntervals = buildBreakIntervals(doctor, now);
    console.log(`Break Intervals: ${JSON.stringify(breakIntervals.map(b => ({ start: format(b.start, 'hh:mm a'), end: format(b.end, 'hh:mm a') })))}`);

    let effectiveStartTime = baseAvailabilityStartTime;
    const initialBreaks = breakIntervals.filter(interval =>
        interval.start.getTime() <= baseAvailabilityStartTime.getTime() + 60000
    );

    if (initialBreaks.length > 0) {
        const latestInitialBreakEnd = initialBreaks.reduce((latest, interval) =>
            interval.end.getTime() > latest.getTime() ? interval.end : latest,
            initialBreaks[0].end
        );
        effectiveStartTime = latestInitialBreakEnd;
    }

    console.log(`Effective Start Time: ${format(effectiveStartTime, 'hh:mm a')}`);

    if (isBefore(now, effectiveStartTime)) {
        console.log("Current time before effective start time");
        return { delayMinutes: 0 };
    }

    const passedBreakMinutes = breakIntervals.reduce((total, interval) => {
        if (isAfter(interval.start, effectiveStartTime) || interval.start.getTime() === effectiveStartTime.getTime()) {
            if (isBefore(interval.start, now)) {
                const breakEnd = isBefore(interval.end, now) ? interval.end : now;
                const duration = Math.max(0, differenceInMinutes(breakEnd, interval.start));
                console.log(`Break passed: ${format(interval.start, 'hh:mm a')} - ${format(breakEnd, 'hh:mm a')} (${duration} mins)`);
                return total + duration;
            }
        }
        return total;
    }, 0);

    console.log(`Total Passed Break Minutes: ${passedBreakMinutes}`);

    let delayMinutes = 0;

    if (doctor.consultationStatus !== 'In') {
        delayMinutes = differenceInMinutes(now, effectiveStartTime);
        console.log(`Doctor Status: ${doctor.consultationStatus} (Late Start Calculation)`);
    } else {
        // Pace Delay
        const avgTime = doctor.averageConsultingTime || 5;
        const expectedWorkMinutes = completedCount * avgTime;
        const actualElapsedMinutes = differenceInMinutes(now, effectiveStartTime);

        console.log(`Doctor Status: In (Pace Calculation)`);
        console.log(`Avg Time: ${avgTime}`);
        console.log(`Completed: ${completedCount}`);
        console.log(`Expected Work: ${expectedWorkMinutes} mins`);
        console.log(`Actual Elapsed: ${actualElapsedMinutes} mins (${format(effectiveStartTime, 'hh:mm a')} to ${format(now, 'hh:mm a')})`);

        delayMinutes = actualElapsedMinutes - expectedWorkMinutes - passedBreakMinutes;
    }

    console.log(`Calculated Delay: ${delayMinutes} mins`);
    return { delayMinutes: Math.max(0, delayMinutes) };
}

// --- Main Execution ---

async function run() {
    const doctorId = "doc-1766066333627-yjug38zsr"; // Jino Devasia
    const clinicId = "LhfG8x4SZZg1BLmCkpYF";
    const todayStr = "11 January 2026";
    const sessionIndex = 0;

    console.log(`Fetching doctor ${doctorId}...`);
    const doctorSnap = await db.collection('doctors').doc(doctorId).get();
    if (!doctorSnap.exists) { console.log("Doctor not found"); return; }
    const doctor = doctorSnap.data();

    console.log(`Fetching appointments for ${todayStr}...`);
    const snapshot = await db.collection('appointments')
        .where('clinicId', '==', clinicId)
        .where('doctor', '==', doctor.name)
        .where('date', '==', todayStr)
        .where('sessionIndex', '==', sessionIndex)
        .where('status', '==', 'Completed')
        .get();

    const completedCount = snapshot.size;
    console.log(`Completed Count: ${completedCount}`);

    // Need to filter out appointments cancelled by break manually if query didn't do it?
    // UseAppointmentStatusUpdater code:
    // where('status', '==', 'Completed')
    // It simply counts ALL completed.

    // Note: Your appointments.json showed "cancelledByBreak": true.
    // Code counts ALL completed appointments.
    // Does "cancelledByBreak" appointments count towards work done?
    // A "cancelledByBreak" appointment was effectively Skipped/Cancelled but marked Completed?
    // If `cancelledByBreak` is true, duration was 0?

    // Let's inspect the completed docs to see if we should exclude them
    let validCompletedCount = 0;
    snapshot.docs.forEach(d => {
        const data = d.data();
        if (data.cancelledByBreak) {
            console.log(`Skipping appointment ${d.id} (cancelledByBreak)`);
        } else if (data.patientId === 'dummy-break-patient') {
            console.log(`Skipping appointment ${d.id} (dummy break)`);
        } else {
            validCompletedCount++;
        }
    });

    // The original code in hook simply does: 
    // where('status', '==', 'Completed')
    // const completedCount = completedSnapshot.size;

    // IF the original code includes "cancelledByBreak" appointments as "Work Done",
    // then expectedWorkMinutes will be huge!
    // 5 cancelled appointments = 25 minutes of expected work.
    // But they took 0 time.

    console.log(`Raw Completed Count (from DB): ${completedCount}`);
    console.log(`Valid Completed Count (excluding breaks/cancelled): ${validCompletedCount}`);

    // WE MUST USE THE SAME LOGIC AS THE APP TO REPRODUCE THE ISSUE.
    // The app uses `completedSnapshot.size` with `status == Completed`.
    // It does NOT appear to filter `cancelledByBreak` or `dummy-break-patient`.
    // Wait, `dummy-break-patient` has status `Completed`.
    // `cancelledByBreak` has status `Completed`.

    // If the app counts them, "Expected Work" is inflated.
    // Expected Work = (6 + 5 + 1) * 5 = 60 minutes.
    // Actual Elapsed = 38 minutes.
    // Delay = 38 - 60 - 0 = -22 minutes.
    // Result = 0 delay.

    // THIS IS LIKELY THE BUG.

    console.log("\n--- Scenario 1: Using Raw Count (Current App Logic?) ---");
    calculateDoctorDelay(doctor, new Date(), sessionIndex, completedCount);

    console.log("\n--- Scenario 2: Using Valid Count (Proposed Fix?) ---");
    calculateDoctorDelay(doctor, new Date(), sessionIndex, validCompletedCount);

}

run().catch(console.error);
