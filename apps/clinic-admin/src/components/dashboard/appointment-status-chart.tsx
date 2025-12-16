

"use client";

import { useEffect, useState, useMemo, useTransition } from "react";
import { collection, getDocs, query, where, getDoc, doc, writeBatch } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/firebase";
import type { Appointment, Doctor } from "@/lib/types";
import { Card, CardHeader, CardTitle, CardContent, CardDescription, CardFooter } from "@/components/ui/card";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";
import type { DateRange } from "react-day-picker";
import { isWithinInterval, parse, isFuture, startOfDay, isToday } from "date-fns";
import { Skeleton } from "../ui/skeleton";

const COLORS = {
  completed: "hsl(var(--chart-2))",
  upcoming: "hsl(var(--chart-1))",
  cancelled: "hsl(var(--chart-3))",
  "No-show": "hsl(var(--muted-foreground))",
};

const ALL_STATUSES = ["completed", "upcoming", "cancelled", "No-show"];

const statusLabels: { [key: string]: string } = {
  completed: "Completed",
  upcoming: "Upcoming",
  cancelled: "Cancelled",
  "No-show": "No-show",
};

type AppointmentStatusChartProps = {
  dateRange: DateRange | undefined;
  doctorId?: string;
};

export default function AppointmentStatusChart({ dateRange, doctorId }: AppointmentStatusChartProps) {
  const auth = useAuth();
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchAppointments = async () => {
    if (!auth.currentUser) return;
    setLoading(true);
    try {
      const userDoc = await getDoc(doc(db, "users", auth.currentUser!.uid));
      const clinicId = userDoc.data()?.clinicId;
      if (!clinicId) {
        setLoading(false);
        return;
      }

      const appointmentsQuery = query(collection(db, "appointments"), where("clinicId", "==", clinicId));
      const appointmentsSnapshot = await getDocs(appointmentsQuery);
      const appointmentsList = appointmentsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }) as Appointment);
      setAppointments(appointmentsList);

      const doctorsQuery = query(collection(db, "doctors"), where("clinicId", "==", clinicId));
      const doctorsSnapshot = await getDocs(doctorsQuery);
      const doctorsList = doctorsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }) as Doctor);
      setDoctors(doctorsList);
    } catch (e) {
      console.error("Failed to fetch appointments", e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAppointments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.currentUser]);

  const { chartData } = useMemo(() => {
    if (!dateRange?.from) return { chartData: [] };

    let filteredAppointments = appointments;

    if (doctorId) {
      const doctor = doctors.find(d => d.id === doctorId);
      if (doctor) {
        filteredAppointments = appointments.filter(apt => apt.doctor === doctor.name);
      }
    }

    const from = startOfDay(dateRange.from);
    const to = dateRange.to ? startOfDay(dateRange.to) : from;

    const rangeAppointments = filteredAppointments.filter(apt => {
      try {
        const aptDate = parse(apt.date, 'd MMMM yyyy', new Date());
        return isWithinInterval(aptDate, { start: from, end: to });
      } catch {
        return false;
      }
    });

    const completed = rangeAppointments.filter(apt => apt.status === 'Completed').length;
    const upcoming = rangeAppointments.filter(apt => (apt.status === 'Confirmed' || apt.status === 'Pending') && (isFuture(parse(apt.date, 'd MMMM yyyy', new Date())) || isToday(parse(apt.date, 'd MMMM yyyy', new Date())))).length;
    const cancelled = rangeAppointments.filter(apt => apt.status === 'Cancelled' && !apt.cancelledByBreak).length;
    const noShow = rangeAppointments.filter(apt => apt.status === 'No-show' || apt.status === 'Skipped').length;

    const data = [
      { name: "completed", value: completed },
      { name: "upcoming", value: upcoming },
      { name: "cancelled", value: cancelled },
      { name: "No-show", value: noShow },
    ].filter(item => item.value > 0);

    return { chartData: data };

  }, [appointments, dateRange, doctorId, doctors]);

  if (loading) {
    return (
      <Card className="h-full flex flex-col">
        <CardHeader>
          <Skeleton className="h-6 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
        </CardHeader>
        <CardContent className="flex-grow flex items-center justify-center">
          <Skeleton className="h-48 w-48 rounded-full" />
        </CardContent>
        <CardFooter>
          <Skeleton className="h-6 w-full" />
        </CardFooter>
      </Card>
    )
  }

  return (
    <Card className="h-full flex flex-col">
      <CardHeader>
        <CardTitle>Appointment Overview</CardTitle>
        <CardDescription>Status of appointments in the selected period.</CardDescription>
      </CardHeader>
      <CardContent className="flex-grow flex items-center justify-center p-0">
        {chartData.length > 0 ? (
          <ResponsiveContainer width="100%" height={250}>
            <PieChart>
              <Tooltip
                contentStyle={{
                  background: "hsl(var(--background))",
                  borderRadius: "var(--radius)",
                  border: "1px solid hsl(var(--border))",
                }}
                labelFormatter={(value) => statusLabels[value as string]}
              />
              <Pie
                data={chartData}
                cx="50%"
                cy="50%"
                labelLine={false}
                outerRadius={100}
                innerRadius={70}
                paddingAngle={5}
                dataKey="value"
                nameKey="name"
              >
                {chartData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={COLORS[entry.name as keyof typeof COLORS]} />
                ))}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
        ) : (
          <p className="text-sm text-muted-foreground">No appointment data for this period.</p>
        )}
      </CardContent>
      {chartData.length > 0 && (
        <CardFooter className="flex-col gap-4 text-sm pt-4">
          <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
            {ALL_STATUSES.map(status => (
              <div key={status} className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: COLORS[status as keyof typeof COLORS] }} />
                <span className="text-muted-foreground">{statusLabels[status]}</span>
              </div>
            ))}
          </div>
        </CardFooter>
      )}
    </Card>
  );
}
