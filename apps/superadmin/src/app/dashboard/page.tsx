'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { fetchAllClinics, fetchAllPatients, fetchAllAppointments, calculateGrowthTrends } from '@/lib/analytics';
import { calculateGrowthPercentage, formatGrowthPercentage, calculate30DayRetention, calculateMAU } from '@/lib/metrics';
import { TrendingUp, TrendingDown, Users, Building2, Calendar, Activity } from 'lucide-react';
import type { Clinic, Patient, Appointment } from '@/lib/analytics';

export default function OverviewDashboard() {
  const [loading, setLoading] = useState(true);
  const [clinics, setClinics] = useState<Clinic[]>([]);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [stats, setStats] = useState({
    totalClinics: 0,
    totalPatients: 0,
    totalAppointments: 0,
    monthlyAppointments: 0,
    retentionRate: 0,
    mau: 0,
  });

  useEffect(() => {
    const loadData = async () => {
      setLoading(true);
      try {
        const [clinicsData, patientsData, appointmentsData] = await Promise.all([
          fetchAllClinics(),
          fetchAllPatients(),
          fetchAllAppointments(),
        ]);

        setClinics(clinicsData);
        setPatients(patientsData);
        setAppointments(appointmentsData);

        // Calculate current month appointments
        const now = new Date();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
        
        const monthAppointments = appointmentsData.filter((apt) => {
          let aptDate: Date | null = null;
          if (apt.createdAt) {
            if (apt.createdAt.toDate) {
              aptDate = apt.createdAt.toDate();
            } else {
              aptDate = new Date(apt.createdAt);
            }
          }
          if (!aptDate && apt.date) {
            // Parse "15 October 2024" format
            try {
              const parts = apt.date.toLowerCase().split(' ');
              const months: Record<string, number> = {
                'january': 0, 'february': 1, 'march': 2, 'april': 3,
                'may': 4, 'june': 5, 'july': 6, 'august': 7,
                'september': 8, 'october': 9, 'november': 10, 'december': 11
              };
              if (parts.length === 3) {
                const day = parseInt(parts[0]);
                const month = months[parts[1]];
                const year = parseInt(parts[2]);
                if (!isNaN(day) && month !== undefined && !isNaN(year)) {
                  aptDate = new Date(year, month, day);
                }
              }
            } catch (e) {
              // Ignore
            }
          }
          
          if (!aptDate) return false;
          return aptDate >= monthStart && aptDate <= monthEnd;
        });

        // Calculate previous month for comparison
        const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const prevMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
        
        const prevMonthAppointments = appointmentsData.filter((apt) => {
          let aptDate: Date | null = null;
          if (apt.createdAt) {
            if (apt.createdAt.toDate) {
              aptDate = apt.createdAt.toDate();
            } else {
              aptDate = new Date(apt.createdAt);
            }
          }
          if (!aptDate) return false;
          return aptDate >= prevMonthStart && aptDate <= prevMonthEnd;
        });

        // Calculate stats
        const retentionRate = calculate30DayRetention(patientsData, appointmentsData);
        const mau = calculateMAU(appointmentsData, now);

        setStats({
          totalClinics: clinicsData.length,
          totalPatients: patientsData.length,
          totalAppointments: appointmentsData.length,
          monthlyAppointments: monthAppointments.length,
          retentionRate,
          mau,
        });

        // Store previous month for growth calculation
        (window as any).prevMonthAppointments = prevMonthAppointments.length;
      } catch (error) {
        console.error('Error loading dashboard data:', error);
      } finally {
        setLoading(false);
      }
    };

    loadData();
  }, []);

  const prevMonthAppointments = (window as any).prevMonthAppointments || 0;
  const appointmentGrowth = formatGrowthPercentage(stats.monthlyAppointments, prevMonthAppointments);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto mb-4" />
          <p className="text-muted-foreground">Loading dashboard...</p>
        </div>
      </div>
    );
  }

  const StatCard = ({
    title,
    value,
    description,
    icon: Icon,
    trend,
  }: {
    title: string;
    value: string | number;
    description?: string;
    icon: any;
    trend?: { value: string; isPositive: boolean };
  }) => (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        {description && (
          <p className="text-xs text-muted-foreground mt-1">
            {description}
            {trend && (
              <span className={`ml-2 flex items-center gap-1 ${trend.isPositive ? 'text-green-600' : 'text-red-600'}`}>
                {trend.isPositive ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                {trend.value}
              </span>
            )}
          </p>
        )}
      </CardContent>
    </Card>
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Overview Dashboard</h1>
        <p className="text-muted-foreground mt-1">Key metrics and growth trends</p>
      </div>

      {/* Key Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <StatCard
          title="Total Clinics"
          value={stats.totalClinics}
          description="Active clinics on platform"
          icon={Building2}
        />
        <StatCard
          title="Total Patients"
          value={stats.totalPatients.toLocaleString()}
          description="Registered patients"
          icon={Users}
        />
        <StatCard
          title="Monthly Appointments"
          value={stats.monthlyAppointments.toLocaleString()}
          description="This month"
          icon={Calendar}
          trend={{
            value: appointmentGrowth,
            isPositive: stats.monthlyAppointments >= prevMonthAppointments,
          }}
        />
        <StatCard
          title="Total Appointments"
          value={stats.totalAppointments.toLocaleString()}
          description="All time"
          icon={Activity}
        />
        <StatCard
          title="30-Day Retention"
          value={`${stats.retentionRate.toFixed(1)}%`}
          description="Patients who return within 30 days"
          icon={Users}
        />
        <StatCard
          title="Monthly Active Users"
          value={stats.mau.toLocaleString()}
          description="Patients with activity this month"
          icon={Activity}
        />
      </div>

      {/* Quick Stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Recent Growth</CardTitle>
            <CardDescription>Last 90 days trend</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-sm text-muted-foreground">
              <p>Growth trends will be displayed here</p>
              <p className="mt-2 text-xs">Chart component to be added</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Platform Health</CardTitle>
            <CardDescription>Overall system status</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <div className="flex justify-between items-center">
                <span className="text-sm">Clinics Active</span>
                <span className="text-sm font-semibold">{clinics.filter(c => c.onboardingStatus === 'Completed').length} / {stats.totalClinics}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm">Average Appointments/Clinic</span>
                <span className="text-sm font-semibold">
                  {stats.totalClinics > 0 ? Math.round(stats.totalAppointments / stats.totalClinics) : 0}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm">Average Appointments/Patient</span>
                <span className="text-sm font-semibold">
                  {stats.totalPatients > 0 ? (stats.totalAppointments / stats.totalPatients).toFixed(1) : 0}
                </span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
