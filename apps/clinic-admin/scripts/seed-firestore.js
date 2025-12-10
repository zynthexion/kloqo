
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { format } = require('date-fns');

// IMPORTANT: This check is to prevent initialization in a client-side environment
// as this script is intended for server-side execution only.
if (typeof window !== 'undefined') {
  throw new Error("This script should only be run in a Node.js environment.");
}

const doctors = [
  {
    id: 'D001',
    name: 'Dr. Petra Winsburry',
    specialty: 'Routine Check-Ups',
    avatar: "https://images.unsplash.com/photo-1612349316228-5942a9b489c2?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w3NDE5ODJ8MHwxfHNlYXJjaHw3fHxkb2N0b3IlMjBwb3J0cmFpdHxlbnwwfHx8fDE3NTg2ODc5Mzd8MA&ixlib=rb-4.1.0&q=80&w=1080",
    schedule: 'Mon, Wed, Fri: 9 AM - 5 PM. Short lunch breaks.',
    preferences: 'Prefers back-to-back consultations in the morning to leave afternoons for administrative tasks. Avoids scheduling follow-ups on Fridays.',
    historicalData: 'Tends to run 15 minutes late for afternoon appointments. High patient satisfaction scores.',
    department: 'General Medicine',
    totalPatients: 150,
    todaysAppointments: 10,
    availability: 'Available',
    degrees: ['MBBS', 'MD'],
    experience: 10,
    rating: 4,
    reviews: 1250,
    consultationFee: 150,
  },
  {
    id: 'D002',
    name: 'Dr. Olivia Martinez',
    specialty: 'Heart Specialist',
    avatar: "https://images.unsplash.com/photo-1673865641073-4479f93a7776?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w3NDE5ODJ8MHwxfHNlYXJjaHw2fHxkb2N0b3IlMjBwb3J0cmFpdHxlbnwwfHx8fDE3NTg2ODc5Mzd8MA&ixlib=rb-4.1.0&q=80&w=1080",
    schedule: 'Tue, Thu: 8 AM - 4 PM. Strict on-time appointments.',
    preferences: 'Likes to have 10-minute gaps between patients for note-taking. Prefers complex cases in the early afternoon.',
    historicalData: 'Appointment lengths are very consistent. Rarely cancels appointments.',
    department: 'Cardiology',
    totalPatients: 200,
    todaysAppointments: 0,
    availability: 'Unavailable',
    degrees: ['MBBS', 'MS - Cardiology'],
    experience: 15,
    rating: 5,
    reviews: 2100,
    consultationFee: 250,
  },
  {
    id: 'D003',
    name: 'Dr. Damian Sanchez',
    specialty: 'Child Health',
    avatar: "https://images.unsplash.com/photo-1550831107-1553da8c8464?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w3NDE5ODJ8MHwxfHNlYXJjaHwxMHx8ZG9jdG9yJTIwcG9ydHJhaXR8ZW58MHx8fHwxNzU4Njg3OTM3fDA&ixlib=rb-4.1.0&q=80&w=1080",
    schedule: 'Mon-Fri: 10 AM - 6 PM. Flexible with walk-ins.',
    preferences: 'Does not want more than 3 new patient check-ups per day. Prefers longer slots for infants.',
    historicalData: 'Often extends appointment times for concerned parents, leading to a cascading delay throughout the day.',
    department: 'Pediatrics',
    totalPatients: 180,
    todaysAppointments: 12,
    availability: 'Available',
    degrees: ['MBBS', 'DCH'],
    experience: 8,
    rating: 4,
    reviews: 980,
    consultationFee: 120,
  },
  {
    id: 'D004',
    name: 'Dr. Chloe Harrington',
    specialty: 'Skin Specialist',
    avatar: "https://images.unsplash.com/photo-1580894908361-967195033215?w=500&auto=format&fit=crop&q=60&ixlib=rb-4.0.3&ixid=M3wxMjA3fDB8MHxzZWFyY2h8MTV8fGRvY3RvcnxlbnwwfHwwfHx8MA%3D%3D",
    schedule: 'Mon, Tue, Thu: 9 AM - 5 PM. Surgery on Wednesdays.',
    preferences: 'Prefers post-op appointments on Mondays. No new patient consultations on Thursdays.',
    historicalData: 'Schedule is frequently disrupted by emergency consultations from the ER.',
    department: 'Dermatology',
    totalPatients: 120,
    todaysAppointments: 8,
    availability: 'Available',
    degrees: ['MBBS', 'MD - Dermatology'],
    experience: 12,
    rating: 5,
    reviews: 1500,
    consultationFee: 200,
  },
    {
    id: 'D005',
    name: 'Dr. Emily Smith',
    specialty: 'Routine Check-Ups',
    avatar: 'https://images.unsplash.com/photo-1537368910025-70035079f326?w=500&auto=format&fit=crop&q=60&ixlib=rb-4.0.3&ixid=M3wxMjA3fDB8MHxzZWFyY2h8OHx8ZG9jdG9yfGVufDB8fDB8fHww',
    schedule: 'Mon, Wed, Fri: 9 AM - 5 PM. Short lunch breaks.',
    preferences: 'Prefers back-to-back consultations in the morning to leave afternoons for administrative tasks. Avoids scheduling follow-ups on Fridays.',
    historicalData: 'Tends to run 15 minutes late for afternoon appointments. High patient satisfaction scores.',
    department: 'General Medicine',
    totalPatients: 160,
    todaysAppointments: 0,
    availability: 'Unavailable',
    degrees: ['MBBS', 'MD'],
    experience: 7,
    rating: 4,
    reviews: 800,
    consultationFee: 140,
  },
  {
    id: 'D006',
    name: 'Dr. Samuel Thompson',
    specialty: 'Heart Specialist',
    avatar: "https://images.unsplash.com/photo-1651133339395-909c065005b4?w=500&auto=format&fit=crop&q=60&ixlib=rb-4.0.3&ixid=M3wxMjA3fDB8MHxzZWFyY2h8MzJ8fGRvY3RvcnxlbnwwfHwwfHx8MA%3D%3D",
    schedule: 'Tue, Thu: 8 AM - 4 PM. Strict on-time appointments.',
    preferences: 'Likes to have 10-minute gaps between patients for note-taking. Prefers complex cases in the early afternoon.',
    historicalData: 'Appointment lengths are very consistent. Rarely cancels appointments.',
    department: 'Cardiology',
    totalPatients: 210,
    todaysAppointments: 14,
    availability: 'Available',
    degrees: ['MBBS', 'DM - Cardiology'],
    experience: 18,
    rating: 5,
    reviews: 2500,
    consultationFee: 275,
  },
    {
    id: 'D007',
    name: 'Dr. Sarah Johnson',
    specialty: 'Child Health',
    avatar: "https://images.unsplash.com/photo-1594824476967-48c8b964273f?w=500&auto=format&fit=crop&q=60&ixlib=rb-4.0.3&ixid=M3wxMjA3fDB8MHxzZWFyY2h8MjZ8fGRvY3RvcnxlbnwwfHwwfHx8MA%3D%3D",
    schedule: 'Mon-Fri: 10 AM - 6 PM. Flexible with walk-ins.',
    preferences: 'Does not want more than 3 new patient check-ups per day. Prefers longer slots for infants.',
    historicalData: 'Often extends appointment times for concerned parents, leading to a cascading delay throughout the day.',
    department: 'Pediatrics',
    totalPatients: 170,
    todaysAppointments: 0,
    availability: 'Unavailable',
    degrees: ['MBBS', 'MD - Pediatrics'],
    experience: 9,
    rating: 4,
    reviews: 1100,
    consultationFee: 130,
  },
  {
    id: 'D008',
    name: 'Dr. Luke Harrison',
    specialty: 'Skin Specialist',
    avatar: "https://plus.unsplash.com/premium_photo-1661757234299-a8c8b217596a?w=500&auto=format&fit=crop&q=60&ixlib=rb-4.0.3&ixid=M3wxMjA3fDB8MHxzZWFyY2h8MXx8ZG9jdG9yfGVufDB8fDB8fHww",
    schedule: 'Mon, Tue, Thu: 9 AM - 5 PM. Surgery on Wednesdays.',
    preferences: 'Prefers post-op appointments on Mondays. No new patient consultations on Thursdays.',
    historicalData: 'Schedule is frequently disrupted by emergency consultations from the ER.',
    department: 'Dermatology',
    totalPatients: 130,
    todaysAppointments: 9,
    availability: 'Available',
    degrees: ['MBBS', 'MD - Dermatology'],
    experience: 6,
    rating: 4,
    reviews: 750,
    consultationFee: 180,
  },
  {
    id: 'D009',
    name: 'Dr. Andrew Peterson',
    specialty: 'Internal Health',
    avatar: "https://images.unsplash.com/photo-1622253692010-333f2da6031d?w=500&auto=format&fit=crop&q=60&ixlib=rb-4.0.3&ixid=M3wxMjA3fDB8MHxzZWFyY2h8Mzh8fGRvY3RvcnxlbnwwfHwwfHx8MA%3D%3D",
    schedule: 'Mon-Fri: 10 AM - 6 PM. Flexible with walk-ins.',
    preferences: 'Does not want more than 3 new patient check-ups per day. Prefers longer slots for infants.',
    historicalData: 'Often extends appointment times for concerned parents, leading to a cascading delay throughout the day.',
    department: 'Internal Medicine',
    totalPatients: 190,
    todaysAppointments: 0,
    availability: 'Unavailable',
    degrees: ['MBBS', 'MD - Internal Medicine'],
    experience: 14,
    rating: 5,
    reviews: 1800,
    consultationFee: 220,
  },
  {
    id: 'D010',
    name: 'Dr. William Carter',
    specialty: 'Child Health',
    avatar: "https://images.unsplash.com/photo-1579165466949-3180a3d056d5?w=500&auto=format&fit=crop&q=60&ixlib=rb-4.0.3&ixid=M3wxMjA3fDB8MHxzZWFyY2h8NTh8fGRvY3RvcnxlbnwwfHwwfHx8MA%3D%3D",
    schedule: 'Mon-Fri: 10 AM - 6 PM. Flexible with walk-ins.',
    preferences: 'Does not want more than 3 new patient check-ups per day. Prefers longer slots for infants.',
    historicalData: 'Often extends appointment times for concerned parents, leading to a cascading delay throughout the day.',
    department: 'Pediatrics',
    totalPatients: 175,
    todaysAppointments: 12,
    availability: 'Available',
    degrees: ['MBBS', 'MD - Pediatrics'],
    experience: 11,
    rating: 4,
    reviews: 1300,
    consultationFee: 135,
  },
  {
    id: 'D011',
    name: 'Dr. Mark Wilson',
    specialty: 'Bone Specialist',
    avatar: "https://images.unsplash.com/photo-1584515933487-779824d29309?w=500&auto=format&fit=crop&q=60&ixlib=rb-4.0.3&ixid=M3wxMjA3fDB8MHxzZWFyY2h8NjB8fGRvY3RvcnxlbnwwfHwwfHx8MA%3D%3D",
    schedule: 'Mon-Fri: 10 AM - 6 PM. Flexible with walk-ins.',
    preferences: 'Does not want more than 3 new patient check-ups per day. Prefers longer slots for infants.',
    historicalData: 'Often extends appointment times for concerned parents, leading to a cascading delay throughout the day.',
    department: 'Orthopedics',
    totalPatients: 140,
    todaysAppointments: 0,
    availability: 'Unavailable',
    degrees: ['MBBS', 'MS - Orthopedics'],
    experience: 16,
    rating: 5,
    reviews: 1950,
    consultationFee: 300,
  },
  {
    id: 'D012',
    name: 'Dr. Thomas Brown',
    specialty: 'Brain Specialist',
    avatar: "https://plus.unsplash.com/premium_photo-1681995326991-236531742439?w=500&auto=format&fit=crop&q=60&ixlib=rb-4.0.3&ixid=M3wxMjA3fDB8MHxzZWFyY2h8Nzd8fGRvY3RvcnxlbnwwfHwwfHx8MA%3D%3D",
    schedule: 'Mon-Fri: 10 AM - 6 PM. Flexible with walk-ins.',
    preferences: 'Does not want more than 3 new patient check-ups per day. Prefers longer slots for infants.',
    historicalData: 'Often extends appointment times for concerned parents, leading to a cascading delay throughout the day.',
    department: 'Neurology',
    totalPatients: 155,
    todaysAppointments: 11,
    availability: 'Available',
    degrees: ['MBBS', 'DM - Neurology'],
    experience: 20,
    rating: 5,
    reviews: 3200,
    consultationFee: 350,
  },
];

