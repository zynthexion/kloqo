'use client';

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { doc, getDoc, collection, getDocs, query, where } from 'firebase/firestore';
import { useFirestore } from '@/firebase';
import { useUser } from '@/firebase/auth/use-user';
import { Card, CardContent } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ArrowLeft, MapPin, Building2, Clock, Users } from 'lucide-react';
import type { Clinic, Doctor } from '@/lib/types';
import { useLanguage } from '@/contexts/language-context';
import { useMasterDepartments } from '@/hooks/use-master-departments';
import { getLocalizedDepartmentName } from '@/lib/department-utils';

// Prevent static generation - this page requires Firebase context
export const dynamic = 'force-dynamic';

function DoctorSkeleton() {
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

function DoctorCard({ doctor, t, departments, language }: { doctor: Doctor; t: any; departments: any[]; language: 'en' | 'ml' }) {
    const router = useRouter();

    const handleBookAppointment = () => {
        router.push(`/book-appointment?doctorId=${doctor.id}&clinicId=${doctor.clinicId}`);
    };

    return (
        <Card className="mb-4 cursor-pointer hover:shadow-lg transition-shadow">
            <CardContent className="p-6">
                <div className="flex gap-4">
                    {doctor.avatar ? (
                        <Avatar className="h-16 w-16">
                            <AvatarImage src={doctor.avatar} alt={doctor.name} />
                            <AvatarFallback>{doctor.name.split(' ').map(n => n[0]).join('')}</AvatarFallback>
                        </Avatar>
                    ) : (
                        <div className="h-16 w-16 rounded-full bg-primary/10 flex items-center justify-center">
                            <Users className="h-8 w-8 text-primary" />
                        </div>
                    )}
                    <div className="flex-grow">
                        <div className="flex items-start justify-between mb-2">
                            <div>
                                <h3 className="text-lg font-bold">{doctor.name}</h3>
                                <p className="text-sm text-muted-foreground">{doctor.specialty}</p>
                            </div>
                            {doctor.department && (
                                <Badge variant="secondary">{getLocalizedDepartmentName(doctor.department, language, departments)}</Badge>
                            )}
                        </div>
                        
                        <div className="flex items-center gap-4 text-sm text-muted-foreground mb-4">
                            {(doctor as any).education && (
                                <div className="flex items-center gap-1">
                                    <span className="text-xs">{(doctor as any).education}</span>
                                </div>
                            )}
                        </div>
                        
                        <Button 
                            onClick={handleBookAppointment}
                            className="w-full"
                            size="sm"
                        >
                            {t.clinics.bookAppointment}
                        </Button>
                    </div>
                </div>
            </CardContent>
        </Card>
    );
}

import { AuthGuard } from '@/components/auth-guard';

function ClinicDetailsPage() {
    const router = useRouter();
    const params = useParams();
    const clinicId = params.id as string;
    
    const firestore = useFirestore();
    const { user, loading: userLoading } = useUser();
    const { t, language } = useLanguage();
    const { departments } = useMasterDepartments();
    
    const [clinic, setClinic] = useState<Clinic | null>(null);
    const [doctors, setDoctors] = useState<Doctor[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        if (!clinicId || !firestore) return;

        const fetchData = async () => {
            setLoading(true);
            try {
                // Fetch clinic details
                const clinicDocRef = doc(firestore, 'clinics', clinicId);
                const clinicDoc = await getDoc(clinicDocRef);
                
                if (clinicDoc.exists()) {
                    setClinic({
                        id: clinicDoc.id,
                        ...clinicDoc.data()
                    } as Clinic);
                    
                    // Fetch doctors for this clinic
                    const doctorsQuery = query(
                        collection(firestore, 'doctors'),
                        where('clinicId', '==', clinicId)
                    );
                    const doctorsSnapshot = await getDocs(doctorsQuery);
                    const doctorsData = doctorsSnapshot.docs.map(doc => ({
                        id: doc.id,
                        ...doc.data()
                    } as Doctor));
                    setDoctors(doctorsData);
                } else {
                    console.error('Clinic not found');
                    router.push('/clinics');
                }
            } catch (error) {
                console.error('Error fetching clinic details:', error);
            } finally {
                setLoading(false);
            }
        };

        fetchData();
    }, [clinicId, firestore, router]);

    // Redirect to login if user is not authenticated
    useEffect(() => {
        if (!userLoading && !user) {
            // Save the current path so we can redirect back after login
            const currentPath = window.location.pathname;
            localStorage.setItem('redirectAfterLogin', currentPath);
            
            // Check if clinicId is in URL and add it as query param for login
            const loginParams = new URLSearchParams();
            loginParams.set('clinicId', clinicId);
            
            router.push(`/login?${loginParams.toString()}`);
        }
    }, [user, userLoading, router, clinicId]);

    // Progressive loading: Show page structure immediately, hydrate with data
    // Only block if we have absolutely no user
    if (!userLoading && !user) {
        return null; // AuthGuard will handle redirect
    }

    return (
        <div className="flex min-h-screen w-full flex-col bg-background font-body">
            {/* Header - Always show immediately */}
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
                    <h1 className="text-xl font-bold text-center flex-grow ml-4">{t.clinics.clinicDetails}</h1>
                    <div className="w-8"></div>
                </div>
            </div>

            <main className="flex-grow overflow-y-auto p-6">
                {/* Clinic Info Card - Show skeleton while loading */}
                {loading || !clinic ? (
                    <Card className="mb-6">
                        <CardContent className="p-6">
                            <div className="flex gap-4">
                                <Skeleton className="h-20 w-20 rounded-lg" />
                                <div className="flex-grow space-y-2">
                                    <Skeleton className="h-6 w-48" />
                                    <Skeleton className="h-4 w-32" />
                                    <Skeleton className="h-4 w-full" />
                                </div>
                            </div>
                        </CardContent>
                    </Card>
                ) : (
                    <Card className="mb-6 relative">
                    {clinic.latitude && clinic.longitude && (
                        <Button
                            variant="default"
                            size="icon"
                            className="absolute bottom-4 right-4 h-14 w-14 rounded-full shadow-lg"
                            onClick={() => {
                                const googleMapsUrl = `https://www.google.com/maps?q=${clinic.latitude},${clinic.longitude}`;
                                window.open(googleMapsUrl, '_blank');
                            }}
                        >
                            <MapPin className="h-6 w-6" />
                        </Button>
                    )}
                    <CardContent className="p-6">
                        <div className="flex gap-4">
                            {clinic.logoUrl ? (
                                <Avatar className="h-20 w-20 rounded-lg">
                                    <AvatarImage src={clinic.logoUrl} alt={clinic.name} />
                                    <AvatarFallback>{clinic.name.split(' ').map(n => n[0]).join('')}</AvatarFallback>
                                </Avatar>
                            ) : (
                                <div className="h-20 w-20 rounded-lg bg-primary/10 flex items-center justify-center">
                                    <Building2 className="h-10 w-10 text-primary" />
                                </div>
                            )}
                            <div className="flex-grow space-y-2 pr-20">
                                <div>
                                    <h2 className="text-xl font-bold">{clinic.name}</h2>
                                    <p className="text-sm text-muted-foreground">{clinic.type}</p>
                                </div>
                                
                                {clinic.address && (
                                    <div className="flex items-start gap-2 text-sm text-muted-foreground">
                                        <MapPin className="w-4 h-4 mt-0.5" />
                                        <span>{clinic.address}</span>
                                    </div>
                                )}
                                
                                <div className="flex items-center gap-4 text-sm">
                                    <div className="flex items-center gap-1">
                                        <Users className="w-4 h-4" />
                                        <span>{doctors.length} {doctors.length !== 1 ? t.clinics.doctorsPlural : t.clinics.doctors}</span>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </CardContent>
                </Card>
                )}

                {/* Doctors Section - Show skeletons while loading */}
                <div>
                    <h2 className="text-lg font-bold mb-4">{t.home.availableDoctors}</h2>
                    {loading && doctors.length === 0 ? (
                        <div className="space-y-4">
                            <DoctorSkeleton />
                            <DoctorSkeleton />
                            <DoctorSkeleton />
                        </div>
                    ) : doctors.length > 0 ? (
                        doctors.map(doctor => (
                            <DoctorCard key={doctor.id} doctor={doctor} t={t} departments={departments} language={language} />
                        ))
                    ) : (
                        <Card>
                            <CardContent className="p-8 text-center">
                                <p className="text-muted-foreground">{t.consultToday.noDoctorsAvailable}</p>
                            </CardContent>
                        </Card>
                    )}
                </div>
            </main>
        </div>
    );
}

function ClinicDetailsPageWithAuth() {
    return (
        <AuthGuard>
            <ClinicDetailsPage />
        </AuthGuard>
    );
}

export default ClinicDetailsPageWithAuth;

