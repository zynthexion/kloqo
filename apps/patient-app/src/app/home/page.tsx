'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import nextDynamic from 'next/dynamic';
// Optimized icon imports - only critical icons for initial render
import { MapPin, Search, Ticket, X, Camera, Building2, CheckCircle2, RefreshCw } from 'lucide-react';
import { format } from 'date-fns/format';
import { parse } from 'date-fns/parse';
import { isToday } from 'date-fns/isToday';
import { isPast } from 'date-fns/isPast';
import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { collection, onSnapshot, query, where, DocumentData, QuerySnapshot, doc, getDoc, limit, orderBy } from 'firebase/firestore';
import { compareAppointments, getClinicNow, getClinicDayOfWeek, getClinicDateString } from '@kloqo/shared-core';

const getGeolocationErrorMessage = (error: unknown) => {
    return (
        (error as GeolocationPositionError)?.message ??
        (error as { message?: string })?.message ??
        (error as Error)?.message ??
        `Geolocation error code: ${(error as GeolocationPositionError)?.code ??
        (error as { code?: number })?.code ??
        'unknown'
        }`
    );
};

const logGeolocationError = (error: unknown) => {
    const errorCode =
        (error as GeolocationPositionError)?.code ??
        (error as { code?: number })?.code ??
        undefined;

    if (process.env.NODE_ENV !== 'development') {
        console.warn('Geolocation error:', getGeolocationErrorMessage(error));
        return;
    }

    try {
        const errorMessage = getGeolocationErrorMessage(error);
        const errorDetails: Record<string, unknown> = {
            code: errorCode,
            message: errorMessage,
            PERMISSION_DENIED: errorCode === 1,
            POSITION_UNAVAILABLE: errorCode === 2,
            TIMEOUT: errorCode === 3,
        };

        if (errorCode === 2) {
            console.debug('Geolocation unavailable (normal in some situations):', {
                code: errorCode,
                message: errorMessage,
                note: 'Location service cannot determine position. This may happen indoors or with poor GPS signal.',
            });
        } else {
            console.error('Geolocation error:', errorDetails);
        }

        if (error != null) {
            try {
                Object.keys(error).forEach((key) => {
                    try {
                        errorDetails[`key_${key}`] = (error as Record<string, unknown>)[key];
                    } catch {
                        // ignore individual property access failures
                    }
                });
            } catch {
                // ignore enumerable extraction errors
            }

            try {
                errorDetails.errorObjectString = JSON.stringify(error, null, 2);
            } catch {
                errorDetails.errorObjectString = String(error);
            }

            try {
                errorDetails.errorType = (error as { constructor?: { name?: string } })?.constructor?.name ?? typeof error;
            } catch {
                errorDetails.errorType = typeof error;
            }
        }
    } catch (logError) {
        console.error('Geolocation error (fallback):', {
            originalError: error,
            originalErrorString: String(error),
            originalErrorType: typeof error,
            logError,
        });
    }
};


import { cn, getArriveByTimeFromAppointment } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { PlaceHolderImages } from '@/lib/placeholder-images';
// Carousel - kept as regular import for stability (bundler handles code splitting)
import { Carousel, CarouselContent, CarouselItem } from '@/components/ui/carousel';
import { useDoctors } from '@/firebase/firestore/use-doctors';
import { useAppointments } from '@/firebase/firestore/use-appointments';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
// Tabs - kept as regular import for stability (bundler handles code splitting)
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useUser } from '@/firebase/auth/use-user';
import { AuthGuard } from '@/components/auth-guard';
import { useLanguage } from '@/contexts/language-context';
import type { Doctor, Appointment, Clinic } from '@/lib/types';
import { formatDayOfWeek, formatDate } from '@/lib/date-utils';
import { useMasterDepartments } from '@/hooks/use-master-departments';
import { getLocalizedDepartmentName } from '@/lib/department-utils';
import { useFirestore } from '@/firebase';
import { useCachedData } from '@/hooks/use-cached-data';
import useSWR from 'swr';
import { useToast } from '@/hooks/use-toast';
import { SplashScreen } from '@/components/splash-screen';

const BottomNav = nextDynamic(
    () => import('@/components/bottom-nav').then(mod => mod.BottomNav),
    {
        ssr: false,
        loading: () => <div className="h-16 w-full" aria-hidden="true" />,
    }
);

const QrScannerOverlay = nextDynamic(
    () => import('@/components/qr-scanner-overlay').then(mod => mod.QrScannerOverlay),
    {
        ssr: false,
        loading: () => null,
    }
);

const fetchJson = async (url: string) => {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) {
        throw new Error(`Failed to fetch ${url}`);
    }
    return res.json();
};

import { NotificationHistory } from '@/components/notification-history';

// Prevent static generation - this page requires Firebase context
export const dynamic = 'force-dynamic';


const WalkInCard = ({ appointment, allClinicAppointments, userDoctors, t, departments, language }: { appointment: Appointment, allClinicAppointments: Appointment[], userDoctors: Doctor[], t: any, departments: any[], language: 'en' | 'ml' }) => {

    return (
        <Card className="bg-primary-foreground/10 border-primary-foreground/20 shadow-lg text-primary-foreground">
            <CardContent className="p-4">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-4">
                        <div className="bg-primary-foreground/20 p-3 rounded-lg">
                            <Ticket className="h-8 w-8" />
                        </div>
                        <div>
                            <p className="font-bold text-lg">{t.home.yourWalkInToken}</p>
                            <p className="text-3xl font-bold">{appointment.tokenNumber}</p>
                        </div>
                    </div>
                    <Button asChild variant="secondary" className="bg-primary-foreground text-primary hover:bg-primary-foreground/90">
                        <Link href="/live-token">{t.home.viewLiveQueue}</Link>
                    </Button>
                </div>
                <div className="mt-4 border-t border-primary-foreground/20 pt-4 flex items-start justify-between">
                    <div>
                        <p className="font-bold text-lg">{appointment.doctor}</p>
                        <p className="text-sm opacity-80">{getLocalizedDepartmentName(appointment.department, language, departments)}</p>
                        <p className="text-sm text-muted-foreground mt-1">Patient: <span className="font-semibold">{appointment.patientName}</span></p>
                    </div>
                    <div className="text-right">
                        <p className="text-xs opacity-80">Time</p>
                        <p className="font-bold text-lg">{(() => {
                            const appointmentDoctor = userDoctors.find(d => d.name === appointment.doctor);
                            return getArriveByTimeFromAppointment(appointment, appointmentDoctor);
                        })()}</p>
                    </div>
                </div>
            </CardContent>
        </Card>
    )
}

