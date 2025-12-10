import { NextResponse } from 'next/server';
import { getFirestore, collection, getDocs } from 'firebase/firestore/lite';
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

export async function GET() {
  try {
    const firestore = getFirestore(getServerFirebaseApp());
    const snapshot = await getDocs(collection(firestore, 'clinics'));

    const clinics = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    return NextResponse.json(
      { clinics },
      {
        headers: corsHeaders,
      }
    );
  } catch (error) {
    console.error('[clinics] Failed to fetch clinics', error);
    return NextResponse.json(
      { error: 'Failed to load clinics' },
      {
        status: 500,
        headers: corsHeaders,
      }
    );
  }
}









