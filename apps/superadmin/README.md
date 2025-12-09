# Kloqo SuperAdmin - Error Monitoring Dashboard

A dedicated SuperAdmin application for monitoring and tracking errors from all Kloqo applications (Patient App, Nurse App, Clinic Admin).

## Features

- 🔍 **Real-time Error Monitoring** - Live error updates from all apps
- 📊 **Error Statistics** - Overview of errors by severity and app
- 🔎 **Advanced Filtering** - Filter by severity, app, date range, search
- 📱 **Multi-App Support** - Monitor errors from Patient, Nurse, and Clinic Admin apps
- 🎯 **Error Details** - Full stack traces, user context, device info
- 🔐 **Secure Authentication** - Role-based access control

## Setup

### 1. Install Dependencies

```bash
cd kloqo-superadmin
npm install
```

### 2. Environment Variables

Create a `.env.local` file:

```env
NEXT_PUBLIC_FIREBASE_API_KEY=your_api_key
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=your_auth_domain
NEXT_PUBLIC_FIREBASE_PROJECT_ID=your_project_id
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=your_storage_bucket
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=your_sender_id
NEXT_PUBLIC_FIREBASE_APP_ID=your_app_id
```

### 3. Create First SuperAdmin User

Before you can log in, you need to create the first SuperAdmin user. You have two options:

#### Option A: Using Setup Script (Recommended)

1. Install Firebase Admin SDK:
   ```bash
   npm install firebase-admin
   ```

2. Set up Firebase Admin credentials (choose one):
   - **Option 1** (Recommended): Download service account key from Firebase Console → Project Settings → Service Accounts. Save it as `serviceAccountKey.json` in the project root or set `GOOGLE_APPLICATION_CREDENTIALS` environment variable to its path.
   - **Option 2**: Set environment variables:
     ```bash
     export FIREBASE_PROJECT_ID=your-project-id
     export FIREBASE_CLIENT_EMAIL=your-service-account-email
     export FIREBASE_PRIVATE_KEY="your-private-key"
     ```
   
   ⚠️ **Security Note**: Never commit service account keys to version control! They are already in `.gitignore`.

3. Run the setup script:
   ```bash
   node scripts/create-superadmin.js admin@kloqo.com YourSecurePassword123!
   ```

#### Option B: Manual Setup via Firebase Console

1. Go to Firebase Console → Authentication → Add User
2. Create a user with email and password
3. Copy the User UID
4. Go to Firestore → `users` collection → Create document with the UID
5. Set the following fields:
   - `role`: `"superAdmin"`
   - `email`: Your email address
   - `uid`: The User UID
   - `createdAt`: Server timestamp
   - `updatedAt`: Server timestamp

### 4. Run Development Server

```bash
npm run dev
```

The app will run on http://localhost:3004

## Usage

1. **Login** - Use your SuperAdmin credentials to login
2. **View Dashboard** - See error statistics and live error feed
3. **Filter Errors** - Use filters to find specific errors
4. **View Details** - Click on any error to see full details including stack traces

## Authentication

Only users with `role: 'superAdmin'` in Firestore can access the SuperAdmin dashboard. This is a **platform-wide** role, not tied to any specific clinic.

## Error Logging

Errors are automatically logged from all Kloqo apps to the `error_logs` collection in Firestore. This dashboard reads from that collection in real-time.

## Production Build

```bash
npm run build
npm start
```

## Port

The app runs on port **3004** by default to avoid conflicts with other Kloqo apps.

