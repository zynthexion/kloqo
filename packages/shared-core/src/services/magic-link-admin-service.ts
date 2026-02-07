
import * as admin from 'firebase-admin';
import { v4 as uuidv4 } from 'uuid';

export class MagicLinkAdminService {
    /**
     * Admin version of generateToken to bypass client side security rules.
     * Use only in server-side contexts (Next.js API routes, Cloud Functions).
     */
    static async generateTokenAdmin(
        firestore: admin.firestore.Firestore,
        phone: string,
        redirectPath: string = '/home'
    ): Promise<string> {
        const token = uuidv4();
        const docId = `ml_${token}`;
        const mlRef = firestore.collection('magic_links').doc(docId);

        // Expires in 24 hours
        const expiresAt = new Date();
        expiresAt.setHours(expiresAt.getHours() + 24);

        await mlRef.set({
            token,
            phone: phone.replace(/\D/g, '').slice(-10),
            redirectPath,
            expiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        return token;
    }
}
