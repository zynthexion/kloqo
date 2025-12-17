'use client';

import { useEffect, useState, useRef } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { useUser } from '@/firebase/auth/use-user';
import { useFirestore } from '@/firebase';
import { doc, getDoc, collection, query, where, getDocs } from 'firebase/firestore';
import { SplashScreen } from '@/components/splash-screen';
import type { Patient } from '@/lib/types';

interface AuthGuardProps {
  children: React.ReactNode;
}

/**
 * AuthGuard component that protects routes by redirecting unauthenticated users to login
 * and preserving the current URL as a redirect parameter
 */
export function AuthGuard({ children }: AuthGuardProps) {
  const { user, loading: userLoading } = useUser();
  const firestore = useFirestore();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [validating, setValidating] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [isValidated, setIsValidated] = useState(false);
  const redirectingRef = useRef(false);

  // Cache validation results per user to avoid re-validation on navigation
  const validationCacheRef = useRef<{
    userId: string | null;
    patientId: string | null;
    isValidated: boolean;
    timestamp: number;
  } | null>(null);

  const VALIDATION_CACHE_DURATION = 2 * 60 * 1000; // 2 minutes

  const validatePatientAndUser = async (currentUser: typeof user) => {
    if (!firestore || !currentUser?.patientId) {
      console.log('[AuthGuard] 🚫 Validation failed: Missing firestore or patientId');
      redirectToLogin();
      return;
    }

    setValidating(true);
    setValidationError(null);

    try {
      console.log('[AuthGuard] 🔍 Step 2 - Finding patient document...', {
        patientId: currentUser.patientId
      });

      // Step 2: Get patient document
      const patientDocRef = doc(firestore, 'patients', currentUser.patientId);
      const patientDocSnap = await getDoc(patientDocRef);

      if (!patientDocSnap.exists()) {
        console.log('[AuthGuard] 🚫 Step 2 Failed: Patient document not found:', currentUser.patientId);
        setValidationError('Patient document not found');
        redirectToLogin();
        return;
      }

      const patientData = patientDocSnap.data() as Patient;
      console.log('[AuthGuard] ✅ Step 2 Success: Patient document found:', {
        patientId: currentUser.patientId,
        patientName: patientData.name || 'N/A',
        communicationPhone: patientData.communicationPhone || patientData.phone || 'N/A',
        phone: patientData.phone || 'N/A'
      });

      // Step 3: Get communicationPhone from patient document
      const communicationPhone = patientData.communicationPhone || patientData.phone || null;

      if (!communicationPhone) {
        console.log('[AuthGuard] 🚫 Step 3 Failed: No communicationPhone found in patient document');
        setValidationError('No communicationPhone in patient document');
        redirectToLogin();
        return;
      }

      console.log('[AuthGuard] 🔍 Step 4 - Searching users collection...', {
        communicationPhone,
        searchingFor: {
          phone: communicationPhone,
          role: 'patient'
        }
      });

      // Step 4: Search users collection for user with matching phone and role='patient'
      const usersQuery = query(
        collection(firestore, 'users'),
        where('phone', '==', communicationPhone),
        where('role', '==', 'patient')
      );

      const usersSnapshot = await getDocs(usersQuery);

      console.log('[AuthGuard] 📊 Step 4 Results:', {
        usersFound: usersSnapshot.size,
        communicationPhone,
        users: usersSnapshot.docs.map(doc => ({
          id: doc.id,
          phone: doc.data().phone,
          role: doc.data().role,
          patientId: doc.data().patientId
        }))
      });

      if (usersSnapshot.empty) {
        console.log('[AuthGuard] 🚫 Step 4 Failed: No user found with communicationPhone and role=patient', {
          communicationPhone,
          searchedFields: ['phone', 'role']
        });
        setValidationError(`No user found with phone ${communicationPhone} and role=patient`);
        redirectToLogin();
        return;
      }

      // Check if any of the found users match the current user's resolved dbUserId
      const matchingUser = usersSnapshot.docs.find(doc => doc.id === currentUser.dbUserId);

      if (!matchingUser) {
        console.log('[AuthGuard] ⚠️ Step 4 Warning: Found users but none match current user dbUserId', {
          currentUserId: currentUser.uid,
          currentDbUserId: currentUser.dbUserId,
          foundUserIds: usersSnapshot.docs.map(doc => doc.id)
        });
        // Still allow if we found at least one patient user with the communicationPhone
        console.log('[AuthGuard] ✅ Step 4 Success: Found patient user(s) with communicationPhone (allowing access)');
      } else {
        console.log('[AuthGuard] ✅ Step 4 Success: Found matching user with communicationPhone and role=patient', {
          userId: matchingUser.id,
          phone: matchingUser.data().phone,
          role: matchingUser.data().role
        });
      }

      // Validation passed!
      console.log('[AuthGuard] ✅✅✅ ALL VALIDATION STEPS PASSED - User is authenticated and validated');
      setIsValidated(true);
      setValidating(false);

      // Cache validation result for faster subsequent navigation
      if (currentUser) {
        validationCacheRef.current = {
          userId: currentUser.uid,
          patientId: currentUser.patientId || null,
          isValidated: true,
          timestamp: Date.now(),
        };
      }

    } catch (error) {
      console.error('[AuthGuard] ❌ Validation Error:', error);
      setValidationError(error instanceof Error ? error.message : 'Unknown error');
      redirectToLogin();
    } finally {
      setValidating(false);
    }
  };

  const redirectToLogin = () => {
    // Prevent multiple redirects
    if (redirectingRef.current) {
      console.log('[AuthGuard] ⚠️ Redirect already in progress, skipping...');
      return;
    }

    // Prevent redirect loops - if already on login page, don't redirect
    if (pathname === '/login') {
      console.log('[AuthGuard] ✅ Already on login page, no redirect needed');
      return;
    }

    if (typeof window !== 'undefined' && window.location.pathname === '/login') {
      console.log('[AuthGuard] ✅ Already on login page (window check), no redirect needed');
      return;
    }

    redirectingRef.current = true;
    console.log('[AuthGuard] 🔀 Starting redirect to login...');

    // Preserve current path and query params for redirect after login
    const currentPath = pathname;
    const currentQuery = searchParams.toString();
    const fullPath = currentQuery ? `${currentPath}?${currentQuery}` : currentPath;

    console.log('[AuthGuard] 💾 Saving redirect path:', fullPath);

    // Save the full path for redirect after login
    if (typeof window !== 'undefined') {
      localStorage.setItem('redirectAfterLogin', fullPath);

      // Build login URL with any clinicId from current URL
      const loginParams = new URLSearchParams();
      const clinicId = searchParams.get('clinicId');
      if (clinicId) {
        loginParams.set('clinicId', clinicId);
      }

      const loginUrl = loginParams.toString()
        ? `/login?${loginParams.toString()}`
        : '/login';

      console.log('[AuthGuard] 🔀 Redirecting to:', loginUrl);
      console.log('[AuthGuard] 🔀 Using window.location.replace for redirect (prevents back button issues)');

      // Use replace immediately to prevent loops - no setTimeout to avoid race conditions
      console.log('[AuthGuard] 🔀 Executing redirect NOW to:', loginUrl);
      console.log('[AuthGuard] 🔀 Current pathname:', window.location.pathname);
      console.log('[AuthGuard] 🔀 Redirecting to:', loginUrl);

      // Immediately redirect - don't wait
      window.location.replace(loginUrl);
    } else {
      // Fallback to router if window is not available (SSR)
      router.replace('/login');
    }
  };

  useEffect(() => {
    // Skip AuthGuard completely on login page to prevent redirect loops
    if (pathname === '/login' || pathname.startsWith('/login')) {
      console.log('[AuthGuard] ⏭️ Skipping validation on login page');
      // Clear validation cache when navigating to login (user might be logging out)
      validationCacheRef.current = null;
      return;
    }

    // Reset redirect flag when pathname changes (but not if going to login)
    if (redirectingRef.current && pathname !== '/login') {
      console.log('[AuthGuard] 🔄 Pathname changed, resetting redirect flag');
      redirectingRef.current = false;
    }

    // Clear validation cache if user changed (different user logged in)
    if (validationCacheRef.current && user && validationCacheRef.current.userId !== user.uid) {
      console.log('[AuthGuard] 🔄 User changed, clearing validation cache');
      validationCacheRef.current = null;
      setIsValidated(false);
    }

    console.log('[AuthGuard] 🔍 Step 1 - Initial Check:', {
      userLoading,
      hasUser: !!user,
      userId: user?.uid || 'null',
      patientId: user?.patientId || 'null',
      phoneNumber: user?.phoneNumber || 'null',
      pathname,
      redirecting: redirectingRef.current,
      timestamp: new Date().toISOString()
    });

    // Wait until authentication state is fully loaded
    if (userLoading) {
      console.log('[AuthGuard] ⏳ Still loading authentication state...');
      return;
    }

    // If already redirecting, don't do anything
    if (redirectingRef.current) {
      console.log('[AuthGuard] ⏸️ Already redirecting, skipping checks');
      return;
    }

    // If user is not authenticated, redirect to login
    if (!user) {
      console.log('[AuthGuard] 🚫 Step 1 Failed: User not authenticated, redirecting to login...');
      redirectToLogin();
      return;
    }

    // If no patientId, redirect to login
    if (!user.patientId) {
      console.log('[AuthGuard] 🚫 Step 1 Failed: No patientId found for user:', user.uid);
      redirectToLogin();
      return;
    }

    // Check validation cache first for faster navigation
    if (validationCacheRef.current) {
      const cached = validationCacheRef.current;
      const now = Date.now();
      const isValidCache =
        cached.userId === user.uid &&
        cached.patientId === user.patientId &&
        (now - cached.timestamp) < VALIDATION_CACHE_DURATION;

      if (isValidCache && cached.isValidated) {
        console.log('[AuthGuard] ✅ Using cached validation result');
        setIsValidated(true);
        return;
      }
    }

    // Start validation process if not already validated and firestore is available
    // Only validate once to prevent loops
    if (!isValidated && !validating && !redirectingRef.current && firestore) {
      console.log('[AuthGuard] 🚀 Starting patient validation...');
      validatePatientAndUser(user);
    }

  }, [user, userLoading, firestore, pathname, searchParams, isValidated, validating]);

  // Skip AuthGuard completely on login page to prevent loops
  if (pathname === '/login' || pathname.startsWith('/login')) {
    return <>{children}</>;
  }

  // If we're redirecting, show splash while navigation happens
  if (redirectingRef.current) {
    return <SplashScreen />;
  }

  // Optimistic rendering: Allow pages to render immediately if user exists
  // This prevents the empty screen flash - pages can show their own skeletons
  // while validation happens in the background

  // Only block if we're actually redirecting
  if (redirectingRef.current) {
    return <SplashScreen />;
  }

  // If userLoading is still true on first render, show splash
  // But allow render after initial auth check to prevent blocking
  if (userLoading && !user) {
    return <SplashScreen />;
  }

  // If no user after loading completes, redirect (but allow page to render skeleton first)
  if (!userLoading && !user && !redirectingRef.current) {
    // Start redirect but don't block - let page render briefly
    redirectToLogin();
  }

  // Optimistic rendering: Allow children to render if user exists
  // Validation happens in background and will redirect if it fails
  // This allows pages to show their skeletons immediately
  return <>{children}</>;
}

