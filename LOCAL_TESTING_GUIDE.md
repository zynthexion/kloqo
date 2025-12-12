# 🧪 Local Testing Guide

Complete step-by-step guide to test all Kloqo apps locally.

---

## ✅ Prerequisites Check

You already have:
- ✅ Node.js v24.4.1 (required: >= 18.0.0)
- ✅ pnpm 8.15.0 (required: >= 8.0.0)
- ✅ Environment files (.env.local) exist

---

## 📋 Step 1: Install Dependencies

```bash
# Navigate to project root
cd /Users/jinodevasia/Desktop/Kloqo-Production

# Install all dependencies (monorepo-wide)
pnpm install
```

**Expected output:**
- All packages from `packages/` will be linked
- All app dependencies will be installed
- Takes 2-5 minutes depending on internet speed

**If you get errors:**
```bash
# Clean install (if needed)
rm -rf node_modules pnpm-lock.yaml
pnpm install
```

---

## 🔧 Step 2: Verify Environment Variables

Your `.env.local` files should already exist. Verify they have Firebase config:

**Check each app:**
```bash
# Patient App
cat apps/patient-app/.env.local | grep NEXT_PUBLIC_FIREBASE

# Nurse App  
cat apps/nurse-app/.env.local | grep NEXT_PUBLIC_FIREBASE

# Clinic Admin
cat apps/clinic-admin/.env.local | grep NEXT_PUBLIC_FIREBASE
```

**Required variables (should be in each .env.local):**
```bash
NEXT_PUBLIC_FIREBASE_API_KEY=...
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=...
NEXT_PUBLIC_FIREBASE_PROJECT_ID=...
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=...
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=...
NEXT_PUBLIC_FIREBASE_APP_ID=...
```

---

## 🚀 Step 3: Run Apps Locally

### Option A: Run One App at a Time (Recommended for Testing)

**Patient App:**
```bash
# From project root
pnpm dev:patient

# Or from app directory
cd apps/patient-app
pnpm dev
```

**Access:** http://localhost:3000

---

**Nurse App:**
```bash
# From project root
pnpm dev:nurse

# Or from app directory
cd apps/nurse-app
pnpm dev
```

**Access:** http://localhost:3000 (stop patient app first, or it will use port 3001)

---

**Clinic Admin:**
```bash
# From project root
pnpm dev:clinic

# Or from app directory
cd apps/clinic-admin
pnpm dev
```

**Access:** http://localhost:3000

---

**Superadmin:**
```bash
# From project root
pnpm dev:superadmin
```

**Access:** http://localhost:3000

---

### Option B: Run All Apps Simultaneously

```bash
# From project root
pnpm dev
```

This uses Turbo to run all apps in parallel:
- Patient App: http://localhost:3000
- Nurse App: http://localhost:3001
- Clinic Admin: http://localhost:3002
- Superadmin: http://localhost:3003

**Note:** This uses more resources. Use Option A for focused testing.

---

## 🧪 Step 4: Testing Checklist

### For Each App:

#### ✅ **1. Initial Load**
- [ ] App loads without errors
- [ ] No console errors (F12 → Console)
- [ ] Firebase connection successful
- [ ] No 404 errors in Network tab

#### ✅ **2. Authentication**
- [ ] Login page loads
- [ ] Can create account (if applicable)
- [ ] Can log in with existing credentials
- [ ] Session persists on refresh
- [ ] Logout works

#### ✅ **3. Core Functionality**

**Patient App:**
- [ ] Can view clinics
- [ ] Can book appointments
- [ ] Can view appointments
- [ ] Can see walk-in queue
- [ ] Notifications work (if enabled)
- [ ] PWA installs (mobile)

**Nurse App:**
- [ ] Dashboard loads
- [ ] Can view appointments
- [ ] Can manage queue
- [ ] Can schedule breaks
- [ ] Can update appointment status
- [ ] Real-time updates work

**Clinic Admin:**
- [ ] Dashboard loads
- [ ] Can view statistics
- [ ] Can manage doctors
- [ ] Can manage departments
- [ ] Can view reports
- [ ] Can manage clinic settings

#### ✅ **4. Real-time Features**
- [ ] Firestore listeners work (appointments update in real-time)
- [ ] Queue updates automatically
- [ ] Status changes reflect immediately

#### ✅ **5. Error Handling**
- [ ] Error boundaries catch errors
- [ ] User-friendly error messages
- [ ] Network errors handled gracefully

#### ✅ **6. Responsive Design**
- [ ] Works on desktop (1920x1080)
- [ ] Works on tablet (768x1024)
- [ ] Works on mobile (375x667)
- [ ] Navigation works on all sizes

---

## 🔍 Step 5: Debugging Tips

### Check Browser Console (F12)

**Look for:**
- ❌ Red errors (fix these first)
- ⚠️ Yellow warnings (review)
- ✅ Green success messages

