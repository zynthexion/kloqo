
export * from './services/appointment-service';
export { getClassicTokenCounterId, prepareNextClassicTokenNumber, commitNextClassicTokenNumber } from './services/appointment-service';
export * from './services/break-service';
export * from './services/capacity-service';
export * from './services/status-update-service';
export * from './services/queue-management-service';
export * from './services/notification-service';
export * from './services/walk-in-booking';
export * from './services/patient-service';
export { getPatientByPhone } from './services/patient-service';
export * from './utils/break-helpers';
export { previewWalkInPlacement, calculateWalkInDetails, findActiveSessionIndex, findTargetSessionForForceBooking, type DailySlot } from './services/walk-in.service';
export * from './services/walk-in-scheduler';
export * from './services/booking.service';
export * from './services/whatsapp-service';
export * from './services/punctuality-service';
export * from './services/code-service';
export * from './services/whatsapp-session-service';
export * from './services/global-search-service';
export * from './services/magic-link-service';
export * from './services/marketing-link-service';
export * from './services/notification-config';
// export * from './services/magic-link-admin-service'; // Server-only: Import directly
// Note: AIService is not exported here to avoid forcing @google/generative-ai dependency on all apps
// Import directly from './services/ai-service' if needed

export * from './utils/date-utils';
export { getClinicDateString, getClinicNow } from './utils/date-utils';
export * from './utils/reservation-utils';
export * from './utils/errors';
// export * from './utils/firebase-admin'; // Server-only: Import directly
export * from './utils/error-emitter';
export * from './utils/text-utils';
export * from './utils/token-utils';
export * from './utils/estimated-time-utils';
