'use client';

import { useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { validateWhatsAppToken } from '@kloqo/shared-core';
import { Loader2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

function MagicLoginHandler() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const { toast } = useToast();

    useEffect(() => {
        const token = searchParams.get('tk') || searchParams.get('token'); // Support both for now
        const isWa = searchParams.get('wa') === 'true';

        if (!token) {
            router.replace('/login');
            return;
        }

        const session = validateWhatsAppToken(token);

        if (session) {
            // Store the virtual session in sessionStorage
            // The useUser hook will be updated to check this
            sessionStorage.setItem('wa_auth_data', JSON.stringify(session));

            // Mark as WhatsApp mode globally
            sessionStorage.setItem('wa_mode', 'true');

            // Success toast
            toast({
                title: "Welcome back!",
                description: "You've been successfully signed in via WhatsApp.",
            });

            // Redirect to home or specific action
            let target = '/home?wa=true';

            if (session.action === 'book' || !session.action) {
                if (session.doctorId && session.clinicId) {
                    target = `/book-appointment?doctor=${session.doctorId}&clinicId=${session.clinicId}&wa=true`;
                } else if (session.clinicId) {
                    target = `/clinics/${session.clinicId}?wa=true`;
                }
            }

            router.replace(target);
        } else {
            toast({
                variant: "destructive",
                title: "Invalid Link",
                description: "This magic link has expired or is invalid. Please request a new one.",
            });
            router.replace('/login');
        }
    }, [router, searchParams, toast]);

    return (
        <div className="min-h-screen flex flex-col items-center justify-center bg-white p-4 text-center">
            <Loader2 className="h-10 w-10 animate-spin text-primary mb-4" />
            <h1 className="text-xl font-bold mb-2">Verifying Link...</h1>
            <p className="text-muted-foreground">Please wait while we securely sign you in.</p>
        </div>
    );
}

export default function MagicLoginPage() {
    return (
        <Suspense fallback={
            <div className="min-h-screen flex items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
        }>
            <MagicLoginHandler />
        </Suspense>
    );
}