const AppointmentCard = ({ appointment, departments, language, doctors, t }: { appointment: Appointment, departments: any[], language: 'en' | 'ml', doctors: Doctor[], t: any }) => {

    let day, month, dayOfMonth;
    try {
        const dateObj = parse(appointment.date, "d MMMM yyyy", new Date());
        day = formatDayOfWeek(dateObj, language);
        month = formatDate(dateObj, 'MMM', language);
        dayOfMonth = format(dateObj, 'dd');
    } catch (e) {
        // fallback for different date formats
        try {
            const dateObj = new Date(appointment.date);
            day = formatDayOfWeek(dateObj, language);
            month = formatDate(dateObj, 'MMM', language);
            dayOfMonth = format(dateObj, 'dd');
        } catch {
            const parts = appointment.date.split(' ');
            month = parts[0];
            dayOfMonth = parts[1];
            day = formatDayOfWeek(new Date(), language);
        }
    }

    return (
        <Link href="/appointments">
            <Card className="bg-primary-foreground/10 border-primary-foreground/20 shadow-none text-primary-foreground cursor-pointer hover:bg-primary-foreground/20 transition-colors">
                <CardContent className="p-4 flex gap-4 items-center">
                    <div className="text-center w-14 shrink-0 bg-primary-foreground/20 rounded-lg p-2">
                        <p className="text-sm font-medium">{month}</p>
                        <p className="text-2xl font-bold">{dayOfMonth}</p>
                        <p className="text-sm font-medium">{day}</p>
                    </div>
                    <div className="border-l border-primary-foreground/20 pl-4">
                        <p className="text-xs opacity-80">{t.home.arriveBy}: {(() => {
                            const appointmentDoctor = doctors.find(d => d.name === appointment.doctor);
                            return getArriveByTimeFromAppointment(appointment, appointmentDoctor);
                        })()}</p>
                        <p className="font-bold text-md mt-1">{appointment.doctor}</p>
                        <p className="text-sm opacity-80">{getLocalizedDepartmentName(appointment.department, language, departments)}</p>
                        <p className="text-sm opacity-80">{appointment.patientName}</p>
                    </div>
                </CardContent>
            </Card>
        </Link>
    );
};

const AppointmentCarousel = ({ appointments, departments, language, doctors, t }: { appointments: Appointment[], departments: any[], language: 'en' | 'ml', doctors: Doctor[], t: any }) => {
    if (appointments.length === 0) {
        return null;
    }

    // Ensure doctors is always an array (defensive)
    const doctorsArray = Array.isArray(doctors) ? doctors : [];

    return (
        <Carousel
            opts={{
                align: "start",
                dragFree: true,
            }}
            className="w-full"
        >
            <CarouselContent className="-ml-4">
                {appointments.map((appt) => (
                    <CarouselItem key={appt.id} className="basis-auto pl-4">
                        <AppointmentCard appointment={appt} departments={departments} language={language} doctors={doctorsArray} t={t} />
                    </CarouselItem>
                ))}
            </CarouselContent>
        </Carousel>
    );
}


