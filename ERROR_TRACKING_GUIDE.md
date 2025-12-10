# 🐛 PRODUCTION ERROR TRACKING & MONITORING GUIDE
**For Kloqo App - Kerala Clinic Management**  
**Date:** December 10, 2025

---

## ❌ **WHY MANUAL FEEDBACK IS NOT ENOUGH**

### Problems with Manual Feedback Only:

1. **Users Don't Report Most Bugs**
   - 95% of users won't report errors
   - They'll just stop using the app
   - You'll lose clinics without knowing why

2. **Missing Critical Context**
   - User says "it's not working"
   - But you don't know:
     - What browser/device?
     - What were they doing?
     - What error occurred?
     - When did it happen?

3. **Silent Failures**
   - Background errors (notifications, queue updates)
   - Users don't even know something failed
   - But your app is broken

4. **Can't Reproduce**
   - User: "It crashed yesterday"
   - You: "What were you doing?"
   - User: "I don't remember"
   - Result: Can't fix the bug

---

## ✅ **RECOMMENDED SOLUTION: AUTOMATED ERROR TRACKING**

### **Best Tools for Your Stack (Next.js + Firebase):**

| Tool | Best For | Cost | Rating |
|------|----------|------|--------|
| **Sentry** | Error tracking | Free tier → ₹2,000/mo | ⭐⭐⭐⭐⭐ |
| **LogRocket** | Session replay | ₹8,000/mo | ⭐⭐⭐⭐⭐ |
| **Firebase Crashlytics** | Mobile crashes | Free | ⭐⭐⭐⭐ |
| **Vercel Analytics** | Performance | Free tier | ⭐⭐⭐⭐ |
| **Google Analytics 4** | User behavior | Free | ⭐⭐⭐ |

---

## 🎯 **RECOMMENDED SETUP (3-TIER APPROACH)**

### **Tier 1: Essential (Launch Day)** 🔴 MUST HAVE

#### 1. **Sentry** - Error Tracking (FREE to start)

**What It Does:**
- Captures all JavaScript errors automatically
- Shows you the exact line of code that failed
- Tells you browser, device, user info
- Groups similar errors together
- Alerts you when errors spike

**Why Sentry for Kloqo:**
- ✅ Perfect for Next.js (official integration)
- ✅ Works with Firebase
- ✅ Free tier: 5,000 errors/month (enough for launch)
- ✅ Shows you Kerala-specific issues (browser versions, devices)
- ✅ Easy to set up (15 minutes)

**Setup:**
```bash
# Install Sentry
npm install --save @sentry/nextjs

# Initialize (automatic setup)
npx @sentry/wizard@latest -i nextjs
```

**What You'll See:**
```
Error: Failed to book appointment
Browser: Chrome 120 on Android 12
Device: Samsung Galaxy M32 (common in Kerala!)
User: +91 98765 43210
Location: Kochi, Kerala
Time: 2025-12-10 14:30 IST
Stack trace: 
  at bookAppointment (walk-in.service.ts:523)
  at onClick (book-button.tsx:45)
```

**Cost:**
- Free: 5,000 errors/month
- Paid: ₹2,000/month (50,000 errors)
- For 100 clinics: Free tier is enough

---

#### 2. **Custom Error Logger** (Already in Your Code!)

**You Already Have:**
```typescript
// packages/shared-core/src/lib/logger.ts
// apps/patient-app/src/lib/error-logger.ts
```

**Enhance It:**
```typescript
// Enhanced error logger with Firebase integration
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '@/lib/firebase';

export async function logError(error: Error, context?: any) {
  // Log to console (development)
  console.error('[ERROR]', error, context);
  
  // Log to Firebase (production)
  if (process.env.NODE_ENV === 'production') {
    try {
      await addDoc(collection(db, 'error-logs'), {
        message: error.message,
        stack: error.stack,
        context: context || {},
        userAgent: navigator.userAgent,
        url: window.location.href,
        timestamp: serverTimestamp(),
        // Kerala-specific data
        language: localStorage.getItem('app-language'),
        clinic: context?.clinicId,
        doctor: context?.doctorName,
      });
    } catch (e) {
      // Don't let error logging break the app
      console.error('Failed to log error:', e);
    }
  }
  
  // Also send to Sentry
  if (typeof window !== 'undefined' && window.Sentry) {
    window.Sentry.captureException(error, { extra: context });
  }
}
```

