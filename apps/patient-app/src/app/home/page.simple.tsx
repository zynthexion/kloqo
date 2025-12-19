'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Bell, Calendar, Home, MapPin, Search, Radio, User, Heart, Ticket, Users, Clock, X } from 'lucide-react';
import { format, parse, isToday } from 'date-fns';
import { useState, useMemo, useEffect } from 'react';

import { cn, getArriveByTimeFromAppointment } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { PlaceHolderImages } from '@/lib/placeholder-images';
import { Carousel, CarouselContent, CarouselItem } from '@/components/ui/carousel';
import { useDoctors, type Doctor } from '@/firebase/firestore/use-doctors';
import { useAppointments, type Appointment } from '@/firebase/firestore/use-appointments';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { useUser } from '@/firebase/auth/use-user';
import { SplashScreen } from '@/components/splash-screen';
import { useLanguage } from '@/contexts/language-context';

const WalkInCard = ({ appointment }: { appointment: Appointment }) => {
    return (
        <Card className="bg-primary-foreground/10 border-primary-foreground/20 shadow-lg mt-6 text-primary-foreground">
            <CardContent className="p-4">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-4">
                        <div className="bg-primary-foreground/20 p-3 rounded-lg">
                            <Ticket className="h-8 w-8" />
                        </div>
                        <div>
                            <p className="font-bold text-lg">Your Walk-in Token</p>
                            <p className="text-3xl font-bold">{appointment.tokenNumber}</p>
                        </div>
                    </div>
                    <Button asChild variant="secondary" className="bg-primary-foreground text-primary hover:bg-primary-foreground/90">
                        <Link href="/live-token">View Live Queue</Link>
                    </Button>
                </div>
                <div className="mt-4 border-t border-primary-foreground/20 pt-4">
                    <p className="font-bold text-lg">{appointment.doctor}</p>
                    <p className="text-sm opacity-80">{appointment.department}</p>
                </div>
            </CardContent>
        </Card>
    )
}

const AppointmentCard = ({ appointment, t }: { appointment: Appointment, t: any }) => {

    let day, month, dayOfMonth;
    try {
        const dateObj = parse(appointment.date, "d MMMM yyyy", new Date());
        day = format(dateObj, 'EEE');
        month = format(dateObj, 'MMM');
        dayOfMonth = format(dateObj, 'dd');
    } catch (e) {
        // fallback for different date formats
        const parts = appointment.date.split(' ');
        month = parts[0];
        dayOfMonth = parts[1];
        day = new Date(appointment.date).toLocaleDateString('en-US', { weekday: 'short' });
    }

    return (
        <Card className="bg-primary-foreground/10 border-primary-foreground/20 shadow-none text-primary-foreground">
            <CardContent className="p-4 flex gap-4 items-center">
                <div className="text-center w-14 shrink-0 bg-primary-foreground/20 rounded-lg p-2">
                    <p className="text-sm font-medium">{month}</p>
                    <p className="text-2xl font-bold">{dayOfMonth}</p>
                    <p className="text-sm font-medium">{day}</p>
                </div>
                <div className="border-l border-primary-foreground/20 pl-4">
                    <p className="text-xs opacity-80">{t.home.arriveBy}: {getArriveByTimeFromAppointment(appointment)}</p>
                    <p className="font-bold text-md mt-1">{appointment.doctor}</p>
                    <p className="text-sm opacity-80">{appointment.department}</p>
                    <p className="text-sm opacity-80">{appointment.patientName}</p>
                </div>
            </CardContent>
        </Card>
    );
};

const AppointmentCarousel = ({ appointments, t }: { appointments: Appointment[], t: any }) => {
    if (appointments.length === 0) {
        return null;
    }

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
                        <AppointmentCard appointment={appt} t={t} />
                    </CarouselItem>
                ))}
            </CarouselContent>
        </Carousel>
    );
}


