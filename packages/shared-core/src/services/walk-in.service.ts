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
  return snapshot.docs.map(docRef => ({ id: docRef.id, ...docRef.data() } as Appointment));
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
  // Before: Sequential fetches took ~600-1500ms
  // After: Parallel fetches take ~300-800ms (40% faster)
  const fetchPromises: [
    Promise<LoadedDoctor>,
    Promise<DocumentSnapshot | null>
  ] = [
      loadDoctorAndSlots(
        firestore,
        clinicId,
        doctorName,
        date,
        typeof appointmentData.doctorId === 'string' ? appointmentData.doctorId : undefined
      ),
      type === 'W' ? getDoc(doc(firestore, 'clinics', clinicId)) : Promise.resolve(null)
    ];

  const [{ doctor, slots: allSlots }, clinicSnap] = await Promise.all(fetchPromises);

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
    // A session is active if current time is within the session or up to 30 minutes before it starts
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
            doctor,
            now,
            walkInSpacingValue,
            effectiveAppointments,
            totalSlots,
            newWalkInNumericToken: nextWalkInNumericToken,
            forceBook: !!appointmentData.isForceBooked,
          });

          numericToken = nextWalkInNumericToken;
          tokenNumber = `W${String(numericToken).padStart(3, '0')}`;

          const { newAssignment, reservationDeletes, appointmentUpdates, usedBucketSlotIndex, existingReservations } = shiftPlan;

          if (!newAssignment) {
            throw new Error('Unable to schedule walk-in token.');
          }

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
            const slotsBeyondAvailability = newSlotIndex - lastSlotIndexFromSlots;

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
            const calculatedTokenNumber = `A${String(calculatedNumericToken).padStart(3, '0')}`;

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
            const expectedTokenNumber = `A${String(expectedNumericToken).padStart(3, '0')}`;

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
          const expectedTokenNumber = `A${String(expectedNumericToken).padStart(3, '0')}`;

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
  transaction,
  firestore,
  clinicId,
  doctorName,
  dateStr,
  slots,
  doctor,
  now,
  walkInSpacingValue,
  effectiveAppointments,
  totalSlots,
  newWalkInNumericToken,
  forceBook,
}: {
  transaction: Transaction;
  firestore: Firestore;
  clinicId: string;
  doctorName: string;
  dateStr: string;
  slots: DailySlot[];
  doctor: Doctor;
  now: Date;
  walkInSpacingValue: number;
  effectiveAppointments: Appointment[];
  totalSlots: number;
  newWalkInNumericToken: number;
  forceBook?: boolean;
}): Promise<{
  newAssignment: SchedulerAssignment | null;
  reservationDeletes: DocumentReference[];
  reservationWrites?: { ref: DocumentReference; data: any }[];
  appointmentUpdates: Array<{
    docRef: DocumentReference;
    slotIndex: number;
    sessionIndex: number;
    timeString: string;
    arriveByTime: string;
    cutOffTime: Date;
    noShowTime: Date;
  }>;
  usedBucketSlotIndex: number | null;
  existingReservations: Map<number, Date>;
}> {
  let hasReservationConflict = false; // Add this definition at function start
  // CRITICAL: Determine target session from slots array
  const targetSessionIndex = slots.length > 0 ? slots[0].sessionIndex : 0;

  const activeAdvanceAppointments = effectiveAppointments.filter((appointment: any) => {
    // CRITICAL FIX: Filter by session to prevent cross-session bleeding
    // Session 0 appointments (indices 0-11) should not interfere with Session 1 (indices 1000+)
    const appointmentSessionIndex = typeof appointment.slotIndex === 'number' && appointment.slotIndex >= 1000
      ? Math.floor(appointment.slotIndex / 1000)
      : 0;

    return (
      appointmentSessionIndex === targetSessionIndex && // CRITICAL: Session filter
      (appointment.bookedVia !== 'Walk-in' || (appointment.bookedVia as string) === 'BreakBlock') &&
      typeof appointment.slotIndex === 'number' &&
      ACTIVE_STATUSES.has(appointment.status) &&
      (!appointment.cancelledByBreak || appointment.status === 'Completed' || appointment.status === 'Skipped')
    );
  });

  // CRITICAL FIX: Add "Break Block" appointments from doctor.breakPeriods
  // These are stored in doctor config, not as appointment documents, but must be treated as BLOCKED slots.
  // We determine which session we are targeting based on the first slot in 'slots' array.
  if (doctor.breakPeriods) {
    const breaksForDate = doctor.breakPeriods[dateStr] || [];

    // Determine target session index. 
    // Usually 'slots' contains slots for ONE session (the active one).
    // We can check the sessionIndex of the first slot.
    const targetSessionIndex = slots.length > 0 ? slots[0].sessionIndex : 0; // Default to 0 if empty

    const breaksForSession = breaksForDate.filter((bp: any) => bp.sessionIndex === targetSessionIndex);

    breaksForSession.forEach((bp: any) => {
      const breakSlotIndices = bp.slots || []; // Array of slot indices
      breakSlotIndices.forEach((slotIdx: number) => {
        // Create synthetic appointment for this break slot
        activeAdvanceAppointments.push({
          id: `__break_${slotIdx}`, // distinct ID
          bookedVia: 'BreakBlock',
          status: 'Completed', // Treat as completed so it is blocked
          slotIndex: slotIdx,
          // Add other required fields if needed by filter logic (though filter is already done)
        } as any);
      });
    });
  }

  const activeWalkIns = effectiveAppointments.filter((appointment: any) => {
    // CRITICAL FIX: Filter by session to prevent cross-session bleeding
    const appointmentSessionIndex = typeof appointment.slotIndex === 'number' && appointment.slotIndex >= 1000
      ? Math.floor(appointment.slotIndex / 1000)
      : 0;

    return (
      appointmentSessionIndex === targetSessionIndex && // CRITICAL: Session filter
      appointment.bookedVia === 'Walk-in' &&
      typeof appointment.slotIndex === 'number' &&
      ACTIVE_STATUSES.has(appointment.status) &&
      (!appointment.cancelledByBreak || appointment.status === 'Completed' || appointment.status === 'Skipped')
    );
  });

  const hasExistingWalkIns = activeWalkIns.length > 0;

  if (DEBUG_BOOKING) {
    console.info('[patient booking] prepareAdvanceShift start', {
      clinicId,
      doctorName,
      dateStr,
      walkInSpacingValue,
      totalSlots,
      activeAdvanceAppointments: activeAdvanceAppointments.map(a => ({ id: a.id, slotIndex: a.slotIndex })),
      activeWalkIns: activeWalkIns.map(w => ({ id: w.id, slotIndex: w.slotIndex })),
    });
  }

  // CRITICAL: Read existing reservations BEFORE calling scheduler
  // This prevents concurrent walk-ins from getting the same slot
  // Also clean up stale reservations (older than 30 seconds)
  // Calculate maximum possible slot index (for bucket compensation cases)
  const allSlotIndicesFromAppointments = effectiveAppointments
    .map(appointment => typeof appointment.slotIndex === 'number' ? appointment.slotIndex : -1)
    .filter(idx => idx >= 0);
  const maxSlotIndexFromAppointments = allSlotIndicesFromAppointments.length > 0
    ? Math.max(...allSlotIndicesFromAppointments)
    : -1;
  const lastSlotIndexFromSlots = totalSlots > 0 ? totalSlots - 1 : -1;
  const maxSlotIndex = Math.max(maxSlotIndexFromAppointments, lastSlotIndexFromSlots);
  // Read reservations up to maxSlotIndex + 50 to cover bucket compensation cases with extra buffer
  // This ensures we read the reservation for finalSlotIndex before any writes
  const maxSlotToRead = Math.max(totalSlots + 10, maxSlotIndex + 50);

  const existingReservations = new Map<number, Date>();
  const reservationDeletes = new Map<string, DocumentReference>();
  const staleReservationsToDelete: DocumentReference[] = [];

  // Batch read reservations for better performance - Fix for ERR_INSUFFICIENT_RESOURCES
  // Instead of reading thousands of potential slots transactionally (which crashes the browser),
  // we fetch all ACTIVE reservations for this doctor/date in a single query.
  // This gives us the "existingReservations" map needed for logic.
  // We will then transactionally verify the specific target slot later.
  const reservationsQuery = query(
    collection(firestore, 'slot-reservations'),
    where('clinicId', '==', clinicId),
    where('doctorName', '==', doctorName),
    where('date', '==', dateStr)
  );

  // Note: We use getDocs (non-transactional) here to build the state map.
  // This is safe because we will perform a transaction.get() on the FINAL chosen slot
  // before writing to it, which ensures we don't overwrite concurrent changes.
  const reservationSnapshot = await getDocs(reservationsQuery);
  const reservationSnapshots = reservationSnapshot.docs;



  for (let i = 0; i < reservationSnapshots.length; i += 1) {
    const reservationSnapshot = reservationSnapshots[i];
    const reservationData = reservationSnapshot.data();
    const slotIdx = reservationData.slotIndex; // Extract slotIndex from data since we don't have it by index anymore

    // Create ref for potential deletion
    const reservationRef = reservationSnapshot.ref;

    // Skip if slotIdx is invalid
    if (typeof slotIdx !== 'number') continue;



    if (reservationSnapshot.exists()) {
      // reservationData already extracted above
      const reservedAt = reservationData?.reservedAt;
      let reservedTime: Date | null = null;

      if (reservedAt) {
        try {
          if (typeof reservedAt.toDate === 'function') {
            reservedTime = reservedAt.toDate();
          } else if (reservedAt instanceof Date) {
            reservedTime = reservedAt;
          } else if (reservedAt.seconds) {
            reservedTime = new Date(reservedAt.seconds * 1000);
          }

          if (reservedTime) {
            const ageInSeconds = (now.getTime() - reservedTime.getTime()) / 1000;
            const isBooked = reservationData.status === 'booked';
            const reservationAppointmentId = reservationData?.appointmentId;
            const reservedBy = reservationData?.reservedBy as string | undefined;
            const threshold = isBooked ? 300 : 30; // 5 minutes for booked, 30 seconds for temporary

            if (ageInSeconds <= threshold) {
              // CRITICAL: If reservation has status 'booked' and appointmentId, we must verify
              // that the appointment still exists and is active before deleting the reservation.
              // For walk-ins, we treat reservations created by advance booking
              // (reservedBy === 'appointment-booking') as NON-blocking so that
              // walk-ins can still use advance-shift logic without hitting a
              // slot-reservation-conflict. These reservations are still cleaned up
              // by the existing TTL logic.
              if (isBooked && reservationAppointmentId) {
                // Find the appointment that this reservation is linked to
                const linkedAppointment = effectiveAppointments.find(
                  a => a.id === reservationAppointmentId
                );

                if (linkedAppointment) {
                  // Reservation's appointment exists - check if it's active
                  if (ACTIVE_STATUSES.has(linkedAppointment.status)) {
                    // Appointment is active - only block walk-ins if this is NOT
                    // an advance-booking reservation.
                    if (reservedBy !== 'appointment-booking') {
                      existingReservations.set(slotIdx, reservedTime);
                    }
                  } else {
                    // Appointment is cancelled/no-show - safe to delete reservation
                    staleReservationsToDelete.push(reservationRef);
                  }
                } else {
                  // Reservation's appointment doesn't exist - check if there's another appointment at this slot
                  const slotAppointment = effectiveAppointments.find(
                    a => typeof a.slotIndex === 'number' && a.slotIndex === slotIdx
                  );

                  if (slotAppointment && ACTIVE_STATUSES.has(slotAppointment.status)) {
                    // Another active appointment exists at this slot - reservation is stale
                    staleReservationsToDelete.push(reservationRef);
                  } else {
                    // No active appointment at this slot - reservation is orphaned but still valid.
                    // Only treat it as blocking if it is NOT from advance booking.
                    if (reservedBy !== 'appointment-booking') {
                      existingReservations.set(slotIdx, reservedTime);
                    }
                  }
                }
              } else {
                // Temporary reservation (not booked) - use simpler logic
                // Check if there's an existing appointment at this slot
                const existingAppt = effectiveAppointments.find(
                  a => typeof a.slotIndex === 'number' && a.slotIndex === slotIdx
                );

                // If appointment exists and is NOT active (Cancelled or No-show), ignore reservation
                if (existingAppt && !ACTIVE_STATUSES.has(existingAppt.status)) {
                  staleReservationsToDelete.push(reservationRef);
                } else {
                  // No appointment, or appointment is active - respect reservation
                  existingReservations.set(slotIdx, reservedTime);
                }
              }
            } else {
              // Stale reservation - mark for deletion
              staleReservationsToDelete.push(reservationRef);
            }
          } else {
            // Can't parse time - assume stale and delete
            staleReservationsToDelete.push(reservationRef);
          }
        } catch (e) {
          // Parsing error - assume stale and delete
          staleReservationsToDelete.push(reservationRef);
        }
      } else {
        // No reservedAt timestamp - assume stale and delete
        staleReservationsToDelete.push(reservationRef);
      }
    }
  }

  // CRITICAL: Before doing any writes, we need to calculate potential bucket slotIndex
  // and read its reservation. This is required because Firestore transactions require
  // all reads before all writes.
  let potentialBucketSlotIndex: number | null = null;
  let potentialBucketReservationRef: DocumentReference | null = null;
  let potentialBucketReservationSnapshot: DocumentSnapshot | null = null;

  // Calculate allSlotsFilled early (before any writes) - needed for bucket compensation check
  const allSlotsFilledEarly = (() => {
    const occupiedSlots = new Set<number>();
    effectiveAppointments.forEach(appt => {
      if (
        typeof appt.slotIndex === 'number' &&
        ACTIVE_STATUSES.has(appt.status) &&
        (!appt.cancelledByBreak || appt.status === 'Completed' || appt.status === 'Skipped')
      ) {
        occupiedSlots.add(appt.slotIndex);
      }
    });
    // Check if all slots in availability (future slots only, excluding cancelled slots in bucket) are occupied
    // Note: cancelledSlotsInBucket hasn't been calculated yet, so we can't check it here
    // We'll use a simplified check - if all future slots are occupied, we might need bucket
    for (const slot of slots) {
      if (isBefore(slot.time, now)) {
        continue; // Skip past slots
      }
      if (!occupiedSlots.has(slot.index)) {
        return false; // Found an empty slot
      }
    }
    return true; // All available future slots are occupied
  })();

  // Calculate potential bucket slotIndex if bucket compensation might be needed
  // This calculation only depends on already-read data, so it's safe to do before writes
  // We'll use a conservative check - if slots might be filled and walk-ins exist, read the reservation
  // Note: We can't check firestoreBucketCount here because it's calculated later
  if (allSlotsFilledEarly && hasExistingWalkIns) {
    // Calculate potential newSlotIndex using the same logic as Strategy 4
    let lastWalkInSlotIndex = -1;
    if (activeWalkIns.length > 0) {
      const sortedWalkIns = [...activeWalkIns].sort((a, b) =>
        (typeof a.slotIndex === 'number' ? a.slotIndex : -1) -
        (typeof b.slotIndex === 'number' ? b.slotIndex : -1)
      );
      const lastWalkIn = sortedWalkIns[sortedWalkIns.length - 1];
      lastWalkInSlotIndex = typeof lastWalkIn?.slotIndex === 'number'
        ? lastWalkIn.slotIndex
        : -1;
    }
    const lastSlotIndexFromSlots = slots.length > 0 ? slots.length - 1 : -1;

    if (lastWalkInSlotIndex >= 0 && walkInSpacingValue > 0) {
      const advanceAppointmentsAfterLastWalkIn = activeAdvanceAppointments
        .filter(appt => {
          const apptSlotIndex = typeof appt.slotIndex === 'number' ? appt.slotIndex : -1;
          return apptSlotIndex > lastWalkInSlotIndex;
        })
        .sort((a, b) => {
          const aIdx = typeof a.slotIndex === 'number' ? a.slotIndex : -1;
          const bIdx = typeof b.slotIndex === 'number' ? b.slotIndex : -1;
          return aIdx - bIdx;
        });
      const advanceCountAfterLastWalkIn = advanceAppointmentsAfterLastWalkIn.length;

      if (advanceCountAfterLastWalkIn > walkInSpacingValue) {
        const nthAdvanceAppointment = advanceAppointmentsAfterLastWalkIn[walkInSpacingValue - 1];
        const nthAdvanceSlotIndex = typeof nthAdvanceAppointment.slotIndex === 'number'
          ? nthAdvanceAppointment.slotIndex
          : -1;
        if (nthAdvanceSlotIndex >= 0) {
          potentialBucketSlotIndex = nthAdvanceSlotIndex + 1;
        } else {
          const lastAdvanceAfterWalkIn = advanceAppointmentsAfterLastWalkIn[advanceAppointmentsAfterLastWalkIn.length - 1];
          const lastAdvanceSlotIndex = typeof lastAdvanceAfterWalkIn.slotIndex === 'number'
            ? lastAdvanceAfterWalkIn.slotIndex
            : -1;
          potentialBucketSlotIndex = lastAdvanceSlotIndex >= 0 ? lastAdvanceSlotIndex + 1 : lastSlotIndexFromSlots + 1;
        }
      } else if (advanceAppointmentsAfterLastWalkIn.length > 0) {
        const lastAdvanceAfterWalkIn = advanceAppointmentsAfterLastWalkIn[advanceAppointmentsAfterLastWalkIn.length - 1];
        const lastAdvanceSlotIndex = typeof lastAdvanceAfterWalkIn.slotIndex === 'number'
          ? lastAdvanceAfterWalkIn.slotIndex
          : -1;
        potentialBucketSlotIndex = lastAdvanceSlotIndex >= 0 ? lastAdvanceSlotIndex + 1 : lastSlotIndexFromSlots + 1;
      } else {
        potentialBucketSlotIndex = lastWalkInSlotIndex + 1;
      }
    } else {
      const allSlotIndicesFromAppointments = effectiveAppointments
        .map(appointment => typeof appointment.slotIndex === 'number' ? appointment.slotIndex : -1)
        .filter(idx => idx >= 0);
      const maxSlotIndexFromAppointments = allSlotIndicesFromAppointments.length > 0
        ? Math.max(...allSlotIndicesFromAppointments)
        : -1;
      const maxSlotIndex = Math.max(maxSlotIndexFromAppointments, lastSlotIndexFromSlots);
      potentialBucketSlotIndex = maxSlotIndex + 1;
    }

    // Read the potential bucket reservation BEFORE any writes
    if (potentialBucketSlotIndex !== null) {
      const bucketReservationId = buildReservationDocId(clinicId, doctorName, dateStr, potentialBucketSlotIndex);
      potentialBucketReservationRef = doc(firestore, 'slot-reservations', bucketReservationId);
      potentialBucketReservationSnapshot = await transaction.get(potentialBucketReservationRef);
    }
  }

  // Delete stale reservations within the transaction - DEFERRED
  // Instead of executing immediately, we add to reservationDeletes map
  // for the caller to execute.
  for (const staleRef of staleReservationsToDelete) {
    reservationDeletes.set(staleRef.path, staleRef);
  }

  // New: Capture reservation writes (e.g. bucket)
  const reservationWrites: { ref: DocumentReference; data: any }[] = [];

  // Normalize indices helper
  const sessionStartSlotIndex = slots.length > 0 ? slots[0].index : 0;
  const normalizeIndex = (idx: number | undefined): number | undefined => {
    if (typeof idx !== 'number') return idx;
    if (idx >= 1000) return (idx % 1000) + sessionStartSlotIndex;
    return idx;
  };

  // Create placeholder walk-in candidates for reserved slots
  // This tells the scheduler that these slots are already taken
  const reservedWalkInCandidates = Array.from(existingReservations.entries()).map(([slotIndex, reservedTime], idx) => ({
    id: `__reserved_${slotIndex}__`,
    numericToken: totalSlots + 1000 + idx, // High token number to ensure they're placed correctly
    createdAt: reservedTime,
    currentSlotIndex: normalizeIndex(slotIndex), // CRITICAL: Normalize reservation indices
  }));

  // For actual booking, we MUST include existing walk-ins as candidates 
  // so the scheduler correctly accounts for spacing between them.
  const baseWalkInCandidates = activeWalkIns.map(appt => ({
    id: appt.id,
    numericToken: typeof appt.numericToken === 'number' ? appt.numericToken : (Number(appt.numericToken) || 0),
    createdAt: (appt.createdAt as any)?.toDate?.() || appt.createdAt || now,
    currentSlotIndex: normalizeIndex(appt.slotIndex), // CRITICAL: Normalize walk-in indices
  }));

  const newWalkInCandidate = {
    id: '__new_walk_in__',
    numericToken: newWalkInNumericToken,
    createdAt: now,
  };

  console.log('[Walk-in Scheduling:DEBUG] Walk-in candidates before scheduler:', {
    baseWalkIns: baseWalkInCandidates.map(w => ({ id: w.id, token: w.numericToken, currentSlot: w.currentSlotIndex })),
    reserved: reservedWalkInCandidates.map(r => ({ id: r.id, token: r.numericToken, currentSlot: r.currentSlotIndex })),
    newWalkIn: { id: newWalkInCandidate.id, token: newWalkInCandidate.numericToken }
  });

  const oneHourAhead = addMinutes(now, 60);

  // Find cancelled slots in 1-hour window
  const cancelledSlotsInWindow: Array<{ slotIndex: number; slotTime: Date }> = [];
  let bucketCount = 0;

  // Build set of slots with active appointments
  const slotsWithActiveAppointments = new Set<number>();
  effectiveAppointments.forEach(appt => {
    if (
      typeof appt.slotIndex === 'number' &&
      ACTIVE_STATUSES.has(appt.status)
    ) {
      slotsWithActiveAppointments.add(appt.slotIndex);
    }
  });

  // Get all active walk-ins with their slot times for comparison
  const activeWalkInsWithTimes = activeWalkIns
    .filter(appt => typeof appt.slotIndex === 'number')
    .map(appt => {
      const slotMeta = slots.find(s => s.index === appt.slotIndex!);
      return {
        appointment: appt,
        slotIndex: appt.slotIndex!,
        slotTime: slotMeta?.time,
      };
    })
    .filter(item => item.slotTime !== undefined);

  for (const appointment of effectiveAppointments) {
    if (
      (appointment.status === 'Cancelled' || appointment.status === 'No-show') &&
      typeof appointment.slotIndex === 'number'
    ) {
      const slotMeta = slots.find(s => s.index === appointment.slotIndex);
      if (slotMeta) {
        // For bucket count: Include past slots (within 1 hour window)
        // Only check upper bound (1 hour ahead), don't filter out past slots
        const isInBucketWindow = !isAfter(slotMeta.time, oneHourAhead);

        if (isInBucketWindow) {
          // Only process if there's no active appointment at this slot
          if (!slotsWithActiveAppointments.has(appointment.slotIndex)) {
            // Check if there are walk-ins scheduled AFTER this cancelled slot's time
            const hasWalkInsAfter = activeWalkInsWithTimes.some(
              walkIn => walkIn.slotTime && isAfter(walkIn.slotTime, slotMeta.time)
            );

            if (hasWalkInsAfter) {
              // There are walk-ins after this cancelled slot - walk-ins cannot use it
              // Add to bucket count if walk-ins exist, or it's available only for A tokens
              if (hasExistingWalkIns) {
                bucketCount += 1;
              }
              // If no walk-ins exist but there are walk-ins after (shouldn't happen, but handle it),
              // it goes to bucket count
            } else {
              // No walk-ins after this cancelled slot - walk-ins CAN use it
              // Only add to cancelledSlotsInWindow if slot is not in the past (for direct use)
              if (!hasExistingWalkIns && !isBefore(slotMeta.time, now)) {
                // No walk-ins exist at all - first walk-in can use this cancelled slot (if not past)
                cancelledSlotsInWindow.push({
                  slotIndex: appointment.slotIndex,
                  slotTime: slotMeta.time,
                });
              }
              // If walk-ins exist but none after this slot, walk-ins can still use it
              // So we don't add it to bucket count - it's available for walk-ins
            }
          }
        }
      }
    }
  }

  // Calculate bucket count on-the-fly from appointments (no Firestore needed)
  // Bucket count = cancelled slots in 1-hour window that have walk-ins AFTER them
  // Subtract walk-ins placed outside availability (they're "using" bucket slots)
  // This is calculated dynamically, so it's always accurate

  // Count walk-ins placed outside availability (slotIndex beyond slots.length)
  // These are "using" bucket slots, so we subtract them from the bucket count
  const walkInsOutsideAvailability = activeWalkIns.filter(appt => {
    if (typeof appt.slotIndex !== 'number') return false;
    return appt.slotIndex >= slots.length; // Outside availability
  });
  const usedBucketSlots = walkInsOutsideAvailability.length;

  // Effective bucket count = cancelled slots in bucket - walk-ins using bucket slots
  const firestoreBucketCount = Math.max(0, bucketCount - usedBucketSlots);

  console.info('[Walk-in Scheduling] Bucket calculation:', {
    cancelledSlotsInBucket: bucketCount,
    walkInsOutsideAvailability: usedBucketSlots,
    effectiveBucketCount: firestoreBucketCount,
  });

  const averageConsultingTime = doctor.averageConsultingTime || 15;
  const totalMinutes =
    slots.length > 0
      ? Math.max(
        differenceInMinutes(
          addMinutes(slots[slots.length - 1].time, averageConsultingTime),
          slots.length > 0 ? slots[0].time : now
        ),
        0
      )
      : 0;
  const completedCount = effectiveAppointments.filter(
    appointment => appointment.status === 'Completed'
  ).length;
  const expectedMinutes = completedCount * averageConsultingTime;
  const actualElapsedRaw =
    slots.length > 0 && slots[0].time ? differenceInMinutes(now, slots[0].time) : 0;
  const actualElapsed = Math.max(0, Math.min(actualElapsedRaw, totalMinutes));
  const delayMinutes = actualElapsed - expectedMinutes;

  // Build set of cancelled slots in bucket (blocked from walk-in scheduling)
  // Only cancelled slots that have walk-ins AFTER them go to bucket
  const cancelledSlotsInBucket = new Set<number>();
  if (hasExistingWalkIns) {
    console.warn('[Walk-in Scheduling] Building cancelled slots in bucket. Active walk-ins:', activeWalkInsWithTimes.length);
    for (const appointment of effectiveAppointments) {
      if (
        (appointment.status === 'Cancelled' || appointment.status === 'No-show') &&
        typeof appointment.slotIndex === 'number'
      ) {
        const slotMeta = slots.find(s => s.index === appointment.slotIndex);
        if (slotMeta) {
          // For bucket: Include past slots (within 1 hour window)
          // Only check upper bound (1 hour ahead), don't filter out past slots
          const isInBucketWindow = !isAfter(slotMeta.time, oneHourAhead);
          const hasActiveAppt = slotsWithActiveAppointments.has(appointment.slotIndex);

          if (
            isInBucketWindow &&
            !hasActiveAppt
          ) {
            // Check if there are walk-ins scheduled AFTER this cancelled slot's time
            const hasWalkInsAfter = activeWalkInsWithTimes.some(
              walkIn => walkIn.slotTime && isAfter(walkIn.slotTime, slotMeta.time)
            );

            if (hasWalkInsAfter) {
              // This is a cancelled slot with walk-ins after it - block it from walk-in scheduling
              // It goes to bucket (only A tokens can use it, or bucket can use it when all slots filled)
              cancelledSlotsInBucket.add(appointment.slotIndex);
              console.warn(`[Walk-in Scheduling] ✅ BLOCKING cancelled slot ${appointment.slotIndex} (has walk-ins after)`);
            } else {
              // If no walk-ins after this slot, it's NOT in bucket - walk-ins CAN use it
              console.warn(`[Walk-in Scheduling] ❌ NOT blocking cancelled slot ${appointment.slotIndex} (no walk-ins after)`);
            }
          } else {
            console.warn(`[Walk-in Scheduling] Skipping cancelled slot ${appointment.slotIndex}: isInBucketWindow=${isInBucketWindow}, hasActiveAppt=${hasActiveAppt}`);
          }
        }
      }
    }
  } else {
    console.warn('[Walk-in Scheduling] No existing walk-ins, skipping bucket logic');
  }

  console.warn('[Walk-in Scheduling] Final cancelled slots in bucket:', Array.from(cancelledSlotsInBucket));

  // Also track cancelled slots that walk-ins CAN use (no walk-ins after them)
  const cancelledSlotsAvailableForWalkIns: Array<{ slotIndex: number; slotTime: Date }> = [];
  if (hasExistingWalkIns) {
    for (const appointment of effectiveAppointments) {
      if (
        (appointment.status === 'Cancelled' || appointment.status === 'No-show') &&
        typeof appointment.slotIndex === 'number'
      ) {
        const slotMeta = slots.find(s => s.index === appointment.slotIndex);
        if (
          slotMeta &&
          !isBefore(slotMeta.time, now) &&
          !isAfter(slotMeta.time, oneHourAhead) &&
          !slotsWithActiveAppointments.has(appointment.slotIndex)
        ) {
          // Check if there are walk-ins scheduled AFTER this cancelled slot's time
          const hasWalkInsAfter = activeWalkInsWithTimes.some(
            walkIn => walkIn.slotTime && isAfter(walkIn.slotTime, slotMeta.time)
          );

          if (!hasWalkInsAfter) {
            // No walk-ins after this slot - walk-ins CAN use it
            cancelledSlotsAvailableForWalkIns.push({
              slotIndex: appointment.slotIndex,
              slotTime: slotMeta.time,
            });
          }
        }
      }
    }
  }

  type ScheduleAttemptResult = {
    schedule: ReturnType<typeof computeWalkInSchedule>;
    newAssignment: SchedulerAssignment;
    placeholderIds: Set<string>;
  };

  const attemptSchedule = (useCancelledSlot: number | null): ScheduleAttemptResult | null => {
    // If using a cancelled slot directly (first walk-in case), create assignment directly
    if (useCancelledSlot !== null) {
      const cancelledSlot = slots.find(s => s.index === useCancelledSlot);
      if (cancelledSlot) {
        return {
          schedule: { assignments: [] },
          newAssignment: {
            id: '__new_walk_in__',
            slotIndex: useCancelledSlot,
            sessionIndex: cancelledSlot.sessionIndex,
            slotTime: cancelledSlot.time,
          },
          placeholderIds: new Set(),
        };
      }
      return null;
    }

    // Normal scheduling - run scheduler
    // Include cancelled slots in bucket as "blocked" advance appointments
    // so the scheduler treats them as occupied and doesn't assign walk-ins to them
    const blockedAdvanceAppointments = activeAdvanceAppointments.map(entry => {
      // CRITICAL: Identify immovable slots (BreakBlocks or Completed appointments)
      // The scheduler treats IDs starting with '__blocked_' as immovable.
      // NOTE: 'Skipped' should be treated as movable/active in the queue context (unless specified otherwise)
      // In calculateWalkInDetails we treated Skipped as blocked? Let's align.
      // Actually, standard is: Completed = Blocked. Pending/Confirmed/Skipped = Active (Shiftable).

      const isBreakBlock = (entry.bookedVia as string) === 'BreakBlock';
      const isStrictlyImmovable = entry.status === 'Completed';

      // Use different prefixes so scheduler knows what can be moved
      let idPrefix = '__shiftable_';
      if (isBreakBlock) {
        idPrefix = '__break_';
      } else if (isStrictlyImmovable) {
        idPrefix = '__blocked_';
      }

      // DEBUG: Log status handling
      if (entry.status === 'Skipped') {
        console.log(`[Walk-in Scheduling:DEBUG] Skipped appointment ${entry.id} treated as ${idPrefix} (Immovable=${idPrefix === '__blocked_'})`);
      }

      return {
        id: `${idPrefix}${entry.id}`,
        slotIndex: typeof entry.slotIndex === 'number' ? entry.slotIndex : -1,
      };
    });

    console.log('[Walk-in Scheduling:DEBUG] Blocked Advance Appointments Summary:', blockedAdvanceAppointments.map(a => `${a.id}:${a.slotIndex}`));

    // CRITICAL: REMOVED the hack that added existing walk-ins as blocked advance appointments.
    // This was causing a type mismatch ('type: A') in the scheduler's occupancy map,
    // which led to collisions during shift operations.
    // Existing walk-ins are correctly handled via walkInCandidates.

    // Add cancelled slots in bucket as blocked slots (treat as occupied)
    // These are cancelled slots that have walk-ins AFTER them, so walk-ins cannot use them
    console.warn('[Walk-in Scheduling] Before blocking - blockedAdvanceAppointments count:', blockedAdvanceAppointments.length);
    console.warn('[Walk-in Scheduling] Cancelled slots in bucket:', Array.from(cancelledSlotsInBucket));

    if (cancelledSlotsInBucket.size > 0) {
      console.warn('[Walk-in Scheduling] ✅ BLOCKING cancelled slots in bucket:', Array.from(cancelledSlotsInBucket));
      cancelledSlotsInBucket.forEach(slotIndex => {
        blockedAdvanceAppointments.push({
          id: `__blocked_cancelled_${slotIndex}`,
          slotIndex: slotIndex,
        });
        console.warn(`[Walk-in Scheduling] Added blocked cancelled slot ${slotIndex} to advance appointments`);
      });
    } else {
      console.warn('[Walk-in Scheduling] ❌ No cancelled slots to block (bucket is empty)');
    }

    console.warn('[Walk-in Scheduling] After blocking - blockedAdvanceAppointments count:', blockedAdvanceAppointments.length);
    console.warn('[Walk-in Scheduling] Blocked advance appointments:', blockedAdvanceAppointments.map(a => ({ id: a.id, slotIndex: a.slotIndex })));


    const allWalkInCandidates = [...baseWalkInCandidates, ...reservedWalkInCandidates, newWalkInCandidate];
    console.warn('[Walk-in Scheduling] Scheduler inputs:', {
      totalSlots: slots.length,
      blockedAdvanceCount: blockedAdvanceAppointments.length,
      existingWalkInsCount: baseWalkInCandidates.length,
      reservedCount: reservedWalkInCandidates.length,
      existingWalkInSlots: baseWalkInCandidates.map(w => w.currentSlotIndex),
      reservedSlots: reservedWalkInCandidates.map(w => w.currentSlotIndex),
    });

    // Declare variables at higher scope so they are available for return
    let newAssignment: SchedulerAssignment | null = null;
    let schedule: ReturnType<typeof computeWalkInSchedule> | null = null;


    // FORCE BOOKING BYPASS: Skip scheduler and append to end
    // Force bookings should not trigger rebalancing or shift existing appointments
    if (forceBook) {
      console.log('[Walk-in Scheduling] Force booking detected - skipping scheduler, appending to end');

      // Find the maximum occupied slot index from all active appointments
      const allOccupiedSlots = effectiveAppointments
        .filter(apt => ACTIVE_STATUSES.has(apt.status) && typeof apt.slotIndex === 'number')
        .map(apt => apt.slotIndex as number);

      const maxOccupiedSlot = allOccupiedSlots.length > 0
        ? Math.max(...allOccupiedSlots)
        : -1;

      const forceBookSlotIndex = maxOccupiedSlot + 1;

      // Determine session index for the force-booked slot
      const forceBookSessionIndex = (() => {
        if (forceBookSlotIndex < slots.length) {
          return slots.find(s => s.index === forceBookSlotIndex)?.sessionIndex ?? 0;
        }
        // If beyond available slots, use the last session index
        const lastSlot = slots[slots.length - 1];
        return lastSlot ? lastSlot.sessionIndex : 0;
      })();

      // Calculate time for force-booked slot
      const slotDuration = doctor.averageConsultingTime || 15;
      let forceBookTime: Date;

      const foundSlot = slots.find(s => s.index === forceBookSlotIndex);
      if (foundSlot) {
        // Within availability - use slot's time
        forceBookTime = foundSlot.time;
      } else {
        // Beyond availability - calculate from last slot
        const lastSlot = slots[slots.length - 1];
        if (lastSlot) {
          // Use relative indexing to handle remapped/segmented indices
          const getRelativeIndex = (idx: number) => {
            if (idx >= 10000) return idx % 10000;
            if (idx >= 1000) return idx % 1000;
            return idx;
          };

          const relativeForceIndex = getRelativeIndex(forceBookSlotIndex);
          const relativeLastIndex = getRelativeIndex(lastSlot.index);
          const slotsAfterAvailability = relativeForceIndex - relativeLastIndex;

          forceBookTime = addMinutes(lastSlot.time, slotsAfterAvailability * slotDuration);
        } else {
          forceBookTime = now;
        }
      }

      console.log('[Walk-in Scheduling] Force booking assigned to slot:', {
        slotIndex: forceBookSlotIndex,
        sessionIndex: forceBookSessionIndex,
        time: forceBookTime.toISOString(),
        maxOccupiedSlot,
      });

      // Return assignment without calling scheduler
      newAssignment = {
        id: '__new_walk_in__',
        slotIndex: forceBookSlotIndex,
        sessionIndex: forceBookSessionIndex,
        slotTime: forceBookTime,
      };
      // Stub schedule for force book
      schedule = { assignments: [] };
    } else {
      // Normal walk-in booking - use scheduler

      // CRITICAL FIX: Ensure scheduler has enough "virtual" slots for spillover.
      const bufferSlotsCount = 20;
      const extendedSlots = [...slots];
      const lastSlot = slots[slots.length - 1];

      if (lastSlot) {
        const slotDuration = doctor.averageConsultingTime || 10;
        for (let i = 1; i <= bufferSlotsCount; i++) {
          extendedSlots.push({
            index: lastSlot.index + i,
            time: addMinutes(lastSlot.time, i * slotDuration),
            sessionIndex: lastSlot.sessionIndex,
          } as any);
        }
      }

      // CRITICAL FIX: Normalize indices!
      const sessionStartSlotIndex = slots.length > 0 ? slots[0].index : 0;
      const normalizedAdvanceAppointments = blockedAdvanceAppointments.map(app => {
        let normalizedSlotIndex = app.slotIndex;
        // If index is segmented (1000+), convert to continuous by subtracting session start
        if (typeof app.slotIndex === 'number' && app.slotIndex >= 1000) {
          // CRITICAL FIX: Subtract sessionStartSlotIndex to get continuous index
          // Example: slot 1005 in Session 1 (start=1000) → 1005 - 1000 = 5
          normalizedSlotIndex = app.slotIndex - sessionStartSlotIndex;
        }
        return { ...app, slotIndex: normalizedSlotIndex };
      }).filter(app => {
        return typeof app.slotIndex === 'number' && app.slotIndex >= 0 && app.slotIndex < extendedSlots.length;
      });

      console.log('[Walk-in Scheduling:DEBUG] Calling scheduler with:', {
        extendedSlotsCount: extendedSlots.length,
        normalizedAdvanceCount: normalizedAdvanceAppointments.length,
        normalizedAdvance: normalizedAdvanceAppointments.map(a => ({ id: a.id, slotIndex: a.slotIndex })),
        allWalkInCandidatesCount: allWalkInCandidates.length,
        allWalkInCandidates: allWalkInCandidates.map(w => ({ id: w.id, token: w.numericToken, currentSlot: w.currentSlotIndex }))
      });

      schedule = computeWalkInSchedule({
        slots: extendedSlots,
        now,
        walkInTokenAllotment: walkInSpacingValue,
        advanceAppointments: normalizedAdvanceAppointments,
        walkInCandidates: allWalkInCandidates,
      });

      console.log('[Walk-in Scheduling:DEBUG] Scheduler result:', {
        assignmentsCount: schedule?.assignments.length,
        newWalkInAssignment: schedule?.assignments.find(a => a.id === '__new_walk_in__')
      });

      newAssignment = schedule.assignments.find(
        assignment => assignment.id === '__new_walk_in__'
      ) || null;

      // CRITICAL FIX: Convert position-based slot index back to segmented format
      // The scheduler works with position-based indices (0-N), but we need segmented indices
      // for multi-session schedules (e.g., session 1 uses 1000-1999)
      if (newAssignment) {
        const sessionStartSlotIndex = slots.length > 0 ? slots[0].index : 0;
        const positionIndex = newAssignment.slotIndex;

        // Convert back to segmented index
        // If this is session 1+, convert position to segmented (1000+)
        if (newAssignment.sessionIndex > 0) {
          const segmentedIndex = (newAssignment.sessionIndex * 1000) + (positionIndex - sessionStartSlotIndex);
          console.log('[Walk-in Scheduling] Converting position to segmented index:', {
            position: positionIndex,
            sessionIndex: newAssignment.sessionIndex,
            sessionStart: sessionStartSlotIndex,
            segmented: segmentedIndex
          });
          newAssignment = {
            ...newAssignment,
            slotIndex: segmentedIndex
          };
        }
      }
    }


    if (!newAssignment || !schedule) {
      console.warn('[Walk-in Scheduling] No assignment found for new walk-in - all slots may be full', {
        totalSlots: slots.length,
        blockedAdvanceCount: blockedAdvanceAppointments.length,
        existingWalkInsCount: baseWalkInCandidates.length,
      });
      return null;
    }

    console.log('[Walk-in Scheduling] Scheduler assigned new walk-in to slot:', newAssignment.slotIndex);
    console.log('[Walk-in Scheduling] Blocked cancelled slots in bucket:', Array.from(cancelledSlotsInBucket));
    console.log('[Walk-in Scheduling] Active walk-ins with times:', activeWalkInsWithTimes.map(w => ({ slotIndex: w.slotIndex, time: w.slotTime })));

    // CRITICAL: Check if the assigned slot is already reserved by a concurrent request
    // This must happen IMMEDIATELY after scheduler assignment to prevent race conditions
    if (existingReservations.has(newAssignment.slotIndex)) {
      // Check if this is a FALSE POSITIVE: Is the slot occupied by an appointment that is VACATING it?
      // If the scheduler moved the current occupant, then the reservation (for the old spot) can be ignored.
      const currentOccupant = effectiveAppointments.find(a =>
        ACTIVE_STATUSES.has(a.status) && typeof a.slotIndex === 'number' && a.slotIndex === newAssignment!.slotIndex
      );

      let isVacating = false;
      if (currentOccupant) {
        // Find if this occupant is assigned to a DIFFERENT slot in the final plan
        // We check all possible prefixes
        const occupantAssignment = schedule.assignments.find(a => a.id.includes(currentOccupant.id));

        if (occupantAssignment && occupantAssignment.slotIndex !== newAssignment.slotIndex) {
          isVacating = true;
          console.log(`[Walk-in Scheduling] Reservation conflict at ${newAssignment.slotIndex} ignored - occupant ${currentOccupant.id} is vacating to ${occupantAssignment.slotIndex}`);
        }
      }

      if (!isVacating) {
        console.error('[Walk-in Scheduling] ERROR: Scheduler assigned to slot that is already reserved by concurrent request:', newAssignment.slotIndex);
        // Mark as conflict so caller knows to throw conflict error for retry
        hasReservationConflict = true;
        return null; // Reject this assignment, will retry with different slot
      }
    }

    // Check if the assigned slot is a cancelled slot
    const assignedAppointment = effectiveAppointments.find(
      apt => apt.slotIndex === newAssignment.slotIndex &&
        (apt.status === 'Cancelled' || apt.status === 'No-show')
    );

    if (assignedAppointment) {
      const assignedSlotMeta = slots.find(s => s.index === newAssignment.slotIndex);
      console.log(`[Walk-in Scheduling] Assigned slot ${newAssignment.slotIndex} is a cancelled/no-show slot at time:`, assignedSlotMeta?.time);

      // Check if this cancelled slot should be blocked (has walk-ins after it)
      if (hasExistingWalkIns && cancelledSlotsInBucket.has(newAssignment.slotIndex)) {
        // This shouldn't happen since we blocked them, but reject if it does
        console.error('[Walk-in Scheduling] ERROR: Scheduler assigned to blocked cancelled slot, rejecting:', newAssignment.slotIndex);
        return null;
      } else if (assignedAppointment) {
        console.log(`[Walk-in Scheduling] Assigned cancelled slot ${newAssignment.slotIndex} is available (no walk-ins after it)`);
      }
    }

    // Double-check: Cancelled slots in bucket are now blocked via advance appointments,
    // so the scheduler shouldn't assign to them. But verify just in case.
    if (hasExistingWalkIns && cancelledSlotsInBucket.has(newAssignment.slotIndex)) {
      // This shouldn't happen since we blocked them, but reject if it does
      console.error('[Walk-in Scheduling] ERROR: Scheduler assigned to blocked cancelled slot (double-check), rejecting:', newAssignment.slotIndex);
      return null;
    }

    // CRITICAL: Prevent slot 0 assignment when all slots are filled
    // If all slots are filled and scheduler assigned slot 0, this is likely an error
    if (newAssignment.slotIndex === 0 && allSlotsFilledEarly) {
      console.error('[Walk-in Scheduling] ERROR: Scheduler assigned slot 0 when all slots are filled - rejecting:', newAssignment.slotIndex);
      return null; // Reject this assignment, will use bucket compensation instead
    }


    // CRITICAL FIX: Verify the assignment is valid. If it's an overflow slot (index > last available slot index),
    // we must have explicit permission (forceBook) or valid bucket compensation.
    // IMPORTANT: Use the ABSOLUTE index (before segmented conversion) for this check
    const absoluteSlotIndex = schedule.assignments.find(a => a.id === '__new_walk_in__')?.slotIndex || newAssignment.slotIndex;
    const lastAvailableSlotIndex = slots.length > 0 ? slots[slots.length - 1].index : -1;
    const isOverflowSlot = absoluteSlotIndex > lastAvailableSlotIndex;

    if (isOverflowSlot && !forceBook && cancelledSlotsInBucket.size === 0) {
      console.error('[Walk-in Scheduling] ERROR: Scheduler assigned virtual overflow slot without forceBook or bucket credits - rejecting:', {
        assignedSlot: absoluteSlotIndex,
        assignedSlotSegmented: newAssignment.slotIndex,
        lastAvailableSlot: lastAvailableSlotIndex,
        totalSlots: slots.length
      });
      return null;
    }

    return { schedule, newAssignment, placeholderIds: new Set() };
  };

  // Check if all slots in availability (future slots only, excluding cancelled slots in bucket) are occupied
  const allSlotsFilled = (() => {
    // ------------------------------------------------------------------------
    // REVISED LOGIC: Account for "Overflow" appointments filling gaps in Scheduler
    // ------------------------------------------------------------------------
    let freeFutureSlotsCount = 0;
    const occupiedIndices = new Set<number>();

    // 1. Identify Occupied Indices from Appointments & Blocked
    const registerOccupancy = (idx: number) => {
      if (typeof idx === 'number') occupiedIndices.add(idx);
    };

    effectiveAppointments.forEach(appt => {
      if (typeof appt.slotIndex === 'number' && ACTIVE_STATUSES.has(appt.status) && (!appt.cancelledByBreak || appt.status === 'Completed' || appt.status === 'Skipped')) {
        occupiedIndices.add(appt.slotIndex);
      }
    });

    // 2. Count "Free" Slots in the future
    for (const slot of slots) {
      if (isBefore(slot.time, now)) continue;
      if (hasExistingWalkIns && cancelledSlotsInBucket.has(slot.index)) continue; // Blocked by bucket

      if (!occupiedIndices.has(slot.index)) {
        freeFutureSlotsCount++;
      }
    }

    // 3. Count "Overflow" Appointments (Indices >= lastSlotIndexInSession + 1)
    let overflowCount = 0;
    effectiveAppointments.forEach(appt => {
      if (ACTIVE_STATUSES.has(appt.status) && (!appt.cancelledByBreak || appt.status === 'Completed' || appt.status === 'Skipped')) {
        const lastSlotIndexInSession = slots.length > 0
          ? Math.max(...slots.map(s => s.index))
          : -1;

        if (typeof appt.slotIndex === 'number' && appt.slotIndex > lastSlotIndexInSession) {
          overflowCount++;
        }
      }
    });

    // Final verdict: Session is full if free slots <= overflow count
    const isFull = freeFutureSlotsCount <= overflowCount;

    console.log('[WALK-IN:SCHEDULER:CAPACITY] Check:', {
      freeFutureSlotsCount,
      overflowCount,
      isFull,
      totalSlots: slots.length,
      occupiedIndices: Array.from(occupiedIndices),
      now: now.toISOString()
    });

    return isFull;
  })();

  let scheduleAttempt: ScheduleAttemptResult | null = null;
  let usedCancelledSlot: number | null = null;
  let usedBucket = false;
  let usedBucketSlotIndex: number | null = null;
  let bucketReservationRef: DocumentReference | null = null;
  hasReservationConflict = false; // Track if failure was due to reservation conflict
  let newSlotIndex = -1;
  let lastWalkInSlotIndex = -1;

  // Strategy 1: If no walk-ins exist and cancelled slot in window, use it directly
  if (!hasExistingWalkIns && cancelledSlotsInWindow.length > 0) {
    // Sort by slotIndex (earliest first)
    cancelledSlotsInWindow.sort((a, b) => a.slotIndex - b.slotIndex);
    const earliestCancelledSlot = cancelledSlotsInWindow[0];
    scheduleAttempt = attemptSchedule(earliestCancelledSlot.slotIndex);
    if (!scheduleAttempt && existingReservations.has(earliestCancelledSlot.slotIndex)) {
      hasReservationConflict = true;
    }
    if (scheduleAttempt) {
      usedCancelledSlot = earliestCancelledSlot.slotIndex;
    }
  }

  // Strategy 2: If walk-ins exist, check for cancelled slots available for walk-ins (no walk-ins after them)
  if (!scheduleAttempt && hasExistingWalkIns && cancelledSlotsAvailableForWalkIns.length > 0) {
    // Sort by slotIndex (earliest first)
    cancelledSlotsAvailableForWalkIns.sort((a, b) => a.slotIndex - b.slotIndex);
    const earliestAvailableCancelledSlot = cancelledSlotsAvailableForWalkIns[0];
    scheduleAttempt = attemptSchedule(earliestAvailableCancelledSlot.slotIndex);
    if (!scheduleAttempt && existingReservations.has(earliestAvailableCancelledSlot.slotIndex)) {
      hasReservationConflict = true;
    }
    if (scheduleAttempt) {
      usedCancelledSlot = earliestAvailableCancelledSlot.slotIndex;
    }
  }

  // Strategy 3: Try normal scheduling
  if (!scheduleAttempt) {
    scheduleAttempt = attemptSchedule(null);

    // Check if scheduler assigned to a cancelled slot in bucket (shouldn't happen, but reject if it does)
    if (scheduleAttempt && hasExistingWalkIns && cancelledSlotsInBucket.has(scheduleAttempt.newAssignment.slotIndex)) {
      // Reject - this slot is in the bucket, shouldn't be used by walk-ins
      scheduleAttempt = null;
    }

    // CRITICAL: Double-check reservation after scheduler assignment
    // This catches cases where a concurrent request reserved the slot between scheduler call and now
    // Also, if attemptSchedule returned null due to reservation conflict (line 1914),
    // hasReservationConflict will already be set to true
    if (scheduleAttempt && existingReservations.has(scheduleAttempt.newAssignment.slotIndex)) {
      console.error('[Walk-in Scheduling] ERROR: Slot reserved by concurrent request after scheduler assignment:', scheduleAttempt.newAssignment.slotIndex);
      hasReservationConflict = true; // Mark as conflict so we throw proper error
      scheduleAttempt = null; // Reject, will try bucket compensation
    }

    // CRITICAL: Prevent slot 0 assignment when all slots are filled
    // This should not happen, but if it does, reject and use bucket compensation
    if (scheduleAttempt && scheduleAttempt.newAssignment.slotIndex === 0 && allSlotsFilled) {
      console.error('[Walk-in Scheduling] ERROR: Scheduler assigned slot 0 when all slots are filled - rejecting and using bucket compensation');
      scheduleAttempt = null; // Reject, will use bucket compensation
    }
  }

  // Strategy 4: If normal scheduling fails and all slots are filled, check bucket count
  // Bucket count is calculated on-the-fly, so we can use it directly
  // OR if forceBook is true - manually force an overflow slot
  if (!scheduleAttempt && ((allSlotsFilled && hasExistingWalkIns && firestoreBucketCount > 0) || forceBook)) {
    // CRITICAL: Re-calculate bucket count within transaction to prevent concurrent usage
    // Count walk-ins placed outside availability (they're "using" bucket slots)
    const walkInsOutsideAvailabilityInTx = effectiveAppointments.filter(appt => {
      return (
        appt.bookedVia === 'Walk-in' &&
        typeof appt.slotIndex === 'number' &&
        appt.slotIndex >= slots.length &&
        ACTIVE_STATUSES.has(appt.status)
      );
    });
    const usedBucketSlotsInTx = walkInsOutsideAvailabilityInTx.length;
    const effectiveBucketCountInTx = Math.max(0, bucketCount - usedBucketSlotsInTx);

    // If bucket count is now 0, another concurrent request used it - fail and retry
    // skip this check if forceBook is true
    if (!forceBook && effectiveBucketCountInTx <= 0) {
      console.warn('[Walk-in Scheduling] Bucket count became 0 during transaction - concurrent request used it', {
        originalBucketCount: firestoreBucketCount,
        bucketCountInTx: effectiveBucketCountInTx,
        usedBucketSlotsInTx,
      });
      const bucketError = new Error('Bucket slot was just used by another concurrent request. Retrying...');
      (bucketError as { code?: string }).code = RESERVATION_CONFLICT_CODE;
      throw bucketError;
    }

    // All slots in availability are filled - create new slot at end (outside availability)
    // This will create a slot beyond the availability time
    usedBucket = true;

    // Find the last walk-in position to use as anchor for interval calculation
    lastWalkInSlotIndex = -1;
    if (activeWalkIns.length > 0) {
      const sortedWalkIns = [...activeWalkIns].sort((a, b) =>
        (typeof a.slotIndex === 'number' ? a.slotIndex : -1) -
        (typeof b.slotIndex === 'number' ? b.slotIndex : -1)
      );
      const lastWalkIn = sortedWalkIns[sortedWalkIns.length - 1];
      lastWalkInSlotIndex = typeof lastWalkIn?.slotIndex === 'number'
        ? lastWalkIn.slotIndex
        : -1;
    }

    // Find the last slotIndex from the slots array (represents last slot in last session)
    const lastSlotIndexFromSlots = slots.length > 0 ? slots.length - 1 : -1;

    // Simplified Overflow Logic (No-Push): Always append after ALL appointments
    const allSlotIndicesFromAppointments = effectiveAppointments
      .map(appointment => typeof appointment.slotIndex === 'number' ? appointment.slotIndex : -1)
      .filter(idx => idx >= 0);

    const maxSlotIndexFromAppointmentsValue = allSlotIndicesFromAppointments.length > 0
      ? Math.max(...allSlotIndicesFromAppointments)
      : -1;

    // The new slot index is simply the next one after everything else
    newSlotIndex = Math.max(maxSlotIndexFromAppointmentsValue + 1, lastSlotIndexFromSlots + 1);

    console.info('[Walk-in Scheduling] Bucket compensation - simplified append logic (No-Push):', {
      maxSlotIndexFromAppointments: maxSlotIndexFromAppointmentsValue,
      lastSlotIndexFromSlots,
      newSlotIndex
    });

    // CRITICAL: Check if this slotIndex is already reserved or occupied by another concurrent request
    // Use the reservation snapshot we already read BEFORE any writes
    let bucketReservationSnapshot: DocumentSnapshot | null = null;
    if (potentialBucketSlotIndex === newSlotIndex && potentialBucketReservationRef && potentialBucketReservationSnapshot) {
      // Use the reservation we already read
      bucketReservationSnapshot = potentialBucketReservationSnapshot;
      bucketReservationRef = potentialBucketReservationRef;
    } else {
      // If the calculated slotIndex differs from what we pre-read, we can't read it now
      // (would violate Firestore transaction rules). Create a new ref anyway - we can still write to it.
      // Conflicts will be detected via effectiveAppointments check and on retry if another transaction
      // also tries to create the same reservation.
      const bucketReservationId = buildReservationDocId(clinicId, doctorName, dateStr, newSlotIndex);
      bucketReservationRef = doc(firestore, 'slot-reservations', bucketReservationId);
      bucketReservationSnapshot = null; // We didn't read it, so we don't have a snapshot
    }

    // Check if there's already an appointment at this slotIndex
    const existingAppointmentAtSlot = effectiveAppointments.find(
      apt => typeof apt.slotIndex === 'number' && apt.slotIndex === newSlotIndex && ACTIVE_STATUSES.has(apt.status)
    );

    // Check reservation if we have a snapshot (pre-read case)
    const hasReservation = bucketReservationSnapshot && bucketReservationSnapshot.exists();

    if (hasReservation || existingAppointmentAtSlot) {
      console.warn('[Walk-in Scheduling] SlotIndex already reserved or occupied - concurrent request conflict', {
        newSlotIndex,
        hasReservation,
        hasAppointment: !!existingAppointmentAtSlot,
      });
      const slotError = new Error('Slot was just reserved by another concurrent request. Retrying...');
      (slotError as { code?: string }).code = RESERVATION_CONFLICT_CODE;
      throw slotError;
    }

    // Create reservation for the new bucket slot to prevent concurrent usage
    // Create reservation for the new bucket slot to prevent concurrent usage - DEFERRED
    reservationWrites.push({
      ref: bucketReservationRef,
      data: {
        clinicId,
        doctorName,
        date: dateStr,
        slotIndex: newSlotIndex,
        reservedAt: serverTimestamp(),
        type: 'bucket',
      }
    });

    console.info('[Walk-in Scheduling] Bucket compensation - interval-based placement:', {
      lastWalkInSlotIndex,
      walkInSpacingValue,
      newSlotIndex,
      totalSlots: slots.length,
      lastSlotIndexFromSlots,
      sessions: slots.length > 0 ? new Set(slots.map(s => s.sessionIndex)).size : 0,
    });

    // Calculate time for the new slot based on its position
    // If newSlotIndex is within availability, use the slot's time
    // If newSlotIndex is outside availability, calculate based on last appointment or last slot
    let newSlotTime: Date;
    const slotDuration = doctor.averageConsultingTime || 15;

    const foundSlot = slots.find(s => s.index === newSlotIndex);
    if (foundSlot) {
      // New slot is within availability - use the slot's time
      newSlotTime = foundSlot.time;
      console.info('[Walk-in Scheduling] Bucket compensation - slot within availability:', {
        newSlotIndex,
        slotTime: newSlotTime
      });
    } else {
      // New slot is outside availability - calculate time based on reference appointment
      // Find the appointment at the slotIndex before newSlotIndex (or last appointment)
      const referenceAppointment = effectiveAppointments
        .filter(appt => {
          const apptSlotIndex = typeof appt.slotIndex === 'number' ? appt.slotIndex : -1;
          return apptSlotIndex >= 0 && apptSlotIndex < newSlotIndex && ACTIVE_STATUSES.has(appt.status);
        })
        .sort((a, b) => {
          const aIdx = typeof a.slotIndex === 'number' ? a.slotIndex : -1;
          const bIdx = typeof b.slotIndex === 'number' ? b.slotIndex : -1;
          return bIdx - aIdx; // Get the last one before newSlotIndex
        })[0];

      if (referenceAppointment && referenceAppointment.time) {
        // Use the reference appointment's time + slot duration
        try {
          const appointmentDate = parseClinicDate(dateStr);
          const referenceTime = parseClinicTime(referenceAppointment.time, appointmentDate);
          newSlotTime = addMinutes(referenceTime, slotDuration);
          console.info('[Walk-in Scheduling] Bucket compensation - time from reference appointment:', {
            referenceSlotIndex: referenceAppointment.slotIndex,
            referenceTime: referenceAppointment.time,
            newSlotTime
          });
        } catch (e) {
          // Fallback: use last slot time + duration
          const lastSlot = slots[slots.length - 1];
          const slotsBeyondAvailability = newSlotIndex - lastSlotIndexFromSlots;
          newSlotTime = lastSlot
            ? addMinutes(lastSlot.time, slotDuration * slotsBeyondAvailability)
            : addMinutes(now, slotDuration);
        }
      } else {
        // No reference appointment - use last slot time + duration
        const lastSlot = slots[slots.length - 1];
        const slotsBeyondAvailability = newSlotIndex - lastSlotIndexFromSlots;
        newSlotTime = lastSlot
          ? addMinutes(lastSlot.time, slotDuration * slotsBeyondAvailability)
          : addMinutes(now, slotDuration);
        console.info('[Walk-in Scheduling] Bucket compensation - time from last slot:', {
          lastSlotIndexFromSlots,
          slotsBeyondAvailability,
          newSlotTime
        });
      }
    }

    console.info('[Walk-in Scheduling] Bucket compensation - final time calculation:', {
      newSlotIndex,
      newSlotTime,
      isWithinAvailability: newSlotIndex < slots.length
    });

    // Determine sessionIndex for the new slot
    let sessionIndexForNewSlot: number;
    if (newSlotIndex < slots.length) {
      // Slot is within availability - use the slot's sessionIndex
      const slotMeta = slots.find(s => s.index === newSlotIndex);
      sessionIndexForNewSlot = slotMeta?.sessionIndex ?? 0;
    } else {
      // Slot is outside availability - find reference appointment's sessionIndex or use last slot's
      const referenceAppointment = effectiveAppointments
        .filter(appt => {
          const apptSlotIndex = typeof appt.slotIndex === 'number' ? appt.slotIndex : -1;
          return apptSlotIndex >= 0 && apptSlotIndex < newSlotIndex && ACTIVE_STATUSES.has(appt.status);
        })
        .sort((a, b) => {
          const aIdx = typeof a.slotIndex === 'number' ? a.slotIndex : -1;
          const bIdx = typeof b.slotIndex === 'number' ? b.slotIndex : -1;
          return bIdx - aIdx; // Get the last one before newSlotIndex
        })[0];

      if (referenceAppointment && typeof referenceAppointment.sessionIndex === 'number') {
        sessionIndexForNewSlot = referenceAppointment.sessionIndex;
      } else {
        // Fallback: use last slot's sessionIndex
        const lastSlot = slots[slots.length - 1];
        sessionIndexForNewSlot = lastSlot?.sessionIndex ?? 0;
      }
    }

    // Create synthetic schedule and assignment
    const syntheticAssignment: SchedulerAssignment = {
      id: '__new_walk_in__',
      slotIndex: newSlotIndex,
      sessionIndex: sessionIndexForNewSlot,
      slotTime: newSlotTime,
    };

    scheduleAttempt = {
      schedule: { assignments: [] },
      newAssignment: syntheticAssignment,
      placeholderIds: new Set(),
    };

    // Note: Bucket count is calculated on-the-fly, so we don't need to update Firestore
    // The bucket count will automatically decrease next time because we'll count one less
    // cancelled slot (since we're using one from the bucket)
    console.info('[Walk-in Scheduling] Using bucket slot, bucket count before:', firestoreBucketCount);
    console.info('[Walk-in Scheduling] Bucket compensation - final assignment:', {
      slotIndex: newSlotIndex,
      sessionIndex: syntheticAssignment.sessionIndex,
      slotTime: newSlotTime,
      maxSlotIndexUsed: maxSlotIndexFromAppointmentsValue,
    });
    usedBucketSlotIndex = newSlotIndex;
  }

  if (!scheduleAttempt) {
    // If failure was due to reservation conflict, throw error to trigger retry
    if (hasReservationConflict) {
      console.error('[Walk-in Scheduling] Reservation conflict detected - throwing error to trigger retry');
      const conflictError = new Error(RESERVATION_CONFLICT_CODE);
      (conflictError as { code?: string }).code = RESERVATION_CONFLICT_CODE;
      throw conflictError;
    }
    // Otherwise, return null to indicate no slots available
    return {
      newAssignment: null,
      reservationDeletes: [],
      appointmentUpdates: [],
      usedBucketSlotIndex: null,
      existingReservations: new Map<number, Date>(),
    };
  }

  const scheduleResult = (scheduleAttempt as ScheduleAttemptResult);
  const schedule = scheduleResult.schedule;
  const newAssignment = scheduleResult.newAssignment;
  const placeholderIds = scheduleResult.placeholderIds;

  // CRITICAL: Double-check reservation for the assigned slot using existingReservations map
  // This catches reservations that were in our initial read
  // Note: We cannot do a new Firestore read here as it would violate "all reads before all writes"
  // The existingReservations map contains all reservations we read at the start
  if (existingReservations.has(newAssignment.slotIndex)) {
    console.error(`[Walk-in Scheduling] Reservation conflict detected for scheduler-assigned slot ${newAssignment.slotIndex} (from existingReservations map)`, {
      slotIndex: newAssignment.slotIndex,
      timestamp: new Date().toISOString()
    });
    const conflictError = new Error(RESERVATION_CONFLICT_CODE);
    (conflictError as { code?: string }).code = RESERVATION_CONFLICT_CODE;
    throw conflictError;
  }

  if (DEBUG_BOOKING) {
    console.info('[patient booking] prepareAdvanceShift schedule', schedule.assignments);
  }


  const appointmentUpdates: Array<{
    docRef: DocumentReference;
    slotIndex: number;
    sessionIndex: number;
    timeString: string;
    arriveByTime: string; // Added this
    cutOffTime: Date;
    noShowTime: Date;
  }> = [];

  const assignmentById = new Map(schedule.assignments.map(assignment => [assignment.id, assignment]));

  const updatedAdvanceMap = new Map<string, Appointment>(
    activeAdvanceAppointments.map(appointment => [appointment.id, { ...appointment }])
  );

  const advanceOccupancy: (Appointment | null)[] = new Array(totalSlots).fill(null);
  activeAdvanceAppointments.forEach(appointment => {
    const idx = typeof appointment.slotIndex === 'number' ? appointment.slotIndex : -1;
    if (idx >= 0 && idx < totalSlots) {
      advanceOccupancy[idx] = appointment;
    }
  });

  const reservedSlots = new Set<number>(
    schedule.assignments
      .filter(assignment => !placeholderIds.has(assignment.id) && !assignment.id.startsWith('__reserved_'))
      .map(assignment => assignment.slotIndex)
      .filter((index): index is number => typeof index === 'number' && index >= 0)
  );

  // CRITICAL: Use existingReservations map instead of reading again
  // We already read all reservations before deleting stale ones
  // Reading again here would violate "all reads before all writes" rule
  for (const slotIndex of reservedSlots) {
    const reservationRef = doc(
      firestore,
      'slot-reservations',
      buildReservationDocId(clinicId, doctorName, dateStr, slotIndex)
    );
    // Check if we already read this reservation (it's in existingReservations)
    // If it exists in the map, we need to delete it (it was a placeholder)
    if (existingReservations.has(slotIndex)) {
      reservationDeletes.set(reservationRef.path, reservationRef);
    }
  }

  // Also clean up any existing reservations that we used as placeholders
  for (const slotIndex of existingReservations.keys()) {
    const reservationRef = doc(
      firestore,
      'slot-reservations',
      buildReservationDocId(clinicId, doctorName, dateStr, slotIndex)
    );
    reservationDeletes.set(reservationRef.path, reservationRef);
  }

  // If bucket was used, add the bucket reservation to cleanup list
  if (usedBucket && bucketReservationRef) {
    reservationDeletes.set(bucketReservationRef.path, bucketReservationRef);
  }

  // Only prepare advance shift if we're not using cancelled slot directly or bucket
  // (cancelled slot is already free, bucket creates slot outside availability)
  if (usedCancelledSlot !== null || usedBucket) {
    // Using cancelled slot directly or bucket - no shift needed
    // Skip appointment shifting

    // CRITICAL: Transactional verification of target slots
    // Since we used a non-transactional query to build existingReservations,
    // we MUST verify the specific slots we are about to write to.

    // 1. Verify the new walk-in slot
    const slotsToVerify = new Set<number>();
    if (typeof newAssignment.slotIndex === 'number') {
      slotsToVerify.add(newAssignment.slotIndex);
    }

    // 2. Verify all shifted appointment destination slots
    for (const update of appointmentUpdates) {
      if (typeof update.slotIndex === 'number') {
        slotsToVerify.add(update.slotIndex);
      }
    }

    // Perform verify
    for (const slotIndex of slotsToVerify) {
      const reservationId = buildReservationDocId(clinicId, doctorName, dateStr, slotIndex);
      const reservationRef = doc(firestore, 'slot-reservations', reservationId);

      // We don't need the result, just the read to ensure consistency
      // If the slot changed since our query, transaction will fail/retry
      const snap = await transaction.get(reservationRef);

      if (snap.exists()) {
        const data = snap.data();
        // If a reservation exists and is BOOKED by someone else (and not one of the appointments we are shifting), conflict!
        if (data.status === 'booked') {
          const blockingApptId = data.appointmentId;
          const isKnownAppt = blockingApptId && effectiveAppointments.some(a => a.id === blockingApptId);

          if (!isKnownAppt) {
            // Conflict with unknown booking
            throw new Error(RESERVATION_CONFLICT_CODE);
          }
        }
      }
    }

    return {
      newAssignment: scheduleAttempt.newAssignment,
      reservationDeletes: Array.from(reservationDeletes.values()),
      appointmentUpdates: appointmentUpdates,
      usedBucketSlotIndex,
      existingReservations,
    };
  } else {

    // Normal scheduling - use the assignments returned by the scheduler
    const walkInSlotIndex = newAssignment.slotIndex;

    // Create a map of assignments by ID for easy lookup
    const assignmentById = new Map<string, SchedulerAssignment>();
    if (scheduleAttempt.schedule && scheduleAttempt.schedule.assignments) {
      for (const assign of scheduleAttempt.schedule.assignments) {
        // Strip prefixes if present
        const cleanId = assign.id.replace(/^__shiftable_/, '').replace(/^__blocked_/, '');
        assignmentById.set(cleanId, assign);
      }
    }

    // Convert scheduler assignments to appointment updates
    const appointmentUpdates: Array<{
      docRef: DocumentReference;
      slotIndex: number;
      sessionIndex: number;
      timeString: string;
      arriveByTime: string;
      cutOffTime: Date;
      noShowTime: Date;
    }> = [];

    // Iterate through assignments from the scheduler
    for (const assignment of scheduleAttempt.schedule.assignments) {
      // Skip the new walk-in itself (handled by caller)
      if (assignment.id === '__new_walk_in__') continue;

      // Skip blocked/immovable slots (scheduler returns them but they don't change)
      if (assignment.id.startsWith('__blocked_')) continue;

      // Find the original appointment
      const originalAppointmentId = assignment.id.replace(/^__shiftable_/, '');
      const originalAppointment = effectiveAppointments.find(a => a.id === originalAppointmentId);

      if (!originalAppointment) {
        console.warn(`[Walk-in Scheduling] Could not find original appointment for assignment ${assignment.id}`);
        continue;
      }

      const newSlotIndex = assignment.slotIndex;
      const newSessionIndex = assignment.sessionIndex;
      const currentSlotIndex = typeof originalAppointment.slotIndex === 'number' ? originalAppointment.slotIndex : -1;

      // CRITICAL FIX: Convert position-based slot index back to segmented format
      // The scheduler returns position-based indices, but we need segmented indices
      let finalSlotIndex = newSlotIndex;
      if (newSessionIndex > 0) {
        const sessionStartSlotIndex = slots.length > 0 ? slots[0].index : 0;
        finalSlotIndex = (newSessionIndex * 1000) + (newSlotIndex - sessionStartSlotIndex);
        console.log('[Walk-in Scheduling] Converting shifted appointment position to segmented:', {
          appointmentId: originalAppointment.id,
          position: newSlotIndex,
          sessionIndex: newSessionIndex,
          sessionStart: sessionStartSlotIndex,
          segmented: finalSlotIndex
        });
      }

      // Calculate new time
      let newAppointmentTime: Date;
      let newTimeString: string;

      const slotMeta = slots.find(s => s.index === newSlotIndex);
      if (slotMeta) {
        newAppointmentTime = slotMeta.time;
        newTimeString = getClinicTimeString(newAppointmentTime);
      } else {
        // Overflow slot logic
        // Synthesize slot meta if missing
        const slotDuration = doctor.averageConsultingTime || 15;
        const lastSlot = slots[slots.length - 1];
        if (lastSlot) {
          const diff = newSlotIndex - lastSlot.index;
          newAppointmentTime = addMinutes(lastSlot.time, diff * slotDuration);
          newTimeString = getClinicTimeString(newAppointmentTime);
        } else {
          newAppointmentTime = now;
          newTimeString = getClinicTimeString(now);
        }
      }

      // Calculate No Show Time
      let noShowTime: Date;
      let cutOffTime: Date;
      try {
        let currentNoShowTime: Date;
        if (originalAppointment.noShowTime instanceof Date) {
          currentNoShowTime = originalAppointment.noShowTime;
        } else if (typeof originalAppointment.noShowTime === 'object' && originalAppointment.noShowTime !== null) {
          // Handle Firestore timestamp
          const noShowTimeObj = originalAppointment.noShowTime as any;
          if (typeof noShowTimeObj.toDate === 'function') {
            currentNoShowTime = noShowTimeObj.toDate();
          } else if (typeof noShowTimeObj.seconds === 'number') {
            currentNoShowTime = new Date(noShowTimeObj.seconds * 1000);
          } else {
            currentNoShowTime = addMinutes(newAppointmentTime, 15);
          }
        } else {
          currentNoShowTime = addMinutes(newAppointmentTime, 15);
        }
        const duration = doctor.averageConsultingTime || 15;
        noShowTime = addMinutes(newAppointmentTime, duration);
        cutOffTime = subMinutes(newAppointmentTime, 15); // 15 minutes before appointment
      } catch (e) {
        const duration = doctor.averageConsultingTime || 15;
        noShowTime = addMinutes(newAppointmentTime, duration);
        cutOffTime = subMinutes(newAppointmentTime, 15);
      }

      // Only update if changed
      const slotIndexChanged = currentSlotIndex !== finalSlotIndex;
      const timeChanged = originalAppointment.time !== newTimeString;

      if (!slotIndexChanged && !timeChanged) {
        continue;
      }

      appointmentUpdates.push({
        docRef: doc(firestore, 'appointments', originalAppointment.id),
        slotIndex: finalSlotIndex,
        sessionIndex: newSessionIndex,
        timeString: newTimeString,
        arriveByTime: newTimeString,
        noShowTime: noShowTime,
        cutOffTime: cutOffTime // CRITICAL: Add cutOffTime for shifted appointments
      });

      if (DEBUG_BOOKING || slotIndexChanged || timeChanged) {
        console.info(`[BOOKING DEBUG] Updating appointment ${originalAppointment.id}`, {
          slotIndexChanged,
          timeChanged,
          oldSlotIndex: currentSlotIndex,
          newSlotIndex: finalSlotIndex,
          oldTime: originalAppointment.time,
          newTime: newTimeString,
        });
      }
    }

    if (DEBUG_BOOKING) {
      console.info('[patient booking] shift plan result', {
        newAssignment,
        reservationDeletes: Array.from(reservationDeletes.values()).map(ref => ref.path),
        appointmentUpdates,
      });
    }
  }


  // CRITICAL: Transactional verification for Normal Path
  // (Same logic as bucket path - verify final slots)
  // 1. Verify the new walk-in slot
  const slotsToVerify = new Set<number>();
  if (typeof newAssignment.slotIndex === 'number') {
    slotsToVerify.add(newAssignment.slotIndex);
  }

  // 2. Verify all shifted appointment destination slots
  for (const update of appointmentUpdates) {
    if (typeof update.slotIndex === 'number') {
      slotsToVerify.add(update.slotIndex);
    }
  }

  // Perform verify
  for (const slotIndex of slotsToVerify) {
    const reservationId = buildReservationDocId(clinicId, doctorName, dateStr, slotIndex);
    const reservationRef = doc(firestore, 'slot-reservations', reservationId);

    const snap = await transaction.get(reservationRef);

    if (snap.exists()) {
      const data = snap.data();
      if (data.status === 'booked') {
        const blockingApptId = data.appointmentId;
        const isKnownAppt = blockingApptId && effectiveAppointments.some(a => a.id === blockingApptId);

        if (!isKnownAppt) {
          throw new Error(RESERVATION_CONFLICT_CODE);
        }
      }
    }
  }

  return {
    newAssignment,
    reservationDeletes: Array.from(reservationDeletes.values()),
    appointmentUpdates,
    reservationWrites, // Return deferred writes
    usedBucketSlotIndex,
    existingReservations,
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
  // This improves preview calculation speed by ~40%
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
  const slots = allSlots.filter((s: any) => s.sessionIndex === targetSessionIndex);

  const lastSlotIndexInSession = slots.length > 0
    ? Math.max(...slots.map((s: any) => s.index))
    : -1;

  // Filter appointments to only include those in the active session
  const sessionAppointments = appointments.filter((appointment: any) => {
    return appointment.sessionIndex === targetSessionIndex;
  });

  const allSlotIndicesFromSessionAppointments = sessionAppointments
    .filter((a: any) => typeof a.slotIndex === 'number')
    .map((appointment: any) => appointment.slotIndex as number);

  const maxSlotIndexInSession = allSlotIndicesFromSessionAppointments.length > 0
    ? Math.max(...allSlotIndicesFromSessionAppointments)
    : -1;

  console.log('[WALK-IN:ESTIMATE] Total appointments in session:', {
    count: sessionAppointments.length,
    sessionIndex: targetSessionIndex,
    appointments: sessionAppointments.map(a => ({
      id: a.id,
      bookedVia: a.bookedVia,
      status: a.status,
      slotIndex: a.slotIndex
    }))
  });

  console.log('[WALK-IN:ESTIMATE] Server Side Data Check:', {
    slotsCount: slots.length,
    firstSlot: slots[0],
    lastSlot: slots[slots.length - 1],
    targetSessionIndex,
    activeSessionIndex,
    now: now.toISOString()
  });

  // Extract walkInTokenAllotment from clinic data if needed
  if (walkInTokenAllotment === undefined && clinicSnap?.exists()) {
    try {
      const data = clinicSnap.data();
      const rawSpacing = Number(data?.walkInTokenAllotment ?? 0);
      if (Number.isFinite(rawSpacing) && rawSpacing > 0) {
        walkInTokenAllotment = Math.floor(rawSpacing);
      }
    } catch (e) {
      console.warn('Failed to extract walk-in token allotment:', e);
    }
  }

  // Calculate numeric token first
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
    (existingNumericTokens.length > 0 ? Math.max(...existingNumericTokens) : slots.length) + 1;

  // Use smart scheduler to find the slot
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
      appointment.status === 'Pending' && // CRITICAL: Only Pending walk-ins for preview (not Completed/Skipped)
      !appointment.cancelledByBreak // CRITICAL: Exclude walk-ins cancelled by breaks
    );
  });



  // For preview, we include both existing walk-ins and the new candidate
  // so the scheduler can correctly account for spacing between walk-ins.
  const baseWalkInCandidates = activeWalkIns.map((appt: any) => ({
    id: appt.id,
    numericToken: typeof appt.numericToken === 'number' ? appt.numericToken : (Number(appt.numericToken) || 0),
    createdAt: (appt.createdAt as any)?.toDate?.() || appt.createdAt || now,
    currentSlotIndex: appt.slotIndex,
  }));

  const activeWalkInCandidates = [
    ...baseWalkInCandidates,
    {
      id: '__new_walk_in__',
      numericToken,
      createdAt: now,
    }
  ];

  // ============================================================================
  // ORDER PROTECTION: Identify cancelled slots that MUST remain blocked
  // ============================================================================
  // Include cancelled slots logic for bucket compensation
  const oneHourAhead = addMinutes(now, 60);
  const hasExistingWalkIns = activeWalkIns.length > 0;

  console.log('[WALK-IN:SCHEDULER-INPUT] Prep:', {
    activeAdvanceCount: activeAdvanceAppointments.length,
    activeWalkInCount: activeWalkIns.length,
    hasExistingWalkIns
  });

  // Calculate bucket count logic (same as appointment-service.ts)
  const cancelledSlotsInWindow: Array<{ slotIndex: number; slotTime: Date }> = [];
  let bucketCount = 0;

  // Build set of slots with active appointments
  const slotsWithActiveAppointments = new Set<number>();
  sessionAppointments.forEach((appt: any) => {
    if (typeof appt.slotIndex === 'number' && ACTIVE_STATUSES.has(appt.status) && (!appt.cancelledByBreak || appt.status === 'Completed' || appt.status === 'Skipped')) {
      slotsWithActiveAppointments.add(appt.slotIndex);
    }
  });

  const activeWalkInsWithTimes = activeWalkIns
    .filter(appt => typeof appt.slotIndex === 'number')
    .map(appt => ({
      slotIndex: appt.slotIndex!,
      slotTime: slots.find(s => s.index === appt.slotIndex!)?.time,
    }))
    .filter(item => item.slotTime !== undefined);

  // Restore variable initialization
  const blockedAdvanceAppointments = activeAdvanceAppointments.map(entry => {
    // CRITICAL FIX: Distinguish between "Strictly Immovable" (Completed, Breaks) 
    // and "Shiftable" (Online appointments).
    // Online appointments SHOULD be shiftable to accommodate Walk-in "Token Allotment" (Interleaving),
    // effectively delaying the online appointment if a walk-in is inserted before it.

    // Check if truly immovable
    const isStrictlyImmovable =
      entry.status === 'Completed'; // CRITICAL: Skipped is now treated as SHIFTABLE (Active)

    const isBreakBlock = (entry.bookedVia as string) === 'BreakBlock';

    // Use different prefixes so scheduler knows what can be moved
    let idPrefix = '__shiftable_';
    if (isBreakBlock) {
      idPrefix = '__break_';
    } else if (isStrictlyImmovable) {
      idPrefix = '__blocked_';
    }

    const id = `${idPrefix}${entry.id}`;

    // NORMALIZE INDEX: Match appointment time to available slots
    // This handles the mismatch between Segmented Indices (1000+) stored in DB
    // and Raw Indices (12+) used in local session slots.
    let effectiveSlotIndex = typeof entry.slotIndex === 'number' ? entry.slotIndex : -1;

    if (entry.time) {
      const apptTimeStr = entry.time as string; // e.g. "08:00 PM"
      const matchingSlot = slots.find(s => getClinicTimeString(s.time) === apptTimeStr);
      if (matchingSlot) {
        effectiveSlotIndex = matchingSlot.index;
      }
    }

    return {
      id,
      slotIndex: effectiveSlotIndex,
    };
  });

  console.log('[WALK-IN:ESTIMATE] Blocked/Immovable appointments:', {
    count: blockedAdvanceAppointments.length,
    blocked: blockedAdvanceAppointments.filter(a => a.id.startsWith('__blocked_'))
  });

  // EXISTING WALK-IN HACK REMOVED: 
  // We no longer add existing walk-ins to blockedAdvanceAppointments here.
  // They are now correctly handled via activeWalkInCandidates above.

  // Identify blocked cancelled slots (Order Protection) & Bucket Count
  const cancelledSlotsInBucket = new Set<number>();

  appointments.forEach(appt => {
    if (
      (appt.status === 'Cancelled' || appt.status === 'No-show') &&
      typeof appt.slotIndex === 'number' &&
      (appt.bookedVia as string) !== 'BreakBlock' // CRITICAL: Ignore administrative blocks
    ) {
      const slotMeta = slots.find(s => s.index === appt.slotIndex);
      if (slotMeta) {
        // For bucket count: Include past slots (within 1 hour window)
        const isInBucketWindow = !isAfter(slotMeta.time, oneHourAhead);

        if (isInBucketWindow) {
          // Only process if there's no active appointment at this slot
          if (!slotsWithActiveAppointments.has(appt.slotIndex)) {
            const hasWalkInsAfter = activeWalkInsWithTimes.some(w => isAfter(w.slotTime!, slotMeta.time));

            if (hasWalkInsAfter) {
              // Cancelled slot with walk-ins after -> Bucket Credit
              if (hasExistingWalkIns) {
                bucketCount += 1;
              }
              cancelledSlotsInBucket.add(appt.slotIndex);
              blockedAdvanceAppointments.push({
                id: `__blocked_cancelled_${appt.slotIndex}`,
                slotIndex: appt.slotIndex
              });
            } else {
              // No walk-ins after -> Can be used directly
              if (!hasExistingWalkIns && !isBefore(slotMeta.time, now)) {
                cancelledSlotsInWindow.push({
                  slotIndex: appt.slotIndex,
                  slotTime: slotMeta.time,
                });
              }

              // No walk-ins yet -> Count as potential bucket credit if not reused
              if (!hasExistingWalkIns) {
                const isNotInCancelledWindow = cancelledSlotsInWindow.every(
                  cs => cs.slotIndex !== appt.slotIndex
                );
                if (isNotInCancelledWindow) {
                  bucketCount += 1;
                }
              }
            }
          }
        }
      }
    }
  });

  // Calculate effective bucket count
  const walkInsOutsideAvailability = activeWalkIns.filter(appt => {
    if (typeof appt.slotIndex !== 'number') return false;
    return appt.slotIndex >= slots.length; // Outside availability
  });
  const usedBucketSlots = walkInsOutsideAvailability.length;
  const firestoreBucketCount = Math.max(0, bucketCount - usedBucketSlots);


  // ============================================================================
  // PREVIEW ACCURACY FIX: Check existing reservations
  // ============================================================================
  // Read existing slot reservations to match booking behavior
  // This ensures preview shows accurate time by accounting for reserved slots
  const reservedSlots = new Set<number>();
  const maxSlotToCheck = Math.min(slots.length + 50, 200); // Check reasonable range
  const dateStr = getClinicDateString(date);

  // Batch read reservations for better performance
  // Batch read reservations for better performance
  // Refactored to use a single query instead of 200 individual reads to prevent network resource exhaustion
  const q = query(
    collection(firestore, 'slot-reservations'),
    where('clinicId', '==', doctor.clinicId),
    where('doctorName', '==', doctor.name),
    where('date', '==', dateStr)
  );

  let reservationDocs: DocumentSnapshot[] = [];
  try {
    const querySnapshot = await getDocs(q);
    reservationDocs = querySnapshot.docs;
  } catch (error) {
    console.error('[WALK-IN:ESTIMATE] Failed to fetch reservations:', error);
  }

  // Process reservation results
  reservationDocs.forEach((snap) => {
    if (!snap.exists()) return;

    try {
      const data = snap.data();
      const reservedAt = data?.reservedAt;
      const slotIdx = data?.slotIndex;

      if (!reservedAt || typeof slotIdx !== 'number') return;

      // Parse reservation time
      let reservedTime: Date | null = null;
      if (typeof reservedAt.toDate === 'function') {
        reservedTime = reservedAt.toDate();
      } else if (reservedAt instanceof Date) {
        reservedTime = reservedAt;
      } else if (reservedAt.seconds) {
        reservedTime = new Date(reservedAt.seconds * 1000);
      }

      if (!reservedTime) return;

      // Check if reservation is still valid (not stale)
      const ageInSeconds = (now.getTime() - reservedTime.getTime()) / 1000;
      const isBooked = data.status === 'booked';
      // Use 30s threshold for temporary reservations to match appointment service logic
      const threshold = isBooked ? 300 : 30;

      if (ageInSeconds <= threshold) {
        // Skip reservations from advance booking (they don't block walk-ins in actual booking previews)
        // But for walk-in estimation, we SHOULD respect them if they block the slot we want?
        // Actually, the original code excluded 'appointment-booking' reservedBy.
        const reservedBy = data?.reservedBy as string | undefined;
        if (reservedBy !== 'appointment-booking') {
          reservedSlots.add(slotIdx);
        }
      }
    } catch (e) {
      // Ignore parsing errors
    }
  });

  // Add reserved slots to blocked appointments so scheduler avoids them
  reservedSlots.forEach(slotIdx => {
    blockedAdvanceAppointments.push({
      id: `__reserved_${slotIdx}`,
      slotIndex: slotIdx
    });
  });

  let schedule: { assignments: SchedulerAssignment[] } | null = null;



  // Strategy 4: Bucket Compensation Check (Calculate early for error handling)
  // Check if all slots in availability (future slots only, excluding cancelled slots in bucket) are occupied
  const allSlotsFilled = (() => {
    // ------------------------------------------------------------------------
    // REVISED LOGIC: Account for "Overflow" appointments filling gaps in Scheduler
    // Break slots are UNAVAILABLE and should be excluded from BOTH total and occupied counts
    // ------------------------------------------------------------------------
    let freeFutureSlotsCount = 0;
    const occupiedIndices = new Set<number>();
    const breakBlockIndices = new Set<number>();

    // 1. Identify Break Block Indices (unavailable slots) from doctor's breakPeriods
    // Break blocks are stored in doctor.breakPeriods, not in appointments array
    const dateStr = getClinicDateString(date);
    const breaksForDate = doctor.breakPeriods?.[dateStr] || [];
    const breaksForSession = breaksForDate.filter((bp: any) => bp.sessionIndex === targetSessionIndex);

    console.log('[WALK-IN:ESTIMATE] Break blocks from doctor.breakPeriods:', {
      dateStr,
      sessionIndex: targetSessionIndex,
      breaksForSession: breaksForSession.map((bp: any) => ({
        id: bp.id,
        startTime: bp.startTimeFormatted,
        endTime: bp.endTimeFormatted,
        duration: bp.duration,
        slots: bp.slots?.length || 0
      }))
    });

    // Extract slot indices from break periods
    breaksForSession.forEach((bp: any) => {
      if (bp.slots && Array.isArray(bp.slots)) {
        bp.slots.forEach((slotTimeStr: string) => {
          try {
            const slotTime = parseISO(slotTimeStr);
            // Find matching slot index
            const matchingSlot = slots.find(s => {
              const diff = Math.abs(s.time.getTime() - slotTime.getTime());
              return diff < 60000; // Within 1 minute
            });
            if (matchingSlot) {
              breakBlockIndices.add(matchingSlot.index);
            }
          } catch (e) {
            // Ignore parsing errors
          }
        });
      }
    });

    // 2. Identify Occupied Indices from real appointments
    const registerOccupancy = (idx: number) => {
      if (typeof idx === 'number') occupiedIndices.add(idx);
    };

    sessionAppointments.forEach(appt => {
      // Only count real appointments, not break blocks or appointments cancelled by breaks
      if (
        typeof appt.slotIndex === 'number' &&
        ACTIVE_STATUSES.has(appt.status) &&
        (appt.bookedVia as string) !== 'BreakBlock' &&
        !appt.cancelledByBreak // CRITICAL: Exclude appointments that were cancelled/shifted by breaks
      ) {
        occupiedIndices.add(appt.slotIndex);
      }
    });

    console.log('[WALK-IN:ESTIMATE] Occupied appointments:', {
      occupiedCount: occupiedIndices.size,
      occupiedIndices: Array.from(occupiedIndices),
      allSessionAppointments: sessionAppointments.map(a => ({
        id: a.id,
        slotIndex: a.slotIndex,
        status: a.status,
        bookedVia: a.bookedVia,
        cancelledByBreak: a.cancelledByBreak,
        included: typeof a.slotIndex === 'number' ? occupiedIndices.has(a.slotIndex) : false
      }))
    });

    // NOTE: blockedAdvanceAppointments are already counted in sessionAppointments above
    // No need to add them again here

    // 3. Count "Free" Slots in the future (excluding break blocks)
    for (const slot of slots) {
      if (isBefore(slot.time, now)) continue;
      if (hasExistingWalkIns && cancelledSlotsInBucket.has(slot.index)) continue; // Blocked by bucket
      if (breakBlockIndices.has(slot.index)) continue; // CRITICAL: Skip break blocks from available count

      if (!occupiedIndices.has(slot.index)) {
        freeFutureSlotsCount++;
      }
    }

    // 4. Count "Overflow" Appointments (Indices >= lastSlotIndexInSession + 1)
    let overflowCount = 0;
    const lastSlotIndexInSession = slots.length > 0
      ? Math.max(...slots.map(s => s.index))
      : -1;

    sessionAppointments.forEach(appt => {
      if (ACTIVE_STATUSES.has(appt.status) && (appt.bookedVia as string) !== 'BreakBlock' && (!appt.cancelledByBreak || appt.status === 'Completed' || appt.status === 'Skipped')) {
        if (typeof appt.slotIndex === 'number' && appt.slotIndex > lastSlotIndexInSession) {
          overflowCount++;
        }
      }
    });

    // Final verdict: Session is full if free slots <= overflow count
    const isFull = freeFutureSlotsCount <= overflowCount;

    console.log('[WALK-IN:ESTIMATE] allSlotsFilled calculation:', {
      totalSlots: slots.length,
      breakBlockCount: breakBlockIndices.size,
      breakBlockIndices: Array.from(breakBlockIndices),
      availableSlots: slots.length - breakBlockIndices.size,
      occupiedCount: occupiedIndices.size,
      occupiedIndices: Array.from(occupiedIndices),
      freeFutureSlotsCount,
      overflowCount,
      isFull,
      verdict: isFull ? 'SESSION FULL - No walk-ins allowed' : 'SESSION HAS SPACE - Walk-ins allowed',
      DEBUG_BREAKS: Array.from(breakBlockIndices).join(', '),
      DEBUG_OCCUPIED: Array.from(occupiedIndices).join(', ')
    });

    return isFull;
  })();


  const canUseBucketCompensation = allSlotsFilled && firestoreBucketCount > 0;

  // FORCE BOOKING BYPASS: Skip scheduler for force bookings in preview
  // This ensures preview shows the same time as actual booking
  let newAssignment: SchedulerAssignment | undefined;

  if (forceBook) {
    console.log('[WALK-IN:ESTIMATE] Force booking detected - skipping scheduler in preview');

    // Find maximum occupied slot from all active appointments
    const allOccupiedSlots = sessionAppointments
      .filter(apt => ACTIVE_STATUSES.has(apt.status) && typeof apt.slotIndex === 'number')
      .map(apt => apt.slotIndex as number);

    const maxOccupiedSlot = allOccupiedSlots.length > 0
      ? Math.max(...allOccupiedSlots)
      : -1;

    const forceBookSlotIndex = maxOccupiedSlot + 1;

    const forceBookSessionIndex = (() => {
      const foundSlot = slots.find(s => s.index === forceBookSlotIndex);
      if (foundSlot) {
        return foundSlot.sessionIndex;
      }
      const lastSlot = slots[slots.length - 1];
      return lastSlot ? lastSlot.sessionIndex : targetSessionIndex;
    })();

    // Helper to get relative index within session (handles segmented 1000+ and remapped 10000+ indices)
    const getRelativeIndex = (idx: number) => {
      if (idx >= 10000) return idx - 10000;
      return idx % 1000;
    };

    // Calculate time
    const slotDuration = doctor.averageConsultingTime || 15;
    let forceBookTime: Date;
    const foundSlot = slots.find(s => s.index === forceBookSlotIndex);

    if (foundSlot) {
      forceBookTime = foundSlot.time;
    } else {
      const lastSlot = slots[slots.length - 1];
      if (lastSlot) {
        // Use relative distance to calculate overflow time
        const relativeForceIndex = getRelativeIndex(forceBookSlotIndex);
        const relativeLastIndex = getRelativeIndex(lastSlot.index);
        const slotsAfterAvailability = relativeForceIndex - relativeLastIndex;

        forceBookTime = addMinutes(lastSlot.time, slotsAfterAvailability * slotDuration);
      } else {
        forceBookTime = now;
      }
    }

    newAssignment = {
      id: '__new_walk_in__',
      slotIndex: forceBookSlotIndex,
      sessionIndex: forceBookSessionIndex,
      slotTime: forceBookTime,
    };

    console.log('[WALK-IN:ESTIMATE] Force booking preview assignment:', {
      slotIndex: forceBookSlotIndex,
      sessionIndex: forceBookSessionIndex,
      time: forceBookTime.toISOString(),
    });

  } else {
    // CRITICAL FIX: Ensure scheduler has enough "virtual" slots for spillover.
    // If physical slots are full, scheduler needs extra slots to place walk-ins/shifts.
    const bufferSlotsCount = 20;
    const extendedSlots = [...slots];
    const lastSlot = slots[slots.length - 1];

    if (lastSlot) {
      const slotDuration = doctor.averageConsultingTime || 10;
      for (let i = 1; i <= bufferSlotsCount; i++) {
        extendedSlots.push({
          index: lastSlot.index + i,
          time: addMinutes(lastSlot.time, i * slotDuration),
          sessionIndex: lastSlot.sessionIndex,
        } as any);
      }
    }

    // CRITICAL FIX: Normalize indices! appointments might have segmented indices (1000+)
    // but scheduler expects indices relative to the slots array (0-N) or absolute indices (if slots are absolute).
    // Start index of the session is needed to offset the relative index.
    const sessionStartSlotIndex = slots.length > 0 ? slots[0].index : 0;

    const normalizedAdvanceAppointments = blockedAdvanceAppointments.map(app => {
      let normalizedSlotIndex = app.slotIndex;
      if (typeof app.slotIndex === 'number' && app.slotIndex >= 1000) {
        normalizedSlotIndex = (app.slotIndex % 1000) + sessionStartSlotIndex;
      }
      return { ...app, slotIndex: normalizedSlotIndex };
    }).filter(app => {
      // Ensure index is within EXTENDED bounds
      return typeof app.slotIndex === 'number' && app.slotIndex >= 0 && app.slotIndex < extendedSlots.length;
    });

    try {
      console.log('[WALK-IN:ESTIMATE] Calling scheduler with:', {
        slotsCount: extendedSlots.length,
        blockedCount: normalizedAdvanceAppointments.length,
        blockedSlotIndices: normalizedAdvanceAppointments.map(b => b.slotIndex),
        walkInCandidatesCount: activeWalkInCandidates.length,
        walkInCandidates: activeWalkInCandidates
      });

      schedule = computeWalkInSchedule({
        slots: extendedSlots, // Pass extended slots!
        now,
        walkInTokenAllotment: walkInTokenAllotment || 0,
        advanceAppointments: normalizedAdvanceAppointments,
        walkInCandidates: activeWalkInCandidates,
      });

      console.log('[WALK-IN:ESTIMATE] Scheduler returned:', {
        assignmentsCount: schedule?.assignments.length,
        assignments: schedule?.assignments.map(a => ({
          id: a.id,
          slotIndex: a.slotIndex,
          sessionIndex: a.sessionIndex,
          time: a.slotTime.toISOString()
        }))
      });

      newAssignment = schedule?.assignments.find(a => a.id === '__new_walk_in__');
    } catch (error) {
      // If all slots are filled, we should fallback to overflow logic (Bucket/Overflow)
      // ONLY if explicit forceBook is requested OR bucket compensation is available.
      // Automatic overflow based solely on allSlotsFilled is disabled to ensure UI prompts are shown.
      if (!forceBook && !canUseBucketCompensation) {
        throw error;
      }
    }
  }


  let chosenSlotIndex = -1;
  let chosenSessionIndex = 0;
  let chosenTime = now;

  if (newAssignment) {
    chosenSlotIndex = newAssignment.slotIndex;
    chosenSessionIndex = newAssignment.sessionIndex;
    chosenTime = newAssignment.slotTime;


  }

  if (!newAssignment || chosenSlotIndex === -1) {
    // Strategy 4: Bucket Compensation Check
    // If forceBook is enabled OR bucket compensation is valid, create an overflow slot
    if (forceBook || canUseBucketCompensation) {


      // Find the last slot index from all appointments and slots
      const allSlotIndices = [
        ...appointments
          .filter(apt => typeof apt.slotIndex === 'number')
          .map(apt => apt.slotIndex as number),
        ...slots.map(s => s.index)
      ];

      const overflowSlotIndex = Math.max(maxSlotIndexInSession + 1, lastSlotIndexInSession + 1);

      // Find last slot time or use last session end time
      let overflowTime: Date;
      const consultationTime = doctor.averageConsultingTime || 15;

      const getRelativeIndex = (idx: number) => {
        if (idx >= 10000) return idx - 10000;
        return idx % 1000;
      };

      if (slots.length > 0) {
        const lastSlot = slots[slots.length - 1];
        const relativeOverflowIndex = getRelativeIndex(overflowSlotIndex);
        const relativeLastIndex = getRelativeIndex(lastSlot.index);
        const slotsAfterAvailability = relativeOverflowIndex - relativeLastIndex;

        overflowTime = addMinutes(lastSlot.time, slotsAfterAvailability * consultationTime);
      } else {
        // No slots exist, use current time
        overflowTime = addMinutes(now, consultationTime);
      }

      // Determine session index
      // Determine session index
      const lastSessionIndex = targetSessionIndex;

      // Count patients ahead (all active appointments in session)
      const allActiveStatuses = new Set(['Pending', 'Confirmed', 'Skipped']);
      const patientsAhead = sessionAppointments.filter(appointment =>
        allActiveStatuses.has(appointment.status)
      ).length;

      console.log('[OVERFLOW] Created overflow slot:', {
        slotIndex: overflowSlotIndex,
        time: getClinicTimeString(overflowTime),
        sessionIndex: lastSessionIndex,
        numericToken,
        patientsAhead,
        reason: forceBook ? 'ForceBook' : 'BucketCompensation'
      });

      return {
        estimatedTime: overflowTime,
        patientsAhead,
        numericToken,
        slotIndex: overflowSlotIndex,
        sessionIndex: lastSessionIndex,
        actualSlotTime: overflowTime,
        isForceBooked: true, // Mark as force booked so UI accepts it (it's valid "overflow")
      };
    }

    throw new Error('No walk-in slots are available at this time.');
  }

  // CRITICAL FIX: Use scheduler assignments to determine slot order
  // DB slot indices might be segmented (1000+), while scheduler uses continuous indices (0-35).
  // We must use the 'assigned' slot index for comparison.
  const assignedSlotMap = new Map<string, number>();
  if (schedule && schedule.assignments) {
    schedule.assignments.forEach(a => {
      assignedSlotMap.set(a.id, a.slotIndex);

      // CRITICAL FIX: Also map the original ID (without __blocked_ or __shiftable_ prefix)
      // The scheduler uses synthetic IDs like "__shiftable_87cgyf3o7ezIHHRPvH9l"
      // but sessionAppointments have original IDs like "87cgyf3o7ezIHHRPvH9l"
      if (a.id.startsWith('__blocked_') || a.id.startsWith('__shiftable_')) {
        const originalId = a.id.replace(/^__(blocked|shiftable)_/, '');
        assignedSlotMap.set(originalId, a.slotIndex);
      }
    });
  }

  const allActiveStatusesCount = new Set(['Pending', 'Confirmed']); // Exclude Skipped from queue count? usually queue = waiting.

  const patientsAheadDetails = sessionAppointments.filter(appointment => {
    // 1. Must be a valid status (Waiting to be seen)
    if (!allActiveStatusesCount.has(appointment.status)) return false;

    // 2. Must be scheduled ahead of us
    // Try to get assigned slot from scheduler (most accurate for shifted apps)
    // Fallback to existing slotIndex (normalized or raw) if not in scheduler (shouldn't happen for active apps)
    let effectiveSlotIndex = assignedSlotMap.get(appointment.id);

    // If not in scheduler, maybe it's not "active" for scheduling but still in session?
    // If it's not in scheduler, it probably shouldn't count as "ahead" in the verified schedule.
    if (typeof effectiveSlotIndex !== 'number') return false;

    // 3. Exclude administrative blocks
    if (appointment.id.startsWith('__blocked_')) return false;

    return effectiveSlotIndex < chosenSlotIndex;
  });

  const patientsAhead = patientsAheadDetails.length;

  console.log('[WALK-IN:ESTIMATE] Patients Ahead Calculation:', {
    doctor: doctor.name,
    chosenSlotIndex,
    totalAppointments: appointments.length,
    activeAppointmentsCount: appointments.filter(a => ACTIVE_STATUSES.has(a.status)).length,
    patientsAhead,
    matchedAppointments: patientsAheadDetails.map(a => ({
      id: a.id,
      slotIndex: a.slotIndex,
      status: a.status,
      bookedVia: a.bookedVia
    }))
  });

  const consultationTime = doctor.averageConsultingTime || 15;
  const apptEnd = addMinutes(chosenTime, consultationTime);

  // Identify if any assignment (including shifted ones) spills over the formal session end
  let isSpillover = false;

  // Find the maximum slot index among ALL assignments returned by the scheduler
  const maxAssignedSlotIndex = Math.max(...(schedule?.assignments.map(a => a.slotIndex) || []), -1);

  // Find the maximum physical slot index available in this session (nominal slots)
  const sessionSlots = allSlots.filter((s: any) => s.sessionIndex === chosenSessionIndex);
  const maxPhysicalSlotIndexInSession = sessionSlots.length > 0
    ? Math.max(...sessionSlots.map((s: any) => s.index))
    : -1;

  console.log('[WALK-IN:ESTIMATE] Spillover detection:', {
    chosenSlotIndex,
    chosenSessionIndex,
    maxAssignedSlotIndex,
    maxPhysicalSlotIndexInSession,
    sessionSlotsCount: sessionSlots.length,
    allSlotsCount: allSlots.length,
    sessionSlotIndices: sessionSlots.map((s: any) => s.index),
    forceBook,
    canUseBucketCompensation
  });

  if (maxAssignedSlotIndex > maxPhysicalSlotIndexInSession) {
    isSpillover = true;
    console.log('[WALK-IN:ESTIMATE] ⚠️ SPILLOVER DETECTED: maxAssignedSlotIndex > maxPhysicalSlotIndexInSession', {
      maxAssignedSlotIndex,
      maxPhysicalSlotIndexInSession,
      difference: maxAssignedSlotIndex - maxPhysicalSlotIndexInSession
    });
  }

  // NOTE: Removed time-based spillover check that was causing false positives
  // The index-based check above is sufficient and correctly accounts for session extensions
  // since sessionSlots already includes extended slots from loadDoctorAndSlots

  // CRITICAL FIX: If we have a spillover (into virtual slots), we MUST enforce forceBook or bucket compensation.
  // EXCEPTION: If allSlotsFilled is false, it means there are free physical slots available.
  // In this case, the spillover is just due to scheduler's spacing logic, not actual capacity limits.
  // We should allow it and let the system create the overflow slot.
  if (isSpillover && !forceBook && !canUseBucketCompensation && allSlotsFilled) {
    // RELAXED CHECK: If the scheduler returned a valid assignment, we trust it (even if it spills over).
    // This allows spacing logic to create necessary overflow.
    console.warn('[WALK-IN:ESTIMATE] ⚠️ Spillover detected but allowed based on scheduler assignment', {
      isSpillover,
      forceBook,
      canUseBucketCompensation,
      allSlotsFilled,
      chosenSlotIndex,
      maxPhysicalSlotIndexInSession
    });
    // throw new Error('No walk-in slots are available. (Session Full)');
  }

  if (isSpillover && !allSlotsFilled) {
    console.log('[WALK-IN:ESTIMATE] ⚠️ Spillover allowed: Free slots available but scheduler chose overflow due to spacing logic', {
      chosenSlotIndex,
      maxPhysicalSlotIndexInSession,
      allSlotsFilled
    });
  }

  // FIX: Convert absolute slot index back to segmented DB index if needed.
  // The scheduler (and allSlots) uses absolute indices (0..N across day).
  // But DB might use segmented indices (Session 0: 0+, Session 1: 1000+, etc).
  // We apply the offset: SessionIndex * 1000 + RelativeIndex.
  let finalSlotIndex = chosenSlotIndex;

  if (chosenSlotIndex >= 0) {
    const sessionStart = sessionSlots.length > 0 ? sessionSlots[0].index : 0;
    // Map absolute index to relative index within session
    const relativeIndex = chosenSlotIndex - sessionStart;

    // Apply segmented offset
    // Convention: Session 0 -> 0, Session 1 -> 1000, etc.
    finalSlotIndex = (chosenSessionIndex * 1000) + relativeIndex;

    console.log('[WALK-IN:ESTIMATE] Converted absolute slot index to segmented index:', {
      absolute: chosenSlotIndex,
      sessionStart,
      relativeIndex,
      sessionIndex: chosenSessionIndex,
      final: finalSlotIndex
    });
  }

  return {
    estimatedTime: chosenTime,
    patientsAhead,
    numericToken,
    slotIndex: finalSlotIndex,
    sessionIndex: chosenSessionIndex,
    actualSlotTime: chosenTime,
    isForceBooked: forceBook || isSpillover, // Respect input forceBook AND auto-detect spillover
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
  const { slots } = await loadDoctorAndSlots(firestore, clinicId, doctorName, date, doctorId);
  const appointments = await fetchDayAppointments(firestore, clinicId, doctorName, date);

  const activeAdvanceAppointments = appointments.filter(appointment => {
    return (
      appointment.bookedVia !== 'Walk-in' &&
      typeof appointment.slotIndex === 'number' &&
      ACTIVE_STATUSES.has(appointment.status)
    );
  });

  const activeWalkIns = appointments.filter(appointment => {
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

  const walkInCandidates = [
    ...activeWalkIns.map(appointment => ({
      id: appointment.id,
      numericToken:
        typeof appointment.numericToken === 'number'
          ? appointment.numericToken
          : Number(appointment.numericToken ?? 0) || 0,
      createdAt: toDate(appointment.createdAt),
      currentSlotIndex: typeof appointment.slotIndex === 'number' ? appointment.slotIndex : undefined,
    })),
    {
      id: placeholderId,
      numericToken: placeholderNumericToken,
      createdAt: new Date(),
    },
  ];

  const schedule = computeWalkInSchedule({
    slots,
    now: getClinicNow(),
    walkInTokenAllotment,
    advanceAppointments: activeAdvanceAppointments.map(entry => ({
      id: entry.id,
      slotIndex: typeof entry.slotIndex === 'number' ? entry.slotIndex : -1,
    })),
    walkInCandidates,
  });

  const assignmentById = new Map(schedule.assignments.map(assignment => [assignment.id, assignment]));

  const advanceShifts: WalkInPreviewShift[] = activeAdvanceAppointments.flatMap(appointment => {
    const assignment = assignmentById.get(appointment.id);
    if (!assignment) {
      return [];
    }
    const currentSlotIndex = typeof appointment.slotIndex === 'number' ? appointment.slotIndex : -1;
    if (currentSlotIndex === assignment.slotIndex) {
      return [];
    }

    const fromTime = currentSlotIndex >= 0 ? slots.find(s => s.index === currentSlotIndex)?.time ?? null : null;

    return [
      {
        id: appointment.id,
        tokenNumber: appointment.tokenNumber,
        fromSlot: currentSlotIndex,
        toSlot: assignment.slotIndex,
        fromTime,
        toTime: assignment.slotTime,
      },
    ];
  });

  const placeholderAssignment = assignmentById.get(placeholderId) ?? null;
  const walkInAssignments = schedule.assignments.filter(assignment => assignment.id !== placeholderId);

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
  const clinicSnap = await getDoc(doc(firestore, 'clinics', clinicId));
  const rawSpacing = clinicSnap.exists() ? Number(clinicSnap.data()?.walkInTokenAllotment ?? 0) : 0;
  const walkInSpacingValue = Number.isFinite(rawSpacing) && rawSpacing > 0 ? Math.floor(rawSpacing) : 0;

  const { doctor, slots } = await loadDoctorAndSlots(firestore, clinicId, doctorName, date, doctorId);
  const appointments = await fetchDayAppointments(firestore, clinicId, doctorName, date);
  const averageConsultingTime = doctor.averageConsultingTime || 15;

  const ACTIVE = (appointment: Appointment) =>
    appointment.bookedVia === 'Walk-in' &&
    typeof appointment.slotIndex === 'number' &&
    ACTIVE_STATUSES.has(appointment.status);

  const activeAdvanceAppointments = appointments.filter(appointment => {
    return (
      appointment.bookedVia !== 'Walk-in' &&
      typeof appointment.slotIndex === 'number' &&
      ACTIVE_STATUSES.has(appointment.status)
    );
  });

  const activeWalkIns = appointments.filter(ACTIVE);

  if (DEBUG_BOOKING) {
    console.info('[patient booking] rebalance start', {
      clinicId,
      doctorName,
      date,
      walkInSpacingValue,
      activeAdvanceAppointments: activeAdvanceAppointments.map(a => ({ id: a.id, slotIndex: a.slotIndex })),
      activeWalkIns: activeWalkIns.map(w => ({ id: w.id, slotIndex: w.slotIndex })),
    });
  }

  if (activeWalkIns.length === 0) {
    return;
  }

  await runTransaction(firestore, async transaction => {
    const advanceRefs = activeAdvanceAppointments.map(appointment => doc(firestore, 'appointments', appointment.id));
    const walkInRefs = activeWalkIns.map(appointment => doc(firestore, 'appointments', appointment.id));

    const [advanceSnapshots, walkInSnapshots] = await Promise.all([
      Promise.all(advanceRefs.map(ref => transaction.get(ref))),
      Promise.all(walkInRefs.map(ref => transaction.get(ref))),
    ]);

    const freshAdvanceAppointments = advanceSnapshots
      .filter(snapshot => snapshot.exists())
      .map(snapshot => {
        const data = snapshot.data() as Appointment;
        return { ...data, id: snapshot.id };
      })
      .filter(appointment => {
        return (
          appointment.bookedVia !== 'Walk-in' &&
          typeof appointment.slotIndex === 'number' &&
          ACTIVE_STATUSES.has(appointment.status)
        );
      });

    const freshWalkIns = walkInSnapshots
      .filter(snapshot => snapshot.exists())
      .map(snapshot => {
        const data = snapshot.data() as Appointment;
        return { ...data, id: snapshot.id };
      })
      .filter(ACTIVE);

    if (freshWalkIns.length === 0) {
      return;
    }

    const walkInCandidates = freshWalkIns.map(appointment => ({
      id: appointment.id,
      numericToken: typeof appointment.numericToken === 'number' ? appointment.numericToken : 0,
      createdAt: toDate(appointment.createdAt),
      currentSlotIndex: typeof appointment.slotIndex === 'number' ? appointment.slotIndex : undefined,
    }));

    const schedule = computeWalkInSchedule({
      slots,
      now: getClinicNow(),
      walkInTokenAllotment: walkInSpacingValue,
      advanceAppointments: freshAdvanceAppointments.map(entry => ({
        id: entry.id,
        slotIndex: typeof entry.slotIndex === 'number' ? entry.slotIndex : -1,
      })),
      walkInCandidates,
    });

    if (DEBUG_BOOKING) {
      console.info('[patient booking] rebalance schedule', schedule.assignments);
    }

    const assignmentById = new Map(schedule.assignments.map(assignment => [assignment.id, assignment]));

    for (const appointment of freshAdvanceAppointments) {
      const assignment = assignmentById.get(appointment.id);
      if (!assignment) continue;

      const currentSlotIndex = typeof appointment.slotIndex === 'number' ? appointment.slotIndex : -1;
      const newSlotIndex = assignment.slotIndex;
      const newTimeString = getClinicTimeString(assignment.slotTime);

      if (currentSlotIndex === newSlotIndex && appointment.time === newTimeString) {
        continue;
      }

      const appointmentRef = doc(firestore, 'appointments', appointment.id);
      transaction.update(appointmentRef, {
        slotIndex: newSlotIndex,
        sessionIndex: assignment.sessionIndex,
        time: newTimeString,
        cutOffTime: subMinutes(assignment.slotTime, averageConsultingTime),
        noShowTime: addMinutes(assignment.slotTime, averageConsultingTime),
      });
    }

    for (const appointment of freshWalkIns) {
      const assignment = assignmentById.get(appointment.id);
      if (!assignment) continue;

      const currentSlotIndex = typeof appointment.slotIndex === 'number' ? appointment.slotIndex : -1;
      const newSlotIndex = assignment.slotIndex;
      const newTimeString = getClinicTimeString(assignment.slotTime);

      if (currentSlotIndex === newSlotIndex && appointment.time === newTimeString) {
        continue;
      }

      if (DEBUG_BOOKING) {
        console.info('[patient booking] rebalance move', {
          appointmentId: appointment.id,
          fromSlot: currentSlotIndex,
          toSlot: newSlotIndex,
          time: newTimeString,
        });
      }

      const appointmentRef = doc(firestore, 'appointments', appointment.id);
      transaction.update(appointmentRef, {
        slotIndex: newSlotIndex,
        sessionIndex: assignment.sessionIndex,
        time: newTimeString,
        cutOffTime: subMinutes(assignment.slotTime, averageConsultingTime),
        noShowTime: addMinutes(assignment.slotTime, averageConsultingTime),
      });
    }
  });

  if (DEBUG_BOOKING) {
    console.info('[patient booking] rebalance complete', {
      clinicId,
      doctorName,
      date,
    });
  }
}