**Usage:**
```typescript
// In your booking code
try {
  await bookAppointment(data);
} catch (error) {
  logError(error, {
    action: 'book-appointment',
    clinicId: clinic.id,
    doctorName: doctor.name,
    bookingType: 'walk-in',
    language: currentLanguage,
  });
  throw error;
}
```

**Why This Helps:**
- ✅ Stores errors in Firebase (you already have it)
- ✅ Can query by clinic, doctor, language
- ✅ See Kerala-specific patterns
- ✅ Free (uses your existing Firebase)

---

### **Tier 2: Advanced (After 1 Month)** 🟡 HIGHLY RECOMMENDED

#### 3. **LogRocket** - Session Replay

**What It Does:**
- Records user sessions like a video
- Shows you EXACTLY what user did before error
- Replays mouse movements, clicks, typing
- Shows network requests, console logs
- Like having a screen recording of every bug

**Why LogRocket for Kloqo:**
- ✅ See exactly how users book appointments
- ✅ Understand Malayalam UI issues
- ✅ Watch walk-in booking flow
- ✅ See what confuses users

**Example:**
```
User: Dr. Clinic, Kochi
Session: 2025-12-10 15:45 IST
Duration: 3 minutes

Timeline:
0:00 - Opened app
0:15 - Switched to Malayalam
0:30 - Clicked "Book Appointment"
0:45 - Selected doctor
1:00 - Selected date
1:15 - Clicked time slot
1:20 - ERROR: "Slot not available"
      (But slot showed as available!)

You can watch the video replay!
```

**Cost:**
- ₹8,000/month (1,000 sessions)
- Expensive but worth it for critical bugs

**When to Use:**
- After launch, when you have revenue
- For debugging complex booking issues
- When users report "it's not working" but you can't reproduce

---

#### 4. **Firebase Performance Monitoring** (FREE!)

**What It Does:**
- Tracks app performance
- Shows slow pages
- Monitors API response times
- Detects network issues

**Why for Kloqo:**
- ✅ Free (included with Firebase)
- ✅ See if Kerala's network is slow
- ✅ Find slow booking flows
- ✅ Optimize for 3G/4G users

**Setup:**
```typescript
// Already in Firebase SDK
import { getPerformance } from 'firebase/performance';

const perf = getPerformance(app);
// Automatically tracks page loads, network requests
```

**What You'll See:**
```
Page Load Times:
- Home: 1.2s (good)
- Book Appointment: 3.5s (slow! ⚠️)
- Live Token: 0.8s (excellent)

Network Requests:
- /api/book-appointment: 2.1s (slow in Kochi)
- /api/get-doctors: 0.5s (fast)

Devices:
- 4G: 1.5s average
- 3G: 4.2s average (many Kerala users!)
```

---

### **Tier 3: Analytics (After 3 Months)** 🟢 NICE TO HAVE

#### 5. **Google Analytics 4** (FREE)

**What It Does:**
- Tracks user behavior
- Shows popular features
- Conversion funnels
- User retention

**Why for Kloqo:**
- ✅ Free
- ✅ See which features users love
- ✅ Track booking completion rate
- ✅ Understand drop-off points

**Key Metrics to Track:**
```
Booking Funnel:
1. Select Doctor: 100 users
2. Select Date: 85 users (15% drop-off)
3. Select Time: 70 users (15% drop-off)
4. Confirm Booking: 60 users (10% drop-off)
5. Booking Success: 58 users (2% error rate)

Language Usage:
- English: 45%
- Malayalam: 55% (great!)

Booking Type:
- Advance: 40%
- Walk-in: 60% (matches Kerala pattern!)
```

---

## 🚀 **IMPLEMENTATION PLAN**

### **Phase 1: Launch Day (Essential)**

