# 🚀 GITHUB & VERCEL DEPLOYMENT GUIDE
**For Kloqo Monorepo**  
**Date:** December 10, 2025

---

## 📋 **YOUR SSH KEYS SETUP**

You have **2 SSH keys**:
1. `id_ed25519` - Default GitHub key
2. `id_ed25519_kloqo` - Kloqo-specific key

**SSH Config:**
```
Host github.com
    IdentityFile ~/.ssh/id_ed25519

Host github-kloqo
    IdentityFile ~/.ssh/id_ed25519_kloqo
```

---

## ⚙️ **STEP 1: CONFIGURE GIT**

### **Option A: Use Kloqo-Specific Key (Recommended)**

```bash
# 1. Set up git user for this repo
cd /Users/jinodevasia/Desktop/Kloqo-Production

# 2. Configure user (replace with your GitHub email)
git config user.name "Jino Devasia"
git config user.email "your-github-email@example.com"  # ← Replace this!

# 3. Update remote to use kloqo SSH key
git remote remove origin
git remote add origin git@github-kloqo:zynthexion/kloqo.git

# 4. Verify
git remote -v
```

### **Option B: Use Default Key**

```bash
# If you want to use your default SSH key
git config user.name "Jino Devasia"
git config user.email "your-github-email@example.com"  # ← Replace this!

# Remote is already set to:
# git@github.com:zynthexion/kloqo.git
```

---

## 🔑 **STEP 2: ADD SSH KEY TO GITHUB**

### **Check Which Key to Add:**

```bash
# For Kloqo key:
cat ~/.ssh/id_ed25519_kloqo.pub

# For default key:
cat ~/.ssh/id_ed25519.pub
```

### **Add to GitHub:**

1. Copy the SSH key output
2. Go to: https://github.com/settings/keys
3. Click "New SSH key"
4. Title: "Kloqo Deployment Key"
5. Paste the key
6. Click "Add SSH key"

### **Test Connection:**

```bash
# Test Kloqo key:
ssh -T git@github-kloqo

# Test default key:
ssh -T git@github.com

# Should see: "Hi zynthexion! You've successfully authenticated..."
```

---

## 📤 **STEP 3: PUSH TO GITHUB**

```bash
cd /Users/jinodevasia/Desktop/Kloqo-Production

# 1. Check current status
git status

# 2. Make sure all changes are committed
git add -A
git commit -m "Final commit before deployment"

# 3. Push to GitHub
git push -u origin main

# If you get permission denied:
# - Make sure SSH key is added to GitHub
# - Check you're using the right remote (github.com vs github-kloqo)
```

---

## 🌐 **STEP 4: DEPLOY TO VERCEL**

### **Prerequisites:**

1. **Vercel Account:** https://vercel.com/signup
2. **Install Vercel CLI:**
   ```bash
   npm install -g vercel
   ```

### **Deployment Steps:**

#### **A. Deploy Patient App**

```bash
# 1. Login to Vercel
vercel login

# 2. Navigate to patient app
cd apps/patient-app

# 3. Deploy
vercel

# Follow prompts:
# - Set up and deploy? Yes
# - Which scope? Your account
# - Link to existing project? No
# - Project name? kloqo-patient-app
# - Directory? ./
# - Override settings? No

# 4. Deploy to production
vercel --prod
```

**Environment Variables (Add in Vercel Dashboard):**
```
NEXT_PUBLIC_FIREBASE_API_KEY=your_api_key
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=your_project.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=your_project_id
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=your_project.appspot.com
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=123456789
NEXT_PUBLIC_FIREBASE_APP_ID=1:123456789:web:abcdef
NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID=G-XXXXXXXXXX
NEXT_PUBLIC_FIREBASE_VAPID_KEY=your_vapid_key
NEXT_PUBLIC_APP_URL=https://kloqo-patient-app.vercel.app
NEXT_PUBLIC_PATIENT_APP_URL=https://kloqo-patient-app.vercel.app
```

#### **B. Deploy Nurse App**

```bash
# 1. Navigate to nurse app
cd ../nurse-app

# 2. Deploy
vercel

# Follow prompts:
# - Project name? kloqo-nurse-app

# 3. Deploy to production
vercel --prod
```

