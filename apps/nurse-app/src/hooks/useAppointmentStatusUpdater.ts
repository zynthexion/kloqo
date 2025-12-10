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
  if (!doctor?.leaveSlots || !referenceDate) {
    return [];
  }

  const consultationTime = doctor.averageConsultingTime || 15;

  const slotsForDay = (doctor.leaveSlots || [])
    .map((leave) => {
      if (typeof leave === 'string') {
        try {
          return parseISO(leave);
        } catch {
          return null;
        }
      }
      if (leave && typeof (leave as any).toDate === 'function') {
        try {
          return (leave as any).toDate();
        } catch {
          return null;
        }
      }
      if (leave instanceof Date) {
        return leave;
      }
      return null;
    })
    .filter((date): date is Date => {
      if (!date || isNaN(date.getTime())) return false;
      return format(date, 'yyyy-MM-dd') === format(referenceDate, 'yyyy-MM-dd');
    })
    .sort((a, b) => a.getTime() - b.getTime());
  
  if (slotsForDay.length === 0) {
    return [];
  }

  const intervals: BreakInterval[] = [];
  let currentInterval: BreakInterval | null = null;

  for (const slot of slotsForDay) {
    if (!currentInterval) {
      currentInterval = {
        start: slot,
        end: addMinutes(slot, consultationTime),
      };
      continue;
    }

    if (slot.getTime() === currentInterval.end.getTime()) {
      currentInterval.end = addMinutes(slot, consultationTime);
    } else {
      intervals.push(currentInterval);
      currentInterval = {
        start: slot,
        end: addMinutes(slot, consultationTime),
      };
    }
  }

  if (currentInterval) {
    intervals.push(currentInterval);
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

// Calculate doctor delay: minutes since availability start while doctor is not 'In'
// Accounts for breaks: if breaks start at/before session start, delay calculation starts after breaks end
function calculateDoctorDelay(
  doctor: Doctor,
  now: Date
): { delayMinutes: number; availabilityStartTime: Date | null } {
  const currentDay = format(now, 'EEEE');
  const todaysAvailability = doctor.availabilitySlots?.find(
    slot => slot.day.toLowerCase() === currentDay.toLowerCase()
  );

  if (!todaysAvailability || !todaysAvailability.timeSlots?.length) {
    return { delayMinutes: 0, availabilityStartTime: null };
  }

  // Get the first session start time (when availability begins)
  const firstSession = todaysAvailability.timeSlots[0];
  let baseAvailabilityStartTime: Date;
  try {
    baseAvailabilityStartTime = parseTime(firstSession.from, now);
  } catch (error) {
    console.warn(`Error parsing availability start time for doctor ${doctor.name}:`, error);
    return { delayMinutes: 0, availabilityStartTime: null };
  }

  // Get break intervals for today to find effective consultation start time
  const breakIntervals = buildBreakIntervals(doctor, now);
  
  // Find breaks that start at or before the first session start time
  // The effective consultation start time is after all such breaks end
  let effectiveStartTime = baseAvailabilityStartTime;
  if (breakIntervals.length > 0) {
    // Find breaks that overlap with or start before the session start
    const relevantBreaks = breakIntervals.filter(interval => 
      interval.start.getTime() <= baseAvailabilityStartTime.getTime() ||
      (interval.start.getTime() <= baseAvailabilityStartTime.getTime() + 60000 && // within 1 minute
       interval.end.getTime() > baseAvailabilityStartTime.getTime())
    );
    
    // If there are breaks at the start, use the latest break end time as effective start
    if (relevantBreaks.length > 0) {
      const latestBreakEnd = relevantBreaks.reduce((latest, interval) => 
        interval.end.getTime() > latest.getTime() ? interval.end : latest,
        relevantBreaks[0].end
      );
      effectiveStartTime = latestBreakEnd;
      console.log(`[Delay Calculation] Doctor ${doctor.name}: Base start ${format(baseAvailabilityStartTime, 'hh:mm a')}, Break ends at ${format(latestBreakEnd, 'hh:mm a')}, Effective start: ${format(effectiveStartTime, 'hh:mm a')}`);
    }
  }

  // If current time is before effective start time (after breaks), no delay
  if (isBefore(now, effectiveStartTime)) {
    return { delayMinutes: 0, availabilityStartTime: effectiveStartTime };
  }

  // If doctor is already 'In', no delay
  if (doctor.consultationStatus === 'In') {
    return { delayMinutes: 0, availabilityStartTime: effectiveStartTime };
  }

  // Calculate delay: minutes since effective consultation start (after breaks) while doctor is not 'In'
  const delayMinutes = differenceInMinutes(now, effectiveStartTime);
  
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

        for (const doctorDoc of doctorsSnapshot.docs) {
          const doctor = { id: doctorDoc.id, ...doctorDoc.data() } as Doctor;
          
          // Check if current time is within a break - if so, clear delays and skip updates
          const breakIntervals = buildBreakIntervals(doctor, now);
          console.log(`[Break Check] Doctor: ${doctor.name}, Current time: ${format(now, 'hh:mm a')}, Break intervals: ${breakIntervals.length}`);
          if (isWithinBreak(now, breakIntervals)) {
            console.log(`[Break Protection] Doctor ${doctor.name} is in break period - clearing all delays`);
            // Clear any existing delays by setting to 0
            await updateAppointmentsWithDelay(clinicId, doctor.id, 0, doctor);
            console.log(`[Break Protection] Delays cleared for doctor ${doctor.name} - skipping further updates during break`);
            continue; // Skip this doctor, don't update appointments during breaks
          }
          console.log(`[Break Check] Doctor ${doctor.name} not in break - proceeding`);
          
          const { delayMinutes, availabilityStartTime } = calculateDoctorDelay(doctor, now);
          
          // Only add delay if doctor is not 'In' and availability has started
          if (delayMinutes > 0 && availabilityStartTime) {
            // Check if we're still within the consultation window
            const currentDay = format(now, 'EEEE');
            const todaysAvailability = doctor.availabilitySlots?.find(
              slot => slot.day.toLowerCase() === currentDay.toLowerCase()
            );
            
            if (todaysAvailability && todaysAvailability.timeSlots?.length > 0) {
              // Get the last session end time to check if we're still in consultation window.
              // Prefer today's availability extension end time (per session) when present.
              const lastSessionIndex = todaysAvailability.timeSlots.length - 1;
              const lastSession = todaysAvailability.timeSlots[lastSessionIndex];
              let availabilityEndTime: Date;
              const todayKey = format(now, 'd MMMM yyyy');
              const todayExtension = (doctor as any)?.availabilityExtensions?.[todayKey];
              const matchingSessionExtension = todayExtension?.sessions?.find?.(
                (s: any) => s?.sessionIndex === lastSessionIndex
              );
              try {
                if (matchingSessionExtension?.newEndTime) {
                  availabilityEndTime = parse(matchingSessionExtension.newEndTime, 'hh:mm a', now);
                  console.log(`[Delay Window] Using session extension end ${matchingSessionExtension.newEndTime} for doctor ${doctor.name} (session ${lastSessionIndex})`);
                } else if (todayExtension?.newEndTime) {
                  availabilityEndTime = parse(todayExtension.newEndTime, 'hh:mm a', now);
                  console.log(`[Delay Window] Using day extension end ${todayExtension.newEndTime} for doctor ${doctor.name}`);
                } else {
                  availabilityEndTime = parseTime(lastSession.to, now);
                  console.log(`[Delay Window] Using base session end ${lastSession.to} for doctor ${doctor.name}`);
                }
              } catch {
                console.warn(`[Delay Window] Could not parse availability end for doctor ${doctor.name} (session ${lastSessionIndex}). Skipping delay update.`);
                continue; // Skip if we can't parse end time
              }
              
              // Only apply delay if we're still within the consultation window
              if (isBefore(now, availabilityEndTime) || now.getTime() === availabilityEndTime.getTime()) {
                // Store doctor delay separately (for display only)
                // Status transitions (Pending → Skipped → No-show) always use ORIGINAL cutOffTime/noShowTime
                await updateAppointmentsWithDelay(
                  clinicId,
                  doctor.id,
                  delayMinutes, // Total delay in minutes (stored in doctorDelayMinutes field)
                  doctor
                );
                console.log(`[Delay Update] Added ${delayMinutes} minute doctor delay to appointments for doctor ${doctor.name} (consultation started at ${format(availabilityStartTime, 'hh:mm a')}, current time: ${format(now, 'hh:mm a')}). Delay added to cutOffTime and noShowTime.`);
              } else {
                // Consultation window has ended, clear the delay
                await updateAppointmentsWithDelay(clinicId, doctor.id, 0, doctor);
                console.log(`[Delay Update] Consultation window ended at ${format(availabilityEndTime, 'hh:mm a')} for doctor ${doctor.name}. Clearing delay to 0.`);
              }
            }
          }
        }
      } catch (error) {
        console.error('Error updating appointment delays:', error);
      }
    };
    
    // Set up the real-time listener
    const userDocRef = doc(db, "users", user.uid);
    getDoc(userDocRef).then(userDocSnap => {
        const clinicId = userDocSnap.data()?.clinicId;
        if (clinicId) {
            // Query for both Pending and Skipped appointments
            const q = query(
                collection(db, "appointments"), 
                where("clinicId", "==", clinicId),
                where("status", "in", ["Pending", "Skipped"])
            );

            // Run immediately on mount to check current statuses
            getDocs(q).then(snapshot => {
                const appointmentsToCheck = snapshot.docs.map(doc => ({ 
                    id: doc.id, 
                    ...doc.data() 
                } as Appointment));
                checkAndUpdateStatuses(appointmentsToCheck);
            });

            // Listen for real-time changes
            const unsubscribe = onSnapshot(q, (snapshot) => {
                const appointmentsToCheck = snapshot.docs.map(doc => ({ 
                    id: doc.id, 
                    ...doc.data() 
                } as Appointment));
                checkAndUpdateStatuses(appointmentsToCheck);
            });

            // Run delay check immediately on mount
            checkAndUpdateDelays(clinicId);

            // Set up real-time listener for doctor status changes
            // This ensures delays stop immediately when doctor goes 'In'
            const doctorsRef = collection(db, 'doctors');
            const doctorsQuery = query(doctorsRef, where('clinicId', '==', clinicId));
            const doctorsUnsubscribe = onSnapshot(doctorsQuery, (doctorsSnapshot) => {
                // When doctor status changes, immediately recalculate delays
                // If doctor goes 'In', delays will stop; if doctor goes 'Out' during consultation, delays will resume
                checkAndUpdateDelays(clinicId);
            });

            // Set an interval to re-run the check periodically, as a fallback for time passing
            // Reduced to 30 seconds for more responsive updates while app is open
            const intervalId = setInterval(() => {
                // Re-fetch to check for time-based status changes
                getDocs(q).then(snapshot => {
                    const appointmentsToCheck = snapshot.docs.map(doc => ({ 
                        id: doc.id, 
                        ...doc.data() 
                    } as Appointment));
                    checkAndUpdateStatuses(appointmentsToCheck);
                });
                // Check and update appointment delays based on doctor consultation status
                checkAndUpdateDelays(clinicId);
            }, 30000); // Check every 30 seconds for more responsive updates while app is open

            // Cleanup function
            return () => {
                unsubscribe();
                doctorsUnsubscribe();
                clearInterval(intervalId);
            };
        }
    });

  }, [user]);
}
