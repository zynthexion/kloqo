import { collection, getDocs, query, where, orderBy, limit, doc, getDoc } from 'firebase/firestore';
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
  communicationPhone?: string;
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

export interface User {
  id: string;
  uid: string;
  phone: string;
  role?: string;
  pwaInstalled?: boolean;
}

/**
 * Fetch all users
 */
export async function fetchAllUsers(): Promise<User[]> {
  try {
    const usersRef = collection(db, 'users');
    const snapshot = await getDocs(usersRef);

    return snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    })) as User[];
  } catch (error) {
    console.error('Error fetching users:', error);
    return [];
  }
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
 * Fetch patients by communication phone (for finding related accounts)
 */
export async function fetchPatientsByPhone(phone: string): Promise<Patient[]> {
  try {
    if (!phone) return [];

    // Check both phone and communicationPhone fields
    const patientsRef = collection(db, 'patients');

    // Method 1: Fetch all and filter (safest for small datasets, but inefficient for large ones)
    // For now, let's assume we can query via 'communicationPhone' OR 'phone' manually

    const q1 = query(patientsRef, where('phone', '==', phone));
    const snap1 = await getDocs(q1);

    const q2 = query(patientsRef, where('communicationPhone', '==', phone));
    const snap2 = await getDocs(q2);

    const patientsMap = new Map<string, Patient>();

    snap1.docs.forEach(doc => patientsMap.set(doc.id, { id: doc.id, ...doc.data() } as Patient));
    snap2.docs.forEach(doc => patientsMap.set(doc.id, { id: doc.id, ...doc.data() } as Patient));

    return Array.from(patientsMap.values());
  } catch (error) {
    console.error('Error fetching related patients:', error);
    return [];
  }
}

/**
 * Fetch patient by ID
 */
export async function fetchPatientById(id: string): Promise<Patient | null> {
  try {
    const patientRef = doc(db, 'patients', id);
    const snapshot = await getDoc(patientRef);

    if (snapshot.exists()) {
      return { id: snapshot.id, ...snapshot.data() } as Patient;
    }
    return null;
  } catch (error) {
    console.error('Error fetching patient:', error);
    return null;
  }
}

/**
 * Fetch appointments for a specific patient
 */
export async function fetchAppointmentsByPatientId(patientId: string): Promise<Appointment[]> {
  try {
    const appointmentsRef = collection(db, 'appointments');
    const q = query(appointmentsRef, where('patientId', '==', patientId));
    const snapshot = await getDocs(q);

    return snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    })) as Appointment[];
  } catch (error) {
    console.error('Error fetching patient appointments:', error);
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



export interface PunctualityLog {
  id: string;
  clinicId: string;
  doctorId: string;
  doctorName: string;
  date: string;
  sessionIndex: number | null;
  type: 'IN' | 'OUT' | 'BREAK_START' | 'BREAK_END' | 'EXTENSION';
  timestamp: any;
  scheduledTime: string | null;
  metadata: any;
}

/**
 * Fetch all doctor punctuality logs
 */
export async function fetchPunctualityLogs(): Promise<PunctualityLog[]> {
  try {
    const logsRef = collection(db, 'doctor_punctuality_logs');
    const q = query(logsRef, orderBy('timestamp', 'desc'));
    const snapshot = await getDocs(q);

    return snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    })) as PunctualityLog[];
  } catch (error) {
    console.error('Error fetching punctuality logs:', error);
    return [];
  }
}