const DoctorCard = ({ doctor }: { doctor: Doctor }) => {
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
                        <p className="text-sm text-muted-foreground">{doctor.department}</p>
                        <p className="text-sm text-muted-foreground">{doctor.specialty}</p>
                        <Badge variant={doctor.availability === 'Available' ? "default" : "destructive"} className={cn("mt-2", doctor.availability === 'Available' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800')}>
                            {doctor.availability}
                        </Badge>
                    </div>
                </CardContent>
            </Link>
        </Card>
    );
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

function HomePageContent() {
    const pathname = usePathname();
    const router = useRouter();
    const searchParams = useSearchParams();
    const { t, language } = useLanguage();
    const [location, setLocation] = useState('Detecting location...');
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState<Doctor[]>([]);

    const clinicId = useMemo(() => {
        const id = searchParams.get('clinicId');
        return id ? [id.trim()] : null;
    }, [searchParams]);

    const { doctors, loading: doctorsLoading } = useDoctors(clinicId);
    const { user } = useUser();
    const { appointments, loading: appointmentsLoading } = useAppointments(user?.phoneNumber);

    const isAnyDoctorAvailableToday = useMemo(() => {
        const todayStr = format(new Date(), 'EEEE');
        return doctors.some(doctor =>
            doctor.availabilitySlots?.some(slot => slot.day === todayStr) ?? false
        );
    }, [doctors]);

    useEffect(() => {
        if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(
                (position) => {
                    // In a real app, you would use a reverse geocoding service to get the location name.
                    // For this demo, we'll just show a placeholder.
                    setLocation('Current Location');
                },
                (error) => {
                    console.error("Geolocation error:", error);
                    setLocation('Location not available');
                }
            );
        } else {
            setLocation('Geolocation not supported');
        }
    }, []);

    useEffect(() => {
        if (searchQuery) {
            const filteredDoctors = doctors.filter(doctor =>
                doctor.name.toLowerCase().includes(searchQuery.toLowerCase())
            );
            setSearchResults(filteredDoctors);
        } else {
            setSearchResults([]);
        }
    }, [searchQuery, doctors]);


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

    const walkInAppointment = useMemo(() => appointments.find(
        a => a.tokenNumber?.startsWith('W') &&
            isAppointmentForToday(a.date) &&
            a.status !== 'Cancelled' &&
            a.status !== 'Completed'
    ), [appointments]);

    const upcomingAppointments = useMemo(() => appointments.filter(a => {
        let date;
        try {
            date = parse(a.date, "d MMMM yyyy", new Date());
        } catch {
            date = new Date(a.date);
        }
        return (!isToday(date) || !a.tokenNumber?.startsWith('W')) &&
            date >= new Date() &&
            a.status !== 'Cancelled' &&
            a.status !== 'Completed';
    }).sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()), [appointments]);

    const navItems = [
        { href: '/home', icon: Home, label: 'Home' },
        { href: '/appointments', icon: Calendar, label: 'Appointments' },
        { href: '/live-token', icon: Radio, label: 'Status' },
        { href: '/profile', icon: User, label: 'Profile' },
    ];

    const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setSearchQuery(e.target.value);
    };

    const handleSuggestionClick = (doctorId: string) => {
        router.push(`/book-appointment?doctorId=${doctorId}`);
        setSearchQuery('');
        setSearchResults([]);
    };


    return (
        <div className="flex min-h-screen w-full flex-col font-body">
            <div className="flex-grow bg-card">
                {/* Header Section */}
                <div className="bg-primary text-primary-foreground p-6 rounded-b-[2rem] pb-24">
                    <div className="flex justify-between items-center mb-4">
                        <div>
                            <h1 className="text-2xl font-bold">Morning, {user?.displayName || 'there'}</h1>
                            <div className="flex items-center gap-1 text-sm">
                                <MapPin className="w-4 h-4" />
                                <span>{location}</span>
                            </div>
                        </div>
                        <div className="relative">
                            <Bell className="w-6 h-6" />
                            <Badge variant="destructive" className="absolute -top-2 -right-2 h-5 w-5 justify-center p-0">3</Badge>
                        </div>
                    </div>
                    <div className="relative mt-4">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
                        <Input
                            placeholder="Search Doctors, clinics, specialty..."
                            className="pl-10 h-12 bg-primary-foreground/20 placeholder:text-primary-foreground/70 border-0 focus-visible:ring-primary-foreground"
                            value={searchQuery}
                            onChange={handleSearchChange}
                        />
                        {searchQuery && (
                            <Button variant="ghost" size="icon" className="absolute right-2 top-1/2 -translate-y-1/2 h-7 w-7 text-muted-foreground" onClick={() => setSearchQuery('')}>
                                <X className="h-4 w-4" />
                            </Button>
                        )}
                        {searchResults.length > 0 && (
                            <Card className="absolute top-full mt-2 w-full z-10 max-h-60 overflow-y-auto">
                                <CardContent className="p-0">
                                    {searchResults.map(doctor => (
                                        <div
                                            key={doctor.id}
                                            className="flex items-center gap-4 p-3 border-b last:border-b-0 cursor-pointer hover:bg-muted"
                                            onClick={() => handleSuggestionClick(doctor.id)}
                                        >
                                            <Avatar className="h-10 w-10">
                                                {doctor.avatar && <AvatarImage src={doctor.avatar} alt={doctor.name} />}
                                                <AvatarFallback>{doctor.name.split(' ').map(n => n[0]).join('')}</AvatarFallback>
                                            </Avatar>
                                            <div>
                                                <p className="font-semibold text-card-foreground">{doctor.name}</p>
                                                <p className="text-sm text-muted-foreground">{doctor.specialty}</p>
                                            </div>
                                        </div>
                                    ))}
                                </CardContent>
                            </Card>
                        )}
                    </div>

                    {appointmentsLoading ? (
                        <Skeleton className="h-40 w-full bg-primary/20 mt-6" />
                    ) : walkInAppointment ? (
                        <WalkInCard appointment={walkInAppointment} />
                    ) : (
                        <>
                            {upcomingAppointments.length > 0 && (
                                <div className="mt-6">
                                    <h2 className="text-lg font-semibold text-primary-foreground/90 mb-4">Upcoming appointments</h2>
                                    <AppointmentCarousel appointments={upcomingAppointments} t={t} />
                                </div>
                            )}
                        </>
                    )}
                </div>

                {/* Main Content */}
                <main className="p-6 space-y-8 bg-background rounded-t-[2rem] -mt-16 pt-8">
                    {/* Clinics/Doctors Section */}
                    <section>
                        <div className="flex justify-between items-center mb-4">
                            <h2 className="text-xl font-bold">Available Doctors</h2>
                        </div>
                        <div className="space-y-4 pt-4">
                            {doctorsLoading ? (
                                <>
                                    <DoctorSkeleton />
                                    <DoctorSkeleton />
                                </>
                            ) : (
                                doctors.length > 0 ? (
                                    doctors.map((doctor) => <DoctorCard key={doctor.id} doctor={doctor} />)
                                ) : (
                                    <p className="text-center text-muted-foreground">No doctors found for this clinic.</p>
                                )
                            )}
                        </div>
                    </section>

                    <Card className="bg-accent/20 border-accent/50">
                        <CardContent className="p-4 flex flex-col sm:flex-row justify-between items-center gap-4">
                            <div>
                                <h3 className="font-bold text-lg text-accent-foreground">Consult for Today?</h3>
                                <p className="text-sm text-accent-foreground/80">Get a token for a walk-in appointment now.</p>
                            </div>
                            <Button asChild className="w-full sm:w-auto bg-accent text-accent-foreground hover:bg-accent/90" disabled={!isAnyDoctorAvailableToday}>
                                <Link href={`/consult-today?clinicId=${clinicId || 'yTAaRDn6rtLFza1IP8CV'}`}>{isAnyDoctorAvailableToday ? 'Get Token' : 'Unavailable Today'}</Link>
                            </Button>
                        </CardContent>
                    </Card>

                </main>
            </div>

            {/* Footer Navigation */}
            <footer className="sticky bottom-0 w-full bg-card border-t max-w-md mx-auto">
                <nav className="mx-auto flex items-center justify-around h-16">
                    {navItems.map((item) => (
                        <Link key={item.href} href={item.href} className={cn(
                            "flex flex-col items-center justify-center text-muted-foreground hover:text-primary transition-colors w-20",
                            pathname.startsWith(item.href) && "text-primary"
                        )}>
                            <div className={cn("p-3 rounded-xl", pathname.startsWith(item.href) ? "bg-primary text-primary-foreground" : "")}>
                                <item.icon className="h-6 w-6" />
                            </div>
                            {!pathname.startsWith(item.href) && <span className="text-xs mt-1">{item.label}</span>}
                        </Link>
                    ))}
                </nav>
            </footer>
        </div>
    );
}

export default function HomePage() {
    const router = useRouter();
    const { user, loading: userLoading } = useUser();

    useEffect(() => {
        if (!userLoading && !user) {
            const params = new URLSearchParams(window.location.search);
            const clinicId = params.get('clinicId');
            const loginParams = new URLSearchParams();
            if (clinicId) {
                loginParams.set('clinicId', clinicId);
                const redirectUrl = `/home?${params.toString()}`;
                loginParams.set('redirect', redirectUrl);
            }
            router.push(`/login?${loginParams.toString()}`);
        }
    }, [user, userLoading, router]);

    if (userLoading || !user) {
        return <SplashScreen />;
    }

    return <HomePageContent />;
}

