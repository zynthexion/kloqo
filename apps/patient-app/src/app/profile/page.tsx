'use client';
import { ArrowLeft, Home, Calendar, Radio, User, Users, ChevronRight, LogOut, FileText, Shield, HelpCircle, Download, Share, CheckCircle2, MapPin } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { PlaceHolderImages } from '@/lib/placeholder-images';
import { Button } from '@/components/ui/button';
import { useUser } from '@/firebase/auth/use-user';
import { useLanguage } from '@/contexts/language-context';
import { BottomNav } from '@/components/bottom-nav';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { useEffect, useMemo, useState } from 'react';
import { usePwa } from '@/lib/pwa';
import dynamic from 'next/dynamic';
import { Skeleton } from '@/components/ui/skeleton';
import { AuthGuard } from '@/components/auth-guard';

const NotificationSettings = dynamic(
    () =>
        import('@/components/notification-settings').then((mod) => ({
            default: mod.NotificationSettings,
        })),
    {
        ssr: false,
        loading: () => (
            <div className="p-4 border-b">
                <Skeleton className="h-10 w-full" />
            </div>
        ),
    }
);

const LanguageSettings = dynamic(
    () =>
        import('@/components/language-settings').then((mod) => ({
            default: mod.LanguageSettings,
        })),
    {
        ssr: false,
        loading: () => (
            <div className="p-4 border-b">
                <Skeleton className="h-10 w-full" />
            </div>
        ),
    }
);

