# 🔍 DETECTING DUPLICATE SLOT/TOKEN BUGS
**Critical Race Condition Monitoring for Kloqo**  
**Date:** December 10, 2025

---

## ⚠️ **THE PROBLEM: RACE CONDITIONS**

### **What Can Go Wrong:**

```
Scenario: Two patients book at the SAME TIME

User A (Kochi):          User B (Trivandrum):
10:30:00 - Click slot 5  10:30:00 - Click slot 5
10:30:01 - Check if free 10:30:01 - Check if free
10:30:02 - Slot is free! 10:30:02 - Slot is free!
10:30:03 - Book slot 5   10:30:03 - Book slot 5
10:30:04 - Get token A005 10:30:04 - Get token A005

Result: BOTH get slot 5, token A005! 💥
```

**This is CRITICAL for Kerala clinics:**
- High booking volume (100+ bookings/day)
- Multiple patients booking simultaneously
- Walk-in + advance bookings happening together
- Can cause chaos in waiting room!

---

## ✅ **YOUR CODE ALREADY HAS PROTECTION!**

### **Good News:**

Your `walk-in.service.ts` already uses **Firestore transactions** which SHOULD prevent this:

```typescript
// Line 616 in walk-in.service.ts
const transactionPromise = runTransaction(firestore, async transaction => {
  // This is ATOMIC - only one transaction succeeds
  // If two users book simultaneously, one will fail and retry
});
```

**But** there are edge cases where it can still fail!

---

## 🐛 **HOW TO DETECT DUPLICATE BOOKINGS**

### **Method 1: Real-time Monitoring (BEST)**

#### **Create a Firestore Trigger (Cloud Function)**

```typescript
// functions/src/index.ts
import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';

admin.initializeApp();

// Trigger on every appointment creation
export const detectDuplicateBookings = functions.firestore
  .document('appointments/{appointmentId}')
  .onCreate(async (snap, context) => {
    const appointment = snap.data();
    
    // Check for duplicates
    const duplicates = await admin.firestore()
      .collection('appointments')
      .where('clinicId', '==', appointment.clinicId)
      .where('doctor', '==', appointment.doctor)
      .where('date', '==', appointment.date)
      .where('slotIndex', '==', appointment.slotIndex)
      .where('status', 'in', ['Pending', 'Confirmed'])
      .get();
    
    // If more than 1 appointment for same slot
    if (duplicates.size > 1) {
      console.error('🚨 DUPLICATE BOOKING DETECTED!', {
        slotIndex: appointment.slotIndex,
        tokenNumber: appointment.tokenNumber,
        count: duplicates.size,
        appointments: duplicates.docs.map(doc => ({
          id: doc.id,
          patientName: doc.data().patientName,
          tokenNumber: doc.data().tokenNumber,
          bookedAt: doc.data().createdAt,
        })),
      });
      
      // Log to error collection
      await admin.firestore().collection('duplicate-bookings').add({
        clinicId: appointment.clinicId,
        doctor: appointment.doctor,
        date: appointment.date,
        slotIndex: appointment.slotIndex,
        tokenNumber: appointment.tokenNumber,
        duplicateCount: duplicates.size,
        appointments: duplicates.docs.map(doc => doc.id),
        detectedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      
      // Send alert
      await sendDuplicateAlert({
        clinic: appointment.clinicId,
        doctor: appointment.doctor,
        slot: appointment.slotIndex,
        token: appointment.tokenNumber,
        count: duplicates.size,
      });
    }
  });

// Check for duplicate tokens
export const detectDuplicateTokens = functions.firestore
  .document('appointments/{appointmentId}')
  .onCreate(async (snap, context) => {
    const appointment = snap.data();
    
    // Check for duplicate token numbers
    const duplicateTokens = await admin.firestore()
      .collection('appointments')
      .where('clinicId', '==', appointment.clinicId)
      .where('doctor', '==', appointment.doctor)
      .where('date', '==', appointment.date)
      .where('tokenNumber', '==', appointment.tokenNumber)
      .where('status', 'in', ['Pending', 'Confirmed'])
      .get();
    
    if (duplicateTokens.size > 1) {
      console.error('🚨 DUPLICATE TOKEN DETECTED!', {
        tokenNumber: appointment.tokenNumber,
        count: duplicateTokens.size,
      });
      
      await admin.firestore().collection('duplicate-tokens').add({
        clinicId: appointment.clinicId,
        doctor: appointment.doctor,
        date: appointment.date,
        tokenNumber: appointment.tokenNumber,
        duplicateCount: duplicateTokens.size,
        appointments: duplicateTokens.docs.map(doc => doc.id),
        detectedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  });
```

