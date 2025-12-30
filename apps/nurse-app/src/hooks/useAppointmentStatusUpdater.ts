'use client';

import { useEffect } from 'react';
import { collection, doc, getDoc, writeBatch, where, query, onSnapshot, getDocs, Timestamp } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useAuth } from '@/contexts/AuthContext';
import type { Appointment, Doctor } from '@/lib/types';
import { addMinutes, isAfter, parse, format, subMinutes, differenceInMinutes, isBefore, parseISO, isWithinInterval } from 'date-fns';

function parseAppointmentDateTime(dateStr: string, timeStr: string): Date {
  // This format needs to exactly match how dates/times are stored in Firestore
  return parse(`${dateStr} ${timeStr}`, 'd MMMM yyyy hh:mm a', new Date());
}

// Helper function to parse time string
function parseTime(timeStr: string, referenceDate: Date): Date {
  try {
    return parse(timeStr, 'hh:mm a', referenceDate);
  } catch {
    // Fallback to 24h format
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

// Build break intervals for a given doctor and date
function buildBreakIntervals(doctor: Doctor | null | undefined, referenceDate: Date | null | undefined): BreakInterval[] {
  if (!doctor?.breakPeriods || !referenceDate) {
    return [];
  }

  const dateKey = format(referenceDate, 'd MMMM yyyy');
  const isoDateKey = format(referenceDate, 'yyyy-MM-dd');
  const shortDateKey = format(referenceDate, 'd MMM yyyy');

  // Try multiple key formats
  const breaksForDay = doctor.breakPeriods[dateKey] || doctor.breakPeriods[isoDateKey] || doctor.breakPeriods[shortDateKey];

  if (!breaksForDay || !Array.isArray(breaksForDay)) {
    return [];
  }

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

  console.log(`[Break Intervals] Doctor ${doctor.name}: ${intervals.length} interval(s) for ${format(referenceDate, 'd MMM yyyy')}`);
  return intervals;
}

// Apply break offsets to a given time (shift forward by each completed break)
function applyBreakOffsets(originalTime: Date, intervals: BreakInterval[]): Date {
  return intervals.reduce((acc, interval) => {
    if (acc.getTime() >= interval.start.getTime()) {
      return addMinutes(acc, differenceInMinutes(interval.end, interval.start));
    }
    return acc;
  }, new Date(originalTime));
}

// Check if current time is within any break interval
function isWithinBreak(currentTime: Date, breakIntervals: BreakInterval[]): boolean {
  if (breakIntervals.length === 0) return false;

  return breakIntervals.some(interval => {
    try {
      return isWithinInterval(currentTime, { start: interval.start, end: interval.end });
    } catch {
      return false;
    }
  });
}

// Calculate doctor delay: accounts for both initial lateness and consultation pace
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

  // Get the first session start time
  const firstSession = todaysAvailability.timeSlots[0];
  let baseAvailabilityStartTime: Date;
  try {
    baseAvailabilityStartTime = parseTime(firstSession.from, now);
  } catch (error) {
    console.warn(`Error parsing availability start time for doctor ${doctor.name}:`, error);
    return { delayMinutes: 0, availabilityStartTime: null };
  }

  const breakIntervals = buildBreakIntervals(doctor, now);

  // Find breaks that started at or before session start
  let effectiveStartTime = baseAvailabilityStartTime;
  const initialBreaks = breakIntervals.filter(interval =>
    interval.start.getTime() <= baseAvailabilityStartTime.getTime() + 60000 // within 1 minute
  );

  if (initialBreaks.length > 0) {
    const latestInitialBreakEnd = initialBreaks.reduce((latest, interval) =>
      interval.end.getTime() > latest.getTime() ? interval.end : latest,
      initialBreaks[0].end
    );
    effectiveStartTime = latestInitialBreakEnd;
  }

  // If current time is before session start, no delay
  if (isBefore(now, effectiveStartTime)) {
    return { delayMinutes: 0, availabilityStartTime: effectiveStartTime };
  }

  // Calculate total break duration passed since session start
  const passedBreakMinutes = breakIntervals.reduce((total, interval) => {
    // Only count breaks that happen AFTER the effective session start and have started by NOW
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
    // Phase 1: Doctor Lateness (minutes since start - initial breaks)
    delayMinutes = differenceInMinutes(now, effectiveStartTime);
  } else {
    // Phase 2: Pace Delay (actual elapsed - expected work - passed breaks)
    const avgTime = doctor.averageConsultingTime || 5;
    const expectedWorkMinutes = completedCount * avgTime;
    const actualElapsedMinutes = differenceInMinutes(now, effectiveStartTime);

    // PaceDelay = elapsed - work - breaks
    delayMinutes = actualElapsedMinutes - expectedWorkMinutes - passedBreakMinutes;
  }

  return {
    delayMinutes: Math.max(0, delayMinutes),
    availabilityStartTime: effectiveStartTime
  };
}

// Update appointments with doctor delay: add delay to cutOffTime and noShowTime
// When doctor is not 'In' after consultation start time, delay is calculated and added to all appointments
// Status transitions (Pending → Skipped → No-show) use the delayed cutOffTime/noShowTime
async function updateAppointmentsWithDelay(
  clinicId: string,
  doctorId: string,
  totalDelayMinutes: number,
  doctor?: Doctor
): Promise<void> {
  const today = format(new Date(), 'd MMMM yyyy');
  const appointmentsRef = collection(db, 'appointments');
  const q = query(
    appointmentsRef,
    where('clinicId', '==', clinicId),
    where('doctorId', '==', doctorId),
    where('date', '==', today),
    where('status', 'in', ['Pending', 'Confirmed', 'Skipped'])
  );

  const snapshot = await getDocs(q);
  if (snapshot.empty) return;

  const batch = writeBatch(db);
  let hasWrites = false;
  let updatedCount = 0;

  snapshot.forEach((doc) => {
    const appointment = doc.data() as Appointment;

    try {
      if (!appointment.time || !appointment.date) {
        console.warn(`Appointment ${doc.id} missing time or date, skipping delay update`);
        return;
      }

      // Parse appointment date and time
      const appointmentDate = parse(appointment.date, 'd MMMM yyyy', new Date());
      const appointmentTime = parseTime(appointment.time, appointmentDate);

      // Apply break offsets first, then compute cutOff/noShow and add doctor delay
      const breakIntervals = doctor ? buildBreakIntervals(doctor, appointmentDate) : [];
      const adjustedAppointmentTime = breakIntervals.length > 0
        ? applyBreakOffsets(appointmentTime, breakIntervals)
        : appointmentTime;

      const baseCutOffTime = subMinutes(adjustedAppointmentTime, 15);
      const baseNoShowTime = addMinutes(adjustedAppointmentTime, 15);

      // Add delay to base times (if delay is 0, times remain at break-adjusted base)
      const delayedCutOffTime = addMinutes(baseCutOffTime, totalDelayMinutes);
      const delayedNoShowTime = addMinutes(baseNoShowTime, totalDelayMinutes);

      // Update with delayed times and store delay amount
      const updates: any = {
        cutOffTime: Timestamp.fromDate(delayedCutOffTime),
        noShowTime: Timestamp.fromDate(delayedNoShowTime),
        doctorDelayMinutes: totalDelayMinutes
      };

      batch.update(doc.ref, updates);
      hasWrites = true;
      updatedCount++;

    } catch (error) {
      console.warn(`Error updating appointment ${doc.id} with delay:`, error);
    }
  });

  if (hasWrites) {
    try {
      await batch.commit();
      console.log(`[Delay Update] Updated ${updatedCount} appointments with ${totalDelayMinutes} minute doctor delay (stored separately, original cutOffTime/noShowTime preserved for status transitions)`);
    } catch (error) {
      console.error('Error committing delay updates:', error);
    }
  }
}

export function useAppointmentStatusUpdater() {
  const { user } = useAuth();

  useEffect(() => {
    if (!user) return;

    // This function handles both Pending → Skipped and Skipped → No-show transitions
    const checkAndUpdateStatuses = async (appointments: Appointment[]) => {
      if (appointments.length === 0) return;

      const now = new Date();
      const batch = writeBatch(db);
      let hasWrites = false;

      // Check both Pending and Skipped appointments
      const appointmentsToCheck = appointments.filter(apt =>
        apt.status === 'Pending' || apt.status === 'Skipped'
      );

      for (const apt of appointmentsToCheck) {
        try {
          if (apt.status === 'Pending') {
            // Use stored cutOffTime from Firestore (original, never delayed)
            let cutOffTime: Date;
            if (apt.cutOffTime) {
              // Convert Firestore timestamp to Date
              cutOffTime = apt.cutOffTime instanceof Date
                ? apt.cutOffTime
                : apt.cutOffTime?.toDate
                  ? apt.cutOffTime.toDate()
                  : new Date(apt.cutOffTime);
            } else {
              // Fallback: calculate if not stored (for old appointments)
              const appointmentDate = parse(apt.date, 'd MMMM yyyy', new Date());
              const appointmentTime = parseTime(apt.time, appointmentDate);
              cutOffTime = subMinutes(appointmentTime, 15);
            }

            // Check if current time is greater than stored cutOffTime
            if (isAfter(now, cutOffTime) || now.getTime() >= cutOffTime.getTime()) {
              const aptRef = doc(db, 'appointments', apt.id);
              batch.update(aptRef, {
                status: 'Skipped',
                skippedAt: new Date(),
                updatedAt: new Date()
              });
              hasWrites = true;
              console.log(`Auto-updating appointment ${apt.id} from Pending to Skipped (cutOffTime: ${cutOffTime.toISOString()}, now: ${now.toISOString()})`);
            }
          } else if (apt.status === 'Skipped') {
            // Use stored noShowTime from Firestore (includes doctor delay if any)
            let noShowTime: Date;
            if (apt.noShowTime) {
              // Convert Firestore timestamp to Date
              noShowTime = apt.noShowTime instanceof Date
                ? apt.noShowTime
                : apt.noShowTime?.toDate
                  ? apt.noShowTime.toDate()
                  : new Date(apt.noShowTime);
            } else {
              // Fallback: calculate if not stored (for old appointments)
              const appointmentDate = parse(apt.date, 'd MMMM yyyy', new Date());
              const appointmentTime = parseTime(apt.time, appointmentDate);
              noShowTime = addMinutes(appointmentTime, 15);
            }

            // Check if current time is greater than stored noShowTime
            if (isAfter(now, noShowTime) || now.getTime() >= noShowTime.getTime()) {
              const aptRef = doc(db, 'appointments', apt.id);
              batch.update(aptRef, {
                status: 'No-show',
                updatedAt: new Date()
              });
              hasWrites = true;
              console.log(`Auto-updating appointment ${apt.id} from Skipped to No-show (noShowTime: ${noShowTime.toISOString()}, now: ${now.toISOString()})`);
            }
          }
        } catch (e) {
          // Ignore parsing errors for potentially malformed old data
          console.warn(`Could not process appointment ${apt.id}:`, e);
          continue;
        }
      }

      if (hasWrites) {
        try {
          await batch.commit();
          console.log("Appointment statuses automatically updated.");
        } catch (e) {
          console.error("Error in automatic status update batch:", e);
        }
      }
    };

    // Function to check and update appointment delays based on doctor consultation status
    // Calculates total delay (minutes since consultation start while doctor is not 'In')
    // and applies it to all appointments' cutOffTime and noShowTime
    // This ensures correct delays even if the app was closed and reopened
    // IMPORTANT: Does NOT update if current time is within a break period
    const checkAndUpdateDelays = async (clinicId: string) => {
      try {
        const doctorsRef = collection(db, 'doctors');
        const q = query(doctorsRef, where('clinicId', '==', clinicId));
        const doctorsSnapshot = await getDocs(q);
        const now = new Date();
        const todayStr = format(now, 'd MMMM yyyy');

        for (const doctorDoc of doctorsSnapshot.docs) {
          const doctor = { id: doctorDoc.id, ...doctorDoc.data() } as Doctor;

          // 1. Fetch completed appointments count for today
          const completedQuery = query(
            collection(db, 'appointments'),
            where('clinicId', '==', clinicId),
            where('doctor', '==', doctor.name),
            where('date', '==', todayStr),
            where('status', '==', 'Completed')
          );
          const completedSnapshot = await getDocs(completedQuery);
          const completedCount = completedSnapshot.size;

          // 2. Fetch current stored delay from one active appointment to check threshold
          const activeApptQuery = query(
            collection(db, 'appointments'),
            where('clinicId', '==', clinicId),
            where('doctorId', '==', doctor.id),
            where('date', '==', todayStr),
            where('status', 'in', ['Pending', 'Confirmed', 'Skipped'])
          );
          const activeApptSnapshot = await getDocs(activeApptQuery);
          let currentStoredDelay = 0;
          if (!activeApptSnapshot.empty) {
            currentStoredDelay = activeApptSnapshot.docs[0].data().doctorDelayMinutes || 0;
          }

          const breakIntervals = buildBreakIntervals(doctor, now);
          if (isWithinBreak(now, breakIntervals)) {
            if (currentStoredDelay > 0) {
              console.log(`[Break Protection] Doctor ${doctor.name} is in break period - clearing all delays`);
              await updateAppointmentsWithDelay(clinicId, doctor.id, 0, doctor);
            }
            continue;
          }

          const { delayMinutes, availabilityStartTime } = calculateDoctorDelay(doctor, now, completedCount);

          const delayDiff = Math.abs(delayMinutes - currentStoredDelay);
          const shouldUpdate =
            (currentStoredDelay === 0 && delayMinutes >= 5) ||
            (currentStoredDelay > 0 && delayMinutes === 0) ||
            (delayDiff >= 5);

          if (!shouldUpdate) continue;

          if (availabilityStartTime) {
            const currentDay = format(now, 'EEEE');
            const todaysAvailability = doctor.availabilitySlots?.find(
              slot => slot.day.toLowerCase() === currentDay.toLowerCase()
            );

            if (todaysAvailability && todaysAvailability.timeSlots?.length > 0) {
              const lastSessionIndex = todaysAvailability.timeSlots.length - 1;
              const lastSession = todaysAvailability.timeSlots[lastSessionIndex];
              let availabilityEndTime: Date;
              const todayKey = todayStr;
              const todayExtension = (doctor as any)?.availabilityExtensions?.[todayKey];
              const matchingSessionExtension = todayExtension?.sessions?.find?.(
                (s: any) => s?.sessionIndex === lastSessionIndex
              );
              try {
                if (matchingSessionExtension?.newEndTime) {
                  availabilityEndTime = parse(matchingSessionExtension.newEndTime, 'hh:mm a', now);
                } else if (todayExtension?.newEndTime) {
                  availabilityEndTime = parse(todayExtension.newEndTime, 'hh:mm a', now);
                } else {
                  availabilityEndTime = parseTime(lastSession.to, now);
                }
              } catch {
                continue;
              }

              if (isBefore(now, availabilityEndTime) || now.getTime() === availabilityEndTime.getTime()) {
                await updateAppointmentsWithDelay(clinicId, doctor.id, delayMinutes, doctor);
                console.log(`[Pace Delay] Updated doctor ${doctor.name} delay to ${delayMinutes}m (Completions: ${completedCount}, Prev: ${currentStoredDelay}m)`);
              } else if (currentStoredDelay > 0) {
                await updateAppointmentsWithDelay(clinicId, doctor.id, 0, doctor);
              }
            }
          }
        }
      } catch (error) {
        console.error('Error updating appointment delays:', error);
      }
    };

    // Set up the real-time listeners
    let unsubscribe: () => void = () => { };
    let doctorsUnsubscribe: () => void = () => { };
    let intervalId: NodeJS.Timeout;

    const userDocRef = doc(db, "users", user.uid);
    getDoc(userDocRef).then(userDocSnap => {
      const clinicId = userDocSnap.data()?.clinicId;
      if (clinicId) {
        const q = query(
          collection(db, "appointments"),
          where("clinicId", "==", clinicId),
          where("status", "in", ["Pending", "Skipped"])
        );

        getDocs(q).then(snapshot => {
          const appointmentsToCheck = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
          } as Appointment));
          checkAndUpdateStatuses(appointmentsToCheck);
        });

        unsubscribe = onSnapshot(q, (snapshot) => {
          const appointmentsToCheck = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
          } as Appointment));
          checkAndUpdateStatuses(appointmentsToCheck);
        });

        checkAndUpdateDelays(clinicId);

        const doctorsRef = collection(db, 'doctors');
        const doctorsQuery = query(doctorsRef, where('clinicId', '==', clinicId));
        doctorsUnsubscribe = onSnapshot(doctorsQuery, () => {
          checkAndUpdateDelays(clinicId);
        });

        intervalId = setInterval(() => {
          getDocs(q).then(snapshot => {
            const appointmentsToCheck = snapshot.docs.map(doc => ({
              id: doc.id,
              ...doc.data()
            } as Appointment));
            checkAndUpdateStatuses(appointmentsToCheck);
          });
          checkAndUpdateDelays(clinicId);
        }, 30000);
      }
    });

    return () => {
      unsubscribe();
      doctorsUnsubscribe();
      if (intervalId) clearInterval(intervalId);
    };
  }, [user]);
}
