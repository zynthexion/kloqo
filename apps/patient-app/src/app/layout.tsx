import type { Metadata } from 'next';
import Script from 'next/script';
import { Toaster } from "@/components/ui/toaster";
import './globals.css';
import { FirebaseClientProvider } from '@/firebase/client-provider';
import AddToHomeScreenPrompt from '@/components/add-to-home-screen';
import { MessagingInitializer } from '@/components/messaging-initializer';
import { NotificationOnboard } from '@/components/notification-onboard';
import { LanguageProvider } from '@/contexts/language-context';
import { LanguagePrompt } from '@/components/language-prompt';
import { ErrorBoundaryWithLogging } from '@/components/ErrorBoundary';
import { GlobalErrorHandler } from '@/components/GlobalErrorHandler';
import { RoutePrefetcher } from '@/components/route-prefetcher';
import { ReviewChecker, AppointmentReminderHandler } from '@/components/deferred-components';
import { PwaTracker } from '@/components/pwa-tracker';


export const metadata: Metadata = {
  title: 'Kloqo',
  description: 'Book appointments and manage your healthcare',
  manifest: '/manifest.json',
  metadataBase: new URL('https://kloqo.com'),
  openGraph: {
    type: 'website',
    locale: 'en_IN',
    url: 'https://kloqo.com',
    siteName: 'Kloqo',
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" translate="no" className="notranslate" style={{ backgroundColor: 'hsl(220, 20%, 97%)' }}>
      <head>
        {/* Critical CSS: Set background immediately to prevent white flash during page transitions */}
        <style dangerouslySetInnerHTML={{
          __html: `
            html {
              background-color: hsl(220, 20%, 97%) !important;
              min-height: 100%;
            }
            body {
              background-color: hsl(220, 20%, 97%);
              margin: 0;
              padding: 0;
              min-height: 100vh;
            }
            /* Prevent white flash during route transitions */
            #__next, [data-nextjs-scroll-focus-boundary] {
              background-color: hsl(220, 20%, 97%);
              min-height: 100vh;
            }
          `
        }} />
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=5, user-scalable=yes" />
        {/* Preconnect to external domains for faster resource loading */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link rel="dns-prefetch" href="https://nominatim.openstreetmap.org" />
        {/* Load fonts asynchronously to prevent render blocking */}
        <link
          rel="preload"
          href="https://fonts.googleapis.com/css2?family=PT+Sans:ital,wght@0,400;0,700;1,400;1,700&family=Noto+Sans+Malayalam:wght@100;200;300;400;500;600;700;800;900&display=swap"
          as="style"
        />
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                var link = document.createElement('link');
                link.rel = 'stylesheet';
                link.href = 'https://fonts.googleapis.com/css2?family=PT+Sans:ital,wght@0,400;0,700;1,400;1,700&family=Noto+Sans+Malayalam:wght@100;200;300;400;500;600;700;800;900&display=swap';
                document.head.appendChild(link);
              })();
            `,
          }}
        />
        <noscript>
          <link
            href="https://fonts.googleapis.com/css2?family=PT+Sans:ital,wght@0,400;0,700;1,400;1,700&family=Noto+Sans+Malayalam:wght@100;200;300;400;500;600;700;800;900&display=swap"
            rel="stylesheet"
          />
        </noscript>
        <meta name="theme-color" content="hsl(220, 20%, 97%)" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <meta name="apple-mobile-web-app-title" content="Kloqo" />
        <link rel="apple-touch-icon" href="/icons/icon-192x192.png" />

        {/* Microsoft Clarity Tracking */}
        <Script
          id="microsoft-clarity"
          strategy="afterInteractive"
          dangerouslySetInnerHTML={{
            __html: `
              (function(c,l,a,r,i,t,y){
                  c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};
                  t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;
                  y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);
              })(window, document, "clarity", "script", "vc2fbkesof");
            `,
          }}
        />
      </head>
      <body className="font-body antialiased">
        <FirebaseClientProvider>
          <LanguageProvider>
            <LanguagePrompt />
            <ErrorBoundaryWithLogging>
              {children}
              <GlobalErrorHandler />
              <ReviewChecker />
              <AppointmentReminderHandler />
              <RoutePrefetcher />
            </ErrorBoundaryWithLogging>
            <Toaster />

            <AddToHomeScreenPrompt />
            <PwaTracker />
            <MessagingInitializer />
            <NotificationOnboard />
          </LanguageProvider>
        </FirebaseClientProvider>
      </body>
    </html>
  );
}
