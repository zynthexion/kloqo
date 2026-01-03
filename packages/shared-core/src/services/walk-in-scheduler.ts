import { addMinutes, isAfter, isBefore } from 'date-fns';

export type SchedulerSlot = {
  index: number;
  time: Date;
  sessionIndex: number;
};

export type SchedulerAdvance = {
  id: string;
  slotIndex: number;
};

export type SchedulerWalkInCandidate = {
  id: string;
  numericToken: number;
  createdAt?: Date | null;
  currentSlotIndex?: number;
};

export type SchedulerAssignment = {
  id: string;
  slotIndex: number;
  sessionIndex: number;
  slotTime: Date;
};

type SchedulerInput = {
  slots: SchedulerSlot[];
  now: Date;
  walkInTokenAllotment: number;
  advanceAppointments: SchedulerAdvance[];
  walkInCandidates: SchedulerWalkInCandidate[];
};

type SchedulerOutput = {
  assignments: SchedulerAssignment[];
};

type Occupant = {
  type: 'A' | 'W';
  id: string;
};

type AdvanceShift = {
  id: string;
  position: number;
};

export function computeWalkInSchedule({
  slots,
  now,
  walkInTokenAllotment,
  advanceAppointments,
  walkInCandidates,
}: SchedulerInput): SchedulerOutput {
  const DEBUG = process.env.NEXT_PUBLIC_DEBUG_WALK_IN === 'true';
  if (DEBUG) {
    console.info('[walk-in scheduler] start', {
      slots: slots.length,
      walkInTokenAllotment,
      now,
      advanceAppointments,
      walkInCandidates,
    });
  }
  // Determine the maximum slotIndex we need to consider
  const maxInputSlotIndex = Math.max(
    ...slots.map(s => s.index),
    ...advanceAppointments.map(a => a.slotIndex),
    ...walkInCandidates.map(w => w.currentSlotIndex || -1),
    -1
  );

  const orderedSlots = [...slots].sort((a, b) => a.index - b.index);

  // CRITICAL SURGICAL FIX: Synthesize "virtual slots" for overflow indices 
  // so the scheduler's occupancy map and shifting logic see them.
  if (orderedSlots.length > 0 && maxInputSlotIndex >= orderedSlots.length) {
    const lastSlot = orderedSlots[orderedSlots.length - 1];
    const avgDuration = slots.length > 1
      ? (slots[1].time.getTime() - slots[0].time.getTime()) / 60000
      : 15;

    for (let i = lastSlot.index + 1; i <= maxInputSlotIndex + 5; i++) {
      orderedSlots.push({
        index: i,
        time: addMinutes(lastSlot.time, (i - lastSlot.index) * avgDuration),
        sessionIndex: lastSlot.sessionIndex
      });
    }
  }

  const positionCount = orderedSlots.length;
  if (positionCount === 0 || walkInCandidates.length === 0) {
    return { assignments: [] };
  }

  const indexToPosition = new Map<number, number>();
  orderedSlots.forEach((slot, position) => {
    indexToPosition.set(slot.index, position);
  });

  const spacing =
    Number.isFinite(walkInTokenAllotment) && walkInTokenAllotment > 0
      ? Math.floor(walkInTokenAllotment)
      : 0;

  const occupancy: (Occupant | null)[] = new Array(positionCount).fill(null);
  const overflowAdvance: { id: string; sourcePosition: number }[] = [];
  advanceAppointments.forEach(entry => {
    const position = indexToPosition.get(entry.slotIndex);
    if (typeof position === 'number') {
      if (occupancy[position] === null) {
        occupancy[position] = { type: 'A', id: entry.id };
      } else {
        overflowAdvance.push({ id: entry.id, sourcePosition: position });
      }
    } else {
      overflowAdvance.push({ id: entry.id, sourcePosition: -1 });
    }
  });

  const sortedWalkIns = [...walkInCandidates].sort((a, b) => {
    if (a.numericToken !== b.numericToken) {
      return a.numericToken - b.numericToken;
    }
    const timeA = a.createdAt ? a.createdAt.valueOf() : 0;
    const timeB = b.createdAt ? b.createdAt.valueOf() : 0;
    return timeA - timeB;
  });

  const oneHourFromNow = addMinutes(now, 60);
  const firstFuturePosition = orderedSlots.findIndex(slot => !isBefore(slot.time, now));
  const effectiveFirstFuturePosition = firstFuturePosition === -1 ? positionCount : firstFuturePosition;

  const assignments = new Map<string, SchedulerAssignment>();
  const preferredPositions = new Map<string, number>();

  walkInCandidates.forEach(candidate => {
    if (typeof candidate.currentSlotIndex === 'number') {
      const position = indexToPosition.get(candidate.currentSlotIndex);
      if (typeof position === 'number') {
        preferredPositions.set(candidate.id, position);
      }
    }
  });

  const applyAssignment = (id: string, position: number) => {
    const slotMeta = orderedSlots[position];
    assignments.set(id, {
      id,
      slotIndex: slotMeta.index,
      sessionIndex: slotMeta.sessionIndex,
      slotTime: slotMeta.time,
    });
  };

  const getLastWalkInPosition = (): number => {
    for (let pos = positionCount - 1; pos >= 0; pos -= 1) {
      if (occupancy[pos]?.type === 'W') {
        return pos;
      }
    }
    return -1;
  };

  const countAdvanceAfter = (anchorPosition: number): number => {
    let count = 0;
    for (
      let pos = Math.max(anchorPosition + 1, effectiveFirstFuturePosition);
      pos < positionCount;
      pos += 1
    ) {
      const occupant = occupancy[pos];
      // Count only advance appointments, exclude blocked appointments (skipped/cancelled)
      // Blocked appointments have IDs starting with '__blocked_'
      if (occupant?.type === 'A' && !occupant.id.startsWith('__blocked_')) {
        count += 1;
      }
    }
    return count;
  };

  const findNthAdvanceAfter = (anchorPosition: number, nth: number): number => {
    if (nth <= 0) {
      return -1;
    }
    let count = 0;
    for (
      let pos = Math.max(anchorPosition + 1, effectiveFirstFuturePosition);
      pos < positionCount;
      pos += 1
    ) {
      const occupant = occupancy[pos];
      // Count only advance appointments, exclude blocked appointments (skipped/cancelled)
      // Blocked appointments have IDs starting with '__blocked_'
      if (occupant?.type === 'A' && !occupant.id.startsWith('__blocked_')) {
        count += 1;
        if (count === nth) {
          return pos;
        }
      }
    }
    return -1;
  };

  const findLastAdvanceAfter = (anchorPosition: number): number => {
    for (let pos = positionCount - 1; pos > anchorPosition; pos -= 1) {
      if (occupancy[pos]?.type === 'A' && !isBefore(orderedSlots[pos].time, now)) {
        return pos;
      }
    }
    return -1;
  };

  const findFirstEmptyPosition = (startPosition: number): number => {
    for (
      let pos = Math.max(startPosition, effectiveFirstFuturePosition);
      pos < positionCount;
      pos += 1
    ) {
      if (occupancy[pos] !== null) {
        continue;
      }
      if (isBefore(orderedSlots[pos].time, now)) {
        continue;
      }
      return pos;
    }
    return -1;
  };

  const findEarliestWindowEmptyPosition = (): number => {
    for (
      let pos = Math.max(effectiveFirstFuturePosition, 0);
      pos < positionCount;
      pos += 1
    ) {
      const slotMeta = orderedSlots[pos];
      if (isBefore(slotMeta.time, now)) {
        continue;
      }
      if (isAfter(slotMeta.time, oneHourFromNow)) {
        break;
      }
      if (occupancy[pos] === null) {
        return pos;
      }
    }
    return -1;
  };

  if (overflowAdvance.length > 0) {
    const sortedOverflow = [...overflowAdvance].sort(
      (a, b) => a.sourcePosition - b.sourcePosition
    );
    for (const entry of sortedOverflow) {
      const startPosition =
        entry.sourcePosition >= 0
          ? Math.max(entry.sourcePosition + 1, effectiveFirstFuturePosition)
          : effectiveFirstFuturePosition;
      let emptyPosition = findFirstEmptyPosition(startPosition);
      if (emptyPosition === -1) {
        emptyPosition = findFirstEmptyPosition(effectiveFirstFuturePosition);
      }
      if (emptyPosition === -1) {
        continue;
      }

      occupancy[emptyPosition] = { type: 'A', id: entry.id };
      applyAssignment(entry.id, emptyPosition);
    }
  }

  const makeSpaceForWalkIn = (
    targetPosition: number,
    isExistingWalkIn: boolean
  ): { position: number; shifts: AdvanceShift[] } => {
    let candidatePosition = targetPosition;
    if (candidatePosition < effectiveFirstFuturePosition) {
      candidatePosition = effectiveFirstFuturePosition;
    }
    while (
      candidatePosition < positionCount &&
      (
        occupancy[candidatePosition]?.type === 'W' ||
        (occupancy[candidatePosition]?.type === 'A' &&
          (occupancy[candidatePosition]?.id.startsWith('__reserved_') ||
            occupancy[candidatePosition]?.id.startsWith('__blocked_')))
      )
    ) {
      candidatePosition += 1;
    }
    if (candidatePosition >= positionCount) {
      return { position: -1, shifts: [] };
    }

    const occupantAtCandidate = occupancy[candidatePosition];
    if (occupantAtCandidate === null) {
      return { position: candidatePosition, shifts: [] };
    }

    const contiguousBlock: { id: string }[] = [];
    for (let pos = candidatePosition; pos < positionCount; pos += 1) {
      const occupant = occupancy[pos];
      if (occupant?.type === 'A') {
        contiguousBlock.push({ id: occupant.id });
        continue;
      }

      if (occupant === null) {
        break;
      }

      if (occupant?.type === 'W') {
        break;
      }
    }

    if (contiguousBlock.length === 0) {
      return { position: candidatePosition, shifts: [] };
    }

    const blockPositions: number[] = [];
    for (let pos = candidatePosition; pos < positionCount; pos += 1) {
      const occupant = occupancy[pos];
      if (occupant === null) {
        break;
      }
      if (occupant.type === 'W') {
        break;
      }
      if (occupant.type === 'A') {
        // CRITICAL FIX: If we hit a blocked appointment, we CANNOT shift this block.
        // We must skip this entire block and try finding space AFTER it.
        // This prevents BreakBlocks and Completed appointments from being moved.
        if (occupant.id.startsWith('__blocked_') || occupant.id.startsWith('__reserved_')) {
          return makeSpaceForWalkIn(pos + 1, isExistingWalkIn);
        }
        blockPositions.push(pos);
      }
    }

    if (blockPositions.length === 0) {
      return { position: candidatePosition, shifts: [] };
    }

    const tailPosition = blockPositions[blockPositions.length - 1];
    let emptyPosition = findFirstEmptyPosition(tailPosition + 1);
    if (emptyPosition === -1) {
      return { position: -1, shifts: [] };
    }

    const shifts: AdvanceShift[] = [];

    for (let index = blockPositions.length - 1; index >= 0; index -= 1) {
      const fromPosition = blockPositions[index];
      const occupant = occupancy[fromPosition];
      if (!occupant || occupant.type !== 'A') {
        continue;
      }

      if (emptyPosition <= fromPosition) {
        emptyPosition = findFirstEmptyPosition(fromPosition + 1);
        if (emptyPosition === -1) {
          return { position: -1, shifts: [] };
        }
      }

      occupancy[fromPosition] = null;
      occupancy[emptyPosition] = { type: 'A', id: occupant.id };
      shifts.push({ id: occupant.id, position: emptyPosition });
      emptyPosition = fromPosition;
    }

    shifts.reverse();

    return { position: candidatePosition, shifts };
  };

  for (const candidate of sortedWalkIns) {
    let assignedPosition: number | null = null;

    const preferredPosition = preferredPositions.get(candidate.id);

    // Check if interval logic should be enforced BEFORE bubble logic
    // This ensures interval logic takes precedence over bubbling into 1-hour window
    const anchorPosition = getLastWalkInPosition();
    const advanceAfterAnchor = countAdvanceAfter(anchorPosition);
    const shouldEnforceInterval = spacing > 0 && advanceAfterAnchor > 0;

    const earliestWindowPosition = findEarliestWindowEmptyPosition();
    const preferredThreshold =
      typeof preferredPosition === 'number' ? preferredPosition : Number.POSITIVE_INFINITY;

    // Always allow bubbling into 1-hour window if a slot is available
    // We prioritize filling gaps (cancellations) over enforcing spacing rules
    // to avoid unnecessary "Force Book" prompts (overflows).
    if (
      earliestWindowPosition !== -1 &&
      earliestWindowPosition < preferredThreshold
    ) {
      const prepared = makeSpaceForWalkIn(earliestWindowPosition, true);
      if (prepared.position !== -1) {
        prepared.shifts.forEach(shift => {
          applyAssignment(shift.id, shift.position);
        });
        occupancy[prepared.position] = { type: 'W', id: candidate.id };
        applyAssignment(candidate.id, prepared.position);
        if (DEBUG) {
          console.info('[walk-in scheduler] bubbled walk-in into 1-hour window', {
            candidateId: candidate.id,
            position: prepared.position,
          });
        }
        continue;
      }
    }

    if (typeof preferredPosition === 'number') {
      const anchorPosition = getLastWalkInPosition();
      if (anchorPosition !== -1) {
        const sequentialPosition = findFirstEmptyPosition(anchorPosition + 1);
        if (
          sequentialPosition !== -1 &&
          sequentialPosition < preferredPosition
        ) {
          const prepared = makeSpaceForWalkIn(sequentialPosition, true);
          if (prepared.position !== -1) {
            prepared.shifts.forEach(shift => {
              applyAssignment(shift.id, shift.position);
            });
            occupancy[prepared.position] = { type: 'W', id: candidate.id };
            applyAssignment(candidate.id, prepared.position);
            if (DEBUG) {
              console.info('[walk-in scheduler] tightened walk-in sequence', {
                candidateId: candidate.id,
                position: prepared.position,
              });
            }
            continue;
          }
        }
      }
    }

    if (DEBUG) {
      console.info('[walk-in scheduler] processing walk-in', {
        candidate,
        preferredPosition,
      });
    }
    if (typeof preferredPosition === 'number') {
      const prepared = makeSpaceForWalkIn(preferredPosition, true);
      if (prepared.position !== -1) {
        prepared.shifts.forEach(shift => {
          applyAssignment(shift.id, shift.position);
        });
        occupancy[prepared.position] = { type: 'W', id: candidate.id };
        applyAssignment(candidate.id, prepared.position);
        if (DEBUG) {
          console.info('[walk-in scheduler] placed existing walk-in', {
            candidateId: candidate.id,
            position: prepared.position,
          });
        }
        continue;
      }
    }

    // Check if interval logic should be enforced before filling empty slots
    // Note: shouldEnforceInterval was already calculated above for bubble logic check
    // This ensures interval logic works the same way before and after consultation starts

    // Only fill empty slots if interval logic shouldn't be enforced
    // (e.g., no spacing configured or no advance appointments available)
    if (!shouldEnforceInterval) {
      for (let pos = effectiveFirstFuturePosition; pos < positionCount; pos += 1) {
        const slotMeta = orderedSlots[pos];
        if (isAfter(slotMeta.time, oneHourFromNow)) {
          break;
        }
        if (isBefore(slotMeta.time, now)) {
          continue;
        }
        if (occupancy[pos] === null) {
          assignedPosition = pos;
          break;
        }
      }
    }

    if (assignedPosition === null) {
      const anchorPosition = getLastWalkInPosition();
      let targetPosition = -1;

      const advanceAfterAnchor = countAdvanceAfter(anchorPosition);

      // CRITICAL FIX: Only apply spacing logic if there are advance appointments
      // In walk-in-only scenarios, place walk-ins sequentially without spacing
      const hasAdvanceAppointments = advanceAfterAnchor > 0;

      if (hasAdvanceAppointments && spacing > 0 && advanceAfterAnchor >= spacing) {
        const nthAdvancePosition = findNthAdvanceAfter(anchorPosition, spacing);
        if (nthAdvancePosition !== -1) {
          targetPosition = nthAdvancePosition + 1;
        }
      }

      if (targetPosition === -1 && hasAdvanceAppointments) {
        const lastAdvancePosition = findLastAdvanceAfter(anchorPosition);
        if (lastAdvancePosition !== -1) {
          targetPosition = lastAdvancePosition + 1;
        }
      }

      if (targetPosition === -1) {
        targetPosition = findFirstEmptyPosition(effectiveFirstFuturePosition);
      }

      // CRITICAL: Don't fall back to slot 0 if all slots are filled
      // This prevents incorrect slot 0 assignment when all slots are occupied
      // Only try slot 0 if we haven't found a position and effectiveFirstFuturePosition is 0
      if (targetPosition === -1 && effectiveFirstFuturePosition === 0) {
        // Only try slot 0 if it's the first future position (meaning no past slots)
        const slot0Empty = occupancy[0] === null;
        if (slot0Empty) {
          targetPosition = 0;
        }
      }

      const prepared = makeSpaceForWalkIn(
        targetPosition === -1 ? effectiveFirstFuturePosition : targetPosition,
        false
      );
      if (prepared.position === -1) {
        // Proceed to fallback
      } else {
        prepared.shifts.forEach(shift => {
          applyAssignment(shift.id, shift.position);
          if (DEBUG) {
            console.info('[walk-in scheduler] shifted advance appointment', shift);
          }
        });
        assignedPosition = prepared.position;
      }
    }

    if (assignedPosition === null) {
      // FINAL FALLBACK: If spacing and bubble logic failed (e.g. wall of advance appointments at end of session)
      // just find ANY empty future slot.
      const anyEmptyFutureSlot = findFirstEmptyPosition(effectiveFirstFuturePosition);
      if (anyEmptyFutureSlot !== -1) {
        assignedPosition = anyEmptyFutureSlot;
      }
    }

    if (assignedPosition === null) {
      throw new Error('Unable to allocate walk-in slot.');
    }

    occupancy[assignedPosition] = { type: 'W', id: candidate.id };
    applyAssignment(candidate.id, assignedPosition);
    if (DEBUG) {
      console.info('[walk-in scheduler] placed walk-in', {
        candidateId: candidate.id,
        assignedPosition,
      });
    }
  }

  if (DEBUG) {
    console.info('[walk-in scheduler] assignments complete', {
      assignments: Array.from(assignments.values()),
    });
  }
  return { assignments: Array.from(assignments.values()) };
}