function ProfilePage() {
    const { t } = useLanguage();
    const pathname = usePathname();
    const { user, logout, loading: userLoading } = useUser();

    // Debug logging and direct redirect check
    useEffect(() => {
        console.log('[ProfilePage] 🔍 Debug:', {
            loading: userLoading,
            hasUser: !!user,
            userId: user?.dbUserId || 'null',
            pathname,
            timestamp: new Date().toISOString()
        });

        // Additional safety check: if not loading and no user, redirect directly
        if (!userLoading && !user && typeof window !== 'undefined') {
            console.log('[ProfilePage] 🚫 No user found, redirecting directly to login...');
            const currentPath = window.location.pathname + window.location.search;
            localStorage.setItem('redirectAfterLogin', currentPath);

            // Use window.location for more reliable redirect
            if (window.location.pathname !== '/login') {
                console.log('[ProfilePage] 🔀 Using window.location.href to redirect');
                window.location.href = '/login';
            }
        }
    }, [user, userLoading, pathname]);
    const [showTerms, setShowTerms] = useState(false);
    const [showPrivacy, setShowPrivacy] = useState(false);
    const [showComingSoon, setShowComingSoon] = useState(false);
    const [showInstallPrompt, setShowInstallPrompt] = useState(false);
    const [isAndroidDevice, setIsAndroidDevice] = useState(false);
    const { isIOS, isStandalone, isInstallable, promptInstall } = usePwa();

    useEffect(() => {
        if (typeof window === 'undefined') return;
        setIsAndroidDevice(/Android/i.test(navigator.userAgent));
    }, []);

    const getUserInitials = () => {
        if (!user?.displayName) return 'AD';
        const names = user.displayName.trim().split(' ');
        if (names.length >= 2) {
            return (names[0][0] + names[names.length - 1][0]).toUpperCase();
        }
        return user.displayName.substring(0, 2).toUpperCase();
    };

    const menuItems = [
        { icon: Users, label: t.profile?.friendsAndFamily || 'Your Friends and Family', href: '/profile/relatives' },
        { icon: MapPin, label: t.profile?.allowLocation || 'Allow Location', href: '#', key: 'location' },
        { icon: FileText, label: t.profile.terms, href: '#', key: 'terms' },
        { icon: Shield, label: t.profile.privacyPolicy, href: '#', key: 'privacy' },
        { icon: Download, label: t.profile.installAppMenu, href: '#', key: 'install' },
        { icon: HelpCircle, label: t.profile.help, href: '/contact' },
    ];

    const handleAllowLocation = () => {
        if (!navigator.geolocation) {
            alert(t.consultToday.geolocationNotSupported || 'Geolocation not supported');
            return;
        }

        navigator.geolocation.getCurrentPosition(
            () => {
                // Success - permission granted
            },
            (error) => {
                console.error('Error requesting location:', error);
                if (error.code === error.PERMISSION_DENIED) {
                    alert(t.consultToday.locationDenied || 'Location access denied');
                }
            },
            { enableHighAccuracy: true, timeout: 5000, maximumAge: 0 }
        );
    };

    const iosSteps = useMemo(() => [
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
    ], [t]);

    const handleInstallMenuClick = () => {
        if (typeof window !== 'undefined' && (window.matchMedia('(display-mode: standalone)').matches || (window.navigator as any).standalone)) {
            window.location.href = window.location.origin;
            return;
        }
        setShowInstallPrompt(true);
    };

    const handleInstallAction = async () => {
        if (isStandalone) {
            window.location.href = window.location.origin;
            return;
        }

        if (isAndroidDevice && isInstallable) {
            await promptInstall();
            setShowInstallPrompt(false);
            return;
        }

        // For other cases, close dialog; instructions remain visible for manual steps
        setShowInstallPrompt(false);
    };

    // Safety check: Don't render if no user (AuthGuard should handle this, but just in case)
    if (!userLoading && !user) {
        console.log('[ProfilePage] 🚫 Blocking render - no user after loading');
        return null;
    }

    // Show loading while checking auth
    if (userLoading) {
        return (
            <div className="flex h-screen w-full items-center justify-center bg-background">
                <div className="text-center">
                    <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
                    <p className="text-muted-foreground">Loading...</p>
                </div>
            </div>
        );
    }

    return (
        <div className="flex min-h-screen w-full flex-col bg-green-50/50 font-body">
            <header className="flex items-center p-4">
                <Link href="/home" className="p-2">
                    <ArrowLeft className="h-6 w-6" />
                </Link>
                <h1 className="text-xl font-bold text-center flex-grow">{t.profile.myProfile}</h1>
                <div className="w-8"></div>
            </header>

            <main className="flex-grow p-4 space-y-6 pb-24">
                <div className="flex items-center gap-4">
                    <Avatar className="h-20 w-20">
                        <AvatarFallback className="text-2xl font-bold bg-primary text-primary-foreground">
                            {getUserInitials()}
                        </AvatarFallback>
                    </Avatar>
                    <div>
                        <h2 className="text-2xl font-bold">{user?.name || user?.displayName || 'User'}</h2>
                        <p className="text-muted-foreground">{user?.phoneNumber}</p>
                        {user?.place && (
                            <p className="text-sm text-muted-foreground">{user.place}</p>
                        )}
                    </div>
                </div>

                <div className="bg-card rounded-xl shadow-sm overflow-hidden">
                    <NotificationSettings />
                    <LanguageSettings />
                    {menuItems.map((item, index) => {
                        if (item.key === 'location') {
                            return (
                                <button
                                    key={index}
                                    type="button"
                                    onClick={handleAllowLocation}
                                    className="w-full text-left"
                                >
                                    <div className="flex items-center justify-between p-4 border-b last:border-b-0 hover:bg-muted/50 transition-colors">
                                        <div className="flex items-center gap-4">
                                            <item.icon className="h-6 w-6 text-primary" />
                                            <span className="font-semibold">{item.label}</span>
                                        </div>
                                        <ChevronRight className="h-5 w-5 text-muted-foreground" />
                                    </div>
                                </button>
                            );
                        } else if (item.key === 'terms') {
                            return (
                                <button
                                    key={index}
                                    type="button"
                                    onClick={() => setShowTerms(true)}
                                    className="w-full text-left"
                                >
                                    <div className="flex items-center justify-between p-4 border-b last:border-b-0 hover:bg-muted/50 transition-colors">
                                        <div className="flex items-center gap-4">
                                            <item.icon className="h-6 w-6 text-primary" />
                                            <span className="font-semibold">{item.label}</span>
                                        </div>
                                        <ChevronRight className="h-5 w-5 text-muted-foreground" />
                                    </div>
                                </button>
                            );
                        } else if (item.key === 'privacy') {
                            return (
                                <button
                                    key={index}
                                    type="button"
                                    onClick={() => setShowPrivacy(true)}
                                    className="w-full text-left"
                                >
                                    <div className="flex items-center justify-between p-4 border-b last:border-b-0 hover:bg-muted/50 transition-colors">
                                        <div className="flex items-center gap-4">
                                            <item.icon className="h-6 w-6 text-primary" />
                                            <span className="font-semibold">{item.label}</span>
                                        </div>
                                        <ChevronRight className="h-5 w-5 text-muted-foreground" />
                                    </div>
                                </button>
                            );
                        } else if (item.key === 'install') {
                            return (
                                <button
                                    key={index}
                                    type="button"
                                    onClick={handleInstallMenuClick}
                                    className="w-full text-left"
                                >
                                    <div className="flex items-center justify-between p-4 border-b last:border-b-0 hover:bg-muted/50 transition-colors">
                                        <div className="flex items-center gap-4">
                                            <item.icon className="h-6 w-6 text-primary" />
                                            <span className="font-semibold">{item.label}</span>
                                        </div>
                                        <ChevronRight className="h-5 w-5 text-muted-foreground" />
                                    </div>
                                </button>
                            );
                        }

                        return (
                            <Link href={item.href} key={index}>
                                <div className="flex items-center justify-between p-4 border-b last:border-b-0 hover:bg-muted/50 transition-colors">
                                    <div className="flex items-center gap-4">
                                        <item.icon className="h-6 w-6 text-primary" />
                                        <span className="font-semibold">{item.label}</span>
                                    </div>
                                    <ChevronRight className="h-5 w-5 text-muted-foreground" />
                                </div>
                            </Link>
                        );
                    })}
                </div>

                <Button onClick={logout} variant="outline" className="w-full justify-start items-center gap-4 p-4 h-auto text-left bg-card">
                    <LogOut className="h-6 w-6 text-red-500" />
                    <span className="font-semibold text-red-500">{t.profile.logout}</span>
                </Button>
            </main>

            <BottomNav />

            <Dialog open={showTerms} onOpenChange={setShowTerms}>
                <DialogContent className="max-h-[80vh] overflow-y-auto">
                    <DialogHeader>
                        <DialogTitle>{t.profile.terms}</DialogTitle>
                        <DialogDescription>
                            Please review the terms and conditions below (English & Malayalam).
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-6 text-sm leading-relaxed">
                        <section>
                            <h3 className="font-semibold text-base mb-2">English</h3>
                            <p className="text-muted-foreground">
                                By using this app, you agree to follow the clinic&apos;s queue rules, arrive on time,
                                and respect all staff and patients. Sharing or misusing tokens is strictly prohibited.
                                Kloqo may update these terms anytime; continued use means you accept the changes.
                            </p>
                        </section>
                        <section>
                            <h3 className="font-semibold text-base mb-2">Malayalam (മലയാളം)</h3>
                            <p className="text-muted-foreground">
                                ഈ ആപ്പ് ഉപയോഗിക്കുമ്പോൾ, ക്ലിനിക്കിന്റെ ക്യൂ നിയമങ്ങൾ പാലിക്കുകയും സമയത്ത് റിപ്പോർട്ട് ചെയ്യുകയും
                                സ്റ്റാഫിനെയും രോഗികളെയും ബഹുമാനിക്കുകയും ചെയ്യുമെന്ന് നിങ്ങൾ സമ്മതിക്കുന്നു. ടോക്കൺ പങ്കിടുകയോ
                                ദുരുപയോഗം ചെയ്യുകയോ കർശനമായി വിലക്കപ്പെട്ടതാണ്. ഈ നിബന്ധനകൾ Kloqo ഏതെങ്കിലും സമയത്ത് പുതുക്കാമെന്ന്
                                ശ്രദ്ധിക്കുക; ആപ്പ് തുടർന്നും ഉപയോഗിക്കുന്നതിലൂടെ പുതിയ നിബന്ധനകളും നിങ്ങൾ അംഗീകരിക്കുന്നു.
                            </p>
                        </section>
                    </div>
                </DialogContent>
            </Dialog>

            <Dialog open={showPrivacy} onOpenChange={setShowPrivacy}>
                <DialogContent className="max-h-[80vh] overflow-y-auto">
                    <DialogHeader>
                        <DialogTitle>{t.profile.privacyPolicy}</DialogTitle>
                        <DialogDescription>
                            We value your privacy. Please review the policy below (English & Malayalam).
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-6 text-sm leading-relaxed">
                        <section>
                            <h3 className="font-semibold text-base mb-2">English</h3>
                            <p className="text-muted-foreground">
                                Your personal data such as name, phone number, and visit history are used only to manage
                                appointments and send clinic updates. We never share your details with third parties
                                without consent, and all data is stored securely following applicable regulations.
                            </p>
                        </section>
                        <section>
                            <h3 className="font-semibold text-base mb-2">Malayalam (മലയാളം)</h3>
                            <p className="text-muted-foreground">
                                നിങ്ങളുടെ പേര്, ഫോൺ നമ്പർ, സന്ദർശന ചരിത്രം തുടങ്ങിയ വ്യക്തിഗത വിവരങ്ങൾ കമ്പനിക്ക് അപ്പോയിന്റ്മെന്റുകൾ
                                ക്രമീകരിക്കാനും ക്ലിനിക്കുമായി ബന്ധപ്പെട്ട വിവരങ്ങൾ നൽകാനും മാത്രം ഉപയോഗിക്കുന്നു. നിങ്ങളുടെ അനുമതി
                                കൂടാതെ മൂന്നാം കക്ഷികളുമായി വിവരങ്ങൾ പങ്കിടുകയില്ല; എല്ലാ വിവരങ്ങളും ബന്ധപ്പെട്ട നിയമങ്ങൾ പാലിച്ച് സുരക്ഷിതമായി സൂക്ഷിക്കുന്നു.
                            </p>
                        </section>
                    </div>
                </DialogContent>
            </Dialog>

            <Dialog open={showComingSoon} onOpenChange={setShowComingSoon}>
                <DialogContent className="max-w-md text-center space-y-4">
                    <DialogHeader>
                        <DialogTitle>{t.profile.rateTheApp}</DialogTitle>
                        <DialogDescription>
                            This feature is coming soon!
                        </DialogDescription>
                    </DialogHeader>
                    <p className="text-sm text-muted-foreground">
                        {/** English */}
                        We are working on the app rating feature. Stay tuned for an update.
                    </p>
                    <p className="text-sm text-muted-foreground">
                        {/** Malayalam */}
                        ആപ്പിനെ വിലയിരുത്താനുള്ള സൗകര്യം ഉടൻ ലഭ്യമാകും. ദയവായി കാത്തിരിക്കുക.
                    </p>
                    <Button onClick={() => setShowComingSoon(false)} className="w-full">
                        OK
                    </Button>
                </DialogContent>
            </Dialog>

            <Dialog open={showInstallPrompt} onOpenChange={setShowInstallPrompt}>
                <DialogContent className="max-w-md space-y-4">
                    <DialogHeader>
                        <DialogTitle>{t.pwa.installApp}</DialogTitle>
                        <DialogDescription>
                            {t.pwa.installQuickAccess}
                        </DialogDescription>
                    </DialogHeader>

                    {isIOS && (
                        <div className="space-y-3">
                            <p className="text-xs text-muted-foreground font-semibold uppercase tracking-wide">
                                {t.pwa.installStepsTitle}
                            </p>
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
                    )}

                    {isAndroidDevice && (
                        <div className="space-y-2 text-sm text-muted-foreground">
                            {!isInstallable && (
                                <p>{t.pwa.installManually}</p>
                            )}
                            <ol className="list-decimal list-inside space-y-1">
                                <li>{t.pwa.installDescription}</li>
                                <li>{t.pwa.installStepAdd}</li>
                                <li>{t.pwa.installStepConfirm}</li>
                            </ol>
                        </div>
                    )}

                    <div className="flex gap-2">
                        <Button variant="outline" className="flex-1" onClick={() => setShowInstallPrompt(false)}>
                            {t.profile.maybeLater}
                        </Button>
                        {isIOS && (
                            <Button className="flex-1" onClick={() => setShowInstallPrompt(false)}>
                                {t.profile.gotIt}
                            </Button>
                        )}
                        {isAndroidDevice && !isStandalone && (
                            <Button
                                className="flex-1"
                                onClick={handleInstallAction}
                                disabled={isAndroidDevice && !isInstallable}
                            >
                                {t.profile.installNow}
                            </Button>
                        )}
                        {isAndroidDevice && isStandalone && (
                            <Button className="flex-1" onClick={handleInstallAction}>
                                {t.profile.openInstalledApp}
                            </Button>
                        )}
                    </div>
                </DialogContent>
            </Dialog>
        </div>
    );
}

function ProfilePageWithAuth() {
    return (
        <AuthGuard>
            <ProfilePage />
        </AuthGuard>
    );
}

export default ProfilePageWithAuth;
