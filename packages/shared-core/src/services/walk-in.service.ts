import { collection, query, where, orderBy, getDocs, getDoc, Firestore, runTransaction, doc, serverTimestamp, type Transaction, type DocumentReference, type DocumentSnapshot } from 'firebase/firestore';
import { format, addMinutes, differenceInMinutes, isAfter, isBefore, subMinutes, parse } from 'date-fns';
import type { Doctor, Appointment } from '@kloqo/shared-types';
import { computeWalkInSchedule, type SchedulerAssignment } from './walk-in-scheduler';
import { logger } from '../lib/logger';
import { getClinicNow, getClinicDayOfWeek, getClinicDateString, getClinicTimeString } from '../utils/date-utils';
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

function getSlotTime(slots: DailySlot[], slotIndex: number): Date {
  const slot = slots[slotIndex];
  if (!slot) {
    throw new Error('Selected slot index is outside of the doctor availability.');
  }
  return slot.time;
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
        const slot = slots[slotIndex];
        console.log(`[SLOT FILTER] Rejecting slot ${slotIndex} - reserved for walk-ins in session ${slot?.sessionIndex}`);
        return; // Skip reserved walk-in slots
      }
      candidates.push(slotIndex);
    }
  };

  if (type === 'A') {
    if (typeof preferredSlotIndex === 'number') {
      const slotTime = getSlotTime(slots, preferredSlotIndex);
      const preferredSlot = slots[preferredSlotIndex];
      const preferredSessionIndex = preferredSlot?.sessionIndex;

      // CRITICAL: Also check if preferred slot is not reserved for walk-ins
      // This prevents booking cancelled slots that are in the reserved walk-in range (last 15% of session)
      if (reservedWSlots.has(preferredSlotIndex)) {
        console.log(`[SLOT FILTER] Rejecting preferred slot ${preferredSlotIndex} - reserved for walk-ins in session ${preferredSessionIndex}`);
      } else if (isAfter(slotTime, oneHourFromNow)) {
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

  const [{ doctor, slots }, clinicSnap] = await Promise.all(fetchPromises);

  let walkInSpacingValue = 0;
  if (type === 'W' && clinicSnap?.exists()) {
    const rawSpacing = Number(clinicSnap.data()?.walkInTokenAllotment ?? 0);
    walkInSpacingValue = Number.isFinite(rawSpacing) && rawSpacing > 0 ? Math.floor(rawSpacing) : 0;
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

  const requestId = `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
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
        const effectiveAppointments = excludeAppointmentId
          ? appointments.filter(appointment => appointment.id !== excludeAppointmentId)
          : appointments;

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
            return (
              appointment.bookedVia !== 'Walk-in' &&
              (appointment.bookedVia as string) !== 'BreakBlock' && // CRITICAL FIX: Breaks shouldn't count towards Advance Token Cap
              typeof appointment.slotIndex === 'number' &&
              ACTIVE_STATUSES.has(appointment.status)
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
            const slotMeta = slots[finalSlotIndex];
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
              const preferredSlot = slots[appointmentData.slotIndex];
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
              const slot = slots[slotIndex];
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
            const reservedSlot = slots[chosenSlotIndex];
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
  appointmentUpdates: Array<{
    docRef: DocumentReference;
    slotIndex: number;
    sessionIndex: number;
    timeString: string;
    arriveByTime: string; // Added this
    noShowTime: Date;
  }>;
  usedBucketSlotIndex: number | null;
  existingReservations: Map<number, Date>;
}> {
  const activeAdvanceAppointments = effectiveAppointments.filter(appointment => {
    return (
      appointment.bookedVia !== 'Walk-in' &&
      typeof appointment.slotIndex === 'number' &&
      ACTIVE_STATUSES.has(appointment.status)
    );
  });

  const activeWalkIns = effectiveAppointments.filter(appointment => {
    return (
      appointment.bookedVia === 'Walk-in' &&
      typeof appointment.slotIndex === 'number' &&
      ACTIVE_STATUSES.has(appointment.status)
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
  const staleReservationsToDelete: DocumentReference[] = [];

  const reservationReadPromises: Promise<DocumentSnapshot>[] = [];
  const reservationRefs: DocumentReference[] = [];

  for (let slotIdx = 0; slotIdx <= maxSlotToRead; slotIdx += 1) {
    const reservationId = buildReservationDocId(clinicId, doctorName, dateStr, slotIdx);
    const reservationRef = doc(firestore, 'slot-reservations', reservationId);
    reservationRefs.push(reservationRef);
    reservationReadPromises.push(transaction.get(reservationRef));
  }

  const reservationSnapshots = await Promise.all(reservationReadPromises);

  for (let i = 0; i < reservationSnapshots.length; i += 1) {
    const reservationSnapshot = reservationSnapshots[i];
    const reservationRef = reservationRefs[i];
    const slotIdx = i;

    if (reservationSnapshot.exists()) {
      const reservationData = reservationSnapshot.data();
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
        ACTIVE_STATUSES.has(appt.status)
      ) {
        occupiedSlots.add(appt.slotIndex);
      }
    });
    // Check if all slots in availability (future slots only, excluding cancelled slots in bucket) are occupied
    // Note: cancelledSlotsInBucket hasn't been calculated yet, so we can't check it here
    // We'll use a simplified check - if all future slots are occupied, we might need bucket
    for (let i = 0; i < slots.length; i++) {
      if (isBefore(slots[i].time, now)) {
        continue; // Skip past slots
      }
      if (!occupiedSlots.has(i)) {
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

  // Delete stale reservations within the transaction
  for (const staleRef of staleReservationsToDelete) {
    transaction.delete(staleRef);
  }

  // Create placeholder walk-in candidates for reserved slots
  // This tells the scheduler that these slots are already taken
  const reservedWalkInCandidates = Array.from(existingReservations.entries()).map(([slotIndex, reservedTime], idx) => ({
    id: `__reserved_${slotIndex}__`,
    numericToken: totalSlots + 1000 + idx, // High token number to ensure they're placed correctly
    createdAt: reservedTime,
    currentSlotIndex: slotIndex,
  }));

  // For actual booking, we MUST include existing walk-ins as candidates 
  // so the scheduler correctly accounts for spacing between them.
  const baseWalkInCandidates = activeWalkIns.map(appt => ({
    id: appt.id,
    numericToken: typeof appt.numericToken === 'number' ? appt.numericToken : (Number(appt.numericToken) || 0),
    createdAt: (appt.createdAt as any)?.toDate?.() || appt.createdAt || now,
    currentSlotIndex: appt.slotIndex,
  }));

  const newWalkInCandidate = {
    id: '__new_walk_in__',
    numericToken: newWalkInNumericToken,
    createdAt: now,
  };

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
      const slotMeta = slots[appt.slotIndex!];
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
      const slotMeta = slots[appointment.slotIndex];
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
          slots[0].time
        ),
        0
      )
      : 0;
  const completedCount = effectiveAppointments.filter(
    appointment => appointment.status === 'Completed'
  ).length;
  const expectedMinutes = completedCount * averageConsultingTime;
  const actualElapsedRaw =
    slots.length > 0 ? differenceInMinutes(now, slots[0].time) : 0;
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
        const slotMeta = slots[appointment.slotIndex];
        if (slotMeta) {
          // For bucket: Include past slots (within 1 hour window)
          // Only check upper bound (1 hour ahead), don't filter out past slots
          const isInBucketWindow = !isAfter(slotMeta.time, oneHourAhead);
          const hasActiveAppt = slotsWithActiveAppointments.has(appointment.slotIndex);

          console.warn(`[Walk-in Scheduling] Checking cancelled slot ${appointment.slotIndex}:`, {
            time: slotMeta.time.toISOString(),
            isInBucketWindow,
            hasActiveAppt,
            status: appointment.status,
          });

          if (
            isInBucketWindow &&
            !hasActiveAppt
          ) {
            // Check if there are walk-ins scheduled AFTER this cancelled slot's time
            const hasWalkInsAfter = activeWalkInsWithTimes.some(
              walkIn => walkIn.slotTime && isAfter(walkIn.slotTime, slotMeta.time)
            );

            console.warn(`[Walk-in Scheduling] Cancelled slot ${appointment.slotIndex}: hasWalkInsAfter=${hasWalkInsAfter}`, {
              cancelledSlotTime: slotMeta.time.toISOString(),
              walkInTimes: activeWalkInsWithTimes.map(w => w.slotTime?.toISOString()),
            });

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
        const slotMeta = slots[appointment.slotIndex];
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
    try {
      // If using a cancelled slot directly (first walk-in case), create assignment directly
      if (useCancelledSlot !== null) {
        const cancelledSlot = slots[useCancelledSlot];
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
      const blockedAdvanceAppointments = activeAdvanceAppointments.map(entry => ({
        id: entry.id,
        slotIndex: typeof entry.slotIndex === 'number' ? entry.slotIndex : -1,
      }));

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

      const schedule = computeWalkInSchedule({
        slots,
        now,
        walkInTokenAllotment: walkInSpacingValue,
        advanceAppointments: blockedAdvanceAppointments,
        walkInCandidates: allWalkInCandidates,
      });

      const newAssignment = schedule.assignments.find(
        assignment => assignment.id === '__new_walk_in__'
      );
      if (!newAssignment) {
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
        console.error('[Walk-in Scheduling] ERROR: Scheduler assigned to slot that is already reserved by concurrent request:', newAssignment.slotIndex);
        // Mark as conflict so caller knows to throw conflict error for retry
        hasReservationConflict = true;
        return null; // Reject this assignment, will retry with different slot
      }

      // Check if the assigned slot is a cancelled slot
      const assignedAppointment = effectiveAppointments.find(
        apt => apt.slotIndex === newAssignment.slotIndex &&
          (apt.status === 'Cancelled' || apt.status === 'No-show')
      );

      if (assignedAppointment) {
        const assignedSlotMeta = slots[newAssignment.slotIndex];
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

      return { schedule, newAssignment, placeholderIds: new Set() };
    } catch {
      return null;
    }
  };

  // Check if all slots in availability (non-past, excluding cancelled slots in bucket) are filled
  const allSlotsFilled = (() => {
    const occupiedSlots = new Set<number>();
    effectiveAppointments.forEach(appt => {
      if (
        typeof appt.slotIndex === 'number' &&
        ACTIVE_STATUSES.has(appt.status)
      ) {
        occupiedSlots.add(appt.slotIndex);
      }
    });
    // Check if all slots in availability (future slots only, excluding cancelled slots in bucket) are occupied
    for (let i = 0; i < slots.length; i++) {
      if (isBefore(slots[i].time, now)) {
        continue; // Skip past slots
      }
      // Skip cancelled slots in bucket - they're blocked, not available
      if (hasExistingWalkIns && cancelledSlotsInBucket.has(i)) {
        continue; // Skip cancelled slots in bucket
      }
      if (!occupiedSlots.has(i)) {
        return false; // Found an empty slot
      }
    }
    return true; // All available future slots are occupied
  })();

  let scheduleAttempt: ScheduleAttemptResult | null = null;
  let usedCancelledSlot: number | null = null;
  let usedBucket = false;
  let usedBucketSlotIndex: number | null = null;
  let bucketReservationRef: DocumentReference | null = null;
  let hasReservationConflict = false; // Track if failure was due to reservation conflict

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

    // Find the last slotIndex from the slots array (represents last slot in last session)
    const lastSlotIndexFromSlots = slots.length > 0 ? slots.length - 1 : -1;

    // Calculate new slotIndex based on walkInTokenAllotment interval logic
    let newSlotIndex: number;

    if (lastWalkInSlotIndex >= 0 && walkInSpacingValue > 0) {
      // CRITICAL: Implement interval logic - place walk-in after nth advance appointment
      // where n = walkInTokenAllotment (walkInSpacingValue)

      // Find all advance appointments after the last walk-in
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

      console.info('[Walk-in Scheduling] Bucket compensation - interval calculation:', {
        lastWalkInSlotIndex,
        walkInSpacingValue,
        advanceCountAfterLastWalkIn,
        advanceAppointmentsAfterLastWalkIn: advanceAppointmentsAfterLastWalkIn.map(a => ({
          id: a.id,
          slotIndex: a.slotIndex
        }))
      });

      if (advanceCountAfterLastWalkIn > walkInSpacingValue) {
        // Place walk-in after the nth advance appointment (where n = walkInSpacingValue)
        const nthAdvanceAppointment = advanceAppointmentsAfterLastWalkIn[walkInSpacingValue - 1];
        const nthAdvanceSlotIndex = typeof nthAdvanceAppointment.slotIndex === 'number'
          ? nthAdvanceAppointment.slotIndex
          : -1;

        if (nthAdvanceSlotIndex >= 0) {
          // Place walk-in right after the nth advance appointment
          newSlotIndex = nthAdvanceSlotIndex + 1;
          console.info('[Walk-in Scheduling] Bucket compensation - placing after nth advance:', {
            nth: walkInSpacingValue,
            nthAdvanceSlotIndex,
            newSlotIndex
          });
        } else {
          // Fallback: place after last advance appointment
          const lastAdvanceAfterWalkIn = advanceAppointmentsAfterLastWalkIn[advanceAppointmentsAfterLastWalkIn.length - 1];
          const lastAdvanceSlotIndex = typeof lastAdvanceAfterWalkIn.slotIndex === 'number'
            ? lastAdvanceAfterWalkIn.slotIndex
            : -1;
          newSlotIndex = lastAdvanceSlotIndex >= 0 ? lastAdvanceSlotIndex + 1 : lastSlotIndexFromSlots + 1;
          console.info('[Walk-in Scheduling] Bucket compensation - fallback: placing after last advance:', {
            lastAdvanceSlotIndex,
            newSlotIndex
          });
        }
      } else {
        // Not enough advance appointments - place after the last advance appointment
        if (advanceAppointmentsAfterLastWalkIn.length > 0) {
          const lastAdvanceAfterWalkIn = advanceAppointmentsAfterLastWalkIn[advanceAppointmentsAfterLastWalkIn.length - 1];
          const lastAdvanceSlotIndex = typeof lastAdvanceAfterWalkIn.slotIndex === 'number'
            ? lastAdvanceAfterWalkIn.slotIndex
            : -1;
          newSlotIndex = lastAdvanceSlotIndex >= 0 ? lastAdvanceSlotIndex + 1 : lastSlotIndexFromSlots + 1;
          console.info('[Walk-in Scheduling] Bucket compensation - not enough advances, placing after last:', {
            lastAdvanceSlotIndex,
            newSlotIndex
          });
        } else {
          // No advance appointments after last walk-in - place after last walk-in
          newSlotIndex = lastWalkInSlotIndex + 1;
          console.info('[Walk-in Scheduling] Bucket compensation - no advances after walk-in, placing after walk-in:', {
            lastWalkInSlotIndex,
            newSlotIndex
          });
        }
      }
    } else {
      // No walk-ins exist or no spacing configured - use sequential placement
      // Find the last slotIndex used across ALL sessions for this day
      const allSlotIndicesFromAppointments = effectiveAppointments
        .map(appointment => typeof appointment.slotIndex === 'number' ? appointment.slotIndex : -1)
        .filter(idx => idx >= 0);

      const maxSlotIndexFromAppointments = allSlotIndicesFromAppointments.length > 0
        ? Math.max(...allSlotIndicesFromAppointments)
        : -1;

      const maxSlotIndex = Math.max(maxSlotIndexFromAppointments, lastSlotIndexFromSlots);
      newSlotIndex = maxSlotIndex + 1;

      console.info('[Walk-in Scheduling] Bucket compensation - sequential placement (no walk-ins or spacing):', {
        maxSlotIndexFromAppointments,
        lastSlotIndexFromSlots,
        maxSlotIndex,
        newSlotIndex
      });
    }

    // CRITICAL FIX: Verify that the chosen newSlotIndex is NOT occupied by an existing appointment
    // This handles cases where interval logic picks an occupied slot index (e.g. 14) but we aren't shifting.
    const isOccupiedByAppointment = effectiveAppointments.some(
      apt => typeof apt.slotIndex === 'number' && apt.slotIndex === newSlotIndex && ACTIVE_STATUSES.has(apt.status)
    );

    if (isOccupiedByAppointment) {
      // Fallback: Use sequential placement at the very end
      const allSlotIndicesFromAppointments = effectiveAppointments
        .filter(apt => typeof apt.slotIndex === 'number' && ACTIVE_STATUSES.has(apt.status))
        .map(apt => apt.slotIndex as number);
      const maxSlotIndexFromAppointments = allSlotIndicesFromAppointments.length > 0
        ? Math.max(...allSlotIndicesFromAppointments)
        : -1;
      const maxSlotIndex = Math.max(maxSlotIndexFromAppointments, lastSlotIndexFromSlots);
      const seqSlotIndex = maxSlotIndex + 1;

      console.info('[Walk-in Scheduling] Strategy 4 chosen index was occupied, falling back to sequential:', {
        originalIndex: newSlotIndex,
        seqSlotIndex
      });
      newSlotIndex = seqSlotIndex;
    }

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
    transaction.set(bucketReservationRef, {
      clinicId,
      doctorName,
      date: dateStr,
      slotIndex: newSlotIndex,
      reservedAt: serverTimestamp(),
      type: 'bucket',
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

    if (newSlotIndex < slots.length) {
      // New slot is within availability - use the slot's time
      const slotMeta = slots[newSlotIndex];
      newSlotTime = slotMeta ? slotMeta.time : addMinutes(now, slotDuration);
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
          const appointmentDate = parse(dateStr, 'd MMMM yyyy', new Date());
          const referenceTime = parse(referenceAppointment.time, 'hh:mm a', appointmentDate);
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
      const slotMeta = slots[newSlotIndex];
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
      maxSlotIndexUsed: maxSlotIndex,
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

  const { schedule, newAssignment, placeholderIds } = scheduleAttempt;

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

  const reservationDeletes = new Map<string, DocumentReference>();
  const appointmentUpdates: Array<{
    docRef: DocumentReference;
    slotIndex: number;
    sessionIndex: number;
    timeString: string;
    arriveByTime: string; // Added this
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
  } else {
    // Normal scheduling - may need to shift advance appointments
    // Get the walk-in's slot index
    const walkInSlotIndex = newAssignment.slotIndex;

    // CRITICAL: Calculate walk-in time based on previous appointment instead of scheduler time
    // Get the appointment before the walk-in slot
    let walkInTime: Date = newAssignment.slotTime; // Default to scheduler time
    if (walkInSlotIndex > 0) {
      const appointmentBeforeWalkIn = advanceOccupancy[walkInSlotIndex - 1];
      if (appointmentBeforeWalkIn && appointmentBeforeWalkIn.time) {
        try {
          const appointmentDate = parse(dateStr, 'd MMMM yyyy', new Date());
          const previousAppointmentTime = parse(
            appointmentBeforeWalkIn.time,
            'hh:mm a',
            appointmentDate
          );
          // Walk-in time = previous appointment time (same time as A004)
          walkInTime = previousAppointmentTime;
        } catch (e) {
          // If parsing fails, use scheduler's time
          walkInTime = newAssignment.slotTime;
        }
      }
    }

    // Get the appointment before the walk-in (or use walk-in time if walkInSlotIndex is 0)
    // This will be used to calculate the first moved appointment's time
    let previousAppointmentTime: Date;
    if (walkInSlotIndex > 0) {
      const appointmentBeforeWalkIn = advanceOccupancy[walkInSlotIndex - 1];
      if (appointmentBeforeWalkIn && appointmentBeforeWalkIn.time) {
        // Parse the appointment time string to Date using date-fns parse
        try {
          const appointmentDate = parse(dateStr, 'd MMMM yyyy', new Date());
          previousAppointmentTime = parseTimeString(
            appointmentBeforeWalkIn.time,
            appointmentDate
          );
        } catch (e) {
          // If parsing fails, use walk-in time
          previousAppointmentTime = walkInTime;
        }
      } else {
        // No appointment before, use walk-in time
        previousAppointmentTime = walkInTime;
      }
    } else {
      // walkInSlotIndex is 0, use walk-in time
      previousAppointmentTime = walkInTime;
    }

    // CRITICAL: Only shift appointments if the walk-in slot is actually occupied
    // If the slot is empty (reserved for walk-ins), no shifting is needed
    const isSlotOccupied = advanceOccupancy[walkInSlotIndex] !== null ||
      activeWalkIns.some(w => typeof w.slotIndex === 'number' && w.slotIndex === walkInSlotIndex);

    // Get appointments that need to be shifted (at or after walk-in slot)
    // Sort by original slotIndex to process them in order
    const appointmentsToShift = isSlotOccupied
      ? activeAdvanceAppointments.filter(appointment => {
        const currentSlotIndex = typeof appointment.slotIndex === 'number' ? appointment.slotIndex : -1;
        return currentSlotIndex >= walkInSlotIndex;
      }).sort((a, b) => {
        const aIdx = typeof a.slotIndex === 'number' ? a.slotIndex : -1;
        const bIdx = typeof b.slotIndex === 'number' ? b.slotIndex : -1;
        return aIdx - bIdx;
      })
      : []; // No shifting needed if slot is empty

    // Process appointments that need shifting (at or after walk-in slot)
    // CRITICAL: For W booking, increment slotIndex by 1 and recalculate time
    // IMPORTANT: We only shift if the slot is occupied - empty slots don't need shifting
    for (const appointment of appointmentsToShift) {
      const currentSlotIndex = typeof appointment.slotIndex === 'number' ? appointment.slotIndex : -1;
      if (currentSlotIndex < 0) continue; // Skip invalid slot indices

      // CRITICAL: Increment slotIndex by 1 for each appointment being shifted
      const newSlotIndex = currentSlotIndex + 1;

      // Validate that newSlotIndex is within bounds
      if (newSlotIndex >= totalSlots) {
        console.warn(`[BOOKING DEBUG] Cannot shift appointment ${appointment.id} from slot ${currentSlotIndex} to ${newSlotIndex} - exceeds total slots ${totalSlots}`);
        continue;
      }

      // CRITICAL: Calculate new time from appointment's current time field + averageConsultingTime
      // Parse the appointment's current time field and add averageConsultingTime to it
      let newAppointmentTime: Date;
      if (appointment.time) {
        try {
          const appointmentDate = parse(dateStr, 'd MMMM yyyy', new Date());
          const currentAppointmentTime = parseTimeString(appointment.time, appointmentDate);
          // New time = current time + averageConsultingTime
          newAppointmentTime = addMinutes(currentAppointmentTime, averageConsultingTime);
        } catch (e) {
          console.warn(`[BOOKING DEBUG] Failed to parse appointment time "${appointment.time}" for appointment ${appointment.id}, skipping time update`);
          continue;
        }
      } else {
        console.warn(`[BOOKING DEBUG] Appointment ${appointment.id} has no time field, skipping time update`);
        continue;
      }

      const newTimeString = getClinicTimeString(newAppointmentTime);

      // CRITICAL: Calculate new noShowTime from appointment's current noShowTime field + averageConsultingTime
      // Parse the appointment's current noShowTime field and add averageConsultingTime to it
      let noShowTime: Date;
      if (appointment.noShowTime) {
        try {
          let currentNoShowTime: Date;
          if (appointment.noShowTime instanceof Date) {
            currentNoShowTime = appointment.noShowTime;
          } else if (typeof appointment.noShowTime === 'object' && appointment.noShowTime !== null) {
            const noShowTimeObj = appointment.noShowTime as { toDate?: () => Date; seconds?: number };
            if (typeof noShowTimeObj.toDate === 'function') {
              currentNoShowTime = noShowTimeObj.toDate();
            } else if (typeof noShowTimeObj.seconds === 'number') {
              currentNoShowTime = new Date(noShowTimeObj.seconds * 1000);
            } else {
              // Fallback to using new appointment time + averageConsultingTime
              currentNoShowTime = addMinutes(newAppointmentTime, averageConsultingTime);
            }
          } else {
            // Fallback to using new appointment time + averageConsultingTime
            currentNoShowTime = addMinutes(newAppointmentTime, averageConsultingTime);
          }
          // New noShowTime = current noShowTime + averageConsultingTime
          noShowTime = addMinutes(currentNoShowTime, averageConsultingTime);
        } catch (e) {
          // If parsing fails, use new appointment time + averageConsultingTime
          noShowTime = addMinutes(newAppointmentTime, averageConsultingTime);
        }
      } else {
        // No noShowTime available, use new appointment time + averageConsultingTime
        noShowTime = addMinutes(newAppointmentTime, averageConsultingTime);
      }

      // Find the sessionIndex for the new slotIndex
      let newSlotMeta = slots[newSlotIndex];
      if (!newSlotMeta && slots.length > 0) {
        // CRITICAL SURGICAL FIX: Synthesize slot metadata for overflow indices
        // to support shifting beyond the regular availability session.
        const lastSlot = slots[slots.length - 1];
        const avgDuration = slots.length > 1
          ? (slots[1].time.getTime() - slots[0].time.getTime()) / 60000
          : 15;

        newSlotMeta = {
          index: newSlotIndex,
          time: addMinutes(lastSlot.time, (newSlotIndex - lastSlot.index) * avgDuration),
          sessionIndex: lastSlot.sessionIndex
        };
        console.info(`[BOOKING DEBUG] Synthesized overflow slot meta for index ${newSlotIndex}`, newSlotMeta);
      }

      if (!newSlotMeta) {
        console.warn(`[BOOKING DEBUG] Slot ${newSlotIndex} does not exist and cannot be synthesized, skipping appointment ${appointment.id}`);
        continue;
      }
      const newSessionIndex = newSlotMeta.sessionIndex;

      // CRITICAL: Always update if slotIndex changed OR time changed
      // Don't skip updates when slotIndex changes, even if time happens to match
      const slotIndexChanged = currentSlotIndex !== newSlotIndex;
      const timeChanged = appointment.time !== newTimeString;

      if (!slotIndexChanged && !timeChanged) {
        // Only skip if both slotIndex and time are unchanged
        continue;
      }

      const appointmentRef = doc(firestore, 'appointments', appointment.id);
      appointmentUpdates.push({
        docRef: appointmentRef,
        slotIndex: newSlotIndex,
        sessionIndex: newSessionIndex,
        timeString: newTimeString,
        arriveByTime: newTimeString, // arriveByTime is always the raw slot time string
        noShowTime,
      });

      if (DEBUG_BOOKING || slotIndexChanged || timeChanged) {
        console.info(`[BOOKING DEBUG] Updating appointment ${appointment.id}`, {
          slotIndexChanged,
          timeChanged,
          oldSlotIndex: currentSlotIndex,
          newSlotIndex,
          oldTime: appointment.time,
          newTime: newTimeString,
          oldNoShowTime: appointment.noShowTime,
          newNoShowTime: noShowTime,
        });
      }

      const cloned = updatedAdvanceMap.get(appointment.id);
      if (cloned) {
        cloned.slotIndex = newSlotIndex;
        cloned.sessionIndex = newSessionIndex;
        cloned.time = newTimeString;
        cloned.arriveByTime = newTimeString; // Added this
        cloned.noShowTime = noShowTime;
      }
    }

    // Handle appointments that are NOT being shifted (before walk-in slot)
    // These should use the scheduler's assignment time (if they moved)
    for (const appointment of activeAdvanceAppointments) {
      const currentSlotIndex = typeof appointment.slotIndex === 'number' ? appointment.slotIndex : -1;
      if (currentSlotIndex >= walkInSlotIndex) {
        continue; // Already handled above
      }

      const assignment = assignmentById.get(appointment.id);
      if (!assignment) continue;

      const newSlotIndex = assignment.slotIndex;
      const newTimeString = getClinicTimeString(assignment.slotTime);
      const noShowTime = addMinutes(assignment.slotTime, averageConsultingTime);

      if (currentSlotIndex === newSlotIndex && appointment.time === newTimeString) {
        continue;
      }

      const appointmentRef = doc(firestore, 'appointments', appointment.id);
      appointmentUpdates.push({
        docRef: appointmentRef,
        slotIndex: newSlotIndex,
        sessionIndex: assignment.sessionIndex,
        timeString: newTimeString,
        arriveByTime: newTimeString,
        noShowTime,
      });

      const cloned = updatedAdvanceMap.get(appointment.id);
      if (cloned) {
        cloned.slotIndex = newSlotIndex;
        cloned.sessionIndex = assignment.sessionIndex;
        cloned.time = newTimeString;
        cloned.noShowTime = noShowTime;
      }
    }
  }

  if (DEBUG_BOOKING) {
    console.info('[patient booking] shift plan result', {
      newAssignment,
      reservationDeletes: Array.from(reservationDeletes.values()).map(ref => ref.path),
      appointmentUpdates,
    });
  }

  return {
    newAssignment,
    reservationDeletes: Array.from(reservationDeletes.values()),
    appointmentUpdates,
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

  const [{ slots }, appointments, clinicSnap] = await Promise.all(fetchPromises);

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
  const existingNumericTokens = appointments
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



  // For preview, we include both existing walk-ins and the new candidate
  // so the scheduler can correctly account for spacing between walk-ins.
  const baseWalkInCandidates = activeWalkIns.map(appt => ({
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

  // Calculate bucket count logic (same as appointment-service.ts)
  const cancelledSlotsInWindow: Array<{ slotIndex: number; slotTime: Date }> = [];
  let bucketCount = 0;

  // Build set of slots with active appointments
  const slotsWithActiveAppointments = new Set<number>();
  appointments.forEach(appt => {
    if (typeof appt.slotIndex === 'number' && ACTIVE_STATUSES.has(appt.status)) {
      slotsWithActiveAppointments.add(appt.slotIndex);
    }
  });

  const activeWalkInsWithTimes = activeWalkIns
    .filter(appt => typeof appt.slotIndex === 'number')
    .map(appt => ({
      slotIndex: appt.slotIndex!,
      slotTime: slots[appt.slotIndex!]?.time,
    }))
    .filter(item => item.slotTime !== undefined);

  // Restore variable initialization
  const blockedAdvanceAppointments = activeAdvanceAppointments.map(entry => ({
    id: entry.id,
    slotIndex: typeof entry.slotIndex === 'number' ? entry.slotIndex : -1,
  }));

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
      const slotMeta = slots[appt.slotIndex];
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
  const reservationChecks: Promise<{ slotIdx: number; snap: DocumentSnapshot }>[] = [];

  for (let slotIdx = 0; slotIdx < maxSlotToCheck; slotIdx++) {
    const reservationId = buildReservationDocId(
      doctor.clinicId || '',
      doctor.name,
      dateStr,
      slotIdx
    );

    reservationChecks.push(
      getDoc(doc(firestore, 'slot-reservations', reservationId))
        .then(snap => ({ slotIdx, snap }))
        .catch(() => ({ slotIdx, snap: null as any }))
    );
  }

  // Wait for all reservation checks to complete
  const reservationResults = await Promise.all(reservationChecks);



  // Process reservation results
  reservationResults.forEach(({ slotIdx, snap }) => {
    if (!snap || !snap.exists()) return;

    try {
      const data = snap.data();
      const reservedAt = data?.reservedAt;

      if (!reservedAt) return;

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
      const threshold = isBooked ? 300 : 30; // 5 minutes for booked, 30 seconds for temporary

      if (ageInSeconds <= threshold) {
        // Skip reservations from advance booking (they don't block walk-ins in actual booking)
        const reservedBy = data?.reservedBy as string | undefined;
        if (reservedBy !== 'appointment-booking') {
          reservedSlots.add(slotIdx);


        }
      }
    } catch (e) {
      // Ignore parsing errors, continue with other slots
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
    // ------------------------------------------------------------------------
    let freeFutureSlotsCount = 0;
    const occupiedIndices = new Set<number>();

    // 1. Identify Occupied Indices from Appointments & Blocked
    const registerOccupancy = (idx: number) => {
      if (typeof idx === 'number') occupiedIndices.add(idx);
    };

    appointments.forEach(appt => {
      if (typeof appt.slotIndex === 'number' && ACTIVE_STATUSES.has(appt.status)) {
        registerOccupancy(appt.slotIndex);
      }
    });
    blockedAdvanceAppointments.forEach(blocked => {
      if (typeof blocked.slotIndex === 'number') registerOccupancy(blocked.slotIndex);
    });

    // 2. Count "Free" Slots in the future
    for (let i = 0; i < slots.length; i++) {
      if (isBefore(slots[i].time, now)) continue;
      if (hasExistingWalkIns && cancelledSlotsInBucket.has(i)) continue; // Blocked by bucket

      if (!occupiedIndices.has(i)) {
        freeFutureSlotsCount++;
      }
    }

    // 3. Count "Overflow" Appointments (Indices >= slots.length)
    // These will be back-filled by the Scheduler into the Free Slots
    let overflowCount = 0;
    appointments.forEach(appt => {
      if (ACTIVE_STATUSES.has(appt.status)) {
        // If valid index but outside range, OR no index (though we filter for number usually)
        if (typeof appt.slotIndex === 'number' && appt.slotIndex >= slots.length) {
          overflowCount++;
        }
      }
    });
    // Also check blocked advance if any are out of bounds (unlikely if derived from active)
    blockedAdvanceAppointments.forEach(blocked => {
      if (typeof blocked.slotIndex === 'number' && blocked.slotIndex >= slots.length) {
        // De-duplicate if already counted?
        // blockedAdvanceAppointments is usually a subset/map of active.
        // We can just rely on appointments loop above for the count to be safe/simple
        // BUT blocked might include cancelled-in-bucket which are separate.
        // CancelledInBucket indices are usually valid (within range).
        // So we primarily care about 'Active Advance' that are out of bounds.
      }
    });

    if (overflowCount >= freeFutureSlotsCount) {
      return true; // Overflow will fill all gaps, so session is full
    }

    return false; // Steps above confirm explicitly active slots
  })();

  const canUseBucketCompensation = allSlotsFilled && firestoreBucketCount > 0;

  try {
    schedule = computeWalkInSchedule({
      slots,
      now,
      walkInTokenAllotment: walkInTokenAllotment || 0,
      advanceAppointments: blockedAdvanceAppointments,
      walkInCandidates: activeWalkInCandidates,
    });
  } catch (error) {
    // If all slots are filled, we should fallback to overflow logic (Bucket/Overflow)
    // ONLY if explicit forceBook is requested OR bucket compensation is available.
    // Automatic overflow based solely on allSlotsFilled is disabled to ensure UI prompts are shown.
    if (!forceBook && !canUseBucketCompensation) {
      throw error;
    }
  }

  const newAssignment = schedule?.assignments.find(a => a.id === '__new_walk_in__');

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

      const maxSlotIndex = allSlotIndices.length > 0 ? Math.max(...allSlotIndices) : -1;
      const overflowSlotIndex = maxSlotIndex + 1;

      // Find last slot time or use last session end time
      let overflowTime: Date;
      const consultationTime = doctor.averageConsultingTime || 15;

      if (slots.length > 0) {
        const lastSlot = slots[slots.length - 1];
        overflowTime = addMinutes(lastSlot.time, consultationTime);
      } else {
        // No slots exist, use current time
        overflowTime = addMinutes(now, consultationTime);
      }

      // Determine session index (use last session)
      const dayOfWeek = getClinicDayOfWeek(date);
      const availabilityForDay = doctor.availabilitySlots?.find(s => s.day === dayOfWeek);
      const lastSessionIndex = availabilityForDay?.timeSlots?.length
        ? availabilityForDay.timeSlots.length - 1
        : 0;

      // Count patients ahead (all active appointments)
      const allActiveStatuses = new Set(['Pending', 'Confirmed', 'Skipped']);
      const patientsAhead = appointments.filter(appointment =>
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

  const allActiveStatuses = new Set(['Pending', 'Confirmed', 'Skipped']);
  const patientsAhead = appointments.filter(appointment => {
    return (
      typeof appointment.slotIndex === 'number' &&
      appointment.slotIndex < chosenSlotIndex &&
      allActiveStatuses.has(appointment.status)
    );
  }).length;

  return {
    estimatedTime: chosenTime,
    patientsAhead,
    numericToken,
    slotIndex: chosenSlotIndex,
    sessionIndex: chosenSessionIndex,
    actualSlotTime: chosenTime,
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

    const fromTime = currentSlotIndex >= 0 ? slots[currentSlotIndex]?.time ?? null : null;

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

