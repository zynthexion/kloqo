'use server';

/**
 * @fileOverview This file defines a Genkit flow for analyzing and adjusting doctor availability based on various factors.
 *
 * - analyzeDoctorAvailability - A function that takes doctor information and returns an adjusted availability schedule.
 * - DoctorAvailabilityInput - The input type for the analyzeDoctorAvailability function.
 * - DoctorAvailabilityOutput - The return type for the analyzeDoctorAvailability function.
 */

import {ai} from '@/ai/genkit';
import {z} from 'genkit';

const DoctorAvailabilityInputSchema = z.object({
  doctorId: z.string().describe('The ID of the doctor.'),
  currentSchedule: z.string().describe('The doctor\'s current schedule as a string.'),
  typicalAppointmentLengths: z
    .string()
    .describe('Typical appointment lengths for different procedures.'),
  doctorPreferences: z.string().describe('The doctor\'s preferences for scheduling.'),
  historicalSchedulingData: z
    .string()
    .describe('Historical scheduling data for the doctor.'),
});

export type DoctorAvailabilityInput = z.infer<typeof DoctorAvailabilityInputSchema>;

const DoctorAvailabilityOutputSchema = z.object({
  adjustedAvailability: z
    .string()
    .describe('The adjusted doctor availability schedule.'),
});

export type DoctorAvailabilityOutput = z.infer<typeof DoctorAvailabilityOutputSchema>;

export async function analyzeDoctorAvailability(
  input: DoctorAvailabilityInput
): Promise<DoctorAvailabilityOutput> {
  return analyzeDoctorAvailabilityFlow(input);
}

const prompt = ai.definePrompt({
  name: 'doctorAvailabilityPrompt',
  input: {schema: DoctorAvailabilityInputSchema},
  output: {schema: DoctorAvailabilityOutputSchema},
  prompt: `You are an AI assistant specializing in optimizing doctor availability.

  Based on the following information, analyze and adjust the doctor's availability schedule to reflect a more realistic view of their schedule.  Consider appointment lengths, doctor preferences and historical data to suggest improvements to the schedule.

  Doctor ID: {{{doctorId}}}
  Current Schedule: {{{currentSchedule}}}
  Typical Appointment Lengths: {{{typicalAppointmentLengths}}}
  Doctor Preferences: {{{doctorPreferences}}}
  Historical Scheduling Data: {{{historicalSchedulingData}}}

  Provide the adjusted availability schedule as a string. Be concise.
  `,
});

const analyzeDoctorAvailabilityFlow = ai.defineFlow(
  {
    name: 'analyzeDoctorAvailabilityFlow',
    inputSchema: DoctorAvailabilityInputSchema,
    outputSchema: DoctorAvailabilityOutputSchema,
  },
  async input => {
    const {output} = await prompt(input);
    return output!;
  }
);
