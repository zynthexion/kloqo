
import { db } from '@kloqo/shared-firebase';
import { collection, getDocs, writeBatch } from 'firebase/firestore';
import { NextResponse } from 'next/server';

export async function GET() {
    console.log('API-CLEAR: Starting clear of appointments collection...');
    try {
        const appointmentsRef = collection(db, 'appointments');
        const snapshot = await getDocs(appointmentsRef);

        const dbAny = db as any;
        console.log('API-CLEAR: Firestore Status', {
            projectId: dbAny._databaseId?.projectId,
            databaseId: dbAny._databaseId?.database,
            isUsingEmulator: !!dbAny._settings?.host?.includes('localhost') || !!dbAny._settings?.host?.includes('127.0.0.1'),
            host: dbAny._settings?.host
        });

        console.log(`API-CLEAR: Found ${snapshot.docs.length} appointments.`);

        const batch = writeBatch(db);
        const deletedIds: string[] = [];

        snapshot.docs.forEach(docSnap => {
            batch.delete(docSnap.ref);
            deletedIds.push(docSnap.id);
        });

        await batch.commit();
        console.log(`API-CLEAR: Successfully deleted appointments:`, deletedIds);

        return NextResponse.json({
            success: true,
            count: snapshot.docs.length,
            projectId: (db as any)._databaseId.projectId,
            deletedIds
        });
    } catch (error: any) {
        console.error('API-CLEAR: Error during clear:', error);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}
