
'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useRouter } from 'next/navigation';
import { signInWithPhoneNumber, RecaptchaVerifier, type ConfirmationResult, updatePassword } from 'firebase/auth';
import { useToast } from '@/hooks/use-toast';
import { auth, db } from '@/lib/firebase';
import { collection, query, where, getDocs } from 'firebase/firestore';
import { ArrowLeft, Loader2, KeyRound, Phone, Mail } from 'lucide-react';
import type { User } from '@/lib/types';
import Image from 'next/image';

type Step = 'enterEmail' | 'enterPhone' | 'verifyOtp' | 'resetPassword' | 'success';

declare global {
  interface Window {
    recaptchaVerifier: RecaptchaVerifier;
    confirmationResult?: ConfirmationResult;
  }
}

export default function ForgotPasswordPage() {
  const router = useRouter();
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState<Step>('enterEmail');

  const [email, setEmail] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [otp, setOtp] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const [foundUser, setFoundUser] = useState<User | null>(null);

  useEffect(() => {
    // This effect runs on the client after the component mounts.
    // It sets up the reCAPTCHA verifier and cleans it up on unmount.
    if (typeof window !== 'undefined') {
      window.recaptchaVerifier = new RecaptchaVerifier(auth, 'recaptcha-container', {
        'size': 'invisible',
        'callback': () => { /* reCAPTCHA solved */ }
      });
      window.recaptchaVerifier.render().catch((error) => {
        console.error("reCAPTCHA render error:", error);
        toast({
          variant: "destructive",
          title: "reCAPTCHA Error",
          description: "Could not render reCAPTCHA. Please refresh the page.",
        });
      });
    }

    // Cleanup function to run when the component unmounts
    return () => {
      if (typeof window !== 'undefined' && window.recaptchaVerifier) {
        // Clear the verifier to avoid memory leaks and conflicts
        window.recaptchaVerifier.clear();
      }
    };
  }, [toast]);


  const handleEmailSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoading(true);
    try {
      const usersRef = collection(db, 'users');
      const q = query(usersRef, where("email", "==", email), where("role", "==", "clinicAdmin"));
      const querySnapshot = await getDocs(q);

      if (querySnapshot.empty) {
        toast({
          variant: "destructive",
          title: "User Not Found",
          description: "No admin user found with this email address.",
        });
      } else {
        const userData = querySnapshot.docs[0].data() as User;
        setFoundUser(userData);
        setStep('enterPhone');
      }
    } catch (error) {
      console.error("Error checking email:", error);
      toast({ variant: "destructive", title: "Error", description: "An error occurred. Please try again." });
    } finally {
      setLoading(false);
    }
  };

  const handlePhoneSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!foundUser) return;
    setLoading(true);

    const enteredPhone = `+91${phoneNumber}`;
    if (enteredPhone !== foundUser.phone) {
      toast({ variant: "destructive", title: "Incorrect Phone Number", description: "This phone number does not match the registered user." });
      setLoading(false);
      return;
    }

    try {
      const appVerifier = window.recaptchaVerifier;
      const confirmationResult = await signInWithPhoneNumber(auth, enteredPhone, appVerifier);
      window.confirmationResult = confirmationResult;
      setStep('verifyOtp');
      toast({ title: "OTP Sent", description: "An OTP has been sent to your mobile number." });
    } catch (error) {
      console.error("Error sending OTP:", error);
      toast({ variant: "destructive", title: "Failed to Send OTP", description: "Please try again." });
      // It's possible the verifier needs to be re-rendered on error
      window.recaptchaVerifier.render().catch(console.error);
    } finally {
      setLoading(false);
    }
  };

  const handleOtpSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!window.confirmationResult) return;
    setLoading(true);
    try {
      await window.confirmationResult.confirm(otp);
      toast({ title: "Verification Successful", description: "You can now reset your password." });
      setStep('resetPassword');
    } catch (error) {
      toast({ variant: "destructive", title: "Invalid OTP", description: "Please try again." });
    } finally {
      setLoading(false);
    }
  };

  const handlePasswordReset = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      toast({ variant: "destructive", title: "Passwords Do Not Match" });
      return;
    }
    if (!auth.currentUser) {
      toast({ variant: "destructive", title: "Authentication Error", description: "User session expired. Please start over." });
      router.push('/login');
      return;
    }
    setLoading(true);
    try {
      await updatePassword(auth.currentUser, newPassword);
      setStep('success');
      toast({ title: "Password Reset Successful", description: "You can now log in with your new password." });
    } catch (error) {
      console.error("Error resetting password:", error);
      toast({ variant: "destructive", title: "Error", description: "Could not reset password. Please try again." });
    } finally {
      setLoading(false);
    }
  };

  const titles: Record<Step, string> = {
    enterEmail: 'Forgot Your Password?',
    enterPhone: 'Verify Your Identity',
    verifyOtp: 'Enter OTP',
    resetPassword: 'Set New Password',
    success: 'Success!'
  }

  const descriptions: Record<Step, string> = {
    enterEmail: "No problem. Enter your email and we'll start the recovery process.",
    enterPhone: 'Enter the mobile number associated with your account.',
    verifyOtp: 'A 6-digit code has been sent to your mobile number.',
    resetPassword: 'Create a new, strong password for your account.',
    success: 'Your password has been reset successfully.'
  }

  return (
    <div
      className="w-full h-screen bg-cover bg-center flex items-center justify-center"
      style={{
        backgroundImage:
          "url('https://images.unsplash.com/photo-1576091160399-112ba8d25d1d?w=1920&h=1080&auto=format&fit=crop&q=60&ixlib=rb-4.0.3&ixid=M3wxMjA3fDB8MHxzZWFyY2h8Mnx8bWVkaWNpbmV8ZW58MHx8MHx8fDA%3D')",
      }}
    >
      <div id="recaptcha-container" />
      <div className="absolute inset-0 bg-primary/80" />
      <Card className="mx-auto w-[400px] z-10">
        <CardHeader className="text-center">
          <div className="flex items-center justify-center gap-2 mb-4">
            <Image src="https://firebasestorage.googleapis.com/v0/b/kloqo-clinic-multi-33968-4c50b.firebasestorage.app/o/Kloqo_Logo_full%20(2).webp?alt=media&token=19a163b9-3243-402c-929e-cb99ddcae05c" alt="Kloqo Logo" width={120} height={30} />
          </div>
          <CardTitle className="text-3xl font-bold">{titles[step]}</CardTitle>
          <CardDescription className="text-balance text-muted-foreground">
            {descriptions[step]}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {step === 'enterEmail' && (
            <form className="grid gap-4" onSubmit={handleEmailSubmit}>
              <div className="grid gap-2">
                <Label htmlFor="email">Email</Label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="email"
                    type="email"
                    placeholder="m@example.com"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="pl-10"
                  />
                </div>
              </div>
              <Button type="submit" className="w-full" disabled={loading}>
                {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Continue
              </Button>
            </form>
          )}

          {step === 'enterPhone' && (
            <form className="grid gap-4" onSubmit={handlePhoneSubmit}>
              <div className="grid gap-2">
                <Label htmlFor="phone">Phone Number</Label>
                <div className="relative">
                  <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="phone"
                    type="tel"
                    placeholder="98765 43210"
                    required
                    value={phoneNumber}
                    onChange={(e) => setPhoneNumber(e.target.value.replace(/\D/g, '').slice(0, 10))}
                    className="pl-10"
                  />
                </div>
              </div>
              <Button type="submit" className="w-full" disabled={loading}>
                {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Send OTP
              </Button>
            </form>
          )}

          {step === 'verifyOtp' && (
            <form className="grid gap-4" onSubmit={handleOtpSubmit}>
              <div className="grid gap-2">
                <Label htmlFor="otp">OTP Code</Label>
                <Input
                  id="otp"
                  type="text"
                  placeholder="Enter 6-digit code"
                  required
                  value={otp}
                  onChange={(e) => setOtp(e.target.value)}
                  maxLength={6}
                />
              </div>
              <Button type="submit" className="w-full" disabled={loading}>
                {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Verify & Proceed
              </Button>
            </form>
          )}

          {step === 'resetPassword' && (
            <form className="grid gap-4" onSubmit={handlePasswordReset}>
              <div className="grid gap-2">
                <Label htmlFor="newPassword">New Password</Label>
                <div className="relative">
                  <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="newPassword"
                    type="password"
                    required
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className="pl-10"
                  />
                </div>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="confirmPassword">Confirm New Password</Label>
                <div className="relative">
                  <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="confirmPassword"
                    type="password"
                    required
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className="pl-10"
                  />
                </div>
              </div>
              <Button type="submit" className="w-full" disabled={loading}>
                {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Reset Password
              </Button>
            </form>
          )}

          {(step === 'success' || step !== 'enterEmail') && (
            <Button variant="outline" className="w-full mt-4" asChild>
              <Link href="/login">
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back to Login
              </Link>
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
