
'use server';

/**
 * @fileOverview Manages the walk-in patient queue by assigning token numbers and
 * inserting them after every X online appointments, based on the doctor's configuration.
 *
 * - manageWalkInQueue - A function that handles the assignment of token numbers and queue positions for walk-in patients.
 * - ManageWalkInQueueInput - The input type for the manageWalkInQueue function.
 * - ManageWalkInQueueOutput - The return type for the manageWalkInQueue function.
 */

import {ai} from '@/ai/genkit';
import {z} from 'zod';
import { addMinutes, format, isAfter, isBefore, isEqual, parse, set } from 'date-fns';
import { parseTime } from '@/lib/utils';
import type { Appointment, Doctor } from '@/lib/types';


const ManageWalkInQueueInputSchema = z.object({
  doctor: z.any().describe('The doctor object with availability slots.'),
  allAppointments: z.array(z.any()).describe('An array of all appointments for the day.'),
  walkInTokenAllotment: z.number().describe('The interval of online appointments after which a walk-in should be placed.')
});
export type ManageWalkInQueueInput = z.infer<typeof ManageWalkInQueueInputSchema>;

const ManageWalkInQueueOutputSchema = z.object({
  numericToken: z
    .number()
    .describe(
      'The new numeric token for the walk-in patient.'
    ),
  time: z
    .string()
    .describe('The assigned time for the walk-in patient in hh:mm a format.'),
    slotIndex: z.number().describe('The calculated slot index for the new appointment.')
});
export type ManageWalkInQueueOutput = z.infer<
  typeof ManageWalkInQueueOutputSchema
>;

export async function manageWalkInQueue(
  input: ManageWalkInQueueInput
): Promise<ManageWalkInQueueOutput> {
  return manageWalkInQueueFlow(input);
}


const manageWalkInQueueFlow = ai.defineFlow(
  {
    name: 'manageWalkInQueueFlow',
    inputSchema: ManageWalkInQueueInputSchema,
    outputSchema: ManageWalkInQueueOutputSchema,
  },
  async input => {
    const { doctor, allAppointments, walkInTokenAllotment } = input;
    const now = new Date();
    const consultationTime = doctor.averageConsultingTime || 15;

    const lastAppointment = allAppointments.length > 0 ? allAppointments[allAppointments.length - 1] : null;

    let assignedTime;
    let nextSlotIndex;

    if (lastAppointment) {
        const lastAppointmentTime = parseTime(lastAppointment.time, now);
        assignedTime = addMinutes(lastAppointmentTime, consultationTime);
        nextSlotIndex = (lastAppointment.slotIndex || 0) + 1;
    } else {
        // No appointments yet, find the first available slot today
        const dayOfWeek = format(now, 'EEEE');
        const doctorAvailabilityForDay = doctor.availabilitySlots.find((slot: any) => slot.day === dayOfWeek);
        let firstSlotTime = now; // Default to now

        if (doctorAvailabilityForDay && doctorAvailabilityForDay.timeSlots.length > 0) {
            const sessionStartTime = parseTime(doctorAvailabilityForDay.timeSlots[0].from, now);
            if (isAfter(sessionStartTime, now)) {
                firstSlotTime = sessionStartTime;
            }
        }
        assignedTime = firstSlotTime;
        nextSlotIndex = 0;
    }
    
    const lastToken = allAppointments.reduce((max: number, a: Appointment) => Math.max(max, a.numericToken || 0), 0);
    const numericToken = lastToken + 1;

    return {
      numericToken: numericToken,
      time: format(assignedTime, 'hh:mm a'),
      slotIndex: nextSlotIndex,
    };
  }
);


