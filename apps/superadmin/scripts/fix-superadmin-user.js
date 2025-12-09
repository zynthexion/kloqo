/**
 * Script to fix/create a SuperAdmin user in Firestore
 * 
 * This script can:
 * 1. Create a new SuperAdmin user (email + password)
 * 2. Fix an existing Firebase Auth user by adding the Firestore document
 * 
 * Usage:
 * 
 * Option 1: Create new user
 *   node scripts/fix-superadmin-user.js --create <email> <password>
 * 
 * Option 2: Fix existing user (add Firestore document)
 *   node scripts/fix-superadmin-user.js --fix <email>
 * 
 * Option 3: Fix by UID (if you know the UID)
 *   node scripts/fix-superadmin-user.js --fix-uid <uid>
 */

const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

// Try to load service account key from clinic-admin (shared credentials)
const clinicAdminKeyPath = path.join(__dirname, '..', '..', 'kloqo-clinic-admin', 'service-account-key.json');
const superAdminKeyPath = path.join(__dirname, '..', 'service-account-key.json');

let serviceAccount = null;

// Try to load service account key
if (fs.existsSync(clinicAdminKeyPath)) {
  serviceAccount = require(clinicAdminKeyPath);
  console.log('✓ Using service account key from clinic-admin');
} else if (fs.existsSync(superAdminKeyPath)) {
  serviceAccount = require(superAdminKeyPath);
  console.log('✓ Using service account key from superadmin');
} else {
  // Try environment variables
  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL || process.env.NEXT_PUBLIC_FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY || process.env.NEXT_PUBLIC_FIREBASE_PRIVATE_KEY;

  if (projectId && clientEmail && privateKey) {
    serviceAccount = {
      project_id: projectId,
      client_email: clientEmail,
      private_key: privateKey.replace(/\\n/g, '\n'),
    };
    console.log('✓ Using service account from environment variables');
  } else {
    console.error('❌ Error: Service account key not found.');
    console.error('Please either:');
    console.error('1. Copy service-account-key.json to kloqo-superadmin/');
    console.error('2. Or use the one from kloqo-clinic-admin/service-account-key.json');
    console.error('3. Or set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY environment variables');
    process.exit(1);
  }
}

// Initialize Firebase Admin
try {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  console.log('✓ Firebase Admin initialized');
} catch (error) {
  console.error('❌ Failed to initialize Firebase Admin:', error.message);
  process.exit(1);
}

const db = admin.firestore();
const auth = admin.auth();

async function createSuperAdmin(email, password) {
  try {
    console.log(`\n📧 Creating SuperAdmin user: ${email}`);

    // Create user in Firebase Authentication
    const userRecord = await auth.createUser({
      email,
      password,
      emailVerified: true,
    });

    console.log('✓ User created in Firebase Authentication');
    console.log(`  UID: ${userRecord.uid}`);

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
    console.log(`   Email: ${email}`);
    console.log(`   UID: ${userRecord.uid}`);
    console.log('\n🔐 You can now log in to the SuperAdmin app with these credentials.');

    return userRecord;
  } catch (error) {
    if (error.code === 'auth/email-already-exists') {
      console.error(`❌ User with email ${email} already exists in Firebase Auth.`);
      console.error('   Use --fix option to add Firestore document instead.');
      throw error;
    }
    console.error('❌ Error creating SuperAdmin user:', error.message);
    throw error;
  }
}

