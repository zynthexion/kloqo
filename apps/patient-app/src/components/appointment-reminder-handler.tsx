'use client';

import { useAppointmentReminders } from '@/hooks/use-appointment-reminders';

export function AppointmentReminderHandler() {
  useAppointmentReminders();
  return null;
}

