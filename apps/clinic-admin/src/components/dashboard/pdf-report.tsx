"use client";

import { useEffect, useState, useMemo, useCallback } from "react";
import { collection, getDocs, doc, getDoc, query, where } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/firebase";
import type { Appointment, Doctor, Patient } from "@/lib/types";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Users,
  Stethoscope,
  XCircle,
  CheckCircle,
  CalendarClock,
  Building2,
  TrendingUp,
  TrendingDown,
  Minus
} from "lucide-react";
import { isFuture, parse, isPast, isWithinInterval, subDays, differenceInDays, startOfDay, isToday, format } from "date-fns";
import type { DateRange } from "react-day-picker";
import { cn } from "@/lib/utils";

type PDFReportProps = {
  dateRange: DateRange | undefined;
  selectedDate: Date;
};

type Stat = {
  title: string;
  value: string | number;
  icon: string;
  change?: string;
  changeType?: 'increase' | 'decrease' | 'neutral';
}

const iconMap: { [key: string]: { component: React.ElementType, color: string } } = {
  "Total Patients": { component: Users, color: "text-cyan-500" },
  "Total Doctors": { component: Stethoscope, color: "text-fuchsia-500" },
  "Cancelled": { component: XCircle, color: "text-red-500" },
  "Completed Appointments": { component: CheckCircle, color: "text-green-500" },
  "Total Revenue": { component: () => <span className="font-bold">₹</span>, color: "text-blue-500" },
  "Upcoming": { component: CalendarClock, color: "text-amber-500" },
};

