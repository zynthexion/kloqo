# 🧪 Test Scenarios Coverage Guide

Complete breakdown of what tests should cover and what bugs they catch.

---

## 📊 Test Coverage Overview

### Critical Functions to Test

1. **Walk-in Booking** (`walk-in.service.ts` - 3,193 lines)
2. **Advance Booking** (`appointment-service.ts` - 2,960 lines)
3. **Break Calculations** (`break-helpers.ts` - 543 lines)
4. **Status Updates** (`status-update-service.ts` - 577 lines)
5. **Token Generation** (both services)
6. **Queue Management** (`queue-management-service.ts`)

---

## 1. 🎫 Walk-in Token Generation

### Function: `generateNextTokenAndReserveSlot()`

**What it does:** Generates tokens (A1, A2, W1, W2) and reserves slots for walk-in patients.

### Test Scenarios:

#### ✅ Scenario 1.1: Basic Token Generation
```typescript
test('should generate A1 for first advance booking', async () => {
  const token = await generateNextToken(clinicId, doctorName, date, 'Advance');
  expect(token).toBe('A1');
});
```
**Catches:** Token counter not incrementing, wrong prefix

---

#### ✅ Scenario 1.2: Token Sequence
```typescript
test('should generate sequential tokens', async () => {
  const token1 = await generateNextToken(..., 'Advance');
  const token2 = await generateNextToken(..., 'Advance');
  expect(token1).toBe('A1');
  expect(token2).toBe('A2');
});
```
**Catches:** Token counter resetting, race conditions

---

#### ✅ Scenario 1.3: Walk-in vs Advance Tokens
```typescript
test('should generate W tokens for walk-in, A tokens for advance', async () => {
  const walkInToken = await generateNextToken(..., 'Walk-in');
  const advanceToken = await generateNextToken(..., 'Advance');
  expect(walkInToken).toMatch(/^W\d+$/);
  expect(advanceToken).toMatch(/^A\d+$/);
});
```
**Catches:** Wrong token type, token prefix confusion

---

#### ✅ Scenario 1.4: Concurrent Token Generation (Race Condition)
```typescript
test('should handle concurrent token requests without duplicates', async () => {
  const [token1, token2, token3] = await Promise.all([
    generateNextToken(...),
    generateNextToken(...),
    generateNextToken(...)
  ]);
  expect(new Set([token1, token2, token3]).size).toBe(3); // All unique
});
```
**Catches:** Race conditions, duplicate tokens, transaction failures

---

#### ✅ Scenario 1.5: Token Reset Per Day
```typescript
test('should reset token counter for new day', async () => {
  const todayToken = await generateNextToken(..., today);
  const tomorrowToken = await generateNextToken(..., tomorrow);
  expect(todayToken).toBe('A1');
  expect(tomorrowToken).toBe('A1'); // Resets for new day
});
```
**Catches:** Token counter not resetting, wrong date handling

---

## 2. 📅 Walk-in Slot Reservation (15% Rule)

### Function: `calculatePerSessionReservedSlots()`

**What it does:** Reserves last 15% of FUTURE slots in each session for walk-ins only.

### Test Scenarios:

#### ✅ Scenario 2.1: Basic 15% Calculation
```typescript
test('should reserve exactly 15% of future slots per session', () => {
  const slots = generateSlots(100); // 100 slots
  const reserved = calculatePerSessionReservedSlots(slots, now);
  expect(reserved.size).toBe(15); // 15% of 100
});
```
**Catches:** Wrong percentage (50% instead of 15%), rounding errors

---

#### ✅ Scenario 2.2: Only Future Slots Reserved
```typescript
test('should not reserve past slots', () => {
  const slots = [
    ...pastSlots(20),  // Past slots
    ...futureSlots(80) // Future slots
  ];
  const reserved = calculatePerSessionReservedSlots(slots, now);
  // Should only reserve from future slots
  reserved.forEach(index => {
    expect(slots[index].time).toBeAfter(now);
  });
});
```
**Catches:** Reserving past slots, time comparison bugs

---

#### ✅ Scenario 2.3: Per-Session Reservation
```typescript
test('should reserve 15% in each session separately', () => {
  const session1 = generateSlots(100); // Session 1: 100 slots
  const session2 = generateSlots(100); // Session 2: 100 slots
  const allSlots = [...session1, ...session2];
  const reserved = calculatePerSessionReservedSlots(allSlots, now);
  
  // Should reserve 15 from session1 AND 15 from session2
  const session1Reserved = reserved.filter(i => i < 100).length;
  const session2Reserved = reserved.filter(i => i >= 100).length;
  expect(session1Reserved).toBe(15);
  expect(session2Reserved).toBe(15);
});
```
**Catches:** Reserving across sessions, session boundary bugs