**What This Does:**
- ✅ Runs automatically on every booking
- ✅ Detects duplicates in real-time
- ✅ Logs to `duplicate-bookings` collection
- ✅ Sends alerts immediately
- ✅ **Catches the bug the moment it happens!**

---

### **Method 2: Scheduled Audit (Daily Check)**

```typescript
// functions/src/index.ts
import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';

// Run every day at 11 PM IST
export const dailyDuplicateAudit = functions.pubsub
  .schedule('0 23 * * *')
  .timeZone('Asia/Kolkata')
  .onRun(async (context) => {
    const today = new Date();
    const dateStr = format(today, 'd MMMM yyyy');
    
    // Get all appointments for today
    const appointments = await admin.firestore()
      .collection('appointments')
      .where('date', '==', dateStr)
      .where('status', 'in', ['Pending', 'Confirmed', 'Completed'])
      .get();
    
    // Group by clinic + doctor + slot
    const slotMap = new Map<string, any[]>();
    
    appointments.forEach(doc => {
      const data = doc.data();
      const key = `${data.clinicId}_${data.doctor}_${data.slotIndex}`;
      
      if (!slotMap.has(key)) {
        slotMap.set(key, []);
      }
      slotMap.get(key)!.push({
        id: doc.id,
        ...data,
      });
    });
    
    // Find duplicates
    const duplicates: any[] = [];
    slotMap.forEach((appointments, key) => {
      if (appointments.length > 1) {
        duplicates.push({
          key,
          count: appointments.length,
          appointments,
        });
      }
    });
    
    if (duplicates.length > 0) {
      console.error(`🚨 Found ${duplicates.length} duplicate slots today!`);
      
      // Log to audit collection
      await admin.firestore().collection('daily-audits').add({
        date: dateStr,
        duplicateSlots: duplicates.length,
        duplicates: duplicates,
        auditedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      
      // Send daily summary email
      await sendDailySummary(duplicates);
    } else {
      console.log('✅ No duplicates found today');
    }
    
    return null;
  });
```

**What This Does:**
- ✅ Runs every night at 11 PM
- ✅ Checks ALL bookings for the day
- ✅ Finds any duplicates that slipped through
- ✅ Sends daily summary
- ✅ **Safety net to catch anything missed**

---

### **Method 3: Client-Side Validation**

```typescript
// packages/shared-core/src/services/booking-validator.ts

export async function validateBookingBeforeConfirm(
  firestore: Firestore,
  bookingData: {
    clinicId: string;
    doctor: string;
    date: string;
    slotIndex: number;
    tokenNumber: string;
  }
): Promise<{ valid: boolean; error?: string }> {
  
  // Check for duplicate slot
  const slotQuery = await getDocs(
    query(
      collection(firestore, 'appointments'),
      where('clinicId', '==', bookingData.clinicId),
      where('doctor', '==', bookingData.doctor),
      where('date', '==', bookingData.date),
      where('slotIndex', '==', bookingData.slotIndex),
      where('status', 'in', ['Pending', 'Confirmed'])
    )
  );
  
  if (!slotQuery.empty) {
    return {
      valid: false,
      error: 'This slot is already booked. Please select another time.',
    };
  }
  
  // Check for duplicate token
  const tokenQuery = await getDocs(
    query(
      collection(firestore, 'appointments'),
      where('clinicId', '==', bookingData.clinicId),
      where('doctor', '==', bookingData.doctor),
      where('date', '==', bookingData.date),
      where('tokenNumber', '==', bookingData.tokenNumber),
      where('status', 'in', ['Pending', 'Confirmed'])
    )
  );
  
  if (!tokenQuery.empty) {
    return {
      valid: false,
      error: 'Duplicate token detected. Please try again.',
    };
  }
  
  return { valid: true };
}
```

