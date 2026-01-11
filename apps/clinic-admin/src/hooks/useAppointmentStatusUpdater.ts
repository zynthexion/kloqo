'use client';

import { useEffect } from 'react';
import { collection, doc, getDoc, writeBatch, where, query, onSnapshot, getDocs, Timestamp } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useAuth } from '@/firebase';
import type { Appointment, Doctor } from '@/lib/types';
import { addMinutes, isAfter, parse, format, subMinutes, differenceInMinutes, isBefore, parseISO, isWithinInterval } from 'date-fns';

import { getClinicNow, getClinicTimeString, getClinicDateString, getSessionBreakIntervals } from '@kloqo/shared-core';

function parseAppointmentDateTime(dateStr: string, timeStr: string): Date {
  return parse(`${dateStr} ${timeStr}`, 'd MMMM yyyy hh:mm a', new Date());
}

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

function isWithinBreak(currentTime: Date, breakIntervals: any[]): boolean {
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
  sessionIndex: number,
  completedCount: number = 0
): { delayMinutes: number; availabilityStartTime: Date | null } {
  const currentDay = format(now, 'EEEE');
  const todaysAvailability = doctor.availabilitySlots?.find(
    slot => slot.day.toLowerCase() === currentDay.toLowerCase()
  );

  if (!todaysAvailability || !todaysAvailability.timeSlots?.length) {
    return { delayMinutes: 0, availabilityStartTime: null };
  }

  const currentSession = todaysAvailability.timeSlots[sessionIndex];
  if (!currentSession) {
    return { delayMinutes: 0, availabilityStartTime: null };
  }

  let baseAvailabilityStartTime: Date;
  try {
    baseAvailabilityStartTime = parseTime(currentSession.from, now);
  } catch (error) {
    return { delayMinutes: 0, availabilityStartTime: null };
  }

  // Calculate passed break duration using shared-core logic
  const breakIntervals = getSessionBreakIntervals(doctor, now, sessionIndex);

  let effectiveStartTime = baseAvailabilityStartTime;
  const initialBreaks = breakIntervals.filter(interval =>
    interval.start.getTime() <= baseAvailabilityStartTime.getTime() + 60000
  );

  if (initialBreaks.length > 0) {
    const latestInitialBreakEnd = initialBreaks.reduce((latest, interval) =>
      interval.end.getTime() > latest.getTime() ? interval.end : latest,
      initialBreaks[0].end
    );
    // Ensure we don't move start time backwards if break ended before session start
    effectiveStartTime = latestInitialBreakEnd.getTime() > baseAvailabilityStartTime.getTime()
      ? latestInitialBreakEnd
      : baseAvailabilityStartTime;
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
    delayMinutes = Math.max(0, differenceInMinutes(now, effectiveStartTime));
  } else {
    const avgTime = doctor.averageConsultingTime || 5;
    const expectedWorkMinutes = completedCount * avgTime;
    const actualElapsedMinutes = differenceInMinutes(now, effectiveStartTime);
    delayMinutes = Math.max(0, actualElapsedMinutes - expectedWorkMinutes - passedBreakMinutes);
  }

  return {
    delayMinutes,
    availabilityStartTime: effectiveStartTime
  };
}

async function updateAppointmentsWithDelay(
  clinicId: string,
  doctorId: string,
  sessionIndex: number,
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
    where('sessionIndex', '==', sessionIndex),
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
      if (!appointment.time || !appointment.date) return;
      const appointmentDate = parse(appointment.date, 'd MMMM yyyy', new Date());
      const appointmentTime = parseTime(appointment.time, appointmentDate);

      // Removed manual break offset. Shared-core slot times already account for breaks.
      const adjustedAppointmentTime = appointmentTime;

      const baseCutOffTime = subMinutes(adjustedAppointmentTime, 15);
      const baseNoShowTime = addMinutes(adjustedAppointmentTime, 15);
      const delayedCutOffTime = addMinutes(baseCutOffTime, totalDelayMinutes);
      const delayedNoShowTime = addMinutes(baseNoShowTime, totalDelayMinutes);

      batch.update(doc.ref, {
        cutOffTime: Timestamp.fromDate(delayedCutOffTime),
        noShowTime: Timestamp.fromDate(delayedNoShowTime),
        doctorDelayMinutes: totalDelayMinutes
      });
      hasWrites = true;
      updatedCount++;
    } catch (error) {
      console.warn(`Error updating appointment ${doc.id} with delay:`, error);
    }
  });

  if (hasWrites) {
    try {
      await batch.commit();
      console.log(`[Delay Update] Updated ${updatedCount} appointments with ${totalDelayMinutes}m delay`);
    } catch (error) {
      console.error('Error committing delay updates:', error);
    }
  }
}

