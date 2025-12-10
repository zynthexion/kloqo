
'use client';

import { useEffect } from 'react';
import { collection, doc, getDoc, getDocs, query, writeBatch, where } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useAuth } from '@/firebase';
import type { Doctor, Appointment } from '@/lib/types';
import { parse, format } from 'date-fns';

/**
 * Parses time string to Date object, handling both "hh:mm a" and "HH:mm" formats
 */
function parseTime(timeStr: string, date: Date): Date {
  try {
    // Try parsing "hh:mm a" format first (e.g., "9:00 AM", "01:00 PM")
    if (timeStr.includes('AM') || timeStr.includes('PM')) {
      return parse(timeStr, 'hh:mm a', date);
    }
    // Try parsing "HH:mm" format (e.g., "09:00", "13:00")
    const parsed = parse(timeStr, 'HH:mm', date);
    if (!isNaN(parsed.getTime())) {
      return parsed;
    }
    // Fallback: try "h:mm a" format
    return parse(timeStr, 'h:mm a', date);
  } catch (error) {
    console.error('Error parsing time:', timeStr, error);
    // Fallback: return current date if parsing fails
    return date;
  }
}

const ACTIVE_APPOINTMENT_STATUSES = ['Pending', 'Confirmed', 'Skipped'] as const;

function parseAppointmentDateTime(appointment: Appointment): Date | null {
  if (!appointment.date || !appointment.time) return null;
  try {
    return parse(`${appointment.date} ${appointment.time}`, 'd MMMM yyyy hh:mm a', new Date());
  } catch (error) {
    console.error('Failed to parse appointment date/time', appointment.id, error);
    return null;
  }
}

export function useDoctorStatusUpdater() {
  const { currentUser } = useAuth();

  useEffect(() => {
    if (!currentUser) return;

    const updateStatuses = async () => {
      try {
        const userDoc = await getDoc(doc(db, "users", currentUser.uid));
        const clinicId = userDoc.data()?.clinicId;
        if (!clinicId) return;

        const doctorsQuery = query(collection(db, "doctors"), where("clinicId", "==", clinicId));
        const now = new Date();
        const todayStr = format(now, 'd MMMM yyyy');
        const appointmentsQuery = query(
          collection(db, "appointments"),
          where("clinicId", "==", clinicId),
          where("date", "==", todayStr),
          where("status", "in", ACTIVE_APPOINTMENT_STATUSES)
        );
        const [doctorsSnapshot, appointmentsSnapshot] = await Promise.all([
          getDocs(doctorsQuery),
          getDocs(appointmentsQuery)
        ]);
        const doctors = doctorsSnapshot.docs.map(d => ({ id: d.id, ...d.data() } as Doctor));
        const appointmentsByDoctor = new Map<string, Appointment[]>();
        const pushAppointment = (key: string | undefined | null, appointment: Appointment) => {
          if (!key) return;
          const existing = appointmentsByDoctor.get(key) ?? [];
          existing.push(appointment);
          appointmentsByDoctor.set(key, existing);
        };
        appointmentsSnapshot.docs
          .map(docSnap => ({ id: docSnap.id, ...docSnap.data() } as Appointment))
          .forEach(appt => {
            if (appt.doctorId) {
              pushAppointment(appt.doctorId, appt);
            } else if (appt.doctor) {
              pushAppointment(`name:${appt.doctor}`, appt);
            }
          });
        
        const batch = writeBatch(db);
        const todayDay = format(now, 'EEEE'); // e.g., 'Monday', 'Tuesday'

        let batchHasWrites = false;

        for (const doctor of doctors) {
          if (doctor.consultationStatus !== 'In') {
            continue;
          }

          const todaysAvailability = doctor.availabilitySlots?.find(s => 
            s.day.toLowerCase() === todayDay.toLowerCase()
          );

          const doctorAppointments =
            appointmentsByDoctor.get(doctor.id) ??
            appointmentsByDoctor.get(`name:${doctor.name}`) ??
            [];

          const hasActiveAppointments = doctorAppointments.some((appointment) => {
            const appointmentDateTime = parseAppointmentDateTime(appointment);
            if (!appointmentDateTime) {
              return true;
            }
            return appointmentDateTime.getTime() <= now.getTime();
          });

          let isWithinAnySlot = false;
          if (todaysAvailability?.timeSlots?.length) {
            isWithinAnySlot = todaysAvailability.timeSlots.some(slot => {
              try {
                const startTime = parseTime(slot.from, now);
                const endTime = parseTime(slot.to, now);
                return now.getTime() >= startTime.getTime() && now.getTime() <= endTime.getTime();
              } catch (error) {
                console.error(`Error checking slot for doctor ${doctor.name}:`, error);
                return false;
              }
            });
          }

          const isSessionFinished = !isWithinAnySlot;

          if (!isSessionFinished || hasActiveAppointments) {
            continue;
          }

          const doctorRef = doc(db, 'doctors', doctor.id);
          batch.update(doctorRef, { 
            consultationStatus: 'Out',
            updatedAt: new Date()
          });
          batchHasWrites = true;
        }

        if (batchHasWrites) {
          await batch.commit();
          console.log(`Successfully updated doctors' consultation statuses`);
        }
      } catch (error) {
        console.error("Error updating doctor consultation statuses:", error);
      }
    };

    // Run immediately on mount and then every 2 minutes
    updateStatuses();
    const intervalId = setInterval(updateStatuses, 120000); // Check every 2 minutes

    return () => clearInterval(intervalId);
  }, [currentUser]);
}