**Usage:**
```typescript
// In your booking flow
const validation = await validateBookingBeforeConfirm(db, {
  clinicId,
  doctor: doctorName,
  date: dateStr,
  slotIndex: chosenSlot,
  tokenNumber: generatedToken,
});

if (!validation.valid) {
  throw new Error(validation.error);
}

// Proceed with booking
await bookAppointment(...);
```

---

### **Method 4: Database Constraints (BEST PREVENTION)**

```typescript
// Create unique composite index in Firestore

// In Firebase Console or via CLI:
// 1. Go to Firestore → Indexes
// 2. Create composite index:
//    Collection: appointments
//    Fields:
//      - clinicId (Ascending)
//      - doctor (Ascending)
//      - date (Ascending)
//      - slotIndex (Ascending)
//      - status (Ascending)

// This makes queries faster AND helps detect duplicates
```

**Also add to your booking code:**
```typescript
// Before creating appointment, check with this indexed query
const existingBooking = await getDocs(
  query(
    collection(firestore, 'appointments'),
    where('clinicId', '==', clinicId),
    where('doctor', '==', doctorName),
    where('date', '==', dateStr),
    where('slotIndex', '==', slotIndex),
    where('status', 'in', ['Pending', 'Confirmed'])
  )
);

if (!existingBooking.empty) {
  throw new Error('DUPLICATE_SLOT');
}
```

---

## 📊 **MONITORING DASHBOARD**

### **Create Admin Dashboard to View Duplicates:**

```typescript
// apps/clinic-admin/src/app/monitoring/duplicates/page.tsx

export default function DuplicatesMonitoringPage() {
  const [duplicates, setDuplicates] = useState([]);
  
  useEffect(() => {
    // Fetch duplicate bookings
    const fetchDuplicates = async () => {
      const snapshot = await getDocs(
        query(
          collection(db, 'duplicate-bookings'),
          orderBy('detectedAt', 'desc'),
          limit(100)
        )
      );
      setDuplicates(snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data(),
      })));
    };
    fetchDuplicates();
  }, []);
  
  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-4">
        Duplicate Booking Detection
      </h1>
      
      {/* Summary Cards */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <Card>
          <h3>Today's Duplicates</h3>
          <p className="text-3xl text-red-600">
            {duplicates.filter(d => isToday(d.detectedAt)).length}
          </p>
        </Card>
        
        <Card>
          <h3>This Week</h3>
          <p className="text-3xl">
            {duplicates.filter(d => isThisWeek(d.detectedAt)).length}
          </p>
        </Card>
        
        <Card>
          <h3>Total</h3>
          <p className="text-3xl">
            {duplicates.length}
          </p>
        </Card>
      </div>
      
      {/* Duplicate List */}
      <Table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Clinic</th>
            <th>Doctor</th>
            <th>Date</th>
            <th>Slot</th>
            <th>Token</th>
            <th>Count</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {duplicates.map(dup => (
            <tr key={dup.id} className="bg-red-50">
              <td>{formatTime(dup.detectedAt)}</td>
              <td>{dup.clinicId}</td>
              <td>{dup.doctor}</td>
              <td>{dup.date}</td>
              <td>{dup.slotIndex}</td>
              <td>{dup.tokenNumber}</td>
              <td className="text-red-600 font-bold">
                {dup.duplicateCount}
              </td>
              <td>
                <Button onClick={() => viewDetails(dup)}>
                  Investigate
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
      
      {duplicates.length === 0 && (
        <div className="text-center py-12 text-green-600">
          ✅ No duplicates detected!
        </div>
      )}
    </div>
  );
}
```