---

#### ✅ Scenario 2.4: Edge Case - Small Number of Slots
```typescript
test('should handle small slot counts correctly', () => {
  const slots = generateSlots(5); // Only 5 slots
  const reserved = calculatePerSessionReservedSlots(slots, now);
  // 15% of 5 = 0.75, should round up to 1
  expect(reserved.size).toBe(1);
});
```
**Catches:** Rounding errors, minimum reservation not applied

---

#### ✅ Scenario 2.5: Advance Booking Cannot Use Reserved Slots
```typescript
test('should reject advance booking in reserved walk-in slots', () => {
  const slots = generateSlots(100);
  const reserved = calculatePerSessionReservedSlots(slots, now);
  const reservedIndex = Array.from(reserved)[0];
  
  const candidates = buildCandidateSlots('A', slots, now, new Set(), reservedIndex);
  expect(candidates).not.toContain(reservedIndex);
});
```
**Catches:** Advance bookings using walk-in reserved slots (CRITICAL BUG!)

---

## 3. 🚶 Walk-in Placement Logic

### Function: `buildCandidateSlots()` for Walk-ins

**What it does:** Finds available slots for walk-in patients with proper spacing.

### Test Scenarios:

#### ✅ Scenario 3.1: Walk-in Within 1 Hour Window
```typescript
test('should allow walk-in booking within 1 hour window', () => {
  const now = parse('10:00 AM');
  const slotAt10_30 = createSlot('10:30 AM');
  const candidates = buildCandidateSlots('W', [slotAt10_30], now, new Set());
  expect(candidates).toContain(slotAt10_30.index);
});
```
**Catches:** Wrong time window, timezone bugs

---

#### ✅ Scenario 3.2: Walk-in Spacing (Every Nth Advance Token)
```typescript
test('should space walk-ins based on advance tokens', () => {
  // 5 advance appointments exist
  const advanceAppointments = [A1, A2, A3, A4, A5];
  const walkInSpacing = 2; // Every 2nd advance token
  
  const candidates = buildCandidateSlots('W', slots, now, new Set(), undefined, {
    appointments: advanceAppointments,
    walkInSpacing: 2
  });
  
  // Should place walk-in after 2nd advance token (A2)
  expect(candidates[0]).toBeGreaterThan(A2.slotIndex);
});
```
**Catches:** Wrong spacing calculation, walk-in placement bugs

---

#### ✅ Scenario 3.3: Walk-in After All Advance Tokens
```typescript
test('should place walk-in after all advance tokens if spacing allows', () => {
  const advanceAppointments = [A1, A2, A3];
  const walkInSpacing = 5; // More than available advance tokens
  
  const candidates = buildCandidateSlots('W', slots, now, new Set(), undefined, {
    appointments: advanceAppointments,
    walkInSpacing: 5
  });
  
  // Should place after last advance token
  expect(candidates[0]).toBeGreaterThan(A3.slotIndex);
});
```
**Catches:** Edge case handling, spacing overflow

---

#### ✅ Scenario 3.4: No Available Slots
```typescript
test('should return empty array when no slots available', () => {
  const allOccupied = new Set([0, 1, 2, 3, 4]);
  const candidates = buildCandidateSlots('W', slots, now, allOccupied);
  expect(candidates).toEqual([]);
});
```
**Catches:** Returning wrong values, null/undefined handling

---

## 4. 📝 Advance Booking Logic

### Function: `buildCandidateSlots()` for Advance Bookings

**What it does:** Finds available slots for advance bookings (must be >1 hour away).

### Test Scenarios:

#### ✅ Scenario 4.1: 1-Hour Cutoff Rule
```typescript
test('should reject slots within 1 hour', () => {
  const now = parse('10:00 AM');
  const slotAt10_30 = createSlot('10:30 AM'); // 30 min away
  const slotAt11_30 = createSlot('11:30 AM'); // 1.5 hours away
  
  const candidates = buildCandidateSlots('A', [slotAt10_30, slotAt11_30], now, new Set());
  
  expect(candidates).not.toContain(slotAt10_30.index);
  expect(candidates).toContain(slotAt11_30.index);
});
```
**Catches:** Wrong cutoff time, time calculation bugs

---

#### ✅ Scenario 4.2: Preferred Slot Selection
```typescript
test('should use preferred slot if available', () => {
  const preferredIndex = 50;
  const candidates = buildCandidateSlots('A', slots, now, new Set(), preferredIndex);
  expect(candidates[0]).toBe(preferredIndex);
});
```
**Catches:** Preferred slot ignored, wrong slot selection

