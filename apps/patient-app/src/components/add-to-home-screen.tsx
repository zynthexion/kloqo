'use client';

import { useState, useEffect } from 'react';
import Image from 'next/image';
import { usePwa } from '@/lib/pwa';
import { Button } from '@/components/ui/button';
import { X, Download, Share, Home, CheckCircle2 } from 'lucide-react';
import { Card, CardContent } from './ui/card';
import { useLanguage } from '@/contexts/language-context';
import translations from '@/translations';
import { useUser } from '@/firebase/auth/use-user';

export default function AddToHomeScreenPrompt() {
  const { showPrompt, isIOS, isStandalone, isInstallable, promptInstall } = usePwa();
  const [isVisible, setIsVisible] = useState(false);
  const [isAndroid, setIsAndroid] = useState(false);
  const [isInstalling, setIsInstalling] = useState(false);
  const { user } = useUser(); // Check if user is logged in
  
  // Get language context
  const { language } = useLanguage();
  const t = translations[language];

  useEffect(() => {
    const isAndroidDevice = /Android/.test(navigator.userAgent);
    setIsAndroid(isAndroidDevice);
    
    console.log('🔔 PWA Prompt Check:', {
      isStandalone,
      isAndroidDevice,
      isInstallable,
      isIOS,
      showPrompt,
      hasUser: !!user
    });
    
    // Show prompt when installable (works for Android, iOS, and Desktop browsers)
    if (!isStandalone && isInstallable) {
      // Check if dismissed today (not permanently)
      const dismissedDate = localStorage.getItem('pwaPromptDismissedDate');
      const today = new Date().toDateString();
      
      console.log('🔔 PWA Install Prompt Available:', {
        isAndroidDevice,
        isIOS,
        isDesktop: !isAndroidDevice && !isIOS,
        dismissedDate,
        today,
        shouldShow: !dismissedDate || dismissedDate !== today
      });
      
      // Show prompt if never dismissed or not dismissed today
      if (!dismissedDate || dismissedDate !== today) {
        // Show after a short delay
        console.log('🔔 Showing PWA install prompt in 2 seconds...');
        const timer = setTimeout(() => {
          console.log('🔔 Setting PWA prompt visible');
          setIsVisible(true);
        }, 2000);
        return () => clearTimeout(timer);
      } else {
        console.log('🔔 PWA prompt dismissed today, not showing');
      }
    } else if (!isStandalone && isIOS && showPrompt) {
      // iOS fallback (when beforeinstallprompt doesn't fire)
      const promptDismissed = localStorage.getItem('pwaPromptDismissed');
      console.log('🔔 iOS PWA Prompt:', {
        promptDismissed,
        shouldShow: !promptDismissed
      });
      if (!promptDismissed) {
        console.log('🔔 Setting iOS PWA prompt visible');
        setIsVisible(true);
      }
    } else {
      console.log('🔔 PWA prompt conditions not met:', {
        isStandalone,
        isAndroidDevice,
        isInstallable,
        isIOS,
        showPrompt
      });
    }
  }, [showPrompt, isIOS, isStandalone, isInstallable, user]);

  const handleInstall = async () => {
    // For Android, desktop browsers (Chrome, Edge) with native install prompt
    if (isInstallable) {
      // Trigger native install prompt
      setIsInstalling(true);
      const accepted = await promptInstall();
      setIsInstalling(false);
      
      if (accepted) {
        setIsVisible(false);
      }
    } else {
      // For iOS or when native prompt not available, show instructions
      handleDismiss();
    }
  };

  const handleDismiss = () => {
    // Store the dismissal date (not permanent)
    if (isAndroid) {
      const today = new Date().toDateString();
      localStorage.setItem('pwaPromptDismissedDate', today);
    } else {
      // iOS behavior - permanent dismiss
      localStorage.setItem('pwaPromptDismissed', 'true');
    }
    setIsVisible(false);
  };

  if (!isVisible) {
    return null;
  }

  const iosSteps = [
    {
      icon: Share,
      title: t.pwa.installStepShare,
      description: t.pwa.installStepShareDesc,
    },
    {
      icon: Home,
      title: t.pwa.installStepAdd,
      description: t.pwa.installStepAddDesc,
    },
    {
      icon: CheckCircle2,
      title: t.pwa.installStepConfirm,
      description: t.pwa.installStepConfirmDesc,
    },
  ];

  if (isIOS && !isStandalone) {
    return (
      <div className="fixed inset-0 z-[9998] flex items-end justify-center p-4 bg-black/60 backdrop-blur-sm">
        <Card className="w-full max-w-md animate-in slide-in-from-bottom-10 relative shadow-2xl">
          <CardContent className="p-6 relative">
            <Button
              variant="ghost"
              size="icon"
              className="absolute top-2 right-2 h-8 w-8 text-muted-foreground hover:bg-muted"
              onClick={handleDismiss}
            >
              <X className="h-4 w-4" />
              <span className="sr-only">Close</span>
            </Button>

            <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 rounded-full bg-purple-100 flex items-center justify-center overflow-hidden">
                <Image
                  src="https://firebasestorage.googleapis.com/v0/b/kloqo-clinic-multi-33968-4c50b.firebasestorage.app/o/Kloqo_Logo_full%20(1).webp?alt=media&token=97537fce-2f99-416b-8243-47c04f6071a5"
                  alt="Kloqo Logo"
                  width={40}
                  height={40}
                  className="object-contain"
                  priority
                />
              </div>
              <div className="flex-1">
                <h3 className="font-semibold text-lg">{t.pwa.installApp}</h3>
                <p className="text-sm text-muted-foreground">
                  {t.pwa.installQuickAccess}
                </p>
              </div>
            </div>

            <div className="space-y-3">
              <div className="text-xs text-muted-foreground mb-2 font-semibold">
                {t.pwa.installStepsTitle}
              </div>
              <div className="space-y-2">
                {iosSteps.map((step, index) => (
                  <div
                    key={index}
                    className="flex items-start gap-3 rounded-xl border border-muted p-3"
                  >
                    <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-primary font-semibold text-sm">
                      {index + 1}
                    </span>
                    <div className="flex-1">
                        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                          <step.icon className="h-4 w-4 text-primary" />
                          {step.title}
                        </div>
                        <p className="text-xs text-muted-foreground mt-1">{step.description}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex gap-2 mt-6">
              <Button variant="outline" className="flex-1" onClick={handleDismiss}>
                Maybe Later
              </Button>
              <Button className="flex-1" onClick={handleDismiss}>
                Got It
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[9998]">
      <div className="absolute inset-0 bg-gradient-to-br from-[#0f172a]/80 via-[#0b1120]/70 to-[#1e293b]/80 backdrop-blur-xl" />
      <div className="relative flex min-h-screen items-center justify-center px-4 py-10">
        <Card className="w-full max-w-md bg-white/95 shadow-2xl border border-white/40 animate-in fade-in-50 zoom-in-95">
          <CardContent className="p-6 sm:p-8 relative">
            <Button
              variant="ghost"
              size="icon"
              className="absolute top-4 right-4 h-8 w-8 text-muted-foreground hover:bg-muted"
              onClick={handleDismiss}
            >
              <X className="h-4 w-4" />
              <span className="sr-only">Dismiss</span>
            </Button>

            <div className="flex flex-col items-center text-center space-y-5">
              <div className="w-24 h-24 rounded-2xl bg-gradient-to-br from-orange-100 to-orange-200 shadow-inner flex items-center justify-center overflow-hidden">
                <Image
                  src="https://firebasestorage.googleapis.com/v0/b/kloqo-clinic-multi-33968-4c50b.firebasestorage.app/o/Kloqo_Logo_full%20(1).webp?alt=media&token=97537fce-2f99-416b-8243-47c04f6071a5"
                  alt="Kloqo Logo"
                  width={96}
                  height={96}
                  className="object-contain"
                  priority
                />
              </div>

              <div className="space-y-2">
                <h3 className="text-2xl font-bold text-foreground">{t.pwa.installApp}</h3>
                <p className="text-sm text-muted-foreground">
                  {isAndroid ? t.pwa.installDescription : t.pwa.installDescriptionIOS}
                </p>
              </div>

              {isAndroid && isInstallable ? (
                <Button
                  onClick={handleInstall}
                  disabled={isInstalling}
                  className="w-full h-12 text-base font-semibold shadow-lg shadow-primary/30"
                >
                  <Download className="h-5 w-5 mr-2" />
                  {isInstalling ? 'Installing...' : 'Install App'}
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  className="w-full h-12 text-base font-semibold shadow-lg shadow-muted/20"
                  onClick={handleDismiss}
                >
                  Got it
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}



