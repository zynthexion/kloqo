import { collection, query, where, orderBy, getDocs, getDoc, Firestore, runTransaction, doc, serverTimestamp, type Transaction, type DocumentReference, type DocumentSnapshot } from 'firebase/firestore';
import { format, addMinutes, differenceInMinutes, isAfter, isBefore, subMinutes, parse, parseISO } from 'date-fns';
import type { Doctor, Appointment } from '@kloqo/shared-types';
import { computeWalkInSchedule, type SchedulerAssignment } from './walk-in-scheduler';
import { logger } from '../lib/logger';
import { getClinicNow, getClinicDayOfWeek, getClinicDateString, getClinicTimeString, parseClinicDate, parseClinicTime } from '../utils/date-utils';
import {
  applyBreakOffsets,
  isSlotBlockedByLeave,
  parseTime as parseTimeString
} from '../utils/break-helpers';

const DEBUG_BOOKING = process.env.NEXT_PUBLIC_DEBUG_BOOKING === 'true';

const ACTIVE_STATUSES = new Set(['Pending', 'Confirmed', 'Skipped', 'Completed']);
const MAX_TRANSACTION_ATTEMPTS = 5;
const RESERVATION_CONFLICT_CODE = 'slot-reservation-conflict';

/**
 * Normalizes a slotIndex by stripping the "Force Book" offset (10000+) 
 * and converting it to a relative index within its session (0-999).
 */
const toRelativeIndex = (idx: number, sessionBase: number) => {
  let relative = idx % 10000;
  return relative >= sessionBase ? relative - sessionBase : relative;
};

import { generateOnlineTokenNumber, generateWalkInTokenNumber } from '../utils/token-utils';

function getTaggedId(appt: any): string {
  if (appt.id === '__new_walk_in__') return appt.id;
  if (appt.cancelledByBreak || appt.bookedVia === 'BreakBlock') return `__break_${appt.id}`;
  if (appt.status === 'Completed' || appt.status === 'No-show') return `__blocked_${appt.id}`;
  return `__shiftable_${appt.id}`;
}

export interface DailySlot {
  index: number;
  time: Date;
  sessionIndex: number;
}

export interface LoadedDoctor {
  doctor: Doctor;
  slots: DailySlot[];
}

export async function loadDoctorAndSlots(
  firestore: Firestore,
  clinicId: string,
  doctorName: string,
  date: Date,
  doctorId?: string
): Promise<LoadedDoctor> {
  let doctor: Doctor | null = null;

  if (doctorId) {
    const doctorRef = doc(firestore, 'doctors', doctorId);
    const doctorSnap = await getDoc(doctorRef);
    if (doctorSnap.exists()) {
      doctor = { id: doctorSnap.id, ...doctorSnap.data() } as Doctor;
    }
  }

  if (!doctor) {
    const doctorsRef = collection(firestore, 'doctors');
    const doctorQuery = query(
      doctorsRef,
      where('clinicId', '==', clinicId),
      where('name', '==', doctorName)
    );
    const doctorSnapshot = await getDocs(doctorQuery);

    if (!doctorSnapshot.empty) {
      const doctorDoc = doctorSnapshot.docs[0];
      doctor = { id: doctorDoc.id, ...doctorDoc.data() } as Doctor;
    }
  }

  if (!doctor) {
    throw new Error('Doctor not found for booking.');
  }

  if (!doctor.availabilitySlots || doctor.availabilitySlots.length === 0) {
    throw new Error('Doctor availability information is missing.');
  }

  const dayOfWeek = getClinicDayOfWeek(date);
  const availabilityForDay = doctor.availabilitySlots.find(slot => slot.day === dayOfWeek);

  if (!availabilityForDay || !availabilityForDay.timeSlots?.length) {
    throw new Error('Doctor is not available on the selected date.');
  }

  const slotDuration = doctor.averageConsultingTime || 15;
  const slots: DailySlot[] = [];
  let slotIndex = 0;

  // Check for availability extension (session-specific)
  const dateStr = getClinicDateString(date);
  const extensionForDate = doctor.availabilityExtensions?.[dateStr];

  availabilityForDay.timeSlots.forEach((session, sessionIndex) => {
    let currentTime = parseTimeString(session.from, date);
    let endTime = parseTimeString(session.to, date);

    const sessionExtension = (extensionForDate as any)?.sessions?.find((s: any) => s.sessionIndex === sessionIndex);
    if (sessionExtension) {
      const newEndTimeStr = sessionExtension.newEndTime;
      // ALWAYS use extended time if it exists in the model
      // This ensures all appointments have a corresponding slot in the slots array
      // The 85% capacity rule should be enforced by looking at original session bounds,
      // not by hiding physical slots from the array.
      if (newEndTimeStr) {
        try {
          const extendedEndTime = parseTimeString(newEndTimeStr, date);
          // Only use extended time if it's actually later than the original end time
          if (isAfter(extendedEndTime, endTime)) {
            endTime = extendedEndTime;
          }
        } catch (error) {
          console.error('Error parsing extended end time, using original:', error);
        }
      }
    }

    while (isBefore(currentTime, endTime)) {
      // CRITICAL FIX: Include ALL physical slots to ensure Absolute Indexing matches appointment-service.ts
      // Previously, we skipped blocked slots, which shifted indices (e.g., 11:25 became slot 5 instead of 11).
      // Now we push every slot. Blocked slots will validly exist at their correct index.
      // The scheduler will see them as occupied (via BreakBlock appointments) and skip them naturally.
      slots.push({ index: slotIndex, time: new Date(currentTime), sessionIndex });
      currentTime = addMinutes(currentTime, slotDuration);
      slotIndex += 1;
    }
  });

  if (slots.length === 0) {
    throw new Error('No slots could be generated for the selected date.');
  }

  return { doctor, slots };
}

export async function fetchDayAppointments(
  firestore: Firestore,
  clinicId: string,
  doctorName: string,
  date: Date
): Promise<Appointment[]> {
  const dateStr = getClinicDateString(date);
  const appointmentsRef = collection(firestore, 'appointments');
  const appointmentsQuery = query(
    appointmentsRef,
    where('clinicId', '==', clinicId),
    where('doctor', '==', doctorName),
    where('date', '==', dateStr)
  );
  const snapshot = await getDocs(appointmentsQuery);
  return snapshot.docs.map(d => ({ id: d.id, ...d.data() } as any as Appointment));
}

export function buildOccupiedSlotSet(appointments: Appointment[]): Set<number> {
  const occupied = new Set<number>();

  appointments.forEach(appointment => {
    const slotIndex = appointment.slotIndex;
    if (typeof slotIndex === 'number' && ACTIVE_STATUSES.has(appointment.status)) {
      occupied.add(slotIndex);
    }
  });

  return occupied;
}

export function getSlotTime(slots: DailySlot[], slotIndex: number): Date | null {
  const slot = slots.find(s => s.index === slotIndex);
  return slot ? slot.time : null;
}

/**
 * Calculate reserved walk-in slots per session (15% of FUTURE slots only in each session)
 * This dynamically adjusts as time passes - reserved slots are recalculated based on remaining future slots
 * Returns a Set of slot indices that are reserved for walk-ins
 */
export function calculatePerSessionReservedSlots(slots: DailySlot[], now: Date = getClinicNow()): Set<number> {
  const reservedSlots = new Set<number>();

  // Group slots by sessionIndex
  const slotsBySession = new Map<number, DailySlot[]>();
  slots.forEach(slot => {
    const sessionSlots = slotsBySession.get(slot.sessionIndex) || [];
    sessionSlots.push(slot);
    slotsBySession.set(slot.sessionIndex, sessionSlots);
  });

  // For each session, calculate 15% reserve (last 15% of FUTURE slots in that session)
  slotsBySession.forEach((sessionSlots, sessionIndex) => {
    // Sort slots by index to ensure correct order
    sessionSlots.sort((a, b) => a.index - b.index);

    // Filter to only future slots (including current time)
    const futureSlots = sessionSlots.filter(slot =>
      isAfter(slot.time, now) || slot.time.getTime() >= now.getTime()
    );

    if (futureSlots.length === 0) {
      return; // No future slots, no reserved slots
    }

    const futureSlotCount = futureSlots.length;
    const minimumWalkInReserve = Math.ceil(futureSlotCount * 0.15);
    const reservedWSlotsStart = futureSlotCount - minimumWalkInReserve;

    // Mark the last 15% of FUTURE slots in this session as reserved
    for (let i = reservedWSlotsStart; i < futureSlotCount; i++) {
      reservedSlots.add(futureSlots[i].index);
    }
  });

  return reservedSlots;
}

type CandidateOptions = {
  appointments?: Appointment[];
  walkInSpacing?: number;
};

export function buildCandidateSlots(
  type: 'A' | 'W',
  slots: DailySlot[],
  now: Date,
  occupied: Set<number>,
  preferredSlotIndex?: number,
  options: CandidateOptions = {}
): number[] {
  const oneHourFromNow = addMinutes(now, 60);
  const candidates: number[] = [];

  // Calculate reserved walk-in slots per session (15% of FUTURE slots only in each session)
  const reservedWSlots = calculatePerSessionReservedSlots(slots, now);

  const addCandidate = (slotIndex: number) => {
    if (
      slotIndex >= 0 &&
      slotIndex < slots.length &&
      !occupied.has(slotIndex) &&
      !candidates.includes(slotIndex)
    ) {
      // CRITICAL: For advance bookings, NEVER allow slots reserved for walk-ins (last 15% of each session)
      if (type === 'A' && reservedWSlots.has(slotIndex)) {
        const slot = slots.find(s => s.index === slotIndex);
        console.log(`[SLOT FILTER] Rejecting slot ${slotIndex} - reserved for walk-ins in session ${slot?.sessionIndex}`);
        return; // Skip reserved walk-in slots
      }
      candidates.push(slotIndex);
    }
  };

  if (type === 'A') {
    if (typeof preferredSlotIndex === 'number') {
      const slotTime = getSlotTime(slots, preferredSlotIndex);
      const preferredSlot = slots.find(s => s.index === preferredSlotIndex);
      const preferredSessionIndex = preferredSlot?.sessionIndex;

      // CRITICAL: Also check if preferred slot is not reserved for walk-ins
      // This prevents booking cancelled slots that are in the reserved walk-in range (last 15% of session)
      if (reservedWSlots.has(preferredSlotIndex)) {
        console.log(`[SLOT FILTER] Rejecting preferred slot ${preferredSlotIndex} - reserved for walk-ins in session ${preferredSessionIndex}`);
      } else if (slotTime && isAfter(slotTime, oneHourFromNow)) {
        addCandidate(preferredSlotIndex);
      } else {
        console.log(`[SLOT FILTER] Rejecting preferred slot ${preferredSlotIndex} - within 1 hour from now`);
      }

      // CRITICAL: If preferred slot is not available, only look for alternatives within the SAME session
      // This ensures bookings stay within the same sessionIndex and don't cross session boundaries
      if (candidates.length === 0 && typeof preferredSessionIndex === 'number') {
        slots.forEach(slot => {
          // Only consider slots in the same session as the preferred slot
          if (
            slot.sessionIndex === preferredSessionIndex &&
            isAfter(slot.time, oneHourFromNow) &&
            !reservedWSlots.has(slot.index)
          ) {
            addCandidate(slot.index);
          }
        });
      }
    } else {
      // No preferred slot - look across all sessions
      slots.forEach(slot => {
        // CRITICAL: Only add slots that are after 1 hour AND not reserved for walk-ins (per session)
        if (isAfter(slot.time, oneHourFromNow) && !reservedWSlots.has(slot.index)) {
          addCandidate(slot.index);
        }
      });
    }
  } else {
    const activeAppointments =
      options.appointments
        ?.filter(
          appointment =>
            typeof appointment.slotIndex === 'number' && ACTIVE_STATUSES.has(appointment.status),
        )
        .sort((a, b) => (a.slotIndex! < b.slotIndex! ? -1 : 1)) ?? [];

    const walkInSpacing =
      typeof options.walkInSpacing === 'number' && options.walkInSpacing > 0
        ? options.walkInSpacing
        : Number.POSITIVE_INFINITY;

    const getATokens = (filterFn?: (appointment: Appointment) => boolean) =>
      activeAppointments.filter(
        appointment =>
          appointment.bookedVia !== 'Walk-in' &&
          (typeof appointment.slotIndex === 'number') &&
          (!filterFn || filterFn(appointment)),
      );

    const getSlotIndexAfterNthA = (afterSlotIndex: number, nth: number): number => {
      let count = 0;
      for (const appointment of activeAppointments) {
        if (appointment.bookedVia === 'Walk-in') continue;
        const slotIndex = appointment.slotIndex!;
        if (slotIndex > afterSlotIndex) {
          count += 1;
          if (count === nth) {
            return slotIndex;
          }
        }
      }
      return -1;
    };

    slots.forEach(slot => {
      if (!isBefore(slot.time, now) && !isAfter(slot.time, oneHourFromNow)) {
        addCandidate(slot.index);
      }
    });

    if (candidates.length > 0) {
      return candidates;
    }

    const availableAfterHour = slots.filter(
      slot => isAfter(slot.time, oneHourFromNow) && !occupied.has(slot.index),
    );

    if (availableAfterHour.length === 0) {
      return candidates;
    }

    if (walkInSpacing === Number.POSITIVE_INFINITY || activeAppointments.length === 0) {
      availableAfterHour.forEach(slot => addCandidate(slot.index));
      return candidates;
    }

    const walkInAppointments = activeAppointments.filter(appointment => appointment.bookedVia === 'Walk-in');
    const lastWalkInSlotIndex =
      walkInAppointments.length > 0
        ? Math.max(...walkInAppointments.map(appointment => appointment.slotIndex!))
        : null;

    let minSlotIndex = -1;

    if (lastWalkInSlotIndex === null) {
      const aTokens = getATokens();
      if (aTokens.length > walkInSpacing) {
        const slotAfterNth = getSlotIndexAfterNthA(-1, walkInSpacing);
        minSlotIndex =
          slotAfterNth >= 0 ? slotAfterNth : aTokens[aTokens.length - 1]?.slotIndex ?? -1;
      } else {
        minSlotIndex = aTokens[aTokens.length - 1]?.slotIndex ?? -1;
      }
    } else {
      const aTokensAfterLastWalkIn = getATokens(appointment => appointment.slotIndex! > lastWalkInSlotIndex);
      if (aTokensAfterLastWalkIn.length > walkInSpacing) {
        const slotAfterNth = getSlotIndexAfterNthA(lastWalkInSlotIndex, walkInSpacing);
        if (slotAfterNth >= 0) {
          minSlotIndex = slotAfterNth;
        } else {
          const allATokens = getATokens();
          minSlotIndex = allATokens[allATokens.length - 1]?.slotIndex ?? lastWalkInSlotIndex;
        }
      } else {
        const allATokens = getATokens();
        const lastASlotIndex = allATokens[allATokens.length - 1]?.slotIndex ?? lastWalkInSlotIndex;
        minSlotIndex = Math.max(lastWalkInSlotIndex, lastASlotIndex);
      }
    }

    const filteredAfterHour = availableAfterHour.filter(slot => slot.index > minSlotIndex);

    if (filteredAfterHour.length === 0) {
      availableAfterHour.forEach(slot => addCandidate(slot.index));
    } else {
      filteredAfterHour.forEach(slot => addCandidate(slot.index));
    }
  }

  return candidates;
}

