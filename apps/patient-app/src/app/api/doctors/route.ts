import { NextRequest, NextResponse } from 'next/server';
import { getFirestore, collection, getDocs, query, where } from 'firebase/firestore/lite';
import { getServerFirebaseApp } from '@/lib/firebase-server-app';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 200,
    headers: corsHeaders,
  });
}

const chunkArray = <T,>(arr: T[], size: number) =>
  Array.from({ length: Math.ceil(arr.length / size) }, (_, index) =>
    arr.slice(index * size, index * size + size)
  );

export async function GET(request: NextRequest) {
  try {
    const firestore = getFirestore(getServerFirebaseApp());
    const clinicIdsParam = request.nextUrl.searchParams.get('clinicIds');
    let doctors: any[] = [];

    if (clinicIdsParam) {
      const clinicIds = clinicIdsParam.split(',').map((id) => id.trim()).filter(Boolean);

      if (clinicIds.length === 0) {
        return NextResponse.json(
          { doctors: [] },
          {
            headers: corsHeaders,
          }
        );
      }

      const chunks = chunkArray(clinicIds, 10);
      for (const chunk of chunks) {
        const doctorsRef = collection(firestore, 'doctors');
        const doctorsQuery = query(doctorsRef, where('clinicId', 'in', chunk));
        const snapshot = await getDocs(doctorsQuery);
        doctors.push(
          ...snapshot.docs.map((doc) => ({
            id: doc.id,
            ...doc.data(),
          }))
        );
      }
    } else {
      const snapshot = await getDocs(collection(firestore, 'doctors'));
      doctors = snapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      }));
    }

    return NextResponse.json(
      { doctors },
      {
        headers: corsHeaders,
      }
    );
  } catch (error) {
    console.error('[doctors] Failed to fetch doctors', error);
    return NextResponse.json(
      { error: 'Failed to load doctors' },
      {
        status: 500,
        headers: corsHeaders,
      }
    );
  }
}

