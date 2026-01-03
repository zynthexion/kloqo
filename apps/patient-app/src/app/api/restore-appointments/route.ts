
import { db } from '@kloqo/shared-firebase';
import { collection, doc, writeBatch, Timestamp } from 'firebase/firestore';
import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

function convertToTimestamps(obj: any): any {
    if (obj === null || obj === undefined) return obj;

    if (typeof obj === 'object') {
        if (obj.type === 'firestore/timestamp/1.0') {
            return new Timestamp(obj.seconds, obj.nanoseconds);
        }

        if (Array.isArray(obj)) {
            return obj.map(item => convertToTimestamps(item));
        }

        const newObj: any = {};
        for (const key in obj) {
            newObj[key] = convertToTimestamps(obj[key]);
        }
        return newObj;
    }

    return obj;
}

export async function GET() {
    console.log('API-RESTORE: Starting restoration of appointments collection...');
    try {
        const backupFile = 'backup_appointments.json';
        const backupPath = path.join(process.cwd(), '..', '..', backupFile);

        if (!fs.existsSync(backupPath)) {
            throw new Error(`Backup file not found at ${backupPath}`);
        }

        const rawData = fs.readFileSync(backupPath, 'utf8');
        const appointments = JSON.parse(rawData);

        console.log(`API-RESTORE: Read ${appointments.length} appointments from backup.`);

        const batch = writeBatch(db);
        const appointmentsRef = collection(db, 'appointments');

        appointments.forEach((appt: any) => {
            const { id, ...data } = appt;
            const processedData = convertToTimestamps(data);
            const docRef = doc(appointmentsRef, id);
            batch.set(docRef, processedData);
        });

        await batch.commit();
        console.log(`API-RESTORE: Successfully restored ${appointments.length} appointments.`);

        return NextResponse.json({
            success: true,
            count: appointments.length,
            projectId: (db as any)._databaseId.projectId
        });
    } catch (error: any) {
        console.error('API-RESTORE: Error during restoration:', error);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}
