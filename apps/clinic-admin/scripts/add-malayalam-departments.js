const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const fs = require('fs');
const path = require('path');

// Load .env.local file manually (more reliable than dotenv)
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

// Department Malayalam translations
const departmentTranslations = {
    'General Medicine': 'സാമാന്യ വൈദ്യ വിദഗ്ധൻ',
    'Cardiology': 'ഹൃദ്രോഗ വിദഗ്ധൻ',
    'Pediatrics': 'ശിശുരോഗ വിദഗ്ധൻ',
    'Dermatology': 'ത്വക്രോഗ വിദഗ്ധൻ',
    'Neurology': 'നാഡീരോഗ വിദഗ്ധൻ',
    'Orthopedics': 'അസ്ഥിരോഗ വിദഗ്ധൻ',
    'Oncology': 'അർബുദ രോഗ വിദഗ്ധൻ',
    'OB/GYN': 'സ്ത്രീരോഗ-പ്രസവ വിദഗ്ധൻ',
    'Gastroenterology': 'അമാശയ-ആന്ത്രരോഗ വിദഗ്ധൻ',
    'Pulmonology': 'ശ്വാസകോശ രോഗ വിദഗ്ധൻ',
    'Endocrinology': 'അന്തഃസ്രാവ രോഗ വിദഗ്ധൻ',
    'Nephrology': 'വൃക്ക രോഗ വിദഗ്ധൻ',
    'Urology': 'മൂത്രവ്യവസ്ഥാ രോഗ വിദഗ്ധൻ',
    'Ophthalmology': 'നെത്രരോഗ വിദഗ്ധൻ',
    'ENT': 'ചെവി മൂക്ക് തൊണ്ട രോഗ വിദഗ്ധൻ',
    'Psychiatry': 'മനഃരോഗ വിദഗ്ധൻ',
    'Rheumatology': 'സന്ധി രോഗ വിദഗ്ധൻ',
    'Radiology': 'വികിരണ രോഗനിർണയ വിദഗ്ധൻ',
    'Anesthesiology': 'മയക്കു വൈദ്യ വിദഗ്ധൻ',
    'Dentistry': 'ദന്ത വൈദ്യ വിദഗ്ധൻ',
    'Emergency Medicine': 'അടിയന്തര വൈദ്യ വിദഗ്ധൻ',
    'Geriatrics': 'വൃദ്ധരോഗ വിദഗ്ധൻ',
    'Hematology': 'രക്തരോഗ വിദഗ്ധൻ',
    'Infectious Disease': 'സാംക്രമിക രോഗ വിദഗ്ധൻ',
    'Plastic Surgery': 'പ്ലാസ്റ്റിക് ശസ്ത്രക്രിയ വിദഗ്ധൻ',
    'Physiotherapy': 'ഭൗതിക ചികിത്സ വിദഗ്ധൻ'
  };
  

