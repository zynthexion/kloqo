
import { GoogleGenerativeAI } from '@google/generative-ai';

// Initialize Gemini with API Key (Needs to be in env)
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

export class AIService {
    private static model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

    /**
     * Generates a helpful response for a patient based on clinic context.
     */
    static async generatePatientResponse(
        clinicName: string,
        doctorName: string,
        doctorStatus: string,
        queueLength: number,
        operatingHours: string,
        userQuery: string
    ): Promise<string> {
        if (!process.env.GEMINI_API_KEY) {
            console.warn('GEMINI_API_KEY not found. Returning fallback response.');
            return "I'm currently undergoing maintenance to serve you better. Please type 'Book' to schedule an appointment manually.";
        }

        const prompt = `
      You are a smart, friendly receptionist for "${clinicName}".
      
      Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}
      
      Clinic Status:
      - Doctor: ${doctorName}
      - Doctor Status: ${doctorStatus}
      - Patients Waiting: ${queueLength}
      - Operating Hours: ${operatingHours}
      
      User Query: "${userQuery}"
      
      Guidelines:
      1. Answer based ONLY on the status provided.
      2. If the user asks to book, guide them to type "Book".
      3. Reply in the same language (Malayalam/English) as the query.
      4. Keep it concise (max 2 sentences).
    `;

        try {
            const result = await this.model.generateContent(prompt);
            const response = await result.response;
            return response.text();
        } catch (error) {
            console.error('Gemini API Error:', error);
            return "I'm sorry, I'm having trouble connecting to the system right now. Please try again or type 'Book' to schedule an appointment.";
        }
    }
}
