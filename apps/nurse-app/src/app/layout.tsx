'use client';

import './globals.css';
import { cn } from '@/lib/utils';
import { Toaster } from "@/components/ui/toaster";
import FirebaseErrorListener from '@/components/firebase-error-listener';
import AddToHomeScreenPrompt from '@/components/add-to-home-screen';
import { AuthProvider } from '@/contexts/AuthContext';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { GlobalErrorHandler } from '@/components/GlobalErrorHandler';
import { useDoctorStatusUpdater } from '@/hooks/useDoctorStatusUpdater';
import { useAppointmentStatusUpdater } from '@/hooks/useAppointmentStatusUpdater';


// Client component wrapper to use hooks
function LayoutContent({ children }: { children: React.ReactNode }) {
  // Hook to automatically update doctor consultation status based on time
  useDoctorStatusUpdater();
  // Hook to automatically update appointment statuses (Pending → Skipped → No-show)
  useAppointmentStatusUpdater();
  
  return (
    <>
      {children}
      <GlobalErrorHandler />
    </>
  );
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning style={{ backgroundColor: '#E6F0F7' }}>
      <head>
        <title>Kloqo Nurse</title>
        <meta name="description" content="Nurse app for managing clinic appointments." />
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=5, user-scalable=yes" />
        {/* Critical CSS: Set background immediately to prevent white flash during page transitions */}
        <style dangerouslySetInnerHTML={{
          __html: `
            html {
              background-color: #E6F0F7 !important;
              min-height: 100%;
            }
            body {
              background-color: #E6F0F7;
              margin: 0;
              padding: 0;
              min-height: 100vh;
            }
            /* Prevent white flash during route transitions */
            #__next, [data-nextjs-scroll-focus-boundary] {
              background-color: #E6F0F7;
              min-height: 100vh;
            }
          `
        }} />
        <link rel="manifest" href="/manifest.json" />
        {/* Preconnect to external domains for faster resource loading */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link rel="dns-prefetch" href="https://firestore.googleapis.com" />
        <link rel="dns-prefetch" href="https://firebase.googleapis.com" />
        {/* Load fonts asynchronously to prevent render blocking */}
        <link
          rel="preload"
          href="https://fonts.googleapis.com/css2?family=PT+Sans:ital,wght@0,400;0,700;1,400;1,700&family=Michroma&display=swap"
          as="style"
        />
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                var link = document.createElement('link');
                link.rel = 'stylesheet';
                link.href = 'https://fonts.googleapis.com/css2?family=PT+Sans:ital,wght@0,400;0,700;1,400;1,700&family=Michroma&display=swap';
                document.head.appendChild(link);
              })();
            `
          }}
        />
        <meta name="theme-color" content="#256cad" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <meta name="apple-mobile-web-app-title" content="Kloqo Nurse" />
        {/* Apple touch icons */}
        <link rel="apple-touch-icon" href="/icons/icon-192x192.png" />
        <link rel="apple-touch-icon" sizes="192x192" href="/icons/icon-192x192.png" />
        <link rel="apple-touch-icon" sizes="512x512" href="/icons/icon-512x512.png" />
      </head>
      <body className={cn("font-body antialiased", "min-h-screen bg-muted/20 font-sans")}>
        <AuthProvider>
          <ErrorBoundary>
            <LayoutContent>{children}</LayoutContent>
          </ErrorBoundary>
          <Toaster />
          <FirebaseErrorListener />
          <AddToHomeScreenPrompt />
        </AuthProvider>
      </body>
    </html>
  );
}
