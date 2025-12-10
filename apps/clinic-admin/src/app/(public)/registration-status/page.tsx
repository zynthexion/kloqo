'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/firebase';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { CheckCircle, Clock, XCircle, AlertCircle } from 'lucide-react';

export default function RegistrationStatusPage() {
  const { currentUser, loading } = useAuth();
  const router = useRouter();
  const [status, setStatus] = useState<'Pending' | 'Approved' | 'Rejected' | 'loading' | null>(null);
  const [clinicName, setClinicName] = useState<string>('');

  useEffect(() => {
    if (!loading && !currentUser) {
      router.push('/login');
      return;
    }

    if (currentUser) {
      const checkStatus = async () => {
        try {
          const userDoc = await getDoc(doc(db, 'users', currentUser.uid));
          if (userDoc.exists()) {
            const userData = userDoc.data();
            const clinicId = userData.clinicId;
            
            if (clinicId) {
              const clinicDoc = await getDoc(doc(db, 'clinics', clinicId));
              if (clinicDoc.exists()) {
                const clinicData = clinicDoc.data();
                setClinicName(clinicData.name || 'Your clinic');
                const registrationStatus = clinicData.registrationStatus || 'Pending';
                setStatus(registrationStatus as any);
                
                // If approved, redirect to dashboard after 2 seconds
                if (registrationStatus === 'Approved') {
                  setTimeout(() => {
                    router.push('/dashboard');
                  }, 2000);
                }
              }
            }
          }
        } catch (error) {
          console.error('Error checking registration status:', error);
          setStatus(null);
        }
      };

      checkStatus();
    }
  }, [currentUser, loading, router]);

  if (loading || status === 'loading') {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto mb-4" />
          <p className="text-muted-foreground">Checking registration status...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center min-h-screen bg-gray-50 p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">Registration Status</CardTitle>
          <CardDescription>{clinicName}</CardDescription>
        </CardHeader>
        <CardContent className="text-center space-y-4">
          {status === 'Pending' && (
            <>
              <div className="flex justify-center">
                <Clock className="h-16 w-16 text-yellow-500" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-yellow-600 mb-2">Pending Approval</h3>
                <p className="text-sm text-muted-foreground">
                  Your clinic registration is currently under review by our SuperAdmin team.
                  You will be able to login and complete onboarding once your registration is approved.
                </p>
              </div>
            </>
          )}

          {status === 'Approved' && (
            <>
              <div className="flex justify-center">
                <CheckCircle className="h-16 w-16 text-green-500" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-green-600 mb-2">Registration Approved!</h3>
                <p className="text-sm text-muted-foreground">
                  Your clinic registration has been approved. Redirecting you to the dashboard...
                </p>
              </div>
            </>
          )}

          {status === 'Rejected' && (
            <>
              <div className="flex justify-center">
                <XCircle className="h-16 w-16 text-red-500" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-red-600 mb-2">Registration Rejected</h3>
                <p className="text-sm text-muted-foreground mb-4">
                  Your clinic registration has been rejected. Please contact support for more information.
                </p>
                <button
                  onClick={() => router.push('/login')}
                  className="text-sm text-primary underline"
                >
                  Back to Login
                </button>
              </div>
            </>
          )}

          {!status && (
            <>
              <div className="flex justify-center">
                <AlertCircle className="h-16 w-16 text-gray-500" />
              </div>
              <div>
                <h3 className="text-lg font-semibold mb-2">Status Unknown</h3>
                <p className="text-sm text-muted-foreground">
                  Unable to determine registration status. Please contact support.
                </p>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

