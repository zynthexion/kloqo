
import { Metadata } from 'next';
import Link from 'next/link';
import { getFirestore, collection, getDocs, query, where } from 'firebase/firestore/lite';
import { getServerFirebaseApp } from '@/lib/firebase-server-app';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { MapPin, Stethoscope, ArrowRight } from 'lucide-react';


export const metadata: Metadata = {
    title: 'Find Best Doctors in Kerala - Kloqo',
    description: 'Browse top-rated doctors and specialists in Kerala. Book appointments online instantly with Kloqo.',
};

async function getDoctorsAndClinics() {
    const firestore = getFirestore(getServerFirebaseApp());

    const [doctorsSnap, clinicsSnap] = await Promise.all([
        getDocs(collection(firestore, 'doctors')),
        getDocs(collection(firestore, 'clinics'))
    ]);

    const clinics = clinicsSnap.docs.reduce((acc, doc) => {
        acc[doc.id] = { id: doc.id, ...doc.data() };
        return acc;
    }, {} as Record<string, any>);

    const doctors = doctorsSnap.docs.map(doc => {
        const data = doc.data();
        return {
            id: doc.id,
            ...data,
            clinic: clinics[data.clinicId] || null
        };
    });

    return doctors;
}

export default async function DoctorsDirectoryPage({
    searchParams,
}: {
    searchParams: { [key: string]: string | string[] | undefined }
}) {
    const doctors = await getDoctorsAndClinics();

    // Simple client-side search simulation for now (since this is a server component, perfect search would need client interaction or URL params)
    // For MVP SEO page, we list all. In a real scenario, we'd handle search params.
    const query = typeof searchParams.q === 'string' ? searchParams.q.toLowerCase() : '';

    const filteredDoctors = doctors.filter((doctor: any) =>
        !query ||
        doctor.name?.toLowerCase().includes(query) ||
        doctor.specialization?.toLowerCase().includes(query) ||
        doctor.clinic?.city?.toLowerCase().includes(query)
    );

    return (
        <div className="min-h-screen bg-gray-50 pb-20">
            {/* Header */}
            <div className="bg-white border-b sticky top-0 z-10">
                <div className="container mx-auto px-4 py-4 max-w-4xl">
                    <div className="flex items-center justify-between mb-4">
                        <Link href="/" className="text-2xl font-bold text-primary">Kloqo</Link>
                        <div className="flex gap-2">
                            <Link href="/login">
                                <Button variant="outline" size="sm">Login</Button>
                            </Link>
                        </div>
                    </div>
                    <h1 className="text-xl md:text-2xl font-bold text-gray-900 mb-2">
                        Find the Best Doctors
                    </h1>
                    <p className="text-gray-500 text-sm mb-4">
                        Book appointments with top specialists in your city
                    </p>

                    <form action="/doctors" method="GET" className="relative">
                        <input
                            name="q"
                            defaultValue={query}
                            placeholder="Search doctors, specialities, clinics..."
                            className="pl-10 h-12 text-lg shadow-sm flex w-full rounded-md border border-input bg-background px-3 py-2 ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                        />
                        <div className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">
                            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></svg>
                        </div>
                    </form>
                </div>
            </div>

            {/* Directory Grid */}
            <div className="container mx-auto px-4 py-8 max-w-4xl">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {filteredDoctors.map((doctor: any) => (
                        <Link href={`/doctors/${doctor.id}`} key={doctor.id} className="block group">
                            <Card className="h-full hover:shadow-lg transition-shadow border-transparent hover:border-primary/20">
                                <CardContent className="p-5 flex gap-4">
                                    <Avatar className="h-20 w-20 rounded-lg group-hover:scale-105 transition-transform">
                                        <AvatarImage src={doctor.photoUrl} alt={doctor.name} className="object-cover" />
                                        <AvatarFallback className="text-lg bg-primary/5 text-primary">
                                            {doctor.name?.split(' ').map((n: string) => n[0]).join('')}
                                        </AvatarFallback>
                                    </Avatar>

                                    <div className="flex-1 min-w-0">
                                        <h2 className="text-lg font-bold text-gray-900 group-hover:text-primary truncate">
                                            {doctor.name}
                                        </h2>
                                        <div className="flex items-center gap-1 text-sm text-gray-600 mb-1">
                                            <Stethoscope className="w-3.5 h-3.5" />
                                            <span>{doctor.department || doctor.specialization || 'General Physician'}</span>
                                        </div>
                                        <div className="flex items-center gap-1 text-sm text-gray-500 mb-3">
                                            <MapPin className="w-3.5 h-3.5 flex-shrink-0" />
                                            <span className="truncate">{doctor.clinic?.name}, {doctor.clinic?.city || doctor.clinic?.address}</span>
                                        </div>

                                        <div className="flex items-center gap-2 mt-auto">
                                            <div className="bg-green-50 text-green-700 text-xs font-semibold px-2 py-1 rounded">
                                                Available Today
                                            </div>
                                        </div>
                                    </div>

                                    <div className="flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity -mr-2">
                                        <ArrowRight className="w-5 h-5 text-gray-400" />
                                    </div>
                                </CardContent>
                            </Card>
                        </Link>
                    ))}
                </div>

                {filteredDoctors.length === 0 && (
                    <div className="text-center py-20">
                        <p className="text-xl text-gray-500 font-medium">No doctors found matching "{query}"</p>
                        <Link href="/doctors">
                            <Button variant="link" className="mt-2">Clear filters</Button>
                        </Link>
                    </div>
                )}
            </div>
        </div>
    );
}
