'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { doc, getDoc, collection, getDocs, query, where } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { fetchAllAppointments } from '@/lib/analytics';
import { firestoreTimestampToDate, parseDateString } from '@/lib/metrics';
import { format, subDays, parse, isWithinInterval, startOfDay, isFuture, isToday, differenceInDays, getHours } from 'date-fns';
import { ArrowLeft, Building2, MapPin, Mail, FileText, ExternalLink, CheckCircle, Clock, XCircle, Calendar as CalendarIcon } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, BarChart, Bar, PieChart, Pie, Cell, AreaChart, Area } from 'recharts';
import type { Clinic, Appointment } from '@/lib/analytics';

interface Doctor {
  id: string;
  name: string;
  consultationFee?: number;
  freeFollowUpDays?: number;
}

export default function ClinicDetailsPage() {
  const params = useParams();
  const router = useRouter();
  const clinicId = params.id as string;

  const [loading, setLoading] = useState(true);
  const [clinic, setClinic] = useState<Clinic | null>(null);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [dateRange, setDateRange] = useState({
    from: subDays(new Date(), 6),
    to: new Date(),
  });
  const [stats, setStats] = useState({
    totalPatients: 0,
    totalDoctors: 0,
    completedAppointments: 0,
    upcomingAppointments: 0,
    cancelledAppointments: 0,
    totalRevenue: 0,
  });

  useEffect(() => {
    const loadClinicData = async () => {
      if (!clinicId) return;

      setLoading(true);
      try {
        // Fetch clinic data
        const clinicDoc = await getDoc(doc(db, 'clinics', clinicId));
        if (!clinicDoc.exists()) {
          router.push('/dashboard/clinics');
          return;
        }

        const clinicData = { id: clinicDoc.id, ...clinicDoc.data() } as Clinic;
        setClinic(clinicData);

        // Fetch appointments
        const allAppointments = await fetchAllAppointments();
        const clinicAppointments = allAppointments.filter(apt => apt.clinicId === clinicId);
        setAppointments(clinicAppointments);

        // Fetch doctors
        const doctorsQuery = query(collection(db, 'doctors'), where('clinicId', '==', clinicId));
        const doctorsSnapshot = await getDocs(doctorsQuery);
        const doctorsList = doctorsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Doctor));
        setDoctors(doctorsList);

        // Calculate stats for date range
        const periodAppointments = clinicAppointments.filter(apt => {
          try {
            let aptDate: Date | null = null;
            if (apt.createdAt) {
              aptDate = apt.createdAt.toDate ? apt.createdAt.toDate() : new Date(apt.createdAt);
            } else if (apt.date) {
              aptDate = parseDateString(apt.date);
            }
            if (!aptDate) return false;
            return isWithinInterval(aptDate, { start: startOfDay(dateRange.from), end: startOfDay(dateRange.to) });
          } catch {
            return false;
          }
        });

        const uniquePatients = new Set(periodAppointments.map(apt => apt.patientId));
        const completed = periodAppointments.filter(apt => apt.status === 'Completed');
        const cancelled = periodAppointments.filter(apt => apt.status === 'Cancelled').length;
        const upcoming = clinicAppointments.filter(apt => {
          try {
            let aptDate: Date | null = null;
            if (apt.createdAt) {
              aptDate = apt.createdAt.toDate ? apt.createdAt.toDate() : new Date(apt.createdAt);
            } else if (apt.date) {
              aptDate = parseDateString(apt.date);
            }
            if (!aptDate) return false;
            return (apt.status === 'Confirmed' || apt.status === 'Pending') && (isFuture(aptDate) || isToday(aptDate));
          } catch {
            return false;
          }
        }).length;

        // Calculate revenue
        let revenue = 0;
        const completedByPatientAndDoctor: Record<string, Appointment[]> = {};

        completed.forEach(apt => {
          const key = `${apt.patientId}-${apt.doctor}`;
          if (!completedByPatientAndDoctor[key]) {
            completedByPatientAndDoctor[key] = [];
          }
          completedByPatientAndDoctor[key].push(apt);
        });

        Object.values(completedByPatientAndDoctor).forEach((appts) => {
          const sortedAppts = appts.sort((a, b) => {
            const dateA = parseDateString(a.date);
            const dateB = parseDateString(b.date);
            return dateA.getTime() - dateB.getTime();
          });

          const doctor = doctorsList.find(d => d.name === sortedAppts[0].doctor);
          const freeFollowUpDays = doctor?.freeFollowUpDays ?? 0;
          const consultationFee = doctor?.consultationFee ?? 0;

          sortedAppts.forEach((apt, index) => {
            if (index === 0 || freeFollowUpDays === 0) {
              revenue += consultationFee;
            } else {
              const prevDate = parseDateString(sortedAppts[index - 1].date);
              const currentDate = parseDateString(apt.date);
              const daysDiff = Math.floor((currentDate.getTime() - prevDate.getTime()) / (1000 * 60 * 60 * 24));

              if (daysDiff > freeFollowUpDays) {
                revenue += consultationFee;
              }
            }
          });
        });

        setStats({
          totalPatients: uniquePatients.size,
          totalDoctors: doctorsList.length,
          completedAppointments: completed.length,
          upcomingAppointments: upcoming,
          cancelledAppointments: cancelled,
          totalRevenue: revenue,
        });
      } catch (error) {
        console.error('Error loading clinic data:', error);
      } finally {
        setLoading(false);
      }
    };

    loadClinicData();
  }, [clinicId, dateRange.from, dateRange.to, router]);

  // Chart data
  const appointmentStatusData = [
    { name: 'Completed', value: stats.completedAppointments, color: '#22c55e' },
    { name: 'Upcoming', value: stats.upcomingAppointments, color: '#f59e0b' },
    { name: 'Cancelled', value: stats.cancelledAppointments, color: '#ef4444' },
  ].filter(item => item.value > 0);

  // Daily appointments trend for selected date range
  const dailyTrend = (() => {
    const trends: Array<{ date: string; count: number }> = [];
    const days = differenceInDays(dateRange.to, dateRange.from);
    const maxDays = days > 60 ? 30 : days;

    const step = Math.max(1, Math.floor(days / maxDays));
    let currentDay = new Date(dateRange.from);
    let dayIndex = 0;

    while (currentDay <= dateRange.to && dayIndex < maxDays) {
      const dayStart = startOfDay(currentDay);
      const dayEnd = new Date(dayStart);
      dayEnd.setHours(23, 59, 59, 999);

      const dayAppointments = appointments.filter(apt => {
        try {
          let aptDate: Date | null = null;
          if (apt.createdAt) {
            aptDate = apt.createdAt.toDate ? apt.createdAt.toDate() : new Date(apt.createdAt);
          } else if (apt.date) {
            aptDate = parseDateString(apt.date);
          }
          if (!aptDate) return false;
          return aptDate >= dayStart && aptDate <= dayEnd;
        } catch {
          return false;
        }
      });

      trends.push({
        date: format(currentDay, days > 60 ? 'MMM d' : 'MMM d'),
        count: dayAppointments.length
      });

      // Skip days if range is large
      currentDay.setDate(currentDay.getDate() + step);
      dayIndex++;
    }

    return trends;
  })();

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto mb-4" />
          <p className="text-muted-foreground">Loading clinic details...</p>
        </div>
      </div>
    );
  }

  if (!clinic) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">Clinic not found</p>
        <Button onClick={() => router.push('/dashboard/clinics')} className="mt-4">
          Back to Clinics
        </Button>
      </div>
    );
  }

  const regDate = clinic.registrationDate ? firestoreTimestampToDate(clinic.registrationDate) : null;
  const planStartDate = clinic.planStartDate ? firestoreTimestampToDate(clinic.planStartDate) : null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="outline" size="sm" onClick={() => router.push('/dashboard/clinics')}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back
          </Button>
          <div>
            <h1 className="text-3xl font-bold">{clinic.name}</h1>
            <p className="text-muted-foreground mt-1">Clinic Details & Performance</p>
          </div>
        </div>
        {clinic.logoUrl && (
          <img
            src={clinic.logoUrl}
            alt={clinic.name}
            className="w-20 h-20 object-cover rounded-lg border"
          />
        )}
      </div>

      {/* Clinic Info */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Clinic Information</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="text-sm text-muted-foreground mb-1">Registration Status</p>
              {clinic.registrationStatus === 'Approved' ? (
                <Badge className="bg-green-100 text-green-800"><CheckCircle className="h-3 w-3 mr-1" />Approved</Badge>
              ) : clinic.registrationStatus === 'Pending' ? (
                <Badge className="bg-yellow-100 text-yellow-800"><Clock className="h-3 w-3 mr-1" />Pending</Badge>
              ) : (
                <Badge className="bg-red-100 text-red-800"><XCircle className="h-3 w-3 mr-1" />Rejected</Badge>
              )}
            </div>
            <div>
              <p className="text-sm text-muted-foreground mb-1">Onboarding Status</p>
              {clinic.onboardingStatus === 'Completed' ? (
                <Badge className="bg-blue-100 text-blue-800"><CheckCircle className="h-3 w-3 mr-1" />Completed</Badge>
              ) : (
                <Badge className="bg-orange-100 text-orange-800"><Clock className="h-3 w-3 mr-1" />Pending</Badge>
              )}
            </div>
            <div>
              <p className="text-sm text-muted-foreground mb-1">Type</p>
              <p className="font-medium">{clinic.type || 'N/A'}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground mb-1 flex items-center gap-1">
                <Mail className="h-4 w-4" />
                Owner Email
              </p>
              <p className="font-medium">{clinic.ownerEmail || 'N/A'}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground mb-1">Registration Number</p>
              <p className="font-medium">{clinic.clinicRegNumber || 'N/A'}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground mb-1">Plan</p>
              <p className="font-medium">{clinic.plan || 'N/A'}</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Location</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="text-sm text-muted-foreground mb-1 flex items-center gap-1">
                <MapPin className="h-4 w-4" />
                Address
              </p>
              <p className="font-medium">{clinic.address || 'N/A'}</p>
              {clinic.addressDetails && (
                <p className="text-sm text-muted-foreground mt-1">
                  {[
                    clinic.addressDetails.line1,
                    clinic.addressDetails.line2,
                    clinic.addressDetails.city,
                    clinic.addressDetails.district,
                    clinic.addressDetails.state,
                    clinic.addressDetails.pincode
                  ].filter(Boolean).join(', ')}
                </p>
              )}
            </div>
            {clinic.mapsLink && (
              <div>
                <a
                  href={clinic.mapsLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-blue-600 hover:underline flex items-center gap-1"
                >
                  <ExternalLink className="h-4 w-4" />
                  View on Maps
                </a>
              </div>
            )}
            {clinic.latitude && clinic.longitude && (
              <div>
                <p className="text-sm text-muted-foreground mb-1">Coordinates</p>
                <p className="text-sm font-medium">
                  {clinic.latitude.toFixed(6)}, {clinic.longitude.toFixed(6)}
                </p>
              </div>
            )}
            <div>
              <p className="text-sm text-muted-foreground mb-1">Registration Date</p>
              <p className="font-medium">{regDate ? format(regDate, 'PP') : 'N/A'}</p>
            </div>
            {planStartDate && (
              <div>
                <p className="text-sm text-muted-foreground mb-1">Plan Start Date</p>
                <p className="font-medium">{format(planStartDate, 'PP')}</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Date Range Selector */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Performance Metrics</CardTitle>
              <CardDescription>
                {format(dateRange.from, 'MMM d, yyyy')} - {format(dateRange.to, 'MMM d, yyyy')}
              </CardDescription>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDateRange({ from: subDays(new Date(), 6), to: new Date() })}
              >
                Last 7 Days
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDateRange({ from: subDays(new Date(), 29), to: new Date() })}
              >
                Last 30 Days
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDateRange({ from: subDays(new Date(), 89), to: new Date() })}
              >
                Last 90 Days
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            <div>
              <p className="text-sm text-muted-foreground">Total Patients</p>
              <p className="text-2xl font-bold">{stats.totalPatients}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Total Doctors</p>
              <p className="text-2xl font-bold">{stats.totalDoctors}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Completed</p>
              <p className="text-2xl font-bold text-green-600">{stats.completedAppointments}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Upcoming</p>
              <p className="text-2xl font-bold text-amber-600">{stats.upcomingAppointments}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Cancelled</p>
              <p className="text-2xl font-bold text-red-600">{stats.cancelledAppointments}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Total Revenue</p>
              <p className="text-2xl font-bold text-blue-600">₹{stats.totalRevenue.toLocaleString()}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Appointment Status</CardTitle>
          </CardHeader>
          <CardContent>
            {appointmentStatusData.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie
                    data={appointmentStatusData}
                    cx="50%"
                    cy="50%"
                    labelLine={false}
                    label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                    outerRadius={80}
                    fill="#8884d8"
                    dataKey="value"
                  >
                    {appointmentStatusData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-[300px] text-muted-foreground">
                No appointment data available
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Daily Appointments Trend</CardTitle>
            <CardDescription>
              {format(dateRange.from, 'MMM d')} - {format(dateRange.to, 'MMM d')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {dailyTrend.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <AreaChart data={dailyTrend}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" />
                  <YAxis />
                  <Tooltip />
                  <Legend />
                  <Area
                    type="monotone"
                    dataKey="count"
                    stroke="#8884d8"
                    fill="#8884d8"
                    fillOpacity={0.6}
                    name="Appointments"
                  />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-[300px] text-muted-foreground">
                No appointment data available
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Peak Hours Chart */}
      <Card>
        <CardHeader>
          <CardTitle>Peak Hours</CardTitle>
          <CardDescription>Appointment distribution by hour for selected period</CardDescription>
        </CardHeader>
        <CardContent>
          {(() => {
            const peakHoursData = (() => {
              const hourlyCounts: { [key: number]: number } = {};
              for (let i = 0; i < 24; i++) {
                hourlyCounts[i] = 0;
              }

              appointments.filter(apt => {
                try {
                  let aptDate: Date | null = null;
                  if (apt.createdAt) {
                    aptDate = apt.createdAt.toDate ? apt.createdAt.toDate() : new Date(apt.createdAt);
                  } else if (apt.date) {
                    aptDate = parseDateString(apt.date);
                  }
                  if (!aptDate) return false;
                  return isWithinInterval(aptDate, { start: startOfDay(dateRange.from), end: startOfDay(dateRange.to) });
                } catch {
                  return false;
                }
              }).forEach(apt => {
                try {
                  const aptTime = parse(apt.time, 'hh:mm a', new Date());
                  const hour = getHours(aptTime);
                  hourlyCounts[hour]++;
                } catch {
                  // Ignore parsing errors
                }
              });

              return Object.entries(hourlyCounts)
                .map(([hour, count]) => ({
                  hour: parseInt(hour),
                  name: format(new Date(0, 0, 0, parseInt(hour)), 'ha'),
                  count: count,
                }))
                .sort((a, b) => a.hour - b.hour)
                .filter(d => d.hour >= 6 && d.hour <= 22 && d.count > 0);
            })();

            return peakHoursData.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={peakHoursData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="name" />
                  <YAxis />
                  <Tooltip />
                  <Legend />
                  <Bar dataKey="count" fill="#82ca9d" name="Appointments" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-[300px] text-muted-foreground">
                No appointment data available for peak hours analysis
              </div>
            );
          })()}
        </CardContent>
      </Card>

      {/* Patient vs Appointments Chart */}
      <Card>
        <CardHeader>
          <CardTitle>Patients & Revenue Trend</CardTitle>
          <CardDescription>New vs returning patients and revenue over time</CardDescription>
        </CardHeader>
        <CardContent>
          {(() => {
            const patientTrendData = (() => {
              const isMonthlyView = differenceInDays(dateRange.to, dateRange.from) > 60;
              const trends: Array<{ period: string; newPatients: number; returningPatients: number; revenue: number }> = [];

              if (isMonthlyView) {
                // Monthly aggregation
                const currentMonth = new Date(dateRange.from);
                while (currentMonth <= dateRange.to) {
                  const monthStart = new Date(currentMonth.getFullYear(), currentMonth.getMonth(), 1);
                  const monthEnd = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 0);

                  const monthAppointments = appointments.filter(apt => {
                    try {
                      let aptDate: Date | null = null;
                      if (apt.createdAt) {
                        aptDate = apt.createdAt.toDate ? apt.createdAt.toDate() : new Date(apt.createdAt);
                      } else if (apt.date) {
                        aptDate = parseDateString(apt.date);
                      }
                      if (!aptDate) return false;
                      return aptDate >= monthStart && aptDate <= monthEnd;
                    } catch {
                      return false;
                    }
                  });

                  const patientFirstVisits = new Map<string, Date>();
                  monthAppointments.forEach(apt => {
                    if (!patientFirstVisits.has(apt.patientId)) {
                      try {
                        let aptDate: Date | null = null;
                        if (apt.createdAt) {
                          aptDate = apt.createdAt.toDate ? apt.createdAt.toDate() : new Date(apt.createdAt);
                        } else if (apt.date) {
                          aptDate = parseDateString(apt.date);
                        }
                        if (aptDate) {
                          patientFirstVisits.set(apt.patientId, aptDate);
                        }
                      } catch { }
                    }
                  });

                  let newPatients = 0;
                  let returningPatients = 0;
                  monthAppointments.forEach(apt => {
                    const firstVisit = patientFirstVisits.get(apt.patientId);
                    try {
                      let aptDate: Date | null = null;
                      if (apt.createdAt) {
                        aptDate = apt.createdAt.toDate ? apt.createdAt.toDate() : new Date(apt.createdAt);
                      } else if (apt.date) {
                        aptDate = parseDateString(apt.date);
                      }
                      if (aptDate && firstVisit) {
                        if (format(aptDate, 'yyyy-MM') === format(firstVisit, 'yyyy-MM')) {
                          newPatients++;
                        } else {
                          returningPatients++;
                        }
                      }
                    } catch { }
                  });

                  // Calculate revenue for this month
                  let monthRevenue = 0;
                  monthAppointments.filter(apt => apt.status === 'Completed').forEach(apt => {
                    const doctor = doctors.find(d => d.name === apt.doctor);
                    if (doctor?.consultationFee) {
                      monthRevenue += doctor.consultationFee;
                    }
                  });

                  trends.push({
                    period: format(monthStart, 'MMM yyyy'),
                    newPatients,
                    returningPatients,
                    revenue: monthRevenue,
                  });

                  currentMonth.setMonth(currentMonth.getMonth() + 1);
                }
              } else {
                // Daily aggregation
                const currentDay = new Date(dateRange.from);
                while (currentDay <= dateRange.to) {
                  const dayStart = startOfDay(currentDay);
                  const dayEnd = new Date(dayStart);
                  dayEnd.setHours(23, 59, 59, 999);

                  const dayAppointments = appointments.filter(apt => {
                    try {
                      let aptDate: Date | null = null;
                      if (apt.createdAt) {
                        aptDate = apt.createdAt.toDate ? apt.createdAt.toDate() : new Date(apt.createdAt);
                      } else if (apt.date) {
                        aptDate = parseDateString(apt.date);
                      }
                      if (!aptDate) return false;
                      return format(aptDate, 'yyyy-MM-dd') === format(dayStart, 'yyyy-MM-dd');
                    } catch {
                      return false;
                    }
                  });

                  const dayPatients = new Set(dayAppointments.map(apt => apt.patientId));
                  let dayRevenue = 0;
                  dayAppointments.filter(apt => apt.status === 'Completed').forEach(apt => {
                    const doctor = doctors.find(d => d.name === apt.doctor);
                    if (doctor?.consultationFee) {
                      dayRevenue += doctor.consultationFee;
                    }
                  });

                  trends.push({
                    period: format(dayStart, 'MMM d'),
                    newPatients: 0, // Simplified for now
                    returningPatients: dayPatients.size,
                    revenue: dayRevenue,
                  });

                  currentDay.setDate(currentDay.getDate() + 1);
                }
              }

              return trends;
            })();

            return patientTrendData.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <AreaChart data={patientTrendData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="period" />
                  <YAxis yAxisId="left" />
                  <YAxis yAxisId="right" orientation="right" />
                  <Tooltip formatter={(value: number, name: string) => {
                    if (name === 'revenue') return `₹${value.toLocaleString()}`;
                    return value;
                  }} />
                  <Legend />
                  <Area
                    yAxisId="left"
                    type="monotone"
                    dataKey="returningPatients"
                    stackId="1"
                    stroke="#8884d8"
                    fill="#8884d8"
                    fillOpacity={0.6}
                    name="Patients"
                  />
                  <Area
                    yAxisId="right"
                    type="monotone"
                    dataKey="revenue"
                    stroke="#82ca9d"
                    fill="#82ca9d"
                    fillOpacity={0.6}
                    name="Revenue (₹)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-[300px] text-muted-foreground">
                No data available for selected period
              </div>
            );
          })()}
        </CardContent>
      </Card>

      {/* Doctors List */}
      <Card>
        <CardHeader>
          <CardTitle>Doctors</CardTitle>
          <CardDescription>{doctors.length} doctor(s) registered</CardDescription>
        </CardHeader>
        <CardContent>
          {doctors.length === 0 ? (
            <p className="text-muted-foreground text-center py-8">No doctors registered yet</p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {doctors.map((doctor) => {
                const doctorAppointments = appointments.filter(apt => apt.doctor === doctor.name);
                const completed = doctorAppointments.filter(apt => apt.status === 'Completed').length;

                return (
                  <div key={doctor.id} className="p-4 border rounded-lg">
                    <div className="font-semibold">{doctor.name}</div>
                    <div className="mt-2 space-y-1 text-sm">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Consultation Fee:</span>
                        <span className="font-medium">₹{doctor.consultationFee || 0}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Free Follow-up:</span>
                        <span className="font-medium">{doctor.freeFollowUpDays || 0} days</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Total Appointments:</span>
                        <span className="font-medium">{doctorAppointments.length}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Completed:</span>
                        <span className="font-medium text-green-600">{completed}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Documents */}
      {(clinic.licenseUrl || clinic.receptionPhotoUrl) && (
        <Card>
          <CardHeader>
            <CardTitle>Documents</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex gap-4">
              {clinic.licenseUrl && (
                <a
                  href={clinic.licenseUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 text-blue-600 hover:underline"
                >
                  <FileText className="h-4 w-4" />
                  View License
                  <ExternalLink className="h-3 w-3" />
                </a>
              )}
              {clinic.receptionPhotoUrl && (
                <a
                  href={clinic.receptionPhotoUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 text-blue-600 hover:underline"
                >
                  <FileText className="h-4 w-4" />
                  View Reception Photo
                  <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Settings */}
      <Card>
        <CardHeader>
          <CardTitle>Clinic Settings</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <p className="text-sm text-muted-foreground">Walk-in Token Allotment</p>
              <p className="font-medium">{clinic.walkInTokenAllotment || 0}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Number of Doctors</p>
              <p className="font-medium">{clinic.numDoctors || 0}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Current Doctor Count</p>
              <p className="font-medium">{clinic.currentDoctorCount || 0}</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