export interface TokenCounterState {
  nextNumber: number;
  exists: boolean;
}

export async function prepareNextTokenNumber(
  transaction: Transaction,
  counterRef: DocumentReference
): Promise<TokenCounterState> {
  const counterDoc = await transaction.get(counterRef);

  if (counterDoc.exists()) {
    const currentCount = counterDoc.data()?.count || 0;
    return {
      nextNumber: currentCount + 1,
      exists: true,
    };
  }

  return { nextNumber: 1, exists: false };
}

export function commitNextTokenNumber(
  transaction: Transaction,
  counterRef: DocumentReference,
  state: TokenCounterState
): void {
  if (state.exists) {
    transaction.update(counterRef, {
      count: state.nextNumber,
      lastUpdated: serverTimestamp(),
    });
    return;
  }

  transaction.set(counterRef, {
    count: state.nextNumber,
    lastUpdated: serverTimestamp(),
    createdAt: serverTimestamp(),
  });
}

function toDate(value: unknown): Date | null {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return value;
  }

  if (typeof (value as { toDate?: () => Date }).toDate === 'function') {
    return (value as { toDate: () => Date }).toDate();
  }

  if (typeof value === 'number') {
    return new Date(value);
  }

  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.valueOf()) ? null : parsed;
  }

  return null;
}

export async function generateNextToken(
  firestore: Firestore,
  clinicId: string,
  doctorName: string,
  date: Date,
  type: 'A' | 'W'
): Promise<string> {
  const dateStr = getClinicDateString(date);
  const counterDocId = `${clinicId}_${doctorName}_${dateStr}${type === 'W' ? '_W' : ''}`
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_]/g, '');
  const counterRef = doc(firestore, 'token-counters', counterDocId);

  const tokenNumber = await runTransaction(firestore, async transaction => {
    const counterState = await prepareNextTokenNumber(transaction, counterRef);
    commitNextTokenNumber(transaction, counterRef, counterState);
    return `${type}${String(counterState.nextNumber + (type === 'W' ? 100 : 0)).padStart(3, '0')}`;
  });

  return tokenNumber;
}

export function buildReservationDocId(
  clinicId: string,
  doctorName: string,
  dateStr: string,
  slotIndex: number
): string {
  return `${clinicId}_${doctorName}_${dateStr}_slot_${slotIndex}`
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_]/g, '');
}

function isReservationConflict(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  // Check for custom reservation conflict code
  if (
    error.message === RESERVATION_CONFLICT_CODE ||
    (typeof (error as { code?: string }).code === 'string' &&
      (error as { code?: string }).code === RESERVATION_CONFLICT_CODE)
  ) {
    return true;
  }

  // Firestore transaction conflicts occur when multiple transactions try to modify the same document
  // These typically have code 'failed-precondition' or 'aborted'
  const firestoreError = error as { code?: string; message?: string };
  if (typeof firestoreError.code === 'string') {
    return (
      firestoreError.code === 'failed-precondition' ||
      firestoreError.code === 'aborted' ||
      firestoreError.code === 'already-exists' ||
      (firestoreError.message?.includes('transaction') ?? false)
    );
  }

  return false;
}

