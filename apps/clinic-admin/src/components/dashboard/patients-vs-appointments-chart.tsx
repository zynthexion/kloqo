
"use client";

import { useEffect, useState, useMemo } from "react";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card";
import { Skeleton } from "../ui/skeleton";
import type { DateRange } from "react-day-picker";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend
} from 'recharts';
import { collection, getDocs, query, where, documentId } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/firebase";
import type { Appointment, Doctor, Patient } from "@/lib/types";
import {
  format,
  eachDayOfInterval,
  eachMonthOfInterval,
  isWithinInterval,
  parse,
  differenceInDays,
  startOfDay,
  startOfMonth,
  endOfMonth,
} from "date-fns";


type ChartProps = {
  dateRange: DateRange | undefined;
};


export default function PatientsVsAppointmentsChart({ dateRange }: ChartProps) {
  const auth = useAuth();
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!auth.currentUser) {
      setLoading(false);
      return;
    }

    const fetchData = async () => {
      setLoading(true);
      try {
        const userDocRef = collection(db, "users");
        const userQuery = query(userDocRef, where("uid", "==", auth.currentUser!.uid));
        const userSnapshot = await getDocs(userQuery);
        if (userSnapshot.empty) {
          setLoading(false);
          return;
        }
        const clinicId = userSnapshot.docs[0].data().clinicId;
        if (!clinicId) {
          setLoading(false);
          return;
        }

        const appointmentsQuery = query(collection(db, "appointments"), where("clinicId", "==", clinicId));
        const doctorsQuery = query(collection(db, "doctors"), where("clinicId", "==", clinicId));
        const patientsQuery = query(collection(db, "patients"), where("clinicIds", "array-contains", clinicId));

        const [appointmentsSnapshot, doctorsSnapshot, patientsSnapshot] = await Promise.all([
          getDocs(appointmentsQuery),
          getDocs(doctorsQuery),
          getDocs(patientsQuery),
        ]);

        setAppointments(appointmentsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Appointment)));
        setDoctors(doctorsSnapshot.docs.map(doc => doc.data() as Doctor));
        setPatients(patientsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Patient)));
      } catch (error) {
        console.error("Error fetching chart data:", error);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [auth.currentUser]);

  const chartData = useMemo(() => {
    if (!dateRange?.from || !dateRange?.to || appointments.length === 0 || patients.length === 0) return [];

    // Filter out cancelled-by-break appointments globally for this chart
    const validAppointments = appointments.filter(apt => !(apt.status === 'Cancelled' && apt.cancelledByBreak));

    const from = startOfDay(dateRange.from);
    const to = startOfDay(dateRange.to);
    const dayCount = differenceInDays(to, from);

    const isMonthlyView = dayCount > 60;

    // Create a map of patientId to their first appointment date
    const patientFirstVisitMap = new Map<string, Date>();

    // Sort all appointments once to find the first visit date efficiently
    const allSortedAppointments = [...validAppointments].sort((a, b) => parse(a.date, 'd MMMM yyyy', new Date()).getTime() - parse(b.date, 'd MMMM yyyy', new Date()).getTime());

    for (const appt of allSortedAppointments) {
      if (!patientFirstVisitMap.has(appt.patientId)) {
        patientFirstVisitMap.set(appt.patientId, parse(appt.date, 'd MMMM yyyy', new Date()));
      }
    }

    const processPeriod = (startDate: Date, endDate: Date) => {
      const periodAppointments = validAppointments.filter(apt => {
        try {
          return isWithinInterval(parse(apt.date, 'd MMMM yyyy', new Date()), { start: startDate, end: endDate });
        } catch { return false; }
      });

      const newPatients = new Set<string>();
      const returningPatients = new Set<string>();

      for (const appt of periodAppointments) {
        const firstVisitDate = patientFirstVisitMap.get(appt.patientId);
        if (firstVisitDate && isWithinInterval(firstVisitDate, { start: startDate, end: endDate })) {
          newPatients.add(appt.patientId);
        } else {
          returningPatients.add(appt.patientId);
        }
      }

      const completed = periodAppointments.filter(apt => apt.status === 'Completed');
      let revenue = 0;
      completed.forEach(apt => {
        const doctor = doctors.find(d => d.name === apt.doctor);
        if (doctor) revenue += doctor.consultationFee || 0;
      });

      return {
        newPatients: newPatients.size,
        returningPatients: returningPatients.size,
        revenue,
      };
    }

    if (isMonthlyView) {
      const months = eachMonthOfInterval({ start: from, end: to });
      return months.map(monthStart => {
        const monthEnd = endOfMonth(monthStart);
        const stats = processPeriod(monthStart, monthEnd);
        return {
          month: format(monthStart, 'MMM yyyy'),
          ...stats,
        };
      });
    } else {
      const days = eachDayOfInterval({ start: from, end: to });
      return days.map(day => {
        const stats = processPeriod(day, day);
        return {
          month: format(day, 'MMM d'),
          ...stats,
        };
      });
    }

  }, [dateRange, appointments, patients, doctors]);

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
        <CardTitle>Analytics Overview</CardTitle>
        <CardDescription>Patient visits and revenue over time.</CardDescription>
      </CardHeader>
      <CardContent className="flex-grow flex items-center justify-center pr-6">
        {chartData.length > 0 ? (
          <ResponsiveContainer width="100%" height={250}>
            <AreaChart data={chartData} margin={{ top: 10, right: 0, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id="colorNewPatients" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="hsl(var(--chart-1))" stopOpacity={0.8} />
                  <stop offset="95%" stopColor="hsl(var(--chart-1))" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="colorReturningPatients" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="hsl(var(--chart-2))" stopOpacity={0.8} />
                  <stop offset="95%" stopColor="hsl(var(--chart-2))" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="colorRevenue" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="hsl(var(--chart-3))" stopOpacity={0.8} />
                  <stop offset="95%" stopColor="hsl(var(--chart-3))" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border) / 0.5)" />
              <XAxis dataKey="month" tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }} tickLine={false} axisLine={false} />
              <YAxis tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }} tickLine={false} axisLine={false} />
              <Tooltip
                contentStyle={{
                  background: "hsl(var(--background))",
                  borderRadius: "var(--radius)",
                  border: "1px solid hsl(var(--border))",
                }}
              />
              <Legend
                verticalAlign="top"
                align="right"
                iconType="circle"
                iconSize={8}
                wrapperStyle={{ top: -10, right: 0 }}
              />
              <Area type="monotone" dataKey="newPatients" stroke="hsl(var(--chart-1))" fill="url(#colorNewPatients)" strokeWidth={2} name="New Patients" />
              <Area type="monotone" dataKey="returningPatients" stroke="hsl(var(--chart-2))" fill="url(#colorReturningPatients)" strokeWidth={2} name="Returning Patients" />
              <Area type="monotone" dataKey="revenue" stroke="hsl(var(--chart-3))" fill="url(#colorRevenue)" strokeWidth={2} name="Revenue (₹)" />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center text-muted-foreground space-y-4">
            <p className="text-sm">Not enough data to display chart for this period.</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
