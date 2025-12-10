import type { Department } from '@/hooks/use-master-departments';

/**
 * Get the localized department name based on the selected language
 * @param departmentName - The English department name
 * @param language - The selected language ('en' or 'ml')
 * @param departments - Array of department objects with name_ml field
 * @returns The localized department name, or the original name if translation not found
 */
export function getLocalizedDepartmentName(
  departmentName: string | undefined,
  language: 'en' | 'ml',
  departments: Department[]
): string {
  if (!departmentName) return '';
  
  if (language === 'en') {
    return departmentName;
  }

  // Find the department in the master list
  const department = departments.find(dept => dept.name === departmentName);
  
  // Return Malayalam name if available, otherwise fallback to English
  return department?.name_ml || departmentName;
}

