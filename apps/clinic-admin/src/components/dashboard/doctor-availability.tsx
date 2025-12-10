
"use client";

import React, { useState, useEffect, useMemo } from "react";
import Image from "next/image";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import type { Appointment, Doctor } from "@/lib/types";
import { collection, getDocs, query, where, doc, getDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/firebase";
import { ScrollArea } from "../ui/scroll-area";
import { getDay, format, isSameDay, parse } from "date-fns";
import { Button } from "../ui/button";
import Link from "next/link";
import { Star, Users, Clock } from "lucide-react";
import { Badge } from "../ui/badge";
import { cn } from "@/lib/utils";

const daysOfWeek = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

type DoctorAvailabilityProps = {
  selectedDate: Date;
};

export default function DoctorAvailability({ selectedDate }: DoctorAvailabilityProps) {
  const auth = useAuth();
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!auth.currentUser) {
      setLoading(false);
      return;
    }

    const fetchClinicData = async () => {
      setLoading(true);
      try {
        const userDocRef = doc(db, "users", auth.currentUser!.uid);
        const userDocSnap = await getDoc(userDocRef);

        if (userDocSnap.exists()) {
          const clinicId = userDocSnap.data()?.clinicId;
          if (clinicId) {
            const doctorsQuery = query(collection(db, "doctors"), where("clinicId", "==", clinicId));
            const doctorsSnapshot = await getDocs(doctorsQuery);
            const doctorsList = doctorsSnapshot.docs.map(d => ({ id: d.id, ...d.data() } as Doctor));
            setDoctors(doctorsList);
            
            const appointmentsQuery = query(collection(db, "appointments"), where("clinicId", "==", clinicId));
            const appointmentsSnapshot = await getDocs(appointmentsQuery);
            const appointmentsList = appointmentsSnapshot.docs.map(a => a.data() as Appointment);
            setAppointments(appointmentsList);
          }
        }
      } catch (error) {
        console.error("Error fetching clinic data for availability: ", error);
      } finally {
        setLoading(false);
      }
    };
    
    fetchClinicData();
  }, [auth.currentUser]);

  const availableDoctors = useMemo(() => {
    if (!selectedDate) return [];
    const dayName = daysOfWeek[getDay(selectedDate)];
    return doctors.filter(doctor =>
      doctor.availabilitySlots?.some(slot => slot.day === dayName)
    );
  }, [selectedDate, doctors]);

  const getAppointmentsForDoctorOnDate = (doctorId: string) => {
    const doctor = doctors.find(d => d.id === doctorId);
    if (!doctor) return 0;
    
    return appointments.filter(apt => {
        try {
            const aptDate = parse(apt.date, 'd MMMM yyyy', new Date());
            return apt.doctor === doctor.name && isSameDay(aptDate, selectedDate);
        } catch {
            return false;
        }
    }).length;
  }

  const StarRating = ({ rating }: { rating: number }) => (
    <div className="flex items-center">
      {[...Array(5)].map((_, i) => (
        <Star
          key={i}
          className={`h-4 w-4 ${i < rating ? "text-yellow-400 fill-yellow-400" : "text-gray-300"}`}
        />
      ))}
    </div>
  );

  return (
    <Card className="h-full flex flex-col bg-[#bcddef]/30">
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle>Available Doctors</CardTitle>
          <CardDescription>
            For {format(selectedDate, "MMMM d, yyyy")}.
          </CardDescription>
        </div>
        <Button variant="link" asChild className="text-primary">
            <Link href="/doctors">See All</Link>
        </Button>
      </CardHeader>
      <CardContent className="flex-grow overflow-auto">
        <ScrollArea className="h-full">
            <div className="space-y-3 pr-3">
            {loading ? (
              <p className="text-sm text-muted-foreground text-center">Loading...</p>
            ) : availableDoctors.length > 0 ? (
                availableDoctors.map((doctor) => {
                    const appointmentCount = getAppointmentsForDoctorOnDate(doctor.id);
                    const tendsToRunLate = doctor.historicalData?.toLowerCase().includes('late');
                    return (
                        <Card key={doctor.id} className="p-4 hover:bg-muted/50 transition-colors">
                            <div className="flex items-start justify-between">
                                <div className="flex items-center gap-4">
                                     <Image
                                        src={doctor.avatar}
                                        alt={doctor.name}
                                        width={40}
                                        height={40}
                                        className="rounded-full"
                                        data-ai-hint="doctor portrait"
                                    />
                                    <div>
                                        <Link href={`/doctors?id=${doctor.id}`} className="font-semibold text-sm hover:underline">{doctor.name}</Link>
                                        <p className="text-xs text-muted-foreground">{doctor.specialty}</p>
                                        <StarRating rating={doctor.rating || 0} />
                                    </div>
                                </div>
                                {appointmentCount > 0 && (
                                 <Badge variant="secondary" className="font-semibold">
                                    <Users className="h-3 w-3 mr-1.5" />
                                    {appointmentCount} {appointmentCount > 1 ? 'appointments' : 'appointment'}
                                </Badge>
                               )}
                            </div>
                            <div className="flex items-center gap-2 mt-3">
                               <Badge variant={doctor.consultationStatus === 'In' ? 'success' : 'destructive'} className="text-xs">
                                  {doctor.consultationStatus || 'Out'}
                                </Badge>
                               {tendsToRunLate && (
                                  <Badge variant="warning" className="text-xs">
                                      <Clock className="h-3 w-3 mr-1" />
                                      Runs Late
                                  </Badge>
                               )}
                            </div>
                        </Card>
                    )
                })
            ) : (
                <div className="flex items-center justify-center h-full pt-10">
                    <p className="text-sm text-muted-foreground text-center">No doctors scheduled for this day.</p>
                </div>
            )}
            </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

    