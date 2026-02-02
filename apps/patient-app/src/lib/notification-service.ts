/**
 * Notification Service for sending push notifications to users
 */

import { getFirestore, doc, getDoc } from 'firebase/firestore';
import { getMessaging } from 'firebase/messaging';
import type { Firestore } from 'firebase/firestore';
import { logger } from '@/lib/logger';
import { parse, subMinutes, format } from 'date-fns';
import { getClinicTimeString } from '@kloqo/shared-core';

export interface NotificationData {
  type: 'appointment_confirmed' | 'appointment_reminder' | 'appointment_cancelled' | 'token_called' | 'doctor_late' | 'appointment_rescheduled';
  appointmentId?: string;
  tokenNumber?: string;
  doctorName?: string;
  date?: string;
  time?: string;
  [key: string]: any;
}

/**
 * Get user's FCM token from Firestore
 */
export async function getUserFCMToken(firestore: Firestore, userId: string): Promise<string | null> {
  try {
    const userDoc = await getDoc(doc(firestore, 'users', userId));
    if (userDoc.exists()) {
      const data = userDoc.data();
      return data.fcmToken || null;
    }
    return null;
  } catch (error) {
    console.error('Error getting user FCM token:', error);
    return null;
  }
}

/**
 * Send notification via API route
 * This will call the backend API endpoint to send the notification
 */
export async function sendNotification(params: {
  firestore: Firestore;
  userId: string;
  title: string;
  body: string;
  data: NotificationData;
}): Promise<boolean> {
  try {
    const { firestore, userId, title, body, data } = params;

    // Get user's FCM token
    const fcmToken = await getUserFCMToken(firestore, userId);
    if (!fcmToken) {
      logger.info('No FCM token found for user');
      return false;
    }

    // Check if notifications are enabled
    const userDoc = await getDoc(doc(firestore, 'users', userId));
    if (!userDoc.exists()) {
      return false;
    }

    const userData = userDoc.data();
    if (!userData.notificationsEnabled) {
      logger.info('Notifications disabled for user');
      return false;
    }

    // Send notification to API endpoint
    const response = await fetch('/api/send-notification', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fcmToken,
        title,
        body,
        data,
        userId, // Pass userId to API for history storage
        language: userData.language || 'en', // Pass user language preference
      }),
    });

    if (!response.ok) {
      console.error('Failed to send notification:', await response.text());
      return false;
    }

    return true;
  } catch (error) {
    console.error('Error sending notification:', error);
    return false;
  }
}

/**
 * Helper function to send appointment confirmed notification
 */
export async function sendAppointmentConfirmedNotification(params: {
  firestore: Firestore;
  userId: string;
  appointmentId: string;
  doctorName: string;
  date: string;
  time: string;
  tokenNumber: string;
  classicTokenNumber?: string;
  tokenDistribution?: 'classic' | 'advanced';
  cancelledByBreak?: boolean;
}): Promise<boolean> {
  const { firestore, userId, appointmentId, doctorName, date, time, tokenNumber, classicTokenNumber, tokenDistribution, cancelledByBreak } = params;

  if (cancelledByBreak) {
    logger.info(`Skipping confirmed notification for break-affected appointment ${appointmentId}`);
    return true;
  }

  // Calculate reporting time (15 mins early)
  let displayTime = time;
  try {
    const appointmentDate = parse(date, 'd MMMM yyyy', new Date());
    const baseTime = parse(time, 'hh:mm a', appointmentDate);
    displayTime = getClinicTimeString(subMinutes(baseTime, 15));
  } catch (error) {
    console.error('Error calculating display time for confirmed notification:', error);
  }

  // STRICT LOGIC:
  // If Classic Clinic:
  //   - Show ONLY if classicTokenNumber exists.
  //   - If NO classicTokenNumber, HIDE token (don't show internal 'A' token).
  // If Advanced Clinic or Unknown:
  //   - Show whatever token is present.

  let finalTokenNumber = tokenNumber;
  let showToken = true;

  if (tokenDistribution === 'classic') {
    if (classicTokenNumber) {
      finalTokenNumber = classicTokenNumber;
      showToken = true;
    } else {
      showToken = false;
    }
  } else {
    // Advanced: Show token
    showToken = !!tokenNumber;
  }

  return sendNotification({
    firestore,
    userId,
    title: 'Appointment Confirmed',
    body: `Your appointment with Dr. ${doctorName} is confirmed for ${date} at ${displayTime}.${showToken ? ` Token: ${finalTokenNumber}` : ''}`,
    data: {
      type: 'appointment_confirmed',
      appointmentId,
      doctorName,
      date,
      time: displayTime,
      tokenNumber: finalTokenNumber,
      classicTokenNumber,
      tokenDistribution,
    },
  });
}

/**
 * Helper function to send appointment reminder notification
 */
