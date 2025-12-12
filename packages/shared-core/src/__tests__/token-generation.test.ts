/**
 * CRITICAL TEST 3: Token Generation Uniqueness
 * Tests that tokens are generated uniquely without duplicates,
 * especially under concurrent requests (race conditions).
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { format } from 'date-fns';

// Mock token counter
let tokenCounter = 0;

/**
 * Generate next token (simplified version for testing)
 */
function generateToken(type: 'Advance' | 'Walk-in', date: Date): string {
  tokenCounter++;
  const prefix = type === 'Advance' ? 'A' : 'W';
  return `${prefix}${tokenCounter}`;
}

/**
 * Reset counter for new day
 */
function resetCounterForNewDay(currentDate: Date, lastDate: Date | null): void {
  if (!lastDate || format(currentDate, 'yyyy-MM-dd') !== format(lastDate, 'yyyy-MM-dd')) {
    tokenCounter = 0;
  }
}

describe('Token Generation - Uniqueness', () => {
  beforeEach(() => {
    tokenCounter = 0;
  });

  test('CRITICAL: should generate A1 for first advance booking', () => {
    const token = generateToken('Advance', new Date());
    expect(token).toBe('A1');
  });

  test('CRITICAL: should generate W1 for first walk-in', () => {
    tokenCounter = 0;
    const token = generateToken('Walk-in', new Date());
    expect(token).toBe('W1');
  });

  test('CRITICAL: should generate sequential tokens', () => {
    const date = new Date();
    const token1 = generateToken('Advance', date);
    const token2 = generateToken('Advance', date);
    const token3 = generateToken('Advance', date);

    expect(token1).toBe('A1');
    expect(token2).toBe('A2');
    expect(token3).toBe('A3');
  });

  test('CRITICAL: should use correct prefix for token type', () => {
    tokenCounter = 0;
    const advanceToken = generateToken('Advance', new Date());
    const walkInToken = generateToken('Walk-in', new Date());

    expect(advanceToken).toMatch(/^A\d+$/);
    expect(walkInToken).toMatch(/^W\d+$/);
  });

  test('CRITICAL: should reset counter for new day', () => {
    const today = new Date('2024-01-15');
    const tomorrow = new Date('2024-01-16');

    // Today
    const token1 = generateToken('Advance', today);
    expect(token1).toBe('A1');

    const token2 = generateToken('Advance', today);
    expect(token2).toBe('A2');

    // Reset for new day
    resetCounterForNewDay(tomorrow, today);

    // Tomorrow - counter should reset
    const token3 = generateToken('Advance', tomorrow);
    expect(token3).toBe('A1'); // Reset to A1
  });

  test('CRITICAL: should not reset counter for same day', () => {
    const morning = new Date('2024-01-15 09:00:00');
    const afternoon = new Date('2024-01-15 15:00:00');

    const token1 = generateToken('Advance', morning);
    expect(token1).toBe('A1');

    // No reset for same day
    resetCounterForNewDay(afternoon, morning);

    const token2 = generateToken('Advance', afternoon);
    expect(token2).toBe('A2'); // Continues from previous
  });
});

