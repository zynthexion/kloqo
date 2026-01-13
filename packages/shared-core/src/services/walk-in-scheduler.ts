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
  // We always ensure at least 10 "virtual slots" beyond the current maximum 
  // occupied or nominal slot index to allow shifting logic to work in full sessions.
  if (orderedSlots.length > 0) {
    const lastSlot = orderedSlots[orderedSlots.length - 1];
    const maxOccupiedIndex = Math.max(lastSlot.index, maxInputSlotIndex);
    const avgDuration = slots.length > 1
      ? (slots[1].time.getTime() - slots[0].time.getTime()) / 60000
      : 15;

    for (let i = lastSlot.index + 1; i <= maxOccupiedIndex + 10; i++) {
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
    indexToPosition.set(Number(slot.index), position);
  });

  if (DEBUG) {
    console.log('[SCHEDULER DEBUG] Index Map:', Array.from(indexToPosition.entries()));
    console.log('[SCHEDULER DEBUG] Advance Apps Input:', advanceAppointments.map(a => ({ id: a.id, slotIndex: a.slotIndex })));
  }

  const spacing =
    Number.isFinite(walkInTokenAllotment) && walkInTokenAllotment > 0
      ? Math.floor(walkInTokenAllotment)
      : 0;

  const occupancy: (Occupant | null)[] = new Array(positionCount).fill(null);
  const overflowAdvance: { id: string; sourcePosition: number }[] = [];

  console.log('[SCHEDULER] Processing advance appointments:', {
    count: advanceAppointments.length,
    appointments: advanceAppointments.map(a => ({ id: a.id, slotIndex: a.slotIndex }))
  });

  advanceAppointments.forEach(entry => {
    // Robust lookup: ensure slotIndex is a number
    const slotIndex = Number(entry.slotIndex);
    const position = indexToPosition.get(slotIndex);

    console.log(`[SCHEDULER] Processing ${entry.id}: slotIndex=${slotIndex}, position=${position}`);

    if (typeof position === 'number') {
      if (occupancy[position] === null) {
        occupancy[position] = { type: 'A', id: entry.id };
        console.log(`[SCHEDULER] ✅ Assigned ${entry.id} to position ${position}`);
      } else {
        overflowAdvance.push({ id: entry.id, sourcePosition: position });
        console.log(`[SCHEDULER] ⚠️ Collision: ${entry.id} at position ${position} (occupied by ${occupancy[position]?.id})`);
      }
    } else {
      if (DEBUG) console.log(`[SCHEDULER DEBUG] Advance app ${entry.id} with slotIndex ${entry.slotIndex} has NO MATCHING POSITION in slots.`);
      console.log(`[SCHEDULER] ❌ DROPPED: ${entry.id} with slotIndex ${slotIndex} - NO MATCHING POSITION`);
      overflowAdvance.push({ id: entry.id, sourcePosition: -1 });
    }
  });

  if (DEBUG) {
    console.log('[SCHEDULER DEBUG] Initial Occupancy:', occupancy.map((o, i) => `${i}:${o?.type}-${o?.id}`));
  }

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
      let pos = anchorPosition + 1;
      pos < positionCount;
      pos += 1
    ) {
      const occupant = occupancy[pos];
      // Count ONLY shiftable (active) appointments for spacing.
      // We ignore __blocked_ (Completed/Skipped) and __break_ (Administrative).
      // This ensures we throttle based on the ACTIVE queue.
      if (occupant?.type === 'A' && occupant.id.startsWith('__shiftable_')) {
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
      let pos = anchorPosition + 1;
      pos < positionCount;
      pos += 1
    ) {
      const occupant = occupancy[pos];
      // Count ONLY shiftable (active) appointments for spacing
      if (occupant?.type === 'A' && occupant.id.startsWith('__shiftable_')) {
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
      if (occupancy[pos]?.type === 'A' && occupancy[pos]?.id.startsWith('__shiftable_')) {
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
        // Only return if it's a "true gap" (has later appointments)
        // Trailing empty slots should be handled by spacing logic or final fallback
        const hasLaterAppointment = occupancy.slice(pos + 1).some(o => o !== null);
        if (hasLaterAppointment) {
          return pos;
        }
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
        console.log('[SCHEDULER] makeSpace loop found null at:', pos);
        break;
      }
      if (occupant.type === 'W') {
        console.log('[SCHEDULER] makeSpace loop found W at:', pos);
        break;
      }
      if (occupant.type === 'A') {
        // CRITICAL FIX: If we hit a blocked appointment, we CANNOT shift this block.
        // We must skip this entire block and try finding space AFTER it.
        if (occupant.id.startsWith('__blocked_') || occupant.id.startsWith('__reserved_')) {
          console.log('[SCHEDULER] makeSpace loop found blocked at:', pos, occupant.id);
          if (blockPositions.length === 0) {
            console.log('[SCHEDULER] Candidate pos is blocked, recursing to:', pos + 1);
            return makeSpaceForWalkIn(pos + 1, isExistingWalkIn);
          }
          console.log('[SCHEDULER] Found block after shiftable items, breaking loop to execute shift.');
          break;
        }
        blockPositions.push(pos);
      }
    }
    console.log('[SCHEDULER] Block positions identified:', blockPositions);

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

    // CRITICAL FIX: Always fill empty slots first, regardless of spacing logic
    // Spacing logic should only apply when there are no empty slots available
    // This ensures walk-ins use available physical slots before creating overflow slots
    let spacingTargetPosition = -1;

    // 1. Calculate spacing target first
    // Note: anchorPosition and advanceAfterAnchor are already calculated above (lines 423-424)
    console.log('[SCHEDULER] Spacing logic prep:', {
      anchorPosition,
      advanceAfterAnchor,
      spacing,
      hasAdvanceAppointments: advanceAfterAnchor > 0
    });

    const hasAdvanceAppointments = advanceAfterAnchor > 0;
    const isSpacingActive = hasAdvanceAppointments && spacing > 0 && advanceAfterAnchor >= spacing;

    if (isSpacingActive) {
      const nthAdvancePosition = findNthAdvanceAfter(anchorPosition, spacing);
      console.log('[SCHEDULER] Found nth advance position:', { nth: spacing, position: nthAdvancePosition });
      if (nthAdvancePosition !== -1) {
        spacingTargetPosition = nthAdvancePosition + 1;
        console.log('[SCHEDULER] Spacing target calculated:', spacingTargetPosition);
      }
    } else if (hasAdvanceAppointments) {
      // Fallback to last advance position if not enough spacing interval
      const lastAdvancePosition = findLastAdvanceAfter(anchorPosition);
      // Only use this fallback if we haven't placed enough walk-ins yet? 
      // Actually, if we haven't reached spacing threshold, we should try to fill gaps first.
      console.log('[SCHEDULER] Using last advance position (fallback):', lastAdvancePosition);
      if (lastAdvancePosition !== -1) {
        // If we are strictly following spacing, we might want to wait? 
        // But usually we append to end if not enough advance apps.
        // Let's set it as a potential target
        spacingTargetPosition = lastAdvancePosition + 1;
      }
    }

    // 2. Check for empty slots, but prioritize spacing target if active
    console.log('[SCHEDULER] Checking for empty slots with target limit:', spacingTargetPosition);

    // Scan for empty slots
    let validationLimitPosition = positionCount;
    // If we have a spacing target, we only want to pick an empty slot if it's EARLIER or EQUAL to the target.
    // Picking a later empty slot (like pos 17 when target is 14) defeats the purpose of queue priority.
    if (spacingTargetPosition !== -1) {
      validationLimitPosition = spacingTargetPosition + 1; // Allow checking up to the target itself
    }

    for (let pos = effectiveFirstFuturePosition; pos < positionCount; pos += 1) {
      if (spacingTargetPosition !== -1 && pos > spacingTargetPosition) {
        // If we passed the spacing target, stop looking for empty slots.
        // We should enforce insertion at the spacing target instead.
        console.log(`[SCHEDULER] Stopped empty slot search at ${pos} (target: ${spacingTargetPosition})`);
        break;
      }

      const slotMeta = orderedSlots[pos];
      if (isAfter(slotMeta.time, oneHourFromNow)) {
        break;
      }
      if (isBefore(slotMeta.time, now)) {
        console.log(`[SCHEDULER] Skipping past slot ${pos}: ${slotMeta.time.toISOString()} vs Now: ${now.toISOString()}`);
        continue;
      }
      if (occupancy[pos] === null) {
        assignedPosition = pos;
        console.log('[SCHEDULER] Found acceptable empty slot:', assignedPosition);
        break;
      }
    }

    // 3. If no empty slot found (or empty slot was too far), use spacing target
    if (assignedPosition === null && spacingTargetPosition !== -1) {
      assignedPosition = null; // Ensure null to trigger makeSpace logic below
      // We will pass spacingTargetPosition to makeSpaceForWalkIn
    }


    if (assignedPosition !== null) {
      console.log('[SCHEDULER] Assigned to empty slot:', assignedPosition);
    } else {
      console.log('[SCHEDULER] No acceptable empty slots found, attempting spacing logic');
    }

    if (assignedPosition === null) {
      let targetPosition = spacingTargetPosition;

      // Re-run fallback logic if target is still -1
      if (targetPosition === -1) {
        targetPosition = findFirstEmptyPosition(effectiveFirstFuturePosition);
      }

      // Slot 0 fallback
      if (targetPosition === -1 && effectiveFirstFuturePosition === 0) {
        const slot0Empty = occupancy[0] === null;
        if (slot0Empty) {
          targetPosition = 0;
        }
      }

      const prepared = makeSpaceForWalkIn(
        targetPosition === -1 ? effectiveFirstFuturePosition : targetPosition,
        false
      );

      console.log('[SCHEDULER] makeSpaceForWalkIn result:', {
        targetPosition,
        preparedPosition: prepared.position,
        shiftsCount: prepared.shifts.length,
        shifts: prepared.shifts
      });

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
        console.log('[SCHEDULER] Assigned position set to:', assignedPosition);
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
      throw new Error('No walk-in slots are available.');
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

  // CRITICAL FIX: Add ALL appointments from occupancy to assignments map
  // Previously, only walk-ins were added via applyAssignment, but advance appointments
  // were only tracked in occupancy array and never added to assignments.
  console.log('[SCHEDULER] Adding occupancy appointments to assignments map...');
  occupancy.forEach((occupant, position) => {
    if (occupant && occupant.type === 'A' && !assignments.has(occupant.id)) {
      const slotMeta = orderedSlots[position];
      if (slotMeta) {
        assignments.set(occupant.id, {
          id: occupant.id,
          slotIndex: slotMeta.index,
          sessionIndex: slotMeta.sessionIndex,
          slotTime: slotMeta.time,
        });
        console.log(`[SCHEDULER] Added ${occupant.id} from occupancy[${position}] to assignments`);
      }
    }
  });

  // CRITICAL FIX: Ensure overflow/colliding appointments are included in assignments
  // so they are counted for "Patients Ahead" logic.
  // Collisions happen when multiple appointments map to the same slot (e.g. Breaks + Patients).
  // We assigns them to the same slot metadata.
  console.log('[SCHEDULER] Processing overflow appointments...', { overflowCount: overflowAdvance.length });
  overflowAdvance.forEach(item => {
    if (!assignments.has(item.id) && item.sourcePosition !== -1) {
      const slotMeta = orderedSlots[item.sourcePosition];
      if (slotMeta) {
        assignments.set(item.id, {
          id: item.id,
          slotIndex: slotMeta.index,
          sessionIndex: slotMeta.sessionIndex,
          slotTime: slotMeta.time,
        });
        console.log(`[SCHEDULER] Added ${item.id} from overflow to assignments`);
      }
    }
  });

  console.log('[SCHEDULER] Final assignments count:', assignments.size);

  if (DEBUG) {
    console.info('[walk-in scheduler] assignments complete', {
      assignments: Array.from(assignments.values()),
    });
  }
  return { assignments: Array.from(assignments.values()) };
}