---

## 🚨 **ALERT SYSTEM**

### **Set Up Immediate Alerts:**

```typescript
// functions/src/alerts.ts

async function sendDuplicateAlert(data: {
  clinic: string;
  doctor: string;
  slot: number;
  token: string;
  count: number;
}) {
  // 1. Send SMS to admin
  await sendSMS({
    to: '+91 98765 43210', // Your number
    message: `🚨 DUPLICATE BOOKING!
Clinic: ${data.clinic}
Doctor: ${data.doctor}
Slot: ${data.slot}
Token: ${data.token}
Count: ${data.count}
Check dashboard immediately!`,
  });
  
  // 2. Send email
  await sendEmail({
    to: 'admin@kloqo.com',
    subject: '🚨 Duplicate Booking Detected',
    html: `
      <h2>Duplicate Booking Alert</h2>
      <p><strong>Clinic:</strong> ${data.clinic}</p>
      <p><strong>Doctor:</strong> ${data.doctor}</p>
      <p><strong>Slot:</strong> ${data.slot}</p>
      <p><strong>Token:</strong> ${data.token}</p>
      <p><strong>Duplicate Count:</strong> ${data.count}</p>
      <p>Check the admin dashboard immediately!</p>
    `,
  });
  
  // 3. Log to Sentry
  if (Sentry) {
    Sentry.captureMessage('Duplicate booking detected', {
      level: 'error',
      extra: data,
    });
  }
}
```

---

## 🧪 **TESTING FOR RACE CONDITIONS**

### **Simulate Concurrent Bookings:**

```typescript
// __tests__/concurrent-booking.test.ts

describe('Concurrent Booking Tests', () => {
  it('should prevent duplicate bookings when 2 users book simultaneously', async () => {
    const clinicId = 'test-clinic';
    const doctorName = 'Dr. Test';
    const date = new Date();
    const slotIndex = 5;
    
    // Simulate 2 users booking at the SAME TIME
    const booking1 = bookAppointment({
      clinicId,
      doctorName,
      date,
      slotIndex,
      patientName: 'Patient A',
    });
    
    const booking2 = bookAppointment({
      clinicId,
      doctorName,
      date,
      slotIndex,
      patientName: 'Patient B',
    });
    
    // Wait for both to complete
    const results = await Promise.allSettled([booking1, booking2]);
    
    // One should succeed, one should fail
    const successes = results.filter(r => r.status === 'fulfilled');
    const failures = results.filter(r => r.status === 'rejected');
    
    expect(successes.length).toBe(1);
    expect(failures.length).toBe(1);
    
    // Verify only ONE appointment was created
    const appointments = await getAppointments(clinicId, doctorName, date);
    const slotAppointments = appointments.filter(a => a.slotIndex === slotIndex);
    
    expect(slotAppointments.length).toBe(1);
  });
  
  it('should prevent duplicate tokens', async () => {
    // Similar test for token generation
    const results = await Promise.all([
      generateToken(clinicId, doctorName, date, 'A'),
      generateToken(clinicId, doctorName, date, 'A'),
      generateToken(clinicId, doctorName, date, 'A'),
    ]);
    
    // All tokens should be unique
    const uniqueTokens = new Set(results);
    expect(uniqueTokens.size).toBe(3);
  });
});
```

**Run Load Test:**
```bash
# Install artillery for load testing
npm install -g artillery

# Create test script
cat > load-test.yml << EOF
config:
  target: 'https://your-app.com'
  phases:
    - duration: 60
      arrivalRate: 10  # 10 users per second
scenarios:
  - name: 'Concurrent Booking'
    flow:
      - post:
          url: '/api/book-appointment'
          json:
            clinicId: 'test-clinic'
            doctor: 'Dr. Test'
            slotIndex: 5
EOF

# Run test
artillery run load-test.yml
```

