

"use client";

import { useEffect, useState } from "react";
import { collection, getDocs, doc, getDoc, query, where } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/firebase";
import type { Appointment, Doctor, Patient } from "@/lib/types";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { 
    Users, 
    Stethoscope, 
    XCircle,
    CheckCircle,
    CalendarClock,
} from "lucide-react";
import { isFuture, parse, isPast, isWithinInterval, subDays, differenceInDays, startOfDay, isToday } from "date-fns";
import type { DateRange } from "react-day-picker";
import { cn } from "@/lib/utils";


const iconMap: { [key: string]: { component: React.ElementType, color: string } } = {
    "Total Patients": { component: Users, color: "text-cyan-500" },
    "Total Doctors": { component: Stethoscope, color: "text-fuchsia-500" },
    "Cancelled": { component: XCircle, color: "text-red-500" },
    "Completed Appointments": { component: CheckCircle, color: "text-green-500" },
    "Total Revenue": { component: () => <span className="font-bold">₹</span>, color: "text-blue-500" },
    "Upcoming": { component: CalendarClock, color: "text-amber-500" },
};


type OverviewStatsProps = {
  dateRange: DateRange | undefined;
  doctorId?: string;
};

type Stat = {
    title: string;
    value: string | number;
    icon: string;
    change?: string;
    changeType?: 'increase' | 'decrease';
}