// Department description Malayalam translations
const descriptionTranslations = {
  'General Medicine': 'വയോജീർണരായവർക്കുള്ള സമഗ്ര പ്രാഥമിക സംരക്ഷണം, രോഗപ്രതിരോധത്തിലും ആരോഗ്യപ്രോത്സാഹനത്തിലും ശ്രദ്ധയോടെ.',
  'Cardiology': 'ഹൃദയത്തിന്റെയും രക്തനാളങ്ങളുടെയും രോഗങ്ങൾക്കുള്ള സമർപ്പിത സംരക്ഷണം.',
  'Pediatrics': 'ശിശുക്കൾ, കുട്ടികൾ, കൗമാരക്കാർ എന്നിവർക്കുള്ള വൈദ്യ സംരക്ഷണം.',
  'Dermatology': 'തൊലി, മുടി, നഖം എന്നിവയുടെ വൈകല്യങ്ങൾക്കുള്ള ചികിത്സ.',
  'Neurology': 'മസ്തിഷ്കവും വെല്ലുമുള്ളും ഉൾപ്പെടെയുള്ള നാഡീവ്യവസ്ഥയുടെ വൈകല്യങ്ങൾക്കുള്ള സംരക്ഷണം.',
  'Orthopedics': 'അസ്ഥികളും സന്ധികളും ഉൾപ്പെടെയുള്ള അസ്ഥികൂടത്തിന്റെ ചികിത്സ.',
  'Oncology': 'അർബുദത്തിന്റെ നിർണയവും ചികിത്സയും.',
  'OB/GYN': 'ഗർഭധാരണവും പ്രസവവും ഉൾപ്പെടെയുള്ള സ്ത്രീകളുടെ ആരോഗ്യ സേവനങ്ങൾ.',
  'Gastroenterology': 'ദഹനവ്യവസ്ഥയുടെയും അതിന്റെ വൈകല്യങ്ങളുടെയും സംരക്ഷണം.',
  'Pulmonology': 'ശ്വാസകോശത്തിന്റെയും ശ്വസനനാളങ്ങളുടെയും രോഗങ്ങൾ പ്രത്യേകം പഠിക്കുന്നു.',
  'Endocrinology': 'ഹോർമോൺ അസന്തുലിതാവസ്ഥയുടെയും രോഗങ്ങളുടെയും ചികിത്സ.',
  'Nephrology': 'വൃക്ക സംരക്ഷണവും രോഗങ്ങളും പ്രത്യേകം പഠിക്കുന്നു.',
  'Urology': 'മൂത്രനാളത്തിന്റെയും പുരുഷ പ്രജനന വ്യവസ്ഥയുടെയും സംരക്ഷണം.',
  'Ophthalmology': 'കണ്ണിന്റെയും കാഴ്ചയുടെയും സമഗ്ര സംരക്ഷണം.',
  'ENT': 'ചെവി, മൂക്ക്, തൊണ്ട എന്നിവയുടെ വൈകല്യങ്ങൾക്കുള്ള ചികിത്സ.',
  'Psychiatry': 'മാനസികാരോഗ്യ സംരക്ഷണവും വൈകാരിക വൈകല്യങ്ങളുടെ ചികിത്സയും.',
  'Rheumatology': 'റൂമറ്റിക് രോഗങ്ങളുടെ നിർണയവും തെറാപ്പിയും.',
  'Radiology': 'രോഗങ്ങൾ നിർണയിക്കാനും ചികിത്സിക്കാനുമുള്ള വൈദ്യ ഇമേജിംഗ്.',
  'Anesthesiology': 'വേദനയും ശസ്ത്രക്രിയയ്ക്ക് മുമ്പും, സമയത്തും, ശേഷവും രോഗിക്ക് മൊത്തം സംരക്ഷണവും.',
  'Dentistry': 'വായിലെ ദ്വാരത്തിന്റെ രോഗങ്ങളുടെയും വൈകല്യങ്ങളുടെയും നിർണയം, ചികിത്സ, പ്രതിരോധം.',
  'Emergency Medicine': 'തീവ്രമായ രോഗങ്ങളോ പരിക്കുകളോ ഉള്ള രോഗികൾക്ക് ഉടനടി വൈദ്യ സംരക്ഷണം ആവശ്യമാണ്.',
  'Geriatrics': 'വൃദ്ധരുടെ ആരോഗ്യ സംരക്ഷണം.',
  'Hematology': 'രക്തം, രക്തം രൂപപ്പെടുത്തുന്ന അവയവങ്ങൾ, രക്ത രോഗങ്ങൾ എന്നിവയുടെ ചികിത്സ.',
  'Infectious Disease': 'സങ്കീർണ്ണമായ രോഗാണുക്കളുടെ നിർണയവും ചികിത്സയും.',
  'Plastic Surgery': 'മുഖവും ശരീരവും വൈകല്യങ്ങൾ പുനർനിർമ്മിക്കുന്നതിനായി സമർപ്പിച്ച ശസ്ത്രക്രിയാ വിദ്യ.',
  'Physiotherapy': 'പരിക്കോ വൈകല്യമോ ബാധിച്ചാൽ ചലനവും പ്രവർത്തനവും വീണ്ടെടുക്കാൻ സഹായിക്കുന്നു.'
};

// Initialize Firebase Admin SDK
let adminInitialized = false;

