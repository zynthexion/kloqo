import { NextRequest, NextResponse } from 'next/server';
import { getFirestore, collection, query, where, getDocs, doc, getDoc } from 'firebase/firestore/lite';
import { getServerFirebaseApp } from '@/lib/firebase-server-app';
import type { Patient } from '@/lib/types';

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

export async function GET(request: NextRequest) {
  try {
    const phone = request.nextUrl.searchParams.get('phone');

    if (!phone) {
      return NextResponse.json(
        { error: 'phone is required' },
        {
          status: 400,
          headers: corsHeaders,
        }
      );
    }

    const firestore = getFirestore(getServerFirebaseApp());
    const usersRef = collection(firestore, 'users');
    const usersQuery = query(usersRef, where('phone', '==', phone), where('role', '==', 'patient'));
    const usersSnapshot = await getDocs(usersQuery);

    if (usersSnapshot.empty) {
      return NextResponse.json(
        { primary: null, relatives: [] },
        {
          headers: corsHeaders,
        }
      );
    }

    const userDoc = usersSnapshot.docs[0];
    const userData = userDoc.data();
    const patientId = userData.patientId;

    if (!patientId) {
      return NextResponse.json(
        { primary: null, relatives: [] },
        {
          headers: corsHeaders,
        }
      );
    }

    const patientRef = doc(firestore, 'patients', patientId);
    const patientSnap = await getDoc(patientRef);

    if (!patientSnap.exists()) {
      return NextResponse.json(
        { primary: null, relatives: [] },
        {
          headers: corsHeaders,
        }
      );
    }

    const primary = { id: patientSnap.id, ...patientSnap.data(), isPrimary: true } as Patient & { id: string; isPrimary: boolean };
    let relatives: any[] = [];

    if (primary.relatedPatientIds && Array.isArray(primary.relatedPatientIds)) {
      const relativesPromises = primary.relatedPatientIds.map((id: string) =>
        getDoc(doc(firestore, 'patients', id))
      );
      const relativesDocs = await Promise.all(relativesPromises);
      relatives = relativesDocs
        .filter((docSnap) => docSnap.exists())
        .map((docSnap) => ({ id: docSnap.id, ...docSnap.data(), isPrimary: false }));
    }

    return NextResponse.json(
      { primary, relatives },
      {
        headers: corsHeaders,
      }
    );
  } catch (error) {
    console.error('[patients] Failed to fetch patient data', error);
    return NextResponse.json(
      { error: 'Failed to load patient data' },
      {
        status: 500,
        headers: corsHeaders,
      }
    );
  }
}