**Environment Variables:**
```
NEXT_PUBLIC_FIREBASE_API_KEY=your_api_key
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=your_project.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=your_project_id
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=your_project.appspot.com
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=123456789
NEXT_PUBLIC_FIREBASE_APP_ID=1:123456789:web:abcdef
NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID=G-XXXXXXXXXX
NEXT_PUBLIC_FIREBASE_VAPID_KEY=your_vapid_key
NEXT_PUBLIC_APP_URL=https://kloqo-nurse-app.vercel.app
NEXT_PUBLIC_PATIENT_APP_URL=https://kloqo-patient-app.vercel.app
```

#### **C. Deploy Clinic Admin**

```bash
# 1. Navigate to clinic admin
cd ../clinic-admin

# 2. Deploy
vercel

# Follow prompts:
# - Project name? kloqo-clinic-admin

# 3. Deploy to production
vercel --prod
```

**Environment Variables:**
```
NEXT_PUBLIC_FIREBASE_API_KEY=your_api_key
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=your_project.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=your_project_id
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=your_project.appspot.com
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=123456789
NEXT_PUBLIC_FIREBASE_APP_ID=1:123456789:web:abcdef
NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID=G-XXXXXXXXXX
NEXT_PUBLIC_FIREBASE_VAPID_KEY=your_vapid_key
NEXT_PUBLIC_APP_URL=https://kloqo-clinic-admin.vercel.app
NEXT_PUBLIC_PATIENT_APP_URL=https://kloqo-patient-app.vercel.app
```

---

## 🎯 **ALTERNATIVE: DEPLOY VIA VERCEL DASHBOARD (EASIER!)**

### **Recommended for Monorepo:**

1. **Go to:** https://vercel.com/new

2. **Import Git Repository:**
   - Click "Import Git Repository"
   - Select "GitHub"
   - Authorize Vercel to access your GitHub
   - Select `zynthexion/kloqo` repository

3. **Configure Patient App:**
   - Project Name: `kloqo-patient-app`
   - Framework Preset: `Next.js`
   - Root Directory: `apps/patient-app`
   - Build Command: `cd ../.. && pnpm install && pnpm run build --filter=patient-app`
   - Output Directory: `.next`
   - Install Command: `pnpm install`
   
4. **Add Environment Variables:**
   - Click "Environment Variables"
   - Add all Firebase variables (see above)
   - Click "Deploy"

5. **Repeat for Nurse App:**
   - Root Directory: `apps/nurse-app`
   - Build Command: `cd ../.. && pnpm install && pnpm run build --filter=nurse-app`

6. **Repeat for Clinic Admin:**
   - Root Directory: `apps/clinic-admin`
   - Build Command: `cd ../.. && pnpm install && pnpm run build --filter=clinic-admin`

---

## ⚙️ **VERCEL CONFIGURATION FILES**

### **Create `vercel.json` in Root:**

```json
{
  "version": 2,
  "buildCommand": "pnpm install && turbo run build",
  "installCommand": "pnpm install",
  "framework": null,
  "public": false
}
```

### **Create `vercel.json` in Each App:**

**`apps/patient-app/vercel.json`:**
```json
{
  "buildCommand": "cd ../.. && pnpm install && pnpm run build --filter=patient-app",
  "devCommand": "cd ../.. && pnpm run dev --filter=patient-app",
  "installCommand": "cd ../.. && pnpm install",
  "framework": "nextjs",
  "outputDirectory": ".next"
}
```

**`apps/nurse-app/vercel.json`:**
```json
{
  "buildCommand": "cd ../.. && pnpm install && pnpm run build --filter=nurse-app",
  "devCommand": "cd ../.. && pnpm run dev --filter=nurse-app",
  "installCommand": "cd ../.. && pnpm install",
  "framework": "nextjs",
  "outputDirectory": ".next"
}
```

**`apps/clinic-admin/vercel.json`:**
```json
{
  "buildCommand": "cd ../.. && pnpm install && pnpm run build --filter=clinic-admin",
  "devCommand": "cd ../.. && pnpm run dev --filter=clinic-admin",
  "installCommand": "cd ../.. && pnpm install",
  "framework": "nextjs",
  "outputDirectory": ".next"
}
```

---

## 🔧 **TROUBLESHOOTING**

### **Issue 1: Permission Denied (SSH)**

```bash
# Check SSH agent
ssh-add -l

# Add your key
ssh-add ~/.ssh/id_ed25519_kloqo

# Test connection
ssh -T git@github-kloqo
```

### **Issue 2: Vercel Build Fails**

