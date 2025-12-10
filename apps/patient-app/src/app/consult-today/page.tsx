'use client';

// Prevent static generation - this page requires Firebase context
export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { ArrowLeft, Camera, MapPin, Shield } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { useUser } from '@/firebase/auth/use-user';
import { useLanguage } from '@/contexts/language-context';
import { useMasterDepartments } from '@/hooks/use-master-departments';
import { getLocalizedDepartmentName } from '@/lib/department-utils';
import { useEffect, useMemo, useState, Suspense } from 'react';
import { useDoctors } from '@/firebase/firestore/use-doctors';
import { Skeleton } from '@/components/ui/skeleton';
import nextDynamic from 'next/dynamic';
import type { Doctor } from '@/lib/types';
import { useFirestore } from '@/firebase';
import { AuthGuard } from '@/components/auth-guard';
import { doc, getDoc } from 'firebase/firestore';
// Lazy load QR scanner - only load when needed (mobile optimization)
const loadQRScanner = () => import('html5-qrcode').then(module => module.Html5Qrcode);
import { format, addMinutes, isBefore, isAfter, subMinutes, isWithinInterval, set } from 'date-fns';
import { parseTime } from '@/lib/utils';
import { getSessionEnd } from '@kloqo/shared-core';
import { BottomNav } from '@/components/bottom-nav';

const PatientForm = nextDynamic(
    () => import('@kloqo/shared-ui').then(mod => mod.PatientForm),
    {
        loading: () => (
            <div className="space-y-4 py-6">
                <Skeleton className="h-6 w-48" />
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-16 w-full" />
            </div>
        ),
        ssr: false,
    }
);

const SelectedDoctorCard = ({ doctor, onBack }: { doctor: Doctor, onBack: () => void }) => {
    const { t, language } = useLanguage();
    const { departments } = useMasterDepartments();
    const [isBioExpanded, setIsBioExpanded] = useState(false);
    
    const bio = doctor.bio || doctor.specialty || '';
    const shouldTruncate = bio.length > 100;
    const displayBio = shouldTruncate && !isBioExpanded ? bio.substring(0, 100) + '...' : bio;

    return (
        <div className="animate-in fade-in-50">
            <Card>
                <CardContent className="p-4 space-y-3">
                    <div className="flex items-center gap-4">
                        <Avatar className="h-16 w-16">
                            {doctor.avatar && <AvatarImage src={doctor.avatar} alt={doctor.name} />}
                            <AvatarFallback>{doctor.name.split(' ').map(n => n[0]).join('')}</AvatarFallback>
                        </Avatar>
                        <div className="flex-grow">
                            <h3 className="font-bold text-lg">{doctor.name}</h3>
                            <p className="text-muted-foreground">{getLocalizedDepartmentName(doctor.department, language, departments)}</p>
                            {doctor.consultationFee && (
                                <p className="text-sm font-semibold text-primary">
                                    {t.consultToday.consultationFee}: <span className="font-mono">&#8377;{doctor.consultationFee}</span>
                                </p>
                            )}
                        </div>
                        <Button variant="link" onClick={onBack}>{t.buttons.changeDoctor}</Button>
                    </div>
                    {displayBio && (
                        <div className="pt-2 border-t">
                            <p className="text-sm text-muted-foreground">
                                {displayBio}
                                {shouldTruncate && (
                                    <Button 
                                        variant="link" 
                                        className="h-auto p-0 ml-1 text-xs"
                                        onClick={() => setIsBioExpanded(!isBioExpanded)}
                                    >
                                        {isBioExpanded ? t.buttons.readLess : t.buttons.readMore}
                                    </Button>
                                )}
                            </p>
                        </div>
                    )}
                </CardContent>
            </Card>
            <div className="mt-6">
                <PatientForm selectedDoctor={doctor} appointmentType="Walk-in" />
            </div>
        </div>
    );
};

