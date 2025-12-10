import { format } from 'date-fns';

const malayalamMonths: Record<string, string> = {
  'January': 'ജനുവരി',
  'February': 'ഫെബ്രുവരി',
  'March': 'മാർച്ച്',
  'April': 'ഏപ്രിൽ',
  'May': 'മേയ്',
  'June': 'ജൂൺ',
  'July': 'ജൂലൈ',
  'August': 'ഓഗസ്റ്റ്',
  'September': 'സെപ്റ്റംബർ',
  'October': 'ഒക്ടോബർ',
  'November': 'നവംബർ',
  'December': 'ഡിസംബർ'
};

const malayalamShortMonths: Record<string, string> = {
  'Jan': 'ജനു',
  'Feb': 'ഫെബ്രു',
  'Mar': 'മാർ',
  'Apr': 'ഏപ്രി',
  'May': 'മേയ്',
  'Jun': 'ജൂൺ',
  'Jul': 'ജൂലൈ',
  'Aug': 'ഓഗ',
  'Sep': 'സെപ്റ്റം',
  'Oct': 'ഒക്ടോ',
  'Nov': 'നവം',
  'Dec': 'ഡിസം'
};

const malayalamDays: Record<string, string> = {
  'Mon': 'തിങ്കൾ',
  'Tue': 'ചൊവ്വ',
  'Wed': 'ബുധൻ',
  'Thu': 'വ്യാഴം',
  'Fri': 'വെള്ളി',
  'Sat': 'ശനി',
  'Sun': 'ഞായർ'
};

/**
 * Format month and year with Malayalam support
 */
export function formatMonthYear(date: Date, language: 'en' | 'ml'): string {
  if (language === 'ml') {
    const englishMonth = format(date, 'MMMM yyyy');
    const monthName = format(date, 'MMMM');
    const year = format(date, 'yyyy');
    const malayalamMonth = malayalamMonths[monthName] || monthName;
    return `${malayalamMonth} ${year}`;
  }
  return format(date, 'MMMM yyyy');
}

/**
 * Format date with Malayalam month support
 */
export function formatDate(date: Date, formatStr: string, language: 'en' | 'ml'): string {
  if (language === 'ml') {
    if (formatStr === 'MMMM') {
      const monthName = format(date, 'MMMM');
      return malayalamMonths[monthName] || monthName;
    } else if (formatStr === 'MMM') {
      const shortMonthName = format(date, 'MMM');
      return malayalamShortMonths[shortMonthName] || shortMonthName;
    }
  }
  return format(date, formatStr);
}

/**
 * Format day of week with Malayalam support
 */
export function formatDayOfWeek(date: Date, language: 'en' | 'ml'): string {
  const englishDay = format(date, 'EEE');
  if (language === 'ml') {
    return malayalamDays[englishDay] || englishDay;
  }
  return englishDay;
}