const departments = [
  {
    id: 'dept-01',
    name: 'General Medicine',
    description: 'Provides comprehensive healthcare services including routine check-ups, preventive care, and treatment for a wide range of illnesses.',
    image: 'https://images.pexels.com/photos/3825529/pexels-photo-3825529.jpeg',
    doctors: ['Dr. Petra Winsburry', 'Dr. Emily Smith', 'Dr. Samuel Thompson', 'Dr. Sarah Johnson', 'Dr. Luke Harrison', 'Dr. Andrew Peterson', 'Dr. William Carter', 'Dr. Mark Wilson', 'Dr. Thomas Brown', 'Dr. Olivia Martinez', 'Dr. Damian Sanchez', 'Dr. Chloe Harrington'],
  },
  {
    id: 'dept-02',
    name: 'Cardiology',
    description: 'Specializes in the diagnosis and treatment of heart-related conditions, offering advanced cardiac care and preventive services.',
    image: 'https://images.pexels.com/photos/8460159/pexels-photo-8460159.jpeg',
    doctors: ['Dr. Olivia Martinez', 'Dr. Samuel Thompson', 'Dr. Emily Smith', 'Dr. Sarah Johnson', 'Dr. Luke Harrison', 'Dr. Andrew Peterson', 'Dr. William Carter', 'Dr. Mark Wilson'],
  },
  {
    id: 'dept-03',
    name: 'Pediatrics',
    description: 'Dedicated to the health and well-being of children, providing specialized care for infants, children, and adolescents.',
    image: 'https://images.pexels.com/photos/5452201/pexels-photo-5452201.jpeg',
    doctors: ['Dr. Damian Sanchez', 'Dr. Sarah Johnson', 'Dr. William Carter', 'Dr. Petra Winsburry', 'Dr. Emily Smith', 'Dr. Samuel Thompson', 'Dr. Luke Harrison'],
  },
  {
    id: 'dept-04',
    name: 'Dermatology',
    description: 'Focuses on the treatment of skin conditions, offering medical and cosmetic dermatology services to improve skin health and appearance.',
    image: 'https://images.pexels.com/photos/6628101/pexels-photo-6628101.jpeg',
    doctors: ['Dr. Chloe Harrington', 'Dr. Luke Harrison', 'Dr. Petra Winsburry', 'Dr. Emily Smith', 'Dr. Samuel Thompson'],
  },
  {
    id: 'dept-05',
    name: 'Internal Medicine',
    description: 'Provides primary care for adults, focusing on the prevention, diagnosis, and treatment of adult diseases.',
    image: 'https://images.pexels.com/photos/8460126/pexels-photo-8460126.jpeg',
    doctors: ['Dr. Andrew Peterson', 'Dr. Petra Winsburry', 'Dr. Olivia Martinez', 'Dr. Samuel Thompson', 'Dr. Mark Wilson', 'Dr. Thomas Brown', 'Dr. Chloe Harrington', 'Dr. Damian Sanchez', 'Dr. Sarah Johnson', 'Dr. William Carter', 'Dr. Emily Smith', 'Dr. Luke Harrison'],
  },
  {
    id: 'dept-06',
    name: 'Orthopedics',
    description: 'Specializes in the treatment of musculoskeletal system disorders, including bones, joints, ligaments, tendons, and muscles.',
    image: 'https://images.pexels.com/photos/5452198/pexels-photo-5452198.jpeg',
    doctors: ['Dr. Mark Wilson', 'Dr. Petra Winsburry', 'Dr. Olivia Martinez', 'Dr. Samuel Thompson', 'Dr. Andrew Peterson', 'Dr. Thomas Brown', 'Dr. Chloe Harrington', 'Dr. Damian Sanchez'],
  },
    {
    id: 'dept-07',
    name: 'Neurology',
    description: 'Deals with disorders of the nervous system, offering expert care for conditions affecting the brain, spinal cord, and nerves.',
    image: 'https://images.pexels.com/photos/8460162/pexels-photo-8460162.jpeg',
    doctors: ['Dr. Thomas Brown', 'Dr. Olivia Martinez', 'Dr. Samuel Thompson', 'Dr. Andrew Peterson', 'Dr. Mark Wilson', 'Dr. Chloe Harrington'],
  },
  {
    id: 'dept-08',
    name: 'Oncology',
    description: 'Focuses on the diagnosis and treatment of cancer, providing comprehensive cancer care and support services.',
    image: 'https://images.pexels.com/photos/8460144/pexels-photo-8460144.jpeg',
    doctors: ['Dr. Emily Smith', 'Dr. Petra Winsburry', 'Dr. Olivia Martinez', 'Dr. Samuel Thompson', 'Dr. Andrew Peterson', 'Dr. Mark Wilson', 'Dr. Thomas Brown'],
  },
  {
    id: 'dept-09',
    name: 'Obstetrics and Gynecology (OB/GYN)',
    description: "Provides care for women's health, including pregnancy, childbirth, and reproductive health.",
    image: 'https://images.pexels.com/photos/7088520/pexels-photo-7088520.jpeg',
    doctors: ['Dr. Sarah Johnson', 'Dr. Petra Winsburry', 'Dr. Olivia Martinez', 'Dr. Samuel Thompson', 'Dr. Andrew Peterson', 'Dr. Mark Wilson', 'Dr. Thomas Brown', 'Dr. Chloe Harrington', 'Dr. Damian Sanchez', 'Dr. William Carter', 'Dr. Emily Smith'],
  }
];

