import { NextRequest, NextResponse } from 'next/server';
import { getFirestore, doc, getDoc, setDoc, collection, query, where, getDocs } from 'firebase/firestore/lite';
import { getServerFirebaseApp } from '@/lib/firebase-server-app';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 200,
    headers: corsHeaders,
  });
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
  try {
    const { userId } = await params;
    const firestore = getFirestore(getServerFirebaseApp());
    const userRef = doc(firestore, 'users', userId);
    const userSnap = await getDoc(userRef);

    if (!userSnap.exists()) {
      return NextResponse.json(
        { error: 'User not found' },
        {
          status: 404,
          headers: corsHeaders,
        }
      );
    }

    return NextResponse.json(
      { user: userSnap.data() },
      {
        headers: corsHeaders,
      }
    );
  } catch (error) {
    console.error('[users] Failed to fetch user', error);
    return NextResponse.json(
      { error: 'Failed to load user' },
      {
        status: 500,
        headers: corsHeaders,
      }
    );
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
  try {
    const { userId } = await params;
    const firestore = getFirestore(getServerFirebaseApp());
    const userRef = doc(firestore, 'users', userId);
    const payload = await request.json();

    await setDoc(
      userRef,
      {
        ...payload,
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    );

    return NextResponse.json(
      { success: true },
      {
        headers: corsHeaders,
      }
    );
  } catch (error) {
    console.error('[users] Failed to update user', error);
    return NextResponse.json(
      { error: 'Failed to update user' },
      {
        status: 500,
        headers: corsHeaders,
      }
    );
  }
}

