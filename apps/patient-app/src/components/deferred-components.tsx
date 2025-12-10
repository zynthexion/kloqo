'use client';

import dynamic from 'next/dynamic';

// Defer non-critical components to reduce initial bundle and improve LCP
// These components are not critical for initial render and can load after the page is interactive
export const ReviewChecker = dynamic(
  () => import('@/components/review-checker').then(mod => mod.ReviewChecker),
  { ssr: false }
);

export const AppointmentReminderHandler = dynamic(
  () => import('@/components/appointment-reminder-handler').then(mod => mod.AppointmentReminderHandler),
  { ssr: false }
);