---

## 📈 **METRICS TO TRACK**

### **Key Metrics:**

1. **Duplicate Rate**
   ```
   Duplicates per day / Total bookings per day
   Target: < 0.1% (1 in 1000)
   ```

2. **Transaction Retry Rate**
   ```
   Failed transactions / Total transactions
   High rate = many concurrent bookings
   ```

3. **Booking Conflicts by Time**
   ```
   Track when duplicates happen:
   - Morning rush (9-10 AM)
   - Evening rush (5-6 PM)
   - Optimize these times
   ```

4. **Clinic-Specific Patterns**
   ```
   Which clinics have most duplicates?
   - High-volume clinics need better infrastructure
   ```

---

## ✅ **RECOMMENDED IMPLEMENTATION**

### **Phase 1: Detection (This Week)**

1. **Add Firestore Trigger** (1 hour)
   ```typescript
   // Detects duplicates in real-time
   export const detectDuplicateBookings = ...
   ```

2. **Create Monitoring Dashboard** (2 hours)
   ```typescript
   // View duplicates in admin panel
   /monitoring/duplicates
   ```

3. **Set Up Alerts** (30 min)
   ```typescript
   // SMS + Email when duplicate detected
   sendDuplicateAlert(...)
   ```

**Cost:** FREE (uses Firebase)  
**Time:** 3.5 hours  
**Impact:** 🔴 **CRITICAL**

---

### **Phase 2: Prevention (Next Week)**

4. **Add Client-Side Validation** (1 hour)
   ```typescript
   // Double-check before booking
   validateBookingBeforeConfirm(...)
   ```

5. **Create Composite Index** (15 min)
   ```
   // Faster queries + better detection
   clinicId + doctor + date + slotIndex
   ```

6. **Add Load Testing** (2 hours)
   ```bash
   # Test concurrent bookings
   artillery run load-test.yml
   ```

**Cost:** FREE  
**Time:** 3.25 hours  
**Impact:** 🔴 **CRITICAL**

---

### **Phase 3: Audit (Ongoing)**

7. **Daily Audit Function** (1 hour)
   ```typescript
   // Runs every night
   dailyDuplicateAudit()
   ```

8. **Weekly Report** (30 min)
   ```typescript
   // Email summary every Monday
   weeklyDuplicateReport()
   ```

**Cost:** FREE  
**Time:** 1.5 hours  
**Impact:** 🟡 **IMPORTANT**

---

## 🎯 **FINAL RECOMMENDATION**

### **For Kloqo, implement this 3-layer defense:**

**Layer 1: Prevention (Your Code)**
- ✅ Firestore transactions (already have!)
- ✅ Client-side validation (add this)
- ✅ Composite indexes (add this)

**Layer 2: Detection (Real-time)**
- ✅ Firestore triggers (add this)
- ✅ Immediate alerts (add this)
- ✅ Monitoring dashboard (add this)

**Layer 3: Audit (Daily)**
- ✅ Nightly audit function (add this)
- ✅ Weekly reports (add this)

**Total Setup Time:** ~8 hours  
**Total Cost:** FREE (uses Firebase)  
**Impact:** Prevents chaos in clinics!

---

## 🚀 **NEXT STEPS**

1. **This Week:** Add Firestore trigger for duplicate detection
2. **This Week:** Create monitoring dashboard
3. **This Week:** Set up SMS/email alerts
4. **Next Week:** Add client-side validation
5. **Next Week:** Run load tests
6. **Ongoing:** Monitor daily audit reports

**You'll catch duplicates before they cause problems!** 🎉

---

**Prepared by:** Antigravity AI  
**Date:** December 10, 2025  
**Priority:** 🔴 **CRITICAL** - Implement before launch!
