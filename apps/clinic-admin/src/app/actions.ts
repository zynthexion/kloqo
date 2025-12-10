'use server';

import { analyzeDoctorAvailability, DoctorAvailabilityInput } from "@/ai/flows/doctor-availability-analysis";
import { z } from 'zod';

const ActionInputSchema = z.object({
  doctorId: z.string(),
  currentSchedule: z.string(),
  typicalAppointmentLengths: z.string(),
  doctorPreferences: z.string(),
  historicalSchedulingData: z.string(),
});

export async function getAdjustedAvailability(input: DoctorAvailabilityInput) {
  const parsedInput = ActionInputSchema.safeParse(input);

  if (!parsedInput.success) {
    throw new Error('Invalid input');
  }

  try {
    const result = await analyzeDoctorAvailability(parsedInput.data);
    return result;
  } catch (error) {
    console.error('Error in AI analysis:', error);
    return { error: 'Failed to analyze availability. Please try again.' };
  }
}
