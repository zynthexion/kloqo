'use client';

import { useEffect, useMemo } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useUser } from '@/firebase/auth/use-user';
import { useAppointments } from '@/firebase/firestore/use-appointments';
import { isPast, isToday, parse } from 'date-fns';
import { Skeleton } from '@/components/ui/skeleton';
import { useLanguage } from '@/contexts/language-context';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import type { Appointment } from '@/lib/types';
import { LottieAnimation } from '@/components/lottie-animation';
import emptyStateAnimation from '@/lib/animations/empty-state.json';

function computeUpcomingAppointments(appointments: Appointment[]) {
    return appointments
        .filter(a => {
            if (a.status === 'Cancelled' || a.status === 'Completed') {
                return false;
            }
            let appointmentDate;
            try {
                appointmentDate = parse(a.date, 'd MMMM yyyy', new Date());
            } catch {
                appointmentDate = new Date(a.date);
            }
            return isToday(appointmentDate) || !isPast(appointmentDate);
        })
        .sort((a, b) => {
            try {
                const dateA = parse(a.date, 'd MMMM yyyy', new Date());
                const dateB = parse(b.date, 'd MMMM yyyy', new Date());
                const dateDiff = dateA.getTime() - dateB.getTime();
                if (dateDiff !== 0) return dateDiff;
                const timeA = parse(a.time, 'hh:mm a', dateA).getTime();
                const timeB = parse(b.time, 'hh:mm a', dateB).getTime();
                if (timeA !== timeB) return timeA - timeB;
                if (a.tokenNumber?.startsWith('A') && b.tokenNumber?.startsWith('W')) return -1;
                if (a.tokenNumber?.startsWith('W') && b.tokenNumber?.startsWith('A')) return 1;
                return (parseInt(a.tokenNumber?.replace(/[A-W]/g, '') || '0', 10) -
                        parseInt(b.tokenNumber?.replace(/[A-W]/g, '') || '0', 10));
            } catch {
                return 0;
            }
        });
}

import { AuthGuard } from '@/components/auth-guard';

function LiveTokenEntryPage() {
    const router = useRouter();
    const { user, loading: userLoading } = useUser();
    const { appointments, loading: appointmentsLoading } = useAppointments(user?.patientId);
    const { t } = useLanguage();

    const upcomingAppointments = useMemo(() => computeUpcomingAppointments(appointments), [appointments]);
    const firstUpcoming = upcomingAppointments[0];

    useEffect(() => {
        if (userLoading || appointmentsLoading) return;
        if (firstUpcoming) {
            router.replace(`/live-token/${firstUpcoming.id}`);
        }
    }, [firstUpcoming, router, userLoading, appointmentsLoading]);

    if (userLoading || appointmentsLoading || firstUpcoming) {
        return (
            <div className="flex h-screen w-full flex-col items-center justify-center bg-background">
                <div className="flex flex-col items-center gap-4">
                    <Skeleton className="h-12 w-12 rounded-full" />
                    <Skeleton className="h-4 w-32" />
                </div>
            </div>
        );
    }

    return (
        <div className="flex min-h-screen w-full flex-col bg-[hsl(var(--app-background))] font-body text-foreground">
            <header className="flex items-center p-4">
                <Link href="/home" className="p-2">
                    <ArrowLeft className="h-6 w-6" />
                </Link>
                <h1 className="text-xl font-bold text-center flex-grow">{t.liveToken.title}</h1>
                <div className="w-8" />
            </header>
            <main className="flex-grow flex flex-col items-center justify-center p-4">
                <Card className="w-full max-w-sm text-center">
                    <CardContent className="p-6 space-y-4">
                        <div className="flex justify-center">
                            <LottieAnimation
                                animationData={emptyStateAnimation}
                                size={200}
                                autoplay={true}
                                loop={true}
                                className="mb-2"
                            />
                        </div>
                        <h2 className="text-xl font-bold">{t.liveToken.noAppointments}</h2>
                        <p className="text-muted-foreground">{t.liveToken.noAppointmentsDescription}</p>
                        <Button asChild>
                            <Link href="/appointments">{t.appointments.myAppointments}</Link>
                        </Button>
                    </CardContent>
                </Card>
            </main>
        </div>
    );
}

function LiveTokenEntryPageWithAuth() {
    return (
        <AuthGuard>
            <LiveTokenEntryPage />
        </AuthGuard>
    );
}

export default LiveTokenEntryPageWithAuth;
