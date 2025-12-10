
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

if (typeof window !== 'undefined') {
  throw new Error("This script should only be run in a Node.js environment.");
}

const masterDepartments = [
  {
    id: 'dept-01',
    name: 'General Medicine',
    description: 'Comprehensive primary care for adults, focusing on disease prevention and health promotion.',
    icon: 'Stethoscope',
    doctors: [],
  },
  {
    id: 'dept-02',
    name: 'Cardiology',
    description: 'Specialized care for heart and blood vessel disorders.',
    icon: 'HeartPulse',
    doctors: [],
  },
  {
    id: 'dept-03',
    name: 'Pediatrics',
    description: 'Medical care for infants, children, and adolescents.',
    icon: 'Baby',
    doctors: [],
  },
  {
    id: 'dept-04',
    name: 'Dermatology',
    description: 'Treatment of skin, hair, and nail conditions.',
    icon: 'Sparkles',
    doctors: [],
  },
  {
    id: 'dept-05',
    name: 'Neurology',
    description: 'Care for disorders of the nervous system, including brain and spinal cord.',
    icon: 'BrainCircuit',
    doctors: [],
  },
  {
    id: 'dept-06',
    name: 'Orthopedics',
    description: 'Treatment of the musculoskeletal system, including bones and joints.',
    icon: 'Bone',
    doctors: [],
  },
  {
    id: 'dept-07',
    name: 'Oncology',
    description: 'Diagnosis and treatment of cancer.',
    icon: 'Award',
    doctors: [],
  },
  {
    id: 'dept-08',
    name: 'OB/GYN',
    description: "Women's health services, including pregnancy and childbirth.",
    icon: 'Pregnant',
    doctors: [],
  },
  {
    id: 'dept-09',
    name: 'Gastroenterology',
    description: 'Care for the digestive system and its disorders.',
    icon: 'Microwave',
    doctors: [],
  },
  {
    id: 'dept-10',
    name: 'Pulmonology',
    description: 'Specializing in diseases of the lungs and respiratory tract.',
    icon: 'Wind',
    doctors: [],
  },
  {
    id: 'dept-11',
    name: 'Endocrinology',
    description: 'Treatment of hormonal imbalances and diseases.',
    icon: 'Droplets',
    doctors: [],
  },
  {
    id: 'dept-12',
    name: 'Nephrology',
    description: 'Specializing in kidney care and diseases.',
    icon: 'Filter',
    doctors: [],
  },
  {
    id: 'dept-13',
    name: 'Urology',
    description: 'Care for the urinary tract and male reproductive system.',
    icon: 'Droplet',
    doctors: [],
  },
  {
    id: 'dept-14',
    name: 'Ophthalmology',
    description: 'Comprehensive eye and vision care.',
    icon: 'Eye',
    doctors: [],
  },
  {
    id: 'dept-15',
    name: 'ENT',
    description: 'Treatment for ear, nose, and throat conditions.',
    icon: 'Ear',
    doctors: [],
  },
  {
    id: 'dept-16',
    name: 'Psychiatry',
    description: 'Mental health care and treatment of emotional disorders.',
    icon: 'Brain',
    doctors: [],
  },
  {
    id: 'dept-17',
    name: 'Rheumatology',
    description: 'Diagnosis and therapy of rheumatic diseases.',
    icon: 'PersonStanding',
    doctors: [],
  },
  {
    id: 'dept-18',
    name: 'Radiology',
    description: 'Medical imaging to diagnose and treat diseases.',
    icon: 'Radiation',
    doctors: [],
  },
  {
    id: 'dept-19',
    name: 'Anesthesiology',
    description: 'Management of pain and total care of the patient before, during and after surgery.',
    icon: 'Siren',
    doctors: [],
  },
  {
    id: 'dept-20',
    name: 'Dentistry',
    description: 'Diagnosis, treatment, and prevention of diseases and conditions of the oral cavity.',
    icon: 'Tooth',
    doctors: [],
  },
  {
    id: 'dept-21',
    name: 'Emergency Medicine',
    description: 'Care for patients with acute illnesses or injuries which require immediate medical attention.',
    icon: 'Ambulance',
    doctors: [],
  },
  {
    id: 'dept-22',
    name: 'Geriatrics',
    description: 'Health care of elderly people.',
    icon: 'PersonStanding',
    doctors: [],
  },
  {
    id: 'dept-23',
    name: 'Hematology',
    description: 'Treatment of blood, blood-forming organs, and blood diseases.',
    icon: 'TestTube',
    doctors: [],
  },
  {
    id: 'dept-24',
    name: 'Infectious Disease',
    description: 'Diagnosis and treatment of complex infections.',
    icon: 'Virus',
    doctors: [],
  },
  {
    id: 'dept-25',
    name: 'Plastic Surgery',
    description: 'Surgical specialty dedicated to reconstruction of facial and body defects.',
    icon: 'Scissors',
    doctors: [],
  },
  {
    id: 'dept-26',
    name: 'Physiotherapy',
    description: 'Helps restore movement and function when someone is affected by injury or disability.',
    icon: 'HeartPulse',
    doctors: [],
  },
];

try {
    if (getApps().length === 0) {
        initializeApp();
    }
} catch(e) {
    if (e.code !== 'app/duplicate-app') {
        console.error("Firebase Admin initialization error:", e);
        process.exit(1);
    }
}

const db = getFirestore();

async function seedMasterDepartments() {
  const collectionRef = db.collection('master-departments');
  console.log('Starting to seed master-departments...');

  for (const dept of masterDepartments) {
    try {
      const docRef = collectionRef.doc(dept.id);
      await docRef.set(dept);
      console.log(`Added master department: ${dept.name}`);
    } catch (error) {
      console.error(`Error adding master department ${dept.name}:`, error);
    }
  }

  console.log('Finished seeding master-departments.');
}

seedMasterDepartments().catch(console.error);
