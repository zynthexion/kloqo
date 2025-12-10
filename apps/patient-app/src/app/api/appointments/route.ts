import { NextRequest, NextResponse } from 'next/server';
import { getFirestore, collection, query, where, getDocs, doc, getDoc } from 'firebase/firestore/lite';
import { getServerFirebaseApp } from '@/lib/firebase-server-app';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const chunkArray = <T,>(arr: T[], size: number) =>
  Array.from({ length: Math.ceil(arr.length / size) }, (_, index) =>
    arr.slice(index * size, index * size + size)
  );

async function getFamilyPatientIds(firestore: ReturnType<typeof getFirestore>, patientId: string) {
  const patientRef = doc(firestore, 'patients', patientId);
  const patientSnap = await getDoc(patientRef);
  if (!patientSnap.exists()) return [];

  const data = patientSnap.data() as { relatedPatientIds?: string[] };
  return [patientId, ...(data.relatedPatientIds || [])].filter(Boolean);
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 200,
    headers: corsHeaders,
  });
}

export async function GET(request: NextRequest) {
  try {
    const patientId = request.nextUrl.searchParams.get('patientId');
    if (!patientId) {
      return NextResponse.json(
        { error: 'patientId is required' },
        { status: 400, headers: corsHeaders }
      );
    }

    const firestore = getFirestore(getServerFirebaseApp());
    const patientIds = await getFamilyPatientIds(firestore, patientId);

    if (patientIds.length === 0) {
      return NextResponse.json({ appointments: [] }, { headers: corsHeaders });
    }

    const chunks = chunkArray(patientIds, 30);
    const appointments: any[] = [];

    for (const chunk of chunks) {
      const apptRef = collection(firestore, 'appointments');
      const apptQuery = query(apptRef, where('patientId', 'in', chunk));
      const snapshot = await getDocs(apptQuery);
      appointments.push(
        ...snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        }))
      );
    }

    return NextResponse.json(
      { appointments },
      {
        headers: corsHeaders,
      }
    );
  } catch (error) {
    console.error('[appointments] Failed to fetch appointments', error);
    return NextResponse.json(
      { error: 'Failed to load appointments' },
      {
        status: 500,
        headers: corsHeaders,
      }
    );
  }
}

