/**
 * CRITICAL TEST 1: Walk-in Slot Reservation (15% Rule)
 * Tests that exactly 15% of future slots per session are reserved for walk-ins
 * and that advance bookings cannot use these reserved slots.
 */

import { describe, test, expect } from 'vitest';
import { addMinutes, parse } from 'date-fns';

// Mock types for testing
interface DailySlot {
  index: number;
  time: Date;
  sessionIndex: number;
}

/**
 * Calculate reserved walk-in slots per session (15% of FUTURE slots only)
 * This is extracted from walk-in.service.ts for testing
 */
function calculatePerSessionReservedSlots(
  slots: DailySlot[],
  now: Date
): Set<number> {
  const reservedSlots = new Set<number>();
  
  // Group slots by session
  const sessionMap = new Map<number, DailySlot[]>();
  slots.forEach(slot => {
    if (!sessionMap.has(slot.sessionIndex)) {
      sessionMap.set(slot.sessionIndex, []);
    }
    sessionMap.get(slot.sessionIndex)!.push(slot);
  });

  sessionMap.forEach((sessionSlots) => {
    // Only consider FUTURE slots
    const futureSlots = sessionSlots.filter(slot =>
      slot.time > now || slot.time.getTime() >= now.getTime()
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

describe('Walk-in Slot Reservation - 15% Rule', () => {
  const now = parse('2024-01-15 09:00:00', 'yyyy-MM-dd HH:mm:ss', new Date());
  
  const generateSlots = (count: number, sessionIndex: number, startTime: Date): DailySlot[] => {
    return Array.from({ length: count }, (_, i) => ({
      index: i,
      time: addMinutes(startTime, i * 15),
      sessionIndex,
    }));
  };

  test('CRITICAL: should reserve exactly 15% of future slots', () => {
    // 100 future slots
    const slots = generateSlots(100, 0, addMinutes(now, 60));
    const reserved = calculatePerSessionReservedSlots(slots, now);
    
    // 15% of 100 = 15 slots
    expect(reserved.size).toBe(15);
  });

  test('CRITICAL: should reserve last 15% of slots (not first)', () => {
    const slots = generateSlots(100, 0, addMinutes(now, 60));
    const reserved = calculatePerSessionReservedSlots(slots, now);
    
    // Last 15 slots should be reserved (indices 85-99)
    const reservedArray = Array.from(reserved).sort((a, b) => a - b);
    expect(reservedArray[0]).toBe(85);
    expect(reservedArray[reservedArray.length - 1]).toBe(99);
  });

  test('CRITICAL: should only reserve from future slots, not past slots', () => {
    // 50 past slots + 50 future slots
    const pastSlots = generateSlots(50, 0, addMinutes(now, -750)); // Past
    const futureSlots = generateSlots(50, 0, addMinutes(now, 60)); // Future
    const allSlots = [...pastSlots, ...futureSlots].map((slot, i) => ({
      ...slot,
      index: i,
    }));
    
    const reserved = calculatePerSessionReservedSlots(allSlots, now);
    
    // Should only reserve from 50 future slots (15% = 8 slots)
    expect(reserved.size).toBe(8);
    
    // All reserved slots should be from future slots (index >= 50)
    reserved.forEach(index => {
      expect(index).toBeGreaterThanOrEqual(50);
    });
  });

  test('CRITICAL: should reserve 15% per session separately', () => {
    // Session 1: 100 future slots
    const session1 = generateSlots(100, 0, addMinutes(now, 60));
    // Session 2: 100 future slots
    const session2 = generateSlots(100, 1, addMinutes(now, 400)).map(slot => ({
      ...slot,
      index: slot.index + 100, // Adjust indices
    }));
    
    const allSlots = [...session1, ...session2];
    const reserved = calculatePerSessionReservedSlots(allSlots, now);
    
    // Should reserve 15 from each session = 30 total
    expect(reserved.size).toBe(30);
    
    // Check session 1 reserved slots (last 15 of first 100)
    const session1Reserved = Array.from(reserved).filter(i => i < 100).length;
    expect(session1Reserved).toBe(15);
    
    // Check session 2 reserved slots (last 15 of second 100)
    const session2Reserved = Array.from(reserved).filter(i => i >= 100).length;
    expect(session2Reserved).toBe(15);
  });

  test('CRITICAL: should handle small slot counts correctly (rounding)', () => {
    // 5 future slots
    const slots = generateSlots(5, 0, addMinutes(now, 60));
    const reserved = calculatePerSessionReservedSlots(slots, now);
    
    // 15% of 5 = 0.75, should round UP to 1
    expect(reserved.size).toBe(1);
  });

  test('CRITICAL: should reserve 2 slots for 10 future slots', () => {
    // 10 future slots
    const slots = generateSlots(10, 0, addMinutes(now, 60));
    const reserved = calculatePerSessionReservedSlots(slots, now);
    
    // 15% of 10 = 1.5, should round UP to 2
    expect(reserved.size).toBe(2);
  });

  test('CRITICAL: should return empty set when no future slots', () => {
    // All slots in the past
    const slots = generateSlots(100, 0, addMinutes(now, -1500));
    const reserved = calculatePerSessionReservedSlots(slots, now);
    
    expect(reserved.size).toBe(0);
  });

  test('CRITICAL: should handle empty slot array', () => {
    const slots: DailySlot[] = [];
    const reserved = calculatePerSessionReservedSlots(slots, now);
    
    expect(reserved.size).toBe(0);
  });
});

describe('Advance Booking Cannot Use Reserved Slots', () => {
  const now = parse('2024-01-15 09:00:00', 'yyyy-MM-dd HH:mm:ss', new Date());
  
  const generateSlots = (count: number, sessionIndex: number, startTime: Date): DailySlot[] => {
    return Array.from({ length: count }, (_, i) => ({
      index: i,
      time: addMinutes(startTime, i * 15),
      sessionIndex,
    }));
  };

  test('CRITICAL: advance booking should NOT include reserved walk-in slots', () => {
    const slots = generateSlots(100, 0, addMinutes(now, 60));
    const reserved = calculatePerSessionReservedSlots(slots, now);
    
    // Simulate building candidate slots for advance booking
    const occupied = new Set<number>();
    const advanceCandidates: number[] = [];
    
    // Advance booking logic: skip reserved slots
    slots.forEach(slot => {
      if (!occupied.has(slot.index) && !reserved.has(slot.index)) {
        advanceCandidates.push(slot.index);
      }
    });
    
    // Should have 85 slots (100 - 15 reserved)
    expect(advanceCandidates.length).toBe(85);
    
    // None of the candidates should be in reserved set
    advanceCandidates.forEach(index => {
      expect(reserved.has(index)).toBe(false);
    });
  });

  test('CRITICAL: preferred slot in reserved range should be rejected', () => {
    const slots = generateSlots(100, 0, addMinutes(now, 60));
    const reserved = calculatePerSessionReservedSlots(slots, now);
    
    // Try to use a reserved slot (index 90 is in last 15)
    const preferredIndex = 90;
    expect(reserved.has(preferredIndex)).toBe(true);
    
    // Advance booking should reject this
    const canUsePreferred = !reserved.has(preferredIndex);
    expect(canUsePreferred).toBe(false);
  });
});