const DoctorSelection = ({ doctors, onSelect }: { doctors: Doctor[], onSelect: (doctor: Doctor) => void }) => {
    const { t, language } = useLanguage();
    const { departments } = useMasterDepartments();
    const [expandedBios, setExpandedBios] = useState<Record<string, boolean>>({});

    const toggleBio = (doctorId: string) => {
        setExpandedBios(prev => ({ ...prev, [doctorId]: !prev[doctorId] }));
    };

    return (
        <div className="space-y-4">
             {doctors.map(doctor => {
                const isExpanded = expandedBios[doctor.id];
                const bio = doctor.bio || doctor.specialty || '';
                const shouldTruncate = bio.length > 100;
                const displayBio = shouldTruncate && !isExpanded ? bio.substring(0, 100) + '...' : bio;

                return (
                    <Card 
                        key={doctor.id} 
                        onClick={() => onSelect(doctor)}
                        className="cursor-pointer transition-all hover:shadow-lg"
                    >
                        <CardContent className="p-4 space-y-3">
                            <div className="flex items-center gap-4">
                                <Avatar className="h-16 w-16">
                                    {doctor.avatar && <AvatarImage src={doctor.avatar} alt={doctor.name} />}
                                    <AvatarFallback>{doctor.name.split(' ').map(n => n[0]).join('')}</AvatarFallback>
                                </Avatar>
                                <div className="flex-grow">
                                    <h3 className="font-bold text-lg">{doctor.name}</h3>
                                    <p className="text-muted-foreground">{getLocalizedDepartmentName(doctor.department, language, departments)}</p>
                                    {doctor.consultationFee && (
                                        <p className="text-sm font-semibold text-primary">
                                            {t.consultToday.consultationFee}: <span className="font-mono">&#8377;{doctor.consultationFee}</span>
                                        </p>
                                    )}
                                </div>
                            </div>
                            {displayBio && (
                                <div className="pt-2 border-t">
                                    <p className="text-sm text-muted-foreground">
                                        {displayBio}
                                        {shouldTruncate && (
                                    <Button 
                                        variant="link" 
                                        className="h-auto p-0 ml-1 text-xs"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            toggleBio(doctor.id);
                                        }}
                                    >
                                        {isExpanded ? t.buttons.readLess : t.buttons.readMore}
                                    </Button>
                                        )}
                                    </p>
                                </div>
                            )}
                        </CardContent>
                    </Card>
                );
             })}
        </div>
    );
};

interface Clinic {
    id: string;
    name: string;
    latitude: number;
    longitude: number;
}