export default function PDFReport({ dateRange, selectedDate }: PDFReportProps) {
  const auth = useAuth();
  const [stats, setStats] = useState<Stat[]>([]);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [clinicName, setClinicName] = useState<string>("");
  const [loading, setLoading] = useState(true);

  const fetchReportData = useCallback(async () => {
    if (!auth.currentUser) {
      console.log("No current user");
      setLoading(false);
      return;
    }

    if (!dateRange?.from) {
      console.log("No date range");
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      console.log("Fetching report data...");

      const userDocRef = doc(db, "users", auth.currentUser!.uid);
      const userDocSnap = await getDoc(userDocRef);
      const clinicId = userDocSnap.data()?.clinicId;

      if (!clinicId) {
        console.log("No clinic ID found");
        setLoading(false);
        return;
      }

      console.log("Clinic ID:", clinicId);

      // Fetch clinic name
      const clinicDocRef = doc(db, "clinics", clinicId);
      const clinicDoc = await getDoc(clinicDocRef);
      if (clinicDoc.exists()) {
        setClinicName(clinicDoc.data().name);
      }

      const appointmentsQuery = query(collection(db, "appointments"), where("clinicId", "==", clinicId));
      const doctorsQuery = query(collection(db, "doctors"), where("clinicId", "==", clinicId));

      const [appointmentsSnapshot, doctorsSnapshot] = await Promise.all([
        getDocs(appointmentsQuery),
        getDocs(doctorsQuery)
      ]);

      const allAppointments = appointmentsSnapshot.docs.map(doc => doc.data() as Appointment);
      const allDoctors = doctorsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }) as Doctor);

      // Filter appointments by date range
      const currentFrom = dateRange?.from || subDays(new Date(), 6);
      const currentTo = dateRange?.to || new Date();

      const periodAppointments = allAppointments.filter(apt => {
        try {
          // Exclude appointments cancelled by break
          if (apt.status === 'Cancelled' && apt.cancelledByBreak) {
            return false;
          }
          const aptDate = parse(apt.date, 'd MMMM yyyy', new Date());
          return isWithinInterval(aptDate, { start: startOfDay(currentFrom), end: startOfDay(currentTo) });
        } catch { return false; }
      });

      // Calculate stats
      const uniquePatients = new Set(periodAppointments.map(apt => apt.patientId));
      const completedAppointments = periodAppointments.filter(apt => apt.status === 'Completed');
      const cancelledAppointments = periodAppointments.filter(apt => apt.status === 'Cancelled').length;

      let totalRevenue = 0;
      const completedByPatientAndDoctor: Record<string, Appointment[]> = {};

      // Group completed appointments by patient and doctor for revenue calculation
      completedAppointments.forEach(apt => {
        const key = `${apt.patientId}-${apt.doctor}`;
        if (!completedByPatientAndDoctor[key]) {
          completedByPatientAndDoctor[key] = [];
        }
        completedByPatientAndDoctor[key].push(apt);
      });

      for (const key in completedByPatientAndDoctor) {
        const appointments = completedByPatientAndDoctor[key].sort((a, b) => parse(a.date, 'd MMMM yyyy', new Date()).getTime() - parse(b.date, 'd MMMM yyyy', new Date()).getTime());
        const doctor = allDoctors.find(d => d.name === appointments[0].doctor);
        const freeFollowUpDays = doctor?.freeFollowUpDays ?? 0;
        const consultationFee = doctor?.consultationFee ?? 0;

        for (let i = 0; i < appointments.length; i++) {
          const currentApt = appointments[i];
          const previousApt = i > 0 ? appointments[i - 1] : null;

          let isFree = false;
          if (previousApt && freeFollowUpDays > 0) {
            const daysBetween = differenceInDays(
              parse(currentApt.date, 'd MMMM yyyy', new Date()),
              parse(previousApt.date, 'd MMMM yyyy', new Date())
            );
            if (daysBetween <= freeFollowUpDays) {
              isFree = true;
            }
          }
          if (!isFree) {
            totalRevenue += consultationFee;
          }
        }
      }

      const upcomingAppointments = allAppointments.filter(apt => {
        try {
          const aptDate = parse(apt.date, 'd MMMM yyyy', new Date());
          return (apt.status === 'Confirmed' || apt.status === 'Pending') && (isFuture(aptDate) || isToday(aptDate));
        } catch { return false; }
      }).length;

      const allStats: Stat[] = [
        {
          title: "Total Patients",
          value: uniquePatients.size,
          icon: "Total Patients"
        },
        {
          title: "Total Doctors",
          value: allDoctors.length,
          icon: "Total Doctors"
        },
        {
          title: "Completed Appointments",
          value: completedAppointments.length,
          icon: "Completed Appointments"
        },
        {
          title: "Upcoming",
          value: upcomingAppointments,
          icon: "Upcoming"
        },
        {
          title: "Cancelled",
          value: cancelledAppointments,
          icon: "Cancelled"
        },
        {
          title: "Total Revenue",
          value: `₹${totalRevenue.toLocaleString()}`,
          icon: "Total Revenue"
        },
      ];

      console.log("Stats:", allStats);
      console.log("Appointments:", periodAppointments.length);
      console.log("Doctors:", allDoctors.length);

      setStats(allStats);
      setAppointments(periodAppointments);
      setDoctors(allDoctors);

    } catch (error) {
      console.error("Error fetching report data:", error);
    } finally {
      setLoading(false);
    }
  }, [auth.currentUser, dateRange]);

  useEffect(() => {
    fetchReportData();
  }, [fetchReportData]);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 p-8">
        <div className="max-w-6xl mx-auto">
          <div className="animate-pulse">
            <div className="h-8 bg-gray-300 rounded w-1/3 mb-4"></div>
            <div className="h-4 bg-gray-300 rounded w-1/4 mb-8"></div>
            <div className="grid grid-cols-3 gap-4 mb-8">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-24 bg-gray-300 rounded"></div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Debug info
  console.log("Rendering PDF Report - Loading:", loading, "Stats:", stats.length, "Appointments:", appointments.length);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-8 print:bg-white print:p-4">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="text-center mb-8 print:mb-6">
          <div className="flex items-center justify-center mb-4">
            <Building2 className="h-12 w-12 text-blue-600 mr-4" />
            <div>
              <h1 className="text-4xl font-bold text-gray-900 print:text-3xl">{clinicName || "Clinic Dashboard"}</h1>
              <p className="text-lg text-gray-600 print:text-base">Dashboard Report</p>
            </div>
          </div>
          <div className="flex items-center justify-center space-x-4 text-sm text-gray-500">
            <span>Report Period: {format(dateRange?.from || new Date(), 'MMM dd, yyyy')} - {format(dateRange?.to || new Date(), 'MMM dd, yyyy')}</span>
            <span>•</span>
            <span>Generated: {format(new Date(), 'MMM dd, yyyy hh:mm a')}</span>
          </div>
        </div>

        {/* Debug Info - Only show in development */}
        {process.env.NODE_ENV === 'development' && (
          <div className="mb-4 p-4 bg-yellow-100 border border-yellow-300 rounded print:hidden">
            <p className="text-sm text-yellow-800">
              Debug: Loading: {loading.toString()}, Stats: {stats.length}, Appointments: {appointments.length}, Doctors: {doctors.length}
            </p>
          </div>
        )}

        {/* Stats Grid */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-8 print:grid-cols-6 print:gap-2">
          {stats.length > 0 ? stats.map((stat) => {
            const { component: Icon, color } = iconMap[stat.icon as keyof typeof iconMap] || { component: Users, color: "text-muted-foreground" };
            return (
              <Card key={stat.title} className="text-center bg-white shadow-lg border-0 print:shadow-none print:border">
                <CardHeader className="flex flex-col items-center space-y-2 pb-2">
                  <Icon className={cn("h-6 w-6", color)} />
                  <CardTitle className="text-xs font-medium text-gray-600 print:text-xs">{stat.title}</CardTitle>
                </CardHeader>
                <CardContent className="pt-0">
                  <div className="text-xl font-bold text-gray-900 print:text-lg">{stat.value}</div>
                </CardContent>
              </Card>
            );
          }) : (
            <div className="col-span-full text-center py-8">
              <p className="text-gray-500">No data available for the selected date range</p>
            </div>
          )}
        </div>

        {/* Appointments Summary */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8 print:grid-cols-2 print:gap-4">
          {/* Recent Appointments */}
          <Card className="bg-white shadow-lg border-0 print:shadow-none print:border">
            <CardHeader>
              <CardTitle className="flex items-center text-lg font-semibold text-gray-900">
                <CalendarClock className="h-5 w-5 mr-2 text-blue-600" />
                Recent Appointments
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3 max-h-64 overflow-y-auto print:max-h-none print:overflow-visible">
                {appointments.slice(0, 10).map((apt, index) => (
                  <div key={index} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg print:bg-gray-100">
                    <div className="flex-1">
                      <p className="font-medium text-gray-900">{apt.patientName}</p>
                      <p className="text-sm text-gray-600">{apt.doctor}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-medium text-gray-900">{apt.time}</p>
                      <Badge
                        variant={apt.status === 'Completed' ? 'default' : apt.status === 'Cancelled' ? 'destructive' : 'secondary'}
                        className="text-xs"
                      >
                        {apt.status}
                      </Badge>
                    </div>
                  </div>
                ))}
                {appointments.length === 0 && (
                  <p className="text-center text-gray-500 py-4">No appointments in this period</p>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Doctors Status */}
          <Card className="bg-white shadow-lg border-0 print:shadow-none print:border">
            <CardHeader>
              <CardTitle className="flex items-center text-lg font-semibold text-gray-900">
                <Stethoscope className="h-5 w-5 mr-2 text-green-600" />
                Doctors Status
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {doctors.map((doctor) => (
                  <div key={doctor.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg print:bg-gray-100">
                    <div className="flex items-center">
                      <div className="w-10 h-10 bg-blue-100 rounded-full flex items-center justify-center mr-3">
                        <Stethoscope className="h-5 w-5 text-blue-600" />
                      </div>
                      <div>
                        <p className="font-medium text-gray-900">{doctor.name}</p>
                        <p className="text-sm text-gray-600">{doctor.specialty}</p>
                      </div>
                    </div>
                    <Badge
                      variant={doctor.consultationStatus === 'In' ? 'default' : 'secondary'}
                      className="text-xs"
                    >
                      {doctor.consultationStatus || 'Out'}
                    </Badge>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Footer */}
        <div className="text-center text-sm text-gray-500 border-t pt-4 print:pt-2">
          <p>This report was generated automatically by Kloqo Clinic Management System</p>
          <p className="mt-1">For support, contact your system administrator</p>
        </div>
      </div>
    </div>
  );
}
