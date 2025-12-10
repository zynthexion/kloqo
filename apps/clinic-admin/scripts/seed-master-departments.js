
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const fs = require('fs');
const path = require('path');

if (typeof window !== 'undefined') {
  throw new Error("This script should only be run in a Node.js environment.");
}

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

const masterDepartments = [
  {
    id: 'dept-01',
    name: 'General Medicine',
    name_ml: 'സാമാന്യ വൈദ്യ വിദഗ്ധൻ',
    description: 'Comprehensive primary care for adults, focusing on disease prevention and health promotion.',
    description_ml: 'വയോജീർണരായവർക്കുള്ള സമഗ്ര പ്രാഥമിക സംരക്ഷണം, രോഗപ്രതിരോധത്തിലും ആരോഗ്യപ്രോത്സാഹനത്തിലും ശ്രദ്ധയോടെ.',
    icon: 'Stethoscope',
    doctors: [],
  },
  {
    id: 'dept-02',
    name: 'Cardiology',
    name_ml: 'ഹൃദ്രോഗ വിദഗ്ധൻ',
    description: 'Specialized care for heart and blood vessel disorders.',
    description_ml: 'ഹൃദയത്തിന്റെയും രക്തനാളങ്ങളുടെയും രോഗങ്ങൾക്കുള്ള സമർപ്പിത സംരക്ഷണം.',
    icon: 'HeartPulse',
    doctors: [],
  },
  {
    id: 'dept-03',
    name: 'Pediatrics',
    name_ml: 'ശിശുരോഗ വിദഗ്ധൻ',
    description: 'Medical care for infants, children, and adolescents.',
    description_ml: 'ശിശുക്കൾ, കുട്ടികൾ, കൗമാരക്കാർ എന്നിവർക്കുള്ള വൈദ്യ സംരക്ഷണം.',
    icon: 'Baby',
    doctors: [],
  },
  {
    id: 'dept-04',
    name: 'Dermatology',
    name_ml: 'ത്വക്രോഗ വിദഗ്ധൻ',
    description: 'Treatment of skin, hair, and nail conditions.',
    description_ml: 'തൊലി, മുടി, നഖം എന്നിവയുടെ വൈകല്യങ്ങൾക്കുള്ള ചികിത്സ.',
    icon: 'Sparkles',
    doctors: [],
  },
  {
    id: 'dept-05',
    name: 'Neurology',
    name_ml: 'നാഡീരോഗ വിദഗ്ധൻ',
    description: 'Care for disorders of the nervous system, including brain and spinal cord.',
    description_ml: 'മസ്തിഷ്കവും വെല്ലുമുള്ളും ഉൾപ്പെടെയുള്ള നാഡീവ്യവസ്ഥയുടെ വൈകല്യങ്ങൾക്കുള്ള സംരക്ഷണം.',
    icon: 'BrainCircuit',
    doctors: [],
  },
  {
    id: 'dept-06',
    name: 'Orthopedics',
    name_ml: 'അസ്ഥിരോഗ വിദഗ്ധൻ',
    description: 'Treatment of the musculoskeletal system, including bones and joints.',
    description_ml: 'അസ്ഥികളും സന്ധികളും ഉൾപ്പെടെയുള്ള അസ്ഥികൂടത്തിന്റെ ചികിത്സ.',
    icon: 'Bone',
    doctors: [],
  },
  {
    id: 'dept-07',
    name: 'Oncology',
    name_ml: 'അർബുദ രോഗ വിദഗ്ധൻ',
    description: 'Diagnosis and treatment of cancer.',
    description_ml: 'അർബുദത്തിന്റെ നിർണയവും ചികിത്സയും.',
    icon: 'Award',
    doctors: [],
  },
  {
    id: 'dept-08',
    name: 'OB/GYN',
    name_ml: 'സ്ത്രീരോഗ-പ്രസവ വിദഗ്ധൻ',
    description: "Women's health services, including pregnancy and childbirth.",
    description_ml: 'ഗർഭധാരണവും പ്രസവവും ഉൾപ്പെടെയുള്ള സ്ത്രീകളുടെ ആരോഗ്യ സേവനങ്ങൾ.',
    icon: 'Pregnant',
    doctors: [],
  },
  {
    id: 'dept-09',
    name: 'Gastroenterology',
    name_ml: 'അമാശയ-ആന്ത്രരോഗ വിദഗ്ധൻ',
    description: 'Care for the digestive system and its disorders.',
    description_ml: 'ദഹനവ്യവസ്ഥയുടെയും അതിന്റെ വൈകല്യങ്ങളുടെയും സംരക്ഷണം.',
    icon: 'Microwave',
    doctors: [],
  },
  {
    id: 'dept-10',
    name: 'Pulmonology',
    name_ml: 'ശ്വാസകോശ രോഗ വിദഗ്ധൻ',
    description: 'Specializing in diseases of the lungs and respiratory tract.',
    description_ml: 'ശ്വാസകോശത്തിന്റെയും ശ്വസനനാളങ്ങളുടെയും രോഗങ്ങൾ പ്രത്യേകം പഠിക്കുന്നു.',
    icon: 'Wind',
    doctors: [],
  },
  {
    id: 'dept-11',
    name: 'Endocrinology',
    name_ml: 'അന്തഃസ്രാവ രോഗ വിദഗ്ധൻ',
    description: 'Treatment of hormonal imbalances and diseases.',
    description_ml: 'ഹോർമോൺ അസന്തുലിതാവസ്ഥയുടെയും രോഗങ്ങളുടെയും ചികിത്സ.',
    icon: 'Droplets',
    doctors: [],
  },
  {
    id: 'dept-12',
    name: 'Nephrology',
    name_ml: 'വൃക്ക രോഗ വിദഗ്ധൻ',
    description: 'Specializing in kidney care and diseases.',
    description_ml: 'വൃക്ക സംരക്ഷണവും രോഗങ്ങളും പ്രത്യേകം പഠിക്കുന്നു.',
    icon: 'Filter',
    doctors: [],
  },
  {
    id: 'dept-13',
    name: 'Urology',
    name_ml: 'മൂത്രവ്യവസ്ഥാ രോഗ വിദഗ്ധൻ',
    description: 'Care for the urinary tract and male reproductive system.',
    description_ml: 'മൂത്രനാളത്തിന്റെയും പുരുഷ പ്രജനന വ്യവസ്ഥയുടെയും സംരക്ഷണം.',
    icon: 'Droplet',
    doctors: [],
  },
  {
    id: 'dept-14',
    name: 'Ophthalmology',
    name_ml: 'നെത്രരോഗ വിദഗ്ധൻ',
    description: 'Comprehensive eye and vision care.',
    description_ml: 'കണ്ണിന്റെയും കാഴ്ചയുടെയും സമഗ്ര സംരക്ഷണം.',
    icon: 'Eye',
    doctors: [],
  },
  {
    id: 'dept-15',
    name: 'ENT',
    name_ml: 'ചെവി മൂക്ക് തൊണ്ട രോഗ വിദഗ്ധൻ',
    description: 'Treatment for ear, nose, and throat conditions.',
    description_ml: 'ചെവി, മൂക്ക്, തൊണ്ട എന്നിവയുടെ വൈകല്യങ്ങൾക്കുള്ള ചികിത്സ.',
    icon: 'Ear',
    doctors: [],
  },
  {
    id: 'dept-16',
    name: 'Psychiatry',
    name_ml: 'മനഃരോഗ വിദഗ്ധൻ',
    description: 'Mental health care and treatment of emotional disorders.',
    description_ml: 'മാനസികാരോഗ്യ സംരക്ഷണവും വൈകാരിക വൈകല്യങ്ങളുടെ ചികിത്സയും.',
    icon: 'Brain',
    doctors: [],
  },
  {
    id: 'dept-17',
    name: 'Rheumatology',
    name_ml: 'സന്ധി രോഗ വിദഗ്ധൻ',
    description: 'Diagnosis and therapy of rheumatic diseases.',
    description_ml: 'റൂമറ്റിക് രോഗങ്ങളുടെ നിർണയവും തെറാപ്പിയും.',
    icon: 'PersonStanding',
    doctors: [],
  },
  {
    id: 'dept-18',
    name: 'Radiology',
    name_ml: 'വികിരണ രോഗനിർണയ വിദഗ്ധൻ',
    description: 'Medical imaging to diagnose and treat diseases.',
    description_ml: 'രോഗങ്ങൾ നിർണയിക്കാനും ചികിത്സിക്കാനുമുള്ള വൈദ്യ ഇമേജിംഗ്.',
    icon: 'Radiation',
    doctors: [],
  },
  {
    id: 'dept-19',
    name: 'Anesthesiology',
    name_ml: 'മയക്കു വൈദ്യ വിദഗ്ധൻ',
    description: 'Management of pain and total care of the patient before, during and after surgery.',
    description_ml: 'വേദനയും ശസ്ത്രക്രിയയ്ക്ക് മുമ്പും, സമയത്തും, ശേഷവും രോഗിക്ക് മൊത്തം സംരക്ഷണവും.',
    icon: 'Siren',
    doctors: [],
  },
  {
    id: 'dept-20',
    name: 'Dentistry',
    name_ml: 'ദന്ത വൈദ്യ വിദഗ്ധൻ',
    description: 'Diagnosis, treatment, and prevention of diseases and conditions of the oral cavity.',
    description_ml: 'വായിലെ ദ്വാരത്തിന്റെ രോഗങ്ങളുടെയും വൈകല്യങ്ങളുടെയും നിർണയം, ചികിത്സ, പ്രതിരോധം.',
    icon: 'Tooth',
    doctors: [],
  },
  {
    id: 'dept-21',
    name: 'Emergency Medicine',
    name_ml: 'അടിയന്തര വൈദ്യ വിദഗ്ധൻ',
    description: 'Care for patients with acute illnesses or injuries which require immediate medical attention.',
    description_ml: 'തീവ്രമായ രോഗങ്ങളോ പരിക്കുകളോ ഉള്ള രോഗികൾക്ക് ഉടനടി വൈദ്യ സംരക്ഷണം ആവശ്യമാണ്.',
    icon: 'Ambulance',
    doctors: [],
  },
  {
    id: 'dept-22',
    name: 'Geriatrics',
    name_ml: 'വൃദ്ധരോഗ വിദഗ്ധൻ',
    description: 'Health care of elderly people.',
    description_ml: 'വൃദ്ധരുടെ ആരോഗ്യ സംരക്ഷണം.',
    icon: 'PersonStanding',
    doctors: [],
  },
  {
    id: 'dept-23',
    name: 'Hematology',
    name_ml: 'രക്തരോഗ വിദഗ്ധൻ',
    description: 'Treatment of blood, blood-forming organs, and blood diseases.',
    description_ml: 'രക്തം, രക്തം രൂപപ്പെടുത്തുന്ന അവയവങ്ങൾ, രക്ത രോഗങ്ങൾ എന്നിവയുടെ ചികിത്സ.',
    icon: 'TestTube',
    doctors: [],
  },
  {
    id: 'dept-24',
    name: 'Infectious Disease',
    name_ml: 'സാംക്രമിക രോഗ വിദഗ്ധൻ',
    description: 'Diagnosis and treatment of complex infections.',
    description_ml: 'സങ്കീർണ്ണമായ രോഗാണുക്കളുടെ നിർണയവും ചികിത്സയും.',
    icon: 'Bug',
    doctors: [],
  },
  {
    id: 'dept-25',
    name: 'Plastic Surgery',
    name_ml: 'പ്ലാസ്റ്റിക് ശസ്ത്രക്രിയ വിദഗ്ധൻ',
    description: 'Surgical specialty dedicated to reconstruction of facial and body defects.',
    description_ml: 'മുഖവും ശരീരവും വൈകല്യങ്ങൾ പുനർനിർമ്മിക്കുന്നതിനായി സമർപ്പിച്ച ശസ്ത്രക്രിയാ വിദ്യ.',
    icon: 'Scissors',
    doctors: [],
  },
  {
    id: 'dept-26',
    name: 'Physiotherapy',
    name_ml: 'ഭൗതിക ചികിത്സ വിദഗ്ധൻ',
    description: 'Helps restore movement and function when someone is affected by injury or disability.',
    description_ml: 'പരിക്കോ വൈകല്യമോ ബാധിച്ചാൽ ചലനവും പ്രവർത്തനവും വീണ്ടെടുക്കാൻ സഹായിക്കുന്നു.',
    icon: 'HeartPulse',
    doctors: [],
  },
];


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

