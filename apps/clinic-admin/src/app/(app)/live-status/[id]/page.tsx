
"use client"

import { useParams } from "next/navigation";
import { LiveStatusDetailHeader } from "@/components/layout/header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { CheckCircle, Clock, Users } from "lucide-react";
import { useEffect, useState, useMemo } from "react";
import { collection, doc, getDoc, getDocs, query, where } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/firebase";
import type { Doctor, Appointment } from '@kloqo/shared-types';
import { format, isToday, parse } from "date-fns";
import { compareAppointments } from '@kloqo/shared-core';

const statusStyles = {
    completed: {
        variant: "success",
        icon: <CheckCircle size={16} className="mr-2" />,
        text: "Completed",
    },
    pending: {
        variant: "warning",
        icon: <Clock size={16} className="mr-2" />,
        text: "Pending",
    },
} as const;

export default function LiveStatusDetailPage() {
    const params = useParams();
    const auth = useAuth();
    const { id } = params;

    const [doctor, setDoctor] = useState<Doctor | null>(null);
    const [appointments, setAppointments] = useState<Appointment[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        if (!id || !auth.currentUser) return;

        const fetchDoctorAndAppointments = async () => {
            setLoading(true);
            try {
                if (!auth.currentUser) return;
                const userDocRef = doc(db, "users", auth.currentUser.uid);
                const userDocSnap = await getDoc(userDocRef);
                const clinicId = userDocSnap.data()?.clinicId;

                if (clinicId) {
                    const doctorRef = doc(db, "doctors", id as string);
                    const doctorSnap = await getDoc(doctorRef);

                    if (doctorSnap.exists()) {
                        const doctorData = { id: doctorSnap.id, ...doctorSnap.data() } as Doctor;
                        setDoctor(doctorData);

                        const todayStr = format(new Date(), 'd MMMM yyyy');
                        const appointmentsQuery = query(
                            collection(db, "appointments"),
                            where("clinicId", "==", clinicId),
                            where("doctor", "==", doctorData.name),
                            where("date", "==", todayStr)
                        );
                        const appointmentsSnapshot = await getDocs(appointmentsQuery);
                        const appointmentsList = appointmentsSnapshot.docs.map(doc => doc.data() as Appointment);
                        setAppointments(appointmentsList);
                    }
                }
            } catch (error) {
                console.error("Error fetching live status details: ", error);
            } finally {
                setLoading(false);
            }
        };
        fetchDoctorAndAppointments();
    }, [id, auth.currentUser]);

    const tokenQueue = useMemo(() => {
        const sorted = [...appointments].sort(compareAppointments);

        const now = new Date();
        const completed = sorted.filter(a => a.status === 'Completed' || parse(a.time, "hh:mm a", new Date()) < now);
        const pending = sorted.filter(a => a.status !== 'Completed' && parse(a.time, "hh:mm a", new Date()) >= now);

        return {
            all: sorted,
            completed,
            pending,
        };
    }, [appointments]);

    if (loading) {
        return (
            <>
                <div className="flex flex-col">
                    <LiveStatusDetailHeader />
                    <main className="flex-1 p-4 sm:p-6 flex items-center justify-center">
                        <p>Loading...</p>
                    </main>
                </div>
            </>
        );
    }

    if (!doctor) {
        return (
            <>
                <div className="flex flex-col">
                    <LiveStatusDetailHeader />
                    <main className="flex-1 p-4 sm:p-6 flex items-center justify-center">
                        <p>Doctor not found.</p>
                    </main>
                </div>
            </>
        );
    }

    const currentToken = tokenQueue.pending[0]?.tokenNumber;
    const queueCount = tokenQueue.pending.length;

    return (
        <>
            <div className="flex flex-col">
                <LiveStatusDetailHeader />
                <main className="flex-1 p-4 sm:p-6">
                    <Card className="mb-6">
                        <CardContent className="p-6">
                            <div className="flex justify-between items-start">
                                <div>
                                    <h2 className="text-2xl font-bold">{doctor.name}</h2>
                                    <p className="text-muted-foreground">{doctor.specialty}</p>
                                </div>
                                <div className="text-right">
                                    <Badge variant={doctor.availability === 'Available' ? 'success' : 'destructive'}>
                                        {doctor.availability}
                                    </Badge>
                                </div>
                            </div>
                            <Separator className="my-4" />
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <p className="text-sm text-muted-foreground">Current Token</p>
                                    <p className="text-3xl font-bold text-green-600">{currentToken || 'N/A'}</p>
                                </div>
                                <div>
                                    <p className="text-sm text-muted-foreground">Patients in Queue</p>
                                    <p className="text-3xl font-bold">{queueCount}</p>
                                </div>
                            </div>
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader>
                            <CardTitle>Token Queue Status</CardTitle>
                            <CardDescription>Overview of all tokens for this queue today.</CardDescription>
                        </CardHeader>
                        <CardContent>
                            <ScrollArea className="h-[calc(100vh-420px)]">
                                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                                    {tokenQueue.all.map((apt) => {
                                        const isCompleted = tokenQueue.completed.some(c => c.id === apt.id);
                                        const style = isCompleted ? statusStyles.completed : statusStyles.pending;
                                        return (
                                            <Badge key={apt.id} variant={style.variant} className="text-base font-medium p-3 flex items-center justify-center">
                                                {style.icon}
                                                <span>{apt.tokenNumber}</span>
                                            </Badge>
                                        )
                                    })}
                                </div>
                            </ScrollArea>
                        </CardContent>
                    </Card>

                </main>
            </div>
        </>
    );
}

