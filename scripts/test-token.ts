import { generateWhatsAppMagicLink } from '../packages/shared-core/src/services/whatsapp-service';
import { validateWhatsAppToken } from '../packages/shared-core/src/services/whatsapp-auth';

// Mock IDs for testing
const testPatientId = "test-patient-id";
const testClinicId = "test-clinic-id";
const testDoctorId = "test-doctor-id";

process.env.NEXT_PUBLIC_PATIENT_APP_URL = "http://localhost:3000";

const link = generateWhatsAppMagicLink({
    baseUrl: process.env.NEXT_PUBLIC_PATIENT_APP_URL,
    patientId: testPatientId,
    clinicId: testClinicId,
    doctorId: testDoctorId,
    action: 'book'
});

console.log("Generated Link:", link);

const url = new URL(link);
const token = url.searchParams.get('tk');

if (token) {
    const session = validateWhatsAppToken(token);
    console.log("Validated Session:", JSON.stringify(session, null, 2));
} else {
    console.error("Token (tk) not found in generated link!");
}

