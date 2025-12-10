
"use client";

import Link from "next/link";
import { LiveStatusHeader } from "@/components/layout/header";
import { Card, CardContent } from "@/components/ui/card";
import { Maximize, ZoomIn, ZoomOut, Users, Clock, Hourglass, Ticket } from "lucide-react";
import { useEffect, useState, useMemo } from "react";
import { collection, getDocs, query, where, doc, getDoc, onSnapshot } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/firebase";
import type { Doctor, Appointment } from '@kloqo/shared-types';
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { format, parse, isToday, differenceInMinutes } from "date-fns";

type EnrichedDoctor = Doctor & {
  currentToken?: string;
  pendingTokens: number;
  delayMinutes?: number;
};

const DoctorStatusCard = ({ data }: { data: EnrichedDoctor }) => {
  const isAvailable = data.consultationStatus === "In";

  return (
    <Link href={`/live-status/${data.id}`}>
      <Card
        className={cn(
          "p-4 flex flex-col justify-between h-full shadow-md hover:shadow-xl transition-shadow border-l-4",
          isAvailable ? "border-green-500" : "border-red-500"
        )}
      >
        <div>
          <div className="flex justify-between items-start">
            <div>
              <h3 className="font-semibold text-lg">{data.name}</h3>
              <p className="text-sm text-muted-foreground">{data.specialty}</p>
            </div>
            <div className={cn(
              "px-2 py-1 rounded-full text-xs font-semibold flex items-center gap-1",
              isAvailable ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"
            )}>
              <div className={cn("h-2 w-2 rounded-full", isAvailable ? "bg-green-500" : "bg-red-500")} />
              {data.consultationStatus}
            </div>
          </div>
        </div>
        <div className="mt-4 space-y-3">
          {isAvailable ? (
            <>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="flex items-center gap-2">
                  <Ticket className="h-4 w-4 text-muted-foreground" />
                  <div>
                    <p className="text-xs text-muted-foreground">Current</p>
                    <p className="font-bold">{data.currentToken || 'N/A'}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Users className="h-4 w-4 text-muted-foreground" />
                  <div>
                    <p className="text-xs text-muted-foreground">In Queue</p>
                    <p className="font-bold">{data.pendingTokens}</p>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <Hourglass className="h-4 w-4 text-muted-foreground" />
                <div>
                  <p className="text-xs text-muted-foreground">Est. Delay</p>
                  <p className={cn("font-bold", (data.delayMinutes ?? 0) > 10 ? "text-red-500" : "text-green-600")}>
                    {data.delayMinutes !== undefined ? `${data.delayMinutes} min` : 'N/A'}
                  </p>
                </div>
              </div>
            </>
          ) : (
            <div>
              <p className="font-bold text-lg text-red-500">UNAVAILABLE</p>
              <p className="text-sm text-muted-foreground">
                Currently not accepting appointments.
              </p>
            </div>
          )}
        </div>
      </Card>
    </Link>
  );
};


const ZoomControls = () => (
  <div className="fixed right-6 bottom-6 flex flex-col gap-1">
    <Card className="p-0 flex flex-col gap-0 rounded-md overflow-hidden border">
      <Button variant="ghost" size="icon" className="rounded-none">
        <ZoomIn className="h-5 w-5" />
      </Button>
      <hr />
      <Button variant="ghost" size="icon" className="rounded-none">
        <ZoomOut className="h-5 w-5" />
      </Button>
      <hr />
      <Button variant="ghost" size="icon" className="rounded-none">
        <Maximize className="h-5 w-5" />
      </Button>
    </Card>
  </div>
);

export default function LiveStatusPage() {
  const auth = useAuth();
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentTime, setCurrentTime] = useState(new Date());

  useEffect(() => {
    if (!auth.currentUser) return;
    let unsubscribeSnapshot: (() => void) | undefined;

    const fetchInitialData = async () => {
      setLoading(true);
      try {
        const userDocRef = doc(db, "users", auth.currentUser!.uid);
        const userDoc = await getDoc(userDocRef);
        const clinicId = userDoc.data()?.clinicId;

        if (clinicId) {
          // Fetch doctors
          const doctorsQuery = query(collection(db, "doctors"), where("clinicId", "==", clinicId));
          const doctorsSnapshot = await getDocs(doctorsQuery);
          const doctorsList = doctorsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Doctor));
          setDoctors(doctorsList);

          // Setup listener for appointments
          const todayStr = format(new Date(), "d MMMM yyyy");
          const appointmentsQuery = query(
            collection(db, "appointments"),
            where("clinicId", "==", clinicId),
            where("date", "==", todayStr)
          );

          unsubscribeSnapshot = onSnapshot(appointmentsQuery, (snapshot) => {
            const appointmentsList = snapshot.docs.map(doc => doc.data() as Appointment);
            setAppointments(appointmentsList);
            setLoading(false);
          });
        } else {
          setLoading(false);
        }
      } catch (error) {
        console.error("Error fetching data for live status: ", error);
        setLoading(false);
      }
    };

    fetchInitialData();

    // Time ticker for delay calculation
    const timerId = setInterval(() => setCurrentTime(new Date()), 60000);

    return () => {
      if (unsubscribeSnapshot) {
        unsubscribeSnapshot();
      }
      clearInterval(timerId);
    };
  }, [auth.currentUser]);

  const enrichedDoctors: EnrichedDoctor[] = useMemo(() => {
    return doctors.map(doctor => {
      const doctorAppointments = appointments
        .filter(apt => apt.doctor === doctor.name && isToday(parse(apt.date, 'd MMMM yyyy', new Date())))
        .sort((a, b) => {
          try {
            const timeA = parse(a.time, "hh:mm a", new Date()).getTime();
            const timeB = parse(b.time, "hh:mm a", new Date()).getTime();
            return timeA - timeB;
          } catch { return 0; }
        });

      const pending = doctorAppointments.filter(apt => ['Pending', 'Confirmed'].includes(apt.status));
      const currentAppointment = pending[0];

      let delayMinutes: number | undefined;
      if (currentAppointment) {
        try {
          const appointmentTime = parse(currentAppointment.time, "hh:mm a", new Date());
          const diff = differenceInMinutes(currentTime, appointmentTime);
          delayMinutes = Math.max(0, diff); // Only show non-negative delay
        } catch {
          delayMinutes = undefined;
        }
      }

      return {
        ...doctor,
        currentToken: currentAppointment?.tokenNumber,
        pendingTokens: pending.length,
        delayMinutes,
      }
    })
  }, [doctors, appointments, currentTime]);

  return (
    <>
      <div className="flex flex-col">
        <LiveStatusHeader />
        <main className="flex-1 p-4 sm:p-6 relative">
          {loading ? (
            <p>Loading doctors...</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
              {enrichedDoctors.map((doctor) => (
                <DoctorStatusCard key={doctor.id} data={doctor} />
              ))}
            </div>
          )}
          <ZoomControls />
        </main>
      </div>
    </>
  );
}
