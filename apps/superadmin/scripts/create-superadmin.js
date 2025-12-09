/**
 * Script to create the first SuperAdmin user
 * 
 * Usage:
 * 1. Create a .env.local file in the kloqo-superadmin folder with:
 *    NEXT_PUBLIC_FIREBASE_PROJECT_ID=your-project-id
 *    FIREBASE_CLIENT_EMAIL=your-service-account-email
 *    FIREBASE_PRIVATE_KEY="your-private-key"
 * 
 * 2. Or use a service account key file:
 *    GOOGLE_APPLICATION_CREDENTIALS=path/to/serviceAccountKey.json
 * 
 * 3. Run: node scripts/create-superadmin.js <email> <password>
 * 
 * Example: node scripts/create-superadmin.js admin@kloqo.com SecurePassword123!
 */

const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

// Load .env.local file if it exists
const envPath = path.join(__dirname, '..', '.env.local');
if (fs.existsSync(envPath)) {
  const envFile = fs.readFileSync(envPath, 'utf8');
  envFile.split('\n').forEach(line => {
    const match = line.match(/^([^=:#]+)=(.*)$/);
    if (match) {
      const key = match[1].trim();
      let value = match[2].trim();
      // Remove quotes if present
      if ((value.startsWith('"') && value.endsWith('"')) || 
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  });
  console.log('✓ Loaded .env.local file');
}

// Initialize Firebase Admin
let initialized = false;

// Method 1: Try service account key file
if (process.env.GOOGLE_APPLICATION_CREDENTIALS && fs.existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS)) {
  try {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
    });
    initialized = true;
    console.log('✓ Firebase Admin initialized with service account key file');
  } catch (error) {
    console.warn('⚠ Failed to initialize with service account key file:', error.message);
  }
}

// Method 2: Try environment variables (from .env.local or environment)
if (!initialized) {
  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL || process.env.NEXT_PUBLIC_FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY || process.env.NEXT_PUBLIC_FIREBASE_PRIVATE_KEY;

  if (projectId && clientEmail && privateKey) {
    try {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: projectId,
          clientEmail: clientEmail,
          privateKey: privateKey.replace(/\\n/g, '\n'),
        }),
      });
      initialized = true;
      console.log('✓ Firebase Admin initialized with environment variables');
    } catch (error) {
      console.warn('⚠ Failed to initialize with environment variables:', error.message);
    }
  }
}

// Method 3: Try default credentials (for Cloud Functions/App Engine)
if (!initialized) {
  try {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
    });
    initialized = true;
    console.log('✓ Firebase Admin initialized with default credentials');
  } catch (error) {
    console.error('❌ Failed to initialize with default credentials');
  }
}

// Final check
if (!initialized) {
  console.error('\n❌ Error: Firebase Admin SDK not initialized.');
  console.error('\nPlease set up credentials using one of these methods:');
  console.error('\n1. Create .env.local file with:');
  console.error('   NEXT_PUBLIC_FIREBASE_PROJECT_ID=your-project-id');
  console.error('   FIREBASE_CLIENT_EMAIL=your-service-account-email');
  console.error('   FIREBASE_PRIVATE_KEY="your-private-key"');
  console.error('\n2. Set GOOGLE_APPLICATION_CREDENTIALS environment variable');
  console.error('\n3. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY environment variables');
  process.exit(1);
}

const db = admin.firestore();
const auth = admin.auth();

async function createSuperAdmin(email, password) {
  try {
    console.log(`Creating SuperAdmin user: ${email}`);

    // Create user in Firebase Authentication
    const userRecord = await auth.createUser({
      email,
      password,
      emailVerified: true,
    });

    console.log('✓ User created in Firebase Authentication');

    // Create user document in Firestore with superAdmin role
    await db.collection('users').doc(userRecord.uid).set({
      uid: userRecord.uid,
      email: email,
      role: 'superAdmin',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log('✓ User document created in Firestore with superAdmin role');
    console.log('\n✅ SuperAdmin user created successfully!');
    console.log(`Email: ${email}`);
    console.log(`UID: ${userRecord.uid}`);
    console.log('\nYou can now log in to the SuperAdmin app with these credentials.');

    return userRecord;
  } catch (error) {
    console.error('Error creating SuperAdmin user:', error);
    throw error;
  }
}

// Get email and password from command line arguments
const email = process.argv[2];
const password = process.argv[3];

if (!email || !password) {
  console.error('Usage: node scripts/create-superadmin.js <email> <password>');
  console.error('Example: node scripts/create-superadmin.js admin@kloqo.com SecurePassword123!');
  process.exit(1);
}

createSuperAdmin(email, password)
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error('Failed to create SuperAdmin:', error);
    process.exit(1);
  });

