/**
 * Capitalizes the first letter of a string.
 */
export function capitalizeFirstLetter(str: string): string {
    if (!str) return str;
    return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Capitalizes the first letter of every word in a string.
 */
export function capitalizeWords(str: string): string {
    if (!str) return str;
    return str.split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ');
}

/**
 * Converts a string to uppercase.
 */
export function toUpperCase(str: string): string {
    if (!str) return str;
    return str.toUpperCase();
}
