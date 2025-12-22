import { collection, getDocs, query, where, orderBy, limit } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { firestoreTimestampToDate, parseDateString } from './metrics';

export interface Clinic {
  id: string;
  name: string;
  type?: string;
  address?: string;
  addressDetails?: {
    line1?: string;
    line2?: string;
    city?: string;
    district?: string;
    state?: string;
    pincode?: string;
  };
  city?: string;
  district?: string;
  registrationDate?: any;
  onboardingStatus?: string;
  currentDoctorCount?: number;
  numDoctors?: number;
  planStartDate?: any;
  registrationStatus?: string;
  ownerEmail?: string;
  ownerId?: string;
  clinicRegNumber?: string;
  latitude?: number;
  longitude?: number;
  mapsLink?: string;
  logoUrl?: string;
  licenseUrl?: string;
  receptionPhotoUrl?: string | null;
  plan?: string;
  walkInTokenAllotment?: number;
  departments?: string[];
}

export interface Patient {
  id: string;
  name: string;
  phone: string;
  email?: string;
  age?: number;
  sex?: 'Male' | 'Female' | 'Other' | '';
  place?: string;
  createdAt?: any;
  totalAppointments?: number;
  clinicIds?: string[];
}

export interface Appointment {
  id: string;
  patientId: string;
  clinicId: string;
  doctor: string;
  date: string;
  status: string;
  createdAt?: any;
  bookedVia?: string;
  tokenNumber?: string;
}

/**
 * Fetch all clinics
 */
export async function fetchAllClinics(): Promise<Clinic[]> {
  try {
    const clinicsRef = collection(db, 'clinics');
    const snapshot = await getDocs(clinicsRef);

    return snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    })) as Clinic[];
  } catch (error) {
    console.error('Error fetching clinics:', error);
    return [];
  }
}

/**
 * Fetch all patients
 */
export async function fetchAllPatients(): Promise<Patient[]> {
  try {
    const patientsRef = collection(db, 'patients');
    const snapshot = await getDocs(patientsRef);

    return snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    })) as Patient[];
  } catch (error) {
    console.error('Error fetching patients:', error);
    return [];
  }
}

/**
 * Fetch all appointments
 */
export async function fetchAllAppointments(): Promise<Appointment[]> {
  try {
    const appointmentsRef = collection(db, 'appointments');
    const snapshot = await getDocs(appointmentsRef);

    return snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    })) as Appointment[];
  } catch (error) {
    console.error('Error fetching appointments:', error);
    return [];
  }
}

/**
 * Fetch appointments for a specific date range
 */
export async function fetchAppointmentsByDateRange(startDate: Date, endDate: Date): Promise<Appointment[]> {
  try {
    const allAppointments = await fetchAllAppointments();

    return allAppointments.filter((apt) => {
      let aptDate: Date | null = null;

      if (apt.createdAt) {
        aptDate = firestoreTimestampToDate(apt.createdAt);
      }

      if (!aptDate && apt.date) {
        aptDate = parseDateString(apt.date);
      }

      if (!aptDate) return false;

      return aptDate >= startDate && aptDate <= endDate;
    });
  } catch (error) {
    console.error('Error fetching appointments by date range:', error);
    return [];
  }
}

/**
 * Get patient first booking date
 */
export function getPatientFirstBooking(patientId: string, appointments: Appointment[]): Date | null {
  const patientAppointments = appointments
    .filter((apt) => apt.patientId === patientId)
    .map((apt) => {
      if (apt.createdAt) {
        return firestoreTimestampToDate(apt.createdAt);
      }
      if (apt.date) {
        return parseDateString(apt.date);
      }
      return null;
    })
    .filter((date): date is Date => date !== null)
    .sort((a, b) => a.getTime() - b.getTime());

  return patientAppointments.length > 0 ? patientAppointments[0] : null;
}

/**
 * Get patient last active date
 */
export function getPatientLastActive(patientId: string, appointments: Appointment[]): Date | null {
  const patientAppointments = appointments
    .filter((apt) => apt.patientId === patientId)
    .map((apt) => {
      if (apt.createdAt) {
        return firestoreTimestampToDate(apt.createdAt);
      }
      if (apt.date) {
        return parseDateString(apt.date);
      }
      return null;
    })
    .filter((date): date is Date => date !== null)
    .sort((a, b) => b.getTime() - a.getTime());

  return patientAppointments.length > 0 ? patientAppointments[0] : null;
}

/**
 * Calculate growth trends over time periods
 */
export function calculateGrowthTrends(
  appointments: Appointment[],
  days: number = 90
): Array<{ date: string; count: number }> {
  const now = new Date();
  const trends: Map<string, number> = new Map();

  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split('T')[0];
    trends.set(dateStr, 0);
  }

  appointments.forEach((apt) => {
    let aptDate: Date | null = null;

    if (apt.createdAt) {
      aptDate = firestoreTimestampToDate(apt.createdAt);
    } else if (apt.date) {
      aptDate = parseDateString(apt.date);
    }

    if (!aptDate) return;

    const dateStr = aptDate.toISOString().split('T')[0];
    if (trends.has(dateStr)) {
      trends.set(dateStr, (trends.get(dateStr) || 0) + 1);
    }
  });

  return Array.from(trends.entries())
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));
}