---

#### ✅ Scenario 4.3: Same-Session Alternative
```typescript
test('should find alternative in same session if preferred unavailable', () => {
  const preferredIndex = 50; // In session 1
  const occupied = new Set([50]); // Preferred slot taken
  
  const candidates = buildCandidateSlots('A', slots, now, occupied, preferredIndex);
  
  // Should find alternative in same session (session 1)
  const selectedSlot = slots[candidates[0]];
  expect(selectedSlot.sessionIndex).toBe(slots[preferredIndex].sessionIndex);
});
```
**Catches:** Cross-session booking, session boundary bugs

---

#### ✅ Scenario 4.4: Cannot Book Reserved Walk-in Slots
```typescript
test('should never allow advance booking in reserved walk-in slots', () => {
  const slots = generateSlots(100);
  const reserved = calculatePerSessionReservedSlots(slots, now);
  const reservedIndex = Array.from(reserved)[0];
  
  const candidates = buildCandidateSlots('A', slots, now, new Set(), reservedIndex);
  expect(candidates).not.toContain(reservedIndex);
});
```
**Catches:** CRITICAL - Advance bookings using walk-in slots

---

## 5. 🔄 Break Time Calculations

### Function: `calculateSessionExtension()`, `applyBreakOffsets()`

**What it does:** Calculates how breaks extend session time and adjust appointment times.

### Test Scenarios:

#### ✅ Scenario 5.1: Single Break Extension
```typescript
test('should add break duration to session end', () => {
  const sessionEnd = parse('12:00 PM');
  const breaks = [{ duration: 15 }]; // 15 min break
  
  const result = calculateSessionExtension(0, breaks, sessionEnd);
  expect(result.newSessionEnd).toEqual(parse('12:15 PM'));
  expect(result.totalBreakMinutes).toBe(15);
});
```
**Catches:** Wrong time addition, negative durations

---

#### ✅ Scenario 5.2: Multiple Breaks
```typescript
test('should sum multiple break durations', () => {
  const sessionEnd = parse('12:00 PM');
  const breaks = [
    { duration: 15 }, // 15 min
    { duration: 30 }  // 30 min
  ];
  
  const result = calculateSessionExtension(0, breaks, sessionEnd);
  expect(result.totalBreakMinutes).toBe(45);
  expect(result.newSessionEnd).toEqual(parse('12:45 PM'));
});
```
**Catches:** Only counting first break, wrong summation

---

#### ✅ Scenario 5.3: Break Offset Application
```typescript
test('should add break time to appointments after break start', () => {
  const appointmentTime = parse('10:30 AM');
  const breaks = [{
    start: parse('10:00 AM'),
    end: parse('10:15 AM')
  }];
  
  const adjusted = applyBreakOffsets(appointmentTime, breaks);
  // Appointment is after break, so add 15 min
  expect(adjusted).toEqual(parse('10:45 AM'));
});
```
**Catches:** Adding break time twice, wrong time comparison

---

#### ✅ Scenario 5.4: Appointment Before Break
```typescript
test('should not adjust appointments before break', () => {
  const appointmentTime = parse('9:30 AM');
  const breaks = [{
    start: parse('10:00 AM'),
    end: parse('10:15 AM')
  }];
  
  const adjusted = applyBreakOffsets(appointmentTime, breaks);
  // Appointment is before break, no adjustment
  expect(adjusted).toEqual(parse('9:30 AM'));
});
```
**Catches:** Adjusting wrong appointments, time comparison bugs

---

#### ✅ Scenario 5.5: Multiple Breaks in Sequence
```typescript
test('should apply all breaks in sequence', () => {
  const appointmentTime = parse('10:30 AM');
  const breaks = [
    { start: parse('10:00 AM'), end: parse('10:15 AM') }, // 15 min
    { start: parse('11:00 AM'), end: parse('11:30 AM') }  // 30 min
  ];
  
  const adjusted = applyBreakOffsets(appointmentTime, breaks);
  // After first break (15 min) but before second, so only add first
  expect(adjusted).toEqual(parse('10:45 AM'));
});
```
**Catches:** Applying wrong breaks, sequence bugs

---

## 6. ⏱️ Status Update Logic

### Function: `updateAppointmentStatuses()`

**What it does:** Updates appointment status (Pending → Skipped → No-show) based on time.

### Test Scenarios:

#### ✅ Scenario 6.1: Pending → Skipped (15 min before)
```typescript
test('should mark as Skipped when arrive-by time passes', () => {
  const appointment = {
    status: 'Pending',
    time: parse('10:00 AM'),
    cutOffTime: parse('9:45 AM') // 15 min before
  };
  const now = parse('9:46 AM'); // After cutoff
  
  const shouldSkip = shouldMarkAsSkipped(appointment, now);
  expect(shouldSkip).toBe(true);
});
```
**Catches:** Wrong cutoff time, timezone issues

---

#### ✅ Scenario 6.2: Skipped → No-show (15 min after)
```typescript
test('should mark as No-show when appointment time + 15min passes', () => {
  const appointment = {
    status: 'Skipped',
    time: parse('10:00 AM'),
    noShowTime: parse('10:15 AM')
  };
  const now = parse('10:16 AM'); // After no-show time
  
  const shouldMarkNoShow = shouldMarkAsNoShow(appointment, now);
  expect(shouldMarkNoShow).toBe(true);
});
```
**Catches:** Wrong no-show time, status transition bugs

---

#### ✅ Scenario 6.3: Doctor Out - Don't Skip
```typescript
test('should not skip if doctor is Out and availability not started', () => {
  const appointment = {
    status: 'Pending',
    time: parse('10:00 AM'),
    cutOffTime: parse('9:45 AM')
  };
  const doctor = { consultationStatus: 'Out' };
  const now = parse('9:46 AM');
  const nextAvailability = parse('10:00 AM'); // Doctor starts at 10
  
  const shouldSkip = shouldMarkAsSkipped(appointment, now, doctor, nextAvailability);
  expect(shouldSkip).toBe(false); // Don't skip, doctor hasn't started
});
```
**Catches:** Skipping when doctor not available, availability check bugs

---

#### ✅ Scenario 6.4: Doctor In - Can Mark No-show
```typescript
test('should mark as No-show only if doctor is In', () => {
  const appointment = {
    status: 'Skipped',
    time: parse('10:00 AM'),
    noShowTime: parse('10:15 AM')
  };
  const doctor = { consultationStatus: 'In' };
  const now = parse('10:16 AM');
  
  const shouldMarkNoShow = shouldMarkAsNoShow(appointment, now, doctor);
  expect(shouldMarkNoShow).toBe(true);
});
```
**Catches:** Marking no-show when doctor out, status logic bugs

---

## 7. 🔒 Double Booking Prevention

### Function: Transaction logic in booking functions

**What it does:** Prevents two patients from booking the same slot simultaneously.

### Test Scenarios:

#### ✅ Scenario 7.1: Slot Reservation Conflict
```typescript
test('should reject booking if slot already reserved', async () => {
  // First booking reserves slot
  await generateNextTokenAndReserveSlot(..., slotIndex: 10);
  
  // Second booking tries same slot
  await expect(
    generateNextTokenAndReserveSlot(..., slotIndex: 10)
  ).rejects.toThrow('slot-reservation-conflict');
});
```
**Catches:** CRITICAL - Double booking allowed, transaction failures

---

#### ✅ Scenario 7.2: Concurrent Booking Attempts
```typescript
test('should handle concurrent booking attempts', async () => {
  const results = await Promise.allSettled([
    bookAppointment(..., slotIndex: 10),
    bookAppointment(..., slotIndex: 10),
    bookAppointment(..., slotIndex: 10)
  ]);
  
  // Only one should succeed
  const successful = results.filter(r => r.status === 'fulfilled');
  expect(successful.length).toBe(1);
});
```
**Catches:** Race conditions, transaction retry bugs

---

#### ✅ Scenario 7.3: Reservation Expiry
```typescript
test('should allow booking after reservation expires', async () => {
  // Create reservation
  await reserveSlot(slotIndex: 10, expiresIn: '5min');
  
  // Wait for expiry
  await wait('6min');
  
  // Should be able to book now
  await expect(bookAppointment(..., slotIndex: 10)).resolves.not.toThrow();
});
```
**Catches:** Reservations never expiring, expiry time bugs

---

## 8. 🔄 Queue Rebalancing

### Function: `rebalanceWalkInSchedule()`

**What it does:** Rebalances walk-in queue when appointments are cancelled/no-show.

### Test Scenarios:

#### ✅ Scenario 8.1: Rebalance After Cancellation
```typescript
test('should move walk-ins up after cancellation', async () => {
  const appointments = [A1, A2, W1, A3, W2];
  await cancelAppointment(A2);
  
  const rebalanced = await rebalanceWalkInSchedule(...);
  // W1 should move to A2's position
  expect(rebalanced[1]).toBe(W1);
});
```
**Catches:** Queue not rebalancing, wrong order