export function useAppointmentStatusUpdater() {
  const { currentUser } = useAuth();

  useEffect(() => {
    if (!currentUser) return;

    const checkAndUpdateStatuses = async (appointments: Appointment[]) => {
      if (appointments.length === 0) return;
      const now = getClinicNow();
      const batch = writeBatch(db);
      let hasWrites = false;

      const appointmentsToCheck = appointments.filter(apt => apt.status === 'Pending' || apt.status === 'Skipped');
      for (const apt of appointmentsToCheck) {
        try {
          if (apt.status === 'Pending') {
            let cutOffTime: Date;
            if (apt.cutOffTime) {
              cutOffTime = (apt.cutOffTime as any).toDate ? (apt.cutOffTime as any).toDate() : new Date(apt.cutOffTime as any);
            } else {
              const appointmentDate = parse(apt.date, 'd MMMM yyyy', new Date());
              const appointmentTime = parseTime(apt.time, appointmentDate);
              cutOffTime = subMinutes(appointmentTime, 15);
            }
            if (isAfter(now, cutOffTime) || now.getTime() >= cutOffTime.getTime()) {
              batch.update(doc(db, 'appointments', apt.id), {
                status: 'Skipped',
                skippedAt: new Date(),
                updatedAt: new Date()
              });
              hasWrites = true;
            }
          } else if (apt.status === 'Skipped') {
            let noShowTime: Date;
            if (apt.noShowTime) {
              noShowTime = (apt.noShowTime as any).toDate ? (apt.noShowTime as any).toDate() : new Date(apt.noShowTime as any);
            } else {
              const appointmentDate = parse(apt.date, 'd MMMM yyyy', new Date());
              const appointmentTime = parseTime(apt.time, appointmentDate);
              noShowTime = addMinutes(appointmentTime, 15);
            }
            if (isAfter(now, noShowTime) || now.getTime() >= noShowTime.getTime()) {
              batch.update(doc(db, 'appointments', apt.id), {
                status: 'No-show',
                updatedAt: new Date()
              });
              hasWrites = true;
            }
          }
        } catch (e) {
          continue;
        }
      }

      if (hasWrites) {
        try {
          await batch.commit();
        } catch (e) {
          console.error("Error in automatic status update batch:", e);
        }
      }
    };

    const checkAndUpdateDelays = async (clinicId: string) => {
      try {
        const doctorsRef = collection(db, 'doctors');
        const doctorsQuery = query(doctorsRef, where('clinicId', '==', clinicId));
        const doctorsSnapshot = await getDocs(doctorsQuery);
        const now = getClinicNow();
        const todayStr = getClinicDateString(now);

        for (const doctorDoc of doctorsSnapshot.docs) {
          const doctor = { id: doctorDoc.id, ...doctorDoc.data() } as Doctor;

          const currentDay = format(now, 'EEEE');
          const todaysAvailability = doctor.availabilitySlots?.find(
            slot => slot.day.toLowerCase() === currentDay.toLowerCase()
          );

          if (!todaysAvailability || !todaysAvailability.timeSlots) continue;

          for (let i = 0; i < todaysAvailability.timeSlots.length; i++) {
            const completedQuery = query(
              collection(db, 'appointments'),
              where('clinicId', '==', clinicId),
              where('doctor', '==', doctor.name),
              where('date', '==', todayStr),
              where('sessionIndex', '==', i),
              where('status', '==', 'Completed')
            );
            const completedSnapshot = await getDocs(completedQuery);
            const completedCount = completedSnapshot.size;

            const activeApptQuery = query(
              collection(db, 'appointments'),
              where('clinicId', '==', clinicId),
              where('doctorId', '==', doctor.id),
              where('date', '==', todayStr),
              where('sessionIndex', '==', i),
              where('status', 'in', ['Pending', 'Confirmed', 'Skipped'])
            );
            const activeApptSnapshot = await getDocs(activeApptQuery);
            let currentStoredDelay = 0;
            if (!activeApptSnapshot.empty) {
              currentStoredDelay = activeApptSnapshot.docs[0].data().doctorDelayMinutes || 0;
            }

            const breakIntervals = getSessionBreakIntervals(doctor, now, i);
            if (isWithinBreak(now, breakIntervals)) {
              if (currentStoredDelay > 0) {
                await updateAppointmentsWithDelay(clinicId, doctor.id, i, 0, doctor);
              }
              continue;
            }

            const { delayMinutes, availabilityStartTime } = calculateDoctorDelay(doctor, now, i, completedCount);
            const delayDiff = Math.abs(delayMinutes - currentStoredDelay);
            const shouldUpdate = (currentStoredDelay === 0 && delayMinutes >= 5) || (currentStoredDelay > 0 && delayMinutes === 0) || (delayDiff >= 5);

            if (!shouldUpdate) continue;

            if (availabilityStartTime) {
              const sessionSource = todaysAvailability.timeSlots[i];
              let availabilityEndTime: Date;
              try {
                availabilityEndTime = parseTime(sessionSource.to, now);
              } catch {
                continue;
              }

              if (isAfter(now, addMinutes(availabilityEndTime, 240))) {
                continue;
              }
            }

            await updateAppointmentsWithDelay(clinicId, doctor.id, i, delayMinutes, doctor);
          }
        }


      } catch (error) {
        console.error('Error updating appointment delays:', error);
      }
    };

    let unsubscribe: () => void = () => { };
    let doctorsUnsubscribe: () => void = () => { };
    let intervalId: NodeJS.Timeout;

    const userDocRef = doc(db, "users", currentUser.uid);
    getDoc(userDocRef).then(userDocSnap => {
      const clinicId = userDocSnap.data()?.clinicId;
      if (clinicId) {
        const appointmentsQuery = query(
          collection(db, "appointments"),
          where("clinicId", "==", clinicId),
          where("status", "in", ["Pending", "Skipped"])
        );

        getDocs(appointmentsQuery).then(snapshot => {
          const appointmentsToCheck = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Appointment));
          checkAndUpdateStatuses(appointmentsToCheck);
        });

        unsubscribe = onSnapshot(appointmentsQuery, (snapshot) => {
          const appointmentsToCheck = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Appointment));
          checkAndUpdateStatuses(appointmentsToCheck);
        });

        checkAndUpdateDelays(clinicId);
        doctorsUnsubscribe = onSnapshot(query(collection(db, 'doctors'), where('clinicId', '==', clinicId)), () => {
          checkAndUpdateDelays(clinicId);
        });

        intervalId = setInterval(() => {
          getDocs(appointmentsQuery).then(snapshot => {
            const appointmentsToCheck = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Appointment));
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
  }, [currentUser]);
}
