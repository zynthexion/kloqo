'use client';

import { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useUser } from '@/firebase/auth/use-user';
import { Card, CardContent } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ArrowLeft, MapPin, Building2, Clock } from 'lucide-react';
import type { Clinic, Doctor } from '@/lib/types';
import { BottomNav } from '@/components/bottom-nav';
import { useLanguage } from '@/contexts/language-context';
import useSWR from 'swr';

// Prevent static generation - this page requires Firebase context
export const dynamic = 'force-dynamic';

function ClinicSkeleton() {
    return (
        <Card className="mb-4">
            <CardContent className="p-6">
                <div className="flex gap-4">
                    <Skeleton className="h-16 w-16 rounded-full" />
                    <div className="flex-grow space-y-2">
                        <Skeleton className="h-5 w-3/4" />
                        <Skeleton className="h-4 w-1/2" />
                        <Skeleton className="h-4 w-2/3" />
                    </div>
                </div>
            </CardContent>
        </Card>
    );
}

function ClinicCard({ clinic, doctors, t }: { clinic: Clinic; doctors: Doctor[]; t: any }) {
    const router = useRouter();
    
    const clinicDoctors = doctors.filter(doctor => doctor.clinicId === clinic.id);
    
    return (
        <Card 
            className="mb-4 cursor-pointer hover:shadow-lg transition-shadow"
            onClick={() => router.push(`/clinics/${clinic.id}`)}
        >
            <CardContent className="p-6">
                <div className="flex gap-4">
                    {clinic.logoUrl ? (
                        <Avatar className="h-16 w-16 rounded-lg">
                            <AvatarImage src={clinic.logoUrl} alt={clinic.name} />
                            <AvatarFallback>{clinic.name.split(' ').map(n => n[0]).join('')}</AvatarFallback>
                        </Avatar>
                    ) : (
                        <div className="h-16 w-16 rounded-lg bg-primary/10 flex items-center justify-center">
                            <Building2 className="h-8 w-8 text-primary" />
                        </div>
                    )}
                    <div className="flex-grow space-y-2">
                        <div>
                            <h3 className="text-lg font-bold">{clinic.name}</h3>
                            <p className="text-sm text-muted-foreground">{clinic.type}</p>
                        </div>
                        
                        {clinic.address && (
                            <div className="flex items-start gap-2 text-sm text-muted-foreground">
                                <MapPin className="w-4 h-4 mt-0.5" />
                                <span>{clinic.address}</span>
                            </div>
                        )}
                        
                        <div className="flex items-center gap-4 text-sm text-muted-foreground">
                            <div className="flex items-center gap-1">
                                <Building2 className="w-4 h-4" />
                                <span>{clinicDoctors.length} {clinicDoctors.length !== 1 ? t.clinics.doctorsPlural : t.clinics.doctors}</span>
                            </div>
                        </div>
                    </div>
                </div>
            </CardContent>
        </Card>
    );
}

const fetchJson = async (url: string) => {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) {
        throw new Error(`Failed to fetch ${url}`);
    }
    return res.json();
};

import { AuthGuard } from '@/components/auth-guard';

function ClinicsPage() {
    const router = useRouter();
    const { user, loading: userLoading } = useUser();
    const { t } = useLanguage();
    const [searchQuery, setSearchQuery] = useState('');
    const {
        data: clinicsResponse,
        isLoading: clinicsLoading,
        error: clinicsError,
    } = useSWR('/api/clinics', fetchJson, { revalidateOnFocus: false, dedupingInterval: 5 * 60 * 1000 });

    const {
        data: doctorsResponse,
        isLoading: doctorsLoading,
        error: doctorsError,
    } = useSWR('/api/doctors', fetchJson, { revalidateOnFocus: false, dedupingInterval: 5 * 60 * 1000 });

    const clinics: Clinic[] = clinicsResponse?.clinics ?? [];
    const doctors: Doctor[] = doctorsResponse?.doctors ?? [];
    const loading = userLoading || clinicsLoading || doctorsLoading;
    const hasError = clinicsError || doctorsError;

    // Redirect to login if user is not authenticated
    useEffect(() => {
        if (!userLoading && !user) {
            // Save the current path so we can redirect back after login
            const currentPath = window.location.pathname;
            localStorage.setItem('redirectAfterLogin', currentPath);
            router.push('/login');
        }
    }, [user, userLoading, router]);

    // Filter clinics based on search query
    const filteredClinics = useMemo(() => {
        if (!searchQuery) return clinics;
        
        const query = searchQuery.toLowerCase();
        return clinics.filter(clinic => 
            clinic.name.toLowerCase().includes(query) ||
            clinic.type?.toLowerCase().includes(query) ||
            clinic.address?.toLowerCase().includes(query)
        );
    }, [clinics, searchQuery]);

    // Progressive loading: Show page structure immediately
    // Only block if we have absolutely no user
    if (!userLoading && !user) {
        // AuthGuard will handle redirect, but show structure while redirecting
        return null;
    }

    return (
        <div className="flex min-h-screen w-full flex-col bg-background font-body">
            <div className="sticky top-0 bg-background border-b z-10">
                <div className="flex items-center p-4">
                    <Button 
                        variant="ghost" 
                        size="icon" 
                        className="h-8 w-8"
                        onClick={() => router.back()}
                    >
                        <ArrowLeft className="h-5 w-5" />
                        <span className="sr-only">Back</span>
                    </Button>
                    <h1 className="text-xl font-bold text-center flex-grow ml-4">{t.clinics.allClinics}</h1>
                    <div className="w-8"></div>
                </div>
                
                <div className="px-4 pb-4">
                    <div className="relative">
                        <input
                            type="text"
                            placeholder={t.clinics.searchClinics}
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className="w-full px-4 py-2 pr-10 border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary"
                        />
                        {searchQuery && (
                            <button
                                onClick={() => setSearchQuery('')}
                                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                            >
                                ×
                            </button>
                        )}
                    </div>
                </div>
            </div>

            <main className="flex-grow overflow-y-auto p-6">
                {loading && clinics.length === 0 ? (
                    // Show skeleton while loading (only if no cached data)
                    <div className="space-y-4">
                        {[1, 2, 3, 4].map((i) => (
                            <ClinicSkeleton key={i} />
                        ))}
                    </div>
                ) : hasError ? (
                    <div className="text-center py-12 text-red-500">
                        {t.clinics.errorLoading || 'Unable to load clinics right now.'}
                    </div>
                ) : filteredClinics.length > 0 ? (
                    filteredClinics.map(clinic => (
                        <ClinicCard key={clinic.id} clinic={clinic} doctors={doctors} t={t} />
                    ))
                ) : (
                    <div className="text-center py-12 text-muted-foreground">
                        {searchQuery ? (
                            <p>{t.clinics.noClinicsFound}</p>
                        ) : (
                            <p>{t.clinics.noClinicsFound}</p>
                        )}
                    </div>
                )}
            </main>

            <BottomNav />
        </div>
    );
}

function ClinicsPageWithAuth() {
    return (
        <AuthGuard>
            <ClinicsPage />
        </AuthGuard>
    );
}

export default ClinicsPageWithAuth;

