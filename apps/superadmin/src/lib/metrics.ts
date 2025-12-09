import { Timestamp } from 'firebase/firestore';

/**
 * Calculate growth percentage between two values
 */
export function calculateGrowthPercentage(current: number, previous: number): number {
  if (previous === 0) return current > 0 ? 100 : 0;
  return ((current - previous) / previous) * 100;
}

/**
 * Format growth percentage with sign
 */
export function formatGrowthPercentage(current: number, previous: number): string {
  const growth = calculateGrowthPercentage(current, previous);
  if (growth === 0) return '0%';
  const sign = growth > 0 ? '+' : '';
  return `${sign}${growth.toFixed(1)}%`;
}

/**
 * Calculate retention rate for specified days
 * Patients who came back within N days of first booking
 */
export function calculate30DayRetention(
  allPatients: Array<{ id: string; firstBookingDate?: any }>,
  appointments: Array<{ patientId: string; date: string; createdAt?: any }>,
  days: number = 30
): number {
  // Group appointments by patient
  const patientAppointments = new Map<string, Date[]>();
  
  appointments.forEach((apt) => {
    if (!patientAppointments.has(apt.patientId)) {
      patientAppointments.set(apt.patientId, []);
    }
    
    let aptDate: Date;
    if (apt.createdAt) {
      aptDate = apt.createdAt.toDate ? apt.createdAt.toDate() : new Date(apt.createdAt);
    } else {
      // Parse date string like "15 October 2024"
      aptDate = parseDateString(apt.date);
    }
    
    patientAppointments.get(apt.patientId)!.push(aptDate);
  });

  // Find patients who booked again within specified days
  let retainedPatients = 0;
  let totalPatientsWithMultipleBookings = 0;

  patientAppointments.forEach((aptDates, patientId) => {
    if (aptDates.length < 2) return; // Need at least 2 bookings
    
    totalPatientsWithMultipleBookings++;
    const sortedDates = aptDates.sort((a, b) => a.getTime() - b.getTime());
    const firstBooking = sortedDates[0];
    
    // Check if second booking is within specified days
    const secondBooking = sortedDates[1];
    const daysDiff = Math.floor((secondBooking.getTime() - firstBooking.getTime()) / (1000 * 60 * 60 * 24));
    
    if (daysDiff <= days) {
      retainedPatients++;
    }
  });

  if (totalPatientsWithMultipleBookings === 0) return 0;
  return (retainedPatients / totalPatientsWithMultipleBookings) * 100;
}

/**
 * Calculate Monthly Active Users (MAU)
 */
export function calculateMAU(
  appointments: Array<{ createdAt?: any; date?: string }>,
  targetMonth: Date
): number {
  const monthStart = new Date(targetMonth.getFullYear(), targetMonth.getMonth(), 1);
  const monthEnd = new Date(targetMonth.getFullYear(), targetMonth.getMonth() + 1, 0);
  
  const uniquePatients = new Set<string>();
  
  appointments.forEach((apt) => {
    let aptDate: Date;
    if (apt.createdAt) {
      aptDate = apt.createdAt.toDate ? apt.createdAt.toDate() : new Date(apt.createdAt);
    } else if (apt.date) {
      aptDate = parseDateString(apt.date);
    } else {
      return;
    }
    
    if (aptDate >= monthStart && aptDate <= monthEnd) {
      // Extract patient ID from appointment
      uniquePatients.add((apt as any).patientId || '');
    }
  });
  
  return uniquePatients.size;
}

/**
 * Calculate clinic health score (0-100)
 */
export function calculateClinicHealth(
  clinic: {
    registrationDate?: any;
    onboardingStatus?: string;
    currentDoctorCount?: number;
    numDoctors?: number;
  },
  appointments: Array<{ date: string; createdAt?: any }>,
  last30Days: Date
): number {
  let score = 0;
  
  // Onboarding status (20 points)
  if (clinic.onboardingStatus === 'Completed') {
    score += 20;
  } else if (clinic.onboardingStatus === 'Pending') {
    score += 10;
  }
  
  // Doctor count (20 points)
  const currentDoctors = clinic.currentDoctorCount || 0;
  const targetDoctors = clinic.numDoctors || 1;
  score += Math.min(20, (currentDoctors / targetDoctors) * 20);
  
  // Activity (60 points) - based on appointments in last 30 days
  const thirtyDaysAgo = new Date(last30Days.getTime() - 30 * 24 * 60 * 60 * 1000);
  const recentAppointments = appointments.filter((apt) => {
    let aptDate: Date;
    if (apt.createdAt) {
      aptDate = apt.createdAt.toDate ? apt.createdAt.toDate() : new Date(apt.createdAt);
    } else {
      aptDate = parseDateString(apt.date);
    }
    return aptDate >= thirtyDaysAgo;
  }).length;
  
  // Scale: 0 appointments = 0 points, 100+ appointments = 60 points
  score += Math.min(60, (recentAppointments / 100) * 60);
  
  return Math.round(score);
}

/**
 * Parse date string like "15 October 2024" to Date object (shared with analytics.ts)
 */
export function parseDateString(dateStr: string): Date {
  try {
    // Handle format "d MMMM yyyy"
    const months: Record<string, number> = {
      'january': 0, 'february': 1, 'march': 2, 'april': 3,
      'may': 4, 'june': 5, 'july': 6, 'august': 7,
      'september': 8, 'october': 9, 'november': 10, 'december': 11
    };
    
    const parts = dateStr.toLowerCase().split(' ');
    if (parts.length === 3) {
      const day = parseInt(parts[0]);
      const month = months[parts[1]];
      const year = parseInt(parts[2]);
      
      if (!isNaN(day) && month !== undefined && !isNaN(year)) {
        return new Date(year, month, day);
      }
    }
  } catch (e) {
    // Fallback
  }
  
  return new Date(dateStr);
}

/**
 * Convert Firestore timestamp to Date
 */
export function firestoreTimestampToDate(timestamp: any): Date | null {
  if (!timestamp) return null;
  
  try {
    if (timestamp.toDate && typeof timestamp.toDate === 'function') {
      return timestamp.toDate();
    }
    if (timestamp.seconds) {
      return new Date(timestamp.seconds * 1000);
    }
    if (timestamp instanceof Date) {
      return timestamp;
    }
    if (typeof timestamp === 'string') {
      return new Date(timestamp);
    }
  } catch (e) {
    console.error('Error converting timestamp:', e);
  }
  
  return null;
}