// Check if we have the minimum required credentials
if (!adminInitialized) {
  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  const hasClientEmail = process.env.FIREBASE_CLIENT_EMAIL || process.env.NEXT_PUBLIC_FIREBASE_CLIENT_EMAIL;
  const hasPrivateKey = process.env.FIREBASE_PRIVATE_KEY || process.env.NEXT_PUBLIC_FIREBASE_PRIVATE_KEY;
  
  // If we only have project ID but not the other credentials, give a helpful error
  if (projectId && (!hasClientEmail || !hasPrivateKey)) {
    console.error("❌ Firebase Admin credentials incomplete!");
    console.error("\n   Detected NEXT_PUBLIC_FIREBASE_PROJECT_ID but missing:");
    if (!hasClientEmail) console.error("   - FIREBASE_CLIENT_EMAIL (or NEXT_PUBLIC_FIREBASE_CLIENT_EMAIL)");
    if (!hasPrivateKey) console.error("   - FIREBASE_PRIVATE_KEY (or NEXT_PUBLIC_FIREBASE_PRIVATE_KEY)");
    console.error("\n💡 To fix this, add to kloqo-clinic-admin/.env.local:");
    console.error("      NEXT_PUBLIC_FIREBASE_PROJECT_ID=your-project-id");
    console.error("      FIREBASE_CLIENT_EMAIL=your-service-account-email");
    console.error("      FIREBASE_PRIVATE_KEY=\"your-private-key\"");
    console.error("\n   OR set GOOGLE_APPLICATION_CREDENTIALS environment variable:");
    console.error("      export GOOGLE_APPLICATION_CREDENTIALS=\"/path/to/serviceAccountKey.json\"");
    process.exit(1);
  }
  
  // If we have nothing, give general instructions
  if (!projectId && !hasClientEmail && !hasPrivateKey) {
    console.error("❌ Firebase Admin credentials not found!");
    console.error("\n💡 To fix this, you need to provide credentials using ONE of these methods:");
    console.error("\n   1. Set GOOGLE_APPLICATION_CREDENTIALS environment variable:");
    console.error("      export GOOGLE_APPLICATION_CREDENTIALS=\"/path/to/serviceAccountKey.json\"");
    console.error("\n   OR");
    console.error("   2. Add to kloqo-clinic-admin/.env.local:");
    console.error("      NEXT_PUBLIC_FIREBASE_PROJECT_ID=your-project-id");
    console.error("      FIREBASE_CLIENT_EMAIL=your-service-account-email");
    console.error("      FIREBASE_PRIVATE_KEY=\"your-private-key\"");
    process.exit(1);
  }
}

const db = getFirestore();

async function seedMasterDepartments() {
  const collectionRef = db.collection('master-departments');
  console.log('Starting to seed master-departments...');
  const batch = db.batch();

  for (const dept of masterDepartments) {
    const docRef = collectionRef.doc(dept.id);
    batch.set(docRef, dept);
  }

  try {
    await batch.commit();
    console.log('Finished seeding master-departments.');
  } catch (error) {
    console.error('Error committing batch for master-departments:', error);
  }
}

seedMasterDepartments().catch(console.error);

    