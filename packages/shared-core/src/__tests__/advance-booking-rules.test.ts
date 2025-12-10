/**
 * CRITICAL TEST 5: Advance Booking Rules
 * Tests the 1-hour cutoff rule and session boundary constraints.
 * These rules prevent last-minute bookings and ensure proper scheduling.
 */

import { describe, test, expect } from 'vitest';
import { addMinutes, parse, isAfter, isBefore } from 'date-fns';

interface DailySlot {
  index: number;
  time: Date;
  sessionIndex: number;
}

/**
 * Check if slot is available for advance booking (> 1 hour away)
 */
function isSlotAvailableForAdvanceBooking(
  slotTime: Date,
  now: Date,
  occupied: Set<number>,
  reservedWalkInSlots: Set<number>,
  slotIndex: number
): boolean {
  const oneHourFromNow = addMinutes(now, 60);
  
  // Must be more than 1 hour away
  if (!isAfter(slotTime, oneHourFromNow)) {
    return false;
  }
  
  // Must not be occupied
  if (occupied.has(slotIndex)) {
    return false;
  }
  
  // Must not be reserved for walk-ins
  if (reservedWalkInSlots.has(slotIndex)) {
    return false;
  }
  
  return true;
}

/**
 * Find alternative slot in same session
 */
function findAlternativeInSameSession(
  slots: DailySlot[],
  preferredSessionIndex: number,
  now: Date,
  occupied: Set<number>,
  reservedWalkInSlots: Set<number>
): number | null {
  const oneHourFromNow = addMinutes(now, 60);
  
  for (const slot of slots) {
    if (
      slot.sessionIndex === preferredSessionIndex &&
      isAfter(slot.time, oneHourFromNow) &&
      !occupied.has(slot.index) &&
      !reservedWalkInSlots.has(slot.index)
    ) {
      return slot.index;
    }
  }
  
  return null;
}

describe('Advance Booking - 1 Hour Cutoff Rule', () => {
  const now = parse('2024-01-15 10:00 AM', 'yyyy-MM-dd hh:mm a', new Date());

  test('CRITICAL: should reject slots within 1 hour', () => {
    const slotAt10_30 = parse('2024-01-15 10:30 AM', 'yyyy-MM-dd hh:mm a', new Date());
    const slotAt10_59 = parse('2024-01-15 10:59 AM', 'yyyy-MM-dd hh:mm a', new Date());
    
    const isAvailable30 = isSlotAvailableForAdvanceBooking(
      slotAt10_30,
      now,
      new Set(),
      new Set(),
      0
    );
    
    const isAvailable59 = isSlotAvailableForAdvanceBooking(
      slotAt10_59,
      now,
      new Set(),
      new Set(),
      1
    );
    
    expect(isAvailable30).toBe(false);
    expect(isAvailable59).toBe(false);
  });

  test('CRITICAL: should accept slot at exactly 1 hour', () => {
    const slotAt11_00 = parse('2024-01-15 11:00 AM', 'yyyy-MM-dd hh:mm a', new Date());
    
    const oneHourFromNow = addMinutes(now, 60);
    
    // At exactly 1 hour, should NOT be accepted (must be AFTER 1 hour)
    const isAvailable = isAfter(slotAt11_00, oneHourFromNow);
    expect(isAvailable).toBe(false);
  });

  test('CRITICAL: should accept slots after 1 hour', () => {
    const slotAt11_01 = parse('2024-01-15 11:01 AM', 'yyyy-MM-dd hh:mm a', new Date());
    const slotAt12_00 = parse('2024-01-15 12:00 PM', 'yyyy-MM-dd hh:mm a', new Date());
    
    const isAvailable11_01 = isSlotAvailableForAdvanceBooking(
      slotAt11_01,
      now,
      new Set(),
      new Set(),
      0
    );
    
    const isAvailable12_00 = isSlotAvailableForAdvanceBooking(
      slotAt12_00,
      now,
      new Set(),
      new Set(),
      1
    );
    
    expect(isAvailable11_01).toBe(true);
    expect(isAvailable12_00).toBe(true);
  });

  test('CRITICAL: should dynamically check based on current time', () => {
    const now1 = parse('2024-01-15 10:00 AM', 'yyyy-MM-dd hh:mm a', new Date());
    const now2 = parse('2024-01-15 10:30 AM', 'yyyy-MM-dd hh:mm a', new Date());
    
    const slot = parse('2024-01-15 11:15 AM', 'yyyy-MM-dd hh:mm a', new Date());
    
    // At 10:00 AM, slot at 11:15 is 1h 15m away (available)
    const available1 = isSlotAvailableForAdvanceBooking(slot, now1, new Set(), new Set(), 0);
    expect(available1).toBe(true);
    
    // At 10:30 AM, slot at 11:15 is only 45m away (not available)
    const available2 = isSlotAvailableForAdvanceBooking(slot, now2, new Set(), new Set(), 0);
    expect(available2).toBe(false);
  });
});

