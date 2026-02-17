'use client';

import { useState, useEffect, useRef, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuth, useFirestore } from '@/firebase';
import { collection, doc, serverTimestamp, setDoc, getDoc, updateDoc, arrayUnion, query, where, getDocs } from 'firebase/firestore';
import { RecaptchaVerifier, signInWithPhoneNumber, signInWithCustomToken, type ConfirmationResult } from 'firebase/auth';
import { Stethoscope, Loader2 } from 'lucide-react';
import { useUser } from '@/firebase/auth/use-user';
import { useLanguage } from '@/contexts/language-context';
import Image from 'next/image';
import { LottieAnimation } from '@/components/lottie-animation';
import loadingDotsAnimation from '@/lib/animations/loading-dots.json';
import { marketingAnalytics } from '@/lib/marketing-analytics';


function LoginContent() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const { toast } = useToast();
    const { t } = useLanguage();
    const auth = useAuth();
    const { user, loading: userLoading, logout } = useUser();

    const [step, setStep] = useState<'phone' | 'otp'>('phone');
    const [phoneNumber, setPhoneNumber] = useState('+91');
    const [otp, setOtp] = useState(new Array(6).fill(''));
    const [isLoading, setIsLoading] = useState(false);
    const [confirmationResult, setConfirmationResult] = useState<ConfirmationResult | null>(null);
    const firestore = useFirestore();

    // Preload animation to avoid loading delay
    useEffect(() => {
        // Preload animation when component mounts
        const link = document.createElement('link');
        link.rel = 'preload';
        link.as = 'fetch';
        link.crossOrigin = 'anonymous';
    }, []);

    const otpInputRefs = useRef<HTMLInputElement[]>([]);

    useEffect(() => {
        if (!auth) return;

        // Clear any existing reCAPTCHA
        if (window.recaptchaVerifier) {
            window.recaptchaVerifier.clear();
            window.recaptchaVerifier = null;
        }

        try {
            window.recaptchaVerifier = new RecaptchaVerifier(auth, 'recaptcha-container', {
                'size': 'invisible',
                'callback': (response: any) => {

                },
                'expired-callback': () => {

                    window.recaptchaVerifier = null;
                },
                'error-callback': (error: any) => {
                    console.error('reCAPTCHA error:', error);
                    window.recaptchaVerifier = null;
                }
            });
        } catch (error) {
            console.error('reCAPTCHA initialization error:', error);
            // Try with visible reCAPTCHA as fallback
            try {
                window.recaptchaVerifier = new RecaptchaVerifier(auth, 'recaptcha-container', {
                    'size': 'normal',
                    'callback': (response: any) => {

                    }
                });
            } catch (fallbackError) {
                console.error('reCAPTCHA fallback error:', fallbackError);
            }
        }
    }, [auth]);

    useEffect(() => {
        if (step === 'otp') {
            otpInputRefs.current[0]?.focus();

            // Auto-detect OTP from SMS using Web OTP API
            if ('OTPCredential' in window) {
                const abortController = new AbortController();

                navigator.credentials
                    .get({
                        otp: { transport: ['sms'] },
                        signal: abortController.signal,
                    } as any)
                    .then((otp: any) => {
                        if (otp && otp.code) {
                            const code = otp.code;
                            if (code.length === 6) {
                                // Fill OTP digits
                                const otpArray = code.split('').slice(0, 6);
                                setOtp(otpArray);

                                // Show toast that OTP was auto-detected
                                toast({ title: 'OTP Auto-detected!', description: 'Click submit to verify.' });

                                // Optionally auto-submit after filling (uncomment to enable)

                            }
                        }
                    })
                    .catch((error: any) => {
                        // Auto-detection failed or not available
                        // This is normal - user can still type manually
                        if (error.name !== 'AbortError' && error.name !== 'NotAllowedError') {

                        }
                    });

                return () => {
                    abortController.abort();
                };
            }
        }
    }, [step, phoneNumber, confirmationResult]);

    // ** MAGIC LOGIN LOGIC **
    useEffect(() => {
        const magicToken = searchParams.get('magicToken') || searchParams.get('token');
        if (magicToken && auth) {
            handleMagicLogin(magicToken);
        }
    }, [auth, searchParams]);

    const handleMagicLogin = async (token: string) => {
        setIsLoading(true);
        try {
            console.log('[MagicLogin] Attempting silent login with token...');
            const response = await fetch('/api/auth/magic-login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ magicToken: token })
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || 'Magic login failed');
            }

            const { customToken, redirectPath, phone } = await response.json();

            // Sign in with Firebase Custom Token
            if (auth) {
                await signInWithCustomToken(auth, customToken);
                console.log('[MagicLogin] Successfully signed in with custom token');

                // Identify user for marketing analytics
                if (phone) {
                    marketingAnalytics.identify(phone);
                }
            }

            // Redirect to target path
            const finalRedirect = searchParams.get('redirect') || redirectPath || '/live-token';
            window.location.href = finalRedirect;
        } catch (error: any) {
            console.error('[MagicLogin] Error:', error);
            toast({
                variant: 'destructive',
                title: 'Login Failed',
                description: 'The magic link was invalid or has expired. Please log in normally.'
            });
            setIsLoading(false);
        }
    };

    useEffect(() => {
        // Only redirect if we're actually on the login page and user is fully authenticated
        if (typeof window === 'undefined' || window.location.pathname !== '/login') {
            return;
        }

        // If user is loaded and exists, redirect them away from login
        // Only redirect if user has patientId (validated user)
        if (!userLoading && user && user.patientId) {
            // Only use explicit redirect query param, always default to /home
            // Ignore localStorage redirectAfterLogin to prevent redirecting to generic pages like /profile
            const redirectUrl = searchParams.get('redirect') || '/live-token';

            // Clean up redirectAfterLogin if it exists (clear stale values)
            if (localStorage.getItem('redirectAfterLogin')) {
                localStorage.removeItem('redirectAfterLogin');
            }



            // Use replace to prevent back button issues and loops
            // Add a small delay to ensure state is stable
            const timeoutId = setTimeout(() => {
                if (window.location.pathname === '/login') {
                    router.replace(redirectUrl);
                }
            }, 200);

            return () => clearTimeout(timeoutId);
        } else if (!userLoading && user && !user.patientId) {

        } else if (!userLoading && !user) {

        }
    }, [user, userLoading, router, searchParams]);


    const handleGenerateOtp = async (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        if (!auth) return;
        setIsLoading(true);

        const fullPhoneNumber = phoneNumber.trim().replace(/\s/g, '');

        if (fullPhoneNumber.length <= 3) {
            toast({ variant: 'destructive', title: t.login.phoneRequired });
            setIsLoading(false);
            return;
        }

        try {
            if (!window.recaptchaVerifier) {
                toast({ variant: 'destructive', title: t.common.error, description: t.login.recaptchaNotInitialized });
                setIsLoading(false);
                return;
            }

            // Immediately transition to OTP input page - instant feedback
            setStep('otp');

            // Send OTP in background - don't block UI
            const confirmationResult = await signInWithPhoneNumber(auth, fullPhoneNumber, window.recaptchaVerifier);
            setConfirmationResult(confirmationResult);
            setIsLoading(false);

            // OTP sent - toast removed per user request
        } catch (error: any) {
            console.error("Error sending OTP:", error);

            let errorMessage = t.login.checkPhoneOrTryLater;

            if (error.code === 'auth/invalid-app-credential') {
                errorMessage = t.login.firebaseConfigError;
            } else if (error.code === 'auth/invalid-phone-number') {
                errorMessage = t.login.invalidPhoneFormat;
            } else if (error.code === 'auth/too-many-requests') {
                errorMessage = t.login.tooManyRequests;
            } else if (error.code === 'auth/captcha-check-failed') {
                errorMessage = t.login.captchaCheckFailed;
            } else if (error.code === 'auth/network-request-failed') {
                errorMessage = t.login.networkError;
            } else if (error.code === 'auth/quota-exceeded') {
                errorMessage = t.login.smsQuotaExceeded;
            }

            toast({
                variant: 'destructive',
                title: t.login.failedToSendOTP,
                description: errorMessage
            });
        }

        setIsLoading(false);
    };

    const handleConfirmOtp = async (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();

        // For OTP confirm, immediately show full-screen splash while we complete login + redirect.
        setIsLoading(true);
        const finalOtp = otp.join('');

        if (finalOtp.length !== 6) {
            toast({ variant: 'destructive', title: t.login.otpMustBe6Digits });
            setIsLoading(false);
            return;
        }

        if (!confirmationResult) {
            toast({ variant: 'destructive', title: t.common.error, description: t.login.pleaseRequestOTP });
            setIsLoading(false);
            return;
        }

        try {
            const result = await confirmationResult.confirm(finalOtp);
            const loggedInUser = result.user;

            if (!firestore || !loggedInUser.phoneNumber) {
                toast({ variant: "destructive", title: "Error", description: "Could not process login." });
                setIsLoading(false);
                return;
            };

            // ** USER LOOKUP BY PHONE NUMBER **
            // Step 1: Check if user exists in users collection with role 'patient' and matching phone
            const usersQuery = query(
                collection(firestore, 'users'),
                where('phone', '==', loggedInUser.phoneNumber),
                where('role', '==', 'patient')
            );

            const usersSnapshot = await getDocs(usersQuery);

            let userData: any = null;
            let patientId: string | null = null;

            if (usersSnapshot.docs.length > 0) {
                // Step 2: User exists - fetch user data and get patientId
                const userDoc = usersSnapshot.docs[0];
                userData = userDoc.data();
                patientId = userData.patientId;
            } else {
                // Step 3: No user exists - create new user and patient documents

                // Declare userRef outside the if/else scope
                let userRef;

                // Check if user document already exists in Firestore (to handle incomplete creation)
                const existingUserRef = doc(firestore, 'users', loggedInUser.uid);
                const existingUserSnap = await getDoc(existingUserRef);

                if (existingUserSnap.exists()) {
                    // User exists but wasn't found in query (might be missing role or phone)
                    await updateDoc(existingUserRef, {
                        phone: loggedInUser.phoneNumber,
                        role: 'patient',
                        updatedAt: serverTimestamp()
                    });
                    userData = existingUserSnap.data();
                    userRef = existingUserRef;
                } else {
                    // Create new user document with Firebase Auth UID as document ID
                    userRef = doc(firestore, 'users', loggedInUser.uid);
                    const newUserData = {
                        uid: loggedInUser.uid,
                        phone: loggedInUser.phoneNumber,
                        role: 'patient',
                        createdAt: serverTimestamp(),
                        updatedAt: serverTimestamp()
                    };
                    await setDoc(userRef, newUserData);
                    userData = newUserData;
                }

                // Create new patient document
                const newPatientRef = doc(collection(firestore, 'patients'));
                const newPatientData = {
                    id: newPatientRef.id,
                    primaryUserId: loggedInUser.uid,
                    name: '',
                    age: 0,
                    sex: '' as const,
                    phone: loggedInUser.phoneNumber,
                    communicationPhone: loggedInUser.phoneNumber,
                    place: '',
                    email: '',
                    clinicIds: [],
                    totalAppointments: 0,
                    visitHistory: [],
                    relatedPatientIds: [],
                    isPrimary: true,
                    isKloqoMember: false,
                    createdAt: serverTimestamp(),
                    updatedAt: serverTimestamp()
                };

                try {
                    await setDoc(newPatientRef, newPatientData);

                } catch (patientError: any) {
                    console.error('Failed to create patient document:', patientError);
                    toast({
                        variant: 'destructive',
                        title: 'Error',
                        description: `Failed to create patient profile: ${patientError.message}`
                    });
                    setIsLoading(false);
                    return;
                }

                // Update user document with patientId
                await updateDoc(userRef, {
                    patientId: newPatientRef.id,
                    updatedAt: serverTimestamp()
                });

                patientId = newPatientRef.id;
                userData.patientId = patientId;
            }

            // Now use patientId from userData

            if (patientId) {
                const clinicIdParam = searchParams.get('clinicId');
                const clinicId = clinicIdParam ? clinicIdParam.trim() : null;

                if (clinicId) {
                    const patientRef = doc(firestore, 'patients', patientId);
                    const patientSnap = await getDoc(patientRef);
                    if (patientSnap.exists() && !patientSnap.data().clinicIds?.includes(clinicId)) {
                        await updateDoc(patientRef, {
                            clinicIds: arrayUnion(clinicId),
                            updatedAt: serverTimestamp()
                        });
                    }
                }
            }

            // Login successful - toast removed per user request
            // Force page reload to ensure user state is updated
            // Only use explicit redirect query param, always default to /home
            // Ignore localStorage redirectAfterLogin to prevent redirecting to generic pages like /profile
            const redirectUrl = searchParams.get('redirect') || '/live-token';

            // Clean up redirectAfterLogin if it exists (clear stale values)
            if (localStorage.getItem('redirectAfterLogin')) {
                localStorage.removeItem('redirectAfterLogin');
            }

            window.location.href = redirectUrl;

        } catch (error: any) {
            console.error("Error confirming OTP:", error);
            let errorMessage = t.login.invalidOTP;

            if (error.code === 'auth/invalid-verification-code') {
                errorMessage = t.login.invalidOTPCheck;
            } else if (error.code === 'auth/code-expired') {
                errorMessage = t.login.otpExpired;
            } else if (error.code === 'auth/too-many-requests') {
                errorMessage = t.login.tooManyAttempts;
            } else if (error.code === 'auth/credential-already-in-use') {
                errorMessage = t.login.phoneAlreadyRegistered;
            } else if (error.message?.includes('Missing or insufficient permissions')) {
                errorMessage = t.login.permissionDenied;
            }

            toast({
                variant: 'destructive',
                title: t.login.otpVerificationFailed,
                description: errorMessage
            });
        }

        setIsLoading(false);
    };

    const handleOtpChange = (element: HTMLInputElement, index: number) => {
        const value = element.value.trim();

        // Handle paste event - if multiple digits pasted
        if (value.length > 1) {
            const digits = value.replace(/\D/g, '').slice(0, 6);
            if (digits.length === 6) {
                // Full OTP pasted - fill all fields
                const otpArray = digits.split('');
                setOtp(otpArray);

                // Focus last input
                setTimeout(() => {
                    otpInputRefs.current[5]?.focus();
                }, 0);
                return;
            } else if (digits.length > 1) {
                // Partial paste - fill from current index
                const newOtp = [...otp];
                digits.split('').forEach((digit, i) => {
                    if (index + i < 6) {
                        newOtp[index + i] = digit;
                    }
                });
                setOtp(newOtp);

                // Focus next empty input or last input
                const nextIndex = Math.min(index + digits.length, 5);
                setTimeout(() => {
                    otpInputRefs.current[nextIndex]?.focus();
                }, 0);
                return;
            }
        }

        // Single digit input
        if (isNaN(Number(value))) return;

        const newOtp = [...otp];
        newOtp[index] = value.slice(-1); // Take only last character
        setOtp(newOtp);

        // Auto-focus next input if value entered
        if (value && index < 5) {
            setTimeout(() => {
                otpInputRefs.current[index + 1]?.focus();
            }, 0);
        }
    };

    const handleOtpPaste = (e: React.ClipboardEvent<HTMLInputElement>, index: number) => {
        e.preventDefault();
        const pastedData = e.clipboardData.getData('text/plain').trim().replace(/\D/g, '');

        if (pastedData.length > 0) {
            const digits = pastedData.slice(0, 6);

            if (digits.length === 6) {
                // Full OTP pasted - fill all fields
                setOtp(digits.split(''));

                // Focus last input and select all
                setTimeout(() => {
                    otpInputRefs.current[5]?.focus();
                    otpInputRefs.current[5]?.select();
                }, 0);
            } else {
                // Partial paste - fill from current index
                const newOtp = [...otp];
                digits.split('').forEach((digit, i) => {
                    if (index + i < 6) {
                        newOtp[index + i] = digit;
                    }
                });
                setOtp(newOtp);

                // Focus next empty input
                const nextIndex = Math.min(index + digits.length, 5);
                setTimeout(() => {
                    otpInputRefs.current[nextIndex]?.focus();
                }, 0);
            }
        }
    };

    const handleOtpKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, index: number) => {
        if (e.key === "Backspace" && !otp[index] && index > 0) {
            otpInputRefs.current[index - 1].focus();
        }
    };

    const handleChangePhoneNumber = () => {
        setStep('phone');
        setOtp(new Array(6).fill(''));
        setConfirmationResult(null);
    };

    const handleResendOTP = async () => {
        if (!auth || !phoneNumber) return;

        const fullPhoneNumber = phoneNumber.trim().replace(/\s/g, '');

        if (fullPhoneNumber.length <= 3) {
            toast({ variant: 'destructive', title: t.login.phoneRequired });
            return;
        }

        try {
            if (!window.recaptchaVerifier) {
                toast({ variant: 'destructive', title: t.common.error, description: t.login.recaptchaNotInitialized });
                return;
            }

            const confirmationResult = await signInWithPhoneNumber(auth, fullPhoneNumber, window.recaptchaVerifier);
            setConfirmationResult(confirmationResult);
            setOtp(new Array(6).fill(''));
            toast({ title: t.login.otpResent, description: `${t.login.otpResentDesc} ${fullPhoneNumber}` });
        } catch (error: any) {
            console.error("Error resending OTP:", error);

            let errorMessage = t.login.failedToResendOTPDesc;

            if (error.code === 'auth/too-many-requests') {
                errorMessage = t.login.tooManyRequests;
            } else if (error.code === 'auth/quota-exceeded') {
                errorMessage = t.login.smsQuotaExceeded;
            }

            toast({
                variant: 'destructive',
                title: t.login.failedToResendOTP,
                description: errorMessage
            });
        }
    };

    const handlePhoneChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        if (!value.startsWith('+91')) {
            setPhoneNumber('+91');
        } else {
            setPhoneNumber(value);
        }
    }

    return (
        <div className="flex min-h-screen w-full items-center justify-center bg-gradient-to-br from-blue-50 via-white to-green-50 font-body p-4 relative">
            <div id="recaptcha-container"></div>

            <div className="w-full max-w-md">
                <div className="relative rounded-2xl border-0 bg-white shadow-2xl p-8 sm:p-10">
                    <div className="flex flex-col items-center justify-center text-center space-y-8 pt-4">
                        <div className="flex flex-col items-center space-y-3">
                            <Image
                                src="https://firebasestorage.googleapis.com/v0/b/kloqo-clinic-multi-33968-4c50b.firebasestorage.app/o/Kloqo_Logo_full%20(1).webp?alt=media&token=97537fce-2f99-416b-8243-47c04f6071a5"
                                alt="Kloqo Logo"
                                width={300}
                                height={150}
                                className="object-contain w-[280px] h-auto"
                                priority
                            />
                            <p className="text-sm text-muted-foreground font-medium">{t.login.tagline}</p>
                        </div>

                        {step === 'phone' && (
                            <form onSubmit={handleGenerateOtp} className="w-full space-y-5 animate-in fade-in-50 duration-500">
                                <div className="space-y-3">
                                    <h2 className="font-semibold text-lg text-foreground">{t.login.enterPhone}</h2>
                                    <Input
                                        id="phone"
                                        type="tel"
                                        placeholder="+91 98765 43210"
                                        required
                                        className="text-center h-14 text-lg rounded-lg border-2 focus-visible:border-primary"
                                        disabled={isLoading}
                                        value={phoneNumber}
                                        onChange={handlePhoneChange}
                                    />
                                </div>
                                <Button
                                    type="submit"
                                    className="w-full bg-primary text-primary-foreground hover:bg-primary/90 h-14 text-base font-semibold rounded-lg shadow-lg"
                                    disabled={isLoading}
                                >
                                    {isLoading ? (
                                        <div className="flex items-center justify-center">
                                            <Loader2 className="h-5 w-5 animate-spin mr-2" />
                                            Sending...
                                        </div>
                                    ) : t.login.generateOTP}
                                </Button>
                            </form>
                        )}

                        {step === 'otp' && (
                            <form onSubmit={handleConfirmOtp} className="w-full space-y-6 animate-in fade-in-50 duration-300">
                                <div className="space-y-4 text-center">
                                    <h2 className="font-semibold text-lg text-foreground">{t.login.enterOTP}</h2>
                                    <p className="text-sm text-muted-foreground">{t.login.otpSent} {phoneNumber}</p>
                                    <div className="flex justify-center gap-2 pt-2">
                                        {otp.map((data, index) => {
                                            return (
                                                <Input
                                                    key={index}
                                                    type="tel"
                                                    inputMode="numeric"
                                                    pattern="[0-9]*"
                                                    value={data}
                                                    maxLength={6}
                                                    className="w-12 h-14 text-center text-2xl font-bold rounded-lg border-2 focus-visible:border-primary"
                                                    onChange={e => handleOtpChange(e.target, index)}
                                                    onKeyDown={e => handleOtpKeyDown(e, index)}
                                                    onPaste={e => handleOtpPaste(e, index)}
                                                    onFocus={e => e.target.select()}
                                                    autoComplete="one-time-code"
                                                    ref={el => { if (el) otpInputRefs.current[index] = el; }}
                                                />
                                            );
                                        })}
                                    </div>
                                    <div className="text-sm text-muted-foreground pt-2 flex flex-col items-center gap-2">
                                        <div>
                                            {t.login.didntReceiveOTP}{' '}
                                            <button
                                                type="button"
                                                onClick={handleResendOTP}
                                                className="font-semibold text-primary hover:underline"
                                            >
                                                {t.login.resend}
                                            </button>
                                        </div>
                                        <button
                                            type="button"
                                            onClick={handleChangePhoneNumber}
                                            className="font-semibold text-primary hover:underline"
                                        >
                                            {t.login.changePhone}
                                        </button>
                                    </div>
                                </div>
                                {isLoading ? (
                                    <div className="w-full flex items-center justify-center h-14">
                                        <LottieAnimation
                                            animationData={loadingDotsAnimation}
                                            size={56}
                                            autoplay={true}
                                            loop={true}
                                        />
                                    </div>
                                ) : (
                                    <Button
                                        type="submit"
                                        className="w-full bg-primary text-primary-foreground hover:bg-primary/90 h-14 text-base font-semibold rounded-lg shadow-lg"
                                        disabled={otp.join('').length !== 6}
                                    >
                                        {t.login.confirmOTP}
                                    </Button>
                                )}
                            </form>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

export default function LoginPage() {
    return (
        <Suspense fallback={
            <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 via-white to-green-50">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
        }>
            <LoginContent />
        </Suspense>
    );
}