function ConsultTodayContent() {
    const pathname = usePathname();
    const router = useRouter();
    const searchParams = useSearchParams();
    const { user, loading: userLoading } = useUser();
    const firestore = useFirestore();
    const { t } = useLanguage();
    const [selectedDoctor, setSelectedDoctor] = useState<Doctor | null>(null);
    const [clinic, setClinic] = useState<Clinic | null>(null);
    const [showQRScanner, setShowQRScanner] = useState(false);
    const [isScanning, setIsScanning] = useState(false);
    const [locationError, setLocationError] = useState<string | null>(null);
    const [isCheckingLocation, setIsCheckingLocation] = useState(false);
    const [permissionGranted, setPermissionGranted] = useState(false);

    const clinicId = useMemo(() => {
        const id = searchParams.get('clinicId');
        return id ? id.trim() : null;
    }, [searchParams]);

    const doctorId = useMemo(() => {
        const id = searchParams.get('doctorId');
        return id ? id.trim() : null;
    }, [searchParams]);

    const { doctors, loading: doctorsLoading } = useDoctors(clinicId ? [clinicId] : undefined);
    
    // Fetch clinic details
    useEffect(() => {
        const fetchClinic = async () => {
            if (!clinicId || !firestore) return;
            
            try {
                const clinicRef = doc(firestore, 'clinics', clinicId);
                const clinicSnap = await getDoc(clinicRef);
                
                if (clinicSnap.exists()) {
                    const clinicData = clinicSnap.data();
                    setClinic({
                        id: clinicSnap.id,
                        name: clinicData.name || '',
                        latitude: clinicData.latitude || 0,
                        longitude: clinicData.longitude || 0
                    });
                }
            } catch (error) {
                console.error('Error fetching clinic:', error);
            }
        };

        fetchClinic();
    }, [clinicId, firestore]);

    // Auto-check location when clinic is loaded
    useEffect(() => {
        if (clinic && !permissionGranted && !isCheckingLocation && !locationError) {
            const autoCheck = async () => {
                const result = await checkLocation();
                if (result.allowed) {
                    setPermissionGranted(true);
                }
            };
            autoCheck();
        }
    }, [clinic]);

    // Auto-select doctor if doctorId is provided in URL
    useEffect(() => {
        if (doctorId && doctors.length > 0 && !selectedDoctor) {
            const doctor = doctors.find(d => d.id === doctorId);
            if (doctor) {
                setSelectedDoctor(doctor);
            }
        }
    }, [doctorId, doctors, selectedDoctor]);

    // Check location permission
    const checkLocation = async () => {
        if (!clinic) return { allowed: true };
        
        if (!navigator.geolocation) {
            return { 
                allowed: false, 
                error: 'Geolocation is not supported on this device' 
            };
        }

        setIsCheckingLocation(true);
        setLocationError(null);

        try {
            const position = await new Promise<GeolocationPosition>((resolve, reject) => {
                navigator.geolocation.getCurrentPosition(resolve, reject, {
                    enableHighAccuracy: true,
                    timeout: 5000,
                    maximumAge: 0
                });
            });

            const { latitude, longitude } = position.coords;
            const distance = calculateDistance(
                latitude, 
                longitude, 
                clinic.latitude, 
                clinic.longitude
            );

            setIsCheckingLocation(false);

            // Check if within 150 meters (increased for GPS accuracy and indoor location)
            if (distance > 150) {
                const distanceMeters = Math.round(distance);
                return { 
                    allowed: false, 
                    error: `You must be within 150 meters of the clinic. Current distance: ${distanceMeters}m away. Please try checking your location again or contact the clinic.` 
                };
            }

            return { allowed: true, distance: Math.round(distance) };
        } catch (error: any) {
            setIsCheckingLocation(false);
            let errorMsg = t.consultToday.couldNotAccessLocation;
            
            // Extract error code safely
            const errorCode = (error as GeolocationPositionError)?.code ?? (error as { code?: number })?.code;
            
            if (errorCode === 1) {
                errorMsg = t.consultToday.locationDenied;
                console.error("Geolocation error: Permission denied");
            } else if (errorCode === 2) {
                // POSITION_UNAVAILABLE - includes CoreLocation's kCLErrorLocationUnknown
                // This is common when GPS can't get a fix (indoor, poor signal, etc.)
                errorMsg = t.consultToday.locationUnavailable;
                // Only log in development - this is expected behavior and doesn't need user attention
                if (process.env.NODE_ENV === 'development') {
                    console.debug("Geolocation unavailable (normal in some situations):", {
                        code: errorCode,
                        note: "CoreLocation may report kCLErrorLocationUnknown when GPS cannot get a fix. This is expected behavior indoors or with poor signal."
                    });
                }
            } else if (errorCode === 3) {
                errorMsg = t.consultToday.locationRequestTimeout;
                console.warn("Geolocation timeout:", { code: errorCode });
            } else {
                // Unknown error - log with details
                console.error("Geolocation error (unknown):", {
                    code: errorCode,
                    error: error,
                    errorType: typeof error
                });
            }
            
            return { allowed: false, error: errorMsg };
        }
    };

    // Calculate distance between two points in meters
    const calculateDistance = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
        const R = 6371e3; // Earth radius in meters
        const φ1 = lat1 * Math.PI / 180;
        const φ2 = lat2 * Math.PI / 180;
        const Δφ = (lat2 - lat1) * Math.PI / 180;
        const Δλ = (lon2 - lon1) * Math.PI / 180;

        const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
                  Math.cos(φ1) * Math.cos(φ2) *
                  Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

        return R * c;
    };

    // Check if walk-in is available (30 minutes before first session starts, closes 15 minutes before effective end incl. extensions)
    const isWalkInAvailable = (doctor: Doctor): boolean => {
        if (!doctor.availabilitySlots?.length) return false;

        const now = new Date();
        const todayDay = format(now, 'EEEE');
        const todaysAvailability = doctor.availabilitySlots.find(s => s.day === todayDay);
        
        if (!todaysAvailability || todaysAvailability.timeSlots.length === 0) return false;
        
        const firstSession = todaysAvailability.timeSlots[0];
        const lastSessionIndex = todaysAvailability.timeSlots.length - 1;
        const lastSession = todaysAvailability.timeSlots[lastSessionIndex];

        const startTime = parseTime(firstSession.from, now);

        // Use session-aware effective end (includes extensions). Fallback to original end.
        const effectiveEnd = getSessionEnd(doctor, now, lastSessionIndex) || parseTime(lastSession.to, now);

        // Walk-in opens 30 minutes before the first session starts
        const walkInStartTime = subMinutes(startTime, 30);
        // Walk-in closes 15 minutes before consultation end
        const walkInEndTime = subMinutes(effectiveEnd, 15);

        return isWithinInterval(now, { start: walkInStartTime, end: walkInEndTime });
    };

    const handleScanQR = async () => {
        setShowQRScanner(true);
        setLocationError(null);
    };

    const handleCameraScan = () => {
        if (!showQRScanner || !clinic) return;

        setIsScanning(true);

        // Check location first
        checkLocation().then(result => {
            if (!result.allowed) {
                setLocationError(result.error || 'Location check failed');
                setIsScanning(false);
                return;
            }

            // Lazy load and start QR scanner (mobile optimization)
            loadQRScanner().then(Html5Qrcode => {
                const html5Qrcode = new Html5Qrcode("qr-reader");
                return html5Qrcode.start(
                { facingMode: "environment" },
                {
                    fps: 10,
                    qrbox: { width: 250, height: 250 }
                },
                (decodedText) => {
                    html5Qrcode.stop().then(() => {
                        setIsScanning(false);
                        setShowQRScanner(false);
                        
                        // Parse QR code URL
                        try {
                            const url = new URL(decodedText);
                            const params = new URLSearchParams(url.search);
                            const scannedClinicId = params.get('clinicId');
                            
                            if (scannedClinicId && scannedClinicId === clinicId) {
                                setPermissionGranted(true);
                            } else {
                                router.push('/login');
                            }
                        } catch (error) {
                            router.push('/login');
                        }
                    });
                },
                (errorMessage) => {
                    // Handle scan errors silently
                }
            ).catch(err => {
                console.error("QR scan error:", err);
                setIsScanning(false);
                setShowQRScanner(false);
            });
            }).catch(err => {
                console.error("Error loading QR scanner:", err);
                setIsScanning(false);
                setShowQRScanner(false);
            });
        });
    };

    const handleManualEntry = async () => {
        setIsCheckingLocation(true);
        setLocationError(null);

        const result = await checkLocation();
        
        if (!result.allowed) {
            setLocationError(result.error || 'Location check failed');
            setIsCheckingLocation(false);
            return;
        }

        setPermissionGranted(true);
        setIsCheckingLocation(false);
    };

    useEffect(() => {
        if (!userLoading && !user) {
            const params = new URLSearchParams();
            if (clinicId) {
                params.set('clinicId', clinicId);
                const redirectUrl = `/consult-today?clinicId=${clinicId}`;
                params.set('redirect', redirectUrl);
            }
            router.push(`/login?${params.toString()}`);
        }
    }, [user, userLoading, router, clinicId]);

    const handleSelectDoctor = (doctor: Doctor) => {
        if (!isWalkInAvailable(doctor)) {
            setLocationError(`Dr. ${doctor.name} ${t.consultToday.doctorNotAvailableWalkIn}`);
            return;
        }
        setSelectedDoctor(doctor);
    }
    
    const handleBack = () => {
       if (selectedDoctor) {
           setSelectedDoctor(null);
           setLocationError(null);
       } else {
           router.back();
       }
    }

    // Show only doctors available for walk-in based on timing
    const availableDoctors = doctors.filter(isWalkInAvailable);

    // Progressive loading: Show page structure immediately
    // Only block if we have absolutely no user (AuthGuard will handle redirect)
    if (!userLoading && !user) {
        return null; // AuthGuard handles redirect
    }

    // Main screen: Show QR scan button
    if (!permissionGranted) {
        return (
            <div className="flex min-h-screen w-full flex-col bg-background font-body">
                <header className="flex items-center p-4 border-b">
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => router.push('/home')}>
                        <ArrowLeft className="h-5 w-5" />
                        <span className="sr-only">Back</span>
                    </Button>
                    <h1 className="text-xl font-bold text-center flex-grow">{t.consultToday.walkInAppointment}</h1>
                    <div className="w-8"></div>
                </header>

                <main className="flex-grow overflow-y-auto p-4 md:p-6 space-y-6">
                    <Card>
                        <CardHeader>
                            <div className="flex items-center gap-3 mb-2">
                                <div className="p-3 rounded-full bg-primary/10">
                                    <Shield className="h-6 w-6 text-primary" />
                                </div>
                                <CardTitle className="text-lg">{t.consultToday.verifyYourLocation}</CardTitle>
                            </div>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <p className="text-sm text-muted-foreground">
                                {t.consultToday.locationVerificationDesc}
                            </p>

                            {!isCheckingLocation && (
                                <div className="p-3 bg-destructive/10 text-destructive rounded-lg text-sm">
                                    {locationError || t.consultToday.mustBeAtClinic}
                                </div>
                            )}

                            {isCheckingLocation ? (
                                <div className="text-center py-8 space-y-3">
                                    <Skeleton className="h-10 w-10 rounded-full mx-auto" />
                                    <Skeleton className="h-4 w-40 mx-auto" />
                                </div>
                            ) : (
                                <div className="space-y-3">
                                    <Button 
                                        onClick={handleManualEntry}
                                        disabled={isScanning || isCheckingLocation}
                                        className="w-full"
                                    >
                                        <MapPin className="mr-2 h-4 w-4" />
                                        {t.consultToday.tryAgain}
                                    </Button>

                                    <Button 
                                        onClick={() => router.push(clinicId ? `/clinics/${clinicId}` : '/clinics')}
                                        variant="outline"
                                        className="w-full"
                                    >
                                        {t.consultToday.bookForAnotherDay}
                                    </Button>
                                </div>
                            )}
                        </CardContent>
                    </Card>
                </main>
            </div>
        );
    }

    return (
        <div className="flex min-h-screen w-full flex-col bg-background font-body">
            <header className="flex items-center p-4 border-b">
                 <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleBack}>
                    <ArrowLeft className="h-5 w-5" />
                    <span className="sr-only">Back</span>
                </Button>
                <h1 className="text-xl font-bold text-center flex-grow">
                    {selectedDoctor ? t.consultToday.bookWalkIn : t.consultToday.selectDoctor}
                </h1>
                <div className="w-8"></div>
            </header>
            <main className="flex-grow overflow-y-auto p-4 md:p-6 space-y-6">
                {selectedDoctor ? (
                    <SelectedDoctorCard 
                        doctor={selectedDoctor} 
                        onBack={() => setSelectedDoctor(null)} 
                    />
                ) : (
                    <>
                        {locationError && (
                            <Card className="bg-destructive/10 border-destructive/50">
                                <CardContent className="p-4">
                                    <p className="text-destructive text-sm">
                                        {locationError}
                                    </p>
                                </CardContent>
                            </Card>
                        )}
                        
                        {doctorsLoading && (
                            <div className="space-y-4">
                                <Skeleton className="h-24 w-full" />
                                <Skeleton className="h-24 w-full" />
                            </div>
                        )}
                        
                        {!doctorsLoading && availableDoctors.length > 0 && (
                            <DoctorSelection doctors={availableDoctors} onSelect={handleSelectDoctor} />
                        )}

                        {!doctorsLoading && availableDoctors.length === 0 && (
                            <Card>
                                <CardContent className="p-8 text-center space-y-4">
                                    <p className="text-lg font-semibold text-destructive">
                                        {t.consultToday.noDoctorsForWalkIn}
                                    </p>
                                    <p className="text-sm text-muted-foreground">
                                        {t.consultToday.walkInOpens30MinutesBefore}
                                    </p>
                                    <Button 
                                        onClick={() => router.push(clinicId ? `/clinics/${clinicId}` : '/clinics')}
                                        variant="outline"
                                        className="mt-4"
                                    >
                                        {t.consultToday.bookForAnotherDay}
                                    </Button>
                                </CardContent>
                            </Card>
                        )}
                    </>
                )}
            </main>

            {/* Commenting/removing <BottomNav /> for consult-today */}
            {/* <BottomNav /> */}
        </div>
    );
}

function ConsultTodayPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <Skeleton className="h-12 w-12 rounded-full" />
          <Skeleton className="h-4 w-32" />
        </div>
      </div>
    }>
      <ConsultTodayContent />
    </Suspense>
  );
}

function ConsultTodayPageWithAuth() {
  return (
    <AuthGuard>
      <ConsultTodayPage />
    </AuthGuard>
  );
}

export default ConsultTodayPageWithAuth;