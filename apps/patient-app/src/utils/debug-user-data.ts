/**
 * Debug utility to find logged-in user's data
 * Call this from browser console or add to a page temporarily
 */

import { getAuth } from 'firebase/auth';
import { getFirestore, doc, getDoc, query, where, collection, getDocs } from 'firebase/firestore';

export async function debugLoggedInUser() {
  const auth = getAuth();
  const db = getFirestore();
  
  if (!auth.currentUser) {
    console.error('❌ No user logged in');
    return null;
  }

  const firebaseUser = auth.currentUser;
  const phoneNumber = firebaseUser.phoneNumber;
  
  console.log('📱 ========== LOGGED IN USER DEBUG ==========');
  console.log('Firebase Auth User:', {
    uid: firebaseUser.uid,
    phoneNumber: phoneNumber,
    email: firebaseUser.email,
    displayName: firebaseUser.displayName
  });
  
  try {
    // Step 1: Find user document in users collection
    console.log('\n🔍 Step 1: Searching users collection...');
    const userDocRef = doc(db, 'users', firebaseUser.uid);
    const userDocSnap = await getDoc(userDocRef);
    
    if (userDocSnap.exists()) {
      const userData = userDocSnap.data();
      console.log('✅ User document found:', {
        documentId: firebaseUser.uid,
        ...userData
      });
      
      const patientId = userData.patientId;
      
      // Step 2: Find patient document
      if (patientId) {
        console.log('\n🔍 Step 2: Searching patients collection...');
        const patientDocRef = doc(db, 'patients', patientId);
        const patientDocSnap = await getDoc(patientDocRef);
        
        if (patientDocSnap.exists()) {
          const patientData = patientDocSnap.data();
          console.log('✅ Patient document found:', {
            documentId: patientId,
            ...patientData
          });
          
          // Step 3: Find appointments
          console.log('\n🔍 Step 3: Searching appointments collection...');
          const allPatientIds = [patientId, ...(patientData.relatedPatientIds || [])];
          
          // Firestore 'in' query limit is 30, so split if needed
          const appointmentsPromises = [];
          for (let i = 0; i < allPatientIds.length; i += 30) {
            const chunk = allPatientIds.slice(i, i + 30);
            const appointmentsQuery = query(
              collection(db, 'appointments'),
              where('patientId', 'in', chunk)
            );
            appointmentsPromises.push(getDocs(appointmentsQuery));
          }
          
          const appointmentsSnapshots = await Promise.all(appointmentsPromises);
          const allAppointments: any[] = [];
          appointmentsSnapshots.forEach(snapshot => {
            snapshot.docs.forEach(doc => {
              allAppointments.push({ id: doc.id, ...doc.data() });
            });
          });
          
          console.log(`✅ Found ${allAppointments.length} appointment(s):`, allAppointments);
          
          // Step 4: Find by phone number (alternative search)
          console.log('\n🔍 Step 4: Searching by phone number...');
          const usersByPhoneQuery = query(
            collection(db, 'users'),
            where('phone', '==', phoneNumber)
          );
          const usersByPhoneSnap = await getDocs(usersByPhoneQuery);
          
          console.log(`✅ Found ${usersByPhoneSnap.size} user(s) with phone ${phoneNumber}:`);
          usersByPhoneSnap.docs.forEach(doc => {
            console.log('  -', { id: doc.id, ...doc.data() });
          });
          
          const patientsByPhoneQuery = query(
            collection(db, 'patients'),
            where('phone', '==', phoneNumber)
          );
          const patientsByPhoneSnap = await getDocs(patientsByPhoneQuery);
          
          console.log(`✅ Found ${patientsByPhoneSnap.size} patient(s) with phone ${phoneNumber}:`);
          patientsByPhoneSnap.docs.forEach(doc => {
            console.log('  -', { id: doc.id, ...doc.data() });
          });
          
          return {
            firebaseUser: {
              uid: firebaseUser.uid,
              phoneNumber: phoneNumber
            },
            userDocument: { id: firebaseUser.uid, ...userData },
            patientDocument: { id: patientId, ...patientData },
            appointments: allAppointments
          };
        } else {
          console.warn('⚠️ Patient document not found:', patientId);
        }
      } else {
        console.warn('⚠️ User document has no patientId');
      }
    } else {
      console.warn('⚠️ User document not found in users collection');
    }
    
  } catch (error) {
    console.error('❌ Error debugging user data:', error);
  }
  
  console.log('📱 ========== END DEBUG ==========\n');
  return null;
}

