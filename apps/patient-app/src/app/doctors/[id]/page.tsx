
import { Metadata, ResolvingMetadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getFirestore, doc, getDoc } from 'firebase/firestore/lite';
import { getServerFirebaseApp } from '@/lib/firebase-server-app';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { MapPin, Clock, Calendar, Star, Building2, Phone } from 'lucide-react';

// Fetch doctor data helper
async function getDoctor(id: string) {
    const firestore = getFirestore(getServerFirebaseApp());
    const docRef = doc(firestore, 'doctors', id);
    const docSnap = await getDoc(docRef);

    if (!docSnap.exists()) return null;

    const doctorData = docSnap.data();

    // Fetch clinic details if available
    let clinicData = null;
    if (doctorData.clinicId) {
        const clinicRef = doc(firestore, 'clinics', doctorData.clinicId);
        const clinicSnap = await getDoc(clinicRef);
        if (clinicSnap.exists()) {
            clinicData = { id: clinicSnap.id, ...clinicSnap.data() };
        }
    }

    return { id: docSnap.id, ...doctorData, clinic: clinicData };
}

// 1. Dynamic Metadata Generation
export async function generateMetadata(
    { params }: { params: { id: string } },
    parent: ResolvingMetadata
): Promise<Metadata> {
    const doctor: any = await getDoctor(params.id);

    if (!doctor) {
        return {
            title: 'Doctor Not Found - Kloqo',
        };
    }

    const doctorName = doctor.name || 'Doctor';
    const speciality = doctor.department || doctor.specialization || 'Specialist';
    const city = doctor.clinic?.city || doctor.clinic?.address || 'Kerala';
    const clinicName = doctor.clinic?.name || '';

    return {
        title: `Dr. ${doctorName} - ${speciality} in ${city} | Kloqo`,
        description: `Book appointment with Dr. ${doctorName}, ${speciality} at ${clinicName}, ${city}. Check fees, timings, and patient reviews.`,
        openGraph: {
            title: `Dr. ${doctorName} - ${speciality}`,
            description: `Book appointment with Dr. ${doctorName} at ${clinicName}.`,
            images: doctor.photoUrl ? [doctor.photoUrl] : [],
        },
    };
}