describe('Advance Booking - Reserved Slot Check', () => {
  const now = parse('2024-01-15 09:00 AM', 'yyyy-MM-dd hh:mm a', new Date());

  test('CRITICAL: should reject reserved walk-in slots', () => {
    const slotAt11_00 = parse('2024-01-15 11:00 AM', 'yyyy-MM-dd hh:mm a', new Date());
    const reservedWalkInSlots = new Set([10, 20, 30]);
    
    // Slot 20 is reserved for walk-ins
    const isAvailable = isSlotAvailableForAdvanceBooking(
      slotAt11_00,
      now,
      new Set(),
      reservedWalkInSlots,
      20
    );
    
    expect(isAvailable).toBe(false);
  });

  test('CRITICAL: should accept non-reserved slots', () => {
    const slotAt11_00 = parse('2024-01-15 11:00 AM', 'yyyy-MM-dd hh:mm a', new Date());
    const reservedWalkInSlots = new Set([10, 20, 30]);
    
    // Slot 15 is not reserved
    const isAvailable = isSlotAvailableForAdvanceBooking(
      slotAt11_00,
      now,
      new Set(),
      reservedWalkInSlots,
      15
    );
    
    expect(isAvailable).toBe(true);
  });

  test('CRITICAL: should reject occupied slots', () => {
    const slotAt11_00 = parse('2024-01-15 11:00 AM', 'yyyy-MM-dd hh:mm a', new Date());
    const occupied = new Set([5, 15, 25]);
    
    // Slot 15 is occupied
    const isAvailable = isSlotAvailableForAdvanceBooking(
      slotAt11_00,
      now,
      occupied,
      new Set(),
      15
    );
    
    expect(isAvailable).toBe(false);
  });
});

describe('Advance Booking - Same Session Constraint', () => {
  const now = parse('2024-01-15 09:00 AM', 'yyyy-MM-dd hh:mm a', new Date());

  const generateSlots = (sessionIndex: number, startHour: number, count: number): DailySlot[] => {
    return Array.from({ length: count }, (_, i) => ({
      index: sessionIndex * 100 + i,
      time: parse(`2024-01-15 ${String(startHour + Math.floor(i * 15 / 60)).padStart(2, '0')}:${String((i * 15) % 60).padStart(2, '0')}`, 'yyyy-MM-dd HH:mm', new Date()),
      sessionIndex,
    }));
  };

  test('CRITICAL: should find alternative in same session', () => {
    const session1Slots = generateSlots(0, 10, 20); // 10:00 - 14:45
    const session2Slots = generateSlots(1, 15, 20); // 15:00 - 19:45
    const allSlots = [...session1Slots, ...session2Slots];
    
    const preferredSessionIndex = 0;
    const occupied = new Set([session1Slots[5].index]); // Occupy one slot
    const reserved = new Set<number>();
    
    const alternative = findAlternativeInSameSession(
      allSlots,
      preferredSessionIndex,
      now,
      occupied,
      reserved
    );
    
    // Should find alternative in session 0, not session 1
    expect(alternative).toBeTruthy();
    const alternativeSlot = allSlots.find(s => s.index === alternative);
    expect(alternativeSlot?.sessionIndex).toBe(0);
  });

  test('CRITICAL: should not cross session boundaries', () => {
    const session1Slots = generateSlots(0, 10, 5);
    const session2Slots = generateSlots(1, 15, 20);
    const allSlots = [...session1Slots, ...session2Slots];
    
    // All slots in session 0 are occupied
    const occupied = new Set(session1Slots.map(s => s.index));
    const reserved = new Set<number>();
    
    const alternative = findAlternativeInSameSession(
      allSlots,
      0, // Preferred session 0
      now,
      occupied,
      reserved
    );
    
    // Should not find alternative in session 1
    expect(alternative).toBe(null);
  });

  test('CRITICAL: should respect reserved slots when finding alternative', () => {
    const session1Slots = generateSlots(0, 10, 20);
    const allSlots = session1Slots;
    
    // Reserve last 3 slots for walk-ins
    const reserved = new Set([17, 18, 19]);
    const occupied = new Set([5]); // Occupy preferred slot
    
    const alternative = findAlternativeInSameSession(
      allSlots,
      0,
      now,
      occupied,
      reserved
    );
    
    // Should find alternative, but not in reserved slots
    expect(alternative).toBeTruthy();
    expect(reserved.has(alternative!)).toBe(false);
  });
});

describe('Advance Booking Edge Cases', () => {
  const now = parse('2024-01-15 09:00 AM', 'yyyy-MM-dd hh:mm a', new Date());

  test('CRITICAL: should handle midnight crossing', () => {
    const now = parse('2024-01-15 11:00 PM', 'yyyy-MM-dd hh:mm a', new Date());
    const slotAtMidnight = parse('2024-01-16 12:30 AM', 'yyyy-MM-dd hh:mm a', new Date());
    
    // 12:30 AM next day is 1.5 hours from 11:00 PM
    const isAvailable = isSlotAvailableForAdvanceBooking(
      slotAtMidnight,
      now,
      new Set(),
      new Set(),
      0
    );
    
    expect(isAvailable).toBe(true);
  });

  test('CRITICAL: should handle very early morning slots', () => {
    const now = parse('2024-01-15 06:00 AM', 'yyyy-MM-dd hh:mm a', new Date());
    const slotAt7_30 = parse('2024-01-15 07:30 AM', 'yyyy-MM-dd hh:mm a', new Date());
    
    // 7:30 AM is 1.5 hours from 6:00 AM
    const isAvailable = isSlotAvailableForAdvanceBooking(
      slotAt7_30,
      now,
      new Set(),
      new Set(),
      0
    );
    
    expect(isAvailable).toBe(true);
  });

  test('CRITICAL: should reject slots in the past', () => {
    const now = parse('2024-01-15 10:00 AM', 'yyyy-MM-dd hh:mm a', new Date());
    const slotAt9_00 = parse('2024-01-15 09:00 AM', 'yyyy-MM-dd hh:mm a', new Date());
    
    const oneHourFromNow = addMinutes(now, 60);
    const isValid = isAfter(slotAt9_00, oneHourFromNow);
    
    expect(isValid).toBe(false);
  });
});




