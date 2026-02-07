
import { Firestore, collection, doc, setDoc, serverTimestamp, getDoc, deleteDoc } from 'firebase/firestore';

import { v4 as uuidv4 } from 'uuid';

export interface MagicLink {
    id: string;
    token: string;
    phone: string;
    redirectPath: string;
    expiresAt: any;
    createdAt: any;
}

export class MagicLinkService {
    /**
     * Generates a short-lived magic token for a user.
     * @returns The unique token string.
     */
    static async generateToken(
        firestore: Firestore,
        phone: string,
        redirectPath: string = '/home'
    ): Promise<string> {
        const token = uuidv4();
        const docId = `ml_${token}`;
        const mlRef = doc(firestore, 'magic_links', docId);

        // Expires in 24 hours
        const expiresAt = new Date();
        expiresAt.setHours(expiresAt.getHours() + 24);

        await setDoc(mlRef, {
            token,
            phone: phone.replace(/\D/g, '').slice(-10), // Store normalized 10-digit phone
            redirectPath,
            expiresAt,
            createdAt: serverTimestamp()
        });

        return token;
    }



    /**
     * Verifies a magic token and returns the associated phone and redirect path.
     * Deletes the token after verification (one-time use).
     */
    static async verifyToken(
        firestore: Firestore,
        token: string
    ): Promise<{ phone: string; redirectPath: string } | null> {
        const docId = `ml_${token}`;
        const mlRef = doc(firestore, 'magic_links', docId);
        const mlSnap = await getDoc(mlRef);

        if (!mlSnap.exists()) {
            return null;
        }

        const data = mlSnap.data();
        const expiresAt = data.expiresAt.toDate();

        if (new Date() > expiresAt) {
            await deleteDoc(mlRef);
            return null;
        }

        // Cleanup after use
        await deleteDoc(mlRef);

        return {
            phone: data.phone,
            redirectPath: data.redirectPath
        };
    }
}