export default async function DoctorProfilePage({ params }: { params: { id: string } }) {
    const doctor: any = await getDoctor(params.id);

    if (!doctor) {
        notFound();
    }

    // 2. Schema.org JSON-LD
    const jsonLd = {
        '@context': 'https://schema.org',
        '@type': 'Physician',
        name: doctor.name,
        image: doctor.photoUrl,
        description: doctor.bio || `Specialist in ${doctor.department || doctor.specialization}`,
        medicalSpecialty: doctor.department || doctor.specialization,
        priceRange: doctor.consultationFee ? `₹${doctor.consultationFee}` : '$$',
        address: {
            '@type': 'PostalAddress',
            streetAddress: doctor.clinic?.address,
            addressLocality: doctor.clinic?.city,
            addressRegion: 'Kerala',
            addressCountry: 'IN'
        },
        telephone: doctor.clinic?.phone || doctor.phone,
        url: `https://kloqo.com/doctors/${doctor.id}`,
    };

    // Construct the booking URL with redirect logic
    // The user requested: login -> /book-appointment?doctorId=id
    const targetUrl = `/book-appointment?doctorId=${doctor.id}`;
    const loginUrl = `/login?redirect=${encodeURIComponent(targetUrl)}`;

    return (
        <div className="min-h-screen bg-gray-50 pb-20">
            {/* JSON-LD Script for SEO */}
            <script
                type="application/ld+json"
                dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
            />

            {/* Navigation */}
            <div className="bg-white border-b sticky top-0 z-20">
                <div className="container mx-auto px-4 py-4 max-w-4xl flex justify-between items-center">
                    <Link href="/doctors" className="flex items-center text-sm text-gray-600 hover:text-primary">
                        <span className="mr-1">←</span> Back to Directory
                    </Link>
                    <Link href="/" className="font-bold text-xl text-primary">Kloqo</Link>
                </div>
            </div>

            <main className="container mx-auto px-4 py-8 max-w-4xl">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-8">

                    {/* Left Column: Profile Card */}
                    <div className="md:col-span-2 space-y-6">
                        <Card className="overflow-hidden border-none shadow-md">
                            <div className="h-32 bg-gradient-to-r from-blue-500 to-cyan-400"></div>
                            <CardContent className="pt-0 relative px-6 pb-6">
                                <div className="flex flex-col sm:flex-row items-start sm:items-end -mt-12 mb-4 gap-4">
                                    <Avatar className="h-32 w-32 rounded-xl border-4 border-white shadow-lg">
                                        <AvatarImage src={doctor.photoUrl} className="object-cover" />
                                        <AvatarFallback className="text-4xl bg-gray-100">{doctor.name?.[0]}</AvatarFallback>
                                    </Avatar>
                                    <div className="mb-2">
                                        <h1 className="text-3xl font-bold text-gray-900">{doctor.name}</h1>
                                        <p className="text-lg text-primary font-medium">{doctor.department || doctor.specialization}</p>
                                        <p className="text-gray-500 text-sm">{doctor.qualification}</p>
                                    </div>
                                </div>

                                <div className="grid grid-cols-2 gap-4 mt-6 border-t pt-6">
                                    <div className="flex flex-col">
                                        <span className="text-xs text-gray-500 uppercase font-bold tracking-wider mb-1">Clinic</span>
                                        <div className="flex items-start gap-2">
                                            <Building2 className="w-4 h-4 text-gray-400 mt-0.5" />
                                            <span className="font-medium text-gray-900">{doctor.clinic?.name || 'Main Clinic'}</span>
                                        </div>
                                    </div>
                                    <div className="flex flex-col">
                                        <span className="text-xs text-gray-500 uppercase font-bold tracking-wider mb-1">Consultation Fee</span>
                                        <div className="flex items-center gap-1">
                                            <span className="text-lg font-bold text-green-700">₹{doctor.consultationFee || 'N/A'}</span>
                                        </div>
                                    </div>
                                </div>
                            </CardContent>
                        </Card>

                        {/* Bio Section */}
                        <Card className="border-none shadow-sm">
                            <CardContent className="p-6">
                                <h3 className="text-lg font-bold mb-3 flex items-center gap-2">
                                    <Star className="w-5 h-5 text-yellow-500 fill-yellow-500" />
                                    About Doctor
                                </h3>
                                <div className="prose text-gray-600 leading-relaxed">
                                    {doctor.bio ? (
                                        <p>{doctor.bio}</p>
                                    ) : (
                                        <p className="text-gray-400 italic">No biography available for this doctor.</p>
                                    )}
                                </div>
                            </CardContent>
                        </Card>

                        {/* Clinic Location */}
                        <Card className="border-none shadow-sm">
                            <CardContent className="p-6">
                                <h3 className="text-lg font-bold mb-4 flex items-center gap-2">
                                    <MapPin className="w-5 h-5 text-red-500" />
                                    Location
                                </h3>
                                <div className="bg-gray-50 p-4 rounded-lg">
                                    <p className="font-semibold text-gray-900">{doctor.clinic?.name}</p>
                                    <p className="text-gray-600 mt-1">{doctor.clinic?.address}</p>
                                    <p className="text-gray-600">{doctor.clinic?.city}, Kerala</p>
                                    {doctor.clinic?.phone && (
                                        <div className="mt-3 text-sm text-gray-500 flex items-center gap-2">
                                            <Phone className="w-4 h-4" />
                                            {doctor.clinic.phone}
                                        </div>
                                    )}
                                </div>
                            </CardContent>
                        </Card>
                    </div>

                    {/* Right Column: Booking Widget (Sticky) */}
                    <div className="md:col-span-1">
                        <div className="sticky top-24">
                            <Card className="border-primary/20 shadow-lg bg-white/50 backdrop-blur">
                                <CardContent className="p-6 space-y-4">
                                    <div className="text-center mb-2">
                                        <span className="text-xs font-bold bg-green-100 text-green-800 px-2 py-1 rounded-full uppercase tracking-wide">
                                            Booking Open
                                        </span>
                                    </div>

                                    <div className="space-y-2 text-center border-b pb-4">
                                        <p className="text-sm text-gray-500">Next Available Slot</p>
                                        <p className="text-xl font-bold text-gray-900">Today / Tomorrow</p>
                                    </div>

                                    <Button asChild className="w-full h-12 text-lg font-bold shadow-lg shadow-primary/20 bg-gradient-to-r from-primary to-blue-600 hover:to-blue-700 hover:scale-[1.02] transition-all">
                                        <a href={loginUrl}>
                                            Book Appointment
                                        </a>
                                    </Button>

                                    <p className="text-xs text-center text-gray-400">
                                        Instant confirmation • No booking fees
                                    </p>
                                </CardContent>
                            </Card>

                            {/* QR Code Hook (Visual element for context) */}
                            <div className="mt-8 text-center p-4 bg-white rounded-lg border border-dashed border-gray-200">
                                <p className="text-xs text-gray-400 mb-2">Scan to share profile</p>
                                <div className="w-32 h-32 bg-gray-100 mx-auto rounded flex items-center justify-center text-gray-300 text-xs">
                                    [QR Code Placeholder]
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </main>
        </div>
    );
}
