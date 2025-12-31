import { db } from '@kloqo/shared-firebase';
import type { Firestore } from 'firebase/firestore';
import {
  collection,
  query,
  where,
  orderBy,
  getDocs,
  getDoc,
  doc,
  runTransaction,
  serverTimestamp,
  type DocumentReference,
  type DocumentSnapshot,
  type Transaction,
} from 'firebase/firestore';
import { format, addMinutes, differenceInMinutes, isAfter, isBefore, subMinutes, parse, parseISO, isSameMinute, isSameDay } from 'date-fns';
import type { Doctor, Appointment } from '@kloqo/shared-types';
import {
  getSessionEnd,
  getSessionBreakIntervals,
  buildBreakIntervalsFromPeriods,
  applyBreakOffsets,
  isSlotBlockedByLeave,
  parseTime as parseTimeString
} from '../utils/break-helpers';
import { getClinicDateString, getClinicDayOfWeek, getClinicTimeString, getClinicISOString, getClinicShortDateString, getClinicNow } from '../utils/date-utils';
import { buildReservationDocId } from '../utils/reservation-utils';
import { computeWalkInSchedule, type SchedulerAssignment } from './walk-in-scheduler';

const DEBUG_BOOKING = process.env.NEXT_PUBLIC_DEBUG_BOOKING === 'true';

const ACTIVE_STATUSES = new Set(['Pending', 'Confirmed', 'Skipped', 'Completed']);
const MAX_TRANSACTION_ATTEMPTS = 5;
const RESERVATION_CONFLICT_CODE = 'slot-reservation-conflict';

function isReservationConflict(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  // Check for Firestore error codes or custom error messages
  return (
    (error as any).code === RESERVATION_CONFLICT_CODE ||
    error.message.includes('reservation') ||
    error.message.includes('conflict')
  );
}

interface DailySlot {
  index: number;
  time: Date;
  sessionIndex: number;
}

interface LoadedDoctor {
  doctor: Doctor;
  slots: DailySlot[];
}


export function getLeaveBlockedIndices(doctor: Doctor, slots: DailySlot[], date: Date): number[] {
  const blockedIndices: number[] = [];

  for (const slot of slots) {
    if (isSlotBlockedByLeave(doctor, slot.time)) {
      blockedIndices.push(slot.index);
    }
  }
  return blockedIndices;
}

