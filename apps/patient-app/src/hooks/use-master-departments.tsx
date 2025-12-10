'use client';

import useSWR from 'swr';

export interface Department {
  id: string;
  name: string;
  name_ml?: string;
  description?: string;
  description_ml?: string;
  icon?: string;
}

const fetchDepartments = async (): Promise<Department[]> => {
  const res = await fetch('/api/master-departments', {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    throw new Error('Failed to load departments');
  }

  const data = await res.json();
  return data.departments ?? [];
};

export function useMasterDepartments() {
  const { data, error, isLoading, mutate } = useSWR<Department[]>(
    'master-departments',
    fetchDepartments,
    {
      revalidateOnFocus: false,
      dedupingInterval: 5 * 60 * 1000, // 5 minutes
    }
  );

  return {
    departments: data ?? [],
    loading: (!data && !error) || isLoading,
    error,
    refresh: mutate,
  };
}

