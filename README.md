# Kloqo Monorepo

A professional monorepo for the Kloqo healthcare appointment management system, built with Next.js, Firebase, and Turborepo.

## 📁 Project Structure

```
kloqo-monorepo/
├── apps/
│   ├── patient-app/        # Patient-facing app (app.kloqo.com)
│   ├── nurse-app/          # Nurse interface (nurse.kloqo.com)
│   ├── clinic-admin/       # Clinic admin dashboard (clinic.kloqo.com)
│   └── superadmin/         # Superadmin panel
│
├── packages/
│   ├── shared-core/        # Business logic & services
│   ├── shared-types/       # TypeScript types
│   ├── shared-ui/          # Shared React components
│   ├── shared-firebase/    # Firebase configuration
│   └── shared-config/      # Shared tooling configs
│
└── docs/                   # Documentation
```

## 🚀 Quick Start

### Prerequisites

- Node.js >= 18.0.0
- pnpm >= 8.0.0

### Installation

```bash
# Install pnpm if you haven't already
npm install -g pnpm

# Install dependencies
pnpm install

# Start development for all apps
pnpm dev

# Or start a specific app
pnpm dev:patient    # Patient app
pnpm dev:nurse      # Nurse app
pnpm dev:clinic     # Clinic admin
pnpm dev:superadmin # Superadmin
```

## 🛠️ Development

### Build Commands

```bash
# Build all apps
pnpm build

# Build specific app
pnpm --filter patient-app build
pnpm --filter nurse-app build
pnpm --filter clinic-admin build
pnpm --filter superadmin build
```

### Type Checking

```bash
# Type check all packages
pnpm typecheck
```

### Linting

```bash
# Lint all packages
pnpm lint
```

## 📦 Shared Packages

### @kloqo/shared-core

Business logic and services used across all apps:
- Walk-in scheduling
- Appointment management
- Capacity calculation
- Break time utilities

### @kloqo/shared-types

TypeScript types and interfaces shared across apps.

### @kloqo/shared-ui

Reusable React components like PatientForm.

### @kloqo/shared-firebase

Firebase configuration and utilities.

## 🚢 Deployment

### Vercel Configuration

Each app is deployed separately on Vercel with the following Root Directory settings:

| App | Domain | Root Directory |
|-----|--------|----------------|
| Patient App | app.kloqo.com | `apps/patient-app` |
| Nurse App | nurse.kloqo.com | `apps/nurse-app` |
| Clinic Admin | clinic.kloqo.com | `apps/clinic-admin` |
| Superadmin | (not deployed) | `apps/superadmin` |

### Deploy to Vercel

1. Connect your Git repository to Vercel
2. Create 3 separate Vercel projects
3. For each project, set the **Root Directory** as shown above
4. Deploy!

## 🏗️ Tech Stack

- **Framework**: Next.js 15
- **Language**: TypeScript
- **Backend**: Firebase (Firestore, Auth, Storage)
- **Styling**: Tailwind CSS
- **UI Components**: Radix UI
- **Build System**: Turborepo
- **Package Manager**: pnpm

## 📝 License

Private - All rights reserved