**Week 1: Set Up Sentry**
```bash
# 1. Install Sentry
npm install --save @sentry/nextjs

# 2. Initialize
npx @sentry/wizard@latest -i nextjs

# 3. Configure for all apps
# Patient app
cd apps/patient-app
npx @sentry/wizard@latest -i nextjs

# Nurse app
cd apps/nurse-app
npx @sentry/wizard@latest -i nextjs

# Clinic admin
cd apps/clinic-admin
npx @sentry/wizard@latest -i nextjs
```

**Configuration:**
```typescript
// sentry.client.config.ts (auto-generated)
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  
  // Kerala-specific configuration
  environment: process.env.NODE_ENV,
  
  // Sample rate (adjust based on traffic)
  tracesSampleRate: 0.1, // 10% of transactions
  
  // Ignore common errors
  ignoreErrors: [
    'ResizeObserver loop limit exceeded',
    'Non-Error promise rejection captured',
  ],
  
  // Add Kerala context
  beforeSend(event, hint) {
    // Add language info
    event.tags = {
      ...event.tags,
      language: localStorage.getItem('app-language') || 'en',
    };
    
    // Add clinic info if available
    const clinic = localStorage.getItem('current-clinic');
    if (clinic) {
      event.tags.clinic = clinic;
    }
    
    return event;
  },
});
```

**Cost:** FREE (5,000 errors/month)  
**Time:** 30 minutes  
**Impact:** 🔴 **CRITICAL**

---

**Week 1: Enhance Error Logger**

```typescript
// packages/shared-core/src/lib/error-logger.ts
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';

export interface ErrorContext {
  action?: string;
  clinicId?: string;
  doctorName?: string;
  bookingType?: 'advance' | 'walk-in';
  language?: string;
  userId?: string;
  [key: string]: any;
}

export async function logError(
  error: Error,
  context?: ErrorContext
) {
  const errorData = {
    message: error.message,
    stack: error.stack,
    name: error.name,
    context: context || {},
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
    url: typeof window !== 'undefined' ? window.location.href : 'unknown',
    timestamp: serverTimestamp(),
    language: typeof localStorage !== 'undefined' 
      ? localStorage.getItem('app-language') 
      : 'unknown',
  };

  // Console log in development
  if (process.env.NODE_ENV === 'development') {
    console.error('[ERROR]', errorData);
  }

  // Log to Firebase in production
  if (process.env.NODE_ENV === 'production') {
    try {
      const db = (await import('@/lib/firebase')).db;
      await addDoc(collection(db, 'error-logs'), errorData);
    } catch (e) {
      console.error('Failed to log error to Firebase:', e);
    }
  }

  // Send to Sentry if available
  if (typeof window !== 'undefined' && (window as any).Sentry) {
    (window as any).Sentry.captureException(error, {
      extra: context,
    });
  }
}

// Convenience function for booking errors
export async function logBookingError(
  error: Error,
  bookingData: {
    clinicId: string;
    doctorName: string;
    bookingType: 'advance' | 'walk-in';
    date: string;
    time?: string;
  }
) {
  await logError(error, {
    action: 'booking-failed',
    ...bookingData,
  });
}
```

**Usage in Your Code:**
```typescript
// In walk-in.service.ts
import { logBookingError } from '@kloqo/shared-core';

export async function generateNextTokenAndReserveSlot(...) {
  try {
    // Your existing booking logic
    const result = await runTransaction(firestore, async (transaction) => {
      // ... booking logic
    });
    return result;
  } catch (error) {
    // Log the error with context
    await logBookingError(error as Error, {
      clinicId,
      doctorName,
      bookingType: type === 'W' ? 'walk-in' : 'advance',
      date: format(date, 'd MMMM yyyy'),
      time: appointmentData.time,
    });
    
    // Re-throw so UI can handle it
    throw error;
  }
}
```

**Cost:** FREE (uses Firebase)  
**Time:** 1 hour  
**Impact:** 🔴 **CRITICAL**

---

**Week 1: Set Up Firebase Performance**

```typescript
// apps/patient-app/src/lib/firebase.ts
import { getPerformance } from 'firebase/performance';

export const perf = getPerformance(app);

// That's it! Auto-tracks everything
```

**Cost:** FREE  
**Time:** 5 minutes  
**Impact:** 🟡 **IMPORTANT**

---

### **Phase 2: After 1 Month (Advanced)**