const DoctorCard = ({ doctor, departments, language }: { doctor: Doctor, departments: any[], language: 'en' | 'ml' }) => {
    const status = doctor.consultationStatus || 'Out';
    const isAvailable = status === 'In';

    return (
        <Card className="hover:shadow-md transition-shadow">
            <Link href={`/book-appointment?doctorId=${doctor.id}`} className="block">
                <CardContent className="p-4 flex gap-4">
                    <Avatar className="w-16 h-16">
                        {doctor.avatar && (
                            <AvatarImage src={doctor.avatar} alt={doctor.name} />
                        )}
                        <AvatarFallback>{doctor.name.split(' ').map(n => n[0]).join('')}</AvatarFallback>
                    </Avatar>
                    <div className="flex-grow">
                        <h3 className="font-bold">{doctor.name}</h3>
                        <p className="text-sm text-muted-foreground">{getLocalizedDepartmentName(doctor.department, language, departments)}</p>
                        <p className="text-sm text-muted-foreground">{doctor.specialty}</p>
                        <Badge variant={isAvailable ? "default" : "destructive"} className={cn("mt-2", isAvailable ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800')}>
                            {status}
                        </Badge>
                    </div>
                </CardContent>
            </Link>
        </Card>
    );
};

// Function to get location name from coordinates using reverse geocoding
const getLocationName = async (lat: number, lng: number): Promise<string> => {
    try {
        const response = await fetch(
            `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&addressdetails=1`
        );

        if (!response.ok) {
            throw new Error('Failed to fetch location');
        }

        const data = await response.json();

        if (data && data.address) {
            const addr = data.address;
            // Try to get a meaningful location name
            if (addr.locality) return addr.locality;
            if (addr.city) return addr.city;
            if (addr.town) return addr.town;
            if (addr.village) return addr.village;
            if (addr.state_district) return addr.state_district;
            if (addr.state) return addr.state;
            return 'Location detected';
        }
        return 'Location detected';
    } catch (error) {
        console.error("Error fetching location name:", error);
        // Return a generic location name if the API fails
        return 'Current Location';
    }
};

const DoctorSkeleton = () => {
    return (
        <Card>
            <CardContent className="p-4 flex items-center gap-4">
                <Skeleton className="w-16 h-16 rounded-full" />
                <div className="flex-grow space-y-2">
                    <Skeleton className="h-4 w-3/4" />
                    <Skeleton className="h-4 w-1/2" />
                    <Skeleton className="h-4 w-1/3" />
                </div>
            </CardContent>
        </Card>
    )
}

type SearchResult =
    | ({ type: 'doctor' } & Doctor)
    | ({ type: 'clinic'; id: string; name: string; location?: string; avatar?: string });

function HomePageContent() {
    const pathname = usePathname();
    const router = useRouter();
    const { t, language } = useLanguage();
    const { departments } = useMasterDepartments();
    const { toast } = useToast();
    const [location, setLocation] = useState(t.consultToday.detectingLocation);
    const [searchQuery, setSearchQuery] = useState('');
    const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
    const [showQRScanner, setShowQRScanner] = useState(false);
    const [scanMode, setScanMode] = useState<'consult' | 'confirm' | null>(null);
    const isProcessingScanRef = useRef(false);
    const [activeTab, setActiveTab] = useState<'all' | 'nearby'>('nearby');
    const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
    const [isRefreshingLocation, setIsRefreshingLocation] = useState(false);
    const [isInitialLoad, setIsInitialLoad] = useState(true);
    const [isLocationLoading, setIsLocationLoading] = useState(false);
    const [splashAnimationDone, setSplashAnimationDone] = useState(false);
    const [dataReady, setDataReady] = useState(false);
    const [hasShownSplashInSession, setHasShownSplashInSession] = useState(false);

    const { user } = useUser();
    const firestore = useFirestore();
    // Get clinicIds from patient document to ensure we have the latest data
    const [patientClinicIds, setPatientClinicIds] = useState<string[]>([]);

    useEffect(() => {
        if (!firestore || !user?.patientId) {
            setPatientClinicIds([]);
            return;
        }

        // Listen to patient document for real-time clinicIds updates
        const patientRef = doc(firestore, 'patients', user.patientId);
        const unsubscribe = onSnapshot(
            patientRef,
            (snapshot) => {
                if (snapshot.exists()) {
                    const patientData = snapshot.data();
                    const clinicIds = patientData?.clinicIds || [];
                    setPatientClinicIds(clinicIds);
                } else {
                    setPatientClinicIds([]);
                }
            },
            (error) => {
                console.error('❌ Error listening to patient document:', error);
                // Fallback to user.clinicIds if patient document fails
                setPatientClinicIds(user?.clinicIds || []);
            }
        );

        return () => unsubscribe();
    }, [firestore, user?.patientId, user?.clinicIds]);

    // Use patientClinicIds if available, otherwise fallback to user.clinicIds
    const clinicIds = useMemo(() => {
        return patientClinicIds.length > 0 ? patientClinicIds : (user?.clinicIds || []);
    }, [patientClinicIds, user?.clinicIds]);

    const { doctors: userDoctors, loading: doctorsLoading } = useDoctors(clinicIds);
    const { appointments: familyAppointments, loading: appointmentsLoading } = useAppointments(user?.patientId);
    const { data: clinicsResponse } = useSWR(
        '/api/clinics',
        fetchJson,
        { revalidateOnFocus: false, dedupingInterval: 5 * 60 * 1000 }
    );
    const allClinicsData: Clinic[] = clinicsResponse?.clinics ?? [];
    const clinics = useMemo(() => {
        if (!clinicIds || clinicIds.length === 0) {
            return allClinicsData;
        }
        const idSet = new Set(clinicIds);
        return allClinicsData.filter((clinic) => idSet.has(clinic.id));
    }, [allClinicsData, clinicIds]);

    // Calculate distance between two lat/lng points in kilometers
    const calculateDistance = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
        const R = 6371; // Earth radius in kilometers
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    };

    const nearbyClinicIds = useMemo(() => {
        if (!userLocation) return [];
        return allClinicsData
            .map((clinic) => {
                const lat = typeof clinic.latitude === 'number' ? clinic.latitude : Number(clinic.latitude);
                const lng = typeof clinic.longitude === 'number' ? clinic.longitude : Number(clinic.longitude);
                if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
                    return null;
                }
                const distance = calculateDistance(userLocation.lat, userLocation.lng, lat, lng);
                return distance <= 50 ? clinic.id : null;
            })
            .filter((id): id is string => Boolean(id));
    }, [allClinicsData, userLocation]);
    const nearbyClinicIdsParam =
        nearbyClinicIds.length > 0 ? nearbyClinicIds.slice(0, 10).join(',') : null;
    const { data: nearbyDoctorsResponse, isLoading: nearbyDoctorsLoading } = useSWR(
        nearbyClinicIdsParam ? `/api/doctors?clinicIds=${encodeURIComponent(nearbyClinicIdsParam)}` : null,
        fetchJson,
        { revalidateOnFocus: false, dedupingInterval: 60 * 1000 }
    );
    const allDoctors: Doctor[] = nearbyDoctorsResponse?.doctors ?? [];

    // Improved loading state logic for "all" tab that considers location, clinics, and doctors
    const loadingAllDoctors = useMemo(() => {
        if (activeTab !== 'all') return false;

        // Show loading if location is being fetched (no cache or expired)
        if (!userLocation && isLocationLoading) {
            return true;
        }

        // Show loading if clinics haven't loaded yet
        if (clinicsResponse === undefined && allClinicsData.length === 0) {
            return true;
        }

        // Show loading if we have location and clinics but are waiting for nearby clinic IDs calculation
        if (userLocation && allClinicsData.length > 0 && nearbyClinicIds.length === 0 && nearbyClinicIdsParam === null) {
            // If we have clinics but no nearby ones found yet, don't show loading (might be calculating)
            return false;
        }

        // Show loading if we have nearby clinic IDs but are waiting for doctors
        if (nearbyClinicIdsParam && nearbyDoctorsLoading && !nearbyDoctorsResponse) {
            return true;
        }

        return false;
    }, [activeTab, userLocation, isLocationLoading, clinicsResponse, allClinicsData, nearbyClinicIds, nearbyClinicIdsParam, nearbyDoctorsLoading, nearbyDoctorsResponse]);
    const cachedAppointments = useCachedData<Appointment[]>(
        user?.dbUserId ? `appointments:${user.dbUserId}` : null,
        familyAppointments,
        !appointmentsLoading
    );
    const cachedDoctors = useCachedData<Doctor[]>(
        clinicIds && clinicIds.length > 0 ? `doctors:${clinicIds.join('-')}` : null,
        userDoctors,
        !doctorsLoading
    );
    const effectiveAppointments = useMemo(() => {
        if (familyAppointments.length > 0) {
            return familyAppointments;
        }
        return cachedAppointments ?? [];
    }, [familyAppointments, cachedAppointments]);

    // Debug logging for appointments (remove after debugging)
    useEffect(() => {
        if (process.env.NODE_ENV === 'development') {
            console.log('[HomePage] Appointments Loading Debug:', {
                patientId: user?.patientId,
                appointmentsLoading,
                familyAppointmentsCount: familyAppointments.length,
                cachedAppointmentsCount: cachedAppointments?.length ?? 0,
                effectiveAppointmentsCount: effectiveAppointments.length,
                familyAppointments: familyAppointments.map(a => ({ id: a.id, date: a.date, status: a.status })),
            });
        }
    }, [user?.patientId, appointmentsLoading, familyAppointments, cachedAppointments, effectiveAppointments]);
    const effectiveUserDoctors = useMemo(() => {
        if (userDoctors.length > 0) {
            return userDoctors;
        }
        return cachedDoctors ?? [];
    }, [userDoctors, cachedDoctors]);
    const showAppointmentsSkeleton = appointmentsLoading && effectiveAppointments.length === 0;

    // Mark initial load as complete once we have user data
    useEffect(() => {
        if (user && !appointmentsLoading && (!doctorsLoading || effectiveUserDoctors.length > 0 || cachedDoctors)) {
            setIsInitialLoad(false);
        }
    }, [user, appointmentsLoading, doctorsLoading, effectiveUserDoctors, cachedDoctors]);

    // On mount, check if we've already shown the home splash in this browser tab (sessionStorage).
    useEffect(() => {
        if (typeof window === 'undefined') return;
        const flag = window.sessionStorage.getItem('homeSplashShown');
        if (flag === '1') {
            setHasShownSplashInSession(true);
        }
    }, []);

    // Consider core home data "ready" when appointments and doctors loading are resolved
    useEffect(() => {
        if (!appointmentsLoading && !doctorsLoading) {
            setDataReady(true);
        }
    }, [appointmentsLoading, doctorsLoading]);

    // Track location loading state for "all" tab
    useEffect(() => {
        if (activeTab === 'all' && !userLocation) {
            // Check if we have cached location
            const cachedLocation = localStorage.getItem('kloqo_user_location');
            const cachedLocationTimestamp = localStorage.getItem('kloqo_user_location_timestamp');

            if (cachedLocation && cachedLocationTimestamp) {
                try {
                    const cachedTime = parseInt(cachedLocationTimestamp, 10);
                    const now = Date.now();
                    const CACHE_DURATION = 30 * 60 * 1000; // 30 minutes

                    if (now - cachedTime < CACHE_DURATION) {
                        setIsLocationLoading(false); // Has valid cache
                    } else {
                        setIsLocationLoading(true); // Cache expired, waiting for location
                    }
                } catch {
                    setIsLocationLoading(true);
                }
            } else {
                setIsLocationLoading(true); // No cache, waiting for location
            }
        } else {
            setIsLocationLoading(false);
        }
    }, [activeTab, userLocation]);

    // State for all doctors (for search functionality)
    // Use userDoctors from useDoctors hook instead of fetching all doctors
    // This is already filtered by clinicIds and more efficient
    const allDoctorsForSearch = useMemo(() => effectiveUserDoctors, [effectiveUserDoctors]);


    const [allClinicAppointments, setAllClinicAppointments] = useState<Appointment[]>([]);


    const isAnyDoctorAvailableToday = useMemo(() => {
        const now = getClinicNow();
        const todayStr = getClinicDayOfWeek(now);
        return effectiveUserDoctors.some(doctor =>
            doctor.availabilitySlots?.some(slot => slot.day === todayStr)
        );
    }, [effectiveUserDoctors]);

    useEffect(() => {
        if (!firestore || !clinicIds || clinicIds.length === 0) return;
        const now = getClinicNow();
        const todayStr = getClinicDateString(now);
        // Try to use optimized query with orderBy and limit
        // If it fails (no index or missing field), fall back to simple query
        let appointmentsQuery = query(
            collection(firestore, 'appointments'),
            where("clinicId", "in", clinicIds),
            where("date", "==", todayStr),
            orderBy("slotIndex", "asc"),
            limit(500)
        );

        // Use onSnapshot for real-time updates but with limits
        const unsubscribe = onSnapshot(appointmentsQuery,
            (snapshot: QuerySnapshot<DocumentData>) => {
                const appointmentsData: Appointment[] = snapshot.docs.map(doc => ({
                    id: doc.id,
                    ...doc.data()
                } as Appointment));
                setAllClinicAppointments(appointmentsData);
            },
            (error: any) => {
                console.error("Error with optimized appointments query: ", error);
                // If orderBy fails (missing index or field), the query will fail
                // Create Firestore indexes as documented in PERFORMANCE_OPTIMIZATIONS.md
                // For now, set empty array - user will see no appointments until index is created
                setAllClinicAppointments([]);
            }
        );

        return () => unsubscribe();
    }, [firestore, clinicIds]);


    // Function to refresh location manually (called by refresh button)
    const refreshLocation = useCallback(async () => {
        setIsRefreshingLocation(true);
        setLocation(t.consultToday.detectingLocation);

        if (!navigator.geolocation) {
            setLocation(t.consultToday.geolocationNotSupported);
            setIsRefreshingLocation(false);
            return;
        }

        try {
            navigator.geolocation.getCurrentPosition(
                async (position) => {
                    const lat = position.coords.latitude;
                    const lng = position.coords.longitude;
                    setUserLocation({ lat, lng });

                    // Cache location coordinates
                    try {
                        localStorage.setItem('kloqo_user_location', JSON.stringify({ lat, lng }));
                        localStorage.setItem('kloqo_user_location_timestamp', Date.now().toString());
                    } catch (error) {
                        console.warn("Failed to cache location:", error);
                    }

                    // Fetch location name
                    try {
                        const locationName = await getLocationName(lat, lng);
                        setLocation(locationName || t.consultToday.currentLocation);

                        // Cache location name
                        try {
                            localStorage.setItem('kloqo_user_location_name', locationName);
                        } catch (error) {
                            console.warn("Failed to cache location name:", error);
                        }
                    } catch (error) {
                        console.error("Error fetching location name:", error);
                        setLocation(t.consultToday.currentLocation);
                    }
                    setIsRefreshingLocation(false);
                },
                (error) => {
                    logGeolocationError(error);
                    setLocation(t.consultToday.locationNotAvailable);
                    setIsRefreshingLocation(false);
                },
                {
                    enableHighAccuracy: true,
                    timeout: 15000,
                    maximumAge: 0 // Force fresh location
                }
            );
        } catch (error) {
            console.error("Error refreshing location:", error);
            setLocation(t.consultToday.locationNotAvailable);
            setIsRefreshingLocation(false);
        }
    }, [t]);

    useEffect(() => {
        // Set initial location immediately (non-blocking)
        setLocation(t.consultToday.detectingLocation);

        // Check if geolocation is available
        if (!navigator.geolocation) {
            setLocation(t.consultToday.geolocationNotSupported);
            return;
        }

        // Check for cached location first (instant display)
        const cachedLocation = localStorage.getItem('kloqo_user_location');
        const cachedLocationName = localStorage.getItem('kloqo_user_location_name');
        const cachedLocationTimestamp = localStorage.getItem('kloqo_user_location_timestamp');
        let hasValidCache = false;

        // Use cached location if less than 30 minutes old
        if (cachedLocation && cachedLocationTimestamp) {
            try {
                const cachedTime = parseInt(cachedLocationTimestamp, 10);
                const now = Date.now();
                const CACHE_DURATION = 30 * 60 * 1000; // 30 minutes

                if (now - cachedTime < CACHE_DURATION) {
                    const { lat, lng } = JSON.parse(cachedLocation);
                    setUserLocation({ lat, lng });
                    setIsLocationLoading(false); // Clear loading state since we have cached location

                    // Set cached location name if available
                    if (cachedLocationName) {
                        setLocation(cachedLocationName);
                    }

                    hasValidCache = true;

                    // Refresh location in background (non-blocking, silent)
                    // Use a longer delay to not interfere with initial render
                    setTimeout(() => {
                        requestLocationSilently(); // Silent refresh (won't prompt if already granted)
                    }, 5000); // 5 seconds delay
                }
            } catch (error) {
                console.error("Error reading cached location:", error);
            }
        }

        // Request location on first visit (if no cache) or when switching to "all" tab
        const checkAndRequestLocation = async () => {
            // If we have valid cache, only request if user switches to "all" tab
            if (hasValidCache && activeTab !== 'all') {
                return; // Skip if cached and on "nearby" tab
            }

            try {
                // Use Permissions API if available to check status
                if (navigator.permissions) {
                    const permission = await navigator.permissions.query({ name: 'geolocation' });

                    // If already denied, don't request
                    if (permission.state === 'denied') {
                        setLocation(t.consultToday.locationNotAvailable);
                        setIsLocationLoading(false); // Clear loading state if permission denied
                        return;
                    }

                    // If granted or prompt, request location
                    if (permission.state === 'granted' || permission.state === 'prompt') {
                        navigator.geolocation.getCurrentPosition(
                            async (position) => {
                                const lat = position.coords.latitude;
                                const lng = position.coords.longitude;
                                setUserLocation({ lat, lng });
                                setIsLocationLoading(false); // Clear loading state when location is fetched

                                // Cache location coordinates
                                try {
                                    localStorage.setItem('kloqo_user_location', JSON.stringify({ lat, lng }));
                                    localStorage.setItem('kloqo_user_location_timestamp', Date.now().toString());
                                } catch (error) {
                                    console.warn("Failed to cache location:", error);
                                }

                                // Fetch location name (deferred to not block UI)
                                setTimeout(async () => {
                                    try {
                                        const locationName = await getLocationName(lat, lng);
                                        setLocation(locationName || t.consultToday.currentLocation);

                                        // Cache location name
                                        try {
                                            localStorage.setItem('kloqo_user_location_name', locationName);
                                        } catch (error) {
                                            console.warn("Failed to cache location name:", error);
                                        }
                                    } catch (error) {
                                        console.error("Error fetching location name:", error);
                                        // Keep current location text
                                    }
                                }, 0);
                            },
                            (error) => {
                                logGeolocationError(error);
                                setLocation(t.consultToday.locationNotAvailable);
                                setIsLocationLoading(false); // Clear loading state on error
                            },
                            {
                                enableHighAccuracy: false,
                                timeout: 10000,
                                maximumAge: 300000 // 5 minutes
                            }
                        );
                    }
                } else {
                    // Permissions API not available, try direct request (browser will prompt)
                    navigator.geolocation.getCurrentPosition(
                        async (position) => {
                            const lat = position.coords.latitude;
                            const lng = position.coords.longitude;
                            setUserLocation({ lat, lng });
                            setIsLocationLoading(false); // Clear loading state when location is fetched

                            // Cache location coordinates
                            try {
                                localStorage.setItem('kloqo_user_location', JSON.stringify({ lat, lng }));
                                localStorage.setItem('kloqo_user_location_timestamp', Date.now().toString());
                            } catch (error) {
                                console.warn("Failed to cache location:", error);
                            }

                            // Fetch location name (deferred to not block UI)
                            setTimeout(async () => {
                                try {
                                    const locationName = await getLocationName(lat, lng);
                                    setLocation(locationName || t.consultToday.currentLocation);

                                    // Cache location name
                                    try {
                                        localStorage.setItem('kloqo_user_location_name', locationName);
                                    } catch (error) {
                                        console.warn("Failed to cache location name:", error);
                                    }
                                } catch (error) {
                                    console.error("Error fetching location name:", error);
                                    // Keep current location text
                                }
                            }, 0);
                        },
                        (error) => {
                            logGeolocationError(error);
                            setLocation(t.consultToday.locationNotAvailable);
                        },
                        {
                            enableHighAccuracy: false,
                            timeout: 10000,
                            maximumAge: 300000 // 5 minutes
                        }
                    );
                }
            } catch (error) {
                console.error("Error checking location permission:", error);
                setLocation(t.consultToday.locationNotAvailable);
            }
        };

        // Separate function for silent background refresh (when permission already granted)
        const requestLocationSilently = async () => {
            try {
                if (navigator.permissions) {
                    const permission = await navigator.permissions.query({ name: 'geolocation' });
                    if (permission.state === 'granted') {
                        // Permission already granted - silently refresh location
                        navigator.geolocation.getCurrentPosition(
                            async (position) => {
                                const lat = position.coords.latitude;
                                const lng = position.coords.longitude;
                                setUserLocation({ lat, lng });

                                try {
                                    localStorage.setItem('kloqo_user_location', JSON.stringify({ lat, lng }));
                                    localStorage.setItem('kloqo_user_location_timestamp', Date.now().toString());

                                    const locationName = await getLocationName(lat, lng);
                                    if (locationName) {
                                        setLocation(locationName);
                                        localStorage.setItem('kloqo_user_location_name', locationName);
                                    }
                                } catch (error) {
                                    console.warn("Failed to cache location:", error);
                                }
                            },
                            () => {
                                // Silent fail - don't log errors for background refresh
                            },
                            {
                                enableHighAccuracy: false,
                                timeout: 10000,
                                maximumAge: 300000
                            }
                        );
                    }
                }
            } catch (error) {
                // Silent fail for background refresh
            }
        };

        // Request location:
        // - Immediately if no cache (first visit) - with small delay
        // - When switching to "all" tab if cached
        if (hasValidCache) {
            // Has cache: only request when switching to "all" tab
            if (activeTab === 'all') {
                checkAndRequestLocation();
            }
        } else {
            // First visit: small delay to avoid blocking initial render
            setTimeout(() => {
                checkAndRequestLocation();
            }, 300); // 300ms delay - better UX than immediate
        }
    }, [t, activeTab]);

    // Fetch clinics - only user's clinics (optimized)
    // Use debounced search query to reduce main-thread work
    useEffect(() => {
        if (debouncedSearchQuery) {
            const queryLower = debouncedSearchQuery.toLowerCase();

            // Filter doctors from ALL doctors (not just user's clinics)
            const filteredDoctors = allDoctorsForSearch
                .filter(doctor => {
                    const localizedDept = getLocalizedDepartmentName(doctor.department, language, departments);
                    return doctor.name.toLowerCase().includes(queryLower) ||
                        doctor.specialty?.toLowerCase().includes(queryLower) ||
                        doctor.department?.toLowerCase().includes(queryLower) ||
                        localizedDept.toLowerCase().includes(queryLower)
                })
                .map(doctor => ({ type: 'doctor' as const, ...doctor }));

            // Filter clinics
            const filteredClinics = clinics
                .filter(clinic =>
                    clinic.name?.toLowerCase().includes(queryLower) ||
                    clinic.address?.toLowerCase().includes(queryLower) ||
                    clinic.type?.toLowerCase().includes(queryLower)
                )
                .map(clinic => ({
                    type: 'clinic' as const,
                    id: clinic.id,
                    name: clinic.name,
                    location: clinic.address,
                    avatar: clinic.logoUrl || clinic.logo
                }));

            // Combine results
            const combined = [...filteredClinics, ...filteredDoctors];
            setSearchResults(prev => {
                if (prev.length === combined.length && prev.every((item, idx) => item.id === combined[idx].id && item.type === combined[idx].type)) {
                    return prev;
                }
                return combined;
            });
        } else {
            setSearchResults(prev => (prev.length === 0 ? prev : []));
        }
    }, [debouncedSearchQuery, allDoctorsForSearch, clinics, language, departments]);

    const handleScanQR = (mode: 'consult' | 'confirm') => {
        setScanMode(mode);
        setShowQRScanner(true);
    };

    const handleScanClose = useCallback(() => {
        setShowQRScanner(false);
        setScanMode(null);
        // Reset processing flag when manually closed
        isProcessingScanRef.current = false;
    }, []);

    const handleScanResult = useCallback(
        async (decodedText: string) => {
            // Prevent multiple simultaneous scans
            if (isProcessingScanRef.current) {
                console.log('🔍 Scan already in progress, ignoring duplicate scan');
                return;
            }

            // Mark as processing immediately
            isProcessingScanRef.current = true;

            // Close scanner immediately to prevent more scans
            setShowQRScanner(false);

            console.log('🔍 QR Scan Result - Raw decoded text:', decodedText);

            try {
                let clinicId: string | null = null;
                let textToParse = (decodedText || '').trim();
                console.log('🔍 QR Scan Result - Trimmed text:', textToParse);

                // Helper function to extract clinic ID from a URL string
                const extractClinicIdFromText = (text: string): string | null => {
                    try {
                        let url: URL;
                        if (text.startsWith('http://') || text.startsWith('https://')) {
                            url = new URL(text);
                        } else if (text.includes('?')) {
                            url = new URL(text, window.location.origin);
                        } else {
                            return null;
                        }

                        // Try to get clinic ID from query parameters
                        let id = url.searchParams.get('clinic') || url.searchParams.get('clinicId');

                        if (id) {
                            try {
                                return decodeURIComponent(id).trim();
                            } catch {
                                return id.trim();
                            }
                        }

                        // Try regex fallback on the URL string
                        const match = text.match(/(?:[?&]clinicId=)([^&?#\s]+)/i) ||
                            text.match(/(?:[?&]clinic=)([^&?#\s]+)/i);
                        if (match && match[1]) {
                            try {
                                return decodeURIComponent(match[1]).trim();
                            } catch {
                                return match[1].trim();
                            }
                        }
                    } catch (e) {
                        console.log('🔍 URL parsing error in extractClinicIdFromText:', e);
                    }
                    return null;
                };

                // First, try to extract from the scanned text directly
                clinicId = extractClinicIdFromText(textToParse);
                console.log('🔍 Initial extraction result:', clinicId);

                // If not found and it's a URL, resolve via API (for short URLs)
                if (!clinicId && (textToParse.startsWith('http://') || textToParse.startsWith('https://'))) {
                    console.log('🔍 No clinic ID found in short URL, resolving via API:', textToParse);
                    try {
                        // Use server-side API to follow redirects
                        const apiUrl = `/api/resolve-url?url=${encodeURIComponent(textToParse)}`;
                        console.log('🔍 Calling API:', apiUrl);
                        const apiResponse = await fetch(apiUrl);
                        console.log('🔍 API response status:', apiResponse.status);

                        if (apiResponse.ok) {
                            const data = await apiResponse.json();
                            console.log('🔍 API response data:', data);

                            if (data.finalUrl && data.finalUrl !== textToParse) {
                                console.log('🔍 Resolved final URL:', data.finalUrl);

                                // Decode the URL first (in case it's URL-encoded)
                                let decodedFinalUrl = data.finalUrl;
                                try {
                                    // Try decoding the entire URL
                                    decodedFinalUrl = decodeURIComponent(data.finalUrl);
                                    console.log('🔍 Decoded final URL:', decodedFinalUrl);
                                } catch (e) {
                                    // If full decode fails, try partial decode
                                    try {
                                        decodedFinalUrl = data.finalUrl.replace(
                                            /%([0-9A-F]{2})/gi,
                                            (match: string, hex: string) => {
                                                return String.fromCharCode(parseInt(hex, 16));
                                            }
                                        );
                                        console.log('🔍 Partially decoded final URL:', decodedFinalUrl);
                                    } catch (e2) {
                                        console.log('🔍 URL decode failed, using original');
                                    }
                                }

                                // Extract clinic ID from resolved final URL (try both encoded and decoded)
                                clinicId = extractClinicIdFromText(decodedFinalUrl) || extractClinicIdFromText(data.finalUrl);
                                console.log('🔍 Extracted from API-resolved URL:', clinicId);

                                // If still not found, try regex on both encoded and decoded URLs
                                if (!clinicId) {
                                    // Try decoded URL first
                                    let match = decodedFinalUrl.match(/(?:[?&]clinicId=)([^&?#\s]+)/i) ||
                                        decodedFinalUrl.match(/(?:[?&]clinic=)([^&?#\s]+)/i);

                                    // If not found, try original encoded URL
                                    if (!match) {
                                        match = data.finalUrl.match(/(?:[?&]clinicId=)([^&?#\s]+)/i) ||
                                            data.finalUrl.match(/(?:[?&]clinic=)([^&?#\s]+)/i);
                                    }

                                    if (match && match[1]) {
                                        try {
                                            clinicId = decodeURIComponent(match[1]).trim();
                                        } catch {
                                            clinicId = match[1].trim();
                                        }
                                        console.log('🔍 Extracted from regex on final URL:', clinicId);
                                    }
                                }

                                // If still a short URL and no clinic ID found, the API might not have followed all redirects
                                const isStillShortUrl = /(me-qr\.com|scan\.page|bit\.ly|tinyurl|t\.co|goo\.gl|short\.link|ow\.ly|is\.gd)/i.test(data.finalUrl);
                                if (isStillShortUrl && !clinicId) {
                                    console.log('🔍 Still a short URL with no clinic ID - API may need to follow more redirects');
                                }
                            } else if (data.error) {
                                console.error('🔍 API returned error:', data.error, data.message);
                            } else {
                                console.log('🔍 No redirect found or same URL returned:', data);
                            }
                        } else {
                            const errorData = await apiResponse.json().catch(() => ({ error: 'Unknown error' }));
                            console.error('🔍 API response not OK:', apiResponse.status, errorData);
                        }
                    } catch (apiError: any) {
                        console.error('🔍 API redirect resolution failed:', apiError);
                        console.error('🔍 Error details:', apiError.message, apiError.stack);
                    }
                }

                // Final fallback: try regex on original text
                if (!clinicId) {
                    const match = textToParse.match(/(?:[?&]clinicId=)([^&?#\s]+)/i) ||
                        textToParse.match(/(?:[?&]clinic=)([^&?#\s]+)/i) ||
                        textToParse.match(/clinicId[=:]([^&?#\s]+)/i) ||
                        textToParse.match(/clinic[=:]([^&?#\s]+)/i);
                    if (match && match[1]) {
                        try {
                            clinicId = decodeURIComponent(match[1]).trim();
                        } catch {
                            clinicId = match[1].trim();
                        }
                        console.log('🔍 Extracted from regex fallback:', clinicId);
                    }
                }

                // Last resort: use entire text as clinic ID if it looks valid
                if (!clinicId && /^[a-zA-Z0-9_-]+$/.test(textToParse)) {
                    clinicId = textToParse;
                    console.log('🔍 Using entire text as clinicId:', clinicId);
                }

                // Validate clinic ID
                console.log('🔍 Final clinicId value:', clinicId);
                if (!clinicId || clinicId.trim().length === 0) {
                    console.error('❌ QR Code parsing failed. Decoded text:', textToParse);
                    console.error('❌ All extraction methods failed. Check console logs above for details.');

                    // Provide more helpful error message for short URLs
                    const isShortUrl = textToParse.startsWith('http://') || textToParse.startsWith('https://');
                    const errorMessage = isShortUrl
                        ? 'Failed to resolve QR code URL. Please check your internet connection and try again.'
                        : 'Could not find clinic ID in QR code. Please scan a valid QR code.';

                    toast({
                        variant: 'destructive',
                        title: language === 'ml' ? 'QR കോഡ് പിശക്' : 'Invalid QR Code',
                        description: language === 'ml'
                            ? (isShortUrl
                                ? 'QR കോഡ് URL പരിഹരിക്കാൻ കഴിഞ്ഞില്ല. ഇന്റർനെറ്റ് കണക്ഷൻ പരിശോധിച്ച് വീണ്ടും ശ്രമിക്കുക.'
                                : 'QR കോഡിൽ ക്ലിനിക് ID കണ്ടെത്താൻ കഴിഞ്ഞില്ല. ശരിയായ QR കോഡ് സ്കാൻ ചെയ്യുക.')
                            : errorMessage,
                    });
                    return;
                }

                console.log('✅ Successfully extracted clinicId:', clinicId);

                // Navigate based on mode
                const modeToUse = scanMode || 'consult';
                if (modeToUse === 'consult') {
                    router.push(`/consult-today?clinicId=${clinicId}`);
                    toast({
                        title: language === 'ml' ? 'സ്കാൻ ചെയ്തു' : 'Scanned',
                        description: language === 'ml'
                            ? 'ഡോക്ടറെ തിരഞ്ഞെടുക്കുന്നു...'
                            : 'Loading doctors...',
                    });
                } else {
                    router.push(`/confirm-arrival?clinic=${clinicId}`);
                    toast({
                        title: language === 'ml' ? 'സ്കാൻ ചെയ്തു' : 'Scanned',
                        description: language === 'ml'
                            ? 'ഹാജരാവൽ സ്ഥിരീകരിക്കുന്നു...'
                            : 'Confirming arrival...',
                    });
                }

                setScanMode(null);
            } catch (error) {
                console.error('Error parsing QR code:', error);
                toast({
                    variant: 'destructive',
                    title: language === 'ml' ? 'QR കോഡ് പിശക്' : 'QR Code Error',
                    description: language === 'ml'
                        ? 'QR കോഡ് പാഴ്‌സ് ചെയ്യാൻ കഴിഞ്ഞില്ല. ദയവായി വീണ്ടും ശ്രമിക്കുക.'
                        : 'Failed to parse QR code. Please try again.',
                });
            } finally {
                // Reset processing flag after a delay to allow re-scanning if needed
                setTimeout(() => {
                    isProcessingScanRef.current = false;
                }, 1000);
            }
        },
        [router, scanMode, toast, language]
    );

    const isAppointmentForToday = (dateStr: string) => {
        try {
            return isToday(parse(dateStr, "d MMMM yyyy", new Date()));
        } catch {
            try {
                return isToday(new Date(dateStr));
            } catch {
                return false;
            }
        }
    };

    const walkInAppointment = useMemo(() => {
        const activeWalkins = effectiveAppointments.filter(
            a => a.tokenNumber?.startsWith('W') &&
                isAppointmentForToday(a.date) &&
                a.status !== 'Cancelled' &&
                a.status !== 'Completed' &&
                a.cancelledByBreak === undefined
        );
        activeWalkins.sort(compareAppointments);
        return activeWalkins[0] || null;
    }, [effectiveAppointments]);

    const upcomingAppointments = useMemo(() => {
        const filtered = effectiveAppointments.filter(a => {
            // Hide break-affected appointments
            if (a.cancelledByBreak !== undefined) return false;

            // Hide completed and cancelled appointments
            if (a.status === 'Cancelled' || a.status === 'Completed') return false;

            // Exclude today's walk-in appointments (handled by WalkInCard)
            if (a.tokenNumber?.startsWith('W')) {
                try {
                    const date = parse(a.date, "d MMMM yyyy", new Date());
                    if (isToday(date)) {
                        return false;
                    }
                } catch {
                    const date = new Date(a.date);
                    if (isToday(date)) {
                        return false;
                    }
                }
            }

            // Include future appointments and today's non-walk-in appointments
            let date;
            try {
                date = parse(a.date, "d MMMM yyyy", new Date());
            } catch {
                date = new Date(a.date);
            }

            // Show if not past (includes today and future)
            return !isPast(date) || isToday(date);
        }).sort(compareAppointments);

        // Debug logging (remove after debugging)
        if (process.env.NODE_ENV === 'development') {
            console.log('[HomePage] Upcoming Appointments Debug:', {
                totalAppointments: effectiveAppointments.length,
                upcomingCount: filtered.length,
                upcomingAppointments: filtered.map(a => ({ id: a.id, date: a.date, status: a.status, tokenNumber: a.tokenNumber }))
            });
        }

        return filtered;
    }, [effectiveAppointments]);

    // navItems removed - BottomNav handles its own icons via lazy loading

    // Debounce search to reduce main-thread work (performance optimization)
    const searchDebounceRef = useRef<NodeJS.Timeout | null>(null);

    const handleSearchChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        // Update UI immediately for better UX
        setSearchQuery(value);

        // Debounce the actual search logic
        if (searchDebounceRef.current) {
            clearTimeout(searchDebounceRef.current);
        }
        searchDebounceRef.current = setTimeout(() => {
            setDebouncedSearchQuery(value);
        }, 300); // 300ms debounce
    }, []);

    // Cleanup debounce on unmount
    useEffect(() => {
        return () => {
            if (searchDebounceRef.current) {
                clearTimeout(searchDebounceRef.current);
            }
        };
    }, []);


    const consultTodayClinicId = user?.clinicIds && user.clinicIds.length > 0 ? user.clinicIds[0] : 'yTAaRDn6rtLFza1IP8CV';

    // Fetch doctors from clinics within 50km radius for "All Doctors" tab
    // Deferred to avoid blocking initial render (performance optimization)
    // Get doctors based on active tab
    const displayDoctors = useMemo(() => {
        if (activeTab === 'all') {
            // Show doctors from nearby clinics (within 50km)
            return allDoctors;
        } else {
            // Show doctors from user's clinicIds array (current logic)
            return effectiveUserDoctors;
        }
    }, [activeTab, allDoctors, effectiveUserDoctors]);

    // Comprehensive loading state that considers initial load and tab-specific loading
    const isLoadingDoctors = useMemo(() => {
        if (isInitialLoad && effectiveUserDoctors.length === 0 && cachedDoctors === null) {
            return true; // Show skeleton during initial load if no cached data
        }

        if (activeTab === 'all') {
            return loadingAllDoctors;
        } else {
            return doctorsLoading && effectiveUserDoctors.length === 0 && cachedDoctors === null;
        }
    }, [isInitialLoad, activeTab, loadingAllDoctors, doctorsLoading, effectiveUserDoctors, cachedDoctors]);

    const handleSplashComplete = useCallback(() => {
        setSplashAnimationDone(true);
    }, []);

    // Only show splash once per browser tab session.
    // After it's fully shown once (animation + data ready), we mark it in sessionStorage.
    useEffect(() => {
        if (!hasShownSplashInSession && splashAnimationDone && dataReady && typeof window !== 'undefined') {
            window.sessionStorage.setItem('homeSplashShown', '1');
            setHasShownSplashInSession(true);
        }
    }, [hasShownSplashInSession, splashAnimationDone, dataReady]);

    if (!hasShownSplashInSession && (!splashAnimationDone || !dataReady)) {
        return <SplashScreen onComplete={handleSplashComplete} />;
    }

    return (
        <div className="flex min-h-screen w-full flex-col font-body">
            <div className="flex-grow bg-card">
                {/* Header Section */}
                <div className="bg-primary text-primary-foreground p-6 rounded-b-[2rem] pb-24">
                    <div className="flex justify-between items-center mb-4">
                        <div>
                            <h1 className="text-2xl font-bold">{t.home.hello}, {user?.name || user?.displayName || t.home.user}</h1>
                            <div
                                className="flex items-center gap-2 text-sm min-h-[20px] cursor-pointer hover:opacity-80 transition-opacity select-none"
                                onClick={!isRefreshingLocation ? refreshLocation : undefined}
                                role="button"
                                aria-label={language === 'ml' ? 'സ്ഥലം പുതുക്കുക' : 'Refresh location'}
                            >
                                <MapPin className={`w-4 h-4 flex-shrink-0 ${isRefreshingLocation ? 'animate-bounce' : ''}`} />
                                <span className="min-w-0 flex-1">{location}</span>
                            </div>
                        </div>
                        <div className="text-primary-foreground">
                            <NotificationHistory />
                        </div>
                    </div>
                    <div className="relative mt-4">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
                        <Input
                            placeholder={t.home.searchPlaceholder}
                            className="pl-10 h-12 bg-primary-foreground/20 placeholder:text-primary-foreground/70 border-0 focus-visible:ring-primary-foreground"
                            value={searchQuery}
                            onChange={handleSearchChange}
                        />
                        {searchQuery && (
                            <Button
                                aria-label={language === 'ml' ? 'തിരയൽ മായ്ക്കുക' : 'Clear search'}
                                variant="ghost"
                                size="icon"
                                className="absolute right-2 top-1/2 -translate-y-1/2 h-7 w-7 text-muted-foreground"
                                onClick={() => setSearchQuery('')}
                            >
                                <X className="h-4 w-4" />
                            </Button>
                        )}
                        {searchResults.length > 0 && (
                            <Card className="absolute top-full mt-2 w-full z-10 max-h-60 overflow-y-auto">
                                <CardContent className="p-0">
                                    {searchResults.map(result => (
                                        <div
                                            key={result.type === 'doctor' ? `doctor-${result.id}` : `clinic-${result.id}`}
                                            className="flex items-center gap-4 p-3 border-b last:border-b-0 cursor-pointer hover:bg-muted"
                                            onClick={() => {
                                                if (result.type === 'doctor') {
                                                    router.push(`/book-appointment?doctorId=${result.id}`);
                                                } else if (result.type === 'clinic') {
                                                    router.push(`/clinics/${result.id}`);
                                                }
                                                setSearchQuery('');
                                                setSearchResults([]);
                                            }}
                                        >
                                            <Avatar className="h-10 w-10">
                                                {result.avatar && <AvatarImage src={result.avatar} alt={result.name} />}
                                                <AvatarFallback>{result.name.split(' ').map(n => n[0]).join('')}</AvatarFallback>
                                            </Avatar>
                                            <div className="flex-grow">
                                                <p className="font-semibold text-card-foreground">{result.name}</p>
                                                <p className="text-sm text-muted-foreground">
                                                    {result.type === 'doctor' ? (result as Doctor).specialty : result.location}
                                                </p>
                                            </div>
                                            {result.type === 'clinic' && <Building2 className="h-5 w-5 text-muted-foreground ml-auto" />}
                                        </div>
                                    ))}
                                </CardContent>
                            </Card>
                        )}
                    </div>

                    {/* Always render appointments section to prevent layout shift */}
                    <div className="mt-6 space-y-4">
                        {/* Reserve space to prevent CLS when walk-in appointment loads */}
                        {showAppointmentsSkeleton || walkInAppointment ? (
                            <div className="min-h-[180px]">
                                {showAppointmentsSkeleton ? (
                                    <Skeleton className="h-40 w-full bg-primary/20" />
                                ) : walkInAppointment ? (
                                    <WalkInCard
                                        appointment={walkInAppointment}
                                        allClinicAppointments={allClinicAppointments}
                                        userDoctors={effectiveUserDoctors}
                                        t={t}
                                        departments={departments}
                                        language={language}
                                    />
                                ) : null}
                            </div>
                        ) : null}

                        {upcomingAppointments.length > 0 ? (
                            <div>
                                <h2 className="text-lg font-semibold text-primary-foreground/90 mb-4 mt-6">{t.home.upcomingAppointments}</h2>
                                <AppointmentCarousel appointments={upcomingAppointments} departments={departments} language={language} doctors={Array.isArray(effectiveUserDoctors) ? effectiveUserDoctors : []} t={t} />
                            </div>
                        ) : !showAppointmentsSkeleton && !appointmentsLoading && effectiveAppointments.length === 0 ? (
                            // Show subtle empty state when no appointments (prevents empty screen)
                            <div className="min-h-[60px] opacity-0" aria-hidden="true">
                                {/* Invisible placeholder to maintain layout consistency */}
                            </div>
                        ) : null}
                    </div>
                </div>

                {/* Main Content */}
                <main className="p-6 space-y-8 bg-background rounded-t-[2rem] -mt-16 pt-8 pb-24">
                    {/* Clinics/Doctors Section with Tabs */}
                    <section>
                        <div className="flex justify-between items-center mb-4">
                            <h2 className="text-xl font-bold">{t.home.availableDoctors}</h2>
                        </div>
                        <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as 'all' | 'nearby')} className="w-full">
                            <TabsList className="grid w-full grid-cols-2 mb-4">
                                <TabsTrigger value="all">{t.home.all}</TabsTrigger>
                                <TabsTrigger value="nearby">{t.home.nearby}</TabsTrigger>
                            </TabsList>
                            <TabsContent value="all" className="space-y-4">
                                {isLoadingDoctors || isLocationLoading ? (
                                    <>
                                        <DoctorSkeleton />
                                        <DoctorSkeleton />
                                    </>
                                ) : displayDoctors.length > 0 ? (
                                    displayDoctors.map((doctor) => <DoctorCard key={doctor.id} doctor={doctor} departments={departments} language={language} />)
                                ) : (
                                    <div className="text-center text-muted-foreground py-8">
                                        {!userLocation ? (
                                            <p>Please enable location access to find nearby doctors.</p>
                                        ) : (
                                            <p>No doctors found within 50km of your location.</p>
                                        )}
                                    </div>
                                )}
                            </TabsContent>
                            <TabsContent value="nearby" className="space-y-4">
                                {isLoadingDoctors ? (
                                    <>
                                        <DoctorSkeleton />
                                        <DoctorSkeleton />
                                    </>
                                ) : (
                                    clinicIds && clinicIds.length > 0 ? (
                                        displayDoctors.length > 0 ? (
                                            displayDoctors.map((doctor) => <DoctorCard key={doctor.id} doctor={doctor} departments={departments} language={language} />)
                                        ) : (
                                            <div className="text-center text-muted-foreground">
                                                <p>No doctors found in your clinics.</p>
                                            </div>
                                        )
                                    ) : (
                                        <div className="text-center text-muted-foreground py-8">
                                            <p className="text-lg font-semibold">{t.home.noAppointmentsYet}</p>
                                            <p className="text-sm mt-2">{t.home.bookFirstAppointment}</p>
                                        </div>
                                    )
                                )}
                            </TabsContent>
                        </Tabs>
                    </section>

                    <div className="grid grid-cols-2 gap-4">
                        <button
                            type="button"
                            onClick={() => handleScanQR('consult')}
                            disabled={showQRScanner}
                            className="rounded-2xl border border-[#60896c]/30 bg-[#60896c]/10 p-4 text-center text-[#60896c] shadow-sm transition hover:shadow-md disabled:opacity-60 flex flex-col items-center justify-center min-h-[220px] gap-3"
                        >
                            <Camera className="h-10 w-10" />
                            <div>
                                <h3 className="font-bold text-lg">{t.home.consultWithoutAppointment}</h3>
                                <p className="text-sm text-[#60896c]/80">{t.home.scanQRCode}</p>
                            </div>
                            {showQRScanner && (
                                <div className="mt-2 text-sm font-semibold flex flex-col items-center justify-center gap-2" aria-live="polite">
                                    <Skeleton className="h-6 w-6 rounded-full" />
                                    <span>{language === 'ml' ? 'സ്കാൻ ചെയ്യുന്നു...' : 'Scanning...'}</span>
                                </div>
                            )}
                        </button>

                        {clinicIds && clinicIds.length > 0 && (
                            <button
                                type="button"
                                onClick={() => handleScanQR('confirm')}
                                disabled={showQRScanner}
                                className="rounded-2xl border border-blue-200 bg-blue-50 p-4 text-center text-blue-900 shadow-sm transition hover:shadow-md disabled:opacity-60 flex flex-col items-center justify-center min-h-[220px] gap-3"
                            >
                                <CheckCircle2 className="h-10 w-10 text-blue-600" />
                                <div className="text-center">
                                    <h3 className="font-bold text-lg">
                                        {language === 'ml' ? 'ഹാജരാവൽ സ്ഥിരീകരിക്കുക' : 'Confirm Arrival'}
                                    </h3>
                                    <p className="text-sm text-blue-700">
                                        {language === 'ml'
                                            ? 'ക്ലിനിക്കിലെത്തിയത് സ്ഥിരീകരിക്കുക'
                                            : 'Confirm your arrival at the clinic'}
                                    </p>
                                </div>
                            </button>
                        )}
                    </div>

                    <button
                        type="button"
                        onClick={() => router.push('/clinics')}
                        className="w-full rounded-3xl bg-white shadow-lg border border-primary/10 px-6 py-5 flex items-center gap-3 text-primary hover:shadow-xl transition"
                    >
                        <div className="rounded-2xl bg-primary/10 p-3">
                            <Building2 className="h-6 w-6" />
                        </div>
                        <div className="text-left">
                            <p className="text-lg font-bold">{t.home.viewAllClinics}</p>
                            <p className="text-sm text-muted-foreground">{t.home.exploreClinics}</p>
                        </div>
                    </button>

                    <QrScannerOverlay
                        open={showQRScanner}
                        mode={scanMode}
                        title={
                            scanMode === 'confirm'
                                ? language === 'ml'
                                    ? 'ഹാജരാവൽ സ്ഥിരീകരിക്കുക'
                                    : 'Confirm Arrival'
                                : t.consultToday.scanQRCode
                        }
                        description={
                            scanMode === 'confirm'
                                ? language === 'ml'
                                    ? 'ക്ലിനിക്കിൽ നൽകിയ QR കോഡ് സ്കാൻ ചെയ്ത് ഹാജരാവൂ.'
                                    : 'Scan the clinic QR to confirm your arrival.'
                                : t.consultToday.positionQRCode
                        }
                        onClose={handleScanClose}
                        onScan={handleScanResult}
                    />

                </main>
            </div>

            <BottomNav />
        </div>
    );
}

function HomePage() {
    return <HomePageContent />;
}

function HomePageWithAuth() {
    return (
        <AuthGuard>
            <HomePage />
        </AuthGuard>
    );
}

export default HomePageWithAuth;