async function fixExistingUser(email) {
  try {
    console.log(`\n🔧 Fixing existing user: ${email}`);

    // Get user by email
    const userRecord = await auth.getUserByEmail(email);
    console.log(`✓ Found user in Firebase Auth`);
    console.log(`  UID: ${userRecord.uid}`);
    console.log(`  Email: ${userRecord.email}`);
    console.log(`  Email Verified: ${userRecord.emailVerified}`);

    // Check if Firestore document exists
    const userDocRef = db.collection('users').doc(userRecord.uid);
    const userDoc = await userDocRef.get();

    if (userDoc.exists()) {
      const existingData = userDoc.data();
      console.log(`\n⚠️  User document already exists in Firestore!`);
      console.log(`   Current role: ${existingData.role || 'none'}`);
      
      if (existingData.role !== 'superAdmin') {
        // Update role to superAdmin
        await userDocRef.update({
          role: 'superAdmin',
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        console.log(`✓ Updated role to superAdmin`);
      } else {
        console.log(`✓ Role is already superAdmin`);
      }
    } else {
      // Create Firestore document
      await userDocRef.set({
        uid: userRecord.uid,
        email: userRecord.email,
        role: 'superAdmin',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      console.log(`✓ Created user document in Firestore with superAdmin role`);
    }

    console.log('\n✅ User fixed successfully!');
    console.log(`   Email: ${userRecord.email}`);
    console.log(`   UID: ${userRecord.uid}`);
    console.log(`   Role: superAdmin`);
    console.log('\n🔐 You can now log in to the SuperAdmin app.');

    return userRecord;
  } catch (error) {
    if (error.code === 'auth/user-not-found') {
      console.error(`❌ User with email ${email} not found in Firebase Auth.`);
      console.error('   Use --create option to create a new user instead.');
      throw error;
    }
    console.error('❌ Error fixing user:', error.message);
    throw error;
  }
}

async function fixByUid(uid) {
  try {
    console.log(`\n🔧 Fixing user by UID: ${uid}`);

    // Get user by UID
    const userRecord = await auth.getUser(uid);
    console.log(`✓ Found user in Firebase Auth`);
    console.log(`  UID: ${userRecord.uid}`);
    console.log(`  Email: ${userRecord.email}`);

    // Create or update Firestore document
    const userDocRef = db.collection('users').doc(uid);
    await userDocRef.set({
      uid: userRecord.uid,
      email: userRecord.email,
      role: 'superAdmin',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    console.log(`✓ Created/updated user document in Firestore with superAdmin role`);
    console.log('\n✅ User fixed successfully!');
    console.log(`   Email: ${userRecord.email}`);
    console.log(`   UID: ${userRecord.uid}`);
    console.log(`   Role: superAdmin`);
    console.log('\n🔐 You can now log in to the SuperAdmin app.');

    return userRecord;
  } catch (error) {
    if (error.code === 'auth/user-not-found') {
      console.error(`❌ User with UID ${uid} not found in Firebase Auth.`);
      throw error;
    }
    console.error('❌ Error fixing user:', error.message);
    throw error;
  }
}

// Parse command line arguments
const args = process.argv.slice(2);
const command = args[0];

if (command === '--create') {
  const email = args[1];
  const password = args[2];
  
  if (!email || !password) {
    console.error('❌ Usage: node scripts/fix-superadmin-user.js --create <email> <password>');
    console.error('   Example: node scripts/fix-superadmin-user.js --create admin@kloqo.com SecurePassword123!');
    process.exit(1);
  }
  
  createSuperAdmin(email, password)
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('\n❌ Failed to create SuperAdmin:', error.message);
      process.exit(1);
    });
    
} else if (command === '--fix') {
  const email = args[1];
  
  if (!email) {
    console.error('❌ Usage: node scripts/fix-superadmin-user.js --fix <email>');
    console.error('   Example: node scripts/fix-superadmin-user.js --fix admin@kloqo.com');
    process.exit(1);
  }
  
  fixExistingUser(email)
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('\n❌ Failed to fix user:', error.message);
      process.exit(1);
    });
    
} else if (command === '--fix-uid') {
  const uid = args[1];
  
  if (!uid) {
    console.error('❌ Usage: node scripts/fix-superadmin-user.js --fix-uid <uid>');
    console.error('   Example: node scripts/fix-superadmin-user.js --fix-uid abc123xyz');
    process.exit(1);
  }
  
  fixByUid(uid)
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('\n❌ Failed to fix user:', error.message);
      process.exit(1);
    });
    
} else {
  console.error('❌ Invalid command');
  console.error('\nUsage:');
  console.error('  Create new user:');
  console.error('    node scripts/fix-superadmin-user.js --create <email> <password>');
  console.error('\n  Fix existing user (by email):');
  console.error('    node scripts/fix-superadmin-user.js --fix <email>');
  console.error('\n  Fix existing user (by UID):');
  console.error('    node scripts/fix-superadmin-user.js --fix-uid <uid>');
  console.error('\nExamples:');
  console.error('  node scripts/fix-superadmin-user.js --create admin@kloqo.com SecurePass123!');
  console.error('  node scripts/fix-superadmin-user.js --fix admin@kloqo.com');
  console.error('  node scripts/fix-superadmin-user.js --fix-uid QW3TUPEXcfeNDv3Y5miGUjbqfcl1');
  process.exit(1);
}

