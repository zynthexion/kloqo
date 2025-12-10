'use client';

import { PatientForm } from '@kloqo/shared-ui';

import type { Doctor } from '@/lib/types';

export function ConsultationForm({ selectedDoctor }: { selectedDoctor: Doctor }) {
    return <PatientForm selectedDoctor={selectedDoctor} appointmentType="Walk-in" />;
}