export async function sendAppointmentReminderNotification(params: {
  firestore: Firestore;
  userId: string;
  appointmentId: string;
  doctorName: string;
  time: string;
  tokenNumber: string;
  classicTokenNumber?: string;
  tokenDistribution?: 'classic' | 'advanced';
  cancelledByBreak?: boolean;
}): Promise<boolean> {
  const { firestore, userId, appointmentId, doctorName, time, tokenNumber, classicTokenNumber, tokenDistribution, cancelledByBreak } = params;

  if (cancelledByBreak) {
    logger.info(`Skipping reminder notification for break-affected appointment ${appointmentId}`);
    return true;
  }

  // Reminder shows reporting time
  let displayTime = time;
  try {
    // Note: No date provided here, using today as reference
    const baseTime = parse(time, 'hh:mm a', new Date());
    displayTime = getClinicTimeString(subMinutes(baseTime, 15));
  } catch (error) {
    console.error('Error calculating display time for reminder:', error);
  }

  // STRICT LOGIC for Reminders:

  let finalTokenNumber = tokenNumber;
  let showToken = true;

  if (tokenDistribution === 'classic') {
    if (classicTokenNumber) {
      finalTokenNumber = classicTokenNumber;
      showToken = true;
    } else {
      showToken = false;
    }
  } else {
    showToken = !!tokenNumber;
  }

  return sendNotification({
    firestore,
    userId,
    title: 'Upcoming Appointment',
    body: `Your appointment with Dr. ${doctorName} is in 2 hours at ${displayTime}.${showToken ? ` Token: ${finalTokenNumber}` : ''}`,
    data: {
      type: 'appointment_reminder',
      appointmentId,
      doctorName,
      time: displayTime,
      tokenNumber: finalTokenNumber,
      classicTokenNumber,
      tokenDistribution,
    },
  });
}

/**
 * Helper function to send appointment cancelled notification
 */
export async function sendAppointmentCancelledNotification(params: {
  firestore: Firestore;
  userId: string;
  appointmentId: string;
  doctorName: string;
  date: string;
  time: string;
  reason?: string;
}): Promise<boolean> {
  const { firestore, userId, appointmentId, doctorName, date, time, reason } = params;

  // Cancellation shows reporting time
  let displayTime = time;
  try {
    const appointmentDate = parse(date, 'd MMMM yyyy', new Date());
    const baseTime = parse(time, 'hh:mm a', appointmentDate);
    displayTime = getClinicTimeString(subMinutes(baseTime, 15));
  } catch (error) {
    console.error('Error calculating display time for cancellation:', error);
  }

  return sendNotification({
    firestore,
    userId,
    title: 'Appointment Cancelled',
    body: `Your appointment with Dr. ${doctorName} on ${date} at ${displayTime} has been cancelled.${reason ? ` Reason: ${reason}` : ''}`,
    data: {
      type: 'appointment_cancelled',
      appointmentId,
      doctorName,
      date,
      time: displayTime,
      reason,
    },
  });
}

/**
 * Helper function to send token called notification
 */
export async function sendTokenCalledNotification(params: {
  firestore: Firestore;
  userId: string;
  tokenNumber: string;
  appointmentId?: string;
  cancelledByBreak?: boolean;
}): Promise<boolean> {
  const { firestore, userId, tokenNumber, appointmentId, cancelledByBreak } = params;

  if (cancelledByBreak) {
    logger.info(`Skipping token called notification for break-affected appointment ${appointmentId}`);
    return true;
  }

  return sendNotification({
    firestore,
    userId,
    title: 'Your Turn!',
    body: `Token ${tokenNumber} is now being served. Please proceed to the clinic.`,
    data: {
      type: 'token_called',
      tokenNumber,
    },
  });
}

/**
 * Helper function to send doctor running late notification
 */
export async function sendDoctorLateNotification(params: {
  firestore: Firestore;
  userId: string;
  appointmentId: string;
  doctorName: string;
  delayMinutes: number;
  cancelledByBreak?: boolean;
}): Promise<boolean> {
  const { firestore, userId, appointmentId, doctorName, delayMinutes, cancelledByBreak } = params;

  if (cancelledByBreak) {
    logger.info(`Skipping doctor late notification for break-affected appointment ${appointmentId}`);
    return true;
  }

  return sendNotification({
    firestore,
    userId,
    title: 'Doctor Running Late',
    body: `Dr. ${doctorName} is running approximately ${delayMinutes} minutes late.`,
    data: {
      type: 'doctor_late',
      appointmentId,
      doctorName,
      delayMinutes,
    },
  });
}

/**
 * Helper function to send appointment rescheduled notification
 */
export async function sendAppointmentRescheduledNotification(params: {
  firestore: Firestore;
  userId: string;
  appointmentId: string;
  doctorName: string;
  oldDate: string;
  newDate: string;
  time: string;
  tokenNumber?: string;
  cancelledByBreak?: boolean;
}): Promise<boolean> {
  const { firestore, userId, appointmentId, doctorName, oldDate, newDate, time, tokenNumber, cancelledByBreak } = params;

  if (cancelledByBreak) {
    logger.info(`Skipping rescheduled notification for break-affected appointment ${appointmentId}`);
    return true;
  }

  // Rescheduled shows reporting time
  let displayTime = time;
  try {
    const appointmentDate = parse(newDate, 'd MMMM yyyy', new Date());
    const baseTime = parse(time, 'hh:mm a', appointmentDate);
    displayTime = getClinicTimeString(subMinutes(baseTime, 15));
  } catch (error) {
    console.error('Error calculating display time for reschedule:', error);
  }

  return sendNotification({
    firestore,
    userId,
    title: 'Appointment Rescheduled',
    body: `Your appointment with Dr. ${doctorName} has been rescheduled from ${oldDate} to ${newDate} at ${displayTime}.`,
    data: {
      type: 'appointment_rescheduled',
      appointmentId,
      doctorName,
      oldDate,
      newDate,
      time: displayTime,
      ...(tokenNumber ? { tokenNumber } : {}),
    },
  });
}



