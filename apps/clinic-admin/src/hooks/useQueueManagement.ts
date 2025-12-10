import { useState, useEffect, useMemo } from 'react';
import { collection, query, where, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { format } from 'date-fns';
import { computeQueues, type QueueState } from '@kloqo/shared-core';
import type { Appointment, Doctor } from '@/lib/types';

/**
 * Hook to manage queues for a specific doctor and session
 */
export function useQueueManagement(
  doctor: Doctor | null,
  date: Date,
  sessionIndex: number,
  enabled: boolean = true
) {
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [queueState, setQueueState] = useState<QueueState | null>(null);
  const [loading, setLoading] = useState(true);

  const dateStr = format(date, 'd MMMM yyyy');

  useEffect(() => {
    if (!enabled || !doctor || !doctor.clinicId) {
      setLoading(false);
      return;
    }

    setLoading(true);

    // Listen to appointments for this doctor, date, and session
    const appointmentsQuery = query(
      collection(db, 'appointments'),
      where('clinicId', '==', doctor.clinicId),
      where('doctor', '==', doctor.name),
      where('date', '==', dateStr)
    );

    const unsubscribe = onSnapshot(
      appointmentsQuery,
      async (snapshot) => {
        const appointmentsData = snapshot.docs.map(doc => ({
          id: doc.id,
          ...doc.data()
        } as Appointment));

        setAppointments(appointmentsData);

        // Compute queues
        try {
          const queues = await computeQueues(
            appointmentsData,
            doctor.name,
            doctor.id,
            doctor.clinicId,
            dateStr,
            sessionIndex
          );
          setQueueState(queues);
        } catch (error) {
          console.error('Error computing queues:', error);
        } finally {
          setLoading(false);
        }
      },
      (error) => {
        console.error('Error listening to appointments:', error);
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, [doctor?.id, doctor?.name, doctor?.clinicId, dateStr, sessionIndex, enabled]);

  return {
    appointments,
    queueState,
    loading,
  };
}