**Common Issues:**

1. **Firebase not initialized**
   ```
   Error: Firebase: No Firebase App '[DEFAULT]' has been created
   ```
   **Fix:** Check `.env.local` has all `NEXT_PUBLIC_FIREBASE_*` variables

2. **Module not found**
   ```
   Error: Cannot find module '@kloqo/shared-core'
   ```
   **Fix:** Run `pnpm install` from project root

3. **Port already in use**
   ```
   Error: Port 3000 is already in use
   ```
   **Fix:** Stop other apps or use different port:
   ```bash
   PORT=3001 pnpm dev:patient
   ```

### Check Terminal Output

**Look for:**
- ✅ "Ready" message
- ✅ "Compiled successfully"
- ❌ Build errors
- ❌ TypeScript errors

**Common Terminal Errors:**

1. **TypeScript errors**
   ```bash
   # Fix before running
   pnpm typecheck
   ```

2. **Build errors**
   ```bash
   # Try building first
   pnpm --filter patient-app build
   ```

3. **Dependency issues**
   ```bash
   # Reinstall dependencies
   pnpm install --force
   ```

---

## 🛠️ Step 6: Type Checking & Building

Before deploying, verify everything works:

```bash
# Type check all apps
pnpm typecheck

# Build all apps (production mode)
pnpm build

# Build individual app
pnpm --filter patient-app build
pnpm --filter nurse-app build
pnpm --filter clinic-admin build
```

**If builds fail:**
- Fix TypeScript errors first
- Check for missing dependencies
- Verify environment variables

---

## 🧹 Step 7: Clean Up (If Needed)

If you encounter issues:

```bash
# Clean all node_modules
pnpm clean

# Reinstall
pnpm install

# Clear Next.js cache
rm -rf apps/*/.next
rm -rf apps/*/out

# Clear Turbo cache
rm -rf .turbo
```

---

## 📊 Step 8: Performance Testing

### Check Bundle Size

```bash
# Analyze bundle (patient-app example)
cd apps/patient-app
ANALYZE=true pnpm build
# Opens bundle-analysis.html in browser
```

### Check Lighthouse Score

1. Open app in Chrome
2. F12 → Lighthouse tab
3. Run audit
4. Target: 90+ score

---

## 🐛 Common Issues & Solutions

### Issue: App won't start

**Solution:**
```bash
# 1. Check if port is in use
lsof -ti:3000 | xargs kill -9

# 2. Clear cache
rm -rf apps/patient-app/.next

# 3. Reinstall
pnpm install

# 4. Try again
pnpm dev:patient
```

### Issue: Firebase connection fails

**Solution:**
1. Verify `.env.local` exists in app directory
2. Check all `NEXT_PUBLIC_FIREBASE_*` variables are set
3. Restart dev server after changing env vars
4. Check Firebase Console for project status

### Issue: Shared packages not found

**Solution:**
```bash
# Rebuild shared packages
pnpm --filter shared-core build
pnpm --filter shared-types build
pnpm --filter shared-firebase build
pnpm --filter shared-ui build

# Then restart app
```

### Issue: Hot reload not working

**Solution:**
```bash
# Clear Next.js cache
rm -rf apps/patient-app/.next

# Restart dev server
pnpm dev:patient
```

---

## 📝 Testing Workflow

**Recommended workflow:**

1. **Start with one app** (e.g., patient-app)
2. **Test all features** thoroughly
3. **Fix any issues** before moving to next app
4. **Repeat** for each app
5. **Test integration** between apps (if applicable)

**Time estimate:**
- Patient App: 30-60 minutes
- Nurse App: 30-60 minutes
- Clinic Admin: 30-60 minutes
- **Total: 2-3 hours for thorough testing**

---

## ✅ Success Criteria

Your apps are ready for deployment when:

- ✅ All apps start without errors
- ✅ All core features work
- ✅ No console errors
- ✅ Type checking passes (`pnpm typecheck`)
- ✅ Build succeeds (`pnpm build`)
- ✅ Responsive design works
- ✅ Real-time features work
- ✅ Error handling works

---

## 🚀 Next Steps

Once local testing is complete:

1. **Fix any issues** found during testing
2. **Commit changes** to git
3. **Deploy to Vercel** (see Vercel deployment guide)
4. **Test in production** environment
5. **Monitor** for errors

---

## 💡 Pro Tips

1. **Use separate terminal windows** for each app when testing multiple
2. **Keep browser console open** to catch errors early
3. **Test on different devices** (phone, tablet, desktop)
4. **Test with slow network** (Chrome DevTools → Network → Throttling)
5. **Test error scenarios** (disconnect internet, invalid inputs)
6. **Use React DevTools** for component debugging
7. **Check Network tab** for failed API calls

---

**Happy Testing! 🎉**





