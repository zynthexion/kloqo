import { GoogleGenerativeAI } from '@google/generative-ai';

// Initialize Gemini with API Key (Needs to be in env)
// Refactored to initialize inside the method to ensure ENV is loaded

export const AI_ERROR_BUSY = "AI_ERROR_BUSY";

export class AIService {
    /**
     * Generates a helpful response for a patient based on clinic context.
     */
    static async generatePatientResponse(
        clinicName: string,
        doctorName: string,
        doctorStatus: string,
        queueLength: number,
        operatingHours: string,
        userQuery: string,
        patientName?: string,
        globalData?: string // New parameter for global clinic context
    ): Promise<string> {
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            console.warn('GEMINI_API_KEY not found. Returning fallback response.');
            return "ക്ഷമിക്കണം, സിസ്റ്റം അറ്റകുറ്റപ്പണിയിലാണ്. ബുക്ക് ചെയ്യാൻ 'Book' എന്ന് ടൈപ്പ് ചെയ്യുക.";
        }

        // Initialize Gemini dynamically to ensure ENV is loaded
        const genAI = new GoogleGenerativeAI(apiKey);
        // Use gemini-flash-latest which is available for this key
        const model = genAI.getGenerativeModel({ model: 'gemini-flash-latest' });

        const greeting = patientName ? `Address the patient as "${patientName}".` : "Address the user politely.";
        const isGeneral = clinicName === "Kloqo" || !clinicName;

        const clinicContext = isGeneral
            ? `You are an assistant for Kloqo, a clinic management platform. The user hasn't selected a specific clinic yet.`
            : `You are a smart, friendly receptionist for "${clinicName}".`;

        const globalInfo = globalData ? `\n\nPlatform context (Clinics you can recommend if the user asks for a specialty or describes a symptom):\n${globalData}` : "";

        const statusInfo = isGeneral
            ? `Use the "Platform context" below to suggest relevant clinics based on the user's symptoms or needs. If no relevant clinic is found, ask for a Clinic Code (KQ-XXXX).`
            : `
      Clinic Status:
      - Doctor: ${doctorName}
      - Doctor Status: ${doctorStatus}
      - Patients Waiting: ${queueLength}
      - Operating Hours: ${operatingHours}
      `;

        const prompt = `
      ${clinicContext}
      ${greeting}
      
      Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}
      
      ${statusInfo}
      ${globalInfo}
      
      User Query: "${userQuery}"
      
      Guidelines:
      1. Priority language is Malayalam. If the user asks in English, you can reply in Malayalam or a mix (Manglish).
      2. If the user describes a symptom (e.g., fever, stomach ache, tooth pain), use the "Platform context" above to find a matching specialty and recommend the specific clinic and its code (KQ-XXXX). Explain why you are recommending it (e.g., "For stomach pain, you can visit a General Physician at Clinic X").
      3. If the user asks for options or what they can do, present these numbered options:
         1. ഡോക്ടറുടെ ലഭята (Doctor Availability)
         2. പ്രവർത്തന സമയം (Opening Hours)
         3. ക്യൂ നില (Queue Status)
         4. അപ്പോയിന്റ്മെന്റ് ബുക്ക് ചെയ്യുക (Book Appointment)
      4. If the user types a number (1, 2, 3, 4), respond to the corresponding option.
      5. If the user wants to book (Option 4), guide them to type "Book" or "4".
      6. Keep it concise (max 3 sentences).
      7. Always be helpful and polite.
    `;

        try {
            console.log(`[AIService] Generating response for ${patientName || 'User'} using gemini-flash-latest...`);
            const result = await model.generateContent(prompt);
            const response = await result.response;
            return response.text();
        } catch (error: any) {
            console.error('Gemini API Error:', error);

            // SPECIAL CASE: Quota Exceeded (429)
            if (error.status === 429 || error.message?.includes('Too Many Requests') || error.message?.includes('quota')) {
                return AI_ERROR_BUSY;
            }

            // If the specific model fails, try gemini-2.0-flash which we saw in the list
            if (error.status === 404 || error.message?.includes('not found')) {
                try {
                    console.log('[AIService] Retrying with alternative model: gemini-2.0-flash');
                    const fallbackModel = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
                    const result = await fallbackModel.generateContent(prompt);
                    const response = await result.response;
                    return response.text();
                } catch (fallbackError: any) {
                    console.error('Gemini Fallback Error:', fallbackError);
                    if (fallbackError.status === 429) return AI_ERROR_BUSY;
                }
            }
            return "ക്ഷമിക്കണം, ഇപ്പോൾ സിസ്റ്റുമായി ബന്ധിപ്പിക്കാൻ കഴിയുന്നില്ല. ദയവായി അല്പം കഴിഞ്ഞ് ശ്രമിക്കുക.";
        }
    }

    /**
     * Uses AI to extract booking information (name, age, sex, date, intent) from user messages.
     */
    static async extractBookingInfo(text: string): Promise<{
        intent?: 'book' | 'cancel' | 'check_status' | 'unknown';
        patientName?: string;
        patientAge?: number;
        patientSex?: string;
        date?: string; // ISO or human readable
        doctorName?: string;
    }> {
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) return { intent: 'unknown' };

        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: 'gemini-flash-latest' });

        const prompt = `
      Extract booking information from this message: "${text}"
      
      Current Date: ${new Date().toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Kolkata' })}
      Reference Date (YYYY-MM-DD): ${new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })}
      
      Rules:
      1. Identify intent: Is the user trying to start a booking, cancel, or just checking?
      2. Extract patient details if present (name, age, gender).
      3. Extract date if mentioned (e.g., "tomorrow", "next Monday", "10th Feb"). Convert to YYYY-MM-DD if possible.
      4. Extract doctor name or specialty if mentioned.
      5. Return ONLY a JSON object with these keys: intent, patientName, patientAge, patientSex, date, doctorName.
      6. Use null for missing values.
      7. Gender should be "Male", "Female", or "Other".
    `;

        try {
            const result = await model.generateContent(prompt);
            const response = await result.response;
            const restext = response.text().replace(/```json/g, '').replace(/```/g, '').trim();
            return JSON.parse(restext);
        } catch (error) {
            console.error('[AIService] Error extracting info:', error);
            return { intent: 'unknown' };
        }
    }
}