const today = new Date();
const currentYear = today.getFullYear();
const currentMonth = today.getMonth();
const currentDay = today.getDate();

const formatDate = (day) => {
    const date = new Date(currentYear, currentMonth, day);
    return format(date, 'd MMMM yyyy');
};

const getTokenNumber = (bookedVia, index) => {
    let prefix = '';
    if (bookedVia === 'Online') prefix = 'A';
    else if (bookedVia === 'Phone') prefix = 'P';
    else if (bookedVia === 'Walk-in') prefix = 'W';
    return `${prefix}${(index + 1).toString().padStart(3, '0')}`;
};

const rawAppointments = [
  {
    id: 'APT001',
    patientName: 'Caren G. Simpson',
    gender: 'Female',
    phone: '123-456-7890',
    age: 34,
    date: formatDate(currentDay),
    time: '09:00 AM',
    doctor: 'Dr. Petra Winsburry',
    treatment: 'Routine Check-Up',
    status: 'Confirmed',
    department: 'General Medicine',
    bookedVia: 'Online',
    place: 'New York, USA',
  },
  {
    id: 'APT002',
    patientName: 'Edgar Warrow',
    gender: 'Male',
    phone: '234-567-8901',
    age: 45,
    date: formatDate(currentDay),
    time: '10:30 AM',
    doctor: 'Dr. Olivia Martinez',
    treatment: 'Cardiac Consultation',
    status: 'Confirmed',
    department: 'Cardiology',
    bookedVia: 'Phone',
    place: 'London, UK',
  },
  {
    id: 'APT003',
    patientName: 'Ocean Jane Lupre',
    gender: 'Female',
    phone: '345-678-9012',
    age: 28,
    date: formatDate(currentDay),
    time: '11:00 AM',
    doctor: 'Dr. Damian Sanchez',
    treatment: 'Pediatric Check-Up',
    status: 'Pending',
    department: 'Pediatrics',
    bookedVia: 'Walk-in',
    place: 'Tokyo, Japan',
  },
  {
    id: 'APT004',
    patientName: 'Shane Riddick',
    gender: 'Male',
    phone: '456-789-0123',
    age: 52,
    date: formatDate(currentDay + 1),
    time: '01:00 PM',
    doctor: 'Dr. Chloe Harrington',
    treatment: 'Skin Allergy',
    status: 'Cancelled',
    department: 'Dermatology',
    bookedVia: 'Online',
    place: 'Sydney, Australia',
  },
  {
    id: 'APT005',
    patientName: 'Queen Lawnston',
    gender: 'Female',
    phone: '567-890-1234',
    age: 61,
    date: formatDate(currentDay + 1),
    time: '02:30 PM',
    doctor: 'Dr. Petra Winsburry',
    treatment: 'Follow-Up Visit',
    status: 'Confirmed',
    department: 'General Medicine',
    bookedVia: 'Phone',
    place: 'Paris, France',
  },
  {
    id: 'APT006',
    patientName: 'Alice Mitchell',
    gender: 'Female',
    phone: '678-901-2345',
    age: 29,
    date: formatDate(currentDay + 2),
    time: '09:00 AM',
    doctor: 'Dr. Emily Smith',
    treatment: 'Routine Check-Up',
    status: 'Confirmed',
    department: 'General Medicine',
    bookedVia: 'Online',
    place: 'Berlin, Germany',
  },
  {
    id: 'APT007',
    patientName: 'Mikhail Morozov',
    gender: 'Male',
    phone: '789-012-3456',
    age: 58,
    date: formatDate(currentDay + 2),
    time: '10:30 AM',
    doctor: 'Dr. Samuel Thompson',
    treatment: 'Cardiac Consultation',
    status: 'Confirmed',
    department: 'Cardiology',
    bookedVia: 'Phone',
    place: 'Moscow, Russia',
  },
  {
    id: 'APT008',
    patientName: 'Mateus Fernandes',
    gender: 'Male',
    phone: '890-123-4567',
    age: 7,
    date: formatDate(currentDay + 3),
    time: '11:00 AM',
    doctor: 'Dr. Sarah Johnson',
    treatment: 'Pediatric Check-Up',
    status: 'Pending',
    department: 'Pediatrics',
    bookedVia: 'Walk-in',
    place: 'Rio de Janeiro, Brazil',
  },
  {
    id: 'APT009',
    patientName: 'Pari Desai',
    gender: 'Female',
    phone: '901-234-5678',
    age: 41,
    date: formatDate(currentDay + 3),
    time: '01:00 PM',
    doctor: 'Dr. Luke Harrison',
    treatment: 'Skin Allergy',
    status: 'Cancelled',
    department: 'Dermatology',
    bookedVia: 'Online',
    place: 'Mumbai, India',
  },
  {
    id: 'APT010',
    patientName: 'Omar Ali',
    gender: 'Male',
    phone: '012-345-6789',
    age: 33,
    date: formatDate(currentDay + 4),
    time: '02:30 PM',
    doctor: 'Dr. Andrew Peterson',
    treatment: 'Follow-Up Visit',
    status: 'Confirmed',
    department: 'Internal Medicine',
    bookedVia: 'Phone',
    place: 'Cairo, Egypt',
  },
  {
    id: 'APT011',
    patientName: 'Camila Alvarez',
    gender: 'Female',
    phone: '112-233-4455',
    age: 68,
    date: formatDate(currentDay),
    time: '03:00 PM',
    doctor: 'Dr. Olivia Martinez',
    treatment: 'Cardiac Check-Up',
    status: 'Confirmed',
    department: 'Cardiology',
    bookedVia: 'Online',
    place: 'Mexico City, Mexico',
  },
  {
    id: 'APT012',
    patientName: 'Thabo van Rooyen',
    gender: 'Male',
    phone: '223-344-5566',
    age: 5,
    date: formatDate(currentDay + 1),
    time: '04:00 PM',
    doctor: 'Dr. William Carter',
    treatment: 'Pediatric Check-Up',
    status: 'Pending',
    department: 'Pediatrics',
    bookedVia: 'Walk-in',
    place: 'Cape Town, South Africa',
  },
  {
    id: 'APT013',
    patientName: 'Chance Geidt',
    gender: 'Male',
    phone: '334-455-6677',
    age: 50,
    date: formatDate(currentDay + 2),
    time: '04:30 PM',
    doctor: 'Dr. Samuel Thompson',
    treatment: 'Follow-Up Visit',
    status: 'Confirmed',
    department: 'Cardiology',
    bookedVia: 'Phone',
    place: 'Toronto, Canada',
  }
];