**Error:** "Cannot find module '@kloqo/shared-core'"

**Solution:** Make sure build command includes monorepo setup:
```bash
cd ../.. && pnpm install && pnpm run build --filter=patient-app
```

### **Issue 3: Environment Variables Not Working**

**Solution:** 
1. Go to Vercel Dashboard
2. Select your project
3. Settings → Environment Variables
4. Add all variables
5. Redeploy

### **Issue 4: Git Email Not Set**

```bash
# Set email for this repo
git config user.email "your-email@example.com"

# Or set globally
git config --global user.email "your-email@example.com"
```

---

## 📊 **DEPLOYMENT CHECKLIST**

### **Before Deploying:**

- [ ] All code committed to git
- [ ] `.env.local` files NOT committed (in .gitignore)
- [ ] `.env.example` files committed
- [ ] Firebase credentials ready
- [ ] SSH key added to GitHub
- [ ] Git email configured

### **During Deployment:**

- [ ] Patient app deployed to Vercel
- [ ] Nurse app deployed to Vercel
- [ ] Clinic admin deployed to Vercel
- [ ] Environment variables added to all apps
- [ ] Custom domains configured (optional)

### **After Deployment:**

- [ ] Test patient app: https://kloqo-patient-app.vercel.app
- [ ] Test nurse app: https://kloqo-nurse-app.vercel.app
- [ ] Test clinic admin: https://kloqo-clinic-admin.vercel.app
- [ ] Test Malayalam language
- [ ] Test booking flow
- [ ] Test notifications
- [ ] Set up monitoring (Sentry)

---

## 🌐 **CUSTOM DOMAINS (OPTIONAL)**

### **Add Custom Domains:**

1. **Buy Domains:**
   - `kloqo.in` (patient app)
   - `nurse.kloqo.in` (nurse app)
   - `admin.kloqo.in` (clinic admin)

2. **Add to Vercel:**
   - Go to project settings
   - Domains → Add Domain
   - Follow DNS configuration steps

3. **Configure DNS:**
   ```
   Type: CNAME
   Name: @
   Value: cname.vercel-dns.com
   ```

---

## 🚀 **CONTINUOUS DEPLOYMENT**

### **Auto-Deploy on Push:**

Vercel automatically deploys when you push to GitHub:

```bash
# Make changes
git add .
git commit -m "Update booking logic"
git push origin main

# Vercel automatically:
# 1. Detects push
# 2. Builds all apps
# 3. Deploys to production
# 4. Sends you notification
```

### **Preview Deployments:**

```bash
# Create feature branch
git checkout -b feature/new-feature

# Make changes and push
git push origin feature/new-feature

# Vercel creates preview URL:
# https://kloqo-patient-app-git-feature-new-feature.vercel.app
```

---

## 💰 **VERCEL PRICING**

**Free Tier (Hobby):**
- ✅ Unlimited deployments
- ✅ 100 GB bandwidth/month
- ✅ Automatic HTTPS
- ✅ Preview deployments
- ✅ Perfect for testing!

**Pro Tier (₹1,500/month):**
- ✅ 1 TB bandwidth/month
- ✅ Team collaboration
- ✅ Analytics
- ✅ Password protection
- ✅ Recommended for production

---

## 📝 **NEXT STEPS**

1. **Configure Git Email** (see below)
2. **Push to GitHub**
3. **Deploy to Vercel** (via dashboard - easiest!)
4. **Add Environment Variables**
5. **Test Deployment**
6. **Set Up Monitoring** (Sentry)
7. **Add Custom Domains** (optional)

---

## ✅ **QUICK START COMMANDS**

```bash
# 1. Configure git
cd /Users/jinodevasia/Desktop/Kloqo-Production
git config user.name "Jino Devasia"
git config user.email "YOUR_GITHUB_EMAIL"  # ← Replace!

# 2. Update remote (for Kloqo SSH key)
git remote remove origin
git remote add origin git@github-kloqo:zynthexion/kloqo.git

# 3. Test SSH
ssh -T git@github-kloqo

# 4. Push to GitHub
git push -u origin main

# 5. Deploy to Vercel (via dashboard)
# Go to: https://vercel.com/new
# Import: zynthexion/kloqo
# Configure each app as shown above
```

---

**Prepared by:** Antigravity AI  
**Date:** December 10, 2025  
**Status:** Ready to Deploy! 🚀
