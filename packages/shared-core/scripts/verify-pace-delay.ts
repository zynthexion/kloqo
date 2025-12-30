import { format, parse, addMinutes, subMinutes, differenceInMinutes, isBefore, isAfter } from 'date-fns';

// Mock types
type BreakInterval = { start: Date; end: Date };
type Doctor = {
    name: string;
    consultationStatus: 'In' | 'Out';
    averageConsultingTime: number;
    availabilitySlots: any[];
    breakPeriods: any;
};

// Paste the logic from the hook
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

function calculateDoctorDelay(
    doctor: Doctor,
    now: Date,
    completedCount: number = 0
): { delayMinutes: number; availabilityStartTime: Date | null } {
    const currentDay = format(now, 'EEEE');
    const todaysAvailability = doctor.availabilitySlots?.find(
        slot => slot.day.toLowerCase() === currentDay.toLowerCase()
    );

    if (!todaysAvailability || !todaysAvailability.timeSlots?.length) {
        return { delayMinutes: 0, availabilityStartTime: null };
    }

    const firstSession = todaysAvailability.timeSlots[0];
    let baseAvailabilityStartTime: Date;
    try {
        baseAvailabilityStartTime = parseTime(firstSession.from, now);
    } catch (error) {
        return { delayMinutes: 0, availabilityStartTime: null };
    }

    // Mock buildBreakIntervals logic for testing
    const breakIntervals: BreakInterval[] = [];
    const dateKey = format(now, 'd MMMM yyyy');
    const breaksForDay = doctor.breakPeriods[dateKey] || [];
    for (const b of breaksForDay) {
        breakIntervals.push({
            start: new Date(b.startTime),
            end: new Date(b.endTime)
        });
    }

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

    if (isBefore(now, effectiveStartTime)) {
        return { delayMinutes: 0, availabilityStartTime: effectiveStartTime };
    }

    const passedBreakMinutes = breakIntervals.reduce((total, interval) => {
        if (isAfter(interval.start, effectiveStartTime) || interval.start.getTime() === effectiveStartTime.getTime()) {
            if (isBefore(interval.start, now)) {
                const breakEnd = isBefore(interval.end, now) ? interval.end : now;
                return total + Math.max(0, differenceInMinutes(breakEnd, interval.start));
            }
        }
        return total;
    }, 0);

    let delayMinutes = 0;
    if (doctor.consultationStatus !== 'In') {
        delayMinutes = differenceInMinutes(now, effectiveStartTime);
    } else {
        const avgTime = doctor.averageConsultingTime || 5;
        const expectedWorkMinutes = completedCount * avgTime;
        const actualElapsedMinutes = differenceInMinutes(now, effectiveStartTime);
        delayMinutes = actualElapsedMinutes - expectedWorkMinutes - passedBreakMinutes;
    }

    return {
        delayMinutes: Math.max(0, delayMinutes),
        availabilityStartTime: effectiveStartTime
    };
}

// TEST SUITE
const runTests = () => {
    const today = new Date();
    const todayStr = format(today, 'd MMMM yyyy');
    const doctorMock: Doctor = {
        name: 'Dr. Test',
        consultationStatus: 'Out',
        averageConsultingTime: 5,
        availabilitySlots: [{ day: format(today, 'EEEE'), timeSlots: [{ from: '10:00 AM', to: '01:00 PM' }] }],
        breakPeriods: {
            [todayStr]: [
                { startTime: parseTime('10:20 AM', today).toISOString(), endTime: parseTime('10:35 AM', today).toISOString() }
            ]
        }
    };

    console.log("--- TEST 1: Doctor is late to start (Out) ---");
    const test1Now = parseTime('10:15 AM', today);
    const res1 = calculateDoctorDelay(doctorMock, test1Now, 0);
    console.log(`Now: 10:15, Completed: 0, Status: Out -> Delay: ${res1.delayMinutes}m (Expect 15)`);

    console.log("\n--- TEST 2: Doctor started, but is slow (In) ---");
    doctorMock.consultationStatus = 'In';
    const test2Now = parseTime('10:15 AM', today);
    const res2 = calculateDoctorDelay(doctorMock, test2Now, 0);
    console.log(`Now: 10:15, Completed: 0, Status: In -> Delay: ${res2.delayMinutes}m (Expect 15 - they are 15 mins behind original schedule)`);

    const res2b = calculateDoctorDelay(doctorMock, test2Now, 2);
    console.log(`Now: 10:15, Completed: 2, Status: In -> Delay: ${res2b.delayMinutes}m (Expect 5 - they did 10m work in 15m)`);

    console.log("\n--- TEST 3: Break Awareness ---");
    const test3Now = parseTime('10:45 AM', today);
    // Elapsed: 45 mins. Work expected (at 0 completions): 0. Break: 15 mins.
    // Lateness phase: 45m - 0 (work) - 15 (break) = 30m delay.
    const res3 = calculateDoctorDelay(doctorMock, test3Now, 0);
    console.log(`Now: 10:45, Completed: 0, Status: In -> Delay: ${res3.delayMinutes}m (Expect 30)`);

    // Elapsed: 45. Work (4 patients * 5m = 20m). Break (15m).
    // 45 - 20 - 15 = 10m delay.
    const res3b = calculateDoctorDelay(doctorMock, test3Now, 4);
    console.log(`Now: 10:45, Completed: 4, Status: In -> Delay: ${res3b.delayMinutes}m (Expect 10)`);

    console.log("\n--- TEST 4: Catching Up (Clamping) ---");
    // At 10:45, they've done 6 patients (30m work). 
    // 45 - 30 - 15 = 0m delay.
    const res4 = calculateDoctorDelay(doctorMock, test3Now, 6);
    console.log(`Now: 10:45, Completed: 6, Status: In -> Delay: ${res4.delayMinutes}m (Expect 0)`);

    // Even if ahead (7 patients = 35m work)
    const res4b = calculateDoctorDelay(doctorMock, test3Now, 7);
    console.log(`Now: 10:45, Completed: 7, Status: In -> Delay: ${res4b.delayMinutes}m (Expect 0, no negative)`);
};

runTests();
