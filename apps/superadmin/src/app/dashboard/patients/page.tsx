'use client';

import { useEffect, useState, useMemo } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { fetchAllPatients, fetchAllAppointments, fetchAllUsers, getPatientFirstBooking, getPatientLastActive } from '@/lib/analytics';
import { calculate30DayRetention, calculateMAU, firestoreTimestampToDate } from '@/lib/metrics';
import { format, subDays, startOfMonth, endOfMonth, differenceInDays, endOfDay, startOfDay } from 'date-fns';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, BarChart, Bar, PieChart, Pie, Cell } from 'recharts';
import { Users, Activity, TrendingUp, Calendar, Search, MapPin, Smartphone } from 'lucide-react';
import type { Patient, Appointment, User } from '@/lib/analytics';

const COLORS = ['#0088FE', '#00C49F', '#FFBB28', '#FF8042', '#8884d8', '#82ca9d'];
import { useRouter } from 'next/navigation';

export default function PatientsPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [stats, setStats] = useState({
    total: 0,
    mau: 0,
    dau: 0,
    retention30d: 0,
    retention90d: 0,
    avgAppointments: 0,
    newVsReturning: { new: 0, returning: 0 },
  });

  useEffect(() => {
    const loadData = async () => {
      setLoading(true);
      try {
        const [patientsData, appointmentsData, usersData] = await Promise.all([
          fetchAllPatients(),
          fetchAllAppointments(),
          fetchAllUsers(),
        ]);

        setPatients(patientsData);
        setAppointments(appointmentsData);
        setUsers(usersData);

        // Calculate DAU (yesterday's active users)
        const yesterday = subDays(new Date(), 1);
        const yesterdayAppointments = appointmentsData.filter((apt: any) => {
          let aptDate: Date | null = null;
          if (apt.createdAt) {
            aptDate = apt.createdAt.toDate ? apt.createdAt.toDate() : new Date(apt.createdAt);
          }
          if (!aptDate && apt.date) {
            try {
              const parts = apt.date.toLowerCase().split(' ');
              const monthsMap: Record<string, number> = {
                'january': 0, 'february': 1, 'march': 2, 'april': 3,
                'may': 4, 'june': 5, 'july': 6, 'august': 7,
                'september': 8, 'october': 9, 'november': 10, 'december': 11
              };
              if (parts.length === 3) {
                const day = parseInt(parts[0]);
                const month = monthsMap[parts[1]];
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
          return format(aptDate, 'yyyy-MM-dd') === format(yesterday, 'yyyy-MM-dd');
        });
        const dau = new Set(yesterdayAppointments.map((apt: any) => apt.patientId)).size;

        // Calculate MAU
        const mau = calculateMAU(appointmentsData, new Date());

        // Calculate retention
        const retention30d = calculate30DayRetention(patientsData, appointmentsData);

        // Calculate 90-day retention (similar logic)
        const retention90d = calculate30DayRetention(patientsData, appointmentsData, 90);

        // Calculate new vs returning
        const patientAppointmentCounts = new Map<string, number>();
        appointmentsData.forEach((apt: any) => {
          patientAppointmentCounts.set(apt.patientId, (patientAppointmentCounts.get(apt.patientId) || 0) + 1);
        });
        const newPatients = Array.from(patientAppointmentCounts.values()).filter(count => count === 1).length;
        const returningPatients = Array.from(patientAppointmentCounts.values()).filter(count => count > 1).length;

        const avgAppointments = patientsData.length > 0
          ? appointmentsData.length / patientsData.length
          : 0;

        setStats({
          total: patientsData.length,
          mau,
          dau,
          retention30d,
          retention90d,
          avgAppointments,
          newVsReturning: { new: newPatients, returning: returningPatients },
        });
      } catch (error) {
        console.error('Error loading patient analytics:', error);
      } finally {
        setLoading(false);
      }
    };

    loadData();
  }, []);

  // Filter patients
  const filteredPatients = useMemo(() => {
    if (!searchTerm) return patients;

    const search = searchTerm.toLowerCase();
    return patients.filter(patient =>
      patient.name?.toLowerCase().includes(search) ||
      patient.phone?.toLowerCase().includes(search) ||
      patient.email?.toLowerCase().includes(search) ||
      patient.place?.toLowerCase().includes(search)
    );
  }, [patients, searchTerm]);

  // Calculate age group distribution
  const ageGroupData = useMemo(() => {
    const groups: Record<string, number> = {
      '0-18': 0,
      '19-30': 0,
      '31-45': 0,
      '46-60': 0,
      '61-75': 0,
      '75+': 0,
    };

    patients.forEach(patient => {
      const age = patient.age || 0;
      if (age <= 18) groups['0-18']++;
      else if (age <= 30) groups['19-30']++;
      else if (age <= 45) groups['31-45']++;
      else if (age <= 60) groups['46-60']++;
      else if (age <= 75) groups['61-75']++;
      else groups['75+']++;
    });

    return Object.entries(groups).map(([name, value]) => ({ name, value }));
  }, [patients]);

  // Calculate gender distribution
  const genderData = useMemo(() => {
    const genders: Record<string, number> = {
      'Male': 0,
      'Female': 0,
      'Other': 0,
      'Not Specified': 0,
    };

    patients.forEach(patient => {
      const sex = patient.sex || '';
      if (sex === 'Male') genders['Male']++;
      else if (sex === 'Female') genders['Female']++;
      else if (sex === 'Other') genders['Other']++;
      else genders['Not Specified']++;
    });

    return Object.entries(genders)
      .filter(([_, count]) => count > 0)
      .map(([name, value]) => ({ name, value }));
  }, [patients]);

  // Calculate location distribution
  const locationData = useMemo(() => {
    const locations = new Map<string, number>();

    patients.forEach(patient => {
      const place = patient.place || 'Unknown';
      locations.set(place, (locations.get(place) || 0) + 1);
    });

    // Sort by count (descending) and take top 10
    return Array.from(locations.entries())
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 10);
  }, [patients]);

  // Calculate patient registration trends (last 30 days)
  const registrationTrends = (() => {
    const now = new Date();
    const trends: Array<{ date: string; count: number }> = [];

    for (let i = 29; i >= 0; i--) {
      const date = subDays(now, i);
      const dateStr = format(date, 'yyyy-MM-dd');
      const dayStart = startOfDay(date);
      const dayEnd = endOfDay(date);

      const dayPatients = patients.filter((patient) => {
        if (!patient.createdAt) return false;
        const createdDate = firestoreTimestampToDate(patient.createdAt);
        if (!createdDate) return false;
        return createdDate >= dayStart && createdDate <= dayEnd;
      });

      trends.push({ date: dateStr, count: dayPatients.length });
    }

    return trends;
  })();

  // Calculate appointment frequency distribution
  const appointmentFrequency = (() => {
    const patientCounts = new Map<string, number>();
    appointments.forEach((apt: any) => {
      patientCounts.set(apt.patientId, (patientCounts.get(apt.patientId) || 0) + 1);
    });

    const frequency: Record<string, number> = {
      '1': 0,
      '2-3': 0,
      '4-5': 0,
      '6-10': 0,
      '11+': 0,
    };

    patientCounts.forEach((count) => {
      if (count === 1) frequency['1']++;
      else if (count >= 2 && count <= 3) frequency['2-3']++;
      else if (count >= 4 && count <= 5) frequency['4-5']++;
      else if (count >= 6 && count <= 10) frequency['6-10']++;
      else frequency['11+']++;
    });

    return Object.entries(frequency).map(([range, count]) => ({
      range,
      count,
    }));
  })();

  // Get appointment count for a patient
  const getPatientAppointmentCount = (patientId: string) => {
    return appointments.filter(apt => apt.patientId === patientId).length;
  };

  const getPatientPwaStatus = (patientId: string, patientPhone: string) => {
    // Try to find user by patientId link first
    let user = users.find(u => u.patientId === patientId);

    // If not found, try by phone number
    if (!user && patientPhone) {
      user = users.find(u => u.phone === patientPhone);
    }

    return user?.pwaInstalled || false;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto mb-4" />
          <p className="text-muted-foreground">Loading patient analytics...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Patient Analytics</h1>
        <p className="text-muted-foreground mt-1">Patient engagement and retention metrics</p>
      </div>

      {/* Key Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Patients</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.total.toLocaleString()}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Monthly Active</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.mau.toLocaleString()}</div>
            <p className="text-xs text-muted-foreground mt-1">
              {stats.total > 0 ? ((stats.mau / stats.total) * 100).toFixed(1) : 0}% of total
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Daily Active</CardTitle>
            <Calendar className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.dau.toLocaleString()}</div>
            <p className="text-xs text-muted-foreground mt-1">Yesterday</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">30-Day Retention</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.retention30d.toFixed(1)}%</div>
            <p className="text-xs text-muted-foreground mt-1">Return within 30 days</p>
          </CardContent>
        </Card>
      </div>

      {/* Analytics Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Age Group Distribution */}
        <Card>
          <CardHeader>
            <CardTitle>Age Group Distribution</CardTitle>
            <CardDescription>Patient age demographics</CardDescription>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={ageGroupData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="name" />
                <YAxis />
                <Tooltip />
                <Bar dataKey="value" fill="#8884d8" name="Patients" />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* Gender Distribution */}
        <Card>
          <CardHeader>
            <CardTitle>Gender Distribution</CardTitle>
            <CardDescription>Patient gender demographics</CardDescription>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={genderData}
                  cx="50%"
                  cy="50%"
                  labelLine={false}
                  label={({ name, percent }: { name: string; percent: number }) => `${name} ${(percent * 100).toFixed(0)}%`}
                  outerRadius={100}
                  fill="#8884d8"
                  dataKey="value"
                >
                  {genderData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* Top Locations */}
        <Card>
          <CardHeader>
            <CardTitle>Top Locations</CardTitle>
            <CardDescription>Patient location distribution</CardDescription>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={locationData} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis type="number" />
                <YAxis dataKey="name" type="category" width={100} />
                <Tooltip />
                <Bar dataKey="value" fill="#82ca9d" name="Patients" />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      {/* Other Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Patient Registration Trend</CardTitle>
            <CardDescription>New patients (last 30 days)</CardDescription>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={registrationTrends}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis
                  dataKey="date"
                  tickFormatter={(date) => format(new Date(date), 'MMM d')}
                  angle={-45}
                  textAnchor="end"
                  height={80}
                />
                <YAxis />
                <Tooltip
                  labelFormatter={(date) => format(new Date(date), 'MMM d, yyyy')}
                />
                <Legend />
                <Line
                  type="monotone"
                  dataKey="count"
                  stroke="#8884d8"
                  strokeWidth={2}
                  name="New Patients"
                  dot={{ r: 3 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Appointment Frequency</CardTitle>
            <CardDescription>Distribution of appointments per patient</CardDescription>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={appointmentFrequency}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="range" />
                <YAxis />
                <Tooltip />
                <Legend />
                <Bar dataKey="count" fill="#82ca9d" name="Number of Patients" />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      {/* Additional Stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Retention Metrics</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex justify-between items-center">
                <span className="text-sm">30-Day Retention</span>
                <span className="text-lg font-semibold">{stats.retention30d.toFixed(1)}%</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm">90-Day Retention</span>
                <span className="text-lg font-semibold">{stats.retention90d.toFixed(1)}%</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm">Average Appointments per Patient</span>
                <span className="text-lg font-semibold">{stats.avgAppointments.toFixed(1)}</span>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Patient Segmentation</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div>
                <div className="flex justify-between items-center mb-2">
                  <span className="text-sm">New Patients</span>
                  <span className="text-sm font-semibold">
                    {stats.newVsReturning.new} ({stats.total > 0 ? ((stats.newVsReturning.new / stats.total) * 100).toFixed(1) : 0}%)
                  </span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-2">
                  <div
                    className="bg-blue-600 h-2 rounded-full"
                    style={{ width: `${stats.total > 0 ? (stats.newVsReturning.new / stats.total) * 100 : 0}%` }}
                  />
                </div>
              </div>
              <div>
                <div className="flex justify-between items-center mb-2">
                  <span className="text-sm">Returning Patients</span>
                  <span className="text-sm font-semibold">
                    {stats.newVsReturning.returning} ({stats.total > 0 ? ((stats.newVsReturning.returning / stats.total) * 100).toFixed(1) : 0}%)
                  </span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-2">
                  <div
                    className="bg-green-600 h-2 rounded-full"
                    style={{ width: `${stats.total > 0 ? (stats.newVsReturning.returning / stats.total) * 100 : 0}%` }}
                  />
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Patients Table */}
      <Card>
        <CardHeader>
          <CardTitle>All Patients</CardTitle>
          <CardDescription>Complete list of all registered patients</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="mb-4">
            <div className="relative">
              <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search by name, phone, email, or location..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-8"
              />
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b">
                  <th className="text-left p-3 text-sm font-medium">Name</th>
                  <th className="text-left p-3 text-sm font-medium">Age</th>
                  <th className="text-left p-3 text-sm font-medium">Gender</th>
                  <th className="text-left p-3 text-sm font-medium">Phone</th>
                  <th className="text-left p-3 text-sm font-medium">
                    <div className="flex items-center gap-1">
                      <Smartphone className="h-4 w-4" />
                      PWA Installed?
                    </div>
                  </th>
                  <th className="text-left p-3 text-sm font-medium">
                    <div className="flex items-center gap-1">
                      <MapPin className="h-4 w-4" />
                      Location
                    </div>
                  </th>
                  <th className="text-left p-3 text-sm font-medium">Appointments</th>
                  <th className="text-left p-3 text-sm font-medium">Registered</th>
                  <th className="text-left p-3 text-sm font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {filteredPatients.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="p-8 text-center text-muted-foreground">
                      {searchTerm ? 'No patients found matching your search.' : 'No patients registered yet.'}
                    </td>
                  </tr>
                ) : (
                  filteredPatients.map((patient) => {
                    const createdDate = patient.createdAt ? firestoreTimestampToDate(patient.createdAt) : null;
                    const appointmentCount = getPatientAppointmentCount(patient.id);
                    const displayPhone = patient.communicationPhone || patient.phone;

                    return (
                      <tr
                        key={patient.id}
                        className="border-b hover:bg-gray-50 transition-colors"
                      >
                        <td className="p-3">
                          <div className="font-medium">{patient.name || 'N/A'}</div>
                        </td>
                        <td className="p-3 text-sm">{patient.age || 'N/A'}</td>
                        <td className="p-3">
                          {patient.sex ? (
                            <Badge variant="outline">
                              {patient.sex}
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground text-sm">Not specified</span>
                          )}
                        </td>
                        <td className="p-3 text-sm">{displayPhone || 'N/A'}</td>
                        <td className="p-3 text-sm">
                          {getPatientPwaStatus(patient.id, patient.phone) ? (
                            <Badge variant="default" className="bg-green-600 hover:bg-green-700">Yes</Badge>
                          ) : (
                            <span className="text-muted-foreground text-xs">No</span>
                          )}
                        </td>
                        <td className="p-3 text-sm">{patient.place || 'Unknown'}</td>
                        <td className="p-3">
                          <Badge variant="secondary">{appointmentCount}</Badge>
                        </td>
                        <td className="p-3 text-sm text-muted-foreground">
                          {createdDate ? format(createdDate, 'MMM d, yyyy') : 'N/A'}
                        </td>
                        <td className="p-3">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => router.push(`/dashboard/patients/${patient.id}`)}
                            title="View Details"
                          >
                            <Users className="h-4 w-4" />
                          </Button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {filteredPatients.length > 0 && (
            <div className="mt-4 text-sm text-muted-foreground">
              Showing {filteredPatients.length} of {patients.length} patients
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