export async function generateNextTokenAndReserveSlot(
  firestore: Firestore,
  clinicId: string,
  doctorName: string,
  date: Date,
  type: 'A' | 'W',
  appointmentData: {
    time?: string;
    slotIndex?: number;
    doctorId?: string;
    existingAppointmentId?: string;
    [key: string]: unknown;
  }
): Promise<{
  tokenNumber: string;
  numericToken: number;
  slotIndex: number;
  sessionIndex: number;
  time: string;
  reservationId: string;
}> {
  const dateStr = getClinicDateString(date);
  const now = getClinicNow();
  const counterDocId = `${clinicId}_${doctorName}_${dateStr}${type === 'W' ? '_W' : ''}`
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_]/g, '');
  const counterRef = doc(firestore, 'token-counters', counterDocId);

  // PERFORMANCE OPTIMIZATION: Parallelize initial data fetches
  // After: Parallel fetches take ~300-800ms (40% faster)
  const fetchPromises: [
    Promise<LoadedDoctor>,
    Promise<DocumentSnapshot | null>,
    Promise<Appointment[]>
  ] = [
      loadDoctorAndSlots(
        firestore,
        clinicId,
        doctorName,
        date,
        typeof appointmentData.doctorId === 'string' ? appointmentData.doctorId : undefined
      ),
      type === 'W' ? getDoc(doc(firestore, 'clinics', clinicId)) : Promise.resolve(null),
      fetchDayAppointments(firestore, clinicId, doctorName, date)
    ];

  const [{ doctor, slots: allSlots }, clinicSnap, preFetchAppointments] = await Promise.all(fetchPromises);

  // Generate request ID early for logging throughout the function
  const requestId = `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  let walkInSpacingValue = 0;
  if (type === 'W' && clinicSnap?.exists()) {
    const rawSpacing = Number(clinicSnap.data()?.walkInTokenAllotment ?? 0);
    walkInSpacingValue = Number.isFinite(rawSpacing) && rawSpacing > 0 ? Math.floor(rawSpacing) : 0;
  }

  // CRITICAL: For walk-in bookings, restrict to active session only
  // This prevents concurrent bookings from spilling over into distant future sessions
  let slots = allSlots;
  let activeSessionIndex: number | null = null;

  if (type === 'W') {
    // Identify "Active Session" for this walk-in
    // TODO: RESTORE ORIGINAL LOGIC AFTER TESTING.
    // Original logic: Picks the first session that matches the 30-minute window.
    // Testing logic: Picks the first session that hasn't ended AND has space, allowing overflow to Session 1+.
    activeSessionIndex = (() => {
      if (allSlots.length === 0) return 0;
      const sessionMap = new Map<number, { start: Date; end: Date }>();
      allSlots.forEach((s) => {
        const current = sessionMap.get(s.sessionIndex);
        if (!current) {
          sessionMap.set(s.sessionIndex, { start: s.time, end: s.time });
        } else {
          if (isBefore(s.time, current.start)) current.start = s.time;
          if (isAfter(s.time, current.end)) current.end = s.time;
        }
      });
      const sortedSessions = Array.from(sessionMap.entries()).sort((a, b) => a[0] - b[0]);
      for (const [sIdx, range] of sortedSessions) {
        // Session is active if now is before session end AND within 30 minutes of session start
        if (!isAfter(now, range.end) && !isBefore(now, subMinutes(range.start, 30))) {
          return sIdx;
        }
      }
      return null;
    })();

    if (activeSessionIndex === null) {
      console.error(`[BOOKING DEBUG] Request ${requestId}: No active session found for walk-in booking`, {
        now: now.toISOString(),
        sessions: Array.from(new Set(allSlots.map(s => s.sessionIndex))),
        timestamp: new Date().toISOString()
      });
      throw new Error('No walk-in slots are available. The next session has not started yet.');
    }

    // Filter slots to only include those in the active session
    slots = allSlots.filter((s) => s.sessionIndex === activeSessionIndex);

    console.log(`[BOOKING DEBUG] Request ${requestId}: Active session identified`, {
      activeSessionIndex,
      totalSlots: allSlots.length,
      sessionSlots: slots.length,
      timestamp: new Date().toISOString()
    });
  }

  const totalSlots = slots.length;
  // Use current time (already defined above) to calculate capacity based on future slots only

  // Calculate maximum advance tokens per session (85% of FUTURE slots in each session)
  // This dynamically adjusts as time passes - capacity is recalculated based on remaining future slots
  // Group slots by sessionIndex to calculate per-session capacity
  const slotsBySession = new Map<number, DailySlot[]>();
  slots.forEach(slot => {
    const sessionSlots = slotsBySession.get(slot.sessionIndex) || [];
    sessionSlots.push(slot);
    slotsBySession.set(slot.sessionIndex, sessionSlots);
  });

  let maximumAdvanceTokens = 0;
  let totalMinimumWalkInReserve = 0;

  const dayOfWeek = getClinicDayOfWeek(date);
  const availabilityForDay = (doctor.availabilitySlots || []).find((s: any) => s.day === dayOfWeek);
  const extensionForDate = (doctor as any).availabilityExtensions?.[dateStr];

  slotsBySession.forEach((sessionSlots, sessionIndex) => {
    // Determine the logical end of the session for capacity purposes
    const sessionSource = availabilityForDay?.timeSlots?.[sessionIndex];
    if (!sessionSource) return;

    const originalSessionEndTime = parseTimeString(sessionSource.to, date);
    let capacityBasisEndTime = originalSessionEndTime;

    const sessionExtension = (extensionForDate as any)?.sessions?.find((s: any) => s.sessionIndex === sessionIndex);
    if (sessionExtension && sessionExtension.newEndTime) {
      const hasActiveBreaks = sessionExtension.breaks && sessionExtension.breaks.length > 0;
      if (hasActiveBreaks) {
        try {
          capacityBasisEndTime = parseTimeString(sessionExtension.newEndTime, date);
        } catch (e) {
          console.error('Error parsing extension time for capacity:', e);
        }
      }
    }

    // Filter slots to only include those within the current capacity basis
    const capacityBasisSlots = sessionSlots.filter(slot => isBefore(slot.time, capacityBasisEndTime));

    // Calculate reserve based on future slots within the capacity basis
    const futureCapacitySlots = capacityBasisSlots.filter(slot =>
      isAfter(slot.time, now) || slot.time.getTime() >= now.getTime()
    );

    const futureSlotCount = futureCapacitySlots.length;
    const sessionMinimumWalkInReserve = futureSlotCount > 0 ? Math.ceil(futureSlotCount * 0.15) : 0;
    const sessionAdvanceCapacity = Math.max(futureSlotCount - sessionMinimumWalkInReserve, 0);

    maximumAdvanceTokens += sessionAdvanceCapacity;
    totalMinimumWalkInReserve += sessionMinimumWalkInReserve;
  });

  console.log(`[BOOKING DEBUG] Capacity calculation for ${dateStr}`, {
    totalSlots,
    maximumAdvanceTokens,
    sessions: slotsBySession.size,
    timestamp: new Date().toISOString()
  });

  const appointmentsRef = collection(firestore, 'appointments');
  const appointmentsQuery = query(
    appointmentsRef,
    where('clinicId', '==', clinicId),
    where('doctor', '==', doctorName),
    where('date', '==', dateStr),
    orderBy('slotIndex', 'asc')
  );

  console.log(`[BOOKING DEBUG] ====== NEW BOOKING REQUEST (PATIENT APP) ======`, {
    requestId,
    clinicId,
    doctorName,
    date: dateStr,
    type,
    preferredSlotIndex: appointmentData.slotIndex,
    timestamp: new Date().toISOString()
  });

  for (let attempt = 0; attempt < MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
    const appointmentsSnapshot = await getDocs(appointmentsQuery);
    const appointmentDocRefs = appointmentsSnapshot.docs.map(docSnap => doc(firestore, 'appointments', docSnap.id));

    console.log(`[BOOKING DEBUG] Request ${requestId}: Attempt ${attempt + 1}/${MAX_TRANSACTION_ATTEMPTS}`, {
      existingAppointmentsCount: appointmentsSnapshot.docs.length,
      timestamp: new Date().toISOString()
    });

    try {
      // Add timeout wrapper for Safari compatibility
      const transactionPromise = runTransaction(firestore, async transaction => {
        console.log(`[BOOKING DEBUG] Request ${requestId}: Transaction STARTED (attempt ${attempt + 1})`, {
          timestamp: new Date().toISOString(),
          userAgent: typeof (globalThis as any).navigator !== 'undefined' ? (globalThis as any).navigator.userAgent : 'unknown'
        });

        // CRITICAL: Only prepare counter for walk-ins, not for advance bookings
        // Advance bookings use slotIndex + 1 for tokens, so counter is not needed
        let counterState: TokenCounterState | null = null;

        if (type === 'W') {
          console.log(`[BOOKING DEBUG] Request ${requestId}: About to prepare token counter (walk-in)`, {
            counterRef: counterRef.path,
            timestamp: new Date().toISOString()
          });

          counterState = await prepareNextTokenNumber(transaction, counterRef);

          console.log(`[BOOKING DEBUG] Request ${requestId}: Token counter prepared`, {
            nextNumber: counterState.nextNumber,
            timestamp: new Date().toISOString()
          });
        } else {
          console.log(`[BOOKING DEBUG] Request ${requestId}: Skipping counter preparation (advance booking)`, {
            timestamp: new Date().toISOString()
          });
        }

        console.log(`[BOOKING DEBUG] Request ${requestId}: About to read ${appointmentDocRefs.length} appointments`, {
          appointmentCount: appointmentDocRefs.length,
          timestamp: new Date().toISOString()
        });

        const appointmentSnapshots = await Promise.all(appointmentDocRefs.map(ref => transaction.get(ref)));

        console.log(`[BOOKING DEBUG] Request ${requestId}: Appointments read successfully`, {
          appointmentCount: appointmentSnapshots.length,
          timestamp: new Date().toISOString()
        });
        const appointments = appointmentSnapshots
          .filter(snapshot => snapshot.exists())
          .map(snapshot => {
            const data = snapshot.data() as Appointment;
            return { ...data, id: snapshot.id };
          });

        const excludeAppointmentId =
          typeof appointmentData.existingAppointmentId === 'string' ? appointmentData.existingAppointmentId : undefined;
        let effectiveAppointments = excludeAppointmentId
          ? appointments.filter(appointment => appointment.id !== excludeAppointmentId)
          : appointments;

        // CRITICAL: For walk-in bookings, filter appointments to only include those in the active session
        // This prevents the scheduler from considering appointments in other sessions
        if (type === 'W' && activeSessionIndex !== null) {
          const currentSessionStart = slots.length > 0 ? slots[0].time : null;

          effectiveAppointments = effectiveAppointments.filter(appointment => {
            // Priority 1: Map via slotIndex if valid (Standard Slots)
            // This is the most reliable check for standard appointments
            if (typeof appointment.slotIndex === 'number' && appointment.slotIndex < allSlots.length) {
              return allSlots[appointment.slotIndex]?.sessionIndex === activeSessionIndex;
            }

            // Priority 2: Use sessionIndex BUT verify with Time if available
            // "Force Booked" appointments often have high slot indices and might have incorrect sessionIndex
            if (appointment.sessionIndex === activeSessionIndex) {
              // Verify time to catch "ghost" appointments from previous sessions (e.g. 3:35 PM in 4:00 PM session)
              if (appointment.time && currentSessionStart) {
                try {
                  const aptTime = parseTimeString(appointment.time, date);
                  // If appointment is more than 30 mins before session start, it definitely belongs to previous session
                  // (Allowing 30 mins buffer for potential early starts/overlaps, but 3:35 vs 4:00 is tight. 
                  // Standard break is usually > 30 mins. Re-using 20 mins as safe buffer)
                  if (isBefore(aptTime, subMinutes(currentSessionStart, 20))) {
                    console.warn(`[BOOKING DEBUG] Filtering out appointment ${appointment.id} (Time: ${appointment.time}) from Session ${activeSessionIndex} (Start: ${getClinicTimeString(currentSessionStart)}) - likely erroneous sessionIndex`);
                    return false;
                  }
                } catch (e) {
                  // If time parsing fails, fallback to trusting sessionIndex
                }
              }
              return true;
            }
            return false;
          });

          console.log(`[BOOKING DEBUG] Request ${requestId}: Filtered appointments to active session`, {
            totalAppointments: appointments.length,
            sessionAppointments: effectiveAppointments.length,
            activeSessionIndex,
            timestamp: new Date().toISOString()
          });
        }

        if (DEBUG_BOOKING) {
          console.info('[patient booking] attempt', attempt, {
            type,
            clinicId,
            doctorName,
            totalSlots,
            effectiveAppointments: effectiveAppointments.map(a => ({ id: a.id, slotIndex: a.slotIndex, status: a.status, bookedVia: a.bookedVia })),
          });
        }

        if (type === 'A' && maximumAdvanceTokens >= 0) {
          const activeAdvanceTokens = effectiveAppointments.filter(appointment => {
            const appointmentTime = parseTimeString(appointment.time || '', date);
            const isFutureAppointment = isAfter(appointmentTime, now) || appointmentTime.getTime() >= now.getTime();

            return (
              appointment.bookedVia !== 'Walk-in' &&
              (appointment.bookedVia as string) !== 'BreakBlock' && // CRITICAL FIX: Breaks shouldn't count towards Advance Token Cap
              typeof appointment.slotIndex === 'number' &&
              isFutureAppointment &&
              ACTIVE_STATUSES.has(appointment.status) &&
              (!appointment.cancelledByBreak || appointment.status === 'Completed' || appointment.status === 'Skipped')
            );
          }).length;

          console.log(`[BOOKING DEBUG] Request ${requestId}: Capacity check (attempt ${attempt + 1})`, {
            activeAdvanceTokens,
            maximumAdvanceTokens,
            totalSlots,
            minimumWalkInReserve: totalMinimumWalkInReserve,
            willBlock: maximumAdvanceTokens === 0 || activeAdvanceTokens >= maximumAdvanceTokens,
            effectiveAppointmentsCount: effectiveAppointments.length,
            advanceAppointments: effectiveAppointments
              .filter(a => a.bookedVia !== 'Walk-in' && typeof a.slotIndex === 'number' && ACTIVE_STATUSES.has(a.status))
              .map(a => ({ id: a.id, slotIndex: a.slotIndex, status: a.status, tokenNumber: a.tokenNumber })),
            timestamp: new Date().toISOString()
          });

          if (maximumAdvanceTokens === 0 || activeAdvanceTokens >= maximumAdvanceTokens) {
            console.error(`[BOOKING DEBUG] Request ${requestId}: ❌ CAPACITY REACHED - Blocking advance booking`, {
              activeAdvanceTokens,
              maximumAdvanceTokens,
              timestamp: new Date().toISOString()
            });
            const capacityError = new Error('Advance booking capacity for the day has been reached.');
            (capacityError as { code?: string }).code = 'A_CAPACITY_REACHED';
            throw capacityError;
          }

          console.log(`[BOOKING DEBUG] Request ${requestId}: ✅ Capacity check passed`, {
            activeAdvanceTokens,
            maximumAdvanceTokens,
            remainingCapacity: maximumAdvanceTokens - activeAdvanceTokens,
            timestamp: new Date().toISOString()
          });
        }

        let numericToken: number = 0;
        let tokenNumber: string = '';
        let chosenSlotIndex = -1;
        let sessionIndexForNew = 0;
        let resolvedTimeString = '';
        let reservationRef: DocumentReference | null = null;

        // IMPORTANT: For advance bookings, DO NOT use counterState.nextNumber for token
        // Token will be assigned based on slotIndex after slot selection
        // This ensures token A001 = slot #1, A002 = slot #2, etc.

        if (type === 'W') {
          if (!counterState) {
            throw new Error('Counter state not prepared for walk-in booking');
          }
          const nextWalkInNumericToken = totalSlots + counterState.nextNumber + 100;
          const shiftPlan = await prepareAdvanceShift({
            transaction,
            firestore,
            clinicId,
            doctorName,
            dateStr,
            slots,
            totalSlots,
            doctor,
            now,
            walkInSpacingValue,
            effectiveAppointments,
            newWalkInNumericToken: nextWalkInNumericToken,
            forceBook: !!appointmentData.isForceBooked,
          });

          const { newAssignment, reservationDeletes, appointmentUpdates, usedBucketSlotIndex, existingReservations } = shiftPlan;

          if (!newAssignment) {
            throw new Error('Unable to schedule walk-in token.');
          }

          numericToken = nextWalkInNumericToken;
          tokenNumber = generateWalkInTokenNumber(numericToken, newAssignment.sessionIndex);

          // If we used a bucket slot, assign a NEW slotIndex at the end (don't reuse cancelled slot's index)
          let finalSlotIndex = newAssignment.slotIndex;
          let finalSessionIndex = newAssignment.sessionIndex;

          // CRITICAL: Calculate walk-in time based on the slot at finalSlotIndex
          // If the slot is within availability, use the slot's time directly
          // Otherwise, calculate based on previous appointment or scheduler time
          let walkInTime: Date;
          const slotDuration = doctor.averageConsultingTime || 15;

          if (finalSlotIndex < slots.length) {
            // Slot is within availability - use the slot's time directly (matches nurse app)
            const slotMeta = slots.find(s => s.index === finalSlotIndex);
            walkInTime = slotMeta ? slotMeta.time : newAssignment.slotTime;
          } else {
            // Slot is outside availability - calculate based on previous appointment
            if (finalSlotIndex > 0) {
              const appointmentBeforeWalkIn = effectiveAppointments
                .filter(appointment =>
                  appointment.bookedVia !== 'Walk-in' &&
                  typeof appointment.slotIndex === 'number' &&
                  appointment.slotIndex === finalSlotIndex - 1 &&
                  ACTIVE_STATUSES.has(appointment.status)
                )
                .sort((a, b) => {
                  const aIdx = typeof a.slotIndex === 'number' ? a.slotIndex : -1;
                  const bIdx = typeof b.slotIndex === 'number' ? b.slotIndex : -1;
                  return bIdx - aIdx; // Get the last one at that slot (should be only one)
                })[0];

              if (appointmentBeforeWalkIn && appointmentBeforeWalkIn.time) {
                try {
                  const appointmentDate = parse(dateStr, 'd MMMM yyyy', new Date());
                  const previousAppointmentTime = parse(
                    appointmentBeforeWalkIn.time,
                    'hh:mm a',
                    appointmentDate
                  );
                  // Walk-in time = previous appointment time (same time as previous appointment - matches nurse app)
                  walkInTime = previousAppointmentTime;
                } catch (e) {
                  // If parsing fails, use scheduler's time
                  walkInTime = newAssignment.slotTime;
                }
              } else {
                // No appointment before, use scheduler's time
                walkInTime = newAssignment.slotTime;
              }
            } else {
              // walkInSlotIndex is 0, use scheduler's time
              walkInTime = newAssignment.slotTime;
            }
          }

          let finalTimeString = getClinicTimeString(walkInTime);

          if (usedBucketSlotIndex !== null) {
            // Find the last slotIndex used across ALL sessions for this day
            // This ensures no conflicts between sessions
            const allSlotIndicesFromAppointments = effectiveAppointments
              .map(appointment => typeof appointment.slotIndex === 'number' ? appointment.slotIndex : -1)
              .filter(idx => idx >= 0);

            // Get the last slotIndex from the slots array (represents last slot in last session)
            // Slots are 0-indexed, so last slot index is slots.length - 1
            const lastSlotIndexFromSlots = slots.length > 0 ? slots.length - 1 : -1;

            // Take the maximum of:
            // 1. Highest slotIndex from all appointments (including walk-ins outside availability)
            // 2. Last slotIndex from slots array (last slot in last session)
            const maxSlotIndexFromAppointments = allSlotIndicesFromAppointments.length > 0
              ? Math.max(...allSlotIndicesFromAppointments)
              : -1;

            const maxSlotIndex = Math.max(maxSlotIndexFromAppointments, lastSlotIndexFromSlots);

            // New slotIndex is one more than the maximum found
            // This ensures it's after all existing slots/appointments across all sessions
            const newSlotIndex = maxSlotIndex + 1;

            console.info('[Walk-in Scheduling] Bucket compensation - finding last slotIndex:', {
              maxSlotIndexFromAppointments,
              lastSlotIndexFromSlots,
              maxSlotIndex,
              newSlotIndex,
              totalSlots: slots.length,
            });

            // Calculate time based on last slot across ALL sessions + slot duration
            // The lastSlot is the last slot in the last session (slots array is sequential across sessions)
            const lastSlot = slots[slots.length - 1];
            const slotDuration = doctor.averageConsultingTime || 15;

            // Calculate how many slots beyond availability we need
            // newSlotIndex is already calculated to be after all existing slots/appointments
            // So slotsBeyondAvailability = newSlotIndex - lastSlotIndexFromSlots
            const normalizedNewIndex = toRelativeIndex(newSlotIndex, 0); // Normalized to Session 0 global
            const normalizedLastIndex = toRelativeIndex(lastSlotIndexFromSlots, 0);
            const slotsBeyondAvailability = normalizedNewIndex - normalizedLastIndex;

            // Time = last slot time (from last session) + (slot duration * slots beyond availability)
            // This ensures the time is calculated correctly even when compensating for bucket in Session 2
            const newSlotTime = lastSlot
              ? addMinutes(lastSlot.time, slotDuration * slotsBeyondAvailability)
              : addMinutes(now, slotDuration);

            // Use new slotIndex at the end, with time calculated from last session
            finalSlotIndex = newSlotIndex;
            finalSessionIndex = lastSlot?.sessionIndex ?? newAssignment.sessionIndex;
            finalTimeString = getClinicTimeString(newSlotTime);

            console.info('[Walk-in Scheduling] Bucket compensation - time calculation:', {
              lastSlotIndexFromSlots,
              newSlotIndex,
              slotsBeyondAvailability,
              lastSlotTime: lastSlot?.time,
              newSlotTime,
              finalSessionIndex,
            });
          }

          // CRITICAL: All reads must happen before any writes
          // We already read the reservation in prepareAdvanceShift's loop
          // Now check if it exists in the map (no additional read needed)
          const reservationId = buildReservationDocId(clinicId, doctorName, dateStr, finalSlotIndex);
          const reservationDocRef = doc(firestore, 'slot-reservations', reservationId);

          if (existingReservations.has(finalSlotIndex)) {
            // Recent reservation exists - conflict
            const conflictError = new Error(RESERVATION_CONFLICT_CODE);
            (conflictError as { code?: string }).code = RESERVATION_CONFLICT_CODE;
            throw conflictError;
          }
          // If not in existingReservations, either:
          // 1. It doesn't exist (proceed)
          // 2. It was stale and already deleted (proceed)
          // Note: The reservation was already read in prepareAdvanceShift's loop,
          // so transaction.set() is safe here

          for (const ref of reservationDeletes) {
            transaction.delete(ref);
          }

          for (const update of appointmentUpdates) {
            transaction.update(update.docRef, {
              slotIndex: update.slotIndex,
              sessionIndex: update.sessionIndex,
              time: update.timeString,
              noShowTime: update.noShowTime,
              // CRITICAL: cutOffTime is NOT updated - it remains the same as the original appointment
            });
          }

          reservationRef = reservationDocRef;
          chosenSlotIndex = finalSlotIndex;
          sessionIndexForNew = finalSessionIndex;
          resolvedTimeString = finalTimeString;
        } else {
          // For advance bookings, token number should be based on slotIndex, not sequential counter
          // This ensures token A001 goes to slot #1, A002 to slot #2, etc.
          // We'll assign the token number after we know which slotIndex was chosen

          const occupiedSlots = buildOccupiedSlotSet(effectiveAppointments);
          const candidates = buildCandidateSlots(type, slots, now, occupiedSlots, appointmentData.slotIndex, {
            appointments: effectiveAppointments,
          });


          console.log(`[BOOKING DEBUG] Request ${requestId}: Candidate slots generated`, {
            totalCandidates: candidates.length,
            candidates: candidates,
            totalSlots,
            maximumAdvanceTokens,
            occupiedSlotsCount: occupiedSlots.size,
            occupiedSlots: Array.from(occupiedSlots),
            type,
            timestamp: new Date().toISOString()
          });

          if (candidates.length === 0) {
            const reservedWSlots = calculatePerSessionReservedSlots(slots, now);
            const reservedSlotsCount = reservedWSlots.size;
            console.error(`[BOOKING DEBUG] Request ${requestId}: ❌ NO CANDIDATE SLOTS AVAILABLE`, {
              type,
              totalSlots,
              maximumAdvanceTokens,
              reservedSlotsCount,
              occupiedSlotsCount: occupiedSlots.size,
              occupiedSlots: Array.from(occupiedSlots),
              oneHourFromNow: addMinutes(now, 60).toISOString(),
              timestamp: new Date().toISOString()
            });
            // If a preferred slot was provided, check if it's in a specific session
            if (typeof appointmentData.slotIndex === 'number') {
              const preferredSlot = slots.find(s => s.index === appointmentData.slotIndex);
              const sessionIndex = preferredSlot?.sessionIndex;
              throw new Error(
                `No available slots in session ${typeof sessionIndex === 'number' ? sessionIndex + 1 : 'selected'}. ` +
                `All slots in this session are either booked or reserved for walk-ins. Please select a different time slot.`
              );
            }
            throw new Error('No available slots match the booking rules.');
          }

          let rejectedCount = 0;
          let rejectedReasons: Record<string, number> = {
            occupied: 0,
            reservedForWalkIn: 0,
            alreadyReserved: 0,
            hasActiveAppointment: 0
          };

          for (const slotIndex of candidates) {
            if (occupiedSlots.has(slotIndex)) {
              rejectedReasons.occupied++;
              continue;
            }

            // CRITICAL: Double-check that this slot is NOT reserved for walk-ins (last 15% of FUTURE slots in its session)
            // This check happens inside the transaction to prevent race conditions
            // Even if buildCandidateSlots included it (shouldn't happen), we reject it here
            const reservedWSlots = calculatePerSessionReservedSlots(slots, now);
            if (type === 'A' && reservedWSlots.has(slotIndex)) {
              rejectedReasons.reservedForWalkIn++;
              const slot = slots.find(s => s.index === slotIndex);
              console.error(`[BOOKING DEBUG] Request ${requestId}: ⚠️ REJECTED - Slot ${slotIndex} is reserved for walk-ins in session ${slot?.sessionIndex}`, {
                slotIndex,
                sessionIndex: slot?.sessionIndex,
                type,
                timestamp: new Date().toISOString()
              });
              continue; // NEVER allow advance bookings to use reserved walk-in slots
            }

            const reservationId = buildReservationDocId(clinicId, doctorName, dateStr, slotIndex);
            const reservationDocRef = doc(firestore, 'slot-reservations', reservationId);

            console.log(`[BOOKING DEBUG] Request ${requestId}: Attempt ${attempt + 1}: Checking reservation for slot ${slotIndex}`, {
              reservationId,
              timestamp: new Date().toISOString()
            });

            // CRITICAL: Check reservation inside transaction - this ensures we see the latest state
            // We MUST read the reservation document as part of the transaction's read set
            // so Firestore can detect conflicts when multiple transactions try to create it
            const reservationSnapshot = await transaction.get(reservationDocRef);

            if (reservationSnapshot.exists()) {
              const reservationData = reservationSnapshot.data();
              const reservedAt = reservationData?.reservedAt;

              // Check if reservation is stale (older than 30 seconds)
              // Stale reservations may be from failed booking attempts that didn't complete
              let isStale = false;
              if (reservedAt) {
                try {
                  let reservedTime: Date | null = null;
                  // Handle Firestore Timestamp objects (has toDate method)
                  if (typeof reservedAt.toDate === 'function') {
                    reservedTime = reservedAt.toDate();
                  } else if (reservedAt instanceof Date) {
                    reservedTime = reservedAt;
                  } else if (reservedAt.seconds) {
                    // Handle Timestamp-like object with seconds property
                    reservedTime = new Date(reservedAt.seconds * 1000);
                  }

                  if (reservedTime) {
                    const now = getClinicNow();
                    const ageInSeconds = (now.getTime() - reservedTime.getTime()) / 1000;
                    isStale = ageInSeconds > 30; // 30 second threshold for stale reservations
                  }
                } catch (e) {
                  // If we can't parse the timestamp, assume it's not stale
                  console.warn(`[BOOKING DEBUG] Request ${requestId}: Could not parse reservedAt timestamp`, e);
                  isStale = false;
                }
              }

              if (isStale) {
                // Reservation is stale - clean it up and allow new booking
                console.log(`[BOOKING DEBUG] Request ${requestId}: Slot ${slotIndex} has STALE reservation - cleaning up`, {
                  reservationId,
                  reservedAt: reservedAt?.toDate?.()?.toISOString(),
                  existingData: reservationData
                });
                // Delete the stale reservation within the transaction
                transaction.delete(reservationDocRef);
                // Continue to create new reservation below
              } else {
                // Reservation exists and is not stale - another active transaction has it
                rejectedReasons.alreadyReserved++;
                console.log(`[BOOKING DEBUG] Request ${requestId}: Slot ${slotIndex} reservation already exists (not stale) - skipping`, {
                  reservationId,
                  reservedAt: reservedAt?.toDate?.()?.toISOString(),
                  existingData: reservationData
                });
                continue;
              }
            }

            // Double-check: Also verify no active appointment exists at this slotIndex
            // Re-check appointments inside transaction to see latest state
            const hasActiveAppointmentAtSlot = effectiveAppointments.some(
              apt => apt.slotIndex === slotIndex && ACTIVE_STATUSES.has(apt.status)
            );

            if (hasActiveAppointmentAtSlot) {
              rejectedReasons.hasActiveAppointment++;
              console.log(`[BOOKING DEBUG] Request ${requestId}: Slot ${slotIndex} has active appointment - skipping`);
              continue;
            }

            console.log(`[BOOKING DEBUG] Request ${requestId}: Attempt ${attempt + 1}: Attempting to CREATE reservation for slot ${slotIndex}`, {
              reservationId,
              timestamp: new Date().toISOString(),
              candidatesCount: candidates.length,
              currentSlotIndex: slotIndex
            });

            // CRITICAL: Reserve the slot atomically using transaction.set()
            // By reading the document first with transaction.get(), we add it to the transaction's read set
            // If another transaction also reads it (doesn't exist) and tries to set() it:
            // - Firestore will detect the conflict (both read the same document)
            // - One transaction will succeed, others will fail with "failed-precondition"
            // - Failed transactions will be retried, and on retry they'll see the reservation exists
            // This ensures only ONE reservation can be created per slot, even with concurrent requests
            transaction.set(reservationDocRef, {
              clinicId,
              doctorName,
              date: dateStr,
              slotIndex: slotIndex,
              reservedAt: serverTimestamp(),
              reservedBy: 'appointment-booking',
            });

            console.log(`[BOOKING DEBUG] Request ${requestId}: Attempt ${attempt + 1}: Reservation SET in transaction for slot ${slotIndex}`, {
              reservationId,
              timestamp: new Date().toISOString()
            });

            // Store the reservation reference - we've successfully reserved this slot
            // If the transaction commits, this reservation will exist
            // If it fails, it will be retried and try the next slot

            reservationRef = reservationDocRef;
            chosenSlotIndex = slotIndex;
            const reservedSlot = slots.find(s => s.index === chosenSlotIndex);
            sessionIndexForNew = reservedSlot?.sessionIndex ?? 0;
            resolvedTimeString = getClinicTimeString(reservedSlot?.time ?? now);

            // CRITICAL: Token number MUST be based on slotIndex + 1 (slotIndex is 0-based, tokens are 1-based)
            // This ensures token A001 goes to slot #1 (slotIndex 0), A002 to slot #2 (slotIndex 1), etc.
            // This makes token numbers correspond to slot positions, not sequential booking order
            // DO NOT use counterState.nextNumber - always use slotIndex + 1
            const calculatedNumericToken = chosenSlotIndex + 1;
            const calculatedTokenNumber = generateOnlineTokenNumber(calculatedNumericToken, sessionIndexForNew);

            // Force assignment - don't allow any other value
            numericToken = calculatedNumericToken;
            tokenNumber = calculatedTokenNumber;

            console.log(`[BOOKING DEBUG] Request ${requestId}: Token assigned based on slotIndex`, {
              slotIndex: chosenSlotIndex,
              calculatedNumericToken,
              calculatedTokenNumber,
              assignedNumericToken: numericToken,
              assignedTokenNumber: tokenNumber,
              counterNextNumber: counterState?.nextNumber ?? 'N/A (not used for advance bookings)', // For debugging - should NOT be used
              timestamp: new Date().toISOString()
            });

            // Verify assignment was successful
            if (numericToken !== calculatedNumericToken || tokenNumber !== calculatedTokenNumber) {
              console.error(`[BOOKING DEBUG] Request ${requestId}: ⚠️ TOKEN ASSIGNMENT FAILED`, {
                slotIndex: chosenSlotIndex,
                expectedNumericToken: calculatedNumericToken,
                actualNumericToken: numericToken,
                expectedTokenNumber: calculatedTokenNumber,
                actualTokenNumber: tokenNumber,
                timestamp: new Date().toISOString()
              });
              // Force correct values
              numericToken = calculatedNumericToken;
              tokenNumber = calculatedTokenNumber;
            }

            break;
          }

          if (chosenSlotIndex < 0 || !reservationRef) {
            const reservedWSlots = calculatePerSessionReservedSlots(slots, now);
            const reservedSlotsCount = reservedWSlots.size;
            const allRejectedDueToReservations = rejectedReasons.alreadyReserved > 0 &&
              (rejectedReasons.alreadyReserved === candidates.length ||
                (rejectedReasons.alreadyReserved + rejectedReasons.hasActiveAppointment) === candidates.length);

            console.error(`[BOOKING DEBUG] Request ${requestId}: ❌ NO SLOT RESERVED - All candidates rejected`, {
              type,
              totalCandidates: candidates.length,
              totalSlots,
              maximumAdvanceTokens,
              reservedSlotsCount,
              occupiedSlotsCount: occupiedSlots.size,
              rejectedReasons,
              allRejectedDueToReservations,
              attempt: attempt + 1,
              timestamp: new Date().toISOString()
            });

            // If all candidates were rejected due to concurrent reservations, throw a retryable error
            if (allRejectedDueToReservations && attempt < MAX_TRANSACTION_ATTEMPTS - 1) {
              const retryError = new Error('All candidate slots were reserved by concurrent requests. Retrying...');
              (retryError as { code?: string }).code = RESERVATION_CONFLICT_CODE;
              throw retryError;
            }

            // Provide a more helpful error message for final failure
            if (type === 'A' && candidates.length > 0) {
              throw new Error(`All available slots were just booked by other users. Please try selecting a different time slot.`);
            } else if (type === 'A') {
              throw new Error(`No advance booking slots are available. All slots are either booked or reserved for walk-ins.`);
            } else {
              throw new Error('No available slots match the booking rules.');
            }
          }

          // CRITICAL: Ensure token is ALWAYS assigned based on slotIndex for advance bookings
          // This is a safety check in case the token wasn't assigned in the loop
          if (type === 'A' && chosenSlotIndex >= 0) {
            const expectedNumericToken = chosenSlotIndex + 1;
            const expectedTokenNumber = generateOnlineTokenNumber(expectedNumericToken, sessionIndexForNew);

            if (numericToken !== expectedNumericToken || tokenNumber !== expectedTokenNumber) {
              console.warn(`[BOOKING DEBUG] Request ${requestId}: Token not properly assigned in loop - fixing now`, {
                slotIndex: chosenSlotIndex,
                currentNumericToken: numericToken,
                expectedNumericToken,
                currentTokenNumber: tokenNumber,
                expectedTokenNumber,
                timestamp: new Date().toISOString()
              });
              numericToken = expectedNumericToken;
              tokenNumber = expectedTokenNumber;
            }
          }
        }

        if (!reservationRef) {
          if (DEBUG_BOOKING) {
            console.warn('[patient booking] failed to reserve slot', { clinicId, doctorName, type, chosenSlotIndex });
          }
          throw new Error('Failed to reserve slot.');
        }

        transaction.set(reservationRef, {
          clinicId,
          doctorName,
          date: dateStr,
          slotIndex: chosenSlotIndex,
          reservedAt: serverTimestamp(),
          reservedBy: type === 'W' ? 'walk-in-booking' : 'appointment-booking',
        });

        // CRITICAL: Only increment counter for walk-ins, not for advance bookings
        // Advance bookings use slotIndex + 1 for tokens, so counter is not needed
        // Incrementing counter for advance bookings causes counter drift and potential token mismatches
        if (type === 'W' && counterState) {
          commitNextTokenNumber(transaction, counterRef, counterState);
        }

        if (DEBUG_BOOKING) {
          console.info('[patient booking] walk-in assignment', {
            clinicId,
            doctorName,
            chosenSlotIndex,
            sessionIndexForNew,
            resolvedTimeString,
            numericToken,
            tokenNumber,
          });
        }
        if (DEBUG_BOOKING) {
          console.info('[patient booking] advance assignment', {
            clinicId,
            doctorName,
            chosenSlotIndex,
            sessionIndexForNew,
            resolvedTimeString,
            numericToken,
            tokenNumber,
          });
        }

        // CRITICAL: Ensure token matches slotIndex before returning
        // This is a final safety check to prevent token/slotIndex mismatches
        if (type === 'A' && chosenSlotIndex >= 0) {
          const expectedNumericToken = chosenSlotIndex + 1;
          const expectedTokenNumber = generateOnlineTokenNumber(expectedNumericToken, sessionIndexForNew);

          if (numericToken !== expectedNumericToken || tokenNumber !== expectedTokenNumber) {
            console.error(`[BOOKING DEBUG] Request ${requestId}: ⚠️ TOKEN MISMATCH DETECTED - Correcting`, {
              slotIndex: chosenSlotIndex,
              currentNumericToken: numericToken,
              expectedNumericToken,
              currentTokenNumber: tokenNumber,
              expectedTokenNumber,
              timestamp: new Date().toISOString()
            });
            numericToken = expectedNumericToken;
            tokenNumber = expectedTokenNumber;
          }
        }

        console.log(`[BOOKING DEBUG] Request ${requestId}: Transaction SUCCESS - about to commit`, {
          tokenNumber,
          numericToken,
          slotIndex: chosenSlotIndex,
          reservationId: reservationRef.id,
          tokenMatchesSlot: type === 'A' ? numericToken === chosenSlotIndex + 1 : true,
          timestamp: new Date().toISOString()
        });

        console.log(`[BOOKING DEBUG] Request ${requestId}: Transaction about to return`, {
          tokenNumber,
          slotIndex: chosenSlotIndex,
          reservationId: reservationRef.id,
          timestamp: new Date().toISOString()
        });

        return {
          tokenNumber,
          numericToken,
          slotIndex: chosenSlotIndex,
          sessionIndex: sessionIndexForNew,
          time: resolvedTimeString,
          reservationId: reservationRef.id,
        };
      });

      // Add timeout for Safari - Firestore transactions can hang in Safari
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error(`Transaction timeout after 30 seconds (Safari compatibility)`));
        }, 30000); // 30 second timeout
      });

      return await Promise.race([transactionPromise, timeoutPromise]) as typeof transactionPromise extends Promise<infer T> ? T : never;
    } catch (error) {
      const errorDetails = {
        requestId,
        attempt: attempt + 1,
        errorMessage: error instanceof Error ? error.message : String(error),
        errorCode: (error as { code?: string }).code,
        errorName: error instanceof Error ? error.name : undefined,
        timestamp: new Date().toISOString()
      };

      console.error(`[BOOKING DEBUG] Request ${requestId}: Transaction FAILED (attempt ${attempt + 1})`, errorDetails);
      console.error(`[BOOKING DEBUG] Request ${requestId}: Full error object:`, error);
      console.error(`[BOOKING DEBUG] Request ${requestId}: Error type check:`, {
        isError: error instanceof Error,
        hasCode: typeof (error as { code?: string }).code === 'string',
        errorCode: (error as { code?: string }).code,
        errorMessage: error instanceof Error ? error.message : String(error),
        userAgent: typeof (globalThis as any).navigator !== 'undefined' ? (globalThis as any).navigator.userAgent : 'unknown',
        isMobileExcludingTablet: typeof (globalThis as any).navigator !== 'undefined' &&
          ((globalThis as any).navigator.userAgent.includes('Mobile') || (globalThis as any).navigator.userAgent.includes('Android')) &&
          !((globalThis as any).navigator.userAgent.includes('iPad') || (globalThis as any).navigator.userAgent.includes('PlayBook') || (globalThis as any).navigator.userAgent.includes('Tablet')),
        isSafari: typeof (globalThis as any).navigator !== 'undefined' && /^((?!chrome|android).)*safari/i.test((globalThis as any).navigator.userAgent)
      });

      // Check if this is a timeout error (Safari-specific)
      if (error instanceof Error && error.message.includes('timeout')) {
        console.error(`[BOOKING DEBUG] Request ${requestId}: ⚠️ TIMEOUT DETECTED - This may be a Safari-specific issue`, {
          errorMessage: error.message,
          userAgent: typeof (globalThis as any).navigator !== 'undefined' ? (globalThis as any).navigator.userAgent : 'unknown'
        });
      }

      const isConflict = isReservationConflict(error);
      console.log(`[BOOKING DEBUG] Request ${requestId}: isReservationConflict check result:`, {
        isConflict,
        willRetry: isConflict && attempt < MAX_TRANSACTION_ATTEMPTS - 1,
        attemptsRemaining: MAX_TRANSACTION_ATTEMPTS - attempt - 1
      });

      if (isConflict) {
        console.log(`[BOOKING DEBUG] Request ${requestId}: ✅ Reservation conflict detected - WILL RETRY`, {
          isReservationConflict: true,
          attemptsRemaining: MAX_TRANSACTION_ATTEMPTS - attempt - 1,
          nextAttempt: attempt + 2
        });
        if (attempt < MAX_TRANSACTION_ATTEMPTS - 1) {
          // Add a small delay before retry to allow other transactions to complete
          await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
          continue;
        }
      }

      console.error(`[BOOKING DEBUG] Request ${requestId}: ❌ Transaction failed and will NOT retry`, {
        ...errorDetails,
        isReservationConflict: isConflict,
        reason: isConflict ? 'Max attempts reached' : 'Not a reservation conflict'
      });
      throw error;
    }
  }

  console.error(`[BOOKING DEBUG] Request ${requestId}: All ${MAX_TRANSACTION_ATTEMPTS} attempts exhausted`);

  throw new Error('No available slots match the booking rules.');
}

export async function prepareAdvanceShift({
  firestore,
  transaction,
  clinicId,
  doctorName,
  dateStr,
  slots,
  totalSlots,
  effectiveAppointments,
  now,
  doctor,
  walkInSpacingValue,
  forceBook = false,
  newWalkInNumericToken,
}: {
  firestore: Firestore;
  transaction: Transaction;
  clinicId: string;
  doctorName: string;
  dateStr: string;
  slots: any[];
  totalSlots: number;
  effectiveAppointments: any[];
  now: Date;
  doctor: any;
  walkInSpacingValue: number;
  forceBook?: boolean;
  newWalkInNumericToken: number;
}): Promise<{
  newAssignment: SchedulerAssignment | null;
  reservationDeletes: DocumentReference[];
  appointmentUpdates: any[];
  usedBucketSlotIndex: number | null;
  existingReservations: Map<number, any>;
  reservationWrites?: Array<{ ref: DocumentReference; data: any }>;
}> {
  // 1. Determine Target Session & Session Start Index
  const targetSessionIndex = slots.length > 0 ? slots[0].sessionIndex : 0;
  const segmentedBase = targetSessionIndex * 1000;
  const memoryBase = slots.length > 0 ? slots[0].index : segmentedBase;

  console.log(`[Walk-in Scheduling] Preparing shift for Session ${targetSessionIndex} (Segment Base: ${segmentedBase}, Memory Base: ${memoryBase})`);

  // 2. Filter Appointments for this Session
  const activeAdvanceAppointments = effectiveAppointments.filter(appointment => {
    return (
      (appointment.bookedVia !== 'Walk-in' || (appointment.bookedVia as string) === 'BreakBlock') &&
      typeof appointment.slotIndex === 'number' &&
      ACTIVE_STATUSES.has(appointment.status) &&
      appointment.sessionIndex === targetSessionIndex
    );
  });

  const activeWalkIns = effectiveAppointments.filter(appointment => {
    return (
      appointment.bookedVia === 'Walk-in' &&
      typeof appointment.slotIndex === 'number' &&
      ACTIVE_STATUSES.has(appointment.status) &&
      appointment.sessionIndex === targetSessionIndex
    );
  });

  // 3. Normalize Indices for Scheduler
  const blockedAdvanceAppointments = activeAdvanceAppointments.map(entry => ({
    id: getTaggedId(entry),
    slotIndex: (entry.slotIndex || 0) - segmentedBase,
  })).filter(a => a.slotIndex >= 0);

  const normalizedWalkIns = activeWalkIns.map(appt => ({
    ...appt,
    id: getTaggedId(appt),
    numericToken: typeof appt.numericToken === 'number' ? appt.numericToken : (Number(appt.numericToken) || 0),
    createdAt: (appt.createdAt as any)?.toDate?.() || appt.createdAt || now,
    currentSlotIndex: (appt.slotIndex || 0) - segmentedBase,
  }));

  const newWalkInCandidate = {
    id: '__new_walk_in__',
    numericToken: newWalkInNumericToken,
    createdAt: now,
    currentSlotIndex: undefined
  };

  const allWalkInCandidates = [...normalizedWalkIns, newWalkInCandidate];
  const normalizedSlots = slots.map(s => ({ ...s, index: s.index - memoryBase }));

  // 3b. Bucket Logic: Identify cancelled slots that should be blocked
  // A cancelled slot is "bucketed" if there are active walk-ins scheduled AFTER it.
  const bucketSlots = effectiveAppointments.filter(appt => {
    return (
      (appt.status === 'Cancelled' || appt.status === 'No-show') &&
      typeof appt.slotIndex === 'number' &&
      appt.sessionIndex === targetSessionIndex
    );
  }).filter(cancelledAppt => {
    // Check if any active walk-in exists after this cancelled slot
    return activeWalkIns.some(w => (w.slotIndex || 0) > (cancelledAppt.slotIndex || 0));
  });

  if (bucketSlots.length > 0) {
    console.log(`[Walk-in Scheduling] Blocking ${bucketSlots.length} bucket slots to prevent reverse shifting:`, bucketSlots.map(s => s.slotIndex));
    bucketSlots.forEach(slot => {
      blockedAdvanceAppointments.push({
        id: `__blocked_bucket_${slot.id}`,
        slotIndex: (slot.slotIndex || 0) - segmentedBase
      });
    });
  }

  let newAssignment: SchedulerAssignment | null = null;
  let schedule: ReturnType<typeof computeWalkInSchedule> | null = null;

  // 4. Booking Logic
  if (forceBook) {
    const allOccupiedSlots = effectiveAppointments
      .filter(apt => ACTIVE_STATUSES.has(apt.status) && typeof apt.slotIndex === 'number' && apt.sessionIndex === targetSessionIndex)
      .map(apt => toRelativeIndex(apt.slotIndex as number, segmentedBase));

    const maxOccupiedSlot = allOccupiedSlots.length > 0 ? Math.max(...allOccupiedSlots) : -1;
    const forceRelativeSlot = maxOccupiedSlot + 1;
    const forceBookSlotIndex = forceRelativeSlot + segmentedBase;

    let forceBookTime: Date;
    const slotDuration = doctor.averageConsultingTime || 15;

    if (forceRelativeSlot >= 0 && forceRelativeSlot < slots.length) {
      forceBookTime = slots[forceRelativeSlot].time;
    } else {
      const lastSlot = slots[slots.length - 1];
      const diff = forceRelativeSlot - (slots.length > 0 ? slots.length - 1 : 0);
      forceBookTime = addMinutes(lastSlot ? lastSlot.time : now, diff * slotDuration);
    }

    newAssignment = {
      id: '__new_walk_in__',
      slotIndex: forceBookSlotIndex,
      sessionIndex: targetSessionIndex,
      slotTime: forceBookTime,
    };
    schedule = { assignments: [] };
  } else {
    schedule = computeWalkInSchedule({
      now,
      walkInTokenAllotment: walkInSpacingValue,
      advanceAppointments: blockedAdvanceAppointments,
      walkInCandidates: allWalkInCandidates,
      slots: normalizedSlots,
    });

    const rawAssigned = schedule.assignments.find(a => a.id === '__new_walk_in__');
    if (rawAssigned) {
      newAssignment = {
        ...rawAssigned,
        slotIndex: rawAssigned.slotIndex + segmentedBase,
      };
    }
  }

  // 5. Process Shift Updates
  const appointmentUpdates: any[] = [];
  if (schedule && schedule.assignments) {
    for (const assign of schedule.assignments) {
      if (assign.id === '__new_walk_in__' || assign.id.startsWith('__blocked_')) continue;

      const originalId = assign.id.replace(/^__shiftable_/, '').replace(/^__break_/, '');
      const originalAppt = effectiveAppointments.find(a => a.id === originalId);
      if (!originalAppt) continue;

      const finalSlotIndex = assign.slotIndex + segmentedBase;
      const newTimeString = getClinicTimeString(assign.slotTime);

      if (originalAppt.slotIndex === finalSlotIndex && originalAppt.time === newTimeString) {
        continue;
      }

      // Metadata calculation
      let calculatedTime: Date;
      const relativeIdx = assign.slotIndex;
      if (relativeIdx < slots.length) {
        calculatedTime = slots[relativeIdx].time;
      } else {
        const lastSlot = slots[slots.length - 1];
        const diff = relativeIdx - (slots.length > 0 ? slots.length - 1 : 0);
        calculatedTime = addMinutes(lastSlot ? lastSlot.time : now, diff * (doctor.averageConsultingTime || 15));
      }
      const finalTimeString = getClinicTimeString(calculatedTime);

      appointmentUpdates.push({
        appointmentId: originalAppt.id,
        docRef: doc(firestore, 'appointments', originalAppt.id),
        slotIndex: finalSlotIndex,
        sessionIndex: targetSessionIndex,
        timeString: finalTimeString,
        arriveByTime: finalTimeString,
        cutOffTime: subMinutes(calculatedTime, 15),
        noShowTime: addMinutes(calculatedTime, (doctor.averageConsultingTime || 15))
      });
    }
  }

  return {
    newAssignment,
    appointmentUpdates,
    reservationDeletes: [],
    usedBucketSlotIndex: null,
    existingReservations: new Map(),
    reservationWrites: [], // Initialize to empty array if no writes are needed
  };
}
export async function calculateWalkInDetails(
  firestore: Firestore,
  doctor: Doctor,
  walkInTokenAllotment?: number,
  walkInCapacityThreshold: number = 0,
  forceBook: boolean = false
): Promise<{
  estimatedTime: Date;
  patientsAhead: number;
  numericToken: number;
  slotIndex: number;
  sessionIndex: number;
  actualSlotTime: Date;
  isForceBooked?: boolean;
}> {
  const now = getClinicNow();
  const date = now;

  // PERFORMANCE OPTIMIZATION: Parallelize initial data fetches for preview
  const fetchPromises: [
    Promise<LoadedDoctor>,
    Promise<Appointment[]>,
    Promise<DocumentSnapshot | null>
  ] = [
      loadDoctorAndSlots(firestore, doctor.clinicId || '', doctor.name, date, doctor.id),
      fetchDayAppointments(firestore, doctor.clinicId || '', doctor.name, date),
      walkInTokenAllotment === undefined && doctor.clinicId
        ? getDoc(doc(firestore, 'clinics', doctor.clinicId))
        : Promise.resolve(null)
    ];

  const [{ slots: allSlots }, appointments, clinicSnap] = await Promise.all(fetchPromises);

  // Extract walkInTokenAllotment early for overflow logic
  let spacingValue = 0;
  if (walkInTokenAllotment === undefined && clinicSnap?.exists()) {
    try {
      const data = clinicSnap.data();
      const rawSpacing = Number(data?.walkInTokenAllotment ?? 0);
      if (Number.isFinite(rawSpacing) && rawSpacing > 0) {
        spacingValue = Math.floor(rawSpacing);
      }
    } catch (e) {
      console.warn('Failed to extract walk-in token allotment:', e);
    }
  } else {
    spacingValue = walkInTokenAllotment || 0;
  }

  // 1. Identify "Active Session" for this walk-in.
  const activeSessionIndex = (() => {
    if (allSlots.length === 0) return 0;
    const sessionMap = new Map<number, { start: Date; end: Date }>();
    allSlots.forEach((s: any) => {
      const current = sessionMap.get(s.sessionIndex);
      if (!current) {
        sessionMap.set(s.sessionIndex, { start: s.time, end: s.time });
      } else {
        if (isBefore(s.time, current.start)) current.start = s.time;
        if (isAfter(s.time, current.end)) current.end = s.time;
      }
    });
    const sortedSessions = Array.from(sessionMap.entries()).sort((a, b) => a[0] - b[0]);
    for (const [sIdx, range] of sortedSessions) {
      if (!isAfter(now, range.end) && !isBefore(now, subMinutes(range.start, 30))) {
        return sIdx;
      }
    }
    return null;
  })();

  const targetSessionIndex = activeSessionIndex ?? 0;
  const sessionBaseIndex = targetSessionIndex * 1000;

  // Get slots for this session
  const slots = allSlots.filter((s: any) => s.sessionIndex === targetSessionIndex);

  // Filter appointments for this session
  const sessionAppointments = appointments.filter((appointment: any) => {
    if (typeof appointment.sessionIndex === 'number') {
      return appointment.sessionIndex === targetSessionIndex;
    }
    if (typeof appointment.slotIndex === 'number') {
      // Fallback check
      if (targetSessionIndex === 0) return appointment.slotIndex < 1000;
      return appointment.slotIndex >= sessionBaseIndex && appointment.slotIndex < sessionBaseIndex + 1000;
    }
    return false;
  });

  console.log('[WALK-IN:ESTIMATE] Session Data:', {
    targetSessionIndex,
    sessionBaseIndex,
    slotsCount: slots.length,
    appointmentCount: sessionAppointments.length
  });



  // Calculate numeric token
  const existingNumericTokens = sessionAppointments
    .filter(appointment => appointment.bookedVia === 'Walk-in')
    .map(appointment => {
      if (typeof appointment.numericToken === 'number') {
        return appointment.numericToken;
      }
      const parsed = Number(appointment.numericToken);
      return Number.isFinite(parsed) ? parsed : 0;
    })
    .filter(token => token > 0);

  const numericToken =
    existingNumericTokens.length > 0
      ? Math.max(...existingNumericTokens) + 1
      : slots.length + 101; // First token = total slots + 1 + 100


  // Filter Active vs Walk-ins
  const activeAdvanceAppointments = sessionAppointments.filter((appointment: any) => {
    return (
      (appointment.bookedVia !== 'Walk-in' || (appointment.bookedVia as string) === 'BreakBlock') &&
      typeof appointment.slotIndex === 'number' &&
      ACTIVE_STATUSES.has(appointment.status) &&
      (!appointment.cancelledByBreak || appointment.status === 'Completed' || appointment.status === 'Skipped')
    );
  });

  const activeWalkIns = sessionAppointments.filter((appointment: any) => {
    return (
      appointment.bookedVia === 'Walk-in' &&
      typeof appointment.slotIndex === 'number' &&
      ACTIVE_STATUSES.has(appointment.status) &&
      !appointment.cancelledByBreak
    );
  });

  console.log('[WALK-IN:ESTIMATE] Filtering Breakdown:', {
    total: sessionAppointments.length,
    activeAdvance: activeAdvanceAppointments.length,
    activeWalkIns: activeWalkIns.length,
    cancelledByBreak: sessionAppointments.filter(a => a.cancelledByBreak).map(a => ({ id: a.id, slot: a.slotIndex, time: a.time, status: a.status })),
    inactive: sessionAppointments.filter(a => !ACTIVE_STATUSES.has(a.status)).map(a => ({ id: a.id, status: a.status }))
  });

  console.log('[WALK-IN:ESTIMATE] Filtering Breakdown:', {
    totalCount: sessionAppointments.length,
    activeAdvanceCount: activeAdvanceAppointments.length,
    activeWalkInCount: activeWalkIns.length,
    filteredCancelledByBreak: sessionAppointments.filter(a => a.cancelledByBreak).map(a => ({ id: a.id, slot: a.slotIndex, status: a.status })),
    filteredInactive: sessionAppointments.filter(a => !ACTIVE_STATUSES.has(a.status)).map(a => ({ id: a.id, slot: a.slotIndex, status: a.status }))
  });

  // PREPARE SCHEDULER INPUTS (NORMALIZED)
  const toRelative = (idx: number) => idx >= sessionBaseIndex ? idx - sessionBaseIndex : idx;
  const toGlobal = (idx: number) => idx + sessionBaseIndex;

  const blockedAdvanceAppointments = activeAdvanceAppointments.map(entry => {
    const isStrictlyImmovable = entry.status === 'Completed';
    const isBreakBlock = (entry.bookedVia as string) === 'BreakBlock';

    let idPrefix = '__shiftable_';
    if (isBreakBlock) idPrefix = '__break_';
    else if (isStrictlyImmovable) idPrefix = '__blocked_';

    return {
      id: `${idPrefix}${entry.id}`,
      slotIndex: toRelative(entry.slotIndex || 0),
    };
  }).filter(a => a.slotIndex >= 0);

  const baseWalkInCandidates = activeWalkIns.map((appt: any) => ({
    id: appt.id,
    numericToken: Number(appt.numericToken) || 0,
    createdAt: (appt.createdAt as any)?.toDate?.() || appt.createdAt || now,
    currentSlotIndex: toRelative(appt.slotIndex || 0),
  }));

  const allWalkInCandidates = [
    ...baseWalkInCandidates,
    {
      id: '__new_walk_in__',
      numericToken,
      createdAt: now,
      currentSlotIndex: undefined
    }
  ];

  // Force Book Check
  if (forceBook) {
    // Simple Append Logic
    const usedIndices = sessionAppointments
      .filter(a => ACTIVE_STATUSES.has(a.status) && typeof a.slotIndex === 'number')
      .map(a => toRelativeIndex(a.slotIndex as number, sessionBaseIndex))
      .filter(idx => idx >= 0 && idx < 1000); // Filter out legitimate outliers (e.g. adjacent session 1000+) but keep 10000+ force books

    const maxIdx = usedIndices.length > 0 ? Math.max(...usedIndices) : -1;
    const forceRelativeVals = maxIdx + 1;

    let forceTime: Date;
    if (forceRelativeVals < slots.length) {
      forceTime = slots[forceRelativeVals].time;
    } else {
      const slotDuration = doctor.averageConsultingTime || 15;
      const lastSlot = slots[slots.length - 1];
      const diff = forceRelativeVals - (slots.length - 1);
      forceTime = addMinutes(lastSlot.time, diff * slotDuration);
    }

    return {
      estimatedTime: forceTime,
      patientsAhead: activeWalkIns.length, // approximation
      numericToken,
      slotIndex: toGlobal(forceRelativeVals),
      sessionIndex: targetSessionIndex,
      actualSlotTime: forceTime,
      isForceBooked: true
    };
  }

  // NORMALIZE SLOTS: Scheduler expects slots to match the index space of appointments.
  // ROBUST FIX: Normalize indices relative to the first slot of the session.
  // This handles both Segmented (1000+) and Continuous (18+) runtime indexing.
  const previewFirstSlotIndex = slots.length > 0 ? slots[0].index : sessionBaseIndex;

  const normalizedSlots = slots.map(s => ({
    ...s,
    index: s.index - previewFirstSlotIndex
  }));

  console.log('[WALK-IN DEBUG] Normalized Slots for Scheduler:', {
    originalCount: slots.length,
    normalizedCount: normalizedSlots.length,
    firstOriginal: slots[0]?.index,
    firstNormalized: normalizedSlots[0]?.index,
    previewFirstSlotIndex,
    sessionBaseIndex
  });

  // Regular Scheduling
  const schedule = computeWalkInSchedule({
    slots: normalizedSlots,
    now,
    walkInTokenAllotment: spacingValue,
    advanceAppointments: blockedAdvanceAppointments,
    walkInCandidates: allWalkInCandidates
  });

  const myAssignment = schedule.assignments.find(a => a.id === '__new_walk_in__');
  console.log('[WALK-IN DEBUG] Scheduler Result:', {
    assigned: !!myAssignment,
    slotIndex: myAssignment?.slotIndex,
    assignmentsCount: schedule.assignments.length
  });

  // Default values validation
  if (!myAssignment) {
    // Fallback if scheduler fails (shouldn't happen)
    return {
      estimatedTime: now,
      patientsAhead: 0,
      numericToken,
      slotIndex: toGlobal(slots.length),
      sessionIndex: targetSessionIndex,
      actualSlotTime: now
    };
  }

  // Calculate Time from Scheduler Result
  const relativeIdx = myAssignment.slotIndex;

  if (relativeIdx === undefined || relativeIdx === null) {
    console.error('[WALK-IN DEBUG] Invalid relativeIdx returned:', relativeIdx);
    throw new Error('Scheduler returned invalid slot index');
  }

  let estimatedTime: Date;

  if (slots[relativeIdx]) {
    estimatedTime = slots[relativeIdx].time;
  } else {
    console.warn('[WALK-IN DEBUG] relativeIdx out of bounds:', {
      relativeIdx,
      slotsLength: slots.length,
      maxSlotIndex: slots.length - 1
    });
    // Fallback logic for overflow
    if (relativeIdx >= slots.length) {
      const slotDuration = doctor.averageConsultingTime || 15;
      const lastSlot = slots[slots.length - 1];
      const diff = relativeIdx - (slots.length - 1);
      estimatedTime = addMinutes(lastSlot.time, diff * slotDuration);
    } else {
      // Should not happen (negative index?)
      estimatedTime = now;
    }
  }

  // Calculate Patients Ahead
  // Count ALL active appointments (Walk-ins + Online) before this slot
  const patientsAhead = [
    ...activeWalkIns,
    ...activeAdvanceAppointments.filter(a => (a.bookedVia as string) !== 'BreakBlock')
  ].filter(appt => {
    // Exclude Completed/No-show/Cancelled from "People Ahead" count
    // NOTE: Query usually filters No-show/Cancelled, but we double check.
    // 'Skipped' should be COUNTED per user request.
    if (appt.status === 'Completed' || appt.status === 'No-show' || appt.status === 'Cancelled') return false;

    const apptIdx = toRelative(appt.slotIndex || 0);
    return apptIdx < relativeIdx;
  }).length;

  return {
    estimatedTime,
    patientsAhead,
    numericToken,
    slotIndex: toGlobal(relativeIdx), // DENORMALIZE
    sessionIndex: targetSessionIndex,
    actualSlotTime: estimatedTime,
  };
}
export interface WalkInPreviewShift {
  id: string;
  tokenNumber?: string;
  fromSlot: number;
  toSlot: number;
  fromTime?: Date | null;
  toTime: Date;
}

export interface WalkInPreviewResult {
  placeholderAssignment: SchedulerAssignment | null;
  advanceShifts: WalkInPreviewShift[];
  walkInAssignments: SchedulerAssignment[];
}

export async function previewWalkInPlacement(
  firestore: Firestore,
  clinicId: string,
  doctorName: string,
  date: Date,
  walkInTokenAllotment: number,
  doctorId?: string
): Promise<WalkInPreviewResult> {
  const DEBUG = process.env.NEXT_PUBLIC_DEBUG_WALK_IN === 'true';
  const now = getClinicNow(); // Use clinic time for session detection

  // Load all data
  const fetchPromises: [
    Promise<LoadedDoctor>,
    Promise<Appointment[]>
  ] = [
      loadDoctorAndSlots(firestore, clinicId, doctorName, date, doctorId),
      fetchDayAppointments(firestore, clinicId, doctorName, date)
    ];

  const [{ slots: allSlots }, appointments] = await Promise.all(fetchPromises);

  // 1. Identify "Active Session" (Consistency with calculateWalkInDetails)
  const activeSessionIndex = (() => {
    if (allSlots.length === 0) return 0;
    const sessionMap = new Map<number, { start: Date; end: Date }>();
    allSlots.forEach((s: any) => {
      const current = sessionMap.get(s.sessionIndex);
      if (!current) {
        sessionMap.set(s.sessionIndex, { start: s.time, end: s.time });
      } else {
        if (isBefore(s.time, current.start)) current.start = s.time;
        if (isAfter(s.time, current.end)) current.end = s.time;
      }
    });
    const sortedSessions = Array.from(sessionMap.entries()).sort((a, b) => a[0] - b[0]);
    for (const [sIdx, range] of sortedSessions) {
      if (!isAfter(now, range.end) && !isBefore(now, subMinutes(range.start, 30))) {
        return sIdx;
      }
    }
    return null;
  })();

  const targetSessionIndex = activeSessionIndex ?? 0;
  const sessionBaseIndex = targetSessionIndex * 1000;

  // Filter slots and appointments for this session
  const slots = allSlots.filter((s: any) => s.sessionIndex === targetSessionIndex);

  const sessionAppointments = appointments.filter((appointment: any) => {
    // 1. Explicit Session Index
    if (typeof appointment.sessionIndex === 'number') {
      return appointment.sessionIndex === targetSessionIndex;
    }
    if (typeof appointment.slotIndex === 'number') {
      if (targetSessionIndex === 0) return appointment.slotIndex < 1000;
      return appointment.slotIndex >= sessionBaseIndex && appointment.slotIndex < sessionBaseIndex + 1000;
    }
    return false;
  });

  const activeAdvanceAppointments = sessionAppointments.filter(appointment => {
    return (
      appointment.bookedVia !== 'Walk-in' &&
      typeof appointment.slotIndex === 'number' &&
      ACTIVE_STATUSES.has(appointment.status)
    );
  });

  const activeWalkIns = sessionAppointments.filter(appointment => {
    return (
      appointment.bookedVia === 'Walk-in' &&
      typeof appointment.slotIndex === 'number' &&
      ACTIVE_STATUSES.has(appointment.status)
    );
  });

  const existingNumericTokens = activeWalkIns
    .map(appointment => {
      if (typeof appointment.numericToken === 'number') {
        return appointment.numericToken;
      }
      const parsed = Number(appointment.numericToken);
      return Number.isFinite(parsed) ? parsed : 0;
    })
    .filter(token => token > 0);

  const placeholderNumericToken =
    (existingNumericTokens.length > 0 ? Math.max(...existingNumericTokens) : slots.length) + 1;

  const placeholderId = '__preview_walk_in__';

  // PREPARE SCHEDULER INPUTS (NORMALIZED)
  const toRelative = (idx: number) => idx >= sessionBaseIndex ? idx - sessionBaseIndex : idx;
  const toGlobal = (idx: number) => idx + sessionBaseIndex;

  const walkInCandidates = [
    ...activeWalkIns.map(appointment => ({
      id: appointment.id,
      numericToken:
        typeof appointment.numericToken === 'number'
          ? appointment.numericToken
          : Number(appointment.numericToken ?? 0) || 0,
      createdAt: toDate(appointment.createdAt),
      currentSlotIndex: toRelative(appointment.slotIndex || 0), // NORMALIZE
    })),
    {
      id: placeholderId,
      numericToken: placeholderNumericToken,
      createdAt: new Date(),
    },
  ];

  const normalizedAdvanceAppointments = activeAdvanceAppointments.map(entry => ({
    id: entry.id,
    slotIndex: toRelative(entry.slotIndex || 0), // NORMALIZE
  }));

  // NORMALIZE SLOTS: Scheduler expects slots to match the index space of appointments.
  // ROBUST FIX: Normalize indices relative to the first slot of the session.
  const previewFirstSlotIndex = slots.length > 0 ? slots[0].index : sessionBaseIndex;

  const normalizedSlots = slots.map(s => ({
    ...s,
    index: s.index - previewFirstSlotIndex
  }));

  const schedule = computeWalkInSchedule({
    slots: normalizedSlots,
    now: getClinicNow(),
    walkInTokenAllotment,
    advanceAppointments: normalizedAdvanceAppointments,
    walkInCandidates,
  });

  const assignmentById = new Map(schedule.assignments.map(assignment => [assignment.id, assignment]));

  const advanceShifts: WalkInPreviewShift[] = activeAdvanceAppointments.flatMap(appointment => {
    const assignment = assignmentById.get(appointment.id);
    if (!assignment) {
      return [];
    }

    // Denormalize comparison
    const originalGlobalIndex = appointment.slotIndex || 0;
    const newGlobalIndex = toGlobal(assignment.slotIndex);

    if (originalGlobalIndex === newGlobalIndex) {
      return [];
    }

    return [
      {
        id: appointment.id,
        tokenNumber: appointment.tokenNumber,
        fromSlot: originalGlobalIndex,
        toSlot: newGlobalIndex, // DENORMALIZE
        fromTime: appointment.time ? parseClinicTime(appointment.time, date) : null,
        toTime: assignment.slotTime,
      },
    ];
  });

  const rawPlaceholderAssignment = assignmentById.get(placeholderId) ?? null;
  let placeholderAssignment: SchedulerAssignment | null = null;

  if (rawPlaceholderAssignment) {
    placeholderAssignment = {
      ...rawPlaceholderAssignment,
      slotIndex: toGlobal(rawPlaceholderAssignment.slotIndex) // DENORMALIZE
    };
  }

  const walkInAssignments = schedule.assignments
    .filter(assignment => assignment.id !== placeholderId)
    .map(a => ({
      ...a,
      slotIndex: toGlobal(a.slotIndex) // DENORMALIZE
    }));

  if (DEBUG) {
    console.group('[walk-in preview] result');
    console.info('placeholder', placeholderAssignment);
    console.info('advance shifts', advanceShifts);
    console.info('walk-in assignments', walkInAssignments);
    console.groupEnd();
  }

  return { placeholderAssignment, advanceShifts, walkInAssignments };
}
export async function rebalanceWalkInSchedule(
  firestore: Firestore,
  clinicId: string,
  doctorName: string,
  date: Date,
  doctorId?: string
): Promise<void> {
  const DEBUG = process.env.NEXT_PUBLIC_DEBUG_WALK_IN === 'true';
  const now = getClinicNow();

  // Load all data
  const fetchPromises: [
    Promise<LoadedDoctor>,
    Promise<Appointment[]>
  ] = [
      loadDoctorAndSlots(firestore, clinicId, doctorName, date, doctorId),
      fetchDayAppointments(firestore, clinicId, doctorName, date)
    ];

  const [{ slots: allSlots, doctor }, appointments] = await Promise.all(fetchPromises);
  const averageConsultingTime = doctor.averageConsultingTime || 15;

  const clinicSnap = await getDoc(doc(firestore, 'clinics', clinicId));
  const rawSpacing = clinicSnap.exists() ? Number(clinicSnap.data()?.walkInTokenAllotment ?? 0) : 0;
  const walkInSpacingValue = Number.isFinite(rawSpacing) && rawSpacing > 0 ? Math.floor(rawSpacing) : 0;

  // Identify "Active Session" (Consistency with calculateWalkInDetails)
  const activeSessionIndex = (() => {
    if (allSlots.length === 0) return 0;
    const sessionMap = new Map<number, { start: Date; end: Date }>();
    allSlots.forEach((s: any) => {
      const current = sessionMap.get(s.sessionIndex);
      if (!current) {
        sessionMap.set(s.sessionIndex, { start: s.time, end: s.time });
      } else {
        if (isBefore(s.time, current.start)) current.start = s.time;
        if (isAfter(s.time, current.end)) current.end = s.time;
      }
    });
    const sortedSessions = Array.from(sessionMap.entries()).sort((a, b) => a[0] - b[0]);
    for (const [sIdx, range] of sortedSessions) {
      if (!isAfter(now, range.end) && !isBefore(now, subMinutes(range.start, 30))) {
        return sIdx;
      }
    }
    return null;
  })();

  const targetSessionIndex = activeSessionIndex ?? 0;
  const sessionBaseIndex = targetSessionIndex * 1000;

  // Filter slots
  const slots = allSlots.filter((s: any) => s.sessionIndex === targetSessionIndex);

  const sessionAppointments = appointments.filter((appointment: any) => {
    if (typeof appointment.sessionIndex === 'number') {
      return appointment.sessionIndex === targetSessionIndex;
    }
    if (typeof appointment.slotIndex === 'number') {
      if (targetSessionIndex === 0) return appointment.slotIndex < 1000;
      return appointment.slotIndex >= sessionBaseIndex && appointment.slotIndex < sessionBaseIndex + 1000;
    }
    return false;
  });

  const activeAdvanceAppointments = sessionAppointments.filter(appointment => {
    return (
      appointment.bookedVia !== 'Walk-in' &&
      typeof appointment.slotIndex === 'number' &&
      ACTIVE_STATUSES.has(appointment.status)
    );
  });

  const activeWalkIns = sessionAppointments.filter(appointment => {
    return (
      appointment.bookedVia === 'Walk-in' &&
      typeof appointment.slotIndex === 'number' &&
      ACTIVE_STATUSES.has(appointment.status)
    );
  });

  if (activeWalkIns.length === 0) {
    return;
  }

  // Normalize
  const toRelative = (idx: number) => idx >= sessionBaseIndex ? idx - sessionBaseIndex : idx;
  const toGlobal = (idx: number) => idx + sessionBaseIndex;

  const normalizedAdvanceAppointments = activeAdvanceAppointments.map(entry => ({
    id: getTaggedId(entry),
    slotIndex: toRelative(entry.slotIndex || 0),
  }));

  // 3b. Bucket Logic for Rebalance
  const bucketSlots = sessionAppointments.filter(appt => {
    return (
      (appt.status === 'Cancelled' || appt.status === 'No-show') &&
      typeof appt.slotIndex === 'number'
    );
  }).filter(cancelledAppt => {
    return activeWalkIns.some(w => (w.slotIndex || 0) > (cancelledAppt.slotIndex || 0));
  });

  if (bucketSlots.length > 0) {
    bucketSlots.forEach(slot => {
      normalizedAdvanceAppointments.push({
        id: `__blocked_bucket_${slot.id}`,
        slotIndex: toRelative(slot.slotIndex || 0)
      });
    });
  }

  const walkInCandidates = activeWalkIns.map(appointment => ({
    id: getTaggedId(appointment),
    numericToken: typeof appointment.numericToken === 'number' ? appointment.numericToken : 0,
    createdAt: toDate(appointment.createdAt),
    currentSlotIndex: toRelative(appointment.slotIndex || 0),
  }));

  // NORMALIZE SLOTS: Scheduler expects slots to match the index space of appointments.
  // ROBUST FIX: Normalize indices relative to the first slot of the session.
  const previewFirstSlotIndex = slots.length > 0 ? slots[0].index : sessionBaseIndex;

  const normalizedSlots = slots.map(s => ({
    ...s,
    index: s.index - previewFirstSlotIndex
  }));
  const schedule = computeWalkInSchedule({
    slots: normalizedSlots,
    now,
    walkInTokenAllotment: walkInSpacingValue,
    advanceAppointments: normalizedAdvanceAppointments,
    walkInCandidates,
  });

  if (DEBUG) {
    console.info('[patient booking] rebalance schedule', schedule.assignments);
  }

  await runTransaction(firestore, async transaction => {
    const assignmentById = new Map(schedule.assignments.map(assignment => [assignment.id, assignment]));

    for (const appointment of activeAdvanceAppointments) {
      const taggedId = getTaggedId(appointment);
      const assignment = assignmentById.get(taggedId);
      if (!assignment) continue;

      const currentSlotIndex = typeof appointment.slotIndex === 'number' ? appointment.slotIndex : -1;
      const newSlotIndex = toGlobal(assignment.slotIndex);
      const newTimeString = getClinicTimeString(assignment.slotTime);

      if (currentSlotIndex === newSlotIndex && appointment.time === newTimeString) {
        continue;
      }

      const appointmentRef = doc(firestore, 'appointments', appointment.id);
      transaction.update(appointmentRef, {
        slotIndex: newSlotIndex,
        sessionIndex: targetSessionIndex,
        time: newTimeString,
        cutOffTime: subMinutes(assignment.slotTime, averageConsultingTime),
        noShowTime: addMinutes(assignment.slotTime, averageConsultingTime),
      });
    }

    for (const appointment of activeWalkIns) {
      const taggedId = getTaggedId(appointment);
      const assignment = assignmentById.get(taggedId);
      if (!assignment) continue;

      const currentSlotIndex = typeof appointment.slotIndex === 'number' ? appointment.slotIndex : -1;
      const newSlotIndex = toGlobal(assignment.slotIndex);
      const newTimeString = getClinicTimeString(assignment.slotTime);

      if (currentSlotIndex === newSlotIndex && appointment.time === newTimeString) {
        continue;
      }

      const appointmentRef = doc(firestore, 'appointments', appointment.id);
      transaction.update(appointmentRef, {
        slotIndex: newSlotIndex,
        sessionIndex: targetSessionIndex,
        time: newTimeString,
        cutOffTime: subMinutes(assignment.slotTime, averageConsultingTime),
        noShowTime: addMinutes(assignment.slotTime, averageConsultingTime),
      });
    }
  });

  if (DEBUG) {
    console.info('[patient booking] rebalance complete');
  }
}