**Month 2: Add LogRocket** (if revenue allows)

```bash
npm install --save logrocket
npm install --save logrocket-react
```

```typescript
// apps/patient-app/src/app/layout.tsx
import LogRocket from 'logrocket';

if (process.env.NODE_ENV === 'production') {
  LogRocket.init('your-app-id');
  
  // Identify users
  LogRocket.identify(user.id, {
    name: user.name,
    phone: user.phone,
    language: currentLanguage,
  });
}
```

**Cost:** ₹8,000/month  
**Time:** 30 minutes  
**Impact:** 🟡 **VERY HELPFUL**

---

### **Phase 3: After 3 Months (Analytics)**

**Month 3: Set Up Google Analytics 4**

```bash
npm install --save @next/third-parties
```

```typescript
// apps/patient-app/src/app/layout.tsx
import { GoogleAnalytics } from '@next/third-parties/google';

export default function RootLayout({ children }) {
  return (
    <html>
      <body>
        {children}
        <GoogleAnalytics gaId="G-XXXXXXXXXX" />
      </body>
    </html>
  );
}
```

**Track Custom Events:**
```typescript
// Track booking completion
gtag('event', 'booking_completed', {
  booking_type: 'walk-in',
  clinic_id: clinicId,
  doctor_name: doctorName,
  language: currentLanguage,
});
```

**Cost:** FREE  
**Time:** 1 hour  
**Impact:** 🟢 **NICE TO HAVE**

---

## 📊 **WHAT YOU'LL SEE IN PRODUCTION**

### **Sentry Dashboard:**
```
Today's Errors: 12
↑ 200% from yesterday (investigate!)

Top Errors:
1. "Slot not available" - 8 occurrences
   - Affected users: 8
   - First seen: 10:30 AM
   - Last seen: 2:45 PM
   - Browsers: Chrome (6), Safari (2)
   - Locations: Kochi (5), Trivandrum (3)
   
2. "Network request failed" - 3 occurrences
   - Affected users: 3
   - Browsers: Chrome on Android
   - Locations: All in Kozhikode
   - Likely: Network issue in Kozhikode

3. "Invalid token format" - 1 occurrence
   - User: +91 98765 43210
   - Clinic: Dr. Rajesh Clinic, Kochi
   - Time: 11:15 AM
   - Stack trace shows exact line
```

### **Firebase Error Logs Query:**
```typescript
// Query errors by clinic
const errors = await getDocs(
  query(
    collection(db, 'error-logs'),
    where('context.clinicId', '==', 'clinic-123'),
    orderBy('timestamp', 'desc'),
    limit(50)
  )
);

// Query Malayalam-specific errors
const mlErrors = await getDocs(
  query(
    collection(db, 'error-logs'),
    where('language', '==', 'ml'),
    orderBy('timestamp', 'desc')
  )
);
```

---

## 🎯 **KERALA-SPECIFIC MONITORING**

### **Track These Metrics:**

1. **Device Distribution**
   ```
   Samsung Galaxy M32: 25% (most common in Kerala)
   Redmi Note 11: 20%
   iPhone 12: 10%
   Others: 45%
   ```

2. **Network Speed**
   ```
   4G: 60%
   3G: 30% (still common in Kerala!)
   WiFi: 10%
   ```

3. **Language Usage**
   ```
   Malayalam: 55%
   English: 45%
   ```

4. **Error Patterns by Location**
   ```
   Kochi: 40% of errors (most users)
   Trivandrum: 25%
   Kozhikode: 20%
   Others: 15%
   ```

5. **Time-Based Patterns**
   ```
   Morning (9-12): 45% of bookings, 30% of errors
   Afternoon (12-4): 20% of bookings, 15% of errors
   Evening (4-8): 35% of bookings, 55% of errors (peak!)
   ```

---

## 💰 **COST BREAKDOWN**

### **Recommended Setup:**

| Tool | When | Cost/Month | Value |
|------|------|------------|-------|
| **Sentry** | Launch day | FREE | 🔴 Critical |
| **Firebase Errors** | Launch day | FREE | 🔴 Critical |
| **Firebase Performance** | Launch day | FREE | 🟡 Important |
| **LogRocket** | Month 2 | ₹8,000 | 🟡 Very helpful |
| **Google Analytics** | Month 3 | FREE | 🟢 Nice to have |

