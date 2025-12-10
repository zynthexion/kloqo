'use client';

import useSWR from 'swr';
import type { Doctor } from '@/lib/types';

export { type Doctor };

const fetchDoctors = async (url: string): Promise<{ doctors: Doctor[] }> => {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`Failed to fetch doctors from ${url}`);
  }
  return res.json();
};

export function useDoctors(clinicIds?: string[] | null) {
  const normalizedIds = clinicIds?.filter(Boolean) ?? [];
  const sortedIds = normalizedIds.length > 0 ? [...normalizedIds].sort() : null;
  const queryParam = sortedIds ? encodeURIComponent(sortedIds.join(',')) : null;
  const swrKey = sortedIds ? `/api/doctors?clinicIds=${queryParam}` : null;

  const { data, error, isLoading } = useSWR(swrKey, fetchDoctors, {
    revalidateOnFocus: false,
    dedupingInterval: 60 * 1000,
  });

  return {
    doctors: data?.doctors ?? [],
    loading: swrKey ? (!!isLoading && !data) : false,
    error,
  };
}
