import { NextRequest, NextResponse } from 'next/server';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';

const serviceAccountJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

if (!serviceAccountJson) {
  throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_JSON environment variable for Firebase Admin credentials.');
}

const parsedServiceAccount = JSON.parse(serviceAccountJson);

const serviceAccountParams = {
  projectId: parsedServiceAccount.project_id,
  clientEmail: parsedServiceAccount.client_email,
  privateKey: parsedServiceAccount.private_key?.replace(/\\n/g, '\n'),
};

export async function POST(request: NextRequest) {
  try {
    // Initialize Firebase Admin SDK
    if (getApps().length === 0) {
      initializeApp({
        credential: cert(serviceAccountParams),
        storageBucket: 'kloqo-clinic-multi-33968-4c50b.firebasestorage.app',
      });
    }

    const formData = await request.formData();
    const file = formData.get('file') as File;
    const userId = formData.get('userId') as string;
    const documentType = formData.get('documentType') as string; // 'logo', 'license', 'reception_photo'

    if (!file || !userId || !documentType) {
      return NextResponse.json({ 
        error: 'Missing required fields',
        received: { hasFile: !!file, hasUserId: !!userId, hasDocumentType: !!documentType }
      }, { status: 400 });
    }

    // Validate document type
    const validTypes = ['logo', 'license', 'reception_photo'];
    if (!validTypes.includes(documentType)) {
      return NextResponse.json({ 
        error: 'Invalid document type. Must be one of: logo, license, reception_photo' 
      }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    
    // Map document type to file path
    const pathMap: Record<string, string> = {
      'logo': 'logo',
      'license': 'license',
      'reception_photo': 'reception_photo'
    };
    
    const filePath = `clinics/${userId}/documents/${pathMap[documentType]}`;
    
    try {
      const bucket = getStorage().bucket('kloqo-clinic-multi-33968-4c50b.firebasestorage.app');
      const fileRef = bucket.file(filePath);

      await fileRef.save(buffer, {
        contentType: file.type,
        metadata: {
          metadata: {
            uploadedBy: userId,
            documentType: documentType,
          },
        },
      });

      // Make the file publicly accessible
      await fileRef.makePublic();
      
      // Get the public URL
      const publicUrl = `https://storage.googleapis.com/${bucket.name}/${filePath}`;

      return NextResponse.json({
        url: publicUrl,
        filePath: filePath,
        bucket: bucket.name,
        documentType: documentType
      });

    } catch (storageError: any) {
      console.error('Firebase Storage Error:', storageError);
      return NextResponse.json({ 
        error: `Firebase Storage Error: ${storageError.message}`,
        details: storageError.code
      }, { status: 500 });
    }

  } catch (error: any) {
    console.error('Upload API Error:', error);
    return NextResponse.json({
      error: 'Internal server error',
      message: error.message || 'An unknown error occurred',
      details: error.toString()
    }, { status: 500 });
  }
}

