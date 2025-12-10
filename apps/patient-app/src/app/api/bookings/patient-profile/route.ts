import { NextRequest, NextResponse } from 'next/server';
import {
  getFirestore,
  doc,
  setDoc,
  collection,
  addDoc,
  serverTimestamp,
  getDoc,
} from 'firebase/firestore/lite';
import { getServerFirebaseApp } from '@/lib/firebase-server-app';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 200,
    headers: corsHeaders,
  });
}

export async function POST(request: NextRequest) {
  try {
    const firestore = getFirestore(getServerFirebaseApp());
    const { userId, patientData } = await request.json();

    if (!userId || !patientData) {
      return NextResponse.json(
        { error: 'userId and patientData are required' },
        { status: 400, headers: corsHeaders }
      );
    }

    const patientsRef = collection(firestore, 'patients');
    const newPatientRef = await addDoc(patientsRef, {
      ...patientData,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    await setDoc(
      doc(firestore, 'users', userId),
      {
        patientId: newPatientRef.id,
        phone: patientData.phone ?? null,
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    );

    const patientSnap = await getDoc(newPatientRef);

    return NextResponse.json(
      { patient: { id: newPatientRef.id, ...patientSnap.data() } },
      { headers: corsHeaders }
    );
  } catch (error) {
    console.error('[patient-profile] Failed to create patient profile', error);
    return NextResponse.json(
      { error: 'Failed to create patient profile' },
      { status: 500, headers: corsHeaders }
    );
  }
}









