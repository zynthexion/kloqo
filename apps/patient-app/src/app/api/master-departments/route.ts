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
    const snapshot = await getDocs(collection(firestore, 'master-departments'));

    const departments = snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        ...data,
      };
    });

    return NextResponse.json(
      { departments },
      {
        headers: corsHeaders,
      }
    );
  } catch (error) {
    console.error('[master-departments] Failed to fetch departments', error);
    return NextResponse.json(
      { error: 'Failed to load departments' },
      {
        status: 500,
        headers: corsHeaders,
      }
    );
  }
}