async function loadDoctorAndSlots(
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
    throw new Error('Doctor not found.');
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

  availabilityForDay.timeSlots.forEach((session, sessionIndex) => {
    let currentTime = parseTimeString(session.from, date);
    let endTime = parseTimeString(session.to, date);

    // Check for availability extension (session-specific)
    const dateKey = getClinicDateString(date);
    const extensionForDate = (doctor as any).availabilityExtensions?.[dateKey];

    if (extensionForDate) {
      const sessionExtension = extensionForDate.sessions?.find((s: any) => s.sessionIndex === sessionIndex);

      if (sessionExtension) {
        const newEndTimeStr = sessionExtension.newEndTime;

        if (newEndTimeStr && sessionExtension.totalExtendedBy > 0) {
          try {
            const extendedEndTime = parseTimeString(newEndTimeStr, date);

            // Only use extended time if it's actually later than the original end time
            if (isAfter(extendedEndTime, endTime)) {
              endTime = extendedEndTime;
            }
          } catch (error) {
            console.error('Error parsing extended end time, using original:', error);
            // Fall back to original end time if parsing fails
          }
        }
      }
    }

    while (isBefore(currentTime, endTime)) {
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

async function fetchDayAppointments(
  clinicId: string,
  doctorName: string,
  date: Date
): Promise<Appointment[]> {
  const dateStr = getClinicDateString(date);
  const appointmentsRef = collection(db, 'appointments');
  const appointmentsQuery = query(
    appointmentsRef,
    where('clinicId', '==', clinicId),
    where('doctor', '==', doctorName),
    where('date', '==', dateStr)
  );
  const snapshot = await getDocs(appointmentsQuery);
  return snapshot.docs.map(docRef => ({ id: docRef.id, ...docRef.data() } as Appointment));
}

function buildOccupiedSlotSet(appointments: Appointment[]): Set<number> {
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
    throw new Error('Selected slot is outside the doctor availability.');
  }
  return slot.time;
}

/**
 * Calculate reserved walk-in slots per session (15% of FUTURE slots only in each session)
 * This dynamically adjusts as time passes - reserved slots are recalculated based on remaining future slots
 * Returns a Set of slot indices that are reserved for walk-ins
 */
function calculatePerSessionReservedSlots(slots: DailySlot[], now: Date = getClinicNow(), blockedIndices: Set<number> = new Set()): Set<number> {
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

    // Filter to only future slots (including current time) AND not blocked by leave
    const futureSlots = sessionSlots.filter(slot =>
      (isAfter(slot.time, now) || slot.time.getTime() >= now.getTime()) &&
      !blockedIndices.has(slot.index)
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

function buildCandidateSlots(
  type: 'A' | 'W',
  slots: DailySlot[],
  now: Date,
  occupied: Set<number>,
  preferredSlotIndex?: number,
  options: CandidateOptions = {},
  blockedIndices: Set<number> = new Set() // New param
): number[] {
  const oneHourFromNow = addMinutes(now, 60);
  const candidates: number[] = [];

  // Calculate reserved walk-in slots per session (15% of FUTURE slots only in each session)
  // We need blockedIndices to exclude them from reserve calculation
  const reservedWSlots = calculatePerSessionReservedSlots(slots, now, blockedIndices);

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

      } else if (isAfter(slotTime, oneHourFromNow)) {
        addCandidate(preferredSlotIndex);
      } else {

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

interface TokenCounterState {
  nextNumber: number;
  exists: boolean;
}

async function prepareNextTokenNumber(
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

function commitNextTokenNumber(
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
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof (value as { toDate?: () => Date }).toDate === 'function') {
    try {
      return (value as { toDate: () => Date }).toDate();
    } catch {
      return null;
    }
  }
  return null;
}

// buildReservationDocId moved to shared utils

export async function generateNextToken(
  clinicId: string,
  doctorName: string,
  date: Date,
  type: 'A' | 'W'
): Promise<string> {
  const dateStr = getClinicDateString(date);
  const counterDocId = `${clinicId}_${doctorName}_${dateStr}${type === 'W' ? '_W' : ''}`
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_]/g, '');
  const counterRef = doc(db, 'token-counters', counterDocId);

  const tokenNumber = await runTransaction(db, async transaction => {
    const counterState = await prepareNextTokenNumber(transaction, counterRef);
    commitNextTokenNumber(transaction, counterRef, counterState);
    return `${type}${String(counterState.nextNumber + (type === 'W' ? 100 : 0)).padStart(3, '0')}`;
  });

  return tokenNumber;
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
    isForceBooked?: boolean;
    [key: string]: unknown;
  }
): Promise<{
  tokenNumber: string;
  numericToken: number;
  slotIndex: number;
  sessionIndex: number;
  time: string;
  arriveByTime: string;
  reservationId: string;
}> {
  const dateStr = getClinicDateString(date);
  const now = getClinicNow();
  const counterDocId = `${clinicId}_${doctorName}_${dateStr}${type === 'W' ? '_W' : ''}`
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_]/g, '');
  const counterRef = doc(firestore, 'token-counters', counterDocId);
  let walkInSpacingValue = 0;
  if (type === 'W') {
    if (typeof appointmentData.walkInSpacing === 'number') {
      walkInSpacingValue = appointmentData.walkInSpacing;
    } else {
      const clinicSnap = await getDoc(doc(firestore, 'clinics', clinicId));
      const rawSpacing = clinicSnap.exists() ? Number(clinicSnap.data()?.walkInTokenAllotment ?? 0) : 0;
      walkInSpacingValue = Number.isFinite(rawSpacing) && rawSpacing > 0 ? Math.floor(rawSpacing) : 0;
    }
  }

  const { doctor: doctorProfile, slots } = await loadDoctorAndSlots(
    firestore,
    clinicId,
    doctorName,
    date,
    typeof appointmentData.doctorId === 'string' ? appointmentData.doctorId : undefined
  );
  const totalSlots = slots.length;
  // Calculate blocked slot indices due to leave
  const blockedIndices = getLeaveBlockedIndices(doctorProfile, slots, date);
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

  const appointmentsRef = collection(firestore, 'appointments');
  const appointmentsQuery = query(
    appointmentsRef,
    where('clinicId', '==', clinicId),
    where('doctor', '==', doctorName),
    where('date', '==', dateStr),
    orderBy('slotIndex', 'asc')
  );

  // Fetch appointments early to partial-exclude cancelledByBreak slots from capacity
  const initialAppointmentsSnapshot = await getDocs(appointmentsQuery);
  const breakBlockedIndices = new Set<number>();
  initialAppointmentsSnapshot.docs.forEach(doc => {
    const data = doc.data();
    if (data.cancelledByBreak && data.status === 'Completed' && typeof data.slotIndex === 'number') {
      breakBlockedIndices.add(data.slotIndex);
    }
  });

  let maximumAdvanceTokens = 0;
  console.log('🔵 [CAPACITY DEBUG] Starting capacity calculation');
  slotsBySession.forEach((sessionSlots, sessionIndex) => {
    console.log(`🔵 [CAPACITY DEBUG] Session ${sessionIndex}: Total slots = ${sessionSlots.length}`);
    console.log(`🔵 [CAPACITY DEBUG] Session ${sessionIndex}: Blocked by leave = ${blockedIndices.length}`);
    console.log(`🔵 [CAPACITY DEBUG] Session ${sessionIndex}: Blocked by break = ${breakBlockedIndices.size}`);
    console.log(`🔵 [CAPACITY DEBUG] Session ${sessionIndex}: Break blocked indices:`, Array.from(breakBlockedIndices));

    // Filter to only future slots (including current time) AND not blocked by leave OR break appointment
    const futureSlots = sessionSlots.filter(slot =>
      (isAfter(slot.time, now) || slot.time.getTime() >= now.getTime()) &&
      !blockedIndices.includes(slot.index) &&
      !breakBlockedIndices.has(slot.index)
    );

    const futureSlotCount = futureSlots.length;
    const sessionMinimumWalkInReserve = futureSlotCount > 0 ? Math.ceil(futureSlotCount * 0.15) : 0;
    const sessionAdvanceCapacity = Math.max(futureSlotCount - sessionMinimumWalkInReserve, 0);

    console.log(`🔵 [CAPACITY DEBUG] Session ${sessionIndex}: Future slots (after filtering) = ${futureSlotCount}`);
    console.log(`🔵 [CAPACITY DEBUG] Session ${sessionIndex}: W-token reserve (15%) = ${sessionMinimumWalkInReserve}`);
    console.log(`🔵 [CAPACITY DEBUG] Session ${sessionIndex}: A-token capacity = ${sessionAdvanceCapacity}`);

    maximumAdvanceTokens += sessionAdvanceCapacity;
  });
  console.log(`🔵 [CAPACITY DEBUG] Total maximum A-tokens = ${maximumAdvanceTokens}`);

  // Proceed to book if capacity allows

  for (let attempt = 0; attempt < MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
    const appointmentsSnapshot = await getDocs(appointmentsQuery);
    const appointmentDocRefs = appointmentsSnapshot.docs.map(docSnap => doc(firestore, 'appointments', docSnap.id));

    try {
      return await runTransaction(firestore, async transaction => {
        // CRITICAL: Only prepare counter for walk-ins, not for advance bookings
        // Advance bookings use slotIndex + 1 for tokens, so counter is not needed
        let counterState: TokenCounterState | null = null;

        if (type === 'W') {
          counterState = await prepareNextTokenNumber(transaction, counterRef);
        }

        const appointmentSnapshots = await Promise.all(
          appointmentDocRefs.map(ref => transaction.get(ref))
        );
        const appointments = appointmentSnapshots
          .filter(snapshot => snapshot.exists())
          .map(snapshot => {
            const data = snapshot.data() as Appointment;
            return { ...data, id: snapshot.id };
          });

        const excludeAppointmentId =
          typeof appointmentData.existingAppointmentId === 'string' ? appointmentData.existingAppointmentId : undefined;
        const rawEffectiveAppointments = excludeAppointmentId
          ? appointments.filter(appointment => appointment.id !== excludeAppointmentId)
          : appointments;

        // Inject blocked slots as confirmed booking to block the scheduler
        const blockedAppointments: Appointment[] = blockedIndices.map(idx => ({
          id: `blocked-leave-${idx}`,
          slotIndex: idx,
          status: 'Confirmed',
          bookedVia: 'Advanced Booking',
          clinicId,
          doctor: doctorName,
          date: dateStr,
          patientId: 'blocked-system',
          patientName: 'Blocked (Leave)',
          createdAt: new Date(),
          updatedAt: new Date(),
          time: slots[idx] ? getClinicTimeString(slots[idx].time) : '',
          tokenNumber: `L${idx}`,
          department: doctorProfile.department || '',
          phone: '',
        } as unknown as Appointment));

        const effectiveAppointments = [...rawEffectiveAppointments, ...blockedAppointments];

        if (DEBUG_BOOKING) {
          console.info('[nurse booking] attempt', attempt, {
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
              typeof appointment.slotIndex === 'number' &&
              ACTIVE_STATUSES.has(appointment.status) &&
              !appointment.cancelledByBreak && // Exclude appointments cancelled by break scheduling
              !appointment.id.startsWith('blocked-leave-') && // Exclude injected blocked slots from usage count
              // CRITICAL: Exclude appointments that are on slots ALREADY blocked by leave
              !blockedIndices.includes(appointment.slotIndex) &&
              // CRITICAL: Exclude appointments that are on slots blocked by COMPLETED break appointments
              !breakBlockedIndices.has(appointment.slotIndex)
            );
          }).length;

          console.log('🔵 [ACTIVE COUNT DEBUG]', {
            totalEffectiveAppointments: effectiveAppointments.length,
            activeAdvanceTokens,
            maximumAdvanceTokens,
            cancelledByBreakCount: effectiveAppointments.filter(a => a.cancelledByBreak && a.status === 'Completed').length,
            breakBlockedSlots: Array.from(breakBlockedIndices),
          });

          if (maximumAdvanceTokens === 0 || activeAdvanceTokens >= maximumAdvanceTokens) {
            console.error('[nurse booking - REJECTION DEBUG]', {
              doctor: doctorName,
              totalSlots,
              maxCapacity: maximumAdvanceTokens,
              currentUsage: activeAdvanceTokens,
              activeAppts: effectiveAppointments.map(a => ({
                id: a.id,
                status: a.status,
                cancelledByBreak: a.cancelledByBreak,
                bookedVia: a.bookedVia,
                slotIndex: a.slotIndex
              }))
            });
            const capacityError = new Error('Advance booking capacity for the day has been reached.');
            (capacityError as { code?: string }).code = 'A_CAPACITY_REACHED';
            throw capacityError;
          }
        }

        let numericToken = 0;
        let tokenNumber = '';
        let chosenSlotIndex = -1;
        let sessionIndexForNew = 0;
        let resolvedTimeString = '';
        let reservationRef: DocumentReference | null = null;

        if (type === 'W') {
          if (!counterState) {
            throw new Error('Counter state not prepared for walk-in booking');
          }
          const nextWalkInNumericToken = totalSlots + counterState.nextNumber + 100;
          const shiftPlan = await prepareAdvanceShift({
            firestore: db,
            transaction,
            clinicId,
            doctorName,
            dateStr,
            slots,
            doctor: doctorProfile,
            now,
            walkInSpacingValue,
            effectiveAppointments,
            totalSlots,
            newWalkInNumericToken: nextWalkInNumericToken,
            isForceBooked: !!appointmentData.isForceBooked,
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

          // Use the time calculated by the scheduler/shiftPlan
          const walkInTime = newAssignment.slotTime;


          let finalTimeString = getClinicTimeString(walkInTime);




          const reservationId = buildReservationDocId(clinicId, doctorName, dateStr, finalSlotIndex);
          const reservationDocRef = doc(firestore, 'slot-reservations', reservationId);

          // CRITICAL: Check existingReservations map (already read in prepareAdvanceShift)
          // This avoids violating Firestore's "all reads before all writes" transaction rule
          if (existingReservations.has(finalSlotIndex)) {
            // Recent reservation exists - conflict
            const conflictError = new Error('Slot is already booked by another user');
            (conflictError as { code?: string }).code = 'SLOT_ALREADY_BOOKED';
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
          const occupiedSlots = buildOccupiedSlotSet(effectiveAppointments);
          // Combine all blocked indices for accurate reservation calculation (Leave + Break)
          const allBlockedIndices = new Set([...blockedIndices, ...breakBlockedIndices]);
          const candidates = buildCandidateSlots(type, slots, now, occupiedSlots, appointmentData.slotIndex, {
            appointments: effectiveAppointments,
          }, allBlockedIndices);

          if (candidates.length === 0) {
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

          for (const slotIndex of candidates) {
            if (occupiedSlots.has(slotIndex)) {
              continue;
            }

            // CRITICAL: Double-check that this slot is NOT reserved for walk-ins (last 15% of FUTURE slots in its session)
            // This check happens inside the transaction to prevent race conditions
            // Even if buildCandidateSlots included it (shouldn't happen), we reject it here
            // IMPORTANT: Must pass blockedIndices to exclude break-blocked slots from the calculation
            const combinedBlockedIndices = new Set([...blockedIndices, ...Array.from(breakBlockedIndices)]);
            const reservedWSlots = calculatePerSessionReservedSlots(slots, now, combinedBlockedIndices);
            if (type === 'A' && reservedWSlots.has(slotIndex)) {
              const slot = slots[slotIndex];
              console.log(`🔵 [SLOT SELECTION DEBUG] Skipping slot ${slotIndex} - reserved for W-tokens`);
              continue; // NEVER allow advance bookings to use reserved walk-in slots
            }

            const reservationId = buildReservationDocId(clinicId, doctorName, dateStr, slotIndex);
            const reservationDocRef = doc(firestore, 'slot-reservations', reservationId);
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
                    const now = new Date();
                    const ageInSeconds = (now.getTime() - reservedTime.getTime()) / 1000;
                    isStale = ageInSeconds > 30; // 30 second threshold for stale reservations
                  }
                } catch (e) {
                  // If we can't parse the timestamp, assume it's not stale
                  console.warn(`[BOOKING DEBUG] Could not parse reservedAt timestamp`, e);
                  isStale = false;
                }
              }

              if (isStale) {
                // Reservation is stale - clean it up and allow new booking

                // Delete the stale reservation within the transaction
                transaction.delete(reservationDocRef);
                // Continue to create new reservation below
              } else {
                // Reservation exists and is not stale - skip it
                continue;
              }
            }

            reservationRef = reservationDocRef;
            chosenSlotIndex = slotIndex;
            const reservedSlot = slots[chosenSlotIndex];
            sessionIndexForNew = reservedSlot?.sessionIndex ?? 0;
            resolvedTimeString = getClinicTimeString(reservedSlot?.time ?? now);

            // CRITICAL: Token number MUST be based on slotIndex + 1 (slotIndex is 0-based, tokens are 1-based)
            // This ensures token A001 goes to slot #1 (slotIndex 0), A002 to slot #2 (slotIndex 1), etc.
            // This makes token numbers correspond to slot positions, not sequential booking order
            // DO NOT use counterState.nextNumber - always use slotIndex + 1
            // Calculate token IMMEDIATELY after reserving slot to ensure atomicity
            const calculatedNumericToken = chosenSlotIndex + 1;
            const calculatedTokenNumber = `A${String(calculatedNumericToken).padStart(3, '0')}`;

            // Force assignment - don't allow any other value
            numericToken = calculatedNumericToken;
            tokenNumber = calculatedTokenNumber;

            // Verify assignment was successful
            if (numericToken !== calculatedNumericToken || tokenNumber !== calculatedTokenNumber) {

              // Force correct values
              numericToken = calculatedNumericToken;
              tokenNumber = calculatedTokenNumber;
            }

            break;
          }

          if (chosenSlotIndex < 0 || !reservationRef) {
            throw new Error('No available slots match the booking rules.');
          }
        }

        // CRITICAL: Ensure token is ALWAYS assigned based on slotIndex for advance bookings
        // This is a safety check in case the token wasn't assigned in the loop
        if (type === 'A' && chosenSlotIndex >= 0) {
          const expectedNumericToken = chosenSlotIndex + 1;
          const expectedTokenNumber = `A${String(expectedNumericToken).padStart(3, '0')}`;

          if (numericToken !== expectedNumericToken || tokenNumber !== expectedTokenNumber) {
            numericToken = expectedNumericToken;
            tokenNumber = expectedTokenNumber;
          }
        }

        if (DEBUG_BOOKING) {
          console.info('[nurse booking] walk-in assignment', {
            type,
            clinicId,
            doctorName,
            chosenSlotIndex,
            sessionIndexForNew,
            resolvedTimeString,
            numericToken,
            tokenNumber,
          });
        }

        if (!reservationRef) {
          if (DEBUG_BOOKING) {
            console.warn('[nurse booking] failed to reserve slot', { type, clinicId, doctorName, chosenSlotIndex });
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

        // CRITICAL: Ensure token matches slotIndex before returning
        // This is a final safety check to prevent token/slotIndex mismatches
        if (type === 'A' && chosenSlotIndex >= 0) {
          const expectedNumericToken = chosenSlotIndex + 1;
          const expectedTokenNumber = `A${String(expectedNumericToken).padStart(3, '0')}`;

          if (numericToken !== expectedNumericToken || tokenNumber !== expectedTokenNumber) {

            numericToken = expectedNumericToken;
            tokenNumber = expectedTokenNumber;
          }
        }

        const arriveByTimeDate = type === 'W'
          ? slots[chosenSlotIndex].time
          : subMinutes(slots[chosenSlotIndex].time, 15);
        const arriveByTimeString = getClinicTimeString(arriveByTimeDate);

        return {
          tokenNumber,
          numericToken,
          slotIndex: chosenSlotIndex,
          sessionIndex: sessionIndexForNew,
          time: resolvedTimeString,
          arriveByTime: arriveByTimeString,
          reservationId: reservationRef.id,
        };
      });
    } catch (error) {
      if (DEBUG_BOOKING) {
        console.warn('[nurse booking] transaction failed', { type, clinicId, doctorName, attempt, error });
      }
      if (isReservationConflict(error) && attempt < MAX_TRANSACTION_ATTEMPTS - 1) {
        continue;
      }
      throw error;
    }
  }

  throw new Error('No available slots match the booking rules.');
}

const prepareAdvanceShift = async ({
  firestore,
  transaction,
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
  isForceBooked = false,
}: {
  firestore: Firestore;
  transaction: Transaction;
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
  isForceBooked?: boolean;
}): Promise<{
  newAssignment: { slotIndex: number; slotTime: Date; sessionIndex: number } | null;
  reservationDeletes: DocumentReference[];
  appointmentUpdates: Array<{
    appointmentId: string;
    docRef: DocumentReference;
    slotIndex: number;
    sessionIndex: number;
    timeString: string;
    noShowTime: Date;
  }>;
  updatedAdvanceAppointments: Appointment[];
  usedBucketSlotIndex: number | null;
  existingReservations: Map<number, Date>;
}> => {
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
  // Read reservations up to maxSlotIndex + 20 to cover bucket compensation cases with extra buffer
  // This ensures we read the reservation for finalSlotIndex before any writes
  const maxSlotToRead = Math.max(totalSlots, maxSlotIndex + 20);

  const existingReservations = new Map<number, Date>();
  const staleReservationsToDelete: DocumentReference[] = [];

  for (let slotIdx = 0; slotIdx <= maxSlotToRead; slotIdx += 1) {
    const reservationId = buildReservationDocId(clinicId, doctorName, dateStr, slotIdx);
    const reservationRef = doc(firestore, 'slot-reservations', reservationId);
    const reservationSnapshot = await transaction.get(reservationRef);

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
            const reservedBy = reservationData?.reservedBy as string | undefined;
            const threshold = isBooked ? 300 : 30; // 5 minutes for booked, 30 seconds for temporary

            if (ageInSeconds <= threshold) {
              // Check if there's an existing appointment at this slot
              const existingAppt = effectiveAppointments.find(
                a => typeof a.slotIndex === 'number' && a.slotIndex === slotIdx
              );

              // If appointment exists and is NOT active (Cancelled or No-show), ignore reservation
              if (existingAppt && !ACTIVE_STATUSES.has(existingAppt.status)) {
                staleReservationsToDelete.push(reservationRef);
              } else {
                // No appointment, or appointment is active.
                // For walk-ins, do NOT treat reservations created by advance booking
                // (reservedBy === 'appointment-booking') as blocking. This allows
                // the scheduler to place a W token in that position and rely on
                // the shift plan to move the A token.
                if (!(isBooked && reservedBy === 'appointment-booking')) {
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

  // Calculate bucket count logic early (moved from below)
  const oneHourAhead = addMinutes(now, 60);
  const hasExistingWalkIns = activeWalkIns.length > 0;

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

            // CRITICAL FIX: When there are no walk-ins yet, count cancelled/no-show slots (especially past slots)
            // as potential bucket slots. This allows Strategy 4 to trigger when all slots are filled.
            // Only count slots that are NOT already in cancelledSlotsInWindow (i.e., past slots)
            if (!hasExistingWalkIns) {
              const isNotInCancelledWindow = cancelledSlotsInWindow.every(
                cs => cs.slotIndex !== appointment.slotIndex
              );

              if (isNotInCancelledWindow) {
                // This cancelled/no-show slot (likely a past slot) can be used for bucket compensation
                bucketCount += 1;
                console.info(`[Walk-in Scheduling] Adding cancelled/no-show slot ${appointment.slotIndex} to bucket count (no walk-ins yet, past slot):`, {
                  slotIndex: appointment.slotIndex,
                  slotTime: slotMeta.time.toISOString(),
                  status: appointment.status,
                  isPast: isBefore(slotMeta.time, now),
                });
              }
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
  // This is done BEFORE any writes to ensure we can read the reservation
  if (allSlotsFilledEarly && hasExistingWalkIns && firestoreBucketCount > 0) {
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
    const lastSlotIndexFromSlots = totalSlots > 0 ? totalSlots - 1 : -1;

    if (lastWalkInSlotIndex >= 0 && walkInSpacingValue > 0) {
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


  // CRITICAL FIX: Don't include existing walk-ins as candidates in actual booking
  // This matches the preview logic and prevents re-placing existing walk-ins
  // Existing walk-ins will be added to blockedAdvanceAppointments instead
  const baseWalkInCandidates: any[] = [];

  const newWalkInCandidate = {
    id: '__new_walk_in__',
    numericToken: newWalkInNumericToken,
    createdAt: now,
  };




  // DEBUG: Additional detailed bucket calculation info
  console.info('[Walk-in Scheduling] DEBUG - Bucket Calculation Details:', {
    totalEffectiveAppointments: effectiveAppointments.length,
    cancelledAppointments: effectiveAppointments.filter(a => a.status === 'Cancelled').length,
    noShowAppointments: effectiveAppointments.filter(a => a.status === 'No-show').length,
    activeWalkInsCount: activeWalkIns.length,
    walkInsOutsideAvailabilityDetails: walkInsOutsideAvailability.map(w => ({
      id: w.id,
      slotIndex: w.slotIndex,
      status: w.status,
    })),
    slotsWithActiveAppointments: Array.from(slotsWithActiveAppointments).sort((a, b) => a - b),
    oneHourAhead: oneHourAhead.toISOString(),
    currentTime: now.toISOString(),
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

      // CRITICAL FIX: Add existing walk-ins as blocked appointments (matching preview logic)
      // This prevents the scheduler from re-placing existing walk-ins
      activeWalkIns.forEach(walkIn => {
        if (typeof walkIn.slotIndex === 'number') {
          blockedAdvanceAppointments.push({
            id: `__existing_walkin_${walkIn.id}`,
            slotIndex: walkIn.slotIndex
          });
        }
      });

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

      const schedule = computeWalkInSchedule({
        slots,
        now,
        walkInTokenAllotment: walkInSpacingValue,
        advanceAppointments: blockedAdvanceAppointments,
        walkInCandidates: [...baseWalkInCandidates, ...reservedWalkInCandidates, newWalkInCandidate],
      });

      const newAssignment = schedule.assignments.find(
        assignment => assignment.id === '__new_walk_in__'
      );
      if (!newAssignment) {

        return null;
      }



      // Check if the assigned slot is a cancelled slot
      const assignedAppointment = effectiveAppointments.find(
        apt => apt.slotIndex === newAssignment.slotIndex &&
          (apt.status === 'Cancelled' || apt.status === 'No-show')
      );

      if (assignedAppointment) {
        const assignedSlotMeta = slots[newAssignment.slotIndex];


        // Check if this cancelled slot should be blocked (has walk-ins after it)
        if (hasExistingWalkIns && cancelledSlotsInBucket.has(newAssignment.slotIndex)) {
          // This shouldn't happen since we blocked them, but reject if it does
          console.error('[Walk-in Scheduling] ERROR: Scheduler assigned to blocked cancelled slot, rejecting:', newAssignment.slotIndex);
          return null;
        } else if (assignedAppointment) {

        }
      }

      // Double-check: Cancelled slots in bucket are now blocked via advance appointments,
      // so the scheduler shouldn't assign to them. But verify just in case.
      if (hasExistingWalkIns && cancelledSlotsInBucket.has(newAssignment.slotIndex)) {
        // This shouldn't happen since we blocked them, but reject if it does
        console.error('[Walk-in Scheduling] ERROR: Scheduler assigned to blocked cancelled slot (double-check), rejecting:', newAssignment.slotIndex);
        return null;
      }

      return { schedule, newAssignment, placeholderIds: new Set() };
    } catch {
      return null;
    }
  };

  // Pre-calculate occupied slots for use in allSlotsFilled and Strategy 4
  const occupiedSlots = new Set<number>();
  effectiveAppointments.forEach(appt => {
    if (
      typeof appt.slotIndex === 'number' &&
      ACTIVE_STATUSES.has(appt.status)
    ) {
      occupiedSlots.add(appt.slotIndex);
    }
  });

  // Check if all slots in availability (non-past, excluding cancelled slots in bucket) are filled
  const allSlotsFilled = (() => {
    // Check if all slots in availability (future slots only, excluding cancelled slots in bucket) are occupied


    // Check if all slots in availability (future slots only, excluding cancelled slots in bucket) are occupied
    const emptySlots: number[] = [];
    const futureSlotsCount: number[] = [];
    const cancelledInBucketSlots: number[] = [];

    for (let i = 0; i < slots.length; i++) {
      if (isBefore(slots[i].time, now)) {
        continue; // Skip past slots
      }
      futureSlotsCount.push(i);
      // Skip cancelled slots in bucket - they're blocked, not available
      if (hasExistingWalkIns && cancelledSlotsInBucket.has(i)) {
        cancelledInBucketSlots.push(i);
        continue; // Skip cancelled slots in bucket
      }
      if (!occupiedSlots.has(i)) {
        emptySlots.push(i); // Found an empty slot
      }
    }

    const isAllSlotsFilled = emptySlots.length === 0;

    // DEBUG: Log allSlotsFilled calculation details
    console.info('[Walk-in Scheduling] DEBUG - allSlotsFilled Calculation:', {
      futureSlotsTotal: futureSlotsCount.length,
      futureSlots: futureSlotsCount,
      cancelledInBucketSlotsTotal: cancelledInBucketSlots.length,
      cancelledInBucketSlots: cancelledInBucketSlots,
      emptySlotsTotal: emptySlots.length,
      emptySlots: emptySlots,
      occupiedSlotsTotal: occupiedSlots.size,
      occupiedSlots: Array.from(occupiedSlots).sort((a, b) => a - b),
      allSlotsFilled: isAllSlotsFilled,
    });

    return isAllSlotsFilled; // All available future slots are occupied
  })();

  let scheduleAttempt: ScheduleAttemptResult | null = null;
  let usedCancelledSlot: number | null = null;
  let usedBucket = false;
  let usedBucketSlotIndex: number | null = null;
  let bucketReservationRef: DocumentReference | null = null;

  // Strategy 1: If no walk-ins exist and cancelled slot in window, use it directly
  if (!hasExistingWalkIns && cancelledSlotsInWindow.length > 0) {
    // Sort by slotIndex (earliest first)
    cancelledSlotsInWindow.sort((a, b) => a.slotIndex - b.slotIndex);
    const earliestCancelledSlot = cancelledSlotsInWindow[0];
    scheduleAttempt = attemptSchedule(earliestCancelledSlot.slotIndex);
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
    if (scheduleAttempt) {
      usedCancelledSlot = earliestAvailableCancelledSlot.slotIndex;
    }
  }

  // Strategy 3: Try normal scheduling
  if (!scheduleAttempt) {
    console.info('[Walk-in Scheduling] DEBUG - Attempting Strategy 3 (Normal Scheduling)');
    scheduleAttempt = attemptSchedule(null);

    // Check if scheduler assigned to a cancelled slot in bucket (shouldn't happen, but reject if it does)
    if (scheduleAttempt && hasExistingWalkIns && cancelledSlotsInBucket.has(scheduleAttempt.newAssignment.slotIndex)) {
      // Reject - this slot is in the bucket, shouldn't be used by walk-ins
      console.info('[Walk-in Scheduling] DEBUG - Strategy 3 rejected - slot is in bucket');
      scheduleAttempt = null;
    }

    if (scheduleAttempt) {
      console.info('[Walk-in Scheduling] DEBUG - Strategy 3 SUCCESS - Normal scheduling worked', {
        slotIndex: scheduleAttempt.newAssignment.slotIndex,
      });
    } else {
      console.info('[Walk-in Scheduling] DEBUG - Strategy 3 FAILED - Normal scheduling did not work');
    }
  }

  // Strategy 4: If normal scheduling fails and all slots are filled, check bucket count
  // Bucket count is calculated on-the-fly, so we can use it directly

  // DEBUG: Log all conditions before Strategy 4 check
  console.info('[Walk-in Scheduling] DEBUG - Strategy 4 Pre-Check:', {
    scheduleAttempt: !!scheduleAttempt,
    allSlotsFilled,
    hasExistingWalkIns,
    activeWalkInsCount: activeWalkIns.length,
    firestoreBucketCount,
    bucketCount,
    usedBucketSlots,
    totalSlots: slots.length,
    occupiedSlotsCount: effectiveAppointments.filter(a =>
      typeof a.slotIndex === 'number' &&
      ACTIVE_STATUSES.has(a.status)
    ).length,
    cancelledNoShowCount: effectiveAppointments.filter(a =>
      (a.status === 'Cancelled' || a.status === 'No-show')
    ).length,
    willTriggerBucketCompensation: !scheduleAttempt && allSlotsFilled && (hasExistingWalkIns || firestoreBucketCount > 0) && firestoreBucketCount > 0,
  });

  // DEBUG: Log why Strategy 4 might NOT trigger
  if (!scheduleAttempt && (!allSlotsFilled || (!hasExistingWalkIns && firestoreBucketCount <= 0) || firestoreBucketCount <= 0)) {
    console.info('[Walk-in Scheduling] DEBUG - ❌ Strategy 4 NOT Triggered - Reasons:', {
      scheduleAttemptExists: !!scheduleAttempt,
      allSlotsFilled,
      hasExistingWalkIns,
      firestoreBucketCount,
      reason: !allSlotsFilled ? 'allSlotsFilled is false' :
        !hasExistingWalkIns && firestoreBucketCount <= 0 ? 'hasExistingWalkIns is false AND firestoreBucketCount <= 0' :
          firestoreBucketCount <= 0 ? `firestoreBucketCount (${firestoreBucketCount}) <= 0` :
            'unknown',
    });
  }

  // Strategy 4: Trigger if all slots are filled AND (has existing walk-ins OR has cancelled/no-show slots for bucket)
  // This allows bucket compensation even when there are no walk-ins yet, as long as there are cancelled/no-show slots
  // FORCE BOOKING: Always trigger Strategy 4 if isForceBooked is true
  if (isForceBooked || (!scheduleAttempt && allSlotsFilled && (hasExistingWalkIns || firestoreBucketCount > 0) && firestoreBucketCount > 0)) {
    console.info('[Walk-in Scheduling] DEBUG - ✅ Strategy 4 TRIGGERED - Bucket Compensation Starting');

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
    // FORCE BOOKING: Bypass this check if force booked
    if (!isForceBooked && effectiveBucketCountInTx <= 0) {
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

    // CRITICAL: Ensure the calculated slot is NOT already occupied
    // Use the occupiedSlots set calculated earlier in the transaction
    while (occupiedSlots.has(newSlotIndex)) {
      console.warn(`[Walk-in Scheduling] Strategy 4: Calculated slotIndex ${newSlotIndex} is already occupied, trying next...`);
      newSlotIndex++;
    }


    // CRITICAL: Check if this slotIndex is already reserved or occupied by another concurrent request
    // Use the reservation snapshot we already read BEFORE any writes
    let currentBucketReservationSnapshot: DocumentSnapshot | null = null;
    if (potentialBucketSlotIndex === newSlotIndex && potentialBucketReservationRef && potentialBucketReservationSnapshot) {
      // Use the reservation we already read
      currentBucketReservationSnapshot = potentialBucketReservationSnapshot;
      bucketReservationRef = potentialBucketReservationRef;
    } else {
      // If the calculated slotIndex differs from what we pre-read, we can't read it now
      // (would violate Firestore transaction rules). Create a new ref anyway - we can still write to it.
      // Conflicts will be detected via effectiveAppointments check and on retry if another transaction
      // also tries to create the same reservation.
      const bucketReservationId = buildReservationDocId(clinicId, doctorName, dateStr, newSlotIndex);
      bucketReservationRef = doc(firestore, 'slot-reservations', bucketReservationId);
      currentBucketReservationSnapshot = null; // We didn't read it, so we don't have a snapshot
    }

    // Check if there's already an appointment at this slotIndex
    const existingAppointmentAtSlot = effectiveAppointments.find(
      apt => typeof apt.slotIndex === 'number' && apt.slotIndex === newSlotIndex && ACTIVE_STATUSES.has(apt.status)
    );

    // Check reservation if we have a snapshot (pre-read case)
    const hasReservation = currentBucketReservationSnapshot && currentBucketReservationSnapshot.exists();

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

    // Note: Reservation for the new slot will be created by the caller to ensure atomicity
    // with other updates and avoid side-effects in this helper function.


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
    return {
      newAssignment: null,
      reservationDeletes: [],
      appointmentUpdates: [],
      updatedAdvanceAppointments: activeAdvanceAppointments,
      usedBucketSlotIndex: null,
      existingReservations: new Map<number, Date>(),
    };
  }

  const { schedule, newAssignment, placeholderIds } = scheduleAttempt;

  const reservationDeletes = new Map<string, DocumentReference>();
  const appointmentUpdates: Array<{
    appointmentId: string;
    docRef: DocumentReference;
    slotIndex: number;
    sessionIndex: number;
    timeString: string;
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
      .filter(assignment => !placeholderIds.has(assignment.id))
      .map(assignment => assignment.slotIndex)
      .filter((index): index is number => typeof index === 'number' && index >= 0)
  );

  // CRITICAL: Don't read reservations here - it would violate "all reads before all writes" rule
  // If a slot is in reservedSlots, it means the scheduler assigned it, so we should clean up
  // any existing reservation for that slot. We'll delete it without reading first.
  for (const slotIndex of reservedSlots) {
    // CRITICAL: Skip the slot that we JUST assigned for the new walk-in
    // The main function will create a new reservation for it.
    if (newAssignment && slotIndex === newAssignment.slotIndex) {
      continue;
    }

    const reservationRef = doc(
      db,
      'slot-reservations',
      buildReservationDocId(clinicId, doctorName, dateStr, slotIndex)
    );
    // Add to delete list without reading - transaction.delete() is safe even if doc doesn't exist
    reservationDeletes.set(reservationRef.path, reservationRef);
  }

  // If bucket was used for an EXISTING slot, add it to cleanup list
  // Strategy 4 (overflow) should NOT be added to cleanup list as it's a NEW slot
  if (usedBucket && bucketReservationRef && (!usedBucketSlotIndex || usedBucketSlotIndex < totalSlots)) {
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
          previousAppointmentTime = parse(
            appointmentBeforeWalkIn.time,
            'hh:mm a',
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
    const isSlotOccupied =
      advanceOccupancy[walkInSlotIndex] !== null ||
      activeWalkIns.some(
        w => typeof w.slotIndex === 'number' && w.slotIndex === walkInSlotIndex
      );

    // Get appointments that need to be shifted (at or after walk-in slot)
    // Sort by original slotIndex to process them in order
    const appointmentsToShift = isSlotOccupied
      ? activeAdvanceAppointments
        .filter(appointment => {
          const currentSlotIndex =
            typeof appointment.slotIndex === 'number'
              ? appointment.slotIndex
              : -1;
          return currentSlotIndex >= walkInSlotIndex;
        })
        .sort((a, b) => {
          const aIdx =
            typeof a.slotIndex === 'number' ? a.slotIndex : -1;
          const bIdx =
            typeof b.slotIndex === 'number' ? b.slotIndex : -1;
          return aIdx - bIdx;
        })
      : []; // No shifting needed if slot is empty

    // Process appointments that need shifting (at or after walk-in slot)
    // CRITICAL: For W booking, increment slotIndex by 1 and recalculate time
    // IMPORTANT: We only shift if the slot is occupied - empty slots don't need shifting
    for (const appointment of appointmentsToShift) {
      const currentSlotIndex =
        typeof appointment.slotIndex === 'number' ? appointment.slotIndex : -1;
      if (currentSlotIndex < 0) continue; // Skip invalid slot indices

      // CRITICAL: Increment slotIndex by 1 for each appointment being shifted
      const newSlotIndex = currentSlotIndex + 1;

      // Validate that newSlotIndex is within bounds
      if (newSlotIndex >= totalSlots) {
        console.warn(
          `[BOOKING DEBUG] Cannot shift appointment ${appointment.id} from slot ${currentSlotIndex} to ${newSlotIndex} - exceeds total slots ${totalSlots}`
        );
        continue;
      }

      // CRITICAL: Calculate new time from appointment's current time field + averageConsultingTime
      // Parse the appointment's current time field and add averageConsultingTime to it
      let newAppointmentTime: Date;
      if (appointment.time) {
        try {
          const appointmentDate = parse(dateStr, 'd MMMM yyyy', new Date());
          const currentAppointmentTime = parse(
            appointment.time,
            'hh:mm a',
            appointmentDate
          );
          // New time = current time + averageConsultingTime
          newAppointmentTime = addMinutes(
            currentAppointmentTime,
            averageConsultingTime
          );
        } catch (e) {
          console.warn(
            `[BOOKING DEBUG] Failed to parse appointment time "${appointment.time}" for appointment ${appointment.id}, skipping time update`
          );
          continue;
        }
      } else {
        console.warn(
          `[BOOKING DEBUG] Appointment ${appointment.id} has no time field, skipping time update`
        );
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
          } else if (
            typeof appointment.noShowTime === 'object' &&
            appointment.noShowTime !== null
          ) {
            const noShowTimeObj = appointment.noShowTime as {
              toDate?: () => Date;
              seconds?: number;
            };
            if (typeof noShowTimeObj.toDate === 'function') {
              currentNoShowTime = noShowTimeObj.toDate();
            } else if (typeof noShowTimeObj.seconds === 'number') {
              currentNoShowTime = new Date(noShowTimeObj.seconds * 1000);
            } else {
              // Fallback to using new appointment time + averageConsultingTime
              currentNoShowTime = addMinutes(
                newAppointmentTime,
                averageConsultingTime
              );
            }
          } else {
            // Fallback to using new appointment time + averageConsultingTime
            currentNoShowTime = addMinutes(
              newAppointmentTime,
              averageConsultingTime
            );
          }
          // New noShowTime = current noShowTime + averageConsultingTime
          noShowTime = addMinutes(
            currentNoShowTime,
            averageConsultingTime
          );
        } catch (e) {
          // If parsing fails, use new appointment time + averageConsultingTime
          noShowTime = addMinutes(
            newAppointmentTime,
            averageConsultingTime
          );
        }
      } else {
        // No noShowTime available, use new appointment time + averageConsultingTime
        noShowTime = addMinutes(
          newAppointmentTime,
          averageConsultingTime
        );
      }

      // Find the sessionIndex for the new slotIndex
      const newSlotMeta = slots[newSlotIndex];
      if (!newSlotMeta) {
        console.warn(
          `[BOOKING DEBUG] Slot ${newSlotIndex} does not exist in slots array, skipping appointment ${appointment.id}`
        );
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
        appointmentId: appointment.id,
        docRef: appointmentRef,
        slotIndex: newSlotIndex,
        sessionIndex: newSessionIndex,
        timeString: newTimeString,
        noShowTime,
      });

      console.info(`[BOOKING DEBUG] Updating appointment ${appointment.id}`, {
        slotIndexChanged,
        timeChanged,
        oldSlotIndex: currentSlotIndex,
        newSlotIndex,
        oldTime: appointment.time,
        newTime: newTimeString,
      });

      const cloned = updatedAdvanceMap.get(appointment.id);
      if (cloned) {
        cloned.slotIndex = newSlotIndex;
        cloned.sessionIndex = newSessionIndex;
        cloned.time = newTimeString;
        cloned.noShowTime = noShowTime;
      }
    }

    // Handle appointments that are NOT being shifted (before walk-in slot)
    // These should use the scheduler's assignment time (if they moved)
    for (const appointment of activeAdvanceAppointments) {
      const currentSlotIndex =
        typeof appointment.slotIndex === 'number' ? appointment.slotIndex : -1;
      if (currentSlotIndex >= walkInSlotIndex) {
        continue; // Already handled above
      }

      const assignment = assignmentById.get(appointment.id);
      if (!assignment) continue;

      const newSlotIndex = assignment.slotIndex;
      const newTimeString = getClinicTimeString(assignment.slotTime);
      const noShowTime = addMinutes(
        assignment.slotTime,
        averageConsultingTime
      );

      if (
        currentSlotIndex === newSlotIndex &&
        appointment.time === newTimeString
      ) {
        continue;
      }

      const appointmentRef = doc(firestore, 'appointments', appointment.id);
      appointmentUpdates.push({
        appointmentId: appointment.id,
        docRef: appointmentRef,
        slotIndex: newSlotIndex,
        sessionIndex: assignment.sessionIndex,
        timeString: newTimeString,
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

  return {
    newAssignment,
    reservationDeletes: Array.from(reservationDeletes.values()),
    appointmentUpdates,
    updatedAdvanceAppointments: activeAdvanceAppointments.map(
      appointment => {
        return updatedAdvanceMap.get(appointment.id) ?? appointment;
      }
    ),
    usedBucketSlotIndex,
    existingReservations,
  };
};

export async function rebalanceWalkInSchedule(
  doctor: Doctor,
  clinicId: string,
  date: Date
): Promise<void> {
  const now = getClinicNow();
  const clinicSnap = await getDoc(doc(db, 'clinics', clinicId));
  const rawSpacing = clinicSnap.exists() ? Number(clinicSnap.data()?.walkInTokenAllotment ?? 0) : 0;
  const walkInSpacingValue = Number.isFinite(rawSpacing) && rawSpacing > 0 ? Math.floor(rawSpacing) : 0;

  const { slots } = await loadDoctorAndSlots(db, doctor.clinicId || '', doctor.name, date, doctor.id);
  const averageConsultingTime = doctor.averageConsultingTime || 15;
  const appointments = await fetchDayAppointments(doctor.clinicId || '', doctor.name, date);

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

  if (activeWalkIns.length === 0) {
    return;
  }

  // Calculate blocked slot indices due to leave
  const blockedIndices = getLeaveBlockedIndices(doctor, slots, date);

  if (DEBUG_BOOKING) {
    console.info('[nurse booking] rebalance start', {
      doctor: doctor.name,
      clinicId,
      date,
      walkInSpacingValue,
      activeAdvanceAppointments: activeAdvanceAppointments.map(a => ({ id: a.id, slotIndex: a.slotIndex })),
      activeWalkIns: activeWalkIns.map(w => ({ id: w.id, slotIndex: w.slotIndex })),
    });
  }

  await runTransaction(db, async transaction => {
    const advanceRefs = activeAdvanceAppointments.map(appointment => doc(db, 'appointments', appointment.id));
    const walkInRefs = activeWalkIns.map(appointment => doc(db, 'appointments', appointment.id));

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
      .filter(appointment => {
        return (
          appointment.bookedVia === 'Walk-in' &&
          typeof appointment.slotIndex === 'number' &&
          ACTIVE_STATUSES.has(appointment.status)
        );
      });

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
      now,
      walkInTokenAllotment: walkInSpacingValue,
      advanceAppointments: [
        ...freshAdvanceAppointments.map(entry => ({
          id: entry.id,
          slotIndex: typeof entry.slotIndex === 'number' ? entry.slotIndex : -1,
        })),
        ...blockedIndices.map(idx => ({
          id: `blocked-leave-${idx}`,
          slotIndex: idx
        }))
      ],
      walkInCandidates,
    });

    if (DEBUG_BOOKING) {
      console.info('[nurse booking] rebalance schedule', schedule.assignments);
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

      const appointmentRef = doc(db, 'appointments', appointment.id);
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
        console.info('[nurse booking] rebalance move', {
          appointmentId: appointment.id,
          fromSlot: currentSlotIndex,
          toSlot: newSlotIndex,
          time: newTimeString,
        });
      }

      const appointmentRef = doc(db, 'appointments', appointment.id);
      transaction.update(appointmentRef, {
        slotIndex: newSlotIndex,
        sessionIndex: assignment.sessionIndex,
        time: newTimeString,
        cutOffTime: subMinutes(assignment.slotTime, averageConsultingTime),
        noShowTime: addMinutes(assignment.slotTime, averageConsultingTime),
      });
    }
  });
}

export async function calculateWalkInDetails(
  doctor: Doctor,
  walkInTokenAllotment?: number,
  walkInCapacityThreshold: number = 0
): Promise<{
  estimatedTime: Date;
  patientsAhead: number;
  numericToken: number;
  slotIndex: number;
  sessionIndex: number;
  actualSlotTime: Date;
}> {
  const now = getClinicNow();
  const date = now;

  const { slots } = await loadDoctorAndSlots(
    db,
    doctor.clinicId || '',
    doctor.name,
    date,
    doctor.id
  );
  const appointments = await fetchDayAppointments(doctor.clinicId || '', doctor.name, date);

  // Unified simple placement rule:
  // - Treat any slot with an ACTIVE status (Pending, Confirmed, Skipped, Completed) as occupied.
  // - Cancelled or never-used slots are free.
  // - Choose the earliest free slot in the future; if none, the earliest free today.
  const occupiedSlots = new Set<number>();
  appointments.forEach(appt => {
    if (
      typeof appt.slotIndex === 'number' &&
      ACTIVE_STATUSES.has(appt.status)
    ) {
      occupiedSlots.add(appt.slotIndex);
    }
  });

  const futureFreeSlots: DailySlot[] = [];
  const allFreeSlots: DailySlot[] = [];
  for (const slot of slots) {
    if (!occupiedSlots.has(slot.index)) {
      allFreeSlots.push(slot);
      if (slot.time >= now) {
        futureFreeSlots.push(slot);
      }
    }
  }

  const chosenSlot =
    futureFreeSlots.sort((a, b) => a.time.getTime() - b.time.getTime())[0] ||
    allFreeSlots.sort((a, b) => a.time.getTime() - b.time.getTime())[0];

  if (!chosenSlot) {
    throw new Error('No walk-in slots are available at this time.');
  }

  const allActiveStatuses = new Set(['Pending', 'Confirmed', 'Skipped', 'Completed']);
  const patientsAhead = appointments.filter(appointment => {
    return (
      typeof appointment.slotIndex === 'number' &&
      appointment.slotIndex < chosenSlot.index &&
      allActiveStatuses.has(appointment.status)
    );
  }).length;

  // Numeric token: next after max existing W or slots length
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

  return {
    estimatedTime: chosenSlot.time,
    patientsAhead,
    numericToken,
    slotIndex: chosenSlot.index,
    sessionIndex: chosenSlot.sessionIndex,
    actualSlotTime: chosenSlot.time,
  };
}

export async function calculateSkippedTokenRejoinSlot(
  appointment: Appointment,
  activeAppointments: Appointment[],
  doctor: Doctor,
  _recurrence: number = 0,
  referenceDate: Date = getClinicNow()
): Promise<{ slotIndex: number; time: string; sessionIndex: number }> {
  const clinicId = appointment.clinicId || doctor.clinicId || '';
  const doctorName = appointment.doctor || doctor.name;
  const { slots } = await loadDoctorAndSlots(
    db,
    clinicId,
    doctorName,
    referenceDate,
    doctor.id ?? appointment.doctorId
  );

  const filteredAppointments = activeAppointments.filter(a => a.id !== appointment.id);
  const occupiedSlots = buildOccupiedSlotSet(filteredAppointments);
  const candidates = buildCandidateSlots('W', slots, referenceDate, occupiedSlots);

  const slotIndex = candidates[0] ?? slots[slots.length - 1].index;
  const slot = slots.find(s => s.index === slotIndex) ?? slots[slots.length - 1];

  return {
    slotIndex: slot.index,
    time: getClinicTimeString(slot.time),
    sessionIndex: slot.sessionIndex,
  };
}


/**
 * Shared comparison function for sorting appointments consistently across all apps.
 * Primary sort: scheduled time (ascending)
 * Secondary sort: skippedAt field (appointments that were skipped come FIRST)
 * Tertiary sort: numericToken (ascending)
 */
export function compareAppointments(a: Appointment, b: Appointment): number {
  try {
    const parseRes = (apt: Appointment) => {
      // Appointments can have different date formats, but 'd MMMM yyyy' is the standard in Kloqo
      const appointmentDate = parse(apt.date, 'd MMMM yyyy', new Date());
      return parseTimeString(apt.time, appointmentDate);
    };

    const timeA = parseRes(a);
    const timeB = parseRes(b);

    if (timeA.getTime() !== timeB.getTime()) {
      return timeA.getTime() - timeB.getTime();
    }

    // Tie-breaker: skippedAt field existence
    // Prioritize previously skipped tokens at the same time slot
    const isASkipped = !!a.skippedAt;
    const isBSkipped = !!b.skippedAt;

    if (isASkipped !== isBSkipped) {
      return isASkipped ? -1 : 1;
    }

    // Final tie-breaker: numericToken
    return (a.numericToken || 0) - (b.numericToken || 0);
  } catch (e) {
    // Fail-safe sorting
    return (a.numericToken || 0) - (b.numericToken || 0);
  }
}
