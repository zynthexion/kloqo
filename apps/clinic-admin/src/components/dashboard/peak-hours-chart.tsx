
"use client";

import { useEffect, useState, useMemo } from "react";
import { collection, getDocs, query, where, getDoc, doc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/firebase";
import type { Appointment } from "@/lib/types";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import type { DateRange } from "react-day-picker";
import { isWithinInterval, parse, format, getHours } from "date-fns";
import { Skeleton } from "../ui/skeleton";

type PeakHoursChartProps = {
  dateRange: DateRange | undefined;
};

export default function PeakHoursChart({ dateRange }: PeakHoursChartProps) {
  const auth = useAuth();
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!auth.currentUser) {
      setLoading(false);
      return;
    }
    const fetchAppointments = async () => {
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
        const appointmentsList = appointmentsSnapshot.docs.map(doc => doc.data() as Appointment);
        setAppointments(appointmentsList);
      } catch (e) {
        console.error("Failed to fetch appointments for peak hours chart", e);
      } finally {
        setLoading(false);
      }
    };
    fetchAppointments();
  }, [auth.currentUser]);

  const chartData = useMemo(() => {
    if (!dateRange?.from) return [];

    const from = dateRange.from;
    const to = dateRange.to || from;

    const rangeAppointments = appointments.filter(apt => {
      try {
        const aptDate = parse(apt.date, 'd MMMM yyyy', new Date());
        return isWithinInterval(aptDate, { start: from, end: to });
      } catch {
        return false;
      }
    });

    const hourlyCounts: { [key: number]: number } = {};
    for (let i = 0; i < 24; i++) {
        hourlyCounts[i] = 0;
    }

    rangeAppointments.forEach(apt => {
      try {
        const aptTime = parse(apt.time, 'hh:mm a', new Date());
        const hour = getHours(aptTime);
        hourlyCounts[hour]++;
      } catch {
        // Ignore parsing errors
      }
    });

    const data = Object.entries(hourlyCounts)
      .map(([hour, count]) => ({
        hour: parseInt(hour),
        name: format(new Date(0, 0, 0, parseInt(hour)), 'ha'),
        count: count,
      }))
      .sort((a, b) => a.hour - b.hour)
      .filter(d => d.hour >= 6 && d.hour <= 22); // Filter for typical business hours

    // Only show hours with data, but ensure we have some data to display
    const filteredData = data.filter(d => d.count > 0);
    return filteredData.length > 0 ? data : [];

  }, [appointments, dateRange]);
  
  if (loading) {
    return (
        <Card className="h-full flex flex-col">
            <CardHeader>
                <Skeleton className="h-6 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
            </CardHeader>
            <CardContent className="flex-grow flex items-center justify-center">
                 <Skeleton className="h-full w-full" />
            </CardContent>
        </Card>
    );
  }

  return (
    <Card className="h-full flex flex-col">
      <CardHeader>
        <CardTitle>Peak Hours</CardTitle>
        <CardDescription>Appointment distribution by hour.</CardDescription>
      </CardHeader>
      <CardContent className="flex-grow flex items-center justify-center pr-6">
        {chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={250}>
                <BarChart data={chartData} margin={{ top: 10, right: 0, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border) / 0.5)" />
                    <XAxis dataKey="name" tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }} tickLine={false} axisLine={false} />
                    <YAxis allowDecimals={false} tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }} tickLine={false} axisLine={false} />
                    <Tooltip
                        contentStyle={{
                            background: "hsl(var(--background))",
                            borderRadius: "var(--radius)",
                            border: "1px solid hsl(var(--border))",
                        }}
                    />
                    <Bar dataKey="count" fill="hsl(var(--chart-1))" name="Appointments" radius={[4, 4, 0, 0]} />
                </BarChart>
            </ResponsiveContainer>
        ) : (
             <div className="w-full h-full flex flex-col items-center justify-center text-muted-foreground space-y-4">
                 <p className="text-sm">No appointment data to display for this period.</p>
            </div>
        )}
      </CardContent>
    </Card>
  );
}