const appointments = rawAppointments.map((apt, index) => ({
  ...apt,
  tokenNumber: getTokenNumber(apt.bookedVia, index),
}));


// Initialize Firebase Admin SDK
// This requires a service account key file. 
// Ensure GOOGLE_APPLICATION_CREDENTIALS is set in your environment.
try {
    initializeApp({
        // If you're running this locally with a service account file:
        // credential: cert(require('./path/to/your/serviceAccountKey.json'))
    });
} catch(e) {
    if (e.code !== 'app/duplicate-app') {
        console.error("Firebase Admin initialization error:", e);
    }
}


const db = getFirestore();

async function seedCollection(collectionName, data, idField) {
  console.log(`Starting to seed ${collectionName}...`);
  const clinicId = 'default-clinic-id'; // Define clinicId here
  const collectionPath = `clinics/${clinicId}/${collectionName}`;
  const batch = db.batch();

  for (const item of data) {
    const docRef = db.collection(collectionPath).doc(item[idField]);
    batch.set(docRef, { ...item, clinicId: clinicId });
  }

  await batch.commit();
  console.log(`Finished seeding ${collectionName} for clinic ${clinicId}.`);
}


async function main() {
    await seedCollection('doctors', doctors, 'id');
    await seedCollection('departments', departments, 'id');
    await seedCollection('appointments', appointments, 'id');
}


main().catch(console.error);

    