
'use client';

import useSWR from 'swr';
import type { Appointment } from '@/lib/types';

export { type Appointment };

const fetchAppointments = async (url: string): Promise<{ appointments: Appointment[] }> => {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`Failed to fetch appointments from ${url}`);
  }
  return res.json();
};

export function useAppointments(patientId?: string | null) {
  const swrKey = patientId ? `/api/appointments?patientId=${encodeURIComponent(patientId)}` : null;
  const { data, error, isLoading } = useSWR(swrKey, fetchAppointments, {
    revalidateOnFocus: false,
    dedupingInterval: 60 * 1000,
  });
            
  return {
    appointments: data?.appointments ?? [],
    loading: swrKey ? (!!isLoading && !data) : false,
    error,
  };
}