**Total Cost:**
- **Month 1:** ₹0 (all free!)
- **Month 2+:** ₹8,000 (if you add LogRocket)

**ROI:**
- Catch bugs before they lose you clinics
- Fix issues 10x faster
- Understand Kerala user behavior
- Worth every rupee!

---

## 🚨 **ALERTING STRATEGY**

### **Set Up Alerts:**

**Sentry Alerts:**
```
1. New Error Type
   → Slack notification immediately
   → Email to you

2. Error Spike (>10 errors/hour)
   → SMS to you
   → Slack notification

3. Critical Errors (booking failures)
   → Immediate SMS
   → Call if >5 in 10 minutes
```

**Firebase Alerts:**
```
1. Performance degradation
   → Email daily summary

2. Crash rate >1%
   → Slack notification
```

---

## 📱 **MONITORING DASHBOARD**

### **Create a Simple Admin Dashboard:**

```typescript
// apps/clinic-admin/src/app/monitoring/page.tsx
export default function MonitoringPage() {
  const [errors, setErrors] = useState([]);
  
  useEffect(() => {
    // Fetch recent errors
    const fetchErrors = async () => {
      const snapshot = await getDocs(
        query(
          collection(db, 'error-logs'),
          orderBy('timestamp', 'desc'),
          limit(100)
        )
      );
      setErrors(snapshot.docs.map(doc => doc.data()));
    };
    fetchErrors();
  }, []);
  
  return (
    <div>
      <h1>Error Monitoring</h1>
      
      {/* Error summary */}
      <div className="grid grid-cols-3 gap-4">
        <Card>
          <h3>Today's Errors</h3>
          <p className="text-3xl">{todayErrors.length}</p>
        </Card>
        
        <Card>
          <h3>Most Common</h3>
          <p>{mostCommonError}</p>
        </Card>
        
        <Card>
          <h3>Affected Clinics</h3>
          <p>{affectedClinics.length}</p>
        </Card>
      </div>
      
      {/* Error list */}
      <Table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Error</th>
            <th>Clinic</th>
            <th>Language</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {errors.map(error => (
            <tr key={error.id}>
              <td>{formatTime(error.timestamp)}</td>
              <td>{error.message}</td>
              <td>{error.context.clinicId}</td>
              <td>{error.language}</td>
              <td>
                <Button onClick={() => viewDetails(error)}>
                  View
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}
```

---

## ✅ **RECOMMENDED SETUP (TL;DR)**

### **Launch Day (FREE):**
1. ✅ Set up Sentry (30 min)
2. ✅ Enhance error logger (1 hour)
3. ✅ Enable Firebase Performance (5 min)

### **After 1 Month (₹8,000/mo):**
4. ✅ Add LogRocket for session replay

### **After 3 Months (FREE):**
5. ✅ Set up Google Analytics

---

## 🎯 **FINAL RECOMMENDATION**

**For Kloqo, I recommend:**

### **Tier 1 (Essential - Launch Day):**
- ✅ **Sentry** - Error tracking (FREE)
- ✅ **Custom Firebase Logger** - Kerala-specific tracking (FREE)
- ✅ **Firebase Performance** - Speed monitoring (FREE)

**Total Cost:** ₹0/month  
**Setup Time:** 2 hours  
**Impact:** Catch 90% of bugs automatically

### **Tier 2 (After Revenue):**
- ✅ **LogRocket** - Session replay (₹8,000/mo)

**Total Cost:** ₹8,000/month  
**Impact:** Debug complex issues 10x faster

---

## 🚀 **NEXT STEPS**

1. **This Week:** Set up Sentry (30 min)
2. **This Week:** Enhance error logger (1 hour)
3. **This Week:** Test error tracking (30 min)
4. **Launch Day:** Monitor errors in real-time
5. **Month 2:** Add LogRocket if needed

**You'll never miss a bug again!** 🎉

---

**Prepared by:** Antigravity AI  
**Date:** December 10, 2025  
**Recommendation:** Start with FREE tier (Sentry + Firebase)
