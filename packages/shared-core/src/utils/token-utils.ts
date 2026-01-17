/**
 * Generate an online appointment token number with session index
 * Format: A{sessionIndex+1}-{numericToken:003}
 * Examples: A1-001 (Session 0), A2-001 (Session 1)
 */
export const generateOnlineTokenNumber = (numericToken: number, sessionIndex: number): string => {
    const sessionLabel = sessionIndex + 1;
    const tokenPart = String(numericToken).padStart(3, '0');
    return `A${sessionLabel}-${tokenPart}`;
};

/**
 * Generate a walk-in appointment token number with session index
 * Format: W{sessionIndex+1}-{numericToken:003}
 * Examples: W1-001 (Session 0), W2-001 (Session 1)
 */
export const generateWalkInTokenNumber = (numericToken: number, sessionIndex: number): string => {
    const sessionLabel = sessionIndex + 1;
    const tokenPart = String(numericToken).padStart(3, '0');
    return `W${sessionLabel}-${tokenPart}`;
};
