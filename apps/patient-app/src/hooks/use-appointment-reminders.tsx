'use client';

import { useEffect, useRef } from 'react';
import { useFirestore } from '@/firebase';
import { useUser } from '@/firebase/auth/use-user';
import { collection, query, where, getDocs } from 'firebase/firestore';
import { sendAppointmentReminderNotification } from '@/lib/notification-service';
import { parseAppointmentDateTime } from '@/lib/utils';
import { differenceInHours } from 'date-fns';
import type { Appointment } from '@/lib/types';

// Store sent reminders to avoid duplicates
const sentReminders = new Set<string>();

const REMINDER_HOURS_BEFORE = 2; // 2 hours before appointment

export function useAppointmentReminders() {
  const firestore = useFirestore();
  const { user } = useUser();
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const checkRef = useRef<boolean>(false);

  useEffect(() => {
    if (!firestore || !user?.dbUserId || !user?.patientId) return;

    const checkAndSendReminders = async () => {
      // Prevent multiple simultaneous checks
      if (checkRef.current) return;
      checkRef.current = true;

      try {
        const now = new Date();

        // Query upcoming appointments for this patient
        const appointmentsRef = collection(firestore, 'appointments');
        const appointmentsQuery = query(
          appointmentsRef,
          where('patientId', '==', user.patientId),
          where('status', 'in', ['Pending', 'Confirmed'])
        );

        const snapshot = await getDocs(appointmentsQuery);
        const appointments = snapshot.docs.map(doc => ({
          id: doc.id,
          ...doc.data()
        })) as Appointment[];

        for (const appointment of appointments) {
          const reminderKey = `${appointment.id}_reminder`;

          // Skip if already sent
          if (sentReminders.has(reminderKey)) continue;

          try {
            const appointmentDateTime = parseAppointmentDateTime(appointment.date, appointment.time);

            // Calculate hours until appointment
            const hoursUntilAppointment = differenceInHours(appointmentDateTime, now);

            // Check if appointment is approximately 2 hours away (within a 10-minute window)
            // Appointment should be between 1 hour 50 minutes and 2 hours 10 minutes from now
            if (hoursUntilAppointment >= 1 && hoursUntilAppointment <= REMINDER_HOURS_BEFORE) {
              // More precise check: between 1h 50min and 2h 10min
              const minutesUntilAppointment = (appointmentDateTime.getTime() - now.getTime()) / (1000 * 60);
              if (minutesUntilAppointment >= 110 && minutesUntilAppointment <= 130) {
                // Send reminder notification
                await sendAppointmentReminderNotification({
                  firestore,
                  userId: user.dbUserId,
                  appointmentId: appointment.id,
                  doctorName: appointment.doctor,
                  time: appointment.time,
                  tokenNumber: appointment.tokenNumber,
                  cancelledByBreak: appointment.cancelledByBreak,
                });

                // Mark as sent
                sentReminders.add(reminderKey);
                console.log(`Reminder sent for appointment ${appointment.id}`);
              }
            }
          } catch (error) {
            console.error(`Error processing reminder for appointment ${appointment.id}:`, error);
          }
        }
      } catch (error) {
        console.error('Error checking appointment reminders:', error);
      } finally {
        checkRef.current = false;
      }
    };

    // Check immediately on mount
    checkAndSendReminders();

    // Check every 10 minutes
    intervalRef.current = setInterval(checkAndSendReminders, 10 * 60 * 1000);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [firestore, user]);

  // Clean up sent reminders for appointments that have passed
  useEffect(() => {
    if (!firestore || !user?.patientId) return;

    const cleanupOldReminders = async () => {
      try {
        const appointmentsRef = collection(firestore, 'appointments');
        const appointmentsQuery = query(
          appointmentsRef,
          where('patientId', '==', user.patientId),
          where('status', 'in', ['Completed', 'Cancelled'])
        );

        const snapshot = await getDocs(appointmentsQuery);
        const completedIds = snapshot.docs.map(doc => doc.id);

        // Remove reminders for completed/cancelled appointments
        completedIds.forEach(id => {
          sentReminders.delete(`${id}_reminder`);
        });
      } catch (error) {
        console.error('Error cleaning up reminders:', error);
      }
    };

    const cleanupInterval = setInterval(cleanupOldReminders, 60 * 60 * 1000); // Every hour
    return () => clearInterval(cleanupInterval);
  }, [firestore, user]);

  return null;
}

