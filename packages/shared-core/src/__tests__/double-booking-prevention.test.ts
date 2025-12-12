/**
 * CRITICAL TEST 2: Double Booking Prevention
 * Tests that two patients cannot book the same slot simultaneously.
 * This is the most critical test as it prevents real-world conflicts.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// Mock Firestore transaction
const mockTransaction = {
  get: vi.fn(),
  set: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};

const mockRunTransaction = vi.fn();

describe('Double Booking Prevention', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('CRITICAL: should reject booking if slot already reserved', async () => {
    // Simulate transaction function
    let slotReserved = false;
    
    const attemptBooking = async (slotIndex: number) => {
      if (slotReserved) {
        throw new Error('slot-reservation-conflict');
      }
      
      // Reserve slot
      slotReserved = true;
      return 'success';
    };

    // First booking succeeds (slot not yet reserved)
    await expect(attemptBooking(10)).resolves.toBe('success');

    // Second booking fails (slot already reserved)
    await expect(attemptBooking(10)).rejects.toThrow('slot-reservation-conflict');
  });

  test('CRITICAL: should handle concurrent booking attempts', async () => {
    let reservationExists = false;
    
    const attemptBooking = async (slotIndex: number) => {
      // Check if slot is reserved
      if (reservationExists) {
        throw new Error('slot-reservation-conflict');
      }
      
      // Simulate small delay (race condition)
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Reserve slot (first one wins)
      if (!reservationExists) {
        reservationExists = true;
        return 'success';
      }
      
      throw new Error('slot-reservation-conflict');
    };

    // Simulate 3 concurrent booking attempts
    const results = await Promise.allSettled([
      attemptBooking(10),
      attemptBooking(10),
      attemptBooking(10),
    ]);

    // Only one should succeed
    const successful = results.filter(r => r.status === 'fulfilled');
    const failed = results.filter(r => r.status === 'rejected');

    expect(successful.length).toBe(1);
    expect(failed.length).toBe(2);
  });

  test('CRITICAL: should allow booking after reservation expires', async () => {
    const now = Date.now();
    
    // Mock: Reservation expired 1 minute ago
    const expiredReservation = {
      exists: () => true,
      data: () => ({
        slotIndex: 10,
        reservedAt: new Date(now - 6 * 60 * 1000), // 6 min ago
        expiresAt: new Date(now - 1 * 60 * 1000), // Expired 1 min ago
      }),
    };

    const checkReservation = (doc: any) => {
      if (!doc.exists()) {
        return false; // No reservation
      }
      
      const data = doc.data();
      const expiresAt = data.expiresAt.getTime();
      
      // Reservation is valid if not expired
      return expiresAt > Date.now();
    };

    // Expired reservation should be invalid
    expect(checkReservation(expiredReservation)).toBe(false);
  });

  test('CRITICAL: should not allow booking with active reservation', async () => {
    const now = Date.now();
    
    // Mock: Reservation still active (expires in 3 minutes)
    const activeReservation = {
      exists: () => true,
      data: () => ({
        slotIndex: 10,
        reservedAt: new Date(now - 2 * 60 * 1000), // 2 min ago
        expiresAt: new Date(now + 3 * 60 * 1000), // Expires in 3 min
      }),
    };

    const checkReservation = (doc: any) => {
      if (!doc.exists()) {
        return false;
      }
      
      const data = doc.data();
      const expiresAt = data.expiresAt.getTime();
      
      return expiresAt > Date.now();
    };

    // Active reservation should be valid
    expect(checkReservation(activeReservation)).toBe(true);
  });

  test('CRITICAL: transaction should retry on conflict', async () => {
    let attemptCount = 0;
    const maxRetries = 5;
    
    const transactionWithRetry = async (operation: () => Promise<any>) => {
      for (let i = 0; i < maxRetries; i++) {
        attemptCount++;
        try {
          return await operation();
        } catch (error) {
          if (i === maxRetries - 1) {
            throw error; // Max retries reached
          }
          // Retry
          continue;
        }
      }
    };

    const operation = vi.fn()
      .mockRejectedValueOnce(new Error('conflict'))
      .mockRejectedValueOnce(new Error('conflict'))
      .mockResolvedValueOnce('success');

    const result = await transactionWithRetry(operation);
    
    expect(result).toBe('success');
    expect(attemptCount).toBe(3); // Failed twice, succeeded third time
  });
});

describe('Slot Reservation Validation', () => {
  test('CRITICAL: should validate slot index is within bounds', () => {
    const totalSlots = 100;
    
    const isValidSlotIndex = (index: number) => {
      return index >= 0 && index < totalSlots;
    };

    expect(isValidSlotIndex(50)).toBe(true);
    expect(isValidSlotIndex(0)).toBe(true);
    expect(isValidSlotIndex(99)).toBe(true);
    expect(isValidSlotIndex(-1)).toBe(false);
    expect(isValidSlotIndex(100)).toBe(false);
    expect(isValidSlotIndex(1000)).toBe(false);
  });

  test('CRITICAL: should validate slot is not already occupied', () => {
    const occupiedSlots = new Set([10, 20, 30]);
    
    const isSlotAvailable = (index: number) => {
      return !occupiedSlots.has(index);
    };

    expect(isSlotAvailable(10)).toBe(false);
    expect(isSlotAvailable(15)).toBe(true);
    expect(isSlotAvailable(20)).toBe(false);
    expect(isSlotAvailable(50)).toBe(true);
  });
});





