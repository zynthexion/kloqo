'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import {
    fetchPatientById,
    fetchAppointmentsByPatientId,
    fetchAllUsers,
    fetchPatientsByPhone,
    type Patient,
    type Appointment,
    type User
} from '@/lib/analytics';
import { firestoreTimestampToDate, parseDateString } from '@/lib/metrics';
import { format } from 'date-fns';
import {
    User as UserIcon,
    Phone,
    Mail,
    MapPin,
    Calendar,
    Clock,
    ArrowLeft,
    Smartphone,
    History,
    Activity,
    Users
} from 'lucide-react';

export default function PatientDetailPage() {
    const params = useParams();
    const router = useRouter();
    const id = params.id as string;

    const [loading, setLoading] = useState(true);
    const [patient, setPatient] = useState<Patient | null>(null);
    const [relatedPatients, setRelatedPatients] = useState<Patient[]>([]);
    const [pwaInstalled, setPwaInstalled] = useState(false);
    const [appointments, setAppointments] = useState<Appointment[]>([]);

    useEffect(() => {
        const loadData = async () => {
            setLoading(true);
            try {
                const [patientData, appointmentsData, usersData] = await Promise.all([
                    fetchPatientById(id),
                    fetchAppointmentsByPatientId(id),
                    fetchAllUsers()
                ]);

                setPatient(patientData);
                setAppointments(appointmentsData);

                // Fetch related patients using communicationPhone or phone
                if (patientData) {
                    const phoneToSearch = patientData.communicationPhone || patientData.phone;
                    if (phoneToSearch) {
                        const related = await fetchPatientsByPhone(phoneToSearch);
                        // Filter out current patient
                        setRelatedPatients(related.filter(p => p.id !== patientData.id));
                    }

                    // Check PWA status
                    let user = usersData.find(u => u.patientId === patientData.id);
                    if (!user && patientData.phone) {
                        user = usersData.find(u => u.phone === patientData.phone);
                    }
                    setPwaInstalled(user?.pwaInstalled || false);
                }
            } catch (error) {
                console.error('Error loading patient details:', error);
            } finally {
                setLoading(false);
            }
        };

        if (id) {
            loadData();
        }
    }, [id]);

    const upcomingAppointments = appointments
        .filter(apt => {
            const aptDate = apt.createdAt ? firestoreTimestampToDate(apt.createdAt) : parseDateString(apt.date);
            return aptDate && aptDate >= new Date() && (apt.status === 'Pending' || apt.status === 'Confirmed');
        })
        .sort((a, b) => {
            const dateA = a.createdAt ? firestoreTimestampToDate(a.createdAt) : parseDateString(a.date);
            const dateB = b.createdAt ? firestoreTimestampToDate(b.createdAt) : parseDateString(b.date);
            return (dateA?.getTime() || 0) - (dateB?.getTime() || 0);
        });

    const pastAppointments = appointments
        .filter(apt => {
            const aptDate = apt.createdAt ? firestoreTimestampToDate(apt.createdAt) : parseDateString(apt.date);
            return (aptDate && aptDate < new Date()) || (apt.status !== 'Pending' && apt.status !== 'Confirmed');
        })
        .sort((a, b) => {
            const dateA = a.createdAt ? firestoreTimestampToDate(a.createdAt) : parseDateString(a.date);
            const dateB = b.createdAt ? firestoreTimestampToDate(b.createdAt) : parseDateString(b.date);
            return (dateB?.getTime() || 0) - (dateA?.getTime() || 0);
        });

    if (loading) {
        return (
            <div className="flex items-center justify-center h-screen">
                <div className="text-center">
                    <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto mb-4" />
                    <p className="text-muted-foreground">Loading patient details...</p>
                </div>
            </div>
        );
    }

    if (!patient) {
        return (
            <div className="p-8 text-center">
                <h2 className="text-2xl font-bold mb-4">Patient Not Found</h2>
                <Button onClick={() => router.back()}>Go Back</Button>
            </div>
        );
    }

    const registeredDate = patient.createdAt ? firestoreTimestampToDate(patient.createdAt) : null;

    return (
        <div className="space-y-6 animate-in fade-in duration-500">
            <div className="flex items-center gap-4 mb-6">
                <Button variant="ghost" size="icon" onClick={() => router.back()}>
                    <ArrowLeft className="h-4 w-4" />
                </Button>
                <div>
                    <h1 className="text-3xl font-bold">{patient.name}</h1>
                    <p className="text-muted-foreground flex items-center gap-2">
                        Patient ID: {patient.id}
                    </p>
                </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                {/* Left Column: Patient Profile */}
                <Card className="md:col-span-1 h-fit">
                    <CardHeader>
                        <CardTitle>Profile</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <div className="flex items-center gap-3">
                            <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center text-primary font-semibold">
                                {patient.name?.charAt(0) || 'U'}
                            </div>
                            <div>
                                <div className="font-medium">{patient.name}</div>
                                <div className="text-sm text-muted-foreground">{patient.age} years • {patient.sex || 'Not specified'}</div>
                            </div>
                        </div>

                        <div className="space-y-3 pt-4 border-t">
                            <div className="flex items-center gap-3 text-sm">
                                <Phone className="h-4 w-4 text-muted-foreground" />
                                <span>{patient.phone}</span>
                            </div>
                            <div className="flex items-center gap-3 text-sm">
                                <Mail className="h-4 w-4 text-muted-foreground" />
                                <span>{patient.email || 'No email'}</span>
                            </div>
                            <div className="flex items-center gap-3 text-sm">
                                <MapPin className="h-4 w-4 text-muted-foreground" />
                                <span>{patient.place || 'Location not set'}</span>
                            </div>
                            <div className="flex items-center gap-3 text-sm">
                                <Calendar className="h-4 w-4 text-muted-foreground" />
                                <span>Member since {registeredDate ? format(registeredDate, 'MMM d, yyyy') : 'Unknown'}</span>
                            </div>
                        </div>

                        <div className="pt-4 border-t">
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2 text-sm font-medium">
                                    <Smartphone className="h-4 w-4 text-primary" />
                                    App Status
                                </div>
                                {pwaInstalled ? (
                                    <Badge className="bg-green-600 hover:bg-green-700">Installed</Badge>
                                ) : (
                                    <Badge variant="outline">Not Installed</Badge>
                                )}
                            </div>
                        </div>

                        <div className="pt-4 border-t">
                            <div className="grid grid-cols-2 gap-4 text-center">
                                <div className="p-3 bg-muted rounded-lg">
                                    <div className="text-2xl font-bold">{appointments.length}</div>
                                    <div className="text-xs text-muted-foreground uppercase tracking-wider mt-1">Total Visits</div>
                                </div>
                                <div className="p-3 bg-muted rounded-lg">
                                    <div className="text-2xl font-bold">{upcomingAppointments.length}</div>
                                    <div className="text-xs text-muted-foreground uppercase tracking-wider mt-1">Upcoming</div>
                                </div>
                            </div>
                        </div>
                    </CardContent>
                </Card>

                {/* Right Column: Key Stats & Appointments */}
                <div className="md:col-span-2 space-y-6">
                    <Tabs defaultValue="upcoming" className="w-full">
                        <TabsList className="grid w-full grid-cols-3 mb-4">
                            <TabsTrigger value="upcoming">Upcoming</TabsTrigger>
                            <TabsTrigger value="history">Visits</TabsTrigger>
                            <TabsTrigger value="related">Related</TabsTrigger>
                        </TabsList>

                        <TabsContent value="upcoming">
                            <Card>
                                <CardHeader>
                                    <CardTitle className="flex items-center gap-2">
                                        <Calendar className="h-5 w-5 text-primary" />
                                        Upcoming Appointments
                                    </CardTitle>
                                    <CardDescription>Scheduled future visits</CardDescription>
                                </CardHeader>
                                <CardContent>
                                    {upcomingAppointments.length === 0 ? (
                                        <div className="text-center py-8 text-muted-foreground">
                                            No upcoming appointments scheduled.
                                        </div>
                                    ) : (
                                        <div className="space-y-4">
                                            {upcomingAppointments.map((apt) => (
                                                <div key={apt.id} className="flex items-start justify-between p-4 border rounded-lg bg-card hover:bg-muted/50 transition-colors">
                                                    <div className="space-y-1">
                                                        <div className="font-semibold flex items-center gap-2">
                                                            {apt.date}
                                                            <Badge variant="secondary">{apt.status}</Badge>
                                                        </div>
                                                        <div className="text-sm text-muted-foreground">Doctor: {apt.doctor}</div>
                                                        <div className="text-sm text-muted-foreground">Token: {apt.tokenNumber || 'Pending'}</div>
                                                    </div>
                                                    <div className="text-right">
                                                        <div className="text-sm font-medium text-primary">{apt.clinicId}</div>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </CardContent>
                            </Card>
                        </TabsContent>

                        <TabsContent value="history">
                            <Card>
                                <CardHeader>
                                    <CardTitle className="flex items-center gap-2">
                                        <History className="h-5 w-5 text-primary" />
                                        Visit History
                                    </CardTitle>
                                    <CardDescription>Past appointments and records</CardDescription>
                                </CardHeader>
                                <CardContent>
                                    {pastAppointments.length === 0 ? (
                                        <div className="text-center py-8 text-muted-foreground">
                                            No past appointment history found.
                                        </div>
                                    ) : (
                                        <div className="space-y-4">
                                            {pastAppointments.map((apt) => (
                                                <div key={apt.id} className="flex items-start justify-between p-4 border rounded-lg bg-card hover:bg-muted/50 transition-colors">
                                                    <div className="space-y-1">
                                                        <div className="font-semibold flex items-center gap-2">
                                                            {apt.date}
                                                            <Badge variant={apt.status === 'Completed' ? 'default' : 'secondary'} className={apt.status === 'Completed' ? 'bg-green-600' : ''}>
                                                                {apt.status}
                                                            </Badge>
                                                        </div>
                                                        <div className="text-sm text-muted-foreground">Doctor: {apt.doctor}</div>
                                                        <div className="text-sm text-muted-foreground">Booked via: {apt.bookedVia || 'Unknown'}</div>
                                                    </div>
                                                    <div className="text-right">
                                                        <div className="text-sm font-medium text-muted-foreground">{apt.clinicId}</div>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </CardContent>
                            </Card>
                        </TabsContent>

                        <TabsContent value="related">
                            <Card>
                                <CardHeader>
                                    <CardTitle className="flex items-center gap-2">
                                        <Users className="h-5 w-5 text-primary" />
                                        Related Patients
                                    </CardTitle>
                                    <CardDescription>
                                        Other patients sharing the same phone number ({patient.communicationPhone || patient.phone})
                                    </CardDescription>
                                </CardHeader>
                                <CardContent>
                                    {relatedPatients.length === 0 ? (
                                        <div className="text-center py-8 text-muted-foreground">
                                            No related patients found.
                                        </div>
                                    ) : (
                                        <div className="space-y-4">
                                            {relatedPatients.map((relPatient) => (
                                                <div
                                                    key={relPatient.id}
                                                    className="flex items-center justify-between p-4 border rounded-lg bg-card hover:bg-muted/50 transition-colors cursor-pointer"
                                                    onClick={() => router.push(`/dashboard/patients/${relPatient.id}`)}
                                                >
                                                    <div className="flex items-center gap-4">
                                                        <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center text-primary font-semibold">
                                                            {relPatient.name?.charAt(0) || 'U'}
                                                        </div>
                                                        <div>
                                                            <div className="font-medium">{relPatient.name}</div>
                                                            <div className="text-sm text-muted-foreground">{relPatient.age} years • {relPatient.sex}</div>
                                                        </div>
                                                    </div>
                                                    <Button variant="ghost" size="sm">View</Button>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </CardContent>
                            </Card>
                        </TabsContent>
                    </Tabs>
                </div>
            </div>
        </div>
    );
}