---

#### ✅ Scenario 8.2: Rebalance After No-show
```typescript
test('should rebalance after marking as no-show', async () => {
  const appointments = [A1, A2, W1];
  await markAsNoShow(A2);
  
  const rebalanced = await rebalanceWalkInSchedule(...);
  expect(rebalanced).not.toContain(A2);
  // Walk-ins should move up
});
```
**Catches:** No-show not triggering rebalance

---

## 9. 📊 Edge Cases & Boundary Conditions

### Test Scenarios:

#### ✅ Scenario 9.1: Midnight Edge Case
```typescript
test('should handle appointments at midnight correctly', () => {
  const now = parse('11:59 PM');
  const slotAtMidnight = createSlot('12:00 AM');
  const candidates = buildCandidateSlots('A', [slotAtMidnight], now, new Set());
  // Should handle day rollover
  expect(candidates).toContain(slotAtMidnight.index);
});
```
**Catches:** Day rollover bugs, date calculation errors

---

#### ✅ Scenario 9.2: Leap Year
```typescript
test('should handle leap year dates', () => {
  const leapYearDate = parse('2024-02-29');
  const token = await generateNextToken(..., leapYearDate);
  expect(token).toBeDefined();
});
```
**Catches:** Date parsing errors, leap year bugs

---

#### ✅ Scenario 9.3: Empty Slot List
```typescript
test('should handle empty slot list gracefully', () => {
  const candidates = buildCandidateSlots('A', [], now, new Set());
  expect(candidates).toEqual([]);
});
```
**Catches:** Null pointer exceptions, empty array handling

---

#### ✅ Scenario 9.4: Doctor with No Availability
```typescript
test('should throw error if doctor has no availability', async () => {
  const doctor = { availabilitySlots: [] };
  await expect(
    bookAppointment(doctor, ...)
  ).rejects.toThrow('Doctor is not available');
});
```
**Catches:** Missing error handling, undefined errors

---

## 📈 Test Coverage Summary

### By Function:

| Function | Test Scenarios | Critical Bugs Caught |
|----------|---------------|---------------------|
| Token Generation | 5 scenarios | Duplicate tokens, race conditions |
| Walk-in Reservation | 5 scenarios | Wrong percentage, cross-session bugs |
| Walk-in Placement | 4 scenarios | Wrong spacing, time window bugs |
| Advance Booking | 4 scenarios | **Double booking**, reserved slot bugs |
| Break Calculations | 5 scenarios | Wrong time addition, sequence bugs |
| Status Updates | 4 scenarios | Wrong timing, status transition bugs |
| Double Booking | 3 scenarios | **CRITICAL - Concurrent booking** |
| Queue Rebalancing | 2 scenarios | Queue order bugs |
| Edge Cases | 4 scenarios | Date/time bugs, null handling |

**Total: 36 test scenarios**

---

## 🎯 Priority Order

### **CRITICAL (Must Test First):**
1. ✅ Double booking prevention (Scenario 7.1, 7.2)
2. ✅ 15% walk-in reservation (Scenario 2.1, 2.5)
3. ✅ Advance booking cannot use reserved slots (Scenario 4.4)
4. ✅ Token generation uniqueness (Scenario 1.4)

### **HIGH PRIORITY:**
5. ✅ Break time calculations (Scenario 5.1-5.3)
6. ✅ Status update timing (Scenario 6.1-6.2)
7. ✅ 1-hour cutoff rule (Scenario 4.1)

### **MEDIUM PRIORITY:**
8. ✅ Walk-in spacing (Scenario 3.2)
9. ✅ Queue rebalancing (Scenario 8.1-8.2)
10. ✅ Edge cases (Scenario 9.1-9.4)

---

## 💡 What Each Test Catches

### Logic Bugs:
- Wrong calculations (15% → 50%)
- Wrong time comparisons
- Wrong status transitions

### Race Conditions:
- Concurrent token generation
- Simultaneous bookings
- Transaction conflicts

### Edge Cases:
- Midnight/day rollover
- Leap years
- Empty data
- Boundary conditions

### Regression Bugs:
- Old code worked, new code breaks
- Refactoring breaks functionality
- Dependency updates break logic

---

## 🚀 Getting Started

**Start with these 5 critical tests:**
1. Double booking prevention
2. 15% reservation calculation
3. Advance booking cannot use reserved slots
4. Token uniqueness
5. Break time calculation

These 5 tests will catch **80% of critical bugs** with **20% of the effort**.

---

**Next Steps:** See `SETUP_TESTING.md` for how to implement these tests.