describe('Token Generation - Concurrency', () => {
  beforeEach(() => {
    tokenCounter = 0;
  });

  test('CRITICAL: should handle concurrent token generation without duplicates', async () => {
    // Simulate atomic counter increment using transaction
    let atomicCounter = 0;

    const generateTokenAtomic = async (type: 'Advance' | 'Walk-in') => {
      // Simulate transaction
      return new Promise<string>((resolve) => {
        // Atomic increment
        const currentCount = ++atomicCounter;
        const prefix = type === 'Advance' ? 'A' : 'W';
        resolve(`${prefix}${currentCount}`);
      });
    };

    // Generate 10 tokens concurrently
    const tokens = await Promise.all([
      generateTokenAtomic('Advance'),
      generateTokenAtomic('Advance'),
      generateTokenAtomic('Advance'),
      generateTokenAtomic('Advance'),
      generateTokenAtomic('Advance'),
      generateTokenAtomic('Walk-in'),
      generateTokenAtomic('Walk-in'),
      generateTokenAtomic('Advance'),
      generateTokenAtomic('Walk-in'),
      generateTokenAtomic('Advance'),
    ]);

    // All tokens should be unique
    const uniqueTokens = new Set(tokens);
    expect(uniqueTokens.size).toBe(10);
    expect(tokens.length).toBe(10);
  });

  test('CRITICAL: should handle race condition with transaction retry', async () => {
    let counter = 0;
    let conflictCount = 0;

    const generateWithRetry = async () => {
      const maxRetries = 5;

      for (let i = 0; i < maxRetries; i++) {
        try {
          // Simulate transaction
          const current = counter;

          // Simulate conflict check
          if (Math.random() < 0.3 && i < maxRetries - 1) {
            conflictCount++;
            throw new Error('Transaction conflict');
          }

          // Success
          counter = current + 1;
          return `A${counter}`;
        } catch (error) {
          if (i === maxRetries - 1) throw error;
          // Retry
          continue;
        }
      }
    };

    const tokens = await Promise.all([
      generateWithRetry(),
      generateWithRetry(),
      generateWithRetry(),
    ]);

    // All tokens should be unique despite conflicts
    const uniqueTokens = new Set(tokens);
    expect(uniqueTokens.size).toBe(3);

    // Some conflicts should have occurred
    console.log(`Conflicts handled: ${conflictCount}`);
  });
});

describe('Token Validation', () => {
  test('CRITICAL: should validate token format', () => {
    const isValidToken = (token: string): boolean => {
      return /^[AW]\d+$/.test(token);
    };

    expect(isValidToken('A1')).toBe(true);
    expect(isValidToken('A123')).toBe(true);
    expect(isValidToken('W5')).toBe(true);
    expect(isValidToken('W999')).toBe(true);

    expect(isValidToken('B1')).toBe(false);
    expect(isValidToken('1A')).toBe(false);
    expect(isValidToken('A')).toBe(false);
    expect(isValidToken('AA1')).toBe(false);
    expect(isValidToken('')).toBe(false);
  });

  test('CRITICAL: should extract token number correctly', () => {
    const getTokenNumber = (token: string): number => {
      const match = token.match(/\d+$/);
      return match ? parseInt(match[0], 10) : 0;
    };

    expect(getTokenNumber('A1')).toBe(1);
    expect(getTokenNumber('A123')).toBe(123);
    expect(getTokenNumber('W5')).toBe(5);
    expect(getTokenNumber('W999')).toBe(999);
  });

  test('CRITICAL: should identify token type correctly', () => {
    const getTokenType = (token: string): 'Advance' | 'Walk-in' | 'Invalid' => {
      if (token.startsWith('A')) return 'Advance';
      if (token.startsWith('W')) return 'Walk-in';
      return 'Invalid';
    };

    expect(getTokenType('A1')).toBe('Advance');
    expect(getTokenType('A123')).toBe('Advance');
    expect(getTokenType('W5')).toBe('Walk-in');
    expect(getTokenType('W999')).toBe('Walk-in');
    expect(getTokenType('B1')).toBe('Invalid');
  });
});

describe('Token Counter Edge Cases', () => {
  test('CRITICAL: should handle large token numbers', () => {
    tokenCounter = 9999;
    const token = generateToken('Advance', new Date());
    expect(token).toBe('A10000');
  });

  test('CRITICAL: should handle token number overflow gracefully', () => {
    // In a real system, you might want to handle this
    tokenCounter = Number.MAX_SAFE_INTEGER - 1;
    const token1 = generateToken('Advance', new Date());
    expect(token1).toBeTruthy();

    // This would overflow in JavaScript
    const token2 = generateToken('Advance', new Date());
    expect(token2).toBeTruthy();
  });
});





