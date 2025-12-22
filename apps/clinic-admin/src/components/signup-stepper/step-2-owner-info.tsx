
'use client';

import { useState, useEffect, useRef } from 'react';
import { useFormContext } from 'react-hook-form';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { SignUpFormData } from '@/app/(public)/signup/page';
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from '../ui/form';
import { Button } from '../ui/button';
import { Loader2, AlertCircle, Eye, EyeOff, CheckCircle2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { auth, db } from '@/lib/firebase';
import { RecaptchaVerifier, signInWithPhoneNumber, type ConfirmationResult } from 'firebase/auth';
import { collection, query, where, getDocs } from 'firebase/firestore';
import { Alert, AlertDescription, AlertTitle } from '../ui/alert';

declare global {
  interface Window {
    recaptchaVerifier?: RecaptchaVerifier;
    confirmationResult?: ConfirmationResult;
  }
}

export function Step2OwnerInfo({ onVerified }: { onVerified: () => void }) {
  const { control, watch, formState: { errors }, setValue, setError, clearErrors, getValues } = useFormContext<SignUpFormData>();
  const { toast } = useToast();

  const recaptchaContainerRef = useRef<HTMLDivElement>(null);

  const [otpSent, setOtpSent] = useState(false);
  const [otp, setOtp] = useState('');
  const [isVerifying, setIsVerifying] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [captchaFailed, setCaptchaFailed] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [isVerified, setIsVerified] = useState(false);

  const mobileNumber = watch('mobileNumber');
  const isMobileNumberValid = !errors.mobileNumber && mobileNumber?.length === 10;

  useEffect(() => {
    if (recaptchaContainerRef.current && !window.recaptchaVerifier) {
      const verifier = new RecaptchaVerifier(auth, recaptchaContainerRef.current, {
        size: 'invisible',
        callback: () => {
          // reCAPTCHA solved
        },
      });
      window.recaptchaVerifier = verifier;
    }

    return () => {
      if (window.recaptchaVerifier) {
        window.recaptchaVerifier.clear();
        window.recaptchaVerifier = undefined;
      }
    };
  }, []);

  const handleSendOtp = async () => {
    if (!isMobileNumberValid || !window.recaptchaVerifier) return;

    setIsSending(true);
    setCaptchaFailed(false);
    const fullNumber = `+91${mobileNumber}`;

    try {
      const appVerifier = window.recaptchaVerifier;
      // Ensure the verifier is rendered before use
      await appVerifier.render();
      const confirmationResult = await signInWithPhoneNumber(auth, fullNumber, appVerifier);

      window.confirmationResult = confirmationResult;
      setOtpSent(true);
      toast({ title: "OTP Sent", description: "An OTP has been sent to your mobile number." });
    } catch (error: any) {
      console.error("Error sending OTP:", error);

      if (error.code === 'auth/captcha-check-failed') {
        setCaptchaFailed(true);
        toast({
          variant: "destructive",
          title: "Action Required: Authorize Domain",
          description: "Please authorize your app's domain in the Firebase console.",
          duration: 10000,
        });
      } else if (error.code === 'auth/too-many-requests') {
        toast({
          variant: "destructive",
          title: "Too Many Requests",
          description: "We have blocked all requests from this device due to unusual activity. Try again later.",
          duration: 10000,
        });
      }
      else {
        toast({
          variant: "destructive",
          title: "Failed to Send OTP",
          description: "Please check the mobile number or try again. If the problem persists, refresh the page.",
        });
      }
    } finally {
      setIsSending(false);
    }
  };

  const handleVerifyOtp = async () => {
    if (!window.confirmationResult) return;
    setIsVerifying(true);
    try {
      await window.confirmationResult.confirm(otp);
      toast({ title: "Verification Successful", description: "Your mobile number has been verified." });
      setIsVerified(true);
      onVerified();
      setOtpSent(false); // Hide OTP UI
    } catch (error) {
      console.error("Error verifying OTP:", error);
      toast({
        variant: "destructive",
        title: "Invalid OTP",
        description: "The OTP you entered is incorrect. Please try again.",
      });
    } finally {
      setIsVerifying(false);
    }
  };

  const handlePhoneChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value.replace(/\D/g, ''); // Remove non-digit characters
    setValue('mobileNumber', value.slice(0, 10)); // Limit to 10 digits
  };

  const handleEmailBlur = async () => {
    const email = getValues('emailAddress');
    if (!email || errors.emailAddress) return;

    try {
      const q = query(
        collection(db, 'users'),
        where('email', '==', email),
        where('role', '==', 'clinicAdmin')
      );
      const querySnapshot = await getDocs(q);

      if (!querySnapshot.empty) {
        setError('emailAddress', {
          type: 'manual',
          message: 'This email is already registered as a Clinic Admin. Please use a different email.',
        });
      } else {
        clearErrors('emailAddress'); // Clear error if email is unique
      }
    } catch (error) {
      console.error("Error checking email uniqueness:", error);
      // Optionally handle error, e.g., show a toast or ignore
    }
  };


  return (
    <div>
      <p className="text-sm text-muted-foreground">Step 2/7</p>
      <h2 className="text-2xl font-bold mb-1">Primary Contact Information</h2>
      <p className="text-muted-foreground mb-6">Details of the main contact person or owner.</p>

      <div id="recaptcha-container" ref={recaptchaContainerRef}></div>

      {captchaFailed && (
        <Alert variant="destructive" className="mb-4">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Authorization Required</AlertTitle>
          <AlertDescription>
            To proceed, you must authorize your domain in the Firebase Console. Go to <strong>Authentication &gt; Settings &gt; Authorized domains</strong> and add your app's URL. Then, please try sending the OTP again.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <FormField
          control={control}
          name="ownerName"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Owner / Admin Name <span className="text-destructive">*</span></FormLabel>
              <FormControl>
                <Input placeholder="Asha Varma" {...field} autoCapitalizeTitle />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={control}
          name="designation"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Designation <span className="text-destructive">*</span></FormLabel>
              <Select onValueChange={field.onChange} defaultValue={field.value}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder="Select designation" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value="Doctor">Doctor</SelectItem>
                  <SelectItem value="Owner">Owner</SelectItem>
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />
        <div className="md:col-span-2">
          <FormField
            control={control}
            name="mobileNumber"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Mobile Number <span className="text-destructive">*</span></FormLabel>
                <div className="flex gap-2">
                  <div className="relative flex-grow">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">+91</span>
                    <FormControl>
                      <Input
                        placeholder="98765 43210"
                        {...field}
                        onChange={handlePhoneChange}
                        className="pl-10"
                      />
                    </FormControl>
                  </div>
                  {!otpSent && !isVerified && (
                    <Button type="button" onClick={handleSendOtp} disabled={!isMobileNumberValid || isSending}>
                      {isSending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                      Send OTP
                    </Button>
                  )}
                  {isVerified && (
                    <div className="flex items-center text-green-600 font-medium">
                      <CheckCircle2 className="mr-2 h-5 w-5" />
                      Verified
                    </div>
                  )}
                </div>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        {otpSent && (
          <div className="md:col-span-2 space-y-4 animate-in fade-in">
            <FormItem>
              <FormLabel>Enter OTP</FormLabel>
              <div className="flex gap-2">
                <FormControl>
                  <Input
                    type="text"
                    placeholder="Enter 6-digit OTP"
                    value={otp}
                    onChange={(e) => setOtp(e.target.value)}
                    maxLength={6}
                  />
                </FormControl>
                <Button type="button" onClick={handleVerifyOtp} disabled={otp.length !== 6 || isVerifying}>
                  {isVerifying ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Verify OTP
                </Button>
              </div>
            </FormItem>
          </div>
        )}

        <FormField
          control={control}
          name="emailAddress"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Email Address <span className="text-destructive">*</span></FormLabel>
              <FormControl>
                <Input type="email" placeholder="clinic@carewell.in" {...field} onBlur={(e) => {
                  field.onBlur(); // Call original onBlur from react-hook-form
                  handleEmailBlur();
                }} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={control}
          name="password"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Password (for login)</FormLabel>
              <div className="relative">
                <FormControl>
                  <Input type={showPassword ? 'text' : 'password'} {...field} />
                </FormControl>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2 text-muted-foreground"
                  onClick={() => setShowPassword(!showPassword)}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
              </div>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>
    </div>
  );
}
