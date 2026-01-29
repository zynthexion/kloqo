
'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Form, FormControl, FormField, FormItem, FormMessage } from '@/components/ui/form';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Loader2, Mail, Lock } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { loginNurse } from '@/lib/auth';
import AppFrameLayout from '@/components/layout/app-frame';
import { Logo } from '@/components/icons';

const formSchema = z.object({
  email: z.string().email({ message: "Please enter a valid email address." }),
  password: z.string().min(1, { message: "Password is required." }),
});

export default function LoginPage() {
  const router = useRouter();
  const { toast } = useToast();
  const { user, loading } = useAuth();
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Session Recovery: If the user lands on the login page but is already authenticated
  // (or if slow auth finally resolves), send them back home.
  useEffect(() => {
    if (!loading && user) {
      console.log(`[Auth-Debug] LoginPage: Active session detected for ${user.email}. Recovering session and redirecting...`);
      router.replace('/');
    }
  }, [user, loading, router]);

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      email: '',
      password: '',
    },
  });

  async function onSubmit(values: z.infer<typeof formSchema>) {
    setIsSubmitting(true);
    try {
      const user = await loginNurse(values.email, values.password);

      // Store user info in localStorage to persist login state
      localStorage.setItem('user', JSON.stringify({
        id: user.uid,
        email: user.email,
        name: user.name,
        clinicId: user.clinicId
      }));
      localStorage.setItem('clinicId', user.clinicId || '');

      toast({
        title: 'Login Successful',
        description: `Welcome, ${user.name || user.email}!`,
      });

      router.push('/');

    } catch (error: any) {
      console.error('Login error:', error);

      let errorMessage = 'An unexpected error occurred. Please try again.';
      let errorTitle = 'Login Failed';

      // Handle Firebase Auth errors
      if (error.code === 'auth/user-not-found') {
        errorMessage = 'No account found with this email address. Please check your email or contact your clinic administrator.';
        errorTitle = 'Account Not Found';
      } else if (error.code === 'auth/wrong-password') {
        errorMessage = 'Incorrect password. Please try again or contact your clinic administrator.';
        errorTitle = 'Invalid Password';
      } else if (error.code === 'auth/invalid-email') {
        errorMessage = 'Please enter a valid email address.';
        errorTitle = 'Invalid Email';
      } else if (error.code === 'auth/user-disabled') {
        errorMessage = 'This account has been disabled. Please contact your clinic administrator.';
        errorTitle = 'Account Disabled';
      } else if (error.code === 'auth/too-many-requests') {
        errorMessage = 'Too many failed login attempts. Please try again later.';
        errorTitle = 'Too Many Attempts';
      } else if (error.code === 'auth/network-request-failed') {
        errorMessage = 'Network error. Please check your internet connection and try again.';
        errorTitle = 'Network Error';
      } else if (error.code === 'auth/invalid-api-key') {
        errorMessage = 'Application configuration error. Please contact support.';
        errorTitle = 'Configuration Error';
      } else if (error.code === 'auth/invalid-credential') {
        errorMessage = 'Invalid email or password. Please check your credentials and try again.';
        errorTitle = 'Invalid Credentials';
      } else if (error.name === 'UserDataNotFound' || error.message === 'User data not found') {
        errorMessage = 'User account not found in the system. Please contact your clinic administrator.';
        errorTitle = 'Account Not Found';
      } else if (error.name === 'AccessDenied' || error.message === 'User does not have clinic admin access') {
        errorMessage = 'This account does not have nurse access permissions. Please contact your clinic administrator.';
        errorTitle = 'Access Denied';
      }

      toast({
        variant: 'destructive',
        title: errorTitle,
        description: errorMessage,
      });

      setIsSubmitting(false);
    }
  }

  return (
    <AppFrameLayout>
      <div className="relative w-full h-full flex flex-col items-center justify-center bg-theme-blue p-4 overflow-hidden">
        <div className="absolute top-[-50px] left-[-50px] w-[150px] h-[150px] bg-white/20 rounded-full" />
        <div className="absolute bottom-[-50px] right-[-80px] w-[200px] h-[200px] border-[20px] border-white/20 rounded-full" />

        <Logo className="text-white mb-6" />

        <Card className="w-full max-w-sm rounded-2xl border bg-card/70 backdrop-blur-sm shadow-lg z-10">
          <CardHeader className="text-center">
            <CardTitle>Nurse Login</CardTitle>
            <p className="text-sm text-muted-foreground mt-2">
              Use your clinic admin email and password
            </p>
          </CardHeader>
          <CardContent className="pt-10">
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" autoComplete="on">
                <FormField
                  control={form.control}
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                      <FormControl>
                        <div className="relative">
                          <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                          <Input
                            type="email"
                            placeholder="Email address"
                            autoComplete="username email"
                            {...field}
                            className="rounded-full pl-10"
                          />
                        </div>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="password"
                  render={({ field }) => (
                    <FormItem>
                      <FormControl>
                        <div className="relative">
                          <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                          <Input
                            type="password"
                            placeholder="Password"
                            autoComplete="current-password"
                            {...field}
                            className="rounded-full pl-10"
                          />
                        </div>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="pt-10">
                  <Button type="submit" className="w-full bg-[#f38d17] hover:bg-[#f38d17]/90 rounded-full shadow-lg" disabled={isSubmitting}>
                    {isSubmitting ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Signing In...
                      </>
                    ) : (
                      'Sign In'
                    )}
                  </Button>
                </div>
              </form>
            </Form>
          </CardContent>
        </Card>
      </div>
    </AppFrameLayout>
  );
}