export default function OverviewStats({ dateRange, doctorId }: OverviewStatsProps) {
  const auth = useAuth();
  const [stats, setStats] = useState<Stat[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!auth.currentUser || !dateRange?.from) return;

    const fetchStats = async () => {
      try {
        setLoading(true);

        const userDocRef = doc(db, "users", auth.currentUser!.uid);
        const userDocSnap = await getDoc(userDocRef);
        const clinicId = userDocSnap.data()?.clinicId;

        if (!clinicId) {
          setLoading(false);
          return;
        }

        const appointmentsQuery = query(collection(db, "appointments"), where("clinicId", "==", clinicId));
        const doctorsQuery = query(collection(db, "doctors"), where("clinicId", "==", clinicId));
        const patientsQuery = query(collection(db, "patients")); // Patients are global

        const [appointmentsSnapshot, doctorsSnapshot, patientsSnapshot] = await Promise.all([
          getDocs(appointmentsQuery),
          getDocs(doctorsQuery),
          getDocs(patientsQuery)
        ]);

        let allAppointments = appointmentsSnapshot.docs.map(doc => doc.data() as Appointment);
        const allDoctors = doctorsSnapshot.docs.map(doc => ({id: doc.id, ...doc.data()}) as Doctor);
        
        if (doctorId) {
            const doctor = allDoctors.find(d => d.id === doctorId);
            if (doctor) {
                allAppointments = allAppointments.filter(apt => apt.doctor === doctor.name);
            }
        }

        // --- Period Calculation ---
        const now = new Date();
        const currentFrom = dateRange?.from || subDays(now, 6);
        const currentTo = dateRange?.to || now;
        const diff = differenceInDays(currentTo, currentFrom);
        const prevFrom = subDays(currentFrom, diff + 1);
        const prevTo = subDays(currentTo, diff + 1);

        const getStatsForPeriod = (from: Date, to: Date) => {
            const periodAppointments = allAppointments.filter(apt => {
                try {
                    const aptDate = parse(apt.date, 'd MMMM yyyy', new Date());
                    return isWithinInterval(aptDate, { start: startOfDay(from), end: startOfDay(to) });
                } catch { return false; }
            });

            const uniquePatients = new Set(periodAppointments.map(apt => apt.patientId));
            
            const completedAppointments = periodAppointments.filter(apt => apt.status === 'Completed');
            const cancelledAppointments = periodAppointments.filter(apt => apt.status === 'Cancelled').length;

            let totalRevenue = 0;
            const completedByPatientAndDoctor: Record<string, Appointment[]> = {};

            // Group completed appointments by patient and doctor
            completedAppointments.forEach(apt => {
              const key = `${apt.patientId}-${apt.doctor}`;
              if (!completedByPatientAndDoctor[key]) {
                completedByPatientAndDoctor[key] = [];
              }
              completedByPatientAndDoctor[key].push(apt);
            });
            
            for (const key in completedByPatientAndDoctor) {
                const appointments = completedByPatientAndDoctor[key].sort((a,b) => parse(a.date, 'd MMMM yyyy', new Date()).getTime() - parse(b.date, 'd MMMM yyyy', new Date()).getTime());
                const doctor = allDoctors.find(d => d.name === appointments[0].doctor);
                const freeFollowUpDays = doctor?.freeFollowUpDays ?? 0;
                const consultationFee = doctor?.consultationFee ?? 0;

                for (let i = 0; i < appointments.length; i++) {
                    const currentApt = appointments[i];
                    const previousApt = i > 0 ? appointments[i-1] : null;

                    let isFree = false;
                    if (previousApt && freeFollowUpDays > 0) {
                        const daysBetween = differenceInDays(
                            parse(currentApt.date, 'd MMMM yyyy', new Date()),
                            parse(previousApt.date, 'd MMMM yyyy', new Date())
                        );
                        if(daysBetween <= freeFollowUpDays) {
                            isFree = true;
                        }
                    }
                    if (!isFree) {
                        totalRevenue += consultationFee;
                    }
                }
            }
            
            return {
                totalPatients: uniquePatients.size,
                completedAppointments: completedAppointments.length,
                cancelledAppointments,
                totalRevenue,
            };
        };

        const currentStats = getStatsForPeriod(currentFrom, currentTo);
        const previousStats = getStatsForPeriod(prevFrom, prevTo);

        const calculateChange = (current: number, previous: number) => {
            if (previous === 0) return current > 0 ? "+100%" : "0%";
            if (current === previous) return "0%";
            const change = ((current - previous) / previous) * 100;
            if (change > 0) return `+${change.toFixed(0)}%`;
            return `${change.toFixed(0)}%`;
        };
        
        const upcomingAppointments = allAppointments.filter(apt => {
            try {
                const aptDate = parse(apt.date, 'd MMMM yyyy', new Date());
                return (apt.status === 'Confirmed' || apt.status === 'Pending') && (isFuture(aptDate) || isToday(aptDate));
            } catch { return false; }
        }).length;
        
        const revenueChange = calculateChange(currentStats.totalRevenue, previousStats.totalRevenue);

        const allStats: Stat[] = [
          { 
              title: "Total Patients", 
              value: currentStats.totalPatients, 
              icon: "Total Patients",
              change: calculateChange(currentStats.totalPatients, previousStats.totalPatients),
              changeType: currentStats.totalPatients >= previousStats.totalPatients ? 'increase' : 'decrease'
          },
          ...(!doctorId ? [{ 
              title: "Total Doctors", 
              value: allDoctors.length, 
              icon: "Total Doctors" 
          }] : []),
          { 
              title: "Completed Appointments", 
              value: currentStats.completedAppointments, 
              icon: "Completed Appointments",
              change: calculateChange(currentStats.completedAppointments, previousStats.completedAppointments),
              changeType: currentStats.completedAppointments >= previousStats.completedAppointments ? 'increase' : 'decrease'
          },
          { 
              title: "Upcoming", 
              value: upcomingAppointments, 
              icon: "Upcoming" 
          },
          { 
              title: "Cancelled", 
              value: currentStats.cancelledAppointments, 
              icon: "Cancelled",
              change: calculateChange(currentStats.cancelledAppointments, previousStats.cancelledAppointments),
              changeType: currentStats.cancelledAppointments > previousStats.cancelledAppointments ? 'decrease' : 'increase' // Less is better
          },
          { 
              title: "Total Revenue", 
              value: `₹${currentStats.totalRevenue.toLocaleString()}`, 
              icon: "Total Revenue",
              change: revenueChange,
              changeType: currentStats.totalRevenue >= previousStats.totalRevenue ? 'increase' : 'decrease'
          },
        ];

        setStats(allStats);

      } catch (error) {
        console.error("Error fetching stats:", error);
      } finally {
        setLoading(false);
      }
    };

    fetchStats();
  }, [dateRange, doctorId, auth.currentUser]);

  const getCardClass = (title: string) => {
    switch (title) {
        case "Total Patients": return "bg-stat-red";
        default: return "shadow-lg shadow-[#dcf2eb]";
    }
  }
  
  if (loading) {
      return (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">
              {Array.from({ length: 6 }).map((_, i) => (
                  <Card key={i} className="animate-pulse">
                      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                          <div className="h-4 bg-muted rounded w-2/4"></div>
                          <div className="h-6 w-6 bg-muted rounded-full"></div>
                      </CardHeader>
                      <CardContent>
                          <div className="h-8 bg-muted rounded w-1/3 mt-2"></div>
                          <div className="h-4 bg-muted rounded w-1/4 mt-2"></div>
                      </CardContent>
                  </Card>
              ))}
          </div>
      );
  }

  return (
    <div className={cn("grid gap-6 sm:grid-cols-2 md:grid-cols-3", doctorId ? "lg:grid-cols-3 xl:grid-cols-5" : "lg:grid-cols-4 xl:grid-cols-6")}>
      {stats.map((stat) => {
        const { component: Icon, color } = iconMap[stat.icon as keyof typeof iconMap] || { component: Users, color: "text-muted-foreground" };
        return (
            <Card key={stat.title} className={cn("text-center", getCardClass(stat.title))}>
            <CardHeader className="flex flex-col items-center space-y-2 pb-2">
                <Icon className={cn("h-6 w-6", color)} />
                <CardTitle className="text-sm font-medium">{stat.title}</CardTitle>
            </CardHeader>
            <CardContent>
                <div className="text-2xl font-bold">{stat.value}</div>
                {stat.change && (
                  <p className={cn(
                    "text-xs text-muted-foreground",
                    stat.changeType === 'increase' ? 'text-emerald-500' : 'text-red-500'
                  )}>
                    {stat.change} from last period
                  </p>
                )}
            </CardContent>
            </Card>
        );
      })}
    </div>
  );
}