// Method 1: Try service account key file
if (process.env.GOOGLE_APPLICATION_CREDENTIALS && fs.existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS)) {
  try {
    const admin = require('firebase-admin');
    initializeApp({
      credential: admin.credential.applicationDefault(),
    });
    adminInitialized = true;
    console.log('✅ Firebase Admin initialized with service account key file');
  } catch (error) {
    console.warn('⚠️  Failed to initialize with service account key file:', error.message);
  }
}

// Method 2: Try environment variables (from .env.local)
if (!adminInitialized) {
  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL || process.env.NEXT_PUBLIC_FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY || process.env.NEXT_PUBLIC_FIREBASE_PRIVATE_KEY;

  if (projectId && clientEmail && privateKey) {
    try {
      initializeApp({
        credential: cert({
          projectId: projectId,
          clientEmail: clientEmail,
          privateKey: privateKey.replace(/\\n/g, '\n'),
        }),
      });
      adminInitialized = true;
      console.log('✅ Firebase Admin initialized with environment variables');
    } catch (error) {
      console.warn('⚠️  Failed to initialize with environment variables:', error.message);
    }
  }
}

// Method 3: Try default credentials with explicit project ID
if (!adminInitialized) {
  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  if (projectId) {
    try {
      initializeApp({
        projectId: projectId,
      });
      adminInitialized = true;
      console.log('✅ Firebase Admin initialized with project ID');
    } catch (e) {
      if (e.code !== 'app/duplicate-app') {
        console.warn('⚠️  Failed to initialize with project ID:', e.message);
      } else {
        adminInitialized = true;
      }
    }
  }
}

// Final fallback
if (!adminInitialized) {
  try {
    initializeApp();
    adminInitialized = true;
    console.log('✅ Firebase Admin initialized with default credentials');
  } catch(e) {
    if (e.code !== 'app/duplicate-app') {
      console.error("❌ Firebase Admin initialization error:", e.message);
      console.error("\n💡 To fix this:");
      console.error("   1. Set GOOGLE_APPLICATION_CREDENTIALS environment variable pointing to serviceAccountKey.json");
      console.error("   OR");
      console.error("   2. Add to .env.local:");
      console.error("      NEXT_PUBLIC_FIREBASE_PROJECT_ID=your-project-id");
      console.error("      FIREBASE_CLIENT_EMAIL=your-service-account-email");
      console.error("      FIREBASE_PRIVATE_KEY=\"your-private-key\"");
      throw e;
    }
    adminInitialized = true;
  }
}

const db = getFirestore();

async function addMalayalamToDepartments() {
  try {
    console.log('🚀 Starting to add Malayalam translations...');

    console.log('📋 Fetching departments from master-departments collection...');
    const departmentsSnapshot = await db.collection('master-departments').get();

    if (departmentsSnapshot.empty) {
      console.log('❌ No departments found in master-departments collection');
      return;
    }

    console.log(`📦 Found ${departmentsSnapshot.docs.length} departments`);
    let updated = 0;
    let skipped = 0;

    for (const deptDoc of departmentsSnapshot.docs) {
      const data = deptDoc.data();
      const englishName = data.name;
      const deptId = deptDoc.id;

      if (!englishName) {
        console.log(`⚠️  Skipping ${deptId} - no name field`);
        skipped++;
        continue;
      }

      const malayalamName = departmentTranslations[englishName];
      const malayalamDescription = descriptionTranslations[englishName];

      if (!malayalamName) {
        console.log(`⚠️  Skipping ${deptId} (${englishName}) - no Malayalam translation found`);
        skipped++;
        continue;
      }

      // Update the document with Malayalam fields
      const updateData = {
        name_ml: malayalamName,
      };

      if (malayalamDescription) {
        updateData.description_ml = malayalamDescription;
      }

      await db.collection('master-departments').doc(deptId).update(updateData);
      console.log(`✅ Updated ${deptId}: ${englishName} -> ${malayalamName}`);
      updated++;
    }

    console.log('\n📊 Summary:');
    console.log(`✅ Updated: ${updated}`);
    console.log(`⚠️  Skipped: ${skipped}`);
    console.log(`\n🎉 Done! Malayalam translations added to departments.`);
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

// Run the script
addMalayalamToDepartments();

