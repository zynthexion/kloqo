/**
 * Generates a consistent document ID for slot reservations.
 * This ID is used as an atomic lock in Firestore transactions.
 * 
 * Rules:
 * 1. Replace all whitespaces with underscores.
 * 2. Remove all non-alphanumeric characters except underscores.
 */
export function buildReservationDocId(
    clinicId: string,
    doctorName: string,
    dateStr: string,
    slotIndex: number
): string {
    const rawId = `${clinicId}_${doctorName}_${dateStr}_slot_${slotIndex}`;
    return rawId
        .replace(/\s+/g, '_')
        .replace(/[^a-zA-Z0-9_]/g, '');
}
