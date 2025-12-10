
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardDescription,
  CardFooter,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { collection, getDocs, query, where, getDoc, doc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/firebase";
import type { Appointment } from "@/lib/types";
import { format } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "../ui/skeleton";
import { Button } from "../ui/button";
import { ArrowRight } from "lucide-react";

export default function TodaysAppointments({ selectedDate }: { selectedDate: Date }) {
  const auth = useAuth();
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!auth.currentUser) {
      setLoading(false);
      return;
    }

    const fetchAppointments = async () => {
      try {
        setLoading(true);

        const userDoc = await getDoc(doc(db, "users", auth.currentUser!.uid));
        const clinicId = userDoc.data()?.clinicId;
        if (!clinicId) {
          setLoading(false);
          return;
        }

        const dateStr = format(selectedDate, "d MMMM yyyy");
        const q = query(
          collection(db, "appointments"),
          where("clinicId", "==", clinicId),
          where("date", "==", dateStr)
        );
        const querySnapshot = await getDocs(q);
        const appts = querySnapshot.docs.map(
          (doc) => doc.data() as Appointment
        );
        
        const sortedAppts = appts.sort((a, b) => {
            const timeA = new Date(`1970/01/01 ${a.time}`).getTime();
            const timeB = new Date(`1970/01/01 ${b.time}`).getTime();
            return timeA - timeB;
        });

        setAppointments(sortedAppts.slice(0, 3));
      } catch (error) {
        console.error("Error fetching today's appointments:", error);
      } finally {
        setLoading(false);
      }
    };
    fetchAppointments();
  }, [selectedDate, auth.currentUser]);

  return (
    <Card className="h-full flex flex-col bg-[#bcddef]/30">
      <CardHeader>
        <CardTitle>Appointments for {format(selectedDate, "MMMM d")}</CardTitle>
        <CardDescription>First 3 appointments for the selected day.</CardDescription>
      </CardHeader>
      <CardContent className="flex-grow overflow-hidden">
        <ScrollArea className="h-full">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Patient</TableHead>
                <TableHead>Time</TableHead>
                <TableHead>Doctor</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                Array.from({ length: 3 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-16" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                    <TableCell><Skeleton className="h-8 w-20 rounded-full" /></TableCell>
                  </TableRow>
                ))
              ) : appointments.length > 0 ? (
                appointments.map((apt) => (
                  <TableRow key={apt.id || apt.tokenNumber}>
                    <TableCell className="font-medium">{apt.patientName}</TableCell>
                    <TableCell>{apt.time}</TableCell>
                    <TableCell>{apt.doctor}</TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          apt.status === "Confirmed"
                            ? "success"
                            : apt.status === "Pending"
                            ? "warning"
                            : apt.status === "Completed"
                            ? "success"
                            : "destructive"
                        }
                      >
                        {apt.status}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell
                    colSpan={4}
                    className="h-24 text-center text-muted-foreground"
                  >
                    No appointments scheduled for this day.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </ScrollArea>
      </CardContent>
       <CardFooter className="pt-4 justify-end">
          <Button asChild variant="link" className="text-primary">
              <Link href="/appointments?drawer=open">
                  View All
                  <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
          </Button>
      </CardFooter>
    </Card>
  );
}
