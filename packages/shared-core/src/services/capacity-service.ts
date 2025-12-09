/**
 * Capacity Service
 * 
 * Handles 85/15 split calculations for A tokens and walk-ins
 * - Maximum A tokens: 85% of total slots
 * - Minimum W tokens: 15% of total slots (assigned slots)
 * - W tokens can use empty A token slots if available
 */

/**
 * Calculate session capacity split based on ratio
 * 
 * Uses smart rounding to handle small numbers correctly:
 * - For small totals, ensures we get as close as possible to target percentages
 * - Ensures walk-in always gets at least 1 slot when total > 0
 * - Chooses the rounding that gets closest to the target percentage
 * 
 * @param totalSlots Total number of slots in the session
 * @param capacityRatio Ratio for advanced tokens (default 0.85 = 85%)
 * @returns Object with advancedCapacity and walkInCapacity
 */
export function calculateSessionCapacity(
  totalSlots: number,
  capacityRatio: number = 0.85
): { advancedCapacity: number; walkInCapacity: number } {
  if (totalSlots <= 0) {
    return { advancedCapacity: 0, walkInCapacity: 0 };
  }

  const idealAdvanced = totalSlots * capacityRatio;
  
  // Calculate both floor and ceil options for advance capacity
  const advancedFloor = Math.floor(idealAdvanced);
  const advancedCeil = Math.ceil(idealAdvanced);
  
  // Calculate corresponding walk-in capacities
  const walkInFloor = totalSlots - advancedFloor;
  const walkInCeil = totalSlots - advancedCeil;
  
  // Calculate which option gets closer to the target percentage
  const floorAdvancedPercent = advancedFloor / totalSlots;
  const ceilAdvancedPercent = advancedCeil / totalSlots;
  
  const floorDiff = Math.abs(floorAdvancedPercent - capacityRatio);
  const ceilDiff = Math.abs(ceilAdvancedPercent - capacityRatio);
  
  // Choose the option that's closer to target, but ensure walk-in gets at least 1
  let advancedCapacity: number;
  let walkInCapacity: number;
  
  if (walkInFloor === 0) {
    // If floor gives walk-in 0, we must use ceil (or adjust)
    advancedCapacity = Math.max(0, totalSlots - 1);
    walkInCapacity = 1;
  } else if (walkInCeil === 0) {
    // If ceil gives walk-in 0, use floor
    advancedCapacity = advancedFloor;
    walkInCapacity = walkInFloor;
  } else if (floorDiff <= ceilDiff) {
    // Floor is closer to target
    advancedCapacity = advancedFloor;
    walkInCapacity = walkInFloor;
  } else {
    // Ceil is closer to target
    advancedCapacity = advancedCeil;
    walkInCapacity = walkInCeil;
  }
  
  // Final safety check: ensure walk-in gets at least 1 slot
  if (walkInCapacity === 0 && totalSlots > 0) {
    walkInCapacity = 1;
    advancedCapacity = totalSlots - walkInCapacity;
  }
  
  return { advancedCapacity, walkInCapacity };
}

/**
 * Check if a slot index is in the advanced token zone (85% zone)
 * 
 * @param slotIndex The slot index to check
 * @param totalSlots Total number of slots in the session
 * @param capacityRatio Ratio for advanced tokens (default 0.85)
 * @returns True if slot is in advanced zone, false if in walk-in zone
 */
export function isSlotInAdvancedZone(
  slotIndex: number,
  totalSlots: number,
  capacityRatio: number = 0.85
): boolean {
  const { advancedCapacity } = calculateSessionCapacity(totalSlots, capacityRatio);
  return slotIndex < advancedCapacity;
}

/**
 * Get the number of A tokens booked for a specific session
 * 
 * @param appointments All appointments for the doctor and date
 * @param date Date string in format "d MMMM yyyy"
 * @param sessionIndex The session index to check
 * @returns Count of A tokens booked in the session
 */
export function getBookedATokenCount(
  appointments: Array<{ bookedVia?: string; slotIndex?: number; sessionIndex?: number; status?: string }>,
  date: string,
  sessionIndex: number
): number {
  return appointments.filter(apt => 
    apt.bookedVia !== 'Walk-in' &&
    apt.sessionIndex === sessionIndex &&
    apt.status !== 'Cancelled' &&
    apt.status !== 'Completed' &&
    apt.status !== 'No-show'
  ).length;
}

/**
 * Check if A token booking is allowed (within 85% capacity)
 * 
 * @param currentA Current number of A tokens booked in the session
 * @param totalSlots Total number of slots in the session
 * @param capacityRatio Ratio for advanced tokens (default 0.85)
 * @returns True if booking is allowed, false if capacity is full
 */
export function canBookAToken(
  currentA: number,
  totalSlots: number,
  capacityRatio: number = 0.85
): boolean {
  const { advancedCapacity } = calculateSessionCapacity(totalSlots, capacityRatio);
  return currentA < advancedCapacity;
}

/**
 * Calculate total slots for a session
 * 
 * @param sessionStart Start time of session
 * @param sessionEnd End time of session
 * @param slotDuration Slot duration in minutes (default 15)
 * @returns Total number of slots in the session
 */
export function calculateTotalSlots(
  sessionStart: Date,
  sessionEnd: Date,
  slotDuration: number = 15
): number {
  const durationMs = sessionEnd.getTime() - sessionStart.getTime();
  const durationMinutes = durationMs / (1000 * 60);
  return Math.floor(durationMinutes / slotDuration);
}

